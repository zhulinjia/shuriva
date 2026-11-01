$ErrorActionPreference = 'Stop'
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$ancestor = Get-Item -LiteralPath $workspace -Force
while ($null -ne $ancestor) {
    if (($ancestor.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'Workspace ancestors must not be links or junctions for this isolated experiment' }
    $ancestor = $ancestor.Parent
}
$cachePath = Join-Path $workspace '.cache'
if ((Test-Path -LiteralPath $cachePath) -and (((Get-Item -LiteralPath $cachePath -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0)) { throw 'Experiment cache must not be a link or junction' }
$serverHome = 'C:/Program Files/MySQL/MySQL Server 26.7'
$serverBinary = Join-Path $serverHome 'bin/mysqld.exe'
if (-not (Test-Path -LiteralPath $serverBinary)) { throw 'Expected MySQL binary is unavailable' }

# Probe only the new experiment port; never inspect or connect to the original database.
$portProbe = [Net.Sockets.TcpListener]::new([Net.IPAddress]::Loopback, 13308)
try { $portProbe.Start() } catch { throw 'Experiment port 13308 is occupied; no existing process will be stopped' }
finally { $portProbe.Stop() }

$runId = [Guid]::NewGuid().ToString('N')
$runRoot = [IO.Path]::GetFullPath((Join-Path $workspace ".cache/stage8-g2-$runId"))
$expectedCache = [IO.Path]::GetFullPath((Join-Path $workspace '.cache')) + [IO.Path]::DirectorySeparatorChar
if (-not $runRoot.StartsWith($expectedCache, [StringComparison]::OrdinalIgnoreCase) -or (Test-Path -LiteralPath $runRoot)) { throw 'New experiment directory is invalid' }
[void](New-Item -ItemType Directory -Path $runRoot)
$currentSid = [Security.Principal.WindowsIdentity]::GetCurrent().User.Value
& icacls.exe $runRoot '/inheritance:r' '/grant:r' "*$($currentSid):(OI)(CI)F" | Out-Null
if ($LASTEXITCODE -ne 0) { throw 'Cannot protect the new experiment directory' }
$dataDir = Join-Path $runRoot 'mysql-data'
[void](New-Item -ItemType Directory -Path $dataDir)
foreach ($newDirectory in @($runRoot, $dataDir)) {
    if (((Get-Item -LiteralPath $newDirectory -Force).Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) { throw 'New experiment directories must not be links or junctions' }
}

$initArgs = @('--no-defaults', '--initialize-insecure', "--basedir=`"$serverHome`"", "--datadir=`"$dataDir`"", "--log-error=`"$(Join-Path $runRoot 'initialize.log')`"")
$initializer = Start-Process -FilePath $serverBinary -ArgumentList $initArgs -WindowStyle Hidden -PassThru -Wait -RedirectStandardOutput (Join-Path $runRoot 'initialize-out.log') -RedirectStandardError (Join-Path $runRoot 'initialize-error.log')
if ($initializer.ExitCode -ne 0) { throw "New isolated instance initialization failed; see $runRoot" }
$uuidMatch = [regex]::Match((Get-Content -LiteralPath (Join-Path $dataDir 'auto.cnf') -Raw), '(?m)^server-uuid=([0-9a-f-]{36})\s*$')
if (-not $uuidMatch.Success) { throw 'New isolated data directory identity is unavailable' }
$secretBytes = [byte[]]::new(32)
$generator = [Security.Cryptography.RandomNumberGenerator]::Create()
try { $generator.GetBytes($secretBytes) } finally { $generator.Dispose() }
$testSecret = [BitConverter]::ToString($secretBytes).Replace('-', '').ToLowerInvariant()
$initFile = Join-Path $runRoot 'bootstrap.sql'
$bootstrapSql = "ALTER USER 'root'@'localhost' IDENTIFIED BY '$testSecret';`nCREATE USER 'root'@'127.0.0.1' IDENTIFIED BY '$testSecret';`nGRANT ALL PRIVILEGES ON *.* TO 'root'@'127.0.0.1' WITH GRANT OPTION;`n"
[IO.File]::WriteAllText($initFile, $bootstrapSql, [Text.UTF8Encoding]::new($false))
$pidFile = Join-Path $runRoot 'mysql.pid'
$serverArgs = @('--no-defaults', "--basedir=`"$serverHome`"", "--datadir=`"$dataDir`"", '--bind-address=127.0.0.1', '--port=13308', '--mysqlx=OFF', '--skip-name-resolve', '--local-infile=OFF', "--pid-file=`"$pidFile`"", "--log-error=`"$(Join-Path $runRoot 'mysql.log')`"", "--init-file=`"$initFile`"")
$server = Start-Process -FilePath $serverBinary -ArgumentList $serverArgs -WindowStyle Hidden -PassThru -RedirectStandardOutput (Join-Path $runRoot 'mysql-out.log') -RedirectStandardError (Join-Path $runRoot 'mysql-error.log')
$manifest = [ordered]@{ format = 'stackoryn-stage8-g2-v1'; runId = $runId; host = '127.0.0.1'; port = 13308; dataDir = $dataDir; serverUuid = $uuidMatch.Groups[1].Value; pidFile = $pidFile; ownerPid = $server.Id; adminUser = 'root'; adminPassword = $testSecret }
$manifestPath = Join-Path $runRoot 'manifest.json'
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
for ($attempt = 0; $attempt -lt 100; $attempt++) {
    if ($server.HasExited) { throw "New isolated instance exited; see $runRoot" }
    if (Test-Path -LiteralPath $pidFile) { break }
    Start-Sleep -Milliseconds 100
}
if (-not (Test-Path -LiteralPath $pidFile)) { throw "Isolated startup not ready; see $runRoot" }
$actualServerPid = [int](Get-Content -LiteralPath $pidFile -Raw).Trim()
if ($actualServerPid -le 0 -or -not (Get-Process -Id $actualServerPid -ErrorAction SilentlyContinue)) { throw 'The isolated server PID file has no running owner' }
$manifest.ownerPid = $actualServerPid
[IO.File]::WriteAllText($manifestPath, ($manifest | ConvertTo-Json), [Text.UTF8Encoding]::new($false))
Write-Output "Created a separate experiment instance. Manifest: $manifestPath"
Write-Output 'The Go fixture guard must verify the instance before any fixture SQL. No connection to the original database was made.'
