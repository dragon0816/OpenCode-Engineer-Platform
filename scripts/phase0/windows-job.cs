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
    private static extern bool TerminateProcess(IntPtr process, uint exit);
    [DllImport("kernel32.dll", SetLastError = true)]
    private static extern bool CloseHandle(IntPtr handle);

    private IntPtr job;

    public PhaseZeroJob()
    {
        job = CreateJobObject(IntPtr.Zero, IntPtr.Zero);
        if (job == IntPtr.Zero) throw new Win32Exception();
        const uint KillOnJobClose = 0x2000;
        const int ExtendedLimitInformation = 9;
        var limits = new ExtendedLimits { Basic = new BasicLimits { Flags = KillOnJobClose } };
        if (!SetInformationJobObject(job, ExtendedLimitInformation, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits))))
        {
            int error = Marshal.GetLastWin32Error();
            Dispose();
            throw new Win32Exception(error);
        }
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
