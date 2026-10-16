// GP race (50cc, Mario), with the DSP-1 answered: drive a while, use the lightning, record the karts' speed
// ($EA), heading ($2A), slide ($AA) and all their bytes for 700 frames (karts at $1000 + k * $100).
import { writeFileSync } from 'node:fs';
import { BTN } from './host.mjs';
import { createDspEmu } from './dsp-host.mjs';
import { Dsp1 } from './dsp1.mjs';
import { makeOps } from './dsp1-ops.mjs';
const [core, romPath, out] = process.argv.slice(2);
const emu = await createDspEmu(core, romPath, new Dsp1(makeOps()));
emu.run(900); emu.press(BTN.START, 4, 90);
emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 180);
emu.press(BTN.B, 4, 60); emu.press(BTN.B, 4, 240); emu.press(BTN.B, 4, 120);
emu.run(384);
const M = emu.M, wp = M._retro_get_memory_data(2);
emu.run(240, 1 << BTN.B);
M.HEAPU8[wp + 0x0d70] = 8; M.HEAPU8[wp + 0x0d71] = 0xc0;
emu.run(2, 1 << BTN.B);
const rows = [];
const snap = () => rows.push([...M.HEAPU8.slice(wp + 0x1000, wp + 0x1800)]);
for (let i = 0; i < 4; i++) { emu.run(1, (1 << BTN.B) | (1 << BTN.A)); snap(); }
for (let i = 0; i < 700; i++) { emu.run(1, 1 << BTN.B); snap(); }
writeFileSync(out, JSON.stringify(rows));
const w = (r, k, o) => (r[k * 0x100 + o] | (r[k * 0x100 + o + 1] << 8)) << 16 >> 16;
for (let i = 0; i < rows.length; i += 10) console.log(i, [0, 1, 2, 3].map((k) => `${w(rows[i], k, 0xea)}/${w(rows[i], k, 0x2a) & 0xffff}/${w(rows[i], k, 0xaa)}`).join('  '));
