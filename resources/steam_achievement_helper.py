# Achievement Manager helper for Linux.
#
# The Lua backend runs this with the system's python3 (on Windows it uses steam_achievement_helper.cs instead). It talks to
# the running Steam client through steamclient.so, the library Steam's own games use, and reads or changes the signed-in
# user's achievements for one game. Standard library only (ctypes), so nothing has to be installed.
#
#   helper status <appid> --result-file <file> [--steam-path <folder>]
#   helper sync   <appid> --result-file <file> [--steam-path <folder>] [--args-file <file>]
#   helper stats    <appid> --result-file <file> --args-file <file>     read a game's stats
#   helper setstats <appid> --result-file <file> --args-file <file>     write stats, store them, read them back
#
# Add --silent to any command to work without Steam showing the user as playing the game (see "silent mode" below).
#
# Output is JSON, the same as the Windows helper:
#   status  {"ok":true,"appid":N,"total":N,"achievements":{"API_NAME":{"achieved":bool,"unlock_time":N},...}}
#   sync    the args file lists "+API_NAME" (unlock), "-API_NAME" (lock) or a bare name (unlock), one per line;
#           result {"ok":bool,"appid":N,"unlocked_count":N,"locked_count":N,...}, ok only when Steam confirmed the save
#   stats   the args file lists "i:NAME" (integer), "f:NAME" (float) or "a:NAME" (average rate, read only), one per line;
#           result {"ok":true,"appid":N,"stats":{"NAME":{"kind":"i","value":N},...},"missing":["NAME",...]}
#   setstats  lines are "i:NAME=123" / "f:NAME=1.5"; result {"ok":bool,"appid":N,"requested":N,"changed":N,
#           "not_changed":[...],"stats":{...as Steam holds them after the save}}
#   errors  {"ok":false,"error":"<code>"[,"detail":"<text>"]}
#
# No f-strings or annotations on purpose, so an old python can still parse the file and report "python_too_old".

import sys

_RESULT_FILE = ""
for _i in range(len(sys.argv) - 1):
    if sys.argv[_i] == "--result-file":
        _RESULT_FILE = sys.argv[_i + 1]

if sys.version_info < (3, 6):
    text = '{"ok":false,"error":"python_too_old","detail":"python ' + ".".join(str(p) for p in sys.version_info[:3]) + '"}'
    try:
        with open(_RESULT_FILE, "w") as handle:
            handle.write(text)
    except Exception:
        sys.stdout.write(text + "\n")
    sys.exit(0)

import ctypes
import json
import os
import re
import struct
import time
from ctypes import CFUNCTYPE, POINTER, byref, c_bool, c_char_p, c_float, c_int, c_uint32, c_uint64, c_void_p


# ---------------------------------------------------------------------------------------------- what Steam fixes
# Names and positions below are fixed by Steam's interfaces (ISteamClient, ISteamUserStats); the Windows helper uses the same.
CLIENT_INTERFACE = b"SteamClient020"
STATS_INTERFACE = b"STEAMUSERSTATS_INTERFACE_VERSION012"

# position of each method in the interface's table of functions
CLIENT_CREATE_PIPE, CLIENT_RELEASE_PIPE, CLIENT_CONNECT_USER, CLIENT_RELEASE_USER, CLIENT_GET_STATS = 0, 1, 2, 4, 13
STATS_REQUEST, STATS_SET, STATS_CLEAR, STATS_GET_TIME, STATS_STORE, STATS_COUNT, STATS_NAME = 0, 7, 8, 9, 10, 14, 15

# The stat calls come in int / float pairs. This platform's compiler lays an overloaded pair out in declaration order, so the
# int version of each pair comes first (on Windows the order is reversed; the helper also checks which slot is which).
STATS_GET_INT, STATS_GET_FLOAT, STATS_SET_INT, STATS_SET_FLOAT = 1, 2, 3, 4

# Silent mode talks to Steam's client engine instead of the game interface. Its stats object takes the game as the first
# argument of every call (a game id passed by reference), so the process never announces that it is running a game.
ENGINE_INTERFACE = b"CLIENTENGINE_INTERFACE_VERSION005"
ENGINE_CREATE_PIPE, ENGINE_RELEASE_PIPE, ENGINE_CONNECT_USER, ENGINE_RELEASE_USER, ENGINE_RUN_FRAME, ENGINE_GET_STATS = 0, 1, 3, 6, 19, 21
SILENT_COUNT, SILENT_NAME, SILENT_REQUEST = 3, 4, 5
SILENT_GET_ACH, SILENT_SET_ACH, SILENT_CLEAR_ACH, SILENT_STORE = 12, 13, 14, 16
# int / float pairs, in this platform's declaration order (Windows reverses each pair; the helper checks which is which)
SILENT_GET_INT, SILENT_GET_FLOAT, SILENT_SET_INT, SILENT_SET_FLOAT = 7, 8, 9, 10

CALLBACK_STATS_RECEIVED = 1101
CALLBACK_STATS_STORED = 1102
RESULT_OK = 1


class CallbackMsg(ctypes.Structure):
    _fields_ = [
        ("user", c_int),
        ("id", c_int),
        ("param", c_void_p),
        ("param_size", c_int),
    ]


# ---------------------------------------------------------------------------------------------- the answer
class Report(object):
    result_file = ""

    @staticmethod
    def write(payload):
        text = json.dumps(payload, separators=(",", ":"))
        if Report.result_file:
            try:
                with open(Report.result_file, "w", encoding="utf-8") as handle:
                    handle.write(text)
                return
            except Exception:
                pass
        try:
            sys.stdout.write(text + "\n")
            sys.stdout.flush()
        except Exception:
            pass

    @staticmethod
    def fail(code, detail=None):
        payload = {"ok": False, "error": code}
        if detail:
            payload["detail"] = detail
        Report.write(payload)


# ---------------------------------------------------------------------------------------------- finding Steam
def _home():
    return os.path.expanduser("~")


def _steam_folders(given):
    home = _home()
    candidates = [
        given,
        os.environ.get("STEAM_PATH"),
        os.path.join(home, ".steam", "steam"),
        os.path.join(home, ".local", "share", "Steam"),
        os.path.join(home, ".steam", "root"),
    ]
    seen = []
    for candidate in candidates:
        if candidate and candidate not in seen:
            seen.append(candidate)
    return seen


def find_steam(given):
    """Returns (steam folder, path of the 64-bit steamclient.so), or (None, None)."""
    folders = _steam_folders(given)
    for folder in folders:
        library = os.path.join(folder, "linux64", "steamclient.so")
        if os.path.isfile(library):
            return folder, library
    # the SDK link Steam keeps for games
    sdk = os.path.join(_home(), ".steam", "sdk64", "steamclient.so")
    if os.path.isfile(sdk):
        return (folders[0] if folders else os.path.join(_home(), ".steam", "steam")), sdk
    return None, None


def someone_is_signed_in():
    """True when Steam itself says an account is signed in (ActiveUser in Steam's registry.vdf is not 0)."""
    home = _home()
    for path in (os.path.join(home, ".steam", "registry.vdf"), os.path.join(home, ".local", "share", "Steam", "registry.vdf")):
        try:
            with open(path, "r", encoding="utf-8", errors="replace") as handle:
                match = re.search(r'"ActiveUser"\s+"(\d+)"', handle.read())
            if match:
                return int(match.group(1)) != 0
        except Exception:
            continue
    return False


# ---------------------------------------------------------------------------------------------- the connection
def shortest_float32(value):
    """The shortest decimal that reads back as the same 32-bit float (0.1, not 0.10000000149011612); None for nan / infinity."""
    if value != value or value in (float("inf"), float("-inf")):
        return None
    for digits in range(1, 10):
        text = "%.*g" % (digits, value)
        try:
            if struct.unpack("<f", struct.pack("<f", float(text)))[0] == value:
                return float(text)
        except (OverflowError, struct.error):
            break
    return value


def _slot(iface, index, restype, *argtypes):
    """The function at position `index` of an interface's table of functions; `this` is always the first argument."""
    table = ctypes.cast(iface, POINTER(c_void_p))[0]
    function = ctypes.cast(table, POINTER(c_void_p))[index]
    if not function:
        return None
    return CFUNCTYPE(restype, c_void_p, *argtypes)(function)


def load_steam_library(library_path):
    """Loads steamclient.so (after its own companions, so that it finds them). Returns (module, None) or (None, (code, detail))."""
    library_dir = os.path.dirname(os.path.realpath(library_path))
    for companion in ("libtier0_s.so", "libvstdlib_s.so"):
        path = os.path.join(library_dir, companion)
        if os.path.isfile(path):
            try:
                ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
            except OSError:
                pass
    try:
        return ctypes.CDLL(library_path), None
    except OSError as error:
        return None, ("steam_client_dll_not_found", str(error)[:200])


class SteamLink(object):
    """One session with the Steam client: a pipe, the signed-in user and that user's stats interface."""

    def __init__(self):
        self.client = None
        self.stats = None
        self.pipe = 0
        self.user = 0
        self._release_pipe = None
        self._release_user = None
        self._next_callback = None
        self._free_callback = None
        self._request = None
        self._count = None
        self._name_at = None
        self._get_time = None
        self._set = None
        self._clear = None
        self._store = None
        self._get_int = None
        self._get_float = None
        self._set_int = None
        self._set_float = None

    @staticmethod
    def open(library_path, steam_folder):
        """Returns (link, None), or (None, (error code, detail)) when Steam cannot be reached."""
        module, problem = load_steam_library(library_path)
        if module is None:
            return None, problem
        return SteamLink.from_module(module)

    @staticmethod
    def from_module(module):
        try:
            create_interface = module.CreateInterface
            create_interface.restype = c_void_p
            create_interface.argtypes = [c_char_p, POINTER(c_int)]
        except AttributeError:
            return None, ("create_interface_not_found", None)

        link = SteamLink()
        try:
            link._next_callback = module.Steam_BGetCallback
            link._next_callback.restype = c_bool
            # Steam_BGetCallback(pipe, message, call): the third argument is an out-parameter that must be a real pointer
            link._next_callback.argtypes = [c_int, POINTER(CallbackMsg), POINTER(c_int)]
            link._free_callback = module.Steam_FreeLastCallback
            link._free_callback.restype = None
            link._free_callback.argtypes = [c_int]
        except AttributeError:
            return None, ("callbacks_not_available", None)

        code = c_int(0)
        link.client = create_interface(CLIENT_INTERFACE, byref(code))
        if not link.client:
            return None, ("steamclient020_not_available", None)

        create_pipe = _slot(link.client, CLIENT_CREATE_PIPE, c_int)
        connect_user = _slot(link.client, CLIENT_CONNECT_USER, c_int, c_int)
        get_stats = _slot(link.client, CLIENT_GET_STATS, c_void_p, c_int, c_int, c_char_p)
        link._release_pipe = _slot(link.client, CLIENT_RELEASE_PIPE, c_bool, c_int)
        link._release_user = _slot(link.client, CLIENT_RELEASE_USER, None, c_int, c_int)
        if not create_pipe or not connect_user or not get_stats:
            return None, ("steamclient020_not_available", None)

        link.pipe = create_pipe(link.client)
        if link.pipe == 0:
            return None, ("steam_not_running", None)

        link.user = connect_user(link.client, link.pipe)
        if link.user == 0:
            link.close()
            # Steam signed in but refused the connection for this game: usually an account that does not own it
            if someone_is_signed_in():
                return None, ("steam_game_refused", None)
            return None, ("steam_user_not_logged_in", None)

        link.stats = get_stats(link.client, link.user, link.pipe, STATS_INTERFACE)
        if not link.stats:
            link.close()
            return None, ("steam_userstats_unavailable", None)

        link._request = _slot(link.stats, STATS_REQUEST, c_bool)
        link._count = _slot(link.stats, STATS_COUNT, c_uint32)
        link._name_at = _slot(link.stats, STATS_NAME, c_char_p, c_uint32)
        link._get_time = _slot(link.stats, STATS_GET_TIME, c_bool, c_char_p, POINTER(c_bool), POINTER(c_uint32))
        link._set = _slot(link.stats, STATS_SET, c_bool, c_char_p)
        link._clear = _slot(link.stats, STATS_CLEAR, c_bool, c_char_p)
        link._store = _slot(link.stats, STATS_STORE, c_bool)
        link.bind_stat_calls(False)
        return link, None

    def bind_stat_calls(self, swapped):
        order = (STATS_GET_FLOAT, STATS_GET_INT, STATS_SET_FLOAT, STATS_SET_INT) if swapped else (STATS_GET_INT, STATS_GET_FLOAT, STATS_SET_INT, STATS_SET_FLOAT)
        self._get_int = _slot(self.stats, order[0], c_bool, c_char_p, POINTER(c_int))
        self._get_float = _slot(self.stats, order[1], c_bool, c_char_p, POINTER(c_float))
        self._set_int = _slot(self.stats, order[2], c_bool, c_char_p, c_int)
        self._set_float = _slot(self.stats, order[3], c_bool, c_char_p, c_float)

    def order_is_swapped(self, kind, name):
        """Asks both getters about the same stat. Steam answers False to the one of the wrong type, so if only the other
        one answers, the int / float slots are the other way round on this system."""
        encoded = name.encode("utf-8")
        as_int = c_int(0)
        as_float = c_float(0)
        ok_int = bool(self._get_int and self._get_int(self.stats, encoded, byref(as_int)))
        ok_float = bool(self._get_float and self._get_float(self.stats, encoded, byref(as_float)))
        if kind == "i":
            return (not ok_int) and ok_float
        return (not ok_float) and ok_int

    def read_stat(self, kind, name):
        """Returns (known, value); a float is the shortest decimal that reads back as the same 32-bit float."""
        encoded = name.encode("utf-8")
        if kind == "i":
            value = c_int(0)
            if self._get_int and self._get_int(self.stats, encoded, byref(value)):
                return True, int(value.value)
            return False, 0
        value = c_float(0)
        if self._get_float and self._get_float(self.stats, encoded, byref(value)):
            return True, shortest_float32(value.value)
        return False, 0

    def write_stat(self, kind, name, number):
        encoded = name.encode("utf-8")
        if kind == "i":
            return bool(self._set_int and self._set_int(self.stats, encoded, int(number)))
        return bool(self._set_float and self._set_float(self.stats, encoded, float(number)))

    def close(self):
        try:
            if self.user != 0 and self._release_user:
                self._release_user(self.client, self.pipe, self.user)
            if self.pipe != 0 and self._release_pipe:
                self._release_pipe(self.client, self.pipe)
        except Exception:
            pass
        self.user = 0
        self.pipe = 0

    def request_stats(self):
        return bool(self._request and self._request(self.stats))

    def commit(self):
        return bool(self._store and self._store(self.stats))

    def unlock(self, name):
        return bool(self._set and self._set(self.stats, name.encode("utf-8")))

    def lock(self, name):
        return bool(self._clear and self._clear(self.stats, name.encode("utf-8")))

    def achievement_count(self):
        return int(self._count(self.stats)) if self._count else 0

    def achievement_name(self, index):
        if not self._name_at:
            return ""
        raw = self._name_at(self.stats, index)
        if not raw:
            return ""
        return raw.decode("utf-8", "replace")

    def read_achievement(self, name):
        """Returns (known, achieved, unlock time)."""
        if not self._get_time:
            return False, False, 0
        achieved = c_bool(False)
        when = c_uint32(0)
        known = bool(self._get_time(self.stats, name.encode("utf-8"), byref(achieved), byref(when)))
        return known, bool(achieved.value), int(when.value)

    def _pump(self):
        """Called before callbacks are collected; the silent connection overrides it."""
        return None

    def wait_for_callback(self, callback_id, app_id, seconds):
        """Steam answers a request with a callback that carries the game id (first 8 bytes) and a result code (the next 4).
        Waits up to `seconds` for callback `callback_id` about `app_id`; returns (whether it came, the result code)."""
        result = 0
        seen = False
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            self._pump()
            message = CallbackMsg()
            call = c_int(0)
            while self._next_callback(self.pipe, byref(message), byref(call)):
                if message.id == callback_id and message.param:
                    game, code = struct.unpack("<Qi", ctypes.string_at(message.param, 12))
                    if game == app_id:
                        result = code
                        seen = True
                self._free_callback(self.pipe)
            if seen:
                return True, result
            time.sleep(0.03)
        return False, result


class SilentLink(SteamLink):
    """The same session as SteamLink, made through Steam's client engine so that Steam is never told a game is running.
    Every stats call carries the game id; the calls are wrapped here so that the rest of the program uses the same methods."""

    def __init__(self):
        SteamLink.__init__(self)
        self.game = c_uint64(0)
        self._run_frame = None
        self._raw = {}

    @staticmethod
    def open(library_path, steam_folder, app_id):
        module, problem = load_steam_library(library_path)
        if module is None:
            return None, problem
        return SilentLink.from_module(module, app_id)

    @staticmethod
    def from_module(module, app_id):
        try:
            create_interface = module.CreateInterface
            create_interface.restype = c_void_p
            create_interface.argtypes = [c_char_p, POINTER(c_int)]
        except AttributeError:
            return None, ("create_interface_not_found", None)

        link = SilentLink()
        try:
            link._next_callback = module.Steam_BGetCallback
            link._next_callback.restype = c_bool
            link._next_callback.argtypes = [c_int, POINTER(CallbackMsg), POINTER(c_int)]
            link._free_callback = module.Steam_FreeLastCallback
            link._free_callback.restype = None
            link._free_callback.argtypes = [c_int]
        except AttributeError:
            return None, ("callbacks_not_available", None)

        link.game = c_uint64(app_id & 0xFFFFFF)
        code = c_int(0)
        link.client = create_interface(ENGINE_INTERFACE, byref(code))
        if not link.client:
            return None, ("silent_unavailable", "client engine not available")

        create_pipe = _slot(link.client, ENGINE_CREATE_PIPE, c_int)
        connect_user = _slot(link.client, ENGINE_CONNECT_USER, c_int, c_int)
        get_stats = _slot(link.client, ENGINE_GET_STATS, c_void_p, c_int, c_int, c_char_p)
        link._release_pipe = _slot(link.client, ENGINE_RELEASE_PIPE, c_bool, c_int)
        link._release_user = _slot(link.client, ENGINE_RELEASE_USER, None, c_int, c_int)
        link._run_frame = _slot(link.client, ENGINE_RUN_FRAME, None)
        if not create_pipe or not connect_user or not get_stats or not link._run_frame:
            return None, ("silent_unavailable", "client engine slots")

        link.pipe = create_pipe(link.client)
        if link.pipe == 0:
            return None, ("steam_not_running", None)

        link.user = connect_user(link.client, link.pipe)
        if link.user == 0:
            link.close()
            if someone_is_signed_in():
                return None, ("silent_unavailable", "could not connect to the signed-in user")
            return None, ("steam_user_not_logged_in", None)

        # no interface version is asked for: the engine hands out its own stats object
        link.stats = get_stats(link.client, link.user, link.pipe, None)
        if not link.stats:
            link.close()
            return None, ("silent_unavailable", "client stats interface")

        game = POINTER(c_uint64)
        stats = link.stats
        slots = {
            "request": _slot(stats, SILENT_REQUEST, c_bool, game),
            "count": _slot(stats, SILENT_COUNT, c_uint32, game),
            "name": _slot(stats, SILENT_NAME, c_char_p, game, c_uint32),
            "get_time": _slot(stats, SILENT_GET_ACH, c_bool, game, c_char_p, POINTER(c_bool), POINTER(c_uint32)),
            "set": _slot(stats, SILENT_SET_ACH, c_bool, game, c_char_p),
            "clear": _slot(stats, SILENT_CLEAR_ACH, c_bool, game, c_char_p),
            "store": _slot(stats, SILENT_STORE, c_bool, game),
        }
        if not all(slots.values()):
            link.close()
            return None, ("silent_unavailable", "client stats slots")
        link._raw = slots
        ref = lambda: byref(link.game)
        link._request = lambda this: slots["request"](this, ref())
        link._count = lambda this: slots["count"](this, ref())
        link._name_at = lambda this, index: slots["name"](this, ref(), index)
        link._get_time = lambda this, name, achieved, when: slots["get_time"](this, ref(), name, achieved, when)
        link._set = lambda this, name: slots["set"](this, ref(), name)
        link._clear = lambda this, name: slots["clear"](this, ref(), name)
        link._store = lambda this: slots["store"](this, ref())
        link.bind_stat_calls(False)
        return link, None

    def bind_stat_calls(self, swapped):
        order = (SILENT_GET_FLOAT, SILENT_GET_INT, SILENT_SET_FLOAT, SILENT_SET_INT) if swapped else (SILENT_GET_INT, SILENT_GET_FLOAT, SILENT_SET_INT, SILENT_SET_FLOAT)
        game = POINTER(c_uint64)
        stats = self.stats
        raw_get_int = _slot(stats, order[0], c_bool, game, c_char_p, POINTER(c_int))
        raw_get_float = _slot(stats, order[1], c_bool, game, c_char_p, POINTER(c_float))
        raw_set_int = _slot(stats, order[2], c_bool, game, c_char_p, c_int)
        raw_set_float = _slot(stats, order[3], c_bool, game, c_char_p, c_float)
        ref = lambda: byref(self.game)
        self._get_int = (lambda this, name, out: raw_get_int(this, ref(), name, out)) if raw_get_int else None
        self._get_float = (lambda this, name, out: raw_get_float(this, ref(), name, out)) if raw_get_float else None
        self._set_int = (lambda this, name, value: raw_set_int(this, ref(), name, value)) if raw_set_int else None
        self._set_float = (lambda this, name, value: raw_set_float(this, ref(), name, value)) if raw_set_float else None

    def _pump(self):
        # the client engine only delivers callbacks while it is being run
        if self._run_frame:
            self._run_frame(self.client)


# ---------------------------------------------------------------------------------------------- command line
class Options(object):
    def __init__(self):
        self.command = ""
        self.app_id = 0
        self.result_file = ""
        self.steam_path = ""
        self.silent = False
        self.entries = []
        self.problem = ""     # an error code when the command line cannot be used

    @staticmethod
    def parse(argv):
        options = Options()
        words = []
        i = 0
        while i < len(argv):
            arg = argv[i]
            if arg == "--result-file" and i + 1 < len(argv):
                i += 1
                options.result_file = argv[i]
            elif arg == "--silent":
                options.silent = True
            elif arg == "--steam-path" and i + 1 < len(argv):
                i += 1
                options.steam_path = argv[i]
            elif arg == "--args-file" and i + 1 < len(argv):
                i += 1
                try:
                    with open(argv[i], "r", encoding="utf-8-sig") as handle:
                        for line in handle.read().splitlines():
                            line = line.strip()
                            if line:
                                words.append(line)
                except Exception:
                    pass
            else:
                words.append(arg)
            i += 1

        if not words:
            options.problem = "missing_arguments"
            return options
        options.command = words[0].lower()
        if options.command not in ("status", "sync", "stats", "setstats"):
            options.problem = "unknown_command"
            return options
        if len(words) < 2 or not words[1].isdigit() or int(words[1]) == 0:
            options.problem = "invalid_appid"
            return options
        options.app_id = int(words[1])
        options.entries = words[2:]
        return options


# ---------------------------------------------------------------------------------------------- the program
def wait_for_schema(steam_folder, app_id):
    """Steam writes the game's stats schema (names, descriptions, icons) a moment after it answers. The plugin reads that
    file, so wait until it exists and has stopped growing; otherwise a game opened for the first time shows bare IDs."""
    path = os.path.join(steam_folder, "appcache", "stats", "UserGameStatsSchema_" + str(app_id) + ".bin")
    deadline = time.monotonic() + 4
    previous = -1
    while time.monotonic() < deadline:
        try:
            if os.path.isfile(path):
                size = os.path.getsize(path)
                if size > 0 and size == previous:
                    return
                previous = size
        except OSError:
            pass
        time.sleep(0.15)


def report_status(link, app_id, silent=False):
    total = link.achievement_count()
    achievements = {}
    for index in range(total):
        name = link.achievement_name(index)
        if not name:
            continue
        known, achieved, when = link.read_achievement(name)
        achievements[name] = {"achieved": achieved, "unlock_time": when}
    payload = {"ok": True, "appid": app_id, "total": total, "achievements": achievements}
    if silent:
        payload["silent"] = True
        if total > 0 and not achievements:
            # Steam counted achievements but gave no names: this route cannot list them on this system
            Report.fail("silent_unavailable", "achievement names")
            return
    Report.write(payload)


def report_sync(link, app_id, entries, silent=False):
    to_unlock = []
    to_lock = []
    for entry in entries:
        name = (entry[1:] if entry[:1] in ("+", "-") else entry).strip()
        if not name:
            continue
        if entry[:1] == "-":
            to_lock.append(name)
        else:
            to_unlock.append(name)
    if len(to_unlock) + len(to_lock) == 0:
        Report.fail("nothing_to_apply")
        return

    unlocked = 0
    locked = 0
    for name in to_unlock:
        if link.unlock(name):
            unlocked += 1
    for name in to_lock:
        if link.lock(name):
            locked += 1

    stored = link.commit()
    # Steam confirms the save with callback 1102
    came, result = link.wait_for_callback(CALLBACK_STATS_STORED, app_id, 4)
    callback_confirmed = came and result == RESULT_OK
    read_back = False
    if silent and stored and not callback_confirmed:
        # the silent route may not deliver the callback: accept the save when Steam now reports every change
        read_back = all(link.read_achievement(n)[1] for n in to_unlock) and not any(link.read_achievement(n)[1] for n in to_lock)
        callback_confirmed = read_back
    committed = stored and callback_confirmed

    payload = {"ok": committed, "appid": app_id, "unlocked_count": unlocked, "locked_count": locked,
               "requested_unlock": len(to_unlock), "requested_lock": len(to_lock),
               "stored": stored, "callback_confirmed": callback_confirmed}
    if silent:
        payload["silent"] = True
        payload["confirmed_by_read_back"] = read_back
    if not committed:
        payload["error"] = "store_stats_not_confirmed"
    Report.write(payload)


def parse_stat_entry(raw, with_value):
    """"i:NAME" (or "i:NAME=123" when a value is wanted) -> (kind, name, text), or None."""
    if len(raw) < 3 or raw[1] != ":" or raw[0] not in "ifa":
        return None
    name = raw[2:]
    text = None
    if with_value:
        cut = name.rfind("=")
        if cut < 1:
            return None
        text = name[cut + 1:]
        name = name[:cut]
    if not name:
        return None
    return (raw[0], name, text)


def detect_stat_order(link, entries):
    """Checks the int / float slot order once, on the first stat Steam answers for."""
    for kind, name, text in entries:
        known_int, x = link.read_stat("i", name)
        known_float, y = link.read_stat("f", name)
        if known_int or known_float:
            if link.order_is_swapped(kind, name):
                link.bind_stat_calls(True)
            return


def read_all_stats(link, entries, missing):
    stats = {}
    for kind, name, text in entries:
        known, value = link.read_stat(kind, name)
        if not known:
            missing.append(name)
            continue
        stats[name] = {"kind": kind, "value": value}
    return stats


def report_stats(link, app_id, entries):
    detect_stat_order(link, entries)
    missing = []
    stats = read_all_stats(link, entries, missing)
    Report.write({"ok": True, "appid": app_id, "stats": stats, "missing": missing})


def stat_number(kind, text):
    """The number a value text stands for, or None when it is not acceptable for this kind of stat."""
    try:
        if kind == "i":
            number = int(text)
            return number if -2147483648 <= number <= 2147483647 else None
        number = float(text)
        return number if number == number and abs(number) != float("inf") and abs(number) < 3.4e38 else None
    except (TypeError, ValueError):
        return None


def report_setstats(link, app_id, entries, silent=False):
    detect_stat_order(link, entries)
    refused = []
    wanted = []
    for kind, name, text in entries:
        number = None if kind == "a" else stat_number(kind, text)
        if number is not None and link.write_stat(kind, name, number):
            wanted.append((kind, name, number))
        else:
            refused.append(name)

    stored = bool(wanted) and link.commit()
    confirmed = False
    if stored:
        came, result = link.wait_for_callback(CALLBACK_STATS_STORED, app_id, 5)
        confirmed = came and result == RESULT_OK
        if silent and not confirmed:
            # the silent route may not deliver the callback: the values are compared with what Steam holds further down
            confirmed = all(link.read_stat(kind, name)[0] for kind, name, number in wanted)

    # ask Steam for the stats again, then compare what it now holds with what was asked for
    from_server = False
    if confirmed and link.request_stats():
        came, result = link.wait_for_callback(CALLBACK_STATS_RECEIVED, app_id, 3)
        from_server = came and result == RESULT_OK

    changed = 0
    for kind, name, number in wanted:
        known, now = link.read_stat(kind, name)
        if kind == "i":
            same = known and now == number
        else:
            same = known and now is not None and abs(now - number) <= 0.0001 * max(1.0, abs(number))
        if same:
            changed += 1
        else:
            refused.append(name)

    missing = []
    after = read_all_stats(link, entries, missing)
    committed = stored and confirmed
    payload = {"ok": committed, "appid": app_id, "requested": len(entries), "changed": changed, "stored": stored,
               "callback_confirmed": confirmed, "verified_from_server": from_server, "not_changed": refused, "stats": after}
    if silent:
        payload["silent"] = True
    if not committed:
        payload["error"] = "store_stats_not_confirmed"
    Report.write(payload)


def main(argv):
    try:
        options = Options.parse(argv)
        Report.result_file = options.result_file
        if options.problem:
            Report.fail(options.problem)
            return

        if not sys.platform.startswith("linux"):
            Report.fail("unsupported_platform", sys.platform)
            return

        if options.silent:
            # silent mode must not announce a game: make sure neither variable is present
            os.environ.pop("SteamAppId", None)
            os.environ.pop("SteamGameId", None)
        else:
            # Steam decides which game the connection belongs to from these two variables, so they are set before its library loads
            os.environ["SteamAppId"] = str(options.app_id)
            os.environ["SteamGameId"] = str(options.app_id)

        steam_folder, library = find_steam(options.steam_path)
        if not library:
            Report.fail("steam_client_dll_not_found")
            return

        if options.silent:
            link, problem = SilentLink.open(library, steam_folder, options.app_id)
        else:
            link, problem = SteamLink.open(library, steam_folder)
        if link is None:
            code, detail = problem
            if code == "steam_game_refused":
                detail = "app " + str(options.app_id)
            Report.fail(code, detail)
            return

        try:
            requested = link.request_stats()
            tries = 1
            while not requested and options.silent and tries < 3:
                # right after connecting, the silent route can refuse the first request
                time.sleep(0.4)
                link._pump()
                requested = link.request_stats()
                tries += 1
            if not requested:
                Report.fail("request_current_stats_failed")
                return
            came, answer = link.wait_for_callback(CALLBACK_STATS_RECEIVED, options.app_id, 8)
            if not came or answer != RESULT_OK:
                Report.write({"ok": False, "error": "game_stats_not_owned_or_unavailable", "result": answer})
                return

            if options.command == "status":
                wait_for_schema(steam_folder, options.app_id)
                report_status(link, options.app_id, options.silent)
            elif options.command == "sync":
                report_sync(link, options.app_id, options.entries, options.silent)
            else:
                entries = [e for e in (parse_stat_entry(w, options.command == "setstats") for w in options.entries) if e]
                if not entries:
                    Report.fail("nothing_to_apply")
                    return
                if options.command == "stats":
                    report_stats(link, options.app_id, entries)
                else:
                    report_setstats(link, options.app_id, entries, options.silent)
        finally:
            link.close()
    except Exception as error:
        message = str(error)[:120]
        Report.fail("helper_exception", type(error).__name__ + ": " + message)


if __name__ == "__main__":
    main(sys.argv[1:])
