// GP: put the player on an item box (MC1, tiles 6-7 x 32-33) and watch the box's map tile (Mode 7 VRAM) and the
// held item over the next frames.
import { readFileSync } from 'node:fs';
import { createEmu, withoutDsp, BTN } from './host.mjs';
const [core, romPath] = process.argv.slice(2);
const emu = await createEmu(core, withoutDsp(readFileSync(romPath)));
emu.run(900); emu.press(BTN.START, 4, 90);
emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 180);
emu.press(BTN.B, 4, 60); emu.press(BTN.B, 4, 240); emu.press(BTN.B, 4, 120);
emu.run(600);
const M = emu.M, wp = M._retro_get_memory_data(2);
const tile = (tx, ty) => Buffer.from(emu.memory(3))[(ty * 128 + tx) * 2];
console.log('tiles da caixa antes', tile(6, 32), tile(7, 32), tile(6, 33), tile(7, 33), 'item', M.HEAPU8[wp + 0xd70], M.HEAPU8[wp + 0xd71].toString(16));
const put = (x, y) => { M.HEAPU8[wp + 0x1018] = x & 255; M.HEAPU8[wp + 0x1019] = x >> 8; M.HEAPU8[wp + 0x101c] = y & 255; M.HEAPU8[wp + 0x101d] = y >> 8; };
for (let i = 0; i < 6; i++) { put(56, 264); emu.run(1); }
put(200, 600);
let last = '';
const pressAt = +(process.argv[4] ?? 30);
for (let f = 0; f < 400; f++) {
  emu.run(1, f >= pressAt && f < pressAt + 4 ? 1 << BTN.A : 0);
  const s = `${tile(6, 32)},${tile(7, 32)},${tile(6, 33)},${tile(7, 33)} estado ${M.HEAPU8[wp + 0xd71].toString(16)}${M.HEAPU8[wp + 0xd71] !== 0xa0 ? " item " + M.HEAPU8[wp + 0xd70] : ""}`;
  if (s !== last) { console.log('quadro', f, s); last = s; }
}
