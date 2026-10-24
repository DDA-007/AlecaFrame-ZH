$ErrorActionPreference = "Stop"

$appId = "afmcagbpgggkpdkokjhjkllpegnadmkignlonpjm"
$extensionsRoot = Join-Path $env:LOCALAPPDATA "Overwolf\Extensions\$appId"
$packagesRoot = Join-Path $env:LOCALAPPDATA "Overwolf\PackagesCache\$appId"
$stateRoot = Join-Path $env:LOCALAPPDATA "AlecaFrame-ZH-Patch"
. (Join-Path $PSScriptRoot "AlecaFrame-ZH-Compatibility.ps1")

Get-Process -Name "Overwolf" -ErrorAction SilentlyContinue | Stop-Process
Start-Sleep -Seconds 4

$versionDirectory = Get-LatestVersionDirectory -AllowMissing
if ($versionDirectory) {
    Restore-OfficialFiles -Version $versionDirectory.Name -VersionPath $versionDirectory.FullName
}

$shortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "AlecaFrame-ZH.lnk"
if (Test-Path -LiteralPath $shortcut) {
    Remove-Item -LiteralPath $shortcut -Force
}
$legacyShortcut = Join-Path ([Environment]::GetFolderPath("Desktop")) "AlecaFrame 中文版.lnk"
if (Test-Path -LiteralPath $legacyShortcut) {
    Remove-Item -LiteralPath $legacyShortcut -Force
}

Write-Host ""
Write-Host "中文版快捷方式已移除，AlecaFrame 官方英文文件已恢复。" -ForegroundColor Green
