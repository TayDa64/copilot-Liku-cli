using System.Runtime.InteropServices;
using System.Text;

namespace AutomationHost.Rpc;

internal static partial class WindowModule
{
    private const int GwlExStyle = -20;
    private const uint GwOwner = 4;
    private const long WsExTopmost = 0x00000008;
    private const long WsExToolwindow = 0x00000080;

    public static WindowInfoResult GetForegroundWindowInfo()
    {
        var handle = GetForegroundWindow();
        if (handle == IntPtr.Zero)
        {
            return new WindowInfoResult
            {
                Success = false,
                Error = "No foreground window"
            };
        }

        return GetWindowInfo(handle);
    }

    public static WindowInfoResult GetWindowInfoByHandle(long hwnd)
    {
        if (hwnd <= 0)
        {
            return new WindowInfoResult
            {
                Success = false,
                Error = "Invalid window handle"
            };
        }

        var handle = new IntPtr(hwnd);
        if (!IsWindow(handle))
        {
            return new WindowInfoResult
            {
                Success = false,
                Error = "Window handle not found"
            };
        }

        return GetWindowInfo(handle);
    }

    private static WindowInfoResult GetWindowInfo(IntPtr handle)
    {
        try
        {
            _ = GetWindowThreadProcessId(handle, out var processId);
            var title = SanitizeText(GetWindowTitle(handle));
            var processName = string.Empty;

            try
            {
                var process = System.Diagnostics.Process.GetProcessById((int)processId);
                processName = process.ProcessName ?? string.Empty;
            }
            catch
            {
                processName = string.Empty;
            }

            var exStyle = GetWindowLongPtrCompat(handle, GwlExStyle).ToInt64();
            var owner = GetWindow(handle, GwOwner);
            var ownerHwnd = owner == IntPtr.Zero ? 0L : owner.ToInt64();
            var isTopmost = (exStyle & WsExTopmost) != 0;
            var isToolWindow = (exStyle & WsExToolwindow) != 0;
            var isMinimized = IsIconic(handle);
            var isMaximized = IsZoomed(handle);
            var windowKind = ownerHwnd != 0 && isToolWindow
                ? "palette"
                : ownerHwnd != 0
                    ? "owned"
                    : "main";

            return new WindowInfoResult
            {
                Success = true,
                Hwnd = handle.ToInt64(),
                Pid = (int)processId,
                ProcessName = processName,
                Title = title,
                OwnerHwnd = ownerHwnd,
                IsTopmost = isTopmost,
                IsToolWindow = isToolWindow,
                IsMinimized = isMinimized,
                IsMaximized = isMaximized,
                WindowKind = windowKind
            };
        }
        catch (Exception ex)
        {
            return new WindowInfoResult
            {
                Success = false,
                Error = ex.Message,
                Hwnd = handle.ToInt64()
            };
        }
    }

    private static string GetWindowTitle(IntPtr handle)
    {
        var builder = new StringBuilder(512);
        _ = GetWindowText(handle, builder, builder.Capacity);
        return builder.ToString();
    }

    private static string SanitizeText(string? value)
    {
        if (string.IsNullOrEmpty(value))
        {
            return string.Empty;
        }

        var builder = new StringBuilder(value.Length);
        foreach (var ch in value)
        {
            if ((ch >= 0x00 && ch <= 0x08) || ch == 0x0B || ch == 0x0C || (ch >= 0x0E && ch <= 0x1F) || ch == 0x7F)
            {
                builder.Append(' ');
            }
            else
            {
                builder.Append(ch);
            }
        }

        return builder.ToString();
    }

    private static IntPtr GetWindowLongPtrCompat(IntPtr handle, int index)
    {
        return IntPtr.Size == 8 ? GetWindowLongPtr64(handle, index) : GetWindowLongPtr32(handle, index);
    }

    [DllImport("user32.dll")]
    private static extern IntPtr GetForegroundWindow();

    [DllImport("user32.dll", SetLastError = true)]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsWindow(IntPtr hWnd);

    [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll", EntryPoint = "GetWindowLong", SetLastError = true)]
    private static extern IntPtr GetWindowLongPtr32(IntPtr hWnd, int nIndex);

    [DllImport("user32.dll")]
    private static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsIconic(IntPtr hWnd);

    [DllImport("user32.dll")]
    [return: MarshalAs(UnmanagedType.Bool)]
    private static extern bool IsZoomed(IntPtr hWnd);

    [DllImport("user32.dll", SetLastError = true)]
    private static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

    [DllImport("user32.dll", CharSet = CharSet.Auto)]
    private static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);
}