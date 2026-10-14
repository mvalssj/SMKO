// Dev tool: draws the race HUD and Lakitu states to PNGs (over a gray race view) to check them by eye
// against the original screen.
// Usage: npx tsx tools/hud-preview.ts "<rom.sfc>" <out-dir>
import { readFileSync } from 'node:fs';
import { SmkRom } from '../src/rom/rom';
import { loadRaceGfx } from '../src/rom/race-gfx';
import { Layer } from '../src/game/layer';
import { HORIZON, MAP_BOTTOM, MAP_TOP, RaceHud, SKY_TOP, VIEW_BOTTOM, type LakituShow } from '../src/game/hud';
import { savePng } from './ppu-check';

const rom = new SmkRom(new Uint8Array(readFileSync(process.argv[2])));
const out = process.argv[3];
const track = rom.loadTrack(rom.tracks[0]);
const gfx = loadRaceGfx(rom)!;
const layer = new Layer(gfx.obj, gfx.hud, track.colors);
const hud = new RaceHud(layer);

function shot(name: string, draw: () => void) {
  layer.clear();
  draw();
  const img = new Uint8Array(256 * 224 * 4);
  for (let y = 0; y < 224; y++) {
    const bg = y < SKY_TOP ? [0, 0, 0] : y < HORIZON ? [248, 232, 144] : y < VIEW_BOTTOM ? [96, 96, 96] : y < MAP_TOP ? [0, 0, 0] : y < MAP_BOTTOM ? [160, 148, 96] : [0, 0, 0];
    for (let x = 0; x < 256; x++) {
      const p = (y * 256 + x) * 4, a = layer.px[p + 3] / 255;
      for (let k = 0; k < 3; k++) img[p + k] = layer.px[p + k] * a + bg[k] * (1 - a);
      img[p + 3] = 255;
    }
  }
  savePng(`${out}/${name}.png`, img);
}

const base = (lap: number, ms: number) => { hud.timer(lap, ms); hud.coins(5); hud.place(8); };
const lak = (s: LakituShow, frame = 0) => () => { base(1, 0); hud.lakitu(s, frame); };
shot('start-descendo', lak({ kind: 'start', t: -250 }));
shot('start-vermelho1', lak({ kind: 'start', t: -100 }));
shot('start-verde', lak({ kind: 'start', t: 5 }));
shot('start-saindo', lak({ kind: 'start', t: 100 }));
shot('volta-2', () => { base(2, 61234); hud.lakitu({ kind: 'lap', lap: 2, t: Number(process.env.FLAG_T ?? 120) }, 0); });
shot('volta-final', () => { base(5, 241234); hud.lakitu({ kind: 'lap', lap: 5, t: Number(process.env.FLAG_T ?? 120) }, 0); });
shot('chegada', () => { base(5, 301234); hud.finishOrder([{ place: 1, character: 0, palette: 1 }, { place: 2, character: 7, palette: 0 }], Number(process.env.FLAG_T ?? 120)); hud.lakitu({ kind: 'finish', t: Number(process.env.FLAG_T ?? 120) }, 0); });
shot('contramao', () => { base(3, 101234); hud.lakitu({ kind: 'reverse', t: 120 }, 0); });
shot('resgate', () => { base(3, 101234); hud.lakitu({ kind: 'rescue', t: 60, x: 128, y: 101 }, 0); });
shot('cabecas', () => { for (let c = 0; c < 8; c++) hud.head(c, 24 + c * 28, 160, [1, 2, 0, 3, 3, 2, 1, 0][c]); });
