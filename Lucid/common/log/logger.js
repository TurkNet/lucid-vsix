"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LucidLogger = void 0;
const vscode = require("vscode");
class LucidLogger {
    static initialize(context) {
        this.isDev = context.extensionMode === vscode.ExtensionMode.Development;
        this.initialized = true;
    }
    static prefix(message) {
        return `[Lucid] ${message}`;
    }
    static debug(message, ...args) {
        if (!this.isDev) {
            return;
        }
        console.debug(this.prefix(message), ...args);
    }
    static info(message, ...args) {
        console.log(this.prefix(message), ...args);
    }
    static warn(message, ...args) {
        console.warn(this.prefix(message), ...args);
    }
    static error(message, ...args) {
        console.error(this.prefix(message), ...args);
    }
    static assertInitialized() {
        if (!this.initialized) {
            console.warn(this.prefix('Logger used before initialization. Call LucidLogger.initialize in activate().'));
        }
    }
}
exports.LucidLogger = LucidLogger;
LucidLogger.isDev = false;
LucidLogger.initialized = false;
//# sourceMappingURL=logger.js.map