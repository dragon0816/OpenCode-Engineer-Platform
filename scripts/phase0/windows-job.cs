using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Text;
using System.Threading;

public sealed class PhaseZeroJob : IDisposable
{
    [StructLayout(LayoutKind.Sequential)]
    private struct BasicLimits
    {
        public long ProcessTime, JobTime;
        public uint Flags;
        public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
        public uint ActiveLimit;
        public UIntPtr Affinity;
        public uint PriorityClass, SchedulingClass;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ExtendedLimits
    {
        public BasicLimits Basic;
        public ulong ReadOps, WriteOps, OtherOps, ReadBytes, WriteBytes, OtherBytes;
        public UIntPtr ProcessMemory, JobMemory, PeakProcess, PeakJob;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct Accounting
    {
        public long UserTime, KernelTime, PeriodUserTime, PeriodKernelTime;
        public uint PageFaults, TotalProcesses, ActiveProcesses, TerminatedProcesses;
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
    private struct StartupInfoEx
    {
        public StartupInfo Startup;
        public IntPtr Attributes;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct ProcessInfo
    {
        public IntPtr Process, Thread;
        public uint ProcessId, ThreadId;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct SecurityCapabilities
    {
        public IntPtr Sid, Capabilities;
        public uint Count, Reserved;
    }

    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int DeriveAppContainerSidFromAppContainerName(string name, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int CreateAppContainerProfile(string name, string label, string detail,
        IntPtr capabilities, uint count, out IntPtr sid);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    private static extern int GetAppContainerFolderPath(string sid, out IntPtr path);
    [DllImport("userenv.dll", CharSet = CharSet.Unicode)]
    public static extern int DeleteAppContainerProfile(string name);
    [DllImport("advapi32.dll")]
    private static extern IntPtr FreeSid(IntPtr sid);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool GetTokenInformation(IntPtr token, int type, IntPtr value, int size, out int required);
    [DllImport("kernelbase.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool DeriveCapabilitySidsFromName(string name, out IntPtr groups, out uint groupCount,
        out IntPtr capabilities, out uint capabilityCount);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr memory);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr GetStdHandle(int which);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetHandleInformation(IntPtr handle, uint mask, uint flags);

    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern IntPtr CreateJobObject(IntPtr attributes, IntPtr name);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool SetInformationJobObject(IntPtr job, int kind, ref ExtendedLimits data, uint size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool InitializeProcThreadAttributeList(IntPtr list, int count, uint flags, ref IntPtr size);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool UpdateProcThreadAttribute(IntPtr list, uint flags, IntPtr attribute, IntPtr value,
        IntPtr size, IntPtr previousValue, IntPtr returnSize);
    [DllImport("kernel32.dll")]
    private static extern void DeleteProcThreadAttributeList(IntPtr list);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, IntPtr information, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool QueryInformationJobObject(IntPtr job, int kind, out Accounting information, uint size, IntPtr returned);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateJobObject(IntPtr job, uint exitCode);
    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcess(string executable, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint WaitForSingleObject(IntPtr handle, uint milliseconds);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool GetExitCodeProcess(IntPtr process, out uint code);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exit);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr job;
    private IntPtr pluginProcess;

    public PhaseZeroJob() : this(false) {}

    public PhaseZeroJob(bool plugin)
    {
        job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
        if (job == IntPtr.Zero) throw new Win32Exception();
        const uint KillOnJobClose = 0x2000;
        const int ExtendedLimitInformation = 9;
        var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = KillOnJobClose } };
        if (plugin)
        {
            limits.Basic.Flags |= 0x8 | 0x100; // Active process and process memory limits.
            limits.Basic.ActiveLimit = 1;
            limits.ProcessMemory = new UIntPtr(768u * 1024 * 1024);
        }
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        {
            int error = Marshal.GetLastWin32Error();
            Dispose();
            throw new Win32Exception(error);
        }
    }

    private static void Attribute(IntPtr list, int kind, IntPtr value, int size)
    {
        if (!UpdateProcThreadAttribute(list, 0, new IntPtr(kind), value, new IntPtr(size), IntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception(Marshal.GetLastWin32Error(), "Process attribute " + kind);
    }

    public static string CreatePluginProfile(string name, out string path)
    {
        IntPtr sid;
        Marshal.ThrowExceptionForHR(CreateAppContainerProfile(name, name, "OEP plugin worker", IntPtr.Zero, 0, out sid));
        try
        {
            string identity = new System.Security.Principal.SecurityIdentifier(sid).Value;
            IntPtr folder;
            Marshal.ThrowExceptionForHR(GetAppContainerFolderPath(identity, out folder));
            try { path = Marshal.PtrToStringUni(folder); }
            finally { Marshal.FreeCoTaskMem(folder); }
            return identity;
        }
        catch { DeleteAppContainerProfile(name); throw; }
        finally { FreeSid(sid); }
    }

    private static void VerifyContainer(IntPtr process, IntPtr sid, IntPtr registryRead)
    {
        IntPtr token;
        if (!OpenProcessToken(process, 8, out token)) throw new Win32Exception();
        IntPtr value = Marshal.AllocHGlobal(4096);
        try
        {
            int required;
            // TokenIsAppContainer, TokenAppContainerSid, TokenCapabilities and TokenIsLessPrivilegedAppContainer.
            if (!GetTokenInformation(token, 29, value, 4096, out required) || Marshal.ReadInt32(value) != 1 ||
                !GetTokenInformation(token, 31, value, 4096, out required) ||
                !new System.Security.Principal.SecurityIdentifier(sid).Equals(
                    new System.Security.Principal.SecurityIdentifier(Marshal.ReadIntPtr(value))) ||
                !GetTokenInformation(token, 30, value, 4096, out required) || Marshal.ReadInt32(value) != 1 ||
                !new System.Security.Principal.SecurityIdentifier(registryRead).Equals(
                    new System.Security.Principal.SecurityIdentifier(Marshal.ReadIntPtr(value, IntPtr.Size))) ||
                !GetTokenInformation(token, 47, value, 4096, out required) || Marshal.ReadInt32(value) != 1)
                throw new InvalidOperationException("Plugin AppContainer token verification failed");
        }
        finally { Marshal.FreeHGlobal(value); CloseHandle(token); }
    }

    private static void FreeSidArray(IntPtr array, uint count)
    {
        if (array == IntPtr.Zero) return;
        for (int i = 0; i < count; i++) LocalFree(Marshal.ReadIntPtr(array, i * IntPtr.Size));
        LocalFree(array);
    }

    public uint StartPlugin(string executable, string bootstrap, string directory, string name)
    {
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 4, 0, ref size);
        if (size == IntPtr.Zero) throw new Win32Exception();
        IntPtr list = Marshal.AllocHGlobal(size);
        IntPtr sid = IntPtr.Zero;
        IntPtr values = Marshal.AllocHGlobal(128);
        IntPtr groups = IntPtr.Zero, capabilitySids = IntPtr.Zero;
        uint groupCount = 0, capabilityCount = 0;
        bool initialized = false;
        try
        {
            initialized = InitializeProcThreadAttributeList(list, 4, 0, ref size);
            if (!initialized) throw new Win32Exception();
            Marshal.ThrowExceptionForHR(DeriveAppContainerSidFromAppContainerName(name, out sid));
            Marshal.WriteIntPtr(values, job);
            Attribute(list, 0x0002000D, values, IntPtr.Size);
            IntPtr capabilities = IntPtr.Add(values, 16);
            // Windows' loader needs the OS registry-read capability for desktop Python in an LPAC.
            if (!DeriveCapabilitySidsFromName("registryRead", out groups, out groupCount, out capabilitySids, out capabilityCount) ||
                capabilityCount != 1) throw new Win32Exception();
            IntPtr registryRead = Marshal.ReadIntPtr(capabilitySids);
            IntPtr capability = IntPtr.Add(values, 96);
            Marshal.WriteIntPtr(capability, registryRead);
            Marshal.WriteInt32(capability, IntPtr.Size, 4);
            Marshal.StructureToPtr(new SecurityCapabilities { Sid = sid, Capabilities = capability, Count = 1 }, capabilities, false);
            Attribute(list, 0x00020009, capabilities, Marshal.SizeOf(typeof(SecurityCapabilities)));
            IntPtr policy = IntPtr.Add(values, 48);
            Marshal.WriteInt32(policy, 1);
            Attribute(list, 0x0002000F, policy, 4);

            var handles = new[] { GetStdHandle(-10), GetStdHandle(-11), GetStdHandle(-12) };
            IntPtr inherited = IntPtr.Add(values, 64);
            for (int i = 0; i < handles.Length; i++)
            {
                if (!SetHandleInformation(handles[i], 1, 1)) throw new Win32Exception();
                Marshal.WriteIntPtr(inherited, i * IntPtr.Size, handles[i]);
            }
            Attribute(list, 0x00020002, inherited, 3 * IntPtr.Size);
            var startup = new StartupInfoEx { Startup = new StartupInfo {
                Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx)), Flags = 0x100,
                Input = handles[0], Output = handles[1], Error = handles[2] }, Attributes = list };
            ProcessInfo process;
            var command = new StringBuilder("\"" + executable + "\" -I -S -B -u \"" + bootstrap + "\"");
            // DETACHED_PROCESS avoids creating a console host in the worker's restricted Job.
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, true, 0x0008000C,
                IntPtr.Zero, directory, ref startup, out process)) throw new Win32Exception(Marshal.GetLastWin32Error(), "Create plugin process");
            try
            {
                VerifyContainer(process.Process, sid, registryRead);
                var members = Members();
                if (members.Length != 1 || members[0] != process.ProcessId)
                    throw new InvalidOperationException("Plugin Job membership failed");
                if (ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception();
                pluginProcess = process.Process;
                return process.ProcessId;
            }
            catch { TerminateProcess(process.Process, 1); throw; }
            finally { CloseHandle(process.Thread); if (pluginProcess == IntPtr.Zero) CloseHandle(process.Process); }
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(list);
            if (sid != IntPtr.Zero) FreeSid(sid);
            FreeSidArray(groups, groupCount);
            FreeSidArray(capabilitySids, capabilityCount);
            Marshal.FreeHGlobal(values);
            Marshal.FreeHGlobal(list);
        }
    }

    public bool PluginExited(uint milliseconds)
    {
        uint result = WaitForSingleObject(pluginProcess, milliseconds);
        if (result != 0 && result != 258) throw new Win32Exception();
        return result == 0;
    }

    public uint PluginExitCode()
    {
        uint code;
        if (!GetExitCodeProcess(pluginProcess, out code)) throw new Win32Exception();
        return code;
    }

    public uint Start(string executable, string script, string directory, bool resume)
    {
        const uint CreateSuspendedNoWindowExtended = 0x08080004;
        const int JobListAttribute = 0x0002000D;
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 1, 0, ref size);
        if (size == IntPtr.Zero) throw new Win32Exception();
        IntPtr list = Marshal.AllocHGlobal(size);
        IntPtr jobValue = IntPtr.Zero;
        bool initialized = false;
        var command = new StringBuilder("\"" + executable + "\" \"" + script + "\"");
        try
        {
            initialized = InitializeProcThreadAttributeList(list, 1, 0, ref size);
            if (!initialized) throw new Win32Exception();
            jobValue = Marshal.AllocHGlobal(IntPtr.Size);
            Marshal.WriteIntPtr(jobValue, job);
            if (!UpdateProcThreadAttribute(list, 0, new IntPtr(JobListAttribute), jobValue, new IntPtr(IntPtr.Size), IntPtr.Zero, IntPtr.Zero))
                throw new Win32Exception();
            var startup = new StartupInfoEx { Startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx)) }, Attributes = list };
            ProcessInfo process;
            if (!CreateProcess(executable, command, IntPtr.Zero, IntPtr.Zero, false, CreateSuspendedNoWindowExtended,
                IntPtr.Zero, directory, ref startup, out process)) throw new Win32Exception();
            try
            {
                if (resume && ResumeThread(process.Thread) == uint.MaxValue)
                {
                    int error = Marshal.GetLastWin32Error();
                    TerminateProcess(process.Process, 1);
                    throw new Win32Exception(error);
                }
                return process.ProcessId;
            }
            finally
            {
                CloseHandle(process.Thread);
                CloseHandle(process.Process);
            }
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(list);
            Marshal.FreeHGlobal(jobValue);
            Marshal.FreeHGlobal(list);
        }
    }

    public uint[] Members()
    {
        const int BasicProcessIdList = 3;
        int size = 8 + 32 * IntPtr.Size;
        IntPtr data = Marshal.AllocHGlobal(size);
        try
        {
            if (!QueryInformationJobObject(job, BasicProcessIdList, data, (uint)size, IntPtr.Zero)) throw new Win32Exception();
            int count = Marshal.ReadInt32(data, 4);
            if (count > 32 || count != Marshal.ReadInt32(data)) throw new InvalidOperationException("Incomplete job membership");
            var ids = new uint[count];
            for (int i = 0; i < count; i++) ids[i] = (uint)Marshal.ReadIntPtr(data, 8 + i * IntPtr.Size).ToInt64();
            return ids;
        }
        finally { Marshal.FreeHGlobal(data); }
    }

    public Tuple<uint, uint> TerminateAndWait(int milliseconds)
    {
        if (!TerminateJobObject(job, 1)) throw new Win32Exception();
        const int BasicAccountingInformation = 1;
        uint size = (uint)Marshal.SizeOf(typeof(Accounting));
        var elapsed = Stopwatch.StartNew();
        for (;;)
        {
            Accounting state;
            if (!QueryInformationJobObject(job, BasicAccountingInformation, out state, size, IntPtr.Zero))
                throw new Win32Exception();
            if (state.ActiveProcesses == 0 || elapsed.ElapsedMilliseconds >= milliseconds)
                return Tuple.Create(state.TotalProcesses, state.ActiveProcesses);
            Thread.Sleep(20);
        }
    }

    public void Dispose()
    {
        if (pluginProcess != IntPtr.Zero) { CloseHandle(pluginProcess); pluginProcess = IntPtr.Zero; }
        if (job == IntPtr.Zero) return;
        CloseHandle(job);
        job = IntPtr.Zero;
    }
}
