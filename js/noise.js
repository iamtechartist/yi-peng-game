// Noise textures. NoiseVolumes and the blue-noise builder are Eye of the Storm's (moved, not rewritten).
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FS_VERT, COMMON } from './glsl.js';
import { mulberry32, yieldTask } from './util.js';

/* 3D noise built ON THE GPU at startup, slice by slice into WebGL3DRenderTargets.
     base   (64³ Low, 128³ Medium/High): R = Perlin-Worley shape, G = Worley fbm (billows),
            B = Perlin fbm (mist / cirrus), A = Worley at 2× frequency.
     detail (32³): R = high-frequency Worley fbm used to erode cloud edges.
   Both tile seamlessly in all three axes. */
const NOISE_GEN = COMMON + /* glsl */`
in vec2 vUv;
uniform float uZ;
layout(location = 0) out vec4 fragColor;
float gnoise(vec3 x, float per) {
  vec3 p = floor(x), w = fract(x);
  vec3 u = w * w * w * (w * (w * 6.0 - 15.0) + 10.0);
  #define G(o) (hash33(mod(p + o, per)) * 2.0 - 1.0)
  float a = dot(G(vec3(0,0,0)), w - vec3(0,0,0)), b = dot(G(vec3(1,0,0)), w - vec3(1,0,0));
  float c = dot(G(vec3(0,1,0)), w - vec3(0,1,0)), d = dot(G(vec3(1,1,0)), w - vec3(1,1,0));
  float e = dot(G(vec3(0,0,1)), w - vec3(0,0,1)), f = dot(G(vec3(1,0,1)), w - vec3(1,0,1));
  float g = dot(G(vec3(0,1,1)), w - vec3(0,1,1)), h = dot(G(vec3(1,1,1)), w - vec3(1,1,1));
  return mix(mix(mix(a, b, u.x), mix(c, d, u.x), u.y), mix(mix(e, f, u.x), mix(g, h, u.x), u.y), u.z);
}
float perlinFbm(vec3 p, float freq, int oct) {
  float amp = 1.0, n = 0.0, G = exp2(-0.85);
  for (int i = 0; i < 8; i++) { if (i >= oct) break; n += amp * gnoise(p * freq, freq); freq *= 2.0; amp *= G; }
  return n;
}
float worley(vec3 p, float freq) {
  vec3 id = floor(p * freq), f = fract(p * freq);
  float md = 1e4;
  for (int z = -1; z <= 1; z++) for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec3 o = vec3(x, y, z);
    vec3 h = hash33(mod(id + o, freq));
    vec3 d = f - o - h;
    md = min(md, dot(d, d));
  }
  return 1.0 - md;
}
float worleyFbm(vec3 p, float f) { return worley(p, f) * 0.625 + worley(p, f * 2.0) * 0.25 + worley(p, f * 4.0) * 0.125; }
void main() {
  vec3 p = vec3(vUv, uZ);
#if MODE == 0
  float pf = mix(1.0, perlinFbm(p, 4.0, 7), 0.5);
  pf = abs(pf * 2.0 - 1.0);
  float w0 = worleyFbm(p, 4.0), w1 = worleyFbm(p, 8.0), w2 = worleyFbm(p, 16.0);
  float pw = remap(pf, 0.0, 1.0, w0, 1.0);
  float lowF = w0 * 0.625 + w1 * 0.25 + w2 * 0.125;
  float shape = sat(remap(pw, lowF - 1.0, 1.0, 0.0, 1.0));
  shape = pow(sat((shape - 0.5) / 0.5), 1.25);
  float pf2 = sat(0.5 + 0.5 * perlinFbm(p, 2.0, 5));
  fragColor = vec4(shape, w1, pf2, w2);
#else
  float d0 = worleyFbm(p, 2.0), d1 = worleyFbm(p, 4.0), d2 = worley(p, 8.0);
  fragColor = vec4(d0 * 0.625 + d1 * 0.25 + d2 * 0.125, d1, d2, 1.0);
#endif
}
`;

export class NoiseVolumes {
  constructor(renderer) {
    this.r = renderer;
    const mk = (n) => {
      const rt = new THREE.WebGL3DRenderTarget(n, n, n, { format: THREE.RGBAFormat, type: THREE.UnsignedByteType, depthBuffer: false, generateMipmaps: false });
      const t = rt.texture;
      t.wrapS = t.wrapT = t.wrapR = THREE.RepeatWrapping; t.minFilter = t.magFilter = THREE.LinearFilter; t.generateMipmaps = false;
      return rt;
    };
    this.base = mk(4); this.detail = mk(4);
    const mat = (mode) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: NOISE_GEN, uniforms: { uZ: { value: 0 } }, defines: { MODE: mode }, depthTest: false, depthWrite: false });
    this.matBase = mat(0); this.matDetail = mat(1);
    this.quad = new FullScreenQuad(this.matBase);
    this.n = 0;
  }
  async build(baseN, detailN, onSlice) {
    const r = this.r, prev = r.getRenderTarget();
    const pass = async (rt, n, mat) => {
      if (rt.width !== n) rt.setSize(n, n, n);
      this.quad.material = mat;
      for (let z = 0; z < n; z++) {
        mat.uniforms.uZ.value = (z + 0.5) / n;
        r.setRenderTarget(rt, z);
        this.quad.render(r);
        if ((z & 15) === 15) { if (onSlice) onSlice(z / n); await yieldTask(); }
      }
    };
    await pass(this.base, baseN, this.matBase);
    await pass(this.detail, detailN, this.matDetail);
    r.setRenderTarget(prev);
    this.n = baseN;
  }
}

/** 64×64 void-and-cluster blue noise rank texture (CPU). */
export function buildBlueNoise(N = 64, seed = 1) {
  const n = N * N, rnd = mulberry32(seed), M = N - 1;
  const bits = new Uint8Array(n), rank = new Uint16Array(n), E = new Float32Array(n);
  const R = 6, W = 2 * R + 1, K = new Float32Array(W * W);
  for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) K[(dy + R) * W + dx + R] = Math.exp(-(dx * dx + dy * dy) / (2 * 1.5 * 1.5));
  const splat = (idx, s) => {
    const x = idx & M, y = idx >> 6;
    for (let dy = -R; dy <= R; dy++) { const row = ((y + dy) & M) * N; for (let dx = -R; dx <= R; dx++) E[row + ((x + dx) & M)] += s * K[(dy + R) * W + dx + R]; }
  };
  const argmax = (want) => { let b = -1, bv = -1e9; for (let i = 0; i < n; i++) if (bits[i] === want && E[i] > bv) { bv = E[i]; b = i; } return b; };
  const argmin = (want) => { let b = -1, bv = 1e9; for (let i = 0; i < n; i++) if (bits[i] === want && E[i] < bv) { bv = E[i]; b = i; } return b; };
  const ones = Math.floor(n * 0.1);
  let placed = 0;
  while (placed < ones) { const i = Math.floor(rnd() * n); if (!bits[i]) { bits[i] = 1; splat(i, 1); placed++; } }
  for (let it = 0; it < 4096; it++) {
    const t = argmax(1); bits[t] = 0; splat(t, -1);
    const v = argmin(0);
    bits[v] = 1; splat(v, 1);
    if (v === t) break;
  }
  const proto = bits.slice(), Ep = E.slice();
  for (let rk = ones - 1; rk >= 0; rk--) { const t = argmax(1); bits[t] = 0; splat(t, -1); rank[t] = rk; }
  bits.set(proto); E.set(Ep);
  for (let rk = ones; rk < n / 2; rk++) { const v = argmin(0); bits[v] = 1; splat(v, 1); rank[v] = rk; }
  E.fill(0); for (let i = 0; i < n; i++) if (!bits[i]) splat(i, 1);
  for (let rk = n / 2; rk < n; rk++) { const t = argmax(0); bits[t] = 1; splat(t, -1); rank[t] = rk; }
  const out = new Uint8Array(n);
  for (let i = 0; i < n; i++) out[i] = Math.floor((rank[i] / n) * 256);
  const tex = new THREE.DataTexture(out, N, N, THREE.RedFormat, THREE.UnsignedByteType);
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping; tex.minFilter = tex.magFilter = THREE.NearestFilter; tex.needsUpdate = true;
  return tex;
}

/**
 * Tileable river-ripple SLOPE texture with LEAN moments for filtering:
 *   RGBA = (∂h/∂x, ∂h/∂z, (∂h/∂x)², (∂h/∂z)²), a box-filtered mip chain built on the CPU, so a
 *   footprint's mean slope and slope VARIANCE come out of one trilinear fetch (variance = E[s²] − E[s]²).
 * The height field is periodic gradient noise with a k^-2 spectrum (short wind ripples dominate the
 * slopes), slightly stretched across the flow. Slopes are normalised to an rms of 1; the shader scales.
 */
export function buildRippleTexture(N = 256, seed = 11) {
  const rnd = mulberry32(seed);
  const h = new Float32Array(N * N);
  const octs = [[4, 1.0], [8, 0.55], [16, 0.3], [32, 0.16], [64, 0.08]];
  for (const [P, amp] of octs) {
    const Py = Math.round(P * 1.25);   // more lattice cells along z: ripples elongated across the flow (x)
    const gx = new Float32Array(P * Py), gy = new Float32Array(P * Py);
    for (let i = 0; i < P * Py; i++) { const a = rnd() * Math.PI * 2; gx[i] = Math.cos(a); gy[i] = Math.sin(a); }
    for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
      const fx = (x / N) * P, fy = (y / N) * Py;
      const xi = Math.floor(fx), yi = Math.floor(fy), xf = fx - xi, yf = fy - yi;
      const u = xf * xf * xf * (xf * (xf * 6 - 15) + 10), v = yf * yf * yf * (yf * (yf * 6 - 15) + 10);
      const idx = (i, j) => ((yi + j) % Py) * P + ((xi + i) % P);
      const dot = (i, j) => { const k = idx(i, j); return gx[k] * (xf - i) + gy[k] * (yf - j); };
      const a = dot(0, 0), b = dot(1, 0), c = dot(0, 1), d = dot(1, 1);
      h[y * N + x] += amp / P * (a + (b - a) * u + (c - a) * v + (a - b - c + d) * u * v);
    }
  }
  // slopes (periodic central differences), normalised to unit rms
  const sx = new Float32Array(N * N), sz = new Float32Array(N * N);
  let ms = 0;
  for (let y = 0; y < N; y++) for (let x = 0; x < N; x++) {
    const i = y * N + x;
    sx[i] = (h[y * N + ((x + 1) % N)] - h[y * N + ((x + N - 1) % N)]) * 0.5 * N;
    sz[i] = (h[((y + 1) % N) * N + x] - h[((y + N - 1) % N) * N + x]) * 0.5 * N;
    ms += sx[i] * sx[i] + sz[i] * sz[i];
  }
  const k = 1 / Math.sqrt(ms / (N * N) / 2);
  let lvl = new Float32Array(N * N * 4);
  for (let i = 0; i < N * N; i++) { const a = sx[i] * k, b = sz[i] * k; lvl[i * 4] = a; lvl[i * 4 + 1] = b; lvl[i * 4 + 2] = a * a; lvl[i * 4 + 3] = b * b; }
  const toHalf = (f) => { const o = new Uint16Array(f.length); for (let i = 0; i < f.length; i++) o[i] = THREE.DataUtils.toHalfFloat(f[i]); return o; };
  const mips = [{ data: toHalf(lvl), width: N, height: N }];
  let n = N;
  while (n > 1) {
    const m = n >> 1, nx = new Float32Array(m * m * 4);
    for (let y = 0; y < m; y++) for (let x = 0; x < m; x++) for (let c = 0; c < 4; c++) {
      nx[(y * m + x) * 4 + c] = 0.25 * (lvl[((2 * y) * n + 2 * x) * 4 + c] + lvl[((2 * y) * n + 2 * x + 1) * 4 + c] + lvl[((2 * y + 1) * n + 2 * x) * 4 + c] + lvl[((2 * y + 1) * n + 2 * x + 1) * 4 + c]);
    }
    lvl = nx; n = m; mips.push({ data: toHalf(lvl), width: n, height: n });
  }
  const tex = new THREE.DataTexture(mips[0].data, N, N, THREE.RGBAFormat, THREE.HalfFloatType);
  tex.mipmaps = mips;
  tex.wrapS = tex.wrapT = THREE.RepeatWrapping;
  tex.minFilter = THREE.LinearMipmapLinearFilter; tex.magFilter = THREE.LinearFilter;
  tex.generateMipmaps = false; tex.anisotropy = 4; tex.needsUpdate = true;
  return tex;
}
