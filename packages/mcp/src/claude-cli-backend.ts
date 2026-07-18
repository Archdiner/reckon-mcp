/**
 * ClaudeCliBackend — the Claude Code implementation of @reckon/core's `LlmBackend` port.
 *
 * This is the ONLY Claude-Code-specific coupling in the whole system, and it lives here
 * in the MCP host, out of core. It runs the isolated grader / decomposer as a `claude -p`
 * subprocess on the user's existing Claude Code SUBSCRIPTION auth — no API key, ever.
 * Reckon ships to Claude Code users; requiring a separate ANTHROPIC_API_KEY would be a
 * non-starter. The sister repo swaps this for an OpenAiBackend against the same interface.
 *
 * All Claude-specific configuration lives here (moved verbatim out of core):
 *   - RECKON_GRADER_MODEL  — pin the grader model (default claude-haiku-4-5; a different,
 *                            cheaper model than the main coding agent, on purpose).
 *   - RECKON_GRADER_CMD    — override the CLI binary (the mock hook the unit tests use).
 *   - RECKON_GRADER_TIMEOUT_MS — per-call timeout (default 90s).
 *
 * Reads at CALL time, not module-load time (ESM hoists imports before a test's env setup).
 */
import { spawn } from 'child_process';
import type { LlmBackend } from '@reckon/core';

const graderModel = () => process.env.RECKON_GRADER_MODEL || 'claude-haiku-4-5';
const cliCmd = () => process.env.RECKON_GRADER_CMD || 'claude'; // overridable for tests
const cliTimeoutMs = () => Number(process.env.RECKON_GRADER_TIMEOUT_MS || 90_000);

export class ClaudeCliBackend implements LlmBackend {
  /** Run one isolated `claude -p` completion. Rejects on timeout / spawn error / nonzero
   *  exit; core (grader/decompose) owns the fail-open + retry semantics around this. */
  complete(system: string, user: string, opts?: { model?: string; timeoutMs?: number }): Promise<string> {
    const cmd = cliCmd();
    const model = opts?.model || graderModel();
    const timeoutMs = opts?.timeoutMs ?? cliTimeoutMs();
    return new Promise((resolve, reject) => {
      // Strip the environment: the grader must not load the user's MCP servers, plugins,
      // or project settings. It only judges text. Stripping cuts ~7s of startup per call
      // AND keeps the grader truly isolated (it cannot see the user's tools).
      const child = spawn(
        cmd,
        ['-p', '--model', model, '--strict-mcp-config', '--mcp-config', '{"mcpServers":{}}', '--setting-sources', '', '--append-system-prompt', system],
        { stdio: ['pipe', 'pipe', 'pipe'] }
      );
      let out = '';
      let err = '';
      const timer = setTimeout(() => {
        child.kill('SIGKILL');
        reject(new Error(`${cmd} -p timed out after ${timeoutMs}ms`));
      }, timeoutMs);

      child.stdout.on('data', (d) => (out += d.toString()));
      child.stderr.on('data', (d) => (err += d.toString()));
      child.on('error', (e) => {
        clearTimeout(timer);
        reject(e); // e.g. ENOENT if the claude CLI isn't on PATH
      });
      child.on('close', (code) => {
        clearTimeout(timer);
        if (code === 0) resolve(out);
        else reject(new Error(`${cmd} -p exited ${code}: ${err.slice(0, 200)}`));
      });

      child.stdin.write(user);
      child.stdin.end();
    });
  }
}
