/** Read-only same-session process inspection. No paths or command lines are interpolated. */
export const WINDOWS_STORAGE_PROBE = String.raw`
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using System.Text;
public static class F5StorageProcess {
 [DllImport("kernel32.dll")] static extern IntPtr OpenProcess(uint access,bool inherit,int pid);
 [DllImport("kernel32.dll")] static extern bool CloseHandle(IntPtr handle);
 [DllImport("kernel32.dll")] static extern bool ReadProcessMemory(IntPtr handle,IntPtr address,byte[] data,int count,out IntPtr read);
 [DllImport("kernel32.dll")] static extern bool IsWow64Process(IntPtr process,out bool wow);
 [DllImport("ntdll.dll")] static extern int NtQueryInformationProcess(IntPtr handle,int info,IntPtr buffer,int length,out int returned);
 static byte[] Read(IntPtr h,IntPtr address,int count) {
   byte[] data=new byte[count]; IntPtr read;
   if(!ReadProcessMemory(h,address,data,count,out read)||read.ToInt64()!=count) throw new Exception("Process memory unavailable");
   return data;
 }
 static IntPtr Pointer(byte[] data,int offset,int width) {
   return new IntPtr(width==8?BitConverter.ToInt64(data,offset):BitConverter.ToUInt32(data,offset));
 }
 public static string Cwd(int pid) {
   IntPtr h=OpenProcess(0x410,false,pid);
   if(h==IntPtr.Zero) throw new Exception("Process access unavailable");
   IntPtr buffer=Marshal.AllocHGlobal(48);
   try {
     bool wow; if(!IsWow64Process(h,out wow)) throw new Exception("Process architecture unavailable");
     int width=wow?4:IntPtr.Size, returned;
     if(NtQueryInformationProcess(h,wow?26:0,buffer,wow?IntPtr.Size:6*IntPtr.Size,out returned)!=0) throw new Exception("Process parameters unavailable");
     IntPtr peb=Marshal.ReadIntPtr(buffer,wow?0:IntPtr.Size);
     IntPtr parameters=Pointer(Read(h,IntPtr.Add(peb,width==8?0x20:0x10),width),0,width);
     byte[] current=Read(h,IntPtr.Add(parameters,width==8?0x38:0x24),width==8?16:8);
     int length=BitConverter.ToUInt16(current,0);
     return Encoding.Unicode.GetString(Read(h,Pointer(current,width==8?8:4,width),length));
   } finally { Marshal.FreeHGlobal(buffer); CloseHandle(h); }
 }
}
'@
$ErrorActionPreference="Stop"
$session=(Get-Process -Id $PID).SessionId
$items=@(Get-CimInstance Win32_Process | Where-Object { $_.SessionId -eq $session -and $_.ExecutablePath } | ForEach-Object {
  $item=$_
  $cwd=$null
  try { $cwd=[F5StorageProcess]::Cwd($item.ProcessId) } catch {
    if (!$item.ExecutablePath.StartsWith(($env:SystemRoot.TrimEnd('\')+'\'),[StringComparison]::OrdinalIgnoreCase)) { throw }
  }
  @{pid=[int]$item.ProcessId;name=$item.Name;cwd=$cwd;paths=@($item.ExecutablePath)}
})
ConvertTo-Json -InputObject $items -Compress -Depth 4
`;

/** Restart Manager only enumerates users of files. Never call RmShutdown. */
export const WINDOWS_STORAGE_FILE_PROBE = String.raw`
$ErrorActionPreference="Stop"
Add-Type -TypeDefinition @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class F5StorageFiles {
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmStartSession(out uint handle,int flags,StringBuilder key);
 [DllImport("rstrtmgr.dll",CharSet=CharSet.Unicode)] static extern int RmRegisterResources(uint handle,uint count,string[] files,uint applications,IntPtr apps,uint services,IntPtr names);
 [DllImport("rstrtmgr.dll")] static extern int RmGetList(uint handle,out uint needed,ref uint count,IntPtr apps,ref uint reboot);
 [DllImport("rstrtmgr.dll")] static extern int RmEndSession(uint handle);
 public static bool Busy(string[] paths) {
   if(paths.Length==0) return false;
   uint handle; int code=RmStartSession(out handle,0,new StringBuilder(33));
   if(code!=0) throw new Exception("File-use session unavailable: "+code);
   try {
     code=RmRegisterResources(handle,(uint)paths.Length,paths,0,IntPtr.Zero,0,IntPtr.Zero);
     if(code!=0) throw new Exception("File-use registration unavailable: "+code);
     uint needed,count=0,reboot=0;
     code=RmGetList(handle,out needed,ref count,IntPtr.Zero,ref reboot);
     if(code!=0 && code!=234) throw new Exception("File-use inspection unavailable: "+code);
     return needed>0;
   } finally { RmEndSession(handle); }
 }
}
'@
$paths=@(ConvertFrom-Json ([Console]::In.ReadToEnd()))
ConvertTo-Json -Compress ([F5StorageFiles]::Busy([string[]]$paths))
`;
