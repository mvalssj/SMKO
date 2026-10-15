import type { ClientMsg, KartNetState, ServerMsg } from '../../shared/protocol';
import { wrapDX, wrapDY, wrapX, wrapY } from '../../shared/royale';

type Handler = (msg: ServerMsg) => void;

export class NetClient {
  /** Shows a message from the server's administrator (or why we were sent away) over the game. */
  static notice: ((text: string) => void) | null = null;
  private ws: WebSocket;
  private handlers = new Set<Handler>();
  readonly opened: Promise<void>;
  onClose: (() => void) | null = null;

  constructor() {
    const proto = location.protocol === 'https:' ? 'wss' : 'ws';
    this.ws = new WebSocket(`${proto}://${location.host}/ws`);
    this.opened = new Promise((resolve, reject) => {
      this.ws.addEventListener('open', () => resolve(), { once: true });
      this.ws.addEventListener('error', () => reject(new Error('Não foi possível conectar ao servidor.')), { once: true });
    });
    this.ws.addEventListener('message', (e) => {
      const msg = JSON.parse(e.data) as ServerMsg;
      if (msg.t === 'notice') NetClient.notice?.(msg.message);
      for (const h of this.handlers) h(msg);
    });
    this.ws.addEventListener('close', () => this.onClose?.());
  }

  on(h: Handler): () => void {
    this.handlers.add(h);
    return () => this.handlers.delete(h);
  }

  send(msg: ClientMsg) {
    if (this.ws.readyState === WebSocket.OPEN) this.ws.send(JSON.stringify(msg));
  }

  close() {
    this.onClose = null;
    this.ws.close();
  }
}

/** Buffers remote kart snapshots and renders them slightly in the past, interpolated. */
export class RemoteKarts {
  private static readonly DELAY_MS = 110;
  private snaps = new Map<number, { t: number; k: KartNetState }[]>();

  /** `local`: ids simulated by this client (itself and, on the CPU host, the CPUs). */
  push(karts: KartNetState[], local: Set<number>) {
    const t = performance.now();
    for (const k of karts) {
      if (local.has(k.id)) continue;
      const list = this.snaps.get(k.id) ?? [];
      list.push({ t, k });
      if (list.length > 20) list.shift();
      this.snaps.set(k.id, list);
    }
  }

  latest(id: number): KartNetState | undefined {
    const list = this.snaps.get(id);
    return list?.[list.length - 1]?.k;
  }

  sample(): KartNetState[] {
    const target = performance.now() - RemoteKarts.DELAY_MS;
    const out: KartNetState[] = [];
    for (const list of this.snaps.values()) {
      if (list.length === 0) continue;
      let i = list.length - 1;
      while (i > 0 && list[i - 1].t > target) i--;
      const b = list[i];
      const a = list[Math.max(0, i - 1)];
      if (a === b || target >= b.t) { out.push(b.k); continue; }
      const f = Math.min(1, Math.max(0, (target - a.t) / (b.t - a.t)));
      let da = b.k.a - a.k.a;
      da = Math.atan2(Math.sin(da), Math.cos(da));
      // (The short way round: in the Battle Royale world a kart can drive off one edge and in at the other.)
      out.push({ ...b.k, x: wrapX(a.k.x + wrapDX(b.k.x - a.k.x) * f), y: wrapY(a.k.y + wrapDY(b.k.y - a.k.y) * f), a: a.k.a + da * f });
    }
    return out;
  }

  clear() {
    this.snaps.clear();
  }

  /** Stops showing a kart (its driver left or was replaced). */
  forget(id: number) {
    this.snaps.delete(id);
  }
}
