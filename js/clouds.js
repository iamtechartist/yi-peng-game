// The cloud layer: Eye of the Storm's CloudRenderer (checkerboard trace at a quarter of the reconstruction
// resolution + reprojection / variance-clipped temporal accumulation + depth-aware composite), with the hurricane
// model replaced by a broken stratocumulus / altocumulus layer over Chiang Mai:
//   BASE ~1.45 km, tops 1.75–2.35 km (thicker cells), ~55 % cover with real gaps (the moon and stars show through),
//   drifting slowly with the upper wind.
// LIGHT
//   the moon from above: Beer-Lambert through a short cone march + the rest of the layer above, Eye of the Storm's
//     dual-lobe phase, multiple-scattering octaves, silver lining and powder → silver tops and bright edges;
//   the sky dome from above, occluded by the cloud above the sample;
//   from below: every lantern and the city's street-lamp spill, splatted each frame into a 2D flux map under the
//     layer (FluxMap below); a sample reads it at the blur matching its height above the lights (a light 1 km below
//     spreads over ~1 km) → the warm glow on the bases where the swarm passes;
//   the 4 nearest lanterns as point lights (inside the cloud, your own lantern glows in the fog around you).
// COMPOSITE: S + scene·T, blended straight into the scene target before the additive lights are drawn (Post).
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FS_VERT, COMMON, SKY } from './glsl.js';
import { clamp, sat, lerp, smoothstep } from './util.js';
import { colCenter } from './course.js';

// the climb column: the solid cell the run's thermal climbs through, centred on the thermal at cloud height
const CD = [0, 0];   // (set below, once CLOUD is defined)

// The 30-second run reaches the cloud ~20 s in: the layer sits low (a stratocumulus deck at ~550 m over the valley).
export const CLOUD = { base: 540, top0: 840, top1: 1440, sigma: 0.05,   // σ: a ~20 m mean free path, as in real cumulus: crisp surfaces
  gain: [12.0, 30.0], diffuse: 0.8,   // gain: the night lift on moonlight, from the ground (moody, the sky stays navy) to the layer (silver)
  below: 9.0, belowHigh: 8.0, spill: 0.05, cover: -0.06,
  colTop: 800,    // the climb column's top (m): fixed, so the breakthrough comes at a known height
  offset: [3500, -8000] };
colCenter(CLOUD.base + 200, CD);   // where the noise field sits over the town: searched so the moon shows through a gap from the river (and stays clear ~2.5 min of drift)

/* The layer's density envelope, shared by the trace and the analytic transmittance the additive lights use. */
export const cloudGLSL = (tex = 'tBase') => /* glsl */`
uniform sampler3D ${tex};
uniform vec4 uCL;        // base (m), top0 (m), top1 (m), sigma max (1/m)
uniform vec4 uCW;        // wind offset x, z (m), time (s), coverage bias
uniform vec4 uCD;        // the run's climb column (world x, z, radius, strength): solid cloud to break through
// integer-hash value noise: the same numbers in js (course.js colTopAt), so the game knows the column's top
float vh(vec2 i) {
  uvec2 u = uvec2(ivec2(i) + 65536);
  uint h = (u.x * 1597334677u) ^ (u.y * 3812015801u);
  h = h * 747796405u + 2891336453u; h = ((h >> ((h >> 28u) + 4u)) ^ h) * 277803737u; h = (h >> 22u) ^ h;
  return float(h) * (1.0 / 4294967295.0);
}
float vnoise(vec2 x) {
  vec2 i = floor(x), f = fract(x); f = f * f * (3.0 - 2.0 * f);
  return mix(mix(vh(i), vh(i + vec2(1.0, 0.0)), f.x), mix(vh(i + vec2(0.0, 1.0)), vh(i + vec2(1.0, 1.0)), f.x), f.y);
}
// the climb column's core weight at q (1 inside, 0 beyond its rim)
float colCore(vec2 q) { return uCD.w > 0.0 ? 1.0 - smoothstep(uCD.z * 0.8, uCD.z, length(q - uCW.xy - uCD.xy)) : 0.0; }
float cloudTop(vec2 q) {
  float n = texture(${tex}, vec3(q / 7000.0, 0.21)).b;
  float t = mix(uCL.y, uCL.z, smoothstep(0.35, 0.8, n));
  if (uCD.w > 0.0) {
    // the climb column's top is set (billowing ~±50 m), not left to the noise: the run breaks out of it at a height
    // it knows; the layer round it stays low, so the moon is clear once you are through
    float dc = length(q - uCW.xy - uCD.xy);
    t = mix(t, min(t, ${(CLOUD.colTop + 45).toFixed(1)}), 1.0 - smoothstep(uCD.z * 1.2, uCD.z * 2.4, dc));
    float b = ${CLOUD.colTop.toFixed(1)} + 70.0 * (vnoise(q / 260.0) - 0.5) + 36.0 * (vnoise(q / 105.0 + 7.3) - 0.5)
            + 16.0 * (vnoise(q / 38.0 + 3.1) - 0.5) + 7.0 * (vnoise(q / 15.0 + 5.7) - 0.5);   // lumps on lumps: cauliflower
    t = mix(t, b, colCore(q));
  }
  return t;
}
float cloudCover(vec2 q) {
  float n1 = texture(${tex}, vec3(q / 9000.0, 0.47)).b, n2 = texture(${tex}, vec3(q / 2600.0, 0.13)).r;
  float c = smoothstep(0.38, 0.72, n1 * 0.62 + n2 * 0.46 + uCW.w);
  // the climb column (fixed to the ground: q minus the wind drift) is solid cloud with a ragged rim
  vec2 w = q - uCW.xy - uCD.xy;
  float col = uCD.w * (1.0 - smoothstep(uCD.z * 0.8, uCD.z, length(w) * (0.75 + 0.5 * n2)));
  return max(c, col);
}
// envelope 0..1 at p (before the 3D noise): coverage × vertical profile (flat base, rounded tops)
float cloudEnv(vec3 p, out float hf) {
  vec2 q = p.xz + uCW.xy;
  float top = cloudTop(q);
  hf = (p.y - uCL.x) / (top - uCL.x);
  if (hf < 0.0 || hf > 1.0) return 0.0;
  float cov = cloudCover(q);
  // rounded tops; the climb column's is crisp (the breakthrough is out of a surface, not a long thinning haze)
  return cov * smoothstep(0.0, 0.035, hf) * (1.0 - smoothstep(mix(0.55 + 0.3 * cov, 0.955, colCore(q)), 1.0, hf));
}
// analytic transmittance along a segment (for lights drawn after the clouds): optical depth through the layer at
// the segment's crossing, with the envelope's mean density
float cloudTransmit(vec3 a, vec3 b) {
  float ya = a.y, yb = b.y;
  float lo = max(min(ya, yb), uCL.x), hi = min(max(ya, yb), uCL.z);
  if (hi <= lo) return 1.0;
  vec3 d = b - a; float L = length(d);
  float dy = abs(d.y);
  float seg = dy > 1e-3 ? (hi - lo) * L / dy : L;
  float tm = dy > 1e-3 ? clamp(((lo + hi) * 0.5 - ya) / (yb - ya), 0.0, 1.0) : 0.5;
  vec2 q = (a + d * tm).xz + uCW.xy;
  float cov = cloudCover(q), top = cloudTop(q);
  float frac = clamp((min(hi, top) - lo) / max(hi - lo, 1.0), 0.0, 1.0);
  return exp(-seg * frac * uCL.w * 0.35 * cov);
}
`;
const WD = [0, 0];
export const CLOUD_GLSL = cloudGLSL('tBase');
/** For lights drawn after the clouds: their own sampler name (their shaders may already use tBase). */
export const CLOUD_T_GLSL = cloudGLSL('tCloudN');

const TRACE = COMMON + SKY + CLOUD_GLSL + /* glsl */`
uniform sampler3D tDetail;
in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oDepth;
uniform sampler2D tBlue, tDepth, tFlux;
uniform mat4 uInvProj, uCamWorld;
uniform vec3 uCamPos;
uniform vec2 uNearFar;
uniform float uFrame;
uniform vec4 uMarch;     // max steps, light steps, step a, step b
uniform vec4 uCB;        // checkerboard offset xy, reconstruction resolution zw
uniform vec3 uMoonLight; // moon illuminance (lux, rgb)
uniform vec3 uAmbTop;    // sky radiance above (nits)
uniform vec4 uFlux;      // flux map origin x, z, texel size (m), gain for the light from the ground
uniform float uFluxH;    // gain for the light from the lanterns aloft (the swarm passing under and into the layer)
uniform vec3 uFluxCol;   // light from the ground (the city, lanterns on the water): colour (unit luminance)
uniform vec3 uFluxColH;  // light from lanterns aloft: colour (unit luminance)
uniform float uDiffuse;  // multiply-scattered moonlight (diffuse transmission through the layer)
uniform vec4 uPL[4];     // nearest lanterns: xyz, intensity (cd)
uniform float uGain;     // night gain on the moon and sky light (a long exposure renders moonlit cloud silver)
uniform float uDetailK;  // detail erosion
uniform float uLS;       // first light-march step (m): small enough to self-shadow the billows
uniform vec2 uHF;        // near-field detail: mix, tile size (m)
uniform int uDbg;
float hg(float c, float g) { float g2 = g * g; return (1.0 - g2) / pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5); }
float dualLobe(float c, float k) { return mix(hg(c, 0.8 * k), hg(c, -0.25 * k), 0.42); }
float gJit = 0.5;
float densityAt(vec3 p, float t) {
  float hf; float e = cloudEnv(p, hf);
  if (e < 0.003) return 0.0;
  vec3 q = p + vec3(uCW.x, 0.0, uCW.y);
  float n = texture(tBase, q / 2400.0).r;
  // inside the climb column: chambers and walls (~100 m cells), not one uniform fog: you fly through open pockets
  // between lit cloud walls, the lanterns spiralling in them; the top 8 % and the base stay whole
  float cc = colCore(q.xz);
  if (cc > 0.0 && hf > 0.06 && hf < 0.93) {
    float w = texture(tBase, q / 820.0 + vec3(0.37, 0.0, 0.11)).g;
    float pocket = smoothstep(0.5, 0.68, w) * smoothstep(0.06, 0.16, hf) * (1.0 - smoothstep(0.84, 0.93, hf));
    n -= 0.5 * pocket * cc * uCD.w;
  }
  float d = sat(remap(n, 1.0 - e, 1.0, 0.0, 1.0));
  if (d <= 0.0) return 0.0;
  float dn = texture(tDetail, q / 300.0 + vec3(0.0, uCW.z * 0.0006, 0.0)).r;
  if (t < 2000.0) dn = mix(dn, texture(tDetail, q / uHF.y).r, uHF.x * smoothstep(40.0, 260.0, t) * (1.0 - smoothstep(900.0, 2000.0, t)));
  float dm = mix(dn, 1.0 - dn, sat(hf * 3.0));   // wispy bases, billowy tops
  dm *= 0.08 + 0.92 * smoothstep(12.0, 220.0, t);  // fog right around the lens: smooth (fine detail there only mottles and shimmers)
  return sat(remap(d, dm * uDetailK, 1.0, 0.0, 1.0));
}
float lightOD(vec3 p, int n) {
  float od = 0.0, ls = uLS, tl = uLS * (gJit - 0.5);
  for (int j = 0; j < n; j++) {
    vec3 q = p + uMoonDir * (tl + 0.5 * ls);
    if (q.y > uCL.z) break;
    od += densityAt(q, 2000.0) * ls;
    tl += ls; ls *= 1.8;
  }
  // the rest of the way up through the layer: the envelope's mean
  // beyond the cone: if still inside, a short remainder (a grazing ray leaves through the side, not the top)
  vec3 qe = p + uMoonDir * tl;
  float hf; float e = cloudEnv(qe, hf);
  od += e * 0.3 * min(max(0.0, cloudTop(qe.xz + uCW.xy) - qe.y) / max(uMoonDir.y, 0.1), 300.0);
  return od * uCL.w;
}
// light from below: the city and the lanterns, read from the flux map at the blur of the distance to them (a light
// 1 km below spreads over ~1 km). Two bands: everything low (the city, the release, the streams) is a broad warm
// wash; the lanterns near and in the layer (≥ 1 km) keep their own sharp footprint and glow in the cloud around them.
// e: the envelope here (for the depth the light has to diffuse through).
// 4 taps on a rotated grid at the mip's own texel spacing: a smooth (B-spline-like) footprint, not mip boxes
float fluxTaps(vec2 uv, float lod, int ch) {
  const vec2 RG[4] = vec2[](vec2(0.25, 0.75), vec2(-0.75, 0.25), vec2(-0.25, -0.75), vec2(0.75, -0.25));
  float o = exp2(lod) * 0.7 / 128.0, a = 0.0;
  for (int k = 0; k < 4; k++) { vec4 f = textureLod(tFlux, uv + RG[k] * o, lod); a += ch == 0 ? f.r : f.b; }
  return a * 0.25;
}
vec3 lightBelow(vec3 p, float e, bool far) {
  vec2 uv = (p.xz - uFlux.xy) / (uFlux.z * 128.0);
  if (any(lessThan(uv, vec2(0.0))) || any(greaterThan(uv, vec2(1.0)))) return vec3(0.0);
  vec4 f3 = textureLod(tFlux, uv, 3.0), f1 = textureLod(tFlux, uv, 1.0);
  float yl = f3.r > 1e-5 ? f3.g / f3.r * 1000.0 : 0.0;      // intensity-weighted heights of each band
  float yn = f1.b > 1e-5 ? f1.a / f1.b * 1000.0 : uCL.x - 150.0;
  float Dl = max(p.y - yl, 40.0), Dn = max(abs(p.y - yn), 30.0);
  float al = textureLod(tFlux, uv, clamp(log2(Dl * 1.6 / uFlux.z), 0.0, 7.0)).r;   // mean intensity per base texel at that scale
  float ln = clamp(log2(Dn * 1.6 / uFlux.z), 1.0, 7.0);   // ≥ 250 m: light diffuses that far in cloud
  float an = far ? textureLod(tFlux, uv, ln + 0.5).b : fluxTaps(uv, ln, 1);
  float k = e * uCL.w * 0.3;
  float tl = exp(-max(p.y - uCL.x, 0.0) * k) + 0.12;        // diffused up from the base
  float tn = exp(-abs(p.y - max(yn, uCL.x)) * k) + 0.03;     // diffused out from the lanterns' own height
  return (uFluxCol * (al * uFlux.w * tl) + uFluxColH * (an * uFluxH * tn)) * 600.0 / (uFlux.z * uFlux.z);
}
// (the other near lanterns' glow in the fog is drawn in the composite, at full rate: marched here, inside the
// checkerboard-reprojected buffer, a lantern passing at 33 m/s left a dotted wake behind it)
void main() {
  vec2 uv = (floor(gl_FragCoord.xy) * 2.0 + uCB.xy + 0.5) / uCB.zw;
  vec4 vp = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vd = normalize(vp.xyz / vp.w);
  vec3 rd = normalize(mat3(uCamWorld) * vd), ro = uCamPos;
  float dz = texture(tDepth, uv).x;
  float tScene = dz >= 0.9999999 ? 1e7 : viewZFromDepth(dz, uNearFar.x, uNearFar.y) / vd.z;
  float t0 = 0.0, t1 = min(tScene, 60000.0);
  if (abs(rd.y) > 1e-6) { float ta = (uCL.x - ro.y) / rd.y, tb = (uCL.z - ro.y) / rd.y; t0 = max(t0, min(ta, tb)); t1 = min(t1, max(ta, tb)); }
  else if (ro.y < uCL.x || ro.y > uCL.z) t1 = -1.0;
  vec3 scat = vec3(0.0);
  float T = 1.0, dSum = 0.0, wSum = 0.0, tHit = -1.0;
  float cosT = dot(rd, uMoonDir);
  float ph0 = dualLobe(cosT, 1.0), ph1 = dualLobe(cosT, 0.5), ph2 = dualLobe(cosT, 0.25);
  float silver = hg(cosT, 0.92) * 0.35;
  float powderView = sat(cosT * 0.5 + 0.5);
  float phD = mix(1.0, hg(cosT, 0.6), 0.45);
  if (t1 > t0) {
    float bn = texture(tBlue, gl_FragCoord.xy / 64.0).r;
    float jit = fract(bn + uFrame * 0.61803398875);
    gJit = fract(jit + 0.37);
    float t = t0 + (uMarch.z + uMarch.w * t0) * jit;
    bool wasEmpty = true; float refine = 0.0; tHit = -1.0;
    for (int i = 0; i < 160; i++) {
      if (float(i) >= uMarch.x || t >= t1 || T < 0.02) break;
      float ds = min(uMarch.z + uMarch.w * t, 300.0);
      if (refine > 0.0) { ds *= 0.35; refine -= 1.0; }
      vec3 p = ro + rd * t;
      float hf; float e = cloudEnv(p, hf);
      if (e < 0.003) { wasEmpty = true; t += ds * 1.8; continue; }
      if (wasEmpty && refine <= 0.0 && t > t0 + ds) { wasEmpty = false; refine = 4.0; t -= ds * (0.9 + 0.8 * fract(gJit + float(i) * 0.618034)); continue; }
      wasEmpty = false;
      float d = densityAt(p, t);
      if (d > 0.05 && tHit < 0.0) tHit = t;
      if (d > 0.001) {
        // far off, the edges soften (the march's long steps would only alias a 20 m surface into grain)
        float sigma = d * uCL.w * mix(1.0, 0.45, smoothstep(1500.0, 7000.0, t));
        bool far = t > 2500.0;            // lighting LOD: far samples are many per pixel and small on screen
        float od = lightOD(p, far ? 3 : 5);
        float ms = (ph0 * exp(-od) + 0.45 * ph1 * exp(-od * 0.4) + 0.2 * ph2 * exp(-od * 0.16)) * 0.62 / (4.0 * PI);
        ms += silver * exp(-od * 1.8) * (1.0 - exp(-sigma * 90.0)) / (4.0 * PI);
        float powder = 1.0 - exp(-2.0 * sigma * 45.0);
        vec3 L = uMoonLight * uGain * ms * mix(powder, 1.0, powderView);
        // optical depth to the top of the layer above this sample (envelope mean)
        float above = (cloudTop(p.xz + uCW.xy) - p.y) * e * uCL.w * 0.3;
        // multiply-scattered moonlight: a thick deck still lets a quarter of the light through, diffusely
        // (two-stream: T ≈ 1 / (1 + 0.75 τ (1 − g)), g ≈ 0.85), so bases are grey, not black
        // (still forward-peaked a few mean free paths in: the broad glow round the moon in fog, silver toward it)
        L += uMoonLight * (uGain * uDiffuse * max(uMoonDir.y, 0.15) / PI) / (1.0 + 0.11 * above) * mix(0.45, 1.0, exp(-od * 0.3)) * phD;
        L += uAmbTop * (0.25 + 0.75 * exp(-above)) * mix(0.35, 1.0, sat(hf * 1.3));   // (the sky radiance already carries the night gain)
        // from below (and from lanterns inside the layer): the base is lit like a ceiling, ~E/π
        L += lightBelow(p, e, far) / PI;
        float Tr = exp(-sigma * ds);
        scat += T * L * (1.0 - Tr);
        float Tp = T; T *= Tr; dSum += t * (Tp - T); wSum += Tp - T;
      }
      t += ds;
    }
  }
  // the nearest lantern (your own, in the chase view) lights the fog right around it: the analytic airlight of a
  // point source, σ I / (4π b) · (angle subtended by the ray), with σ the density between the lens and the lantern
  // (the march's steps are far too coarse at a few metres)
  {
    vec3 lp = uPL[0].xyz; float s0 = dot(lp - ro, rd), b = max(length(ro + rd * s0 - lp), 0.3);
    float sg = 0.5 * (densityAt(ro, 0.0) + densityAt(lp, 0.0)) * uCL.w;
    // (× 4: the same "long exposure" lift the moonlight gets, so your lantern's glow holds its own in the moonlit fog)
    if (sg > 0.0) scat += uFluxColH * (4.0 * uPL[0].w * sg / (4.0 * PI * b) * (atan((min(tScene, 300.0) - s0) / b) + atan(s0 / b)));
  }
  float cd = wSum > 0.002 ? dSum / wSum : min(tScene, 60000.0);
  // distant cloud fades into the sky along the ray (haze below the layer and to the horizon)
  float fogF = 1.0 - exp(-max(cd - 4000.0, 0.0) * 0.00005);
  vec3 skyH = nightSky(normalize(vec3(rd.x, max(rd.y, 0.02), rd.z)));
  scat = mix(scat, (1.0 - T) * skyH, fogF);
  oColor = vec4(scat, T);
  if (uDbg == 1 && rd.y > 0.01) { vec3 pb = ro + rd * ((uCL.x - ro.y) / rd.y); oColor = vec4(lightBelow(pb, 0.0, false), 0.0); }
  if (uDbg == 2 && abs(rd.y) > 0.01) { vec3 pb = ro + rd * ((uCL.x - ro.y) / rd.y); vec2 q = pb.xz + uCW.xy; oColor = vec4(cloudCover(q), texture(tBase, vec3(q / 9000.0, 0.47)).b, texture(tBase, vec3(q / 2600.0, 0.13)).r, 0.0); }
  if (uDbg == 3) oColor = vec4(vec3(1.0 - T), 0.0);
  if (uDbg == 4) oColor = vec4(tHit, 1.0 - T, 0.0, 0.0);
  oDepth = vec4(min(cd, 60000.0), min(tScene, 60000.0), 0.0, 1.0);
}
`;

/* Temporal reconstruction: verbatim from Eye of the Storm (reprojection + variance clipping + bilateral fill). */
const TEMPORAL = COMMON + /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 oColor;
layout(location = 1) out vec4 oDepth;
uniform sampler2D tCur, tCurD, tHist, tHistD, tDepth;
uniform mat4 uInvProj, uCamWorld, uPrevVP;
uniform vec3 uCamPos;
uniform vec2 uNearFar;
uniform vec4 uCB;
uniform vec4 uRecon;
void main() {
  ivec2 p = ivec2(gl_FragCoord.xy);
  ivec2 tsz = textureSize(tCur, 0);
  ivec2 d = p - ivec2(uCB.xy);
  ivec2 tq = ivec2(floor(vec2(d) * 0.5));
  bool traced = ((d.x | d.y) & 1) == 0 && d.x >= 0 && d.y >= 0 && tq.x < tsz.x && tq.y < tsz.y;
  vec2 uv = (vec2(p) + 0.5) / uCB.zw;
  vec4 vp = uInvProj * vec4(uv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vd = normalize(vp.xyz / vp.w);
  vec3 rd = normalize(mat3(uCamWorld) * vd);
  float dz = texture(tDepth, uv).x;
  float sceneD = dz >= 0.9999999 ? 60000.0 : min(viewZFromDepth(dz, uNearFar.x, uNearFar.y) / vd.z, 60000.0);
  float lsd = log(sceneD + 1.0);
  vec4 m1 = vec4(0.0), m2 = vec4(0.0);
  for (int y = -1; y <= 1; y++) for (int x = -1; x <= 1; x++) {
    vec4 c = texelFetch(tCur, clamp(tq + ivec2(x, y), ivec2(0), tsz - 1), 0);
    m1 += c; m2 += c * c;
  }
  m1 /= 9.0; m2 /= 9.0;
  vec4 sdv = sqrt(max(m2 - m1 * m1, 0.0));
  vec2 f = vec2(d) * 0.5 - vec2(tq);
  vec4 sp = vec4(0.0); float ws = 0.0, cdist = 0.0;
  for (int i = 0; i < 4; i++) {
    ivec2 o = ivec2(i & 1, i >> 1);
    ivec2 c = clamp(tq + o, ivec2(0), tsz - 1);
    float wb = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    vec4 dd = texelFetch(tCurD, c, 0);
    float e = lsd - log(dd.y + 1.0);
    float w = wb * (exp(-e * e * 10.0) + 1e-3);
    sp += texelFetch(tCur, c, 0) * w; cdist += dd.x * w; ws += w;
  }
  sp /= max(ws, 1e-6); cdist /= max(ws, 1e-6);
  vec4 cur = sp; float cD = cdist;
  if (traced) { cur = texelFetch(tCur, tq, 0); cD = texelFetch(tCurD, tq, 0).x; }
  vec4 pc = uPrevVP * vec4(uCamPos + rd * cD, 1.0);
  vec2 puv = pc.xy / pc.w * 0.5 + 0.5;
  bool inside = pc.w > 0.0 && puv.x > 0.0 && puv.y > 0.0 && puv.x < 1.0 && puv.y < 1.0;
  float he = lsd - log(texture(tHistD, puv).y + 1.0);
  bool valid = inside && uRecon.w < 0.5 && abs(he) < 0.22;
  vec4 hc = clamp(texture(tHist, puv), m1 - uRecon.z * sdv, m1 + uRecon.z * sdv);
  vec4 o = valid ? mix(hc, cur, traced ? uRecon.x : uRecon.y) : cur;
  oColor = max(o, vec4(0.0));
  oDepth = vec4(cD, sceneD, 0.0, 1.0);
}
`;

/* Composite: depth-aware bilateral upsample of the reconstruction (Eye of the Storm), output (S, T) for blending
   straight into the scene target: dst = S + dst·T. */
const COMPOSITE = COMMON + /* glsl */`
in vec2 vUv;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tDepth, tCloud, tCloudD;
uniform mat4 uInvProj, uCamWorld;
uniform vec3 uCamPos, uFluxColH;
uniform vec2 uNearFar, uLowRes;
uniform vec4 uPL[4];     // nearest lanterns: xyz, intensity (cd); [0] is yours (its airlight is in the trace)
uniform float uGlowSg;   // the fog's extinction around the camera (1/m), 0 outside the cloud
// the nearest other lanterns light the fog round them: the analytic single-scatter airlight of a point source,
// σ I / b · (angle the ray sees it over), as the multiply-scattering cloud's ~E/π (× 4: the long-exposure lift)
vec3 nearGlow(vec3 ro, vec3 rd, float tMax) {
  float g = 0.0;
  for (int k = 1; k < 4; k++) {
    vec3 lp = uPL[k].xyz; float s0 = dot(lp - ro, rd);
    float b = sqrt(dot(ro + rd * s0 - lp, ro + rd * s0 - lp) + 1.0);
    g += uPL[k].w / b * (atan((tMax - s0) / b) + atan(s0 / b)) * exp(-length(lp - ro) * (0.012 + uGlowSg));
  }
  return uFluxColH * g * uGlowSg * (4.0 / PI);
}
void main() {
  vec4 vp = uInvProj * vec4(vUv * 2.0 - 1.0, 1.0, 1.0);
  vec3 vd = normalize(vp.xyz / vp.w);
  float dz = texture(tDepth, vUv).x;
  float dist = dz >= 0.9999999 ? 60000.0 : viewZFromDepth(dz, uNearFar.x, uNearFar.y) / vd.z;
  vec3 glow = uGlowSg > 0.0 ? nearGlow(uCamPos, normalize(mat3(uCamWorld) * vd), min(dist, 300.0)) : vec3(0.0);
  vec2 pos = vUv * uLowRes - 0.5; vec2 f = fract(pos); ivec2 b = ivec2(floor(pos)), mx = ivec2(uLowRes) - 1;
  vec4 acc = vec4(0.0); float ws = 0.0, wq = 0.0, wbs = 0.0, sdAvg = 0.0;
  float ld = log(min(dist, 60000.0) + 1.0);
  for (int i = 0; i < 4; i++) {
    ivec2 o = ivec2(i & 1, i >> 1); ivec2 c = clamp(b + o, ivec2(0), mx);
    float wb = (o.x == 1 ? f.x : 1.0 - f.x) * (o.y == 1 ? f.y : 1.0 - f.y);
    float sd = texelFetch(tCloudD, c, 0).y;
    float dd = ld - log(sd + 1.0);
    float m = exp(-dd * dd * 6.0), w = wb * (m + 1e-3);
    acc += texelFetch(tCloud, c, 0) * w; ws += w; wq += wb * m; wbs += wb; sdAvg += wb * sd;
  }
  vec4 cl = acc / max(ws, 1e-6);
  sdAvg /= max(wbs, 1e-6);
  if (wq < 0.3 * wbs && dist < sdAvg * 0.7) {
    float ratio = dist / max(sdAvg, 1.0);
    float T2 = pow(max(cl.a, 1e-4), ratio);
    cl.rgb *= (1.0 - T2) / max(1.0 - cl.a, 1e-4); cl.a = T2;
  }
  // no cloud here (most of the town below the horizon): leave the multisampled target untouched
  cl.rgb += glow;
  if (cl.a > 0.998 && dot(cl.rgb, vec3(1.0)) < 1e-4) discard;
  fragColor = vec4(max(cl.rgb, vec3(0.0)), clamp(cl.a, 0.0, 1.0));
}
`;

/* The flux map: every light splatted as one texel (R = Σ I, G = Σ I·y below 1 km; B, A the same above), 128² around the camera,
   125 m texels (16 km), mipmapped: a mip's texel is the mean over its footprint. */
const FLUX_VERT = /* glsl */`
uniform sampler2D tL;
uniform int uLW;
uniform vec4 uFluxO;       // origin x, z, texel size, scale for lights flagged "spill" (street lamps)
uniform int uSpillFrom;    // index from which lights are street lamps (only their upward spill counts)
out vec4 vI;
void main() {
  vec4 L = texelFetch(tL, ivec2(gl_VertexID % uLW, gl_VertexID / uLW), 0);
  vec2 uv = (L.xz - uFluxO.xy) / (uFluxO.z * 128.0);
  float I = L.w * (gl_VertexID >= uSpillFrom ? uFluxO.w : 1.0);
  gl_PointSize = 1.0;
  gl_Position = (L.w > 0.0 && all(greaterThan(uv, vec2(0.0))) && all(lessThan(uv, vec2(1.0)))) ? vec4(uv * 2.0 - 1.0, 0.0, 1.0) : vec4(2.0, 2.0, 0.0, 1.0);
  // R, G: everything below 1 km (cd / 100, × height in km); B, A: the lanterns from 1 km up (half floats stay in range)
  float i = I * 0.01;
  vI = L.y < ${(CLOUD.base * 0.55).toFixed(1)} ? vec4(i, i * L.y * 0.001, 0.0, 0.0) : vec4(0.0, 0.0, i, i * L.y * 0.001);
}
`;
const FLUX_FRAG = /* glsl */`
in vec4 vI;
layout(location = 0) out vec4 fragColor;
void main() { fragColor = vI; }
`;

const mk = (frag, uniforms, extra = {}) => new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: frag, uniforms, depthTest: false, depthWrite: false, ...extra });

/** Uniforms a late (additive) light material needs for cloudTransmit(). */
/** The cloud field's drift at time t (m): what uCW.xy holds. The game reads it from here, not from the uniform (the
 *  uniform is written when a frame renders: a played run must not depend on which frames were drawn). */
export function cloudWind(t, out) { out[0] = CLOUD.offset[0] + 2.2 * t; out[1] = CLOUD.offset[1] - 0.8 * t; return out; }

export function cloudLateUniforms(noise) {
  return { tCloudN: { value: noise.base.texture }, uCL: { value: new THREE.Vector4(CLOUD.base, CLOUD.top0, CLOUD.top1, CLOUD.sigma) }, uCW: { value: new THREE.Vector4(0, 0, 0, CLOUD.cover) }, uCD: { value: new THREE.Vector4(CD[0], CD[1], 650, 0.9) } };   // (Vector4() defaults w to 1: full overcast)
}

export class Clouds {
  constructor(renderer, { noise, blue, sky, lightTex, lightW, count, spillFrom }) {
    this.r = renderer;
    this.U = {
      tBase: { value: noise.base.texture }, tDetail: { value: noise.detail.texture },
      uCL: { value: new THREE.Vector4(CLOUD.base, CLOUD.top0, CLOUD.top1, CLOUD.sigma) },
      uCW: { value: new THREE.Vector4(0, 0, 0, CLOUD.cover) }, uCD: { value: new THREE.Vector4(CD[0], CD[1], 650, 0.9) },
    };
    const hf = { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false };
    const nf = { ...hf, minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter };
    this.trace = new THREE.WebGLRenderTarget(4, 4, { ...nf, count: 2 });
    this.hist = [new THREE.WebGLRenderTarget(4, 4, { ...hf, count: 2 }), new THREE.WebGLRenderTarget(4, 4, { ...hf, count: 2 })];
    this.ping = 0; this.frame = 0; this.reset = true; this.scale = 0.5;
    this.glowDensity = 0.25;            // the fog density round the camera in the climb column, for the near lanterns' glow
    this.recon = [0.12, 0.035, 1.35];   // still camera: weight of a traced / filled pixel's new sample, clip width (σ): long history (Eye of the Storm used 0.34: the night sky flickered)
    this.prevVP = new THREE.Matrix4(); this.prevFwd = new THREE.Vector3(); this.prevPos = new THREE.Vector3(); this._f = new THREE.Vector3();
    this.cbOff = [[0, 0], [1, 1], [1, 0], [0, 1]];
    // flux map
    this.flux = new THREE.WebGLRenderTarget(128, 128, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearMipmapLinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: true });
    const fg = new THREE.BufferGeometry(); fg.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    this.fluxMat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FLUX_VERT, fragmentShader: FLUX_FRAG, depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: { tL: { value: lightTex }, uLW: { value: lightW }, uFluxO: { value: new THREE.Vector4(0, 0, 125, CLOUD.spill) }, uSpillFrom: { value: spillFrom } },
    });
    this.fluxPts = new THREE.Points(fg, this.fluxMat); this.fluxPts.frustumCulled = false;
    this.fluxScene = new THREE.Scene(); this.fluxScene.add(this.fluxPts); this.fluxCam = new THREE.Camera();

    const near = { value: new THREE.Vector2() }, invProj = { value: new THREE.Matrix4() }, camWorld = { value: new THREE.Matrix4() }, camPos = { value: new THREE.Vector3() };
    this.tDepth = { value: null };
    this.traceMat = mk(TRACE, {
      ...this.U, ...sky.U, tBlue: { value: blue }, tDepth: this.tDepth, tFlux: { value: this.flux.texture },
      uInvProj: invProj, uCamWorld: camWorld, uCamPos: camPos, uNearFar: near, uFrame: { value: 0 },
      uMarch: { value: new THREE.Vector4(56, 5, 14, 0.035) }, uCB: { value: new THREE.Vector4(0, 0, 4, 4) },
      uMoonLight: { value: new THREE.Vector3(sky.moonLight.r, sky.moonLight.g, sky.moonLight.b) },
      uAmbTop: { value: new THREE.Vector3(sky.skyAmbTop.r, sky.skyAmbTop.g, sky.skyAmbTop.b) },
      uFlux: { value: new THREE.Vector4(0, 0, 125, CLOUD.below) }, uFluxCol: { value: new THREE.Vector3(1, 0.6, 0.3) }, uFluxColH: { value: new THREE.Vector3(1, 0.6, 0.3) }, uFluxH: { value: CLOUD.belowHigh }, uDiffuse: { value: CLOUD.diffuse },
      uPL: { value: Array.from({ length: 4 }, () => new THREE.Vector4(0, -1e5, 0, 0)) },
      uGain: { value: CLOUD.gain[0] }, uDetailK: { value: 0.42 }, uLS: { value: 15 }, uHF: { value: new THREE.Vector2(0.35, 95) }, uDbg: { value: 0 },
    });
    this.tempMat = mk(TEMPORAL, {
      tCur: { value: this.trace.textures[0] }, tCurD: { value: this.trace.textures[1] }, tHist: { value: null }, tHistD: { value: null }, tDepth: this.tDepth,
      uInvProj: invProj, uCamWorld: camWorld, uCamPos: camPos, uNearFar: near, uPrevVP: { value: this.prevVP },
      uCB: this.traceMat.uniforms.uCB, uRecon: { value: new THREE.Vector4(0.35, 0.08, 1.25, 1) },
    });
    const tu = this.traceMat.uniforms;
    this.compMat = mk(COMPOSITE, { tDepth: this.tDepth, tCloud: { value: null }, tCloudD: { value: null }, uInvProj: invProj, uNearFar: near, uLowRes: { value: new THREE.Vector2() },
      uCamWorld: camWorld, uCamPos: camPos, uPL: tu.uPL, uFluxColH: tu.uFluxColH, uGlowSg: { value: 0 } },
      { transparent: true, blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.SrcAlphaFactor,
        blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor });
    this.quad = new FullScreenQuad(this.traceMat);
    this.uniforms = { invProj, camWorld, camPos, near };
  }
  setTier(t) {
    this.scale = t.cloudScale || 0.5;
    this.traceMat.uniforms.uMarch.value.x = t.cloudSteps || 56;
  }
  setSize(w, h) {
    this.lw = Math.max(64, 2 * Math.round(w * this.scale / 2)); this.lh = Math.max(40, 2 * Math.round(h * this.scale / 2));
    this.trace.setSize(this.lw >> 1, this.lh >> 1); this.hist[0].setSize(this.lw, this.lh); this.hist[1].setSize(this.lw, this.lh);
    this.traceMat.uniforms.uCB.value.z = this.lw; this.traceMat.uniforms.uCB.value.w = this.lh;
    this.compMat.uniforms.uLowRes.value.set(this.lw, this.lh);
    this.reset = true;
  }
  /** Per frame: wind drift, the flux map around the camera, the nearest lanterns. */
  update(time, camera, near, extra = null) {
    // the clouds' night lift follows the camera up: a moody dark sky from the river, silver tops at the layer
    const k = clamp((camera.position.y - CLOUD.base * 0.2) / (CLOUD.base * 0.7), 0, 1);
    this.traceMat.uniforms.uGain.value = lerp(CLOUD.gain[0], CLOUD.gain[1], k * k * (3 - 2 * k));
    const w = this.U.uCW.value; cloudWind(time, WD); w.x = WD[0]; w.y = WD[1]; w.z = time;
    const s = 125, cp = camera.position, fo = this.fluxMat.uniforms.uFluxO.value;
    fo.x = Math.floor(cp.x / s) * s - 64 * s; fo.y = Math.floor(cp.z / s) * s - 64 * s;
    this.traceMat.uniforms.uFlux.value.x = fo.x; this.traceMat.uniforms.uFlux.value.y = fo.y;
    const r = this.r, prev = r.getRenderTarget();
    r.setRenderTarget(this.flux); r.setClearColor(0x000000, 0); r.clear(true, false, false);
    r.render(this.fluxScene, this.fluxCam);
    r.setRenderTarget(prev);
    const cy = camera.position.y, inC = smoothstep(CLOUD.base - 10, CLOUD.base + 40, cy) * (1 - smoothstep(CLOUD.colTop - 40, CLOUD.colTop + 10, cy));
    this.compMat.uniforms.uGlowSg.value = CLOUD.sigma * this.glowDensity * inC;
    const pl = this.traceMat.uniforms.uPL.value;
    // the 4 nearest lanterns (the player's own first) light the cloud around them directly
    for (let k = 0, j = 0; k < 4; k++) { const q = k === 0 && extra ? extra : near[j++]; if (q) pl[k].set(q[0], q[1], q[2], q[3]); else pl[k].set(0, -1e5, 0, 0); }
  }
  /** Trace + temporal at reduced resolution, then blend (S + dst·T) into the currently bound scene target. */
  render(camera, depthTex, target) {
    const r = this.r, u = this.uniforms, q = this.quad;
    this.tDepth.value = depthTex;
    u.invProj.value.copy(camera.projectionMatrixInverse); u.camWorld.value.copy(camera.matrixWorld);
    u.camPos.value.setFromMatrixPosition(camera.matrixWorld); u.near.value.set(camera.near, camera.far);
    const tu = this.traceMat.uniforms;
    tu.uFrame.value = this.frame % 4096;
    const off = this.cbOff[this.frame & 3]; this.frame++;
    tu.uCB.value.x = off[0]; tu.uCB.value.y = off[1];
    const f = this._f.set(-camera.matrixWorld.elements[8], -camera.matrixWorld.elements[9], -camera.matrixWorld.elements[10]);
    const rot = Math.acos(clamp(f.dot(this.prevFwd), -1, 1)), trans = u.camPos.value.distanceTo(this.prevPos);
    this.prevFwd.copy(f); this.prevPos.copy(u.camPos.value);
    const m = sat(rot * 14 + trans / 260);
    const R = this.recon;
    this.tempMat.uniforms.uRecon.value.set(lerp(R[0], 0.75, m), lerp(R[1], 0.4, m), lerp(R[2], 0.9, m), this.reset ? 1 : 0);
    q.material = this.traceMat; r.setRenderTarget(this.trace); q.render(r);
    const src = this.hist[this.ping], dst = this.hist[1 - this.ping];
    this.tempMat.uniforms.tHist.value = src.textures[0]; this.tempMat.uniforms.tHistD.value = src.textures[1];
    q.material = this.tempMat; r.setRenderTarget(dst); q.render(r);
    this.ping = 1 - this.ping; this.reset = false;
    this.prevVP.multiplyMatrices(camera.projectionMatrix, camera.matrixWorldInverse);
    const cu = this.compMat.uniforms; cu.tCloud.value = dst.textures[0]; cu.tCloudD.value = dst.textures[1];
    q.material = this.compMat; r.setRenderTarget(target); q.render(r);
  }
}
