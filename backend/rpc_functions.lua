-- Achievement Manager backend.
--
-- Runs a small helper program that talks to the Steam client and unlocks / locks achievements on the signed-in account.
--   Windows: resources/steam_achievement_helper.cs, compiled on first use with the .NET compiler that ships with Windows.
--   Linux:   resources/steam_achievement_helper.py, run with the system's python3.
-- Both helpers write the same JSON.
--
-- Functions the frontend calls (backend.am_status, backend.am_apply). Millennium only exports a function when the three
-- annotation lines (---@ffi, ---@param, ---@return) sit directly above it, so keep everything else out of that gap.
-- `request` is a string, or a table holding `request_json`.

local logger = require("logger")
local millennium = require("millennium")
local json_ok, json = pcall(require, "json")
local fs_ok, fs = pcall(require, "fs")
local http_ok, http = pcall(require, "http")

-- Fallbacks for when Millennium doesn't provide the json / fs modules.
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

-- "windows", "linux" or "other" (macOS and the rest)
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
    -- defining the same types twice (after a plugin reload) raises an error, which is harmless
    pcall(function()
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
    local loaded, lib = pcall(ffi.load, "kernel32")
    if loaded then kernel32 = lib end
end

local CREATE_NO_WINDOW = 0x08000000
local STARTF_USESHOWWINDOW = 0x00000001
local SW_HIDE = 0

local function temp_dir()
    return os.getenv("TEMP") or os.getenv("TMP") or "C:\\Windows\\Temp"
end

-- Runs a command line without a console window and waits up to wait_ms for it to finish.
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
    -- No FFI: fall back to os.execute (a console window may flash).
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

-- Compiles the helper once. The exe name contains a hash of the source, so an updated helper never runs as an old exe.
local function helper_exe(resource, prefix, failcode)
    resource = resource or "resources/steam_achievement_helper.cs"
    prefix = prefix or "achievement_manager_helper_"
    failcode = failcode or "compilation_failed"
    local ok, source = pcall(function() return millennium.assets.read(resource) end)
    if not ok or type(source) ~= "string" or source == "" then return nil, "helper_source_missing" end

    local hash = 5381
    for i = 1, #source do hash = (hash * 33 + source:byte(i)) % 4294967296 end
    local exe = fs.join(temp_dir(), string.format("%s%08x.exe", prefix, hash))
    if fs.exists(exe) then return exe end

    local cs_path = fs.join(temp_dir(), string.format("%s%08x.cs", prefix, hash))
    local f = io.open(cs_path, "wb")
    if not f then return nil, failcode end
    f:write(source)
    f:close()

    local csc = find_csc()
    if not csc then return nil, "csc_not_found" end
    run_silent(string.format('"%s" /nologo /target:winexe /out:"%s" "%s"', csc, exe, cs_path), 60000)
    pcall(os.remove, cs_path)
    if fs.exists(exe) then return exe end
    return nil, failcode
end

local function steam_path()
    local ok, value = pcall(function() return millennium.steam_path() end)
    if ok and type(value) == "string" and value ~= "" then return value end
    return nil
end

-- ---------------------------------------------------------------------------------------------- Linux
-- Linux only. The python helper is written to a per-user folder (not /tmp, where another user could swap the file) and
-- started with a clean environment, because Steam's own LD_PRELOAD / LD_LIBRARY_PATH would break python.

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

-- Like the Windows exe, the script's name contains a hash of its source.
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

-- The Linux half of run_helper: returns the helper's JSON text, or nil plus an error code and detail.
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

    -- Drop Steam's overlay and runtime libraries; only Steam's own 64-bit folder goes on the library path.
    local env = "env -u LD_PRELOAD -u PYTHONHOME -u PYTHONPATH"
    if steam then env = env .. " LD_LIBRARY_PATH=" .. shell_quote(steam .. "/linux64")
    else env = env .. " -u LD_LIBRARY_PATH" end

    local command = string.format("%s timeout 25 %s %s %s --result-file %s", env, shell_quote(python), shell_quote(script), arguments, shell_quote(result_path))
    if steam then command = command .. " --steam-path " .. shell_quote(steam) end
    if args_path then command = command .. " --args-file " .. shell_quote(args_path) end
    -- Python's output and the exit status go to a log, which is shown if the helper writes no result.
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

local sequence = 0     -- makes temp file names unique
local busy = false    -- one request at a time

-- Runs the helper with `arguments` such as "status 220" and returns the JSON text it wrote.
-- `silent` adds --silent: the helper then works without Steam showing the user as playing the game.
local function run_helper(arguments, arg_lines, silent)
    if silent then arguments = arguments .. " --silent" end
    if PLATFORM == "linux" then
        sequence = (sequence + 1) % 1000000
        return run_helper_linux(arguments, arg_lines, steam_path(), tostring(os.time()) .. "_" .. tostring(sequence))
    elseif PLATFORM ~= "windows" then
        return nil, "unsupported_platform", tostring(jit and jit.os or "unknown")
    end

    local exe, why
    if silent then
        -- silent mode is its own program, so a problem with it never touches the normal helper
        exe, why = helper_exe("resources/steam_silent_helper.cs", "achievement_manager_silent_", "silent_compilation_failed")
    else
        -- one program for achievements and stats
        exe, why = helper_exe("resources/steam_achievement_helper.cs", "achievement_manager_helper_", "compilation_failed")
    end
    if not exe then return nil, why end

    sequence = (sequence + 1) % 1000000
    local stamp = tostring(os.time()) .. "_" .. tostring(sequence)
    local result_path = fs.join(temp_dir(), "achievement_manager_result_" .. stamp .. ".json")
    pcall(os.remove, result_path)

    local command = string.format('"%s" %s --result-file "%s"', exe, arguments, result_path)
    local steam = steam_path()
    if steam then command = command .. string.format(' --steam-path "%s"', steam) end

    -- Long lists go in a file: a command line tops out near 32,000 characters.
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

-- Turns whatever the frontend sent (an app id, a JSON string, or a table) into { steam_app_id, unlock, lock, stats, set, silent }.
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
            stats = request.stats,
            set = request.set,
            silent = request.silent == true or request.silent == "true" or request.silent == 1,
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

-- Removes control characters, quotes and backslashes from an achievement name before it goes into the args file.
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

-- Share of all players who have each achievement (the numbers on Steam's own achievements page), from Steam's public
-- Web API. No key is needed and only the app id is sent. Returns the response text, or nil if it can't be had.
-- Cached for ten minutes per game (one minute after a failure) so reloading the window doesn't ask again.
local percent_cache = {}
local function global_percentages(id)
    if not tostring(id):match("^%d+$") then return nil end
    local now = os.time()
    local hit = percent_cache[id]
    if hit and now - hit.at < hit.keep then return hit.text end
    local text = nil
    if http_ok and type(http) == "table" and type(http.get) == "function" then
        local ok, res = pcall(http.get, "https://api.steampowered.com/ISteamUserStats/GetGlobalAchievementPercentagesForApp/v2/?gameid=" .. id .. "&format=json",
            { headers = { ["Accept"] = "application/json" }, timeout = 6 })
        if ok and type(res) == "table" and res.status == 200 and type(res.body) == "string" and res.body:sub(1, 1) == "{" and #res.body < 4000000 then
            text = res.body
        end
    end
    percent_cache[id] = { text = text, at = now, keep = text and 600 or 60 }
    return text
end

-- Encodes a string as JSON (the json fallback above only handles tables).
local function json_string(text)
    return '"' .. (text:gsub('[%c"\\]', function(c) return string.format("\\u%04x", c:byte()) end)) .. '"'
end

---@ffi
---@param request string
---@return string
function am_status(request)
    return with_lock(function()
        local data = parse_request(request)
        local id = data.steam_app_id
        if not valid_appid(id) then return fail("invalid_appid") end

        local raw, err, detail = run_helper("status " .. id, nil, data.silent)
        if not raw then return fail(err or "status_failed", detail) end

        local decoded_ok, decoded = pcall(json.decode, raw)
        if not decoded_ok or type(decoded) ~= "table" then return fail("json_parse_failed", raw:sub(1, 200)) end
        if decoded.ok ~= true then return raw end      -- the helper's own error, passed through

        -- Steam writes the game's stats schema (names, descriptions, icons) while the helper waits for the stats.
        -- Send it along as hex. The helper's text is spliced instead of re-encoded so the achievements keep Steam's order.
        local schema_path = path_join(steam_path() or "", "appcache", "stats", "UserGameStatsSchema_" .. id .. ".bin")
        local schema = read_all(schema_path)
        local body = raw:match("^(.*)}%s*$")
        if not body then return fail("json_parse_failed") end
        local shares = global_percentages(id)
        if shares then body = body .. ',"percent_raw":' .. json_string(shares) end
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

        local raw, err, detail = run_helper("sync " .. id, lines, data.silent)
        if not raw then return fail(err or "sync_failed", detail) end
        local decoded_ok, decoded = pcall(json.decode, raw)
        if not decoded_ok or type(decoded) ~= "table" then return fail("json_parse_failed", raw:sub(1, 200)) end
        logger:info(string.format("Achievement Manager: app %s, +%s -%s, ok=%s", id,
            tostring(decoded.unlocked_count), tostring(decoded.locked_count), tostring(decoded.ok)))
        return raw
    end)
end

-- Stats: the numeric counters a game keeps (kills, distance, ...). Windows and Linux.
local stats_supported = PLATFORM == "windows" or PLATFORM == "linux"
-- The frontend sends entries { kind = "i" | "f" | "a", name = "...", value = ... } (kind from the schema: integer, float,
-- average rate; value only when writing). They reach the helper as lines "i:NAME" or "i:NAME=123"; numbers are re-formatted
-- here, so nothing the frontend sends is passed on as text.
local function stat_lines(list, with_value)
    local lines = {}
    for _, item in ipairs(type(list) == "table" and list or {}) do
        local kind = type(item) == "table" and tostring(item.kind or "") or ""
        local name = type(item) == "table" and clean_name(item.name or "") or ""
        if (kind == "i" or kind == "f" or kind == "a") and name ~= "" and not name:find("[=:]") then
            if not with_value then
                lines[#lines + 1] = kind .. ":" .. name
            else
                local number = tonumber(item.value)
                if kind == "i" and number and number == math.floor(number) and math.abs(number) < 2147483648 then
                    lines[#lines + 1] = string.format("i:%s=%d", name, number)
                elseif kind == "f" and number and number == number and math.abs(number) < 3.4e38 then
                    lines[#lines + 1] = string.format("f:%s=%.9g", name, number)
                end
            end
        end
    end
    return lines
end

---@ffi
---@param request string
---@return string
function am_stats(request)
    return with_lock(function()
        local data = parse_request(request)
        local id = data.steam_app_id
        if not valid_appid(id) then return fail("invalid_appid") end
        if not stats_supported then return fail("stats_unavailable", PLATFORM) end

        local lines = stat_lines(data.stats, false)
        if #lines == 0 then return fail("nothing_to_apply") end

        local raw, err, detail = run_helper("stats " .. id, lines, data.silent)
        if not raw then return fail(err or "stats_failed", detail) end
        return raw
    end)
end

---@ffi
---@param request string
---@return string
function am_stats_apply(request)
    return with_lock(function()
        local data = parse_request(request)
        local id = data.steam_app_id
        if not valid_appid(id) then return fail("invalid_appid") end
        if not stats_supported then return fail("stats_unavailable", PLATFORM) end

        local lines = stat_lines(data.set, true)
        if #lines == 0 then return fail("nothing_to_apply") end

        local raw, err, detail = run_helper("setstats " .. id, lines, data.silent)
        if not raw then return fail(err or "stats_failed", detail) end
        logger:info(string.format("Achievement Manager: app %s, %d stat(s) written", id, #lines))
        return raw
    end)
end

logger:info("Achievement Manager: RPC functions registered (" .. PLATFORM .. ")")
