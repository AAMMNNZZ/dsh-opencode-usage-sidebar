#!/usr/bin/env bash
# Install the newest packed tarball into the desktop profile.
# Writes outside the workspace, so it must run with elevated sandbox access.
set -uo pipefail

WS="/c/AAA/DSH/useage"
NODE="/c/Users/AMNZ/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/node/bin/node.exe"
PNPM="/c/Users/AMNZ/.dsh/dsh-runtimes/dsh-primary-runtime/dependencies/pnpm/bin/pnpm.mjs"
DEST_DIR="/c/Users/AMNZ/dsh-plugins"
PROFILE="/c/Users/AMNZ/.dsh/profiles/desktop"
INSTALLED="$PROFILE/node_modules/dsh-opencode-usage-sidebar"
BACKUP="$WS/.tmp/profile-backup"

TGZ=$(ls -t "$WS"/dsh-opencode-usage-sidebar-*.tgz 2>/dev/null | head -1)
[ -z "$TGZ" ] && { echo "no tarball found; run pnpm pack first"; exit 1; }
NAME=$(basename "$TGZ")
VERSION=$(grep -m1 '"version"' "$WS/package.json" | sed 's/.*"\([^"]*\)".*/\1/')
echo "installing $NAME (package.json version $VERSION)"

mkdir -p "$BACKUP"
cp "$PROFILE/package.json" "$PROFILE/pnpm-lock.yaml" "$BACKUP"/ || exit 1
echo "backup written to $BACKUP"

cp "$TGZ" "$DEST_DIR/" || exit 1
echo "tarball copied to $DEST_DIR"

cd "$PROFILE" || exit 1
"$NODE" "$PNPM" add "file:C:/Users/AMNZ/dsh-plugins/$NAME"
status=$?
echo "pnpm add exit: $status"

echo "=== dependency row ==="
grep "opencode" package.json
echo "=== post-install checks ==="
grep -m1 '"version"' "$INSTALLED/package.json"
grep -q "\"version\": \"$VERSION\"" "$INSTALLED/package.json" && echo "version matches $VERSION" || { echo "VERSION MISMATCH (expected $VERSION)"; status=1; }
cmp -s "$WS/client.js" "$INSTALLED/client.js" && echo "client.js matches workspace" || { echo "client.js MISMATCH"; status=1; }
cmp -s "$WS/index.js" "$INSTALLED/index.js" && echo "index.js matches workspace" || { echo "index.js MISMATCH"; status=1; }
exit $status
