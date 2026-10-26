param(
    # Opt-in diagnostic only: closes this session and restores official files after 45 seconds.
    [switch]$TestValidationReportOnly,
    # Explicit experimental entry: restore official files after Overwolf exits.
    [switch]$SessionValidationReportOnly
)

$ErrorActionPreference = "Stop"
if ($TestValidationReportOnly -and $SessionValidationReportOnly) {
    throw "请选择限时测试或会话启动中的一种模式。"
}
$validationReportOnly = $TestValidationReportOnly -or $SessionValidationReportOnly
$testSessionStarted = $false

. (Join-Path $PSScriptRoot "AlecaFrame-ZH-Compatibility.ps1")

$appId = "afmcagbpgggkpdkokjhjkllpegnadmkignlonpjm"
$overwolfExe = $null
$launcherExe = $null
$extensionsRoot = Join-Path $env:LOCALAPPDATA "Overwolf\Extensions\$appId"
$packagesRoot = Join-Path $env:LOCALAPPDATA "Overwolf\PackagesCache\$appId"
$stateRoot = Join-Path $env:LOCALAPPDATA "AlecaFrame-ZH-Patch"
$localizerSource = Join-Path $PSScriptRoot "alecaframe-zh-cn.js"
$itemTranslationsSource = Join-Path $PSScriptRoot "alecaframe-zh-cn-items.js"
$relicDucatsSource = Join-Path $PSScriptRoot "alecaframe-zh-cn-relic-ducats.js"
$relicOcrBridgeSource = Join-Path $PSScriptRoot "alecaframe-zh-cn-relic-ocr.js"
$rivenOcrBridgeSource = Join-Path $PSScriptRoot "alecaframe-zh-cn-riven-ocr.js"
$rivenOverlaySource = Join-Path $PSScriptRoot "alecaframe-zh-cn-riven-overlay.js"
$relicOverlaySource = Join-Path $PSScriptRoot "alecaframe-zh-cn-relic-overlay.js"
$relicRecommendationSource = Join-Path $PSScriptRoot "alecaframe-zh-cn-relic-recommendation.js"
$relicPlannerCacheSource = Join-Path $PSScriptRoot "alecaframe-zh-cn-relic-planner-cache.js"
$inventoryPriceSyncSource = Join-Path $PSScriptRoot "alecaframe-zh-cn-inventory-price-sync.js"
$inventoryImagesSource = Join-Path $PSScriptRoot "alecaframe-zh-cn-inventory-images.js"
$relicOcrServerSource = Join-Path $PSScriptRoot "alecaframe-relic-ocr-server.js"
$relicOcrWorkerSource = Join-Path $PSScriptRoot "Invoke-AlecaFrame-RelicChineseOcr.ps1"
$paddleRewardWorkerSource = Join-Path $PSScriptRoot "alecaframe-paddle-reward-worker.py"
$paddlePythonSource = Join-Path $PSScriptRoot ".tools\python311-portable\python.exe"
$localNodeSource = Join-Path $PSScriptRoot ".tools\node\node.exe"
$ocrSettingsPath = Join-Path $PSScriptRoot "AlecaFrame-ZH.settings.json"
$relicCaptureSource = Join-Path $PSScriptRoot "Capture-AlecaFrame-WarframeScreen.ps1"
$relicOcrStateRoot = Join-Path $stateRoot "RelicChineseOcr"

function Write-LauncherLog {
    param([string]$Message)
    New-Item -ItemType Directory -Path $stateRoot -Force | Out-Null
    $line = "$(Get-Date -Format o) $Message"
    Add-Content -LiteralPath (Join-Path $stateRoot "launcher.log") -Value $line -Encoding UTF8
}

function Get-RelicOcrEnabled {
    param([bool]$DefaultEnabled = $true)
    if (-not (Test-Path -LiteralPath $ocrSettingsPath)) { return $DefaultEnabled }
    try {
        $settings = Get-Content -LiteralPath $ocrSettingsPath -Raw -Encoding UTF8 | ConvertFrom-Json
        if ($null -ne $settings.relicOcr -and $null -ne $settings.relicOcr.enabled) {
            if ($settings.relicOcr.enabled -isnot [bool]) { throw "relicOcr.enabled must be a JSON Boolean." }
            return $settings.relicOcr.enabled
        }
    }
    catch {
        Write-LauncherLog "OCR settings could not be read; using default enabled=$DefaultEnabled`: $($_.Exception.Message)"
    }
    return $DefaultEnabled
}

function Test-RelicOcrPrerequisites {
    $nodeAvailable = (Test-Path -LiteralPath $localNodeSource) -or $null -ne (Get-Command node -ErrorAction SilentlyContinue)
    if (-not $nodeAvailable) { return $false }
    foreach ($path in @($relicOcrServerSource, $relicOcrWorkerSource, $relicCaptureSource, $paddleRewardWorkerSource, $paddlePythonSource)) {
        if (-not (Test-Path -LiteralPath $path)) { return $false }
    }
    return $true
}

function Find-OverwolfInstall {
    $candidateDirectories = New-Object System.Collections.Generic.List[string]

    $running = Get-Process -Name "Overwolf" -ErrorAction SilentlyContinue |
        Where-Object { $_.Path } |
        Select-Object -First 1
    if ($running) {
        $candidateDirectories.Add((Split-Path -Parent $running.Path))
    }

    $uninstallRoots = @(
        "HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall",
        "HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall"
    )
    foreach ($root in $uninstallRoots) {
        if (-not (Test-Path -LiteralPath $root)) { continue }
        Get-ChildItem -LiteralPath $root -ErrorAction SilentlyContinue |
            ForEach-Object {
                Get-ItemProperty -LiteralPath $_.PSPath -ErrorAction SilentlyContinue
            } |
            Where-Object {
                $_.DisplayName -eq "Overwolf" -and $_.InstallLocation
            } |
            ForEach-Object {
                $candidateDirectories.Add($_.InstallLocation.TrimEnd("\"))
            }
    }

    $candidateDirectories.Add((Join-Path $env:LOCALAPPDATA "Overwolf"))
    if (${env:ProgramFiles(x86)}) {
        $candidateDirectories.Add((Join-Path ${env:ProgramFiles(x86)} "Overwolf"))
    }
    if ($env:ProgramFiles) {
        $candidateDirectories.Add((Join-Path $env:ProgramFiles "Overwolf"))
    }

    foreach ($directory in $candidateDirectories | Select-Object -Unique) {
        $overwolf = Join-Path $directory "Overwolf.exe"
        $launcher = Join-Path $directory "OverwolfLauncher.exe"
        if ((Test-Path -LiteralPath $overwolf) -and
            (Test-Path -LiteralPath $launcher)) {
            return [pscustomobject]@{
                Overwolf = $overwolf
                Launcher = $launcher
            }
        }
    }
    throw "找不到 Overwolf 安装目录，请先安装或修复 Overwolf。"
}

function Add-AlecaFramePageScripts {
    param([string]$Content, [string]$RelativePage, [string[]]$Scripts)
    if ($Content -notmatch '(?i)</body\s*>') { throw "页面缺少 </body>，无法注入：$RelativePage" }
    $depth = ($RelativePage.Split('/').Count - 1)
    $assetPrefix = ('../' * $depth) + 'assets/js/'
    foreach ($scriptFile in $Scripts) {
        $source = $assetPrefix + $scriptFile
        $scriptPattern = '(?i)<script\b[^>]*\bsrc\s*=\s*["'']' + [regex]::Escape($source) + '["''][^>]*>'
        if (-not [regex]::IsMatch($Content, $scriptPattern)) {
            $tag = '<script src="' + $source + '"></script>'
            $insertion = '    ' + $tag + "`r`n"
            $Content = ([regex]'(?i)</body\s*>').Replace($Content,
                [Text.RegularExpressions.MatchEvaluator]{ param($match) $insertion + $match.Value }, 1)
        }
    }
    return $Content
}

function Add-ChineseFiles {
    param(
        [string]$VersionPath,
        [bool]$EnableRelicOcr
    )
    Assert-AppPath $VersionPath
    $webRoot = Join-Path $VersionPath "web"
    $targetPages = @(Get-AlecaFrameTargetPages $VersionPath)
    $sourceFiles = @($localizerSource, $itemTranslationsSource, $relicDucatsSource,
        $relicOverlaySource, $relicRecommendationSource, $relicPlannerCacheSource,
        $inventoryPriceSyncSource, $inventoryImagesSource)
    if ($EnableRelicOcr) { $sourceFiles += @($relicOcrBridgeSource, $rivenOcrBridgeSource, $rivenOverlaySource) }
    foreach ($source in $sourceFiles) {
        if (-not (Test-Path -LiteralPath $source -PathType Leaf)) { throw "缺少汉化脚本：$source" }
    }
    $null = Get-AlecaFrameRelativePath $VersionPath 'web/assets/js'
    $pageWrites = New-Object System.Collections.Generic.List[object]
    foreach ($relativePage in $targetPages) {
        $target = Get-AlecaFrameRelativePath $webRoot $relativePage
        if (-not (Test-Path -LiteralPath $target -PathType Leaf)) {
            throw "AlecaFrame 页面清单中的文件不存在：web/$relativePage。请重新安装 AlecaFrame。"
        }
        $original = [IO.File]::ReadAllText($target, [Text.Encoding]::UTF8)
        $scripts = @('alecaframe-zh-cn-items.js', 'alecaframe-zh-cn.js')
        if ($EnableRelicOcr -and $relativePage -eq 'background.html') {
            $scripts += @('alecaframe-zh-cn-relic-ocr.js', 'alecaframe-zh-cn-riven-ocr.js')
        }
        if ($EnableRelicOcr -and $relativePage -eq 'rivenOverlay.html') {
            $scripts += 'alecaframe-zh-cn-riven-overlay.js'
        }
        if ($relativePage -eq 'relicRecommendation.html') { $scripts += 'alecaframe-zh-cn-relic-recommendation.js' }
        if ($relativePage -eq 'relicOverlay.html') {
            $scripts += @('alecaframe-zh-cn-relic-ducats.js', 'alecaframe-zh-cn-relic-overlay.js')
        }
        if ($relativePage -eq 'main.html') {
            $scripts += @('alecaframe-zh-cn-relic-planner-cache.js', 'alecaframe-zh-cn-inventory-price-sync.js',
                'alecaframe-zh-cn-inventory-images.js')
        }
        $content = Add-AlecaFramePageScripts -Content $original -RelativePage $relativePage -Scripts $scripts
        if ($EnableRelicOcr -and $relativePage -eq 'rivenOverlay.html') {
            # Preserve existing Vue keys and make repeated injection idempotent.
            $content = [regex]::Replace($content,
                '(<div class="rivenDetailsStat (?:positive|negative)" v-for="stat in [^"]+")(?!\s+:key=)',
                '$1 :key="stat.description"')
        }
        $pageWrites.Add([pscustomobject]@{ Target = $target; Content = $content; Changed = $content -cne $original })
    }

    if ($EnableRelicOcr) {
    # The official reward window always executes this file. Patch only its
    # English-language failure branch so reward selection can consume the
    # short-lived Chinese OCR result. This is independent of the refinement
    # recommendation overlay and its planner cache.
    $relicOverlayMain = Get-AlecaFrameRelativePath $VersionPath 'web/assets/js/relicOverlay/main.js'
    $mainContent = [IO.File]::ReadAllText($relicOverlayMain, [Text.Encoding]::UTF8)
    $helperMarker = "// ALECAFRAME_ZH_CN_REWARD_FALLBACK"
    if (-not $mainContent.Contains($helperMarker)) {
        if ([regex]::Matches($mainContent, 'var relicWindowInitialized = false;').Count -ne 1) {
            throw '奖励窗口初始化结构已变化，未应用中文奖励回退补丁。'
        }
        $helper = @'
// ALECAFRAME_ZH_CN_REWARD_FALLBACK
var alecaFrameZhCnRewardResultKey = "__alecaframeZhCnRewardOverlayResult";
var alecaFrameZhCnRewardResultEndpoint = "http://127.0.0.1:38147/latest-reward";
var alecaFrameZhCnRewardCaptureEndpoint = "http://127.0.0.1:38147/capture-reward";
var alecaFrameZhCnRewardFallbackInProgress = false;
var alecaFrameZhCnRewardFallbackCompleted = false;
function alecaFrameZhCnRewardDisplayName(englishName) {
    try {
        var translations = window.__ALECAFRAME_ZH_CN_ITEMS__ || {};
        var chineseName = translations[englishName];
        return chineseName && chineseName !== englishName ? chineseName + "\n" + englishName : englishName;
    } catch (e) {
        return englishName;
    }
}
function alecaFrameZhCnRewardItem(name) {
    return {
        name: alecaFrameZhCnRewardDisplayName(name), platinum: -1, ducats: -1,
        isItemVaulted: false, isFav: false, isPartOfOwned: false,
        countOwned: "-", totalToOwn: "-", componentData: [], setPlat: -1, detected: true
    };
}
function alecaFrameZhCnRewardRead(startedAt, done) {
    try {
        var cached = JSON.parse(localStorage.getItem(alecaFrameZhCnRewardResultKey) || "");
        if (cached && Array.isArray(cached.rewards) && cached.rewards.length &&
            cached.updatedAt >= startedAt - 15000 && Date.now() - cached.updatedAt < 30000) {
            done(cached.rewards);
            return;
        }
    } catch (e) { }
    fetch(alecaFrameZhCnRewardResultEndpoint).then(function (response) {
        return response.ok ? response.json() : null;
    }).then(function (payload) {
        if (payload && Array.isArray(payload.rewards) && payload.rewards.length &&
            payload.updatedAt >= startedAt - 15000) {
            done(payload.rewards);
        }
    }).catch(function () { });
}
function alecaFrameZhCnRewardApplyPrices(names) {
    try {
        var nativePlugin = window.plugin && window.plugin.get && window.plugin.get();
        if (!nativePlugin || typeof nativePlugin.getHugePriceList !== "function") return;
        nativePlugin.getHugePriceList(JSON.stringify(names), function (success, data) {
            if (!success) return;
            try {
                var prices = JSON.parse(data);
                relicsApp.relics = relicsApp.relics.map(function (relic, index) {
                    var price = prices[index] && prices[index].post;
                    if (Number.isFinite(Number(price))) relic.platinum = Number(price);
                    return relic;
                });
            } catch (e) { }
        });
    } catch (e) { }
}
function alecaFrameZhCnRequestRewardCapture() {
    // Ask the background page for its native Overwolf game-window capture.
    // The fallback keeps compatibility only if the background bridge is not
    // yet available during application startup.
    try {
        var mainWindow = overwolf.windows.getMainWindow();
        var background = mainWindow && mainWindow.window ? mainWindow.window : mainWindow;
        if (background && typeof background.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__ === "function") {
            background.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__();
            return;
        }
        fetch(alecaFrameZhCnRewardCaptureEndpoint, { method: "POST" }).catch(function () { });
    } catch (e) {
        try {
            fetch(alecaFrameZhCnRewardCaptureEndpoint, { method: "POST" }).catch(function () { });
        } catch (ignored) { }
    }
}
function alecaFrameZhCnStartRewardFallback() {
    if (alecaFrameZhCnRewardFallbackInProgress || alecaFrameZhCnRewardFallbackCompleted) return;
    alecaFrameZhCnRewardFallbackInProgress = true;
    var fallbackStartedAt = Date.now();
    var attempts = 0;
    var completed = false;
    relicsApp.loading = true;
    relicsApp.error = false;
    alecaFrameZhCnRequestRewardCapture();
    var timer = setInterval(function () {
        attempts += 1;
        alecaFrameZhCnRewardRead(fallbackStartedAt, function (names) {
            if (completed) return;
            completed = true;
            alecaFrameZhCnRewardFallbackCompleted = true;
            alecaFrameZhCnRewardFallbackInProgress = false;
            clearInterval(timer);
            relicsApp.relics = names.map(alecaFrameZhCnRewardItem);
            relicsApp.globalData = { platinum: -1, ducats: -1 };
            relicsApp.error = false;
            relicsApp.errorMessage = "";
            relicsApp.loading = false;
            alecaFrameZhCnRewardApplyPrices(names);
            console.log("[AlecaFrame ZH] Chinese reward fallback applied: " + names.join(" | "));
        });
        if (attempts >= 35 && !completed) {
            clearInterval(timer);
            alecaFrameZhCnRewardFallbackInProgress = false;
            relicsApp.loading = false;
            relicsApp.error = true;
            relicsApp.errorMessage = "Unsupported Warframe language detected. Chinese OCR did not return a current reward result.";
        }
    }, 100);
}
'@
        $mainContent = $mainContent.Replace("var relicWindowInitialized = false;", "$helper`r`nvar relicWindowInitialized = false;")
        $replacementBranch = @'
                            console.log("Failed to get relic data: " + data);

                            if (String(data || "").toLowerCase().includes("unsupported warframe language detected")) {
                                alecaFrameZhCnStartRewardFallback();
                            } else {
                                relicsApp.error = true;
                                relicsApp.errorMessage = data;
                            }
'@
        $failurePattern = '(?ms)^\s*console\.log\("Failed to get relic data: " \+ data\);\s*relicsApp\.error = true;\s*relicsApp\.errorMessage = data;'
        if ([regex]::Matches($mainContent, $failurePattern).Count -ne 1) {
            throw "奖励窗口主脚本版本不匹配，未应用中文奖励回退补丁。"
        }
        $mainContent = [regex]::Replace($mainContent, $failurePattern, $replacementBranch, 1)
    }
    # Keep the injected reward helper up to date across launcher runs. The
    # first implementation only inserted once, which left deployed users on
    # its old 2.5-second capture path even after source fixes were made.
    $mainContent = $mainContent.Replace('var alecaFrameZhCnRewardCaptureEndpoint = "http://127.0.0.1:38147/capture";', 'var alecaFrameZhCnRewardCaptureEndpoint = "http://127.0.0.1:38147/capture-reward";')
    # The reward cards use English names internally for price and inventory
    # queries. Render only the Chinese display name in this overlay; the main
    # market card renderer remains independent and can keep its bilingual UI.
    $mainContent = $mainContent.Replace('return chineseName && chineseName !== englishName ? chineseName + "\n" + englishName : englishName;', 'return chineseName && chineseName !== englishName ? chineseName : (englishName === "Forma Blueprint" ? "Forma 蓝图" : englishName);')
    # Existing installations already contain the first helper implementation.
    # Replace its direct PowerShell capture request with the background page's
    # native Overwolf screenshot bridge without touching planner logic.
    if (-not $mainContent.Contains('background.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__')) {
        $oldRewardCaptureRequest = @'
function alecaFrameZhCnRequestRewardCapture() {
    // This request is made only after the official reward window has already
    // reported the Chinese-language error. It is intentionally independent
    // from the relic-planner recommendation probe and does not poll.
    try {
        fetch(alecaFrameZhCnRewardCaptureEndpoint, { method: "POST" }).catch(function () { });
    } catch (e) { }
}
'@
        $newRewardCaptureRequest = @'
function alecaFrameZhCnRequestRewardCapture() {
    // Ask the background page for its native Overwolf game-window capture.
    // The fallback keeps compatibility only if the background bridge is not
    // yet available during application startup.
    try {
        overwolf.windows.getMainWindow().then(function (result) {
            var background = result && result.window;
            if (background && typeof background.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__ === "function") {
                background.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__();
                return;
            }
            fetch(alecaFrameZhCnRewardCaptureEndpoint, { method: "POST" }).catch(function () { });
        }).catch(function () {
            fetch(alecaFrameZhCnRewardCaptureEndpoint, { method: "POST" }).catch(function () { });
        });
    } catch (e) { }
}
'@
        if (-not $mainContent.Contains($oldRewardCaptureRequest)) {
            throw "奖励截图请求函数版本不匹配，未应用原生截图更新。"
        }
        $mainContent = $mainContent.Replace($oldRewardCaptureRequest, $newRewardCaptureRequest)
    }
    # Upgrade the Promise-based bridge deployed by the previous launcher. In
    # this Overwolf context getMainWindow is synchronous, so that version
    # never reached the native game-window capture function.
    $deployedPromiseRewardCaptureRequest = @'
function alecaFrameZhCnRequestRewardCapture() {
    // Ask the background page for its native Overwolf game-window capture.
    // The fallback keeps compatibility only if the background bridge is not
    // yet available during application startup.
    try {
        overwolf.windows.getMainWindow().then(function (result) {
            var background = result && result.window;
            if (background && typeof background.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__ === "function") {
                background.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__();
                return;
            }
            fetch(alecaFrameZhCnRewardCaptureEndpoint, { method: "POST" }).catch(function () { });
        }).catch(function () {
            fetch(alecaFrameZhCnRewardCaptureEndpoint, { method: "POST" }).catch(function () { });
        });
    } catch (e) { }
}
'@
    $synchronousRewardCaptureRequest = @'
function alecaFrameZhCnRequestRewardCapture() {
    // Ask the background page for its native Overwolf game-window capture.
    // The fallback keeps compatibility only if the background bridge is not
    // yet available during application startup.
    try {
        var mainWindow = overwolf.windows.getMainWindow();
        var background = mainWindow && mainWindow.window ? mainWindow.window : mainWindow;
        if (background && typeof background.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__ === "function") {
            background.__ALECAFRAME_ZH_CN_CAPTURE_REWARD__();
            return;
        }
        fetch(alecaFrameZhCnRewardCaptureEndpoint, { method: "POST" }).catch(function () { });
    } catch (e) {
        try {
            fetch(alecaFrameZhCnRewardCaptureEndpoint, { method: "POST" }).catch(function () { });
        } catch (ignored) { }
    }
}
'@
    $mainContent = $mainContent.Replace($deployedPromiseRewardCaptureRequest, $synchronousRewardCaptureRequest)
    if (-not $mainContent.Contains('var alecaFrameZhCnRewardFallbackInProgress = false;')) {
        $mainContent = $mainContent.Replace('var alecaFrameZhCnRewardCaptureEndpoint = "http://127.0.0.1:38147/capture-reward";', "var alecaFrameZhCnRewardCaptureEndpoint = `"http://127.0.0.1:38147/capture-reward`";`r`nvar alecaFrameZhCnRewardFallbackInProgress = false;`r`nvar alecaFrameZhCnRewardFallbackCompleted = false;")
    }
    if (-not $mainContent.Contains('if (alecaFrameZhCnRewardFallbackInProgress || alecaFrameZhCnRewardFallbackCompleted) return;')) {
        $mainContent = $mainContent.Replace('function alecaFrameZhCnStartRewardFallback() {', "function alecaFrameZhCnStartRewardFallback() {`r`n    if (alecaFrameZhCnRewardFallbackInProgress || alecaFrameZhCnRewardFallbackCompleted) return;`r`n    alecaFrameZhCnRewardFallbackInProgress = true;")
        $mainContent = $mainContent.Replace('            completed = true;', "            completed = true;`r`n            alecaFrameZhCnRewardFallbackCompleted = true;`r`n            alecaFrameZhCnRewardFallbackInProgress = false;")
        $mainContent = $mainContent.Replace('            clearInterval(timer);`r`n            relicsApp.loading = false;', "            clearInterval(timer);`r`n            alecaFrameZhCnRewardFallbackInProgress = false;`r`n            relicsApp.loading = false;")
    }
    $slowRewardStart = '(?m)^[ \t]*setTimeout\(\(\) => \{\s*sendPage\("relic"\);\s*\}, 2500\);'
    $fastRewardStart = "    // Start Chinese reward recognition immediately; native English OCR may fail later.`r`n    alecaFrameZhCnStartRewardFallback();`r`n    setTimeout(() => {`r`n        sendPage(`"relic`");`r`n    }, 300);"
    $mainContent = [regex]::Replace($mainContent, $slowRewardStart, $fastRewardStart)
    if ([regex]::Matches($mainContent, 'function alecaFrameZhCnStartRewardFallback\(').Count -ne 1 -or
        -not $mainContent.Contains('    alecaFrameZhCnStartRewardFallback();')) {
        throw '奖励窗口中文回退入口未能完整绑定，未修改官方文件。'
    }
    }
    # All page and native-hook compatibility checks above complete before any
    # official file is changed. The shared restore routine provides rollback.
    foreach ($page in $pageWrites) {
        if ($page.Changed) { [IO.File]::WriteAllText($page.Target, $page.Content, [Text.UTF8Encoding]::new($false)) }
    }
    if ($EnableRelicOcr) {
        [IO.File]::WriteAllText($relicOverlayMain, $mainContent, [Text.UTF8Encoding]::new($false))
    }
    Copy-Item -LiteralPath $localizerSource `
        -Destination (Join-Path $webRoot "assets\js\alecaframe-zh-cn.js") `
        -Force
    Copy-Item -LiteralPath $itemTranslationsSource `
        -Destination (Join-Path $webRoot "assets\js\alecaframe-zh-cn-items.js") `
        -Force
    Copy-Item -LiteralPath $relicDucatsSource `
        -Destination (Join-Path $webRoot "assets\js\alecaframe-zh-cn-relic-ducats.js") `
        -Force
    if ($EnableRelicOcr) {
        Copy-Item -LiteralPath $relicOcrBridgeSource `
            -Destination (Join-Path $webRoot "assets\js\alecaframe-zh-cn-relic-ocr.js") `
            -Force
        Copy-Item -LiteralPath $rivenOcrBridgeSource `
            -Destination (Join-Path $webRoot "assets\js\alecaframe-zh-cn-riven-ocr.js") `
            -Force
        Copy-Item -LiteralPath $rivenOverlaySource `
            -Destination (Join-Path $webRoot "assets\js\alecaframe-zh-cn-riven-overlay.js") `
            -Force
    }
    Copy-Item -LiteralPath $relicOverlaySource `
        -Destination (Join-Path $webRoot "assets\js\alecaframe-zh-cn-relic-overlay.js") `
        -Force
    Copy-Item -LiteralPath $relicRecommendationSource `
        -Destination (Join-Path $webRoot "assets\js\alecaframe-zh-cn-relic-recommendation.js") `
        -Force
    Copy-Item -LiteralPath $relicPlannerCacheSource `
        -Destination (Join-Path $webRoot "assets\js\alecaframe-zh-cn-relic-planner-cache.js") `
        -Force
    Copy-Item -LiteralPath $inventoryPriceSyncSource `
        -Destination (Join-Path $webRoot "assets\js\alecaframe-zh-cn-inventory-price-sync.js") `
        -Force
    Copy-Item -LiteralPath $inventoryImagesSource `
        -Destination (Join-Path $webRoot "assets\js\alecaframe-zh-cn-inventory-images.js") `
        -Force

}

function Start-RelicChineseOcrHelper {
    $nodeCommand = if (Test-Path -LiteralPath $localNodeSource) {
        $localNodeSource
    }
    elseif (Get-Command node -ErrorAction SilentlyContinue) {
        (Get-Command node -ErrorAction Stop).Source
    }
    else {
        throw "未找到 Node.js。请先运行 安装OCR前置组件.cmd。"
    }
    foreach ($path in @($relicOcrServerSource, $relicOcrWorkerSource, $relicCaptureSource, $paddleRewardWorkerSource, $paddlePythonSource)) {
        if (-not (Test-Path -LiteralPath $path)) {
            throw "缺少中文遗物 OCR 文件：$path"
        }
    }

    $healthUri = "http://127.0.0.1:38147/health"

    # The helper loads the OCR server code only at process startup. Stop the
    # previous instance so a launcher restart always applies source updates.
    $listeningConnection = Get-NetTCPConnection -LocalAddress "127.0.0.1" -LocalPort 38147 -State Listen `
        -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($listeningConnection) {
        $owner = Get-CimInstance Win32_Process -Filter "ProcessId = $($listeningConnection.OwningProcess)" `
            -ErrorAction SilentlyContinue
        if ($owner -and $owner.Name -eq "node.exe" -and
            $owner.CommandLine -like "*alecaframe-relic-ocr-server.js*") {
            Stop-Process -Id $listeningConnection.OwningProcess -Force
            Start-Sleep -Milliseconds 350
            Write-LauncherLog "Previous Chinese relic OCR helper stopped"
        }
        else {
            throw "端口 38147 正被其他程序占用，无法启动中文遗物 OCR 服务。"
        }
    }

    New-Item -ItemType Directory -Path $relicOcrStateRoot -Force | Out-Null
    $paddleCacheRoot = Join-Path $PSScriptRoot ".tools\paddleocr-home"
    New-Item -ItemType Directory -Path $paddleCacheRoot -Force | Out-Null
    $helperStdoutLog = Join-Path $relicOcrStateRoot "helper.out.log"
    $helperStderrLog = Join-Path $relicOcrStateRoot "helper.err.log"
    $previousPaddleHome = $env:PADDLE_HOME
    $previousXdgCacheHome = $env:XDG_CACHE_HOME
    $previousHome = $env:HOME
    $previousUserProfile = $env:USERPROFILE
    try {
        # Paddle 2.x uses XDG_CACHE_HOME/HOME for its model cache rather than
        # PADDLE_HOME alone. Keep all downloads inside this project.
        $env:PADDLE_HOME = $paddleCacheRoot
        $env:XDG_CACHE_HOME = $paddleCacheRoot
        $env:HOME = (Join-Path $PSScriptRoot ".tools")
        $env:USERPROFILE = (Join-Path $PSScriptRoot ".tools")
        Start-Process -FilePath $nodeCommand `
            -ArgumentList @($relicOcrServerSource, $itemTranslationsSource, $relicOcrWorkerSource, $relicOcrStateRoot, $relicCaptureSource, $paddlePythonSource, $paddleRewardWorkerSource) `
            -WindowStyle Hidden `
            -RedirectStandardOutput $helperStdoutLog `
            -RedirectStandardError $helperStderrLog
    }
    finally {
        $env:PADDLE_HOME = $previousPaddleHome
        $env:XDG_CACHE_HOME = $previousXdgCacheHome
        $env:HOME = $previousHome
        $env:USERPROFILE = $previousUserProfile
    }

    for ($attempt = 0; $attempt -lt 20; $attempt++) {
        Start-Sleep -Milliseconds 250
        try {
            if ((Invoke-RestMethod -Uri $healthUri -TimeoutSec 1).ready) {
                Write-LauncherLog "Chinese relic OCR helper started"
                return
            }
        }
        catch { }
    }
    throw "中文遗物 OCR 服务启动失败。"
}

function Test-AlecaFrameInitializationLog {
    param([string]$LogPath, [datetime]$StartedAt)
    if (-not (Test-Path -LiteralPath $LogPath)) { return $false }
    foreach ($line in (Get-Content -LiteralPath $LogPath -Tail 120 -ErrorAction SilentlyContinue)) {
        if ($line -notmatch 'Plugin initialization successful!' -or $line.Length -lt 23) { continue }
        $loggedAt = [datetime]::MinValue
        if ([datetime]::TryParseExact($line.Substring(0, 23), 'yyyy-MM-dd HH:mm:ss,fff',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None,
            [ref]$loggedAt) -and $loggedAt -ge $StartedAt) { return $true }
    }
    return $false
}

function Wait-AlecaFrameInitialization {
    param([datetime]$StartedAt, [int]$TimeoutSeconds = 90, [string]$Version)
    $backgroundLog = Join-Path $env:LOCALAPPDATA 'Overwolf\Log\Apps\AlecaFrame\BackGround.html.log'
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    Write-Output '正在等待 AlecaFrame 完成数据初始化……'
    while ((Get-Date) -lt $deadline) {
        Assert-AlecaFrameIntegrity -StartedAt $StartedAt
        if ($Version) { Assert-AlecaFrameSelectedVersion -Version $Version -StartedAt $StartedAt }
        if (Test-AlecaFrameInitializationLog -LogPath $backgroundLog -StartedAt $StartedAt) {
            Write-LauncherLog 'AlecaFrame native initialization completed'
            return
        }
        if (-not (Get-Process -Name 'Overwolf' -ErrorAction SilentlyContinue)) {
            throw 'Overwolf 已退出，AlecaFrame 初始化未完成。'
        }
        Start-Sleep -Milliseconds 500
    }
    throw "AlecaFrame 数据初始化超时（${TimeoutSeconds} 秒）。中文脚本已加载不代表应用已就绪，请检查 $backgroundLog"
}

function Get-AlecaFrameRenderer {
    Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
        Where-Object {
            $_.Name -eq "OverwolfBrowser.exe" -and
            $_.CommandLine -match "AlecaFrame"
        } |
        Select-Object -First 1
}

function Get-AlecaFrameStartupVersionState {
    param(
        [datetime]$StartedAt,
        [string]$TraceRoot = (Join-Path $env:LOCALAPPDATA 'Overwolf\Log'),
        [string]$BackgroundLog = (Join-Path $TraceRoot 'Apps\AlecaFrame\BackGround.html.log')
    )
    $loaded = $null
    $update = $null
    $active = $null
    $escapedId = [regex]::Escape($appId)
    $traces = Get-ChildItem -LiteralPath $TraceRoot -Filter 'Trace_*.log' -File -ErrorAction SilentlyContinue |
        Where-Object { $_.LastWriteTime -ge $StartedAt } | Sort-Object LastWriteTime -Descending | Select-Object -First 3
    foreach ($trace in $traces) {
        foreach ($line in (Get-Content -LiteralPath $trace.FullName -Tail 1200 -Encoding UTF8 -ErrorAction SilentlyContinue)) {
            if ($line -notmatch $escapedId -or $line.Length -lt 23) { continue }
            $eventAt = [datetime]::MinValue
            if (-not [datetime]::TryParseExact($line.Substring(0, 23), 'yyyy-MM-dd HH:mm:ss,fff',
                [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None,
                [ref]$eventAt) -or $eventAt -lt $StartedAt) { continue }
            if ($line -match ("Loading extension '" + $escapedId + " - AlecaFrame' (\d+(?:\.\d+){1,3})(?:\s|$)")) {
                if (-not $loaded -or $eventAt -gt $loaded.At) { $loaded = [pscustomobject]@{ Version = $Matches[1]; At = $eventAt } }
            }
            elseif ($line -match ("Updating AlecaFrame \(" + $escapedId + '\) from \d+(?:\.\d+){1,3} to (\d+(?:\.\d+){1,3})\.')) {
                if (-not $update -or $eventAt -gt $update.At) { $update = [pscustomobject]@{ Version = $Matches[1]; At = $eventAt } }
            }
        }
    }
    if (Test-Path -LiteralPath $BackgroundLog) {
        foreach ($line in (Get-Content -LiteralPath $BackgroundLog -Tail 240 -Encoding UTF8 -ErrorAction SilentlyContinue)) {
            if ($line -notmatch 'Extension version: (\d+(?:\.\d+){1,3})(?:\s|$)' -or $line.Length -lt 23) { continue }
            $version = $Matches[1]
            $eventAt = [datetime]::MinValue
            if ([datetime]::TryParseExact($line.Substring(0, 23), 'yyyy-MM-dd HH:mm:ss,fff',
                [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None,
                [ref]$eventAt) -and $eventAt -ge $StartedAt -and (-not $active -or $eventAt -gt $active.At)) {
                $active = [pscustomobject]@{ Version = $version; At = $eventAt }
            }
        }
    }
    $pending = $update -and (-not $loaded -or [version]$loaded.Version -lt [version]$update.Version)
    $lastChange = $StartedAt
    foreach ($statusEvent in @($loaded, $update)) { if ($statusEvent -and $statusEvent.At -gt $lastChange) { $lastChange = $statusEvent.At } }
    [pscustomobject]@{
        LoadedVersion = if ($loaded) { $loaded.Version } else { $null }
        ActiveVersion = if ($active) { $active.Version } else { $null }
        ActiveAt = if ($active) { $active.At } else { $StartedAt }
        UpdateVersion = if ($update) { $update.Version } else { $null }
        PendingUpdate = [bool]$pending
        LastChangeAt = $lastChange
    }
}

function Wait-OverwolfExtensionReady {
    param([datetime]$StartedAt, [int]$TimeoutSeconds = 120)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $reportedUpdate = $false
    do {
        Start-Sleep -Milliseconds 500
        $state = Get-AlecaFrameStartupVersionState -StartedAt $StartedAt
        if ($state.PendingUpdate) {
            if (-not $reportedUpdate) {
                Write-Output '检测到 AlecaFrame 自动更新，正在等待更新完成……'
                Write-LauncherLog "Waiting for extension update to $($state.UpdateVersion)"
                $reportedUpdate = $true
            }
            continue
        }
        $latest = Get-LatestVersionDirectory -AllowMissing
        if ($latest -and $state.LoadedVersion -eq $latest.Name -and (Get-Date) -ge $state.LastChangeAt.AddSeconds(3)) { return }
        # Missing trace logs must not turn an otherwise healthy cold start into
        # a hard failure. The official renderer/version checks below still run.
        if (-not $state.LoadedVersion -and (Get-Date) -ge $StartedAt.AddSeconds(15)) {
            Write-LauncherLog 'Extension trace unavailable; checking the official renderer and native initialization'
            return
        }
    } while ((Get-Date) -lt $deadline)
    throw 'AlecaFrame 自动更新尚未完成，暂未修改汉化文件。请等待官方更新完成后重试。'
}

function Wait-AlecaFrameOfficialVersionReady {
    param([datetime]$StartedAt, [int]$TimeoutSeconds = 120)
    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $backgroundLog = Join-Path $env:LOCALAPPDATA 'Overwolf\Log\Apps\AlecaFrame\BackGround.html.log'
    $stableKey = ''
    $stableAt = Get-Date
    do {
        Assert-AlecaFrameIntegrity -StartedAt $StartedAt
        $latest = Get-LatestVersionDirectory -AllowMissing
        $state = Get-AlecaFrameStartupVersionState -StartedAt $StartedAt
        $renderer = Get-AlecaFrameRenderer
        $versionMatches = $latest -and -not $state.PendingUpdate -and
            (-not $state.LoadedVersion -or $state.LoadedVersion -eq $latest.Name) -and
            (-not $state.ActiveVersion -or $state.ActiveVersion -eq $latest.Name)
        $nativeReady = $versionMatches -and $renderer -and
            (Test-AlecaFrameInitializationLog -LogPath $backgroundLog -StartedAt $state.ActiveAt)
        $key = if ($nativeReady) { "$($latest.FullName)|$($renderer.ProcessId)|$($state.ActiveAt.Ticks)" } else { '' }
        if (-not $key -or $key -ne $stableKey) { $stableAt = Get-Date; $stableKey = $key }
        if ($key -and (Get-Date) -ge $stableAt.AddSeconds(3)) {
            Write-LauncherLog "Official AlecaFrame ready on version $($latest.Name), renderer $($renderer.ProcessId)"
            return $latest
        }
        if (-not (Get-Process -Name 'Overwolf' -ErrorAction SilentlyContinue)) { throw 'Overwolf 已退出，版本确认未完成。' }
        Start-Sleep -Milliseconds 500
    } while ((Get-Date) -lt $deadline)
    throw 'AlecaFrame 更新或数据初始化尚未完成，无法确认当前运行版本；未向旧版本写入汉化。'
}

function Assert-AlecaFrameSelectedVersion {
    param([string]$Version, [datetime]$StartedAt)
    $state = Get-AlecaFrameStartupVersionState -StartedAt $StartedAt
    $latest = Get-LatestVersionDirectory -AllowMissing
    if ($state.PendingUpdate -or -not $latest -or $latest.Name -ne $Version -or
        ($state.LoadedVersion -and $state.LoadedVersion -ne $Version)) {
        $versionChangeException = New-Object InvalidOperationException('AlecaFrame 在启动过程中发生更新，正在重新选择汉化版本。')
        $versionChangeException.Data['AlecaFrameVersionChanged'] = $true
        throw $versionChangeException
    }
}

function Test-AlecaFrameChineseLoadLog {
    param([string]$LogPath, [datetime]$StartedAt)
    if (-not (Test-Path -LiteralPath $LogPath)) { return $false }
    foreach ($line in (Get-Content -LiteralPath $LogPath -Tail 120 -Encoding UTF8 -ErrorAction SilentlyContinue)) {
        if ($line -notmatch '\[AlecaFrame 中文补丁\] 已加载' -or $line.Length -lt 23) { continue }
        $loggedAt = [datetime]::MinValue
        if ([datetime]::TryParseExact($line.Substring(0, 23), 'yyyy-MM-dd HH:mm:ss,fff',
            [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::None,
            [ref]$loggedAt) -and $loggedAt -ge $StartedAt) { return $true }
    }
    return $false
}

function Start-AlecaFrameAndWait {
    param(
        [int]$TimeoutSeconds = 60,
        [datetime]$StartedAt = (Get-Date)
    )

    $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
    $nextLaunch = Get-Date
    do {
        Assert-AlecaFrameIntegrity -StartedAt $StartedAt
        $renderer = Get-AlecaFrameRenderer
        if ($renderer) { return $renderer }
        if ((Get-Date) -ge $nextLaunch) {
            Start-Process -FilePath $launcherExe `
                -ArgumentList "-launchapp", $appId, "-from-desktop" -WindowStyle Hidden
            $nextLaunch = (Get-Date).AddSeconds(3)
        }
        Start-Sleep -Milliseconds 500
        Assert-AlecaFrameIntegrity -StartedAt $StartedAt
        $renderer = Get-AlecaFrameRenderer
        if ($renderer) {
            return $renderer
        }
    } while ((Get-Date) -lt $deadline)

    throw "AlecaFrame 启动超时。"
}

try {
    $overwolfInstall = Find-OverwolfInstall
    $overwolfExe = $overwolfInstall.Overwolf
    $launcherExe = $overwolfInstall.Launcher
    if (-not (Test-Path -LiteralPath $overwolfExe)) {
        throw "找不到 Overwolf：$overwolfExe"
    }
    if (-not (Test-Path -LiteralPath $launcherExe)) {
        throw "找不到 OverwolfLauncher：$launcherExe"
    }
    if (-not (Test-Path -LiteralPath $localizerSource)) {
        throw "缺少汉化词库：$localizerSource"
    }
    if (-not (Test-Path -LiteralPath $itemTranslationsSource)) {
        throw "缺少物品汉化词库：$itemTranslationsSource"
    }
    if (-not (Test-Path -LiteralPath $relicDucatsSource)) {
        throw "缺少遗物奖励杜卡德词库：$relicDucatsSource"
    }
    if (-not (Test-Path -LiteralPath $relicOcrBridgeSource)) {
        throw "缺少中文遗物 OCR 桥接脚本：$relicOcrBridgeSource"
    }
    if (-not (Test-Path -LiteralPath $relicOverlaySource)) {
        throw "缺少中文遗物奖励叠加层脚本：$relicOverlaySource"
    }
    if (-not (Test-Path -LiteralPath $relicRecommendationSource)) {
        throw "缺少中文遗物推荐显示脚本：$relicRecommendationSource"
    }
    if (-not (Test-Path -LiteralPath $relicPlannerCacheSource)) {
        throw "缺少遗物规划缓存脚本：$relicPlannerCacheSource"
    }
    if (-not (Test-Path -LiteralPath $inventoryPriceSyncSource)) {
        throw "缺少仓库价格同步脚本：$inventoryPriceSyncSource"
    }

    $versionDirectory = Get-LatestVersionDirectory
    if ($validationReportOnly) {
        # Version numbers are logged below for diagnostics, not used as an
        # allowlist. Actual patch compatibility and initialization are checked.
        if (Get-Process -Name "Overwolf" -ErrorAction SilentlyContinue) {
            throw "请先退出 Overwolf，再运行临时试验，以免影响其他已运行的应用。"
        }
        Write-LauncherLog "EXPERIMENTAL: validation report-only applies to every extension in this Overwolf session; official files will be restored when the session ends"
    }
    Write-LauncherLog "Starting AlecaFrame ZH for $($versionDirectory.Name)"
    Write-LauncherLog "Overwolf version: $((Get-Item -LiteralPath $overwolfExe).VersionInfo.FileVersion)"
    $relicOcrRequested = Get-RelicOcrEnabled -DefaultEnabled:(-not $validationReportOnly)
    $relicOcrAvailable = Test-RelicOcrPrerequisites
    $enableRelicOcr = $relicOcrRequested -and $relicOcrAvailable -and -not $TestValidationReportOnly
    if ($enableRelicOcr) {
        Start-RelicChineseOcrHelper
    }
    elseif ($TestValidationReportOnly) {
        Write-LauncherLog "Chinese relic OCR skipped during UI-only compatibility experiment"
    }
    elseif ($relicOcrRequested) {
        Write-LauncherLog "Chinese relic OCR skipped because optional prerequisites are not installed"
    }
    else {
        Write-LauncherLog "Chinese relic OCR disabled by saved setting or session default"
    }

    Get-Process -Name "Overwolf" -ErrorAction SilentlyContinue | Stop-Process
    Start-Sleep -Seconds 4
    Restore-OfficialFiles -Version $versionDirectory.Name -VersionPath $versionDirectory.FullName

    $overwolfStartedAt = Get-Date
    $overwolfArguments = @("--ow-disable-features=extension-validation,read-opk-from-memory")
    if ($validationReportOnly) {
        $overwolfArguments += "--ow-enable-features=force-validation-report-only"
    }
    Start-Process -FilePath $overwolfExe `
        -ArgumentList $overwolfArguments -WindowStyle Hidden
    $testSessionStarted = [bool]$validationReportOnly
    Wait-OverwolfExtensionReady -StartedAt $overwolfStartedAt

    # The official warm-up may install a newer version than the directory found
    # before Overwolf started. Select the version only after that update settles.
    $startupComplete = $false
    for ($launchAttempt = 1; $launchAttempt -le 3; $launchAttempt++) {
        $patchWritten = $false
        try {
            $null = Start-AlecaFrameAndWait -TimeoutSeconds 120 -StartedAt $overwolfStartedAt
            $readyVersion = Wait-AlecaFrameOfficialVersionReady -StartedAt $overwolfStartedAt
            if ($versionDirectory.Name -ne $readyVersion.Name) {
                Write-LauncherLog "AlecaFrame updated during startup: $($versionDirectory.Name) -> $($readyVersion.Name); selecting the running version"
            }
            $versionDirectory = $readyVersion
            Assert-AlecaFrameSelectedVersion -Version $versionDirectory.Name -StartedAt $overwolfStartedAt
            # Every newly selected version needs its own same-version backup.
            Restore-OfficialFiles -Version $versionDirectory.Name -VersionPath $versionDirectory.FullName
            $patchTime = Get-Date
            $patchWritten = $true
            Add-ChineseFiles -VersionPath $versionDirectory.FullName -EnableRelicOcr $enableRelicOcr
            Write-LauncherLog "Chinese scripts applied to AlecaFrame $($versionDirectory.Name)"

            # Reload only AlecaFrame, keeping Overwolf and the session flags alive.
            Get-CimInstance Win32_Process -ErrorAction SilentlyContinue |
                Where-Object {
                    $_.Name -eq "OverwolfBrowser.exe" -and
                    $_.CommandLine -match "AlecaFrame"
                } |
                ForEach-Object { Stop-Process -Id $_.ProcessId -ErrorAction SilentlyContinue }
            Start-Sleep -Seconds 3
            Assert-AlecaFrameSelectedVersion -Version $versionDirectory.Name -StartedAt $overwolfStartedAt
            $null = Start-AlecaFrameAndWait -TimeoutSeconds 120 -StartedAt $patchTime

            $loaded = $false
            $mainLog = Join-Path $env:LOCALAPPDATA 'Overwolf\Log\Apps\AlecaFrame\MainWindow.html.log'
            for ($attempt = 0; $attempt -lt 120; $attempt++) {
                Start-Sleep -Milliseconds 500
                Assert-AlecaFrameIntegrity -StartedAt $patchTime
                Assert-AlecaFrameSelectedVersion -Version $versionDirectory.Name -StartedAt $overwolfStartedAt
                if (Test-AlecaFrameChineseLoadLog -LogPath $mainLog -StartedAt $patchTime) { $loaded = $true; break }
            }
            if (-not $loaded) { throw "中文脚本未能加载，请查看 $stateRoot\launcher.log" }
            Wait-AlecaFrameInitialization -StartedAt $patchTime -Version $versionDirectory.Name
            Assert-AlecaFrameSelectedVersion -Version $versionDirectory.Name -StartedAt $overwolfStartedAt
            $startupComplete = $true
            break
        }
        catch {
            $startupFailure = $_
            $versionChanged = [bool]$startupFailure.Exception.Data['AlecaFrameVersionChanged']
            if (-not $versionChanged) {
                # Updating may remove a page while patch planning is reading it.
                # Retry only when a version change is independently confirmed.
                try { Assert-AlecaFrameSelectedVersion -Version $versionDirectory.Name -StartedAt $overwolfStartedAt }
                catch { $versionChanged = [bool]$_.Exception.Data['AlecaFrameVersionChanged'] }
            }
            if (-not $versionChanged) { throw $startupFailure }
            Write-LauncherLog "Version changed while loading Chinese UI; retry $launchAttempt of 3"
            if ($patchWritten -and (Test-Path -LiteralPath (Join-Path $versionDirectory.FullName 'manifest.json'))) {
                Restore-OfficialFiles -Version $versionDirectory.Name -VersionPath $versionDirectory.FullName
            }
            if ($launchAttempt -eq 3) { throw 'AlecaFrame 在启动过程中连续更新，暂未完成汉化。请等待官方更新稳定后重试。' }
            Wait-OverwolfExtensionReady -StartedAt $overwolfStartedAt
        }
    }
    if (-not $startupComplete) { throw 'AlecaFrame 中文启动未完成。' }
    Write-LauncherLog "Chinese UI loaded successfully"
    if ($TestValidationReportOnly) {
        Write-Output "SESSION_READY: translation load marker found; 45 seconds for visual inspection, then automatic exit and restore."
        Start-Sleep -Seconds 45
    }
    elseif ($SessionValidationReportOnly) {
        Write-Output "SESSION_READY: experimental Chinese UI loaded. Exit Overwolf normally to restore official files."
        while (Get-Process -Name "Overwolf" -ErrorAction SilentlyContinue) {
            Start-Sleep -Seconds 2
        }
    }
}
catch {
    $launchError = $_.Exception.Message
    Write-LauncherLog "ERROR: $launchError"
    if ($validationReportOnly) {
        # The finally block restores only a session started by this experiment.
        throw
    }
    try {
        Get-Process -Name "Overwolf" -ErrorAction SilentlyContinue | Stop-Process
        Start-Sleep -Seconds 3
        if ($versionDirectory) {
            Restore-OfficialFiles -Version $versionDirectory.Name -VersionPath $versionDirectory.FullName
        }
    }
    catch {
        Write-LauncherLog "RESTORE ERROR: $($_.Exception.Message)"
    }
    Add-Type -AssemblyName System.Windows.Forms
    [Windows.Forms.MessageBox]::Show(
        $launchError,
        "AlecaFrame 中文启动失败",
        [Windows.Forms.MessageBoxButtons]::OK,
        [Windows.Forms.MessageBoxIcon]::Error
    ) | Out-Null
    exit 1
}
finally {
    if ($validationReportOnly -and $testSessionStarted) {
        try {
            Get-Process -Name "Overwolf" -ErrorAction SilentlyContinue | Stop-Process
            Start-Sleep -Seconds 3
        }
        finally {
            if (Test-Path -LiteralPath (Join-Path $versionDirectory.FullName 'manifest.json')) {
                Restore-OfficialFiles -Version $versionDirectory.Name -VersionPath $versionDirectory.FullName
            }
            else { Write-LauncherLog "Official update removed version $($versionDirectory.Name); no old version recreated" }
        }
        Write-LauncherLog "Experimental session ended; official files restored"
        Write-Output "SESSION_RESTORED: experimental Overwolf session ended and official files restored."
    }
}
