import { probeBilibili } from '../src/engines/bilibili';

const url = 'BV1j5nj68E48';
const mode = process.env.VDL_TS_HELPER === '1' ? 'helper' : 'exe';

for (let i = 0; i < 3; i += 1) {
  const started = performance.now();
  const res = await probeBilibili(url);
  const ms = Math.round(performance.now() - started);
  console.log(`${mode} run${i + 1}: ${ms}ms  formats=${res.formats.length}`);
}
process.exit(0);
