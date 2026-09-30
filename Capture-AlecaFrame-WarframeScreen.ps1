param(
    [Parameter(Mandatory = $true)][string]$OutputPath
)

$ErrorActionPreference = "Stop"

Add-Type -AssemblyName System.Drawing
Add-Type -AssemblyName System.Windows.Forms

Add-Type -ReferencedAssemblies @("System.Drawing.dll", "System.Windows.Forms.dll") @'
using System;
using System.Drawing;
using System.Runtime.InteropServices;
using System.Windows.Forms;

public static class AlecaFrameForegroundCapture {
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public static string GetForegroundProcessName() {
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero) return "";
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        try { return System.Diagnostics.Process.GetProcessById((int)processId).ProcessName; }
        catch { return ""; }
    }

    public static void CapturePrimaryScreen(string path) {
        var bounds = Screen.PrimaryScreen.Bounds;
        using (var bitmap = new Bitmap(bounds.Width, bounds.Height))
        using (var graphics = Graphics.FromImage(bitmap)) {
            graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
            bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
        }
    }
}
'@

$processName = [AlecaFrameForegroundCapture]::GetForegroundProcessName()
if ($processName -ne "Warframe.x64") {
    @{ success = $false; reason = "Warframe is not the foreground window ($processName)." } |
        ConvertTo-Json -Compress
    exit 0
}

[AlecaFrameForegroundCapture]::CapturePrimaryScreen($OutputPath)
@{ success = $true; path = $OutputPath } | ConvertTo-Json -Compress
