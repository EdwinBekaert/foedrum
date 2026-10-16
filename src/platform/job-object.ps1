# The Job Object helper (#92, ADR 0039). job-object.ts starts it with Windows PowerShell by its
# full path as an encoded command, with $file, $line and $cwd put in at the inputs line below.
#
# It creates a Job Object that kills every process in it when its last handle closes, and allows
# no process to break away. It starts the program suspended, assigns it to the job and only then
# lets it run, so every process the program starts is in the job from its first instruction. The
# program inherits the helper's stdin, stdout and stderr. The helper holds the only handle to the
# job and waits for the program, then exits with its exit code. When the helper ends, killed or
# after the program, the job closes and Windows ends whatever is left in it.
#
# When it cannot start the program inside a job, it writes one line starting with
# "foedrum job object: " to stdout, which nothing else has written to yet, and exits with 125.
# The runner reads that as a program that did not start (fail closed); once the program runs, the
# helper never writes it. Constrained Language Mode
# forbids the .NET calls below, and even writing to a stream directly, so the check comes first
# and its line goes out through Write-Output.

$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'
function Fail($why) {
  $text = "foedrum job object: $why"
  if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Write-Output $text; exit 125 }
  # UTF-8 without touching the console's code page, which the program shares.
  $bytes = [Text.Encoding]::UTF8.GetBytes("$text`n")
  $out = [Console]::OpenStandardOutput()
  $out.Write($bytes, 0, $bytes.Length)
  $out.Flush()
  exit 125
}
if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') {
  Fail "PowerShell runs in $($ExecutionContext.SessionState.LanguageMode) mode"
}
$process = [IntPtr]::Zero
try {
  # Foedrum: inputs

  # kernel32 through P/Invoke methods emitted in memory: Add-Type would compile C# with csc.exe
  # into the temp folder on every start.
  $module = [AppDomain]::CurrentDomain.DefineDynamicAssembly(
    (New-Object Reflection.AssemblyName 'FoedrumJobObject'), 'Run'
  ).DefineDynamicModule('FoedrumJobObject')
  $type = $module.DefineType('Kernel32', 'Public,Class')
  $dllImport = [Runtime.InteropServices.DllImportAttribute]
  $import = New-Object Reflection.Emit.CustomAttributeBuilder(
    $dllImport.GetConstructor([string]), [object[]]@('kernel32.dll'),
    [Reflection.FieldInfo[]]@($dllImport.GetField('SetLastError'), $dllImport.GetField('CharSet')),
    [object[]]@($true, [Runtime.InteropServices.CharSet]::Unicode))
  function Import($name, $returns, [Type[]]$parameters) {
    $type.DefineMethod($name, 'Public,Static,PinvokeImpl', $returns, $parameters).SetCustomAttribute($import)
  }
  Import 'CreateJobObjectW' ([IntPtr]) @([IntPtr], [IntPtr])
  Import 'SetInformationJobObject' ([bool]) @([IntPtr], [int], [byte[]], [int])
  Import 'GetStdHandle' ([IntPtr]) @([int])
  Import 'CreateProcessW' ([bool]) @([string], [Text.StringBuilder], [IntPtr], [IntPtr], [bool], [int], [IntPtr], [string], [byte[]], [byte[]])
  Import 'AssignProcessToJobObject' ([bool]) @([IntPtr], [IntPtr])
  Import 'ResumeThread' ([int]) @([IntPtr])
  Import 'TerminateProcess' ([bool]) @([IntPtr], [int])
  Import 'WaitForSingleObject' ([int]) @([IntPtr], [int])
  Import 'GetExitCodeProcess' ([bool]) @([IntPtr], [int].MakeByRefType())
  $k = $type.CreateType()
  # The reason a call failed. Its error code ($e) is read in the same statement as the call:
  # anything PowerShell runs in between, even finding a function, can overwrite it.
  $marshal = [Runtime.InteropServices.Marshal]
  function Why($what, $code) {
    "${what}: $((New-Object ComponentModel.Win32Exception $code).Message) ($code)"
  }
  $wide = [IntPtr]::Size -eq 8
  $pointer = { param($value) if ($wide) { [BitConverter]::GetBytes($value.ToInt64()) } else { [BitConverter]::GetBytes($value.ToInt32()) } }
  $read = { param($bytes, $at) if ($wide) { [IntPtr][BitConverter]::ToInt64($bytes, $at) } else { [IntPtr][BitConverter]::ToInt32($bytes, $at) } }

  $job = $k::CreateJobObjectW([IntPtr]::Zero, [IntPtr]::Zero); $e = $marshal::GetLastWin32Error()
  if ($job -eq [IntPtr]::Zero) { Fail (Why 'CreateJobObject' $e) }
  # JOBOBJECT_EXTENDED_LIMIT_INFORMATION (class 9), LimitFlags at offset 16:
  # KILL_ON_JOB_CLOSE (0x2000) and DIE_ON_UNHANDLED_EXCEPTION (0x400), so a crash ends a process
  # instead of waiting on an error dialog no one sees. No BREAKAWAY_OK: nothing leaves the job.
  $limits = New-Object byte[] ($(if ($wide) { 144 } else { 112 }))
  [BitConverter]::GetBytes(0x2400).CopyTo($limits, 16)
  $ok = $k::SetInformationJobObject($job, 9, $limits, $limits.Length); $e = $marshal::GetLastWin32Error()
  if (-not $ok) { Fail (Why 'SetInformationJobObject' $e) }

  # STARTUPINFOW with STARTF_USESTDHANDLES (0x100): the helper's own stdin, stdout and stderr.
  $startup = New-Object byte[] ($(if ($wide) { 104 } else { 68 }))
  [BitConverter]::GetBytes($startup.Length).CopyTo($startup, 0)
  [BitConverter]::GetBytes(0x100).CopyTo($startup, $(if ($wide) { 60 } else { 44 }))
  $size = [IntPtr]::Size
  foreach ($i in 0..2) {
    (& $pointer ($k::GetStdHandle(-10 - $i))).CopyTo($startup, $startup.Length - (3 - $i) * $size)
  }
  # PROCESS_INFORMATION: hProcess, hThread, dwProcessId, dwThreadId.
  $started = New-Object byte[] (2 * $size + 8)
  # CREATE_SUSPENDED (0x4); handles inherited, the helper's environment.
  $ok = $k::CreateProcessW($file, (New-Object Text.StringBuilder $line), [IntPtr]::Zero, [IntPtr]::Zero, $true, 0x4, [IntPtr]::Zero, $cwd, $startup, $started); $e = $marshal::GetLastWin32Error()
  if (-not $ok) { Fail (Why 'CreateProcess' $e) }
  $process = & $read $started 0
  $thread = & $read $started $size
  # The program exists but never ran: end it before saying so.
  function Abandon($why) { [void]$k::TerminateProcess($process, 1); Fail $why }
  $ok = $k::AssignProcessToJobObject($job, $process); $e = $marshal::GetLastWin32Error()
  if (-not $ok) { Abandon (Why 'AssignProcessToJobObject' $e) }
  $suspended = $k::ResumeThread($thread); $e = $marshal::GetLastWin32Error()
  if ($suspended -eq -1) { Abandon (Why 'ResumeThread' $e) }
} catch {
  # The program may exist, suspended and in no job: end it, or it holds the output open.
  if ($process -ne [IntPtr]::Zero) { [void]$k::TerminateProcess($process, 1) }
  Fail $_.Exception.Message
}
# The program runs from here on, so nothing below may claim that it did not start.
[void]$k::WaitForSingleObject($process, -1)
$code = 1
[void]$k::GetExitCodeProcess($process, [ref]$code)
exit $code
