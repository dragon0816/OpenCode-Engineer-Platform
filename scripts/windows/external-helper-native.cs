using System;
using System.ComponentModel;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.Runtime.InteropServices;
using System.Security.Cryptography;
using System.Security.Principal;
using System.Text;
using System.Threading;
using System.Threading.Tasks;
using Microsoft.Win32;
using Microsoft.Win32.SafeHandles;

public static class OepHelperNative
{
    public const string RegistryPath = @"SOFTWARE\OEP\ExternalHelper";
    public const string Account = "OEPExternalHelper";
    public const string Sentinel = ".oep-external-helper-sentinel";
    public const string LaunchCredential = "OEP/ExternalHelper/WindowsLogon";
    private const string ClaudeCredential = "OEP/ExternalHelper/ClaudeConsole";
    private static readonly Encoding Utf8 = new UTF8Encoding(false, true);

    [StructLayout(LayoutKind.Sequential, CharSet = CharSet.Unicode)]
    private struct Credential
    {
        public uint Flags, Type;
        public string Target, Comment;
        public long Written;
        public uint Size;
        public IntPtr Blob;
        public uint Persist, AttributeCount;
        public IntPtr Attributes;
        public string Alias, User;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct StartupInfo
    {
        public uint Size;
        public IntPtr Reserved, Desktop, Title;
        public uint X, Y, Width, Height, Columns, Rows, Fill, Flags;
        public ushort Show, ReservedSize;
        public IntPtr ReservedBytes, Input, Output, Error;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredWrite(ref Credential credential, uint flags);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredRead(string target, uint type, uint flags, out IntPtr value);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CredDelete(string target, uint type, uint flags);
    [DllImport("advapi32.dll")]
    private static extern void CredFree(IntPtr value);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateProfile(string sid, string user, StringBuilder path, uint size);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool DeleteProfile(string sid, string path, string computer);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessWithLogonW(string user, string domain, IntPtr password, uint logonFlags,
        string executable, StringBuilder command, uint flags, IntPtr environment, string cwd, ref StartupInfo startup, out ProcessInfo process);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out SafeFileHandle token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int kind, IntPtr info, uint size, out uint needed);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool LookupPrivilegeValue(string system, string privilege, out long luid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool AdjustTokenPrivileges(SafeFileHandle token, bool disableAll, byte[] state, uint length,
        IntPtr previous, IntPtr returned);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(string path, uint access, uint share, IntPtr security, uint creation, uint flags, IntPtr template);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr process, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll")]
    private static extern bool CloseHandle(IntPtr handle);

    public static void WriteCredential(string target, char[] secret)
    {
        IntPtr blob = Marshal.AllocHGlobal((secret.Length + 1) * 2);
        try
        {
            Marshal.Copy(secret, 0, blob, secret.Length);
            Marshal.WriteInt16(blob, secret.Length * 2, 0);
            var value = new Credential { Type = 1, Target = target, Blob = blob, Size = (uint)(secret.Length * 2 + 2), Persist = 2, User = Account };
            if (!CredWrite(ref value, 0)) throw new Win32Exception();
        }
        finally
        {
            Marshal.ZeroFreeGlobalAllocUnicode(blob);
        }
    }

    public static void DeleteCredential(string target)
    {
        if (!CredDelete(target, 1, 0) && Marshal.GetLastWin32Error() != 1168) throw new Win32Exception();
    }

    public static bool HasCredential(string target)
    {
        IntPtr pointer;
        if (!CredRead(target, 1, 0, out pointer))
        {
            if (Marshal.GetLastWin32Error() == 1168) return false;
            throw new Win32Exception();
        }
        CredFree(pointer);
        return true;
    }

    // Provision and store the password in one elevated process. Only the SecureString crosses into PowerShell.
    public static System.Security.SecureString ProvisionPassword()
    {
        var generated = new byte[48];
        using (var random = RandomNumberGenerator.Create()) random.GetBytes(generated);
        var chars = ("aA1!" + Convert.ToBase64String(generated)).ToCharArray();
        Array.Clear(generated, 0, generated.Length);
        try
        {
            var password = new System.Security.SecureString();
            foreach (char character in chars) password.AppendChar(character);
            WriteCredential(LaunchCredential, chars);
            password.MakeReadOnly();
            return password;
        }
        finally { Array.Clear(chars, 0, chars.Length); }
    }

    public static string EnsureProfile(string sid)
    {
        using (var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid))
        {
            if (key != null) return (string)key.GetValue("ProfileImagePath");
        }
        var path = new StringBuilder(260);
        int result = CreateProfile(sid, Account, path, (uint)path.Capacity);
        if (result != 0) Marshal.ThrowExceptionForHR(result);
        return path.ToString();
    }

    public static void RemoveProfile(string sid, string path)
    {
        using (var key = Registry.LocalMachine.OpenSubKey(@"SOFTWARE\Microsoft\Windows NT\CurrentVersion\ProfileList\" + sid))
        {
            if (key == null) return;
            if (!String.Equals((string)key.GetValue("ProfileImagePath"), path, StringComparison.OrdinalIgnoreCase))
                throw new InvalidOperationException("The helper profile changed.");
        }
        if (!DeleteProfile(sid, path, null)) throw new Win32Exception();
    }

    public static FileStream Pin(string path, string expected)
    {
        var file = new FileStream(path, FileMode.Open, FileAccess.Read, FileShare.Read);
        try
        {
            using (var hash = SHA256.Create())
            {
                string actual = BitConverter.ToString(hash.ComputeHash(file)).Replace("-", "").ToLowerInvariant();
                if (actual != expected) throw new InvalidOperationException("The helper binary changed.");
            }
            return file;
        }
        catch { file.Dispose(); throw; }
    }

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int slashes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { slashes++; continue; }
            if (character == '"') result.Append('\\', slashes + 1);
            result.Append('\\', slashes).Append(character);
            slashes = 0;
        }
        return result.Append('\\', slashes * 2).Append('"').ToString();
    }

    private static string Arguments(string[] arguments)
    {
        return String.Join(" ", Array.ConvertAll(arguments, Quote));
    }

    private sealed class Child : IDisposable
    {
        private readonly IntPtr handle;
        public Child(IntPtr handle) { this.handle = handle; }
        public bool WaitForExit(uint milliseconds)
        {
            uint result = WaitForSingleObject(handle, milliseconds);
            if (result == 0 || result == 258) return result == 0;
            throw new Win32Exception();
        }
        public int ExitCode
        {
            get { uint code; if (!GetExitCodeProcess(handle, out code)) throw new Win32Exception(); return unchecked((int)code); }
        }
        public void Dispose() { CloseHandle(handle); }
    }

    private static Child Start(PhaseZeroJob job, string executable, string[] arguments, string cwd, string environment,
        AnonymousPipeServerStream input, AnonymousPipeServerStream output, AnonymousPipeServerStream error)
    {
        bool interactive = input == null;
        const uint SuspendedUnicode = 0x404;
        var info = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfo)) };
        if (!interactive)
        {
            info.Flags = 0x100; // STARTF_USESTDHANDLES
            info.Input = input.ClientSafePipeHandle.DangerousGetHandle();
            info.Output = output.ClientSafePipeHandle.DangerousGetHandle();
            info.Error = error.ClientSafePipeHandle.DangerousGetHandle();
        }
        IntPtr pointer;
        if (!CredRead(LaunchCredential, 1, 0, out pointer)) throw new Win32Exception();
        IntPtr env = Marshal.StringToHGlobalUni(environment);
        ProcessInfo process;
        try
        {
            var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            if (credential.Size < 4 || Marshal.ReadInt16(credential.Blob, (int)credential.Size - 2) != 0)
                throw new InvalidOperationException("Invalid helper credential.");
            var line = new StringBuilder(Quote(executable) + " " + Arguments(arguments));
            if (!CreateProcessWithLogonW(Account, ".", credential.Blob, 1, executable, line,
                SuspendedUnicode | (interactive ? 0x10U : 0x08000000U), env, cwd, ref info, out process)) throw new Win32Exception();
        }
        finally { Marshal.FreeHGlobal(env); CredFree(pointer); }
        try
        {
            job.Assign(process.Process);
            if (ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception();
            return new Child(process.Process);
        }
        catch { TerminateProcess(process.Process, 1); CloseHandle(process.Process); throw; }
        finally { CloseHandle(process.Thread); }
    }

    private sealed class OutputLimit
    {
        public int Count;
        public const int Maximum = 128 * 1024;
    }

    private static byte[] ReadOutput(Stream stream, OutputLimit limit, bool capture)
    {
        using (var data = new MemoryStream())
        {
            var buffer = new byte[4096];
            int read;
            while ((read = stream.Read(buffer, 0, buffer.Length)) != 0)
            {
                if (Interlocked.Add(ref limit.Count, read) > OutputLimit.Maximum) break;
                if (capture) data.Write(buffer, 0, read);
            }
            return data.ToArray();
        }
    }

    private static byte[] RelayOutput(Stream stream, OutputLimit limit, string prefix)
    {
        var buffer = new byte[4096];
        int read;
        while ((read = stream.Read(buffer, 0, buffer.Length)) != 0)
        {
            if (Interlocked.Add(ref limit.Count, read) > OutputLimit.Maximum) break;
            Console.WriteLine(prefix + Convert.ToBase64String(buffer, 0, read));
        }
        return new byte[0];
    }

    private static void RelayInput(Stream stream, Task<string> first)
    {
        try
        {
            string line = first.GetAwaiter().GetResult();
            while (line != null && line.StartsWith("code:", StringComparison.Ordinal))
            {
                string code = line.Substring(5);
                if (!System.Text.RegularExpressions.Regex.IsMatch(code, @"\A[a-zA-Z0-9_~.%+=/#-]{1,512}\z")) return;
                var bytes = Utf8.GetBytes(code + "\n");
                try { stream.Write(bytes, 0, bytes.Length); }
                finally { Array.Clear(bytes, 0, bytes.Length); }
                line = Console.ReadLine();
            }
        }
        catch (IOException) { }
    }

    private static void ForwardInput(StreamWriter input)
    {
        try
        {
            string code;
            while ((code = Console.ReadLine()) != null)
            {
                input.WriteLine(code);
                input.Flush();
            }
        }
        catch (IOException) { }
    }

    public sealed class JobReceipt
    {
        public int? exit { get; set; }
        public string stdout { get; set; }
        public string stderr { get; set; }
        public uint members { get; set; }
        public uint orphans { get; set; }
        public string reason { get; set; }
    }

    public static JobReceipt Run(string executable, string[] arguments, string cwd, string environment, string input,
        bool interactive, bool requestRelease, int ownerId, int milliseconds)
    {
        using (var owner = Process.GetProcessById(ownerId))
        using (var job = new PhaseZeroJob(24, 1536UL * 1024 * 1024, TimeSpan.FromMinutes(3).Ticks))
        using (var send = interactive ? null : new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable))
        using (var receive = interactive ? null : new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
        using (var errors = interactive ? null : new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
        using (var child = Start(job, executable, arguments, cwd, environment, send, receive, errors))
        {
            var limit = new OutputLimit();
            bool relay = arguments[0] == "relay";
            bool status = arguments.Length >= 3 && arguments[2] == "status";
            bool capture = status || arguments.Length >= 3 && (arguments[2] == "version" || arguments[2] == "run");
            bool oldBootstrap = false;
            int? exit = null;
            var clock = Stopwatch.StartNew();
            var command = Task.Run(() => Console.ReadLine());
            var stderr = Task.FromResult(new byte[0]);
            var stdout = Task.FromResult(new byte[0]);
            var writer = Task.CompletedTask;
            Task control = command;
            if (!interactive)
            {
                send.DisposeLocalCopyOfClientHandle();
                receive.DisposeLocalCopyOfClientHandle();
                errors.DisposeLocalCopyOfClientHandle();
                // The bootstrap acknowledges its mode before inheriting the pipes into the provider.
                var ready = Task.Run(() => receive.ReadByte());
                stderr = Task.Run(() => relay ? RelayOutput(errors, limit, "err:") : ReadOutput(errors, limit, status));
                while (!ready.IsCompleted && !command.IsCompleted && !owner.HasExited && clock.ElapsedMilliseconds < milliseconds)
                    if (child.WaitForExit(20)) break;
                oldBootstrap = relay && ready.Status == TaskStatus.RanToCompletion && ready.Result == 1;
                if (ready.Status == TaskStatus.RanToCompletion && ready.Result == (relay ? 2 : 1))
                {
                    if (requestRelease) Console.WriteLine("ready");
                    while (requestRelease && !command.IsCompleted && !owner.HasExited && clock.ElapsedMilliseconds < milliseconds)
                        if (child.WaitForExit(20)) break;
                    if (!requestRelease || command.Status == TaskStatus.RanToCompletion && command.Result == "run")
                    {
                        if (requestRelease) command = Task.Run(() => Console.ReadLine());
                        if (relay) control = Task.Run(() => RelayInput(send, command));
                        else
                        {
                            control = command;
                            writer = Task.Run(() => {
                                try { var bytes = Utf8.GetBytes(input); send.Write(bytes, 0, bytes.Length); }
                                catch (IOException) { }
                                finally { send.Dispose(); }
                            });
                        }
                        stdout = Task.Run(() => relay ? RelayOutput(receive, limit, "out:") : ReadOutput(receive, limit, capture));
                    }
                    else send.Dispose();
                }
                else send.Dispose();
            }
            while (!oldBootstrap && !owner.HasExited && !control.IsCompleted && Volatile.Read(ref limit.Count) <= OutputLimit.Maximum &&
                clock.ElapsedMilliseconds < milliseconds)
            {
                if (!child.WaitForExit(20)) continue;
                exit = child.ExitCode;
                break;
            }
            var state = job.TerminateAndWait(3000);
            if (state.Item2 != 0 || !Task.WaitAll(new[] { stdout, stderr, writer }, 2000)) throw new InvalidOperationException("Helper stop unverified.");
            return new JobReceipt { exit = exit, stdout = Convert.ToBase64String(stdout.Result), members = state.Item1,
                stderr = status ? Convert.ToBase64String(stderr.Result) : null, orphans = state.Item2,
                reason = oldBootstrap ? "external-auth-setup-required" : limit.Count > OutputLimit.Maximum ? "external-cli-output-limit" : null };
        }
    }

    private static void RemoveTraverseBypass()
    {
        SafeFileHandle token;
        using (var self = Process.GetCurrentProcess())
            if (!OpenProcessToken(self.Handle, 0x28, out token)) throw new Win32Exception();
        using (token)
        {
            long luid;
            if (!LookupPrivilegeValue(null, "SeChangeNotifyPrivilege", out luid)) throw new Win32Exception();
            var state = new byte[16];
            Buffer.BlockCopy(BitConverter.GetBytes(1), 0, state, 0, 4);
            Buffer.BlockCopy(BitConverter.GetBytes(luid), 0, state, 4, 8);
            Buffer.BlockCopy(BitConverter.GetBytes(4), 0, state, 12, 4); // SE_PRIVILEGE_REMOVED
            if (!AdjustTokenPrivileges(token, false, state, 0, IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception();
            int result = Marshal.GetLastWin32Error();
            if (result != 0 && result != 1300) throw new Win32Exception(result);
        }
    }

    private static bool Denied(string directory)
    {
        if (String.IsNullOrEmpty(directory)) return false;
        using (var file = CreateFile(Path.Combine(directory, Sentinel), 0x80000000, 7, IntPtr.Zero, 3, 0, IntPtr.Zero))
        {
            return file.IsInvalid && Marshal.GetLastWin32Error() == 5;
        }
    }

    private static bool IsAdministrator(IntPtr token)
    {
        // WindowsIdentity.Groups leaves out deny-only groups, including the UAC-filtered Administrators SID.
        const int TokenGroups = 2;
        uint length;
        GetTokenInformation(token, TokenGroups, IntPtr.Zero, 0, out length);
        if (length == 0) throw new Win32Exception();
        IntPtr buffer = Marshal.AllocHGlobal(checked((int)length));
        try
        {
            if (!GetTokenInformation(token, TokenGroups, buffer, length, out length)) throw new Win32Exception();
            var admin = new SecurityIdentifier(WellKnownSidType.BuiltinAdministratorsSid, null);
            int count = Marshal.ReadInt32(buffer);
            for (int index = 0; index < count; index++)
            {
                int offset = IntPtr.Size + index * 2 * IntPtr.Size;
                if (admin.Equals(new SecurityIdentifier(Marshal.ReadIntPtr(buffer, offset)))) return true;
            }
            return false;
        }
        finally { Marshal.FreeHGlobal(buffer); }
    }

    public static void VerifyAccess(string expectedSid, string actualSid, bool administrator, string[] protectedRoots,
        Action removeTraverseBypass, Func<string, bool> readDenied, Action testWrite)
    {
        if (String.IsNullOrEmpty(expectedSid) || actualSid != expectedSid || administrator || protectedRoots.Length != 3)
            throw new InvalidOperationException("Invalid helper identity.");
        removeTraverseBypass();
        foreach (string root in protectedRoots)
            if (!readDenied(root)) throw new InvalidOperationException("Private helper access probe failed.");
        testWrite();
    }

    private static void TestWrite()
    {
        Environment.CurrentDirectory = Environment.GetEnvironmentVariable("OEP_HELPER_WORK");
        Environment.SetEnvironmentVariable("OEP_HELPER_WORK", null);
        foreach (string directory in new[] { Environment.CurrentDirectory, Path.GetTempPath() })
        {
            string write = Path.Combine(directory, Guid.NewGuid().ToString("N"));
            using (var stream = new FileStream(write, FileMode.CreateNew, FileAccess.ReadWrite, FileShare.None, 1, FileOptions.DeleteOnClose))
                stream.WriteByte(1);
        }
    }

    private static void CheckIdentityAndAccess()
    {
        using (var config = Registry.LocalMachine.OpenSubKey(RegistryPath))
        using (var identity = WindowsIdentity.GetCurrent())
        {
            if (config == null || (int)config.GetValue("Ready", 0) != 1) throw new InvalidOperationException();
            VerifyAccess((string)config.GetValue("HelperSid"), identity.User.Value, IsAdministrator(identity.Token), new[] {
                (string)config.GetValue("OwnerProfile"), (string)config.GetValue("DataRoot"), (string)config.GetValue("DefaultRoot")
            }, RemoveTraverseBypass, Denied, TestWrite);
        }
    }

    public static int Main(string[] args)
    {
        try
        {
            CheckIdentityAndAccess();
            bool interactive = args[0] == "interactive";
            bool relay = args[0] == "relay";
            if (!interactive)
            {
                Stream output = Console.OpenStandardOutput();
                output.WriteByte(relay ? (byte)2 : (byte)1);
                output.Flush();
            }
            if (args[0] == "verify") return 0;
            string provider = args[1];
            if (provider != "codex_cli" && provider != "claude_code") return 1;
            string file = Path.Combine(AppDomain.CurrentDomain.BaseDirectory, provider + ".exe");
            string operation = args[2];
            if (!interactive)
            {
                Console.InputEncoding = Utf8;
                Console.OutputEncoding = Utf8;
            }
            string data = interactive || relay ? null : Console.In.ReadToEnd();
            bool removedConsoleKey = false;
            if (provider == "claude_code")
            {
                if (operation == "key")
                {
                    var key = data.TrimEnd('\r', '\n').ToCharArray();
                    try { WriteCredential(ClaudeCredential, key); }
                    finally { Array.Clear(key, 0, key.Length); }
                    return 0;
                }
                if (operation == "logout" || operation == "cli" && !relay)
                {
                    removedConsoleKey = operation == "logout" && HasCredential(ClaudeCredential);
                    DeleteCredential(ClaudeCredential);
                }
                if (operation == "status" && HasCredential(ClaudeCredential))
                {
                    Console.WriteLine("{\"loggedIn\":true,\"authMethod\":\"api_key\"}");
                    return 0;
                }
            }
            var flags = new string[args.Length - 3];
            Array.Copy(args, 3, flags, 0, flags.Length);
            var start = new ProcessStartInfo(file, Arguments(flags));
            start.UseShellExecute = false;
            start.RedirectStandardInput = !interactive;
            if (provider == "claude_code" && operation == "run") AddClaudeKey(start);
            using (var child = Process.Start(start))
            {
                if (relay)
                {
                    Task.Run(() => ForwardInput(child.StandardInput));
                }
                else if (!interactive)
                {
                    using (var pipe = child.StandardInput)
                    {
                        pipe.Write(data);
                    }
                }
                child.WaitForExit();
                if (relay && provider == "claude_code" && operation == "cli" && child.ExitCode == 0) DeleteCredential(ClaudeCredential);
                return removedConsoleKey && child.ExitCode == 1 ? 0 : child.ExitCode;
            }
        }
        catch { return 1; }
    }

    private static void AddClaudeKey(ProcessStartInfo child)
    {
        IntPtr pointer;
        if (!CredRead(ClaudeCredential, 1, 0, out pointer))
        {
            if (Marshal.GetLastWin32Error() == 1168) return;
            throw new Win32Exception();
        }
        try
        {
            var credential = (Credential)Marshal.PtrToStructure(pointer, typeof(Credential));
            child.EnvironmentVariables["ANTHROPIC_API_KEY"] = Marshal.PtrToStringUni(credential.Blob);
        }
        finally { CredFree(pointer); }
    }
}
