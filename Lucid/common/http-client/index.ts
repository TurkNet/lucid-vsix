/**
 * Shared HTTP client for Lucid common code.
 * Implement the real Ollama-specific headers, streaming and error handling here.
 */

export async function postJson(endpoint: string, body: any, headers: Record<string,string> = {}) {
  const h = Object.assign({ 'Content-Type': 'application/json' }, headers || {});
  const resp = await fetch(endpoint, { method: 'POST', headers: h as any, body: JSON.stringify(body) });
  const text = await resp.text();
  try { return JSON.parse(text); } catch (_) { return text; }
}
