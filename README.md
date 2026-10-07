# 반여 가는 버스 🚌 (부산 버스 환승 타이밍 추천)

출발 **부산 연제구 중앙대로 1067 (3층)** → 도착 **해운대구 반여로 67**. 직통·1회 환승 버스 조합을 부산 BIMS 실시간 도착정보로 비교해 “언제 나가서 어디서 몇 번을 타면 되는지”를 보여주는 모바일 웹앱.

- 화면: React(Vite) · 서버: Node(의존성 거의 없음) · 계산: `shared/evaluator.ts`, `shared/recommender.ts` (순수 함수, vitest)
- 실시간: 부산광역시_부산버스정보시스템 공공 API (무료). 키는 **서버 환경변수 `BUSAN_BIMS_SERVICE_KEY`** 에만 둔다. 브라우저·저장소·Pages에는 절대 들어가지 않는다.
- 키가 없거나 미등록이면 **예시 모드**(화면에 명시)로 동작. 예시 모드는 실시간이 아니다.

## 실행
```bash
npm install
cp .env.example .env.local   # BUSAN_BIMS_SERVICE_KEY=발급키  (chmod 600)
npm test                     # T01~T17 + 녹화 응답 테스트
npx vite build && npm start  # http://localhost:5179
scripts/restart-tunnel.sh    # 서버+Cloudflare 임시 터널 재시작 + Pages config.json 갱신
scripts/deploy-pages.sh      # 화면을 GitHub Pages에 배포
```
후보 경로 재생성: 공식 자료를 `data/raw/`에 받은 뒤 `node scripts/build-candidates.mjs`.

## Render 무료 배포 (API + 화면 한 번에)
`render.yaml` 블루프린트 포함 — 싱가포르 리전, 무료 플랜.
- Build: `npm ci --include=dev && npm run build`
- Start: `npm start` (= `node --import tsx server/index.ts`, `0.0.0.0:$PORT`)
- Health check: `/api/health`
- 환경변수: `BUSAN_BIMS_SERVICE_KEY` (Render 대시보드에서 입력, `sync: false`), `NODE_VERSION=20.19.2`, `ALLOWED_ORIGINS=https://dowonact12.github.io`
- Render 주소만으로도 화면이 열린다. GitHub Pages 화면은 `config.json`의 `apiBase`를 Render 주소로 바꾸면 그 API를 쓴다.
- 무료 인스턴스는 15분쯤 안 쓰면 잠들고 깨는 데 30~60초 걸린다 → 화면은 ‘버스 서버 깨우는 중…’을 보여주며 5초마다 최대 2분 재시도.
- BIMS 호출은 HTTPS 우선, 연결/TLS 실패 시에만 HTTP 폴백(30분마다 HTTPS 재시도). `/api/health`의 `bimsTransport`로 확인.

## 부산 버스 실시간 키 받는 법 (무료)
1. [공공데이터포털](https://www.data.go.kr) 로그인(없으면 회원가입).
2. [부산광역시_부산버스정보시스템](https://www.data.go.kr/data/15092750/openapi.do) 페이지에서 **활용신청** → 활용 목적 간단히 입력 → 신청 (개발계정 자동승인, 무료, 하루 10,000회).
3. **마이페이지 → 데이터활용 → Open API → 활용신청 현황**에서 이 API를 눌러 **일반 인증키(Decoding)** 를 복사.
4. 서버의 `.env.local`에 `BUSAN_BIMS_SERVICE_KEY=복사한키` 저장 후 서버 재시작. (발급 직후 최대 1시간 정도 ‘등록되지 않은 키’로 나올 수 있음)

## 가는 길 / 오는 길 · 버스 위치 도식 · 지도
- **평소 경로**: 카톡으로 확인한 길(갈 때 43→29 안락 환승, 돌아올 때 29→43 동래시장 환승)을 ⭐ 표시. 비슷하게 도착하면 우선, 연결 안 되면 1순위로 안 올림.
- 맨 위 토글로 **가는 길**(중앙대로 1067 → 반여로 67)과 **오는 길**(반여로 67 → 중앙대로 1067)을 고르고, 기기에 기억해요. 문→정류장 시간·진행 상태도 방향마다 따로 저장해요.
- 오는 길 후보: `node scripts/build-candidates.mjs reverse` (공식 노선별 정류소 자료). 실시간 대조: `node --import tsx scripts/verify-live.ts` (두 방향 후보의 모든 정류장 매핑).
- 경로를 펼치면 맨 위에 **출발 — 환승 — 도착** 3점 도식. `busInfoByRouteId` 차량 위치(정류소 순번)로 ‘출발 정류장 n정류장 전 / 출발~환승 사이 / 환승~도착 사이 / 지남’에 버스(노선 · 번호판 끝 4자리 · GPS n분 전)를 놓고, GPS가 5분 넘게 멈춘 버스는 흐리게.
- 그 아래 간단한 지도(Leaflet + OpenStreetMap 기본 타일을 옅게 보정, 출처 표기). CARTO Positron은 이제 API 키(가입)가 필요해서 쓰지 않아요. 정류장 연결선, 출발/환승/도착 핀, 건물(대략) 표시, 실시간 버스만.
- 서버 API: `/api/candidates?trip=forward|reverse`, `/api/snapshot?trip=…` (그 방향 정류장만 조회), `/api/routes`(두 방향 노선), `/api/vehicles?routes=…`. `trip`이 없으면 가는 길 — 옛 화면과 호환.
- 화면은 옛 서버(방향 미지원)에서도 동작: 가는 길은 그대로, 오는 길은 ‘실시간 준비 중’으로 표시하고 다른 방향 실시간 값을 섞지 않아요.
- Pages 배포: `scripts/deploy-pages.sh` 는 지금 배포된 `config.json` 의 apiBase(기본 Render 주소)를 그대로 유지. 바꿀 때만 `API_BASE=https://… scripts/deploy-pages.sh`.

## 데이터 정직성
- 첫 버스·환승 버스 도착은 BIMS 실시간 예측(분 단위). 버스 주행시간은 정류장 간 거리 ÷ 평균 15km/h **추정**(같은 차량의 하류 정류장 예측이 맞물리면 실시간 예측 사용). 보행은 직선거리×1.3÷1.2m/s **추정**.
- 출발·도착 좌표는 도로명 번호로 잡은 **대략 위치**이며 건물 출입구는 미확인.
- 혼잡: 잔여좌석은 BIMS 값이 유효할 때만(현재 응답은 −1=확인 불가). 주변 인파·도로 정체는 검증된 무료 제공원이 없어 ‘확인 불가’.
- 자료: 부산시 공식 노선별 정류소 다운로드(2026-10-06 기준, CP949), `data/samples/`는 키를 제거한 실제 응답 샘플.

## 현장 보정 (실사용자 측정)

- 문 → 평소 첫 정류장 **5~7분(가운데 6분), 직접 측정(사용자)** — 건물 나가기(3층)·신호 대기 포함.
  - 돌아올 때(forward): 회사 3층 → 연산역.연제초교 **13706**
  - 갈 때(reverse): 집 → 한화꿈에그린아파트 **09198**
- 별도 '건물 나가기' 기본값은 **0분** (실측에 포함 → 이중 계산 없음). 계산은 6분, 출발 마감은 7분 + 승차 여유 1분 기준.
- 실측 안 된 다른 정류장: 직선 추정 보행 + 문~큰길 시간(실측 6분 − 같은 정류장 추정 보행: forward 234초, reverse 111초).
- 기기에 저장된 예전 설정 `{exitMin, walkMult}`은 v2 `{v:2, doorLowMin, doorHighMin, walkMult}`로 자동 이관(exitMin 버림, 걷기 속도 유지). 걷기 속도는 실측 구간엔 적용하지 않음.
- 평소 경로 카드에 '🚏 n번이 k정거장 전일 때 나가면 돼요' — 실시간 남은 정거장·분을 같은 속도로 선형 어림. 정보 없으면 본인 규칙 '보통 8정거장 전에 출발'(갈 때 43번)을 라벨 붙여 표시.

## 호스팅 (2026-10-07~)

- **주 서버: Vercel** — https://busan-bus-transfer.vercel.app (Hobby, 함수 지역 서울 `icn1`, 잠들지 않음). GitHub `main`에 push하면 자동 배포.
  - `npm run vercel-build` → `scripts/build-vercel.mjs`: 화면(vite) → `.vercel/output/static`(apiBase `''` 같은 오리진), `/api/*` → 단일 함수 `api.func`(esbuild 번들, `server/vercel.ts` → `server/app.ts`).
  - 환경변수: `BUSAN_BIMS_SERVICE_KEY`(sensitive, production+preview), `BUSAN_BIMS_ALLOW_HTTP_FALLBACK=0`(HTTPS만). 30초 캐시·일일 한도는 인스턴스별 메모리(최선 노력).
  - Vercel Authentication은 미리보기 배포에만(프로덕션 주소는 공개).
- **GitHub Pages**: https://dowonact12.github.io/busan-bus-transfer/ — `config.json` apiBase = Vercel. `API_BASE=... scripts/deploy-pages.sh`로만 바꿈.
- **예비: Render** — https://busan-bus-transfer.onrender.com (무료, 잠듦, 자동 배포 꺼짐). 그대로 둠. 같은 `server/app.ts`를 `server/index.ts`가 씀.

## 도우미 4가지 (모두 관측값 기반 · 라벨 표시)

1. **💺 자리 힌트** — 널널할 듯 / 보통 / 붐빌 듯 (**추정**). 근거: 기점(순환 노선은 `rpoint` 회차지점)에서 몇 정거장째 + 앞차와 간격(같은 정류장 예측 차이, 첫 차는 노선 차량 위치로 어림) + 평일 출퇴근 시간. 부산 BIMS `seat1/seat2`가 유효(−1 아님)하면 그 값을 우선하고 **실시간** 표시. 지금 29·43 포함 이 경로 노선들은 모두 −1(미제공). 자세한 근거는 👥 혼잡 시트.
2. **😢 플랜 B** — 추천/평소 경로가 노리던 차를 놓치면(출발 시각 지남 또는 도착 목록에서 사라짐) 같은 노선의 다음 **관측된** 차와 새 도착, 3분 안쪽이거나 더 빠른 다른 경로를 바로 보여 줌. 다음 차가 데이터에 없으면 ‘다음 차 정보 아직 없음’.
3. **🚌🚌 배차 몰림** — 같은 노선 두 대가 2정거장·3분 안으로 붙어 오면 ‘두 대가 붙어 와요, 뒤차가 더 한산할 수 있어요 (추정)’ + 뒤차를 타면 환승/도착이 어떻게 되는지(앞차를 빼고 다시 계산).
4. **🧾 내 기록** — ‘출발했어요 → 정류장 도착 → 🚌 이 버스 탔어요 → 도착했어요’ 시각을 **이 폰 localStorage에만** 저장(`bbt.history`, 서버 전송 없음). 같은 방향·평일/주말·시간대 기록이 3회 이상이면 중앙값을 섞음(가중치 n/(n+3), 최대 85%): 문→정류장 시간은 계산에 반영, 탄 뒤 도착까지는 카드에 ‘내 기록 기반 (n회)’로 표시. 설정에서 지우기.
