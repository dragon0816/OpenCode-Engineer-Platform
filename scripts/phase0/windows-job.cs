using System;
using System.ComponentModel;
using System.Diagnostics;
using System.Runtime.InteropServices;
using System.Security.Principal;
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
    private struct SidAndAttributes
    {
        public IntPtr Sid;
        public uint Attributes;
    }

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
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool CreateProcessAsUser(IntPtr token, string executable, StringBuilder command, IntPtr processAttributes,
        IntPtr threadAttributes, bool inheritHandles, uint flags, IntPtr environment, string directory,
        ref StartupInfoEx startup, out ProcessInfo process);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool OpenProcessToken(IntPtr process, uint access, out IntPtr token);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool CreateRestrictedToken(IntPtr token, uint flags, uint disableCount, IntPtr disableSids,
        uint deleteCount, IntPtr deletePrivileges, uint restrictCount, IntPtr restrictSids, out IntPtr result);
    [DllImport("advapi32.dll", SetLastError = true)]
    private static extern bool SetTokenInformation(IntPtr token, int type, ref SidAndAttributes value, uint size);
    [DllImport("kernel32.dll")]
    private static extern IntPtr GetCurrentProcess();
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern uint ResumeThread(IntPtr thread);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool TerminateProcess(IntPtr process, uint exit);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr job;

    public PhaseZeroJob() : this(0, 0, 0) { }

    public PhaseZeroJob(uint maximumProcesses, ulong maximumMemory, long userTimeLimit)
    {
        job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
        if (job == IntPtr.Zero) throw new Win32Exception();
        const uint KillOnJobClose = 0x2000;
        const int ExtendedLimitInformation = 9;
        var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = KillOnJobClose } };
        if (maximumProcesses != 0) { limits.Basic.ActiveLimit = maximumProcesses; limits.Basic.Flags |= 0x8; }
        if (maximumMemory != 0) { limits.JobMemory = new UIntPtr(maximumMemory); limits.Basic.Flags |= 0x200; }
        if (userTimeLimit != 0) { limits.Basic.JobTime = userTimeLimit; limits.Basic.Flags |= 0x4; }
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        {
            int error = Marshal.GetLastWin32Error();
            Dispose();
            throw new Win32Exception(error);
        }
    }

    // Used by the synthetic helper fixture. A low-integrity token does not enforce provider egress or host-wide read isolation.
    public Process StartLowIntegrity(string executable, string[] args, string directory, string environment,
        IntPtr input, IntPtr output, IntPtr error)
    {
        const uint SuspendedUnicodeNoWindowExtended = 0x08080404;
        IntPtr size = IntPtr.Zero;
        InitializeProcThreadAttributeList(IntPtr.Zero, 2, 0, ref size);
        if (size == IntPtr.Zero) throw new Win32Exception();
        IntPtr list = Marshal.AllocHGlobal(size);
        IntPtr handles = Marshal.AllocHGlobal(3 * IntPtr.Size);
        IntPtr jobValue = Marshal.AllocHGlobal(IntPtr.Size);
        IntPtr env = Marshal.StringToHGlobalUni(environment);
        IntPtr token = IntPtr.Zero;
        bool initialized = false;
        try
        {
            initialized = InitializeProcThreadAttributeList(list, 2, 0, ref size);
            if (!initialized) throw new Win32Exception();
            token = LowIntegrityToken();
            Marshal.WriteIntPtr(jobValue, job);
            Marshal.Copy(new[] { input, output, error }, 0, handles, 3);
            AddAttribute(list, 0x0002000D, jobValue, IntPtr.Size);
            AddAttribute(list, 0x00020002, handles, 3 * IntPtr.Size);
            var startup = new StartupInfoEx {
                Startup = new StartupInfo { Size = (uint)Marshal.SizeOf(typeof(StartupInfoEx)), Flags = 0x100,
                    Input = input, Output = output, Error = error }, Attributes = list
            };
            var command = new StringBuilder(Quote(executable));
            foreach (var arg in args) command.Append(' ').Append(Quote(arg));
            ProcessInfo process;
            if (!CreateProcessAsUser(token, executable, command, IntPtr.Zero, IntPtr.Zero, true, SuspendedUnicodeNoWindowExtended,
                env, directory, ref startup, out process)) throw new Win32Exception();
            try
            {
                var child = Process.GetProcessById((int)process.ProcessId);
                try
                {
                    var pin = child.Handle;
                    if (ResumeThread(process.Thread) == uint.MaxValue) throw new Win32Exception();
                    return child;
                }
                catch { child.Dispose(); throw; }
            }
            catch { TerminateProcess(process.Process, 1); throw; }
            finally { CloseHandle(process.Thread); CloseHandle(process.Process); }
        }
        finally
        {
            if (initialized) DeleteProcThreadAttributeList(list);
            if (token != IntPtr.Zero) CloseHandle(token);
            Marshal.FreeHGlobal(env);
            Marshal.FreeHGlobal(jobValue);
            Marshal.FreeHGlobal(handles);
            Marshal.FreeHGlobal(list);
        }
    }

    private static IntPtr LowIntegrityToken()
    {
        IntPtr current;
        if (!OpenProcessToken(GetCurrentProcess(), 0x8B, out current)) throw new Win32Exception();
        IntPtr token = IntPtr.Zero;
        try
        {
            if (!CreateRestrictedToken(current, 1, 0, IntPtr.Zero, 0, IntPtr.Zero, 0, IntPtr.Zero, out token))
                throw new Win32Exception();
            var low = new SecurityIdentifier("S-1-16-4096");
            var bytes = new byte[low.BinaryLength];
            low.GetBinaryForm(bytes, 0);
            IntPtr pointer = Marshal.AllocHGlobal(bytes.Length);
            try
            {
                Marshal.Copy(bytes, 0, pointer, bytes.Length);
                var label = new SidAndAttributes { Sid = pointer, Attributes = 0x20 };
                if (!SetTokenInformation(token, 25, ref label, (uint)(Marshal.SizeOf(typeof(SidAndAttributes)) + bytes.Length)))
                    throw new Win32Exception();
            }
            finally { Marshal.FreeHGlobal(pointer); }
            var result = token;
            token = IntPtr.Zero;
            return result;
        }
        finally
        {
            if (token != IntPtr.Zero) CloseHandle(token);
            CloseHandle(current);
        }
    }

    private static void AddAttribute(IntPtr list, int attribute, IntPtr value, int length)
    {
        if (!UpdateProcThreadAttribute(list, 0, new IntPtr(attribute), value, new IntPtr(length), IntPtr.Zero, IntPtr.Zero))
            throw new Win32Exception();
    }

    private static string Quote(string value)
    {
        var result = new StringBuilder("\"");
        int escapes = 0;
        foreach (char character in value)
        {
            if (character == '\\') { escapes++; continue; }
            if (character == '"') result.Append('\\', escapes + 1);
            result.Append('\\', escapes).Append(character);
            escapes = 0;
        }
        return result.Append('\\', escapes * 2).Append('"').ToString();
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
        if (job == IntPtr.Zero) return;
        CloseHandle(job);
        job = IntPtr.Zero;
    }
}
