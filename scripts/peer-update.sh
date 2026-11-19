#!/usr/bin/env bash
# Keeps an always-on peer's clone (scripts/peer.mjs) up to date: fast-forwards to origin/main and, if
# anything changed, reinstalls (when the lockfile changed), rebuilds and restarts the peer service.
# Run from a timer, e.g. the latent-canvas-peer-update systemd user timer.
set -euo pipefail
cd "$(dirname "$0")/.."
SERVICE=${PEER_SERVICE:-latent-canvas-peer.service}

git fetch --quiet origin main
old=$(git rev-parse HEAD)
new=$(git rev-parse origin/main)
[ "$old" = "$new" ] && exit 0

git merge --ff-only --quiet origin/main
echo "updating $old -> $new"
if ! git diff --quiet "$old" "$new" -- package.json package-lock.json; then
  npm ci --ignore-scripts
fi
npx vite build
systemctl --user restart "$SERVICE"
echo "updated to $(git log -1 --format='%h %s')"
