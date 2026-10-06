import fs from 'node:fs';
import path from 'node:path';
import { loadEnv } from '../server/env';
import { BimsClient } from '../server/bimsClient';
const root = path.resolve(import.meta.dirname, '..');
loadEnv(root);
const c = new BimsClient(process.env.BUSAN_BIMS_SERVICE_KEY);
const save = (n: string, t: string) => fs.writeFileSync(path.join(root, 'data/samples', n), t);
const ts = Math.floor(Date.now() / 1000);
let r = await c.call('busStopArrByBstopidLineid', { bstopid: '193420201', lineid: '5200036000' });
save(`busStopArrByBstopidLineid_13051_36_${ts}.xml`, r.rawRedacted);
console.log('lineid op', r.resultCode, JSON.stringify(r.items));
for (const no of ['36', '43', '29']) {
  r = await c.call('busInfo', { lineno: no });
  save(`busInfo_${no}.xml`, r.rawRedacted);
  console.log('busInfo', no, r.resultCode, JSON.stringify(r.items.filter((i) => i.buslinenum === no || i.lineno === no || true).slice(0, 3)));
}
