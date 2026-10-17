// The air of the run: one warm column from the release on the river up into the cloud (the 30-second run's dangers
// are laid out in beats.js; this is the field the background swarm rides and the plane you fly in follows).
// (Below: the original thermal-chain field, kept general: segments and shear gaps.)
//   SEGMENTS: rising columns of warm air (the town and the river give off the day's heat). Core updraft w (m/s)
//     is flat across the inner half of the column and falls off outside it; the air swirls slowly and drifts with
//     the column.
//   GAPS between them: crosswind shear (the layers where the wind turns). Lift collapses there, the air shoves
//     sideways, and the next segment starts 70–90 m away: the column jogs. Lanterns riding the thermal slow down
//     in the gaps and bunch up (the crowded, dangerous parts of the climb).
//   The swarm rides the same field (swarm.js): the release lanterns near the base are drawn in, and a steady feed
//   of earlier lanterns fills the whole column, so the way up is always marked by a helix of lights above you.
// Units: metres, m/s; azimuth from east toward north (−z), like the moon's.
import { smoothstep } from './util.js';

export const COURSE = {
  start: [-14, 6],                       // the release, on the river (also the thermal's foot)
  lean: [0.05, 0.02],                    // the column leans gently downwind (m per m of height)
  // the 30-second run: one warm column all the way up (the beats bring the danger, not the air)
  segs: [{ y0: 0, y1: 2100, w: 26, R: 50, cloud: true }],
  gaps: [],
  checkpoints: [],
  residual: 0.3,
};

const S = COURSE.segs, G = COURSE.gaps;
const toward = (az) => [Math.cos(az * Math.PI / 180), -Math.sin(az * Math.PI / 180)];
for (const g of G) g.dir = toward(g.az);

/** Centreline of the thermal at height h (world x, z). */
export function colCenter(h, out) {
  let x = COURSE.start[0] + COURSE.lean[0] * h, z = COURSE.start[1] + COURSE.lean[1] * h;
  for (const g of G) { const s = smoothstep(g.y0, g.y1, h); x += g.off[0] * s; z += g.off[1] * s; }
  // a slow wobble so no stretch of the column is ruler-straight
  x += 9 * Math.sin(h / 140 + 0.7) * smoothstep(0, 120, h); z += 7 * Math.sin(h / 190 + 2.1) * smoothstep(0, 120, h);
  out[0] = x; out[1] = z;
  return out;
}

/** Core updraft (m/s) and radius (m) at height h: full in a segment (tapered over its first and last 25 m into
 *  the residual of the gaps), the residual in a gap, none above the last segment. */
export function core(h, out) {
  let w = 0, R = S[0].R;
  for (let k = 0; k < S.length; k++) {
    const s = S[k];
    if (h >= s.y0 - 30 && h <= s.y1 + 30) {
      const t = smoothstep(s.y0 - 15, s.y0 + 15, h) * (1 - smoothstep(s.y1 - 15, s.y1 + 15, h));
      const resid = k < S.length - 1 || h < s.y1 ? COURSE.residual : 0;
      w = Math.max(w, s.w * (resid + (1 - resid) * t)); R = s.R;
    }
  }
  if (h < S[0].y0) w = S[0].w;
  for (const g of G) if (h > g.y0 && h < g.y1) { w = Math.max(w, S[0].w * COURSE.residual); }
  out[0] = w; out[1] = R;
  return out;
}

/** Crosswind of the shear layers at height h (added to the ambient wind): a smooth bump over each gap. */
export function shear(h, out) {
  out[0] = 0; out[1] = 0;
  for (const g of G) {
    const m = 0.5 * (g.y1 - g.y0) + 20, c = 0.5 * (g.y0 + g.y1);
    const s = Math.max(0, 1 - ((h - c) / m) ** 2);
    if (s > 0) { out[0] += g.dir[0] * g.wind * s; out[1] += g.dir[1] * g.wind * s; }
  }
  return out;
}

/** Which stretch of the course height h is in: { kind: 'seg' | 'gap' | 'above', i }. */
export function stretch(h) {
  for (let k = 0; k < G.length; k++) if (h >= G[k].y0 && h < G[k].y1) return { kind: 'gap', i: k };
  for (let k = 0; k < S.length; k++) if (h >= S[k].y0 && h < S[k].y1) return { kind: 'seg', i: k };
  return { kind: 'above', i: S.length };
}

/** The radial lift profile: flat-topped (a thermal's core is broad, ~half its radius), then falling off: 8 % at r = R. */
export const lift = (r, R) => { const u = r / R - 0.5; return u <= 0 ? 1 : Math.exp(-10 * u * u); };

/* The climb column's top under (x, z) at cloud-wind offset (wx, wz): mirrors cloudTop() in clouds.js (the same
   integer hash), so the game can tell the moment your lantern comes out of it. */
const vh = (ix, iz) => {
  const ux = (ix + 65536) >>> 0, uz = (iz + 65536) >>> 0;
  let h = (Math.imul(ux, 1597334677) ^ Math.imul(uz, 3812015801)) >>> 0;
  h = (Math.imul(h, 747796405) + 2891336453) >>> 0;
  h = Math.imul(((h >>> (((h >>> 28) + 4) >>> 0)) ^ h) >>> 0, 277803737) >>> 0;
  h = ((h >>> 22) ^ h) >>> 0;
  return h / 4294967295;
};
const vnoise = (x, z) => {
  const ix = Math.floor(x), iz = Math.floor(z); let fx = x - ix, fz = z - iz;
  fx = fx * fx * (3 - 2 * fx); fz = fz * fz * (3 - 2 * fz);
  const a = vh(ix, iz), b = vh(ix + 1, iz), c = vh(ix, iz + 1), d = vh(ix + 1, iz + 1);
  return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fz;
};
export function colTopAt(x, z, wx, wz, colTop = 800, base = 540, out = {}) {
  const qx = x + wx, qz = z + wz;
  const top = colTop + 70 * (vnoise(qx / 260, qz / 260) - 0.5) + 36 * (vnoise(qx / 105 + 7.3, qz / 105 + 7.3) - 0.5)
    + 16 * (vnoise(qx / 38 + 3.1, qz / 38 + 3.1) - 0.5) + 7 * (vnoise(qx / 15 + 5.7, qz / 15 + 5.7) - 0.5);
  out.cap = top;                                // where the last wisps end
  out.surface = top - 0.022 * (top - base);     // where the fog is thin enough to see out (the column's top fades over hf 0.955–1)
  return out;
}
