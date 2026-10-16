// Dev tool: a bot drives a course and the 1P race screen is rendered in software (same math as the WebGL
// shader) every few seconds, with drivers, track objects, HUD and course map, to check the picture by eye.
// Usage: npx tsx tools/race-preview.ts "<rom.sfc>" <out-dir> [track index] [seconds between shots]
import { readFileSync } from 'node:fs';
import { CHARACTERS, MAP_PX, BG_BACK_W, BG_FRONT_W, BG_HEIGHT, SmkRom } from '../src/rom/rom';
import { loadRaceGfx } from '../src/rom/race-gfx';
import { createKart, isBoosting, kartFacing, kartHeight, raceGeometry, stepKart, terrainAt } from '../src/game/physics';
import { objectState } from '../src/game/objects';
import { Layer } from '../src/game/layer';
import { HORIZON, MAP_BOTTOM, MAP_TOP, RaceHud, SKY_TOP, VIEW_BOTTOM } from '../src/game/hud';
import {
  CHASE_DISTANCE, MAP_SCALE, MAP_TILT, VIEW, drawRaceView, floorLine, mapPoint, withRowHeights, type Camera,
} from '../src/game/renderer';
import { Bot } from './bot';
import { savePng } from './ppu-check';

const rom = new SmkRom(new Uint8Array(readFileSync(process.argv[2])));
const out = process.argv[3];
// BATTLE=1: the battle courses instead (balloons over the kart).
const battle = process.env.BATTLE === '1';
const info = rom.tracks.filter((t) => t.battle === battle)[Number(process.argv[4] ?? 0)];
const every = Number(process.argv[5] ?? 4) * 60;
const track = rom.loadTrack(info);
const geo = raceGeometry(track);
const gfx = loadRaceGfx(rom)!;
const layer = new Layer(gfx.obj, gfx.hud, track.colors);
const hud = new RaceHud(layer);
const drivers = new Map([[0, withRowHeights(rom.loadDriverSprites(0, track.colors)!)]]);
const kart = createKart(track, 0);
const bot = new Bot(track, geo, kart);
const cam: Camera = { x: 0, y: 0, angle: kart.angle };

function floorAt(x: number, y: number): number[] {
  if (x < 0 || y < 0 || x >= MAP_PX || y >= MAP_PX) {
    const p = ((Math.floor(((y % 8) + 8) % 8)) * 8 + Math.floor(((x % 8) + 8) % 8)) * 4;
    return [track.fill[p], track.fill[p + 1], track.fill[p + 2]];
  }
  const p = (Math.floor(y) * MAP_PX + Math.floor(x)) * 4;
  return [track.pixels[p], track.pixels[p + 1], track.pixels[p + 2]];
}

function render(frame: number, name: string) {
  const img = new Uint8Array(256 * 224 * 4);
  const turn = cam.angle / (Math.PI * 2);
  for (let sy = 0; sy < 224; sy++) {
    for (let sx = 0; sx < 256; sx++) {
      let c = [0, 0, 0];
      if (sy >= SKY_TOP && sy < HORIZON) {
        c = [...track.backColor];
        const by = sy - (HORIZON - BG_HEIGHT);
        for (const [bg, w, scroll] of [[track.background.back, BG_BACK_W, turn * BG_BACK_W], [track.background.front, BG_FRONT_W, turn * BG_FRONT_W]] as const) {
          const bx = ((Math.floor(sx + scroll) % w) + w) % w, p = (by * w + bx) * 4;
          if (bg[p + 3]) c = [bg[p], bg[p + 1], bg[p + 2]];
        }
      } else if (sy >= HORIZON && sy < VIEW_BOTTOM && floorLine(VIEW, sy)) {
        const line = floorLine(VIEW, sy)!;
        const z = line.ahead, lat = (sx + 0.5 - 128) * line.across;
        c = floorAt(cam.x + Math.sin(cam.angle) * z + Math.cos(cam.angle) * lat, cam.y - Math.cos(cam.angle) * z + Math.sin(cam.angle) * lat);
      } else if (sy >= MAP_TOP && sy < MAP_BOTTOM) {
        const t = (sy - MAP_TOP + 0.5) / (MAP_BOTTOM - MAP_TOP);
        const wy = MAP_PX * t * (1 + MAP_TILT) / (1 + MAP_TILT * t);
        const scale = MAP_SCALE * (1 + MAP_TILT) / (1 + MAP_TILT * t);
        c = floorAt(MAP_PX / 2 + (sx + 0.5 - 128) * scale, wy);
      }
      img.set([c[0], c[1], c[2], 255], (sy * 256 + sx) * 4);
    }
  }
  layer.clear();
  layer.setClip(HORIZON, VIEW_BOTTOM);
  const objects = track.objects.flatMap((o, i) => {
    const st = objectState(o.kind, i, frame);
    return st.visible ? [{ x: o.x, y: o.y, lift: st.height, frame: Math.floor(frame / 8) % Math.max(1, track.objectFrames.length) }] : [];
  });
  drawRaceView(layer, cam, [{
    x: kart.x, y: kart.y, angle: kartFacing(kart), character: 0, lift: kartHeight(kart),
    smoke: Math.abs(kart.slide) > 0.3 && kart.speed > 2, dust: kart.speed > 1 && terrainAt(track, kart.x, kart.y) === 'slow', boost: isBoosting(kart), balloons: battle ? 3 : 0,
  }], objects,
    { drivers, objectFrames: track.objectFrames, objectSizes: track.objectSizes, itemFrames: [] }, frame);
  layer.setClip(MAP_TOP, MAP_BOTTOM);
  const p = mapPoint(kart.x, kart.y);
  if (p) hud.head(0, p.x, p.y, CHARACTERS[0].palette - 8);
  layer.setClip();
  hud.timer(Math.max(1, kart.lap), (frame * 1000) / 60);
  hud.coins(0);
  hud.place(1);
  for (let i = 0; i < img.length; i += 4) {
    const a = layer.px[i + 3] / 255;
    for (let k = 0; k < 3; k++) img[i + k] = layer.px[i + k] * a + img[i + k] * (1 - a);
  }
  savePng(`${out}/${name}.png`, img);
}

for (let frame = 0; frame <= every * 6; frame++) {
  stepKart(kart, bot.input(kart), track, geo, [], frame);
  // Chase camera, as in the race.
  let da = kart.angle - cam.angle;
  da = Math.atan2(Math.sin(da), Math.cos(da));
  cam.angle += frame === 0 ? da : da * 0.12;
  cam.x = kart.x - Math.sin(cam.angle) * CHASE_DISTANCE;
  cam.y = kart.y + Math.cos(cam.angle) * CHASE_DISTANCE;
  if (frame % every === 0) render(frame, `${info.name.replace(/\s+/g, '-')}-${String(frame / 60).padStart(3, '0')}s`);
}
console.log('ok', info.name);
