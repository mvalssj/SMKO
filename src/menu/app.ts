// The original Super Mario Kart menus (title, mode boxes, character select, cup/course select),
// drawn by the mini-PPU from the user's ROM, plus the online room flow in the same style.

import { CHARACTER_NAMES } from '../../shared/protocol';
import { CUP_NAMES, type SmkRom, type SpriteFrame, type TrackInfo } from '../rom/rom';
import { createOam, renderFrame, SCREEN_H, SCREEN_W, setSprite, type Screen } from '../snes/ppu';
import { MenuAssets } from './assets';
import { FADES, transition } from '../fade';
import { cc150Open, specialCupOpen, trialRecord } from './progress';
import { boardTime } from './results';
import {
  TV_CHARACTERS, TV_SPRITE_POS, bigSpriteText, buildCupMap, cupBorder, cupTitle, okPrompt, spriteText, tvChosen, tvMarker,
} from './draw';

/** gp / tt: 1P GAME; gp / match / battle: the online room (the original's 2P GAME modes). */
export type Mode = 'gp' | 'tt' | 'match' | 'battle';
export type Cc = 50 | 100 | 150;

export interface MenuEvents {
  /** Solo: Grand Prix (cup = 0-3) or Time Trial (single course). */
  solo(choice: { mode: Mode; cc: Cc; character: number; tracks: TrackInfo[] }): void;
  /** Online: create a room (code null) or join one. */
  online(choice: { code: string | null; cc: Cc }): void;
  /** Online lobby: this player's cursor is on `character`; `ready` = confirmed it. */
  onlineCharacter(character: number, ready: boolean): void;
  /** Online host: start with these tracks (1 = single race, 5 = a cup). */
  onlineStart(choice: { mode: Mode; cc: Cc; tracks: TrackInfo[] }): void;
  /** Left the online lobby. */
  onlineLeave(): void;
}

/** Room state pushed in by the online code while in the lobby. */
export interface LobbyView {
  code: string;
  isHost: boolean;
  selfId: number;
  /** People in the room, in joining order (1P, 2P, ...). */
  players: { id: number; character: number; cursor: number; ready: boolean; name: string }[];
  status: string;
}

type Box = { lines: string[]; onPick: (i: number) => void; onBack?: () => void; cursor: number };

type State =
  | { s: 'title' }
  | { s: 'box'; box: Box }
  | { s: 'confirm'; summary: string[]; yes: boolean; onYes: () => void; onNo: () => void }
  | { s: 'code'; code: string; pos: number }
  | { s: 'select'; tv: number; ok: boolean; online: boolean }
  | { s: 'cup'; cursor: number; online: boolean }
  | { s: 'course'; cup: number; cursor: number; online: boolean }
  | { s: 'message'; lines: string[]; onB?: () => void; onBack?: () => void; roomStatus?: boolean };

const BOX = { x0: 64, x1: 188 };
/** The battle courses take the place of a cup in the course list. */
const BATTLE_CUP = 4;
const KEYS: Record<string, string> = {
  ArrowUp: 'up', ArrowDown: 'down', ArrowLeft: 'left', ArrowRight: 'right',
  KeyX: 'b', Space: 'b', Enter: 'start', KeyZ: 'y', Escape: 'y', Backspace: 'y', KeyA: 'b', KeyS: 'y',
};

export class MenuApp {
  private assets: MenuAssets;
  private ctx: CanvasRenderingContext2D;
  private image: ImageData;
  private title: Screen;
  private select: Screen;
  private cup: Screen;
  private frame = 0;
  private raf = 0;
  private state: State = { s: 'title' };
  private mode: Mode = 'gp';
  private cc: Cc = 50;
  private character = 0;
  private online = false;
  private lobby: LobbyView | null = null;
  private pressed = new Set<string>();
  private titleDrivers: SpriteFrame[][][];
  private selectDrivers: SpriteFrame[][][];
  private onKey = (e: KeyboardEvent) => this.key(e);
  private visible = false;

  constructor(private rom: SmkRom, canvas: HTMLCanvasElement, private events: MenuEvents) {
    this.assets = new MenuAssets(rom);
    canvas.width = SCREEN_W;
    canvas.height = SCREEN_H;
    this.ctx = canvas.getContext('2d')!;
    this.image = this.ctx.createImageData(SCREEN_W, SCREEN_H);
    this.title = this.assets.titleScreen();
    this.select = this.assets.selectScreen();
    this.cup = this.assets.cupScreen();
    // Driver frames colored with each screen's own sprite palettes.
    const colors = (s: Screen) => Array.from(s.cgram, (c) => [((c & 31) << 3) | ((c & 31) >> 2), (((c >> 5) & 31) << 3) | (((c >> 5) & 31) >> 2), (((c >> 10) & 31) << 3) | (((c >> 10) & 31) >> 2)] as [number, number, number]);
    this.titleDrivers = CHARACTER_NAMES.map((_, c) => rom.loadDriverSprites(c, colors(this.title))!.rows);
    this.selectDrivers = CHARACTER_NAMES.map((_, c) => rom.loadDriverSprites(c, colors(this.select))!.rows);
  }

  show() {
    if (this.visible) return;
    this.visible = true;
    addEventListener('keydown', this.onKey);
    const loop = () => {
      this.raf = requestAnimationFrame(loop);
      this.frame++;
      this.draw();
    };
    this.raf = requestAnimationFrame(loop);
  }

  hide() {
    this.visible = false;
    cancelAnimationFrame(this.raf);
    removeEventListener('keydown', this.onKey);
  }

  /** Back to the title screen (after a race, or when leaving a room). */
  toTitle() {
    this.online = false;
    this.lobby = null;
    this.state = { s: 'title' };
  }

  /** After a solo race/GP: straight back to the cup screen with the same settings. */
  toCupSelect() {
    this.state = { s: 'cup', cursor: 0, online: this.online };
  }

  // ---------- Online hooks ----------

  /** Arriving in a room's lobby (joined, or back from a race): the character select screen. */
  enterLobby(view: LobbyView) {
    this.online = true;
    this.lobby = view;
    const mine = view.players.find((p) => p.id === view.selfId);
    this.state = { s: 'select', tv: TV_CHARACTERS.indexOf(mine?.cursor ?? this.character), ok: false, online: true };
    this.events.onlineCharacter(TV_CHARACTERS[this.state.tv], false);
  }

  /** Room changed while in the lobby (someone joined, left, moved or confirmed). */
  updateLobby(view: LobbyView) {
    const wasHost = this.lobby?.isHost;
    this.lobby = view;
    // Became the host (the previous one left) while waiting: now this player picks the cup.
    if (view.isHost && !wasHost && this.state.s === 'message' && this.state.roomStatus) this.state = this.hostPicks();
  }

  /** The server refused the confirmed driver (someone else confirmed it first). */
  backToSelect() {
    if (!this.online) return;
    this.state = { s: 'select', tv: TV_CHARACTERS.indexOf(this.character), ok: false, online: true };
  }

  showMessage(lines: string[], onB?: () => void) {
    this.state = { s: 'message', lines, onB, onBack: () => { this.events.onlineLeave(); this.toTitle(); } };
  }

  // ---------- Input ----------

  private key(e: KeyboardEvent) {
    if (this.state.s === 'code') {
      const ch = e.key.toUpperCase();
      if (/^[A-Z0-9]$/.test(ch)) { this.typeCode(ch); e.preventDefault(); return; }
    }
    const k = KEYS[e.code];
    if (!k) return;
    e.preventDefault();
    this.press(k);
  }

  /** A fade between screens is running: keys wait (as in the original). */
  private busy = false;

  /** Changes screen with the original's fade out / black / fade in. */
  private go(t: { out: number; black: number; in: number; wait?: number }, next: () => void) {
    if (typeof document === 'undefined') { next(); return; } // tools running the menus in Node
    this.busy = true;
    void transition(t, next).finally(() => { this.busy = false; });
  }

  private press(k: string) {
    if (this.busy) return;
    const st = this.state;
    switch (st.s) {
      case 'title':
        if (k === 'start' || k === 'b') this.mainBox();
        break;
      case 'box': {
        const box = st.box;
        if (k === 'up') box.cursor = (box.cursor + box.lines.length - 1) % box.lines.length;
        else if (k === 'down') box.cursor = (box.cursor + 1) % box.lines.length;
        else if (k === 'b' || k === 'start') box.onPick(box.cursor);
        else if (k === 'y') (box.onBack ?? (() => this.toTitle()))();
        break;
      }
      case 'confirm':
        if (k === 'left' || k === 'right') st.yes = !st.yes;
        else if (k === 'b' || k === 'start') (st.yes ? st.onYes : st.onNo)();
        else if (k === 'y') st.onNo();
        break;
      case 'code':
        if (k === 'left') st.pos = Math.max(0, st.pos - 1);
        else if (k === 'right') st.pos = Math.min(4, st.pos + 1);
        else if (k === 'up' || k === 'down') {
          const set = 'ABCDEFGHJKLMNPQRSTUVWXYZ23456789';
          const cur = set.indexOf(st.code[st.pos] ?? 'A');
          const next = set[(cur + (k === 'up' ? 1 : set.length - 1) + set.length) % set.length];
          st.code = (st.code.padEnd(5, 'A').slice(0, st.pos) + next + st.code.padEnd(5, 'A').slice(st.pos + 1)).slice(0, 5);
        } else if ((k === 'b' || k === 'start') && st.code.length === 5) this.events.online({ code: st.code, cc: this.cc });
        else if (k === 'y') this.onlineBox();
        break;
      case 'select':
        this.pressSelect(st, k);
        break;
      case 'cup':
        if (k === 'up') st.cursor = (st.cursor + this.cupCount() - 1) % this.cupCount();
        else if (k === 'down') st.cursor = (st.cursor + 1) % this.cupCount();
        else if ((k === 'start' || k === 'b') && st.online && this.mode !== 'match') this.events.onlineStart({ mode: 'gp', cc: this.cc, tracks: this.cupTracks(st.cursor) });
        else if (k === 'b' || k === 'start') this.pickCup(st.cursor, st.online);
        else if (k === 'y') {
          if (st.online) this.events.onlineCharacter(this.character, false);
          this.state = { s: 'select', tv: TV_CHARACTERS.indexOf(this.character), ok: false, online: st.online };
        }
        break;
      case 'course':
        if (k === 'up') st.cursor = (st.cursor + this.cupTracks(st.cup).length - 1) % this.cupTracks(st.cup).length;
        else if (k === 'down') st.cursor = (st.cursor + 1) % this.cupTracks(st.cup).length;
        else if (k === 'b' || k === 'start') this.pickCourse(st.cup, st.cursor, st.online);
        else if (k === 'y') this.state = st.cup === BATTLE_CUP ? this.reselect(st.online) : { s: 'cup', cursor: st.cup, online: st.online };
        break;
      case 'message':
        if ((k === 'b' || k === 'start') && st.onB) st.onB();
        else if (k === 'y' && st.onBack) st.onBack();
        break;
    }
  }

  private pressSelect(st: Extract<State, { s: 'select' }>, k: string) {
    const taken = this.takenTvs();
    if (st.ok) {
      if (k === 'b' || k === 'start') {
        this.character = TV_CHARACTERS[st.tv];
        if (st.online) {
          this.events.onlineCharacter(this.character, true);
          if (this.lobby?.isHost) this.go(FADES.toCup, () => { this.state = this.hostPicks(); });
          else this.waitForHost();
        } else this.go(FADES.toCup, () => { this.state = { s: 'cup', cursor: 0, online: false }; });
      } else if (k === 'y') st.ok = false;
      return;
    }
    const move = (dx: number, dy: number) => {
      let tv = st.tv;
      for (let n = 0; n < 8; n++) {
        const col = (tv % 4 + dx + 4) % 4, row = (Math.floor(tv / 4) + dy + 2) % 2;
        tv = row * 4 + col;
        if (!taken.has(tv)) break;
      }
      st.tv = tv;
      if (st.online) this.events.onlineCharacter(TV_CHARACTERS[tv], false);
    };
    if (k === 'left') move(-1, 0);
    else if (k === 'right') move(1, 0);
    else if (k === 'up' || k === 'down') move(0, 1);
    else if ((k === 'b' || k === 'start') && !taken.has(st.tv)) st.ok = true;
    else if (k === 'y') {
      if (st.online) { this.events.onlineLeave(); this.toTitle(); } else this.confirmBox();
    }
  }

  /** TVs whose driver another online player has confirmed. */
  private takenTvs(): Set<number> {
    const set = new Set<number>();
    if (!this.lobby) return set;
    for (const p of this.lobby.players) if (p.id !== this.lobby.selfId && p.ready) set.add(TV_CHARACTERS.indexOf(p.character));
    return set;
  }

  /** Guest after confirming: waits for the host's cup choice; B/Z goes back to change driver. */
  private waitForHost() {
    const back = () => {
      this.events.onlineCharacter(this.character, false);
      this.state = { s: 'select', tv: TV_CHARACTERS.indexOf(this.character), ok: false, online: true };
    };
    this.state = { s: 'message', lines: ['WAIT FOR', 'THE HOST'], onBack: back, roomStatus: true };
  }

  private typeCode(ch: string) {
    const st = this.state;
    if (st.s !== 'code') return;
    const code = st.code.padEnd(5, ' ').split('');
    code[st.pos] = ch;
    st.code = code.join('').trimEnd();
    st.pos = Math.min(4, st.pos + 1);
  }

  // ---------- Menu flow ----------

  private box(lines: string[], onPick: (i: number) => void, onBack?: () => void) {
    this.state = { s: 'box', box: { lines, onPick, onBack, cursor: 0 } };
  }

  private mainBox() {
    this.box(['1P GAME', 'ONLINE GAME'], (i) => (i === 0 ? this.modeBox() : this.onlineBox()));
  }

  private modeBox() {
    this.online = false;
    this.box(['MARIOKART GP', 'TIME TRIAL'], (i) => {
      this.mode = i === 0 ? 'gp' : 'tt';
      // Time Trial has no class choice in the original.
      if (this.mode === 'tt') { this.cc = 100; this.confirmBox(); } else this.classBox(() => this.confirmBox(), () => this.modeBox(), true);
    }, () => this.mainBox());
  }

  /** `solo`: 1P GAME, where 150cc has to be won first (golds in all four cups at 100cc). */
  private classBox(next: () => void, back: () => void, solo = false) {
    const lines = ['50¢ CLASS', '100¢ CLASS', '150¢ CLASS'].slice(0, solo && !cc150Open() ? 2 : 3);
    this.box(lines, (i) => {
      this.cc = ([50, 100, 150] as const)[i];
      next();
    }, back);
  }

  private confirmBox() {
    const summary = ['1P GAME', this.mode === 'gp' ? 'MARIOKART GP' : 'TIME TRIAL'];
    if (this.mode === 'gp') summary.push(`${this.cc}¢ CLASS`);
    this.state = {
      s: 'confirm', summary, yes: true,
      onYes: () => this.go(FADES.toSelect, () => { this.state = { s: 'select', tv: TV_CHARACTERS.indexOf(this.character), ok: false, online: false }; }),
      onNo: () => this.modeBox(),
    };
  }

  private onlineBox() {
    this.online = true;
    this.box(['CREATE ROOM', 'JOIN ROOM'], (i) => {
      if (i === 0) this.roomModeBox();
      else {
        const fromUrl = new URLSearchParams(location.search).get('sala')?.toUpperCase().slice(0, 5) ?? '';
        this.state = { s: 'code', code: fromUrl, pos: Math.min(4, fromUrl.length) };
      }
    }, () => this.mainBox());
  }

  /** Creating a room: the modes of the original's 2P GAME (Battle Mode has no engine class). */
  private roomModeBox() {
    this.box(['MARIOKART GP', 'MATCH RACE', 'BATTLE MODE'], (i) => {
      this.mode = (['gp', 'match', 'battle'] as const)[i];
      if (this.mode === 'battle') { this.cc = 100; this.events.online({ code: null, cc: this.cc }); }
      else this.classBox(() => this.events.online({ code: null, cc: this.cc }), () => this.roomModeBox());
    }, () => this.onlineBox());
  }

  /** What the room's host chooses next: a cup (GP, Match Race) or one of the battle courses. */
  private hostPicks(): State {
    return this.mode === 'battle' ? { s: 'course', cup: BATTLE_CUP, cursor: 0, online: true } : { s: 'cup', cursor: 0, online: true };
  }

  private reselect(online: boolean): State {
    if (online) this.events.onlineCharacter(this.character, false);
    return { s: 'select', tv: TV_CHARACTERS.indexOf(this.character), ok: false, online };
  }

  private pickCup(cup: number, online: boolean) {
    if (this.mode === 'tt' || online) {
      this.state = { s: 'course', cup, cursor: 0, online };
      return;
    }
    this.events.solo({ mode: 'gp', cc: this.cc, character: this.character, tracks: this.cupTracks(cup) });
  }

  private pickCourse(cup: number, course: number, online: boolean) {
    const track = this.cupTracks(cup)[course];
    if (online) this.events.onlineStart({ mode: cup === BATTLE_CUP ? 'battle' : 'match', cc: this.cc, tracks: [track] });
    else this.events.solo({ mode: 'tt', cc: this.cc, character: this.character, tracks: [track] });
  }

  /** Cups on the list: the Special Cup is won in 1P GAME (golds in the first three at 100cc); online, all four. */
  private cupCount(): number {
    return this.online || specialCupOpen() ? 4 : 3;
  }

  private cupTracks(cup: number): TrackInfo[] {
    if (cup === BATTLE_CUP) return this.rom.tracks.filter((t) => t.battle).sort((a, b) => a.name.localeCompare(b.name));
    return this.rom.tracks.filter((t) => !t.battle && t.cup === cup);
  }

  // ---------- Drawing ----------

  private draw() {
    const st = this.state;
    const out = this.image.data as unknown as Uint8Array;
    let screen: Screen;
    if (st.s === 'select') screen = this.drawSelect(st);
    else if (st.s === 'cup' || st.s === 'course') screen = this.drawCup(st);
    else screen = this.drawTitle(st);
    renderFrame(screen, out);
    // The karts on the title are parked while a menu box is open, as in the original.
    if (screen === this.title && st.s === 'title') this.drawTitleKarts(out);
    if (screen === this.select) this.drawTvKarts(out, st.s === 'select' ? st : null);
    this.ctx.putImageData(this.image, 0, 0);
  }

  private drawTitle(st: State): Screen {
    const s = this.title;
    s.layers[1].h = this.frame & 1023; // the hills scroll by one pixel per frame
    s.oam = createOam();
    s.window = null;
    const lineY = (i: number) => 128 + i * 16;
    if (st.s === 'box') {
      const n = st.box.lines.length;
      s.window = { ...BOX, y0: 120, y1: 120 + n * 16 + 7 };
      let slot = 64;
      st.box.lines.forEach((text, i) => {
        const x = 128 - text.length * 4;
        if (i === st.box.cursor) setSprite(s.oam!, slot++, x - 16, lineY(i), 0x9d, 6);
        slot = spriteText(s.oam!, slot, x, lineY(i), text, i === st.box.cursor ? 4 : 5);
      });
    } else if (st.s === 'confirm') {
      s.window = { ...BOX, y0: 112, y1: 197 };
      let slot = 64;
      st.summary.forEach((text, i) => {
        setSprite(s.oam!, slot++, 72, 120 + i * 16, 0x9d, 6);
        slot = spriteText(s.oam!, slot, 88, 120 + i * 16, text, 4);
      });
      slot = spriteText(s.oam!, slot, 96, 168, 'IS THIS OK?', 5);
      // "(YES) NO": the brackets mark the current answer.
      const bx = st.yes ? 112 : 152, bw = st.yes ? 32 : 24;
      setSprite(s.oam!, slot++, bx, 184, 0x7d, 4);
      setSprite(s.oam!, slot++, bx + bw, 184, 0x7d, 4, 0, false, true);
      slot = spriteText(s.oam!, slot, 120, 184, 'YES', st.yes ? 4 : 5);
      spriteText(s.oam!, slot, 160, 184, 'NO', st.yes ? 5 : 4);
    } else if (st.s === 'code') {
      s.window = { ...BOX, y0: 120, y1: 159 };
      let slot = spriteText(s.oam!, 64, 88, 128, 'ROOM CODE', 5);
      const code = st.code.padEnd(5, ' ');
      for (let i = 0; i < 5; i++) {
        const x = 108 + i * 8;
        const blink = i === st.pos && (this.frame >> 4) % 2 === 0;
        if (code[i] !== ' ') slot = spriteText(s.oam!, slot, x, 144, code[i], i === st.pos ? 4 : 5);
        else if (blink) setSprite(s.oam!, slot++, x, 144, 0x9d, 6);
      }
    } else if (st.s === 'message') {
      const lines = st.roomStatus && this.lobby ? [...st.lines, this.readyLine()] : st.lines;
      s.window = { ...BOX, y0: 120, y1: 120 + lines.length * 16 + 7 };
      let slot = 64;
      lines.forEach((text, i) => { slot = spriteText(s.oam!, slot, 128 - text.length * 4, lineY(i), text, i === 0 ? 4 : 5); });
    }
    return s;
  }

  /** Karts driving past on the title screen, one after another (side view). */
  private drawTitleKarts(out: Uint8Array) {
    const period = 96, speed = 1.13;
    for (let k = 0; k < 4; k++) {
      const launch = Math.floor(this.frame / period) - k;
      if (launch < 0) continue;
      const x = Math.round(-32 + (this.frame - launch * period) * speed);
      if (x > SCREEN_W) continue;
      const character = [6, 2, 0, 1, 7, 3, 5, 4][launch % 8];
      blit(out, this.titleDrivers[character][0][8], x, 160 + ((this.frame >> 3) & 1), false);
    }
  }

  private drawSelect(st: Extract<State, { s: 'select' }>): Screen {
    const s = this.select;
    s.layers[1].h = Math.floor(this.frame * 2 / 3) & 255; // LED sign
    const lobby = this.lobby;
    const others = lobby ? lobby.players.filter((p) => p.id !== lobby.selfId) : [];
    const blinkOn = (this.frame >> 3) % 2 === 0;
    const labels = lobby?.players.map((p, i) => {
      const mine = p.id === lobby.selfId;
      return {
        player: i + 1,
        tv: TV_CHARACTERS.indexOf(mine ? TV_CHARACTERS[st.tv] : p.ready ? p.character : p.cursor),
        show: (mine ? st.ok : p.ready) || blinkOn,
      };
    }) ?? [];
    for (let tv = 0; tv < 8; tv++) {
      tvMarker(s, tv, st.online ? null : tv === st.tv && (!st.online || blinkOn || st.ok) ? 1 : null);
      tvChosen(s, tv, (st.ok && tv === st.tv) || others.some((p) => p.ready && TV_CHARACTERS.indexOf(p.character) === tv));
    }
    okPrompt(s, st.ok);
    s.oam = createOam();
    if (lobby) {
      // 1P/2P use their real ROM BG tiles. Extra online players use an
      // extension in the same framed position/palette; only colliding cursors
      // fall back to small OAM text because a TV has one marker slot.
      const occupied = new Set<number>();
      const overlaps: typeof labels = [];
      for (const label of labels) {
        if (!label.show) continue;
        if (occupied.has(label.tv)) overlaps.push(label);
        else {
          tvMarker(s, label.tv, label.player);
          occupied.add(label.tv);
        }
      }
      let slot = 0;
      const perTv = new Map<number, number>();
      for (const t of overlaps) {
        const k = perTv.get(t.tv) ?? 0;
        perTv.set(t.tv, k + 1);
        const { x, y } = TV_SPRITE_POS[t.tv];
        // Several players on one TV: side by side, then a second row above.
        slot = spriteText(s.oam!, slot, x + 8 + (k % 3) * 16 - Math.floor(k / 3) * 8, y - 16 - Math.floor(k / 3) * 9, `${t.player}P`, 5, 3);
      }
      spriteText(s.oam!, slot, 16, 200, `ROOM ${lobby.code}  ${this.readyLine()}`, 5, 3);
    }
    return s;
  }

  /** Each TV shows its driver turning around. */
  private drawTvKarts(out: Uint8Array, st: Extract<State, { s: 'select' }> | null) {
    TV_CHARACTERS.forEach((c, tv) => {
      const { x, y } = TV_SPRITE_POS[tv];
      let step = (this.frame >> 3) % 32;
      if (st && tv !== st.tv) step = 12; // the others face the camera at three quarters
      const mirror = step > 15;
      const slot = mirror ? 31 - step : step;
      blit(out, this.selectDrivers[c][0][slot], x, y, mirror);
    });
  }

  private drawCup(st: Extract<State, { s: 'cup' | 'course' }>): Screen {
    const s = this.cup;
    // Lines fit between the icons going round the frame (rows 7-20).
    if (st.s === 'cup') buildCupMap(s, CUP_NAMES.slice(0, this.cupCount()).map((n) => `${n.replace(' Cup', '')} CUP RACE`.toUpperCase()), st.cursor, 8, 3);
    else buildCupMap(s, this.cupTracks(st.cup).map((t) => t.name.toUpperCase()), st.cursor, 7, 3);
    s.oam = createOam();
    let slot = cupBorder(s.oam, 0, this.frame);
    slot = cupTitle(s.oam, slot, this.cc);
    // Time Trial: the course's record (best time, best lap) under the list.
    if (!this.online && this.mode === 'tt' && st.s === 'course') {
      const track = this.cupTracks(st.cup)[st.cursor];
      const r = track ? trialRecord(this.rom.tracks.indexOf(track)) : null;
      const line = r?.times.length ? `BEST ${boardTime(r.times[0])}  LAP ${r.bestLap === null ? '-' : boardTime(r.bestLap)}` : 'NO RECORD';
      slot = bigSpriteText(s.oam, slot, 128 - line.length * 4, 208, line, 3);
    }
    if (this.online && this.lobby && (st.s === 'cup' || st.cup === BATTLE_CUP)) {
      const hint = this.mode === 'battle' ? 'B BATTLE' : this.mode === 'match' ? 'B CHOOSE COURSE' : 'B START GP';
      slot = bigSpriteText(s.oam, slot, 128 - hint.length * 4, 208, hint, 3);
      // The host keeps seeing who is in the room and who has chosen a driver.
      bigSpriteText(s.oam, slot, 128 - this.readyLine().length * 4, 0, this.readyLine(), 3);
    }
    return s;
  }

  /** "3P  2 OK": players in the room and how many have confirmed their driver. */
  private readyLine(): string {
    const players = this.lobby?.players ?? [];
    return `${players.length}P  ${players.filter((p) => p.ready).length} OK`;
  }
}

/** Copies a sprite frame (RGBA, alpha = 0 for transparent) onto the 256x224 output. */
function blit(out: Uint8Array, f: SpriteFrame, x0: number, y0: number, mirror: boolean) {
  for (let y = 0; y < f.h; y++) {
    const sy = y0 + y;
    if (sy < 0 || sy >= SCREEN_H) continue;
    for (let x = 0; x < f.w; x++) {
      const sx = x0 + x;
      if (sx < 0 || sx >= SCREEN_W) continue;
      const q = (y * f.w + (mirror ? f.w - 1 - x : x)) * 4;
      if (!f.pixels[q + 3]) continue;
      const o = (sy * SCREEN_W + sx) * 4;
      out[o] = f.pixels[q]; out[o + 1] = f.pixels[q + 1]; out[o + 2] = f.pixels[q + 2]; out[o + 3] = 255;
    }
  }
}
