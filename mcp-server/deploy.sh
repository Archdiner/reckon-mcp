#!/usr/bin/env bash
# Deploy Reckon v5 from this repo (the single source of truth) to ~/.reckon.
# Safe by construction: backs up the existing install before overwriting, and
# never touches the ledger DBs.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
DEST="${RECKON_HOME:-$HOME/.reckon}"
STAMP="$(date +%Y%m%d-%H%M%S)"

echo "→ Reckon v5 deploy"
echo "  source: $SRC"
echo "  dest:   $DEST"

# 1. Build fresh.
echo "→ building…"
( cd "$SRC" && npm install --silent && npm run build --silent )

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
echo "→ syncing dist + package.json + hooks"
rm -rf "$DEST/dist"
cp -R "$SRC/dist" "$DEST/dist"
cp "$SRC/package.json" "$DEST/package.json"
mkdir -p "$DEST/hooks"
cp "$SRC/../hooks/"*.js "$DEST/hooks/"
( cd "$DEST" && npm install --omit=dev --silent )

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
