import * as vscode from 'vscode';
import { LucidConfig } from '../config';
import { LucidLogger } from './logger';

export interface CurlLogOptions {
  url: string;
  method?: string;
  headers?: Record<string, string>;
  body?: string | object;
  stream?: boolean;
  label?: string;
  revealSensitive?: boolean;
}

function escapeSingleQuotes(input: string): string {
  return input.replace(/'/g, "'\\''");
}

export class CurlLogger {
  static shouldRevealSensitive(context: vscode.ExtensionContext): boolean {
    const logUnmasked = LucidConfig.shouldLogUnmaskedHeaders();
    const logUnmaskedInDev = LucidConfig.shouldLogUnmaskedHeadersInDev();
    return logUnmasked || (logUnmaskedInDev && context.extensionMode === vscode.ExtensionMode.Development);
  }

  static buildCommand(options: CurlLogOptions): string {
    const { url, method = 'POST', headers = {}, stream, revealSensitive, body } = options;
    const flag = stream ? '-N' : '-s';
    let cmd = `curl ${flag} -X ${method.toUpperCase()} '${url}'`;

    for (const key of Object.keys(headers)) {
      const value = headers[key];
      const lower = key.toLowerCase();
      const isSensitive = lower === 'x-api-key' || lower.includes('authorization');
      const printable = revealSensitive || !isSensitive ? value : '****';
      cmd += ` -H '${key}: ${printable}'`;
    }

    if (body !== undefined) {
      const payload = typeof body === 'string' ? body : JSON.stringify(body);
      cmd += ` --data-raw '${escapeSingleQuotes(payload)}'`;
    }

    return cmd;
  }

  static log(options: CurlLogOptions): void {
    try {
      const command = CurlLogger.buildCommand(options);
      const label = options.label || 'CurlLogger';
      LucidLogger.debug(`${label}: ${command}`);
    } catch (err) {
      LucidLogger.error('Failed to build curl log:', err);
    }
  }
}
