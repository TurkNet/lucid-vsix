import * as vscode from 'vscode';
import { CurlLogger } from './curlLogger';
import { LucidConfig } from './config';
import { LucidLogger } from './logger';

interface OllamaMessage {
  role: string;
  content: string;
}

interface OllamaResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
}

interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
}

function getNonce() {
  const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let text = '';
  for (let i = 0; i < 32; i++) {
    text += possible.charAt(Math.floor(Math.random() * possible.length));
  }
  return text;
}

export function activate(context: vscode.ExtensionContext) {
  LucidLogger.initialize(context);

  // --- 1. Chat Participant (Sohbet) ---
  const lucidParticipant = vscode.chat.createChatParticipant('lucid.ollama', async (request, chatContext, stream, token) => {

    const endpoint = LucidConfig.getEndpoint();
    const model = LucidConfig.getModelName();

    // --- Headers and API key handling ---
    // Read extra headers from environment (JSON) and from settings, merge them.
    let envExtraHeaders: { [key: string]: string } = {};
    try {
      const raw = process.env.OLLAMA_EXTRA_HEADERS;
      if (raw) {
        // Expecting JSON like: {"X-Request-Source":"post_text_script"}
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') envExtraHeaders = parsed as any;
      }
    } catch (e) {
      LucidLogger.error('Failed to parse OLLAMA_EXTRA_HEADERS:', e);
    }

    const configExtra = LucidConfig.getExtraHeaders();
    const combinedExtra: { [key: string]: string } = Object.assign({}, configExtra || {}, envExtraHeaders || {});

    // API key can be set via environment variable or settings
    const apiKey = process.env.OLLAMA_API_KEY || LucidConfig.getApiKey();

    // Ensure Content-Type is set so server parses JSON body correctly
    if (!Object.keys(combinedExtra).some(k => k.toLowerCase() === 'content-type')) {
      combinedExtra['Content-Type'] = 'application/json';
    }
    if (apiKey) combinedExtra['X-API-Key'] = apiKey;

    const fullHistory: OllamaMessage[] = [];

    chatContext.history.forEach((h: any) => {
      if (h instanceof vscode.ChatRequestTurn) {
        fullHistory.push({ role: 'user', content: h.prompt });
      } else if (h instanceof vscode.ChatResponseTurn) {
        const content = h.response.map((r: any) => r.value).filter((v: any) => typeof v === 'string').join('');
        fullHistory.push({ role: 'assistant', content: content });
      }
    });

    fullHistory.push({ role: 'user', content: request.prompt });

    try {
      // Build and log a curl command (mask sensitive headers unless settings allow unmasked logging)
      CurlLogger.log({
        url: `${endpoint}`,
        headers: combinedExtra,
        body: { model, messages: [{ role: 'user', content: request.prompt }], stream: false },
        label: 'CURL chatParticipant',
        revealSensitive: CurlLogger.shouldRevealSensitive(context)
      });

      const response = await fetch(`${endpoint}`, {
        method: 'POST',
        headers: combinedExtra,
        body: JSON.stringify({ model: model, messages: [{ role: 'user', content: request.prompt }], stream: false })
      });

      if (!response.ok) {
        stream.markdown(`Error connecting to Ollama: ${response.statusText}`);
        return;
      }

      if (!response.body) {
        stream.markdown("No response body from Ollama.");
        return;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();

      // Read streaming chunks and support multiple response formats:
      // - legacy chunked objects with { message: { content } }
      // - single JSON object with { choices: [{ message: { content } }] }
      // - generate-style with { response: "..." }
      let buffer = '';
      while (true) {
        if (token.isCancellationRequested) {
          await reader.cancel();
          break;
        }

        const { done, value } = await reader.read();
        if (done) break;

        const chunk = decoder.decode(value, { stream: true });
        // buffer ile kısmi chunk'ları birleştiriyoruz
        buffer += chunk;
        const lines = buffer.split('\n');
        // buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;

          // 1) normal parse
          // 2) eğer JSON-string ise inner parse (double-encoded)
          // 3) choices dizisini kontrol et, assistant role ise content'i göster
          // 4) fallback olarak message.content / response / text alanları da göster
          try {
            let parsed: any = JSON.parse(trimmed);
            if (parsed && parsed.choices && Array.isArray(parsed.choices)) {
              for (const c of parsed.choices) {
                const role = c?.message?.role || c?.role || c?.delta?.role;
                const msg = c?.message?.content || c?.text || c?.delta?.content || c?.response;
                if (role === 'assistant' && msg) stream.markdown(String(msg));
              }
              continue;
            }
            if (parsed?.message?.content) stream.markdown(parsed.message.content);
            else if (parsed?.response) stream.markdown(parsed.response);
          } catch (e) {
            LucidLogger.error('JSON parse error', e, 'Line:', trimmed);
            const parseMsg = (e instanceof Error) ? e.message : String(e);
            stream.markdown(`Parse error: ${parseMsg}`);
          }
        }
      }
    } catch (err) {
      if (err instanceof Error) {
        stream.markdown(`Failed to communicate with Ollama: ${err.message}`);
      } else {
        stream.markdown("An unknown error occurred.");
      }
    }
  });

  context.subscriptions.push(lucidParticipant);

  // --- 2. Inline Completion Provider (Kod Tamamlama / Ghost Text) ---
  const provider: vscode.InlineCompletionItemProvider = {
    async provideInlineCompletionItems(document, position, provContext, token) {

      if (!LucidConfig.isInlineCompletionEnabled()) {
        return [];
      }

      const endpoint = LucidConfig.getEndpoint();
      const model = LucidConfig.getModelName();

      // Inline completion should use same headers + API key
      let envExtraHeaders2: { [key: string]: string } = {};
      try {
        const raw = process.env.OLLAMA_EXTRA_HEADERS;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') envExtraHeaders2 = parsed as any;
        }
      } catch (e) {
        LucidLogger.error('Failed to parse OLLAMA_EXTRA_HEADERS:', e);
      }
      const configExtra2 = LucidConfig.getExtraHeaders();
      const combinedExtra2: { [key: string]: string } = Object.assign({}, configExtra2 || {}, envExtraHeaders2 || {});
      const apiKey2 = process.env.OLLAMA_API_KEY || LucidConfig.getApiKey();
      const baseHeaders2: { [key: string]: string } = { 'Content-Type': 'application/json' };
      Object.assign(baseHeaders2, combinedExtra2);
      if (apiKey2) baseHeaders2['X-API-Key'] = apiKey2;

      // Basit bir prompt oluşturma: İmleçten önceki son 2000 karakteri al
      const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
      const prompt = `Complete the following code. Do not include any explanation, just the code.\n\n${textBeforeCursor.slice(-2000)}`;

      try {
        // Build and log a curl command for generate (mask sensitive headers)
        CurlLogger.log({
          url: `${endpoint}/api/generate`,
          headers: baseHeaders2,
          body: { model, prompt, stream: false, options: { stop: ["\n\n", "```"] } },
          label: 'CURL inlineGenerate',
          revealSensitive: CurlLogger.shouldRevealSensitive(context)
        });

        // Ollama /api/generate endpoint'i tek seferlik tamamlama için daha uygundur
        const response = await fetch(`${endpoint}/api/generate`, {
          method: 'POST',
          headers: baseHeaders2,
          body: JSON.stringify({
            model: model,
            prompt: prompt,
            stream: false, // Hız için stream kapalı
            options: {
              stop: ["\n\n", "```"] // Basit durdurma kriterleri
            }
          })
        });

        if (!response.ok) return [];

        const json = await response.json() as OllamaGenerateResponse;
        if (json.response) {
          return [new vscode.InlineCompletionItem(json.response, new vscode.Range(position, position))];
        }

      } catch (e) {
        LucidLogger.error('Ollama inline completion error', e);
      }

      return [];
    }
  };

  // Tüm diller / dosyalar için provider'ı kaydet
  // Use explicit schemes to avoid "document selector without scheme" warnings.
  const docFilters: vscode.DocumentFilter[] = [
    { scheme: 'file', pattern: '**/*' },
    { scheme: 'untitled', pattern: '**/*' }
  ];
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider(docFilters, provider));

  // --- 3. File send helper + Commands ---
  async function buildHeadersFromConfig(): Promise<{ [key: string]: string }> {
    let envExtraHeaders: { [key: string]: string } = {};
    try {
      const raw = process.env.OLLAMA_EXTRA_HEADERS;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') envExtraHeaders = parsed as any;
      }
    } catch (e) {
      LucidLogger.error('Failed to parse OLLAMA_EXTRA_HEADERS:', e);
    }
    const configExtra = LucidConfig.getExtraHeaders();
    const combined: { [key: string]: string } = Object.assign({}, configExtra || {}, envExtraHeaders || {});
    const apiKey = process.env.OLLAMA_API_KEY || LucidConfig.getApiKey();
    if (!Object.keys(combined).some(k => k.toLowerCase() === 'content-type')) {
      combined['Content-Type'] = 'application/json';
    }
    if (apiKey) combined['X-API-Key'] = apiKey;
    return combined;
  }

  async function sendFileUri(uri: vscode.Uri): Promise<{ ok: boolean; status: number; text: string } | undefined> {
    try {
      const endpoint = LucidConfig.getEndpoint();
      const model = LucidConfig.getModelName();

      const headers = await buildHeadersFromConfig();
      const bytes = await vscode.workspace.fs.readFile(uri);
      const b64 = Buffer.from(bytes).toString('base64');
      const filename = uri.path.split('/').pop() || uri.fsPath;

      const filePayload = {
        type: 'file',
        filename: filename,
        encoding: 'base64',
        content_b64: b64,
      };

      const resp = await fetch(`${endpoint}` , {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ model: model, messages: [{ role: 'user', content: JSON.stringify(filePayload) }], stream: false })
      });

      const text = await resp.text().catch(() => resp.statusText || '');
      // Try to parse JSON response for structured data
      let parsed: any | undefined = undefined;
      try {
        parsed = JSON.parse(text);
      } catch (e) {
        // not JSON, leave parsed undefined
      }
      if (!resp.ok) return Object.assign({ ok: false, status: resp.status, text }, parsed ? { json: parsed } : {} as any);
      return Object.assign({ ok: true, status: resp.status, text }, parsed ? { json: parsed } : {} as any);
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(msg);
    }
  }

  // Show structured results to the user (open URLs, copy ids, show raw JSON)
  async function showResultToUser(result: { ok: boolean; status: number; text: string; json?: any } | undefined) {
    if (!result) return;

    if (result.json && typeof result.json === 'object') {
      const json = result.json;
      const urls: string[] = [];
      if (typeof json.url === 'string') urls.push(json.url);
      if (Array.isArray(json.urls)) urls.push(...json.urls.filter((u: any) => typeof u === 'string'));
      // Common id fields
      const id = json.id || json.message_id || json.messageId || json.msgId || json.result_id;

      const actions: string[] = [];
      if (urls.length > 0) actions.push('Open URL');
      if (id) actions.push('Copy ID');
      actions.push('Show Raw');

      const pick = await vscode.window.showInformationMessage(`File sent — status ${result.status}`, ...actions);
      if (!pick) return;

      if (pick === 'Open URL' && urls.length > 0) {
        const pickUrl = urls.length === 1 ? urls[0] : await vscode.window.showQuickPick(urls, { placeHolder: 'Select URL to open' });
        if (pickUrl) await vscode.env.openExternal(vscode.Uri.parse(pickUrl));
        return;
      }

      if (pick === 'Copy ID' && id) {
        await vscode.env.clipboard.writeText(String(id));
        vscode.window.showInformationMessage('ID copied to clipboard');
        return;
      }

      if (pick === 'Show Raw') {
        const doc = await vscode.workspace.openTextDocument({ content: JSON.stringify(result.json, null, 2), language: 'json' });
        await vscode.window.showTextDocument(doc, { preview: true });
        return;
      }
      return;
    }

    // fallback: show plain text response
    vscode.window.showInformationMessage(`File sent to Ollama. Response: ${result.text.slice(0, 200)}`);
  }

  // --- 5. Webview Sidebar: Lucid Chat ---
  class LucidSidebarProvider implements vscode.WebviewViewProvider {
    private _view?: vscode.WebviewView;
    constructor(private readonly _extensionUri: vscode.Uri) {}

    public async resolveWebviewView(webviewView: vscode.WebviewView) {
      this._view = webviewView;
      LucidLogger.debug('resolveWebviewView called');
      try {
        webviewView.webview.options = {
          enableScripts: true,
          localResourceRoots: [this._extensionUri]
        };

        // Safe HTML generation
        try {
          webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
        } catch (htmlErr) {
          LucidLogger.error('Error generating webview HTML:', htmlErr);
          webviewView.webview.html = `<body><pre>Failed to create webview UI: ${String(htmlErr)}</pre></body>`;
        }

        webviewView.webview.onDidReceiveMessage(async (msg) => {
          LucidLogger.debug('Webview message received', msg);
          try {
            if (msg?.type === 'send') {
              const prompt: string = String(msg.prompt || '');
              if (!prompt) return;
              const streamingStatusEnabled = LucidConfig.shouldShowStreamingStatus();
              webviewView.webview.postMessage({ type: 'status', text: 'Sending prompt…', streaming: streamingStatusEnabled });
              try {
                await sendPromptToOllama(webviewView.webview, prompt);
              } catch (e) {
                const text = e instanceof Error ? e.message : String(e);
                LucidLogger.error('sendPromptToOllama error', e);
                webviewView.webview.postMessage({ type: 'error', text });
                webviewView.webview.postMessage({ type: 'status', text: 'Ollama request failed', level: 'error', streaming: false });
              }
            } else if (msg?.type === 'clearLogs') {
              webviewView.webview.postMessage({ type: 'status', text: 'Output cleared', streaming: false });
            }
          } catch (msgErr) {
              LucidLogger.error('Error handling webview message', msgErr);
            try { webviewView.webview.postMessage({ type: 'error', text: String(msgErr) }); } catch (_) {}
          }
        });

        webviewView.onDidDispose(() => {
          LucidLogger.debug('webviewView disposed');
        });

        // Send an initial ready message so the view shows activity immediately
        try {
          webviewView.webview.postMessage({ type: 'append', text: 'Lucid Chat ready. Write a prompt and click Send.\n' });
        } catch (e) {
              LucidLogger.error('Failed to post initial ready message to webview', e);
        }
      } catch (e) {
        LucidLogger.error('resolveWebviewView top-level error', e);
        try {
          webviewView.webview.html = `<body><pre>Internal error: ${String(e)}</pre></body>`;
        } catch (_) {}
      }
    }

    // Build a VS Code-themed, CSP-hardened webview with a streaming-friendly UI.
    private _getHtmlForWebview(webview: vscode.Webview) {
      try {
        const nonce = getNonce();
        const csp = [
          "default-src 'none';",
          `img-src ${webview.cspSource} https: data:;`,
          `font-src ${webview.cspSource};`,
          `style-src 'nonce-${nonce}';`,
          `script-src 'nonce-${nonce}';`
        ].join(' ');

        return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Lucid Chat</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      padding: 12px;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family);
    }
    .shell {
      display: flex;
      flex-direction: column;
      gap: 10px;
      height: 100vh;
    }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03);
    }
    .composer {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .message {
      margin: 0 0 8px;
      padding: 8px 10px;
      border-radius: 5px;
      background: rgba(255, 255, 255, 0.02);
      white-space: pre-wrap;
      font-family: var(--vscode-editor-font-family);
    }
    .message.user {
      background: rgba(0, 120, 212, 0.18);
      color: var(--vscode-foreground);
    }
    .message.error {
      border: 1px solid var(--vscode-errorForeground);
      color: var(--vscode-errorForeground);
      background: transparent;
    }
    textarea {
      width: 100%;
      min-height: 80px;
      max-height: 160px;
      resize: vertical;
      border-radius: 6px;
      padding: 8px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-editor-font-family);
    }
    .controls {
      display: flex;
      align-items: center;
      flex-wrap: wrap;
      gap: 10px;
    }
    .status {
      display: flex;
      align-items: center;
      gap: 6px;
      color: var(--vscode-descriptionForeground);
      flex: 1;
      min-width: 160px;
    }
    .status[data-level="error"] {
      color: var(--vscode-errorForeground);
    }
    .spinner {
      width: 12px;
      height: 12px;
      border: 2px solid transparent;
      border-top-color: var(--vscode-progressBar-background);
      border-radius: 50%;
      animation: spin 1s linear infinite;
    }
    @keyframes spin { to { transform: rotate(360deg); } }
    .buttons {
      display: flex;
      gap: 8px;
    }
    button {
      border: none;
      border-radius: 4px;
      padding: 6px 14px;
      font-size: 12px;
      cursor: pointer;
      background: var(--vscode-button-secondaryBackground);
      color: var(--vscode-button-secondaryForeground);
    }
    button.primary {
      background: var(--vscode-button-background);
      color: var(--vscode-button-foreground);
    }
    button:disabled {
      opacity: 0.6;
      cursor: not-allowed;
    }
  </style>
</head>
<body>
  <div class="shell">
    <div id="messages" class="messages" aria-live="polite"></div>
    <div class="composer">
      <textarea id="prompt" placeholder="Ask your local model..."></textarea>
      <div class="controls">
        <div class="status" id="status" data-level="info">
          <div id="spinner" class="spinner" hidden></div>
          <span id="statusText">Idle</span>
        </div>
        <div class="buttons">
          <button id="clear" type="button">Clear</button>
          <button id="send" type="button" class="primary">Send</button>
        </div>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    (() => {
      const vscode = acquireVsCodeApi();
      const messages = document.getElementById('messages');
      const promptInput = document.getElementById('prompt');
      const sendBtn = document.getElementById('send');
      const clearBtn = document.getElementById('clear');
      const statusRoot = document.getElementById('status');
      const statusText = document.getElementById('statusText');
      const spinner = document.getElementById('spinner');

      const state = {
        isStreaming: false,
        queue: [],
        raf: null,
        totalChars: 0,
        maxChars: 50000
      };

      const flushQueue = () => {
        state.raf = null;
        while (state.queue.length) {
          const job = state.queue.shift();
          if (job) job();
        }
      };

      const enqueue = (job) => {
        state.queue.push(job);
        if (!state.raf) {
          state.raf = requestAnimationFrame(flushQueue);
        }
      };

      const appendBlock = (text, role) => {
        enqueue(() => {
          const block = document.createElement('pre');
          block.className = role === 'error' ? 'message error' : role === 'user' ? 'message user' : 'message';
          block.textContent = text || '';
          messages.appendChild(block);
          state.totalChars += block.textContent.length;
          while (state.totalChars > state.maxChars && messages.firstChild) {
            state.totalChars -= messages.firstChild.textContent.length;
            messages.removeChild(messages.firstChild);
          }
          messages.scrollTop = messages.scrollHeight;
        });
      };

      const clearMessages = () => {
        enqueue(() => {
          messages.textContent = '';
          state.totalChars = 0;
        });
      };

      const setStatus = (text, level = 'info', streaming = false) => {
        statusText.textContent = text;
        statusRoot.dataset.level = level;
        state.isStreaming = streaming;
        spinner.hidden = !streaming;
        updateSendState();
      };

      const updateSendState = () => {
        const hasText = promptInput.value.trim().length > 0;
        sendBtn.disabled = state.isStreaming || !hasText;
      };

      const sendPrompt = () => {
        const value = promptInput.value.trim();
        if (!value || state.isStreaming) return;
        setStatus('Sending prompt…', 'info', true);
        appendBlock('You: ' + value, 'user');
        vscode.postMessage({ type: 'send', prompt: value });
        promptInput.value = '';
        updateSendState();
      };

      promptInput.addEventListener('input', updateSendState);
      promptInput.addEventListener('keydown', (event) => {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          sendPrompt();
        }
      });

      sendBtn.addEventListener('click', sendPrompt);
      clearBtn.addEventListener('click', () => {
        clearMessages();
        setStatus('Idle');
        vscode.postMessage({ type: 'clearLogs' });
      });

      window.addEventListener('message', (event) => {
        const msg = event.data;
        if (!msg) return;
        switch (msg.type) {
          case 'append':
            appendBlock(msg.text, msg.role);
            break;
          case 'clear':
            clearMessages();
            break;
          case 'error':
            appendBlock(msg.text || 'Unknown error', 'error');
            setStatus(msg.text || 'Error', 'error', false);
            break;
          case 'status':
            setStatus(msg.text || 'Idle', msg.level || 'info', !!msg.streaming);
            break;
        }
      });

      setStatus('Idle');
      updateSendState();
    })();
  </script>
</body>
</html>`;
      } catch (e) {
        LucidLogger.error('_getHtmlForWebview error', e);
        return `<body><pre>Failed to render UI: ${String(e)}</pre></body>`;
      }
    }
  }

  // Stream chunked Ollama responses to the webview and keep the UI informed via status messages.
  async function sendPromptToOllama(webview: vscode.Webview, prompt: string) {
    const endpoint = LucidConfig.getEndpoint();
    const model = LucidConfig.getModelName();
    const headers = await buildHeadersFromConfig();
    const streamingStatusEnabled = LucidConfig.shouldShowStreamingStatus();

    try {
      CurlLogger.log({
        url: endpoint,
        headers,
        body: { model, messages: [{ role: 'user', content: prompt }], stream: streamingStatusEnabled },
        label: 'CURL sendPromptToOllama',
        revealSensitive: CurlLogger.shouldRevealSensitive(context)
      });

      webview.postMessage({ type: 'status', text: 'Connecting to Ollama…', streaming: streamingStatusEnabled });
      const response = await fetch(`${endpoint}`, {
        method: 'POST',
        headers: headers,
        body: JSON.stringify({ model: model, messages: [{ role: 'user', content: prompt }], stream: streamingStatusEnabled })
      });

      if (!response.ok) {
        const txt = await response.text().catch(() => response.statusText);
        throw new Error(`Ollama error ${response.status}: ${txt}`);
      }
      if (!response.body) {
        throw new Error('No response body from Ollama');
      }

      webview.postMessage({ type: 'status', text: 'Streaming response…', streaming: streamingStatusEnabled });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        // buffer = lines.pop() || '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            let content = '';
            if (parsed.choices && Array.isArray(parsed.choices)) {
              for (const c of parsed.choices) {
                const msg = c?.message?.content || c?.text || c?.response || c?.delta?.content;
                if (msg) content += String(msg);
              }
            } else if (parsed.message && parsed.message.content) {
              content = parsed.message.content;
            } else if (parsed.response) {
              content = parsed.response;
            } else if (typeof parsed === 'string') {
              content = parsed;
            }
            if (content) {
              webview.postMessage({ type: 'append', text: content });
            }
          } catch (e) {
            webview.postMessage({ type: 'append', text: trimmed });
          }
        }
      }

      if (buffer.trim()) {
        try {
          const p = JSON.parse(buffer.trim());
          const content = p?.message?.content || p?.response || '';
          if (content) webview.postMessage({ type: 'append', text: content });
        } catch (e) {
          webview.postMessage({ type: 'append', text: buffer });
        }
      }

      webview.postMessage({ type: 'status', text: 'Idle', streaming: false });
    } catch (err) {
      webview.postMessage({ type: 'status', text: err instanceof Error ? err.message : 'Ollama request failed', level: 'error', streaming: false });
      throw err;
    }
  }

  // Register the sidebar provider (log registration errors to help debugging)
  let sidebarProvider: LucidSidebarProvider | undefined;
  try {
    sidebarProvider = new LucidSidebarProvider(context.extensionUri);
    context.subscriptions.push(vscode.window.registerWebviewViewProvider('lucid.chatView', sidebarProvider));
    LucidLogger.debug('Registered WebviewViewProvider for lucid.chatView');
  } catch (e) {
    LucidLogger.error('Failed to register WebviewViewProvider for lucid.chatView', e);
  }

  // Diagnostic helper: reveal the Lucid activity bar container and instruct user
  const openSidebarCommand = vscode.commands.registerCommand('lucid.openChatView', async () => {
    try {
      // Reveal the activity bar container we declared as `lucid` in package.json
      await vscode.commands.executeCommand('workbench.view.extension.lucid');
      vscode.window.showInformationMessage('Lucid: activity bar revealed. If the view is empty, open Webview DevTools (focus the view and run "Developer: Toggle Webview Developer Tools").');
    } catch (err) {
      LucidLogger.error('Error executing openChatView command', err);
      vscode.window.showErrorMessage('Lucid: failed to reveal sidebar: ' + String(err));
    }
  });
  context.subscriptions.push(openSidebarCommand);

  const closeSidebarCommand = vscode.commands.registerCommand('lucid.closeChatView', async () => {
    try {
      await vscode.commands.executeCommand('workbench.action.closeSidebar');
      vscode.window.showInformationMessage('Lucid: sidebar hidden. Run "Lucid: Open Chat View" to show it again.');
    } catch (err) {
      LucidLogger.error('Error executing closeChatView command', err);
      vscode.window.showErrorMessage('Lucid: failed to close sidebar: ' + String(err));
    }
  });
  context.subscriptions.push(closeSidebarCommand);

  // Diagnostic helper: dump internal provider/view state to the Extension Host console
  const dumpStateCommand = vscode.commands.registerCommand('lucid.dumpState', async () => {
    try {
      // Try to find the registered provider by scanning subscriptions (best-effort)
      const subs: any = (context as any).subscriptions || [];
      let providerFound = false;
      for (const s of subs) {
        try {
          if (s && s._provider && s._provider.constructor && s._provider.constructor.name === 'LucidSidebarProvider') {
            providerFound = true;
            LucidLogger.debug('Found provider (via _provider)', s._provider);
            LucidLogger.debug('_view snapshot', (s._provider as any)._view);
            break;
          }
        } catch (_) {}
      }
      if (sidebarProvider) {
        LucidLogger.debug('sidebarProvider var', sidebarProvider);
        LucidLogger.debug('sidebarProvider._view snapshot', (sidebarProvider as any)._view);
        providerFound = true;
      }

      if (!providerFound) LucidLogger.debug('Provider instance not found in subscriptions or local scope (non-fatal)');
      vscode.window.showInformationMessage('Lucid: provider state dumped to Extension Host console. Check the Debug Console / DevTools.');
    } catch (e) {
      LucidLogger.error('dumpState error', e);
      vscode.window.showErrorMessage('Lucid: dumpState failed: ' + String(e));
    }
  });
  context.subscriptions.push(dumpStateCommand);

  // Existing single-file picker command
  const sendFileCommand = vscode.commands.registerCommand('lucid.sendFile', async () => {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: false, openLabel: 'Send to Ollama' });
    if (!uris || uris.length === 0) return;
    const uri = uris[0];

    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Sending file to Ollama', cancellable: false }, async () => {
        return await sendFileUri(uri);
      });
      if (!result) return;
      if (!result.ok) vscode.window.showErrorMessage(`Failed to send file: ${result.status} ${result.text}`);
      else vscode.window.showInformationMessage(`File sent to Ollama. Response: ${result.text.slice(0, 200)}`);
    } catch (e) {
      vscode.window.showErrorMessage(`Error sending file: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // Send active editor file
  const sendActiveFileCommand = vscode.commands.registerCommand('lucid.sendActiveFile', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('No active editor to send.');
      return;
    }
    const uri = editor.document.uri;
    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Sending active file to Ollama', cancellable: false }, async () => {
        return await sendFileUri(uri);
      });
      if (!result) return;
      if (!result.ok) vscode.window.showErrorMessage(`Failed to send file: ${result.status} ${result.text}`);
      else vscode.window.showInformationMessage(`File sent to Ollama. Response: ${result.text.slice(0, 200)}`);
    } catch (e) {
      vscode.window.showErrorMessage(`Error sending file: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  // Send multiple files (picker with multi-select)
  const sendFilesCommand = vscode.commands.registerCommand('lucid.sendFiles', async () => {
    const uris = await vscode.window.showOpenDialog({ canSelectMany: true, openLabel: 'Send to Ollama' });
    if (!uris || uris.length === 0) return;
    try {
      await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: `Sending ${uris.length} files to Ollama`, cancellable: false }, async (progress) => {
        for (let i = 0; i < uris.length; i++) {
          const u = uris[i];
          progress.report({ message: `Sending ${u.path.split('/').pop()}`, increment: Math.round(100 / uris.length) });
          const res = await sendFileUri(u);
          if (!res || !res.ok) {
            vscode.window.showErrorMessage(`Failed to send ${u.path.split('/').pop()}: ${res ? `${res.status} ${res.text}` : 'unknown error'}`);
          }
        }
      });
      vscode.window.showInformationMessage('Done sending selected files to Ollama.');
    } catch (e) {
      vscode.window.showErrorMessage(`Error sending files: ${e instanceof Error ? e.message : String(e)}`);
    }
  });

  context.subscriptions.push(sendFileCommand, sendActiveFileCommand, sendFilesCommand);
}

export function deactivate() { }
