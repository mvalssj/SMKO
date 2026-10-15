// Messages exchanged between browser and server over the /ws WebSocket (JSON).

export const MAX_PLAYERS = 8;
export const TOTAL_LAPS = 5;
/** Client -> server state rate and server -> client broadcast rate. */
export const NET_HZ = 20;
/** Course shown to the green light: Lakitu comes down with the lights (5.1 s in the original). */
export const COUNTDOWN_MS = 5200;
/** Grand Prix points by finishing place (from the ROM: 9, 6, 3, 1, then nothing). */
export const GP_POINTS = [9, 6, 3, 1, 0, 0, 0, 0];
/** Battle Mode: balloons each player starts with, and the longest a battle lasts. */
export const BATTLE_BALLOONS = 3;
export const BATTLE_MAX_MS = 180_000;
/** Pause between the races of an online Grand Prix. */
export const GP_NEXT_RACE_MS = 9000;
export type Cc = 50 | 100 | 150;
/** Simulation step, shared by clients and server (race frames). */
export const STEP_MS = 1000 / 60;

export type Phase = 'lobby' | 'countdown' | 'racing' | 'results';

/** Item order used by the ROM tables (probabilities, HUD icons). */
export const ITEM_KINDS = ['mushroom', 'feather', 'star', 'banana', 'greenShell', 'redShell', 'ghost', 'coins', 'lightning'] as const;
export type ItemKind = (typeof ITEM_KINDS)[number];

/** Item chances (out of 32, in ITEM_KINDS order) for one track, by race situation. */
export interface ItemOdds {
  /** Lap 1, or in 1st place. */
  leader: number[];
  /** Laps 2-5 in 2nd-4th. */
  middle: number[];
  /** Laps 2-5 in 5th-8th. */
  back: number[];
}

export type EntityKind = 'banana' | 'greenShell' | 'redShell' | CpuItemKind;

/**
 * Items only computer drivers use, each character its own (Mario and Luigi turn invincible with a star,
 * Donkey Kong Jr. drops bananas, Koopa Troopa green shells): Peach and Toad drop poison mushrooms (they shrink
 * whoever touches them), Bowser drops fireballs that roll about, Yoshi drops eggs.
 */
export type CpuItemKind = 'poison' | 'fireball' | 'egg';

/** What each character's CPU drops, in CHARACTER_NAMES order ('star' = turns invincible instead). */
export const CPU_SPECIAL: (EntityKind | 'star')[] = ['star', 'star', 'fireball', 'poison', 'banana', 'greenShell', 'poison', 'egg'];

/** An item lying on or moving along the track. */
export interface NetEntity {
  id: number;
  kind: EntityKind;
  owner: number;
  x: number;
  y: number;
  /** Heading of a thrown shell. */
  a: number;
  /** Race frame it was created on; clients simulate it forward from there. */
  frame: number;
  /** Red shells home on this player. */
  target: number | null;
}

export type EffectKind = 'mushroom' | 'star' | 'feather' | 'ghost' | 'lightning';

/** Bits of KartNetState.e */
export const EFFECT_STAR = 1;
export const EFFECT_GHOST = 2;
export const EFFECT_SHRUNK = 4;
/** Mushroom, zipper, mini-turbo or start boost. */
export const EFFECT_BOOST = 8;

export interface PlayerInfo {
  id: number;
  name: string;
  character: number; // index into CHARACTER_NAMES (one per player in a room)
  /** Driver confirmed on the select screen ("OK?" -> yes); until then `cursor` is the one being looked at. */
  ready: boolean;
  /** Online lobby: the TV (driver) this player's cursor is on. */
  cursor?: number;
  /** Joined while a race was running: watches it, races from the next one. */
  spectator?: boolean;
  /** Computer-driven kart, simulated by the room host's browser. */
  cpu?: boolean;
}

/** CPU player ids start here, so they never clash with connection ids. */
export const CPU_ID_BASE = 1_000_000;

export interface KartNetState {
  id: number;
  x: number;
  y: number;
  a: number; // heading, radians
  /** Kart body's swing out of the heading in a skid / power slide, radians (drawing only). */
  d?: number;
  s: number; // speed
  lap: number;
  p: number; // race progress (lap * pathLength + path index); higher = ahead
  f: number; // falling timer (0 = on the track)
  h: number; // height above the floor while jumping
  e: number; // active effects, EFFECT_* bits
}

export interface Standing {
  id: number;
  name: string;
  points: number;
}

export interface ResultEntry {
  id: number;
  name: string;
  timeMs: number | null; // null = did not finish
}

export type ClientMsg =
  | { t: 'join'; room: string; name: string; romCrc: number; character: number }
  /** Select screen: cursor moved to `character`; `ready` = confirmed it (false = still choosing / cancelled). */
  | { t: 'character'; character: number; ready: boolean }
  | { t: 'track'; track: number } // host only, index into SmkRom.tracks
  /** Host only: 1 track (single race) or 5 (Grand Prix); odds per track come from the host's ROM; cpus = fill empty slots. */
  | { t: 'start'; tracks?: number[]; odds?: ItemOdds[]; cpus?: boolean; cc?: Cc; battle?: boolean }
  | { t: 'lobby' } // host only: back to lobby after results
  | { t: 'state'; k: Omit<KartNetState, 'id'> }
  /** `cpu`: the host reports a CPU kart finishing. */
  | { t: 'finish'; timeMs: number; cpu?: number }
  /** Host only: states of the CPU karts it simulates. */
  | { t: 'cpu'; karts: KartNetState[] }
  /** Host only: a CPU drops its special item. */
  | { t: 'cpuDrop'; cpu: number; x: number; y: number; a: number; kind: EntityKind }
  | { t: 'break'; tiles: number[] }
  /** Drove over an item box (its map tiles). */
  | { t: 'box'; tiles: number[]; cpu?: number }
  /** Drove over a coin (its map tiles). */
  | { t: 'coin'; tiles: number[]; cpu?: number }
  /** Use the held item; `back` throws a shell behind (bananas always go behind). */
  | { t: 'use'; x: number; y: number; a: number; back: boolean; cpu?: number }
  /** This client's kart (or, from the host, CPU `cpu`) was hit by an entity. */
  | { t: 'hit'; entity: number; cpu?: number }
  /** Battle: this player lost a balloon to something that isn't a thrown item (a star kart, a fall). */
  | { t: 'pop'; cpu?: number };

export type ServerMsg =
  | { t: 'welcome'; id: number }
  | { t: 'room'; room: string; hostId: number; phase: Phase; track: number; players: PlayerInfo[] }
  /** `players` includes the CPUs; `cpuHost` is the player whose browser simulates them. */
  | { t: 'race'; track: number; laps: number; grid: number[]; startInMs: number; players: PlayerInfo[]; cpuHost: number; cc: Cc; round: number; rounds: number; battle?: boolean }
  /** Battle: a player's balloons (0 = out). */
  | { t: 'balloons'; id: number; n: number }
  /** Battle Royale: a player is out (finishing `place`), and the match is over. */
  | { t: 'royaleOut'; id: number; place: number }
  | { t: 'royaleOver'; winner: number }
  /** The player now simulating the CPUs (the previous one left mid-race). */
  | { t: 'cpuHost'; id: number }
  | { t: 'states'; karts: KartNetState[] }
  | { t: 'finished'; id: number; place: number; timeMs: number }
  /** `standings`: Grand Prix points so far; `final` = last race of the event. */
  | { t: 'results'; results: ResultEntry[]; standings: Standing[]; round: number; rounds: number; final: boolean }
  | { t: 'break'; tiles: number[] }
  /** Your held item (null = none). `roll` = show the roulette before it can be used. */
  /** `cpu`: the news is for that computer driver (one this client simulates), not for the player. */
  | { t: 'item'; item: ItemKind | null; roll?: boolean; cpu?: number }
  | { t: 'coins'; coins: number; cpu?: number }
  /** Item box / coin tiles taken (restore = false) or back (restore = true). */
  | { t: 'tiles'; tiles: number[]; restore: boolean }
  | { t: 'spawn'; e: NetEntity }
  | { t: 'despawn'; id: number; victim: number | null }
  /** A player used a self item (or lightning, which hits everyone else). */
  | { t: 'effect'; id: number; kind: EffectKind }
  | { t: 'error'; message: string };

/** Super Mario Kart's 8 drivers, in the game's order (matches CHARACTERS in src/rom/rom.ts). */
export const CHARACTER_NAMES = ['Mario', 'Luigi', 'Bowser', 'Peach', 'DK Jr.', 'Koopa', 'Toad', 'Yoshi'];
/** Name tag / minimap color per character. */
export const KART_COLORS = ['#e52521', '#43b047', '#ff9a1f', '#ff8ad8', '#c07a3a', '#fbd000', '#049cd8', '#8ee05a'];
