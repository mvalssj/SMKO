// Super Mario Kart LZ-style decompressor.
// Format documented by the Epic Edit project (GPL-3); this is an independent TypeScript implementation.
//
// Each command byte: top 3 bits = command, low 5 bits = count-1.
// Command 7 extends the count to 10 bits: next 3 bits are the real command.
// 0xFF ends the stream.

export function decompress(src: Uint8Array, offset = 0): Uint8Array {
  let out = new Uint8Array(0x8000);
  let o = 0;
  let s = offset;

  const ensure = (n: number) => {
    if (o + n <= out.length) return;
    let size = out.length;
    while (o + n > size) size *= 2;
    const next = new Uint8Array(size);
    next.set(out);
    out = next;
  };

  while (s < src.length) {
    const value = src[s++];
    if (value === 0xff) break;

    let command = value >> 5;
    let count: number;
    if (command === 7) {
      command = (value & 0x1c) >> 2;
      count = ((value & 3) << 8) + src[s++];
    } else {
      count = value & 0x1f;
    }
    count++;
    ensure(count);

    switch (command) {
      case 0: // literal bytes
        for (let i = 0; i < count; i++) out[o++] = src[s++];
        break;
      case 1: // repeat one byte
        for (let i = 0; i < count; i++) out[o++] = src[s];
        s++;
        break;
      case 2: // repeat two bytes alternately
        for (let i = 0; i < count; i++) out[o++] = src[s + (i & 1)];
        s += 2;
        break;
      case 3: // incrementing byte
        for (let i = 0; i < count; i++) out[o++] = (src[s] + i) & 0xff;
        s++;
        break;
      case 4: // copy from absolute output position
      case 5: { // same, inverted
        const from = src[s] | (src[s + 1] << 8);
        s += 2;
        const xor = command === 5 ? 0xff : 0;
        for (let i = 0; i < count; i++) out[o++] = out[from + i] ^ xor;
        break;
      }
      case 6: { // copy from relative output position
        let from = o - src[s++];
        for (let i = 0; i < count; i++) out[o++] = out[from++];
        break;
      }
      default:
        throw new Error(`Dados comprimidos inválidos (comando ${command}) em 0x${(s - 1).toString(16)}`);
    }
  }

  return out.slice(0, o);
}
