import { lazy, Suspense, useMemo, useRef, useState } from 'react';
import { preferredFor } from '../shared/preferences';
import { calibratedSettings, DOOR_CALIBRATION, defaultPrefs, MEASURED_LABEL, migratePrefs, RULE_OF_THUMB, stopsAwayAtLeave, type UserPrefsV2 } from '../shared/calibration';
import { computeLeaveDeadline } from '../shared/evaluator';
import { recommend, stabilize, type StabilityState } from '../shared/recommender';
import { seatLabel } from '../shared/normalizer';
import { crowdDisplay } from '../shared/crowd';
import type { TripId } from '../shared/api';
import { buildSchematic } from '../shared/schematic';
import { type ArrivalBoard, type CandidateRoute, type ItineraryEvaluation, type JourneyState, type Settings } from '../shared/types';
import { BusBuddy, routeColor } from './BusBuddy';
import { evidenceLabel, hhmm, hhmmss, kakaoMap, minText, rangeText, untilText } from './format';
import { RouteStrip } from './RouteStrip';
import { Schematic } from './Schematic';
import { clientSampleSnapshot, useData, useLocal, useNow, useVehicles } from './useData';

const TripMap = lazy(() => import('./TripMap').then((m) => ({ default: m.TripMap })));

/** 방향별 문구. 도착지 쪽 건물 안 이동(3층 올라가기 등)은 계산에 넣지 않음 */
const TRIP_META: Record<TripId, { tab: string; from: string; to: string; exitLabel: string; destNote: string }> = {
  forward: { tab: '가는 길', from: '중앙대로 1067 · 3층', to: '반여로 67', exitLabel: '3층에서 건물 밖까지', destNote: '도착지 출입구·마지막 동선은 아직 확인 안 됐어요' },
  reverse: { tab: '오는 길', from: '반여로 67', to: '중앙대로 1067', exitLabel: '반여로 67 건물에서 밖까지', destNote: '건물 안 이동(3층까지)은 시간에 넣지 않았어요 · 출입구는 미확인' },
};
const TRIP_KEY = 'bbt.trip';
function loadTrip(): TripId { try { return localStorage.getItem(TRIP_KEY) === 'reverse' ? 'reverse' : 'forward'; } catch { return 'forward'; } }

type UserPrefs = UserPrefsV2;
/** 방향별 저장 설정. 예전 형식({exitMin:2, walkMult})은 v2로 옮기면서 exitMin을 버림(실측 문→정류장에 포함 → 이중 계산 방지) */
function usePrefs(trip: TripId): [UserPrefs, (p: UserPrefs) => void] {
  const key = trip === 'forward' ? 'bbt.prefs' : 'bbt.prefs.reverse';
  const [v, setV] = useState<UserPrefs>(() => {
    try {
      const raw = localStorage.getItem(key);
      const parsed = raw ? JSON.parse(raw) : null;
      const p = migratePrefs(parsed, trip);
      if (raw && parsed?.v !== p.v) localStorage.setItem(key, JSON.stringify(p));
      return p;
    } catch { return defaultPrefs(trip); }
  });
  const set = (nv: UserPrefs) => { const p = migratePrefs(nv, trip); setV(p); try { localStorage.setItem(key, JSON.stringify(p)); } catch { /* ignore */ } };
  return [v, set];
}
const PHASES: { key: JourneyState['phase']; label: string }[] = [
  { key: 'before', label: '출발 전' }, { key: 'walking_to_stop', label: '정류장 가는 중' }, { key: 'on_first_bus', label: '첫 버스' },
  { key: 'at_transfer', label: '환승 정류장' }, { key: 'on_second_bus', label: '다음 버스' }, { key: 'arrived', label: '도착' },
];

export function App() {
  // 가는 길 / 오는 길 — 기기에 기억. 방향을 바꾸면 화면 상태(추천 안정화·펼침)를 새로 시작
  const [trip, setTripState] = useState<TripId>(loadTrip);
  const setTrip = (t: TripId) => { setTripState(t); try { localStorage.setItem(TRIP_KEY, t); } catch { /* ignore */ } };
  return <TripApp key={trip} trip={trip} setTrip={setTrip} />;
}

function TripToggle({ trip, setTrip }: { trip: TripId; setTrip: (t: TripId) => void }) {
  return (
    <div className="trip-toggle" role="radiogroup" aria-label="방향">
      {(['forward', 'reverse'] as TripId[]).map((t) => (
        <button key={t} role="radio" aria-checked={trip === t} className={trip === t ? 'on' : ''} onClick={() => trip !== t && setTrip(t)}>{t === 'forward' ? '🌅 ' : '🌙 '}{TRIP_META[t].tab}</button>
      ))}
    </div>
  );
}

function TripApp({ trip, setTrip }: { trip: TripId; setTrip: (t: TripId) => void }) {
  const meta = TRIP_META[trip];
  const { tripUnsupported, cands, routeStops, snap: liveSnap, netError, loading, refresh, offset, connection, wakeElapsed, demo, setDemo } = useData(trip);
  const now = useNow(offset);
  // 연결 끊김 + 사용자가 '예시 화면'을 고른 경우에만 클라이언트 예시 데이터 (실시간처럼 보이지 않게)
  const snap = demo && cands ? clientSampleSnapshot(cands, now) : liveSnap;
  // 문→평소 정류장 실측 범위(건물 나가기·신호 포함)를 방향마다 따로 기억
  const [prefs, setPrefs] = usePrefs(trip);
  const [journeyRaw, setJourney] = useLocal<JourneyState>(trip === 'forward' ? 'bbt.journey' : 'bbt.journey.reverse', { phase: 'before' });
  const [open, setOpen] = useState<string | null>(null); // 펼친 카드
  const [othersOpen, setOthersOpen] = useState<string | null>(null); // '다른 후보'에서 펼친 경로(버스 위치·지도)
  const [sheet, setSheet] = useState<null | 'settings' | 'others' | 'crowd' | 'info'>(null);
  const stab = useRef<StabilityState>({ currentId: null, challengerId: null, streak: 0 });

  const settings: Settings = useMemo(() => calibratedSettings(trip, prefs, cands?.candidates ?? []), [trip, prefs, cands]);
  const boards = snap?.boards ?? [];
  const lookup = (ars: string, routeNo: string): ArrivalBoard | undefined => boards.find((b) => b.stopArs === ars && b.routeNo === routeNo);
  const candList = cands?.candidates ?? [];
  const candById = (id: string) => candList.find((c) => c.id === id)!;
  // 저장된 진행 상태가 지금 후보에 없으면(후보 갱신 등) 처음부터
  const journeyValid = journeyRaw.phase === 'before' || !journeyRaw.candidateId || (!!cands && candList.some((c) => c.id === journeyRaw.candidateId));
  const journey: JourneyState = useMemo(() => (journeyValid ? journeyRaw : { phase: 'before' }), [journeyValid, journeyRaw]);

  const preferred = preferredFor(trip);
  const rec = useMemo(() => (snap && cands ? recommend(cands.candidates, { now, settings, lookup, journey }, { preferredCandidateId: preferred.candidateId }) : null),
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [snap, cands, now, settings, journey, preferred.candidateId]);
  const shownRec = useMemo(() => {
    if (!rec) return null;
    const s = stabilize(stab.current, rec);
    stab.current = s.state;
    return rec.all.find((e) => e.candidateId === s.displayId) ?? rec.recommended;
  }, [rec]);
  const alts = rec ? rec.alternatives.filter((a) => a.evaluation.candidateId !== shownRec?.candidateId).slice(0, 2) : [];
  // 추천이 없을 때(심야·미연결 등)에도 평소 경로는 숨기지 않고 카드로 보여 줌
  const preferredEv = rec && !shownRec ? rec.all.find((e) => e.candidateId === preferred.candidateId) : null;
  const preferredCand = preferredEv && candList.some((c) => c.id === preferred.candidateId) ? candById(preferred.candidateId) : null;

  const visibleRoutes = [
    ...(sheet === 'others' && othersOpen && candList.some((c) => c.id === othersOpen) ? candById(othersOpen).routes : []),
    ...(preferredCand ? preferredCand.routes : []),
    ...[shownRec, ...alts.map((a) => a.evaluation)].filter(Boolean).flatMap((e) => e!.constituentRoutes),
  ];
  const vehicles = useVehicles(visibleRoutes.slice(0, 6), !!liveSnap && connection === 'ok', demo, Object.fromEntries(Object.entries(routeStops).map(([k, v]) => [k, v.length])));
  const sample = snap?.mode === 'sample';
  const oldestAge = boards.length ? Math.max(...boards.filter((b) => b.fetchedAt).map((b) => now - (b.fetchedAt ?? now))) : null;
  const statusPill = tripUnsupported && !demo && connection === 'ok' ? { cls: 'pill-stale', text: '실시간 준비 중' } : demo ? { cls: 'pill-sample', text: '예시 모드' } : connection === 'waking' ? { cls: 'pill-wait', text: '서버 깨우는 중' } : connection === 'lost' ? { cls: 'pill-off', text: '실시간 연결 끊김' } : !snap ? { cls: 'pill-wait', text: '불러오는 중' } : sample ? { cls: 'pill-sample', text: '예시 모드' } : oldestAge != null && oldestAge > 120 ? { cls: 'pill-stale', text: '갱신 필요' } : snap.mode === 'live_degraded' ? { cls: 'pill-stale', text: '일부만 실시간' } : { cls: 'pill-live', text: '실시간' };
  const mood = !rec ? 'sleepy' : rec.recommendedIsTight || !rec.recommended ? 'worried' : 'happy';

  return (
    <div className="app">
      <header className="top">
        <BusBuddy size={36} mood={mood} />
        <div className="top-text">
          <TripToggle trip={trip} setTrip={setTrip} />
          <div className="top-route">{cands?.origin.label ?? meta.from} <span aria-hidden>→</span> {cands?.destination.label ?? meta.to}</div>
          <div className="top-sub">
            <span className={`pill ${statusPill.cls}`}>{statusPill.text}</span>
            <span>{snap ? `${hhmmss(Math.max(...boards.map((b) => b.fetchedAt ?? 0), 0) || snap.serverTime)} 수신` : ''}</span>
          </div>
        </div>
        <button className="icon-btn" onClick={() => refresh(true)} aria-label="새로고침" disabled={loading}><span className={loading ? 'spin' : ''}>↻</span></button>
        <button className="icon-btn" onClick={() => setSheet('settings')} aria-label="설정">⚙︎</button>
      </header>

      <main className="main">
        {tripUnsupported && !demo && <div className="banner banner-warn" role="status">🛠 오는 길 실시간 도착 정보는 버스 서버를 업데이트한 뒤에 볼 수 있어요. 지금은 공식 노선 자료로 만든 경로와 GPS 버스 위치만 보여드리고, 도착 시각은 계산하지 않아요.</div>}
        {demo && <div className="banner banner-sample">🧸 실시간 연결이 끊겨서 <b>예시 화면</b>을 보여드려요. 시각은 실제가 아니에요. <button className="btn tiny" onClick={() => { setDemo(false); refresh(true); }}>다시 연결</button></div>}
        {sample && !demo && <div className="banner banner-sample">🧸 지금은 <b>예시 모드</b>예요. 아래 버스 시각은 실제가 아니에요.{snap?.providerMessage ? ` (${snap.providerMessage})` : ''}</div>}
        {connection === 'waking' && liveSnap && !demo && <div className="banner banner-sample" role="status">☕ 버스 서버 깨우는 중… ({wakeElapsed}초) 아래 정보는 마지막으로 받은 값이라 곧 ‘갱신 필요’로 바뀔 수 있어요.</div>}
        {netError && !demo && liveSnap && <div className="banner banner-warn" role="alert">📡 {netError}</div>}
        {snap?.providerMessage && !sample && !demo && <div className="banner banner-warn" role="status">{snap.providerMessage}</div>}
        {!tripUnsupported && rec?.notices.map((n) => <div key={n} className="banner banner-warn" role="status">{n}</div>)}

        {journey.phase !== 'before' && <JourneyBar journey={journey} setJourney={setJourney} now={now} cand={journey.candidateId ? candById(journey.candidateId) : undefined} ev={rec?.all.find((e) => e.candidateId === journey.candidateId) ?? null} />}

        {connection === 'waking' && !liveSnap && !demo ? (
          <div className="card offline-card" role="status" aria-live="polite">
            <span className="wake-bus"><BusBuddy size={76} mood="sleepy" label="일어나는 버스" /></span>
            <p className="hero-action">버스 서버 깨우는 중… ☕</p>
            <p className="muted">무료 서버라 한동안 안 쓰면 잠들어요. 깨어나는 데 30~60초쯤 걸려요. 잠깐만 기다려 주세요!</p>
            <div className="wake-dots" aria-hidden><span /><span /><span /></div>
            <p className="fine">{wakeElapsed > 0 ? `${wakeElapsed}초째 깨우는 중 · 5초마다 다시 불러요` : '연결 중'}</p>
          </div>
        ) : connection === 'lost' && !liveSnap && !demo ? (
          <div className="card offline-card" role="alert">
            <BusBuddy size={72} mood="sleepy" label="잠든 버스" />
            <p className="hero-action">실시간 연결이 끊겼어요 💤</p>
            <p className="muted">버스 정보를 받아오는 서버에 지금 닿지 않아요. 그래서 버스 시각을 보여드릴 수 없어요.</p>
            <div className="detail-actions" style={{ justifyContent: 'center' }}>
              <button className="btn primary" onClick={() => refresh(true)}>다시 깨워 보기</button>
              <button className="btn soft" onClick={() => setDemo(true)}>예시 화면 보기</button>
            </div>
            <p className="fine">예시 화면의 시각은 실제가 아니에요.</p>
          </div>
        ) : !snap || !cands ? (
          <div className="card hero loading-card"><BusBuddy size={64} mood="sleepy" /><p>버스 친구들을 부르는 중이에요…</p></div>
        ) : preferredEv && preferredCand ? (
          <>
            <div className="banner banner-sample" role="status">⭐ 지금은 바로 추천할 수 있는 경로가 없어 <b>평소 타는 길</b>을 먼저 보여드려요.</div>
            <RouteCard trip={trip} key={preferredCand.id} hero ev={preferredEv} cand={preferredCand} reason={null}
              tight={preferredEv.feasibility === 'tight'} now={now} settings={settings} lookup={lookup} routeStops={routeStops} vehicles={vehicles} meta={meta} places={cands}
              preferred={preferred}
              expanded={open === preferredCand.id} onToggle={() => setOpen(open === preferredCand.id ? null : preferredCand.id)} journey={journey} setJourney={setJourney} />
          </>
        ) : tripUnsupported && !shownRec ? (
          <div className="card hero empty-card"><BusBuddy size={64} mood="sleepy" /><p className="hero-action">오는 길 경로 {candList.length}개를 준비해 뒀어요.</p><p className="muted">실시간 도착 정보가 연결되면 여기서 바로 추천해 드릴게요.</p><button className="btn soft" onClick={() => setSheet('others')}>🗂 경로·버스 위치 보기</button></div>
        ) : shownRec ? (
          <RouteCard trip={trip} key={shownRec.candidateId} hero ev={shownRec} cand={candById(shownRec.candidateId)} reason={shownRec.candidateId === rec?.recommended?.candidateId ? rec.reason : '방금 전 추천을 유지하고 있어요(작은 변화로 바꾸지 않아요).'}
            tight={shownRec.feasibility === 'tight'} now={now} settings={settings} lookup={lookup} routeStops={routeStops} vehicles={vehicles} meta={meta} places={cands}
            preferred={shownRec.candidateId === preferred.candidateId ? preferred : null}
            expanded={open === shownRec.candidateId} onToggle={() => setOpen(open === shownRec.candidateId ? null : shownRec.candidateId)} journey={journey} setJourney={setJourney} />
        ) : (
          <div className="card hero empty-card"><BusBuddy size={64} mood="worried" /><p className="hero-action">지금 바로 추천할 수 있는 경로가 없어요.</p><p className="muted">‘다른 후보’에서 상태(운행대기·미확인 등)와 지금 다니는 버스 위치를 볼 수 있어요.</p><button className="btn soft" onClick={() => setSheet('others')}>🗂 다른 후보 · 버스 위치</button></div>
        )}

        {alts.length > 0 && <h2 className="section-title">다른 선택 <span className="muted">· 눌러서 자세히</span></h2>}
        {alts.map((a) => (
          <RouteCard trip={trip} key={a.evaluation.candidateId} ev={a.evaluation} cand={candById(a.evaluation.candidateId)} diff={a.diffLabels} risk={a.risk} tight={a.evaluation.feasibility === 'tight'} now={now} settings={settings} lookup={lookup}
            routeStops={routeStops} vehicles={vehicles} meta={meta} places={cands}
            preferred={a.evaluation.candidateId === preferred.candidateId ? preferred : null}
            expanded={open === a.evaluation.candidateId} onToggle={() => setOpen(open === a.evaluation.candidateId ? null : a.evaluation.candidateId)} journey={journey} setJourney={setJourney} />
        ))}

        <nav className="quick" aria-label="더 보기">
          <button onClick={() => setSheet('others')}>🗂 다른 후보 {rec ? rec.others.length : ''}</button>
          <button onClick={() => setSheet('crowd')}>👥 혼잡</button>
          <button onClick={() => setSheet('info')}>ℹ️ 정보·출처</button>
        </nav>
      </main>

      {sheet && (
        <Sheet title={{ settings: `설정 · ${meta.tab}`, others: '다른 후보', crowd: '혼잡 정보', info: '데이터 정보' }[sheet]} onClose={() => setSheet(null)}>
          {sheet === 'settings' && <SettingsView trip={trip} prefs={prefs} setPrefs={setPrefs} journey={journey} setJourney={setJourney} overheadSec={settings.doorOverheadSec ?? 0} />}
          {sheet === 'others' && rec && <OthersView evs={rec.others} candById={candById} openId={othersOpen} setOpenId={setOthersOpen} vehicles={vehicles} routeStops={routeStops} places={cands} now={now} preferred={preferred} trip={trip} settings={settings} />}
          {sheet === 'crowd' && <CrowdView ev={shownRec} lookup={lookup} cand={shownRec ? candById(shownRec.candidateId) : undefined} now={now} />}
          {sheet === 'info' && <InfoView snap={snap} cands={cands} now={now} />}
        </Sheet>
      )}
    </div>
  );
}

function Sheet({ title, onClose, children }: { title: string; onClose: () => void; children: React.ReactNode }) {
  return (
    <div className="sheet-backdrop" onClick={onClose}>
      <section className="sheet" role="dialog" aria-modal="true" aria-label={title} onClick={(e) => e.stopPropagation()}>
        <div className="sheet-head"><h2>{title}</h2><button className="icon-btn" onClick={onClose} aria-label="닫기" autoFocus>✕</button></div>
        <div className="sheet-body">{children}</div>
      </section>
    </div>
  );
}

function Chips({ cand }: { cand: CandidateRoute }) {
  return (
    <div className="chips">
      {cand.legs.map((l, i) => (
        <span key={i} className="chip-group">
          {i > 0 && <span className="arrow" aria-hidden>›</span>}
          <span className="route-chip big" style={{ background: routeColor(l.routeNo) }}>🚌 {l.routeNo}</span>
        </span>
      ))}
      {cand.kind === 'direct' && <span className="mini-tag">환승 없음</span>}
    </div>
  );
}

interface Seg { key: string; icon: string; label: string; sec: number; kind: 'walk' | 'wait' | 'ride' | 'prep'; ev: string }
function segments(ev: ItineraryEvaluation, cand: CandidateRoute, s: Settings, leaveAt: number): Seg[] {
  const w = (x: number) => Math.round(x * s.walkMultiplier);
  const out: Seg[] = [];
  const firstB = ev.firstBoardingEstimate?.nominalAt;
  if (firstB == null) return out;
  const atStop = ev.firstReadyAt != null ? ev.firstReadyAt + (ev.indoorWaitSec ?? 0) : null;
  if (ev.firstReadyAt != null) {
    if (s.buildingExitSec > 0) out.push({ key: 'prep', icon: '🏢', label: '건물 나가기', sec: s.buildingExitSec, kind: 'prep', ev: '설정값' });
    const fw = ev.firstWalkEstimate;
    out.push({ key: 'w1', icon: '🚶', label: '문 → 정류장', sec: fw ? fw.nominalSec : w(cand.firstWalk.sec), kind: 'walk', ev: fw?.measured ? MEASURED_LABEL : '추정' });
    if (atStop != null) out.push({ key: 'q1', icon: '⏳', label: '버스 기다림', sec: Math.max(0, firstB - atStop), kind: 'wait', ev: evidenceLabel(ev.firstBoardingEstimate!.evidenceKind, ev.firstBoardingEstimate!.origin) });
  }
  const t1 = ev.transferArrivalEstimate?.nominalAt;
  if (t1 != null) out.push({ key: 'r1', icon: '🚌', label: `${cand.legs[0].routeNo}번 타고`, sec: t1 - firstB, kind: 'ride', ev: evidenceLabel(ev.transferArrivalEstimate!.evidenceKind, ev.transferArrivalEstimate!.origin) });
  if (cand.kind === 'transfer' && ev.transferBoardingEstimate?.nominalAt != null && t1 != null) {
    out.push({ key: 'wt', icon: '🚶', label: '갈아타러', sec: w(cand.transferWalk!.sec), kind: 'walk', ev: '추정' });
    out.push({ key: 'q2', icon: '⏳', label: '환승 대기', sec: Math.max(0, ev.transferWaitSec ?? 0), kind: 'wait', ev: evidenceLabel(ev.transferBoardingEstimate.evidenceKind, ev.transferBoardingEstimate.origin) });
    out.push({ key: 'r2', icon: '🚌', label: `${cand.legs[1].routeNo}번 타고`, sec: cand.legs[1].ride.nominalSec, kind: 'ride', ev: '추정' });
  }
  out.push({ key: 'wf', icon: '🚶', label: '도착지까지', sec: w(cand.finalWalk.sec), kind: 'walk', ev: '추정' });
  void leaveAt;
  return out;
}

function RouteCard(p: {
  ev: ItineraryEvaluation; cand: CandidateRoute; hero?: boolean; reason?: string | null; diff?: string[]; risk?: boolean; tight: boolean; now: number; settings: Settings;
  lookup: (a: string, r: string) => ArrivalBoard | undefined; routeStops: Record<string, import('../shared/api').RouteStop[]>; vehicles: Record<string, import('../shared/api').RouteVehicles>;
  expanded: boolean; onToggle: () => void; journey: JourneyState; setJourney: (j: JourneyState) => void;
  meta: (typeof TRIP_META)[TripId]; places: import('../shared/api').CandidatesPayload | null;
  preferred?: import('../shared/preferences').PreferredRoute | null;
  trip: TripId;
}) {
  const { ev, cand, now, settings } = p;
  const leg1 = cand.legs[0], leg2 = cand.legs[1];
  const dest = ev.destinationEstimate;
  const leaveAt = ev.recommendedLeaveAt != null ? Math.max(now, ev.recommendedLeaveAt) : now;
  const segs = segments(ev, cand, settings, leaveAt);
  const tripSec = dest?.nominalAt != null ? dest.nominalAt - leaveAt : null;
  const totalBar = segs.reduce((a, s) => a + s.sec, 0) || 1;
  const sampleEv = ev.firstBoardingEstimate?.origin === 'sample';
  const advice = ev.leaveAdvice;
  const firstEta = ev.firstBoardingEstimate?.nominalAt;
  const action = advice.kind === 'leave_in' ? `${advice.minutes}분 뒤(${hhmm(advice.atSec)})에 나가면 ${leg1.board.name}에서 ${leg1.routeNo}번을 탈 수 있을 것 같아요.`
    : advice.kind === 'leave_now_tight' ? `지금 바로 나가야 ${leg1.board.name}에서 ${leg1.routeNo}번을 탈 수 있을 것 같아요. 여유가 적어요!`
    : advice.kind === 'conservative_now' ? `지금 출발하는 걸 권해요. ${leg1.board.name}에서 ${leg1.routeNo}번 (탑승을 보장하진 않아요)`
    : `지금 출발하면 ${leg1.board.name}에서 ${leg1.routeNo}번을 탈 수 있을 것으로 예상돼요.`;
  const boarding = p.lookup(leg1.board.ars, leg1.routeNo);

  return (
    <article className={`card ${p.hero ? 'hero' : 'alt'} ${p.tight ? 'is-tight' : ''}`}>
      <button className="card-tap" onClick={p.onToggle} aria-expanded={p.expanded}>
        <div className="card-top">
          <span className={`badge ${p.hero ? 'badge-rec' : 'badge-alt'}`}>{p.hero ? '💖 추천' : '다른 길'}</span>
          {p.preferred && <span className="badge badge-usual">⭐ {p.preferred.badge}</span>}
          {p.tight && <span className="badge badge-risk">⚠️ 환승 촉박</span>}
          {ev.tier === 'estimate' && <span className="badge badge-risk">배차 추정</span>}
          {sampleEv && <span className="badge badge-sample">예시값</span>}
        </div>
        {p.preferred && <p className="usual-note">💺 {p.preferred.note}</p>}
        {p.hero && <p className="hero-action">{action}</p>}
        {p.preferred && <LeaveByStops ev={ev} cand={cand} now={now} trip={p.trip} settings={settings} />}
        <div className="eta-row">
          <div>
            <div className="eta-clock">{hhmm(dest?.nominalAt)}</div>
            <div className="eta-label">{ev.destinationConditional ? '이 버스에 타면 도착' : '도착 예상'}</div>
          </div>
          <div className="eta-side">
            <div className="trip-total">{tripSec != null ? `총 ${Math.round(tripSec / 60)}분` : '—'}</div>
            <div className="muted small">{ev.totalSec != null ? `지금부터 ${Math.round(ev.totalSec / 60)}분` : ''}</div>
          </div>
        </div>
        {rangeText(dest) && <div className="range">{rangeText(dest)}</div>}
        <Chips cand={cand} />
        {p.diff && p.diff.length > 0 && <div className="diffs">{p.diff.map((d) => <span key={d} className={`diff ${/촉박|늦음|추가|추정|더 대기/.test(d) ? 'diff-bad' : 'diff-good'}`}>{d}</span>)}</div>}
        {/* 소요시간 막대 */}
        <div className="seg-bar" aria-hidden>
          {segs.map((s) => <span key={s.key} className={`seg seg-${s.kind} ${s.ev === '추정' || s.ev === '설정값' ? 'seg-est' : ''}`} style={{ flexGrow: Math.max(s.sec, 30) / totalBar }} />)}
        </div>
        <ul className="seg-list">
          {segs.map((s) => (
            <li key={s.key}><span className="seg-ico">{s.icon}</span>{s.label} <b>{minText(s.sec)}</b> <em className={`tag ${s.ev === '실시간 예측' ? 'tag-live' : s.ev === '예시값' ? 'tag-sample' : s.ev === MEASURED_LABEL ? 'tag-measured' : 'tag-est'}`}>{s.ev}</em></li>
          ))}
        </ul>
        <div className="metrics">
          <div><span>출발</span><b>{ev.recommendedLeaveAt != null && ev.recommendedLeaveAt > now + 59 ? hhmm(ev.recommendedLeaveAt) : '지금'}</b></div>
          <div><span>첫 버스</span><b>{untilText(firstEta, now)}</b></div>
          <div><span>환승 대기</span><b>{cand.kind === 'direct' ? '없음' : minText(ev.transferWaitSec)}</b></div>
          <div><span>총 도보</span><b>{minText(ev.walkSec)}</b></div>
        </div>
        {p.reason && <p className="reason">✨ {p.reason}</p>}
        {ev.warnings.length > 0 && <ul className="warns">{ev.warnings.map((w) => <li key={w}>{w}</li>)}</ul>}
        <div className="more">{p.expanded ? '접기 ▲' : '자세히 · 버스 위치 보기 ▼'}</div>
      </button>

      {p.expanded && (
        <div className="details">
          <Schematic cand={cand} vehicles={p.vehicles} now={now} />
          {p.places && (
            <details className="map-box" open>
              <summary>🗺 지도</summary>
              <Suspense fallback={<div className="map map-loading">지도를 불러오는 중…</div>}>
                <TripMap cand={cand} routeStops={p.routeStops} buses={buildSchematic(cand, p.vehicles, now)} origin={p.places.origin} dest={p.places.destination} />
              </Suspense>
            </details>
          )}
          <details className="strip-box">
            <summary>🚏 정류장별로 보기</summary>
            <RouteStrip leg={leg1} alightRole={leg2 ? '갈아타요' : '내려요'} stops={p.routeStops[leg1.routeNo]} vehicles={p.vehicles[leg1.routeNo]} boardArrivals={boarding?.observations ?? []} now={now} />
            {leg2 && <RouteStrip leg={leg2} alightRole="내려요" stops={p.routeStops[leg2.routeNo]} vehicles={p.vehicles[leg2.routeNo]} boardArrivals={p.lookup(leg2.board.ars, leg2.routeNo)?.observations ?? []} now={now} />}
          </details>
          <Timeline ev={ev} cand={cand} settings={settings} now={now} meta={p.meta} destLabel={p.places?.destination.label ?? p.meta.to} />
          <div className="detail-actions">
            {p.journey.phase === 'before' && <button className="btn soft" onClick={() => p.setJourney({ phase: 'walking_to_stop', candidateId: cand.id, leftAt: now })}>🚪 출발했어요</button>}
            {(p.journey.phase === 'before' || ((p.journey.phase === 'walking_to_stop' || p.journey.phase === 'at_stop'))) && ev.firstBoardingEstimate && (
              <button className="btn primary" onClick={() => p.setJourney({ phase: 'on_first_bus', candidateId: cand.id, leftAt: p.journey.leftAt ?? null, boarded: { routeNo: leg1.routeNo, boardArs: leg1.board.ars, vehicleReference: ev.firstVehicle?.vehicleReference ?? null, vehicleConfirmed: false, boardedAt: now } })}>🚌 {leg1.routeNo}번 탔어요</button>
            )}
          </div>
        </div>
      )}
    </article>
  );
}

function Timeline({ ev, cand, settings, now, meta, destLabel }: { ev: ItineraryEvaluation; cand: CandidateRoute; settings: Settings; now: number; meta: (typeof TRIP_META)[TripId]; destLabel: string }) {
  const l1 = cand.legs[0], l2 = cand.legs[1];
  const fb = ev.firstBoardingEstimate, ta = ev.transferArrivalEstimate, sb = ev.transferBoardingEstimate, d = ev.destinationEstimate;
  const lbl = (e: typeof fb) => (e ? evidenceLabel(e.evidenceKind, e.origin) : '확인 불가');
  const seat = ev.firstVehicle ? seatLabel(ev.firstVehicle.seats) : null;
  const w = (x: number) => minText(x * settings.walkMultiplier);
  const leave = ev.recommendedLeaveAt != null ? Math.max(now, ev.recommendedLeaveAt) : now;
  const fw = ev.firstWalkEstimate;
  return (
    <ol className="timeline" aria-label="시간순 일정">
      <li><time>{hhmm(leave)}</time><div><b>출발</b>{settings.buildingExitSec > 0 && <> · {meta.exitLabel} {minText(settings.buildingExitSec)} <em className="tag tag-est">설정값</em></>}</div></li>
      <li><time /><div>🚶 {fw ? (fw.measured ? `${Math.round(fw.lowSec / 60)}~${Math.round(fw.highSec / 60)}분` : minText(fw.nominalSec)) : w(cand.firstWalk.sec)} 걸어서 <b>{l1.board.name}</b> <span className="ars">{l1.board.ars}</span> {fw?.measured ? <em className="tag tag-measured">{MEASURED_LABEL}</em> : <em className="tag tag-est">추정</em>}<div className="muted small">{fw?.measured ? '문 나서서 정류장까지(건물 나가기·신호 포함)' : (settings.doorOverheadSec ?? 0) > 0 ? `걷기 추정 + 문~큰길 ${minText(settings.doorOverheadSec)}(실측 정류장 기준 보정)` : ''}</div>{l1.board.nextStopName && <div className="muted small">다음 정류장 {l1.board.nextStopName} 방면</div>}<a className="link" href={kakaoMap(l1.board.name, l1.board.lat, l1.board.lon)} target="_blank" rel="noreferrer">정류장 위치 열기</a></div></li>
      <li><time>{hhmm(fb?.nominalAt)}</time><div>🚌 <b>{l1.routeNo}번 승차</b> <em className={`tag ${fb?.origin === 'sample' ? 'tag-sample' : fb?.evidenceKind === 'realtime_prediction' ? 'tag-live' : 'tag-est'}`}>{lbl(fb)}</em>{ev.firstVehicle?.vehicleReference && <div className="muted small">차량 {ev.firstVehicle.vehicleReference}{ev.firstVehicle.remainingStops != null ? ` · ${ev.firstVehicle.remainingStops}정류장 전` : ''}</div>}{seat && <div className="muted small">{seat}</div>}</div></li>
      <li><time>{hhmm(ta?.nominalAt)}</time><div>{l1.ride.hops}정거장 이동 → <b>{l1.alight.name}</b> <span className="ars">{l1.alight.ars}</span> {l2 ? '하차' : '하차'} <em className={`tag ${ta?.evidenceKind === 'realtime_prediction' ? (ta.origin === 'sample' ? 'tag-sample' : 'tag-live') : 'tag-est'}`}>{lbl(ta)}</em></div></li>
      {l2 && (
        <>
          <li><time /><div>🚶 환승 {w(cand.transferWalk!.sec)} {cand.transferWalk!.sameStop ? '(같은 정류장)' : <>→ <b>{l2.board.name}</b> <span className="ars">{l2.board.ars}</span> <span className="warn-inline">다른 정류장 · 횡단 확인</span></>} <em className="tag tag-est">추정</em></div></li>
          <li><time>{hhmm(sb?.nominalAt)}</time><div>🚌 <b>{l2.routeNo}번 승차</b> <em className={`tag ${sb?.origin === 'sample' ? 'tag-sample' : sb?.evidenceKind === 'realtime_prediction' ? 'tag-live' : 'tag-est'}`}>{lbl(sb)}</em><div className="muted small">환승 대기 {minText(ev.transferWaitSec)} · 계산상 여유 {minText(ev.transferSlackSec)}</div></div></li>
          <li><time /><div>{l2.ride.hops}정거장 이동 → <b>{l2.alight.name}</b> <span className="ars">{l2.alight.ars}</span> 하차 <em className="tag tag-est">추정</em></div></li>
        </>
      )}
      <li><time>{hhmm(d?.nominalAt)}</time><div>🚶 {w(cand.finalWalk.sec)} 걸어서 <b>{destLabel}</b> 도착 <em className="tag tag-est">추정</em><div className="muted small">{meta.destNote}</div>{ev.destinationIfMissed && <div className="muted small">환승을 놓치면 {hhmm(ev.destinationIfMissed.nominalAt)} 도착 예상</div>}{ev.destinationConditional && !ev.destinationIfMissed && <div className="muted small">환승을 놓치면 도착 시각은 미확정</div>}</div></li>
    </ol>
  );
}

function JourneyBar({ journey, setJourney, now, cand, ev }: { journey: JourneyState; setJourney: (j: JourneyState) => void; now: number; cand?: CandidateRoute; ev: ItineraryEvaluation | null }) {
  const phaseIdx = PHASES.findIndex((p) => p.key === (journey.phase === 'at_stop' ? 'walking_to_stop' : journey.phase));
  const isDirect = cand?.kind === 'direct';
  const steps = PHASES.filter((p) => !(isDirect && (p.key === 'at_transfer' || p.key === 'on_second_bus')));
  return (
    <section className="card journey" aria-label="이동 진행 상태">
      <ol className="steps">{steps.map((p) => <li key={p.key} className={PHASES.findIndex((x) => x.key === p.key) <= phaseIdx ? 'done' : ''}>{p.label}</li>)}</ol>
      {journey.boarded && !journey.boarded.vehicleConfirmed && journey.boarded.vehicleReference && journey.phase === 'on_first_bus' && (
        <div className="confirm">탄 버스 번호판 끝자리가 <b>{journey.boarded.vehicleReference}</b> 맞아요?
          <button className="btn tiny" onClick={() => setJourney({ ...journey, boarded: { ...journey.boarded!, vehicleConfirmed: true } })}>맞아요</button>
          <button className="btn tiny ghost" onClick={() => setJourney({ ...journey, boarded: { ...journey.boarded!, vehicleReference: null } })}>모르겠어요</button>
        </div>
      )}
      <div className="journey-actions">
        {journey.phase === 'walking_to_stop' && <button className="btn soft" onClick={() => setJourney({ ...journey, phase: 'at_stop' })}>📍 정류장 도착</button>}
        {journey.phase === 'on_first_bus' && !isDirect && <button className="btn soft" onClick={() => setJourney({ ...journey, phase: 'at_transfer' })}>📍 환승 정류장 도착</button>}
        {journey.phase === 'at_transfer' && cand?.legs[1] && <button className="btn primary" onClick={() => setJourney({ ...journey, phase: 'on_second_bus', secondBoarded: { routeNo: cand.legs[1].routeNo, boardArs: cand.legs[1].board.ars, boardedAt: now } })}>🚌 {cand.legs[1].routeNo}번 탔어요</button>}
        {(journey.phase === 'on_second_bus' || (journey.phase === 'on_first_bus' && isDirect)) && <button className="btn primary" onClick={() => setJourney({ ...journey, phase: 'arrived' })}>🏁 도착했어요</button>}
        <button className="btn ghost" onClick={() => setJourney({ phase: 'before' })}>처음부터</button>
      </div>
      {journey.phase === 'arrived' && <p className="arrived">🎉 잘 도착했어요! 오늘도 수고했어요.</p>}
      {ev?.destinationEstimate && journey.phase !== 'arrived' && <p className="muted small">현재 경로 도착 예상 {hhmm(ev.destinationEstimate.nominalAt)}</p>}
    </section>
  );
}

function SettingsView({ trip, prefs, setPrefs, journey, setJourney, overheadSec }: { trip: TripId; prefs: UserPrefs; setPrefs: (p: UserPrefs) => void; journey: JourneyState; setJourney: (j: JourneyState) => void; overheadSec: number }) {
  const cal = DOOR_CALIBRATION[trip];
  const step = (k: 'doorLowMin' | 'doorHighMin', d: number) => {
    const n = { ...prefs, [k]: Math.min(30, Math.max(1, prefs[k] + d)) };
    if (k === 'doorLowMin' && n.doorLowMin > n.doorHighMin) n.doorHighMin = n.doorLowMin;
    if (k === 'doorHighMin' && n.doorHighMin < n.doorLowMin) n.doorLowMin = n.doorHighMin;
    setPrefs(n);
  };
  const isDefault = prefs.doorLowMin === cal.lowMin && prefs.doorHighMin === cal.highMin;
  return (
    <div className="settings">
      <div className="field"><span>{cal.from} 문 → {cal.stopName}({cal.ars}) <b>{prefs.doorLowMin}~{prefs.doorHighMin}분</b></span></div>
      <div className="range-steppers">
        <label>빠를 때 <b>{prefs.doorLowMin}분</b>
          <span className="stepper"><button className="btn tiny" onClick={() => step('doorLowMin', -1)} aria-label="빠를 때 1분 줄이기">−</button><button className="btn tiny" onClick={() => step('doorLowMin', 1)} aria-label="빠를 때 1분 늘리기">＋</button></span>
        </label>
        <label>늦을 때 <b>{prefs.doorHighMin}분</b>
          <span className="stepper"><button className="btn tiny" onClick={() => step('doorHighMin', -1)} aria-label="늦을 때 1분 줄이기">−</button><button className="btn tiny" onClick={() => step('doorHighMin', 1)} aria-label="늦을 때 1분 늘리기">＋</button></span>
        </label>
      </div>
      <p className="fine">{isDefault ? <>초깃값 {cal.lowMin}~{cal.highMin}분은 <b>{MEASURED_LABEL}</b> 값이에요.</> : '직접 바꾼 값이에요.'} 문을 나서서(건물 나가기·신호 포함) 정류장에 닿기까지예요. 계산은 가운데 값으로 하고, 출발 시각은 늦을 때 기준으로 잡아요. 따로 &lsquo;건물 나가기&rsquo; 시간은 더하지 않아요.</p>
      <p className="fine">다른 정류장은 직선거리 걷기 추정에 문~큰길 {minText(overheadSec)}(이 실측에서 걷기 추정을 뺀 값)을 더해요. 가는 길·오는 길은 따로 기억해요.</p>
      <div className="field"><span>걷는 속도 <span className="muted small">(실측 안 된 정류장·환승·도착 걷기에만)</span></span>
        <div className="seg-choice" role="radiogroup" aria-label="걷는 속도">
          {[{ v: 1.25, t: '느긋하게' }, { v: 1, t: '보통' }, { v: 0.85, t: '빠르게' }].map((o) => <button key={o.v} role="radio" aria-checked={prefs.walkMult === o.v} className={prefs.walkMult === o.v ? 'on' : ''} onClick={() => setPrefs({ ...prefs, walkMult: o.v })}>{o.t}</button>)}
        </div>
      </div>
      <p className="fine">걷는 시간 추정은 직선거리 × 1.3 ÷ 1.2m/s예요. 첫 승차 여유 1분, 환승 여유 2분이 기본으로 들어가요.</p>
      {journey.phase !== 'before' && <button className="btn ghost" onClick={() => setJourney({ phase: 'before' })}>진행 상태 초기화</button>}
    </div>
  );
}

/** 평소 경로 카드: '버스가 n정거장 전일 때 나가면 돼요' (실시간 남은 정거장·분 기준 어림) + 본인 경험 규칙 */
function LeaveByStops({ ev, cand, now, trip, settings }: { ev: ItineraryEvaluation; cand: CandidateRoute; now: number; trip: TripId; settings: Settings }) {
  const leg1 = cand.legs[0];
  const rule = RULE_OF_THUMB[trip];
  const ruleHere = rule && rule.routeNo === leg1.routeNo && rule.ars === leg1.board.ars ? rule : null;
  const v = ev.firstVehicle;
  const realtime = ev.firstBoardingEstimate?.evidenceKind === 'realtime_prediction';
  // 환승 쪽이 미확인이어도 첫 버스 기준 출발 마감은 계산 가능
  const fb = ev.firstBoardingEstimate, fw = ev.firstWalkEstimate;
  const leaveAt = ev.recommendedLeaveAt ?? (fb?.earliestAt != null && fw ? computeLeaveDeadline(fb.earliestAt, settings.buildingExitHighSec, fw.highSec, settings.firstBoardMarginSec) : null);
  const sa = realtime && leaveAt != null ? stopsAwayAtLeave(v, leaveAt, now) : null;
  const connUnsure = ev.feasibility !== 'comfortable' && ev.feasibility !== 'tight';
  const sample = ev.firstBoardingEstimate?.origin === 'sample';
  if (!sa && !ruleHere) return null;
  return (
    <div className="stops-helper" aria-label="몇 정거장 전에 나갈지">
      {sa ? (
        <p className="stops-main">🚏 {leg1.routeNo}번이 {sa.atLeave >= sa.now ? <>지금 <b>{sa.now}정거장 전</b>이에요 — 지금 나가면 돼요</> : <><b>{sa.atLeave}정거장 전</b>일 때 나가면 돼요 <span className="muted small">(지금 {sa.now}정거장 전)</span></>}</p>
      ) : (
        <p className="stops-main">🚏 {v?.remainingStops != null ? <>{leg1.routeNo}번 지금 {v.remainingStops}정거장 전 · </> : null}<b>{ruleHere!.text}</b></p>
      )}
      <p className="muted small">
        {sa ? <>{sample ? '예시값' : '실시간 예측'}의 남은 정거장·분으로 어림 · 문→정류장 늦을 때 + 승차 여유 1분 기준</> : '실시간 정거장 정보가 없어 본인 경험 규칙을 보여 드려요'}
        {ruleHere && sa && <> · 평소 규칙: {ruleHere.text}(본인 경험)</>}
        {ruleHere && !sa && <> · (본인 경험 규칙)</>}
        {sa && connUnsure && <> · 첫 버스 기준(환승 연결은 아직 미확인)</>}
      </p>
    </div>
  );
}

const FEAS: Record<string, string> = { comfortable: '여유 있음', tight: '촉박', infeasible: '연결 어려움', unobserved_next: '다음 차량 미확인', waiting: '운행대기', no_realtime: '실시간 판단 불가', stale: '정보 오래됨', not_applicable: '현재 진행과 맞지 않음' };
function OthersView({ evs, candById, openId, setOpenId, vehicles, routeStops, places, now, preferred, trip, settings }: {
  evs: ItineraryEvaluation[]; candById: (id: string) => CandidateRoute; openId: string | null; setOpenId: (id: string | null) => void;
  vehicles: Record<string, import('../shared/api').RouteVehicles>; routeStops: Record<string, import('../shared/api').RouteStop[]>; places: import('../shared/api').CandidatesPayload | null; now: number;
  preferred: import('../shared/preferences').PreferredRoute; trip: TripId; settings: Settings;
}) {
  if (evs.length === 0) return <p>더 보여드릴 후보가 없어요.</p>;
  return (
    <ul className="others">
      {evs.map((e) => { const c = candById(e.candidateId); const isOpen = openId === c.id; return (
        <li key={e.candidateId}>
          <Chips cand={c} />
          {c.id === preferred.candidateId && <div className="usual-note">⭐ {preferred.badge} · {preferred.note}</div>}
          {c.id === preferred.candidateId && <LeaveByStops ev={e} cand={c} now={now} trip={trip} settings={settings} />}
          <div className="muted small">{c.legs.map((l) => `${l.board.name}(${l.board.ars})→${l.alight.name}(${l.alight.ars})`).join(' · ')}</div>
          <div><span className="badge badge-alt">{FEAS[e.feasibility]}</span>{c.id === preferred.candidateId && <span className="badge badge-usual">⭐ {preferred.badge}</span>} {e.destinationEstimate ? `도착 ${hhmm(e.destinationEstimate.nominalAt)}` : '도착 미확정'} <span className="muted small">· 걷기+승차 약 {Math.round(c.staticTotalSec / 60)}분(추정, 기다림 제외)</span></div>
          {e.warnings.slice(0, 2).map((w) => <div key={w} className="muted small">{w}</div>)}
          <button className="btn tiny soft" aria-expanded={isOpen} onClick={() => setOpenId(isOpen ? null : c.id)}>{isOpen ? '접기 ▲' : '🚏 버스 위치 · 지도 ▼'}</button>
          {isOpen && (
            <div className="details">
              <Schematic cand={c} vehicles={vehicles} now={now} />
              {places && <Suspense fallback={<div className="map map-loading">지도를 불러오는 중…</div>}><TripMap cand={c} routeStops={routeStops} buses={buildSchematic(c, vehicles, now)} origin={places.origin} dest={places.destination} /></Suspense>}
            </div>
          )}
        </li>); })}
    </ul>
  );
}

function CrowdView({ ev, lookup, cand, now }: { ev: ItineraryEvaluation | null; lookup: (a: string, r: string) => ArrivalBoard | undefined; cand?: CandidateRoute; now: number }) {
  const seat = ev?.firstVehicle ? seatLabel(ev.firstVehicle.seats) : '탈 버스가 정해지면 보여드려요';
  void lookup; void cand;
  const people = crowdDisplay(null, 'people_area', now);
  const road = crowdDisplay(null, 'road', now);
  return (
    <div className="crowd">
      <div className="crowd-row"><b>🚌 버스 안</b><p>{seat}</p><p className="fine">부산 BIMS 잔여좌석(seat) 값이 −1이면 확인 불가로 표시해요. 0석은 ‘빈 좌석 없음’이지 만차라는 뜻은 아니에요.</p></div>
      <div className="crowd-row"><b>👥 주변 사람</b><p>{people.label}</p><p className="fine">이 경로의 정류장을 지금 측정하는 무료 공개 자료를 확인하지 못했어요. 행정동 월평균 같은 통계는 ‘지금 붐빔’으로 쓰지 않아요.</p></div>
      <div className="crowd-row"><b>🚗 도로 정체</b><p>{road.label}</p><p className="fine">버스 도착 예측에 이미 교통 상황이 들어가 있을 수 있어 따로 더하지 않아요. 지도 앱에서 직접 확인할 수 있어요.</p></div>
    </div>
  );
}

function InfoView({ snap, cands, now }: { snap: import('../shared/api').Snapshot | null; cands: import('../shared/api').CandidatesPayload | null; now: number }) {
  const v = snap?.verification ?? [];
  const ok = v.filter((x) => x.seqMatch).length;
  return (
    <div className="info">
      <p><b>실시간 연결:</b> {snap?.mode === 'live' ? '부산 BIMS 공공 API 정상 수신' : snap?.mode === 'live_degraded' ? '부산 BIMS 일부 응답 오류' : '키 없음/미등록 → 예시 모드'}</p>
      {snap && <p className="muted small">오늘 서버 호출 {snap.callsToday}회 · 갱신 주기 {snap.ttlSec}초 · 서버 시각 {hhmmss(snap.serverTime)}</p>}
      <p><b>정류장 순서 실시간 대조:</b> {v.length ? `${ok}/${v.length} 일치` : '아직 없음'}</p>
      {v.length > 0 && <details><summary>대조표 보기</summary><table className="vt"><thead><tr><th>ARS</th><th>노선</th><th>공식 순번</th><th>실시간</th></tr></thead><tbody>{v.map((x) => <tr key={x.ars + x.routeNo}><td>{x.ars}</td><td>{x.routeNo}</td><td>{x.expectedSeq ?? '—'}</td><td>{x.seqMatch == null ? '미수신' : x.seqMatch ? '✓' : `✗(${x.apiBstopidx})`}</td></tr>)}</tbody></table></details>}
      {snap?.routeInfo && snap.routeInfo.length > 0 && <details><summary>노선 첫차·막차(기점 기준)</summary><ul>{snap.routeInfo.map((r) => <li key={r.routeNo}>{r.routeNo}번 {r.startPoint}→{r.endPoint} · 첫차 {r.firstTime ?? '—'} · 막차 {r.endTime ?? '—'} <span className="muted small">(기점 출발, 이 정류장 통과시각 아님)</span></li>)}</ul></details>}
      <p><b>평소 경로:</b> 카톡으로 확인한 정류장·노선을 ‘평소 경로’로 표시해요. 비슷하게 도착하는 후보가 여럿이면 그 길을 우선하고, 연결이 안 되면 1순위로 올리지 않아요.</p>
      <p><b>후보 경로:</b> 부산시 공식 노선별 정류소 자료에서 출발·도착 주변 정류장을 잇는 직통·1회 환승 {cands?.candidates.length ?? 0}개를 만들었어요. 부산 모든 경로의 최적해는 아니에요.</p>
      <p className="muted small">자료: {cands?.source.name} · {cands?.source.note}</p>
      <p><b>추정인 것:</b> 버스 주행시간(정류장 간 거리 ÷ 평균 15km/h 가정), 걷는 시간, 건물 출입 시간. 같은 차량의 하류 예측이 맞물릴 때만 주행도 ‘실시간 예측’으로 표시해요.</p>
      <p><b>위치:</b> 출발·도착 좌표는 도로명 번호로 잡은 대략 위치예요. 건물 출입구는 아직 확인 안 됐어요.</p>
      <p className="muted small">지도 배경 © OpenStreetMap contributors (기본 타일을 옅게 보정) · 정류장 위치 링크는 카카오맵 공식 링크</p>
      <p className="muted small">현재 {hhmmss(now)} (한국 시간)</p>
    </div>
  );
}
