// Dev tool: renders the menu screens headless (fake canvas) to PNG, driving them with simulated buttons.
// Usage: npx tsx tools/menu-shots.ts "<rom.sfc>" <out-dir>
import { readFileSync } from 'node:fs';
import { SmkRom } from '../src/rom/rom';
import { MenuApp } from '../src/menu/app';
import { savePng } from './ppu-check';

(globalThis as any).location = { search: '' };
const rom = new SmkRom(new Uint8Array(readFileSync(process.argv[2])));
const out = process.argv[3];
let last: Uint8Array | null = null;
const canvas = {
  width: 0, height: 0,
  getContext: () => ({
    createImageData: (w: number, h: number) => ({ data: new Uint8ClampedArray(w * h * 4), width: w, height: h }),
    putImageData: (img: { data: Uint8ClampedArray }) => { last = new Uint8Array(img.data); },
  }),
} as unknown as HTMLCanvasElement;
const log: string[] = [];
const app = new MenuApp(rom, canvas, {
  solo: (c) => log.push(`solo ${c.mode} ${c.cc}cc personagem=${c.character} pistas=${c.tracks.map((t) => t.name).join('/')}`),
  online: (c) => log.push(`online ${c.code ?? 'criar'} ${c.cc}cc`),
  onlineCharacter: (c) => log.push(`online personagem ${c}`),
  onlineStart: (c) => log.push(`online iniciar ${c.mode} ${c.tracks.length} pistas`),
  onlineLeave: () => log.push('online sair'),
});
const a = app as any;
let n = 0;
const shot = (name: string, frames = 30) => { for (let i = 0; i < frames; i++) { a.frame++; } a.draw(); savePng(`${out}/${String(++n).padStart(2, '0')}-${name}.png`, last!); };
const press = (k: string) => a.press(k);

shot('titulo', 200);
press('start'); shot('menu-principal');
press('b'); shot('mario-kart-gp-ou-time-trial');
press('b'); shot('cilindrada');
press('down'); shot('cilindrada-100');
press('b'); shot('confirmacao');
press('b'); shot('selecao-piloto', 40);
press('right'); press('right'); shot('selecao-cursor-bowser', 20);
press('b'); shot('selecao-ok');
press('b'); shot('copas');
press('down'); shot('copas-flor');
press('b');
console.log(log.join('\n'));
// Time trial path
app.toTitle();
press('start'); press('b'); press('down'); press('b'); press('b'); press('b'); press('b');
shot('tt-copas'); press('b'); shot('tt-pistas'); press('down'); press('down'); shot('tt-pistas-3'); press('b');
// Online path
app.toTitle(); press('start'); press('down'); shot('menu-online'); press('b'); shot('online-criar-entrar'); press('down'); press('b');
for (const ch of 'ab3') a.typeCode(ch.toUpperCase()); shot('codigo-sala');
console.log(log.slice(1).join('\n'));
// Online lobby: this player is 2P; 1P has confirmed Mario, 3P is looking at Bowser.
const lobby = (isHost: boolean, myReady = false) => ({
  code: 'AB3CD', isHost, selfId: 2, status: '',
  players: [
    { id: 1, character: 0, cursor: 0, ready: true, name: 'Mario' },
    { id: 2, character: 1, cursor: 1, ready: myReady, name: 'Luigi' },
    { id: 3, character: 2, cursor: 2, ready: false, name: 'Bowser' },
  ],
});
app.enterLobby(lobby(false)); shot('lobby-selecao', 8);
press('b'); press('b'); shot('lobby-aguardando-anfitriao');
app.updateLobby(lobby(true, true)); shot('lobby-virou-anfitriao-copas');

// Eight-player extension: 1P/2P are the original ROM tiles; 3P..8P use the
// same framed marker so multiplayer labels do not fall back to mismatched text.
app.enterLobby({
  code: 'AB3CD', isHost: false, selfId: 2, status: '',
  players: Array.from({ length: 8 }, (_, i) => ({
    id: i + 1, character: i, cursor: i, ready: i !== 1, name: `P${i + 1}`,
  })),
});
a.state.ok = true;
shot('lobby-8p-marcadores', 1);
const marker = (tv: number) => {
  const col = 6 + (tv % 4) * 6, row = 8 + Math.floor(tv / 4) * 8;
  const at = 0x4800 + (row * 32 + col) * 2;
  return [a.select.vram[at] | (a.select.vram[at + 1] << 8), a.select.vram[at + 2] | (a.select.vram[at + 3] << 8)];
};
for (const [tv, expected] of [[0, 0x1815], [4, 0x1817], [2, 0x1850], [1, 0x1851], [6, 0x1852], [3, 0x1853], [7, 0x1854], [5, 0x1855]] as const) {
  if (marker(tv)[0] !== expected) throw new Error(`marcador ${tv}: esperado ${expected.toString(16)}, recebido ${marker(tv)[0].toString(16)}`);
}
console.log('marcadores 1P..8P: OK');
