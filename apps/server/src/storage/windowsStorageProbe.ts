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
  # Protected/elevated unrelated processes must not poison the whole snapshot.
  # Their executable still blocks its own tree; target file handles are checked
  # separately. Failure of the enumeration itself remains unknown.
  try { $cwd=[F5StorageProcess]::Cwd($item.ProcessId) } catch {}
  @{pid=[int]$item.ProcessId;name=$item.Name;cwd=$cwd;paths=@($item.ExecutablePath)}
})
ConvertTo-Json -InputObject $items -Compress -Depth 4
`;

/** Read-only native file-sharing checks. Never stops or restarts applications. */
export const WINDOWS_STORAGE_FILE_PROBE = String.raw`
$ErrorActionPreference="Stop"
Add-Type -TypeDefinition @'
using System;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class F5StorageFiles {
 [DllImport("kernel32.dll",CharSet=CharSet.Unicode,ExactSpelling=true,SetLastError=true)]
 static extern SafeFileHandle CreateFileW(string path,uint access,uint sharing,IntPtr security,uint creation,uint flags,IntPtr template);
 public static bool Busy(string[] paths) {
   foreach(string path in paths) {
     // FILE_READ_DATA, no sharing, OPEN_EXISTING. Attribute-only access bypasses
     // sharing checks; requesting read access detects existing data handles.
     // This neither reads contents nor writes/deletes the file.
     using(SafeFileHandle handle=CreateFileW(path,0x1,0,IntPtr.Zero,3,0,IntPtr.Zero)) {
       if(handle.IsInvalid) {
         int code=Marshal.GetLastWin32Error();
         if(code==32 || code==33) return true;
         if(code==2 || code==3) continue;
         throw new Exception("File-sharing inspection failed: "+code);
       }
     }
   }
   return false;
 }
}
'@
# Preserve the JSON array directly: Windows PowerShell 5.1 otherwise nests it
# inside @(...), and casting that nested array joins several filenames together.
[string[]]$paths=ConvertFrom-Json ([Console]::In.ReadToEnd())
ConvertTo-Json -Compress ([F5StorageFiles]::Busy([string[]]$paths))
`;
