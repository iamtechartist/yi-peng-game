// The town along the Ping: the Lanna temple compound on the east bank (viharn, naga stair, chedi), and (from the
// other generators) stilt houses, boats, trees, bulb strings, the crowd. One shader for every town mesh:
//   materials by id (vertex attribute aPart.r): plaster, gold leaf, worn tiles, old timber, lacquer, lit windows,
//   stone, leaves, bark, crowd, paint, metal, banana leaf, flowers, wax, flame;
//   light: the moon (a static shadow map rendered once: nothing in the town moves), the sky (baked AO), every lantern
//   through the light volume (diffuse by normal + a broad warm sheen on gold / glaze), warm floods on the temple and
//   the chedi, the 8 nearest lanterns as point lights for glints, and emission; aerial haze as on the terrain.
import * as THREE from 'three';
import { COMMON, SKY } from './glsl.js';
import { LIGHTVOL_GLSL } from './lightvol.js';
import { loadMeshes } from './gltf.js';
import { CONFIG } from './config.js';
import { blackbody } from './util.js';

const VERT = /* glsl */`
in vec4 aPart;
out vec3 vWorld, vN;
out vec2 vUv;
out vec4 vPart;
out float vInst;
out vec3 vCandle;
void main() {
  mat4 M = modelMatrix;
#ifdef USE_INSTANCING
  M = modelMatrix * instanceMatrix;
  vInst = float(gl_InstanceID);
#else
  vInst = 0.0;
#endif
  vec4 wp = M * vec4(position, 1.0);
  vWorld = wp.xyz; vN = normalize(mat3(M) * normal); vUv = uv; vPart = aPart;
  vCandle = (M * vec4(0.0, 0.17, 0.0, 1.0)).xyz;   // a krathong's candle flame (its object origin is at the waterline)
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;

const FRAG = COMMON + SKY + LIGHTVOL_GLSL + /* glsl */`
in vec3 vWorld, vN;
in vec2 vUv;
in vec4 vPart;
in float vInst;
in vec3 vCandle;
layout(location = 0) out vec4 fragColor;
uniform sampler3D tBase;
uniform sampler2DShadow tShadow0, tShadow1;
uniform mat4 uShadowM0, uShadowM1;
uniform vec3 uMoonLight, uAmbTop, uAmbHor;
uniform vec4 uHaze;
uniform vec4 uFP[12];        // floods: position, intensity (cd)
uniform vec4 uFD[12];        // floods: direction, cos(outer half-angle)
uniform vec3 uFC;            // flood colour (unit luminance)
uniform int uFN;
uniform vec4 uNL[8];         // nearest lanterns: position, intensity
uniform float uTime;
uniform int uDbg;
uniform float uCheap;        // 1 inside the river's mirror pass: diffuse light only
uniform vec3 uFloodC;        // centre of the flood-lit compound (floods only reach within ~70 m)

float hash13(vec3 p) { p = fract(p * 0.1031); p += dot(p, p.zyx + 31.32); return fract((p.x + p.y) * p.z); }
float shadowAt(vec3 p, vec3 n) {
  vec4 c = uShadowM0 * vec4(p + n * 0.06, 1.0);
  vec3 s = c.xyz / c.w * 0.5 + 0.5;
  bool hero = all(greaterThan(s.xy, vec2(0.002))) && all(lessThan(s.xy, vec2(0.998))) && s.z < 1.0;
  if (!hero) { c = uShadowM1 * vec4(p + n * 0.35, 1.0); s = c.xyz / c.w * 0.5 + 0.5; if (any(lessThan(s.xy, vec2(0.0))) || any(greaterThan(s.xy, vec2(1.0))) || s.z > 1.0) return 1.0; }
  // 5 taps of hardware-filtered (bilinear PCF) comparisons
  const vec2 O[5] = vec2[5](vec2(0.0), vec2(1.0, 0.4), vec2(-0.4, 1.0), vec2(-1.0, -0.4), vec2(0.4, -1.0));
  float sh = 0.0;
  if (hero) { vec2 tx = 1.0 / vec2(textureSize(tShadow0, 0)); for (int k = 0; k < 5; k++) sh += texture(tShadow0, vec3(s.xy + O[k] * tx * 1.3, s.z - 0.0008)); }
  else { vec2 tx = 1.0 / vec2(textureSize(tShadow1, 0)); for (int k = 0; k < 5; k++) sh += texture(tShadow1, vec3(s.xy + O[k] * tx * 1.3, s.z - 0.0015)); }
  return sh / 5.0;
}
float ggx(float nh, float a) { float a2 = a * a; float d = nh * nh * (a2 - 1.0) + 1.0; return a2 / (PI * d * d); }
// specular BRDF × cos for one light (Schlick F, GGX D, Smith-Schlick G)
vec3 specL(vec3 n, vec3 v, vec3 l, vec3 F0, float rough) {
  vec3 h = normalize(l + v);
  float nl = max(dot(n, l), 0.0), nv = max(dot(n, v), 1e-3), nh = max(dot(n, h), 0.0), vh = max(dot(v, h), 0.0);
  float a = rough * rough, k = (rough + 1.0) * (rough + 1.0) / 8.0;
  float G = (nl / (nl * (1.0 - k) + k)) * (nv / (nv * (1.0 - k) + k));
  vec3 F = F0 + (1.0 - F0) * pow(1.0 - vh, 5.0);
  return F * ggx(nh, a) * G / (4.0 * nv + 1e-4);
}
void main() {
  vec3 n = normalize(vN);
  vec3 V = cameraPosition - vWorld; float dist = length(V); V /= dist;
  if (!gl_FrontFacing) n = -n;
  int id = int(vPart.r * 16.0);
  float ao = vPart.g, var = vPart.b;
  vec3 p = vWorld;
  float iv = hash11(vInst * 7.31 + 0.5);
  // ---------------- material ----------------
  vec3 alb = vec3(0.5); vec3 F0 = vec3(0.04); float rough = 0.9; float metal = 0.0; vec3 emit = vec3(0.0);
  float n1 = texture(tBase, p * vec3(0.35, 0.09, 0.35)).b, n2 = texture(tBase, p * 1.7).g;
  if (id == 0) {                 // whitewashed plaster: warm white, rain streaks from the cornices, grime at the foot
    float streak = smoothstep(0.45, 0.8, texture(tBase, vec3(p.x * 1.3 + p.z * 1.3, p.y * 0.06, 0.3)).b);
    alb = vec3(0.78, 0.74, 0.66) * (0.86 + 0.14 * var) * (1.0 - 0.22 * streak) * (1.0 - 0.3 * smoothstep(0.6, 0.0, p.y - 2.5) * n2);
    rough = 0.95;
  } else if (id == 1) {          // gold leaf over red lacquer, worn through in patches
    float wear = smoothstep(0.74, 0.86, n1 * 0.6 + n2 * 0.5 + var * 0.1);
    metal = 1.0 - 0.6 * wear;                      // rubbed leaf: duller, browner gold, never bare red
    F0 = vec3(1.0, 0.78, 0.36) * (0.88 + 0.16 * var) * (1.0 - 0.45 * wear);
    alb = vec3(0.16, 0.09, 0.03) * wear;
    // carved, burnished leaf scatters broadly: rough enough that the floods paint it, glossy enough to glint
    rough = mix(0.5, 0.38 + 0.18 * n2, metal);
  } else if (id == 2) {          // worn clay roof tiles, pointed ends, overlapping rows; glazed dark brown
    vec2 g = vUv / vec2(0.12, 0.2);
    float row = floor(g.y);
    float cx = g.x + 0.5 * mod(row, 2.0);
    vec2 cell = vec2(floor(cx), row), f = vec2(fract(cx), fract(g.y));
    float h = hash12(cell + 13.1);
    float edge = f.y - (0.16 + 0.32 * abs(f.x - 0.5));          // the pointed lower end of the tile above
    float gap = smoothstep(0.0, 0.06, edge) * smoothstep(0.0, 0.08, min(f.x, 1.0 - f.x));
    alb = vec3(0.085, 0.055, 0.04) * (0.7 + 0.6 * h) * mix(0.35, 1.0, gap);
    if (h > 0.93) alb = vec3(0.16, 0.09, 0.05);                 // newer replacement tiles
    alb *= 0.8 + 0.4 * n2;
    rough = 0.38 + 0.25 * h; F0 = vec3(0.045);
  } else if (id == 3) {          // old teak
    float grain = texture(tBase, vec3(p.x * 0.4, p.y * 6.0, p.z * 0.4)).g;
    alb = vec3(0.13, 0.08, 0.05) * (0.7 + 0.6 * grain) * (0.8 + 0.4 * var);
    rough = 0.75;
  } else if (id == 4) {          // red lacquer
    alb = vec3(0.32, 0.045, 0.03) * (0.85 + 0.3 * n2); rough = 0.35; F0 = vec3(0.05);
  } else if (id == 5) {          // a lit opening: warm light from inside
    alb = vec3(0.02);
    emit = vec3(1.0, 0.4, 0.09) * (8.0 + 18.0 * var * var) * (0.85 + 0.3 * n2);   // incandescent / candlelit, ~2100 K
  } else if (id == 6) {          // the wider town: concrete shophouse facades with windows, some lit from within
    alb = vec3(0.22, 0.2, 0.18) * (0.75 + 0.5 * iv) * (0.85 + 0.3 * n2);
    if (abs(n.y) < 0.5) {
      float u = abs(n.x) > 0.5 ? p.z : p.x;
      vec2 cell = vec2(floor(u / 2.6), floor((p.y - 0.4) / 3.2));
      vec2 f = vec2(fract(u / 2.6), fract((p.y - 0.4) / 3.2));
      float win = step(0.22, f.x) * step(f.x, 0.78) * step(0.28, f.y) * step(f.y, 0.78) * step(0.5, cell.y + 0.5);
      float h = hash12(cell + vInst * 1.37);
      if (win > 0.5) {
        alb = vec3(0.02);
        if (h > 0.55) emit = (h > 0.82 ? vec3(0.75, 0.85, 1.0) : vec3(1.0, 0.55, 0.2)) * (2.0 + 6.0 * fract(h * 13.7));
      }
    }
  } else if (id == 7) {          // leaves: dark, a little translucent
    alb = vec3(0.035, 0.05, 0.025) * (0.7 + 0.6 * var); rough = 0.6;
  } else if (id == 8) {
    alb = vec3(0.07, 0.06, 0.05) * (0.8 + 0.4 * n2);
  } else if (id == 9) {          // crowd: dark clothes, skin, mostly in silhouette
    alb = mix(vec3(0.03, 0.03, 0.035), vec3(0.12, 0.07, 0.05), step(0.7, var)) * (0.7 + 0.6 * iv);
    rough = 0.8;
  } else if (id == 10) {         // boat paint
    vec3 c1 = vec3(0.05, 0.12, 0.2), c2 = vec3(0.25, 0.05, 0.04), c3 = vec3(0.06, 0.14, 0.07);
    alb = (iv < 0.33 ? c1 : iv < 0.66 ? c2 : c3) * (0.7 + 0.5 * var); rough = 0.5;
  } else if (id == 11) {         // galvanised metal sheet
    alb = vec3(0.2, 0.2, 0.19) * (0.7 + 0.5 * n2); F0 = vec3(0.5); rough = 0.45; metal = 0.6;
  } else if (id == 12) {         // banana leaf
    alb = vec3(0.07, 0.15, 0.04) * (0.75 + 0.5 * var); rough = 0.5;
  } else if (id == 13) {         // flowers: marigold and orchid
    alb = var > 0.5 ? vec3(0.9, 0.38, 0.03) : vec3(0.7, 0.18, 0.45); rough = 0.7;
  } else if (id == 14) {         // candle wax, glowing near the flame
    alb = vec3(0.8, 0.74, 0.6); emit = vec3(1.0, 0.55, 0.2) * 4.0 * var;
  } else if (id == 15) {
    // a candle flame flickers (var < 0.5); a festoon bulb glows steady
    emit = var < 0.5 ? vec3(1.0, 0.52, 0.16) * 600.0 * (0.85 + 0.15 * sin(uTime * 41.0 + iv * 30.0)) : vec3(1.0, 0.58, 0.24) * 140.0;
  }
  // ---------------- light ----------------
  vec3 diff = vec3(0.0), spec = vec3(0.0);
  float sh = shadowAt(p, n);
  float ndm = max(dot(n, uMoonDir), 0.0);
  diff += uMoonLight * ndm * sh;
  spec += uMoonLight * specL(n, V, uMoonDir, F0, rough) * sh * PI;
  diff += mix(uAmbHor, uAmbTop, 0.5 + 0.5 * n.y) * PI * (0.55 + 0.45 * n.y) * ao;
  // the lanterns (light volume): diffuse by normal, and their combined glow as a broad light for sheen
  vec4 LL = lanternLight(p + n * 0.25);
  diff += uLVcol * lanternE(LL, n) * mix(0.35, 1.0, ao);
  bool glossy = rough < 0.7 && uCheap < 0.5;      // gold, lacquer, glazed tiles, paint, metal
  float lv = length(LL.yzw);
  if (glossy && lv > 1e-4) spec += uLVcol * lv * specL(n, V, LL.yzw / lv, F0, max(rough, 0.45)) * mix(0.4, 1.0, ao);
  // floods (only around the temple compound)
  vec3 dc = p - uFloodC;
  int nf = dot(dc, dc) < 75.0 * 75.0 ? uFN : 0;
  for (int k = 0; k < 12; k++) {
    if (k >= nf) break;
    vec3 dl = uFP[k].xyz - p; float d2 = dot(dl, dl); vec3 l = dl * inversesqrt(d2);
    float cone = smoothstep(uFD[k].w, uFD[k].w + 0.12, dot(-l, uFD[k].xyz));
    if (cone <= 0.0) continue;
    float E = uFP[k].w * cone / d2;
    diff += uFC * E * max(dot(n, l), 0.0);
    if (glossy) spec += uFC * E * specL(n, V, l, F0, rough);
  }
  // a krathong's own candle (≈1 cd, flickering) lights its banana leaves and flowers from inside the lotus
  if (id == 12 || id == 13 || id == 14) {
    vec3 dl = vCandle - p; float d2 = dot(dl, dl) + 0.0004;
    float fl = 0.85 + 0.15 * sin(uTime * 37.0 + iv * 40.0);
    diff += vec3(1.0, 0.55, 0.2) * 1.0 * fl / d2 * (0.35 + 0.65 * max(dot(n, dl * inversesqrt(d2)), 0.0));
  }
  if (glossy) {
    // the nearest lanterns: glints
    for (int k = 0; k < 8; k++) {
      vec3 dl = uNL[k].xyz - p; float d2 = dot(dl, dl);
      if (d2 > 900.0) continue;
      vec3 l = dl * inversesqrt(d2);
      spec += uLVcol * uNL[k].w / d2 * specL(n, V, l, F0, rough);
    }
    // the night sky in the gold and the glaze
    vec3 R = reflect(-V, n);
    vec3 Fv = F0 + (1.0 - F0) * pow(1.0 - max(dot(n, V), 0.0), 5.0);
    spec += nightSky(normalize(vec3(R.x, max(R.y, 0.02), R.z))) * Fv * ao * (1.0 - rough * 0.6);
  }
  vec3 L = alb / PI * diff * (1.0 - metal) + spec + emit;
  // aerial perspective (as on the terrain)
  float hk = uHaze.y, fe = exp(-max(cameraPosition.y, 0.0) / hk), k2 = -V.y / hk;
  float od = abs(k2) < 1e-6 ? fe * dist : fe * (1.0 - exp(-k2 * dist)) / k2;
  od *= smoothstep(uHaze.z, uHaze.z * 3.0, dist);
  L = mix(L, nightSky(normalize(vec3(-V.x, max(-V.y, 0.0) * 0.5 + 0.01, -V.z))), 1.0 - exp(-od * uHaze.x));
  if (uDbg == 1) L = vec3(fract(float(id) * 0.37), fract(float(id) * 0.61), fract(float(id) * 0.83)) * 2.0;   // material ids
  if (uDbg == 2) L = vec3(ao) * 0.5;
  fragColor = vec4(L, 1.0);
}
`;

/* The temple compound's placement (world): the viharn's front faces the river (−x). */
export const TEMPLE = CONFIG.town.temple;
export const CHEDI = CONFIG.town.chedi;

export class Town {
  constructor(sky, noise) {
    this.sky = sky;
    const fc = blackbody(3500);   // halogen floods: a shade warmer than the camera's white balance (3800 K)
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG, side: THREE.DoubleSide,
      uniforms: {
        ...sky.U, tBase: { value: noise.base.texture },
        tLV: { value: null }, uLVo: { value: [] }, uLVcol: { value: new THREE.Vector3() },
        tShadow0: { value: null }, tShadow1: { value: null }, uShadowM0: { value: new THREE.Matrix4() }, uShadowM1: { value: new THREE.Matrix4() },
        uMoonLight: { value: new THREE.Vector3(sky.moonLight.r, sky.moonLight.g, sky.moonLight.b) },
        uAmbTop: { value: new THREE.Vector3(sky.skyAmbTop.r, sky.skyAmbTop.g, sky.skyAmbTop.b) },
        uAmbHor: { value: new THREE.Vector3(sky.skyAmbHor.r, sky.skyAmbHor.g, sky.skyAmbHor.b) },
        uHaze: { value: new THREE.Vector4(0.000045, 1600, 2500, 0) },
        uFP: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) }, uFD: { value: Array.from({ length: 12 }, () => new THREE.Vector4()) },
        uFC: { value: new THREE.Vector3(fc[0], fc[1], fc[2]) }, uFN: { value: 0 },
        uNL: { value: Array.from({ length: 8 }, () => new THREE.Vector4(0, -1e4, 0, 0)) }, uTime: { value: 0 }, uDbg: { value: 0 }, uCheap: { value: 0 }, uFloodC: { value: new THREE.Vector3((CONFIG.town.temple.x + CONFIG.town.chedi.x) / 2, CONFIG.town.temple.ground + 5, (CONFIG.town.temple.z + CONFIG.town.chedi.z) / 2) },
      },
    });
    this.group = new THREE.Group();
    this.group.layers.enable(1);
    this.keepOut = [];      // rects (x0, z0, x1, z1) where nothing else may stand (buildings), for the swarm's release
  }

  /** Add a mesh (or instances of one). Large instance sets are split into 160 m tiles, each with its own bounds,
   *  so the tiles out of view are culled. reflect: false keeps it out of the river's mirror pass (layer 1). */
  add(geo, matrix, instances, { chunk = true, reflect = true, tile = 160 } = {}) {
    const mk = (list) => {
      const m = new THREE.InstancedMesh(geo, this.mat, list.length);
      list.forEach((M, i) => m.setMatrixAt(i, M));
      m.instanceMatrix.needsUpdate = true;
      m.computeBoundingSphere();
      if (reflect) m.layers.enable(1);
      m.userData.town = true;
      return m;
    };
    let out;
    if (instances) {
      if (chunk && instances.length > 24) {
        const tiles = new Map(), p = new THREE.Vector3();
        for (const M of instances) { p.setFromMatrixPosition(M); const k = `${Math.floor(p.x / tile)},${Math.floor(p.z / tile)}`; if (!tiles.has(k)) tiles.set(k, []); tiles.get(k).push(M); }
        out = new THREE.Group();
        for (const list of tiles.values()) out.add(mk(list));
      } else out = mk(instances);
    } else {
      out = new THREE.Mesh(geo, this.mat);
      if (matrix) { out.matrixAutoUpdate = false; out.matrix.copy(matrix); }
      if (reflect) out.layers.enable(1);
      out.userData.town = true;
    }
    if (reflect) out.layers.enable(1);
    out.userData.town = true;
    this.group.add(out);
    return out;
  }

  /** Instances with a near and a far mesh, tiled; each tile switches on its distance from the camera. */
  addLOD(geoNear, geoFar, instances, dist, opts = {}) {
    const tile = opts.tile || 160;
    const tiles = new Map(), p = new THREE.Vector3();
    for (const M of instances) { p.setFromMatrixPosition(M); const k = `${Math.floor(p.x / tile)},${Math.floor(p.z / tile)}`; if (!tiles.has(k)) tiles.set(k, []); tiles.get(k).push(M); }
    const grp = new THREE.Group();
    this.lods = this.lods || [];
    for (const list of tiles.values()) {
      const near = this.add(geoNear, null, list, { ...opts, chunk: false }), far = this.add(geoFar, null, list, { ...opts, chunk: false });
      this.group.remove(near, far); grp.add(near, far);
      const bs = near.boundingSphere;
      this.lods.push({ near, far, c: bs.center.clone(), r: bs.radius, dist });
    }
    this.group.add(grp);
    return grp;
  }

  async load() {
    const T = await loadMeshes('assets/temple.glb');
    const g = TEMPLE.ground;
    const at = (x, y, z) => new THREE.Matrix4().makeTranslation(x, y, z);
    this.add(T.viharn, at(TEMPLE.x, g, TEMPLE.z));
    this.add(T.naga_stair, at(TEMPLE.x, g, TEMPLE.z));
    this.add(T.chedi, at(CHEDI.x, g, CHEDI.z));
    this.keepOut.push([TEMPLE.x - 20, TEMPLE.z - 9, TEMPLE.x + 17, TEMPLE.z + 9], [CHEDI.x - 8, CHEDI.z - 8, CHEDI.x + 8, CHEDI.z + 8]);
    // floods: warm lamps at the foot of the viharn and around the chedi, aimed up at the gables and the bell
    const F = [];
    const flood = (px, py, pz, tx, ty, tz, I, deg) => F.push([new THREE.Vector3(px, py, pz), new THREE.Vector3(tx - px, ty - py, tz - pz).normalize(), I, Math.cos(deg * Math.PI / 180)]);
    const X = TEMPLE.x, Z = TEMPLE.z;
    flood(X - 22, g + 0.4, Z - 5, X - 15, g + 6.5, Z - 1, 9000, 32);       // the porch gable, from the riverside lawn
    flood(X - 22, g + 0.4, Z + 5, X - 15, g + 6.5, Z + 1, 9000, 32);
    flood(X - 19.5, g + 1.2, Z, X - 11, g + 7.5, Z, 5000, 30);              // up through the porch to the middle gable
    flood(X - 9, g + 0.3, Z - 11, X + 2, g + 5, Z - 7, 4500, 40);           // the north aisle wall and brackets
    flood(X - 9, g + 0.3, Z + 11, X + 2, g + 5, Z + 7, 4500, 40);
    const cx = CHEDI.x, cz = CHEDI.z;
    for (const [sx, sz] of [[-1, -1], [-1, 1], [1, -1], [1, 1]]) flood(cx + sx * 12, g + 0.3, cz + sz * 12, cx, g + 9, cz, 14000, 28);
    flood(cx - 14, g + 0.3, cz, cx, g + 17, cz, 9000, 14);                   // a narrow beam up the spire
    this.floods = F;
    const u = this.mat.uniforms;
    F.forEach(([p, d, I, c], i) => { u.uFP.value[i].set(p.x, p.y, p.z, I); u.uFD.value[i].set(d.x, d.y, d.z, c); });
    u.uFN.value = F.length;
    return this;
  }

  /** Static moon shadows: rendered once (nothing in the town moves). Hero map over the temple compound,
   *  wide map over the whole town. */
  bakeShadows(renderer, scene) {
    const md = this.sky.moonDir;
    const mk = (cx, cz, half, res) => {
      const rt = new THREE.WebGLRenderTarget(res, res, { depthBuffer: true });
      rt.depthTexture = new THREE.DepthTexture(res, res, THREE.FloatType);
      rt.depthTexture.compareFunction = THREE.LessEqualCompare;
      rt.depthTexture.minFilter = rt.depthTexture.magFilter = THREE.LinearFilter;
      const cam = new THREE.OrthographicCamera(-half, half, half, -half, 1, 3000);
      const c = new THREE.Vector3(cx, 5, cz);
      cam.position.copy(c).addScaledVector(md, 1500); cam.lookAt(c); cam.updateMatrixWorld(); cam.updateProjectionMatrix();
      return { rt, cam, M: new THREE.Matrix4().multiplyMatrices(cam.projectionMatrix, cam.matrixWorldInverse) };
    };
    const hero = mk((TEMPLE.x + CHEDI.x) / 2, (TEMPLE.z + CHEDI.z) / 2, 48, 2048);
    const wide = mk(0, 0, 700, 2048);
    const depthMat = new THREE.MeshDepthMaterial();
    const prevOverride = scene.overrideMaterial, prev = renderer.getRenderTarget();
    const vis = [];
    scene.traverse((o) => { if ((o.isMesh || o.isPoints) && !o.userData.town && o.visible) { vis.push(o); o.visible = false; } });
    scene.overrideMaterial = depthMat;
    for (const S of [hero, wide]) { renderer.setRenderTarget(S.rt); renderer.clear(true, true, false); renderer.render(scene, S.cam); }
    scene.overrideMaterial = prevOverride; renderer.setRenderTarget(prev);
    for (const o of vis) o.visible = true;
    const u = this.mat.uniforms;
    u.tShadow0.value = hero.rt.depthTexture; u.tShadow1.value = wide.rt.depthTexture;
    u.uShadowM0.value.copy(hero.M); u.uShadowM1.value.copy(wide.M);
    this.shadows = { hero, wide };
  }

  update(time, near, camera) {
    if (camera && this.lods) {
      const cp = camera.position;
      for (const L of this.lods) { const d = cp.distanceTo(L.c) - L.r; L.near.visible = d < L.dist; L.far.visible = !L.near.visible; }
    }
    const u = this.mat.uniforms;
    u.uTime.value = time;
    for (let j = 0; j < 8; j++) { const q = near[j]; if (q) u.uNL.value[j].set(q[0], q[1], q[2], q[3]); else u.uNL.value[j].set(0, -1e4, 0, 0); }
  }
}
