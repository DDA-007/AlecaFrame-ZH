function Get-AlecaFrameIntegrityFailure {
    [CmdletBinding()]
    param(
        [datetime]$StartedAt = [datetime]::MinValue,
        [string]$TraceRoot = (Join-Path $env:LOCALAPPDATA "Overwolf\Log"),
        [string]$AppId = "afmcagbpgggkpdkokjhjkllpegnadmkignlonpjm"
    )

    # Only an app-specific close event is evidence. Other Overwolf apps may
    # report unrelated resource errors in the same trace file.
    $pattern = "Closing extension '" + [regex]::Escape($AppId) + "' - 'HashMismatch'"
    $latestFailure = $null
    $traces = Get-ChildItem -LiteralPath $TraceRoot -Filter "Trace_*.log" -File `
        -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $StartedAt } |
        Sort-Object LastWriteTime -Descending |
        Select-Object -First 5

    foreach ($trace in $traces) {
        $lines = Get-Content -LiteralPath $trace.FullName -Tail 500 -Encoding UTF8 `
            -ErrorAction SilentlyContinue
        foreach ($line in $lines) {
            if ($line -notmatch $pattern -or
                $line -notmatch '^(\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2},\d{3})') { continue }
            $eventTime = [datetime]::MinValue
            if (-not [datetime]::TryParseExact($Matches[1], "yyyy-MM-dd HH:mm:ss,fff",
                [Globalization.CultureInfo]::InvariantCulture,
                [Globalization.DateTimeStyles]::None, [ref]$eventTime)) { continue }
            # Modification time alone cannot distinguish an old failure from
            # a new launch that appends to the same trace.
            if ($eventTime -lt $StartedAt) { continue }
            if ($latestFailure -and $eventTime -le $latestFailure.Timestamp) { continue }
            $latestFailure = [pscustomobject]@{
                Code = "HashMismatch"
                Timestamp = $eventTime
                AppId = $AppId
                TracePath = $trace.FullName
                Evidence = $line.ToString()
            }
        }
    }
    return $latestFailure
}

function Assert-AlecaFrameIntegrity {
    param([datetime]$StartedAt)
    $failure = Get-AlecaFrameIntegrityFailure -StartedAt $StartedAt
    if ($failure) {
        throw ("Overwolf 完整性校验拒绝了 AlecaFrame 页面（HashMismatch），并关闭了应用。" +
            "当前汉化加载方式与此版本不兼容；重新运行 Install.cmd 或安装 OCR 前置组件无法解决。" +
            "请使用官方 AlecaFrame，等待补丁适配。诊断日志：" + $failure.TracePath)
    }
}

$extraScriptNames = @(
    "alecaframe-zh-cn.js", "alecaframe-zh-cn-items.js", "alecaframe-zh-cn-relic-ducats.js",
    "alecaframe-zh-cn-relic-ocr.js", "alecaframe-zh-cn-riven-ocr.js", "alecaframe-zh-cn-riven-overlay.js",
    "alecaframe-zh-cn-relic-overlay.js", "alecaframe-zh-cn-relic-recommendation.js",
    "alecaframe-zh-cn-relic-planner-cache.js", "alecaframe-zh-cn-inventory-price-sync.js",
    "alecaframe-zh-cn-inventory-images.js"
)
function Get-LatestVersionDirectory {
    param([switch]$AllowMissing)
    $candidates = foreach ($installed in Get-ChildItem -LiteralPath $extensionsRoot -Directory -ErrorAction SilentlyContinue) {
        $parsedVersion = $null
        if ([version]::TryParse($installed.Name, [ref]$parsedVersion) -and
            (Test-Path -LiteralPath (Join-Path $installed.FullName "manifest.json"))) {
            [pscustomobject]@{ Version = $parsedVersion; Directory = $installed }
        }
    }
    $latest = $candidates | Sort-Object Version -Descending |
        Select-Object -First 1
    if (-not $latest) {
        if ($AllowMissing) { return $null }
        throw "没有找到 AlecaFrame 安装版本。"
    }
    return $latest.Directory
}

function Assert-AppPath {
    param([string]$Path)
    $resolvedRoot = [IO.Path]::GetFullPath($extensionsRoot).TrimEnd("\") + "\"
    $resolvedPath = [IO.Path]::GetFullPath($Path)
    if (-not $resolvedPath.StartsWith($resolvedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "安全检查失败：路径不属于 AlecaFrame 扩展目录。"
    }
}

function Get-AlecaFrameRelativePath {
    param([string]$Root, [string]$RelativePath)
    # Only canonical package-relative paths are accepted. Never let a manifest,
    # backup path or a junction redirect patch writes outside its selected root.
    if ($RelativePath -notmatch '^[A-Za-z0-9_.-]+(?:/[A-Za-z0-9_.-]+)*$' -or
        @($RelativePath.Split('/') | Where-Object { $_ -eq '.' -or $_ -eq '..' }).Count) {
        throw "不支持的 AlecaFrame 相对路径：$RelativePath"
    }
    $resolvedRoot = [IO.Path]::GetFullPath($Root).TrimEnd('\')
    $resolvedPath = [IO.Path]::GetFullPath((Join-Path $resolvedRoot $RelativePath.Replace('/', '\')))
    if (-not $resolvedPath.StartsWith($resolvedRoot + '\', [StringComparison]::OrdinalIgnoreCase)) {
        throw "AlecaFrame 路径越界：$RelativePath"
    }
    $ancestor = $resolvedPath
    while ($ancestor -and $ancestor.Length -ge $resolvedRoot.Length) {
        if (Test-Path -LiteralPath $ancestor) {
            $item = Get-Item -LiteralPath $ancestor -Force
            if ($item.Attributes -band [IO.FileAttributes]::ReparsePoint) {
                throw "不支持指向其他位置的 AlecaFrame 文件或目录：$RelativePath"
            }
        }
        if ($ancestor -eq $resolvedRoot) { break }
        $ancestor = Split-Path -Parent $ancestor
    }
    return $resolvedPath
}

function Get-AlecaFrameTargetPages {
    param([string]$VersionPath)
    Assert-AppPath $VersionPath
    $manifestPath = Get-AlecaFrameRelativePath $VersionPath 'manifest.json'
    try {
        $manifest = [IO.File]::ReadAllText($manifestPath, [Text.Encoding]::UTF8) | ConvertFrom-Json
    }
    catch { throw "无法读取 AlecaFrame 页面清单：$($_.Exception.Message)" }
    if (-not $manifest.data.windows -or $manifest.meta.name -ne 'AlecaFrame') {
        throw 'AlecaFrame manifest 缺少窗口清单或应用名称不匹配。'
    }
    $pages = New-Object System.Collections.Generic.List[string]
    foreach ($window in $manifest.data.windows.PSObject.Properties) {
        $file = [string]$window.Value.file
        # The uninstall window performs native uninstall work and is not a UI
        # entry point. Keep it untouched as in the earlier launcher.
        if ($file -eq [string]$manifest.data.uninstall_window.file -or $window.Name -eq 'Uninstall') { continue }
        if ($file -notmatch '^web/.+\.html$') {
            throw "窗口 $($window.Name) 不是 web 目录内的相对 HTML 页面：$file"
        }
        $null = Get-AlecaFrameRelativePath $VersionPath $file
        $page = $file.Substring(4)
        if (-not $pages.Contains($page)) { $pages.Add($page) }
    }
    if (-not $pages.Count) { throw 'AlecaFrame 没有可汉化的窗口页面。' }
    return $pages.ToArray()
}

function Test-AlecaFramePatchedFile {
    param([string]$Path)
    $content = [IO.File]::ReadAllText($Path, [Text.Encoding]::UTF8)
    return $content -match '(?i)alecaframe-zh-cn|ALECAFRAME_ZH_CN_REWARD_FALLBACK|alecaFrameZhCnStartRewardFallback'
}

function Restore-OfficialFiles {
    param(
        [string]$Version,
        [string]$VersionPath
    )
    Assert-AppPath $VersionPath
    if ($Version -notmatch '^\d+(?:\.\d+){1,3}$') { throw "无效的 AlecaFrame 版本目录：$Version" }
    if ([IO.Path]::GetFileName([IO.Path]::GetFullPath($VersionPath).TrimEnd('\')) -ne $Version) {
        throw 'AlecaFrame 恢复版本与目标目录不匹配；未修改任何文件。'
    }
    $opk = Get-AlecaFrameRelativePath $packagesRoot "$Version/app.opk"
    $backupRoot = Join-Path $stateRoot "OfficialBackup\$Version"
    $entries = @("_metadata/verified_contents.json", "web/assets/js/relicOverlay/main.js")
    $entries += Get-AlecaFrameTargetPages $VersionPath | ForEach-Object { "web/$_" }
    $archive = $null
    $restorePlan = New-Object System.Collections.Generic.List[object]
    try {
        if (Test-Path -LiteralPath $opk) {
            Add-Type -AssemblyName System.IO.Compression
            Add-Type -AssemblyName System.IO.Compression.FileSystem
            $archive = [IO.Compression.ZipFile]::OpenRead($opk)
        }
        # Validate every source first. A partial old backup can be extended with
        # a clean newly declared page; never back up an already patched page.
        foreach ($entryName in $entries) {
            $target = Get-AlecaFrameRelativePath $VersionPath $entryName
            $backup = Get-AlecaFrameRelativePath $backupRoot $entryName
            $entry = $null
            $source = $null
            if ($archive) {
                $entry = $archive.GetEntry($entryName)
                if (-not $entry) { throw "官方 OPK 中缺少文件：$entryName" }
            }
            elseif (Test-Path -LiteralPath $backup -PathType Leaf) { $source = $backup }
            elseif (Test-Path -LiteralPath $target -PathType Leaf) { $source = $target }
            else { throw "AlecaFrame 官方文件不完整：$entryName。请重新安装 AlecaFrame。" }
            if ($source -and $entryName -like 'web/*' -and (Test-AlecaFramePatchedFile $source)) {
                throw "检测到旧汉化文件，但缺少未修改的官方备份：$entryName。请重新安装 AlecaFrame。"
            }
            $restorePlan.Add([pscustomobject]@{ Target = $target; Backup = $backup; Source = $source; Entry = $entry })
        }
        foreach ($step in $restorePlan) {
            New-Item -ItemType Directory -Path (Split-Path -Parent $step.Backup) -Force | Out-Null
            if ($step.Entry) {
                New-Item -ItemType Directory -Path (Split-Path -Parent $step.Target) -Force | Out-Null
                $input = $step.Entry.Open()
                $output = [IO.File]::Create($step.Target)
                try { $input.CopyTo($output) }
                finally { $output.Dispose(); $input.Dispose() }
                Copy-Item -LiteralPath $step.Target -Destination $step.Backup -Force
            }
            elseif ($step.Source -eq $step.Backup) {
                New-Item -ItemType Directory -Path (Split-Path -Parent $step.Target) -Force | Out-Null
                Copy-Item -LiteralPath $step.Backup -Destination $step.Target -Force
            }
            else { Copy-Item -LiteralPath $step.Target -Destination $step.Backup -Force }
        }
        if (Get-Command Write-LauncherLog -ErrorAction SilentlyContinue) { Write-LauncherLog "Official files restored/backed up: $($restorePlan.Count) files, OPK available=$([bool]$archive)" }
    }
    finally { if ($archive) { $archive.Dispose() } }

    foreach ($extraScript in $extraScriptNames) {
        $extraLocalizer = Get-AlecaFrameRelativePath $VersionPath "web/assets/js/$extraScript"
        if (Test-Path -LiteralPath $extraLocalizer) {
            Remove-Item -LiteralPath $extraLocalizer -Force
        }
    }
}

