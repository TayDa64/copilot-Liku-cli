using System;
using System.Collections.Generic;
using System.Diagnostics;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text;
using System.Text.Json;
using System.Text.RegularExpressions;
using System.Threading;
using System.Timers;
using System.Windows;
using System.Windows.Automation;

namespace UIAWrapper
{
    class Program
    {
        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool IsWindow(IntPtr hWnd);

        [DllImport("user32.dll", EntryPoint = "GetWindowLongPtr", SetLastError = true)]
        static extern IntPtr GetWindowLongPtr64(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll", EntryPoint = "GetWindowLong", SetLastError = true)]
        static extern IntPtr GetWindowLongPtr32(IntPtr hWnd, int nIndex);

        [DllImport("user32.dll")]
        static extern IntPtr GetWindow(IntPtr hWnd, uint uCmd);

        [DllImport("user32.dll")]
        static extern bool IsIconic(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern bool IsZoomed(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern bool GetWindowRect(IntPtr hWnd, out RECT rect);

        [DllImport("user32.dll", SetLastError = true)]
        static extern uint GetWindowThreadProcessId(IntPtr hWnd, out uint lpdwProcessId);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        static extern int GetWindowText(IntPtr hWnd, StringBuilder text, int count);

        [DllImport("user32.dll", CharSet = CharSet.Auto)]
        static extern int GetClassName(IntPtr hWnd, StringBuilder className, int count);

        [DllImport("user32.dll")]
        static extern bool EnumWindows(EnumWindowsProc lpEnumFunc, IntPtr lParam);

        [DllImport("user32.dll")]
        static extern bool IsWindowVisible(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern bool ShowWindow(IntPtr hWnd, int nCmdShow);

        [DllImport("user32.dll")]
        static extern bool SetForegroundWindow(IntPtr hWnd);

        [DllImport("user32.dll")]
        static extern bool AttachThreadInput(uint idAttach, uint idAttachTo, bool fAttach);

        [DllImport("kernel32.dll")]
        static extern uint GetCurrentThreadId();

        [DllImport("user32.dll", SetLastError = true)]
        static extern bool SystemParametersInfo(uint uiAction, uint uiParam, IntPtr pvParam, uint fWinIni);

        [DllImport("user32.dll")]
        static extern void SwitchToThisWindow(IntPtr hWnd, bool fAltTab);

        delegate bool EnumWindowsProc(IntPtr hWnd, IntPtr lParam);

        [StructLayout(LayoutKind.Sequential)]
        struct RECT
        {
            public int Left;
            public int Top;
            public int Right;
            public int Bottom;
        }

        static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = false };
        const int GWL_EXSTYLE = -20;
        const uint GW_OWNER = 4;
        const long WS_EX_TOPMOST = 0x00000008;
        const long WS_EX_TOOLWINDOW = 0x00000080;
        const int SW_RESTORE = 9;
        const uint SPI_GETFOREGROUNDLOCKTIMEOUT = 0x2000;
        const uint SPI_SETFOREGROUNDLOCKTIMEOUT = 0x2001;
        const uint SPIF_SENDCHANGE = 0x02;

        // ── Thread-safe output (Phase 4) ─────────────────────────────────────
        static readonly object _writeLock = new object();

        // ── Event subscription state (Phase 4) ──────────────────────────────
        static bool _eventsSubscribed = false;
        static AutomationElement? _subscribedWindow = null;
        static int _subscribedWindowHandle = 0;
        static readonly int MaxWalkElements = 300;

        // Debounce timers
        static System.Timers.Timer? _structureDebounce = null;
        static System.Timers.Timer? _propertyDebounce = null;
        static readonly List<Dictionary<string, object?>> _pendingPropertyChanges = new();
        static readonly object _propLock = new object();

        // Adaptive backoff: if >10 structure events in 1s, increase debounce
        static int _structureEventBurst = 0;
        static DateTime _structureBurstWindowStart = DateTime.UtcNow;
        static int _structureDebounceMs = 100;

        // Event handler references (for removal)
        static AutomationFocusChangedEventHandler? _focusHandler = null;
        static StructureChangedEventHandler? _structureHandler = null;
        static AutomationPropertyChangedEventHandler? _propertyHandler = null;

        static void Main(string[] args)
        {
            // Legacy one-shot mode: no args → dump foreground tree and exit
            if (!Console.IsInputRedirected && args.Length == 0)
            {
                IntPtr handle = GetForegroundWindow();
                if (handle == IntPtr.Zero) return;
                AutomationElement root = AutomationElement.FromHandle(handle);
                var node = BuildTree(root);
                Console.WriteLine(JsonSerializer.Serialize(node, new JsonSerializerOptions { WriteIndented = true }));
                return;
            }

            // Persistent command-loop mode (JSONL over stdin/stdout)
            string? line;
            while ((line = Console.ReadLine()) != null)
            {
                if (string.IsNullOrWhiteSpace(line)) continue;
                try
                {
                    using var doc = JsonDocument.Parse(line);
                    var root = doc.RootElement;
                    var cmd = root.GetProperty("cmd").GetString() ?? "";

                    switch (cmd)
                    {
                        case "getTree":
                            HandleGetTree();
                            break;
                        case "getForegroundWindowInfo":
                            HandleGetForegroundWindowInfo();
                            break;
                        case "getWindowInfoByHandle":
                            HandleGetWindowInfoByHandle(root);
                            break;
                        case "findWindow":
                            HandleFindWindow(root);
                            break;
                        case "focusWindow":
                            HandleFocusWindow(root);
                            break;
                        case "restoreWindow":
                            HandleRestoreWindow(root);
                            break;
                        case "elementFromPoint":
                            HandleElementFromPoint(root);
                            break;
                        case "findElementsByWindow":
                            HandleFindElementsByWindow(root);
                            break;
                        case "invokeElementByWindow":
                            HandleInvokeElementByWindow(root);
                            break;
                        case "setValue":
                            HandleSetValue(root);
                            break;
                        case "scroll":
                            HandleScroll(root);
                            break;
                        case "expandCollapse":
                            HandleExpandCollapse(root);
                            break;
                        case "getText":
                            HandleGetText(root);
                            break;
                        case "getClipboardText":
                            HandleGetClipboardText();
                            break;
                        case "setClipboardText":
                            HandleSetClipboardText(root);
                            break;
                        case "subscribeEvents":
                            HandleSubscribeEvents();
                            break;
                        case "unsubscribeEvents":
                            HandleUnsubscribeEvents();
                            break;
                        case "exit":
                            Reply(new { ok = true, cmd = "exit" });
                            return;
                        default:
                            Reply(new { ok = false, error = $"Unknown command: {cmd}" });
                            break;
                    }
                }
                catch (Exception ex)
                {
                    Reply(new { ok = false, error = ex.Message });
                }
            }
        }

        static void Reply(object obj)
        {
            lock (_writeLock)
            {
                Console.WriteLine(JsonSerializer.Serialize(obj, JsonOpts));
                Console.Out.Flush();
            }
        }

        // ── getTree ──────────────────────────────────────────────────────────
        static void HandleGetTree()
        {
            IntPtr handle = GetForegroundWindow();
            if (handle == IntPtr.Zero)
            {
                Reply(new { ok = false, error = "No foreground window" });
                return;
            }
            AutomationElement root = AutomationElement.FromHandle(handle);
            var node = BuildTree(root);
            Reply(new { ok = true, cmd = "getTree", tree = node });
        }

        // ── getForegroundWindowInfo / getWindowInfoByHandle ────────────────
        static void HandleGetForegroundWindowInfo()
        {
            IntPtr hwnd = GetForegroundWindow();
            if (hwnd == IntPtr.Zero)
            {
                Reply(new { ok = false, cmd = "getForegroundWindowInfo", error = "No foreground window" });
                return;
            }

            AutomationElement? window = null;
            try { window = AutomationElement.FromHandle(hwnd); } catch { }

            Reply(new
            {
                ok = true,
                cmd = "getForegroundWindowInfo",
                window = BuildWindowInfo(hwnd, window)
            });
        }

        static void HandleGetWindowInfoByHandle(JsonElement root)
        {
            long rawHandle = root.TryGetProperty("hwnd", out var hwndProp)
                ? hwndProp.GetInt64()
                : 0;

            IntPtr hwnd = new IntPtr(rawHandle);
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            {
                Reply(new { ok = false, cmd = "getWindowInfoByHandle", error = "Window handle not found" });
                return;
            }

            AutomationElement? window = null;
            try { window = AutomationElement.FromHandle(hwnd); } catch { }

            Reply(new
            {
                ok = true,
                cmd = "getWindowInfoByHandle",
                window = BuildWindowInfo(hwnd, window)
            });
        }

        static void HandleFindWindow(JsonElement root)
        {
            try
            {
                string title = root.TryGetProperty("title", out var titleProp)
                    ? titleProp.GetString() ?? ""
                    : "";
                string titleMode = root.TryGetProperty("titleMode", out var titleModeProp)
                    ? titleModeProp.GetString() ?? "contains"
                    : "contains";
                string processName = root.TryGetProperty("processName", out var processProp)
                    ? processProp.GetString() ?? ""
                    : "";
                string className = root.TryGetProperty("className", out var classProp)
                    ? classProp.GetString() ?? ""
                    : "";

                var bestMatch = FindBestWindow(title, titleMode, processName, className);
                Reply(new
                {
                    ok = true,
                    cmd = "findWindow",
                    window = bestMatch != null ? BuildWindowInfo(bestMatch.Value) : null
                });
            }
            catch (Exception ex)
            {
                Reply(new { ok = false, cmd = "findWindow", error = ex.Message });
            }
        }

        static void HandleFocusWindow(JsonElement root)
        {
            long rawHandle = root.TryGetProperty("hwnd", out var hwndProp)
                ? hwndProp.GetInt64()
                : 0;

            IntPtr hwnd = new IntPtr(rawHandle);
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            {
                Reply(new { ok = false, cmd = "focusWindow", error = "Window handle not found" });
                return;
            }

            bool restored = false;
            if (IsIconic(hwnd))
            {
                restored = ShowWindow(hwnd, SW_RESTORE);
                Thread.Sleep(100);
            }

            bool focusAttempted = TryFocusWindow(hwnd);

            IntPtr actualForeground = IntPtr.Zero;
            bool exactMatch = false;
            for (int attempt = 0; attempt < 8; attempt++)
            {
                actualForeground = GetForegroundWindow();
                if (actualForeground == hwnd)
                {
                    exactMatch = true;
                    break;
                }
                Thread.Sleep(50);
            }

            if (actualForeground == IntPtr.Zero)
                actualForeground = GetForegroundWindow();

            Reply(new
            {
                ok = true,
                cmd = "focusWindow",
                requestedWindowHandle = hwnd.ToInt64(),
                actualForegroundHandle = actualForeground == IntPtr.Zero ? 0 : actualForeground.ToInt64(),
                actualForeground = actualForeground == IntPtr.Zero ? null : BuildWindowInfo(actualForeground),
                exactMatch,
                restored,
                focusAttempted,
                outcome = exactMatch ? "exact" : "mismatch"
            });
        }

        static void HandleRestoreWindow(JsonElement root)
        {
            long rawHandle = root.TryGetProperty("hwnd", out var hwndProp)
                ? hwndProp.GetInt64()
                : 0;

            IntPtr hwnd = new IntPtr(rawHandle);
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            {
                Reply(new { ok = false, cmd = "restoreWindow", error = "Window handle not found" });
                return;
            }

            bool restored = ShowWindow(hwnd, SW_RESTORE);
            AutomationElement? window = null;
            try { window = AutomationElement.FromHandle(hwnd); } catch { }

            Reply(new
            {
                ok = true,
                cmd = "restoreWindow",
                hwnd = hwnd.ToInt64(),
                restored,
                window = BuildWindowInfo(hwnd, window)
            });
        }

        // ── elementFromPoint ─────────────────────────────────────────────────
        static void HandleElementFromPoint(JsonElement root)
        {
            double x = root.GetProperty("x").GetDouble();
            double y = root.GetProperty("y").GetDouble();

            AutomationElement element;
            try
            {
                element = AutomationElement.FromPoint(new Point(x, y));
            }
            catch (Exception ex)
            {
                Reply(new { ok = false, error = $"FromPoint failed: {ex.Message}" });
                return;
            }

            if (element == null)
            {
                Reply(new { ok = false, error = "No element at point" });
                return;
            }

            var payload = BuildRichElement(element);
            payload["queryPoint"] = new Dictionary<string, double> { ["x"] = x, ["y"] = y };
            Reply(new { ok = true, cmd = "elementFromPoint", element = payload });
        }

        // ── findElementsByWindow ─────────────────────────────────────────────
        static void HandleFindElementsByWindow(JsonElement root)
        {
            var started = Stopwatch.StartNew();
            long rawHandle = root.TryGetProperty("hwnd", out var hwndProp)
                ? hwndProp.GetInt64()
                : 0;

            IntPtr hwnd = new IntPtr(rawHandle);
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            {
                Reply(new { ok = false, cmd = "findElementsByWindow", error = "Window handle not found" });
                return;
            }

            string text = GetStringOption(root, "text", "");
            string textMode = GetStringOption(root, "textMode", "contains").ToLowerInvariant();
            string controlType = GetStringOption(root, "controlType", "");
            string view = GetStringOption(root, "view", "control");
            int maxResults = ClampInt(GetIntOption(root, "maxResults", 50), 1, 500);
            int maxDepth = ClampInt(GetIntOption(root, "maxDepth", 12), 0, 64);
            int maxVisited = ClampInt(GetIntOption(root, "maxVisited", 750), 1, 5000);
            int timeoutMs = ClampInt(GetIntOption(root, "timeoutMs", 2500), 100, 8000);
            bool includeOffscreen = GetBoolOption(root, "includeOffscreen", false);
            bool includeDisabled = GetBoolOption(root, "includeDisabled", true);
            var bounds = TryGetBoundsOption(root);

            Regex? regex = null;
            if (textMode == "regex" && !string.IsNullOrWhiteSpace(text))
            {
                try
                {
                    regex = new Regex(text, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
                }
                catch (Exception ex)
                {
                    Reply(new { ok = false, cmd = "findElementsByWindow", error = $"Invalid regex: {ex.Message}" });
                    return;
                }
            }

            AutomationElement window;
            try
            {
                window = AutomationElement.FromHandle(hwnd);
            }
            catch (Exception ex)
            {
                Reply(new { ok = false, cmd = "findElementsByWindow", error = $"AutomationElement.FromHandle failed: {ex.Message}" });
                return;
            }

            var results = new List<Dictionary<string, object?>>();
            int visited = 0;
            bool timedOut = false;
            bool visitedLimitHit = false;
            bool depthLimitHit = false;

            try
            {
                var walker = ResolveTreeWalker(view);
                var stack = new Stack<(AutomationElement Element, int Depth)>();
                stack.Push((window, 0));

                while (stack.Count > 0)
                {
                    if (started.ElapsedMilliseconds >= timeoutMs)
                    {
                        timedOut = true;
                        break;
                    }

                    if (visited >= maxVisited)
                    {
                        visitedLimitHit = true;
                        break;
                    }

                    var current = stack.Pop();
                    visited++;

                    try
                    {
                        if (ElementMatchesFindOptions(
                            current.Element,
                            text,
                            textMode,
                            regex,
                            controlType,
                            includeOffscreen,
                            includeDisabled,
                            bounds))
                        {
                            results.Add(BuildFindElementPayload(current.Element, hwnd, current.Depth));
                            if (results.Count >= maxResults)
                                break;
                        }
                    }
                    catch (ElementNotAvailableException) { continue; }
                    catch { }

                    if (current.Depth >= maxDepth)
                    {
                        depthLimitHit = true;
                        continue;
                    }

                    var children = new List<AutomationElement>();
                    try
                    {
                        var child = walker.GetFirstChild(current.Element);
                        while (child != null)
                        {
                            children.Add(child);
                            child = walker.GetNextSibling(child);
                            if (started.ElapsedMilliseconds >= timeoutMs)
                            {
                                timedOut = true;
                                break;
                            }
                        }
                    }
                    catch (ElementNotAvailableException) { }
                    catch { }

                    for (int i = children.Count - 1; i >= 0; i--)
                    {
                        stack.Push((children[i], current.Depth + 1));
                    }

                    if (timedOut) break;
                }
            }
            catch (Exception ex)
            {
                Reply(new { ok = false, cmd = "findElementsByWindow", error = ex.Message });
                return;
            }

            Reply(new
            {
                ok = true,
                cmd = "findElementsByWindow",
                hwnd = hwnd.ToInt64(),
                query = new
                {
                    text,
                    textMode,
                    controlType,
                    view,
                    maxResults,
                    maxDepth,
                    maxVisited,
                    timeoutMs,
                    includeOffscreen,
                    includeDisabled,
                    bounds
                },
                elements = results,
                count = results.Count,
                stats = new
                {
                    visited,
                    elapsedMs = started.ElapsedMilliseconds,
                    timedOut,
                    visitedLimitHit,
                    depthLimitHit,
                    resultLimitHit = results.Count >= maxResults
                }
            });
        }

        static void HandleInvokeElementByWindow(JsonElement root)
        {
            var started = Stopwatch.StartNew();
            long rawHandle = root.TryGetProperty("hwnd", out var hwndProp)
                ? hwndProp.GetInt64()
                : 0;

            IntPtr hwnd = new IntPtr(rawHandle);
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
            {
                Reply(new { ok = false, cmd = "invokeElementByWindow", error = "Window handle not found" });
                return;
            }

            string text = GetStringOption(root, "text", "");
            string textMode = GetStringOption(root, "textMode", "contains").ToLowerInvariant();
            string controlType = GetStringOption(root, "controlType", "");
            string view = GetStringOption(root, "view", "control");
            int maxDepth = ClampInt(GetIntOption(root, "maxDepth", 16), 0, 64);
            int maxVisited = ClampInt(GetIntOption(root, "maxVisited", 1000), 1, 5000);
            int timeoutMs = ClampInt(GetIntOption(root, "timeoutMs", 3000), 100, 8000);
            bool includeOffscreen = GetBoolOption(root, "includeOffscreen", false);
            bool includeDisabled = GetBoolOption(root, "includeDisabled", false);
            var bounds = TryGetBoundsOption(root);

            Regex? regex = null;
            if (textMode == "regex" && !string.IsNullOrWhiteSpace(text))
            {
                try
                {
                    regex = new Regex(text, RegexOptions.IgnoreCase | RegexOptions.CultureInvariant);
                }
                catch (Exception ex)
                {
                    Reply(new { ok = false, cmd = "invokeElementByWindow", error = $"Invalid regex: {ex.Message}" });
                    return;
                }
            }

            AutomationElement window;
            try
            {
                window = AutomationElement.FromHandle(hwnd);
            }
            catch (Exception ex)
            {
                Reply(new { ok = false, cmd = "invokeElementByWindow", error = $"AutomationElement.FromHandle failed: {ex.Message}" });
                return;
            }

            AutomationElement? matched = null;
            int visited = 0;
            bool timedOut = false;
            bool visitedLimitHit = false;
            bool depthLimitHit = false;

            try
            {
                matched = FindFirstMatchingElement(
                    window,
                    text,
                    textMode,
                    regex,
                    controlType,
                    includeOffscreen,
                    includeDisabled,
                    bounds,
                    maxDepth,
                    maxVisited,
                    timeoutMs,
                    started,
                    view,
                    out visited,
                    out timedOut,
                    out visitedLimitHit,
                    out depthLimitHit);
            }
            catch (Exception ex)
            {
                Reply(new { ok = false, cmd = "invokeElementByWindow", error = ex.Message });
                return;
            }

            if (matched == null)
            {
                Reply(new
                {
                    ok = false,
                    cmd = "invokeElementByWindow",
                    error = "Element not found",
                    stats = new
                    {
                        visited,
                        elapsedMs = started.ElapsedMilliseconds,
                        timedOut,
                        visitedLimitHit,
                        depthLimitHit
                    }
                });
                return;
            }

            var elementPayload = BuildFindElementPayload(matched, hwnd, 0);
            try
            {
                string method = InvokeSemanticPattern(matched);
                Reply(new
                {
                    ok = true,
                    cmd = "invokeElementByWindow",
                    method,
                    element = elementPayload,
                    stats = new
                    {
                        visited,
                        elapsedMs = started.ElapsedMilliseconds,
                        timedOut,
                        visitedLimitHit,
                        depthLimitHit
                    }
                });
            }
            catch (Exception ex)
            {
                Reply(new
                {
                    ok = false,
                    cmd = "invokeElementByWindow",
                    error = ex.Message,
                    element = elementPayload,
                    patterns = GetPatternNames(matched),
                    stats = new
                    {
                        visited,
                        elapsedMs = started.ElapsedMilliseconds,
                        timedOut,
                        visitedLimitHit,
                        depthLimitHit
                    }
                });
            }
        }

        // ── Helper: resolve element at x,y ───────────────────────────────────
        static AutomationElement? ResolveElement(JsonElement root, out double x, out double y)
        {
            x = root.GetProperty("x").GetDouble();
            y = root.GetProperty("y").GetDouble();
            return AutomationElement.FromPoint(new Point(x, y));
        }

        // ── setValue (Phase 3) ───────────────────────────────────────────────
        static void HandleSetValue(JsonElement root)
        {
            try
            {
                var el = ResolveElement(root, out double x, out double y);
                if (el == null) { Reply(new { ok = false, cmd = "setValue", error = "No element at point" }); return; }

                string value = root.GetProperty("value").GetString() ?? "";

                if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsValuePatternAvailableProperty))
                {
                    var vp = (ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern);
                    vp.SetValue(value);
                    Reply(new { ok = true, cmd = "setValue", method = "ValuePattern", element = BuildRichElement(el) });
                }
                else
                {
                    Reply(new { ok = false, cmd = "setValue", error = "ValuePattern not supported", patterns = GetPatternNames(el) });
                }
            }
            catch (Exception ex) { Reply(new { ok = false, cmd = "setValue", error = ex.Message }); }
        }

        // ── scroll (Phase 3) ─────────────────────────────────────────────────
        static void HandleScroll(JsonElement root)
        {
            try
            {
                var el = ResolveElement(root, out double x, out double y);
                if (el == null) { Reply(new { ok = false, cmd = "scroll", error = "No element at point" }); return; }

                string direction = root.TryGetProperty("direction", out var dirProp) ? dirProp.GetString() ?? "down" : "down";
                double amount = root.TryGetProperty("amount", out var amtProp) ? amtProp.GetDouble() : -1;

                if (!(bool)el.GetCurrentPropertyValue(AutomationElement.IsScrollPatternAvailableProperty))
                {
                    Reply(new { ok = false, cmd = "scroll", error = "ScrollPattern not supported", patterns = GetPatternNames(el) });
                    return;
                }

                var sp = (ScrollPattern)el.GetCurrentPattern(ScrollPattern.Pattern);

                if (amount >= 0)
                {
                    // SetScrollPercent mode
                    double hPct = sp.Current.HorizontalScrollPercent;
                    double vPct = sp.Current.VerticalScrollPercent;
                    switch (direction)
                    {
                        case "left": hPct = Math.Max(0, amount); break;
                        case "right": hPct = Math.Min(100, amount); break;
                        case "up": vPct = Math.Max(0, amount); break;
                        default: vPct = Math.Min(100, amount); break; // down
                    }
                    sp.SetScrollPercent(hPct, vPct);
                }
                else
                {
                    // Scroll by amount (SmallIncrement)
                    switch (direction)
                    {
                        case "up": sp.ScrollVertical(ScrollAmount.SmallDecrement); break;
                        case "down": sp.ScrollVertical(ScrollAmount.SmallIncrement); break;
                        case "left": sp.ScrollHorizontal(ScrollAmount.SmallDecrement); break;
                        case "right": sp.ScrollHorizontal(ScrollAmount.SmallIncrement); break;
                    }
                }

                Reply(new
                {
                    ok = true,
                    cmd = "scroll",
                    method = "ScrollPattern",
                    direction,
                    scrollInfo = new
                    {
                        horizontalPercent = sp.Current.HorizontalScrollPercent,
                        verticalPercent = sp.Current.VerticalScrollPercent,
                        horizontalViewSize = sp.Current.HorizontalViewSize,
                        verticalViewSize = sp.Current.VerticalViewSize
                    }
                });
            }
            catch (Exception ex) { Reply(new { ok = false, cmd = "scroll", error = ex.Message }); }
        }

        // ── expandCollapse (Phase 3) ─────────────────────────────────────────
        static void HandleExpandCollapse(JsonElement root)
        {
            try
            {
                var el = ResolveElement(root, out double x, out double y);
                if (el == null) { Reply(new { ok = false, cmd = "expandCollapse", error = "No element at point" }); return; }

                string action = root.TryGetProperty("action", out var actProp) ? actProp.GetString() ?? "toggle" : "toggle";

                if (!(bool)el.GetCurrentPropertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty))
                {
                    Reply(new { ok = false, cmd = "expandCollapse", error = "ExpandCollapsePattern not supported", patterns = GetPatternNames(el) });
                    return;
                }

                var ecp = (ExpandCollapsePattern)el.GetCurrentPattern(ExpandCollapsePattern.Pattern);
                var stateBefore = ecp.Current.ExpandCollapseState.ToString();

                switch (action)
                {
                    case "expand": ecp.Expand(); break;
                    case "collapse": ecp.Collapse(); break;
                    default: // toggle
                        if (ecp.Current.ExpandCollapseState == ExpandCollapseState.Collapsed)
                            ecp.Expand();
                        else
                            ecp.Collapse();
                        break;
                }

                Reply(new
                {
                    ok = true,
                    cmd = "expandCollapse",
                    method = "ExpandCollapsePattern",
                    action,
                    stateBefore,
                    stateAfter = ecp.Current.ExpandCollapseState.ToString()
                });
            }
            catch (Exception ex) { Reply(new { ok = false, cmd = "expandCollapse", error = ex.Message }); }
        }

        // ── getText (Phase 3) ────────────────────────────────────────────────
        static void HandleGetText(JsonElement root)
        {
            try
            {
                var el = ResolveElement(root, out double x, out double y);
                if (el == null) { Reply(new { ok = false, cmd = "getText", error = "No element at point" }); return; }

                // Try TextPattern first
                if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsTextPatternAvailableProperty))
                {
                    var tp = (TextPattern)el.GetCurrentPattern(TextPattern.Pattern);
                    string text = tp.DocumentRange.GetText(-1);
                    Reply(new { ok = true, cmd = "getText", method = "TextPattern", text, element = BuildRichElement(el) });
                    return;
                }

                // Fallback: try ValuePattern
                if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsValuePatternAvailableProperty))
                {
                    var vp = (ValuePattern)el.GetCurrentPattern(ValuePattern.Pattern);
                    string text = vp.Current.Value;
                    Reply(new { ok = true, cmd = "getText", method = "ValuePattern", text, element = BuildRichElement(el) });
                    return;
                }

                // Fallback: Name property
                string name = el.Current.Name;
                if (!string.IsNullOrEmpty(name))
                {
                    Reply(new { ok = true, cmd = "getText", method = "Name", text = name, element = BuildRichElement(el) });
                    return;
                }

                Reply(new { ok = false, cmd = "getText", error = "No text source available", patterns = GetPatternNames(el) });
            }
            catch (Exception ex) { Reply(new { ok = false, cmd = "getText", error = ex.Message }); }
        }

        // ── clipboard helpers ───────────────────────────────────────────────
        static void HandleGetClipboardText()
        {
            try
            {
                string text = ReadClipboardTextWithRetry();
                Reply(new { ok = true, cmd = "getClipboardText", text });
            }
            catch (Exception ex)
            {
                Reply(new { ok = false, cmd = "getClipboardText", error = ex.Message });
            }
        }

        static void HandleSetClipboardText(JsonElement root)
        {
            try
            {
                string text = root.TryGetProperty("text", out var textProp)
                    ? textProp.GetString() ?? ""
                    : "";
                WriteClipboardTextWithRetry(text);
                Reply(new { ok = true, cmd = "setClipboardText" });
            }
            catch (Exception ex)
            {
                Reply(new { ok = false, cmd = "setClipboardText", error = ex.Message });
            }
        }

        static string ReadClipboardTextWithRetry(int attempts = 5, int delayMs = 60)
        {
            Exception? lastError = null;
            for (int attempt = 1; attempt <= attempts; attempt++)
            {
                try
                {
                    return RunInStaThread(() =>
                    {
                        if (Clipboard.ContainsText(TextDataFormat.UnicodeText))
                            return Clipboard.GetText(TextDataFormat.UnicodeText) ?? "";
                        if (Clipboard.ContainsText())
                            return Clipboard.GetText() ?? "";
                        return "";
                    });
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    if (attempt < attempts)
                        Thread.Sleep(delayMs);
                }
            }

            throw new InvalidOperationException($"Clipboard read failed after {attempts} attempts: {lastError?.Message}", lastError);
        }

        static void WriteClipboardTextWithRetry(string text, int attempts = 5, int delayMs = 60)
        {
            Exception? lastError = null;
            for (int attempt = 1; attempt <= attempts; attempt++)
            {
                try
                {
                    RunInStaThread(() =>
                    {
                        Clipboard.Clear();
                        if (!string.IsNullOrEmpty(text))
                            Clipboard.SetText(text, TextDataFormat.UnicodeText);
                        return true;
                    });
                    return;
                }
                catch (Exception ex)
                {
                    lastError = ex;
                    if (attempt < attempts)
                        Thread.Sleep(delayMs);
                }
            }

            throw new InvalidOperationException($"Clipboard write failed after {attempts} attempts: {lastError?.Message}", lastError);
        }

        static T RunInStaThread<T>(Func<T> action)
        {
            T result = default!;
            Exception? error = null;

            var thread = new Thread(() =>
            {
                try
                {
                    result = action();
                }
                catch (Exception ex)
                {
                    error = ex;
                }
            });

            thread.SetApartmentState(ApartmentState.STA);
            thread.Start();
            thread.Join();

            if (error != null)
                throw error;

            return result;
        }

        static IntPtr? FindBestWindow(string title, string titleMode, string processName, string className)
        {
            string normalizedTitle = (title ?? "").Trim();
            string normalizedTitleMode = string.IsNullOrWhiteSpace(titleMode) ? "contains" : titleMode.Trim().ToLowerInvariant();
            string normalizedProcess = NormalizeProcessName(processName);
            string normalizedClass = (className ?? "").Trim().ToLowerInvariant();

            if (string.IsNullOrWhiteSpace(normalizedTitle) && string.IsNullOrWhiteSpace(normalizedProcess) && string.IsNullOrWhiteSpace(normalizedClass))
                return null;

            var candidates = new List<(IntPtr Handle, int Score)>();

            EnumWindows((hwnd, _) =>
            {
                if (hwnd == IntPtr.Zero || !IsWindow(hwnd) || !IsWindowVisible(hwnd))
                    return true;

                string candidateTitle = GetWindowTitle(hwnd);
                string candidateClass = GetWindowClassName(hwnd);

                uint processId = 0;
                GetWindowThreadProcessId(hwnd, out processId);
                string candidateProcess = GetProcessName(processId);

                if (!WindowMatches(normalizedTitle, normalizedTitleMode, candidateTitle, normalizedProcess, candidateProcess, normalizedClass, candidateClass))
                    return true;

                int score = ScoreWindowMatch(normalizedTitle, normalizedTitleMode, candidateTitle, normalizedProcess, candidateProcess, normalizedClass, candidateClass, hwnd);
                candidates.Add((hwnd, score));
                return true;
            }, IntPtr.Zero);

            if (candidates.Count == 0)
                return null;

            return candidates
                .OrderByDescending(candidate => candidate.Score)
                .ThenByDescending(candidate => candidate.Handle.ToInt64())
                .Select(candidate => (IntPtr?)candidate.Handle)
                .FirstOrDefault();
        }

        static bool WindowMatches(
            string title,
            string titleMode,
            string candidateTitle,
            string processName,
            string candidateProcessName,
            string className,
            string candidateClassName)
        {
            if (!string.IsNullOrWhiteSpace(title))
            {
                if (titleMode == "regex")
                {
                    if (!Regex.IsMatch(candidateTitle ?? "", title, RegexOptions.IgnoreCase))
                        return false;
                }
                else if ((candidateTitle ?? "").IndexOf(title, StringComparison.OrdinalIgnoreCase) < 0)
                {
                    return false;
                }
            }

            if (!string.IsNullOrWhiteSpace(processName))
            {
                string normalizedCandidateProcess = NormalizeProcessName(candidateProcessName);
                bool processMatches = !string.IsNullOrWhiteSpace(normalizedCandidateProcess)
                    && (normalizedCandidateProcess == processName
                        || normalizedCandidateProcess.Contains(processName)
                        || processName.Contains(normalizedCandidateProcess));
                if (!processMatches)
                    return false;
            }

            if (!string.IsNullOrWhiteSpace(className))
            {
                string normalizedCandidateClass = (candidateClassName ?? "").Trim().ToLowerInvariant();
                if (!normalizedCandidateClass.Contains(className))
                    return false;
            }

            return true;
        }

        static int ScoreWindowMatch(
            string title,
            string titleMode,
            string candidateTitle,
            string processName,
            string candidateProcessName,
            string className,
            string candidateClassName,
            IntPtr hwnd)
        {
            int score = 0;
            string normalizedCandidateProcess = NormalizeProcessName(candidateProcessName);
            string normalizedCandidateTitle = (candidateTitle ?? "").Trim();
            string normalizedCandidateClass = (candidateClassName ?? "").Trim().ToLowerInvariant();

            if (!string.IsNullOrWhiteSpace(processName))
            {
                if (normalizedCandidateProcess == processName) score += 120;
                else if (!string.IsNullOrWhiteSpace(normalizedCandidateProcess)
                    && (normalizedCandidateProcess.Contains(processName) || processName.Contains(normalizedCandidateProcess))) score += 80;
            }

            if (!string.IsNullOrWhiteSpace(title))
            {
                if (string.Equals(normalizedCandidateTitle, title, StringComparison.OrdinalIgnoreCase)) score += 100;
                else if (titleMode == "regex" && Regex.IsMatch(normalizedCandidateTitle, title, RegexOptions.IgnoreCase)) score += 75;
                else if (normalizedCandidateTitle.IndexOf(title, StringComparison.OrdinalIgnoreCase) >= 0) score += 70;
            }

            if (!string.IsNullOrWhiteSpace(className))
            {
                if (normalizedCandidateClass == className) score += 60;
                else if (normalizedCandidateClass.Contains(className)) score += 40;
            }

            var windowInfo = BuildWindowInfo(hwnd);
            if (string.Equals(windowInfo["windowKind"]?.ToString(), "main", StringComparison.OrdinalIgnoreCase)) score += 15;
            if (!(windowInfo["isMinimized"] as bool? ?? false)) score += 10;
            if (!string.IsNullOrWhiteSpace(normalizedCandidateTitle)) score += 5;
            return score;
        }

        static bool TryFocusWindow(IntPtr hwnd)
        {
            if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
                return false;

            IntPtr foreground = GetForegroundWindow();
            if (foreground == hwnd)
                return true;

            IntPtr timeoutPtr = IntPtr.Zero;
            int originalTimeout = 0;

            try
            {
                timeoutPtr = Marshal.AllocHGlobal(sizeof(int));
                if (SystemParametersInfo(SPI_GETFOREGROUNDLOCKTIMEOUT, 0, timeoutPtr, 0))
                    originalTimeout = Marshal.ReadInt32(timeoutPtr);
                SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, IntPtr.Zero, SPIF_SENDCHANGE);
            }
            catch { }

            try
            {
                uint foregroundThread = foreground == IntPtr.Zero ? 0 : GetWindowThreadProcessId(foreground, out _);
                uint currentThread = GetCurrentThreadId();
                bool focused = false;

                if (foregroundThread != 0 && foregroundThread != currentThread)
                {
                    AttachThreadInput(currentThread, foregroundThread, true);
                    try
                    {
                        focused = SetForegroundWindow(hwnd);
                    }
                    finally
                    {
                        AttachThreadInput(currentThread, foregroundThread, false);
                    }
                }
                else
                {
                    focused = SetForegroundWindow(hwnd);
                }

                if (!focused)
                    SwitchToThisWindow(hwnd, true);
            }
            finally
            {
                try
                {
                    if (timeoutPtr != IntPtr.Zero)
                    {
                        Marshal.WriteInt32(timeoutPtr, originalTimeout);
                        SystemParametersInfo(SPI_SETFOREGROUNDLOCKTIMEOUT, 0, timeoutPtr, SPIF_SENDCHANGE);
                    }
                }
                catch { }

                if (timeoutPtr != IntPtr.Zero)
                    Marshal.FreeHGlobal(timeoutPtr);
            }

            return GetForegroundWindow() == hwnd;
        }

        // ── Helper: get pattern short names ──────────────────────────────────

        // ── Phase 4: Event streaming ─────────────────────────────────────────

        static void HandleSubscribeEvents()
        {
            if (_eventsSubscribed)
            {
                Reply(new { ok = true, cmd = "subscribeEvents", note = "already subscribed" });
                return;
            }

            _eventsSubscribed = true;

            // Register system-wide focus changed handler
            _focusHandler = new AutomationFocusChangedEventHandler(OnFocusChanged);
            Automation.AddAutomationFocusChangedEventHandler(_focusHandler);

            // Set up debounce timers
            _structureDebounce = new System.Timers.Timer(_structureDebounceMs) { AutoReset = false };
            _structureDebounce.Elapsed += OnStructureDebounceElapsed;

            _propertyDebounce = new System.Timers.Timer(50) { AutoReset = false };
            _propertyDebounce.Elapsed += OnPropertyDebounceElapsed;

            // Immediately attach to current foreground window
            try
            {
                IntPtr fgHwnd = GetForegroundWindow();
                if (fgHwnd != IntPtr.Zero)
                {
                    var win = AutomationElement.FromHandle(fgHwnd);
                    AttachToWindow(win);
                }
            }
            catch { /* ignore — will pick up on next focus change */ }

            // Return initial snapshot
            var initialElements = WalkFocusedWindowElements();
            var activeWindow = GetActiveWindowInfo();
            Reply(new
            {
                ok = true,
                cmd = "subscribeEvents",
                initial = new { activeWindow, elements = initialElements }
            });
        }

        static void HandleUnsubscribeEvents()
        {
            if (!_eventsSubscribed)
            {
                Reply(new { ok = true, cmd = "unsubscribeEvents", note = "not subscribed" });
                return;
            }

            DetachFromWindow();

            if (_focusHandler != null)
            {
                try { Automation.RemoveAutomationFocusChangedEventHandler(_focusHandler); } catch { }
                _focusHandler = null;
            }

            _structureDebounce?.Stop();
            _structureDebounce?.Dispose();
            _structureDebounce = null;

            _propertyDebounce?.Stop();
            _propertyDebounce?.Dispose();
            _propertyDebounce = null;

            lock (_propLock) { _pendingPropertyChanges.Clear(); }

            _eventsSubscribed = false;
            _structureDebounceMs = 100;
            _structureEventBurst = 0;

            Reply(new { ok = true, cmd = "unsubscribeEvents" });
        }

        static void OnFocusChanged(object sender, AutomationFocusChangedEventArgs e)
        {
            if (!_eventsSubscribed) return;

            try
            {
                var focused = sender as AutomationElement;
                if (focused == null) return;

                // Walk up to find the top-level window
                var topWindow = FindTopLevelWindow(focused);
                if (topWindow == null) return;

                int hwnd = topWindow.Current.NativeWindowHandle;

                // Skip if same window
                if (hwnd == _subscribedWindowHandle && hwnd != 0) return;

                // Switch windows
                DetachFromWindow();
                AttachToWindow(topWindow);

                // Emit focus changed event with active window info
                var winInfo = BuildWindowInfo(topWindow);
                Reply(new
                {
                    type = "event",
                    @event = "focusChanged",
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    data = new { activeWindow = winInfo }
                });

                // Also trigger a structure snapshot for the new window
                FireStructureDebounce();
            }
            catch (ElementNotAvailableException) { /* element vanished, ignore */ }
            catch { /* defensive */ }
        }

        static void OnStructureChanged(object sender, StructureChangedEventArgs e)
        {
            if (!_eventsSubscribed) return;
            FireStructureDebounce();
        }

        static void OnPropertyChanged(object sender, AutomationPropertyChangedEventArgs e)
        {
            if (!_eventsSubscribed) return;

            try
            {
                var el = sender as AutomationElement;
                if (el == null) return;

                var light = BuildLightElement(el, _subscribedWindowHandle);
                if (light == null) return;

                lock (_propLock)
                {
                    _pendingPropertyChanges.Add(light);
                }

                // Reset the 50ms debounce timer
                _propertyDebounce?.Stop();
                _propertyDebounce?.Start();
            }
            catch (ElementNotAvailableException) { /* vanished */ }
            catch { /* defensive */ }
        }

        static void FireStructureDebounce()
        {
            // Adaptive backoff: track burst rate
            var now = DateTime.UtcNow;
            if ((now - _structureBurstWindowStart).TotalMilliseconds > 1000)
            {
                // New 1-second window
                if (_structureEventBurst > 10)
                {
                    // Too many events last second — increase debounce for 5 seconds
                    _structureDebounceMs = 200;
                }
                else if (_structureDebounceMs > 100)
                {
                    // Cool down back to normal
                    _structureDebounceMs = 100;
                }
                _structureEventBurst = 0;
                _structureBurstWindowStart = now;
            }
            _structureEventBurst++;

            if (_structureDebounce != null)
            {
                _structureDebounce.Interval = _structureDebounceMs;
                _structureDebounce.Stop();
                _structureDebounce.Start();
            }
        }

        static void OnStructureDebounceElapsed(object? sender, ElapsedEventArgs e)
        {
            if (!_eventsSubscribed) return;

            try
            {
                var elements = WalkFocusedWindowElements();
                Reply(new
                {
                    type = "event",
                    @event = "structureChanged",
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    data = new { elements }
                });
            }
            catch (Exception ex)
            {
                // Window may have vanished
                Reply(new
                {
                    type = "event",
                    @event = "error",
                    ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                    data = new { error = ex.Message }
                });
            }
        }

        static void OnPropertyDebounceElapsed(object? sender, ElapsedEventArgs e)
        {
            if (!_eventsSubscribed) return;

            List<Dictionary<string, object?>> batch;
            lock (_propLock)
            {
                if (_pendingPropertyChanges.Count == 0) return;
                batch = new List<Dictionary<string, object?>>(_pendingPropertyChanges);
                _pendingPropertyChanges.Clear();
            }

            // Deduplicate by id (keep latest)
            var deduped = new Dictionary<string, Dictionary<string, object?>>();
            foreach (var el in batch)
            {
                var id = el["id"]?.ToString() ?? "";
                deduped[id] = el; // last wins
            }

            Reply(new
            {
                type = "event",
                @event = "propertyChanged",
                ts = DateTimeOffset.UtcNow.ToUnixTimeMilliseconds(),
                data = new { elements = deduped.Values.ToList() }
            });
        }

        static void AttachToWindow(AutomationElement window)
        {
            _subscribedWindow = window;
            try { _subscribedWindowHandle = window.Current.NativeWindowHandle; } catch { _subscribedWindowHandle = 0; }

            _structureHandler = new StructureChangedEventHandler(OnStructureChanged);
            _propertyHandler = new AutomationPropertyChangedEventHandler(OnPropertyChanged);

            try
            {
                Automation.AddStructureChangedEventHandler(
                    window, TreeScope.Subtree, _structureHandler);
            }
            catch { /* element may have vanished */ }

            try
            {
                Automation.AddAutomationPropertyChangedEventHandler(
                    window, TreeScope.Subtree, _propertyHandler,
                    AutomationElement.BoundingRectangleProperty,
                    AutomationElement.NameProperty,
                    AutomationElement.IsEnabledProperty,
                    AutomationElement.IsOffscreenProperty);
            }
            catch { /* element may have vanished */ }
        }

        static void DetachFromWindow()
        {
            if (_subscribedWindow == null) return;

            if (_structureHandler != null)
            {
                try { Automation.RemoveStructureChangedEventHandler(_subscribedWindow, _structureHandler); } catch { }
                _structureHandler = null;
            }
            if (_propertyHandler != null)
            {
                try { Automation.RemoveAutomationPropertyChangedEventHandler(_subscribedWindow, _propertyHandler); } catch { }
                _propertyHandler = null;
            }

            _subscribedWindow = null;
            _subscribedWindowHandle = 0;
        }

        static AutomationElement? FindTopLevelWindow(AutomationElement element)
        {
            try
            {
                var walker = TreeWalker.ControlViewWalker;
                var current = element;
                AutomationElement? lastWindow = null;

                while (current != null && !Automation.Compare(current, AutomationElement.RootElement))
                {
                    try
                    {
                        if (current.Current.ControlType == ControlType.Window)
                            lastWindow = current;
                    }
                    catch (ElementNotAvailableException) { break; }

                    current = walker.GetParent(current);
                }

                return lastWindow;
            }
            catch { return null; }
        }

        static Dictionary<string, object?> BuildWindowInfo(AutomationElement window)
        {
            try
            {
                return BuildWindowInfo(new IntPtr(window.Current.NativeWindowHandle), window);
            }
            catch
            {
                return new Dictionary<string, object?>
                {
                    ["hwnd"] = 0,
                    ["title"] = "",
                    ["bounds"] = null,
                    ["processName"] = "",
                    ["ownerHwnd"] = 0,
                    ["isTopmost"] = false,
                    ["isToolWindow"] = false,
                    ["isMinimized"] = false,
                    ["isMaximized"] = false,
                    ["windowKind"] = "main"
                };
            }
        }

        static Dictionary<string, object?> BuildWindowInfo(IntPtr hwnd, AutomationElement? window = null)
        {
            try
            {
                if (hwnd == IntPtr.Zero || !IsWindow(hwnd))
                {
                    return new Dictionary<string, object?>
                    {
                        ["hwnd"] = 0,
                        ["title"] = "",
                        ["bounds"] = null,
                        ["processName"] = "",
                        ["ownerHwnd"] = 0,
                        ["isTopmost"] = false,
                        ["isToolWindow"] = false,
                        ["isMinimized"] = false,
                        ["isMaximized"] = false,
                        ["windowKind"] = "main"
                    };
                }

                string title = GetWindowTitle(hwnd);
                if (string.IsNullOrWhiteSpace(title) && window != null)
                {
                    try { title = window.Current.Name ?? ""; } catch { }
                }

                uint processId = 0;
                GetWindowThreadProcessId(hwnd, out processId);
                string processName = GetProcessName(processId);

                long exStyle = GetWindowStyle(hwnd, GWL_EXSTYLE).ToInt64();
                IntPtr owner = GetWindow(hwnd, GW_OWNER);
                long ownerHwnd = owner == IntPtr.Zero ? 0 : owner.ToInt64();
                bool isTopmost = (exStyle & WS_EX_TOPMOST) != 0;
                bool isToolWindow = (exStyle & WS_EX_TOOLWINDOW) != 0;
                bool isMinimized = IsIconic(hwnd);
                bool isMaximized = IsZoomed(hwnd);
                string windowKind = ownerHwnd != 0 && isToolWindow
                    ? "palette"
                    : ownerHwnd != 0
                        ? "owned"
                        : "main";

                RECT rect;
                bool haveRect = GetWindowRect(hwnd, out rect);
                return new Dictionary<string, object?>
                {
                    ["hwnd"] = hwnd.ToInt64(),
                    ["title"] = title,
                    ["pid"] = (int)processId,
                    ["processId"] = (int)processId,
                    ["processName"] = processName,
                    ["ownerHwnd"] = ownerHwnd,
                    ["isTopmost"] = isTopmost,
                    ["isToolWindow"] = isToolWindow,
                    ["isMinimized"] = isMinimized,
                    ["isMaximized"] = isMaximized,
                    ["windowKind"] = windowKind,
                    ["bounds"] = new Dictionary<string, double?>
                    {
                        ["x"] = haveRect ? rect.Left : null,
                        ["y"] = haveRect ? rect.Top : null,
                        ["width"] = haveRect ? rect.Right - rect.Left : null,
                        ["height"] = haveRect ? rect.Bottom - rect.Top : null
                    }
                };
            }
            catch
            {
                return new Dictionary<string, object?>
                {
                    ["hwnd"] = 0,
                    ["title"] = "",
                    ["bounds"] = null,
                    ["processName"] = "",
                    ["ownerHwnd"] = 0,
                    ["isTopmost"] = false,
                    ["isToolWindow"] = false,
                    ["isMinimized"] = false,
                    ["isMaximized"] = false,
                    ["windowKind"] = "main"
                };
            }
        }

        static string GetWindowTitle(IntPtr handle)
        {
            var sb = new StringBuilder(512);
            GetWindowText(handle, sb, sb.Capacity);
            return sb.ToString();
        }

        static string GetWindowClassName(IntPtr handle)
        {
            var sb = new StringBuilder(512);
            GetClassName(handle, sb, sb.Capacity);
            return sb.ToString();
        }

        static IntPtr GetWindowStyle(IntPtr handle, int index)
        {
            return IntPtr.Size == 8
                ? GetWindowLongPtr64(handle, index)
                : GetWindowLongPtr32(handle, index);
        }

        static string NormalizeProcessName(string value)
        {
            return (value ?? "")
                .Trim()
                .ToLowerInvariant()
                .Replace(".exe", "")
                .Replace(" ", "")
                .Replace("-", "")
                .Replace("_", "");
        }

        static string GetProcessName(uint processId)
        {
            if (processId == 0) return "";
            try
            {
                return Process.GetProcessById((int)processId).ProcessName ?? "";
            }
            catch
            {
                return "";
            }
        }

        /// <summary>
        /// Walk the focused window tree, returning elements in the same shape
        /// as the PowerShell UIWatcher (id, name, type, automationId, className,
        /// windowHandle, bounds, center, isEnabled).
        /// </summary>
        static List<Dictionary<string, object?>> WalkFocusedWindowElements()
        {
            var results = new List<Dictionary<string, object?>>();

            AutomationElement? win = _subscribedWindow;
            if (win == null)
            {
                try
                {
                    IntPtr fgHwnd = GetForegroundWindow();
                    if (fgHwnd != IntPtr.Zero)
                        win = AutomationElement.FromHandle(fgHwnd);
                }
                catch { return results; }
            }
            if (win == null) return results;

            int rootHwnd = 0;
            try { rootHwnd = win.Current.NativeWindowHandle; } catch { }

            try
            {
                var all = win.FindAll(TreeScope.Descendants, System.Windows.Automation.Condition.TrueCondition);
                int count = 0;
                foreach (AutomationElement el in all)
                {
                    if (count >= MaxWalkElements) break;
                    var light = BuildLightElement(el, rootHwnd);
                    if (light != null) { results.Add(light); count++; }
                }
            }
            catch (ElementNotAvailableException) { /* window vanished */ }

            return results;
        }

        /// <summary>
        /// Build a lightweight element matching the PowerShell UIWatcher format exactly.
        /// Returns null for elements with no useful info or zero-size bounds.
        /// </summary>
        static Dictionary<string, object?>? BuildLightElement(AutomationElement el, int rootHwnd)
        {
            try
            {
                var rect = el.Current.BoundingRectangle;
                if (rect.Width <= 0 || rect.Height <= 0) return null;
                if (rect.X < -10000 || rect.Y < -10000) return null;

                string name = el.Current.Name ?? "";
                name = name.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ");

                string ctrlType = el.Current.ControlType.ProgrammaticName.Replace("ControlType.", "");
                string autoId = el.Current.AutomationId ?? "";
                autoId = autoId.Replace("\r", " ").Replace("\n", " ").Replace("\t", " ");

                // Skip elements with no useful identifying info (same filter as PS watcher)
                if (string.IsNullOrWhiteSpace(name) && string.IsNullOrWhiteSpace(autoId)) return null;

                int x = (int)rect.X, y = (int)rect.Y;
                int w = (int)rect.Width, h = (int)rect.Height;

                return new Dictionary<string, object?>
                {
                    ["id"] = $"{ctrlType}|{name}|{autoId}|{x}|{y}",
                    ["name"] = name,
                    ["type"] = ctrlType,
                    ["automationId"] = autoId,
                    ["className"] = el.Current.ClassName,
                    ["windowHandle"] = rootHwnd,
                    ["bounds"] = new Dictionary<string, int> { ["x"] = x, ["y"] = y, ["width"] = w, ["height"] = h },
                    ["center"] = new Dictionary<string, int> { ["x"] = x + w / 2, ["y"] = y + h / 2 },
                    ["isEnabled"] = el.Current.IsEnabled
                };
            }
            catch (ElementNotAvailableException) { return null; }
            catch { return null; }
        }

        static Dictionary<string, object?>? GetActiveWindowInfo()
        {
            try
            {
                IntPtr hwnd = GetForegroundWindow();
                if (hwnd == IntPtr.Zero) return null;
                var win = AutomationElement.FromHandle(hwnd);
                return BuildWindowInfo(win);
            }
            catch { return null; }
        }

        // ── End Phase 4 ─────────────────────────────────────────────────────
        static string GetStringOption(JsonElement root, string propertyName, string fallback)
        {
            try
            {
                return root.TryGetProperty(propertyName, out var prop)
                    ? prop.GetString() ?? fallback
                    : fallback;
            }
            catch { return fallback; }
        }

        static int GetIntOption(JsonElement root, string propertyName, int fallback)
        {
            try
            {
                if (!root.TryGetProperty(propertyName, out var prop)) return fallback;
                if (prop.ValueKind == JsonValueKind.Number && prop.TryGetInt32(out int value)) return value;
                if (prop.ValueKind == JsonValueKind.String && int.TryParse(prop.GetString(), out value)) return value;
                return fallback;
            }
            catch { return fallback; }
        }

        static bool GetBoolOption(JsonElement root, string propertyName, bool fallback)
        {
            try
            {
                if (!root.TryGetProperty(propertyName, out var prop)) return fallback;
                if (prop.ValueKind == JsonValueKind.True) return true;
                if (prop.ValueKind == JsonValueKind.False) return false;
                if (prop.ValueKind == JsonValueKind.String && bool.TryParse(prop.GetString(), out bool value)) return value;
                return fallback;
            }
            catch { return fallback; }
        }

        static int ClampInt(int value, int min, int max)
        {
            return Math.Max(min, Math.Min(max, value));
        }

        static Dictionary<string, double>? TryGetBoundsOption(JsonElement root)
        {
            try
            {
                if (!root.TryGetProperty("bounds", out var prop) || prop.ValueKind != JsonValueKind.Object)
                    return null;

                double x = prop.TryGetProperty("x", out var xProp) ? xProp.GetDouble() : 0;
                double y = prop.TryGetProperty("y", out var yProp) ? yProp.GetDouble() : 0;
                double width = prop.TryGetProperty("width", out var widthProp) ? widthProp.GetDouble() : 0;
                double height = prop.TryGetProperty("height", out var heightProp) ? heightProp.GetDouble() : 0;
                if (width <= 0 || height <= 0) return null;

                return new Dictionary<string, double>
                {
                    ["x"] = x,
                    ["y"] = y,
                    ["width"] = width,
                    ["height"] = height
                };
            }
            catch { return null; }
        }

        static bool ElementMatchesFindOptions(
            AutomationElement el,
            string text,
            string textMode,
            Regex? regex,
            string controlType,
            bool includeOffscreen,
            bool includeDisabled,
            Dictionary<string, double>? bounds)
        {
            var current = el.Current;
            string elementControlType = current.ControlType.ProgrammaticName.Replace("ControlType.", "");

            if (!string.IsNullOrWhiteSpace(controlType)
                && !string.Equals(elementControlType, controlType, StringComparison.OrdinalIgnoreCase)
                && !current.ControlType.ProgrammaticName.EndsWith("." + controlType, StringComparison.OrdinalIgnoreCase))
            {
                return false;
            }

            if (!includeOffscreen && current.IsOffscreen) return false;
            if (!includeDisabled && !current.IsEnabled) return false;

            var rect = current.BoundingRectangle;
            if (!IsUsableRect(rect)) return false;
            if (bounds != null && !RectIntersects(rect, bounds)) return false;

            if (string.IsNullOrWhiteSpace(text)) return true;

            string currentValue = "";
            try
            {
                object value = el.GetCurrentPropertyValue(ValuePattern.ValueProperty);
                if (value != AutomationElement.NotSupported)
                    currentValue = value?.ToString() ?? "";
            }
            catch { currentValue = ""; }

            string haystack = string.Join(" ", new[]
            {
                current.Name ?? "",
                currentValue,
                current.AutomationId ?? "",
                current.ClassName ?? "",
                elementControlType
            }).Trim();

            if (string.IsNullOrWhiteSpace(haystack)) return false;

            if (textMode == "exact")
            {
                return string.Equals(current.Name ?? "", text, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(currentValue, text, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(current.AutomationId ?? "", text, StringComparison.OrdinalIgnoreCase)
                    || string.Equals(current.ClassName ?? "", text, StringComparison.OrdinalIgnoreCase);
            }

            if (textMode == "regex" && regex != null)
            {
                return regex.IsMatch(haystack);
            }

            return haystack.IndexOf(text, StringComparison.OrdinalIgnoreCase) >= 0;
        }

        static bool IsUsableRect(Rect rect)
        {
            if (rect.Width <= 0 || rect.Height <= 0) return false;
            if (!double.IsFinite(rect.X) || !double.IsFinite(rect.Y)) return false;
            if (!double.IsFinite(rect.Width) || !double.IsFinite(rect.Height)) return false;
            if (rect.X < -10000 || rect.Y < -10000) return false;
            return true;
        }

        static bool RectIntersects(Rect rect, Dictionary<string, double> bounds)
        {
            double bx = bounds["x"];
            double by = bounds["y"];
            double bw = bounds["width"];
            double bh = bounds["height"];
            return rect.X < bx + bw
                && rect.X + rect.Width > bx
                && rect.Y < by + bh
                && rect.Y + rect.Height > by;
        }

        static TreeWalker ResolveTreeWalker(string view)
        {
            string normalized = String.IsNullOrWhiteSpace(view)
                ? "control"
                : view.Trim().ToLowerInvariant();
            return normalized switch
            {
                "raw" => TreeWalker.RawViewWalker,
                "content" => TreeWalker.ContentViewWalker,
                _ => TreeWalker.ControlViewWalker
            };
        }

        static AutomationElement? FindFirstMatchingElement(
            AutomationElement root,
            string text,
            string textMode,
            Regex? regex,
            string controlType,
            bool includeOffscreen,
            bool includeDisabled,
            Dictionary<string, double>? bounds,
            int maxDepth,
            int maxVisited,
            int timeoutMs,
            Stopwatch started,
            string view,
            out int visited,
            out bool timedOut,
            out bool visitedLimitHit,
            out bool depthLimitHit)
        {
            visited = 0;
            timedOut = false;
            visitedLimitHit = false;
            depthLimitHit = false;

            var walker = ResolveTreeWalker(view);
            var stack = new Stack<(AutomationElement Element, int Depth)>();
            stack.Push((root, 0));

            while (stack.Count > 0)
            {
                if (started.ElapsedMilliseconds >= timeoutMs)
                {
                    timedOut = true;
                    return null;
                }

                if (visited >= maxVisited)
                {
                    visitedLimitHit = true;
                    return null;
                }

                var current = stack.Pop();
                visited++;

                try
                {
                    if (ElementMatchesFindOptions(
                        current.Element,
                        text,
                        textMode,
                        regex,
                        controlType,
                        includeOffscreen,
                        includeDisabled,
                        bounds))
                    {
                        return current.Element;
                    }
                }
                catch (ElementNotAvailableException) { continue; }
                catch { }

                if (current.Depth >= maxDepth)
                {
                    depthLimitHit = true;
                    continue;
                }

                var children = new List<AutomationElement>();
                try
                {
                    var child = walker.GetFirstChild(current.Element);
                    while (child != null)
                    {
                        children.Add(child);
                        child = walker.GetNextSibling(child);
                        if (started.ElapsedMilliseconds >= timeoutMs)
                        {
                            timedOut = true;
                            break;
                        }
                    }
                }
                catch (ElementNotAvailableException) { }
                catch { }

                for (int i = children.Count - 1; i >= 0; i--)
                {
                    stack.Push((children[i], current.Depth + 1));
                }

                if (timedOut) return null;
            }

            return null;
        }

        static string InvokeSemanticPattern(AutomationElement el)
        {
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsInvokePatternAvailableProperty))
            {
                var invokePattern = (InvokePattern)el.GetCurrentPattern(InvokePattern.Pattern);
                invokePattern.Invoke();
                return "Invoke";
            }

            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsTogglePatternAvailableProperty))
            {
                var togglePattern = (TogglePattern)el.GetCurrentPattern(TogglePattern.Pattern);
                togglePattern.Toggle();
                return "Toggle";
            }

            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsSelectionItemPatternAvailableProperty))
            {
                var selectionPattern = (SelectionItemPattern)el.GetCurrentPattern(SelectionItemPattern.Pattern);
                selectionPattern.Select();
                return "SelectionItem";
            }

            throw new InvalidOperationException("Element does not expose Invoke, Toggle, or SelectionItem pattern");
        }

        static Dictionary<string, object?> BuildFindElementPayload(AutomationElement el, IntPtr rootHwnd, int depth)
        {
            var payload = BuildRichElement(el);
            var rect = el.Current.BoundingRectangle;
            payload["ControlType"] = el.Current.ControlType.ProgrammaticName;
            payload["Name"] = el.Current.Name;
            payload["AutomationId"] = el.Current.AutomationId;
            payload["ClassName"] = el.Current.ClassName;
            payload["WindowHandle"] = rootHwnd.ToInt64();
            payload["NativeWindowHandle"] = el.Current.NativeWindowHandle;
            payload["Patterns"] = payload.TryGetValue("patterns", out var patterns) ? patterns : GetPatternNames(el);
            payload["depth"] = depth;
            payload["Bounds"] = new Dictionary<string, double?>
            {
                ["X"] = SafeNumber(rect.X),
                ["Y"] = SafeNumber(rect.Y),
                ["Width"] = SafeNumber(rect.Width),
                ["Height"] = SafeNumber(rect.Height),
                ["CenterX"] = SafeNumber(rect.X + rect.Width / 2),
                ["CenterY"] = SafeNumber(rect.Y + rect.Height / 2)
            };
            try { payload["isFocusable"] = el.Current.IsKeyboardFocusable; } catch { payload["isFocusable"] = false; }
            payload["isClickable"] = payload.TryGetValue("clickPoint", out var point) && point != null
                || (payload.TryGetValue("patterns", out var patternList)
                    && patternList is List<string> names
                    && names.Any(pattern => string.Equals(pattern, "Invoke", StringComparison.OrdinalIgnoreCase)));
            return payload;
        }

        static List<string> GetPatternNames(AutomationElement el)
        {
            var patterns = new List<string>();
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsInvokePatternAvailableProperty)) patterns.Add("Invoke");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsValuePatternAvailableProperty)) patterns.Add("Value");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsTogglePatternAvailableProperty)) patterns.Add("Toggle");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsSelectionItemPatternAvailableProperty)) patterns.Add("SelectionItem");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty)) patterns.Add("ExpandCollapse");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsScrollPatternAvailableProperty)) patterns.Add("Scroll");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsTextPatternAvailableProperty)) patterns.Add("Text");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsWindowPatternAvailableProperty)) patterns.Add("Window");
            return patterns;
        }

        // ── Rich element payload (Phase 2) ───────────────────────────────────
        static Dictionary<string, object?> BuildRichElement(AutomationElement el)
        {
            var rect = el.Current.BoundingRectangle;
            var result = new Dictionary<string, object?>
            {
                ["name"] = el.Current.Name,
                ["automationId"] = el.Current.AutomationId,
                ["className"] = el.Current.ClassName,
                ["role"] = el.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""),
                ["bounds"] = new Dictionary<string, double?>
                {
                    ["x"] = SafeNumber(rect.X),
                    ["y"] = SafeNumber(rect.Y),
                    ["width"] = SafeNumber(rect.Width),
                    ["height"] = SafeNumber(rect.Height)
                },
                ["isEnabled"] = el.Current.IsEnabled,
                ["isOffscreen"] = el.Current.IsOffscreen,
                ["hasKeyboardFocus"] = el.Current.HasKeyboardFocus,
                ["nativeWindowHandle"] = el.Current.NativeWindowHandle
            };

            // RuntimeId — session-scoped stable identity
            try
            {
                int[] rid = el.GetRuntimeId();
                result["runtimeId"] = rid;
            }
            catch { result["runtimeId"] = null; }

            // TryGetClickablePoint — preferred click target
            try
            {
                if (el.TryGetClickablePoint(out Point pt))
                {
                    result["clickPoint"] = new Dictionary<string, double>
                    {
                        ["x"] = pt.X,
                        ["y"] = pt.Y
                    };
                }
                else
                {
                    result["clickPoint"] = null;
                }
            }
            catch { result["clickPoint"] = null; }

            // Value (if available)
            try
            {
                object val = el.GetCurrentPropertyValue(ValuePattern.ValueProperty);
                result["value"] = val?.ToString();
            }
            catch { result["value"] = null; }

            // Supported patterns (names only — avoids expensive GetSupportedPatterns())
            var patterns = new List<string>();
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsInvokePatternAvailableProperty)) patterns.Add("Invoke");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsValuePatternAvailableProperty)) patterns.Add("Value");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsTogglePatternAvailableProperty)) patterns.Add("Toggle");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsSelectionItemPatternAvailableProperty)) patterns.Add("SelectionItem");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsExpandCollapsePatternAvailableProperty)) patterns.Add("ExpandCollapse");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsScrollPatternAvailableProperty)) patterns.Add("Scroll");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsTextPatternAvailableProperty)) patterns.Add("Text");
            if ((bool)el.GetCurrentPropertyValue(AutomationElement.IsWindowPatternAvailableProperty)) patterns.Add("Window");
            result["patterns"] = patterns;

            return result;
        }

        // ── Tree builder (legacy path, unchanged shape) ──────────────────────
        static UIANode BuildTree(AutomationElement element)
        {
            var rectangle = element.Current.BoundingRectangle;
            var node = new UIANode
            {
                id = element.Current.AutomationId,
                name = element.Current.Name,
                role = element.Current.ControlType.ProgrammaticName.Replace("ControlType.", ""),
                bounds = new Bounds
                {
                    x = SafeNumber(rectangle.X),
                    y = SafeNumber(rectangle.Y),
                    width = SafeNumber(rectangle.Width),
                    height = SafeNumber(rectangle.Height)
                },
                isClickable = (bool)element.GetCurrentPropertyValue(AutomationElement.IsInvokePatternAvailableProperty) || element.Current.IsKeyboardFocusable,
                isFocusable = element.Current.IsKeyboardFocusable,
                children = new List<UIANode>()
            };

            var walker = TreeWalker.ControlViewWalker;
            var child = walker.GetFirstChild(element);
            while (child != null)
            {
                try
                {
                    if (!child.Current.IsOffscreen)
                    {
                        node.children.Add(BuildTree(child));
                    }
                }
                catch (ElementNotAvailableException) { }

                child = walker.GetNextSibling(child);
            }

            return node;
        }

        static double? SafeNumber(double value)
        {
            return double.IsFinite(value) ? value : null;
        }
    }

    class UIANode
    {
        public string id { get; set; } = "";
        public string name { get; set; } = "";
        public string role { get; set; } = "";
        public Bounds bounds { get; set; } = new();
        public bool isClickable { get; set; }
        public bool isFocusable { get; set; }
        public List<UIANode> children { get; set; } = new();
    }

    class Bounds
    {
        public double? x { get; set; }
        public double? y { get; set; }
        public double? width { get; set; }
        public double? height { get; set; }
    }
}
