import * as vscode from 'vscode';
import { LucidConfig } from '../../../common/config';
import { CurlLogger } from '../../../common/log/curlLogger';
import { ChatHistoryManager } from './historyManager';

export type HeadersBuilder = () => Promise<Record<string, string>>;
export type ExtensionContextProvider = () => vscode.ExtensionContext | undefined;

export class AskHandler {
  constructor(
    private readonly buildHeadersFromConfig: HeadersBuilder,
    private readonly getExtensionContext: ExtensionContextProvider,
    private readonly historyManager?: ChatHistoryManager
  ) { }

  async sendPrompt(webview: vscode.Webview, prompt: string): Promise<void> {
    const endpoint = LucidConfig.getEndpoint();
    const model = LucidConfig.getModelName();
    const headers = await this.buildHeadersFromConfig();
    const streamingStatusEnabled = LucidConfig.shouldShowStreamingStatus();

    try {
      CurlLogger.log({
        url: endpoint,
        headers,
        body: { model, messages: [{ role: 'user', content: prompt }], stream: streamingStatusEnabled },
        label: 'CURL sendPromptToOllama',
        revealSensitive: this.shouldRevealSensitive()
      });

      webview.postMessage({ type: 'status', text: 'Connecting to Ollama…', streaming: streamingStatusEnabled });
      const response = await fetch(`${endpoint}` , {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: streamingStatusEnabled })
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
      let collected = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');

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
              collected += content;
            }
          } catch (e) {
            webview.postMessage({ type: 'append', text: trimmed, role: 'assistant' });
            collected += trimmed;
          }
        }
      }

      if (buffer.trim()) {
        try {
          const parsed = JSON.parse(buffer.trim());
          const content = parsed?.message?.content || parsed?.response || '';
          if (content) {
            webview.postMessage({ type: 'append', text: content, role: 'assistant' });
            collected += content;
          }
        } catch (_) {
          webview.postMessage({ type: 'append', text: buffer, role: 'assistant' });
          collected += buffer;
        }
      }

      webview.postMessage({ type: 'status', text: 'Idle', streaming: false });
      if (collected && collected.trim()) {
        await this.logHistory('assistant', collected, 'ask');
      }
    } catch (err) {
      webview.postMessage({
        type: 'status',
        text: err instanceof Error ? err.message : 'Ollama request failed',
        level: 'error',
        streaming: false
      });
      const errorText = err instanceof Error ? err.message : 'Ollama request failed';
      await this.logHistory('error', errorText, 'ask');
      throw err;
    }
  }

  private shouldRevealSensitive(): boolean {
    const context = this.getExtensionContext();
    return context ? CurlLogger.shouldRevealSensitive(context) : false;
  }

  private async logHistory(role: 'assistant' | 'error', text: string, mode: 'ask') {
    if (!this.historyManager || !text || !text.trim()) return;
    await this.historyManager.appendEntry({ role, text, mode, timestamp: Date.now() });
  }
}
