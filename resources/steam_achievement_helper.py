# Achievement Manager: the Steam helper for Linux.
#
# The plugin's Lua backend runs this file with the system's python3 (Linux only; on Windows the plugin uses
# steam_achievement_helper.cs instead). It talks to the running Steam client through steamclient.so, the same library
# Steam's own games use, and reads or changes the signed-in user's achievements for one game. It never touches a game's
# process. Only Python's standard library is used (ctypes), so nothing has to be installed.
#
#   helper status <appid> --result-file <file> [--steam-path <folder>]
#   helper sync   <appid> --result-file <file> [--steam-path <folder>] [--args-file <file>]
#
# The output is the same JSON the Windows helper of this version writes (the read-back and verified_from_server fields belong to 1.13):
#   status  {"ok":true,"appid":N,"total":N,"achievements":{"API_NAME":{"achieved":bool,"unlock_time":N},...}}
#   sync    entries "+API_NAME" (unlock), "-API_NAME" (lock) or a bare name (unlock), one per line in the args file;
#           writes {"ok":bool,"appid":N,"unlocked_count":N,"locked_count":N,...}; ok is true only when Steam confirmed the save
#   errors  {"ok":false,"error":"<code>"[,"detail":"<text>"]}
#
# Kept parseable by old interpreters (no f-strings, no annotations) so that the version check below can answer first.

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
from ctypes import CFUNCTYPE, POINTER, byref, c_bool, c_char_p, c_int, c_uint32, c_void_p


# ---------------------------------------------------------------------------------------------- what Steam fixes
# Names, positions and numbers below are dictated by Steam's own interfaces (ISteamClient, ISteamUserStats); any program
# that talks to the client has to use exactly these. They are the same ones the Windows helper uses.
CLIENT_INTERFACE = b"SteamClient020"
STATS_INTERFACE = b"STEAMUSERSTATS_INTERFACE_VERSION012"

# position of each method in the interface's table of functions
CLIENT_CREATE_PIPE, CLIENT_RELEASE_PIPE, CLIENT_CONNECT_USER, CLIENT_RELEASE_USER, CLIENT_GET_STATS = 0, 1, 2, 4, 13
STATS_REQUEST, STATS_SET, STATS_CLEAR, STATS_GET_TIME, STATS_STORE, STATS_COUNT, STATS_NAME = 0, 7, 8, 9, 10, 14, 15

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
def _slot(iface, index, restype, *argtypes):
    """The function at position `index` of an interface's table of functions; `this` is always the first argument."""
    table = ctypes.cast(iface, POINTER(c_void_p))[0]
    function = ctypes.cast(table, POINTER(c_void_p))[index]
    if not function:
        return None
    return CFUNCTYPE(restype, c_void_p, *argtypes)(function)


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

    @staticmethod
    def open(library_path, steam_folder):
        """Returns (link, None), or (None, (error code, detail)) when Steam cannot be reached."""
        # the library's own companions sit next to it; load them first so that it finds them
        library_dir = os.path.dirname(os.path.realpath(library_path))
        for companion in ("libtier0_s.so", "libvstdlib_s.so"):
            path = os.path.join(library_dir, companion)
            if os.path.isfile(path):
                try:
                    ctypes.CDLL(path, mode=ctypes.RTLD_GLOBAL)
                except OSError:
                    pass
        try:
            module = ctypes.CDLL(library_path)
        except OSError as error:
            return None, ("steam_client_dll_not_found", str(error)[:200])
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
            link._next_callback.argtypes = [c_int, POINTER(CallbackMsg)]
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
        return link, None

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

    def wait_for_callback(self, callback_id, app_id, seconds):
        """Steam answers a request with a callback that carries the game id (first 8 bytes) and a result code (the next 4).
        Waits up to `seconds` for callback `callback_id` about `app_id`; returns (whether it came, the result code)."""
        result = 0
        seen = False
        deadline = time.monotonic() + seconds
        while time.monotonic() < deadline:
            message = CallbackMsg()
            while self._next_callback(self.pipe, byref(message)):
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


# ---------------------------------------------------------------------------------------------- command line
class Options(object):
    def __init__(self):
        self.command = ""
        self.app_id = 0
        self.result_file = ""
        self.steam_path = ""
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
        if options.command not in ("status", "sync"):
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


def report_status(link, app_id):
    total = link.achievement_count()
    achievements = {}
    for index in range(total):
        name = link.achievement_name(index)
        if not name:
            continue
        known, achieved, when = link.read_achievement(name)
        achievements[name] = {"achieved": achieved, "unlock_time": when}
    Report.write({"ok": True, "appid": app_id, "total": total, "achievements": achievements})


def report_sync(link, app_id, entries):
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
    committed = stored and callback_confirmed

    payload = {"ok": committed, "appid": app_id, "unlocked_count": unlocked, "locked_count": locked,
               "requested_unlock": len(to_unlock), "requested_lock": len(to_lock),
               "stored": stored, "callback_confirmed": callback_confirmed}
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

        # Steam decides which game the connection belongs to from these two variables, so they are set before its library loads
        os.environ["SteamAppId"] = str(options.app_id)
        os.environ["SteamGameId"] = str(options.app_id)

        steam_folder, library = find_steam(options.steam_path)
        if not library:
            Report.fail("steam_client_dll_not_found")
            return

        link, problem = SteamLink.open(library, steam_folder)
        if link is None:
            code, detail = problem
            if code == "steam_game_refused":
                detail = "app " + str(options.app_id)
            Report.fail(code, detail)
            return

        try:
            if not link.request_stats():
                Report.fail("request_current_stats_failed")
                return
            came, answer = link.wait_for_callback(CALLBACK_STATS_RECEIVED, options.app_id, 8)
            if not came or answer != RESULT_OK:
                Report.write({"ok": False, "error": "game_stats_not_owned_or_unavailable", "result": answer})
                return

            if options.command == "status":
                wait_for_schema(steam_folder, options.app_id)
                report_status(link, options.app_id)
            else:
                report_sync(link, options.app_id, options.entries)
        finally:
            link.close()
    except Exception as error:
        message = str(error)[:120]
        Report.fail("helper_exception", type(error).__name__ + ": " + message)


if __name__ == "__main__":
    main(sys.argv[1:])
