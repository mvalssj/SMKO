// One Battle Royale match on this client: the world, the safe area's circles (from the match seed, the same
// everywhere), the bots' way-finding map to the next circle, and where everyone starts.

import { ROYALE_PLAYERS, mulberry32, zoneAt, zoneCircles, type Circle, type ZoneNow } from '../../shared/royale';
import { NavField } from './bot';
import { itemBoxes, type WorldTrack } from './world';

export class RoyaleState {
  readonly circles: Circle[];
  readonly nav: NavField;
  readonly boxes: { x: number; y: number }[];
  private order: { x: number; y: number; angle: number }[];
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
  }

  /** Where player `slot` (0-99) starts. */
  spawn(slot: number): { x: number; y: number; angle: number } {
    const n = this.order.length;
    const step = Math.max(1, Math.floor(n / ROYALE_PLAYERS));
    return this.order[(slot * step) % n];
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
