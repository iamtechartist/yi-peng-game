// The photographic pipeline. Scene → HDR (half-float, optional MSAA, float depth) → LENS:
//   1 depth of field (round bokeh, half-res scatter-as-gather)  2 soft wide bloom  3 lateral chromatic aberration
//   toward the corners  4 gentle vignette  5 sensor noise  → exposure (EV100) + white balance → AgX → sRGB.
// No lens flares. Only two full-resolution passes (the scene and the final): the river mist, the DoF and the
// bloom all run at half resolution or below (each full-res pass costs ~1.5 ms on ANGLE-Metal).
// Bloom / exposure / quad plumbing follow Eye of the Storm's PostFX.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FS_VERT, COMMON, AGX } from './glsl.js';
import { LIGHTVOL_GLSL } from './lightvol.js';
import { RIVER_GLSL } from './terrain.js';

/* ---------- prep (half res, 3 targets): colour + nearest depth for the DoF, and the river mist ----------
   The mist is a thin wispy layer a few metres thick hugging the water, lit by the moon (forward-scattering
   silver toward it), the sky, and the nearest lights. It is marched once per half-res pixel to that pixel's
   nearest depth; the final pass applies the same (in-scatter, transmittance) to the full-res image. */
const PREP = COMMON + LIGHTVOL_GLSL + RIVER_GLSL + /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oZ;
layout(location = 2) out vec4 oMist;
layout(location = 3) out vec4 oBlur;   // colour·w, w with w = how blurred: the DoF prefilter reads only out-of-focus content
uniform sampler2D tScene, tDepth, tBlue;
uniform sampler3D tBase;
uniform vec2 uTexel;     // full-res texel
uniform mat4 uInvProj, uCamWorld;
uniform vec3 uCamPos;
uniform vec2 uNearFar;
uniform vec4 uMist;      // extinction at the water (1/m), layer top (m), noise scale (1/m), max distance (m)
uniform vec4 uMist2;     // corridor half-width (m), corridor falloff (m), time (s), max steps
uniform float uMistGain; // the night gain the sky gets (a long exposure sees moonlit mist glow silver)
uniform vec3 uMoonDir, uMoonLight, uAmb;
uniform vec4 uPL[4];     // nearest point lights: xyz, intensity (cd)
uniform vec3 uPLc[4];    // their colour (unit luminance)
uniform int uPLn;
uniform float uFrame;
uniform vec4 uAir;     // humid air: scattering at the water (1/m), scale height (m), max distance (m), steps
uniform vec4 uDof;
float cocR(float z) { return clamp(uDof.y * (1.0 - uDof.x / max(z, 0.01)), -uDof.z, uDof.z); }
float mistDensity(vec3 p) {
  float corridor = 1.0 - smoothstep(uMist2.x, uMist2.x + uMist2.y, abs(p.x - riverX(p.z)));
  float top = uMist.y;
  float hgt = exp(-max(p.y, 0.0) / (top * 0.32)) * (1.0 - smoothstep(top * 0.55, top, p.y));
  if (corridor * hgt < 0.002) return 0.0;
  vec3 q = p * uMist.z + vec3(0.011, 0.0, 0.03) * uMist2.z;
  float n = texture(tBase, q * vec3(1.0, 2.2, 1.0)).b * 0.6 + texture(tBase, q * 2.9 + 0.37).r * 0.4;
  return uMist.x * corridor * hgt * smoothstep(0.38, 0.82, n);
}
void main() {
  vec3 c = vec3(0.0); float z = 1e6;
  for (int i = 0; i < 4; i++) {
    vec2 o = (vec2(i & 1, i >> 1) - 0.5) * uTexel;
    c += texture(tScene, vUv + o).rgb;
    float d = texture(tDepth, vUv + o).x;
    z = min(z, d >= 0.9999999 ? 6e4 : -viewZFromDepth(d, uNearFar.x, uNearFar.y));
  }
  c *= 0.25;
  vec3 S = vec3(0.0); float T = 1.0;
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vd = normalize(vp.xyz / vp.w);
  vec3 rd = normalize(mat3(uCamWorld) * vd), ro = uCamPos;
  float tS = z >= 5.9e4 ? 1e6 : z / max(-vd.z, 1e-4);
  // a FIXED blue-noise offset (no per-frame rotation: that flickered); the final pass tent-filters it away
  float jit = texture(tBlue, gl_FragCoord.xy / 64.0).r;
  // ---- the river mist, lit by the moon, the sky and the lanterns (light volume) ----
  if (uMist.x > 0.0) {
    float top = uMist.y;
    float t0 = 0.0, t1 = min(tS, uMist.w);
    if (abs(rd.y) > 1e-5) { float ta = (-0.5 - ro.y) / rd.y, tb = (top - ro.y) / rd.y; t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb)); }
    else if (ro.y > top) t1 = -1.0;
    if (t1 > t0) {
      float span = t1 - t0;
      int N = int(clamp(span / 3.0, 4.0, uMist2.w));
      float cm = dot(rd, uMoonDir);
      float phM = mix(hgPhase(cm, 0.65), hgPhase(cm, -0.15), 0.3);
      for (int i = 0; i < 16; i++) {
        if (i >= N) break;
        float u = (float(i) + jit) / float(N);
        float tt = t0 + span * u * u;                 // denser near the camera
        float dt = span * 2.0 * u / float(N);
        vec3 p = ro + rd * tt;
        float sig = mistDensity(p) * smoothstep(0.5, 3.0, tt);
        if (sig < 1e-6) continue;
        vec3 L = (uMoonLight * phM + uAmb) * uMistGain;
        vec4 LL = lanternLight(p);
        float v = length(LL.yzw);
        L += uLVcol * (0.5 * LL.x / (4.0 * PI) + 0.5 * v * hgPhase(dot(LL.yzw / max(v, 1e-5), rd), 0.5));
        float Tr = exp(-sig * dt);
        S += T * L * (1.0 - Tr);
        T *= Tr;
      }
    }
  }
  // ---- the humid air around the swarm: lantern light scattered toward the lens (in-scatter only; the
  //      terrain's aerial haze already carries the air's extinction). A thin, warm glow, densest low down ----
  if (uAir.x > 0.0) {
    float t1 = min(tS, uAir.z);
    int N = int(uAir.w);
    vec3 A = vec3(0.0);
    for (int i = 0; i < 16; i++) {
      if (i >= N) break;
      float u0 = (float(i) + jit) / float(N), u1 = (float(i) + 1.0 + jit) / float(N);
      float ta = t1 * u0 * u0, tb = t1 * min(u1 * u1, 1.0);   // quadratic spacing: fine near the camera
      vec3 p = ro + rd * (0.5 * (ta + tb));
      float sig = uAir.x * exp(-max(p.y, 0.0) / uAir.y);
      vec4 LL = lanternLight(p);
      if (LL.x <= 0.0) continue;
      float v = length(LL.yzw);
      A += sig * (tb - ta) * (0.45 * LL.x / (4.0 * PI) + 0.55 * v * hgPhase(dot(LL.yzw / max(v, 1e-5), rd), 0.6));
    }
    S += T * uLVcol * A;
  }
  oColor = vec4(c * T + S, 1.0);
  oZ = vec4(z, 0.0, 0.0, 1.0);
  oMist = vec4(S, T);
  float wb = smoothstep(0.4, 1.5, abs(cocR(z)));
  oBlur = vec4(oColor.rgb * wb, wb);
}
`;

/* scatter-as-gather on a golden-angle spiral (after D. Gustafsson, "Bokeh depth of field in a single pass"):
   each sample contributes if ITS circle of confusion reaches this pixel, so out-of-focus lights become round
   discs that overlap and add; a background sample may not spread wider than twice the centre's blur (no
   background bleeding over sharp foreground). Ring samples read colour pre-filtered over the area each one
   stands for, so a small bright source lands in every nearby sample (no speckled discs). */
const DOF_GATHER = COMMON + /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tHalf, tHalfZ, tHalfB;
uniform vec2 uTexel;     // half-res texel
uniform vec4 uDof;       // focus distance (m), CoC radius at infinity (half-res px), max radius (half px), spiral step
uniform vec3 uBoost;     // exposure (to judge brightness), highlight boost, prefilter lod for ring samples
float cocR(float z) { return clamp(uDof.y * (1.0 - uDof.x / max(z, 0.01)), -uDof.z, uDof.z); }
void main() {
  vec3 c0 = textureLod(tHalf, vUv, 0.0).rgb;
  float z0 = texture(tHalfZ, vUv).r;
  float r0 = abs(cocR(z0));
  // the centre sample is one pixel; each ring sample stands for ~2π·step px². Out of focus, weight the centre
  // by its true share, or a hot core keeps a bright dot in the middle of its own bokeh disc
  float w0 = (1.0 + uBoost.y * max(luma(c0) * uBoost.x - 0.5, 0.0)) * mix(1.0, 1.0 / (6.2831853 * uDof.w), smoothstep(0.6, 2.0, r0));
  vec3 acc = c0 * w0; float ws = w0, ra = r0 * w0;
  float radius = uDof.w * 0.5;
  float ang = hash12(gl_FragCoord.xy) * 6.2831853;
  for (int i = 0; i < 320; i++) {
    if (radius >= uDof.z) break;
    ang += 2.39996323;
    vec2 uv = vUv + vec2(cos(ang), sin(ang)) * uTexel * radius;
    float sz = texture(tHalfZ, uv).r;
    float rs = abs(cocR(sz));
    // a blurred sample reads colour pre-filtered over the area it stands for, from the blur-weighted target
    // (so an in-focus neighbour never leaks in); a sharp sample reads its own texel
    vec3 sc = textureLod(tHalf, uv, 0.0).rgb;
    vec4 pb = textureLod(tHalfB, uv, uBoost.z);
    if (pb.a > 0.03) sc = mix(sc, pb.rgb / pb.a, smoothstep(0.6, 2.0, rs));
    if (sz > z0) rs = min(rs, r0 * 2.0);
    float m = smoothstep(radius - 0.75, radius + 0.25, rs);
    float w = mix(1.0, 1.0 + uBoost.y * max(luma(sc) * uBoost.x - 0.5, 0.0), m);
    acc += mix(acc / ws, sc, m) * w;
    // alpha carries only FOREGROUND spill (contributors nearer than this pixel): a blurred background must
    // never pull an in-focus edge over to the half-res bokeh (that drew a dark fringe inside silhouettes)
    ra += rs * m * w * step(sz, z0 * 0.95 - 0.02);
    ws += w;
    radius += uDof.w / radius;
  }
  fragColor = vec4(acc / ws, ra / ws);
}
`;

/* ---------- bloom: 13-tap down (Jimenez, CoD:AW: no aliasing / pulsing) + tent up, tight levels weighted most ---------- */
const BLOOM_DOWN = COMMON + /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tSrc;
uniform vec2 uTexel;
uniform float uFirst, uClamp;
// above the knee, luminance grows only logarithmically: a very bright source (the moon, its glow in fog) never builds a
// flat plateau, whose edge each level would turn into a ring; below it nothing changes (the lanterns' bloom)
vec3 tp(vec2 o) { vec3 c = texture(tSrc, vUv + o * uTexel).rgb; float L = luma(c); return uFirst > 0.5 && L > uClamp ? c * (uClamp * (1.0 + log(L / uClamp)) / L) : c; }
void main() {
  vec3 a = tp(vec2(-2, 2)), b = tp(vec2(0, 2)), c = tp(vec2(2, 2));
  vec3 d = tp(vec2(-2, 0)), e = tp(vec2(0, 0)), f = tp(vec2(2, 0));
  vec3 g = tp(vec2(-2, -2)), h = tp(vec2(0, -2)), i = tp(vec2(2, -2));
  vec3 j = tp(vec2(-1, 1)), k = tp(vec2(1, 1)), l = tp(vec2(-1, -1)), m = tp(vec2(1, -1));
  vec3 o = e * 0.125 + (a + c + g + i) * 0.03125 + (b + d + f + h) * 0.0625 + (j + k + l + m) * 0.125;
  fragColor = vec4(max(o, vec3(0.0)), 1.0);
}
`;
const BLOOM_UP = COMMON + /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tSrc, tHigher;
uniform vec2 uTexel;
uniform float uMixLower;
void main() {
  vec2 o = uTexel;
  vec3 c = texture(tSrc, vUv + vec2(-o.x, -o.y)).rgb + texture(tSrc, vUv + vec2(o.x, -o.y)).rgb + texture(tSrc, vUv + vec2(-o.x, o.y)).rgb + texture(tSrc, vUv + vec2(o.x, o.y)).rgb;
  c += (texture(tSrc, vUv + vec2(0.0, -o.y)).rgb + texture(tSrc, vUv + vec2(0.0, o.y)).rgb + texture(tSrc, vUv + vec2(-o.x, 0.0)).rgb + texture(tSrc, vUv + vec2(o.x, 0.0)).rgb) * 2.0;
  c += texture(tSrc, vUv).rgb * 4.0;
  c /= 16.0;
  fragColor = vec4(c * uMixLower + texture(tHigher, vUv).rgb, 1.0);
}
`;

/* ---------- final (full res): mist + DoF composite → bloom → CA → vignette → exposure/WB → noise → AgX → sRGB ---------- */
const FINAL = COMMON + AGX + /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tScene, tDepth, tMist, tBokeh, tBloom, tHalfZ;
uniform vec2 uRes, uNearFar;
uniform vec4 uDof;
uniform float uDofOn;
uniform float uExpo, uBloomI;
uniform vec3 uWB;       // white balance gains (camera set for warm light)
uniform vec4 uLens;     // CA (px at the corner), vignette strength, grain (shot), grain (read)
uniform float uTime;
uniform int uDbg;
float cocR(float z) { return clamp(uDof.y * (1.0 - uDof.x / max(z, 0.01)), -uDof.z, uDof.z); }
// 1. the lens image: the sharp scene behind the river mist, blended toward the bokeh by the circle of confusion
vec4 mistAt(vec2 uv) {
  vec2 h = 1.0 / vec2(textureSize(tMist, 0));
  return (texture(tMist, uv + vec2(-0.75, -0.75) * h) + texture(tMist, uv + vec2(0.75, -0.75) * h) + texture(tMist, uv + vec2(-0.75, 0.75) * h) + texture(tMist, uv + vec2(0.75, 0.75) * h)) * 0.25;
}
// depth-aware (bilateral) upsample of the half-res bokeh: only texels whose depth matches this pixel's take
// part, so an in-focus silhouette never blends with the blurred sky beside it (that drew a soft, speckled band)
vec4 bokehAt(vec2 uv, float z) {
  vec2 hs = vec2(textureSize(tBokeh, 0));
  vec2 pos = uv * hs - 0.5; ivec2 b = ivec2(floor(pos)); vec2 f = fract(pos);
  vec4 acc = vec4(0.0); float ws = 0.0;
  for (int i = 0; i < 4; i++) {
    ivec2 o = ivec2(i & 1, i >> 1);
    ivec2 c = clamp(b + o, ivec2(0), ivec2(hs) - 1);
    float wb = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    float e = log(max(texelFetch(tHalfZ, c, 0).r, 0.01) / max(z, 0.01));
    float w = wb * (exp(-e * e * 80.0) + 1e-4);
    acc += texelFetch(tBokeh, c, 0) * w; ws += w;
  }
  return acc / ws;
}
vec3 lensAt(vec2 uv, float t, vec4 m, vec3 bk) {
  vec3 c = texture(tScene, uv).rgb * m.a + m.rgb;
  return t > 0.0 ? mix(c, bk, t) : c;
}
void main() {
  vec2 uv = vUv;
  float t = 0.0;
  vec3 bk = vec3(0.0);
  if (uDofOn > 0.5) {
    float d = texture(tDepth, uv).x;
    float z = d >= 0.9999999 ? 6e4 : -viewZFromDepth(d, uNearFar.x, uNearFar.y);
    vec4 b = bokehAt(uv, z);
    bk = b.rgb;
    t = smoothstep(0.45, 1.2, max(abs(cocR(z)), b.a));
  }
  vec2 p = (uv - 0.5) * uRes;
  float rn = length(p) / length(0.5 * uRes);
  // 3. lateral chromatic aberration: red magnified, blue shrunk, growing with r² (a clean centre)
  vec2 off = (p / max(length(p), 1e-3)) * uLens.x * rn * rn / uRes;
  // 2. bloom (soft, wide, low intensity: veiling glare, never a hard halo)
  vec4 m = mistAt(uv);   // low-frequency: one filtered fetch serves all three CA taps
  vec3 c0 = lensAt(uv, t, m, bk);
  vec3 cs = vec3(lensAt(uv + off, t, m, bk).r, c0.g, lensAt(uv - off, t, m, bk).b);
  // limit the fringe to a fraction of the local luminance: real CA, but a 1-px white-hot flame core no longer
  // splits into a saturated purple / red pair beside a dark pixel
  float l0 = luma(c0) * 0.3 + 1e-5;
  cs = c0 + clamp(cs - c0, -vec3(l0), vec3(l0));
  vec3 col = cs + vec3(texture(tBloom, uv + off).r, texture(tBloom, uv).g, texture(tBloom, uv - off).b) * uBloomI;
  // 4. vignette: natural cos⁴-like falloff, gentle
  col *= mix(1.0, pow(cos(atan(rn * 0.62)), 4.0), uLens.y);
  // exposure (EV100) and white balance
  col *= uExpo * uWB;
  // 5. sensor noise: photon shot noise ∝ √signal plus a read-noise floor; mostly luminance, a little chroma
  vec2 h1 = hash22(gl_FragCoord.xy + fract(uTime * 7.31) * 413.0), h2 = hash22(gl_FragCoord.xy * 1.37 + fract(uTime * 3.17) * 211.0);
  float gL = sqrt(-2.0 * log(max(h1.x, 1e-6))) * cos(6.2831853 * h1.y);
  vec2 gC = (h2 - 0.5) * 0.7;
  float sig = sqrt(uLens.z * luma(col) + uLens.w * uLens.w);
  col = max(col + sig * (vec3(gL) + vec3(gC.x, 0.0, gC.y)), 0.0);
  col = agx(col);
  col = srgbEncode(col);
  col += (hash12(gl_FragCoord.xy + uTime) - 0.5) / 255.0;
  if (uDbg == 1) col = srgbEncode(clamp(texture(tScene, uv).rgb * uExpo, 0.0, 1.0));
  if (uDbg == 2) col = vec3(t);
  if (uDbg == 3) col = srgbEncode(clamp(bk * uExpo, 0.0, 1.0));
  fragColor = vec4(col, 1.0);
}
`;

const mk = (frag, uniforms) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false });

export class Post {
  constructor(renderer, tier, shared) {
    this.r = renderer;
    const hf = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter };
    this.rtScene = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, samples: tier.msaa, depthTexture: new THREE.DepthTexture(4, 4, THREE.FloatType) });
    this.rtHalf = new THREE.WebGLRenderTarget(4, 4, { ...hf, count: 4 });
    const [hc, hz, hm, hb] = this.rtHalf.textures;
    hb.generateMipmaps = true; hb.minFilter = THREE.LinearMipmapLinearFilter;
    hc.generateMipmaps = false;
    hz.generateMipmaps = false; hz.minFilter = hz.magFilter = THREE.NearestFilter;
    hm.generateMipmaps = false;
    this.rtBokeh = new THREE.WebGLRenderTarget(4, 4, hf);
    this.down = []; this.up = [];
    for (let i = 0; i < 7; i++) { this.down.push(new THREE.WebGLRenderTarget(4, 4, hf)); this.up.push(new THREE.WebGLRenderTarget(4, 4, hf)); }
    const depth = this.rtScene.depthTexture;
    const nearFar = { value: new THREE.Vector2() };

    const uDof = { value: new THREE.Vector4() };
    this.prep = mk(PREP, {
      tScene: { value: this.rtScene.texture }, tDepth: { value: depth }, tBlue: { value: shared.blue }, tBase: { value: shared.base },
      uTexel: { value: new THREE.Vector2() },
      uInvProj: { value: new THREE.Matrix4() }, uCamWorld: { value: new THREE.Matrix4() }, uCamPos: { value: new THREE.Vector3() }, uNearFar: nearFar,
      uMist: { value: new THREE.Vector4(0.045, 4.5, 1 / 14, 700) }, uMistGain: { value: 4.0 }, uMist2: { value: new THREE.Vector4(70, 80, 0, tier.mist) },
      uMoonDir: { value: shared.moonDir }, uMoonLight: { value: new THREE.Vector3() }, uAmb: { value: new THREE.Vector3() },
      uPL: { value: Array.from({ length: 4 }, () => new THREE.Vector4()) }, uPLc: { value: Array.from({ length: 4 }, () => new THREE.Vector3()) }, uPLn: { value: 0 },
      uFrame: { value: 0 }, uDof, uAir: { value: new THREE.Vector4(0.00018, 450, 1800, tier.air || 10) },
      tLV: { value: null }, uLVo: { value: [] }, uLVcol: { value: new THREE.Vector3() },
    });
    this.comp = this.prep;   // (older name used by callers for the mist / light uniforms)
    this.dof = { focus: 30, fstop: 2.8, focalMM: 35, enabled: true, maxR: tier.dofR, step: tier.dofStep, boost: 0.25 };
    this.dofGather = mk(DOF_GATHER, { tHalf: { value: hc }, tHalfZ: { value: hz }, tHalfB: { value: hb }, uTexel: { value: new THREE.Vector2() }, uDof, uBoost: { value: new THREE.Vector3(1, 0.25, 1.2) } });
    this.bDown = mk(BLOOM_DOWN, { tSrc: { value: null }, uTexel: { value: new THREE.Vector2() }, uFirst: { value: 0 }, uClamp: { value: 4000 } });
    this.bUp = mk(BLOOM_UP, { tSrc: { value: null }, tHigher: { value: null }, uTexel: { value: new THREE.Vector2() }, uMixLower: { value: 0.7 } });
    this.final = mk(FINAL, {
      tScene: { value: this.rtScene.texture }, tDepth: { value: depth }, tMist: { value: hm }, tBokeh: { value: this.rtBokeh.texture }, tBloom: { value: null }, tHalfZ: { value: hz },
      uRes: { value: new THREE.Vector2(1, 1) }, uNearFar: nearFar, uDof, uDofOn: { value: 1 },
      uExpo: { value: 1 }, uBloomI: { value: 0.03 },
      uLens: { value: new THREE.Vector4(1.6, 0.35, 0.00016, 0.0016) }, uTime: { value: 0 }, uDbg: { value: 0 }, uWB: { value: new THREE.Vector3(1, 1, 1) },
      uAgxLook: { value: new THREE.Vector4(1.0, 1.25, 1.4, 0.0) },
    });
    this.rtDepthCopy = new THREE.WebGLRenderTarget(4, 4, { type: THREE.FloatType, format: THREE.RedFormat, depthBuffer: false, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter });
    this.depthCopyMat = mk(/* glsl */`in vec2 vUv; layout(location = 0) out vec4 fragColor; uniform sampler2D tDepth; void main() { fragColor = vec4(texture(tDepth, vUv).x, 0.0, 0.0, 1.0); }`, { tDepth: { value: null } });
    // with MSAA: after the solid pass resolves, its colour and depth are copied once into a plain target where the
    // clouds and the additive lights go (going back into the multisampled target reloads it and resolves it a
    // second time: ~1.3 ms at 1080p on Apple GPUs). The lights are soft sprites and volumes: they need no MSAA.
    this.rtLate = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthTexture: new THREE.DepthTexture(4, 4, THREE.FloatType) });
    this.lateCopyMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FS_VERT, depthTest: true, depthWrite: true, depthFunc: THREE.AlwaysDepth,
      fragmentShader: /* glsl */`layout(location = 0) out vec4 fragColor; uniform sampler2D tColor, tDepth;
        void main() { ivec2 p = ivec2(gl_FragCoord.xy); fragColor = texelFetch(tColor, p, 0); gl_FragDepth = texelFetch(tDepth, p, 0).x; }`,
      uniforms: { tColor: { value: this.rtScene.texture }, tDepth: { value: this.rtScene.depthTexture } },
    });
    this.quad = new FullScreenQuad(this.prep);
    this.bloomLevels = tier.bloom;
    this.frame = 0;
    this.w = 4; this.h = 4;
  }
  setMSAA(n) { if (this.rtScene.samples !== n) { this.rtScene.samples = n; this.rtScene.dispose(); } }
  setSize(w, h) {
    this.w = w; this.h = h;
    this.rtScene.setSize(w, h); this.rtDepthCopy.setSize(w, h); this.rtLate.setSize(w, h);
    const hw = Math.max(2, w >> 1), hh = Math.max(2, h >> 1);
    this.rtHalf.setSize(hw, hh); this.rtBokeh.setSize(hw, hh);
    for (let i = 0; i < 7; i++) { const s = 4 << i; this.down[i].setSize(Math.max(2, Math.round(w / s)), Math.max(2, Math.round(h / s))); this.up[i].setSize(Math.max(2, Math.round(w / s)), Math.max(2, Math.round(h / s))); }
    this.final.uniforms.uRes.value.set(w, h);
    this.prep.uniforms.uTexel.value.set(1 / w, 1 / h);
    this.dofGather.uniforms.uTexel.value.set(1 / hw, 1 / hh);
  }
  /** Thin-lens circle of confusion: radius at infinity in half-res pixels for the current lens. */
  updateLens() {
    const d = this.dof, f = d.focalMM / 1000, S1 = Math.max(d.focus, f * 1.5);
    const diamPx = (this.h / 0.024) * (f * f) / (d.fstop * (S1 - f));
    // the spiral only needs to reach the largest blur in the frame: at infinity, or at ~1 m (nothing is drawn nearer):
    // in the game's lenses that is 1–2 half-res px, not the tier's maximum (≈52 samples a pixel saved, ~3 ms at 1080p)
    const rInf = diamPx / 4, rNear = Math.abs(rInf * (1 - S1 / Math.max(this.nearest || 1.0, 0.05)));
    const reach = Math.min(d.maxR, Math.max(2, Math.ceil(Math.max(rInf, rNear) + 1.5)));
    this.dofGather.uniforms.uDof.value.set(S1, rInf, reach, d.step);
  }
  render(app, dt, expo) {
    const r = this.r, cam = app.camera, q = this.quad;
    this.frame++;
    // scene: 1 everything solid (and the sky), 2 the clouds blended over it by depth, 3 the additive lights
    //   (far lantern points, flames, lamps; layer 3), which attenuate themselves through the layer analytically
    r.setRenderTarget(this.rtScene); r.setClearColor(0x000000, 0); r.clear(true, true, false);
    cam.layers.set(0);
    r.render(app.scene, cam);
    let late = this.rtScene;
    if (app.clouds && !this.cloudsOff) {
      let depth = this.rtScene.depthTexture;
      if (this.rtScene.samples === 0) {         // no MSAA: the depth texture is attached to the target we blend into
        this.depthCopyMat.uniforms.tDepth.value = depth;
        q.material = this.depthCopyMat; r.setRenderTarget(this.rtDepthCopy); q.render(r);
        depth = this.rtDepthCopy.texture;
      } else {                                   // MSAA: resolve (by switching away) and copy into the plain target
        late = this.rtLate;
        r.setRenderTarget(late); q.material = this.lateCopyMat; q.render(r);
      }
      app.clouds.render(cam, depth, late);
      r.setRenderTarget(late);
    }
    cam.layers.set(3);
    r.render(app.scene, cam);
    cam.layers.set(0);
    this.prep.uniforms.tScene.value = this.final.uniforms.tScene.value = late.texture;
    this.updateLens();   // the prep pass needs the lens too (blur weights for the DoF prefilter)
    // prep: half-res colour + nearest depth + river mist
    const u = this.prep.uniforms;
    u.uInvProj.value.copy(cam.projectionMatrixInverse); u.uCamWorld.value.copy(cam.matrixWorld); u.uCamPos.value.setFromMatrixPosition(cam.matrixWorld);
    u.uNearFar.value.set(cam.near, cam.far); u.uFrame.value = this.frame % 4096; u.uMist2.value.z = app.time;
    q.material = this.prep; r.setRenderTarget(this.rtHalf); q.render(r);
    // depth of field (half res)
    let bloomSrc = this.rtHalf.textures[0], bw = this.rtHalf.width, bh = this.rtHalf.height;
    const f = this.final.uniforms;
    f.uDofOn.value = this.dof.enabled ? 1 : 0;
    if (this.dof.enabled) {
      this.dofGather.uniforms.uBoost.value.set(expo, this.dof.boost, Math.max(0, Math.log2(Math.sqrt(2 * Math.PI * this.dof.step)) + 0.45));
      q.material = this.dofGather; r.setRenderTarget(this.rtBokeh); q.render(r);
      bloomSrc = this.rtBokeh.texture;
    }
    // bloom (from the half-res lens image, down to 1/256)
    const n = this.bloomOff ? 1 : this.bloomLevels, d = this.bDown.uniforms;
    d.uClamp.value = 14 / Math.max(expo, 1e-6);   // very bright sources (the moon) must not build a flat plateau: that stepped the halo
    q.material = this.bDown;
    let s = bloomSrc, sw = bw, sh = bh;
    for (let i = 0; i < n; i++) {
      d.tSrc.value = s; d.uTexel.value.set(1 / sw, 1 / sh); d.uFirst.value = i === 0 ? 1 : 0;
      r.setRenderTarget(this.down[i]); q.render(r);
      s = this.down[i].texture; sw = this.down[i].width; sh = this.down[i].height;
    }
    const uu = this.bUp.uniforms; q.material = this.bUp;
    let low = this.down[n - 1].texture;
    for (let i = n - 2; i >= 0; i--) {
      uu.tSrc.value = low; uu.tHigher.value = this.down[i].texture; uu.uTexel.value.set(1 / this.down[i + 1].width, 1 / this.down[i + 1].height);
      r.setRenderTarget(this.up[i]); q.render(r);
      low = this.up[i].texture;
    }
    // final → screen
    f.tBloom.value = low; f.uExpo.value = expo; f.uTime.value = app.time;
    q.material = this.final; r.setRenderTarget(null); q.render(r);
  }
}
