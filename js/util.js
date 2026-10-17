// Small math / RNG / colour helpers (lifted from Eye of the Storm, plus blackbody colour).
export const DEG = Math.PI / 180;
export const TAU = Math.PI * 2;
export const clamp = (x, a, b) => (x < a ? a : x > b ? b : x);
export const sat = (x) => (x < 0 ? 0 : x > 1 ? 1 : x);
export const lerp = (a, b, t) => a + (b - a) * t;
export const invLerp = (a, b, x) => sat((x - a) / (b - a));
export const smoothstep = (a, b, x) => { const t = sat((x - a) / (b - a)); return t * t * (3 - 2 * t); };
export const expDecay = (dt, tau) => 1 - Math.exp(-dt / Math.max(1e-5, tau));

export function mulberry32(seed) {
  let a = seed >>> 0;
  return () => { a = (a + 0x6D2B79F5) >>> 0; let t = a; t = Math.imul(t ^ (t >>> 15), t | 1); t ^= t + Math.imul(t ^ (t >>> 7), t | 61); return ((t ^ (t >>> 14)) >>> 0) / 4294967296; };
}

/** A value that eases toward its target with time constant tau (seconds). */
export class Damped {
  constructor(v = 0, tau = 0.3) { this.v = v; this.target = v; this.tau = tau; }
  update(dt) { this.v += (this.target - this.v) * expDecay(dt, this.tau); return this.v; }
  snap(v = this.target) { this.v = this.target = v; return v; }
}

// MessageChannel yields are not throttled in background tabs, so loading never stalls.
export const yieldTask = () => new Promise((r) => { const c = new MessageChannel(); c.port1.onmessage = () => r(); c.port2.postMessage(0); });

/** Camera focal length (mm, full-frame 24 mm sensor height) → vertical FOV (deg). */
export const fovFromFocal = (mm) => 2 * Math.atan(12 / mm) / DEG;

/**
 * Blackbody colour in LINEAR sRGB, normalised to unit luminance (Y = 1).
 * Planck spectrum integrated against the CIE 1931 2° observer (Wyman, Sloan & Shirley 2013 multi-lobe fit).
 */
export function blackbody(T) {
  const g = (x, mu, s1, s2) => { const t = (x - mu) / (x < mu ? s1 : s2); return Math.exp(-0.5 * t * t); };
  let X = 0, Y = 0, Z = 0;
  for (let l = 380; l <= 780; l += 5) {
    const xb = 1.056 * g(l, 599.8, 37.9, 31.0) + 0.362 * g(l, 442.0, 16.0, 26.7) - 0.065 * g(l, 501.1, 20.4, 26.2);
    const yb = 0.821 * g(l, 568.8, 46.9, 40.5) + 0.286 * g(l, 530.9, 16.3, 31.1);
    const zb = 1.217 * g(l, 437.0, 11.8, 36.0) + 0.681 * g(l, 459.0, 26.0, 13.8);
    const lm = l * 1e-9, B = 1 / (Math.pow(lm, 5) * (Math.exp(1.4388e-2 / (lm * T)) - 1));
    X += xb * B; Y += yb * B; Z += zb * B;
  }
  X /= Y; Z /= Y; Y = 1;
  const r = 3.2406 * X - 1.5372 * Y - 0.4986 * Z, gg = -0.9689 * X + 1.8758 * Y + 0.0415 * Z, b = 0.0557 * X - 0.2040 * Y + 1.0570 * Z;
  return [Math.max(r, 0), Math.max(gg, 0), Math.max(b, 0)];
}

/** Seeded CPU noise (Eye of the Storm): 2D Perlin gradient noise and 3D value noise. */
export class Noise {
  constructor(seed) {
    const r = mulberry32(seed), p = new Uint8Array(256);
    for (let i = 0; i < 256; i++) p[i] = i;
    for (let i = 255; i > 0; i--) { const j = Math.floor(r() * (i + 1)); const t = p[i]; p[i] = p[j]; p[j] = t; }
    this.p = new Uint8Array(512); for (let i = 0; i < 512; i++) this.p[i] = p[i & 255];
    this.gx = new Float32Array(256); this.gy = new Float32Array(256); this.v = new Float32Array(256);
    for (let i = 0; i < 256; i++) { const a = r() * TAU; this.gx[i] = Math.cos(a); this.gy[i] = Math.sin(a); this.v[i] = r() * 2 - 1; }
  }
  n2(x, y) {
    const P = this.p, xi = Math.floor(x), yi = Math.floor(y), xf = x - xi, yf = y - yi, X = xi & 255, Y = yi & 255;
    const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
    const a = P[P[X] + Y], b = P[P[X + 1] + Y], c = P[P[X] + Y + 1], d = P[P[X + 1] + Y + 1];
    const ga = this.gx[a] * xf + this.gy[a] * yf, gb = this.gx[b] * (xf - 1) + this.gy[b] * yf;
    const gc = this.gx[c] * xf + this.gy[c] * (yf - 1), gd = this.gx[d] * (xf - 1) + this.gy[d] * (yf - 1);
    return (ga + (gb - ga) * u + (gc - ga) * v + (ga - gb - gc + gd) * u * v) * 1.414;
  }
  /** fbm in [0, 1] */
  fbm2(x, y, oct = 4) {
    let s = 0, a = 0.5, n = 0;
    for (let i = 0; i < oct; i++) { s += a * this.n2(x, y); n += a; x = x * 2.03 + 17.1; y = y * 2.03 - 9.3; a *= 0.5; }
    return sat(0.5 + 0.5 * s / n * 1.25);
  }
  /** ridged fbm in [0, 1]: sharp crests, the look of eroded hill ridgelines */
  ridged2(x, y, oct = 5) {
    let s = 0, a = 0.5, n = 0, w = 1;
    for (let i = 0; i < oct; i++) { let v = 1 - Math.abs(this.n2(x, y)); v *= v * w; w = clamp(v * 1.6, 0, 1); s += a * v; n += a; x = x * 2.07 + 31.7; y = y * 2.07 - 12.9; a *= 0.5; }
    return s / n;
  }
  n3(x, y, z) {
    const P = this.p, V = this.v, xi = Math.floor(x), yi = Math.floor(y), zi = Math.floor(z);
    let xf = x - xi, yf = y - yi, zf = z - zi;
    xf = xf * xf * (3 - 2 * xf); yf = yf * yf * (3 - 2 * yf); zf = zf * zf * (3 - 2 * zf);
    const X = xi & 255, Y = yi & 255, Z = zi & 255;
    const h = (i, j, k) => V[P[P[P[(X + i) & 255] + ((Y + j) & 255)] + ((Z + k) & 255)]];
    const x00 = lerp(h(0, 0, 0), h(1, 0, 0), xf), x10 = lerp(h(0, 1, 0), h(1, 1, 0), xf);
    const x01 = lerp(h(0, 0, 1), h(1, 0, 1), xf), x11 = lerp(h(0, 1, 1), h(1, 1, 1), xf);
    return lerp(lerp(x00, x10, yf), lerp(x01, x11, yf), zf);
  }
}
