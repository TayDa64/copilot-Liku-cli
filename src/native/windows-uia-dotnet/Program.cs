using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
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

        static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = false };

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
                        case "elementFromPoint":
                            HandleElementFromPoint(root);
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
                var rect = window.Current.BoundingRectangle;
                return new Dictionary<string, object?>
                {
                    ["hwnd"] = window.Current.NativeWindowHandle,
                    ["title"] = window.Current.Name,
                    ["processId"] = window.Current.ProcessId,
                    ["bounds"] = new Dictionary<string, double>
                    {
                        ["x"] = SafeNumber(rect.X),
                        ["y"] = SafeNumber(rect.Y),
                        ["width"] = SafeNumber(rect.Width),
                        ["height"] = SafeNumber(rect.Height)
                    }
                };
            }
            catch
            {
                return new Dictionary<string, object?> { ["hwnd"] = 0, ["title"] = "", ["bounds"] = null };
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
                ["bounds"] = new Dictionary<string, double>
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

        static double SafeNumber(double value)
        {
            return double.IsFinite(value) ? value : 0;
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
        public double x { get; set; }
        public double y { get; set; }
        public double width { get; set; }
        public double height { get; set; }
    }
}
