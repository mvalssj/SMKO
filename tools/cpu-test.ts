// Dev check: a full grid of 8 CPUs (kart collisions, rubber band) races every GP track.
// Kart 0 plays the "human" (full skill, no rubber band). Usage: npx tsx tools/cpu-test.ts "<rom.sfc>"
import { readFileSync } from 'node:fs';
import { SmkRom } from '../src/rom/rom';
import { createKart, raceGeometry, stepKart } from '../src/game/physics';
import { CpuDriver, rubberBand } from '../src/game/cpu';
import { TOTAL_LAPS } from '../shared/protocol';

const rom = new SmkRom(new Uint8Array(readFileSync(process.argv[2])));
let total = 0, done = 0;
for (const info of rom.tracks.filter((t) => !t.battle)) {
  const track = rom.loadTrack(info);
  const geo = raceGeometry(track);
  const karts = Array.from({ length: 8 }, (_, slot) => createKart(track, slot));
  const drivers = karts.map((k, i) => new CpuDriver(track, k, i === 0 ? 1 : 0.55 + (i / 7) * 0.45));
  const finish: number[] = Array(8).fill(0);
  let f = 0;
  for (; f < 60 * 60 * 6 && finish.some((x) => !x); f++) {
    const human = karts[0].progress;
    karts.forEach((k, i) => {
      if (i > 0) k.speedScale = rubberBand(drivers[i].skill, k.progress - human);
      stepKart(k, drivers[i].input(k), track, geo, karts.filter((o) => o !== k && o.fall === 0), f);
      if (k.lap > TOTAL_LAPS && !finish[i]) finish[i] = f;
    });
  }
  const n = finish.filter(Boolean).length;
  total += 8; done += n;
  const times = finish.map((x) => (x ? (x / 60).toFixed(0) + 's' : '--')).join(' ');
  console.log(`${n === 8 ? 'OK  ' : n >= 6 ? 'OK~ ' : 'FAIL'} ${info.name.padEnd(16)} ${n}/8 terminaram  [${times}]`);
}
console.log(`Total: ${done}/${total} CPUs terminaram`);
