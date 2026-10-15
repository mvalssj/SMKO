// Solo practice: runs the item authority in the browser, behind the same send/on interface as NetClient.
// In a solo Battle Royale it also runs the balloons and the safe area (shared/royale.ts).

import type { ClientMsg, ItemOdds, ServerMsg } from '../../shared/protocol';
import { ItemAuthority } from '../../shared/items';
import { RoyaleAuthority, WORLD_COLS, WORLD_ROWS } from '../../shared/royale';

export interface Channel {
  send(msg: ClientMsg): void;
  on(handler: (msg: ServerMsg) => void): () => void;
}

export class LocalChannel implements Channel {
  private handlers = new Set<(msg: ServerMsg) => void>();
  private authority: ItemAuthority;
  private royale: RoyaleAuthority | null = null;
  private timer: ReturnType<typeof setInterval>;

  constructor(private selfId: number, odds: ItemOdds, startInMs: number, cpuIds: number[] = [], royaleSeed?: number) {
    // News for one of the CPUs (their item, their coins) is marked as theirs.
    const deliver = (to: number | 'all', msg: ServerMsg) => {
      const m = typeof to === 'number' && to !== selfId && (msg.t === 'item' || msg.t === 'coins') ? { ...msg, cpu: to } : msg;
      queueMicrotask(() => this.handlers.forEach((h) => h(m)));
    };
    const royale = royaleSeed !== undefined;
    this.authority = new ItemAuthority(
      odds,
      deliver,
      Date.now() + startInMs,
      Date.now,
      Math.random,
      // Alone on the track (or in the open world): roll as if racing mid-pack. With CPUs, use the real race position.
      royale || !cpuIds.length ? 'middle' : null,
      royale ? WORLD_COLS * WORLD_ROWS : 128 * 128,
    );
    if (royale) this.royale = new RoyaleAuthority(royaleSeed, Date.now() + startInMs, deliver);
    for (const id of [selfId, ...cpuIds]) {
      this.authority.addPlayer(id);
      this.royale?.addPlayer(id);
    }
    this.timer = setInterval(() => { this.authority.tick(); this.royale?.tick(); }, 50);
  }

  send(msg: ClientMsg) {
    if (msg.t === 'cpuDrop') this.authority.cpuDrop(msg.cpu, msg.x, msg.y, msg.a, msg.kind);
    else if (msg.t === 'state') {
      this.authority.updateKart(this.selfId, msg.k.lap, msg.k.p);
      this.royale?.updatePos(this.selfId, msg.k.x, msg.k.y);
    } else if (msg.t === 'cpu') {
      msg.karts.forEach((k) => { this.authority.updateKart(k.id, k.lap, k.p); this.royale?.updatePos(k.id, k.x, k.y); });
    } else if (msg.t === 'pop') this.royale?.pop(msg.cpu ?? this.selfId);
    else if (msg.t === 'hit') {
      const victim = msg.cpu ?? this.selfId;
      if (this.authority.hitEntity(victim, msg.entity)) this.royale?.pop(victim);
    } else this.authority.handle(this.selfId, msg);
  }

  on(handler: (msg: ServerMsg) => void) {
    this.handlers.add(handler);
    return () => this.handlers.delete(handler);
  }

  close() {
    clearInterval(this.timer);
    this.handlers.clear();
  }
}
