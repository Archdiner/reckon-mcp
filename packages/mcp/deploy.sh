#!/usr/bin/env bash
# Deploy Reckon v5 from this repo (the single source of truth) to ~/.reckon.
# Safe by construction: backs up the existing install before overwriting, and
# never touches the ledger DBs.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"     # packages/mcp
ROOT="$(cd "$SRC/../.." && pwd)"                          # repo root (npm workspaces)
DEST="${RECKON_HOME:-$HOME/.reckon}"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "→ Reckon v5 deploy"
echo "  source: $SRC"
echo "  root:   $ROOT"
echo "  dest:   $DEST"

# 1. Build fresh from the workspace root so @reckon/core builds before @reckon/mcp.
echo "→ building…"
( cd "$ROOT" && npm install --silent && npm run build --silent )

# 2. Back up the existing install (code only — DBs are preserved in place).
if [ -d "$DEST" ]; then
  BACKUP="$DEST.bak-$STAMP"
  echo "→ backing up existing install to $BACKUP"
  mkdir -p "$BACKUP"
  # copy everything EXCEPT the ledger DBs and node_modules
  rsync -a --exclude 'node_modules' --exclude '*.db' "$DEST"/ "$BACKUP"/ 2>/dev/null || cp -R "$DEST"/. "$BACKUP"/
fi

mkdir -p "$DEST"

# 3. Sync the built server + manifest + hooks. Ledger DBs (reckon-v5.db, and the
#    legacy reckon.db / decisions.db) are left untouched.
echo "→ syncing dist + package.json + hooks + vendored @reckon/core"
rm -rf "$DEST/dist"
cp -R "$SRC/dist" "$DEST/dist"
cp "$SRC/package.json" "$DEST/package.json"
mkdir -p "$DEST/hooks"
cp "$SRC/hooks/"*.js "$DEST/hooks/"
# The hooks are CommonJS (require/module.exports); $DEST/package.json is type:module,
# so ship the scoped {"type":"commonjs"} override next to them or they load as ESM and crash.
cp "$SRC/hooks/package.json" "$DEST/hooks/"
# Vendor the built @reckon/core into the install's node_modules so the flat install
# (no workspace root at $DEST) can resolve it. package.json pins @reckon/core@0.5.0;
# we drop the real built package in and let npm install fetch only the MCP SDK.
mkdir -p "$DEST/node_modules/@reckon/core"
rm -rf "$DEST/node_modules/@reckon/core/dist"
cp -R "$ROOT/packages/core/dist" "$DEST/node_modules/@reckon/core/dist"
cp "$ROOT/packages/core/package.json" "$DEST/node_modules/@reckon/core/package.json"
( cd "$DEST" && npm install --omit=dev --silent --no-package-lock )

# 4. Point the MCP manifest at the v5 entrypoint.
cat > "$DEST/.mcp.json" <<JSON
{
  "mcpServers": {
    "reckon": {
      "type": "stdio",
      "command": "node",
      "args": ["$DEST/dist/server.js"],
      "alwaysLoad": true
    }
  }
}
JSON

# 5. Migrate ~/.claude/settings.json hooks to the v5 wiring (backs up first,
#    preserves every non-hooks key, retires the stale hooks.json orphan).
echo "→ migrating ~/.claude/settings.json hooks"
RECKON_HOME="$DEST" node "$SRC/migrate-settings.mjs"

echo "✓ deployed Reckon v5 to $DEST"
echo
echo "NEXT:"
echo "  • Grader uses your Claude Code SUBSCRIPTION via 'claude -p' — no API key needed."
echo "    (Optional: RECKON_GRADER_MODEL to pin the grader model, default claude-haiku-4-5.)"
echo "  • Restart Claude Code so it reloads the reckon MCP server + migrated hooks."
echo "  • Old install backed up at: ${BACKUP:-<none>}"
