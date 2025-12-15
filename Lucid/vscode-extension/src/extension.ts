import * as vscode from "vscode";
import * as path from "path";
import * as fs from "fs";
import { CurlLogger } from "../../common/log/curlLogger";
import { LucidConfig } from "../../common/config";
import { LucidLogger } from "../../common/log/logger";

let extensionContext: vscode.ExtensionContext | undefined;

interface OllamaMessage {
  role: string;
  content: string;
}

interface OllamaResponse {
  model: string;
  created_at: string;
  message: {
    role: string;
    content: string;
  };
  done: boolean;
}

interface OllamaGenerateResponse {
  model: string;
  created_at: string;
  response: string;
  done: boolean;
}

function getNonce(): string {
  const chars =
    "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let nonce = "";
  for (let i = 0; i < 24; i++)
    nonce += chars.charAt(Math.floor(Math.random() * chars.length));
  return nonce;
}

// ============= CODE READING HELPERS =============

// Get active editor's content and metadata
function getActiveEditorInfo(): {
  fileName: string;
  filePath: string;
  content: string;
  language: string;
  selection?: string;
  selectionRange?: { start: number; end: number };
} | null {
  const editor = vscode.window.activeTextEditor;
  if (!editor) return null;

  const doc = editor.document;
  const selection = editor.selection;
  const selectedText = !selection.isEmpty ? doc.getText(selection) : undefined;

  return {
    fileName: path.basename(doc.fileName),
    filePath: doc.fileName,
    content: doc.getText(),
    language: doc.languageId,
    selection: selectedText,
    selectionRange: selectedText
      ? {
          start: doc.offsetAt(selection.start),
          end: doc.offsetAt(selection.end),
        }
      : undefined,
  };
}

// Read a specific file's content
async function readFileContent(filePath: string): Promise<string | null> {
  try {
    const uri = vscode.Uri.file(filePath);
    const bytes = await vscode.workspace.fs.readFile(uri);
    return Buffer.from(bytes).toString("utf8");
  } catch (e) {
    LucidLogger.error("readFileContent error", e);
    return null;
  }
}

// ============= CODE EDITING HELPERS =============

// Apply code to active editor (replace all or selection)
async function applyCodeToEditor(
  code: string,
  replaceSelection: boolean = false
): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active editor to apply code");
    return false;
  }

  const success = await editor.edit((editBuilder) => {
    if (replaceSelection && !editor.selection.isEmpty) {
      editBuilder.replace(editor.selection, code);
    } else {
      const fullRange = new vscode.Range(
        editor.document.positionAt(0),
        editor.document.positionAt(editor.document.getText().length)
      );
      editBuilder.replace(fullRange, code);
    }
  });

  if (success) {
    vscode.window.showInformationMessage("Code applied successfully!");
  }
  return success;
}

// Insert code at cursor position
async function insertCodeAtCursor(code: string): Promise<boolean> {
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    vscode.window.showErrorMessage("No active editor");
    return false;
  }

  const success = await editor.edit((editBuilder) => {
    editBuilder.insert(editor.selection.active, code);
  });

  return success;
}

// Show diff between original and new code, let user accept/reject
async function showCodeDiff(
  originalCode: string,
  newCode: string,
  fileName: string
): Promise<boolean> {
  // Create temp URIs for diff view
  const originalUri = vscode.Uri.parse(`lucid-diff:original/${fileName}`);
  const modifiedUri = vscode.Uri.parse(`lucid-diff:modified/${fileName}`);

  // Register a simple text document provider for diff
  const provider = new (class implements vscode.TextDocumentContentProvider {
    provideTextDocumentContent(uri: vscode.Uri): string {
      if (uri.path.startsWith("original/")) return originalCode;
      if (uri.path.startsWith("modified/")) return newCode;
      return "";
    }
  })();

  const disposable = vscode.workspace.registerTextDocumentContentProvider(
    "lucid-diff",
    provider
  );

  try {
    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      modifiedUri,
      `${fileName}: Original ↔ AI Suggestion`
    );

    const choice = await vscode.window.showInformationMessage(
      "Apply the suggested changes?",
      "Apply",
      "Cancel"
    );

    disposable.dispose();
    return choice === "Apply";
  } catch (e) {
    disposable.dispose();
    LucidLogger.error("showCodeDiff error", e);
    return false;
  }
}

// Extract code block from AI response (handles ```language ... ``` format)
function extractCodeFromResponse(response: string): string {
  // Try to find code block with triple backticks
  const codeBlockRegex = /```(?:\w+)?\s*\n?([\s\S]*?)```/g;
  const matches = [...response.matchAll(codeBlockRegex)];

  if (matches.length > 0) {
    // Return the first code block content
    return matches[0][1].trim();
  }

  // If no code block found, return the whole response trimmed
  return response.trim();
}

// Extract CLI commands from response
function extractCliCommands(response: string): string[] {
  const commands: string[] = [];

  // Pattern 1: Commands in bash/sh/shell/zsh code blocks
  const shellBlockRegex =
    /```(?:bash|sh|shell|zsh|terminal|console|cmd)\s*\n([\s\S]*?)```/gi;
  const shellMatches = [...response.matchAll(shellBlockRegex)];

  for (const match of shellMatches) {
    const blockContent = match[1].trim();
    const lines = blockContent.split("\n");

    for (const line of lines) {
      const trimmed = line.trim();
      // Skip comments and empty lines
      if (trimmed && !trimmed.startsWith("#") && !trimmed.startsWith("//")) {
        // Remove $ or > prompt prefix if present
        const cleaned = trimmed.replace(/^[$>]\s*/, "");
        if (cleaned) {
          commands.push(cleaned);
        }
      }
    }
  }

  // Pattern 2: Inline commands with backticks (like `npm install`)
  const inlineRegex = /`([^`]+)`/g;
  const inlineMatches = [...response.matchAll(inlineRegex)];

  for (const match of inlineMatches) {
    const cmd = match[1].trim();
    // Check if it looks like a CLI command (contains common CLI keywords)
    if (
      cmd.match(
        /^(npm|yarn|pnpm|git|node|python|pip|docker|kubectl|cargo|go|rustc|gcc|make|mvn|gradle)\s+/
      )
    ) {
      commands.push(cmd);
    }
  }

  return [...new Set(commands)]; // Remove duplicates
}

// ============= AGENT MODE LOGIC =============

interface PendingAgentChange {
  changeId: string;
  filePath: string;
  fileName: string;
  originalCode: string;
  newCode: string;
  preview: string;
}

// Store for pending agent changes
const pendingAgentChanges: Map<string, PendingAgentChange> = new Map();

// Conversation history (stores messages for context)
let conversationHistory: OllamaMessage[] = [];

// Build agent system prompt that instructs the AI to return code in a specific format
function buildAgentSystemPrompt(): string {
  return `You are an AI coding agent. When the user asks you to modify code, you MUST:
1. Analyze the provided code carefully
2. Make the requested changes
3. Return the COMPLETE modified code inside a code block with the appropriate language tag
4. If you need to explain your changes, do so BEFORE the code block

IMPORTANT: Always return the full modified code, not just the changes. The code will be applied directly to the file.

Example format:
I've added error handling to the function.

\`\`\`typescript
// Your complete modified code here
\`\`\`
`;
}

// Process agent response and extract code for approval
async function processAgentResponse(
  webview: vscode.Webview,
  response: string,
  selectionInfo: any
): Promise<void> {
  const extractedCode = extractCodeFromResponse(response);

  // Check for CLI commands in the response
  const cliCommands = extractCliCommands(response);
  if (cliCommands.length > 0) {
    webview.postMessage({
      type: "cliCommandsDetected",
      commands: cliCommands,
    });
  }

  if (!extractedCode || extractedCode === response.trim()) {
    // No code block found, treat as regular response
    webview.postMessage({ type: "append", text: response, role: "assistant" });
    webview.postMessage({ type: "status", text: "Idle", streaming: false });
    return;
  }

  // Get the active editor for context
  const editor = vscode.window.activeTextEditor;
  if (!editor) {
    webview.postMessage({ type: "append", text: response, role: "assistant" });
    webview.postMessage({ type: "status", text: "Idle", streaming: false });
    return;
  }

  const fileName = path.basename(editor.document.fileName);
  const filePath = editor.document.fileName;

  // Determine what code we're replacing
  let originalCode: string;
  if (
    selectionInfo &&
    selectionInfo.hasSelection &&
    selectionInfo.selectedText
  ) {
    originalCode = selectionInfo.selectedText;
  } else {
    originalCode = editor.document.getText();
  }

  // Generate unique change ID
  const changeId = `change_${Date.now()}_${Math.random()
    .toString(36)
    .substr(2, 9)}`;

  // Store the pending change
  const pendingChange: PendingAgentChange = {
    changeId,
    filePath,
    fileName,
    originalCode,
    newCode: extractedCode,
    preview:
      extractedCode.length > 500
        ? extractedCode.substring(0, 500) + "..."
        : extractedCode,
  };
  pendingAgentChanges.set(changeId, pendingChange);

  // Send the response text (without code block) to chat
  const textBeforeCode = response.split("```")[0].trim();
  if (textBeforeCode) {
    webview.postMessage({
      type: "append",
      text: textBeforeCode,
      role: "assistant",
    });
  }

  // Send pending change notification to UI
  webview.postMessage({
    type: "agentPendingChange",
    changeId,
    fileName,
    filePath,
    preview: pendingChange.preview,
    hasSelection: selectionInfo?.hasSelection || false,
  });

  webview.postMessage({
    type: "status",
    text: "Awaiting approval...",
    streaming: false,
  });
}

// Apply an approved agent change
async function applyAgentChange(
  changeId: string,
  webview: vscode.Webview
): Promise<boolean> {
  const change = pendingAgentChanges.get(changeId);
  if (!change) {
    LucidLogger.error("Agent change not found:", changeId);
    return false;
  }

  try {
    const editor = vscode.window.activeTextEditor;
    if (!editor || editor.document.fileName !== change.filePath) {
      // Try to open the correct file
      const doc = await vscode.workspace.openTextDocument(change.filePath);
      await vscode.window.showTextDocument(doc);
    }

    const activeEditor = vscode.window.activeTextEditor;
    if (!activeEditor) {
      throw new Error("No active editor");
    }

    // Apply the change directly
    const success = await activeEditor.edit((editBuilder) => {
      if (change.originalCode === activeEditor.document.getText()) {
        // Replace entire file
        const fullRange = new vscode.Range(
          activeEditor.document.positionAt(0),
          activeEditor.document.positionAt(
            activeEditor.document.getText().length
          )
        );
        editBuilder.replace(fullRange, change.newCode);
      } else {
        // Try to find and replace the selection
        const text = activeEditor.document.getText();
        const startIndex = text.indexOf(change.originalCode);
        if (startIndex !== -1) {
          const startPos = activeEditor.document.positionAt(startIndex);
          const endPos = activeEditor.document.positionAt(
            startIndex + change.originalCode.length
          );
          editBuilder.replace(
            new vscode.Range(startPos, endPos),
            change.newCode
          );
        } else {
          // Fallback: replace entire file
          const fullRange = new vscode.Range(
            activeEditor.document.positionAt(0),
            activeEditor.document.positionAt(
              activeEditor.document.getText().length
            )
          );
          editBuilder.replace(fullRange, change.newCode);
        }
      }
    });

    if (success) {
      // Save the document automatically
      await activeEditor.document.save();

      webview.postMessage({
        type: "agentChangeApplied",
        fileName: change.fileName,
        changeId,
      });
      webview.postMessage({
        type: "status",
        text: "Idle",
        streaming: false,
      });
      vscode.window.showInformationMessage(
        `✅ Changes applied and saved to ${change.fileName}`
      );
    }

    pendingAgentChanges.delete(changeId);
    return success;
  } catch (e) {
    LucidLogger.error("applyAgentChange error", e);
    pendingAgentChanges.delete(changeId);
    return false;
  }
}

// Show diff for agent change (view-only, with Apply/Reject in UI)
async function showAgentChangeDiff(changeId: string): Promise<void> {
  const change = pendingAgentChanges.get(changeId);
  if (!change) {
    return;
  }

  try {
    const originalUri = vscode.Uri.parse(
      `lucid-agent-diff:original/${change.fileName}?id=${changeId}`
    );
    const modifiedUri = vscode.Uri.parse(
      `lucid-agent-diff:modified/${change.fileName}?id=${changeId}`
    );

    const provider = new (class implements vscode.TextDocumentContentProvider {
      provideTextDocumentContent(uri: vscode.Uri): string {
        const query = new URLSearchParams(uri.query);
        const id = query.get("id");
        const agentChange = pendingAgentChanges.get(id || "");
        if (!agentChange) return "";

        if (uri.path.startsWith("original/")) return agentChange.originalCode;
        if (uri.path.startsWith("modified/")) return agentChange.newCode;
        return "";
      }
    })();

    const disposable = vscode.workspace.registerTextDocumentContentProvider(
      "lucid-agent-diff",
      provider
    );

    await vscode.commands.executeCommand(
      "vscode.diff",
      originalUri,
      modifiedUri,
      `🤖 Agent Suggestion: ${change.fileName}`
    );

    // Disposable will be cleaned up later
    setTimeout(() => disposable.dispose(), 60000); // Clean up after 1 minute
  } catch (e) {
    LucidLogger.error("showAgentChangeDiff error", e);
  }
}

async function buildHeadersFromConfig(): Promise<Record<string, string>> {
  const headers: Record<string, string> = {
    "Content-Type": "application/json",
  };
  try {
    const apiKey = LucidConfig.getApiKey();
    const apiKeyHeaderName = LucidConfig.getApiKeyHeaderName();
    LucidLogger.debug("apiKeyHeaderName resolved", apiKeyHeaderName);
    if (typeof console !== "undefined")
      console.log("apiKeyHeaderName=", apiKeyHeaderName);
    if (apiKey && apiKey.length) headers[apiKeyHeaderName] = `${apiKey}`;
    const extra = LucidConfig.getExtraHeaders() || {};
    for (const k of Object.keys(extra)) {
      try {
        headers[k] = String((extra as any)[k]);
      } catch (_) {}
    }
  } catch (e) {
    LucidLogger.debug("buildHeadersFromConfig error", e);
  }
  return headers;
}

// Send a file's contents to the Ollama endpoint and return a normalized response
async function sendFileUri(
  uri: vscode.Uri
): Promise<{ ok: boolean; status: number; text: string; json?: any }> {
  try {
    const bytes = await vscode.workspace.fs.readFile(uri);
    const text = Buffer.from(bytes).toString("utf8");
    const endpoint = LucidConfig.getEndpoint();
    const model = LucidConfig.getModelName();
    const headers = await buildHeadersFromConfig();

    // Model boşsa gönderme, doluysa ekle
    const body: any = {
      messages: [{ role: "user", content: text }],
      stream: false,
    };
    if (model && model.length > 0) body.model = model;

    const resp = await fetch(endpoint, {
      method: "POST",
      headers,
      body: JSON.stringify(body),
    });

    const bodyText = await resp.text().catch(() => resp.statusText || "");
    let parsed: any = undefined;
    try {
      parsed = JSON.parse(bodyText);
    } catch (_) {
      parsed = undefined;
    }

    // Provide simple interactive actions to the user from the caller
    if (resp.ok) {
      // Attempt to surface useful actions if the response contains urls or ids
      const urls: string[] = [];
      const id = parsed && parsed.id ? String(parsed.id) : undefined;
      // if parsed contains fields with http(s) strings, collect them (best-effort)
      try {
        const maybe = parsed || {};
        for (const k of Object.keys(maybe)) {
          const v = maybe[k];
          if (
            typeof v === "string" &&
            (v.startsWith("http://") || v.startsWith("https://"))
          )
            urls.push(v);
          if (Array.isArray(v)) {
            for (const item of v)
              if (
                typeof item === "string" &&
                (item.startsWith("http://") || item.startsWith("https://"))
              )
                urls.push(item);
          }
        }
      } catch (_) {}

      if (urls.length > 0 || id || parsed) {
        const actions: string[] = [];
        if (urls.length > 0) actions.push("Open URL");
        if (id) actions.push("Copy ID");
        actions.push("Show Raw");

        const pick = await vscode.window.showInformationMessage(
          `File sent — status ${resp.status}`,
          ...actions
        );
        if (pick === "Open URL" && urls.length > 0) {
          const pickUrl =
            urls.length === 1
              ? urls[0]
              : await vscode.window.showQuickPick(urls, {
                  placeHolder: "Select URL to open",
                });
          if (pickUrl) await vscode.env.openExternal(vscode.Uri.parse(pickUrl));
        } else if (pick === "Copy ID" && id) {
          await vscode.env.clipboard.writeText(String(id));
          vscode.window.showInformationMessage("ID copied to clipboard");
        } else if (pick === "Show Raw") {
          const doc = await vscode.workspace.openTextDocument({
            content: JSON.stringify(parsed || bodyText, null, 2),
            language: "json",
          });
          await vscode.window.showTextDocument(doc, { preview: true });
        }
      }
    }

    return { ok: resp.ok, status: resp.status, text: bodyText, json: parsed };
  } catch (e) {
    LucidLogger.error("sendFileUri error", e);
    return { ok: false, status: 0, text: String(e) };
  }
}

// Stream chunked Ollama responses to the webview and keep the UI informed via status messages.
async function sendPromptToOllama(webview: vscode.Webview, prompt: string) {
  const endpoint = LucidConfig.getEndpoint();
  const model = LucidConfig.getModelName();
  const headers = await buildHeadersFromConfig();
  const streamingStatusEnabled = LucidConfig.shouldShowStreamingStatus();

  // Add user message to conversation history (only if last message is not user)
  if (
    conversationHistory.length === 0 ||
    conversationHistory[conversationHistory.length - 1].role !== "user"
  ) {
    conversationHistory.push({ role: "user", content: prompt });
  }

  // Model boşsa gönderme, doluysa ekle
  const body: any = {
    messages: conversationHistory, // Send full conversation history
    stream: streamingStatusEnabled,
  };
  if (model && model.length > 0) body.model = model;

  try {
    CurlLogger.log({
      url: endpoint,
      headers,
      body: body,
      label: "CURL sendPromptToOllama",
      revealSensitive: extensionContext
        ? CurlLogger.shouldRevealSensitive(extensionContext)
        : false,
    });

    webview.postMessage({
      type: "status",
      text: "Connecting to API…",
      streaming: streamingStatusEnabled,
    });
    const response = await fetch(`${endpoint}`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const txt = await response.text().catch(() => response.statusText);
      throw new Error(`API error ${response.status}: ${txt}`);
    }

    let fullResponse = ""; // Track full response

    // Handle streaming vs non-streaming responses
    if (streamingStatusEnabled && response.body) {
      webview.postMessage({
        type: "status",
        text: "Streaming response…",
        streaming: true,
      });

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = "";

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split("\n");

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          try {
            const parsed = JSON.parse(trimmed);
            let content = "";
            if (parsed.choices && Array.isArray(parsed.choices)) {
              for (const c of parsed.choices) {
                const msg =
                  c?.message?.content ||
                  c?.text ||
                  c?.response ||
                  c?.delta?.content;
                if (msg) content += String(msg);
              }
            } else if (parsed.message && parsed.message.content) {
              content = parsed.message.content;
            } else if (parsed.response) {
              content = parsed.response;
            } else if (typeof parsed === "string") {
              content = parsed;
            }
            if (content) {
              fullResponse += content;
              webview.postMessage({
                type: "append",
                text: content,
                role: "assistant",
              });
            }
          } catch (e) {
            fullResponse += trimmed;
            webview.postMessage({
              type: "append",
              text: trimmed,
              role: "assistant",
            });
          }
        }
      }

      if (buffer.trim()) {
        try {
          const p = JSON.parse(buffer.trim());
          const content = p?.message?.content || p?.response || "";
          if (content) {
            fullResponse += content;
            webview.postMessage({
              type: "append",
              text: content,
              role: "assistant",
            });
          }
        } catch (e) {
          fullResponse += buffer;
          webview.postMessage({
            type: "append",
            text: buffer,
            role: "assistant",
          });
        }
      }
    } else {
      // Non-streaming response
      webview.postMessage({
        type: "status",
        text: "Processing response…",
        streaming: false,
      });

      const responseText = await response.text();
      try {
        const parsed = JSON.parse(responseText);

        // Extract content from different response formats
        if (
          parsed.choices &&
          Array.isArray(parsed.choices) &&
          parsed.choices.length > 0
        ) {
          // OpenAI-style response
          const choice = parsed.choices[0];
          fullResponse = choice?.message?.content || choice?.text || "";
        } else if (parsed.message?.content) {
          // Ollama-style response
          fullResponse = parsed.message.content;
        } else if (parsed.response) {
          // Alternative format
          fullResponse = parsed.response;
        } else if (parsed.content) {
          fullResponse = parsed.content;
        } else {
          fullResponse = responseText;
        }
      } catch (e) {
        fullResponse = responseText;
      }

      if (fullResponse) {
        webview.postMessage({
          type: "append",
          text: fullResponse,
          role: "assistant",
        });
      }
    }

    // Add assistant response to conversation history
    if (fullResponse.trim()) {
      conversationHistory.push({ role: "assistant", content: fullResponse });
    }

    // Check for CLI commands in the full response (Ask mode)
    const cliCommands = extractCliCommands(fullResponse);
    if (cliCommands.length > 0) {
      webview.postMessage({
        type: "cliCommandsDetected",
        commands: cliCommands,
      });
    }

    webview.postMessage({ type: "status", text: "Idle", streaming: false });
  } catch (err) {
    webview.postMessage({
      type: "status",
      text: err instanceof Error ? err.message : "Ollama request failed",
      level: "error",
      streaming: false,
    });
    throw err;
  }
}

// Agent mode: Send prompt and collect full response (no streaming to UI)
async function sendPromptToOllamaAndCollect(
  webview: vscode.Webview,
  prompt: string
): Promise<string> {
  const endpoint = LucidConfig.getEndpoint();
  const model = LucidConfig.getModelName();
  const headers = await buildHeadersFromConfig();

  // Add user message to conversation history (only if last message is not user)
  if (
    conversationHistory.length === 0 ||
    conversationHistory[conversationHistory.length - 1].role !== "user"
  ) {
    conversationHistory.push({ role: "user", content: prompt });
  }

  // For agent mode, we don't stream - we want the full response
  const body: any = {
    messages: conversationHistory, // Send full conversation history
    stream: false,
  };
  if (model && model.length > 0) body.model = model;

  try {
    CurlLogger.log({
      url: endpoint,
      headers,
      body: body,
      label: "CURL sendPromptToOllamaAndCollect (Agent)",
      revealSensitive: extensionContext
        ? CurlLogger.shouldRevealSensitive(extensionContext)
        : false,
    });

    webview.postMessage({
      type: "status",
      text: "🤖 Agent thinking…",
      streaming: true,
    });

    const response = await fetch(`${endpoint}`, {
      method: "POST",
      headers: headers,
      body: JSON.stringify(body),
    });

    if (!response.ok) {
      const txt = await response.text().catch(() => response.statusText);
      throw new Error(`API error ${response.status}: ${txt}`);
    }

    const responseText = await response.text();

    // Parse the response to extract content
    try {
      const parsed = JSON.parse(responseText);

      // Handle different API response formats
      if (
        parsed.choices &&
        Array.isArray(parsed.choices) &&
        parsed.choices.length > 0
      ) {
        // OpenAI-style response
        const choice = parsed.choices[0];
        return choice?.message?.content || choice?.text || responseText;
      } else if (parsed.message?.content) {
        // Ollama-style response
        return parsed.message.content;
      } else if (parsed.response) {
        // Alternative Ollama format
        return parsed.response;
      } else if (parsed.content) {
        return parsed.content;
      }

      // Fallback to raw response
      const finalResponse = responseText;

      // Add assistant response to conversation history
      if (finalResponse.trim()) {
        conversationHistory.push({ role: "assistant", content: finalResponse });
      }

      return finalResponse;
    } catch (e) {
      // If parsing fails, return raw text
      if (responseText.trim()) {
        conversationHistory.push({ role: "assistant", content: responseText });
      }
      return responseText;
    }
  } catch (err) {
    webview.postMessage({
      type: "status",
      text: err instanceof Error ? err.message : "Agent request failed",
      level: "error",
      streaming: false,
    });
    throw err;
  }
}

// --- 5. Webview Sidebar: Lucid Chat ---
class LucidSidebarProvider implements vscode.WebviewViewProvider {
  private _view?: vscode.WebviewView;
  constructor(private readonly _extensionUri: vscode.Uri) {}

  public async resolveWebviewView(webviewView: vscode.WebviewView) {
    this._view = webviewView;
    LucidLogger.debug("resolveWebviewView called");
    try {
      webviewView.webview.options = {
        enableScripts: true,
        localResourceRoots: [this._extensionUri],
      };

      // Safe HTML generation
      try {
        webviewView.webview.html = this._getHtmlForWebview(webviewView.webview);
      } catch (htmlErr) {
        LucidLogger.error("Error generating webview HTML:", htmlErr);
        webviewView.webview.html = `<body><pre>Failed to create webview UI: ${String(
          htmlErr
        )}</pre></body>`;
      }

      webviewView.webview.onDidReceiveMessage(async (msg) => {
        LucidLogger.debug("Webview message received", msg);
        // maintain a per-view set of attached files in closure
        if (!(webviewView as any)._attachedPaths)
          (webviewView as any)._attachedPaths = new Set<string>();
        const attachedPaths: Set<string> = (webviewView as any)._attachedPaths;

        async function listWorkspaceFiles() {
          try {
            const folders = vscode.workspace.workspaceFolders || [];
            if (folders.length === 0) return [];
            // Prefer files under the first workspace folder (common simple case)
            const first = folders[0];
            try {
              const rel = new vscode.RelativePattern(first, "**/*");
              const files = await vscode.workspace.findFiles(
                rel,
                "**/node_modules/**",
                1000
              );
              return files.map((f) => ({
                path: f.fsPath,
                name: path.basename(f.fsPath),
              }));
            } catch (e) {
              // fallback to workspace-wide search
              const files = await vscode.workspace.findFiles(
                "**/*",
                "**/node_modules/**",
                1000
              );
              return files.map((f) => ({
                path: f.fsPath,
                name: path.basename(f.fsPath),
              }));
            }
          } catch (e) {
            LucidLogger.error("listWorkspaceFiles error", e);
            return [];
          }
        }

        try {
          if (!msg || !msg.type) return;

          // ============= CODE EDITING HANDLERS =============

          // Get active editor info (for context-aware prompts)
          if (msg.type === "getActiveEditor") {
            const info = getActiveEditorInfo();
            webviewView.webview.postMessage({
              type: "activeEditorInfo",
              data: info,
            });
            return;
          }

          // Apply code to active editor (replace all or selection)
          if (msg.type === "applyCode") {
            const code = extractCodeFromResponse(String(msg.code || ""));
            if (!code) {
              vscode.window.showErrorMessage("No code to apply");
              return;
            }
            const replaceSelection = Boolean(msg.replaceSelection);
            const success = await applyCodeToEditor(code, replaceSelection);
            webviewView.webview.postMessage({
              type: "applyCodeResult",
              success,
            });
            return;
          }

          // Insert code at cursor
          if (msg.type === "insertAtCursor") {
            const code = extractCodeFromResponse(String(msg.code || ""));
            if (!code) {
              vscode.window.showErrorMessage("No code to insert");
              return;
            }
            const success = await insertCodeAtCursor(code);
            webviewView.webview.postMessage({ type: "insertResult", success });
            return;
          }

          // Show diff and apply
          if (msg.type === "showDiffAndApply") {
            const editor = vscode.window.activeTextEditor;
            if (!editor) {
              vscode.window.showErrorMessage("No active editor");
              return;
            }
            const originalCode = editor.document.getText();
            const newCode = extractCodeFromResponse(String(msg.code || ""));
            const fileName = path.basename(editor.document.fileName);

            const shouldApply = await showCodeDiff(
              originalCode,
              newCode,
              fileName
            );
            if (shouldApply) {
              await applyCodeToEditor(newCode, false);
            }
            return;
          }

          // Copy code to clipboard
          if (msg.type === "copyCode") {
            const code = extractCodeFromResponse(String(msg.code || ""));
            await vscode.env.clipboard.writeText(code);
            vscode.window.showInformationMessage("Code copied to clipboard!");
            return;
          }

          // Create new file with code
          if (msg.type === "createFileWithCode") {
            const code = extractCodeFromResponse(String(msg.code || ""));
            const fileName = String(msg.fileName || "untitled.txt");

            const workspaceFolders = vscode.workspace.workspaceFolders;
            if (!workspaceFolders || workspaceFolders.length === 0) {
              // No workspace, create untitled document
              const doc = await vscode.workspace.openTextDocument({
                content: code,
                language: msg.language || "plaintext",
              });
              await vscode.window.showTextDocument(doc);
            } else {
              // Save to workspace
              const filePath = await vscode.window.showSaveDialog({
                defaultUri: vscode.Uri.joinPath(
                  workspaceFolders[0].uri,
                  fileName
                ),
                saveLabel: "Create File",
              });
              if (filePath) {
                await vscode.workspace.fs.writeFile(
                  filePath,
                  Buffer.from(code, "utf8")
                );
                const doc = await vscode.workspace.openTextDocument(filePath);
                await vscode.window.showTextDocument(doc);
              }
            }
            return;
          }

          // ============= EXISTING HANDLERS =============

          if (msg.type === "requestFiles") {
            const files = await listWorkspaceFiles();
            webviewView.webview.postMessage({ type: "fileList", files });
            webviewView.webview.postMessage({
              type: "attachedChanged",
              files: Array.from(attachedPaths),
            });
            return;
          }

          if (msg.type === "attach") {
            const p = String(msg.path || "");
            if (p) attachedPaths.add(p);
            webviewView.webview.postMessage({
              type: "attachedChanged",
              files: Array.from(attachedPaths),
            });
            return;
          }

          if (msg.type === "detach") {
            const p = String(msg.path || "");
            if (p) attachedPaths.delete(p);
            webviewView.webview.postMessage({
              type: "attachedChanged",
              files: Array.from(attachedPaths),
            });
            return;
          }

          if (msg.type === "replay") {
            const prompt: string = String(msg.prompt || "");
            if (!prompt) return;
            const streamingStatusEnabledReplay =
              LucidConfig.shouldShowStreamingStatus();
            webviewView.webview.postMessage({
              type: "status",
              text: "Sending prompt…",
              streaming: streamingStatusEnabledReplay,
            });

            let combinedReplay = "";
            if (attachedPaths.size > 0) {
              for (const p of Array.from(attachedPaths)) {
                try {
                  const uri = vscode.Uri.file(p);
                  const bytes = await vscode.workspace.fs.readFile(uri);
                  const text = Buffer.from(bytes).toString("utf8");
                  combinedReplay += `--- ATTACHED: ${p
                    .split("/")
                    .pop()} ---\n${text}\n--- END ATTACHED ---\n\n`;
                } catch (e) {
                  LucidLogger.error("Failed to read attached file " + p, e);
                }
              }
            } else {
              try {
                const ed = vscode.window.activeTextEditor;
                if (ed && ed.document) {
                  const doc = ed.document;
                  const fileName =
                    doc.fileName && doc.fileName.length
                      ? path.basename(doc.fileName)
                      : doc.uri && doc.uri.path
                      ? path.basename(doc.uri.path)
                      : undefined;
                  const text = doc.getText();
                  combinedReplay += `--- ACTIVE EDITOR: ${
                    fileName || "untitled"
                  } ---\n${text}\n--- END ACTIVE EDITOR ---\n\n`;
                }
              } catch (e) {
                LucidLogger.debug(
                  "Failed to read active editor for fallback attached content",
                  e
                );
              }
            }

            const finalPromptReplay = combinedReplay + "\n" + prompt;
            try {
              await sendPromptToOllama(webviewView.webview, finalPromptReplay);
            } catch (e) {
              const text = e instanceof Error ? e.message : String(e);
              LucidLogger.error("sendPromptToOllama (replay) error", e);
              webviewView.webview.postMessage({ type: "error", text });
              webviewView.webview.postMessage({
                type: "status",
                text: "Ollama request failed",
                level: "error",
                streaming: false,
              });
            }
            return;
          }

          if (msg.type === "send") {
            const prompt: string = String(msg.prompt || "");
            const mode: string = String(msg.mode || "ask");
            const selectionInfo = msg.selection || null;

            if (!prompt) return;
            const streamingStatusEnabled =
              LucidConfig.shouldShowStreamingStatus();

            webviewView.webview.postMessage({
              type: "status",
              text:
                mode === "agent" ? "🤖 Agent processing…" : "Sending prompt…",
              streaming: streamingStatusEnabled,
            });

            let combined = "";
            if (attachedPaths.size > 0) {
              for (const p of Array.from(attachedPaths)) {
                try {
                  const uri = vscode.Uri.file(p);
                  const bytes = await vscode.workspace.fs.readFile(uri);
                  const text = Buffer.from(bytes).toString("utf8");
                  combined += `--- ATTACHED: ${p
                    .split("/")
                    .pop()} ---\n${text}\n--- END ATTACHED ---\n\n`;
                } catch (e) {
                  LucidLogger.error("Failed to read attached file " + p, e);
                }
              }
            } else {
              // No attached files: fall back to the active editor's contents (if any)
              try {
                const ed = vscode.window.activeTextEditor;
                if (ed && ed.document) {
                  const doc = ed.document;
                  const fileName =
                    doc.fileName && doc.fileName.length
                      ? path.basename(doc.fileName)
                      : doc.uri && doc.uri.path
                      ? path.basename(doc.uri.path)
                      : undefined;
                  const text = doc.getText();
                  combined += `--- ACTIVE EDITOR: ${
                    fileName || "untitled"
                  } ---\n${text}\n--- END ACTIVE EDITOR ---\n\n`;
                }
              } catch (e) {
                LucidLogger.debug(
                  "Failed to read active editor for fallback attached content",
                  e
                );
              }
            }

            // Add agent system prompt if in agent mode
            let finalPrompt = combined + "\n" + prompt;
            if (mode === "agent") {
              finalPrompt = buildAgentSystemPrompt() + "\n\n" + finalPrompt;
            }

            try {
              if (mode === "agent") {
                // Agent mode: collect full response then process for approval
                const fullResponse = await sendPromptToOllamaAndCollect(
                  webviewView.webview,
                  finalPrompt
                );
                await processAgentResponse(
                  webviewView.webview,
                  fullResponse,
                  selectionInfo
                );
              } else {
                // Ask mode: stream response directly
                await sendPromptToOllama(webviewView.webview, finalPrompt);
              }
            } catch (e) {
              const text = e instanceof Error ? e.message : String(e);
              LucidLogger.error("sendPromptToOllama error", e);
              webviewView.webview.postMessage({ type: "error", text });
              webviewView.webview.postMessage({
                type: "status",
                text: "Request failed",
                level: "error",
                streaming: false,
              });
            }
            return;
          }

          // Handle agent view diff (optional preview before apply)
          if (msg.type === "agentViewDiff") {
            const changeId = String(msg.changeId || "");
            await showAgentChangeDiff(changeId);
            return;
          }

          // Handle agent approval/rejection
          if (msg.type === "agentApprove") {
            const changeId = String(msg.changeId || "");
            const action = String(msg.action || "");

            if (action === "apply") {
              await applyAgentChange(changeId, webviewView.webview);
            } else {
              // Rejected
              pendingAgentChanges.delete(changeId);
              webviewView.webview.postMessage({
                type: "agentChangeRejected",
                changeId,
              });
              webviewView.webview.postMessage({
                type: "status",
                text: "Idle",
                streaming: false,
              });
            }
            return;
          }

          // Handle CLI command execution
          if (msg.type === "runCliCommand") {
            const command = String(msg.command || "");
            const commandIndex =
              typeof msg.commandIndex === "number" ? msg.commandIndex : -1;
            const waitForCompletion = msg.waitForCompletion === true;
            if (!command) return;

            try {
              // Create or reuse terminal
              let terminal = vscode.window.terminals.find(
                (t) => t.name === "Lucid CLI"
              );
              if (!terminal) {
                terminal = vscode.window.createTerminal({
                  name: "Lucid CLI",
                  cwd: vscode.workspace.workspaceFolders?.[0]?.uri.fsPath,
                });
              }
              terminal.show();

              if (waitForCompletion) {
                // Use Node.js child_process to run command and wait for completion
                const { exec } = require("child_process");
                const cwd = vscode.workspace.workspaceFolders?.[0]?.uri.fsPath;

                // Show command in terminal for visibility
                terminal.sendText(`# Running: ${command}`);

                exec(
                  command,
                  {
                    cwd,
                    shell:
                      process.platform === "win32"
                        ? "powershell.exe"
                        : "/bin/zsh",
                  },
                  (error: any, stdout: any, stderr: any) => {
                    // Display output in terminal
                    if (stdout) terminal.sendText(stdout);
                    if (stderr) terminal.sendText(stderr);

                    if (error) {
                      webviewView.webview.postMessage({
                        type: "cliCommandCompleted",
                        success: false,
                        command: command,
                        commandIndex: commandIndex,
                        error: error.message,
                      });
                    } else {
                      webviewView.webview.postMessage({
                        type: "cliCommandCompleted",
                        success: true,
                        command: command,
                        commandIndex: commandIndex,
                      });
                    }
                  }
                );
              } else {
                // Just run without waiting
                terminal.sendText(command);

                webviewView.webview.postMessage({
                  type: "cliCommandResult",
                  success: true,
                  command: command,
                  commandIndex: commandIndex,
                });
              }
            } catch (e) {
              webviewView.webview.postMessage({
                type: "cliCommandResult",
                success: false,
                error: e instanceof Error ? e.message : String(e),
                commandIndex: commandIndex,
              });
            }
            return;
          }

          // Handle clear history
          if (msg.type === "clearHistory") {
            conversationHistory = [];
            LucidLogger.debug("Conversation history cleared");
            return;
          }

          if (msg.type === "error") {
            const text =
              typeof msg.text === "string" ? msg.text : "Unknown webview error";
            LucidLogger.error("Webview reported error:", text);
            return;
          }
        } catch (msgErr) {
          LucidLogger.error("Error handling webview message", msgErr);
          try {
            webviewView.webview.postMessage({
              type: "error",
              text: String(msgErr),
            });
          } catch (_) {}
        }
      });

      webviewView.onDidDispose(() => {
        LucidLogger.debug("webviewView disposed");
      });

      // Send an initial ready message so the view shows activity immediately
      try {
        webviewView.webview.postMessage({
          type: "append",
          text: "Lucid Chat ready. Write a prompt and click Send.\n",
          role: "system",
        });
      } catch (e) {
        LucidLogger.error("Failed to post initial ready message to webview", e);
      }
    } catch (e) {
      LucidLogger.error("resolveWebviewView top-level error", e);
      try {
        webviewView.webview.html = `<body><pre>Internal error: ${String(
          e
        )}</pre></body>`;
      } catch (_) {}
    }
  }

  // Build a VS Code-themed, CSP-hardened webview with a streaming-friendly UI.
  private _getHtmlForWebview(webview: vscode.Webview) {
    try {
      const nonce = getNonce();
      const csp = [
        "default-src 'none';",
        `img-src ${webview.cspSource} https: data:;`,
        `font-src ${webview.cspSource};`,
        `style-src 'nonce-${nonce}';`,
        `script-src 'nonce-${nonce}';`,
      ].join(" ");

      // Load external HTML template (shared between VS Code and Visual Studio)
      const templatePath = path.join(
        this._extensionUri.fsPath,
        "..",
        "common",
        "html",
        "ui.html"
      );
      const raw = fs.readFileSync(templatePath, "utf8");
      const filled = raw
        .replace(/__NONCE__/g, nonce)
        .replace(
          /__CSP_META__/g,
          `<meta http-equiv="Content-Security-Policy" content="${csp}">`
        );
      return filled;
    } catch (e) {
      LucidLogger.error("_getHtmlForWebview error", e);
      return `<body><pre>Failed to render UI: ${String(e)}</pre></body>`;
    }
  }
}

export function activate(context: vscode.ExtensionContext) {
  extensionContext = context;

  // Register the sidebar provider (log registration errors to help debugging)
  let sidebarProvider: LucidSidebarProvider | undefined;
  try {
    sidebarProvider = new LucidSidebarProvider(context.extensionUri);
    context.subscriptions.push(
      vscode.window.registerWebviewViewProvider(
        "lucid.chatView",
        sidebarProvider
      )
    );
    LucidLogger.debug("Registered WebviewViewProvider for lucid.chatView");
    // Post current active editor filename to the webview when available and on changes
    const postEditorName = (editor?: vscode.TextEditor) => {
      try {
        const ed = editor || vscode.window.activeTextEditor;
        if (!ed) return;
        const view = (sidebarProvider as any)?._view;
        if (!view) return;
        const doc = ed.document;
        const fileName =
          doc.fileName && doc.fileName.length
            ? path.basename(doc.fileName)
            : doc.uri && doc.uri.path
            ? path.basename(doc.uri.path)
            : doc.uri.toString();
        view.webview.postMessage({ type: "editor", text: fileName });
      } catch (e) {
        LucidLogger.debug("postEditorName error", e);
      }
    };

    // Post selection changes to webview
    const postSelectionChange = (
      event: vscode.TextEditorSelectionChangeEvent
    ) => {
      try {
        const view = (sidebarProvider as any)?._view;
        if (!view) return;

        const editor = event.textEditor;
        const selection = editor.selection;

        if (selection.isEmpty) {
          // No selection - clear selection display
          view.webview.postMessage({
            type: "selectionChanged",
            hasSelection: false,
            selectedText: "",
            fileName: "",
            language: "",
            startLine: 0,
            endLine: 0,
          });
        } else {
          // Has selection - send selected text
          const selectedText = editor.document.getText(selection);
          const fileName = path.basename(editor.document.fileName);
          const language = editor.document.languageId;

          view.webview.postMessage({
            type: "selectionChanged",
            hasSelection: true,
            selectedText: selectedText,
            fileName: fileName,
            language: language,
            startLine: selection.start.line + 1,
            endLine: selection.end.line + 1,
          });
        }
      } catch (e) {
        LucidLogger.debug("postSelectionChange error", e);
      }
    };

    // initial post (if active editor exists)
    postEditorName();

    context.subscriptions.push(
      vscode.window.onDidChangeActiveTextEditor(postEditorName)
    );
    context.subscriptions.push(
      vscode.workspace.onDidOpenTextDocument(() => postEditorName())
    );
    context.subscriptions.push(
      vscode.workspace.onDidSaveTextDocument(() => postEditorName())
    );
    // Listen for selection changes
    context.subscriptions.push(
      vscode.window.onDidChangeTextEditorSelection(postSelectionChange)
    );
  } catch (e) {
    LucidLogger.error(
      "Failed to register WebviewViewProvider for lucid.chatView",
      e
    );
  }

  // Diagnostic helper: reveal the Lucid activity bar container and instruct user
  const openSidebarCommand = vscode.commands.registerCommand(
    "lucid.openChatView",
    async () => {
      try {
        // Reveal the activity bar container we declared as `lucid` in package.json
        await vscode.commands.executeCommand("workbench.view.extension.lucid");
        vscode.window.showInformationMessage(
          'Lucid: activity bar revealed. If the view is empty, open Webview DevTools (focus the view and run "Developer: Toggle Webview Developer Tools").'
        );
      } catch (err) {
        LucidLogger.error("Error executing openChatView command", err);
        vscode.window.showErrorMessage(
          "Lucid: failed to reveal sidebar: " + String(err)
        );
      }
    }
  );
  context.subscriptions.push(openSidebarCommand);

  const closeSidebarCommand = vscode.commands.registerCommand(
    "lucid.closeChatView",
    async () => {
      try {
        await vscode.commands.executeCommand("workbench.action.closeSidebar");
        vscode.window.showInformationMessage(
          'Lucid: sidebar hidden. Run "Lucid: Open Chat View" to show it again.'
        );
      } catch (err) {
        LucidLogger.error("Error executing closeChatView command", err);
        vscode.window.showErrorMessage(
          "Lucid: failed to close sidebar: " + String(err)
        );
      }
    }
  );
  context.subscriptions.push(closeSidebarCommand);

  // Diagnostic helper: dump internal provider/view state to the Extension Host console
  const dumpStateCommand = vscode.commands.registerCommand(
    "lucid.dumpState",
    async () => {
      try {
        // Try to find the registered provider by scanning subscriptions (best-effort)
        const subs: any = (context as any).subscriptions || [];
        let providerFound = false;
        for (const s of subs) {
          try {
            if (
              s &&
              s._provider &&
              s._provider.constructor &&
              s._provider.constructor.name === "LucidSidebarProvider"
            ) {
              providerFound = true;
              LucidLogger.debug("Found provider (via _provider)", s._provider);
              LucidLogger.debug("_view snapshot", (s._provider as any)._view);
              break;
            }
          } catch (_) {}
        }
        if (sidebarProvider) {
          LucidLogger.debug("sidebarProvider var", sidebarProvider);
          LucidLogger.debug(
            "sidebarProvider._view snapshot",
            (sidebarProvider as any)._view
          );
          providerFound = true;
        }

        if (!providerFound)
          LucidLogger.debug(
            "Provider instance not found in subscriptions or local scope (non-fatal)"
          );
        vscode.window.showInformationMessage(
          "Lucid: provider state dumped to Extension Host console. Check the Debug Console / DevTools."
        );
      } catch (e) {
        LucidLogger.error("dumpState error", e);
        vscode.window.showErrorMessage("Lucid: dumpState failed: " + String(e));
      }
    }
  );
  context.subscriptions.push(dumpStateCommand);

  // Existing single-file picker command
  const sendFileCommand = vscode.commands.registerCommand(
    "lucid.sendFile",
    async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: false,
        openLabel: "Send to Ollama",
      });
      if (!uris || uris.length === 0) return;
      const uri = uris[0];

      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Sending file to Ollama",
            cancellable: false,
          },
          async () => {
            return await sendFileUri(uri);
          }
        );
        if (!result) return;
        if (!result.ok)
          vscode.window.showErrorMessage(
            `Failed to send file: ${result.status} ${result.text}`
          );
        else
          vscode.window.showInformationMessage(
            `File sent to Ollama. Response: ${result.text.slice(0, 200)}`
          );
      } catch (e) {
        vscode.window.showErrorMessage(
          `Error sending file: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  );

  // Send active editor file
  const sendActiveFileCommand = vscode.commands.registerCommand(
    "lucid.sendActiveFile",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("No active editor to send.");
        return;
      }
      const uri = editor.document.uri;
      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Sending active file to Ollama",
            cancellable: false,
          },
          async () => {
            return await sendFileUri(uri);
          }
        );
        if (!result) return;
        if (!result.ok)
          vscode.window.showErrorMessage(
            `Failed to send file: ${result.status} ${result.text}`
          );
        else
          vscode.window.showInformationMessage(
            `File sent to Ollama. Response: ${result.text.slice(0, 200)}`
          );
      } catch (e) {
        vscode.window.showErrorMessage(
          `Error sending file: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  );

  // Send multiple files (picker with multi-select)
  const sendFilesCommand = vscode.commands.registerCommand(
    "lucid.sendFiles",
    async () => {
      const uris = await vscode.window.showOpenDialog({
        canSelectMany: true,
        openLabel: "Send to Ollama",
      });
      if (!uris || uris.length === 0) return;
      try {
        await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: `Sending ${uris.length} files to Ollama`,
            cancellable: false,
          },
          async (progress) => {
            for (let i = 0; i < uris.length; i++) {
              const u = uris[i];
              progress.report({
                message: `Sending ${u.path.split("/").pop()}`,
                increment: Math.round(100 / uris.length),
              });
              const res = await sendFileUri(u);
              if (!res || !res.ok) {
                vscode.window.showErrorMessage(
                  `Failed to send ${u.path.split("/").pop()}: ${
                    res ? `${res.status} ${res.text}` : "unknown error"
                  }`
                );
              }
            }
          }
        );
        vscode.window.showInformationMessage(
          "Done sending selected files to Ollama."
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `Error sending files: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  );
  context.subscriptions.push(
    sendFileCommand,
    sendActiveFileCommand,
    sendFilesCommand
  );

  // Send active editor contents (selection or whole file) to Ollama and apply response
  const sendActiveForEditCommand = vscode.commands.registerCommand(
    "lucid.sendActiveForEdit",
    async () => {
      const editor = vscode.window.activeTextEditor;
      if (!editor) {
        vscode.window.showInformationMessage("No active editor to send.");
        return;
      }

      const doc = editor.document;
      const selection = editor.selection;
      const textToSend =
        selection && !selection.isEmpty
          ? doc.getText(selection)
          : doc.getText();

      try {
        const result = await vscode.window.withProgress(
          {
            location: vscode.ProgressLocation.Notification,
            title: "Sending code to Ollama",
            cancellable: false,
          },
          async () => {
            // Reuse local headers builder
            const endpoint = LucidConfig.getEndpoint();
            const model = LucidConfig.getModelName();
            const headers = await buildHeadersFromConfig();

            const resp = await fetch(`${endpoint}`, {
              method: "POST",
              headers,
              body: JSON.stringify({
                model: model,
                messages: [{ role: "user", content: textToSend }],
                stream: false,
              }),
            });

            const txt = await resp.text().catch(() => resp.statusText || "");
            if (!resp.ok)
              throw new Error(`Ollama error ${resp.status}: ${txt}`);

            // Try to parse known shapes
            try {
              const parsed = JSON.parse(txt);
              // common shapes: { response } or { message: { content } } or { choices: [{ message: { content } }] }
              if (parsed.response && typeof parsed.response === "string")
                return parsed.response;
              if (parsed.message && parsed.message.content)
                return parsed.message.content;
              if (Array.isArray(parsed.choices)) {
                let out = "";
                for (const c of parsed.choices) {
                  out += c?.message?.content || c?.text || "";
                }
                if (out) return out;
              }
              // Fallback to raw text
              return typeof parsed === "string"
                ? parsed
                : JSON.stringify(parsed, null, 2);
            } catch (e) {
              return txt;
            }
          }
        );

        if (!result) return;

        // Apply response back into editor
        await editor.edit((editBuilder) => {
          if (selection && !selection.isEmpty) {
            editBuilder.replace(selection, result);
          } else {
            // No selection: open a new untitled document with the response
          }
        });

        if ((!selection || selection.isEmpty) && result) {
          const newDoc = await vscode.workspace.openTextDocument({
            content: result,
            language: doc.languageId,
          });
          await vscode.window.showTextDocument(newDoc, { preview: false });
        }

        vscode.window.showInformationMessage(
          "Ollama response applied to editor."
        );
      } catch (e) {
        vscode.window.showErrorMessage(
          `Error sending code: ${e instanceof Error ? e.message : String(e)}`
        );
      }
    }
  );
  context.subscriptions.push(sendActiveForEditCommand);
}

export function deactivate() {}
