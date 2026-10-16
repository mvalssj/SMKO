// GP, at the green light: fire item `item`, follow the objects ($1800-$1FFF, $100 apart; x +$18, y +$1C) and
// the karts frame by frame.
import { writeFileSync } from 'node:fs';
import { BTN } from './host.mjs';
import { createDspEmu } from './dsp-host.mjs';
import { Dsp1 } from './dsp1.mjs';
import { makeOps } from './dsp1-ops.mjs';
const [core, romPath, item = '4', frames = '120', out = 'fid2/obj.json', hold = ''] = process.argv.slice(2);
const emu = await createDspEmu(core, romPath, new Dsp1(makeOps()));
emu.run(900); emu.press(BTN.START, 4, 90);
emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 180);
emu.press(BTN.B, 4, 60); emu.press(BTN.B, 4, 240); emu.press(BTN.B, 4, 120);
emu.run(384);
const M = emu.M, wp = M._retro_get_memory_data(2);
M.HEAPU8[wp + 0x0d70] = +item; M.HEAPU8[wp + 0x0d71] = 0xc0;
const rows = [];
const snap = () => { rows.push(Buffer.from(emu.memory(2)).subarray(0x1000, 0x2000).toString('base64')); };
emu.run(2); snap();
const btn = hold === 'down' ? (1 << BTN.A) | (1 << BTN.DOWN) : 1 << BTN.A;
for (let i = 0; i < 4; i++) { emu.run(1, btn); snap(); }
for (let i = 0; i < +frames; i++) { emu.run(1); snap(); }
writeFileSync(out, JSON.stringify(rows));
const at = (i) => Buffer.from(rows[i], 'base64');
for (let i = 0; i < rows.length; i += 6) {
  const b = at(i);
  const objs = [];
  for (let o = 0x800; o < 0x1000; o += 0x100) { const x = b.readUInt16LE(o + 0x18), y = b.readUInt16LE(o + 0x1c); if (x || y) objs.push(`$${(0x1000 + o).toString(16)}:${x},${y}`); }
  console.log(i, 'kart2', b.readUInt16LE(0x218), b.readUInt16LE(0x21c), 'v', b.readInt16LE(0x2ea), '| objetos', objs.join(' '));
}
