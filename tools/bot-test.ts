// Dev check: a bot follows the AI path on every GP track and must complete all laps.
// Usage: npx tsx tools/bot-test.ts "<rom.sfc>"
import { readFileSync } from 'node:fs';
import { SmkRom } from '../src/rom/rom';
import { createKart, raceGeometry, stepKart } from '../src/game/physics';
import { TOTAL_LAPS } from '../shared/protocol';
import { Bot } from './bot';

const rom = new SmkRom(new Uint8Array(readFileSync(process.argv[2])));
let failures = 0;
for (const info of rom.tracks.filter((t) => !t.battle)) {
  const track = rom.loadTrack(info);
  const geo = raceGeometry(track);
  const k = createKart(track, 0);
  const bot = new Bot(track, geo, k);
  let falls = 0, frames = 0;
  while (k.lap <= TOTAL_LAPS && frames < 60 * 60 * 6) {
    const wasFalling = k.fall > 0;
    stepKart(k, bot.input(k), track, geo, [], frames);
    if (!wasFalling && k.fall > 0) falls++;
    frames++;
  }
  const ok = k.lap > TOTAL_LAPS;
  if (!ok) failures++;
  console.log(`${ok ? 'OK  ' : 'FAIL'} ${info.name.padEnd(16)} voltas=${Math.min(k.lap, TOTAL_LAPS + 1) - 1}/${TOTAL_LAPS} tempo=${(frames / 60).toFixed(1)}s quedas=${falls} parou em ${Math.round(k.x)},${Math.round(k.y)}`);
}
process.exit(failures ? 1 : 0);
