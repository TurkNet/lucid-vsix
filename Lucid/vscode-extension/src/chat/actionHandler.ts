import * as vscode from 'vscode';
import { spawn } from 'child_process';
import { LucidConfig } from '../../../common/config';
import { CurlLogger } from '../../../common/log/curlLogger';
import { LucidLogger } from '../../../common/log/logger';
import { AskHandler } from './askHandler';
import { ChatHistoryManager, StoredActionPreview, HistoryRole } from './historyManager';

export interface LucidActionPayload {
  command: string;
  args?: any[];
  type?: 'vscode' | 'terminal' | 'clipboard';
  text?: string;
  description?: string;
}

interface ActionExecutionResult {
  success: boolean;
  type: 'vscode' | 'terminal' | 'clipboard';
  stdout?: string;
  stderr?: string;
  exitCode?: number;
}

interface PendingActionEntry {
  id: string;
  payload: LucidActionPayload;
  webview: vscode.Webview;
  originalPrompt: string;
}

interface ActionPreviewUiPayload {
  snippet: string;
  language: string;
  typeLabel: string;
  description?: string;
  rawJson?: string;
  command?: string;
  actionId?: string;
  actionType?: 'vscode' | 'terminal' | 'clipboard';
}

export class ActionHandler {
  private readonly pendingActions = new Map<string, PendingActionEntry>();

  constructor(
    private readonly askHandler: AskHandler,
    private readonly buildHeadersFromConfig: () => Promise<Record<string, string>>,
    private readonly getExtensionContext: () => vscode.ExtensionContext | undefined,
    private readonly historyManager?: ChatHistoryManager
  ) { }

  async handleActionFlow(webview: vscode.Webview, finalPrompt: string, originalPrompt: string): Promise<void> {
    try {
      const responseText = await this.requestActionResponseFromOllama(webview, finalPrompt);
      if (!responseText || !responseText.trim()) {
        webview.postMessage({ type: 'append', text: 'Action mode response was empty.', role: 'system' });
        await this.logHistory('system', 'Action mode response was empty.', 'action');
        return;
      }

      const actionPayload = this.extractActionPayloadFromText(responseText);
      if (!actionPayload) {
        webview.postMessage({ type: 'append', text: 'No executable action block was found in the response.', role: 'system' });
        await this.logHistory('system', 'No executable action block was found in the response.', 'action');
        return;
      }

      const promptForReview = originalPrompt || finalPrompt;
      const actionId = this.registerPendingAction(webview, actionPayload, promptForReview);
      const preview = this.buildActionPreview(actionId, actionPayload);
      webview.postMessage({
        type: 'append',
        text: preview.message,
        role: 'system',
        options: { actionPreview: preview.ui }
      });
      webview.postMessage({ type: 'status', text: 'Action ready. Use the toolbar or Play button to execute.', streaming: false });
      await this.logHistory('system', preview.message, 'action', this.buildStoredPreview(preview.ui));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      webview.postMessage({ type: 'append', text: `Action mode failed: ${message}`, role: 'error' });
      webview.postMessage({ type: 'status', text: 'Action failed', level: 'error', streaming: false });
      LucidLogger.error('handleActionFlow error', err);
      await this.logHistory('error', `Action mode failed: ${message}`, 'action');
    }
  }

  private async requestActionResponseFromOllama(webview: vscode.Webview, prompt: string): Promise<string> {
    const endpoint = LucidConfig.getEndpoint();
    const model = LucidConfig.getModelName();
    const headers = await this.buildHeadersFromConfig();

    webview.postMessage({ type: 'status', text: 'Requesting action plan…', streaming: true });
    try {
      CurlLogger.log({
        url: endpoint,
        headers,
        body: { model, messages: [{ role: 'user', content: prompt }], stream: false },
        label: 'CURL requestActionResponseFromOllama',
        revealSensitive: this.shouldRevealSensitive()
      });

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify({ model, messages: [{ role: 'user', content: prompt }], stream: false })
      });

      const bodyText = await response.text().catch(() => response.statusText || '');
      if (!response.ok) {
        throw new Error(`Ollama error ${response.status}: ${bodyText}`);
      }

      const normalized = this.normalizeResponseText(bodyText);
      const contentToAppend = normalized || bodyText;
      if (contentToAppend) {
        webview.postMessage({ type: 'append', text: contentToAppend, role: 'assistant' });
        await this.logHistory('assistant', contentToAppend, 'action');
      }
      return contentToAppend;
    } finally {
      webview.postMessage({ type: 'status', text: 'Idle', streaming: false });
    }
  }

  private normalizeResponseText(bodyText: string): string {
    if (!bodyText) return '';
    try {
      const parsed = JSON.parse(bodyText);
      if (typeof parsed === 'string') return parsed;
      if (parsed.response && typeof parsed.response === 'string') return parsed.response;
      if (parsed.message && typeof parsed.message.content === 'string') return parsed.message.content;
      if (Array.isArray(parsed.choices)) {
        let combined = '';
        for (const choice of parsed.choices) {
          const chunk = choice?.message?.content || choice?.text || choice?.response;
          if (chunk) combined += String(chunk);
        }
        if (combined) return combined;
      }
      return JSON.stringify(parsed, null, 2);
    } catch (_) {
      return bodyText;
    }
  }

  private extractActionPayloadFromText(text: string): LucidActionPayload | undefined {
    if (!text) return undefined;
    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(text)) !== null) {
      const payload = this.tryParseActionJson(match[1]);
      if (payload) return payload;
    }

    const marker = text.indexOf('{"command"');
    if (marker === -1) return undefined;
    let braceDepth = 0;
    let snippet = '';
    for (let i = marker; i < text.length; i++) {
      const ch = text[i];
      snippet += ch;
      if (ch === '{') braceDepth++;
      else if (ch === '}') {
        braceDepth--;
        if (braceDepth === 0) break;
      }
    }
    return this.tryParseActionJson(snippet);
  }

  private tryParseActionJson(snippet: string): LucidActionPayload | undefined {
    try {
      const parsed = JSON.parse(snippet.trim());
      if (parsed && typeof parsed.command === 'string') {
        return parsed as LucidActionPayload;
      }
    } catch (_) {
      // ignore parse errors
    }
    return undefined;
  }

  private registerPendingAction(webview: vscode.Webview, payload: LucidActionPayload, originalPrompt: string): string {
    const id = `action-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    this.pendingActions.set(id, { id, payload, webview, originalPrompt });
    return id;
  }

  async runPendingAction(actionId: string, requestWebview: vscode.Webview): Promise<void> {
    const entry = this.pendingActions.get(actionId);
    if (!entry) {
      requestWebview.postMessage({ type: 'append', text: 'Action is no longer available.', role: 'system' });
      await this.logHistory('system', 'Action is no longer available.', 'action');
      return;
    }

    const targetView = entry.webview;
    targetView.postMessage({ type: 'status', text: 'Executing action…', streaming: false });
    try {
      const executionResult = await this.executeActionPayload(entry.payload);
      const summary = this.buildActionSummary(entry.payload, executionResult);
      targetView.postMessage({ type: 'append', text: summary, role: executionResult.success ? 'system' : 'error' });
      await this.logHistory(executionResult.success ? 'system' : 'error', summary, 'action');
      await this.sendActionReviewToOllama(targetView, entry.payload, executionResult, entry.originalPrompt, summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      targetView.postMessage({ type: 'append', text: `Action execution error: ${msg}`, role: 'error' });
      LucidLogger.error('runPendingAction error', err);
      await this.logHistory('error', `Action execution error: ${msg}`, 'action');
    } finally {
      targetView.postMessage({ type: 'status', text: 'Idle', streaming: false });
      this.pendingActions.delete(actionId);
    }
  }

  clearPendingActionsForWebview(webview: vscode.Webview) {
    for (const [id, entry] of this.pendingActions.entries()) {
      if (entry.webview === webview) {
        this.pendingActions.delete(id);
      }
    }
  }

  private buildActionPreview(actionId: string, payload: LucidActionPayload): { message: string; ui: ActionPreviewUiPayload } {
    const type = this.inferActionType(payload);
    const snippet = this.buildActionSnippet(payload, type);
    const language = this.inferPreviewLanguage(type, payload);
    const label = this.describeTypeLabel(type);
    const description = payload.description || `Command: ${payload.command}`;
    const headline = description ? `${label} ready: ${description}` : `${label} ready.`;
    const rawJson = JSON.stringify(payload, null, 2);
    return {
      message: `${headline} Use Play to execute or the toolbar for snippet actions.`,
      ui: {
        actionId,
        actionType: type,
        snippet,
        language,
        typeLabel: label,
        description,
        rawJson,
        command: payload.command
      }
    };
  }

  private buildActionSnippet(payload: LucidActionPayload, type: 'clipboard' | 'vscode' | 'terminal'): string {
    if (type === 'terminal') {
      const normalized = this.buildTerminalCommandParts(payload);
      const parts = [normalized.command].concat(normalized.args || []);
      return parts.filter(Boolean).join(' ').trim();
    }
    if (type === 'clipboard') {
      return payload.text || (Array.isArray(payload.args) && payload.args.length ? this.stringifyArg(payload.args[0]) : payload.command);
    }
    const snippetText = this.extractSnippetText(payload.args);
    if (snippetText) {
      return snippetText;
    }
    return JSON.stringify({ command: payload.command, args: payload.args || [] }, null, 2);
  }

  private inferPreviewLanguage(type: 'clipboard' | 'vscode' | 'terminal', payload: LucidActionPayload): string {
    if (type === 'terminal') return 'bash';
    if (type === 'clipboard') return 'text';
    if (type === 'vscode' && this.extractSnippetText(payload.args)) return 'text';
    return type === 'vscode' ? 'json' : 'text';
  }

  private extractSnippetText(args?: any[] | any): string | undefined {
    const candidate = Array.isArray(args) ? args[0] : args;
    if (!candidate) return undefined;
    if (typeof candidate === 'string') return candidate;
    if (typeof candidate === 'object' && typeof (candidate as any).snippet === 'string') {
      return (candidate as any).snippet;
    }
    return undefined;
  }

  private describeTypeLabel(type: 'clipboard' | 'vscode' | 'terminal'): string {
    switch (type) {
      case 'terminal': return 'Terminal Action';
      case 'vscode': return 'VS Code Action';
      case 'clipboard': return 'Clipboard Action';
      default: return 'Action';
    }
  }

  private async logHistory(role: HistoryRole, text: string, mode: 'ask' | 'action' | undefined, preview?: StoredActionPreview) {
    if (!this.historyManager || !text || !text.trim()) return;
    await this.historyManager.appendEntry({ role, text, mode, actionPreview: preview, timestamp: Date.now() });
  }

  private buildStoredPreview(ui?: ActionPreviewUiPayload): StoredActionPreview | undefined {
    if (!ui) return undefined;
    return {
      snippet: ui.snippet,
      language: ui.language,
      typeLabel: ui.typeLabel,
      description: ui.description,
      rawJson: ui.rawJson,
      command: ui.command,
      actionType: ui.actionType
    };
  }

  private async executeActionPayload(action: LucidActionPayload): Promise<ActionExecutionResult> {
    const kind = this.inferActionType(action);
    if (kind === 'clipboard') {
      const text = typeof action.text === 'string'
        ? action.text
        : Array.isArray(action.args) && action.args.length > 0
          ? this.stringifyArg(action.args[0])
          : '';
      await vscode.env.clipboard.writeText(text);
      vscode.window.showInformationMessage('Lucid action copied text to clipboard.');
      return { success: true, type: 'clipboard', stdout: text };
    }

    if (kind === 'vscode') {
      try {
        const commandArgs = this.coerceCommandArgs(action.args);
        await vscode.commands.executeCommand(action.command, ...commandArgs);
        return { success: true, type: 'vscode', stdout: 'VS Code command executed.' };
      } catch (err) {
        const stderr = err instanceof Error ? err.message : String(err);
        return { success: false, type: 'vscode', stderr };
      }
    }

    const terminalParts = this.buildTerminalCommandParts(action);
    return this.runTerminalAction(terminalParts.command, terminalParts.args);
  }

  private buildTerminalCommandParts(action: LucidActionPayload): { command: string; args: string[] } {
    let command = action.command.trim();
    let args = Array.isArray(action.args) ? action.args.map(this.stringifyArg) : [];

    const normalized = command.toLowerCase();
    const isWrapper = normalized === 'terminal.runinterminal'
      || normalized === 'lucid.runinterminal'
      || normalized === 'lucid.runterminalcommand'
      || normalized === 'terminal.runshellcommand'
      || normalized === 'lucid.runshellcommand';
    if (isWrapper && args.length > 0) {
      const composite = args.join(' ').trim();
      if (composite.length > 0) {
        const parts = composite.split(' ').filter(Boolean);
        command = parts.shift() || command;
        args = parts;
        return { command, args };
      }
    }

    if ((!args || args.length === 0) && command.includes(' ')) {
      const parts = command.split(' ').filter(Boolean);
      command = parts.shift() || command;
      args = parts;
    }

    return { command, args };
  }

  private async runTerminalAction(command: string, args: string[]): Promise<ActionExecutionResult> {
    return await new Promise<ActionExecutionResult>((resolve) => {
      const writeEmitter = new vscode.EventEmitter<string>();
      let child: ReturnType<typeof spawn> | undefined;
      let stdout = '';
      let stderr = '';
      let resolved = false;

      const finish = (result: ActionExecutionResult) => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };

      const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        open: () => {
          const cwd = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : process.cwd();
          writeEmitter.fire(`Running ${command} ${args.join(' ')}\r\n\r\n`);
          child = spawn(command, args, { cwd, shell: process.platform === 'win32' });
          child.stdout?.on('data', (chunk) => {
            const text = chunk.toString();
            stdout += text;
            writeEmitter.fire(text.replace(/\n/g, '\r\n'));
          });
          child.stderr?.on('data', (chunk) => {
            const text = chunk.toString();
            stderr += text;
            writeEmitter.fire(text.replace(/\n/g, '\r\n'));
          });
          child.on('error', (err) => {
            const message = err instanceof Error ? err.message : String(err);
            stderr += message;
            writeEmitter.fire(`\r\n${message}\r\n`);
            finish({ success: false, type: 'terminal', stdout, stderr: message });
          });
          child.on('close', (code) => {
            writeEmitter.fire(`\r\nProcess exited with code ${code ?? 'unknown'}\r\n`);
            finish({ success: (code ?? 1) === 0, type: 'terminal', stdout, stderr, exitCode: code ?? undefined });
          });
        },
        close: () => {
          if (child && !child.killed) {
            child.kill();
          }
        }
      };

      const terminal = vscode.window.createTerminal({ name: `Lucid Action: ${command}`, pty });
      terminal.show(true);
    });
  }

  private buildActionSummary(action: LucidActionPayload, result: ActionExecutionResult): string {
    const label = this.describeTypeLabel(result.type);
    const statusLine = result.success ? `${label} completed successfully.` : `${label} encountered an error.`;
    const details: string[] = [statusLine];

    if (action.description) {
      details.push(action.description);
    }

    if (result.type === 'vscode') {
      if (action.command === 'editor.action.insertSnippet') {
        const snippet = this.extractSnippetText(action.args);
        if (snippet) {
          details.push(`Snippet applied:\n${this.truncateForReview(snippet, 800)}`);
        }
      }
      if (!result.success && result.stderr) {
        details.push(`VS Code reported: ${result.stderr}`);
      }
    } else {
      if (result.stdout) {
        details.push(`Output:\n${this.truncateForReview(result.stdout)}`);
      }
      if (result.stderr) {
        details.push(`Errors:\n${this.truncateForReview(result.stderr)}`);
      }
    }

    if (!result.success) {
      details.push(`Command: ${action.command}`);
    }

    return details.filter(Boolean).join('\n\n');
  }

  private truncateForReview(text: string | undefined, max = 1000): string {
    if (!text) return '';
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…`;
  }

  private async sendActionReviewToOllama(
    webview: vscode.Webview,
    action: LucidActionPayload,
    result: ActionExecutionResult,
    originalPrompt: string,
    summary: string
  ): Promise<void> {
    try {
      const reviewPrompt = [
        'You previously requested an executable action for the following prompt:',
        originalPrompt,
        'The action was executed with this summary:',
        summary,
        'Did the action succeed? Respond with PASS if satisfied or outline the next step. Only include another action JSON block if a follow-up command is required.'
      ].join('\n\n');
      webview.postMessage({ type: 'append', text: 'Validating action output with Ollama…', role: 'system' });
      await this.askHandler.sendPrompt(webview, reviewPrompt);
    } catch (err) {
      LucidLogger.error('sendActionReviewToOllama error', err);
    }
  }

  private coerceCommandArgs(args?: any[] | any): any[] {
    if (Array.isArray(args)) return args;
    if (typeof args !== 'undefined') return [args];
    return [];
  }

  private stringifyArg = (arg: any): string => {
    if (arg === undefined || arg === null) return '';
    if (typeof arg === 'string') return arg;
    if (typeof arg === 'number' || typeof arg === 'boolean') return String(arg);
    if (typeof arg === 'object') return JSON.stringify(arg);
    return String(arg);
  };

  private inferActionType(action: LucidActionPayload): 'clipboard' | 'vscode' | 'terminal' {
    if (action.type) return action.type;
    const command = (action.command || '').toLowerCase();
    if (command.startsWith('terminal.') || command.startsWith('bash') || command.startsWith('sh ') || command.startsWith('./')) {
      return 'terminal';
    }
    if (command.includes('clipboard') || command.startsWith('copy')) return 'clipboard';
    if (command.includes('.') && !command.includes(' ')) return 'vscode';
    return 'terminal';
  }

  private shouldRevealSensitive(): boolean {
    const context = this.getExtensionContext();
    return context ? CurlLogger.shouldRevealSensitive(context) : false;
  }
}
