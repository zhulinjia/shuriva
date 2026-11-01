using System;
using System.ComponentModel;
using System.Runtime.InteropServices;

// Lifecycle ownership only. This does not isolate OS-user privileges.
public static class G2Job {
  [StructLayout(LayoutKind.Sequential)]
  struct BasicLimits {
    public long ProcessTime, JobTime;
    public uint Flags;
    public UIntPtr MinimumWorkingSet, MaximumWorkingSet;
    public uint ActiveProcesses;
    public UIntPtr Affinity;
    public uint Priority, Scheduling;
  }
  [StructLayout(LayoutKind.Sequential)]
  struct IoCounters { public ulong A, B, C, D, E, F; }
  [StructLayout(LayoutKind.Sequential)]
  struct ExtendedLimits {
    public BasicLimits Basic;
    public IoCounters Io;
    public UIntPtr ProcessMemory, JobMemory, PeakProcessMemory, PeakJobMemory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr CreateJobObject(IntPtr attributes, string name);
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  static extern IntPtr OpenJobObject(uint access, bool inherit, string name);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool SetInformationJobObject(IntPtr job, int type, ref ExtendedLimits value, uint size);
  [DllImport("kernel32.dll", SetLastError=true)]
  static extern bool AssignProcessToJobObject(IntPtr job, IntPtr process);
  [DllImport("kernel32.dll")] static extern IntPtr GetCurrentProcess();
  [DllImport("kernel32.dll", SetLastError=true)] public static extern bool CloseHandle(IntPtr handle);

  public static IntPtr Create(string name) {
    IntPtr job = CreateJobObject(IntPtr.Zero, name);
    int error = Marshal.GetLastWin32Error();
    // Do not join or reconfigure a job owned by another run.
    if (job == IntPtr.Zero || error == 183) {
      if (job != IntPtr.Zero) CloseHandle(job);
      throw new Win32Exception(error);
    }
    var limits = new ExtendedLimits();
    limits.Basic.Flags = 0x2000 | 0x0008; // KILL_ON_JOB_CLOSE | ACTIVE_PROCESS
    limits.Basic.ActiveProcesses = 8;
    if (!SetInformationJobObject(job, 9, ref limits, (uint)Marshal.SizeOf(typeof(ExtendedLimits)))) {
      error = Marshal.GetLastWin32Error(); CloseHandle(job); throw new Win32Exception(error);
    }
    return job;
  }
  public static void Join(string name) {
    // The broker owns the only long-lived handle. No handle is inherited.
    IntPtr job = OpenJobObject(0x0001, false, name); // JOB_OBJECT_ASSIGN_PROCESS
    if (job == IntPtr.Zero) throw new Win32Exception(Marshal.GetLastWin32Error());
    try {
      if (!AssignProcessToJobObject(job, GetCurrentProcess()))
        throw new Win32Exception(Marshal.GetLastWin32Error());
    } finally { CloseHandle(job); }
  }
}
