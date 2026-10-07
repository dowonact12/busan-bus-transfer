#!/usr/bin/env bash
# 화면을 GitHub Pages(gh-pages 브랜치)에 배포. 비밀키는 절대 포함되지 않는다(프런트는 키를 모름).
# apiBase(서버 주소)는 지금 배포된 config.json 값을 그대로 유지한다(기본: Vercel, 예비: Render).
#   다른 주소로 바꾸려면: API_BASE=https://... scripts/deploy-pages.sh
#   빈 값·임시 터널 주소(trycloudflare)는 거부한다.
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${PAGES_REPO:-dowonact12/busan-bus-transfer}"
NAME="${REPO#*/}"
DEFAULT_API_BASE="https://busan-bus-transfer.vercel.app"
TMP=$(mktemp -d)
trap 'rm -rf "$TMP"' EXIT
git clone -q --depth 1 --branch gh-pages "https://github.com/$REPO.git" "$TMP" 2>/dev/null || { git init -q "$TMP"; git -C "$TMP" checkout -q -b gh-pages; git -C "$TMP" remote add origin "https://github.com/$REPO.git"; }
CURRENT="$(node -e 'try{process.stdout.write(JSON.parse(require("fs").readFileSync(process.argv[1],"utf8")).apiBase||"")}catch{}' "$TMP/config.json")"
API_BASE="${API_BASE:-${CURRENT:-$DEFAULT_API_BASE}}"
case "$API_BASE" in
  https://*) ;;
  *) echo "apiBase '$API_BASE' 는 https 주소가 아니라 중단"; exit 1 ;;
esac
if [[ "$API_BASE" == *trycloudflare.com* ]]; then echo "임시 터널 주소는 쓰지 않아요 — 중단"; exit 1; fi
echo "apiBase: $API_BASE (현재 배포값: ${CURRENT:-없음})"
rm -rf dist && PAGES_BASE="/$NAME/" npx vite build >/dev/null
printf '{ "apiBase": "%s" }\n' "$API_BASE" > dist/config.json
touch dist/.nojekyll
cp dist/index.html dist/404.html
# 배포물 비밀 검사
if [ -f .env.local ]; then K=$(sed -n 's/^BUSAN_BIMS_SERVICE_KEY=//p' .env.local); if [ -n "$K" ] && grep -rqF "$K" dist; then echo "키 발견! 중단"; exit 1; fi; fi
if grep -rqi 'serviceKey=' dist; then echo "serviceKey= 발견! 중단"; exit 1; fi
find "$TMP" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r dist/. "$TMP/"
git -C "$TMP" add -A
git -C "$TMP" -c user.name="$(git config user.name || echo deploy)" -c user.email="$(git config user.email || echo deploy@users.noreply.github.com)" commit -q -m "deploy $(date -Iseconds)" || echo "변경 없음"
git -C "$TMP" push -q origin gh-pages
echo "deployed: https://${REPO%%/*}.github.io/$NAME/ (apiBase $API_BASE)"
