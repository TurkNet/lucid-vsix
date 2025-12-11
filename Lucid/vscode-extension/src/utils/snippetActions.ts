import * as vscode from 'vscode';
import { LucidLogger } from '../../../common/log/logger';

export async function applySnippetToActiveEditor(snippet: string, mode: 'replace' | 'insert'): Promise<boolean> {
  if (!snippet || !snippet.length) return false;
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showInformationMessage('Open a text editor to apply this snippet.');
    return false;
  }

  const snippetString = new vscode.SnippetString(snippet);
  try {
    if (mode === 'replace') {
      const targeted = editor.selections?.filter(sel => sel && !sel.isEmpty) || [];
      if (targeted.length > 0) {
        return await editor.insertSnippet(snippetString, targeted);
      }
      const start = new vscode.Position(0, 0);
      const lastLine = Math.max(0, editor.document.lineCount - 1);
      const end = editor.document.lineCount > 0
        ? editor.document.lineAt(lastLine).range.end
        : start;
      const fullRange = new vscode.Range(start, end);
      return await editor.insertSnippet(snippetString, fullRange);
    }

    const positions = editor.selections?.map(sel => sel?.active).filter(Boolean) || [];
    if (positions.length === 1 && positions[0]) {
      return await editor.insertSnippet(snippetString, positions[0]);
    }
    if (positions.length > 1) {
      return await editor.insertSnippet(snippetString, positions);
    }
    return await editor.insertSnippet(snippetString);
  } catch (err) {
    LucidLogger.error('applySnippetToActiveEditor error', err);
    vscode.window.showErrorMessage('Failed to apply snippet. Check logs for details.');
    return false;
  }
}
