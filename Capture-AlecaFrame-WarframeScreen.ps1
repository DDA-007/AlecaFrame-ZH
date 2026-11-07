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
    [StructLayout(LayoutKind.Sequential)]
    struct Rect { public int Left, Top, Right, Bottom; }
    [StructLayout(LayoutKind.Sequential)]
    struct Point { public int X, Y; }

    [DllImport("user32.dll")]
    static extern IntPtr SetThreadDpiAwarenessContext(IntPtr context);
    [DllImport("user32.dll")]
    static extern bool GetClientRect(IntPtr window, out Rect rect);
    [DllImport("user32.dll")]
    static extern bool ClientToScreen(IntPtr window, ref Point point);
    [DllImport("user32.dll")]
    public static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll")]
    public static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    public static bool CaptureWarframe(string path) {
        IntPtr window = GetForegroundWindow();
        if (window == IntPtr.Zero) return false;
        uint processId;
        GetWindowThreadProcessId(window, out processId);
        try {
            using (var process = System.Diagnostics.Process.GetProcessById((int)processId))
                if (process.ProcessName != "Warframe.x64") return false;
        } catch (ArgumentException) { return false; }

        IntPtr previousDpiContext = SetThreadDpiAwarenessContext(new IntPtr(-4));
        if (previousDpiContext == IntPtr.Zero) return false;
        try {
            Rect rect;
            Point origin = new Point();
            if (!GetClientRect(window, out rect) || !ClientToScreen(window, ref origin)) return false;
            var bounds = new Rectangle(origin.X, origin.Y, rect.Right, rect.Bottom);
            if (bounds.Width <= 0 || bounds.Height <= 0 ||
                !Screen.FromHandle(window).Bounds.Contains(bounds) || GetForegroundWindow() != window) return false;

            using (var bitmap = new Bitmap(bounds.Width, bounds.Height))
            using (var graphics = Graphics.FromImage(bitmap)) {
                graphics.CopyFromScreen(bounds.Left, bounds.Top, 0, 0, bounds.Size, CopyPixelOperation.SourceCopy);
                if (GetForegroundWindow() != window) return false;
                bitmap.Save(path, System.Drawing.Imaging.ImageFormat.Png);
                return true;
            }
        } finally { SetThreadDpiAwarenessContext(previousDpiContext); }
    }
}
'@

if (-not [AlecaFrameForegroundCapture]::CaptureWarframe($OutputPath)) {
    @{ success = $false; reason = "Warframe's game window is not fully visible in the foreground." } |
        ConvertTo-Json -Compress
    exit 0
}
@{ success = $true; path = $OutputPath } | ConvertTo-Json -Compress
