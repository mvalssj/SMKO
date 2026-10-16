// DSP-1 commands as math (analysis only, no chip data): fixed point Q15, angles 65536 a turn. The simple ones
// (multiply, rotate, distance...) are exact up to rounding; the projection ones (parameter, raster, project)
// are the geometry they compute, in floating point, rounded at the end.
const TAU = Math.PI * 2;
const clamp16 = (v) => Math.max(-32768, Math.min(32767, Math.trunc(v)));
const sin = (a) => clamp16(Math.round(Math.sin((a * TAU) / 65536) * 32767));
const cos = (a) => clamp16(Math.round(Math.cos((a * TAU) / 65536) * 32767));
const mul = (a, b) => (a * b) >> 15;

export function makeOps() {
  const st = {};
  const ops = {
    0x00: ([a, b]) => [clamp16(mul(a, b))],
    0x20: ([a, b]) => [clamp16(mul(a, b) + 1)],
    0x10: ([c, e]) => {
      // 1 / (c * 2^e) as coefficient * 2^exponent.
      if (c === 0) return [0x7fff, 0x002f];
      let sign = 1, cc = c, ee = e;
      if (cc < 0) { sign = -1; cc = Math.min(32767, -cc); }
      while (cc < 0x4000) { cc <<= 1; ee--; }
      let ic = cc === 0x4000 ? 0x7fff : Math.min(0x7fff, Math.floor(2 ** 29 / cc));
      return [clamp16(ic * sign), clamp16(1 - ee)];
    },
    0x04: ([a, r]) => [clamp16(mul(r, sin(a))), clamp16(mul(r, cos(a)))],
    0x08: ([x, y, z]) => { const v = (x * x + y * y + z * z) * 2; return [v & 0xffff, (v >>> 16) & 0xffff]; },
    0x18: ([x, y, z, r]) => [clamp16((x * x + y * y + z * z - r * r) >> 15)],
    0x38: ([x, y, z, r]) => [clamp16(((x * x + y * y + z * z - r * r) >> 15) + 1)],
    0x28: ([x, y, z]) => [clamp16(Math.floor(Math.sqrt(x * x + y * y + z * z)))],
    0x0c: ([a, x, y]) => {
      const s = sin(a), c = cos(a);
      return [clamp16(mul(y, s) + mul(x, c)), clamp16(mul(y, c) - mul(x, s))];
    },
    0x02: ([fx, fy, fz, lfe, les, aas, azs]) => {
      Object.assign(st, { fx, fy, fz, lfe, les, aas, azs });
      const sA = Math.sin((aas * TAU) / 65536), cA = Math.cos((aas * TAU) / 65536);
      const sZ = Math.sin((azs * TAU) / 65536), cZ = Math.cos((azs * TAU) / 65536);
      // Unit normal of the screen (from the point looked at towards the eye), the eye, the screen's centre.
      st.n = [sZ * -sA, sZ * cA, cZ];
      st.eye = [fx + lfe * st.n[0], fy + lfe * st.n[1], fz + lfe * st.n[2]];
      st.g = [st.eye[0] - les * st.n[0], st.eye[1] - les * st.n[1], st.eye[2] - les * st.n[2]];
      st.h = [cA, sA, 0];
      st.v = [-cZ * sA, cZ * cA, -sZ];
      st.sA = sA; st.cA = cA; st.sZ = sZ; st.cZ = cZ;
      // Where the line of sight meets the ground (z = 0): the screen centre on the floor.
      const t = st.eye[2] / Math.max(1e-6, cZ);
      const cx = st.eye[0] - st.n[0] * t, cy = st.eye[1] - st.n[1] * t;
      // Screen line of the horizon (rows from the centre).
      const vva = cZ > 1e-6 ? -les * sZ / cZ : -32768;
      return [0, clamp16(vva), clamp16(cx), clamp16(cy)];
    },
    0x06: ([x, y, z]) => {
      if (!st.n) return [0, 0, 0];
      const p = [x - st.g[0], y - st.g[1], z - st.g[2]];
      const depth = st.les - (p[0] * st.n[0] + p[1] * st.n[1] + p[2] * st.n[2]);
      const k = depth > 1e-6 ? st.les / depth : 0;
      const h = (p[0] * st.h[0] + p[1] * st.h[1]) * k;
      const v = (p[0] * st.v[0] + p[1] * st.v[1] + p[2] * st.v[2]) * k;
      return [clamp16(Math.round(h)), clamp16(Math.round(v)), clamp16(Math.round(k * 256))];
    },
  };
  ops.st = st;
  return ops;
}
