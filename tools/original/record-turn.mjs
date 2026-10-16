// Heading rate ($102A delta) per frame: normal turn, release, drift turn (R), release; also at low speed.
import { readFileSync, writeFileSync } from 'node:fs';
import { createEmu, withoutDsp, BTN } from './host.mjs';
const [core, romPath, out, sel] = process.argv.slice(2);
const emu = await createEmu(core, withoutDsp(readFileSync(romPath)));
emu.run(900); emu.press(BTN.START, 4, 90);
emu.press(BTN.B, 4, 120); emu.press(BTN.DOWN, 4, 30); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 180);
for (const c of sel) emu.press(c === 'R' ? BTN.RIGHT : BTN.DOWN, 4, 20);
emu.press(BTN.B, 4, 60); emu.press(BTN.B, 4, 240); emu.press(BTN.B, 4, 120); emu.press(BTN.B, 4, 120);
emu.run(360);
const B = 1 << BTN.B, R = 1 << BTN.RIGHT, RB = 1 << BTN.R;
const seq = [[B, 40], [B | R, 40], [B, 40], [B, 400], [B | R, 120], [B, 80], [B | R | RB, 100], [B, 80], [B | RB, 10], [B, 60]];
const rows = [];
for (const [b, n] of seq) for (let i = 0; i < n; i++) { emu.run(1, b); const m = Buffer.from(emu.memory(2)); rows.push([b, m.readUInt16LE(0x102a), m.readInt16LE(0x10aa), m.readInt16LE(0x10ea), m.readUInt16LE(0x10ca), m.readUInt16LE(0x10a6), m.readUInt8(0x101f), m.readUInt16LE(0x10a0)]); }
writeFileSync(out, JSON.stringify(rows));
