import * as vscode from 'vscode';
import * as path from 'path';
import * as fs from 'fs';
import { CurlLogger } from '../../common/log/curlLogger';
import { LucidConfig } from '../../common/config';
import { LucidLogger } from '../../common/log/logger';

let extensionContext: vscode.ExtensionContext | undefined;

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

function getNonce(): string {
  const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
  let nonce = '';
  for (let i = 0; i < 24; i++) nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}

async function buildHeadersFromConfig(): Promise<Record<string, string>> {
  const headers: Record<string, string> = { 'Content-Type': 'application/json' };
  try {
    const apiKey = LucidConfig.getApiKey();
    const apiKeyHeaderName = LucidConfig.getApiKeyHeaderName();
    LucidLogger.debug('apiKeyHeaderName resolved', apiKeyHeaderName);
    if (typeof console !== 'undefined') console.log('apiKeyHeaderName=', apiKeyHeaderName);
    if (apiKey && apiKey.length) headers[apiKeyHeaderName] = `${apiKey}`;
    const extra = LucidConfig.getExtraHeaders() || {};
    for (const k of Object.keys(extra)) {
      try { headers[k] = String((extra as any)[k]); } catch (_) { }
    }
  } catch (e) {
    LucidLogger.debug('buildHeadersFromConfig error', e);
  }
  return headers;
}

// Send a file's contents to the Ollama endpoint and return a normalized response
async function sendFileUri(uri: vscode.Uri): Promise<{ ok: boolean; status: number; text: string; json?: any }> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString('utf8');
    const endpoint = LucidConfig.getEndpoint();
    const model = LucidConfig.getModelName();
    const headers = await buildHeadersFromConfig();

    const resp = await fetch(endpoint, {
      method: 'POST',
      headers,
      body: JSON.stringify({ model: model, messages: [{ role: 'user', content: text }], stream: false })
    });

    const bodyText = await resp.text().catch(() => resp.statusText || '');
    let parsed: any = undefined;
    try { parsed = JSON.parse(bodyText); } catch (_) { parsed = undefined; }

    // Provide simple interactive actions to the user from the caller
    if (resp.ok) {
      // Attempt to surface useful actions if the response contains urls or ids
      const urls: string[] = [];
      const id = parsed && parsed.id ? String(parsed.id) : undefined;
      // if parsed contains fields with http(s) strings, collect them (best-effort)
      try {
        const maybe = parsed || {};
        for (const k of Object.keys(maybe)) {
          const v = maybe[k];
          if (typeof v === 'string' && (v.startsWith('http://') || v.startsWith('https://'))) urls.push(v);
          if (Array.isArray(v)) {
            for (const item of v) if (typeof item === 'string' && (item.startsWith('http://') || item.startsWith('https://'))) urls.push(item);
          }
        }
      } catch (_) { }

      if (urls.length > 0 || id || parsed) {
        const actions: string[] = [];
        if (urls.length > 0) actions.push('Open URL');
        if (id) actions.push('Copy ID');
        actions.push('Show Raw');

        const pick = await vscode.window.showInformationMessage(`File sent — status ${resp.status}`, ...actions);
        if (pick === 'Open URL' && urls.length > 0) {
          const pickUrl = urls.length === 1 ? urls[0] : await vscode.window.showQuickPick(urls, { placeHolder: 'Select URL to open' });
          if (pickUrl) await vscode.env.openExternal(vscode.Uri.parse(pickUrl));
        } else if (pick === 'Copy ID' && id) {
          await vscode.env.clipboard.writeText(String(id));
          vscode.window.showInformationMessage('ID copied to clipboard');
        } else if (pick === 'Show Raw') {
          const doc = await vscode.workspace.openTextDocument({ content: JSON.stringify(parsed || bodyText, null, 2), language: 'json' });
          await vscode.window.showTextDocument(doc, { preview: true });
        }
      }

    }

    return { ok: resp.ok, status: resp.status, text: bodyText, json: parsed };
  } catch (e) {
    LucidLogger.error('sendFileUri error', e);
    return { ok: false, status: 0, text: String(e) };
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
        revealSensitive: extensionContext ? CurlLogger.shouldRevealSensitive(extensionContext) : false
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

            if (msg.type === 'replay') {
              const prompt: string = String(msg.prompt || '');
              if (!prompt) return;
              const streamingStatusEnabledReplay = LucidConfig.shouldShowStreamingStatus();
              webviewView.webview.postMessage({ type: 'status', text: 'Sending prompt…', streaming: streamingStatusEnabledReplay });

              let combinedReplay = '';
              if (attachedPaths.size > 0) {
                for (const p of Array.from(attachedPaths)) {
                  try {
                    const uri = vscode.Uri.file(p);
                    const bytes = await vscode.workspace.fs.readFile(uri);
                    const text = Buffer.from(bytes).toString('utf8');
                    combinedReplay += `--- ATTACHED: ${p.split('/').pop()} ---\n${text}\n--- END ATTACHED ---\n\n`;
                  } catch (e) {
                    LucidLogger.error('Failed to read attached file ' + p, e);
                  }
                }
              } else {
                try {
                  const ed = vscode.window.activeTextEditor;
                  if (ed && ed.document) {
                    const doc = ed.document;
                    const fileName = doc.fileName && doc.fileName.length ? path.basename(doc.fileName) : (doc.uri && doc.uri.path ? path.basename(doc.uri.path) : undefined);
                    const text = doc.getText();
                    combinedReplay += `--- ACTIVE EDITOR: ${fileName || 'untitled'} ---\n${text}\n--- END ACTIVE EDITOR ---\n\n`;
                  }
                } catch (e) {
                  LucidLogger.debug('Failed to read active editor for fallback attached content', e);
                }
              }

              const finalPromptReplay = combinedReplay + '\n' + prompt;
              try {
                await sendPromptToOllama(webviewView.webview, finalPromptReplay);
              } catch (e) {
                const text = e instanceof Error ? e.message : String(e);
                LucidLogger.error('sendPromptToOllama (replay) error', e);
                webviewView.webview.postMessage({ type: 'error', text });
                webviewView.webview.postMessage({ type: 'status', text: 'Ollama request failed', level: 'error', streaming: false });
              }
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

        // Load external HTML template (shared between VS Code and Visual Studio)
        const templatePath = path.join(this._extensionUri.fsPath, '..', 'common', 'html', 'ui.html');
        const raw = fs.readFileSync(templatePath, 'utf8');
        const filled = raw.replace(/__NONCE__/g, nonce).replace(/__CSP_META__/g, `<meta http-equiv="Content-Security-Policy" content="${csp}">`);
        return filled;
      } catch (e) {
        LucidLogger.error('_getHtmlForWebview error', e);
        return `<body><pre>Failed to render UI: ${String(e)}</pre></body>`;
      }
    }
  }

  export function activate(context: vscode.ExtensionContext) {
    extensionContext = context;

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
