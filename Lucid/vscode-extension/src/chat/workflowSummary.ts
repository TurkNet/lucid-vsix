import * as vscode from 'vscode';
import type { ChatHistoryManager, HistoryMode, HistoryRole } from './historyManager';

export type WorkflowStage = 'analysis' | 'diff' | 'patch' | 'tests' | 'report' | 'summary';

export interface WorkflowFileInsight {
  path: string;
  summary?: string;
  status?: 'scanned' | 'changed' | 'unchanged' | 'error';
  diffId?: string;
  patchActionId?: string;
}

export interface WorkflowDiffPreview {
  id: string;
  title: string;
  summary?: string;
  hunks: string;
  keep?: boolean;
  undo?: boolean;
  added?: number;
  removed?: number;
  path?: string;
}

export interface WorkflowPatchAction {
  actionId: string;
  title: string;
  description?: string;
  applied?: boolean;
}

export interface WorkflowTestStatus {
  name: string;
  status: 'passed' | 'failed' | 'running';
  logActionId?: string;
}

export interface WorkflowReportMetric {
  label: string;
  value: string;
}

export interface WorkflowReportArtifact {
  label: string;
  url?: string;
  actionId?: string;
}

export interface WorkflowReport {
  title: string;
  highlights?: string[];
  metrics?: WorkflowReportMetric[];
  artifacts?: WorkflowReportArtifact[];
}

export interface WorkflowSummaryPayload {
  stageOrder?: WorkflowStage[];
  files?: WorkflowFileInsight[];
  diffs?: WorkflowDiffPreview[];
  patches?: WorkflowPatchAction[];
  tests?: WorkflowTestStatus[];
  report?: WorkflowReport;
}

export interface WorkflowMessageOptions {
  text?: string;
  role?: HistoryRole;
  mode?: HistoryMode;
}

export async function postWorkflowSummaryMessage(params: {
  webview: vscode.Webview;
  summary: WorkflowSummaryPayload;
  historyManager?: ChatHistoryManager;
  options?: WorkflowMessageOptions;
}): Promise<void> {
  const { webview, summary, historyManager, options } = params;
  const role = options?.role ?? 'assistant';
  const text = options?.text ?? '';
  const mode = options?.mode;

  webview.postMessage({
    type: 'append',
    text,
    role,
    options: {
      sendMode: mode,
      workflowSummary: summary
    }
  });

  if (!historyManager) return;
  await historyManager.appendEntry({
    role,
    text,
    mode,
    timestamp: Date.now(),
    workflowSummary: summary
  });
}
