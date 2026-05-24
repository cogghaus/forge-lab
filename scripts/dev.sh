#!/usr/bin/env bash
# dev.sh — start forge-hub + forge-dash-community on random available ports
# Usage: bash scripts/dev.sh

set -euo pipefail

free_port() {
  python3 -c "import socket; s=socket.socket(); s.bind(('',0)); print(s.getsockname()[1]); s.close()" 2>/dev/null \
    || node -e "const n=require('net').createServer(); n.listen(0,()=>{console.log(n.address().port);n.close()})"
}

HUB_PORT=$(free_port)
DASH_PORT=$(free_port)
HUB_URL="http://localhost:$HUB_PORT"

echo ""
echo "forge-lab dev"
echo "  hub   -> http://localhost:$HUB_PORT"
echo "  dash  -> http://localhost:$DASH_PORT"
echo ""

echo "FORGE_HUB_URL=$HUB_URL" > packages/forge-dash-community/.env.local

cd packages/forge-hub
FORGE_HUB_PORT=$HUB_PORT pnpm dev &
HUB_PID=$!
cd ../..

cd packages/forge-dash-community
pnpm exec next dev --port "$DASH_PORT" --hostname 0.0.0.0 &
DASH_PID=$!
cd ../..

trap "kill $HUB_PID $DASH_PID 2>/dev/null" EXIT INT TERM
wait
