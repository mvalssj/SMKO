// Time trial start position: cup `c` (LEFT, DOWN c times, RIGHT), course `t` (DOWN t times).
import { readFileSync } from 'node:fs';
import { createEmu, withoutDsp, BTN } from './host.mjs';
const [core, romPath, c = '0', t = '0'] = process.argv.slice(2);
const emu = await createEmu(core, withoutDsp(readFileSync(romPath)));
emu.run(900); emu.press(BTN.START, 4, 90);
emu.press(BTN.B, 4, 120); emu.press(BTN.DOWN, 4, 30); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 180);
emu.press(BTN.B, 6, 150); emu.press(BTN.B, 6, 150); emu.run(120);
if (+c) { emu.press(BTN.LEFT, 6, 60); for (let i = 0; i < +c; i++) emu.press(BTN.DOWN, 6, 60); emu.press(BTN.RIGHT, 6, 60); }
for (let i = 0; i < +t; i++) emu.press(BTN.DOWN, 6, 60);
emu.press(BTN.B, 6, 150); emu.press(BTN.B, 6, 150);
emu.run(200);
const m = Buffer.from(emu.memory(2));
console.log(`copa ${c} pista ${t}: x ${m.readUInt16LE(0x1018)} y ${m.readUInt16LE(0x101c)}`);
