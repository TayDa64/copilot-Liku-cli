using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Runtime.InteropServices;
using System.Text.Json;
using System.Windows;
using System.Windows.Automation;

namespace UIAWrapper
{
    class Program
    {
        [DllImport("user32.dll")]
        static extern IntPtr GetForegroundWindow();

        static readonly JsonSerializerOptions JsonOpts = new() { WriteIndented = false };

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
            Console.WriteLine(JsonSerializer.Serialize(obj, JsonOpts));
            Console.Out.Flush();
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
