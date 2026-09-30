[CmdletBinding()]
param(
    [switch]$Force
)

$ErrorActionPreference = "Stop"
$ProgressPreference = "SilentlyContinue"

# All OCR dependencies stay inside the project.  No system-wide Python or
# Node.js installation is required, and the launcher uses these local copies.
$toolsRoot = Join-Path $PSScriptRoot ".tools"
$pythonRoot = Join-Path $toolsRoot "python311-portable"
$pythonExe = Join-Path $pythonRoot "python.exe"
$nodeRoot = Join-Path $toolsRoot "node"
$nodeExe = Join-Path $nodeRoot "node.exe"
$cacheRoot = Join-Path $toolsRoot "paddleocr-home"
$downloadRoot = Join-Path $toolsRoot "downloads"
$pythonVersion = "3.11.9"
$nodeVersion = "20.18.0"

# Mirrors are intentionally explicit so users in mainland China do not need
# to download Python/Node/PyPI packages from overseas default endpoints.
$pythonZipUrl = "https://mirrors.huaweicloud.com/python/$pythonVersion/python-$pythonVersion-embed-amd64.zip"
$nodeZipUrl = "https://npmmirror.com/mirrors/node/v$nodeVersion/node-v$nodeVersion-win-x64.zip"
$getPipUrl = "https://mirrors.aliyun.com/pypi/get-pip.py"
$pypiMirror = "https://mirrors.aliyun.com/pypi/simple"
$paddleCpuMirror = "https://www.paddlepaddle.org.cn/packages/stable/cpu/"

function Write-Step {
    param([string]$Text)
    Write-Host "[OCR 前置安装] $Text" -ForegroundColor Cyan
}

function Assert-ToolsChildPath {
    param([string]$Path)
    $expectedRoot = [IO.Path]::GetFullPath($toolsRoot).TrimEnd('\') + '\'
    $resolved = [IO.Path]::GetFullPath($Path)
    if (-not $resolved.StartsWith($expectedRoot, [StringComparison]::OrdinalIgnoreCase)) {
        throw "目标目录不属于当前项目的 .tools：$Path"
    }
}

function Get-DownloadFile {
    param([string]$Url, [string]$Destination)
    if ((Test-Path -LiteralPath $Destination) -and (Get-Item -LiteralPath $Destination).Length -gt 0) {
        Write-Step "复用已下载文件：$(Split-Path -Leaf $Destination)"
        return
    }
    Write-Step "下载：$Url"
    Assert-ToolsChildPath $Destination
    $partialPath = "$Destination.partial"
    try {
        Invoke-WebRequest -Uri $Url -OutFile $partialPath -UseBasicParsing
        if (-not (Test-Path -LiteralPath $partialPath -PathType Leaf) -or
            (Get-Item -LiteralPath $partialPath).Length -eq 0) {
            throw "下载文件为空：$Url"
        }
        Move-Item -LiteralPath $partialPath -Destination $Destination -Force
    }
    finally {
        if (Test-Path -LiteralPath $partialPath) { Remove-Item -LiteralPath $partialPath -Force }
    }
}

function Expand-ArchiveReplace {
    param([string]$ZipPath, [string]$Destination)
    Assert-ToolsChildPath $Destination
    if (Test-Path -LiteralPath $Destination) {
        Remove-Item -LiteralPath $Destination -Recurse -Force
    }
    New-Item -ItemType Directory -Path $Destination -Force | Out-Null
    Expand-Archive -LiteralPath $ZipPath -DestinationPath $Destination -Force
}

function Test-PythonPackages {
    if (-not (Test-Path -LiteralPath $pythonExe)) { return $false }
    # Windows PowerShell 5.1 strips double quotes from native -c arguments.
    # Keep Python string literals single-quoted so version checks survive.
    $versionCheck = @'
import paddle, paddleocr, numpy, PIL
assert paddle.__version__ == '2.6.2', paddle.__version__
assert paddleocr.__version__ == '2.9.1', paddleocr.__version__
assert numpy.__version__ == '1.26.4', numpy.__version__
assert PIL.__version__ == '12.3.0', PIL.__version__
'@
    # Missing/broken packages are expected here. In Windows PowerShell 5.1,
    # redirected native stderr can otherwise terminate the installer under Stop.
    # This preference is local to the probe; installation errors still stop.
    $ErrorActionPreference = 'SilentlyContinue'
    & $pythonExe -B -c $versionCheck *> $null
    return $LASTEXITCODE -eq 0
}

function Test-PaddleModels {
    $modelFiles = @(
        (Join-Path $cacheRoot ".paddleocr\whl\det\ch\ch_PP-OCRv4_det_infer\inference.pdmodel"),
        (Join-Path $cacheRoot ".paddleocr\whl\det\ch\ch_PP-OCRv4_det_infer\inference.pdiparams"),
        (Join-Path $cacheRoot ".paddleocr\whl\rec\ch\ch_PP-OCRv4_rec_infer\inference.pdmodel"),
        (Join-Path $cacheRoot ".paddleocr\whl\rec\ch\ch_PP-OCRv4_rec_infer\inference.pdiparams"),
        (Join-Path $cacheRoot ".paddleocr\whl\cls\ch_ppocr_mobile_v2.0_cls_infer\inference.pdmodel"),
        (Join-Path $cacheRoot ".paddleocr\whl\cls\ch_ppocr_mobile_v2.0_cls_infer\inference.pdiparams")
    )

    return @($modelFiles | Where-Object {
        -not (Test-Path -LiteralPath $_ -PathType Leaf) -or (Get-Item -LiteralPath $_).Length -eq 0
    }).Count -eq 0
}

function Get-ProgramVersion {
    param([string]$Executable)
    $ErrorActionPreference = 'SilentlyContinue'
    try {
        $output = (& $Executable --version 2>$null | Out-String).Trim()
        if ($LASTEXITCODE -eq 0) { return $output }
    }
    catch { }
    return ''
}

function Ensure-PortablePython {
    $pythonReady = $false
    if (Test-Path -LiteralPath $pythonExe) {
        $installedVersion = Get-ProgramVersion $pythonExe
        $pythonReady = $installedVersion -eq "Python $pythonVersion"
        if ($pythonReady -and -not $Force) {
            Write-Step "便携 Python $pythonVersion 已存在，跳过下载和解压。"
            return
        }
        if (-not $pythonReady) {
            Write-Step "现有便携 Python 不可用或版本不符（$installedVersion），将重新安装。"
        }
    }
    $zipPath = Join-Path $downloadRoot "python-$pythonVersion-embed-amd64.zip"
    Get-DownloadFile -Url $pythonZipUrl -Destination $zipPath
    Expand-ArchiveReplace -ZipPath $zipPath -Destination $pythonRoot
    $pthPath = Join-Path $pythonRoot "python311._pth"
    $pth = @("python311.zip", ".", "Lib\\site-packages", "", "import site")
    $pth | Set-Content -LiteralPath $pthPath -Encoding ASCII
    if (-not (Test-Path -LiteralPath $pythonExe)) {
        throw "便携 Python 解压后缺少 python.exe。"
    }
}

function Ensure-PortableNode {
    $nodeReady = $false
    if (Test-Path -LiteralPath $nodeExe) {
        $installedVersion = Get-ProgramVersion $nodeExe
        $nodeReady = $installedVersion -eq "v$nodeVersion"
        if ($nodeReady -and -not $Force) {
            Write-Step "便携 Node.js v$nodeVersion 已存在，跳过下载和解压。"
            return
        }
        if (-not $nodeReady) {
            Write-Step "现有便携 Node.js 不可用或版本不符（$installedVersion），将重新安装。"
        }
    }
    $zipPath = Join-Path $downloadRoot "node-v$nodeVersion-win-x64.zip"
    $extractRoot = Join-Path $downloadRoot "node-v$nodeVersion-win-x64"
    Get-DownloadFile -Url $nodeZipUrl -Destination $zipPath
    Assert-ToolsChildPath $extractRoot
    Assert-ToolsChildPath $nodeRoot
    if (Test-Path -LiteralPath $extractRoot) { Remove-Item -LiteralPath $extractRoot -Recurse -Force }
    Expand-Archive -LiteralPath $zipPath -DestinationPath $downloadRoot -Force
    if (-not (Test-Path -LiteralPath (Join-Path $extractRoot "node.exe"))) {
        throw "Node.js 解压后缺少 node.exe。"
    }
    if (Test-Path -LiteralPath $nodeRoot) { Remove-Item -LiteralPath $nodeRoot -Recurse -Force }
    Move-Item -LiteralPath $extractRoot -Destination $nodeRoot
}

New-Item -ItemType Directory -Path $toolsRoot,$downloadRoot,$cacheRoot -Force | Out-Null
$env:PADDLE_HOME = $cacheRoot
$env:XDG_CACHE_HOME = $cacheRoot

Write-Step "准备便携 Python $pythonVersion"
Ensure-PortablePython

if (-not (Test-PythonPackages) -or $Force) {
    $getPipPath = Join-Path $downloadRoot "get-pip.py"
    Get-DownloadFile -Url $getPipUrl -Destination $getPipPath
    Write-Step "安装 pip（阿里云 PyPI 镜像）"
    & $pythonExe $getPipPath --no-warn-script-location --no-cache-dir --index-url $pypiMirror
    if ($LASTEXITCODE -ne 0) { throw "pip 安装失败。" }

    Write-Step "安装 PaddlePaddle CPU 2.6.2（Paddle 国内镜像）"
    & $pythonExe -m pip install --disable-pip-version-check --no-warn-script-location --no-cache-dir --upgrade `
        "paddlepaddle==2.6.2" -i $paddleCpuMirror
    if ($LASTEXITCODE -ne 0) { throw "PaddlePaddle 安装失败。请检查网络或镜像可用性。" }

    Write-Step "安装 PaddleOCR、NumPy 和 Pillow（阿里云 PyPI 镜像）"
    & $pythonExe -m pip install --disable-pip-version-check --no-warn-script-location --no-cache-dir --upgrade `
        "paddleocr==2.9.1" "numpy==1.26.4" "pillow==12.3.0" -i $pypiMirror
    if ($LASTEXITCODE -ne 0) { throw "PaddleOCR 依赖安装失败。请检查网络或镜像可用性。" }
} else {
    Write-Step "Python OCR 依赖及版本已符合要求，跳过安装。"
}

Write-Step "准备便携 Node.js $nodeVersion"
Ensure-PortableNode

if (Test-PaddleModels) {
    Write-Step "PaddleOCR 中文模型已存在且完整，跳过下载。"
} else {
    Write-Step "PaddleOCR 中文模型缺失，将初始化下载。"
    # Use the same explicit model paths as the runtime worker and readiness check.
    # PADDLE_HOME alone does not control PaddleOCR 2.x's default model directory.
    $modelInitialization = @'
import sys
from pathlib import Path
from paddleocr import PaddleOCR
model_root = Path(sys.argv[1]) / '.paddleocr' / 'whl'
PaddleOCR(lang='ch', use_angle_cls=True, show_log=False, use_mkldnn=False, use_gpu=False,
    det_model_dir=str(model_root / 'det' / 'ch' / 'ch_PP-OCRv4_det_infer'),
    rec_model_dir=str(model_root / 'rec' / 'ch' / 'ch_PP-OCRv4_rec_infer'),
    cls_model_dir=str(model_root / 'cls' / 'ch_ppocr_mobile_v2.0_cls_infer'))
print('PaddleOCR ready')
'@
    & $pythonExe -B -c $modelInitialization $cacheRoot
    if ($LASTEXITCODE -ne 0) { throw "PaddleOCR 模型初始化失败。请检查安装窗口中的错误信息后重试。" }
    if (-not (Test-PaddleModels)) { throw "PaddleOCR 初始化完成后，中文模型文件仍不完整。" }
}

& $nodeExe --version
if ($LASTEXITCODE -ne 0) { throw "Node.js 验证失败。" }
if (-not (Test-PythonPackages)) { throw "OCR 依赖最终验证失败，请保留安装输出进行诊断。" }

Write-Host ""
Write-Host "OCR 前置组件已准备完成。需要 OCR 时运行 启用中文遗物OCR.cmd，下次中文启动生效。" -ForegroundColor Green
Write-Host "尚未创建桌面快捷方式时，运行 Install.cmd。"
Write-Host "缓存位置：$cacheRoot"
