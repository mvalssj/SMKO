// Test driver = the game's CPU driver at full skill.
import type { Track } from '../src/rom/rom';
import type { Kart, RaceGeometry } from '../src/game/physics';
import { CpuDriver } from '../src/game/cpu';

export class Bot extends CpuDriver {
  constructor(track: Track, _geo: RaceGeometry, k: Kart) {
    super(track, k);
  }
}
