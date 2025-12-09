import * as vscode from 'vscode';
import * as crypto from 'crypto';
import { LucidLogger } from '../../../common/log/logger';

export type HistoryRole = 'user' | 'assistant' | 'system' | 'error';
export type HistoryMode = 'ask' | 'action' | undefined;

export interface StoredActionPreview {
  snippet: string;
  language: string;
  typeLabel: string;
  description?: string;
  rawJson?: string;
  command?: string;
  actionType?: 'vscode' | 'terminal' | 'clipboard';
}

export interface HistoryEntry {
  role: HistoryRole;
  text: string;
  mode?: HistoryMode;
  timestamp: number;
  actionPreview?: StoredActionPreview;
}

export class ChatHistoryManager {
  private entries: HistoryEntry[] = [];
  private historyFile?: vscode.Uri;

  constructor(private readonly context: vscode.ExtensionContext) { }

  async initialize(): Promise<void> {
    try {
      const historyDir = vscode.Uri.joinPath(this.context.globalStorageUri, 'chatHistory');
      await vscode.workspace.fs.createDirectory(historyDir);
      const workspaceKey = this.computeWorkspaceKey();
      this.historyFile = vscode.Uri.joinPath(historyDir, `${workspaceKey}.json`);
      this.entries = await this.readEntries(this.historyFile);
    } catch (err) {
      LucidLogger.error('ChatHistoryManager.initialize error', err);
      this.entries = [];
      this.historyFile = undefined;
    }
  }

  getEntries(limit = 200): HistoryEntry[] {
    if (!this.entries || this.entries.length === 0) return [];
    if (this.entries.length <= limit) return [...this.entries];
    return this.entries.slice(-limit);
  }

  async appendEntry(entry: HistoryEntry): Promise<void> {
    try {
      if (!entry || !entry.text || !entry.text.trim()) return;
      this.entries.push(entry);
      if (this.entries.length > 500) this.entries = this.entries.slice(-500);
      if (!this.historyFile) return;
      const data = Buffer.from(JSON.stringify(this.entries, null, 2), 'utf8');
      await vscode.workspace.fs.writeFile(this.historyFile, data);
    } catch (err) {
      LucidLogger.error('ChatHistoryManager.appendEntry error', err);
    }
  }

  private async readEntries(file: vscode.Uri): Promise<HistoryEntry[]> {
    try {
      const buffer = await vscode.workspace.fs.readFile(file);
      const text = Buffer.from(buffer).toString('utf8');
      const parsed = JSON.parse(text);
      if (Array.isArray(parsed)) {
        return parsed.filter(this.isHistoryEntry);
      }
      return [];
    } catch (err: any) {
      if (err && (err.code === 'FileNotFound' || err.name === 'FileNotFound')) {
        return [];
      }
      return [];
    }
  }

  private isHistoryEntry(value: any): value is HistoryEntry {
    return value && typeof value.text === 'string' && typeof value.role === 'string';
  }

  private computeWorkspaceKey(): string {
    const folders = vscode.workspace.workspaceFolders;
    if (!folders || folders.length === 0) {
      return 'global';
    }
    const primary = folders[0].uri.fsPath;
    return crypto.createHash('sha256').update(primary).digest('hex');
  }
}
