// 귀여운 버스 캐릭터 (인라인 SVG)
export function BusBuddy({ size = 40, color = '#7cc6a4', mood = 'happy', label }: { size?: number; color?: string; mood?: 'happy' | 'sleepy' | 'worried'; label?: string }) {
  return (
    <svg width={size} height={size} viewBox="0 0 64 64" role={label ? 'img' : 'presentation'} aria-label={label} aria-hidden={label ? undefined : true}>
      <rect x="6" y="10" width="52" height="40" rx="14" fill={color} />
      <rect x="12" y="16" width="40" height="15" rx="6" fill="#fffdf7" />
      {mood === 'sleepy' ? (
        <g stroke="#3b3355" strokeWidth="2.4" strokeLinecap="round"><path d="M21 37 q3 2 6 0" fill="none" /><path d="M37 37 q3 2 6 0" fill="none" /></g>
      ) : (
        <g fill="#3b3355"><circle cx="24" cy="37" r="3" /><circle cx="40" cy="37" r="3" /><circle cx="25" cy="36" r="1" fill="#fff" /><circle cx="41" cy="36" r="1" fill="#fff" /></g>
      )}
      <circle cx="17" cy="42" r="3" fill="#ff9fb2" opacity=".75" />
      <circle cx="47" cy="42" r="3" fill="#ff9fb2" opacity=".75" />
      {mood === 'worried' ? <path d="M29 45 q3 -2 6 0" stroke="#3b3355" strokeWidth="2" fill="none" strokeLinecap="round" /> : <path d="M28 43 q4 4 8 0" stroke="#3b3355" strokeWidth="2" fill="none" strokeLinecap="round" />}
      <circle cx="18" cy="52" r="5" fill="#3b3355" /><circle cx="46" cy="52" r="5" fill="#3b3355" />
      <circle cx="18" cy="52" r="2" fill="#d9d4ea" /><circle cx="46" cy="52" r="2" fill="#d9d4ea" />
    </svg>
  );
}

const ROUTE_COLORS = ['#7cc6a4', '#f6a6b9', '#9db8f2', '#f5c26b', '#b9a3ea', '#7fd0d8'];
export function routeColor(routeNo: string): string {
  if (routeNo === '36') return '#7cc6a4';
  if (routeNo === '43') return '#9db8f2';
  if (routeNo === '29') return '#f6a6b9';
  let h = 0; for (const c of routeNo) h = (h * 31 + c.charCodeAt(0)) >>> 0;
  return ROUTE_COLORS[h % ROUTE_COLORS.length];
}
