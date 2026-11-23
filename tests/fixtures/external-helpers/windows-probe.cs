using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.IO.Pipes;
using System.ComponentModel;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.RegularExpressions;
using System.Threading;
using System.Threading.Tasks;

public static class HelperJobProbe
{
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool ConvertStringSecurityDescriptorToSecurityDescriptor(string sddl, uint revision, out IntPtr descriptor, IntPtr size);
    [DllImport("advapi32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern bool SetFileSecurity(string path, uint information, IntPtr descriptor);
    [DllImport("kernel32.dll")]
    private static extern IntPtr LocalFree(IntPtr address);

    public static void ProtectCanary(string path)
    {
        IntPtr descriptor;
        if (!ConvertStringSecurityDescriptorToSecurityDescriptor("S:(ML;;NWNR;;;ME)", 1, out descriptor, IntPtr.Zero))
            throw new Win32Exception();
        try { if (!SetFileSecurity(path, 0x10, descriptor)) throw new Win32Exception(); }
        finally { LocalFree(descriptor); }
    }

    private sealed class OutputLimit
    {
        public int Count;
        public const int Maximum = 128 * 1024;
    }

    private static byte[] Read(Stream input, OutputLimit limit, bool capture)
    {
        using (var data = new MemoryStream())
        {
            var buffer = new byte[4096];
            int size;
            while ((size = input.Read(buffer, 0, buffer.Length)) != 0)
            {
                if (Interlocked.Add(ref limit.Count, size) > OutputLimit.Maximum) break;
                if (capture) data.Write(buffer, 0, size);
            }
            return data.ToArray();
        }
    }

    public static object Run(string file, string[] args, string cwd, string env, byte[] input, int ownerId)
    {
            using (var owner = Process.GetProcessById(ownerId))
            using (var job = new PhaseZeroJob(8, 512UL * 1024 * 1024, TimeSpan.FromSeconds(20).Ticks))
            using (var send = new AnonymousPipeServerStream(PipeDirection.Out, HandleInheritability.Inheritable))
            using (var receive = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
            using (var errors = new AnonymousPipeServerStream(PipeDirection.In, HandleInheritability.Inheritable))
            {
                var ownerHandle = owner.Handle;
                var cancel = Task.Run(() => Console.Read());
                using (var child = job.StartLowIntegrity(file, args, cwd, env,
                    send.ClientSafePipeHandle.DangerousGetHandle(), receive.ClientSafePipeHandle.DangerousGetHandle(),
                    errors.ClientSafePipeHandle.DangerousGetHandle()))
                {
                    send.DisposeLocalCopyOfClientHandle();
                    receive.DisposeLocalCopyOfClientHandle();
                    errors.DisposeLocalCopyOfClientHandle();
                    var limit = new OutputLimit();
                    var stdout = Task.Run(() => Read(receive, limit, true));
                    var stderr = Task.Run(() => Read(errors, limit, true));
                    var writer = Task.Run(() => {
                        try { send.Write(input, 0, input.Length); }
                        catch (IOException) { }
                        finally { send.Dispose(); }
                    });
                    int? exit = null;
                    var clock = Stopwatch.StartNew();
                    var observed = new HashSet<uint>();
                    while (!owner.HasExited && !cancel.IsCompleted && Volatile.Read(ref limit.Count) <= OutputLimit.Maximum && clock.ElapsedMilliseconds < 30000)
                    {
                        observed.UnionWith(job.Members());
                        if (!child.WaitForExit(20)) continue;
                        exit = child.ExitCode;
                        break;
                    }
                    observed.UnionWith(job.Members());
                    var state = job.TerminateAndWait(3000);
                    if (state.Item2 != 0 || !Task.WaitAll(new Task[] { stdout, stderr, writer }, 2000)) throw new InvalidOperationException();
                    var diagnosis = Regex.Match(Encoding.UTF8.GetString(stderr.Result), @"fake-cli\.mjs:\d+(?::\d+)?|\b(?:EPERM|EACCES|ENOENT|ERR_[A-Z_]+)\b").Value;
                    return new { exit, stdout = stdout.Result, members = state.Item1, orphans = state.Item2, observed,
                        diagnosis,
                        reason = limit.Count > OutputLimit.Maximum ? "external-cli-output-limit" : null };
                }
            }
    }
}
