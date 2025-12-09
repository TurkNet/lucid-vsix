using EnvDTE;
using Microsoft.VisualStudio.Shell;
using Microsoft.Web.WebView2.Core;
using Microsoft.Web.WebView2.Wpf;
using System;
using System.Collections.Generic;
using System.IO;
using System.Linq;
using System.Net.Http;
using System.Text;
using System.Text.Json;
using System.Threading.Tasks;
using System.Windows;
using System.Windows.Controls;

namespace Lucid.VisualStudioExtension
{
    public class LucidToolWindowControl : UserControl
    {
        private readonly WebView2 _webView;
        private readonly HashSet<string> _attached = new HashSet<string>(StringComparer.OrdinalIgnoreCase);
        private readonly HttpClient _httpClient = new HttpClient();
        private string? _solutionRoot;
        private bool _initialized;

        public LucidToolWindowControl()
        {
            _webView = new WebView2();
            Content = _webView;
            Loaded += OnLoaded;
        }

        private async void OnLoaded(object sender, RoutedEventArgs e)
        {
            if (_initialized) return;
            _initialized = true;
            await InitializeWebViewAsync();
            await ResolveSolutionRootAsync();
        }

        private async Task InitializeWebViewAsync()
        {
            await _webView.EnsureCoreWebView2Async();
            _webView.CoreWebView2.WebMessageReceived += OnWebMessageReceived;
            _webView.CoreWebView2.Settings.IsWebMessageEnabled = true;

            var html = await LoadSharedHtmlAsync();
            _webView.NavigateToString(html);
        }

        private async Task<string> LoadSharedHtmlAsync()
        {
            try
            {
                // Use the shared UI template so VS Code and Visual Studio stay in sync.
                var assemblyDir = Path.GetDirectoryName(typeof(LucidToolWindowControl).Assembly.Location) ?? string.Empty;
                var dir = new DirectoryInfo(assemblyDir);
                string? templatePath = null;
                for (var i = 0; i < 5 && dir != null; i++)
                {
                    var candidate = Path.Combine(dir.FullName, "common", "html", "ui.html");
                    if (File.Exists(candidate))
                    {
                        templatePath = candidate;
                        break;
                    }
                    dir = dir.Parent;
                }

                if (string.IsNullOrWhiteSpace(templatePath)) return "<body><pre>Lucid UI template not found.</pre></body>";

                var raw = File.ReadAllText(templatePath, Encoding.UTF8);
                var nonce = Guid.NewGuid().ToString("N");
                // WebView2 does not enforce the CSP placeholders; keep it simple.
                return raw.Replace("__NONCE__", nonce).Replace("__CSP_META__", string.Empty);
            }
            catch (Exception ex)
            {
                return $"<body><pre>Failed to load Lucid UI: {ex}</pre></body>";
            }
        }

        private async Task ResolveSolutionRootAsync()
        {
            await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
            try
            {
                if (LucidVsPackage.Instance == null) return;
                var dte = await LucidVsPackage.Instance.GetServiceAsync(typeof(DTE)) as DTE;
                if (dte?.Solution != null && !string.IsNullOrWhiteSpace(dte.Solution.FullName))
                {
                    _solutionRoot = Path.GetDirectoryName(dte.Solution.FullName);
                    var solutionName = Path.GetFileNameWithoutExtension(dte.Solution.FullName);
                    PostMessage(new { type = "editor", text = solutionName });
                }
            }
            catch (Exception ex)
            {
                PostMessage(new { type = "error", text = $"Failed to locate solution: {ex.Message}" });
            }
        }

        private void OnWebMessageReceived(object? sender, CoreWebView2WebMessageReceivedEventArgs e)
        {
            var json = e.WebMessageAsJson;
            if (string.IsNullOrWhiteSpace(json))
            {
                json = e.TryGetWebMessageAsString();
            }

            if (string.IsNullOrWhiteSpace(json)) return;
            try
            {
                using var doc = JsonDocument.Parse(json);
                if (!doc.RootElement.TryGetProperty("type", out var typeProp)) return;
                var type = typeProp.GetString() ?? string.Empty;
                switch (type)
                {
                    case "requestFiles":
                        _ = SendFileListAsync();
                        break;
                    case "attach":
                        if (doc.RootElement.TryGetProperty("path", out var attachPath))
                        {
                            AddAttachment(attachPath.GetString());
                        }
                        break;
                    case "detach":
                        if (doc.RootElement.TryGetProperty("path", out var detachPath))
                        {
                            RemoveAttachment(detachPath.GetString());
                        }
                        break;
                    case "send":
                        if (doc.RootElement.TryGetProperty("prompt", out var promptProp))
                        {
                            _ = SendPromptAsync(promptProp.GetString() ?? string.Empty);
                        }
                        break;
                    case "replay":
                        if (doc.RootElement.TryGetProperty("prompt", out var replayProp))
                        {
                            _ = SendPromptAsync(replayProp.GetString() ?? string.Empty);
                        }
                        break;
                    case "error":
                        if (doc.RootElement.TryGetProperty("text", out var errProp))
                        {
                            PostMessage(new { type = "error", text = errProp.GetString() });
                        }
                        break;
                }
            }
            catch (Exception ex)
            {
                PostMessage(new { type = "error", text = $"Host message error: {ex.Message}" });
            }
        }

        private void AddAttachment(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            if (!File.Exists(path)) return;
            _attached.Add(path);
            PostMessage(new { type = "attachedChanged", files = _attached.ToArray() });
        }

        private void RemoveAttachment(string? path)
        {
            if (string.IsNullOrWhiteSpace(path)) return;
            _attached.Remove(path);
            PostMessage(new { type = "attachedChanged", files = _attached.ToArray() });
        }

        private async Task SendFileListAsync()
        {
            try
            {
                var files = FindWorkspaceFiles();
                var payload = files.Select(f => new { path = f, name = Path.GetFileName(f) }).ToArray();
                PostMessage(new { type = "fileList", files = payload });
                PostMessage(new { type = "attachedChanged", files = _attached.ToArray() });
            }
            catch (Exception ex)
            {
                PostMessage(new { type = "error", text = $"File listing failed: {ex.Message}" });
            }
        }

        private IEnumerable<string> FindWorkspaceFiles()
        {
            if (string.IsNullOrWhiteSpace(_solutionRoot) || !Directory.Exists(_solutionRoot))
            {
                return Array.Empty<string>();
            }

            var ignored = new[] { $"{Path.DirectorySeparatorChar}bin{Path.DirectorySeparatorChar}", $"{Path.DirectorySeparatorChar}obj{Path.DirectorySeparatorChar}", $"{Path.DirectorySeparatorChar}.git{Path.DirectorySeparatorChar}", $"{Path.DirectorySeparatorChar}node_modules{Path.DirectorySeparatorChar}", $"{Path.DirectorySeparatorChar}.vs{Path.DirectorySeparatorChar}" };
            var results = new List<string>();

            foreach (var file in Directory.EnumerateFiles(_solutionRoot, "*", SearchOption.AllDirectories))
            {
                try
                {
                    if (ignored.Any(i => file.IndexOf(i, StringComparison.OrdinalIgnoreCase) >= 0)) continue;
                    results.Add(file);
                    if (results.Count >= 400) break;
                }
                catch
                {
                    // continue on IO errors
                }
            }

            return results;
        }

        private async Task<string> BuildPromptAsync(string prompt)
        {
            var sb = new StringBuilder();

            if (_attached.Count > 0)
            {
                foreach (var path in _attached)
                {
                    try
                    {
                        var text = File.ReadAllText(path);
                        var name = Path.GetFileName(path);
                        sb.AppendLine($"--- ATTACHED: {name} ---");
                        sb.AppendLine(text);
                        sb.AppendLine($"--- END ATTACHED ---");
                        sb.AppendLine();
                    }
                    catch (Exception ex)
                    {
                        PostMessage(new { type = "error", text = $"Failed to read {path}: {ex.Message}" });
                    }
                }
            }
            else
            {
                // Fallback to active document contents if no explicit attachments exist.
                try
                {
                    await ThreadHelper.JoinableTaskFactory.SwitchToMainThreadAsync();
                    if (LucidVsPackage.Instance != null)
                    {
                        var dte = await LucidVsPackage.Instance.GetServiceAsync(typeof(DTE)) as DTE;
                        var doc = dte?.ActiveDocument;
                        if (doc?.Object("TextDocument") is TextDocument textDoc)
                        {
                            var editPoint = textDoc.StartPoint.CreateEditPoint();
                            var body = editPoint.GetText(textDoc.EndPoint);
                            var name = Path.GetFileName(doc.FullName);
                            sb.AppendLine($"--- ACTIVE EDITOR: {name} ---");
                            sb.AppendLine(body);
                            sb.AppendLine("--- END ACTIVE EDITOR ---");
                            sb.AppendLine();
                        }
                    }
                }
                catch
                {
                    // ignore fallback failures
                }
            }

            sb.AppendLine(prompt);
            return sb.ToString();
        }

        private async Task SendPromptAsync(string prompt)
        {
            var trimmed = prompt?.Trim();
            if (string.IsNullOrWhiteSpace(trimmed)) return;

            PostMessage(new { type = "status", text = "Sending prompt…", streaming = true });

            var combined = await BuildPromptAsync(trimmed);
            var endpoint = LucidSettings.Endpoint;
            var model = LucidSettings.ModelName;
            var headers = LucidSettings.BuildHeaders();
            var streamingEnabled = LucidSettings.ShowStreamingStatus;

            var payload = new
            {
                model = model,
                messages = new[] { new { role = "user", content = combined } },
                stream = streamingEnabled
            };

            try
            {
                var request = new HttpRequestMessage(HttpMethod.Post, endpoint)
                {
                    Content = new StringContent(JsonSerializer.Serialize(payload), Encoding.UTF8, "application/json")
                };
                foreach (var kv in headers)
                {
                    request.Headers.TryAddWithoutValidation(kv.Key, kv.Value);
                }

                var response = await _httpClient.SendAsync(request, HttpCompletionOption.ResponseHeadersRead);
                if (!response.IsSuccessStatusCode)
                {
                    var err = await response.Content.ReadAsStringAsync();
                    PostMessage(new { type = "error", text = $"Ollama error {response.StatusCode}: {err}" });
                    PostMessage(new { type = "status", text = "Ollama request failed", streaming = false });
                    return;
                }

                using var stream = await response.Content.ReadAsStreamAsync();
                using var reader = new StreamReader(stream);

                while (!reader.EndOfStream)
                {
                    var line = await reader.ReadLineAsync();
                    if (string.IsNullOrWhiteSpace(line)) continue;
                    var text = ParseAssistantText(line);
                    if (!string.IsNullOrEmpty(text))
                    {
                        PostMessage(new { type = "append", text, role = "assistant" });
                    }
                }

                PostMessage(new { type = "status", text = "Idle", streaming = false });
            }
            catch (Exception ex)
            {
                PostMessage(new { type = "error", text = $"Request failed: {ex.Message}" });
                PostMessage(new { type = "status", text = "Error", level = "error", streaming = false });
            }
        }

        private static string ParseAssistantText(string line)
        {
            try
            {
                using var doc = JsonDocument.Parse(line);
                var root = doc.RootElement;
                if (root.TryGetProperty("response", out var response) && response.ValueKind == JsonValueKind.String)
                    return response.GetString() ?? string.Empty;

                if (root.TryGetProperty("message", out var message) &&
                    message.ValueKind == JsonValueKind.Object &&
                    message.TryGetProperty("content", out var content) &&
                    content.ValueKind == JsonValueKind.String)
                {
                    return content.GetString() ?? string.Empty;
                }

                if (root.TryGetProperty("choices", out var choices) && choices.ValueKind == JsonValueKind.Array)
                {
                    var sb = new StringBuilder();
                    foreach (var choice in choices.EnumerateArray())
                    {
                        if (choice.TryGetProperty("message", out var msg) && msg.TryGetProperty("content", out var msgContent) && msgContent.ValueKind == JsonValueKind.String)
                        {
                            sb.Append(msgContent.GetString());
                        }
                        else if (choice.TryGetProperty("text", out var textProp) && textProp.ValueKind == JsonValueKind.String)
                        {
                            sb.Append(textProp.GetString());
                        }
                        else if (choice.TryGetProperty("delta", out var delta) && delta.TryGetProperty("content", out var deltaContent) && deltaContent.ValueKind == JsonValueKind.String)
                        {
                            sb.Append(deltaContent.GetString());
                        }
                    }
                    return sb.ToString();
                }

                if (root.ValueKind == JsonValueKind.String)
                {
                    return root.GetString() ?? string.Empty;
                }
            }
            catch
            {
                // fall through to raw text
            }

            return line;
        }

        private void PostMessage(object payload)
        {
            try
            {
                if (_webView?.CoreWebView2 == null) return;
                var json = JsonSerializer.Serialize(payload);
                _webView.CoreWebView2.PostWebMessageAsJson(json);
            }
            catch
            {
                // ignore post failures in tooling mode
            }
        }
    }

    internal static class LucidSettings
    {
        public static string Endpoint =>
            Environment.GetEnvironmentVariable("OLLAMA_ENDPOINT") ??
            Environment.GetEnvironmentVariable("LUCID_OLLAMA_ENDPOINT") ??
            "http://localhost:11434";

        public static string ModelName =>
            Environment.GetEnvironmentVariable("OLLAMA_MODEL") ??
            Environment.GetEnvironmentVariable("LUCID_MODEL") ??
            "llama3";

        public static bool ShowStreamingStatus =>
            !string.Equals(Environment.GetEnvironmentVariable("LUCID_ENABLE_STREAMING_STATUS"), "false", StringComparison.OrdinalIgnoreCase);

        public static Dictionary<string, string> BuildHeaders()
        {
            var headers = new Dictionary<string, string>(StringComparer.OrdinalIgnoreCase)
            {
                { "Content-Type", "application/json" }
            };

            var apiKey = Environment.GetEnvironmentVariable("OLLAMA_API_KEY") ??
                         Environment.GetEnvironmentVariable("LUCID_OLLAMA_API_KEY");
            var apiKeyHeader = Environment.GetEnvironmentVariable("OLLAMA_API_KEY_HEADER_NAME") ??
                               Environment.GetEnvironmentVariable("LUCID_OLLAMA_API_KEY_HEADER_NAME") ??
                               "Authorization";
            if (!string.IsNullOrWhiteSpace(apiKey))
            {
                headers[apiKeyHeader] = apiKey;
            }

            var extraHeadersJson = Environment.GetEnvironmentVariable("OLLAMA_EXTRA_HEADERS") ??
                                   Environment.GetEnvironmentVariable("LUCID_OLLAMA_EXTRA_HEADERS");
            if (!string.IsNullOrWhiteSpace(extraHeadersJson))
            {
                try
                {
                    var doc = JsonDocument.Parse(extraHeadersJson);
                    if (doc.RootElement.ValueKind == JsonValueKind.Object)
                    {
                        foreach (var prop in doc.RootElement.EnumerateObject())
                        {
                            headers[prop.Name] = prop.Value.GetString() ?? string.Empty;
                        }
                    }
                }
                catch
                {
                    // ignore malformed extra headers
                }
            }

            return headers;
        }
    }
}
