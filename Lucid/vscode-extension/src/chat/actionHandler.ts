import * as vscode from 'vscode';
import { spawn } from 'child_process';
import * as path from 'path';
import { LucidConfig } from '../../../common/config';
import { CurlLogger } from '../../../common/log/curlLogger';
import { LucidLogger } from '../../../common/log/logger';
import { AskHandler } from './askHandler';
import { ChatHistoryManager, StoredActionPreview, HistoryRole, StoredActionResult } from './historyManager';

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
      await this.logHistory('system', 'Action is no longer available.', 'agent');
      return;
    }

    const targetView = entry.webview;
    targetView.postMessage({ type: 'status', text: 'Executing action…', streaming: false });
    try {
      const executionResult = await this.executeActionPayload(entry.payload);
      const summary = this.buildActionSummary(entry.payload, executionResult);
      const storedResult = this.buildStoredActionResult(entry.payload, executionResult);
      const options = storedResult ? { actionOutput: storedResult } : undefined;
      targetView.postMessage({ type: 'append', text: summary, role: executionResult.success ? 'assistant' : 'error', options });
      await this.logHistory(executionResult.success ? 'assistant' : 'error', summary, 'agent', undefined, storedResult);
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
          writeEmitter.fire(`Running ${command} ${args.join(' ')}\r\n\r\n`);
          try {
            child = spawn(command, args, { cwd, shell: process.platform === 'win32', env });
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

  private truncateForReview(text: string | undefined, max = 1000): string {
    if (!text) return '';
    if (text.length <= max) return text;
    return `${text.slice(0, max)}…`;
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

      const plan = await this.requestRemediationPlan(action, result, originalPrompt, summary);
      if (!plan) {
        const fallback = 'Otomatik çözüm önerileri alınamadı.';
        webview.postMessage({ type: 'append', text: fallback, role: 'assistant' });
        await this.logHistory('assistant', fallback, 'agent');
        return;
      }

      const todoPayload = this.buildTodoListPayload(webview, plan, originalPrompt);
      const planMessage = plan.summary || 'Çözüm önerileri hazır. Adımları sırayla uygulayın.';
      if (todoPayload && todoPayload.items.length > 0) {
        webview.postMessage({ type: 'append', text: planMessage, role: 'assistant', options: { todoList: todoPayload } });
      } else {
        webview.postMessage({ type: 'append', text: planMessage, role: 'assistant' });
      }
      await this.logHistory('assistant', planMessage, 'agent');
    } catch (err) {
      LucidLogger.error('sendActionReviewToOllama error', err);
    }
  }

  private async requestRemediationPlan(
    action: LucidActionPayload,
    result: ActionExecutionResult,
    originalPrompt: string,
    summary: string
  ): Promise<RemediationPlanPayload | undefined> {
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
      try {
        const parsed = JSON.parse(normalized);
        if (parsed && Array.isArray(parsed.steps) && parsed.steps.length > 0) {
          return parsed as RemediationPlanPayload;
        }
      } catch (parseErr) {
        LucidLogger.error('Failed to parse remediation plan response', parseErr);
      }
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
