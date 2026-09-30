[CmdletBinding()]
param(
    [string]$ShortcutDirectory = [Environment]::GetFolderPath("Desktop")
)

$ErrorActionPreference = "Stop"
foreach ($name in @(
    "Start-Chinese.cmd", "Start-Chinese-Session.cmd", "Start-AlecaFrame-ZH.ps1",
    "AlecaFrame-ZH-Compatibility.ps1", "alecaframe-zh-cn.js", "alecaframe-zh-cn-items.js"
)) {
    $requiredFile = Join-Path $PSScriptRoot $name
    if (-not (Test-Path -LiteralPath $requiredFile -PathType Leaf)) {
        throw "项目文件不完整，请完整解压后再安装：$requiredFile"
    }
}

$ShortcutDirectory = [IO.Path]::GetFullPath($ShortcutDirectory)
New-Item -ItemType Directory -Path $ShortcutDirectory -Force | Out-Null
$shortcutPath = Join-Path $ShortcutDirectory "AlecaFrame-ZH.lnk"
if (Test-Path -LiteralPath $shortcutPath) {
    $backupRoot = Join-Path $env:LOCALAPPDATA "AlecaFrame-ZH-Patch\ShortcutBackups"
    New-Item -ItemType Directory -Path $backupRoot -Force | Out-Null
    $backupName = "AlecaFrame-ZH_{0}_{1}.lnk" -f (Get-Date -Format "yyyyMMdd-HHmmss-fff"), [guid]::NewGuid().ToString("N")
    Copy-Item -LiteralPath $shortcutPath -Destination (Join-Path $backupRoot $backupName)
}

$startCommand = Join-Path $PSScriptRoot "Start-Chinese.cmd"
$commandPath = Join-Path $env:SystemRoot "System32\cmd.exe"
$commandArguments = '/d /c ""' + $startCommand + '""'
$shell = New-Object -ComObject WScript.Shell
$shortcut = $shell.CreateShortcut($shortcutPath)
$shortcut.TargetPath = $commandPath
$shortcut.Arguments = $commandArguments
$shortcut.WorkingDirectory = $PSScriptRoot
$shortcut.WindowStyle = 1
$extensionsRoot = Join-Path $env:LOCALAPPDATA `
    "Overwolf\Extensions\afmcagbpgggkpdkokjhjkllpegnadmkignlonpjm"
$latestVersion = Get-ChildItem -LiteralPath $extensionsRoot -Directory `
    -ErrorAction SilentlyContinue |
    Where-Object { Test-Path -LiteralPath (Join-Path $_.FullName "manifest.json") } |
    Sort-Object { [version]$_.Name } -Descending |
    Select-Object -First 1
$icon = if ($latestVersion) { Join-Path $latestVersion.FullName "icon.ico" } else { "" }
if ($icon -and (Test-Path -LiteralPath $icon)) {
    $shortcut.IconLocation = "$icon,0"
}
$shortcut.Description = "启动 AlecaFrame 中文会话，退出 Overwolf 后恢复官方文件"
$shortcut.Save()

if (-not (Test-Path -LiteralPath $shortcutPath)) {
    throw "快捷方式创建失败：$shortcutPath"
}
$saved = $shell.CreateShortcut($shortcutPath)
if ($saved.TargetPath -ne $commandPath -or $saved.Arguments -ne $commandArguments -or
    $saved.WorkingDirectory -ne $PSScriptRoot) {
    throw "快捷方式验证失败，请重新运行 Install.cmd：$shortcutPath"
}
Write-Host ""
Write-Host "中文版快捷方式已创建：$shortcutPath" -ForegroundColor Green
Write-Host "项目目录：$PSScriptRoot"
Write-Host "启动前请从托盘完全退出 Overwolf，再双击 AlecaFrame-ZH。"
Write-Host "请保留启动器窗口；使用完退出 Overwolf，脚本会恢复官方文件。"
Write-Host "当前适配让此次 Overwolf 会话中所有扩展的完整性错误仅记录、不关闭应用。"
Write-Host "中文 OCR 会读取此目录保存的开关设置；安装快捷方式不会改变该设置。"
