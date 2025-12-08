"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.LucidConfig = void 0;
const vscode = require("vscode");
const SECTION = 'lucid';
class LucidConfig {
    static getSection() {
        return vscode.workspace.getConfiguration(SECTION);
    }
    static getEndpoint() {
        return this.getSection().get('ollamaEndpoint', 'http://localhost:11434');
    }
    static getModelName() {
        return this.getSection().get('modelName', 'llama3');
    }
    static isInlineCompletionEnabled() {
        return this.getSection().get('enableInlineCompletion', true);
    }
    static getExtraHeaders() {
        return this.getSection().get('ollamaExtraHeaders', {}) || {};
    }
    static getApiKeyHeaderName() {
        return this.getSection().get('ollamaApiKeyHeaderName', 'Authorization');
    }
    static getApiKey() {
        return this.getSection().get('ollamaApiKey', '') || '';
    }
    static shouldShowStreamingStatus() {
        return this.getSection().get('enableStreamingStatus', true);
    }
    static shouldLogUnmaskedHeaders() {
        return this.getSection().get('logUnmaskedHeaders', false);
    }
    static shouldLogUnmaskedHeadersInDev() {
        return this.getSection().get('logUnmaskedHeadersInDev', true);
    }
}
exports.LucidConfig = LucidConfig;
//# sourceMappingURL=config.js.map