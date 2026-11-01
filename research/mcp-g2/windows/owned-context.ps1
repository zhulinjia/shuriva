function Get-G2OwnedContext {
  param([string]$MetadataFile, [string]$NodePath)
  $taskWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../..'))
  $taskCache = [IO.Path]::GetFullPath((Join-Path $taskWorkspace '.cache'))
  if (-not [IO.Path]::IsPathRooted($MetadataFile) -or -not [IO.Path]::IsPathRooted($NodePath)) {
    throw 'G2 owned paths must be absolute'
  }
  $taskMetadata = [IO.Path]::GetFullPath($MetadataFile)
  $taskRoot = [IO.Path]::GetDirectoryName($taskMetadata)
  if ([IO.Path]::GetFileName($taskMetadata) -ne 'metadata.json' -or
      -not [IO.Path]::GetDirectoryName($taskRoot).Equals($taskCache, [StringComparison]::OrdinalIgnoreCase) -or
      [IO.Path]::GetFileName($taskRoot) -notmatch '^g2-job-[A-Za-z0-9_-]{6,64}$') {
    throw 'G2 metadata is outside the owned direct run directory'
  }
  $taskEntry = Get-Item -LiteralPath $taskRoot -Force
  if (-not $taskEntry.PSIsContainer) { throw 'G2 run directory is unavailable' }
  while ($null -ne $taskEntry) {
    if (($taskEntry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
      throw 'G2 reparse-point path rejected'
    }
    $taskEntry = $taskEntry.Parent
  }
  $taskNode = Get-Item -LiteralPath $NodePath -Force
  if ($taskNode.PSIsContainer -or $taskNode.Extension -ne '.exe') { throw 'G2 selected runtime is unavailable' }
  return @{ root=$taskRoot; metadata=$taskMetadata; node=$taskNode.FullName }
}
