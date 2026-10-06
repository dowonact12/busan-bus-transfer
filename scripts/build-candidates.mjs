// 공식 부산 BIMS 노선별 정류소 자료(StationInfo.asp, CP949 → UTF-8 변환본)에서
// 출발지 주변 → 도착지 주변의 직통·1회 환승 '정적 후보'를 생성한다.
// 결과는 실시간 추천이 아니라 '검색한 후보'이며, 접근 도보·횡단 동선은 현장 미검증이다.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = path.join(root, 'data/raw/route_stops.csv');
const outPath = path.join(root, 'shared/candidates.generated.json');

// 위치 근사값: 건물 단위 지오코딩이 무료·무키로 확인되지 않아, OSM 도로 구간과
// 도로명주소 기초번호(약 10m 간격) 규칙으로 잡은 '대략 위치'이다. 출입구 좌표가 아니다.
const ORIGIN = { lat: 35.1830, lon: 129.0795, label: '중앙대로 1067 · 3층', approx: true };
const DEST = { lat: 35.1982, lon: 129.1208, label: '반여로 67', approx: true };

const P = {
  accessRadiusM: 700, // 처음·마지막 보행 탐색 반경(직선) ≈ 도보 10분 내외
  transferRadiusM: 250,
  walkSpeedMps: 1.2,
  detourFactor: 1.3, // 직선거리 → 보행거리 가정 계수
  busKmh: { nominal: 15, fast: 20, slow: 11 }, // 가정 평균 운행속도(정차 포함). 실측 아님
  roadFactor: 1.1,
  maxHopsPerLeg: 45,
};

function hav(a, b) {
  const R = 6371000, r = Math.PI / 180;
  const dLat = (b.lat - a.lat) * r, dLon = (b.lon - a.lon) * r;
  const s = Math.sin(dLat / 2) ** 2 + Math.cos(a.lat * r) * Math.cos(b.lat * r) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(s));
}
const walkSec = (m) => Math.round((m * P.detourFactor) / P.walkSpeedMps);

function parseCsv(text) {
  const lines = text.split(/\r?\n/).filter(Boolean);
  const rows = [];
  for (const line of lines.slice(1)) {
    const cells = []; let cur = ''; let q = false;
    for (const ch of line) {
      if (ch === '"') q = !q; else if (ch === ',' && !q) { cells.push(cur); cur = ''; } else cur += ch;
    }
    cells.push(cur);
    const [route, seq, name, , , gu, , lon, lat, ars, stopId] = cells;
    if (!lat || !lon) continue;
    rows.push({ route, seq: Number(seq), name, gu, lat: Number(lat), lon: Number(lon), ars: ars || '', officialStopId: stopId });
  }
  return rows;
}

const rows = parseCsv(fs.readFileSync(csvPath, 'utf8'));
const routes = new Map();
for (const r of rows) {
  if (!routes.has(r.route)) routes.set(r.route, []);
  routes.get(r.route).push(r);
}
for (const list of routes.values()) list.sort((a, b) => a.seq - b.seq);

function rideEstimate(list, i, j) {
  let d = 0;
  for (let k = i; k < j; k++) d += hav(list[k], list[k + 1]);
  d *= P.roadFactor;
  const s = (kmh) => Math.round(d / (kmh / 3.6));
  return { pathM: Math.round(d), nominalSec: s(P.busKmh.nominal), lowSec: s(P.busKmh.fast), highSec: s(P.busKmh.slow), hops: j - i };
}
const stopRef = (s) => ({ ars: s.ars, name: s.name, lat: s.lat, lon: s.lon, routeStopSequence: s.seq, officialStopId: s.officialStopId });

// 처음/마지막 접근 가능 정류장(노선별 인덱스)
const near = (pt) => {
  const out = [];
  for (const [route, list] of routes) list.forEach((s, idx) => {
    const d = hav(pt, s);
    if (d <= P.accessRadiusM && s.ars) out.push({ route, idx, d });
  });
  return out;
};
const originNear = near(ORIGIN);
const destNear = near(DEST);

const candidates = [];
// 직통
for (const o of originNear) {
  for (const de of destNear) {
    if (de.route !== o.route || de.idx <= o.idx || de.idx - o.idx > P.maxHopsPerLeg) continue;
    const list = routes.get(o.route);
    const ride = rideEstimate(list, o.idx, de.idx);
    const fw = walkSec(o.d), lw = walkSec(de.d);
    candidates.push({
      kind: 'direct', routes: [o.route],
      firstWalk: { meters: Math.round(o.d), sec: fw },
      finalWalk: { meters: Math.round(de.d), sec: lw },
      legs: [{ routeNo: o.route, board: stopRef(list[o.idx]), alight: stopRef(list[de.idx]), ride }],
      staticTotalSec: fw + ride.nominalSec + lw,
    });
  }
}
// 1회 환승
const byArsIndex = [];
for (const [route, list] of routes) list.forEach((s, idx) => byArsIndex.push({ route, idx, s }));
for (const o of originNear) {
  const l1 = routes.get(o.route);
  for (let k = o.idx + 1; k < Math.min(l1.length, o.idx + 1 + P.maxHopsPerLeg); k++) {
    const t1 = l1[k];
    if (!t1.ars) continue;
    for (const de of destNear) {
      if (de.route === o.route) continue;
      const l2 = routes.get(de.route);
      for (let m = Math.max(0, de.idx - P.maxHopsPerLeg); m < de.idx; m++) {
        const t2 = l2[m];
        if (!t2.ars) continue;
        const dT = hav(t1, t2);
        if (dT > P.transferRadiusM) continue;
        const r1 = rideEstimate(l1, o.idx, k), r2 = rideEstimate(l2, m, de.idx);
        const fw = walkSec(o.d), lw = walkSec(de.d);
        const sameStop = t1.ars === t2.ars;
        // 같은 정류소(ARS 동일)라도 하차 후 승차 위치 이동 1분을 둔다. 다른 ARS는 거리 기반 + 횡단 미확인.
        const tw = sameStop ? 60 : Math.max(120, walkSec(dT));
        candidates.push({
          kind: 'transfer', routes: [o.route, de.route],
          firstWalk: { meters: Math.round(o.d), sec: fw },
          transferWalk: { meters: Math.round(dT), sec: tw, sameStop, sameNameDifferentArs: !sameStop && t1.name === t2.name },
          finalWalk: { meters: Math.round(de.d), sec: lw },
          legs: [
            { routeNo: o.route, board: stopRef(l1[o.idx]), alight: stopRef(t1), ride: r1 },
            { routeNo: de.route, board: stopRef(t2), alight: stopRef(l2[de.idx]), ride: r2 },
          ],
          staticTotalSec: fw + r1.nominalSec + tw + r2.nominalSec + lw,
        });
      }
    }
  }
}

// 후보 축소(선택용 휴리스틱일 뿐, 화면 순위는 실시간 평가가 결정):
// - 노선 조합별 최선 대비 정적 3분 이내 변형 중 서로 다른 승차/환승 지점 최대 2개
// - 환승 후보 선택 점수에만 고정 5분 가산(대기시간 미지). 표시값에는 쓰지 않음
// - 두 번째 노선별·첫 노선별 조합 수 제한으로 다양성 확보
// - 문서 5장의 조사 후보(36 직통, 36→43, 29→43, 주변 첫 버스→36)는 생성되면 반드시 포함
const SEED_SIGS = ['36', '36>43', '29>43'];
const bySig = new Map();
for (const c of candidates) {
  const sig = c.routes.join('>');
  if (!bySig.has(sig)) bySig.set(sig, []);
  bySig.get(sig).push(c);
}
const perSig = [];
for (const [sig, list] of bySig) {
  list.sort((a, b) => a.staticTotalSec - b.staticTotalSec);
  const best = list[0].staticTotalSec;
  const seen = new Set();
  const picked = [];
  for (const c of list) {
    if (c.staticTotalSec > best + 180) break;
    const key = c.kind === 'direct' ? c.legs[0].board.ars : c.legs[0].alight.ars + '/' + c.legs[1].board.ars;
    if (seen.has(key)) continue;
    seen.add(key); picked.push(c);
    if (picked.length >= 2) break;
  }
  perSig.push({ sig, picked, score: best + (picked[0].kind === 'transfer' ? 300 : 0) });
}
perSig.sort((a, b) => a.score - b.score);
const countR1 = new Map(), countR2 = new Map();
let kept = [];
let sigCount = 0;
for (const g of perSig) {
  const seed = SEED_SIGS.includes(g.sig);
  const [r1, r2] = g.sig.split('>');
  if (!seed) {
    if (sigCount >= 9) continue;
    if (r2 && ((countR2.get(r2) ?? 0) >= 3 || (countR1.get(r1) ?? 0) >= 2)) continue;
  }
  if (r2) { countR2.set(r2, (countR2.get(r2) ?? 0) + 1); countR1.set(r1, (countR1.get(r1) ?? 0) + 1); }
  sigCount++;
  kept.push(...g.picked);
}
kept.sort((a, b) => a.staticTotalSec - b.staticTotalSec);
kept.forEach((c) => {
  c.id = c.kind === 'direct'
    ? `D-${c.routes[0]}-${c.legs[0].board.ars}-${c.legs[0].alight.ars}`
    : `T-${c.routes[0]}-${c.legs[0].board.ars}-${c.legs[0].alight.ars}-${c.routes[1]}-${c.legs[1].board.ars}-${c.legs[1].alight.ars}`;
});

// 화면 노선 띠용: 후보에 쓰인 노선의 전체 정류소 순서(공식 자료)
const routeStops = {};
for (const no of new Set(kept.flatMap((c) => c.routes))) routeStops[no] = routes.get(no).map((s) => ({ seq: s.seq, name: s.name, ars: s.ars, lat: s.lat, lon: s.lon }));
// 다음 정류장(진행 방향 표시용)
for (const c of kept) for (const l of c.legs) {
  const list = routes.get(l.routeNo);
  const i = list.findIndex((s) => s.seq === l.board.routeStopSequence);
  l.board.nextStopName = list[i + 1]?.name ?? null;
}
const out = {
  routeStops,
  generatedAt: new Date().toISOString(),
  source: {
    name: '부산광역시 대중교통정보 노선별 정류소 다운로드 (bus.busan.go.kr/busanBIMS/StationInfo.asp)',
    note: '다운로드 문서 내 표기: 2026-10-06 기준. CP949 인코딩. 정류소ID는 API bstopid와 같은 체계로 가정하지 않음.',
    fetchedAt: fs.statSync(path.join(root, 'data/raw/StationInfo_cp949.html')).mtime.toISOString(),
  },
  origin: ORIGIN, destination: DEST, params: P,
  candidates: kept,
};
fs.writeFileSync(outPath, JSON.stringify(out, null, 1));
console.log(`candidates kept: ${kept.length}`);
for (const c of kept) console.log(Math.round(c.staticTotalSec / 60) + 'm', c.id, c.legs.map((l) => `${l.routeNo}:${l.board.name}(${l.board.ars})→${l.alight.name}(${l.alight.ars}) ${l.ride.hops}정거장`).join(' | '), 'walk', c.firstWalk.meters, c.transferWalk?.meters ?? '-', c.finalWalk.meters);
