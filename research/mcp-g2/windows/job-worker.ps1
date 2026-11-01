param([Parameter(Mandatory=$true)][string]$JobName,
      [Parameter(Mandatory=$true)][string]$MetadataFile,
      [Parameter(Mandatory=$true)][string]$NodePath,
      [ValidateSet('wait','graceful')][string]$Mode = 'wait')
$ErrorActionPreference = 'Stop'
if ($JobName -notmatch '^stackoryn-g2-[0-9a-f]{32}$') { throw 'Invalid owned job' }
. (Join-Path $PSScriptRoot 'owned-context.ps1')
$ownedContext = Get-G2OwnedContext -MetadataFile $MetadataFile -NodePath $NodePath
[IO.File]::WriteAllText((Join-Path $ownedContext.root 'worker.json'),
  (@{ worker=$PID; phase='started' } | ConvertTo-Json))
Add-Type -LiteralPath (Join-Path $PSScriptRoot 'job-native.cs')
[G2Job]::Join($JobName)
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $MetadataFile) 'worker.json'),
  (@{ worker=$PID; phase='joined' } | ConvertTo-Json))
# Joining succeeds BEFORE any MCP/Node process starts. Do not enable breakaway.
$nodeBinary = $ownedContext.node
$fixture = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../test/fixtures/job-client.mjs'))
$env:G2_JOB_METADATA = $MetadataFile
$env:G2_JOB_MODE = $Mode
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $MetadataFile) 'worker.json'),
  (@{ worker=$PID; phase='node'; node=$nodeBinary; fixture=$fixture;
      exists=(Test-Path -LiteralPath $fixture) } | ConvertTo-Json))
& $nodeBinary $fixture
[IO.File]::WriteAllText((Join-Path (Split-Path -Parent $MetadataFile) 'worker.json'),
  (@{ worker=$PID; phase='node-exited'; code=$LASTEXITCODE; node=$nodeBinary; fixture=$fixture } | ConvertTo-Json))
exit $LASTEXITCODE
