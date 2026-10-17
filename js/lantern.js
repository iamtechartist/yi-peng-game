// The khom loi: the Blender model (assets/lantern.glb, made by blender/lantern.py) lit from inside by its
// own flame. Everything here is a custom shader:
//   PAPER (translucent rice paper). Seen from outside, each point shows light TRANSMITTED from the inner face:
//     direct flame irradiance I·cosθ/d² (bright near the flame, falling toward the dome) + the cavity's
//     interreflected glow (the inside of a white paper bag is a bright integrating sphere), times the paper's
//     transmittance, which drops where the sheet is doubled (glued seams, the folded hem), shifts along fold
//     lines and varies with fibre density; crinkled facets tilted away from the flame pass less light.
//     Seen from inside (looking up into the opening) the same irradiance is REFLECTED by the inner face.
//   FUEL CELL: wax-soaked rolled paper burning on top: hot orange glow, brightest at the burning face.
//   FLAME: a volume ray-marched inside a small box (real 3D, not a card): a ragged teardrop of glowing gas,
//     white-yellow core, orange tips, turbulent tongues, flickering at 5–10 Hz on its own phase per lantern.
import * as THREE from 'three';
import { loader as gltfLoader } from './gltf.js';
import { COMMON } from './glsl.js';
import { CONFIG } from './config.js';
import { blackbody } from './util.js';
import { CLOUD_T_GLSL, cloudLateUniforms } from './clouds.js';

/** Flicker of one lantern's flame (also used on the CPU for its point light). Mean 1, ±~15 %, 5–10 Hz. */
export function flicker(t, ph) {
  return 1 + 0.055 * Math.sin(t * 44.6 + ph) + 0.045 * Math.sin(t * 58.4 + ph * 1.7) + 0.035 * Math.sin(t * 33.3 + ph * 2.3) + 0.04 * Math.sin(t * 4.4 + ph * 0.6);
}
const FLICKER_GLSL = /* glsl */`
float flicker(float t, float ph) {
  return 1.0 + 0.055 * sin(t * 44.6 + ph) + 0.045 * sin(t * 58.4 + ph * 1.7) + 0.035 * sin(t * 33.3 + ph * 2.3) + 0.04 * sin(t * 4.4 + ph * 0.6);
}
`;

// ------------------------------------------------------------------ paper, frame and fuel cell
const PAPER_VERT = /* glsl */`
in vec4 aPart;
in vec4 aInst;            // per lantern: flicker phase, flame strength (0 out … 1), brightness scale, seed
out vec3 vWorld, vLocal, vNormalL;
out vec2 vUv;
out vec4 vPart, vInst;
out mat3 vModel3;
out float vNear;          // 0 within uNearFade.x of the lens, 1 beyond .y (a lantern passing the camera dissolves)
uniform vec2 uNearFade;
void main() {
  mat4 M = modelMatrix;
#ifdef USE_INSTANCING
  M = modelMatrix * instanceMatrix;
#endif
  vec4 wp = M * vec4(position, 1.0);
  vWorld = wp.xyz; vLocal = position; vNormalL = normal; vUv = uv; vPart = aPart; vInst = aInst;
  vModel3 = mat3(M);
  vNear = smoothstep(uNearFade.x, uNearFade.y, length((M * vec4(0.0, 0.45, 0.0, 1.0)).xyz - cameraPosition));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const PAPER_FRAG = COMMON + FLICKER_GLSL + /* glsl */`
in vec3 vWorld, vLocal, vNormalL;
in vec2 vUv;
in vec4 vPart, vInst;
in mat3 vModel3;
in float vNear;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tPaper;
uniform float uTime;
uniform vec3 uFlameCol;      // flame light colour (unit luminance, linear)
uniform vec4 uPaperK;        // flame intensity I (cd), cavity irradiance / I, transmittance, reflectance
uniform vec4 uPaperK2;       // seam transmit, hem transmit, (unused), crinkle normal strength
uniform vec3 uPaperTint;     // the rice paper's own colour
uniform vec3 uAmb;           // outside light falling on the paper (moonlit sky), nits-equivalent
uniform float uDetail;       // 1 = hero / near (paper map), 0 = far LOD
const float TAU_ = 6.2831853;
void main() {
#ifndef NEAR_FADE
  if (vNear < 0.999 && fract(52.9829189 * fract(dot(gl_FragCoord.xy, vec2(0.06711056, 0.00583715)))) >= vNear) discard;
#endif
  float part = vPart.r;
  float fl = flicker(uTime, vInst.x) * vInst.y;
  float I = uPaperK.x * fl * vInst.z;
  // a guttering flame is small and red: the glow shifts from gold to ember as the flame weakens
  vec3 FC = uFlameCol * mix(vec3(1.4, 0.55, 0.22), vec3(1.0), smoothstep(0.12, 0.75, vInst.y));
  // the flame sways a few mm: the glow distribution lives
  vec3 fp = vec3(0.004 * sin(uTime * 9.1 + vInst.x * 3.0), 0.035 + 0.006 * sin(uTime * 13.7 + vInst.x), 0.004 * cos(uTime * 7.3 + vInst.x * 2.0));
  vec3 p = vLocal;
  vec3 n = normalize(vNormalL);
  vec3 toF = fp - p; float d2 = dot(toF, toF); vec3 l = toF * inversesqrt(d2);
  vec3 col;
  if (part < 0.16) {
    // ---------------- paper ----------------
    vec4 tex = uDetail > 0.5 ? texture(tPaper, vUv) : vec4(0.5, 0.5, 0.5, 0.5);
    // crease normal in the paper's frame: tangent around (u), bitangent up the surface (v)
    vec3 tU = normalize(vec3(-p.z, 0.0, p.x) * -1.0);
    tU = normalize(tU - n * dot(tU, n));
    vec3 tV = normalize(cross(n, tU));
    vec2 cn = (tex.rg - 0.5) * 2.0 * uPaperK2.w;
    vec3 nd = normalize(n + tU * cn.x + tV * cn.y);
    float hem = vPart.b, flap = vPart.g;
    // seams: the vertical sheet joins and the crown overlap are doubled paper wherever the flap lies
    float seam = 0.0;
    float uS = fract(vUv.x - 0.125 + 0.125);   // seams at u = 1/8 + k/4
    float dS = abs(fract(vUv.x * 4.0 - 0.5) - 0.5) / 4.0 * TAU_ * length(p.xz);
    seam = max(seam, (1.0 - smoothstep(0.007, 0.016, dS)) * (1.0 - smoothstep(0.80, 0.815, p.y)));
    seam = max(seam, (1.0 - smoothstep(0.009, 0.019, abs(p.y - 0.799))));
    seam = max(seam, flap);
    float T = uPaperK.z * mix(1.0, uPaperK2.x, seam) * mix(1.0, uPaperK2.y, hem);
    T *= 1.0 - 0.55 * (tex.a - 0.5);                  // fibre-dense paper transmits less
    T *= 1.0 + 1.0 * (tex.b - 0.5);                   // fold lines: the fibre is broken along a crease
    // irradiance on the paper's INNER face: the flame directly + the bright cavity. A crinkled facet tilted away
    // from the flame also passes less of it (longer path through the sheet, more reflected at the surface): the
    // transmission falls faster than cos, which is what makes crinkles show even where light meets the wall square
    float cosI = max(dot(-nd, l), 0.0);
    float Edir = I * pow(cosI, 1.6) / d2;
    float Ecav = I * uPaperK.y * (0.8 + 0.4 * smoothstep(0.9, 0.1, p.y));
    float E = Edir + Ecav;
    if (gl_FrontFacing) {
      // outside: transmitted light (Lambertian diffuse transmission) + a little outside light reflected
      col = FC * uPaperTint * (T / PI) * E + uAmb * 0.6 * uPaperTint;
    } else {
      // inside: the inner face reflects the same irradiance
      col = FC * uPaperTint * (uPaperK.w / PI) * (I * abs(dot(nd, l)) / d2 + Ecav) * mix(1.0, 0.75, seam);
    }
  } else if (part < 0.5) {
    // ---------------- bamboo (none in the current model: kept for part id 0.33) ----------------
    float ndl = max(dot(n, l), 0.0) * 0.8 + 0.2;
    col = vec3(0.42, 0.3, 0.17) / PI * (I * ndl / d2 + I * uPaperK.y * 0.6) * FC;
  } else if (part < 0.83) {
    // ---------------- wire: dark steel, a hot glint toward the flame ----------------
    vec3 V = normalize(cameraPosition - vWorld);
    vec3 nW = normalize(vModel3 * n), lW = normalize(vModel3 * l);
    float spec = pow(max(dot(reflect(-lW, nW), V), 0.0), 40.0);
    col = FC * (0.03 / PI * (I / d2 + I * uPaperK.y) + spec * I / d2 * 0.08);
  } else {
    // ---------------- fuel cell: burning wax-soaked paper ----------------
    // the burning top glows white-hot, the rolled side darkens from a hot orange rim to the waxy, sooty
    // underside (lit only by the cavity and the flame above it)
    float top = smoothstep(-0.031, -0.024, p.y);
    float rim = smoothstep(-0.05, -0.026, p.y) * (1.0 - top);
    float nse = texture(tPaper, vUv * 3.0).a;
    float under = smoothstep(-0.052, -0.058, p.y);
    float glow = (top * 900.0 + rim * 140.0 * (0.6 + 0.8 * nse)) * fl;
    vec3 hot = mix(vec3(1.0, 0.32, 0.05), vec3(1.0, 0.7, 0.32), top);
    col = hot * glow * vInst.z * smoothstep(0.0, 0.2, vInst.y + 0.05);
    col += vec3(0.16, 0.09, 0.045) / PI * (I * uPaperK.y * 0.6 + I * 0.08 / max(d2, 0.004) * (1.0 - under)) * FC * (0.5 + 0.5 * nse);
  }
#ifdef NEAR_FADE
  fragColor = vec4(col * vNear, vNear);   // premultiplied: a lantern passing the lens fades out smoothly
#else
  fragColor = vec4(col, 1.0);
#endif
}
`;

// ------------------------------------------------------------------ flame (ray-marched volume in a box)
const FLAME_VERT = CLOUD_T_GLSL + /* glsl */`
in vec4 aInst;
out vec3 vWorld;
out vec4 vInst;
out float vCT;
flat out mat4 vM;
uniform vec2 uNearFade;
void main() {
  mat4 M = modelMatrix;
#ifdef USE_INSTANCING
  M = modelMatrix * instanceMatrix;
#endif
  vec4 wp = M * vec4(position, 1.0);
  vWorld = wp.xyz; vInst = aInst; vM = M;
  vec3 fc = (M * vec4(0.0, 0.1, 0.0, 1.0)).xyz;
  vCT = cloudTransmit(cameraPosition, fc) * smoothstep(uNearFade.x, uNearFade.y, length(fc - cameraPosition));
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const FLAME_FRAG = COMMON + FLICKER_GLSL + /* glsl */`
in vec3 vWorld;
in vec4 vInst;
in float vCT;
flat in mat4 vM;
layout(location = 0) out vec4 fragColor;
uniform sampler3D tBase;
uniform float uTime;
uniform vec4 uFlame;      // base y, height, half-width, core luminance (nits)
uniform vec2 uLean;       // wind lean (x, z) in the lantern's frame
uniform vec3 uBox;        // box half-size
uniform vec3 uBoxC;       // box centre
// blackbody-ish ramp for a wax / paraffin flame: deep orange tips → yellow → white-yellow core
vec3 flameColor(float k) {
  vec3 c = mix(vec3(1.0, 0.22, 0.03), vec3(1.0, 0.55, 0.14), smoothstep(0.0, 0.45, k));
  c = mix(c, vec3(1.0, 0.82, 0.52), smoothstep(0.45, 0.85, k));
  return mix(c, vec3(1.0, 0.95, 0.85), smoothstep(0.85, 1.0, k));
}
void main() {
  mat4 Mi = inverse(vM);
  vec3 ro = (Mi * vec4(cameraPosition, 1.0)).xyz;
  vec3 rd = normalize((Mi * vec4(vWorld, 1.0)).xyz - ro);
  // ray ∩ box (local)
  vec3 bmin = uBoxC - uBox, bmax = uBoxC + uBox;
  vec3 t0 = (bmin - ro) / rd, t1 = (bmax - ro) / rd;
  vec3 tn = min(t0, t1), tf = max(t0, t1);
  float ta = max(max(tn.x, tn.y), max(tn.z, 0.0)), tb = min(min(tf.x, tf.y), tf.z);
  if (tb <= ta) discard;
  float strength = min(vInst.y, 1.2);   // (a relight flare overdrives the glow; the flame itself caps)
  float fl = flicker(uTime, vInst.x);
  float h = uFlame.y * (0.82 + 0.35 * (fl - 1.0) * 3.0) * mix(0.25, 1.0, strength);
  float wdt = uFlame.z * mix(0.6, 1.0, strength);
  const int N = 28;
  float dt = (tb - ta) / float(N);
  float jit = hash12(gl_FragCoord.xy);   // fixed per pixel: a per-frame jitter made the flame shimmer
  vec3 acc = vec3(0.0);
  float ph = vInst.x;
  for (int i = 0; i < N; i++) {
    vec3 q = ro + rd * (ta + (float(i) + jit) * dt);
    float y = (q.y - uFlame.x) / h;                       // 0 at the burning face, 1 at the tip
    if (y < -0.05 || y > 1.35) continue;
    float yc = clamp(y, 0.0, 1.0);
    // lean with the wind (quadratic: the tip bends most) and lick with turbulence that rises with the gas
    vec2 off = uLean * yc * yc * h;
    vec3 nq = vec3(q.x * 26.0, q.y * 15.0 - uTime * 4.6 - ph, q.z * 26.0 + ph * 0.37);
    vec2 turb = (vec2(texture(tBase, nq * 0.11).r, texture(tBase, nq * 0.11 + 0.31).r) - 0.5) * 0.11 * yc * (0.5 + yc);
    turb += (vec2(texture(tBase, nq * 0.29 + 0.53).g, texture(tBase, nq * 0.29 + 0.17).g) - 0.5) * 0.025 * yc;
    vec2 rq = q.xz - off - turb;
    float r = length(rq);
    // a bulb burning across the cell's top, widest a quarter of the way up, pinching to the tip …
    float R = wdt * 1.15 * pow(clamp(1.0 - y, 0.0, 1.0), 0.7) * (0.85 + 0.6 * exp(-sq((y - 0.26) / 0.25)));
    // … breaking into licking tongues higher up: lobes around the axis that rise and change with the gas
    float a = atan(rq.y, rq.x);
    float lobe = texture(tBase, vec3(cos(a) * 0.32 + ph * 0.13, y * 0.55 - uTime * 0.85, sin(a) * 0.32 + 0.41)).g;
    R *= 1.0 + 0.9 * pow(yc, 1.4) * (lobe - 0.45);
    float tongue = texture(tBase, vec3(q.x * 9.0 + ph, q.y * 6.0 - uTime * 2.3, q.z * 9.0) * 0.17).g;
    float body = smoothstep(R, R * 0.3, r) * smoothstep(-0.05, 0.05, y) * (1.0 - smoothstep(0.62 + 0.55 * tongue, 1.32, y));
    if (body <= 0.0) continue;
    // temperature: hottest low in the core, cooling outward and upward
    float k = clamp((1.0 - r / max(R, 1e-4)) * 0.9 + (1.0 - y) * 0.45 - 0.2, 0.0, 1.0);
    float L = uFlame.w * mix(0.012, 1.0, k * k * k) * body * strength * fl;   // edges fall into the orange range, only the core clips
    acc += flameColor(k) * L * dt / (wdt * 1.6);
  }
  if (dot(acc, acc) < 1e-10) discard;
  fragColor = vec4(acc * vCT, 1.0);
}
`;

// ------------------------------------------------------------------ far lanterns: points of light
// Below ~2 px a lantern is a point source, like a star: drawn as an energy-conserving gaussian footprint
// (its average radiance × projected area spread over the PSF), so it dims smoothly as it shrinks and never
// pops against the mesh LOD it replaces.
const POINT_VERT = CLOUD_T_GLSL + /* glsl */`
in float aFlux;              // the lantern's average radiance seen from here (nits)
uniform float uPxPerRad, uDpr;
out vec3 vCol, vHaloCol;
out float vSig, vHalo, vSize;
uniform vec3 uCol;
void main() {
  vec4 mv = modelViewMatrix * vec4(position, 1.0);
  gl_Position = projectionMatrix * mv;
  float d = max(-mv.z, 0.1);
  float area = 0.6 / (d * d) * uPxPerRad * uPxPerRad;        // projected px² of a 0.62 × 0.95 m lantern
  float sig = max(0.55 * uDpr, sqrt(area / 6.2831853));
  vSig = sig;
  vec3 wp = (modelMatrix * vec4(position, 1.0)).xyz;
  float T = cloudTransmit(cameraPosition, wp);
  vec3 E = uCol * aFlux * area;                               // the lantern's energy on the sensor (nits · px²)
  vCol = E * T / (6.2831853 * sig * sig);
  // in cloud, what the fog scatters out of the direct beam reaches the lens as a soft halo around the lantern: about
  // half of it (the rest goes sideways), spread over the forward-scattering cone (~ a fifth of the way in, ≤ 40 m)
  float sc = (1.0 - T) * 0.5;
  float hr = min(0.2 * min(d, 400.0), 40.0);
  float hs = clamp(hr / d * uPxPerRad, sig, 90.0 * uDpr);
  vHalo = hs;
  vHaloCol = E * sc / (6.2831853 * hs * hs);
  vSize = aFlux > 0.0 ? ceil(max(sig * 5.0, sc > 0.01 ? hs * 3.5 : 0.0)) + 1.0 : 0.0;
  gl_PointSize = vSize;
}
`;
const POINT_FRAG = /* glsl */`
in vec3 vCol, vHaloCol;
in float vSig, vHalo, vSize;
layout(location = 0) out vec4 fragColor;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * vSize;
  float r2 = dot(q, q);
  fragColor = vec4(vCol * exp(-r2 / (2.0 * vSig * vSig)) + vHaloCol * exp(-r2 / (2.0 * vHalo * vHalo)), 1.0);
}
`;

export class LanternKit {
  async load(base, noise) {
    const gltf = await gltfLoader.loadAsync('assets/lantern.glb');
    const geos = {};
    gltf.scene.updateMatrixWorld(true);
    gltf.scene.traverse((o) => {
      if (!o.isMesh) return;
      const g = o.geometry;
      // the GLB is quantized (KHR_mesh_quantization): back to float, then bake the node's dequantization
      // transform into the vertices, so the shader's object space is the lantern's real metres
      for (const name of Object.keys(g.attributes)) {
        const a = g.attributes[name];
        if (a.array instanceof Float32Array && !a.normalized) continue;
        const f = new Float32Array(a.count * a.itemSize);
        for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) f[i * a.itemSize + c] = a.getComponent(i, c);
        g.setAttribute(name, new THREE.BufferAttribute(f, a.itemSize));
      }
      g.applyMatrix4(o.matrixWorld);
      g.setAttribute('aPart', g.getAttribute('color')); g.deleteAttribute('color');
      geos[o.name] = g;
    });
    this.lod0 = geos.lantern_lod0; this.lod1 = geos.lantern_lod1;
    this.paperTex = await new THREE.TextureLoader().loadAsync('assets/lantern_paper.png');
    const t = this.paperTex;
    // glTF texcoords run v = 0 at the crown (Blender's v flipped on export): upload the PNG unflipped to match
    t.flipY = false; t.needsUpdate = true;
    t.colorSpace = THREE.NoColorSpace; t.wrapS = THREE.RepeatWrapping; t.wrapT = THREE.ClampToEdgeWrapping;
    t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 8;
    const fc = blackbody(CONFIG.lantern.flameK);
    this.flameCol = new THREE.Vector3(fc[0], fc[1], fc[2]);
    this.uniforms = {
      uTime: { value: 0 }, tPaper: { value: t }, uFlameCol: { value: this.flameCol },
      uPaperK: { value: new THREE.Vector4(55, 0.45, 0.38, 0.45) },
      uPaperK2: { value: new THREE.Vector4(0.86, 0.5, 0.0, 0.75) },   // seam T, hem T, (unused: ribs dropped), crinkle normal
      uPaperTint: { value: new THREE.Vector3(1.0, 0.8, 0.5) },   // thin cellulose transmits warm
      uAmb: { value: new THREE.Vector3(0.004, 0.006, 0.01) },
      uNearFade: { value: new THREE.Vector2(-2, -1) },   // set per frame by the game (off for look-dev)
    };
    this.noise = noise;
    this.cloudU = cloudLateUniforms(noise);   // shared by every late material: Clouds keeps uCW in step
    return this;
  }
  /** near: the variant for lanterns close to the lens, faded (premultiplied, no depth write) instead of cut. The
   *  opaque ones never fade (their near fade is off); only the near bucket follows the game's uNearFade. */
  paperMaterial(detail = 1, near = false) {
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: PAPER_VERT, fragmentShader: PAPER_FRAG, side: THREE.DoubleSide,
      uniforms: { ...this.uniforms, uDetail: { value: detail }, uNearFade: near ? this.uniforms.uNearFade : { value: new THREE.Vector2(-2, -1) } },
      ...(near ? { defines: { NEAR_FADE: 1 }, transparent: true, depthWrite: false, blending: THREE.CustomBlending, blendSrc: THREE.OneFactor, blendDst: THREE.OneMinusSrcAlphaFactor } : {}),
    });
  }
  flameMaterial() {
    const box = new THREE.Vector3(0.07, 0.15, 0.07), c = new THREE.Vector3(0, 0.11, 0);
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: FLAME_VERT, fragmentShader: FLAME_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { ...this.cloudU, uTime: this.uniforms.uTime, uNearFade: this.uniforms.uNearFade, tBase: { value: this.noise.base.texture }, uFlame: { value: new THREE.Vector4(-0.03, 0.19, 0.044, 1600) }, uLean: { value: new THREE.Vector2() }, uBox: { value: box }, uBoxC: { value: c } },
    });
  }
  pointMaterial() {
    const c = this.flameCol, t = this.uniforms.uPaperTint.value;
    return new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: POINT_VERT, fragmentShader: POINT_FRAG, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
      uniforms: { ...this.cloudU, uPxPerRad: { value: 1000 }, uDpr: { value: 1 }, uCol: { value: new THREE.Vector3(c.x * t.x, c.y * t.y, c.z * t.z) } },
    });
  }
  /** The far mesh LOD (~150 tris): the lantern's profile on 10 sides, open at the bottom, with the burning
   *  fuel cell and flame as one small hot core (seen from below at a distance it is the bright dot of ref 11). */
  miniGeometry() {
    const R0 = 0.3, R1 = 0.334, HB = 0.8, H = 1.0, SEG = 10;
    const prof = [];
    for (const t of [0, 0.3, 0.65, 1.0]) { const r = R0 + (R1 - R0) * (1 - Math.pow(1 - t, 2.4)), dr = (R1 - R0) * 2.4 * Math.pow(1 - t, 1.4); const n = new THREE.Vector2(HB, -dr).normalize(); prof.push([r, HB * t, n.x, n.y, t === 0 ? 1 : 0]); }
    for (const ph of [0.45, 0.9, 1.25]) { const c = Math.cos(ph), sn = Math.sin(ph); const r = R1 * Math.pow(c, 0.62), z = HB + (H - HB) * sn; const n = new THREE.Vector2((H - HB) * c, R1 * 0.62 * Math.pow(c, -0.38) * sn).normalize(); prof.push([r, z, n.x, n.y, 0]); }
    const pos = [], nor = [], uv = [], part = [], idx = [];
    prof.forEach(([r, y, nr, ny, hem], j) => { for (let i = 0; i < SEG; i++) { const a = i / SEG * Math.PI * 2, ca = Math.cos(a), sa = -Math.sin(a); pos.push(r * ca, y, r * sa); nor.push(nr * ca, ny, nr * sa); uv.push(i / SEG, 1 - y); part.push(0, 0, hem, 1); } });
    for (let j = 0; j < prof.length - 1; j++) for (let i = 0; i < SEG; i++) { const a = j * SEG + i, b = j * SEG + (i + 1) % SEG, c2 = a + SEG, d = b + SEG; idx.push(a, b, d, a, d, c2); }
    const pole = pos.length / 3; pos.push(0, H, 0); nor.push(0, 1, 0); uv.push(0.5, 0); part.push(0, 0, 0, 1);
    const last = (prof.length - 1) * SEG; for (let i = 0; i < SEG; i++) idx.push(last + i, last + (i + 1) % SEG, pole);
    // the hot core: an octahedron at the fuel cell
    const o = pos.length / 3, cy = -0.012, cr = 0.045;
    for (const [x, y, z] of [[cr, 0, 0], [-cr, 0, 0], [0, cr * 1.4, 0], [0, -cr * 0.7, 0], [0, 0, cr], [0, 0, -cr]]) { pos.push(x, cy + y, z); const l = Math.hypot(x, y, z); nor.push(x / l, y / l, z / l); uv.push(0.5, 0.5); part.push(1, 0, 0, 1); }
    idx.push(o + 2, o + 4, o, o + 2, o, o + 5, o + 2, o + 5, o + 1, o + 2, o + 1, o + 4, o + 3, o, o + 4, o + 3, o + 5, o, o + 3, o + 1, o + 5, o + 3, o + 4, o + 1);
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setAttribute('normal', new THREE.Float32BufferAttribute(nor, 3));
    g.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
    g.setAttribute('aPart', new THREE.Float32BufferAttribute(part, 4));
    g.setIndex(idx);
    return g;
  }
  flameGeometry() {
    const g = new THREE.BoxGeometry(0.14, 0.30, 0.14);
    g.translate(0, 0.11, 0);
    return g;
  }
}

/** A handful of real lanterns (instanced), the first one the hero. Per-instance aInst = (phase, flame, bright, seed). */
export class LanternGroup {
  constructor(kit, transforms, { detail = 1, flames = true } = {}) {
    const n = transforms.length;
    this.kit = kit; this.n = n;
    this.inst = new Float32Array(n * 4);
    for (let i = 0; i < n; i++) { this.inst[i * 4] = i * 2.399 + 0.7; this.inst[i * 4 + 1] = 1; this.inst[i * 4 + 2] = 0.85 + 0.3 * ((i * 0.618) % 1); this.inst[i * 4 + 3] = (i * 0.37) % 1; }
    this.inst[2] = 1;
    const ia = new THREE.InstancedBufferAttribute(this.inst, 4);
    const geo = kit.lod0.clone(); geo.setAttribute('aInst', ia);
    this.paper = new THREE.InstancedMesh(geo, kit.paperMaterial(detail), n);
    const fgeo = kit.flameGeometry(); fgeo.setAttribute('aInst', ia);
    this.flame = new THREE.InstancedMesh(fgeo, kit.flameMaterial(), n);
    this.flame.renderOrder = 10;
    transforms.forEach((m, i) => { this.paper.setMatrixAt(i, m); this.flame.setMatrixAt(i, m); });
    for (const o of [this.paper, this.flame]) { o.instanceMatrix.needsUpdate = true; o.frustumCulled = false; o.layers.enable(1); }
    this.flame.layers.set(3); this.flame.layers.enable(1);
    this.flame.visible = flames;
    this.matrices = transforms;
  }
  /** World position of lantern i's flame (for its point light). */
  flamePos(i, out) { return out.set(0, 0.035, 0).applyMatrix4(this.matrices[i]); }
}
