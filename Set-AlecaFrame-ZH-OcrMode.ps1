[CmdletBinding(DefaultParameterSetName = "Mode")]
param(
    [Parameter(Mandatory = $true, ParameterSetName = "Mode")]
    [ValidateSet("Enable", "Disable")]
    [string]$Mode,

    # Preserve direct PowerShell callers that supply an actual Boolean value.
    [Parameter(Mandatory = $true, ParameterSetName = "Enabled")]
    [bool]$Enabled
)

$ErrorActionPreference = "Stop"
if ($PSCmdlet.ParameterSetName -eq "Mode") {
    $Enabled = $Mode -eq "Enable"
}
$settingsPath = Join-Path $PSScriptRoot "AlecaFrame-ZH.settings.json"
$settings = [pscustomobject]@{}
if (Test-Path -LiteralPath $settingsPath) {
    $settings = Get-Content -LiteralPath $settingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ($settings -isnot [pscustomobject]) {
        throw "OCR 设置文件格式无效，未覆盖原文件：$settingsPath"
    }
}
if ($null -eq $settings.relicOcr) {
    $settings | Add-Member -MemberType NoteProperty -Name relicOcr -Value ([pscustomobject]@{}) -Force
}
if ($settings.relicOcr -isnot [pscustomobject]) {
    throw "OCR 设置格式无效，未覆盖原文件：$settingsPath"
}
$settings.relicOcr | Add-Member -MemberType NoteProperty -Name enabled -Value $Enabled -Force

$settings | ConvertTo-Json -Depth 20 | Set-Content -LiteralPath $settingsPath -Encoding UTF8
$state = if ($Enabled) { "启用" } else { "关闭" }
Write-Host "中文遗物 OCR 已${state}。请完全退出 Overwolf，再通过 AlecaFrame-ZH 启动，设置才会生效。" -ForegroundColor Green
