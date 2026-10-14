// Dev tool: renders every track of a ROM to PNG (with start grid, lap line and AI path) to check the ROM reader.
// Usage: npm run dump-track -- "<rom.sfc>" <out-dir>

import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { deflateSync } from 'node:zlib';
import { MAP_PX, SmkRom, crc32 } from '../src/rom/rom';

const [romPath, outDir = 'track-dump'] = process.argv.slice(2);
if (!romPath) {
  console.error('Uso: npm run dump-track -- "<rom.sfc>" [pasta-saida]');
  process.exit(1);
}

const rom = new SmkRom(new Uint8Array(readFileSync(romPath)));
console.log(`Região ${rom.region}, CRC32 ${rom.crc.toString(16)}`);
mkdirSync(outDir, { recursive: true });

for (const info of rom.tracks) {
  const t = rom.loadTrack(info);
  const px = t.pixels;
  const dot = (x: number, y: number, r: number, g: number, b: number, size = 3) => {
    for (let dy = -size; dy <= size; dy++)
      for (let dx = -size; dx <= size; dx++) {
        const X = Math.round(x) + dx, Y = Math.round(y) + dy;
        if (X < 0 || Y < 0 || X >= MAP_PX || Y >= MAP_PX) continue;
        const p = (Y * MAP_PX + X) * 4;
        px[p] = r; px[p + 1] = g; px[p + 2] = b;
      }
  };
  t.path.forEach((p) => dot(p.x, p.y, 0, 255, 255, 2));
  if (t.lapLine) for (let x = 0; x < t.lapLine.length; x++) dot(t.lapLine.x + x, t.lapLine.y, 255, 0, 255, 1);
  for (const o of t.objects) dot(o.x, o.y, 255, 255, 0, 5);
  if (t.start) for (let k = 0; k < 8; k++) dot(t.start.x + (k % 2) * t.start.secondRowOffset, t.start.y + k * 24, 255, 0, 0);
  const file = join(outDir, `${String(info.index).padStart(2, '0')}-${info.name.replace(/\s+/g, '_')}.png`);
  writeFileSync(file, png(MAP_PX, MAP_PX, px));
  console.log(`${info.name.padEnd(16)} idx=${info.index} tema=${t.theme} caminho=${t.path.length} largada=${JSON.stringify(t.start)} chegada=${JSON.stringify(t.lapLine)}`);
}

function png(w: number, h: number, rgba: Uint8Array): Buffer {
  const raw = Buffer.alloc((w * 4 + 1) * h);
  for (let y = 0; y < h; y++) Buffer.from(rgba.buffer, rgba.byteOffset + y * w * 4, w * 4).copy(raw, y * (w * 4 + 1) + 1);
  const chunk = (type: string, data: Buffer) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length);
    const td = Buffer.concat([Buffer.from(type), data]);
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(td));
    return Buffer.concat([len, td, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 6;
  return Buffer.concat([Buffer.from([137, 80, 78, 71, 13, 10, 26, 10]), chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw)), chunk('IEND', Buffer.alloc(0))]);
}
