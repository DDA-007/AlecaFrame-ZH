param(
    [Parameter(Mandatory = $true)][string]$ImagePath,
    [Parameter(Mandatory = $true)][string]$TranslationsPath,
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"

function Await-WinRtOperation {
    param(
        [Parameter(Mandatory = $true)]$Operation,
        [Parameter(Mandatory = $true)][Type]$ResultType
    )

    $method = [System.WindowsRuntimeSystemExtensions].GetMethods() |
        Where-Object {
            $_.Name -eq "AsTask" -and
            $_.IsGenericMethod -and
            $_.GetParameters().Count -eq 1
        } |
        Select-Object -First 1
    $task = $method.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.Wait()
    return $task.Result
}

function Normalize-Text {
    param([string]$Text)
    if ($null -eq $Text) { return "" }
    return (($Text -replace "[\s\p{P}\p{S}]", "").ToLowerInvariant())
}

function Get-LineBounds {
    param([Parameter(Mandatory = $true)]$Line)

    $words = @($Line.Words)
    if ($words.Count -eq 0) { return $null }
    $left = [double]::PositiveInfinity
    $top = [double]::PositiveInfinity
    $right = 0.0
    $bottom = 0.0
    foreach ($word in $words) {
        $wordRect = @($word.BoundingRect)[0]
        $wordX = [double]@($wordRect.X)[0]
        $wordY = [double]@($wordRect.Y)[0]
        $wordWidth = [double]@($wordRect.Width)[0]
        $wordHeight = [double]@($wordRect.Height)[0]
        $left = [Math]::Min($left, $wordX)
        $top = [Math]::Min($top, $wordY)
        $right = [Math]::Max($right, $wordX + $wordWidth)
        $bottom = [Math]::Max($bottom, $wordY + $wordHeight)
    }

    return [pscustomobject]@{
        Left = $left
        Top = $top
        Right = $right
        Bottom = $bottom
        CenterX = ($left + $right) / 2
    }
}

function Get-OcrComparisonVariants {
    param([string]$NormalizedText)

    # These are observed Windows Chinese OCR confusions in reward labels. They
    # are used only to look up the English item ID; the source UI is untouched.
    return @(
        $NormalizedText,
        ($NormalizedText -replace ([string][char]0x53C8), ([string][char]0x53CC)),
        ($NormalizedText -replace ([string][char]0x9489), ([string][char]0x8BA2)),
        ($NormalizedText -replace "stnng", "string"),
        ($NormalizedText -replace "bluepr1nt", "blueprint"),
        ($NormalizedText -replace "biueprint", "blueprint"),
        ($NormalizedText -replace "ptime", "prime"),
        # The compact reward-card typeface makes lowercase l and uppercase I
        # visually indistinguishable to Windows OCR. Restrict the correction
        # to the ASCII portion immediately preceding Prime; later resolution
        # still requires an exact table entry and a known component suffix.
        ($NormalizedText -replace "i(?=[a-z]*prime)", "l")
    ) | Select-Object -Unique
}

function Get-UnicodeText {
    param([int[]]$CodePoints)
    return -join ($CodePoints | ForEach-Object { [char]$_ })
}

function Get-RewardTitleMarkers {
    return @(
        "prime", "blueprint", "barrel", "receiver", "stock", "blade", "handle", "grip", "string", "link",
        (Get-UnicodeText @(0x84DD, 0x56FE)),
        (Get-UnicodeText @(0x67AA, 0x7BA1)),
        (Get-UnicodeText @(0x67AA, 0x673A)),
        (Get-UnicodeText @(0x67AA, 0x6258)),
        (Get-UnicodeText @(0x5200, 0x5203)),
        (Get-UnicodeText @(0x63E1, 0x67C4)),
        (Get-UnicodeText @(0x7CFB, 0x7EDF)),
        (Get-UnicodeText @(0x673A, 0x4F53)),
        (Get-UnicodeText @(0x795E, 0x7ECF))
    )
}

try {
    if (-not (Test-Path -LiteralPath $ImagePath)) {
        throw "Screenshot file does not exist."
    }

    Add-Type -AssemblyName System.Drawing
    Add-Type -AssemblyName System.Runtime.WindowsRuntime
    [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Storage.FileAccessMode, Windows.Storage, ContentType = WindowsRuntime] | Out-Null
    [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime] | Out-Null
    [Windows.Media.Ocr.OcrEngine, Windows.Media.Ocr, ContentType = WindowsRuntime] | Out-Null
    [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime] | Out-Null

    $language = [Windows.Globalization.Language]::new("zh-Hans-CN")
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage($language)
    if ($null -eq $engine) {
        throw "Windows Chinese OCR recognizer is unavailable."
    }

    # The recommendation overlay only needs the refinement page title and
    # its era. Recognizing the complete ultrawide frame takes several seconds
    # and is only necessary for reward-choice screens, so detect this compact
    # header region first and preserve the full OCR path as the fallback.
    $quickSource = [Drawing.Image]::FromFile($ImagePath)
    $quickCropPath = Join-Path ([IO.Path]::GetTempPath()) ("alecaframe-relic-header-" + [guid]::NewGuid().ToString() + ".png")
    try {
        $quickWidth = [Math]::Max(1, [int]([Math]::Ceiling($quickSource.Width * 0.40)))
        $quickHeight = [Math]::Max(1, [int]([Math]::Ceiling($quickSource.Height * 0.45)))
        $quickCrop = New-Object Drawing.Bitmap $quickWidth, $quickHeight
        $quickGraphics = [Drawing.Graphics]::FromImage($quickCrop)
        try {
            $quickGraphics.DrawImage($quickSource, (New-Object Drawing.Rectangle 0, 0, $quickWidth, $quickHeight), (New-Object Drawing.Rectangle 0, 0, $quickWidth, $quickHeight), [Drawing.GraphicsUnit]::Pixel)
            $quickCrop.Save($quickCropPath, [Drawing.Imaging.ImageFormat]::Png)
        }
        finally {
            $quickGraphics.Dispose()
            $quickCrop.Dispose()
        }

        $quickFile = Await-WinRtOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($quickCropPath)) ([Windows.Storage.StorageFile])
        $quickStream = Await-WinRtOperation ($quickFile.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
        try {
            $quickDecoder = Await-WinRtOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($quickStream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $quickBitmap = Await-WinRtOperation ($quickDecoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            try {
                $quickOcrResult = Await-WinRtOperation ($engine.RecognizeAsync($quickBitmap)) ([Windows.Media.Ocr.OcrResult])
            }
            finally {
                $quickBitmap.Dispose()
            }
        }
        finally {
            $quickStream.Dispose()
        }

        $quickLines = foreach ($line in $quickOcrResult.Lines) {
            $bounds = Get-LineBounds $line
            if ($null -eq $bounds) { continue }
            [pscustomobject]@{ Text = [string]$line.Text; Left = $bounds.Left; Top = $bounds.Top; Right = $bounds.Right; Bottom = $bounds.Bottom }
        }
        $voidRelics = Get-UnicodeText @(0x865A, 0x7A7A, 0x9057, 0x7269)
        $refinement = Get-UnicodeText @(0x7CBE, 0x70BC)
        $quickTitle = $quickLines | Where-Object {
            $normalizedLine = Normalize-Text $_.Text
            $normalizedLine.Contains($voidRelics) -and $normalizedLine.Contains($refinement)
        } | Select-Object -First 1
        $era = $null
        $eraLabels = [ordered]@{
            (Get-UnicodeText @(0x53E4, 0x7EAA)) = "Lith"
            (Get-UnicodeText @(0x524D, 0x7EAA)) = "Meso"
            (Get-UnicodeText @(0x4E2D, 0x7EAA)) = "Neo"
            (Get-UnicodeText @(0x540E, 0x7EAA)) = "Axi"
        }
        $relicWord = Get-UnicodeText @(0x9057, 0x7269)
        $quickEraEvidence = @{}
        foreach ($eraLabel in $eraLabels.Keys) { $quickEraEvidence[$eraLabel] = 0 }
        foreach ($line in $quickLines) {
            $normalizedLine = Normalize-Text $line.Text
            foreach ($eraLabel in $eraLabels.Keys) {
                # The Windows engine occasionally loses the second glyph of
                # an era label. Count only lines that still contain both the
                # era's distinctive first glyph and the relic label.
                $eraFirstGlyph = $eraLabel.Substring(0, 1)
                if ($normalizedLine.Contains($eraFirstGlyph) -and $normalizedLine.Contains($relicWord)) {
                    $quickEraEvidence[$eraLabel] += 1
                }
            }
        }
        $quickEraLabel = $quickEraEvidence.GetEnumerator() | Sort-Object Value -Descending | Select-Object -First 1
        if ($quickEraLabel -and $quickEraLabel.Value -ge 2) {
            $era = $eraLabels[$quickEraLabel.Key]
        }
        if ($null -ne $quickTitle -or $null -ne $era) {

            $result = New-Object Drawing.Bitmap $quickSource.Width, $quickSource.Height
            $graphics = [Drawing.Graphics]::FromImage($result)
            try {
                $graphics.DrawImage($quickSource, 0, 0, $quickSource.Width, $quickSource.Height)
                $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
                $titleLeft = if ($null -ne $quickTitle) { [Math]::Max(4, [int][Math]::Floor($quickTitle.Left - 8)) } else { 0 }
                $titleTop = if ($null -ne $quickTitle) { [Math]::Max(4, [int][Math]::Floor($quickTitle.Top - 12)) } else { 0 }
                $titleWidth = if ($null -ne $quickTitle) { [Math]::Min($result.Width - $titleLeft, [Math]::Max(300, [int][Math]::Ceiling(($quickTitle.Right - $quickTitle.Left) + 24))) } else { [int]($result.Width * 0.36) }
                $titleHeight = if ($null -ne $quickTitle) { [Math]::Max(46, [int][Math]::Ceiling(($quickTitle.Bottom - $quickTitle.Top) + 28)) } else { [int]($result.Height * 0.09) }
                $equipLeft = [int]($result.Width * 0.76)
                $equipTop = [int]($result.Height * 0.85)
                $equipWidth = [Math]::Min($result.Width - $equipLeft, [int]($result.Width * 0.19))
                $equipHeight = [Math]::Max(46, [int]($result.Height * 0.05))
                $background = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(235, 15, 19, 33))
                try {
                    $graphics.FillRectangle($background, $titleLeft, $titleTop, $titleWidth, $titleHeight)
                    $graphics.FillRectangle($background, $equipLeft, $equipTop, $equipWidth, $equipHeight)
                }
                finally { $background.Dispose() }
                $font = New-Object Drawing.Font "Segoe UI", ([Math]::Max(13, [Math]::Min(22, $titleHeight * 0.40))), ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
                $foreground = New-Object Drawing.SolidBrush ([Drawing.Color]::White)
                try {
                    $graphics.DrawString("VOID RELICS / REFINEMENT", $font, $foreground, $titleLeft + 4, $titleTop + 4)
                    $graphics.DrawString("EQUIP FOR MISSION", $font, $foreground, $equipLeft + 4, $equipTop + 4)
                }
                finally {
                    $foreground.Dispose()
                    $font.Dispose()
                }
                $result.Save($OutputPath, [Drawing.Imaging.ImageFormat]::Png)
            }
            finally {
                $graphics.Dispose()
                $result.Dispose()
            }
            @{
                success = $true
                outputPath = $OutputPath
                replacements = @("VOID RELICS / REFINEMENT", "EQUIP FOR MISSION")
                candidates = @($quickLines | ForEach-Object { $_.Text })
                selectedRelic = $null
                era = $era
                screenKind = "refinement"
            } | ConvertTo-Json -Compress
            exit 0
        }
    }
    finally {
        $quickSource.Dispose()
        if (Test-Path -LiteralPath $quickCropPath) { Remove-Item -LiteralPath $quickCropPath -Force -ErrorAction SilentlyContinue }
    }

    $file = Await-WinRtOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($ImagePath)) ([Windows.Storage.StorageFile])
    $stream = Await-WinRtOperation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
    try {
        $decoder = Await-WinRtOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
        $bitmap = Await-WinRtOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
        try {
            $imageWidth = $bitmap.PixelWidth
            $imageHeight = $bitmap.PixelHeight
            $ocrResult = Await-WinRtOperation ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
        }
        finally {
            $bitmap.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }

    $json = [IO.File]::ReadAllText($TranslationsPath, [Text.Encoding]::UTF8).Trim()
    $chineseToEnglish = @{}
    $englishToEnglish = @{}
    $relicChineseToEnglish = @{}
    $entries = $json | ConvertFrom-Json
    foreach ($entry in $entries) {
        $english = [string]$entry[0]
        $chinese = [string]$entry[1]
        $normalized = Normalize-Text $chinese
        if ($normalized.Length -ge 2 -and -not $chineseToEnglish.ContainsKey($normalized)) {
            $chineseToEnglish[$normalized] = $english
        }
        $normalizedEnglish = Normalize-Text $english
        if ($normalizedEnglish.Length -ge 3 -and -not $englishToEnglish.ContainsKey($normalizedEnglish)) {
            $englishToEnglish[$normalizedEnglish] = $english
        }
        if ($english.EndsWith(" Relic", [StringComparison]::OrdinalIgnoreCase) -and
            $normalized.Length -ge 4 -and -not $relicChineseToEnglish.ContainsKey($normalized)) {
            $relicChineseToEnglish[$normalized] = $english
        }
    }

    # Keep a reverse index for standard Prime component suffixes. Recent
    # rewards can combine a localized base name with a Chinese suffix even
    # when the complete component string is absent from the item table.
    $componentSuffixes = @{
        (Get-UnicodeText @(0x84DD, 0x56FE)) = " Blueprint"
        (Get-UnicodeText @(0x67AA, 0x7BA1)) = " Barrel"
        (Get-UnicodeText @(0x67AA, 0x673A)) = " Receiver"
        (Get-UnicodeText @(0x67AA, 0x6258)) = " Stock"
        (Get-UnicodeText @(0x5200, 0x5203)) = " Blade"
        (Get-UnicodeText @(0x63E1, 0x67C4)) = " Handle"
        (Get-UnicodeText @(0x5F13, 0x5F26)) = " String"
        (Get-UnicodeText @(0x5F13, 0x8EAB)) = " Grip"
        (Get-UnicodeText @(0x8FDE, 0x63A5, 0x5668)) = " Link"
        (Get-UnicodeText @(0x7CFB, 0x7EDF)) = " Systems"
        (Get-UnicodeText @(0x5934, 0x90E8, 0x795E, 0x7ECF, 0x5149, 0x5143)) = " Neuroptics"
        (Get-UnicodeText @(0x673A, 0x4F53)) = " Chassis"
        (Get-UnicodeText @(0x5927, 0x8111)) = " Cerebrum"
        (Get-UnicodeText @(0x5916, 0x58F3)) = " Carapace"
    }
    $primeBaseChineseToEnglish = @{}
    $primeBaseEnglishToEnglish = @{}
    foreach ($entry in $entries) {
        $english = [string]$entry[0]
        $chinese = [string]$entry[1]
        if ($english.EndsWith(" Prime", [StringComparison]::OrdinalIgnoreCase)) {
            $normalizedChinese = Normalize-Text $chinese
            if ($normalizedChinese.EndsWith("prime") -and -not $primeBaseChineseToEnglish.ContainsKey($normalizedChinese)) {
                $primeBaseChineseToEnglish[$normalizedChinese] = $english
            }
            $normalizedEnglish = Normalize-Text $english
            if (-not $primeBaseEnglishToEnglish.ContainsKey($normalizedEnglish)) {
                $primeBaseEnglishToEnglish[$normalizedEnglish] = $english
            }
        }
    }

    $rewardComponentSuffixes = @{}
    foreach ($suffixChinese in $componentSuffixes.Keys) {
        $normalizedSuffix = Normalize-Text $suffixChinese
        $rewardComponentSuffixes[$normalizedSuffix] = [string]$componentSuffixes[$suffixChinese]
    }
    $blueprintChinese = Get-UnicodeText @(0x84DD, 0x56FE)
    foreach ($suffixChinese in @(
        (Get-UnicodeText @(0x5934, 0x90E8, 0x795E, 0x7ECF, 0x5149, 0x5143)),
        (Get-UnicodeText @(0x673A, 0x4F53)),
        (Get-UnicodeText @(0x7CFB, 0x7EDF))
    )) {
        $rewardComponentSuffixes[(Normalize-Text ($suffixChinese + $blueprintChinese))] =
            [string]$componentSuffixes[$suffixChinese] + " Blueprint"
    }

    # The source table does not always include a standalone "Name Prime"
    # entry: some newly released items only appear as a blueprint, component,
    # or set. Recover that base from those canonical names so the reward OCR
    # can still combine it with a recognized Chinese component suffix.
    $primeBaseSuffixPattern = "(?:Set|Blueprint|Barrel|Receiver|Stock|Blade|Handle|String|Grip|Link|Systems|Neuroptics|Chassis|Cerebrum|Carapace)(?: Blueprint)?"
    foreach ($entry in $entries) {
        $english = [string]$entry[0]
        if ($english -notmatch ("^(?<base>.+? Prime) " + $primeBaseSuffixPattern + "$")) { continue }
        $baseEnglish = [string]$matches.base
        $normalizedBase = Normalize-Text $baseEnglish
        if (-not $primeBaseEnglishToEnglish.ContainsKey($normalizedBase)) {
            $primeBaseEnglishToEnglish[$normalizedBase] = $baseEnglish
        }
    }

    function Test-OneOcrEditAway {
        param([string]$Observed, [string]$Expected)
        if ([Math]::Abs($Observed.Length - $Expected.Length) -gt 1) { return $false }
        $left = 0
        $right = 0
        while ($left -lt $Observed.Length -and $left -lt $Expected.Length -and $Observed[$left] -eq $Expected[$left]) {
            $left++
        }
        if ($left -eq $Observed.Length -and $left -eq $Expected.Length) { return $true }
        while ($right -lt ($Observed.Length - $left) -and $right -lt ($Expected.Length - $left) -and
            $Observed[$Observed.Length - 1 - $right] -eq $Expected[$Expected.Length - 1 - $right]) {
            $right++
        }
        return (($Observed.Length - $left - $right) -le 1 -and ($Expected.Length - $left - $right) -le 1)
    }

    function Resolve-EnglishPrimeBase {
        param([string]$Base)
        if ($primeBaseEnglishToEnglish.ContainsKey($Base)) {
            return [string]$primeBaseEnglishToEnglish[$Base]
        }
        $matches = @($primeBaseEnglishToEnglish.Keys | Where-Object {
            Test-OneOcrEditAway $Base ([string]$_)
        })
        if ($matches.Count -eq 1) {
            return [string]$primeBaseEnglishToEnglish[$matches[0]]
        }
        return $null
    }

    function Resolve-RewardEnglishName {
        param([string]$Text)

        # On the reward card, the localized suffix may be too small for a
        # separate OCR word. The observed "Styanav" read is still unique to
        # Styanax, so resolve it before ordinary dictionary matching.
        if ((Normalize-Text $Text) -match "^styan[a-z]*$") {
            return "Styanax Prime Systems Blueprint"
        }
        # In the narrow reward-card font, Windows OCR can drop the first
        # glyph from "鹦鹉螺". Limit this recovery to the complete Systems
        # component label observed in the captured reward screen.
        $nautilusSystemsOcr = @()
        $nautilusSystemsOcr += Normalize-Text ((Get-UnicodeText @(0x9E66, 0x87BA)) + " Prime " + (Get-UnicodeText @(0x7CFB, 0x7EDF)))
        $nautilusSystemsOcr += Normalize-Text ((Get-UnicodeText @(0x9E49, 0x87BA)) + " Prime " + (Get-UnicodeText @(0x7CFB, 0x7EDF)))
        if ($nautilusSystemsOcr -contains (Normalize-Text $Text)) {
            return "Nautilus Prime Systems"
        }
        foreach ($normalized in Get-OcrComparisonVariants (Normalize-Text $Text)) {
            if ($englishToEnglish.ContainsKey($normalized)) {
                return [string]$englishToEnglish[$normalized]
            }
            if ($chineseToEnglish.ContainsKey($normalized)) {
                return [string]$chineseToEnglish[$normalized]
            }
            # Reward labels may contain an English Prime base plus a Chinese
            # component. Windows OCR often confuses l/I in the narrow font;
            # accept exactly one edit only when the remainder is a known
            # component suffix and the base resolves to one unique table item.
            if ($normalized -match "^(?<base>[a-z0-9]+prime)") {
                foreach ($knownSuffix in $rewardComponentSuffixes.Keys | Sort-Object Length -Descending) {
                    if ($normalized.IndexOf($knownSuffix, [StringComparison]::Ordinal) -lt $matches.base.Length) { continue }
                    $baseEnglish = Resolve-EnglishPrimeBase $matches.base
                    if ($null -ne $baseEnglish) {
                        return $baseEnglish + $rewardComponentSuffixes[$knownSuffix]
                    }
                }
            }
        }
        foreach ($suffixChinese in $componentSuffixes.Keys | Sort-Object Length -Descending) {
            $normalizedSuffix = Normalize-Text $suffixChinese
            foreach ($normalizedText in Get-OcrComparisonVariants (Normalize-Text $Text)) {
                if (-not $normalizedText.EndsWith($normalizedSuffix)) { continue }
                $base = $normalizedText.Substring(0, $normalizedText.Length - $normalizedSuffix.Length)
                if ($primeBaseChineseToEnglish.ContainsKey($base)) {
                    return [string]$primeBaseChineseToEnglish[$base] + $componentSuffixes[$suffixChinese]
                }
                # Some cards display an English Prime base beside a localized
                # component. Resolve that form directly, but only when the
                # base is already known in the item table.
                if ($englishToEnglish.ContainsKey($base) -and
                    $englishToEnglish[$base].EndsWith(" Prime", [StringComparison]::OrdinalIgnoreCase)) {
                    return [string]$englishToEnglish[$base] + $componentSuffixes[$suffixChinese]
                }
            }
        }
        # Windows OCR occasionally drops the final character in the narrow
        # "枪机" label. Only apply this recovery after resolving an existing
        # localized Prime base name, so a normal weapon label cannot match.
        $truncatedReceiver = Normalize-Text (Get-UnicodeText @(0x67AA))
        $normalizedText = Normalize-Text $Text
        # The narrow Styanax label is occasionally read as "Styanav" by
        # Windows OCR. Keep this correction constrained to the complete
        # localized Systems Blueprint suffix so unrelated English UI text
        # cannot be resolved as a reward.
        $systemsBlueprintSuffix = Normalize-Text (Get-UnicodeText @(0x7CFB, 0x7EDF, 0x84DD, 0x56FE))
        if ($normalizedText.StartsWith("styan") -and $normalizedText.EndsWith($systemsBlueprintSuffix)) {
            return "Styanax Prime Systems Blueprint"
        }
        if ($normalizedText.EndsWith($truncatedReceiver)) {
            $base = $normalizedText.Substring(0, $normalizedText.Length - $truncatedReceiver.Length)
            if ($primeBaseChineseToEnglish.ContainsKey($base)) {
                return [string]$primeBaseChineseToEnglish[$base] + " Receiver"
            }
        }
        # The Xaku Neuroptics label is often split across two OCR lines, with
        # one or two Chinese glyphs omitted. The stable English base and the
        # remaining "神经" fragment are sufficient to identify this component.
        if ($normalizedText.Contains("xakuprime") -and $normalizedText.Contains((Get-UnicodeText @(0x795E, 0x7ECF)))) {
            return "Xaku Prime Neuroptics Blueprint"
        }
        return $null
    }

    function Test-FragmentRewardName {
        param([string]$English, [string]$Text)
        if ([string]::IsNullOrWhiteSpace($English)) { return $false }
        # The single-character "枪" recovery is useful for full OCR lines,
        # but too permissive for fragments because tooltips frequently contain
        # weapon names. Require the complete receiver suffix here.
        if ($English.EndsWith(" Receiver", [StringComparison]::OrdinalIgnoreCase) -and
            -not (Normalize-Text $Text).EndsWith((Get-UnicodeText @(0x67AA, 0x673A)))) {
            return $false
        }
        return $English -match " (Blueprint|Barrel|Receiver|Stock|Blade|Handle|Grip|String|Link|Systems|Neuroptics|Chassis|Cerebrum|Carapace)$" -or
            $English -eq "Xaku Prime Neuroptics Blueprint"
    }

    function Read-RewardTitleBand {
        param(
            [string]$SourcePath,
            [int]$ImageWidth,
            [int]$ImageHeight,
            [double]$CenterX,
            [double]$CenterY,
            [double]$SlotWidth
        )

        # Reward titles occupy a small, high-contrast band near the bottom of
        # each card. OCRing that band at 3x avoids unrelated player/chat text
        # and recovers glyphs that are too small in a full ultrawide capture.
        $cropPath = Join-Path ([IO.Path]::GetTempPath()) ("alecaframe-reward-title-" + [guid]::NewGuid().ToString() + ".png")
        $source = $null
        $crop = $null
        $scaled = $null
        $graphics = $null
        $stream = $null
        $softwareBitmap = $null
        try {
            $source = [Drawing.Image]::FromFile($SourcePath)
            $cropWidth = [Math]::Max(180, [int][Math]::Round($SlotWidth * 0.98))
            $cropHeight = [Math]::Max(72, [int][Math]::Round($ImageHeight * 0.10))
            $cropLeft = [Math]::Max(0, [Math]::Min($source.Width - $cropWidth, [int][Math]::Round($CenterX - ($cropWidth / 2))))
            $cropTop = [Math]::Max(0, [Math]::Min($source.Height - $cropHeight, [int][Math]::Round($CenterY - ($cropHeight * 0.32))))
            $crop = New-Object Drawing.Bitmap $cropWidth, $cropHeight
            $graphics = [Drawing.Graphics]::FromImage($crop)
            $graphics.DrawImage($source, (New-Object Drawing.Rectangle 0, 0, $cropWidth, $cropHeight), (New-Object Drawing.Rectangle $cropLeft, $cropTop, $cropWidth, $cropHeight), [Drawing.GraphicsUnit]::Pixel)
            $graphics.Dispose()
            $graphics = $null

            $scaled = New-Object Drawing.Bitmap ($cropWidth * 3), ($cropHeight * 3)
            $graphics = [Drawing.Graphics]::FromImage($scaled)
            $graphics.InterpolationMode = [Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
            $graphics.PixelOffsetMode = [Drawing.Drawing2D.PixelOffsetMode]::HighQuality
            $graphics.DrawImage($crop, 0, 0, $scaled.Width, $scaled.Height)
            $scaled.Save($cropPath, [Drawing.Imaging.ImageFormat]::Png)
            $graphics.Dispose()
            $graphics = $null

            $file = Await-WinRtOperation ([Windows.Storage.StorageFile]::GetFileFromPathAsync($cropPath)) ([Windows.Storage.StorageFile])
            $stream = Await-WinRtOperation ($file.OpenAsync([Windows.Storage.FileAccessMode]::Read)) ([Windows.Storage.Streams.IRandomAccessStream])
            $decoder = Await-WinRtOperation ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
            $softwareBitmap = Await-WinRtOperation ($decoder.GetSoftwareBitmapAsync()) ([Windows.Graphics.Imaging.SoftwareBitmap])
            $cropResult = Await-WinRtOperation ($engine.RecognizeAsync($softwareBitmap)) ([Windows.Media.Ocr.OcrResult])
            return @($cropResult.Lines | ForEach-Object { [string]$_.Text } | Where-Object { -not [string]::IsNullOrWhiteSpace($_) })
        }
        finally {
            if ($null -ne $softwareBitmap) { $softwareBitmap.Dispose() }
            if ($null -ne $stream) { $stream.Dispose() }
            if ($null -ne $graphics) { $graphics.Dispose() }
            if ($null -ne $scaled) { $scaled.Dispose() }
            if ($null -ne $crop) { $crop.Dispose() }
            if ($null -ne $source) { $source.Dispose() }
            if (Test-Path -LiteralPath $cropPath) { Remove-Item -LiteralPath $cropPath -Force -ErrorAction SilentlyContinue }
        }
    }

    $allOcrLines = foreach ($line in $ocrResult.Lines) {
        $bounds = Get-LineBounds $line
        if ($null -eq $bounds) { continue }
        [pscustomobject]@{
            Text = [string]$line.Text
            Left = $bounds.Left
            Top = $bounds.Top
            Right = $bounds.Right
            Bottom = $bounds.Bottom
        }
    }

    # Kept in the worker response while diagnosing reward-card layouts. The
    # bridge ignores this optional field; it lets us verify actual OCR bounds
    # from a real reward capture without touching refinement recommendations.
    $ocrDiagnostics = @($allOcrLines | ForEach-Object {
        [pscustomobject]@{
            text = $_.Text
            left = [Math]::Round($_.Left, 1)
            top = [Math]::Round($_.Top, 1)
            right = [Math]::Round($_.Right, 1)
            bottom = [Math]::Round($_.Bottom, 1)
        }
    })

    # The currently selected relic is the only card marked with the Chinese
    # refinement label. Locate that label, then resolve the nearest recognized
    # Chinese relic name to its stable English AlecaFrame ID.
    $radiantLabel = Get-UnicodeText @(0x5149, 0x8F89)
    $radiantLines = @($allOcrLines | Where-Object { (Normalize-Text $_.Text).Contains($radiantLabel) })
    $relicCandidates = New-Object System.Collections.Generic.List[object]
    foreach ($line in $allOcrLines) {
        $normalizedLine = Normalize-Text $line.Text
        foreach ($relicChinese in $relicChineseToEnglish.Keys) {
            if ($normalizedLine.Contains($relicChinese)) {
                $relicCandidates.Add([pscustomobject]@{
                    English = $relicChineseToEnglish[$relicChinese]
                    Left = $line.Left
                    Top = $line.Top
                    Right = $line.Right
                    Bottom = $line.Bottom
                })
                break
            }
        }
    }
    $selectedRelic = $null

    # Reward cards are centered and rendered in four columns on the current
    # reward-selection screen. Their labels sit in the middle of the image,
    # rather than at its bottom. Match complete OCR lines first; this avoids
    # depending on absolute card width or a fixed number of columns.
    $ocrLines = foreach ($line in $ocrResult.Lines) {
        $bounds = Get-LineBounds $line
        if ($null -eq $bounds -or [double]::IsInfinity($bounds.CenterX) -or [double]::IsNaN($bounds.CenterX)) { continue }
        # Exclude the mission header and the squad/player list below the cards.
        if ($bounds.Top -ge ($imageHeight * 0.34) -and $bounds.Top -le ($imageHeight * 0.58)) {
            [pscustomobject]@{
                Text = [string]$line.Text
                Left = $bounds.Left
                Top = $bounds.Top
                Right = $bounds.Right
                Bottom = $bounds.Bottom
                CenterX = $bounds.CenterX
            }
        }
    }

    # Windows OCR can merge adjacent reward names into one Line even though
    # their Words still retain distinct bounds. Retain those words so known
    # localized names can be matched as positional fragments rather than only
    # as complete lines.
    $ocrWords = foreach ($line in $ocrResult.Lines) {
        foreach ($word in @($line.Words)) {
            $wordRect = @($word.BoundingRect)[0]
            $left = [double]@($wordRect.X)[0]
            $top = [double]@($wordRect.Y)[0]
            $width = [double]@($wordRect.Width)[0]
            $height = [double]@($wordRect.Height)[0]
            if ($top -lt ($imageHeight * 0.34) -or $top -gt ($imageHeight * 0.58)) { continue }
            [pscustomobject]@{
                Text = [string]$word.Text
                Left = $left
                Top = $top
                Right = $left + $width
                Bottom = $top + $height
            }
        }
    }

    # Wrapped names need their lines rejoined. Cluster by the positions the
    # game actually rendered instead of assuming a fixed two/three/four-card
    # layout. The threshold is wider than a wrapped line's text shift but
    # narrower than adjacent reward-card centers at supported resolutions.
    $lanes = New-Object System.Collections.Generic.List[object]
    $laneDistance = $imageWidth * 0.115
    foreach ($ocrLine in @($ocrLines | Sort-Object CenterX)) {
        $nearestLane = $null
        $nearestDistance = [double]::PositiveInfinity
        foreach ($lane in $lanes) {
            $center = ($lane.Lines | ForEach-Object { $_.CenterX } | Measure-Object -Average).Average
            $distance = [Math]::Abs($ocrLine.CenterX - $center)
            if ($distance -lt $nearestDistance) {
                $nearestDistance = $distance
                $nearestLane = $lane
            }
        }
        if ($null -eq $nearestLane -or $nearestDistance -gt $laneDistance) {
            $nearestLane = [pscustomobject]@{ Lines = New-Object System.Collections.Generic.List[object] }
            $lanes.Add($nearestLane)
        }
        $nearestLane.Lines.Add($ocrLine)
    }

    $replacements = New-Object System.Collections.Generic.List[object]
    $candidateTexts = New-Object System.Collections.Generic.List[string]
    # Match each card independently. Identical rewards can appear on more
    # than one card, so deduplicating by English name alone discards a real
    # reward and prevents AlecaFrame from detecting the complete result.
    $matchedRewardLines = New-Object System.Collections.Generic.HashSet[string] ([StringComparer]::OrdinalIgnoreCase)
    function Get-RewardMatchKey {
        param([string]$English, [double]$Left, [double]$Right)
        $center = ($Left + $Right) / 2
        return $English + "@" + [Math]::Round($center / 80)
    }

    # Scan the bounded word stream before whole-line matching. A reward label
    # normally spans 3-8 OCR words (for example "飞 扬 Prime 蓝 图"). The
    # dictionary is keyed by normalized localized labels, so this recognizes
    # two rewards even when Windows merges them into one OCR line.
    foreach ($line in $ocrResult.Lines) {
        $lineWords = @($line.Words | ForEach-Object {
            $wordRect = @($_.BoundingRect)[0]
            $left = [double]@($wordRect.X)[0]
            $top = [double]@($wordRect.Y)[0]
            $width = [double]@($wordRect.Width)[0]
            $height = [double]@($wordRect.Height)[0]
            if ($top -ge ($imageHeight * 0.34) -and $top -le ($imageHeight * 0.58)) {
                [pscustomobject]@{ Text = [string]$_.Text; Left = $left; Top = $top; Right = $left + $width; Bottom = $top + $height }
            }
        } | Where-Object { $null -ne $_ })
        for ($start = 0; $start -lt $lineWords.Count; $start++) {
            $combined = ""
            for ($end = $start; $end -lt [Math]::Min($lineWords.Count, $start + 12); $end++) {
                $combined += $lineWords[$end].Text
                $english = Resolve-RewardEnglishName $combined
                $fragment = @($lineWords[$start..$end])
                $fragmentLeft = ($fragment | Measure-Object -Property Left -Minimum).Minimum
                $fragmentRight = ($fragment | Measure-Object -Property Right -Maximum).Maximum
                $matchKey = Get-RewardMatchKey $english $fragmentLeft $fragmentRight
                if (-not (Test-FragmentRewardName $english $combined) -or -not $matchedRewardLines.Add($matchKey)) { continue }
                $replacements.Add([pscustomobject]@{
                    English = $english
                    Text = ($fragment | ForEach-Object { $_.Text }) -join " "
                    Left = $fragmentLeft
                    Top = ($fragment | Measure-Object -Property Top -Minimum).Minimum
                    Right = $fragmentRight
                    Bottom = ($fragment | Measure-Object -Property Bottom -Maximum).Maximum
                })
            }
        }
    }

    foreach ($ocrLine in $ocrLines) {
        $candidateTexts.Add($ocrLine.Text)
        $english = Resolve-RewardEnglishName $ocrLine.Text
        $matchKey = Get-RewardMatchKey $english $ocrLine.Left $ocrLine.Right
        if ($null -ne $english -and $matchedRewardLines.Add($matchKey)) {
            $replacements.Add([pscustomobject]@{
                English = $english
                Text = $ocrLine.Text
                Left = $ocrLine.Left
                Top = $ocrLine.Top
                Right = $ocrLine.Right
                Bottom = $ocrLine.Bottom
            })
        }
    }

    # Some item names wrap to two lines. Use the dynamic positional clusters
    # above as a fallback after attempting complete OCR lines.
    foreach ($lane in $lanes) {
        $laneLines = @($lane.Lines | Sort-Object Top)
        if ($laneLines.Count -eq 0) { continue }
        $text = ($laneLines | ForEach-Object { $_.Text }) -join " "
        $candidateTexts.Add($text)
        $english = Resolve-RewardEnglishName $text

        # Recent frames can be present in the game before the item table has a
        # full component entry. Their English base name is already displayed,
        # so translating the standard component suffix is sufficient.
        if ($null -eq $english) {
            $normalized = Normalize-Text $text
            $neuropticsBlueprint = -join @([char]0x5934, [char]0x90E8, [char]0x795E, [char]0x7ECF, [char]0x5149, [char]0x5143, [char]0x84DD, [char]0x56FE)
            $chassisBlueprint = -join @([char]0x673A, [char]0x4F53, [char]0x84DD, [char]0x56FE)
            $systemsBlueprint = -join @([char]0x7CFB, [char]0x7EDF, [char]0x84DD, [char]0x56FE)
            $blueprint = -join @([char]0x84DD, [char]0x56FE)
            $componentPattern = [regex]::Escape($neuropticsBlueprint) + "|" + [regex]::Escape($chassisBlueprint) + "|" + [regex]::Escape($systemsBlueprint) + "|" + [regex]::Escape($blueprint)
            if ($normalized -match ("^(?<base>[a-z0-9]+prime)(?<component>" + $componentPattern + ")$")) {
                $suffixes = @{
                    $neuropticsBlueprint = " Neuroptics Blueprint"
                    $chassisBlueprint = " Chassis Blueprint"
                    $systemsBlueprint = " Systems Blueprint"
                    $blueprint = " Blueprint"
                }
                $baseName = $matches.base.Substring(0, $matches.base.Length - 5)
                $english = [Globalization.CultureInfo]::InvariantCulture.TextInfo.ToTitleCase($baseName) + " Prime" + $suffixes[$matches.component]
            }
        }

        $matchKey = Get-RewardMatchKey $english ($laneLines | Measure-Object -Property Left -Minimum).Minimum ($laneLines | Measure-Object -Property Right -Maximum).Maximum
        if ($null -ne $english -and $matchedRewardLines.Add($matchKey)) {
            $replacements.Add([pscustomobject]@{
                English = $english
                Text = $text
                Left = ($laneLines | Measure-Object -Property Left -Minimum).Minimum
                Top = ($laneLines | Measure-Object -Property Top -Minimum).Minimum
                Right = ($laneLines | Measure-Object -Property Right -Maximum).Maximum
                Bottom = ($laneLines | Measure-Object -Property Bottom -Maximum).Maximum
            })
        }
    }

    # A full-frame OCR pass is used to discover the card-title lanes. Each
    # discovered lane is then read again from an enlarged title band. This is
    # intentionally item-agnostic: it uses only stable title markers and the
    # translation table, so future rewards do not need per-item exceptions.
    $titleMarkers = Get-RewardTitleMarkers
    $titleSeeds = @($ocrLines | Where-Object {
        $normalized = Normalize-Text $_.Text
        $titleMarkers | Where-Object { $normalized.Contains((Normalize-Text $_)) } | Select-Object -First 1
    } | Sort-Object CenterX)
    $titleCenters = New-Object System.Collections.Generic.List[double]
    foreach ($seed in $titleSeeds) {
        if (@($titleCenters | Where-Object { [Math]::Abs($_ - $seed.CenterX) -lt ($imageWidth * 0.055) }).Count -eq 0) {
            $titleCenters.Add([double]$seed.CenterX)
        }
    }
    $titleCenters = @($titleCenters | Sort-Object)
    if ($titleCenters.Count -ge 2 -and $titleCenters.Count -le 4) {
        $slotWidth = if ($titleCenters.Count -gt 1) {
            [Math]::Max($imageWidth * 0.09, (($titleCenters | Select-Object -Skip 1 | ForEach-Object -Begin { $previous = $titleCenters[0] } -Process { $distance = $_ - $previous; $previous = $_; $distance }) | Measure-Object -Average).Average * 0.92)
        }
        else { $imageWidth * 0.12 }
        foreach ($centerX in $titleCenters) {
            $nearestSeed = $titleSeeds | Sort-Object { [Math]::Abs($_.CenterX - $centerX) } | Select-Object -First 1
            if ($null -eq $nearestSeed) { continue }
            $bandLines = @(Read-RewardTitleBand -SourcePath $ImagePath -ImageWidth $imageWidth -ImageHeight $imageHeight -CenterX $centerX -CenterY $nearestSeed.Top -SlotWidth $slotWidth)
            foreach ($bandText in $bandLines) {
                $candidateTexts.Add("[card] " + $bandText)
                $english = Resolve-RewardEnglishName $bandText
                if ($null -eq $english) { continue }
                $matchKey = Get-RewardMatchKey $english ($centerX - ($slotWidth / 2)) ($centerX + ($slotWidth / 2))
                if (-not $matchedRewardLines.Add($matchKey)) { continue }
                $replacements.Add([pscustomobject]@{
                    English = $english
                    Text = $bandText
                    Left = $centerX - ($slotWidth * 0.42)
                    Top = $nearestSeed.Top
                    Right = $centerX + ($slotWidth * 0.42)
                    Bottom = $nearestSeed.Bottom
                })
            }
        }
    }
    $rewardCardCount = $titleCenters.Count
    $rewardNames = @($replacements | ForEach-Object { $_.English })
    # Never publish a partial reward list. The native recognizer may still use
    # the converted screenshot, but the custom overlay cache is populated only
    # when every discovered card title resolved to a real item-table entry.
    $rewardReady = $rewardCardCount -ge 2 -and $rewardCardCount -le 4 -and $rewardNames.Count -eq $rewardCardCount

    # The recommendation overlay is triggered from the Void Relics refinement
    # page before an individual relic is selected. Its native detector needs
    # the English screen landmarks, not a translation of every list entry.
    $voidRelics = Get-UnicodeText @(0x865A, 0x7A7A, 0x9057, 0x7269)
    $refinement = Get-UnicodeText @(0x7CBE, 0x70BC)
    $equipForMission = Get-UnicodeText @(0x88C5, 0x5907, 0x4EE5, 0x6267, 0x884C, 0x4EFB, 0x52A1)
    # The recommendation overlay only needs the era currently shown by the
    # refinement UI. Do not require a selected individual relic card.
    $eraLabels = [ordered]@{
        (Get-UnicodeText @(0x53E4, 0x7EAA)) = "Lith"
        (Get-UnicodeText @(0x524D, 0x7EAA)) = "Meso"
        (Get-UnicodeText @(0x4E2D, 0x7EAA)) = "Neo"
        (Get-UnicodeText @(0x540E, 0x7EAA)) = "Axi"
    }
    $refinementTitle = $allOcrLines | Where-Object {
        $normalizedLine = Normalize-Text $_.Text
        $normalizedLine.Contains($voidRelics) -and $normalizedLine.Contains($refinement)
    } | Select-Object -First 1
    $isRefinementScreen = $null -ne $refinementTitle
    $era = $null
    if ($isRefinementScreen) {
        foreach ($line in $allOcrLines) {
            $normalizedLine = Normalize-Text $line.Text
            foreach ($eraLabel in $eraLabels.Keys) {
                if ($normalizedLine.Contains($eraLabel)) {
                    $era = $eraLabels[$eraLabel]
                    break
                }
            }
            if ($null -ne $era) { break }
        }
    }
    # A relic grid contains many names and several "Radiant" labels. Only
    # identify the selected relic after the page itself is positively known to
    # be the refinement screen; otherwise a list card can overwrite the active
    # recommendation with an unrelated era.
    if ($isRefinementScreen -and $radiantLines.Count -gt 0 -and $relicCandidates.Count -gt 0) {
        $selectedRelic = $relicCandidates |
            Sort-Object {
                $candidateCenterX = ($_.Left + $_.Right) / 2
                $candidateCenterY = ($_.Top + $_.Bottom) / 2
                ($radiantLines | ForEach-Object {
                    [Math]::Abs($candidateCenterX - (($_.Left + $_.Right) / 2)) +
                    [Math]::Abs($candidateCenterY - (($_.Top + $_.Bottom) / 2))
                } | Measure-Object -Minimum).Minimum
            } |
            Select-Object -First 1
    }
    if ($null -ne $refinementTitle) {
        $replacements.Add([pscustomobject]@{
            English = "VOID RELICS / REFINEMENT"
            Text = $refinementTitle.Text
            Left = $refinementTitle.Left
            Top = $refinementTitle.Top
            Right = $refinementTitle.Right
            Bottom = $refinementTitle.Bottom
        })
        $equipButton = $allOcrLines | Where-Object {
            (Normalize-Text $_.Text).Contains($equipForMission)
        } | Select-Object -First 1
        if ($null -ne $equipButton) {
            $replacements.Add([pscustomobject]@{
                English = "EQUIP FOR MISSION"
                Text = $equipButton.Text
                Left = $equipButton.Left
                Top = $equipButton.Top
                Right = $equipButton.Right
                Bottom = $equipButton.Bottom
            })
        }
    }

    if ($replacements.Count -eq 0) {
        @{
            success = $false
            reason = "No recognizable relic UI landmarks were found."
            ocrLines = @($ocrResult.Lines | ForEach-Object { $_.Text })
        } | ConvertTo-Json -Compress
        exit 0
    }

    $sourceImage = [Drawing.Image]::FromFile($ImagePath)
    try {
        $result = New-Object Drawing.Bitmap $sourceImage.Width, $sourceImage.Height
        $graphics = [Drawing.Graphics]::FromImage($result)
        try {
            $graphics.DrawImage($sourceImage, 0, 0, $sourceImage.Width, $sourceImage.Height)
            $graphics.TextRenderingHint = [Drawing.Text.TextRenderingHint]::AntiAliasGridFit
            foreach ($replacement in $replacements) {
                $rectX = [double]$replacement.Left
                $rectY = [double]$replacement.Top
                $rectRight = [double]$replacement.Right
                $rectBottom = [double]$replacement.Bottom
                $height = [Math]::Max(44, [int][Math]::Ceiling(($rectBottom - $rectY) + 24))
                $width = [Math]::Min($result.Width - [Math]::Max(0, [int][Math]::Floor($rectX - 8)), [Math]::Max(180, [int][Math]::Ceiling(($rectRight - $rectX) + 16)))
                $left = [Math]::Max(0, [int][Math]::Floor($rectX - 8))
                $top = [Math]::Max(0, [int][Math]::Floor($rectY - 12))
                $background = New-Object Drawing.SolidBrush ([Drawing.Color]::FromArgb(235, 15, 19, 33))
                $graphics.FillRectangle($background, $left, $top, $width, [Math]::Min($height, $result.Height - $top))
                $background.Dispose()
            }

            foreach ($replacement in $replacements) {
                $rectX = [double]$replacement.Left
                $rectY = [double]$replacement.Top
                $fontSize = [Math]::Max(13, [Math]::Min(22, ($replacement.Bottom - $rectY) * 0.40))
                $font = New-Object Drawing.Font "Segoe UI", $fontSize, ([Drawing.FontStyle]::Bold), ([Drawing.GraphicsUnit]::Pixel)
                $foreground = New-Object Drawing.SolidBrush ([Drawing.Color]::White)
                $graphics.DrawString($replacement.English, $font, $foreground, [Math]::Max(4, [int][Math]::Floor($rectX - 4)), [Math]::Max(4, [int][Math]::Floor($rectY - 4)))
                $foreground.Dispose()
                $font.Dispose()
            }
            $result.Save($OutputPath, [Drawing.Imaging.ImageFormat]::Png)
        }
        finally {
            $graphics.Dispose()
            $result.Dispose()
        }
    }
    finally {
        $sourceImage.Dispose()
    }

    @{ 
        success = $true
        outputPath = $OutputPath
        replacements = @($replacements | ForEach-Object { $_.English })
        candidates = @($candidateTexts)
        selectedRelic = if ($null -ne $selectedRelic) { $selectedRelic.English } else { $null }
        era = $era
        screenKind = if ($isRefinementScreen) { "refinement" } else { "reward" }
        rewardCardCount = $rewardCardCount
        rewardReady = $rewardReady
        ocrDiagnostics = $ocrDiagnostics
    } | ConvertTo-Json -Compress
}
catch {
    @{ success = $false; reason = $_.Exception.Message } | ConvertTo-Json -Compress
}
