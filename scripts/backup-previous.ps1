param(
  [string]$Source = "D:\ai-video-director-saas",
  [string]$BackupRoot = "D:\ai-video-director-saas-backup",
  [string]$BackupName = "previous"
)

$ErrorActionPreference = "Stop"

$backup = Join-Path $BackupRoot $BackupName
$resolvedSource = Resolve-Path -LiteralPath $Source
New-Item -ItemType Directory -Force -Path $BackupRoot | Out-Null
$resolvedBackupRoot = Resolve-Path -LiteralPath $BackupRoot

if (Test-Path -LiteralPath $backup) {
  $resolvedBackup = Resolve-Path -LiteralPath $backup
  if (-not $resolvedBackup.Path.StartsWith($resolvedBackupRoot.Path, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to delete backup outside expected root: $($resolvedBackup.Path)"
  }

  Remove-Item -LiteralPath $resolvedBackup.Path -Recurse -Force
}

robocopy $resolvedSource.Path $backup /MIR /XD node_modules .next .git /XF server.out.log server.err.log
$robocopyExit = $LASTEXITCODE

if ($robocopyExit -gt 7) {
  throw "Robocopy failed with exit code $robocopyExit"
}

Write-Host "Backup created: $backup"
