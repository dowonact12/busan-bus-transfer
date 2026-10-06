import type { RouteVehicles } from '../shared/api';
import { buildSchematic, gpsAgeText, SCHEMATIC_DEFAULTS, zoneText, type SchematicBus } from '../shared/schematic';
import type { CandidateRoute, Sec } from '../shared/types';
import { routeColor } from './BusBuddy';
import { hhmmss } from './format';

const CHIP_H = 24;
const MIN_GAP = 17; // % — 이보다 가까우면 한 줄 위(아래)로 쌓기

/** 출발 — 환승 — 도착 3점 도식. 차량 위치는 공급자 정류소 순번(GPS 기준) 그대로 */
export function Schematic({ cand, vehicles, now }: { cand: CandidateRoute; vehicles: Record<string, RouteVehicles>; now: Sec }) {
  const transfer = cand.kind === 'transfer' && cand.legs.length === 2;
  const X = transfer ? { s: 17, t: 52, d: 86 } : { s: 20, t: 86, d: 86 };
  const buses = buildSchematic(cand, vehicles, now);
  const loaded = cand.legs.every((l) => vehicles[l.routeNo]);
  const sample = cand.legs.some((l) => vehicles[l.routeNo]?.origin === 'sample');
  const fetched = Math.max(0, ...cand.legs.map((l) => vehicles[l.routeNo]?.fetchedAt ?? 0));
  const failed = cand.legs.filter((l) => vehicles[l.routeNo] && vehicles[l.routeNo].status !== 'ok' && vehicles[l.routeNo].origin !== 'sample').map((l) => l.routeNo);

  const xOf = (b: SchematicBus) => {
    const board = b.legIndex === 0 ? X.s : X.t;
    const alight = b.legIndex === 0 ? X.t : X.d;
    const approachW = b.legIndex === 0 ? board - 3 : 14;
    let x = b.zone === 'before_board' ? board - (b.stopsToBoard! / SCHEMATIC_DEFAULTS.lookBehind) * approachW
      : b.zone === 'between' ? board + b.fraction * (alight - board)
      : alight + 3 + (b.stopsPastAlight! / SCHEMATIC_DEFAULTS.lookAfter) * 6;
    x = Math.min(93, Math.max(7, x));
    return x;
  };
  // 겹치지 않게 줄 배치
  const placed = (leg: number) => {
    const rows: number[][] = [];
    return buses.filter((b) => b.legIndex === leg).map((b) => ({ b, x: xOf(b) })).sort((p, q) => p.x - q.x).map((p) => {
      let r = rows.findIndex((xs) => xs.every((x) => Math.abs(x - p.x) >= MIN_GAP));
      if (r < 0) { rows.push([]); r = rows.length - 1; }
      rows[r].push(p.x);
      return { ...p, row: r };
    });
  };
  const p1 = placed(0), p2 = transfer ? placed(1) : [];
  const rows1 = Math.max(1, ...p1.map((p) => p.row + 1));
  const rows2 = Math.max(1, ...p2.map((p) => p.row + 1));
  const y1 = rows1 * CHIP_H + 8;
  const y2 = y1 + 50;
  const height = transfer ? y2 + 8 + rows2 * CHIP_H + 4 : y1 + 30;
  const c1 = routeColor(cand.legs[0].routeNo), c2 = transfer ? routeColor(cand.legs[1].routeNo) : c1;
  const l1 = cand.legs[0], l2 = cand.legs[1];

  const chip = (p: { b: SchematicBus; x: number; row: number }, lane: 1 | 2) => {
    const top = lane === 1 ? y1 - 6 - (p.row + 1) * CHIP_H + 2 : y2 + 8 + p.row * CHIP_H;
    return (
      <span key={`${p.b.legIndex}-${p.b.carno}`} className={`sbus ${p.b.stale ? 'bus-stale' : ''} ${p.b.zone === 'before_board' ? 'sbus-coming' : ''}`} style={{ left: `${p.x}%`, top, background: routeColor(p.b.routeNo) }}
        title={`${p.b.routeNo}번 ${p.b.carno} · ${zoneText(p.b, cand.kind)} · ${gpsAgeText(p.b.gpsAgeSec)}`}>
        🚌<b>{p.b.routeNo}</b><i>{p.b.plate4}</i>
      </span>
    );
  };

  return (
    <section className="schem" aria-label="버스 위치 도식">
      <div className="schem-head">
        <b>🚏 버스 어디쯤?</b>
        <span className="fine">{sample ? '예시 위치(실제 아님)' : fetched ? `GPS 위치 · ${hhmmss(fetched)} 수신` : loaded ? '위치 정보 없음' : '불러오는 중…'}</span>
      </div>
      <div className="schem-track" style={{ height }}>
        {/* 1구간 차선 */}
        <span className="lane lane-dash" style={{ left: '2%', width: `${X.s - 2}%`, top: y1, background: c1 }} />
        <span className="lane" style={{ left: `${X.s}%`, width: `${X.t - X.s}%`, top: y1, background: c1 }} />
        <span className="lane lane-dash" style={{ left: `${X.t}%`, width: `${transfer ? 9 : 98 - X.t}%`, top: y1, background: c1 }} />
        {transfer && (<>
          <span className="lane lane-dash" style={{ left: `${X.t - 14}%`, width: '14%', top: y2, background: c2 }} />
          <span className="lane" style={{ left: `${X.t}%`, width: `${X.d - X.t}%`, top: y2, background: c2 }} />
          <span className="lane lane-dash" style={{ left: `${X.d}%`, width: `${98 - X.d}%`, top: y2, background: c2 }} />
          <span className="lane-walk" style={{ left: `${X.t}%`, top: y1, height: y2 - y1 }} />
        </>)}
        <span className="node node-start" style={{ left: `${X.s}%`, top: y1 }} />
        <span className="node-cap" style={{ left: `${X.s}%`, top: y1 + 9 }}>출발</span>
        {transfer ? (<>
          <span className="node node-transfer" style={{ left: `${X.t}%`, top: y1 }} />
          <span className="node node-transfer" style={{ left: `${X.t}%`, top: y2 }} />
          <span className="node-cap node-cap-side" style={{ left: `${X.t}%`, top: y1 + 16 }}>환승{cand.transferWalk && !cand.transferWalk.sameStop ? ' · 도보' : ''}</span>
          <span className="node node-end" style={{ left: `${X.d}%`, top: y2 }} />
          <span className="node-cap" style={{ left: `${X.d}%`, top: y2 - 24 }}>도착</span>
        </>) : (<>
          <span className="node node-end" style={{ left: `${X.d}%`, top: y1 }} />
          <span className="node-cap" style={{ left: `${X.d}%`, top: y1 + 9 }}>도착</span>
        </>)}
        {p1.map((p) => chip(p, 1))}
        {p2.map((p) => chip(p, 2))}
      </div>
      <ol className="schem-stops">
        <li><span className="dot dot-start" />출발 <b>{l1.board.name}</b> <span className="ars">{l1.board.ars}</span> · {l1.routeNo}번</li>
        {transfer && <li><span className="dot dot-transfer" />환승 <b>{l1.alight.name}</b>{l2.board.ars !== l1.alight.ars ? <> → <b>{l2.board.name}</b></> : null} <span className="ars">{l2.board.ars}</span> · {l2.routeNo}번</li>}
        <li><span className="dot dot-end" />도착 <b>{(l2 ?? l1).alight.name}</b> <span className="ars">{(l2 ?? l1).alight.ars}</span></li>
      </ol>
      {buses.length > 0 ? (
        <ul className="schem-list">
          {buses.slice(0, 8).map((b) => (
            <li key={`${b.legIndex}-${b.carno}`} className={b.stale ? 'bus-stale' : ''}>
              <span className="schip" style={{ background: routeColor(b.routeNo) }}>{b.routeNo} · {b.plate4}</span>
              <span>{zoneText(b, cand.kind)}</span>
              <span className="muted small">{gpsAgeText(b.gpsAgeSec)}{b.stale ? ' · 오래된 위치' : ''}</span>
            </li>
          ))}
        </ul>
      ) : loaded ? <p className="muted small">이 구간 근처({SCHEMATIC_DEFAULTS.lookBehind}정류장 전까지)에 GPS로 잡힌 버스가 지금은 없어요.</p> : null}
      {failed.length > 0 && <p className="fine">{failed.join('·')}번 위치를 지금 받아오지 못했어요.</p>}
      <p className="fine">위치는 BIMS가 알려 준 ‘몇 번째 정류장 부근’이라 실제와 한 정류장쯤 차이 날 수 있어요. GPS가 5분 넘게 멈춘 버스는 흐리게 보여요.</p>
    </section>
  );
}
