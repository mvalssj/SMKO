// What the original keeps in the cartridge's battery memory, kept in this browser instead: the cups won
// (Special Cup after golds in the first three cups at 100cc, 150cc after golds in all four at 100cc) and the
// Time Trial records (5 best times and the best lap of each course).

const KEY = 'smko-progress';

export interface TrialRecord {
  /** Best totals, fastest first (ms). */
  times: number[];
  bestLap: number | null;
}

interface Saved {
  /** Cups won (gold) per engine class. */
  golds: Record<string, number[]>;
  trials: Record<string, TrialRecord>;
}

function load(): Saved {
  try {
    const s = JSON.parse(localStorage.getItem(KEY) ?? '{}');
    return { golds: s.golds ?? {}, trials: s.trials ?? {} };
  } catch {
    return { golds: {}, trials: {} };
  }
}

function save(s: Saved) {
  try { localStorage.setItem(KEY, JSON.stringify(s)); } catch { /* private mode: progress isn't kept */ }
}

/** A Grand Prix finished with the gold (1st overall). */
export function winCup(cc: number, cup: number) {
  const s = load();
  const won = new Set(s.golds[cc] ?? []);
  won.add(cup);
  s.golds[cc] = [...won];
  save(s);
}

function won100(): Set<number> {
  return new Set(load().golds['100'] ?? []);
}

export function specialCupOpen(): boolean {
  const w = won100();
  return [0, 1, 2].every((c) => w.has(c));
}

export function cc150Open(): boolean {
  const w = won100();
  return [0, 1, 2, 3].every((c) => w.has(c));
}

export function trialRecord(track: number): TrialRecord {
  return load().trials[track] ?? { times: [], bestLap: null };
}

/** Saves a Time Trial run; returns whether it's a new best time / best lap. */
export function saveTrial(track: number, totalMs: number, laps: number[]): { best: boolean; lap: boolean } {
  const s = load();
  const r = s.trials[track] ?? { times: [], bestLap: null };
  const best = !r.times.length || totalMs < r.times[0];
  r.times = [...r.times, totalMs].sort((a, b) => a - b).slice(0, 5);
  const fastest = laps.length ? Math.min(...laps) : null;
  const lap = fastest !== null && (r.bestLap === null || fastest < r.bestLap);
  if (lap) r.bestLap = fastest;
  s.trials[track] = r;
  save(s);
  return { best, lap };
}
