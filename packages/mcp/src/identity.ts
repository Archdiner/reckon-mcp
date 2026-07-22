import { execFileSync } from 'child_process';

/**
 * The user's identity, resolved so LOCAL MCP comprehension events can join the reckon-pr
 * PR-gate records into ONE cross-surface profile. The join key is the GitHub NUMERIC id —
 * reckon-pr already stores it as `reviewer_id` / `passed_by_id`, so stamping it here is what
 * lets "this is the same person" work without any linking token. Email is a softer fallback.
 *
 * Every field is nullable: identity is best-effort (a user may not have `gh` authed). A null
 * identity still forwards — as an anonymous event — it just can't be attributed to a person.
 */
export interface Identity {
  github_id: number | null;
  github_login: string | null;
  email: string | null;
}

let cachedIdentity: Identity | null = null;
let cachedRepo: string | null | undefined; // undefined = not yet resolved; null = resolved-but-none

function tryCmd(cmd: string, args: string[], cwd?: string): string | null {
  try {
    return execFileSync(cmd, args, {
      encoding: 'utf8',
      timeout: 5000,
      stdio: ['ignore', 'pipe', 'ignore'],
      cwd,
    }).trim();
  } catch {
    return null;
  }
}

/**
 * Resolve GitHub identity once (cached for the process). `gh` gives the id + login (the real
 * join key); `git config` supplies the email fallback when the GitHub email is private/null.
 */
export function resolveIdentity(): Identity {
  if (cachedIdentity) return cachedIdentity;

  let github_id: number | null = null;
  let github_login: string | null = null;
  let email: string | null = null;

  const ghJson = tryCmd('gh', ['api', 'user', '--jq', '{login: .login, id: .id, email: .email}']);
  if (ghJson) {
    try {
      const u = JSON.parse(ghJson);
      github_id = typeof u.id === 'number' ? u.id : null;
      github_login = typeof u.login === 'string' ? u.login : null;
      email = typeof u.email === 'string' && u.email ? u.email : null;
    } catch {
      /* leave nulls */
    }
  }
  if (!email) email = tryCmd('git', ['config', 'user.email']) || null;

  cachedIdentity = { github_id, github_login, email };
  return cachedIdentity;
}

/**
 * Best-effort repo slug (`owner/name`) from the current git remote — the SAME shape reckon-pr
 * stores as `repos.full_name`, giving a second join dimension (which repo a dev-time event
 * belongs to). Null when there's no git remote. Cached for the process.
 */
export function resolveRepo(cwd?: string): string | null {
  if (cachedRepo !== undefined) return cachedRepo;
  const url = tryCmd('git', ['config', '--get', 'remote.origin.url'], cwd || process.cwd());
  cachedRepo = url ? parseRepoSlug(url) : null;
  return cachedRepo;
}

function parseRepoSlug(remoteUrl: string): string | null {
  // git@github.com:owner/name.git  |  https://github.com/owner/name(.git)
  const m = remoteUrl.match(/[:/]([^/:]+\/[^/]+?)(?:\.git)?\s*$/);
  return m ? m[1] : null;
}
