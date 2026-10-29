-- Achievement Manager — backend.
--
-- Runs a small helper program that talks to the running Steam client, reads the game's achievement list and unlocks /
-- locks achievements on the signed-in account. The backend detects the operating system and picks the helper:
--   Windows: resources/steam_achievement_helper.cs, compiled on first use with the .NET Framework compiler that ships
--            with Windows. The process handling is adapted from NativeGameLink for Steam (MIT, David Miranda); see LICENSE.
--   Linux:   resources/steam_achievement_helper.py, run with the system's python3 (standard library only).
-- Both write the same JSON, so everything after "run the helper" is shared.
--
-- Frontend-callable functions (Millennium finds them by global name):
--   am_status(request)  -> JSON: every achievement's state, plus Steam's own schema file (hex) for names/icons
--   am_apply(request)   -> JSON: result of unlocking / locking the listed achievements
-- `request` arrives either as a string or as a table holding `request_json`.

local logger = require("logger")
local millennium = require("millennium")
local json_ok, json = pcall(require, "json")
local fs_ok, fs = pcall(require, "fs")

-- fallbacks, in case this Millennium does not offer the json / fs modules
if not json_ok or type(json) ~= "table" or not json.decode then
    json = {
        encode = function(t)
            local parts = {}
            for k, v in pairs(t) do
                local value
                if type(v) == "string" then value = '"' .. v:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end) .. '"'
                elseif type(v) == "boolean" or type(v) == "number" then value = tostring(v) end
                if value then parts[#parts + 1] = '"' .. k .. '":' .. value end
            end
            return "{" .. table.concat(parts, ",") .. "}"
        end,
        decode = function(text)
            if type(text) ~= "string" or not text:match("^%s*{") then error("not json") end
            return {
                ok = (text:match('"ok"%s*:%s*(%a+)') == "true"),
                unlocked_count = tonumber(text:match('"unlocked_count"%s*:%s*(%d+)')),
                locked_count = tonumber(text:match('"locked_count"%s*:%s*(%d+)')),
            }
        end,
    }
end
if not fs_ok or type(fs) ~= "table" or not fs.join then
    fs = {
        join = function(...) return table.concat({ ... }, "\\") end,
        exists = function(path) local f = io.open(path, "rb"); if f then f:close() return true end return false end,
    }
end

-- which operating system the plugin runs on: "windows", "linux" or "other" (anything else, such as macOS)
local function detect_platform()
    local ok, name = pcall(function() return jit and jit.os end)
    if ok and type(name) == "string" then
        if name == "Windows" then return "windows" end
        if name == "Linux" then return "linux" end
        return "other"
    end
    if package.config and package.config:sub(1, 1) == "\\" then return "windows" end
    local proc = io.open("/proc/version", "rb")
    if proc then proc:close() return "linux" end
    return "other"
end

local PLATFORM = detect_platform()

local ffi_ok, ffi = pcall(require, "ffi")
local kernel32 = nil

if PLATFORM == "windows" and ffi_ok and ffi then
    local defined = pcall(function()
        ffi.cdef[[
        typedef unsigned long DWORD;
        typedef int BOOL;
        typedef void* HANDLE;
        typedef const char* LPCSTR;
        typedef char* LPSTR;

        typedef struct _SECURITY_ATTRIBUTES {
            DWORD nLength;
            void* lpSecurityDescriptor;
            BOOL bInheritHandle;
        } SECURITY_ATTRIBUTES, *LPSECURITY_ATTRIBUTES;

        typedef struct _STARTUPINFOA {
            DWORD cb;
            LPSTR lpReserved;
            LPSTR lpDesktop;
            LPSTR lpTitle;
            DWORD dwX;
            DWORD dwY;
            DWORD dwXSize;
            DWORD dwYSize;
            DWORD dwXCountChars;
            DWORD dwYCountChars;
            DWORD dwFillAttribute;
            DWORD dwFlags;
            short wShowWindow;
            short cbReserved2;
            void* lpReserved2;
            HANDLE hStdInput;
            HANDLE hStdOutput;
            HANDLE hStdError;
        } STARTUPINFOA, *LPSTARTUPINFOA;

        typedef struct _PROCESS_INFORMATION {
            HANDLE hProcess;
            HANDLE hThread;
            DWORD dwProcessId;
            DWORD dwThreadId;
        } PROCESS_INFORMATION, *LPPROCESS_INFORMATION;

        BOOL CreateProcessA(
            LPCSTR lpApplicationName,
            LPSTR lpCommandLine,
            LPSECURITY_ATTRIBUTES lpProcessAttributes,
            LPSECURITY_ATTRIBUTES lpThreadAttributes,
            BOOL bInheritHandles,
            DWORD dwCreationFlags,
            void* lpEnvironment,
            LPCSTR lpCurrentDirectory,
            LPSTARTUPINFOA lpStartupInfo,
            LPPROCESS_INFORMATION lpProcessInformation
        );

        DWORD WaitForSingleObject(HANDLE hHandle, DWORD dwMilliseconds);
        BOOL CloseHandle(HANDLE hObject);
        ]]
    end)
    -- a second load of this file defines the same types again; that error is harmless
    local loaded, lib = pcall(ffi.load, "kernel32")
    if loaded then kernel32 = lib end
    if not defined and not loaded then kernel32 = nil end
end

local CREATE_NO_WINDOW = 0x08000000
local STARTF_USESHOWWINDOW = 0x00000001
local SW_HIDE = 0

local function temp_dir()
    return os.getenv("TEMP") or os.getenv("TMP") or "C:\\Windows\\Temp"
end

-- run a command line without a console window and wait for it
local function run_silent(cmd_line, wait_ms)
    if kernel32 and ffi then
        local si = ffi.new("STARTUPINFOA")
        si.cb = ffi.sizeof("STARTUPINFOA")
        si.dwFlags = STARTF_USESHOWWINDOW
        si.wShowWindow = SW_HIDE
        local pi = ffi.new("PROCESS_INFORMATION")
        local buf = ffi.new("char[?]", #cmd_line + 1)
        ffi.copy(buf, cmd_line)
        local ok = kernel32.CreateProcessA(nil, buf, nil, nil, 0, CREATE_NO_WINDOW, nil, nil, si, pi)
        if ok == 0 then return false end
        if wait_ms and wait_ms > 0 then kernel32.WaitForSingleObject(pi.hProcess, wait_ms) end
        kernel32.CloseHandle(pi.hThread)
        kernel32.CloseHandle(pi.hProcess)
        return true
    end
    -- without FFI the only way left is os.execute (a console window may flash)
    pcall(os.execute, cmd_line)
    return true
end

local function read_all(path)
    local f = io.open(path, "rb")
    if not f then return nil end
    local data = f:read("*a")
    f:close()
    return data
end

local function find_csc()
    local windir = os.getenv("WINDIR") or "C:\\Windows"
    local candidates = {
        fs.join(windir, "Microsoft.NET", "Framework64", "v4.0.30319", "csc.exe"),
        fs.join(windir, "Microsoft.NET", "Framework", "v4.0.30319", "csc.exe"),
    }
    for _, path in ipairs(candidates) do
        if fs.exists(path) then return path end
    end
    return nil
end

-- the helper is compiled once; its file name carries a hash of the source, so an updated helper
-- never runs as an old executable
local function helper_exe()
    -- the helper source is a bundled resource (resources/steam_achievement_helper.cs)
    local ok, source = pcall(function() return millennium.assets.read("resources/steam_achievement_helper.cs") end)
    if not ok or type(source) ~= "string" or source == "" then return nil, "helper_source_missing" end

    local hash = 5381
    for i = 1, #source do hash = (hash * 33 + source:byte(i)) % 4294967296 end
    local exe = fs.join(temp_dir(), string.format("achievement_manager_helper_%08x.exe", hash))
    if fs.exists(exe) then return exe end

    local cs_path = fs.join(temp_dir(), string.format("achievement_manager_helper_%08x.cs", hash))
    local f = io.open(cs_path, "wb")
    if not f then return nil, "compilation_failed" end
    f:write(source)
    f:close()

    local csc = find_csc()
    if not csc then return nil, "csc_not_found" end
    run_silent(string.format('"%s" /nologo /target:winexe /out:"%s" "%s"', csc, exe, cs_path), 60000)
    pcall(os.remove, cs_path)
    if fs.exists(exe) then return exe end
    return nil, "compilation_failed"
end

local function steam_path()
    local ok, value = pcall(function() return millennium.steam_path() end)
    if ok and type(value) == "string" and value ~= "" then return value end
    return nil
end

-- ---------------------------------------------------------------------------------------------- Linux
-- Everything below is used on Linux only. The helper is a Python script that is written to a per-user folder (never to
-- the shared /tmp, where another user could swap the file) and started through the shell with a clean environment:
-- Steam's own LD_PRELOAD / LD_LIBRARY_PATH would otherwise leak into python.

local function shell_quote(text)
    return "'" .. tostring(text):gsub("'", "'\\''") .. "'"
end

local function file_exists(path)
    local f = io.open(path, "rb")
    if f then f:close() return true end
    return false
end

local function path_join(...)
    if PLATFORM == "windows" then return fs.join(...) end
    return (table.concat({ ... }, "/"):gsub("//+", "/"))
end

local function linux_work_dir()
    local base = os.getenv("XDG_CACHE_HOME")
    if not base or base == "" then
        local home = os.getenv("HOME")
        if not home or home == "" then return nil end
        base = home .. "/.cache"
    end
    local dir = base .. "/achievement-manager"
    pcall(os.execute, "mkdir -p -m 700 " .. shell_quote(dir))
    return dir
end

local function find_python()
    for _, candidate in ipairs({ "/usr/bin/python3", "/usr/local/bin/python3", "/bin/python3" }) do
        if file_exists(candidate) then return candidate end
    end
    local ok, pipe = pcall(io.popen, "command -v python3 2>/dev/null")
    if ok and pipe then
        local found = pipe:read("*l")
        pipe:close()
        if found and found:sub(1, 1) == "/" and file_exists(found) then return found end
    end
    return nil
end

-- the script's file name carries a hash of its source, so an updated helper never runs as an old script
local function linux_helper_script(dir)
    local ok, source = pcall(function() return millennium.assets.read("resources/steam_achievement_helper.py") end)
    if not ok or type(source) ~= "string" or source == "" then return nil, "helper_source_missing" end
    local hash = 5381
    for i = 1, #source do hash = (hash * 33 + source:byte(i)) % 4294967296 end
    local script = string.format("%s/achievement_manager_helper_%08x.py", dir, hash)
    if file_exists(script) then return script end
    local f = io.open(script, "wb")
    if not f then return nil, "helper_write_failed", script end
    f:write(source)
    f:close()
    return script
end

local function tidy(text, limit)
    return ((text or ""):gsub("[%c]+", " | "):gsub("%s+", " "):sub(1, limit))
end

-- Linux counterpart of the Windows part of run_helper; returns the same things: the raw JSON text, or nil, code, detail
local function run_helper_linux(arguments, arg_lines, steam, sequence_stamp)
    local dir = linux_work_dir()
    if not dir then return nil, "helper_write_failed", "no home folder" end
    local python = find_python()
    if not python then return nil, "python_not_found" end
    local script, why, detail = linux_helper_script(dir)
    if not script then return nil, why, detail end

    local result_path = string.format("%s/result_%s.json", dir, sequence_stamp)
    local log_path = string.format("%s/run_%s.log", dir, sequence_stamp)
    pcall(os.remove, result_path)

    local args_path = nil
    if arg_lines and #arg_lines > 0 then
        args_path = string.format("%s/args_%s.txt", dir, sequence_stamp)
        local f = io.open(args_path, "wb")
        if not f then return nil, "args_file_failed" end
        f:write(table.concat(arg_lines, "\n"))
        f:close()
    end

    -- a clean environment: no preloaded overlay, no Steam runtime libraries; only Steam's own 64-bit folder is on the library path
    local env = "env -u LD_PRELOAD -u PYTHONHOME -u PYTHONPATH"
    if steam then env = env .. " LD_LIBRARY_PATH=" .. shell_quote(steam .. "/linux64")
    else env = env .. " -u LD_LIBRARY_PATH" end

    local command = string.format("%s timeout 25 %s %s %s --result-file %s", env, shell_quote(python), shell_quote(script), arguments, shell_quote(result_path))
    if steam then command = command .. " --steam-path " .. shell_quote(steam) end
    if args_path then command = command .. " --args-file " .. shell_quote(args_path) end
    -- python's own messages and the exit status go to a log, shown when the helper writes no answer
    command = command .. " > " .. shell_quote(log_path) .. " 2>&1; echo \"exit status $?\" >> " .. shell_quote(log_path)

    pcall(os.execute, command)

    local output = read_all(result_path)
    local log = read_all(log_path)
    pcall(os.remove, result_path)
    pcall(os.remove, log_path)
    if args_path then pcall(os.remove, args_path) end
    if not output or output == "" then
        return nil, "helper_failed", (log and log ~= "") and tidy(log, 400) or nil
    end
    return output
end

local sequence = 0
local busy = false

-- run the helper with `arguments` (a string such as "status 220"); returns the raw JSON text it wrote
local function run_helper(arguments, arg_lines)
    if PLATFORM == "linux" then
        sequence = (sequence + 1) % 1000000
        return run_helper_linux(arguments, arg_lines, steam_path(), tostring(os.time()) .. "_" .. tostring(sequence))
    elseif PLATFORM ~= "windows" then
        return nil, "unsupported_platform", tostring(jit and jit.os or "unknown")
    end

    local exe, why = helper_exe()
    if not exe then return nil, why end

    sequence = (sequence + 1) % 1000000
    local stamp = tostring(os.time()) .. "_" .. tostring(sequence)
    local result_path = fs.join(temp_dir(), "achievement_manager_result_" .. stamp .. ".json")
    pcall(os.remove, result_path)

    local command = string.format('"%s" %s --result-file "%s"', exe, arguments, result_path)
    local steam = steam_path()
    if steam then command = command .. string.format(' --steam-path "%s"', steam) end

    -- long lists travel in a file: a command line tops out near 32,000 characters
    local args_path = nil
    if arg_lines and #arg_lines > 0 then
        args_path = fs.join(temp_dir(), "achievement_manager_args_" .. stamp .. ".txt")
        local f = io.open(args_path, "wb")
        if not f then return nil, "args_file_failed" end
        f:write(table.concat(arg_lines, "\n"))
        f:close()
        command = command .. string.format(' --args-file "%s"', args_path)
    end

    run_silent(command, 25000)

    local output = read_all(result_path)
    pcall(os.remove, result_path)
    if args_path then pcall(os.remove, args_path) end
    if not output or output == "" then return nil, "empty_output" end
    return output
end

local function parse_request(request)
    if type(request) == "string" then
        local trimmed = request:match("^%s*(.-)%s*$") or ""
        if trimmed:match("^%d+$") then return { steam_app_id = trimmed } end
        local ok, decoded = pcall(json.decode, trimmed)
        if ok and type(decoded) == "table" then return parse_request(decoded) end
        return {}
    elseif type(request) == "table" then
        if request.request_json ~= nil then return parse_request(request.request_json) end
        local raw_id = request.steam_app_id or request.appid or request[1]
        return {
            steam_app_id = raw_id and tostring(raw_id):match("%d+") or nil,
            unlock = request.unlock,
            lock = request.lock,
        }
    end
    return {}
end

local function fail(code, detail)
    return json.encode({ ok = false, error = code, detail = detail })
end

local function valid_appid(id)
    return id and id ~= "" and id ~= "0" and #id <= 12
end

-- achievement API names come from Steam; strip anything that could break out of an argument line
local function clean_name(name)
    return (tostring(name):gsub('[%c"\\]', ""))
end

local function hex_of(data)
    return (data:gsub(".", function(c) return string.format("%02x", c:byte()) end))
end

local function with_lock(fn)
    if busy then return fail("busy") end
    busy = true
    local ok, result = pcall(fn)
    busy = false
    if not ok then
        logger:error("Achievement Manager: " .. tostring(result))
        return fail("backend_exception", tostring(result))
    end
    return result
end

---@ffi
---@param request string
---@return string
function am_status(request)
    return with_lock(function()
        local data = parse_request(request)
        local id = data.steam_app_id
        if not valid_appid(id) then return fail("invalid_appid") end

        local raw, err, detail = run_helper("status " .. id)
        if not raw then return fail(err or "status_failed", detail) end

        local decoded_ok, decoded = pcall(json.decode, raw)
        if not decoded_ok or type(decoded) ~= "table" then return fail("json_parse_failed", raw:sub(1, 200)) end
        if decoded.ok ~= true then return raw end      -- the helper's own error, passed through

        -- Steam writes the game's stats schema while the helper waits for the stats; hand it over as hex
        -- (the achievement names, descriptions and icons live there). The helper's text is spliced, not
        -- re-encoded, so the achievements keep Steam's order.
        local schema_path = path_join(steam_path() or "", "appcache", "stats", "UserGameStatsSchema_" .. id .. ".bin")
        local schema = read_all(schema_path)
        local body = raw:match("^(.*)}%s*$")
        if not body then return fail("json_parse_failed") end
        if schema and #schema > 0 then
            return body .. ',"platform":"' .. PLATFORM .. '","schema_found":true,"schema_bytes":' .. #schema .. ',"schema_hex":"' .. hex_of(schema) .. '"}'
        end
        return body .. ',"platform":"' .. PLATFORM .. '","schema_found":false}'
    end)
end

---@ffi
---@param request string
---@return string
function am_apply(request)
    return with_lock(function()
        local data = parse_request(request)
        local id = data.steam_app_id
        if not valid_appid(id) then return fail("invalid_appid") end

        local lines = {}
        for _, name in ipairs(type(data.unlock) == "table" and data.unlock or {}) do
            local clean = clean_name(name)
            if clean ~= "" then lines[#lines + 1] = "+" .. clean end
        end
        for _, name in ipairs(type(data.lock) == "table" and data.lock or {}) do
            local clean = clean_name(name)
            if clean ~= "" then lines[#lines + 1] = "-" .. clean end
        end
        if #lines == 0 then return fail("nothing_to_apply") end

        local raw, err, detail = run_helper("sync " .. id, lines)
        if not raw then return fail(err or "sync_failed", detail) end
        local decoded_ok, decoded = pcall(json.decode, raw)
        if not decoded_ok or type(decoded) ~= "table" then return fail("json_parse_failed", raw:sub(1, 200)) end
        logger:info(string.format("Achievement Manager: app %s, +%s -%s, ok=%s", id,
            tostring(decoded.unlocked_count), tostring(decoded.locked_count), tostring(decoded.ok)))
        return raw
    end)
end

logger:info("Achievement Manager: RPC functions registered (" .. PLATFORM .. ")")
