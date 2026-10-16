// GP race (50cc, Mario): put item `item` in the held slot, use it, record WRAM $0C00-$1FFF every frame for 900
// frames; then find the counters that start counting down when it is used (and how long they last).
import { readFileSync, writeFileSync } from 'node:fs';
import { createEmu, withoutDsp, BTN } from './host.mjs';
const [core, romPath, item, out] = process.argv.slice(2);
const emu = await createEmu(core, withoutDsp(readFileSync(romPath)));
emu.run(900); emu.press(BTN.START, 4, 90);
emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 180);
emu.press(BTN.B, 4, 60); emu.press(BTN.B, 4, 240); emu.press(BTN.B, 4, 120);
emu.run(600);
emu.run(200, 1 << BTN.B);
const M = emu.M, wp = M._retro_get_memory_data(2);
const A0 = 0x0c00, A1 = 0x2000;
const frames = [];
const snap = () => frames.push(Buffer.from(M.HEAPU8.slice(wp + A0, wp + A1)));
for (let i = 0; i < 30; i++) { emu.run(1, 1 << BTN.B); snap(); }
M.HEAPU8[wp + 0x0d70] = +item; M.HEAPU8[wp + 0x0d71] = 0xc0;
emu.run(2, 1 << BTN.B); snap(); snap();
const useAt = frames.length;
for (let i = 0; i < 6; i++) { emu.run(1, (1 << BTN.B) | (1 << BTN.A)); snap(); }
for (let i = 0; i < 900; i++) { emu.run(1, 1 << BTN.B); snap(); }
// Counters: a byte (or little-endian word) unchanged before the use, then going down steadily to a stop.
const found = [];
for (let o = 0; o < A1 - A0 - 1; o++) {
  for (const word of [false, true]) {
    const v = (f) => word ? frames[f][o] | (frames[f][o + 1] << 8) : frames[f][o];
    const before = v(useAt - 3);
    let start = -1;
    for (let f = useAt - 2; f < useAt + 10; f++) if (v(f) !== before) { start = f; break; }
    if (start < 0) continue;
    let f = start, steps = 0, lastV = v(start);
    const top = v(start);
    if (top < 8) continue;
    let ok = true, end = -1;
    for (f = start + 1; f < frames.length; f++) {
      const x = v(f);
      if (x === lastV) continue;
      if (x < lastV && lastV - x <= 2) { steps++; lastV = x; if (x === 0) { end = f; break; } continue; }
      ok = false; break;
    }
    if (ok && end > 0 && steps >= 8) found.push({ addr: '$' + (A0 + o).toString(16), word, from: top, frames: end - start, startsAfterUse: start - useAt });
  }
}
const speed = frames.map((b) => (b[0x10ea - A0] | (b[0x10eb - A0] << 8)) << 16 >> 16);
writeFileSync(out, JSON.stringify({ found, speed: speed.slice(useAt - 5, useAt + 300), useAt })); writeFileSync(out + '.bin', Buffer.concat(frames));
console.log('item', item, JSON.stringify(found.filter((x) => !x.word || !found.some((y) => !y.word && y.addr === x.addr)).slice(0, 12)));
