param([switch]$Candidate)
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
if ($PSVersionTable.PSVersion.Major -lt 7 -or -not $IsWindows) { throw 'Release packaging currently requires PowerShell 7 on Windows' }
$workspace = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
Push-Location -LiteralPath $workspace
try {
    $revision = (& git rev-parse HEAD).Trim()
    if ($LASTEXITCODE -ne 0) { throw 'Git revision unavailable' }
    $dirty = @(& git status --porcelain)
    if ($LASTEXITCODE -ne 0 -or ($dirty.Count -gt 0 -and -not $Candidate)) { throw 'A release requires a clean commit; use -Candidate for local review output' }
    if ((& node -p "process.platform + '-' + process.arch") -ne 'win32-x64') { throw 'Only Windows/amd64 has been validated' }
    & node --eval 'const [major,minor]=process.versions.node.split(".").map(Number); if(major!==24||minor<19) process.exit(2)'
    if ($LASTEXITCODE -ne 0) { throw 'Node.js must be 24.19 or newer within the 24.x line' }
    if ((& pnpm --version) -ne '12.14.0') { throw 'Use the packageManager version pinned in package.json' }
    $output = (& node scripts/release-workspace.mjs prepare $workspace).Trim()
    if ($LASTEXITCODE -ne 0 -or -not [IO.Path]::IsPathFullyQualified($output)) { throw 'Release output preparation failed' }
    & pnpm install --frozen-lockfile --ignore-scripts
    if ($LASTEXITCODE -ne 0) { throw 'Locked dependency install failed' }
    & node scripts/release-workspace.mjs clean $workspace
    if ($LASTEXITCODE -ne 0) { throw 'Fresh build output cleanup failed' }
    & pnpm exec turbo run build --force
    if ($LASTEXITCODE -ne 0) { throw 'Product build failed' }
    & pnpm --filter '@workspace/community-api' mcp:host:build
    if ($LASTEXITCODE -ne 0) { throw 'Owned MCP host build failed' }
    $platform = Join-Path $output 'platform'
    & pnpm --filter '@workspace/community-api' deploy --node-linker hoisted --prod --ignore-scripts --frozen-lockfile --offline $platform
    if ($LASTEXITCODE -ne 0) { throw 'Production dependency deployment failed; partial output retained for diagnosis' }
    Copy-Item -LiteralPath 'apps/community-web/dist' -Destination (Join-Path $output 'web') -Recurse
    Copy-Item -LiteralPath '.env.example' -Destination (Join-Path $output '.env.example')
    Copy-Item -LiteralPath 'LICENSE' -Destination (Join-Path $output 'LICENSE')
    Copy-Item -LiteralPath 'docs/37-Community发布与运维手册.md' -Destination (Join-Path $output 'OPERATIONS.md')
    Copy-Item -LiteralPath 'docs/38-Connector发布版操作指南.md' -Destination (Join-Path $output 'CONNECTOR.md')
    $tools = Join-Path $output 'tools'
    [void](New-Item -ItemType Directory -Path $tools)
    foreach ($tool in @('verify-release.mjs', 'release-files.mjs', 'read-diagnostics.mjs')) {
        Copy-Item -LiteralPath (Join-Path $PSScriptRoot $tool) -Destination (Join-Path $tools $tool)
    }
    $connector = Join-Path $output 'connector.exe'
    $savedGo = @{}
    foreach ($name in @('GOOS','GOARCH','CGO_ENABLED')) { $savedGo[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }
    Push-Location -LiteralPath 'connector/go'
    try {
        $env:GOOS = 'windows'; $env:GOARCH = 'amd64'; $env:CGO_ENABLED = '0'
        & go build -trimpath -buildvcs=false -o $connector './cmd/connector'
        if ($LASTEXITCODE -ne 0) { throw 'Connector build failed' }
        & go list -deps -f '{{if .Module}}{{.Module.Path}}|{{.Module.Version}}|{{.Module.Dir}}{{end}}' './cmd/connector' './cmd/mcp-host' | Out-File -LiteralPath (Join-Path $output 'go-modules.txt') -Encoding utf8NoBOM
        if ($LASTEXITCODE -ne 0) { throw 'Go dependency inventory failed' }
        $standard = @(& go list -deps -f '{{if .Standard}}{{.ImportPath}}|{{.Dir}}{{end}}' './cmd/connector' './cmd/mcp-host')
        if ($LASTEXITCODE -ne 0) { throw 'Go standard-library inventory failed' }
        $goRoot = (& go env GOROOT).Trim()
        $goVersion = (& go env GOVERSION).Trim()
        if ($LASTEXITCODE -ne 0) { throw 'Go toolchain identity unavailable' }
        @{ root = $goRoot; version = $goVersion; standardPackages = ($standard -join "`n") } | ConvertTo-Json | Out-File -LiteralPath (Join-Path $output 'go-toolchain.json') -Encoding utf8NoBOM
    } finally {
        Pop-Location
        foreach ($name in @('GOOS','GOARCH','CGO_ENABLED')) { [Environment]::SetEnvironmentVariable($name, $savedGo[$name], 'Process') }
    }
    # Physical deployed metadata is inventoried by complete-release. pnpm 12's
    # hoisted license report emits virtual paths which do not exist on disk.
    & pnpm --dir apps/community-web licenses list --prod --json | Out-File -LiteralPath (Join-Path $output 'npm-web.json') -Encoding utf8NoBOM
    if ($LASTEXITCODE -ne 0) { throw 'Web dependency inventory failed' }
    $channel = if ($Candidate) { 'candidate' } else { 'release' }
    & node scripts/complete-release.mjs $output $revision $channel
    if ($LASTEXITCODE -ne 0) { throw 'Release verification failed; output is not publishable' }
    Write-Output "Local $channel output: $output"
} finally { Pop-Location }
