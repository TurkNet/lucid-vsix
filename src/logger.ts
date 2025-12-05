import * as vscode from 'vscode';

export class LucidLogger {
  private static isDev = false;
  private static initialized = false;

  static initialize(context: vscode.ExtensionContext) {
    this.isDev = context.extensionMode === vscode.ExtensionMode.Development;
    this.initialized = true;
  }

  private static prefix(message: string) {
    return `[Lucid] ${message}`;
  }

  static debug(message: string, ...args: unknown[]) {
    if (!this.isDev) {
      return;
    }
    console.debug(this.prefix(message), ...args);
  }

  static info(message: string, ...args: unknown[]) {
    console.log(this.prefix(message), ...args);
  }

  static warn(message: string, ...args: unknown[]) {
    console.warn(this.prefix(message), ...args);
  }

  static error(message: string, ...args: unknown[]) {
    console.error(this.prefix(message), ...args);
  }

  static assertInitialized() {
    if (!this.initialized) {
      console.warn(this.prefix('Logger used before initialization. Call LucidLogger.initialize in activate().'));
    }
  }
}
