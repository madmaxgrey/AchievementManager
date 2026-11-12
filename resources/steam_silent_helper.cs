// Steam silent helper (Windows). Does what the achievement and stats helpers do, but without Steam showing the user as
// playing the game: instead of the game interface (which needs SteamAppId) it uses Steam's client engine, whose stats
// object takes the game as an argument of every call, so no game is ever announced.
//
// Written for the .NET Framework 4 compiler that ships with Windows (csc.exe, C# 5): no string interpolation, no ?. operator.
// It is a separate program on purpose: a problem here can never touch the normal helpers.
//
//   status   <appid>                  achievements and their state
//   sync     <appid>                  lines "+NAME" (unlock) / "-NAME" (lock) from --args-file, then store
//   stats    <appid>                  read stats; lines "i:NAME" / "f:NAME" / "a:NAME"
//   setstats <appid>                  write stats; lines "i:NAME=123" / "f:NAME=1.5"
// Options (anywhere): --result-file <path>, --steam-path <dir>, --args-file <path>, --silent (accepted, always on)
using System;
using System.Collections.Generic;
using System.Globalization;
using System.IO;
using System.Runtime.InteropServices;
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
                if (args[i] == "--silent") continue;     // this helper is always silent
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

        // ---- Steam's client engine. The positions of its methods are fixed by Steam's interface.
        const int EngineCreatePipe = 0, EngineReleasePipe = 1, EngineConnectUser = 3, EngineReleaseUser = 6, EngineRunFrame = 19, EngineGetStats = 21;

        // positions in the client engine's stats object (every call takes the game id first, by reference)
        const int SlotCount = 3, SlotName = 4, SlotRequest = 5, SlotGetAch = 12, SlotSetAch = 13, SlotClearAch = 14, SlotStore = 16;

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate void RunFrameFn(IntPtr thisPtr);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate IntPtr GetClientStatsFn(IntPtr thisPtr, int hUser, int hPipe, IntPtr version);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        delegate bool GameCallFn(IntPtr thisPtr, ref ulong game);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate uint CountFn(IntPtr thisPtr, ref ulong game);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        delegate IntPtr NameAtFn(IntPtr thisPtr, ref ulong game, uint index);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        delegate bool GetAchFn(IntPtr thisPtr, ref ulong game, [MarshalAs(UnmanagedType.LPStr)] string name, [MarshalAs(UnmanagedType.I1)] ref bool achieved, ref uint unlockTime);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        delegate bool NamedCallFn(IntPtr thisPtr, ref ulong game, [MarshalAs(UnmanagedType.LPStr)] string name);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        delegate bool GetStatIntFn(IntPtr thisPtr, ref ulong game, [MarshalAs(UnmanagedType.LPStr)] string name, ref int value);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        delegate bool GetStatFloatFn(IntPtr thisPtr, ref ulong game, [MarshalAs(UnmanagedType.LPStr)] string name, ref float value);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        delegate bool SetStatIntFn(IntPtr thisPtr, ref ulong game, [MarshalAs(UnmanagedType.LPStr)] string name, int value);

        [UnmanagedFunctionPointer(CallingConvention.Cdecl)]
        [return: MarshalAs(UnmanagedType.I1)]
        delegate bool SetStatFloatFn(IntPtr thisPtr, ref ulong game, [MarshalAs(UnmanagedType.LPStr)] string name, float value);

        static ulong Game;           // the game id (for an app, its app id) passed on every call
        static IntPtr Engine;
        static RunFrameFn RunFrame;
        static int Pipe;

        class Api
        {
            public IntPtr Stats;
            public GameCallFn Request;
            public GameCallFn Store;
            public CountFn Count;
            public NameAtFn NameAt;
            public GetAchFn GetAch;
            public NamedCallFn SetAch;
            public NamedCallFn ClearAch;
            public GetStatIntFn GetInt;
            public GetStatFloatFn GetFloat;
            public SetStatIntFn SetInt;
            public SetStatFloatFn SetFloat;
        }

        // The stat calls come as int / float pairs at positions 7 to 10. Windows' compiler lays an overloaded pair out in
        // reverse order, so the float version comes first: GetStat float, GetStat int, SetStat float, SetStat int.
        static void BindStatApi(Api api, bool swapped)
        {
            int getFloat = swapped ? 8 : 7, getInt = swapped ? 7 : 8, setFloat = swapped ? 10 : 9, setInt = swapped ? 9 : 10;
            api.GetFloat = GetDelegate<GetStatFloatFn>(api.Stats, getFloat);
            api.GetInt = GetDelegate<GetStatIntFn>(api.Stats, getInt);
            api.SetFloat = GetDelegate<SetStatFloatFn>(api.Stats, setFloat);
            api.SetInt = GetDelegate<SetStatIntFn>(api.Stats, setInt);
        }

        class StatEntry
        {
            public char Kind;       // 'i' integer, 'f' float, 'a' average rate (read like a float)
            public string Name;
            public string Text;     // the wanted value, for setstats
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

        static string Fail(string code, string detail)
        {
            string text = "{\"ok\":false,\"error\":\"" + code + "\"";
            if (!string.IsNullOrEmpty(detail)) text += ",\"detail\":\"" + EscapeJson(detail) + "\"";
            return text + "}";
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

        // Steam answers false to the getter of the wrong type, so if only the "other" one answers, the order is wrong on this system.
        static bool OrderIsSwapped(Api api, StatEntry sample)
        {
            int i = 0;
            float f = 0;
            bool okInt = api.GetInt(api.Stats, ref Game, sample.Name, ref i);
            bool okFloat = api.GetFloat(api.Stats, ref Game, sample.Name, ref f);
            if (sample.Kind == 'i') return !okInt && okFloat;
            return !okFloat && okInt;
        }

        // the value as JSON text, or null when Steam does not know the stat
        static string ReadStat(Api api, StatEntry e)
        {
            if (e.Kind == 'i')
            {
                int v = 0;
                if (!api.GetInt(api.Stats, ref Game, e.Name, ref v)) return null;
                return v.ToString(CultureInfo.InvariantCulture);
            }
            float f = 0;
            if (!api.GetFloat(api.Stats, ref Game, e.Name, ref f)) return null;
            if (float.IsNaN(f) || float.IsInfinity(f)) return "null";
            return f.ToString("R", CultureInfo.InvariantCulture);
        }

        static string ReadAll(Api api, List<StatEntry> entries, List<string> missing)
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

        // Steam answers a request with a callback that carries the game id (first 8 bytes) and a result code (the next 4).
        // The client engine only delivers callbacks while it is being run, so it is run on every round.
        static bool WaitForCallback(int callbackId, int seconds, out int result)
        {
            result = 0;
            bool seen = false;
            var start = DateTime.UtcNow;
            while ((DateTime.UtcNow - start).TotalSeconds < seconds)
            {
                if (RunFrame != null) RunFrame(Engine);
                CallbackMsg msg = new CallbackMsg();
                while (Steam_BGetCallback(Pipe, ref msg))
                {
                    if (msg.m_iCallback == callbackId && msg.m_pubParam != IntPtr.Zero)
                    {
                        ulong gameId = (ulong)Marshal.ReadInt64(msg.m_pubParam);
                        if ((gameId & 0xFFFFFF) == Game)
                        {
                            result = Marshal.ReadInt32(msg.m_pubParam, 8);
                            seen = true;
                        }
                    }
                    Steam_FreeLastCallback(Pipe);
                }
                if (seen) return true;
                Thread.Sleep(30);
            }
            return false;
        }

        // Steam writes the stats schema (names, descriptions, icons) a moment after it answers. Wait until the file exists and
        // stops growing, otherwise a game opened for the first time shows raw IDs and no icons.
        static void WaitForSchema(string steamPath, ulong appId)
        {
            string schemaPath = Path.Combine(Path.Combine(Path.Combine(steamPath, "appcache"), "stats"), "UserGameStatsSchema_" + appId + ".bin");
            var started = DateTime.UtcNow;
            long lastSize = -1;
            while ((DateTime.UtcNow - started).TotalSeconds < 4)
            {
                try
                {
                    if (File.Exists(schemaPath))
                    {
                        long size = new FileInfo(schemaPath).Length;
                        if (size > 0 && size == lastSize) return;
                        lastSize = size;
                    }
                }
                catch { }
                Thread.Sleep(150);
            }
        }

        static bool Achieved(Api api, string name)
        {
            bool achieved = false;
            uint when = 0;
            api.GetAch(api.Stats, ref Game, name, ref achieved, ref when);
            return achieved;
        }

        static void ReportStatus(Api api, string steamPath, ulong appId)
        {
            WaitForSchema(steamPath, appId);
            uint total = api.Count(api.Stats, ref Game);
            var sb = new StringBuilder();
            bool first = true;
            int named = 0;
            for (uint i = 0; i < total; i++)
            {
                IntPtr namePtr = api.NameAt(api.Stats, ref Game, i);
                if (namePtr == IntPtr.Zero) continue;
                string name = Marshal.PtrToStringAnsi(namePtr);
                if (string.IsNullOrEmpty(name)) continue;
                named++;

                bool achieved = false;
                uint unlockTime = 0;
                api.GetAch(api.Stats, ref Game, name, ref achieved, ref unlockTime);

                if (!first) sb.Append(",");
                first = false;
                sb.Append("\"" + EscapeJson(name) + "\":{\"achieved\":" + (achieved ? "true" : "false") + ",\"unlock_time\":" + unlockTime + "}");
            }
            if (total > 0 && named == 0)
            {
                // Steam counted achievements but gave no names: this route cannot list them on this system
                WriteOutput(Fail("silent_unavailable", "achievement names"));
                return;
            }
            WriteOutput("{\"ok\":true,\"appid\":" + appId + ",\"total\":" + total + ",\"achievements\":{" + sb.ToString() + "},\"silent\":true}");
        }

        static void ReportSync(Api api, ulong appId, string[] args)
        {
            var unlockList = new List<string>();
            var lockList = new List<string>();
            for (int i = 2; i < args.Length; i++)
            {
                string arg = args[i];
                if (arg.StartsWith("+")) unlockList.Add(arg.Substring(1).Trim());
                else if (arg.StartsWith("-")) lockList.Add(arg.Substring(1).Trim());
                else unlockList.Add(arg.Trim());
            }
            if (unlockList.Count + lockList.Count == 0) { WriteOutput(Fail("nothing_to_apply", null)); return; }

            int unlockedCount = 0;
            int lockedCount = 0;
            foreach (string ach in unlockList)
            {
                if (string.IsNullOrEmpty(ach)) continue;
                if (api.SetAch(api.Stats, ref Game, ach)) unlockedCount++;
            }
            foreach (string ach in lockList)
            {
                if (string.IsNullOrEmpty(ach)) continue;
                if (api.ClearAch(api.Stats, ref Game, ach)) lockedCount++;
            }

            bool stored = api.Store(api.Stats, ref Game);

            // Steam confirms the save with callback 1102; this route may not deliver it, so a save is also accepted when Steam now reports every change
            int storedResult;
            bool confirmed = WaitForCallback(1102, 4, out storedResult) && storedResult == 1;
            bool readBack = false;
            if (stored && !confirmed)
            {
                readBack = true;
                foreach (string ach in unlockList) { if (!string.IsNullOrEmpty(ach) && !Achieved(api, ach)) readBack = false; }
                foreach (string ach in lockList) { if (!string.IsNullOrEmpty(ach) && Achieved(api, ach)) readBack = false; }
                confirmed = readBack;
            }

            bool committed = stored && confirmed;
            WriteOutput("{\"ok\":" + (committed ? "true" : "false") + ",\"appid\":" + appId + ",\"unlocked_count\":" + unlockedCount + ",\"locked_count\":" + lockedCount
                + ",\"requested_unlock\":" + unlockList.Count + ",\"requested_lock\":" + lockList.Count
                + ",\"stored\":" + (stored ? "true" : "false") + ",\"callback_confirmed\":" + (confirmed ? "true" : "false")
                + ",\"silent\":true,\"confirmed_by_read_back\":" + (readBack ? "true" : "false")
                + (committed ? "" : ",\"error\":\"store_stats_not_confirmed\"") + "}");
        }

        static void ReportStats(Api api, ulong appId, string command, List<StatEntry> entries)
        {
            // check the order of the int / float slots once, on the first stat Steam knows
            foreach (StatEntry e in entries)
            {
                int probeInt = 0;
                float probeFloat = 0;
                if (api.GetInt(api.Stats, ref Game, e.Name, ref probeInt) || api.GetFloat(api.Stats, ref Game, e.Name, ref probeFloat))
                {
                    if (OrderIsSwapped(api, e)) BindStatApi(api, true);
                    break;
                }
            }

            var missing = new List<string>();
            if (command == "stats")
            {
                string values = ReadAll(api, entries, missing);
                WriteOutput("{\"ok\":true,\"appid\":" + appId + ",\"stats\":{" + values + "},\"missing\":[" + JsonList(missing) + "],\"silent\":true}");
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
                    if (int.TryParse(e.Text, NumberStyles.Integer, CultureInfo.InvariantCulture, out iv)) wrote = api.SetInt(api.Stats, ref Game, e.Name, iv);
                }
                else
                {
                    float fv;
                    if (float.TryParse(e.Text, NumberStyles.Float, CultureInfo.InvariantCulture, out fv) && !float.IsNaN(fv) && !float.IsInfinity(fv)) wrote = api.SetFloat(api.Stats, ref Game, e.Name, fv);
                }
                if (wrote) wanted.Add(e); else refused.Add(e.Name);
            }

            bool stored = wanted.Count > 0 && api.Store(api.Stats, ref Game);
            int storedResult = 0;
            bool confirmed = false;
            if (stored)
            {
                // this route may not deliver the callback: the values are compared with what Steam holds further down
                confirmed = WaitForCallback(1102, 5, out storedResult) && storedResult == 1;
                if (!confirmed)
                {
                    confirmed = true;
                    foreach (StatEntry e in wanted) { if (ReadStat(api, e) == null) confirmed = false; }
                }
            }

            bool fromServer = false;
            if (confirmed && api.Request(api.Stats, ref Game))
            {
                int again;
                fromServer = WaitForCallback(1101, 3, out again) && again == 1;
            }

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
                + ",\"not_changed\":[" + JsonList(refused) + "],\"stats\":{" + valuesAfter + "},\"silent\":true";
            if (!committed) output += ",\"error\":\"store_stats_not_confirmed\"";
            WriteOutput(output + "}");
        }

        public static void Main(string[] args)
        {
            try
            {
                args = ConfigureOptions(args);
                if (args.Length == 0) { WriteOutput(Fail("missing_arguments", null)); return; }

                string command = args[0].ToLowerInvariant();
                if (command != "status" && command != "sync" && command != "stats" && command != "setstats") { WriteOutput(Fail("unknown_command", null)); return; }

                ulong appId = 0;
                if (args.Length < 2 || !ulong.TryParse(args[1], out appId) || appId == 0) { WriteOutput(Fail("invalid_appid", null)); return; }
                Game = appId & 0xFFFFFF;

                var entries = new List<StatEntry>();
                if (command == "stats" || command == "setstats")
                {
                    for (int i = 2; i < args.Length; i++)
                    {
                        StatEntry parsed;
                        if (ParseEntry(args[i], command == "setstats", out parsed)) entries.Add(parsed);
                    }
                    if (entries.Count == 0) { WriteOutput(Fail("nothing_to_apply", null)); return; }
                }

                // silent: no game is announced, so neither variable may be present
                Environment.SetEnvironmentVariable("SteamAppId", null);
                Environment.SetEnvironmentVariable("SteamGameId", null);

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
                Engine = createInterface("CLIENTENGINE_INTERFACE_VERSION005", ref retCode);
                if (Engine == IntPtr.Zero) { WriteOutput(Fail("silent_unavailable", "client engine not available")); return; }

                var createPipe = GetDelegate<CreateSteamPipeFn>(Engine, EngineCreatePipe);
                var releasePipe = GetDelegate<ReleaseSteamPipeFn>(Engine, EngineReleasePipe);
                var connectUser = GetDelegate<ConnectToGlobalUserFn>(Engine, EngineConnectUser);
                var releaseUser = GetDelegate<ReleaseUserFn>(Engine, EngineReleaseUser);
                var getStats = GetDelegate<GetClientStatsFn>(Engine, EngineGetStats);
                RunFrame = GetDelegate<RunFrameFn>(Engine, EngineRunFrame);
                if (createPipe == null || releasePipe == null || connectUser == null || releaseUser == null || getStats == null || RunFrame == null)
                {
                    WriteOutput(Fail("silent_unavailable", "client engine slots"));
                    return;
                }

                Pipe = createPipe(Engine);
                if (Pipe == 0) { WriteOutput(Fail("steam_not_running", null)); return; }

                int user = connectUser(Engine, Pipe);
                if (user == 0)
                {
                    releasePipe(Engine, Pipe);
                    WriteOutput(SomeoneIsSignedIn() ? Fail("silent_unavailable", "could not connect to the signed-in user") : Fail("steam_user_not_logged_in", null));
                    return;
                }

                try
                {
                    // no interface version is asked for: the engine hands out its own stats object
                    IntPtr stats = getStats(Engine, user, Pipe, IntPtr.Zero);
                    if (stats == IntPtr.Zero) { WriteOutput(Fail("silent_unavailable", "client stats interface")); return; }

                    var api = new Api();
                    api.Stats = stats;
                    api.Request = GetDelegate<GameCallFn>(stats, SlotRequest);
                    api.Store = GetDelegate<GameCallFn>(stats, SlotStore);
                    api.Count = GetDelegate<CountFn>(stats, SlotCount);
                    api.NameAt = GetDelegate<NameAtFn>(stats, SlotName);
                    api.GetAch = GetDelegate<GetAchFn>(stats, SlotGetAch);
                    api.SetAch = GetDelegate<NamedCallFn>(stats, SlotSetAch);
                    api.ClearAch = GetDelegate<NamedCallFn>(stats, SlotClearAch);
                    BindStatApi(api, false);
                    if (api.Request == null || api.Store == null || api.Count == null || api.NameAt == null || api.GetAch == null || api.SetAch == null || api.ClearAch == null
                        || api.GetInt == null || api.GetFloat == null || api.SetInt == null || api.SetFloat == null)
                    {
                        WriteOutput(Fail("silent_unavailable", "client stats slots"));
                        return;
                    }

                    // right after connecting, this route can refuse the first request, so it is tried up to three times
                    bool requested = api.Request(stats, ref Game);
                    for (int attempt = 1; !requested && attempt < 3; attempt++)
                    {
                        Thread.Sleep(400);
                        RunFrame(Engine);
                        requested = api.Request(stats, ref Game);
                    }
                    if (!requested) { WriteOutput(Fail("request_current_stats_failed", null)); return; }

                    int answer;
                    if (!WaitForCallback(1101, 8, out answer) || answer != 1)
                    {
                        WriteOutput("{\"ok\":false,\"error\":\"game_stats_not_owned_or_unavailable\",\"result\":" + answer + "}");
                        return;
                    }

                    if (command == "status") ReportStatus(api, steamPath, appId);
                    else if (command == "sync") ReportSync(api, appId, args);
                    else ReportStats(api, appId, command, entries);
                }
                finally
                {
                    releaseUser(Engine, Pipe, user);
                    releasePipe(Engine, Pipe);
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
