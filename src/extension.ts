import * as vscode from 'vscode';

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

export function activate(context: vscode.ExtensionContext) {

  // --- 1. Chat Participant (Sohbet) ---
  const lucidParticipant = vscode.chat.createChatParticipant('lucid.ollama', async (request, chatContext, stream, token) => {

    const config = vscode.workspace.getConfiguration('lucid');
    const endpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434');
    const model = config.get<string>('modelName', 'llama3');

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
      console.error('Failed to parse OLLAMA_EXTRA_HEADERS:', e);
    }

    const configExtra = config.get<{ [key: string]: string }>('ollamaExtraHeaders', {});
    const combinedExtra: { [key: string]: string } = Object.assign({}, configExtra || {}, envExtraHeaders || {});

    // API key can be set via environment variable or settings
    const apiKey = process.env.OLLAMA_API_KEY || config.get<string>('ollamaApiKey', '') || '';

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
      try {
        const url = `${endpoint}`;
        // Send only the current user message to Ollama; keep fullHistory locally
        const currentMessage = { role: 'user', content: request.prompt };
        const bodyObj = { model: model, messages: [currentMessage], stream: false };
        const bodyStr = JSON.stringify(bodyObj);
        const logUnmasked = config.get<boolean>('logUnmaskedHeaders', false);
        const logUnmaskedInDev = config.get<boolean>('logUnmaskedHeadersInDev', true);
        const isDev = context.extensionMode === vscode.ExtensionMode.Development;
        const reveal = logUnmasked || (logUnmaskedInDev && isDev);

        let curl = `curl -s -X POST '${url}'`;
        for (const k of Object.keys(combinedExtra)) {
          const v = (combinedExtra as any)[k];
          const kl = k.toLowerCase();
          const isSensitive = kl === 'x-api-key' || kl.includes('authorization');
          const display = (reveal || !isSensitive) ? v : '****';
          curl += ` -H '${k}: ${display}'`;
        }
        curl += ` --data-raw '${bodyStr.replace(/'/g, "'\\''")}'`;
        console.log('[Lucid] CURL:', curl);
      } catch (e) {
        console.error('Failed to build curl log:', e);
      }

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
            console.error('JSON parse error:', e, 'Line:', trimmed);
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

      const config = vscode.workspace.getConfiguration('lucid');
      if (!config.get<boolean>('enableInlineCompletion', true)) {
        return [];
      }

      const endpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434');
      const model = config.get<string>('modelName', 'llama3');

      // Inline completion should use same headers + API key
      let envExtraHeaders2: { [key: string]: string } = {};
      try {
        const raw = process.env.OLLAMA_EXTRA_HEADERS;
        if (raw) {
          const parsed = JSON.parse(raw);
          if (parsed && typeof parsed === 'object') envExtraHeaders2 = parsed as any;
        }
      } catch (e) {
        console.error('Failed to parse OLLAMA_EXTRA_HEADERS:', e);
      }
      const configExtra2 = config.get<{ [key: string]: string }>('ollamaExtraHeaders', {});
      const combinedExtra2: { [key: string]: string } = Object.assign({}, configExtra2 || {}, envExtraHeaders2 || {});
      const apiKey2 = process.env.OLLAMA_API_KEY || config.get<string>('ollamaApiKey', '') || '';
      const baseHeaders2: { [key: string]: string } = { 'Content-Type': 'application/json' };
      Object.assign(baseHeaders2, combinedExtra2);
      if (apiKey2) baseHeaders2['X-API-Key'] = apiKey2;

      // Basit bir prompt oluşturma: İmleçten önceki son 2000 karakteri al
      const textBeforeCursor = document.getText(new vscode.Range(new vscode.Position(0, 0), position));
      const prompt = `Complete the following code. Do not include any explanation, just the code.\n\n${textBeforeCursor.slice(-2000)}`;

      try {
        // Build and log a curl command for generate (mask sensitive headers)
        try {
          const url = `${endpoint}/api/generate`;
          const bodyObj = { model: model, prompt: prompt, stream: false, options: { stop: ["\n\n", "```"] } };
          const bodyStr = JSON.stringify(bodyObj);
          const logUnmasked = config.get<boolean>('logUnmaskedHeaders', false);
          const logUnmaskedInDev = config.get<boolean>('logUnmaskedHeadersInDev', true);
          const isDev = context.extensionMode === vscode.ExtensionMode.Development;
          const reveal = logUnmasked || (logUnmaskedInDev && isDev);

          let curl = `curl -s -X POST '${url}'`;
          for (const k of Object.keys(baseHeaders2)) {
            const v = (baseHeaders2 as any)[k];
            const kl = k.toLowerCase();
            const isSensitive = kl === 'x-api-key' || kl.includes('authorization');
            const display = (reveal || !isSensitive) ? v : '****';
            curl += ` -H '${k}: ${display}'`;
          }
          curl += ` --data-raw '${bodyStr.replace(/'/g, "'\\''")}'`;
          console.log('[Lucid] CURL:', curl);
        } catch (e) {
          console.error('Failed to build curl log (generate):', e);
        }

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
        console.error("Ollama inline completion error:", e);
      }

      return [];
    }
  };

  // Tüm diller için provider'ı kaydet
  context.subscriptions.push(vscode.languages.registerInlineCompletionItemProvider({ pattern: '**' }, provider));

  // --- 3. File send helper + Commands ---
  async function buildHeadersFromConfig(): Promise<{ [key: string]: string }> {
    const config = vscode.workspace.getConfiguration('lucid');
    let envExtraHeaders: { [key: string]: string } = {};
    try {
      const raw = process.env.OLLAMA_EXTRA_HEADERS;
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && typeof parsed === 'object') envExtraHeaders = parsed as any;
      }
    } catch (e) {
      console.error('Failed to parse OLLAMA_EXTRA_HEADERS:', e);
    }
    const configExtra = config.get<{ [key: string]: string }>('ollamaExtraHeaders', {});
    const combined: { [key: string]: string } = Object.assign({}, configExtra || {}, envExtraHeaders || {});
    const apiKey = process.env.OLLAMA_API_KEY || config.get<string>('ollamaApiKey', '') || '';
    if (!Object.keys(combined).some(k => k.toLowerCase() === 'content-type')) {
      combined['Content-Type'] = 'application/json';
    }
    if (apiKey) combined['X-API-Key'] = apiKey;
    return combined;
  }

  async function sendFileUri(uri: vscode.Uri): Promise<{ ok: boolean; status: number; text: string } | undefined> {
    try {
      const config = vscode.workspace.getConfiguration('lucid');
      const endpoint = config.get<string>('ollamaEndpoint', 'http://localhost:11434');
      const model = config.get<string>('modelName', 'llama3');

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
      if (!resp.ok) return { ok: false, status: resp.status, text };
      return { ok: true, status: resp.status, text };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      throw new Error(msg);
    }
  }

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
