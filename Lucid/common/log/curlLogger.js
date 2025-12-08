"use strict";
Object.defineProperty(exports, "__esModule", { value: true });
exports.CurlLogger = void 0;
const vscode = require("vscode");
const config_1 = require("../config");
const logger_1 = require("./logger");
function escapeSingleQuotes(input) {
    return input.replace(/'/g, "'\\''");
}
class CurlLogger {
    static shouldRevealSensitive(context) {
        const logUnmasked = config_1.LucidConfig.shouldLogUnmaskedHeaders();
        const logUnmaskedInDev = config_1.LucidConfig.shouldLogUnmaskedHeadersInDev();
        return logUnmasked || (logUnmaskedInDev && context.extensionMode === vscode.ExtensionMode.Development);
    }
    static buildCommand(options) {
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
    static log(options) {
        try {
            const command = CurlLogger.buildCommand(options);
            const label = options.label || 'CurlLogger';
            logger_1.LucidLogger.debug(`${label}: ${command}`);
        }
        catch (err) {
            logger_1.LucidLogger.error('Failed to build curl log:', err);
        }
    }
}
exports.CurlLogger = CurlLogger;
//# sourceMappingURL=curlLogger.js.map