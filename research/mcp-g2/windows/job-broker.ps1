param([Parameter(Mandatory=$true)][string]$JobName,
      [Parameter(Mandatory=$true)][string]$MetadataFile,
      [Parameter(Mandatory=$true)][string]$NodePath,
      [ValidateSet('wait','graceful')][string]$Mode = 'wait')
$ErrorActionPreference = 'Stop'
if ($JobName -notmatch '^stackoryn-g2-[0-9a-f]{32}$') { throw 'Invalid owned job' }
. (Join-Path $PSScriptRoot 'owned-context.ps1')
$ownedContext = Get-G2OwnedContext -MetadataFile $MetadataFile -NodePath $NodePath
$resolvedMetadata = $ownedContext.metadata
Add-Type -LiteralPath (Join-Path $PSScriptRoot 'job-native.cs')
$jobHandle = [G2Job]::Create($JobName)
try {
  $worker = Join-Path $PSScriptRoot 'job-worker.ps1'
  $powershell = Join-Path $env:SystemRoot 'System32/WindowsPowerShell/v1.0/powershell.exe'
  $ownedRoot = Split-Path -Parent $resolvedMetadata
  $workerArgs = @('-NoLogo', '-NoProfile', '-NonInteractive', '-File', "`"$worker`"",
    '-JobName', $JobName, '-MetadataFile', "`"$resolvedMetadata`"", '-NodePath', "`"$($ownedContext.node)`"", '-Mode', $Mode)
  $process = Start-Process -FilePath $powershell -ArgumentList $workerArgs -WindowStyle Hidden -PassThru `
    -RedirectStandardOutput (Join-Path $ownedRoot 'worker.out') `
    -RedirectStandardError (Join-Path $ownedRoot 'worker.err')
  $null = $process.Handle
  [IO.File]::WriteAllText((Join-Path $ownedRoot 'broker.json'),
    (@{ broker=$PID; worker=$process.Id; phase='started' } | ConvertTo-Json))
  if (-not $process.WaitForExit(15000)) { throw 'Owned G2 process deadline' }
  $process.Refresh()
  if ($null -eq $process.ExitCode) { throw 'Owned process exit was not observed' }
  [IO.File]::WriteAllText((Join-Path $ownedRoot 'broker.json'),
    (@{ broker=$PID; worker=$process.Id; phase='exited'; code=$process.ExitCode } | ConvertTo-Json))
  exit $process.ExitCode
} finally { [void][G2Job]::CloseHandle($jobHandle) }
