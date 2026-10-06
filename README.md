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

## 데이터 정직성
- 첫 버스·환승 버스 도착은 BIMS 실시간 예측(분 단위). 버스 주행시간은 정류장 간 거리 ÷ 평균 15km/h **추정**(같은 차량의 하류 정류장 예측이 맞물리면 실시간 예측 사용). 보행은 직선거리×1.3÷1.2m/s **추정**.
- 출발·도착 좌표는 도로명 번호로 잡은 **대략 위치**이며 건물 출입구는 미확인.
- 혼잡: 잔여좌석은 BIMS 값이 유효할 때만(현재 응답은 −1=확인 불가). 주변 인파·도로 정체는 검증된 무료 제공원이 없어 ‘확인 불가’.
- 자료: 부산시 공식 노선별 정류소 다운로드(2026-10-06 기준, CP949), `data/samples/`는 키를 제거한 실제 응답 샘플.
