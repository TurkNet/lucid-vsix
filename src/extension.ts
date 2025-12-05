import * as vscode from 'vscode';
import * as path from 'path';
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
        body: JSON.stringify({ model: model, messages: fullHistory, stream: false })
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

      const resp = await fetch(`${endpoint}`, {
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
    constructor(private readonly _extensionUri: vscode.Uri) { }

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
          // maintain a per-view set of attached files in closure
          if (!(webviewView as any)._attachedPaths) (webviewView as any)._attachedPaths = new Set<string>();
          const attachedPaths: Set<string> = (webviewView as any)._attachedPaths;

          async function listWorkspaceFiles() {
            try {
              const folders = vscode.workspace.workspaceFolders || [];
              if (folders.length === 0) return [];
              // Prefer files under the first workspace folder (common simple case)
              const first = folders[0];
              try {
                const rel = new vscode.RelativePattern(first, '**/*');
                const files = await vscode.workspace.findFiles(rel, '**/node_modules/**', 1000);
                return files.map(f => ({ path: f.fsPath, name: path.basename(f.fsPath) }));
              } catch (e) {
                // fallback to workspace-wide search
                const files = await vscode.workspace.findFiles('**/*', '**/node_modules/**', 1000);
                return files.map(f => ({ path: f.fsPath, name: path.basename(f.fsPath) }));
              }
            } catch (e) {
              LucidLogger.error('listWorkspaceFiles error', e);
              return [];
            }
          }

          try {
            if (!msg || !msg.type) return;

            if (msg.type === 'requestFiles') {
              const files = await listWorkspaceFiles();
              webviewView.webview.postMessage({ type: 'fileList', files });
              webviewView.webview.postMessage({ type: 'attachedChanged', files: Array.from(attachedPaths) });
              return;
            }

            if (msg.type === 'attach') {
              const p = String(msg.path || '');
              if (p) attachedPaths.add(p);
              webviewView.webview.postMessage({ type: 'attachedChanged', files: Array.from(attachedPaths) });
              return;
            }

            if (msg.type === 'detach') {
              const p = String(msg.path || '');
              if (p) attachedPaths.delete(p);
              webviewView.webview.postMessage({ type: 'attachedChanged', files: Array.from(attachedPaths) });
              return;
            }

            if (msg.type === 'send') {
              const prompt: string = String(msg.prompt || '');
              if (!prompt) return;
              const streamingStatusEnabled = LucidConfig.shouldShowStreamingStatus();
              webviewView.webview.postMessage({ type: 'status', text: 'Sending prompt…', streaming: streamingStatusEnabled });

              let combined = '';
              if (attachedPaths.size > 0) {
                for (const p of Array.from(attachedPaths)) {
                  try {
                    const uri = vscode.Uri.file(p);
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    const text = Buffer.from(bytes).toString('utf8');
                    combined += `--- ATTACHED: ${p.split('/').pop()} ---\n${text}\n--- END ATTACHED ---\n\n`;
                  } catch (e) {
                    LucidLogger.error('Failed to read attached file ' + p, e);
                  }
                }
              } else {
                // No attached files: fall back to the active editor's contents (if any)
                try {
                  const ed = vscode.window.activeTextEditor;
                  if (ed && ed.document) {
                    const doc = ed.document;
                    const fileName = doc.fileName && doc.fileName.length ? path.basename(doc.fileName) : (doc.uri && doc.uri.path ? path.basename(doc.uri.path) : undefined);
                    const text = doc.getText();
                    combined += `--- ACTIVE EDITOR: ${fileName || 'untitled'} ---\n${text}\n--- END ACTIVE EDITOR ---\n\n`;
                  }
                } catch (e) {
                  LucidLogger.debug('Failed to read active editor for fallback attached content', e);
                }
              }

              const finalPrompt = combined + '\n' + prompt;

              try {
                await sendPromptToOllama(webviewView.webview, finalPrompt);
              } catch (e) {
                const text = e instanceof Error ? e.message : String(e);
                LucidLogger.error('sendPromptToOllama error', e);
                webviewView.webview.postMessage({ type: 'error', text });
                webviewView.webview.postMessage({ type: 'status', text: 'Ollama request failed', level: 'error', streaming: false });
              }
              return;
            }

            if (msg.type === 'error') {
              const text = typeof msg.text === 'string' ? msg.text : 'Unknown webview error';
              LucidLogger.error('Webview reported error:', text);
              return;
            }
          } catch (msgErr) {
            LucidLogger.error('Error handling webview message', msgErr);
            try { webviewView.webview.postMessage({ type: 'error', text: String(msgErr) }); } catch (_) { }
          }
        });

        webviewView.onDidDispose(() => {
          LucidLogger.debug('webviewView disposed');
        });

        // Send an initial ready message so the view shows activity immediately
        try {
          webviewView.webview.postMessage({ type: 'append', text: 'Lucid Chat ready. Write a prompt and click Send.\n', role: 'system' });
        } catch (e) {
          LucidLogger.error('Failed to post initial ready message to webview', e);
        }
      } catch (e) {
        LucidLogger.error('resolveWebviewView top-level error', e);
        try {
          webviewView.webview.html = `<body><pre>Internal error: ${String(e)}</pre></body>`;
        } catch (_) { }
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

        const html_content = `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta http-equiv="Content-Security-Policy" content="${csp}">
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Lucid Chat</title>
  <style nonce="${nonce}">
    :root { color-scheme: light dark; }
    * { box-sizing: border-box; }
    html, body {
      height: 100%;
    }
    body {
      margin: 0;
      padding: 12px;
      background: var(--vscode-sideBar-background);
      color: var(--vscode-foreground);
      font-family: var(--vscode-font-family, -apple-system, BlinkMacSystemFont, sans-serif);
      display: flex;
      flex-direction: column;
      overflow: hidden;
    }
    .shell {
      display: flex;
      flex-direction: column;
      gap: 10px;
      flex: 1;
      min-height: 0;
    }
    .messages {
      flex: 1;
      overflow-y: auto;
      padding: 12px;
      border: 1px solid var(--vscode-panel-border);
      border-radius: 6px;
      background: var(--vscode-editor-background);
      box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.03);
      display: flex;
      flex-direction: column;
      gap: 8px;
      min-height: 0;
    }
    .composer {
      display: flex;
      flex-direction: column;
      gap: 8px;
    }
    .message {
      display: inline-flex;
      flex-direction: column;
      gap: 6px;
      margin: 0;
      padding: 10px 12px;
      border-radius: 8px;
      background: rgba(255, 255, 255, 0.02);
      align-self: flex-start;
      text-align: left;
      max-width: 100%;
      box-shadow: 0 1px 2px rgba(0,0,0,0.15);
    }
    .message.assistant {
      background: rgba(255, 255, 255, 0.02);
    }
    .message.user {
      background: rgba(0, 120, 212, 0.18);
      color: var(--vscode-foreground);
      align-self: flex-end;
      text-align: right;
    }
    .message.system {
      border: 1px dashed var(--vscode-descriptionForeground);
      background: transparent;
      color: var(--vscode-descriptionForeground);
    }
    .message.error {
      border: 1px solid var(--vscode-errorForeground);
      color: var(--vscode-errorForeground);
      background: transparent;
    }
    .message-label {
      font-size: 10px;
      text-transform: uppercase;
      letter-spacing: 0.06em;
      opacity: 0.7;
    }
    .message.user .message-label {
      align-self: flex-end;
    }
    .message-body {
      margin: 0;
      padding: 0;
      background: transparent;
      border: none;
      white-space: normal;
      font-family: var(--vscode-editor-font-family, Menlo, Monaco, "Courier New", monospace);
      font-size: 13px;
      line-height: 1.4;
    }
    .message-body code {
      font-size: 12px;
      padding: 0 4px;
      border-radius: 4px;
      background: rgba(249, 245, 255, 0.1);
    }
    .message-body .code-block {
      margin: 10px 0;
      padding: 12px;
      border-radius: 6px;
      background: rgba(249, 245, 255, 0.05);
      border: 1px solid rgba(255,255,255,0.08);
      overflow-x: auto;
      font-family: var(--vscode-editor-font-family, Menlo, Monaco, "Courier New", monospace);
      font-size: 12px;
      line-height: 1.6;
      position: relative;
      white-space: pre-wrap;
    }
    .message-body .code-block::before {
      content: attr(data-lang);
      position: absolute;
      top: 6px;
      right: 8px;
      font-size: 10px;
      letter-spacing: 0.04em;
      text-transform: uppercase;
      color: var(--vscode-descriptionForeground);
    }
    textarea {
      resize: vertical;
      border-radius: 6px;
      padding: 8px;
      border: 1px solid var(--vscode-input-border, transparent);
      background: var(--vscode-input-background);
      color: var(--vscode-input-foreground);
      font-family: var(--vscode-editor-font-family, Menlo, Monaco, "Courier New", monospace);
      min-height: 80px;
      max-height: 160px;
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
    button {
      display: inline-flex;
      align-items: center;
      gap: 6px;
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
    .icon-plane {
      width: 14px;
      height: 14px;
      fill: currentColor;
      flex-shrink: 0;
    }
    /* File search dropdown / list styles to match VS Code look */
    #fileList { box-shadow: var(--vscode-widget-shadow, 0 1px 0 rgba(0,0,0,0.1)); border-radius: 6px; }
    .file-list-item { padding: 6px 8px; border-radius: 4px; cursor: pointer; display: flex; align-items: center; justify-content: space-between; gap: 8px; color: var(--vscode-foreground); }
    .file-list-item:hover { background: var(--vscode-list-hoverBackground); color: var(--vscode-list-hoverForeground); }
    .file-list-item.focused { background: var(--vscode-list-activeSelectionBackground); color: var(--vscode-list-activeSelectionForeground); outline: none; }
    #fileList::-webkit-scrollbar { height: 8px; width: 8px; }
    #fileList::-webkit-scrollbar-thumb { background: rgba(128,128,128,0.25); border-radius: 4px; }
    #fileHint { font-size: 11px; color: var(--vscode-descriptionForeground); margin-bottom:6px; display: none; }
  </style>
</head>
<body>
  <div class="shell">
    <div id="messages" class="messages" aria-live="polite"></div>
    <div class="composer">
      <div id="activeEditorName" style="font-size:12px; font-weight:600; margin-bottom:6px; color:var(--vscode-descriptionForeground);"></div>
      <div id="activeFiles" style="display:flex; gap:6px; flex-wrap:wrap; margin-bottom:6px;"></div>
      <input id="fileSearch" placeholder="Filter files..." style="width:100%; padding:6px; margin-bottom:6px; border-radius:4px; border:1px solid var(--vscode-input-border); background:var(--vscode-input-background); color:var(--vscode-input-foreground);" />
      <div id="fileHint">↑/↓ select — Enter attach</div>
      <div id="fileList" style="display:none; max-height:170px; overflow:auto; margin-bottom:8px; border:1px solid rgba(255,255,255,0.03); padding:6px; border-radius:6px; background:var(--vscode-sideBar-background)"></div>
      <textarea id="prompt" placeholder="Ask your local model..."></textarea>
      <div class="controls">
        <div class="status" id="status" data-level="info">
          <div id="spinner" class="spinner" hidden></div>
          <span id="statusText">Idle</span>
        </div>
        <button id="send" type="button" class="primary" aria-label="Send prompt">
          <svg class="icon-plane" viewBox="0 0 24 24" role="presentation" focusable="false">
            <path d="M2.4 11.2l17.3-7.7c.9-.4 1.8.5 1.4 1.4L13.4 22.2c-.4.9-1.8.8-2-.2l-1.7-6.1-6.1-1.7c-1-.3-1.1-1.6-.2-2zM18 6.6L6.9 11.5l3.5 1 .9 3.5L18 6.6z"></path>
          </svg>
          <span>Send</span>
        </button>
      </div>
    </div>
  </div>

  <script nonce="${nonce}">
    (function () {
      var vscode = acquireVsCodeApi();
      var messages = document.getElementById('messages');
      var promptInput = document.getElementById('prompt');
      var sendBtn = document.getElementById('send');
      var statusRoot = document.getElementById('status');
      var statusText = document.getElementById('statusText');
      var spinner = document.getElementById('spinner');
      var fileLabel = document.getElementById('fileLabel');
      var activeEditorName = document.getElementById('activeEditorName');
      var activeFilesRoot = document.getElementById('activeFiles');
      var fileSearch = document.getElementById('fileSearch');
      var fileListRoot = document.getElementById('fileList');
      var fileHint = document.getElementById('fileHint');


      if (!messages || !promptInput || !sendBtn || !statusRoot || !statusText || !spinner || !activeEditorName || !activeFilesRoot || !fileSearch || !fileListRoot || !fileHint) {
        var missing = [];
        if (!messages) missing.push('messages');
        if (!promptInput) missing.push('prompt');
        if (!sendBtn) missing.push('send');
        if (!statusRoot) missing.push('status');
        if (!statusText) missing.push('statusText');
        if (!spinner) missing.push('spinner');
        if (!fileLabel) missing.push('fileLabel (optional)');
        if (!activeEditorName) missing.push('activeEditorName');
        if (!activeFilesRoot) missing.push('activeFiles');
        if (!fileSearch) missing.push('fileSearch');
        if (!fileListRoot) missing.push('fileList');
        if (!fileHint) missing.push('fileHint');

        // Console with structure for devtools
        console.error('Lucid Chat: missing required DOM nodes:', missing.join(', '), {
          messagesPresent: !!messages,
          promptPresent: !!promptInput,
          sendPresent: !!sendBtn,
          statusPresent: !!statusRoot,
          statusTextPresent: !!statusText,
          spinnerPresent: !!spinner,
          fileLabelPresent: !!fileLabel,
          fileHintPresent: !!fileHint,
          fileListPresent: !!fileListRoot
        });

        // Notify extension host for centralized logging / telemetry
        try {
          vscode.postMessage({ type: 'error', text: 'Webview initialization failed: missing DOM nodes', nodes: missing });
        } catch (e) { /* ignore post failures */ }

        // Try to show a visible error in the messages pane if available
        try {
          if (messages) {
            var errBlock = document.createElement('div');
            errBlock.className = 'message error';
            var lbl = document.createElement('div');
            lbl.className = 'message-label';
            lbl.textContent = 'Error';
            errBlock.appendChild(lbl);
            var body = document.createElement('div');
            body.className = 'message-body';
            body.textContent = 'Webview failed to initialize. Missing nodes: ' + missing.join(', ');
            errBlock.appendChild(body);
            messages.appendChild(errBlock);
          }
        } catch (e) { /* ignore UI errors */ }

        return;
      }

      function setEditorLabel(text) {
        try {
          if (fileLabel) fileLabel.textContent = text || '';
          if (activeEditorName) activeEditorName.textContent = text || '';
        } catch (e) { /* ignore */ }
      }

      // File list render + interaction
      var currentFiles = [];
      var currentAttached = [];
      var dropdownRows = [];
      var dropdownSelected = -1;
      function renderFileList(files, attached) {
        try {
          if (!Array.isArray(files)) files = [];
          const attachedSet = new Set(attached || []);
          fileListRoot.innerHTML = '';
          // If we have no files but some attached entries, show attached ones
          if ((!files || files.length === 0) && (!attached || attached.length === 0)) {
            fileListRoot.textContent = 'No workspace files found';
            return;
          }
          // normalize filter
          var filter = '';
          try { filter = (fileSearch && fileSearch.value) ? String(fileSearch.value).toLowerCase().trim() : ''; } catch (e) { filter = ''; }

          // If no filter, hide the results dropdown (do not show full list)
          if (!filter) {
            try { fileListRoot.innerHTML = ''; fileListRoot.style.display = 'none'; if (fileHint) fileHint.style.display = 'none'; } catch (e) { }
            return;
          }

          // show the results container and keyboard hint
          try { fileListRoot.style.display = 'block'; if (fileHint) fileHint.style.display = 'block'; } catch (e) { }

          var visibleIndex = 0;
          dropdownRows = [];

          for (const f of files) {
            var nm = (f.name || f.path || '').toLowerCase();
            if (nm.indexOf(filter) === -1) continue;
            const row = document.createElement('div');
            row.style.display = 'flex';
            row.style.alignItems = 'center';
            row.style.justifyContent = 'space-between';
            row.style.padding = '2px 4px';

            const left = document.createElement('div');
            left.style.display = 'flex';
            left.style.alignItems = 'center';

            const name = document.createElement('div');
            name.textContent = f.name || f.path;
            name.title = f.path;
            name.style.marginRight = '8px';

            const badge = document.createElement('div');
            badge.style.width = '18px';
            badge.style.height = '18px';
            badge.style.display = 'inline-flex';
            badge.style.alignItems = 'center';
            badge.style.justifyContent = 'center';
            badge.style.cursor = 'pointer';

            const isAttached = attachedSet.has(f.path);
            if (isAttached) {
              badge.textContent = '✔';
              badge.title = 'Attached';
              badge.style.opacity = '0.9';
              badge.onclick = null;
            } else {
              badge.textContent = '+';
              badge.title = 'Add to selection';
              badge.onclick = () => { vscode.postMessage({ type: 'attach', path: f.path }); };
            }

            // Place the badge inline after the filename
            left.appendChild(name);
            left.appendChild(badge);
            row.appendChild(left);

            // accessibility / keyboard target
            row.className = 'file-list-item';
            row.tabIndex = 0;
            row.dataset.index = String(visibleIndex);
            row.dataset.path = f.path;
            // mouse enter selects
            row.addEventListener('mouseenter', function () { setDropdownSelected(Number(row.dataset.index)); });
            // click to attach (if not attached)
            row.addEventListener('click', function () {
              try {
                if (!attachedSet.has(f.path)) {
                  vscode.postMessage({ type: 'attach', path: f.path });
                  // hide dropdown and clear search for clarity
                  try { if (fileListRoot) fileListRoot.style.display = 'none'; } catch (_) { }
                }
              } catch (e) { }
            });

            dropdownRows.push(row);
            visibleIndex++;

            fileListRoot.appendChild(row);
          }
          // ensure only up to N visible without scrolling (CSS handles scroll). nothing else to do here.
          if (dropdownSelected >= dropdownRows.length) dropdownSelected = dropdownRows.length - 1;
          updateDropdownFocus();
        } catch (e) { /* ignore rendering errors */ }
      }

      function setDropdownSelected(idx) {
        try {
          dropdownSelected = typeof idx === 'number' ? idx : -1;
          updateDropdownFocus();
        } catch (e) { }
      }

      function updateDropdownFocus() {
        try {
          for (var i = 0; i < dropdownRows.length; i++) {
            var r = dropdownRows[i];
            if (!r) continue;
            if (i === dropdownSelected) {
              r.classList.add('focused');
              try { r.scrollIntoView({ block: 'nearest' }); } catch (e) { }
            } else {
              r.classList.remove('focused');
            }
          }
        } catch (e) { }
      }

      function renderAttachedPills(attached) {
        try {
          if (!activeFilesRoot) return;
          activeFilesRoot.innerHTML = '';
          if (!Array.isArray(attached) || attached.length === 0) return;
          for (const p of attached) {
            var base = p.split('/').pop();
            var pill = document.createElement('div');
            pill.style.display = 'inline-flex';
            pill.style.alignItems = 'center';
            pill.style.gap = '6px';
            pill.style.padding = '4px 8px';
            pill.style.borderRadius = '999px';
            pill.style.border = '1px solid var(--vscode-input-border)';
            pill.style.color = 'var(--vscode-input-foreground)';
            pill.style.fontSize = '12px';

            var txt = document.createElement('span');
            txt.textContent = base || p;
            txt.title = p;
            pill.appendChild(txt);

            var rem = document.createElement('button');
            rem.textContent = '×';
            rem.title = 'Remove attached file';
            rem.style.border = 'none';
            rem.style.background = 'transparent';
            rem.style.cursor = 'pointer';
            rem.style.fontSize = '12px';
            rem.onclick = function () { vscode.postMessage({ type: 'detach', path: p }); };
            pill.appendChild(rem);

            activeFilesRoot.appendChild(pill);
          }
        } catch (e) { /* ignore */ }
      }

      // request initial file list
      vscode.postMessage({ type: 'requestFiles' });
      if (fileSearch) {
        fileSearch.addEventListener('input', function () {
          try { renderFileList(currentFiles, currentAttached); } catch (e) { }
        });
        // show results on focus as well if the field has content
        fileSearch.addEventListener('focus', function () {
          try { renderFileList(currentFiles, currentAttached); } catch (e) { }
        });
        // hide results if clicking outside (simple handler)
        document.addEventListener('click', function (ev) {
          try {
            var target = ev.target;
            if (!target) return;
            if (target === fileSearch) return;
            // if click inside the fileListRoot, ignore
            if (fileListRoot && fileListRoot.contains && fileListRoot.contains(target)) return;
            // otherwise hide dropdown
            if (fileListRoot) fileListRoot.style.display = 'none';
            if (fileHint) fileHint.style.display = 'none';
          } catch (e) { }
        });
      }
      // keyboard navigation for the dropdown
      if (fileSearch) {
        fileSearch.addEventListener('keydown', function (ev) {
          try {
            if (!dropdownRows || dropdownRows.length === 0) return;
            if (ev.key === 'ArrowDown') {
              ev.preventDefault();
              dropdownSelected = Math.min((dropdownSelected + 1) || 0, dropdownRows.length - 1);
              updateDropdownFocus();
              return;
            }
            if (ev.key === 'ArrowUp') {
              ev.preventDefault();
              dropdownSelected = Math.max((dropdownSelected - 1) || 0, 0);
              updateDropdownFocus();
              return;
            }
            if (ev.key === 'Enter') {
              ev.preventDefault();
              if (dropdownSelected >= 0 && dropdownSelected < dropdownRows.length) {
                var r = dropdownRows[dropdownSelected];
                if (r && r.dataset && r.dataset.path) {
                  vscode.postMessage({ type: 'attach', path: r.dataset.path });
                  try { if (fileListRoot) fileListRoot.style.display = 'none'; } catch (_) { }
                }
              }
              return;
            }
            if (ev.key === 'Escape') {
              try { if (fileListRoot) fileListRoot.style.display = 'none'; } catch (_) { }
              return;
            }
          } catch (e) { }
        });
      }

      var state = {
        isStreaming: false,
        queue: [],
        raf: null,
        totalChars: 0,
        maxChars: 50000
      };

      function flushQueue() {
        state.raf = null;
        while (state.queue.length) {
          var job = state.queue.shift();
          if (job) job();
        }
      }

      function enqueue(job) {
        state.queue.push(job);
        if (!state.raf) {
          state.raf = window.requestAnimationFrame(flushQueue);
        }
      }

      function trimOverflow() {
        while (state.totalChars > state.maxChars && messages.firstChild) {
          var first = messages.firstChild;
          var len = Number(first.dataset && first.dataset.textLength ? first.dataset.textLength : first.textContent.length);
          state.totalChars -= len;
          messages.removeChild(first);
        }
      }

      function escapeHtml(str) {
        if (str === void 0 || str === null) return '';
        return String(str)
          .replace(/&/g, '&amp;')
          .replace(/</g, '&lt;')
          .replace(/>/g, '&gt;');
      }

      // Inline code: text surrounded by grave accent (backtick), using \u0060 instead of literal backtick
      var inlineCodePattern = /\\u0060([^\\u0060]+)\\u0060/g;

      function renderInline(line) {
        if (line === void 0 || line === null) line = '';
        var html = escapeHtml(line);
        html = html.replace(/\\*\\*(.+?)\\*\\*/g, '<strong>$1</strong>');
        html = html.replace(/\\*(.+?)\\*/g, '<em>$1</em>');
        html = html.replace(inlineCodePattern, '<code>$1</code>');
        return html;
      }

      // Code fences using three grave accents (no literal backtick in source, use \u0060)
      var fencePattern = /\\u0060\\u0060\\u0060(\\w+)?\\n([\\s\\S]*?)\\u0060\\u0060\\u0060/g;

      function renderMarkdown(source) {
        if (!source) return '';

        var codeBlocks = [];
        var fenced = source.replace(fencePattern, function (_m, lang, code) {
          var idx = codeBlocks.length;
          codeBlocks.push({ lang: lang || '', code: code || '' });
          return '\\n{{CODE_BLOCK_' + idx + '}}\\n';
        });

        var lines = fenced.replace(/\\r\\n/g, '\\n').split('\\n');
        var html = '';
        var inList = false;

        function closeList() {
          if (inList) {
            html += '</ul>';
            inList = false;
          }
        }

        for (var i = 0; i < lines.length; i++) {
          var rawLine = lines[i];

          if (rawLine.indexOf('{{CODE_BLOCK_') === 0) {
            closeList();
            var idxMatch = rawLine.match(/\\d+/);
            var idx = idxMatch ? Number(idxMatch[0]) : 0;
            var block = codeBlocks[idx];
            var lang = block && block.lang ? block.lang : '';
            var code = escapeHtml(block && block.code ? block.code : '');
            var langClass = lang ? 'language-' + lang.replace(/[^a-z0-9_-]/gi, '') : 'language-plain';
            var langAttr = lang || 'plain';
            html += '<pre class="code-block" data-lang="' + langAttr + '"><code class="' + langClass + '">' + code + '</code></pre>';
            continue;
          }

          // Bullet list (- item / * item)
          if (/^\\s*[-*]\\s+/.test(rawLine)) {
            var content = rawLine.replace(/^\\s*[-*]\\s+/, '');
            if (!inList) {
              html += '<ul class="message-list">';
              inList = true;
            }
            html += '<li>' + renderInline(content) + '</li>';
            continue;
          }

          closeList();

          if (rawLine.trim() === '') {
            html += '<br />';
            continue;
          }

          html += '<p>' + renderInline(rawLine) + '</p>';
        }

        closeList();
        return html;
      }

      function labelForRole(role) {
        switch (role) {
          case 'user': return 'You';
          case 'assistant': return 'Assistant';
          case 'system': return 'System';
          case 'error': return 'Error';
          default: return 'Notice';
        }
      }

      function appendBlock(text, role) {
        if (role === void 0) role = 'assistant';
        var safeText = text || '';
        enqueue(function () {
          // streaming: append to last assistant block if exists
          if (role === 'assistant') {
            var last = messages.lastElementChild;
            if (last && last.classList.contains('assistant')) {
              var body = last.querySelector('.message-body');
              if (body) {
                var prevRaw = last.dataset.rawText || '';
                var nextRaw = prevRaw + safeText;
                var prevLen = Number(last.dataset.textLength || '0');
                var nextLen = nextRaw.length;
                last.dataset.rawText = nextRaw;
                last.dataset.textLength = String(nextLen);
                state.totalChars += (nextLen - prevLen);
                body.innerHTML = renderMarkdown(nextRaw);
                trimOverflow();
                messages.scrollTop = messages.scrollHeight;
                return;
              }
            }
          }

          var block = document.createElement('div');
          var roleClass =
            role === 'error' ? 'message error' :
            role === 'user' ? 'message user' :
            role === 'system' ? 'message system' :
            'message assistant';
          block.className = roleClass;

          var label = document.createElement('div');
          label.className = 'message-label';
          label.textContent = labelForRole(role);
          block.appendChild(label);

          var bodyEl = document.createElement('div');
          bodyEl.className = 'message-body';
          bodyEl.innerHTML = renderMarkdown(safeText);
          block.appendChild(bodyEl);

          block.dataset.rawText = safeText;
          block.dataset.textLength = String(safeText.length);
          messages.appendChild(block);
          state.totalChars += safeText.length;
          trimOverflow();
          messages.scrollTop = messages.scrollHeight;
        });
      }

      function clearMessages() {
        enqueue(function () {
          messages.textContent = '';
          state.totalChars = 0;
        });
      }

      function setStatus(text, level, streaming) {
        if (level === void 0) level = 'info';
        if (streaming === void 0) streaming = false;
        statusText.textContent = text;
        statusRoot.dataset.level = level;
        state.isStreaming = streaming;
        spinner.hidden = !streaming;
        updateSendState();
      }

      function updateSendState() {
        var hasText = promptInput.value.trim().length > 0;
        sendBtn.disabled = state.isStreaming || !hasText;
      }

      function sendPrompt() {
        var value = promptInput.value.trim();
        if (!value || state.isStreaming) return;
        setStatus('Sending prompt…', 'info', true);
        appendBlock(value, 'user');
        vscode.postMessage({ type: 'send', prompt: value });
        promptInput.value = '';
        updateSendState();
      }

      promptInput.addEventListener('input', updateSendState);
      promptInput.addEventListener('keydown', function (event) {
        if ((event.metaKey || event.ctrlKey) && event.key === 'Enter') {
          event.preventDefault();
          sendPrompt();
        }
      });

      sendBtn.addEventListener('click', sendPrompt);

      window.addEventListener('message', function (event) {
        var msg = event.data;
        if (!msg) return;
        switch (msg.type) {
          case 'append':
            appendBlock(msg.text, msg.role || 'assistant');
            break;
          case 'fileList':
            try { currentFiles = msg.files || []; renderFileList(currentFiles, currentAttached); renderAttachedPills(currentAttached); } catch (e) { /* ignore */ }
            break;
          case 'attachedChanged':
            try { currentAttached = msg.files || []; renderFileList(currentFiles, currentAttached); renderAttachedPills(currentAttached); } catch (e) { /* ignore */ }
            break;
          case 'editor':
            setEditorLabel(msg.text || '');
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

      setStatus('Idle', 'info', false);
      updateSendState();
    })();
  </script>
</body>
</html>`;
        return html_content;
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
              webview.postMessage({ type: 'append', text: content, role: 'assistant' });
            }
          } catch (e) {
            webview.postMessage({ type: 'append', text: trimmed, role: 'assistant' });
          }
        }
      }

      if (buffer.trim()) {
        try {
          const p = JSON.parse(buffer.trim());
          const content = p?.message?.content || p?.response || '';
          if (content) webview.postMessage({ type: 'append', text: content, role: 'assistant' });
        } catch (e) {
          webview.postMessage({ type: 'append', text: buffer, role: 'assistant' });
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
    // Post current active editor filename to the webview when available and on changes
    const postEditorName = (editor?: vscode.TextEditor) => {
      try {
        const ed = editor || vscode.window.activeTextEditor;
        if (!ed) return;
        const view = (sidebarProvider as any)?._view;
        if (!view) return;
        const doc = ed.document;
        const fileName = doc.fileName && doc.fileName.length ? path.basename(doc.fileName) : (doc.uri && doc.uri.path ? path.basename(doc.uri.path) : doc.uri.toString());
        view.webview.postMessage({ type: 'editor', text: fileName });
      } catch (e) {
        LucidLogger.debug('postEditorName error', e);
      }
    };

    // initial post (if active editor exists)
    postEditorName();

    context.subscriptions.push(vscode.window.onDidChangeActiveTextEditor(postEditorName));
    context.subscriptions.push(vscode.workspace.onDidOpenTextDocument(() => postEditorName()));
    context.subscriptions.push(vscode.workspace.onDidSaveTextDocument(() => postEditorName()));
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
        } catch (_) { }
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

  // Send active editor contents (selection or whole file) to Ollama and apply response
  const sendActiveForEditCommand = vscode.commands.registerCommand('lucid.sendActiveForEdit', async () => {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      vscode.window.showInformationMessage('No active editor to send.');
      return;
    }

    const doc = editor.document;
    const selection = editor.selection;
    const textToSend = selection && !selection.isEmpty ? doc.getText(selection) : doc.getText();

    try {
      const result = await vscode.window.withProgress({ location: vscode.ProgressLocation.Notification, title: 'Sending code to Ollama', cancellable: false }, async () => {
        // Reuse local headers builder
        const endpoint = LucidConfig.getEndpoint();
        const model = LucidConfig.getModelName();
        const headers = await buildHeadersFromConfig();

        const resp = await fetch(`${endpoint}`, {
          method: 'POST',
          headers,
          body: JSON.stringify({ model: model, messages: [{ role: 'user', content: textToSend }], stream: false })
        });

        const txt = await resp.text().catch(() => resp.statusText || '');
        if (!resp.ok) throw new Error(`Ollama error ${resp.status}: ${txt}`);

        // Try to parse known shapes
        try {
          const parsed = JSON.parse(txt);
          // common shapes: { response } or { message: { content } } or { choices: [{ message: { content } }] }
          if (parsed.response && typeof parsed.response === 'string') return parsed.response;
          if (parsed.message && parsed.message.content) return parsed.message.content;
          if (Array.isArray(parsed.choices)) {
            let out = '';
            for (const c of parsed.choices) {
              out += c?.message?.content || c?.text || '';
            }
            if (out) return out;
          }
          // Fallback to raw text
          return typeof parsed === 'string' ? parsed : JSON.stringify(parsed, null, 2);
        } catch (e) {
          return txt;
        }
      });

      if (!result) return;

      // Apply response back into editor
      await editor.edit(editBuilder => {
        if (selection && !selection.isEmpty) {
          editBuilder.replace(selection, result);
        } else {
          // No selection: open a new untitled document with the response
        }
      });

      if ((!selection || selection.isEmpty) && result) {
        const newDoc = await vscode.workspace.openTextDocument({ content: result, language: doc.languageId });
        await vscode.window.showTextDocument(newDoc, { preview: false });
      }

      vscode.window.showInformationMessage('Ollama response applied to editor.');
    } catch (e) {
      vscode.window.showErrorMessage(`Error sending code: ${e instanceof Error ? e.message : String(e)}`);
    }
  });
  context.subscriptions.push(sendActiveForEditCommand);


}

export function deactivate() { }
