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
  "lucid.enableStreamingStatus": false
}
```

5. Using the extension in a normal VS Code window (packaging):

```bash
npm run compile
npm install -g vsce
vsce package
# install the generated .vsix
code --install-extension lucid-vsx-x.x.x.vsix
```

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