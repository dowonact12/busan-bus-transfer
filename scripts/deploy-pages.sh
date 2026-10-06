#!/usr/bin/env bash
# 화면을 GitHub Pages(gh-pages 브랜치)에 배포. 비밀키는 절대 포함되지 않는다(프런트는 키를 모름).
set -euo pipefail
cd "$(dirname "$0")/.."
REPO="${PAGES_REPO:-dowonact12/busan-bus-transfer}"
NAME="${REPO#*/}"
API_BASE="$(cat .run/tunnel.url 2>/dev/null || echo '')"
rm -rf dist && PAGES_BASE="/$NAME/" npx vite build >/dev/null
printf '{ "apiBase": "%s" }\n' "$API_BASE" > dist/config.json
touch dist/.nojekyll
cp dist/index.html dist/404.html
# 배포물 비밀 검사
if [ -f .env.local ]; then K=$(sed -n 's/^BUSAN_BIMS_SERVICE_KEY=//p' .env.local); [ -n "$K" ] && grep -rqF "$K" dist && { echo "키 발견! 중단"; exit 1; }; fi
grep -rqi 'serviceKey=' dist && { echo "serviceKey= 발견! 중단"; exit 1; }
TMP=$(mktemp -d)
git clone -q --depth 1 --branch gh-pages "https://github.com/$REPO.git" "$TMP" 2>/dev/null || { git init -q "$TMP"; git -C "$TMP" checkout -q -b gh-pages; git -C "$TMP" remote add origin "https://github.com/$REPO.git"; }
find "$TMP" -mindepth 1 -maxdepth 1 ! -name .git -exec rm -rf {} +
cp -r dist/. "$TMP/"
git -C "$TMP" add -A
git -C "$TMP" -c user.name="$(git config user.name || echo deploy)" -c user.email="$(git config user.email || echo deploy@users.noreply.github.com)" commit -q -m "deploy $(date -Iseconds)" || echo "변경 없음"
git -C "$TMP" push -q origin gh-pages
rm -rf "$TMP"
echo "deployed: https://${REPO%%/*}.github.io/$NAME/"
