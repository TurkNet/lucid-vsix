import * as vscode from "vscode";

const SECTION = "lucid";

export class LucidConfig {
  private static getSection() {
    return vscode.workspace.getConfiguration(SECTION);
  }

  static getEndpoint(): string {
    return this.getSection().get<string>(
      "ollamaEndpoint",
      "https://api.example.com/v1/chat/completions"
    );
  }

  static getModelName(): string {
    // Model artık opsiyonel - boş ise gönderilmeyecek
    return this.getSection().get<string>("modelName", "");
  }

  static isInlineCompletionEnabled(): boolean {
    return this.getSection().get<boolean>("enableInlineCompletion", true);
  }

  static getExtraHeaders(): Record<string, string> {
    return (
      this.getSection().get<Record<string, string>>("ollamaExtraHeaders", {}) ||
      {}
    );
  }

  static getApiKey(): string {
    return this.getSection().get<string>("ollamaApiKey", "") || "";
  }

  static getApiKeyHeaderName(): string {
    return (
      this.getSection().get<string>("ollamaApiKeyHeaderName", "") || "X-API-Key"
    );
  }

  static shouldShowStreamingStatus(): boolean {
    return this.getSection().get<boolean>("enableStreamingStatus", true);
  }

  static shouldLogUnmaskedHeaders(): boolean {
    return this.getSection().get<boolean>("logUnmaskedHeaders", false);
  }

  static shouldLogUnmaskedHeadersInDev(): boolean {
    return this.getSection().get<boolean>("logUnmaskedHeadersInDev", true);
  }
}
