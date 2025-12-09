# 🧠 Lucid-VSX: Local Ollama Integration for VS Code

This project provides a Copilot-like experience within VS Code using a local or network Ollama API. The extension supports both Chat Participant (chat) and inline code completion (ghost text) features.

## 🚀 Quick Start

1. Install dependencies:

```bash
npm install
```

2. Compile:

```bash
npm run compile
```

3. Development / Debug (Extension Development Host):

- After opening the project in VS Code, press `F5`. A new VS Code window (Extension Development Host) will open with the extension loaded.

4. Configure settings (in development host or normal VS Code settings):

```json
{
  "lucid.ollamaEndpoint": "http://<OLLAMA_HOST>:11434",
  "lucid.ollamaApiKey": "llm-...",
  "lucid.ollamaExtraHeaders": { "X-Request-Source": "post_text_script" },
  "lucid.enableInlineCompletion": true,
  "lucid.logUnmaskedHeaders": false,
  "lucid.enableStreamingStatus": false,
  "lucid.ollamaApiKeyHeaderName": ""
}
```

Configuration settings (detailed)

Below are the primary configuration options you can set in VS Code's Settings (`settings.json`) or via environment variables where noted. Each entry includes the default value and a short explanation with examples.

- `lucid.ollamaEndpoint` (string) — Default: `"http://<OLLAMA_HOST>:11434"`
  - Description: The HTTP endpoint for your Ollama API. Include host and port as appropriate.
  - Example: `"http://localhost:11434"` or `"http://10.0.0.5:11434"`.

- `lucid.ollamaApiKey` (string) — Default: `""` (empty)
  - Description: Optional API key used to authenticate requests to Ollama. You can alternatively supply the key via the `OLLAMA_API_KEY` environment variable.
  - Example: `"llm-xxxxxxxxxxxx"`.

- `lucid.ollamaApiKeyHeaderName` (string) — Default: `"Authorization"`
  - Description: The header name to use when sending the API key. Some deployments or proxies expect a custom header name (for example `X-API-Key`). The extension will add this header with the value from `lucid.ollamaApiKey` or `OLLAMA_API_KEY`.
  - Example: `"X-API-Key"` or `"Authorization"`.

- `lucid.ollamaExtraHeaders` (object) — Default: `{}`
  - Description: Additional HTTP headers to send with each request to Ollama. This can be used for tracing, routing, or proxy requirements.
  - Environment variable alternative: `OLLAMA_EXTRA_HEADERS` (JSON string).
  - Example: `{ "X-Request-Source": "post_text_script", "X-Tenant-Id": "tenant-123" }`.

- `lucid.enableInlineCompletion` (boolean) — Default: `true`
  - Description: Enable inline (ghost text) code completions within the editor. When enabled, the extension may present inline suggestions drawn from the configured Ollama model.

- `lucid.logUnmaskedHeaders` (boolean) — Default: `false`
  - Description: When `true`, sensitive headers such as the API key will be logged in full within the extension logs. This is useful for debugging but should be disabled in production environments.

- `lucid.logUnmaskedHeadersInDev` (boolean) — Default: `true`
  - Description: Allow unmasked header logging when the extension runs in development mode (e.g., when launched from the Extension Development Host). This provides a safer default for day-to-day development while keeping production logs sanitized.

- `lucid.enableStreamingStatus` (boolean) — Default: `false`
  - Description: Controls whether the chat view shows a streaming status indicator (spinner and disabled send button) while receiving chunked/streaming responses from Ollama. Enable this if you want a visual streaming indicator in the webview.

Notes:
- The extension always sets `Content-Type: application/json` on requests unless overridden in `lucid.ollamaExtraHeaders`.
- If you use environment variables (`OLLAMA_API_KEY`, `OLLAMA_EXTRA_HEADERS`), the extension will prefer explicit settings in `settings.json` when present.


5. Using the extension in a normal VS Code window (packaging):

```bash
npm run compile
npm install -g vsce
vsce package
# install the generated .vsix
code --install-extension lucid-vsx-x.x.x.vsix
```

## 🕹️ Ask vs Action Modes

- Switch between `Ask` (plain chat) and `Action` (request executable steps) via the dropdown under the chat input.
- `Action` responses must include a JSON block with at least a `command` plus optional `args`, `type` (`vscode` | `terminal` | `clipboard`), and `text` when copying to the clipboard.
- Lucid always shows the parsed payload and asks for confirmation before running it, then streams back an execution summary and validates the outcome with Ollama.

Examples:

```jsonc
// Run a VS Code command
{
  "command": "workbench.action.files.save"
}

// Execute a terminal step
{
  "command": "npm",
  "args": ["run", "test"],
  "type": "terminal"
}

// Copy generated text
{
  "command": "copy-to-clipboard",
  "type": "clipboard",
  "text": "git commit -am \"fix: address bug\""
}
```

## ✨ What's New Since The Last Commit

- **Persistent chat history:** every exchange (including action previews) is saved per workspace, so reopening the view restores the full thread and lets you replay prompts without losing context.
- **Mode-aware replays:** the `Ask/Action` choice is stored with each message, making replays use the original intent automatically and keeping your preferred mode between sessions.
- **Richer action previews:** toolbar buttons now let you run terminal commands, apply or insert suggested snippets, copy artifacts, and inspect the raw JSON payload without leaving the chat.
- **Safer terminal execution:** wrapper commands such as `terminal.runShellCommand` are stripped before execution so only the actual payload (e.g., `./set_version.sh`) is sent to the shell, preventing accidental wrapper text from running.
- **Stable UI state:** the chat panel no longer clears itself when hosts emit `type: "clear"` messages, so status banners and prior answers remain visible during debugging.

## ▶️ Run / Test

- Open the Chat panel in the development host (F5) window and chat with `@lucid`.
- To test code completion, type in any code file; if `lucid.enableInlineCompletion` is enabled, ghost text suggestions should appear.

## 🔐 Environment Variables and Headers

- `OLLAMA_EXTRA_HEADERS`: Additional headers in JSON format. Example:

```bash
export OLLAMA_EXTRA_HEADERS='{"X-Request-Source":"post_text_script"}'
```

- `OLLAMA_API_KEY`: API key (can also be provided via `lucid.ollamaApiKey` setting):

```bash
export OLLAMA_API_KEY='tn-llm-...'
```

The extension automatically adds the `Content-Type: application/json` header (if not specified in settings) and sends the API key with the `X-API-Key` header.

## 🌊 Stream / Chunk Test

Responses from Ollama can be in chunks (NDJSON or line-based). You can simulate streaming by running a test server within the project:

```js
// tiny-stream-server.js
const http = require("http");
http
  .createServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" });
    res.write(
      JSON.stringify({
        choices: [{ message: { role: "assistant", content: "Hello" } }],
      }) + "\n"
    );
    setTimeout(() => {
      res.write(
        JSON.stringify({
          choices: [
            {
              message: {
                role: "assistant",
                content: " How can I help you?",
              },
            },
          ],
        }) + "\n"
      );
      res.end();
    }, 500);
  })
  .listen(8089);

// run: node tiny-stream-server.js
```

You can test the extension with F5 by running this server and setting `lucid.ollamaEndpoint` to `http://localhost:8089`; incoming chunks will be displayed instantly.

## 📦 Packaging & Deployment

- Create a `.vsix` with `vsce package` and install it with `code --install-extension`.
- If you want to publish to the Marketplace, you can use `vsce publish` (update `package.json` metadata before publishing).

## 🐞 Debugging

- View logs in the Extension Development Host console: `Help → Toggle Developer Tools` or `Debug Console`.
- If the server returns a JSON parse error, the extension automatically adds `Content-Type: application/json`; if you still get an error, check the endpoint path and expected body format.

## 🛡️ Security Notes

- If you set `lucid.logUnmaskedHeaders` to `true`, sensitive headers (e.g., `X-API-Key`) will be clearly visible in the logs. Keep it disabled in Production.