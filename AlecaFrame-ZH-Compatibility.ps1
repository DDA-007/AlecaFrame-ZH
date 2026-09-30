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
