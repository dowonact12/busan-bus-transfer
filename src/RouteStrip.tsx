import { useEffect, useRef } from 'react';
import type { RouteStop, RouteVehicles } from '../shared/api';
import type { ArrivalObservation, CandidateLeg, Sec } from '../shared/types';
import { BusBuddy, routeColor } from './BusBuddy';
import { hhmmss } from './format';

interface Props {
  leg: CandidateLeg;
  alightRole: '갈아타요' | '내려요';
  stops: RouteStop[] | undefined;
  vehicles: RouteVehicles | undefined;
  boardArrivals: ArrivalObservation[];
  now: Sec;
}

/** 노선 띠: 승차 전 몇 정류장 ~ 하차 정류장. 차량은 공급자가 준 정류소 순번(bstopidx) 위치에 표시 */
export function RouteStrip({ leg, alightRole, stops, vehicles, boardArrivals, now }: Props) {
  const ref = useRef<HTMLDivElement>(null);
  const boardSeq = leg.board.routeStopSequence ?? 0;
  const alightSeq = leg.alight.routeStopSequence ?? 0;
  const start = Math.max(1, boardSeq - 7);
  const shown = (stops ?? []).filter((s) => s.seq >= start && s.seq <= alightSeq);
  const color = routeColor(leg.routeNo);
  const vs = vehicles?.vehicles ?? [];
  // GPS가 5분 넘게 갱신되지 않은 차량(회차·차고지 대기 등)은 흐리게, 접근 차량 계산에서 제외
  const isStale = (g: number | null) => g != null && now - g > 300;
  const sample = vehicles?.origin === 'sample';
  useEffect(() => {
    const id = requestAnimationFrame(() => {
      const el = ref.current?.querySelector<HTMLElement>('[data-board="1"]');
      if (el && ref.current) ref.current.scrollLeft = Math.max(0, el.offsetLeft - ref.current.clientWidth / 2 + el.clientWidth / 2);
    });
    return () => cancelAnimationFrame(id);
  }, [shown.length]);
  if (!stops || shown.length === 0) return null;

  // 다가오는 버스: 승차 정류장 이전(또는 그 정류장)에 있는 차량 중 가장 가까운 것
  const approaching = vs.filter((v) => !isStale(v.gpsAt) && v.stopIdx <= boardSeq && v.stopIdx >= boardSeq - 40).sort((a, b) => b.stopIdx - a.stopIdx)[0];
  const matchObs = approaching ? boardArrivals.find((o) => o.vehicleReference && approaching.carno.endsWith(o.vehicleReference) && o.etaAt != null) : undefined;
  const away = approaching ? boardSeq - approaching.stopIdx : null;
  const gpsAt = vs.map((v) => v.gpsAt).filter((x): x is number => x != null).sort((a, b) => b - a)[0] ?? null;

  return (
    <div className="strip-wrap">
      <div className="strip-head">
        <span className="route-chip" style={{ background: color }}>{leg.routeNo}</span>
        <span className="strip-title">{leg.board.name} → {leg.alight.name}</span>
      </div>
      <p className="strip-approach" aria-live="polite">
        {!vehicles ? '버스 위치를 불러오는 중…' : vehicles.status !== 'ok' && !vehicles.fetchedAt ? '버스 위치를 지금은 확인할 수 없어요' : approaching ? (
          <>
            <b>{away === 0 ? '버스가 승차 정류장 부근에 있어요' : `가장 가까운 버스: ${away}정류장 전`}</b>
            {matchObs && <> · 약 {Math.max(0, Math.round((matchObs.etaAt! - now) / 60))}분 <em className={`tag ${sample ? 'tag-sample' : 'tag-live'}`}>{sample ? '예시' : '실시간 예측'}</em></>}
          </>
        ) : '승차 정류장 앞쪽에서 운행 중인 버스가 보이지 않아요 (운행 종료로 단정하지 않아요)'}
      </p>
      <div className="strip" ref={ref} role="list" aria-label={`${leg.routeNo}번 노선 정류장`}>
        <div className="strip-line" style={{ background: color }} />
        {shown.map((s) => {
          const isBoard = s.seq === boardSeq, isAlight = s.seq === alightSeq;
          const busHere = vs.filter((v) => v.stopIdx === s.seq);
          const between = s.seq > boardSeq && s.seq < alightSeq;
          return (
            <div key={s.seq} className={`stop ${isBoard ? 'is-board' : ''} ${isAlight ? 'is-alight' : ''} ${between ? 'is-ride' : ''}`} role="listitem" data-board={isBoard ? '1' : undefined}
              aria-label={`${s.name}${isBoard ? ' 승차' : ''}${isAlight ? ' ' + alightRole : ''}${busHere.length ? ' · 버스 있음' : ''}`}>
              <div className="bus-slot">{busHere.length > 0 && <span className={`bus-bob ${busHere.every((b) => isStale(b.gpsAt)) ? 'bus-stale' : ''}`} title={busHere.map((b) => b.carno).join(', ')}><BusBuddy size={30} color={color} label={`버스 ${busHere.map((b) => b.carno).join(', ')}`} /></span>}</div>
              <div className="dot" style={{ borderColor: color }} />
              {isBoard && <span className="pin pin-board">여기서 타요</span>}
              {isAlight && <span className="pin pin-alight">{alightRole}</span>}
              <span className="stop-name">{s.name}</span>
              <span className="stop-ars">{s.ars}</span>
            </div>
          );
        })}
      </div>
      <p className="fine">
        {sample ? '예시 모드: 버스 위치는 가짜 예시예요.' : `버스 위치는 정류장 단위(공급자 순번)로 표시${gpsAt ? ` · GPS ${hhmmss(gpsAt)} 기준` : ''} · 흐린 버스는 위치가 5분 넘게 갱신 안 됨`}
      </p>
    </div>
  );
}
