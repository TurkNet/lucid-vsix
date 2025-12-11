import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import * as os from 'os';
import { LucidConfig } from '../../../common/config';
import { CurlLogger } from '../../../common/log/curlLogger';
import { LucidLogger } from '../../../common/log/logger';
import { AskHandler } from './askHandler';
import { ChatHistoryManager, StoredActionPreview, HistoryRole, StoredActionResult } from './historyManager';
import { postWorkflowSummaryMessage } from './workflowSummary';

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
  command?: string;
  args?: string[];
  cwd?: string;
  suggestions?: string[];
  autoEditReview?: AutoEditReviewDisplay;
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

interface RemediationStepAction {
  command?: string;
  args?: any[];
  type?: 'vscode' | 'terminal' | 'clipboard';
  text?: string;
  description?: string;
}

interface RemediationPlanStep {
  title?: string;
  description?: string;
  action?: RemediationStepAction;
}

interface RemediationPlanPayload {
  title?: string;
  summary?: string;
  steps?: RemediationPlanStep[];
}

interface RemediationPlanResult {
  plan?: RemediationPlanPayload;
  rawText?: string;
}

interface TodoListItemPayload {
  id: string;
  title: string;
  detail?: string;
  snippet?: string;
  actionId?: string;
}

interface TodoListWebviewPayload {
  title?: string;
  description?: string;
  items: TodoListItemPayload[];
}

interface AutoEditReviewDisplay {
  id: string;
  diff: string;
  fileName?: string;
  description?: string;
  path?: string;
  added?: number;
  removed?: number;
  command?: string;
  status?: 'pending' | 'kept' | 'undone';
}

interface PendingAutoEditReview extends AutoEditReviewDisplay {
  documentUri: string;
  documentPath?: string;
  documentVersion: number;
  languageId?: string;
  beforeText: string;
  afterText: string;
  timestamp: number;
}

const TERMINAL_FILE_EDIT_COMMANDS = new Set([
  'sed',
  'perl',
  'python',
  'python3',
  'ruby',
  'node',
  'npx',
  'npm',
  'pnpm',
  'yarn',
  'deno',
  'bash',
  'sh',
  'zsh',
  'fish',
  'pwsh',
  'powershell',
  'cmd',
  'awk',
  'patch',
  'apply_patch',
  'ed',
  'cat',
  'tee'
]);

const DIFFABLE_EDITOR_COMMANDS = new Set<string>([
  'editor.action.insert',
  'editor.action.insertsnippet',
  'editor.action.delete',
  'editor.action.deletelines',
  'editor.action.clipboardcutaction'
]);

export class ActionHandler {
  private readonly pendingActions = new Map<string, PendingActionEntry>();
  private readonly pendingAutoEditReviews = new Map<string, PendingAutoEditReview>();

  constructor(
    private readonly askHandler: AskHandler,
    private readonly buildHeadersFromConfig: () => Promise<Record<string, string>>,
    private readonly getExtensionContext: () => vscode.ExtensionContext | undefined,
    private readonly historyManager?: ChatHistoryManager
  ) { }

  async handleActionFlow(webview: vscode.Webview, finalPrompt: string, originalPrompt: string): Promise<void> {
    try {
      const responseText = await this.requestActionResponseFromOllama(webview, finalPrompt, false);
      if (!responseText || !responseText.trim()) {
        webview.postMessage({ type: 'append', text: 'Action mode response was empty.', role: 'system' });
        await this.logHistory('system', 'Action mode response was empty.', 'agent');
        return;
      }

      const actionPayload = this.extractActionPayloadFromText(responseText);
      if (!actionPayload) {
        webview.postMessage({ type: 'append', text: 'No executable action block was found in the response.', role: 'system' });
        await this.logHistory('system', 'No executable action block was found in the response.', 'agent');
        return;
      }

      const promptForReview = originalPrompt || finalPrompt;
      if (this.shouldAutoExecuteVsCodeAction(actionPayload)) {
        await this.executeAutoVsCodeAction(webview, actionPayload);
        return;
      }
      const actionId = this.registerPendingAction(webview, actionPayload, promptForReview);
      const preview = this.buildActionPreview(actionId, actionPayload);
      webview.postMessage({
        type: 'append',
        text: preview.message,
        role: 'assistant',
        options: { actionPreview: preview.ui }
      });
      webview.postMessage({ type: 'status', text: 'Action ready. Use the toolbar or Play button to execute.', streaming: false });
      await this.logHistory('assistant', preview.message, 'agent', this.buildStoredPreview(preview.ui));
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      webview.postMessage({ type: 'append', text: `Action mode failed: ${message}`, role: 'error' });
      webview.postMessage({ type: 'status', text: 'Action failed', level: 'error', streaming: false });
      LucidLogger.error('handleActionFlow error', err);
      await this.logHistory('error', `Action mode failed: ${message}`, 'agent');
    }
  }

  private shouldAutoExecuteVsCodeAction(payload: LucidActionPayload): boolean {
    if (!payload || typeof payload.command !== 'string') {
      return false;
    }
    const type = this.inferActionType(payload);
    if (type !== 'vscode') {
      return false;
    }
    return payload.command.trim().toLowerCase().startsWith('editor.action.');
  }

  private async executeAutoVsCodeAction(webview: vscode.Webview, payload: LucidActionPayload): Promise<void> {
    webview.postMessage({ type: 'status', text: 'Applying VS Code action…', streaming: false });
    try {
      const executionResult = await this.executeActionPayload(payload);
      const summary = this.buildActionSummary(payload, executionResult);
      const prefix = `VS Code action ${payload.command} was applied automatically.`;
      const message = summary ? `${prefix}\n\n${summary}` : prefix;
      const role: HistoryRole = executionResult.success ? 'assistant' : 'error';
      const options = executionResult.autoEditReview ? { autoEditReview: executionResult.autoEditReview } : undefined;
      webview.postMessage({ type: 'append', text: message, role, options });
      await this.logHistory(role, message, 'agent');
      if (executionResult.autoEditReview) {
        await this.emitAutoEditWorkflowSummary(webview, executionResult.autoEditReview.id);
      }
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const text = `Automatic VS Code action failed: ${message}`;
      webview.postMessage({ type: 'append', text, role: 'error' });
      LucidLogger.error('executeAutoVsCodeAction error', err);
      await this.logHistory('error', text, 'agent');
    } finally {
      webview.postMessage({ type: 'status', text: 'Idle', streaming: false });
    }
  }

  private async requestActionResponseFromOllama(webview: vscode.Webview, prompt: string, emitToChat = true): Promise<string> {
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
      if (contentToAppend && emitToChat) {
        webview.postMessage({ type: 'append', text: contentToAppend, role: 'assistant' });
        await this.logHistory('assistant', contentToAppend, 'agent');
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
        return this.normalizeParsedPayload(parsed as LucidActionPayload);
      }
    } catch (_) {
      // ignore parse errors
    }
    return undefined;
  }

  private normalizeParsedPayload(payload: LucidActionPayload): LucidActionPayload {
    const normalized: LucidActionPayload = { ...payload };
    const type = this.inferActionType(normalized);
    if (type === 'terminal') {
      const parts = this.buildTerminalCommandParts(normalized);
      normalized.command = parts.command;
      normalized.args = parts.args;
      normalized.type = 'terminal';
    } else if (type === 'vscode') {
      const lowered = (normalized.command || '').trim().toLowerCase();
      if (lowered === 'vscode') {
        const args = this.coerceCommandArgs(normalized.args);
        const delegated = typeof args[0] === 'string' ? args.shift() : this.stringifyArg(args.shift());
        if (delegated && delegated.length) {
          normalized.command = delegated;
          normalized.args = args;
        }
      }
    }
    return normalized;
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
      await this.logHistory('system', 'Action is no longer available.', 'agent');
      return;
    }

    const targetView = entry.webview;
    targetView.postMessage({ type: 'status', text: 'Executing action…', streaming: false });
    try {
      const executionResult = await this.executeActionPayload(entry.payload);
      const summary = this.buildActionSummary(entry.payload, executionResult);
      const storedResult = this.buildStoredActionResult(entry.payload, executionResult);
      const optionsPayload: Record<string, any> = {};
      if (storedResult) optionsPayload.actionOutput = storedResult;
      if (executionResult.autoEditReview) optionsPayload.autoEditReview = executionResult.autoEditReview;
      const options = Object.keys(optionsPayload).length ? optionsPayload : undefined;
      targetView.postMessage({ type: 'append', text: summary, role: executionResult.success ? 'assistant' : 'error', options });
      await this.logHistory(executionResult.success ? 'assistant' : 'error', summary, 'agent', undefined, storedResult);
      if (executionResult.autoEditReview) {
        await this.emitAutoEditWorkflowSummary(targetView, executionResult.autoEditReview.id);
      }
      await this.sendActionReviewToOllama(targetView, entry.payload, executionResult, entry.originalPrompt, summary);
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      targetView.postMessage({ type: 'append', text: `Action execution error: ${msg}`, role: 'error' });
      LucidLogger.error('runPendingAction error', err);
      await this.logHistory('error', `Action execution error: ${msg}`, 'agent');
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

  async keepAutoEditReview(reviewId: string, webview: vscode.Webview): Promise<void> {
    const entry = this.pendingAutoEditReviews.get(reviewId);
    if (!entry) {
      this.postAutoEditReviewUpdate(webview, reviewId, 'error', 'Change is no longer available to confirm.');
      return;
    }
    entry.status = 'kept';
    this.postAutoEditReviewUpdate(webview, reviewId, 'kept', 'Change kept. You can continue editing normally.');
    await this.emitAutoEditWorkflowSummary(webview, reviewId);
    await this.logHistory('assistant', `Auto-applied edit kept (${entry.fileName || 'document'}).`, 'agent');
  }

  async undoAutoEditReview(reviewId: string, webview: vscode.Webview): Promise<void> {
    const entry = this.pendingAutoEditReviews.get(reviewId);
    if (!entry) {
      this.postAutoEditReviewUpdate(webview, reviewId, 'error', 'Change is no longer available to undo.');
      return;
    }
    let document = this.findDocument(entry.documentUri);
    if (!document) {
      try {
        document = await vscode.workspace.openTextDocument(vscode.Uri.parse(entry.documentUri));
      } catch (err) {
        LucidLogger.error('Failed to reopen document for undo', err);
      }
    }
    if (!document) {
      this.postAutoEditReviewUpdate(webview, reviewId, 'error', 'Document is no longer open. Open the file and try undo again.');
      return;
    }
    if (document.version !== entry.documentVersion) {
      this.postAutoEditReviewUpdate(webview, reviewId, 'error', 'Document has changed since the auto edit. Please review manually.');
      return;
    }
    const revertRange = new vscode.Range(
      new vscode.Position(0, 0),
      document.lineCount > 0 ? document.lineAt(Math.max(0, document.lineCount - 1)).range.end : new vscode.Position(0, 0)
    );
    const edit = new vscode.WorkspaceEdit();
    edit.replace(document.uri, revertRange, entry.beforeText);
    const applied = await vscode.workspace.applyEdit(edit);
    if (!applied) {
      this.postAutoEditReviewUpdate(webview, reviewId, 'error', 'Failed to undo change. Please use Undo in the editor.');
      return;
    }
    entry.status = 'undone';
    entry.afterText = entry.beforeText;
    entry.documentVersion = document.version;
    this.postAutoEditReviewUpdate(webview, reviewId, 'undone', 'Change was undone and previous content restored.');
    await this.emitAutoEditWorkflowSummary(webview, reviewId);
    await this.logHistory('assistant', `Auto-applied edit was undone (${entry.fileName || 'document'}).`, 'agent');
  }

  async viewAutoEditReview(reviewId: string, webview: vscode.Webview): Promise<void> {
    const entry = this.pendingAutoEditReviews.get(reviewId);
    if (!entry) {
      this.postAutoEditReviewUpdate(webview, reviewId, 'error', 'Change is no longer available to view.');
      return;
    }
    try {
      const title = `${entry.fileName || 'Auto edit'} (before ↔ after)`;
      const files = await this.writeDiffPreviewFiles(entry);
      await vscode.commands.executeCommand(
        'vscode.diff',
        files.before,
        files.after,
        title,
        { preview: false }
      );
    } catch (err) {
      LucidLogger.error('viewAutoEditReview error', err);
      this.postAutoEditReviewUpdate(webview, reviewId, 'error', 'Failed to open diff view. Check logs for details.');
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

  private async logHistory(
    role: HistoryRole,
    text: string,
    mode: 'ask' | 'agent' | undefined,
    preview?: StoredActionPreview,
    actionResult?: StoredActionResult
  ) {
    if (!this.historyManager || !text || !text.trim()) return;
    await this.historyManager.appendEntry({ role, text, mode, actionPreview: preview, actionResult, timestamp: Date.now() });
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

  private buildStoredActionResult(action: LucidActionPayload, result: ActionExecutionResult): StoredActionResult | undefined {
    if (!result || result.type !== 'terminal') {
      return undefined;
    }
    const terminalParts = this.buildTerminalCommandParts(action);
    const args = result.args && result.args.length ? result.args : terminalParts.args;
    const titleBase = 'Terminal Command Output';
    const title = result.success ? titleBase : `${titleBase} (failed)`;
    return {
      title,
      command: result.command || terminalParts.command,
      args,
      cwd: result.cwd,
      stdout: result.stdout,
      stderr: result.stderr,
      exitCode: result.exitCode,
      success: result.success,
      suggestions: result.suggestions
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
      return { success: true, type: 'clipboard', stdout: text, command: action.command, args: this.toStringArgs(action.args) };
    }

    if (kind === 'vscode') {
      const normalizedCommand = (action.command || '').trim().toLowerCase();
      if (normalizedCommand === 'open') {
        return await this.handleOpenFileCommand(action);
      }
      const handled = await this.tryHandleEditorSnippetCommand(normalizedCommand, action);
      if (handled) {
        return handled;
      }
      const diffable = await this.tryExecuteDiffableEditorCommand(normalizedCommand, action);
      if (diffable) {
        return diffable;
      }
      try {
        const commandArgs = this.coerceCommandArgs(action.args);
        await vscode.commands.executeCommand(action.command, ...commandArgs);
        return { success: true, type: 'vscode', stdout: 'VS Code command executed.', command: action.command, args: this.toStringArgs(action.args) };
      } catch (err) {
        const stderr = err instanceof Error ? err.message : String(err);
        return { success: false, type: 'vscode', stderr, command: action.command, args: this.toStringArgs(action.args), suggestions: ['Ensure the VS Code command exists and that any required arguments are valid.'] };
      }
    }

    const terminalParts = this.buildTerminalCommandParts(action);
    const violation = this.describeTerminalFileEditViolation(action, terminalParts.command, terminalParts.args);
    if (violation) {
      LucidLogger.warn('Blocked terminal-based file edit attempt', { action: action.command, args: action.args });
      return {
        success: false,
        type: 'terminal',
        stderr: violation,
        command: terminalParts.command,
        args: terminalParts.args,
        suggestions: [
          'Use VS Code commands such as editor.action.insertSnippet or editor.action.replace with the desired snippet to modify files.',
          'Return the updated code snippet directly in the action JSON so the extension can apply it safely.'
        ]
      };
    }
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
      let cwdUsed = '';
      let resolved = false;
      const suggestions: string[] = [];
      const commandArgs = Array.isArray(args) ? [...args] : [];
      const compositeLine = [command].concat(args || []).join(' ').trim();
      let spawnCommand = command;
      let spawnArgs = Array.isArray(args) ? [...args] : [];
      if (this.shouldRunViaShell(command, args)) {
        if (process.platform === 'win32') {
          spawnCommand = 'cmd';
          spawnArgs = ['/d', '/c', compositeLine];
        } else {
          spawnCommand = '/bin/sh';
          spawnArgs = ['-c', compositeLine];
        }
      }

      const finish = (result: ActionExecutionResult) => {
        if (resolved) return;
        resolved = true;
        resolve(result);
      };


      // TODO: buradaki $PATH olarak ayarlamak daha iyi olabilir
      const env = { ...process.env } as NodeJS.ProcessEnv;
      if (process.platform !== 'win32') {
        const extraBins = new Set<string>([
          '/usr/local/bin',
          '/usr/local/sbin',
          '/usr/local/go/bin',
          '/opt/homebrew/bin',
          '/opt/homebrew/sbin',
          '/opt/homebrew/opt/go/bin'
        ]);
        const goRoot = env.GOROOT;
        const goBin = env.GOBIN;
        const goPath = env.GOPATH;
        const homeDir = env.HOME;
        if (goRoot) extraBins.add(path.join(goRoot, 'bin'));
        if (goBin) extraBins.add(goBin);
        if (goPath) extraBins.add(path.join(goPath, 'bin'));
        if (homeDir) extraBins.add(path.join(homeDir, 'go', 'bin'));
        const currentPath = env.PATH || env.Path || '';
        const pathParts = currentPath.split(path.delimiter).filter(Boolean);
        const injectDir = (dir: string | undefined) => {
          if (!dir || !dir.trim()) return;
          if (pathParts.indexOf(dir) !== -1) return;
          pathParts.unshift(dir);
        };
        for (const dir of extraBins) {
          injectDir(dir);
        }
        env.PATH = pathParts.join(path.delimiter);
      }

      const pty: vscode.Pseudoterminal = {
        onDidWrite: writeEmitter.event,
        open: () => {
          const cwd = vscode.workspace.workspaceFolders && vscode.workspace.workspaceFolders.length > 0
            ? vscode.workspace.workspaceFolders[0].uri.fsPath
            : process.cwd();
          cwdUsed = cwd;
          writeEmitter.fire(`Running ${compositeLine || command}\r\n\r\n`);
          try {
            child = spawn(spawnCommand, spawnArgs, { cwd, shell: process.platform === 'win32', env });
          } catch (spawnErr) {
            const message = spawnErr instanceof Error ? spawnErr.message : String(spawnErr);
            stderr += message;
            writeEmitter.fire(`\r\n${message}\r\n`);
            const lower = message.toLowerCase();
            if (lower.includes('enoent') || lower.includes('not found')) {
              this.pushSuggestion(suggestions, `Confirm that \`${command}\` is installed and available on PATH.`);
            }
            this.pushSuggestion(suggestions, 'Try running the same command inside a standard VS Code terminal to inspect environment differences.');
            finish({ success: false, type: 'terminal', stdout, stderr: message, command, args: commandArgs, cwd: cwdUsed, suggestions });
            return;
          }
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
            const lower = message.toLowerCase();
            if (lower.includes('enoent') || lower.includes('not found')) {
              this.pushSuggestion(suggestions, `Confirm that \`${command}\` is installed and available on PATH.`);
            }
            this.pushSuggestion(suggestions, 'Try running the same command inside a standard VS Code terminal to inspect environment differences.');
            finish({ success: false, type: 'terminal', stdout, stderr: message, command, args: commandArgs, cwd: cwdUsed, suggestions });
          });
          child.on('close', (code) => {
            writeEmitter.fire(`\r\nProcess exited with code ${code ?? 'unknown'}\r\n`);
            const exitSuccess = (code ?? 1) === 0;
            if (!exitSuccess) {
              const combined = `${stderr} ${stdout}`.toLowerCase();
              if (combined.includes('command not found') || (code === 127)) {
                this.pushSuggestion(suggestions, `Confirm that \`${command}\` is installed and available on PATH.`);
              }
              this.pushSuggestion(suggestions, 'Try running the same command inside a standard VS Code terminal to inspect environment differences.');
              if (!combined.includes('permission') && (code === 126 || code === 1)) {
                this.pushSuggestion(suggestions, 'Check file permissions or add any missing build steps before rerunning.');
              }
            }
            finish({ success: exitSuccess, type: 'terminal', stdout, stderr, exitCode: code ?? undefined, command, args: commandArgs, cwd: cwdUsed, suggestions: suggestions.length ? suggestions : undefined });
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

    if (result.suggestions && result.suggestions.length > 0) {
      const bullets = result.suggestions.map((tip) => `- ${tip}`).join('\n');
      details.push(`Next steps:\n${bullets}`);
    }

    return details.filter(Boolean).join('\n\n');
  }

  private async tryHandleEditorSnippetCommand(
    normalizedCommand: string,
    action: LucidActionPayload
  ): Promise<ActionExecutionResult | undefined> {
    if (normalizedCommand !== 'editor.action.replace') {
      return undefined;
    }
    return await this.applySnippetReplacement(action);
  }

  private async tryExecuteDiffableEditorCommand(
    normalizedCommand: string,
    action: LucidActionPayload
  ): Promise<ActionExecutionResult | undefined> {
    const shouldDiff = DIFFABLE_EDITOR_COMMANDS.has(normalizedCommand);
    if (!shouldDiff) return undefined;
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return {
        success: false,
        type: 'vscode',
        stderr: 'Open a text editor to run this command.',
        command: action.command,
        args: this.toStringArgs(action.args),
        suggestions: ['Open the relevant file in VS Code and try again.']
      };
    }
    const beforeText = editor.document.getText();
    try {
      const commandArgs = this.coerceCommandArgs(action.args);
      await vscode.commands.executeCommand(action.command, ...commandArgs);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      return { success: false, type: 'vscode', stderr: message, command: action.command, args: this.toStringArgs(action.args) };
    }
    const afterText = editor.document.getText();
    const review = this.registerAutoEditReview(action, editor.document, beforeText, afterText);
    return {
      success: true,
      type: 'vscode',
      stdout: 'VS Code command executed.',
      command: action.command,
      args: this.toStringArgs(action.args),
      autoEditReview: review
    };
  }

  private async handleOpenFileCommand(action: LucidActionPayload): Promise<ActionExecutionResult> {
    try {
      const targetPath = this.stringifyArg(action.args && action.args[0]);
      let uri: vscode.Uri | undefined;
      if (targetPath && targetPath.length) {
        const normalized = path.isAbsolute(targetPath)
          ? targetPath
          : path.join(vscode.workspace.workspaceFolders?.[0]?.uri.fsPath || process.cwd(), targetPath);
        uri = vscode.Uri.file(normalized);
      } else {
        uri = vscode.window.activeTextEditor?.document.uri;
      }
      if (!uri) {
        throw new Error('Specify a file path to open.');
      }
      const doc = await vscode.workspace.openTextDocument(uri);
      await vscode.window.showTextDocument(doc, { preview: false });
      return { success: true, type: 'vscode', stdout: `Opened ${uri.fsPath}`, command: action.command, args: this.toStringArgs(action.args) };
    } catch (err) {
      const stderr = err instanceof Error ? err.message : String(err);
      return {
        success: false,
        type: 'vscode',
        stderr,
        command: action.command,
        args: this.toStringArgs(action.args),
        suggestions: ['Provide a workspace-relative or absolute file path.', 'Ensure the file exists and is readable.']
      };
    }
  }

  private async applySnippetReplacement(action: LucidActionPayload): Promise<ActionExecutionResult> {
    const editor = vscode.window.activeTextEditor;
    if (!editor) {
      return {
        success: false,
        type: 'vscode',
        stderr: 'Open a text editor to apply this edit.',
        command: action.command,
        args: this.toStringArgs(action.args),
        suggestions: ['Open the target file in VS Code before running this action.']
      };
    }
    const replaceArgs = this.parseReplaceArgs(action.args);
    const snippet = replaceArgs.snippet;
    if (!snippet || !snippet.trim()) {
      return {
        success: false,
        type: 'vscode',
        stderr: 'editor.action.replace requires a snippet argument.',
        command: action.command,
        args: this.toStringArgs(action.args),
        suggestions: ['Ensure the first argument includes the desired replacement text (string or { "snippet": "..." }).']
      };
    }

    const snippetString = new vscode.SnippetString(snippet);
    const targetedSelections = editor.selections?.filter(sel => sel && !sel.isEmpty) || [];
    const beforeText = editor.document.getText();
    let applied = false;

    if (targetedSelections.length > 0) {
      applied = await editor.insertSnippet(snippetString, targetedSelections);
    } else if (replaceArgs.target) {
      const range = this.findTargetRange(editor.document, replaceArgs.target);
      if (!range) {
        return {
          success: false,
          type: 'vscode',
          stderr: 'Unable to find the target text to replace.',
          command: action.command,
          args: this.toStringArgs(action.args),
          suggestions: ['Double-check the "target" text in the action JSON matches the document exactly (including spacing).']
        };
      }
      applied = await editor.insertSnippet(snippetString, range);
    } else {
      return {
        success: false,
        type: 'vscode',
        stderr: 'No selection or target text provided for editor.action.replace.',
        command: action.command,
        args: this.toStringArgs(action.args),
        suggestions: [
          'Include a {"target":"...","snippet":"..."} object in the action args so Lucid knows which text to replace.',
          'Alternatively, select the code you want to replace before triggering the action.'
        ]
      };
    }

    if (!applied) {
      return {
        success: false,
        type: 'vscode',
        stderr: 'Failed to replace text in the active editor.',
        command: action.command,
        args: this.toStringArgs(action.args),
        suggestions: ['Open the target file in VS Code before running this action.', 'Select the lines you want to replace, or leave the editor focused to replace the full document.']
      };
    }

    const afterText = editor.document.getText();
    const review = this.registerAutoEditReview(action, editor.document, beforeText, afterText);
    return {
      success: true,
      type: 'vscode',
      stdout: 'Replacement snippet applied to the active editor.',
      command: action.command,
      args: this.toStringArgs(action.args),
      autoEditReview: review
    };
  }

  private describeTerminalFileEditViolation(action: LucidActionPayload, command: string, args: string[]): string | undefined {
    const normalizedCmd = command.trim().toLowerCase();
    const argsJoined = args.join(' ').toLowerCase();
    const description = `${action.description || ''} ${action.text || ''}`.toLowerCase();
    const editVerbs = ['edit', 'replace', 'modify', 'remove', 'delete', 'insert', 'update', 'patch', 'refactor', 'change'];
    const hasEditIntent = editVerbs.some((verb) => description.includes(verb));
    const hasApplyPatch = normalizedCmd.includes('apply_patch') || argsJoined.includes('apply_patch');
    if (normalizedCmd === 'sed' && args.some((arg) => arg.includes('-i'))) {
      return 'Editing files via terminal sed commands is not allowed. Use VS Code snippet commands instead.';
    }
    if ((normalizedCmd === 'perl' || normalizedCmd === 'python' || normalizedCmd === 'python3' || normalizedCmd === 'ruby') && args.some((arg) => arg.includes('-i'))) {
      return 'Editing files via terminal scripting languages (-i/in-place) is disabled. Provide a VS Code snippet action.';
    }
    if (hasApplyPatch) {
      return 'Commands that invoke apply_patch/patch are blocked. Return the exact snippet using editor.action.insertSnippet/editor.action.replace.';
    }
    if (TERMINAL_FILE_EDIT_COMMANDS.has(normalizedCmd) && hasEditIntent) {
      return 'This looks like a file edit expressed as a terminal command. File edits must be performed with VS Code actions, not shell commands.';
    }
    if ((normalizedCmd === 'bash' || normalizedCmd === 'sh' || normalizedCmd === 'zsh' || normalizedCmd === 'pwsh' || normalizedCmd === 'powershell') && hasEditIntent) {
      return 'Shell scripts that modify files are blocked. Provide the desired changes through VS Code snippet commands.';
    }
    return undefined;
  }

  private parseReplaceArgs(args?: any[] | any): { snippet?: string; target?: string } {
    if (Array.isArray(args) && args.length > 0) {
      return this.parseReplaceArgs(args[0]);
    }
    if (!args) return {};
    if (typeof args === 'string') {
      return { snippet: args };
    }
    if (typeof args === 'object') {
      const snippet = typeof (args as any).snippet === 'string'
        ? (args as any).snippet
        : typeof (args as any).text === 'string'
          ? (args as any).text
          : undefined;
      const target = typeof (args as any).target === 'string'
        ? (args as any).target
        : typeof (args as any).before === 'string'
          ? (args as any).before
          : undefined;
      return { snippet, target };
    }
    return {};
  }

  private findTargetRange(document: vscode.TextDocument, target: string): vscode.Range | undefined {
    if (!target) return undefined;
    const content = document.getText();
    const normalizedTarget = target.replace(/\r\n/g, '\n');
    const normalizedContent = content.replace(/\r\n/g, '\n');
    const index = normalizedContent.indexOf(normalizedTarget);
    if (index === -1) return undefined;
    const start = document.positionAt(index);
    const end = document.positionAt(index + normalizedTarget.length);
    return new vscode.Range(start, end);
  }

  private registerAutoEditReview(
    action: LucidActionPayload,
    document: vscode.TextDocument,
    beforeText: string,
    afterText: string
  ): AutoEditReviewDisplay | undefined {
    if (!document) return undefined;
    if (beforeText === afterText) return undefined;
    const diff = this.buildCompactDiff(beforeText, afterText, document.fileName);
    if (!diff || !diff.trim()) return undefined;
    const diffStats = this.countDiffLines(diff);
    const entry: PendingAutoEditReview = {
      id: `autoedit-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
      diff,
      fileName: document.fileName ? path.basename(document.fileName) : undefined,
      description: action.description,
      documentUri: document.uri.toString(),
      documentPath: document.uri.fsPath,
      documentVersion: document.version,
      languageId: document.languageId,
      beforeText,
      afterText,
      timestamp: Date.now(),
      status: 'pending',
      path: document.uri.fsPath,
      added: diffStats.added,
      removed: diffStats.removed,
      command: action.command
    };
    this.pendingAutoEditReviews.set(entry.id, entry);
    return {
      id: entry.id,
      diff: entry.diff,
      fileName: entry.fileName,
      description: entry.description,
      path: entry.path,
      added: entry.added,
      removed: entry.removed,
      command: entry.command,
      status: entry.status
    };
  }

  private async writeDiffPreviewFiles(entry: PendingAutoEditReview): Promise<{ before: vscode.Uri; after: vscode.Uri }> {
    const ctx = this.getExtensionContext?.();
    let base = ctx?.globalStorageUri;
    if (!base) {
      base = vscode.Uri.file(path.join(os.tmpdir(), 'lucid-diff-previews'));
    }
    const dir = vscode.Uri.joinPath(base, 'diff-previews', entry.id);
    try {
      await vscode.workspace.fs.createDirectory(dir);
    } catch (_) { }
    const beforeUri = vscode.Uri.joinPath(dir, 'before.txt');
    const afterUri = vscode.Uri.joinPath(dir, 'after.txt');
    const encoder = new TextEncoder();
    await Promise.all([
      vscode.workspace.fs.writeFile(beforeUri, encoder.encode(entry.beforeText ?? '')),
      vscode.workspace.fs.writeFile(afterUri, encoder.encode(entry.afterText ?? ''))
    ]);
    return { before: beforeUri, after: afterUri };
  }

  private async emitAutoEditWorkflowSummary(webview: vscode.Webview, reviewId: string): Promise<void> {
    const entry = this.pendingAutoEditReviews.get(reviewId);
    if (!entry) return;
    try {
      const fileStatus: 'scanned' | 'changed' | 'unchanged' | 'error' = entry.status === 'undone' ? 'unchanged' : 'changed';
      const files = entry.documentPath
        ? [{
          path: entry.documentPath,
          summary: entry.description || `Auto edit applied to ${entry.fileName || 'file'}`,
          status: fileStatus,
          diffId: entry.id
        }]
        : undefined;
      await postWorkflowSummaryMessage({
        webview,
        summary: {
          files,
          diffs: [{
            id: entry.id,
            title: entry.fileName ? `Auto edit: ${entry.fileName}` : 'Auto edit diff',
            summary: entry.description,
            hunks: entry.diff,
            keep: entry.status === 'kept',
            undo: entry.status === 'undone',
            added: entry.added,
            removed: entry.removed,
            path: entry.documentPath
          }]
        },
        historyManager: this.historyManager,
        options: { mode: 'agent' }
      });
    } catch (err) {
      LucidLogger.error('emitAutoEditWorkflowSummary error', err);
    }
  }

  private buildCompactDiff(beforeText: string, afterText: string, filePath?: string): string {
    const beforeLines = this.splitLines(beforeText);
    const afterLines = this.splitLines(afterText);
    const ops = this.computeLineDiff(beforeLines, afterLines);
    const lines: string[] = [];
    const displayName = filePath ? path.basename(filePath) : 'document';
    lines.push(`diff -- auto-edit ${displayName}`);
    lines.push('--- before');
    lines.push('+++ after');
    let hasChange = false;
    for (const op of ops) {
      if (op.type === 'delete') {
        lines.push(`- ${op.line}`);
        hasChange = true;
      } else if (op.type === 'insert') {
        lines.push(`+ ${op.line}`);
        hasChange = true;
      } else if (op.type === 'equal') {
        lines.push(`  ${op.line}`);
      }
    }
    return hasChange ? lines.join('\n') : '';
  }

  private splitLines(text: string): string[] {
    if (!text) return [''];
    const normalized = text.replace(/\r\n/g, '\n');
    return normalized.split('\n');
  }

  private computeLineDiff(beforeLines: string[], afterLines: string[]): { type: 'equal' | 'insert' | 'delete'; line: string }[] {
    const m = beforeLines.length;
    const n = afterLines.length;
    const dp: number[][] = [];
    for (let i = 0; i <= m; i++) {
      dp[i] = new Array(n + 1).fill(0);
    }
    for (let i = m - 1; i >= 0; i--) {
      for (let j = n - 1; j >= 0; j--) {
        if (beforeLines[i] === afterLines[j]) {
          dp[i][j] = dp[i + 1][j + 1] + 1;
        } else {
          dp[i][j] = Math.max(dp[i + 1][j], dp[i][j + 1]);
        }
      }
    }
    const ops: { type: 'equal' | 'insert' | 'delete'; line: string }[] = [];
    let i = 0;
    let j = 0;
    while (i < m && j < n) {
      if (beforeLines[i] === afterLines[j]) {
        ops.push({ type: 'equal', line: beforeLines[i] });
        i++;
        j++;
      } else if (dp[i + 1][j] >= dp[i][j + 1]) {
        ops.push({ type: 'delete', line: beforeLines[i] });
        i++;
      } else {
        ops.push({ type: 'insert', line: afterLines[j] });
        j++;
      }
    }
    while (i < m) {
      ops.push({ type: 'delete', line: beforeLines[i++] });
    }
    while (j < n) {
      ops.push({ type: 'insert', line: afterLines[j++] });
    }
    return ops;
  }

  private countDiffLines(diffText: string): { added: number; removed: number } {
    const lines = diffText ? diffText.split('\n') : [];
    let added = 0;
    let removed = 0;
    for (const line of lines) {
      if (line.startsWith('+ ') || line.startsWith('+	') || (line.startsWith('+') && line.length > 1)) {
        added++;
      } else if (line.startsWith('- ') || line.startsWith('-	') || (line.startsWith('-') && line.length > 1)) {
        removed++;
      }
    }
    return { added, removed };
  }

  private shouldRunViaShell(command: string, args: string[]): boolean {
    const tokens = [command].concat(args || []);
    const operators = ['&&', '||', ';', '|', '>', '<'];
    for (const token of tokens) {
      if (!token) continue;
      if (operators.includes(token.trim())) return true;
      if (/[&|;<>]/.test(token)) return true;
    }
    return false;
  }

  private truncateForReview(text: string | undefined, max = 1000): string {
    if (!text) return '';
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…`;
  }

  private postAutoEditReviewUpdate(webview: vscode.Webview, reviewId: string, status: 'kept' | 'undone' | 'error', message: string) {
    try {
      webview.postMessage({ type: 'autoEditReviewUpdate', reviewId, status, message });
    } catch (err) {
      LucidLogger.error('postAutoEditReviewUpdate error', err);
    }
  }

  private findDocument(uriString: string): vscode.TextDocument | undefined {
    try {
      const uri = vscode.Uri.parse(uriString);
      for (const doc of vscode.workspace.textDocuments) {
        if (doc.uri.toString() === uri.toString()) return doc;
      }
      return undefined;
    } catch (_) {
      return undefined;
    }
  }

  // TODO: burada output geri Ollamaya gittikten sonrasını düzenlemek lazım
  // sorun yoksa bir mesaj dönmemeli, ama hata varsa bu hatanın giderilmesi için gerekli çözümleri listeyip TODO olarak
  // denememiz lazım
  private async sendActionReviewToOllama(
    webview: vscode.Webview,
    action: LucidActionPayload,
    result: ActionExecutionResult,
    originalPrompt: string,
    summary: string
  ): Promise<void> {
    if (result.success || result.type !== 'terminal') {
      return;
    }
    try {
      const intro = 'Hata oluştu, çözüm için öneriler getiriliyor…';
      webview.postMessage({ type: 'append', text: intro, role: 'assistant' });
      await this.logHistory('assistant', intro, 'agent');

      const planResult = await this.requestRemediationPlan(action, result, originalPrompt, summary);
      if (!planResult) {
        const fallback = 'Otomatik çözüm önerileri alınamadı.';
        webview.postMessage({ type: 'append', text: fallback, role: 'assistant' });
        await this.logHistory('assistant', fallback, 'agent');
        return;
      }

      if (planResult.plan) {
        const plan = planResult.plan;
        const todoPayload = this.buildTodoListPayload(webview, plan, originalPrompt);
        const planMessage = plan.summary || 'Çözüm önerileri hazır. Adımları sırayla uygulayın.';
        if (todoPayload && todoPayload.items.length > 0) {
          webview.postMessage({ type: 'append', text: planMessage, role: 'assistant', options: { todoList: todoPayload } });
        } else {
          webview.postMessage({ type: 'append', text: planMessage, role: 'assistant' });
        }
        await this.logHistory('assistant', planMessage, 'agent');
        return;
      }

      if (planResult.rawText) {
        const manual = `Otomatik planparse edilemedi. Model cevabı:\n\n${planResult.rawText}`;
        webview.postMessage({ type: 'append', text: manual, role: 'assistant' });
        await this.logHistory('assistant', manual, 'agent');
        return;
      }

      const fallback = 'Otomatik çözüm önerileri alınamadı.';
      webview.postMessage({ type: 'append', text: fallback, role: 'assistant' });
      await this.logHistory('assistant', fallback, 'agent');
    } catch (err) {
      LucidLogger.error('sendActionReviewToOllama error', err);
    }
  }

  private async requestRemediationPlan(
    action: LucidActionPayload,
    result: ActionExecutionResult,
    originalPrompt: string,
    summary: string
  ): Promise<RemediationPlanResult | undefined> {
    try {
      const endpoint = LucidConfig.getEndpoint();
      const model = LucidConfig.getModelName();
      const headers = await this.buildHeadersFromConfig();
      const terminalParts = this.buildTerminalCommandParts(action);
      const commandLine = [terminalParts.command].concat(terminalParts.args || []).join(' ').trim();
      const truncatedStdout = this.truncateForReview(result.stdout, 1500) || '(empty)';
      const truncatedStderr = this.truncateForReview(result.stderr, 1500) || '(empty)';
      const suggestionText = (result.suggestions || [])
        .map((tip, idx) => `${idx + 1}. ${tip}`)
        .join('\n') || '(none)';

      const instructions = [
        'You are a senior developer diagnosing a failed VS Code terminal command.',
        'Always respond with strict JSON and no additional prose.',
        'JSON schema:',
        '{',
        '  "title"?: string,',
        '  "summary": string,',
        '  "steps": [',
        '    {',
        '      "title": string,',
        '      "description"?: string,',
        '      "action"?: {',
        '        "command": string,',
        '        "args"?: string[],',
        '        "type"?: "terminal" | "vscode" | "clipboard",',
        '        "description"?: string',
        '      }',
        '    }',
        '  ]',
        '}',
        'Return at most 3 ordered steps. Use real executables (e.g., "go", "npm", "./script.sh") with explicit arguments. Never output helper names like terminal.run.'
      ].join('\n');

      const userPrompt = [
        'Original request or context:',
        originalPrompt || '(unspecified)',
        'Executed command:',
        commandLine || action.command,
        `Working directory: ${result.cwd || 'workspace root'}`,
        `Exit code: ${typeof result.exitCode === 'number' ? result.exitCode : 'unknown'}`,
        'Execution summary:',
        summary,
        'stdout (trimmed):',
        truncatedStdout,
        'stderr (trimmed):',
        truncatedStderr,
        'Existing suggestions from the runner:',
        suggestionText
      ].join('\n\n');

      const payload = {
        model,
        messages: [
          { role: 'system', content: instructions },
          { role: 'user', content: userPrompt }
        ],
        stream: false
      };

      CurlLogger.log({
        url: endpoint,
        headers,
        body: payload,
        label: 'CURL requestRemediationPlan',
        revealSensitive: this.shouldRevealSensitive()
      });

      const response = await fetch(endpoint, {
        method: 'POST',
        headers,
        body: JSON.stringify(payload)
      });

      const bodyText = await response.text().catch(() => response.statusText || '');
      if (!response.ok) {
        throw new Error(`Ollama remediation error ${response.status}: ${bodyText}`);
      }

      const normalized = this.normalizeResponseText(bodyText) || bodyText;
      const parsedPlan = this.tryParseRemediationPlanJson(normalized);
      if (parsedPlan) {
        return { plan: parsedPlan };
      }
      return { rawText: normalized };
    } catch (err) {
      LucidLogger.error('requestRemediationPlan error', err);
    }
    return undefined;
  }

  private buildTodoListPayload(
    webview: vscode.Webview,
    plan: RemediationPlanPayload,
    originalPrompt: string
  ): TodoListWebviewPayload | undefined {
    if (!plan || !Array.isArray(plan.steps) || plan.steps.length === 0) {
      return undefined;
    }

    const items: TodoListItemPayload[] = [];
    const limitedSteps = plan.steps.slice(0, 4);

    for (const step of limitedSteps) {
      if (!step) {
        continue;
      }

      let actionId: string | undefined;
      let snippet: string | undefined;

      if (step.action) {
        const normalized = this.normalizeRecommendedAction(step.action, step.description);
        if (normalized) {
          actionId = this.registerPendingAction(webview, normalized, originalPrompt);
          snippet = this.buildActionSnippet(normalized, this.inferActionType(normalized));
        }
      }

      items.push({
        id: `todo-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`,
        title: step.title?.trim() || 'Önerilen adım',
        detail: step.description,
        actionId,
        snippet
      });
    }

    if (!items.length) {
      return undefined;
    }

    return {
      title: plan.title || 'Çözüm adımları',
      description: plan.summary || 'Oluşan hatayı gidermek için önerilen adımlar. Her komutu çalıştırmadan önce inceleyin.',
      items
    };
  }

  private normalizeRecommendedAction(action: RemediationStepAction, detail?: string): LucidActionPayload | undefined {
    if (!action || typeof action.command !== 'string' || !action.command.trim()) {
      return undefined;
    }

    const payload: LucidActionPayload = {
      command: action.command.trim(),
      description: action.description || detail,
      type: action.type,
      text: action.text
    };

    if (Array.isArray(action.args)) {
      payload.args = action.args;
    } else if (typeof action.args !== 'undefined') {
      payload.args = [action.args];
    }

    return payload;
  }

  private tryParseRemediationPlanJson(text: string): RemediationPlanPayload | undefined {
    if (!text) return undefined;
    const attempts: string[] = [];
    const trimmed = text.trim();
    if (trimmed) attempts.push(trimmed);

    const fenceRegex = /```(?:json)?\s*([\s\S]*?)```/gi;
    let match: RegExpExecArray | null;
    while ((match = fenceRegex.exec(text)) !== null) {
      if (match[1]) attempts.push(match[1]);
    }

    const firstBrace = text.indexOf('{');
    const lastBrace = text.lastIndexOf('}');
    if (firstBrace !== -1 && lastBrace > firstBrace) {
      attempts.push(text.slice(firstBrace, lastBrace + 1));
    }

    for (const candidate of attempts) {
      try {
        const parsed = JSON.parse(candidate);
        if (parsed && typeof parsed === 'object') {
          return parsed as RemediationPlanPayload;
        }
      } catch (_) {
        continue;
      }
    }
    return undefined;
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

  private toStringArgs(args?: any[] | any): string[] {
    if (Array.isArray(args)) return args.map(this.stringifyArg);
    if (typeof args === 'undefined') return [];
    return [this.stringifyArg(args)];
  }

  private pushSuggestion(target: string[], suggestion?: string) {
    if (!suggestion) return;
    if (target.includes(suggestion)) return;
    target.push(suggestion);
  }

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
