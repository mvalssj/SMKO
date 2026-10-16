// GP (50cc, Mario, Mushroom Cup: Mario Circuit 1): the 8 karts' places on the grid.
import { BTN } from './host.mjs';
import { createDspEmu } from './dsp-host.mjs';
import { Dsp1 } from './dsp1.mjs';
import { makeOps } from './dsp1-ops.mjs';
const [core, romPath] = process.argv.slice(2);
const emu = await createDspEmu(core, romPath, new Dsp1(makeOps()));
emu.run(900); emu.press(BTN.START, 4, 90);
emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 180);
emu.press(BTN.B, 4, 60); emu.press(BTN.B, 4, 240); emu.press(BTN.B, 4, 120);
emu.run(120);
const m = Buffer.from(emu.memory(2));
const out = [];
for (let k = 0; k < 8; k++) { const b = 0x1000 + k * 0x100; out.push(`kart${k}(${m[b + 0x12]}): ${m.readUInt16LE(b + 0x18)},${m.readUInt16LE(b + 0x1c)} ângulo ${m.readUInt16LE(b + 0x2a)}`); }
console.log(out.join('\n'));
emu.screenshot('fid2/dsp-grid.png', 1);
