// One Battle Royale match on this client: the world, the safe area's circles (from the match seed, the same
// everywhere), the bots' way-finding map to the next circle, and where everyone starts.

import { ROYALE_PLAYERS, COURSE_TILES, TILE_PX, mulberry32, zoneAt, zoneCircles, type Circle, type ZoneNow } from '../../shared/royale';
import { NavField } from './bot';
import { itemBoxes, type WorldTrack } from './world';

export class RoyaleState {
  readonly circles: Circle[];
  readonly nav: NavField;
  readonly boxes: { x: number; y: number }[];
  /** All world-wide points bots may choose while roaming. */
  private order: { x: number; y: number; angle: number }[];
  /** The 10×10 starting grid in the centre of Battle Course 4. */
  private starts: { x: number; y: number; angle: number }[];
  private navPhase = -1;

  constructor(readonly world: WorldTrack, readonly seed: number, readonly zoneScale = 1) {
    this.circles = zoneCircles(seed);
    this.nav = new NavField(world);
    this.boxes = itemBoxes(world);
    // Starting places: the world's spawn points in a shuffled order (from the seed), spread out evenly.
    const rand = mulberry32(seed ^ 0x5eed);
    const all = [...world.world.spawns];
    for (let i = all.length - 1; i > 0; i--) {
      const j = Math.floor(rand() * (i + 1));
      [all[i], all[j]] = [all[j], all[i]];
    }
    this.order = all;

    // Every Battle Royale starts as a compact grid in the middle of Battle Course 4 (which is part of the
    // world at track index 23). The 18 px spacing avoids karts spawning inside one another, and outward
    // headings let the pack fan out immediately. The regular world-wide points remain available for bot roaming.
    const arena = world.world.regions.find((r) => r.info.name === 'Battle Course 4');
    if (arena) {
      const centreX = (arena.x0 + COURSE_TILES / 2) * TILE_PX;
      const centreY = (arena.y0 + COURSE_TILES / 2) * TILE_PX;
      const columns = 10, spacing = 18;
      this.starts = Array.from({ length: ROYALE_PLAYERS }, (_, slot) => {
        const dx = (slot % columns - (columns - 1) / 2) * spacing;
        const dy = (Math.floor(slot / columns) - (columns - 1) / 2) * spacing;
        return { x: centreX + dx, y: centreY + dy, angle: Math.atan2(dx, -dy) };
      });
    } else this.starts = this.order;
  }

  /** Where player `slot` (0-99) starts: the centre of Battle Course 4. */
  spawn(slot: number): { x: number; y: number; angle: number } {
    return this.starts[slot % this.starts.length];
  }

  /** Spawn points (on each course's racing line), for the bots to roam between. */
  get spawns() {
    return this.order;
  }

  /**
   * The safe area `ms` after the start. A new distance map is assembled in small frame-sized slices, so
   * entering a 24-course Battle Royale never freezes the picture just to prepare bot navigation.
   */
  zone(ms: number): ZoneNow {
    const z = zoneAt(this.circles, ms, this.zoneScale);
    if (z.phase !== this.navPhase) {
      this.navPhase = z.phase;
      this.nav.begin(z.next);
    }
    this.nav.work(3);
    return z;
  }
}
