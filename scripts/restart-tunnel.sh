#!/usr/bin/env bash
# 서버 + Cloudflare 임시 터널을 재시작하고, GitHub Pages 의 config.json(apiBase)을 새 터널 주소로 갱신한다.
# 사용: scripts/restart-tunnel.sh            (재시작 + Pages config 갱신)
#       scripts/restart-tunnel.sh --no-publish (Pages 갱신 생략)
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${PAGES_REPO:-dowonact12/busan-bus-transfer}"
PORT="${PORT:-5179}"
CLOUDFLARED="${CLOUDFLARED:-$(command -v cloudflared || echo "$HOME/.local/bin/cloudflared")}"
mkdir -p .run

stop() { [ -f ".run/$1.pid" ] && kill "$(cat ".run/$1.pid")" 2>/dev/null || true; rm -f ".run/$1.pid"; }
stop tunnel; stop server
sleep 1

[ -d dist ] || npx vite build >/dev/null
PORT="$PORT" nohup node --import tsx server/index.ts > .run/server.log 2>&1 &
echo $! > .run/server.pid
for i in $(seq 1 30); do curl -sf "http://localhost:$PORT/api/health" >/dev/null && break; sleep 1; done
curl -sf "http://localhost:$PORT/api/health" >/dev/null || { echo "서버 시작 실패 (.run/server.log 확인)"; exit 1; }
echo "server: http://localhost:$PORT"

URL=""
# 계정 없는 임시 터널은 생성 요청이 429로 거절될 수 있어 대기 후 재시도
for wait in 0 30 60 120 180 300; do
  [ "$wait" -gt 0 ] && { echo "터널 생성 거절됨($(tail -1 .run/tunnel.log)) — ${wait}초 후 재시도"; sleep "$wait"; }
  nohup "$CLOUDFLARED" tunnel --no-autoupdate --url "http://localhost:$PORT" > .run/tunnel.log 2>&1 &
  echo $! > .run/tunnel.pid
  for i in $(seq 1 45); do
    URL=$(grep -oE 'https://[a-z0-9-]+\.trycloudflare\.com' .run/tunnel.log | head -1 || true)
    [ -n "$URL" ] && break 2
    grep -q 'failed' .run/tunnel.log && break
    sleep 1
  done
  stop tunnel
done
[ -n "$URL" ] || { echo "터널 주소를 못 받음 (.run/tunnel.log 확인)"; exit 1; }
echo "$URL" > .run/tunnel.url
echo "tunnel: $URL"

if [ "${1:-}" != "--no-publish" ]; then
  CONTENT=$(printf '{ "apiBase": "%s" }\n' "$URL" | base64 -w0)
  SHA=$(gh api "repos/$REPO/contents/config.json?ref=gh-pages" --jq .sha 2>/dev/null || true)
  gh api -X PUT "repos/$REPO/contents/config.json" -f message="config: tunnel $URL" -f content="$CONTENT" -f branch=gh-pages ${SHA:+-f sha="$SHA"} --jq .commit.sha >/dev/null
  echo "Pages config.json 갱신 완료 (반영까지 1~2분, CDN 캐시 최대 10분)"
fi
