// GP race (50cc, Mario), with the DSP-1 answered from here: drive, drop a banana, then put the kart (at speed)
// 24 px before it on its heading and record speed, heading ($2A), slide ($AA) and the kart's bytes for 260 frames.
import { writeFileSync } from 'node:fs';
import { BTN } from './host.mjs';
import { createDspEmu } from './dsp-host.mjs';
import { Dsp1 } from './dsp1.mjs';
import { makeOps } from './dsp1-ops.mjs';
const [core, romPath, out, ahead = '24'] = process.argv.slice(2);
const emu = await createDspEmu(core, romPath, new Dsp1(makeOps()));
emu.run(900); emu.press(BTN.START, 4, 90);
emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 180);
emu.press(BTN.B, 4, 60); emu.press(BTN.B, 4, 240); emu.press(BTN.B, 4, 120);
emu.run(384);
const M = emu.M, wp = M._retro_get_memory_data(2);
const r16 = (a) => (M.HEAPU8[wp + a] | (M.HEAPU8[wp + a + 1] << 8)) << 16 >> 16;
const w16 = (a, v) => { M.HEAPU8[wp + a] = v & 255; M.HEAPU8[wp + a + 1] = (v >> 8) & 255; };
const objs = () => { const o = []; for (let a = 0x1800; a < 0x2000; a += 0x100) o.push([a.toString(16), r16(a + 0x18), r16(a + 0x1c)]); return o; };
emu.run(150, 1 << BTN.B);
console.log('driving', r16(0x1018), r16(0x101c), r16(0x10ea));
const before = objs();
M.HEAPU8[wp + 0x0d70] = 3; M.HEAPU8[wp + 0x0d71] = 0xc0;
emu.run(2, 1 << BTN.B);
for (let i = 0; i < 4; i++) emu.run(1, (1 << BTN.B) | (1 << BTN.A));
emu.run(+(process.argv[6] ?? 60), 1 << BTN.B);
console.log("obj 1a00", [...M.HEAPU8.slice(wp + 0x1a00, wp + 0x1a40)].join(","));
const kx = r16(0x1018), ky = r16(0x101c), head = r16(0x102a) & 0xffff;
const moved = objs().filter((o, i) => o[1] !== before[i][1] || o[2] !== before[i][2]);
const ban = moved.sort((a, b) => Math.hypot(a[1] - kx, a[2] - ky) - Math.hypot(b[1] - kx, b[2] - ky)).pop();
console.log('kart', kx, ky, 'v', r16(0x10ea), 'head', head, 'changed', JSON.stringify(moved), 'banana?', ban);
const a = (head / 65536) * 2 * Math.PI;
const sx = Math.round(ban[1] - Math.sin(a) * +ahead), sy = Math.round(ban[2] + Math.cos(a) * +ahead);
const rows = [];
for (let f = 0; f < 260; f++) {
  if (f < 1) { w16(0x1018, sx); w16(0x101c, sy); if (process.argv[7]) w16(0x10ea, +process.argv[7]); }
  emu.run(1, 1 << BTN.B);
  rows.push({ f, x: r16(0x1018), y: r16(0x101c), speed: r16(0x10ea), head: r16(0x102a) & 0xffff, slide: r16(0x10aa), kart: [...M.HEAPU8.slice(wp + 0x1000, wp + 0x1100)] });
}
writeFileSync(out, JSON.stringify({ banana: ban, rows }));
for (const r of rows.filter((_, i) => i % 4 === 0 && i < 160)) console.log(r.f, r.x, r.y, r.speed, r.head, r.slide);
