// GP race (50cc, Mario), with the DSP-1 answered: at the green light Mario takes a star and drives straight on
// into the karts ahead; record every kart's bytes ($1000 + k * $100) for `frames` frames.
import { writeFileSync } from 'node:fs';
import { BTN } from './host.mjs';
import { createDspEmu } from './dsp-host.mjs';
import { Dsp1 } from './dsp1.mjs';
import { makeOps } from './dsp1-ops.mjs';
const [core, romPath, out, frames = '400', item = '2'] = process.argv.slice(2);
const emu = await createDspEmu(core, romPath, new Dsp1(makeOps()));
emu.run(900); emu.press(BTN.START, 4, 90);
emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 180);
emu.press(BTN.B, 4, 60); emu.press(BTN.B, 4, 240); emu.press(BTN.B, 4, 120);
emu.run(384);
const M = emu.M, wp = M._retro_get_memory_data(2);
M.HEAPU8[wp + 0x0d70] = +item; M.HEAPU8[wp + 0x0d71] = 0xc0;
emu.run(2);
const rows = [];
const snap = () => rows.push([...M.HEAPU8.slice(wp + 0x1000, wp + 0x1800)]);
for (let i = 0; i < 4; i++) { emu.run(1, (1 << BTN.B) | (1 << BTN.A)); snap(); }
for (let i = 0; i < +frames; i++) { emu.run(1, 1 << BTN.B); snap(); }
writeFileSync(out, JSON.stringify(rows));
const w = (r, k, o) => (r[k * 0x100 + o] | (r[k * 0x100 + o + 1] << 8)) << 16 >> 16;
for (let i = 0; i < rows.length; i += 8) console.log(i, Array.from({ length: 8 }, (_, k) => `${w(rows[i], k, 0x18)},${w(rows[i], k, 0x1c)} v${w(rows[i], k, 0xea)} h${w(rows[i], k, 0x2a) & 0xffff}`).join(' | '));
