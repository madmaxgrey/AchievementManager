// Steam stats helper (Windows). Reads and writes a game's numeric stats (kills, distance, counters ...) for the signed-in
// user, through the same Steam interface as the achievement helper (ISteamUserStats in steamclient64.dll).
//
// Written for the .NET Framework 4 compiler that ships with Windows (csc.exe, C# 5): no string interpolation, no ?. operator.
//
//   stats    <appid>   read the current values
//   setstats <appid>   write values, store them, then read them back from Steam
// Entries come from --args-file, one per line: "i:NAME" (integer stat), "f:NAME" (float stat), "a:NAME" (average-rate stat,
// read only), and for setstats "i:NAME=123" / "f:NAME=1.5".
// Options (anywhere): --result-file <path>, --steam-path <dir>, --args-file <path>
using System;
using System.Collections.Generic;
using System.IO;
using System.Runtime.InteropServices;
using System.Globalization;
using System.Text;
using System.Threading;

namespace SteamAchievementSync
{
    public class Program
    {
        static string ResultFilePath;
        static string SteamPathOverride;

        static string[] ConfigureOptions(string[] args)
        {
            var remaining = new List<string>();
            for (int i = 0; i < args.Length; i++)
            {
                if (args[i] == "--result-file" && i + 1 < args.Length)
                {
                    ResultFilePath = args[++i];
                    continue;
                }
                if (args[i] == "--steam-path" && i + 1 < args.Length)
                {
                    SteamPathOverride = args[++i];
                    continue;
                }
                if (args[i] == "--args-file" && i + 1 < args.Length)
                {
                    string path = args[++i];
                    try
                    {
                        foreach (string line in File.ReadAllLines(path, new UTF8Encoding(false)))
                        {
                            string trimmed = line.Trim();
                            if (trimmed.Length > 0) remaining.Add(trimmed);
                        }
                    }
                    catch { }
                    continue;
                }
                remaining.Add(args[i]);
            }
            return remaining.ToArray();
        }

        // true when Steam itself says an account is signed in (HKCU\Software\Valve\Steam\ActiveProcess\ActiveUser is not 0)
        static bool SomeoneIsSignedIn()
        {
            try
            {
                object value = Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Valve\Steam\ActiveProcess", "ActiveUser", null);
                return value is int && (int)value != 0;
            }
            catch (Exception) { return false; }
        }

        static void WriteOutput(string text)
        {
            if (!string.IsNullOrEmpty(ResultFilePath))
            {
                try
                {
                    File.WriteAllText(ResultFilePath, text, new UTF8Encoding(false));
                }
                catch { }
            }
            try
            {
                byte[] bytes = Encoding.UTF8.GetBytes(text + "\r\n");
                var stdout = Console.OpenStandardOutput();
                stdout.Write(bytes, 0, bytes.Length);
                stdout.Flush();
                return;
            }
            catch { }
            try { Console.WriteLine(text); } catch { }
        }

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
        static extern bool SetDllDirectoryA(string lpPathName);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
        static extern IntPtr LoadLibraryA(string lpLibFileName);

        [DllImport("kernel32.dll", SetLastError = true, CharSet = CharSet.Ansi)]
        static extern IntPtr GetProcAddress(IntPtr hModule, string lpProcName);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate IntPtr CreateInterfaceFn(string version, ref int returnCode);

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        struct CallbackMsg
        {
            public int m_hSteamUser;
            public int m_iCallback;
            public IntPtr m_pubParam;
            public int m_cubParam;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        struct UserStatsReceived_t
        {
            public ulong m_nGameID;
            public int m_eResult;
            public ulong m_steamIDUser;
        }

        [StructLayout(LayoutKind.Sequential, Pack = 8)]
        struct UserStatsStored_t
        {
            public ulong m_nGameID;
            public int m_eResult;
        }

        [DllImport("steamclient64.dll", EntryPoint = "Steam_BGetCallback", CallingConvention = CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        static extern bool Steam_BGetCallback64(int hPipe, ref CallbackMsg pCallbackMsg);

        [DllImport("steamclient64.dll", EntryPoint = "Steam_FreeLastCallback", CallingConvention = CallingConvention.Cdecl)]
        static extern void Steam_FreeLastCallback64(int hPipe);

        [DllImport("steamclient.dll", EntryPoint = "Steam_BGetCallback", CallingConvention = CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        static extern bool Steam_BGetCallback32(int hPipe, ref CallbackMsg pCallbackMsg);

        [DllImport("steamclient.dll", EntryPoint = "Steam_FreeLastCallback", CallingConvention = CallingConvention.Cdecl)]
        static extern void Steam_FreeLastCallback32(int hPipe);

        static bool Steam_BGetCallback(int hPipe, ref CallbackMsg pCallbackMsg)
        {
            return IntPtr.Size == 8 ? Steam_BGetCallback64(hPipe, ref pCallbackMsg) : Steam_BGetCallback32(hPipe, ref pCallbackMsg);
        }

        static void Steam_FreeLastCallback(int hPipe)
        {
            if (IntPtr.Size == 8) Steam_FreeLastCallback64(hPipe);
            else Steam_FreeLastCallback32(hPipe);
        }

        static T GetDelegate<T>(IntPtr iface, int slot) where T : class
        {
            if (iface == IntPtr.Zero) return null;
            IntPtr vtable = Marshal.ReadIntPtr(iface);
            IntPtr methodPtr = Marshal.ReadIntPtr(vtable, slot * IntPtr.Size);
            return Marshal.GetDelegateForFunctionPointer(methodPtr, typeof(T)) as T;
        }

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate int CreateSteamPipeFn(IntPtr thisPtr);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate bool ReleaseSteamPipeFn(IntPtr thisPtr, int hPipe);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate int ConnectToGlobalUserFn(IntPtr thisPtr, int hPipe);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate void ReleaseUserFn(IntPtr thisPtr, int hPipe, int hUser);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate IntPtr GetISteamUserStatsFn(IntPtr thisPtr, int hUser, int hPipe, [MarshalAs(UnmanagedType.LPStr)] string version);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate bool RequestCurrentStatsFn(IntPtr thisPtr);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate uint GetNumAchievementsFn(IntPtr thisPtr);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate IntPtr GetAchievementNameFn(IntPtr thisPtr, uint iAch);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate bool GetAchievementAndUnlockTimeFn(IntPtr thisPtr, [MarshalAs(UnmanagedType.LPStr)] string name, [MarshalAs(UnmanagedType.I1)] ref bool achieved, ref uint unlockTime);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate bool SetAchievementFn(IntPtr thisPtr, [MarshalAs(UnmanagedType.LPStr)] string name);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate bool ClearAchievementFn(IntPtr thisPtr, [MarshalAs(UnmanagedType.LPStr)] string name);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate bool StoreStatsFn(IntPtr thisPtr);

        // JSON string escaping, including control characters (a tab in an achievement name would break the output)
        static string EscapeJson(string s)
        {
            if (string.IsNullOrEmpty(s)) return "";
            var sb = new StringBuilder();
            foreach (char c in s)
            {
                switch (c)
                {
                    case '\\': sb.Append("\\\\"); break;
                    case '"': sb.Append("\\\""); break;
                    case '\r': break;
                    case '\n': sb.Append("\\n"); break;
                    case '\t': sb.Append("\\t"); break;
                    default:
                        if (c < ' ') sb.Append("\\u" + ((int)c).ToString("x4"));
                        else sb.Append(c);
                        break;
                }
            }
            return sb.ToString();
        }

        static string RegistrySteamPath()
        {
            try
            {
                return Microsoft.Win32.Registry.GetValue(@"HKEY_CURRENT_USER\Software\Valve\Steam", "SteamPath", null) as string;
            }
            catch
            {
                return null;
            }
        }

        // the folder holding steamclient64.dll: --steam-path, the SteamPath variable, the registry, the default
        static string ResolveSteamPath()
        {
            string dllName = IntPtr.Size == 8 ? "steamclient64.dll" : "steamclient.dll";
            string[] candidates = new string[]
            {
                SteamPathOverride,
                Environment.GetEnvironmentVariable("SteamPath"),
                RegistrySteamPath(),
                @"C:\Program Files (x86)\Steam"
            };
            foreach (string candidate in candidates)
            {
                if (string.IsNullOrEmpty(candidate)) continue;
                string path = candidate.Replace('/', '\\');
                if (Directory.Exists(path) && File.Exists(Path.Combine(path, dllName))) return path;
            }
            return null;
        }


        // ---- the stat calls. Each comes as an int / float pair, and Windows' compiler lays an overloaded pair out in reverse
        // order, so the float version comes first: GetStat float, GetStat int, SetStat float, SetStat int.
        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        delegate bool GetStatIntFn(IntPtr thisPtr, [MarshalAs(UnmanagedType.LPStr)] string name, ref int value);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        delegate bool GetStatFloatFn(IntPtr thisPtr, [MarshalAs(UnmanagedType.LPStr)] string name, ref float value);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        delegate bool SetStatIntFn(IntPtr thisPtr, [MarshalAs(UnmanagedType.LPStr)] string name, int value);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        delegate bool SetStatFloatFn(IntPtr thisPtr, [MarshalAs(UnmanagedType.LPStr)] string name, float value);

        class StatEntry
        {
            public char Kind;       // 'i' integer, 'f' float, 'a' average rate (read like a float)
            public string Name;
            public string Text;     // the wanted value, for setstats
        }

        class StatApi
        {
            public IntPtr Stats;
            public GetStatIntFn GetInt;
            public GetStatFloatFn GetFloat;
            public SetStatIntFn SetInt;
            public SetStatFloatFn SetFloat;
        }

        static void BindStatApi(StatApi api, bool swapped)
        {
            int getFloat = swapped ? 2 : 1, getInt = swapped ? 1 : 2, setFloat = swapped ? 4 : 3, setInt = swapped ? 3 : 4;
            api.GetFloat = GetDelegate<GetStatFloatFn>(api.Stats, getFloat);
            api.GetInt = GetDelegate<GetStatIntFn>(api.Stats, getInt);
            api.SetFloat = GetDelegate<SetStatFloatFn>(api.Stats, setFloat);
            api.SetInt = GetDelegate<SetStatIntFn>(api.Stats, setInt);
        }

        // "i:NAME" or, with a value, "i:NAME=123"
        static bool ParseEntry(string raw, bool withValue, out StatEntry entry)
        {
            entry = null;
            if (raw.Length < 3 || raw[1] != ':') return false;
            char kind = raw[0];
            if (kind != 'i' && kind != 'f' && kind != 'a') return false;
            string name = raw.Substring(2);
            string text = null;
            if (withValue)
            {
                int eq = name.LastIndexOf('=');
                if (eq < 1) return false;
                text = name.Substring(eq + 1);
                name = name.Substring(0, eq);
            }
            if (name.Length == 0) return false;
            entry = new StatEntry();
            entry.Kind = kind;
            entry.Name = name;
            entry.Text = text;
            return true;
        }

        // Asks both getters about the same stat. Steam answers false to the one of the wrong type, so if only the "other"
        // one answers, the order above is wrong on this system and the slots are bound the other way round.
        static bool OrderIsSwapped(StatApi api, StatEntry sample)
        {
            int i = 0;
            float f = 0;
            bool okInt = api.GetInt(api.Stats, sample.Name, ref i);
            bool okFloat = api.GetFloat(api.Stats, sample.Name, ref f);
            if (sample.Kind == 'i') return !okInt && okFloat;
            return !okFloat && okInt;
        }

        // the value as JSON text, or null when Steam does not know the stat
        static string ReadStat(StatApi api, StatEntry e)
        {
            if (e.Kind == 'i')
            {
                int v = 0;
                if (!api.GetInt(api.Stats, e.Name, ref v)) return null;
                return v.ToString(CultureInfo.InvariantCulture);
            }
            float f = 0;
            if (!api.GetFloat(api.Stats, e.Name, ref f)) return null;
            if (float.IsNaN(f) || float.IsInfinity(f)) return "null";
            return f.ToString("R", CultureInfo.InvariantCulture);
        }

        static bool WaitForCallback(int pipe, int callbackId, ulong appId, int seconds, out int result)
        {
            result = 0;
            bool seen = false;
            var start = DateTime.UtcNow;
            while ((DateTime.UtcNow - start).TotalSeconds < seconds)
            {
                CallbackMsg msg = new CallbackMsg();
                while (Steam_BGetCallback(pipe, ref msg))
                {
                    if (msg.m_iCallback == callbackId && msg.m_pubParam != IntPtr.Zero)
                    {
                        ulong game = (ulong)Marshal.ReadInt64(msg.m_pubParam);
                        if (game == appId)
                        {
                            result = Marshal.ReadInt32(msg.m_pubParam, 8);
                            seen = true;
                        }
                    }
                    Steam_FreeLastCallback(pipe);
                }
                if (seen) return true;
                Thread.Sleep(30);
            }
            return false;
        }

        static string Fail(string code, string detail)
        {
            string text = "{\"ok\":false,\"error\":\"" + code + "\"";
            if (!string.IsNullOrEmpty(detail)) text += ",\"detail\":\"" + EscapeJson(detail) + "\"";
            return text + "}";
        }

        // the values of the entries that Steam knows, as the inside of a JSON object, plus the names it does not know
        static string ReadAll(StatApi api, List<StatEntry> entries, List<string> missing)
        {
            var sb = new StringBuilder();
            bool first = true;
            foreach (StatEntry e in entries)
            {
                string value = ReadStat(api, e);
                if (value == null) { missing.Add(e.Name); continue; }
                if (!first) sb.Append(",");
                first = false;
                sb.Append("\"" + EscapeJson(e.Name) + "\":{\"kind\":\"" + e.Kind + "\",\"value\":" + value + "}");
            }
            return sb.ToString();
        }

        static string JsonList(List<string> names)
        {
            var sb = new StringBuilder();
            for (int i = 0; i < names.Count; i++)
            {
                if (i > 0) sb.Append(",");
                sb.Append("\"" + EscapeJson(names[i]) + "\"");
            }
            return sb.ToString();
        }

        public static void Main(string[] args)
        {
            try
            {
                args = ConfigureOptions(args);
                if (args.Length == 0) { WriteOutput(Fail("missing_arguments", null)); return; }

                string command = args[0].ToLowerInvariant();
                if (command != "stats" && command != "setstats") { WriteOutput(Fail("unknown_command", null)); return; }

                ulong appId = 0;
                if (args.Length < 2 || !ulong.TryParse(args[1], out appId) || appId == 0) { WriteOutput(Fail("invalid_appid", null)); return; }

                var entries = new List<StatEntry>();
                for (int i = 2; i < args.Length; i++)
                {
                    StatEntry parsed;
                    if (ParseEntry(args[i], command == "setstats", out parsed)) entries.Add(parsed);
                }
                if (entries.Count == 0) { WriteOutput(Fail("nothing_to_apply", null)); return; }

                // like the achievement helper: Steam takes the game from these two variables
                Environment.SetEnvironmentVariable("SteamAppId", appId.ToString());
                Environment.SetEnvironmentVariable("SteamGameId", appId.ToString());

                string steamPath = ResolveSteamPath();
                if (steamPath == null) { WriteOutput(Fail("steam_client_dll_not_found", null)); return; }
                SetDllDirectoryA(steamPath);
                string dllName = IntPtr.Size == 8 ? "steamclient64.dll" : "steamclient.dll";

                IntPtr hModule = LoadLibraryA(Path.Combine(steamPath, dllName));
                if (hModule == IntPtr.Zero) { WriteOutput(Fail("steam_client_dll_not_found", null)); return; }

                IntPtr proc = GetProcAddress(hModule, "CreateInterface");
                if (proc == IntPtr.Zero) { WriteOutput(Fail("create_interface_not_found", null)); return; }

                int retCode = 0;
                var createInterface = (CreateInterfaceFn)Marshal.GetDelegateForFunctionPointer(proc, typeof(CreateInterfaceFn));
                IntPtr steamClient = createInterface("SteamClient020", ref retCode);
                if (steamClient == IntPtr.Zero) { WriteOutput(Fail("steamclient020_not_available", null)); return; }

                var createSteamPipe = GetDelegate<CreateSteamPipeFn>(steamClient, 0);
                var releaseSteamPipe = GetDelegate<ReleaseSteamPipeFn>(steamClient, 1);
                var connectToGlobalUser = GetDelegate<ConnectToGlobalUserFn>(steamClient, 2);
                var releaseUser = GetDelegate<ReleaseUserFn>(steamClient, 4);
                var getUserStats = GetDelegate<GetISteamUserStatsFn>(steamClient, 13);

                int pipe = createSteamPipe(steamClient);
                if (pipe == 0) { WriteOutput(Fail("steam_not_running", null)); return; }

                int user = connectToGlobalUser(steamClient, pipe);
                if (user == 0)
                {
                    releaseSteamPipe(steamClient, pipe);
                    WriteOutput(SomeoneIsSignedIn() ? Fail("steam_game_refused", "app " + appId) : Fail("steam_user_not_logged_in", null));
                    return;
                }

                try
                {
                    IntPtr userStats = getUserStats(steamClient, user, pipe, "STEAMUSERSTATS_INTERFACE_VERSION012");
                    if (userStats == IntPtr.Zero) { WriteOutput(Fail("steam_userstats_unavailable", null)); return; }

                    var requestStats = GetDelegate<RequestCurrentStatsFn>(userStats, 0);
                    var storeStats = GetDelegate<StoreStatsFn>(userStats, 10);
                    if (requestStats == null || storeStats == null) { WriteOutput(Fail("steam_userstats_unavailable", "slots")); return; }

                    var api = new StatApi();
                    api.Stats = userStats;
                    BindStatApi(api, false);
                    if (api.GetInt == null || api.GetFloat == null || api.SetInt == null || api.SetFloat == null) { WriteOutput(Fail("steam_userstats_unavailable", "stat slots")); return; }

                    if (!requestStats(userStats)) { WriteOutput(Fail("request_current_stats_failed", null)); return; }
                    int answer;
                    if (!WaitForCallback(pipe, 1101, appId, 8, out answer) || answer != 1)
                    {
                        WriteOutput("{\"ok\":false,\"error\":\"game_stats_not_owned_or_unavailable\",\"result\":" + answer + "}");
                        return;
                    }

                    // check the order of the int / float slots once, on the first stat Steam knows
                    foreach (StatEntry e in entries)
                    {
                        int probeInt = 0;
                        float probeFloat = 0;
                        if (api.GetInt(userStats, e.Name, ref probeInt) || api.GetFloat(userStats, e.Name, ref probeFloat))
                        {
                            if (OrderIsSwapped(api, e)) BindStatApi(api, true);
                            break;
                        }
                    }

                    var missing = new List<string>();
                    if (command == "stats")
                    {
                        string values = ReadAll(api, entries, missing);
                        WriteOutput("{\"ok\":true,\"appid\":" + appId + ",\"stats\":{" + values + "},\"missing\":[" + JsonList(missing) + "]}");
                        return;
                    }

                    // setstats: write, store, then ask Steam for the stats again and compare what it now holds
                    var refused = new List<string>();
                    var wanted = new List<StatEntry>();
                    foreach (StatEntry e in entries)
                    {
                        if (e.Kind == 'a') { refused.Add(e.Name); continue; }
                        bool wrote = false;
                        if (e.Kind == 'i')
                        {
                            int iv;
                            if (int.TryParse(e.Text, NumberStyles.Integer, CultureInfo.InvariantCulture, out iv)) wrote = api.SetInt(userStats, e.Name, iv);
                        }
                        else
                        {
                            float fv;
                            if (float.TryParse(e.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out fv) && !float.IsNaN(fv) && !float.IsInfinity(fv)) wrote = api.SetFloat(userStats, e.Name, fv);
                        }
                        if (wrote) wanted.Add(e); else refused.Add(e.Name);
                    }

                    bool stored = wanted.Count > 0 && storeStats(userStats);
                    int storedResult = 0;
                    bool confirmed = stored && WaitForCallback(pipe, 1102, appId, 5, out storedResult) && storedResult == 1;

                    bool fromServer = false;
                    if (confirmed && requestStats(userStats))
                    {
                        int again;
                        fromServer = WaitForCallback(pipe, 1101, appId, 3, out again) && again == 1;
                    }

                    // what Steam holds now, for every stat that was asked for
                    var changed = 0;
                    foreach (StatEntry e in wanted)
                    {
                        string now = ReadStat(api, e);
                        bool same = false;
                        if (now != null)
                        {
                            if (e.Kind == 'i')
                            {
                                int a, b;
                                same = int.TryParse(now, NumberStyles.Integer, CultureInfo.InvariantCulture, out a) && int.TryParse(e.Text, NumberStyles.Integer, CultureInfo.InvariantCulture, out b) && a == b;
                            }
                            else
                            {
                                float a, b;
                                if (float.TryParse(now, NumberStyles.Float, CultureInfo.InvariantCulture, out a) && float.TryParse(e.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out b))
                                    same = Math.Abs(a - b) <= 0.0001f * Math.Max(1f, Math.Abs(b));
                            }
                        }
                        if (same) changed++; else refused.Add(e.Name);
                    }

                    var after = new List<StatEntry>(entries);
                    string valuesAfter = ReadAll(api, after, missing);
                    bool committed = stored && confirmed;
                    string output = "{\"ok\":" + (committed ? "true" : "false") + ",\"appid\":" + appId
                        + ",\"requested\":" + entries.Count + ",\"changed\":" + changed
                        + ",\"stored\":" + (stored ? "true" : "false") + ",\"callback_confirmed\":" + (confirmed ? "true" : "false")
                        + ",\"verified_from_server\":" + (fromServer ? "true" : "false")
                        + ",\"not_changed\":[" + JsonList(refused) + "],\"stats\":{" + valuesAfter + "}";
                    if (!committed) output += ",\"error\":\"store_stats_not_confirmed\"";
                    WriteOutput(output + "}");
                }
                finally
                {
                    releaseUser(steamClient, pipe, user);
                    releaseSteamPipe(steamClient, pipe);
                }
            }
            catch (Exception ex)
            {
                string message = ex.Message;
                if (message.Length > 120) message = message.Substring(0, 120);
                WriteOutput(Fail("helper_exception", ex.GetType().Name + ": " + message));
            }
        }
    }
}
