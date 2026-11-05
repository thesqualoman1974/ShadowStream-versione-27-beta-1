namespace ShadowStream;

internal static class NativeDisplay
{
    private const uint MonitorInfoPrimary = 1;

    public static CaptureRegion GetPrimaryBounds()
    {
        CaptureRegion found = default;
        EnumDisplayMonitors(IntPtr.Zero, IntPtr.Zero, (hMonitor, _, _, _) =>
        {
            var info = new MonitorInfo { cbSize = Marshal.SizeOf<MonitorInfo>() };
            if (!GetMonitorInfo(hMonitor, ref info))
            {
                return true;
            }

            if ((info.dwFlags & MonitorInfoPrimary) == 0)
            {
                return true;
            }

            found = new CaptureRegion(
                info.rcMonitor.Left,
                info.rcMonitor.Top,
                info.rcMonitor.Right - info.rcMonitor.Left,
                info.rcMonitor.Bottom - info.rcMonitor.Top);
            return false;
        }, IntPtr.Zero);

        if (found.Width > 0)
        {
            return found;
        }

        return new CaptureRegion(0, 0, GetSystemMetrics(0), GetSystemMetrics(1));
    }

    private delegate bool MonitorEnumProc(IntPtr hMonitor, IntPtr hdc, IntPtr lprcMonitor, IntPtr dwData);

    [DllImport("user32.dll")]
    private static extern bool EnumDisplayMonitors(IntPtr hdc, IntPtr lprcClip, MonitorEnumProc lpfnEnum, IntPtr dwData);

    [DllImport("user32.dll", CharSet = CharSet.Unicode, EntryPoint = "GetMonitorInfoW")]
    private static extern bool GetMonitorInfo(IntPtr hMonitor, ref MonitorInfo lpmi);

    [DllImport("user32.dll")]
    private static extern int GetSystemMetrics(int nIndex);

    [StructLayout(LayoutKind.Sequential)]
    private struct Rect
    {
        public int Left;
        public int Top;
        public int Right;
        public int Bottom;
    }

    [StructLayout(LayoutKind.Sequential)]
    private struct MonitorInfo
    {
        public int cbSize;
        public Rect rcMonitor;
        public Rect rcWork;
        public uint dwFlags;
    }
}

/// <summary>
/// Enumera le finestre visibili con titolo non vuoto per la selezione della sorgente di cattura.
/// </summary>

internal static class WindowEnumerator
{
    private delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

    [DllImport("user32.dll")]
    private static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetWindowText(IntPtr hWnd, System.Text.StringBuilder lpString, int nMaxCount);

    [DllImport("user32.dll")]
    private static extern bool IsWindowVisible(IntPtr hWnd);

    [DllImport("user32.dll", CharSet = CharSet.Unicode)]
    private static extern int GetClassName(IntPtr hWnd, System.Text.StringBuilder className, int maxCount);

    [DllImport("user32.dll")]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint processId);

    [DllImport("user32.dll")]
    private static extern IntPtr GetShellWindow();

    public sealed record WindowInfo(string Title, string ClassName, string Executable);

    public static IReadOnlyList<WindowInfo> GetVisibleWindows()
    {
        var shellWindow = GetShellWindow();
        var windows = new List<WindowInfo>();
        EnumWindows((hWnd, _) =>
        {
            if (hWnd == shellWindow || !IsWindowVisible(hWnd))
                return true;
            var title = new System.Text.StringBuilder(256);
            var className = new System.Text.StringBuilder(256);
            if (GetWindowText(hWnd, title, title.Capacity) <= 0 || title.Length == 0
                || GetClassName(hWnd, className, className.Capacity) <= 0)
                return true;

            GetWindowThreadProcessId(hWnd, out var processId);
            if (processId == 0)
                return true;

            try
            {
                var executable = Process.GetProcessById((int)processId).ProcessName + ".exe";
                windows.Add(new WindowInfo(title.ToString(), className.ToString(), executable));
            }
            catch (ArgumentException)
            {
                // The window's process exited while the list was being collected.
            }
            catch (System.ComponentModel.Win32Exception)
            {
                // The process does not allow its executable name to be queried.
            }
            return true;
        }, IntPtr.Zero);
        return windows;
    }
}
