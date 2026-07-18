/**
 * The LLM backend port (Reckon core).
 *
 * This is the ONE seam between the client-agnostic comprehension-loop brain and whatever
 * concrete model runtime a host uses. Core (grader, decompose) makes model calls ONLY
 * through this interface — it never spawns a process, never names a provider, never
 * touches `claude` or an API key. The MCP host injects a `ClaudeCliBackend` (Claude Code
 * subscription via `claude -p`); a future sister repo can inject an `OpenAiBackend`
 * against the exact same contract with no change to core.
 *
 * Contract: `complete` takes a system prompt and a user message and returns the model's
 * raw text response. It MAY throw on failure (timeout, unavailable backend, nonzero exit);
 * callers in core are responsible for the fail-open / retry semantics around it.
 */
export interface LlmBackend {
  complete(
    system: string,
    user: string,
    opts?: { model?: string; timeoutMs?: number }
  ): Promise<string>;
}
