// Solo practice: runs the item authority in the browser, behind the same send/on interface as NetClient.

import type { ClientMsg, ItemOdds, ServerMsg } from '../../shared/protocol';
import { ItemAuthority } from '../../shared/items';

export interface Channel {
  send(msg: ClientMsg): void;
  on(handler: (msg: ServerMsg) => void): () => void;
}

export class LocalChannel implements Channel {
  private handlers = new Set<(msg: ServerMsg) => void>();
  private authority: ItemAuthority;
  private timer: ReturnType<typeof setInterval>;

  constructor(private selfId: number, odds: ItemOdds, startInMs: number, cpuIds: number[] = []) {
    this.authority = new ItemAuthority(
      odds,
      (_to, msg) => queueMicrotask(() => this.handlers.forEach((h) => h(msg))),
      Date.now() + startInMs,
      Date.now,
      Math.random,
      // Alone on the track: roll as if racing mid-pack. With CPUs, use the real race position.
      cpuIds.length ? null : 'middle',
    );
    this.authority.addPlayer(selfId);
    cpuIds.forEach((id) => this.authority.addPlayer(id));
    this.timer = setInterval(() => this.authority.tick(), 50);
  }

  send(msg: ClientMsg) {
    if (msg.t === 'cpuDrop') this.authority.cpuDrop(msg.cpu, msg.x, msg.y, msg.a, msg.kind);
    else if (msg.t === 'state') this.authority.updateKart(this.selfId, msg.k.lap, msg.k.p);
    else if (msg.t === 'cpu') msg.karts.forEach((k) => this.authority.updateKart(k.id, k.lap, k.p));
    else this.authority.handle(this.selfId, msg);
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
