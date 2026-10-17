// The Ping valley: river channel and banks, the town plain, Doi Suthep–Pui massif to the west, low hills
// to the east under the moon. One tensor-product grid with dense rows along the banks and near the hero
// area, coarsening geometrically out to 32 km. Lit by the moon and the sky; distant slopes take aerial haze.
import * as THREE from 'three';
import { COMMON, SKY } from './glsl.js';
import { LIGHTVOL_GLSL } from './lightvol.js';
import { CONFIG } from './config.js';
import { Noise, smoothstep, lerp } from './util.js';

const N = new Noise(31);

/** The river's centreline x at z: straight through the hero reach (z −110 … 170), meandering beyond it. */
export function riverX(z) {
  const k = smoothstep(140, 420, Math.abs(z - 30));
  return k * (60 * Math.sin((z - 30) / 390) + 22 * Math.sin((z - 30) / 160 + 0.7) - 22 * Math.sin(0.7));
}
export const RIVER_GLSL = /* glsl */`
float riverX(float z) {
  float k = smoothstep(140.0, 420.0, abs(z - 30.0));
  return k * (60.0 * sin((z - 30.0) / 390.0) + 22.0 * sin((z - 30.0) / 160.0 + 0.7) - 22.0 * sin(0.7));
}
`;

/** Ground height (m above the water) at world x, z. */
export function heightAt(x, z) {
  const W = CONFIG.world, ax = Math.abs(x - riverX(z));
  let h;
  const bed = W.riverHalf - 5, toe = W.riverHalf + 1, crest = W.riverHalf + 9;
  if (ax < bed) h = -2.2 + 1.0 * (ax / bed) ** 2;
  else if (ax < toe) h = lerp(-1.2, -0.25, smoothstep(bed, toe, ax));
  else if (ax < crest) h = lerp(-0.25, W.bankTop, smoothstep(toe, crest, ax));
  else h = W.bankTop + 1.6 * (N.fbm2(x / 420, z / 420, 3) - 0.5) * smoothstep(crest, crest + 120, ax) + 0.0006 * Math.max(ax - 300, 0);
  h += hills(x, z);
  for (const [x0, z0, x1, z1, ph] of CONFIG.town.pads) {
    const dx = Math.max(x0 - x, 0, x - x1), dz = Math.max(z0 - z, 0, z - z1);
    const w = 1 - smoothstep(0, 6, Math.hypot(dx, dz));
    if (w > 0) h = lerp(h, ph, w);
  }
  return h;
}

function hills(x, z) {
  // Doi Suthep–Pui: a long massif 7–14 km west, summit ridge ~1350 m above the valley
  const rw = N.ridged2(x / 2600 + 3.1, z / 2600 - 1.7, 5);
  const west = 1500 * Math.exp(-(((x + 10500) / 3800) ** 2)) * Math.exp(-(((z + 1500) / 11000) ** 2)) * (0.55 + 0.6 * rw);
  const west2 = 1100 * smoothstep(-12500, -19000, x) * (0.5 + 0.6 * N.ridged2(x / 3400 - 7.3, z / 3400 + 2.2, 5));
  // eastern hills (Doi Saket): low and broken, 13–22 km east, the moon rises over them
  const re = 0.5 * N.ridged2(x / 3200 + 11.3, z / 3200 + 5.1, 4) + 0.5 * N.fbm2(x / 2600 - 3.3, z / 2600 + 1.9, 4);   // rounded, forested
  const east = (620 + 420 * N.fbm2(z / 9000, 1.3, 2)) * smoothstep(9500, 15000, x) * (0.45 + 0.75 * re);
  const east2 = 750 * smoothstep(20000, 27000, x) * (0.5 + 0.6 * N.ridged2(x / 3000, z / 3000 + 9.4, 4));
  // the valley closes far to the north and south
  const ns = 380 * smoothstep(19000, 30000, Math.abs(z)) * (0.5 + 0.7 * N.ridged2(x / 2800 - 4.4, z / 2800, 4));
  // the foothills only rise away from the river (keep the plain flat near the town)
  const keep = smoothstep(2500, 6000, Math.abs(x));
  return (west + west2 + east + east2) * keep + ns;
}

function axisNodes(fineHalf, fineStep, growth, maxStep, extent) {
  const pos = [0];
  let x = 0, s = fineStep;
  while (x < extent) {
    if (x >= fineHalf) s = Math.min(s * growth, maxStep);
    x += s; pos.push(Math.min(x, extent));
  }
  return [...pos.slice(1).reverse().map((v) => -v), ...pos];
}

const VERT = /* glsl */`
out vec3 vWorld;
out vec3 vN;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz; vN = normal;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const FRAG = COMMON + SKY + LIGHTVOL_GLSL + RIVER_GLSL + /* glsl */`
in vec3 vWorld;
in vec3 vN;
layout(location = 0) out vec4 fragColor;
uniform sampler3D tBase;
uniform vec3 uMoonLight;          // moon illuminance (lux, rgb)
uniform vec3 uAmbTop, uAmbHor;    // sky radiance averages (nits)
uniform vec4 uHaze;               // density (1/m), height scale (m), start (m), 0
uniform vec4 uNL[8];              // the 8 nearest lanterns as point lights (xyz, cd): highlights
void main() {
  vec3 n = normalize(vN);
  vec3 V = vWorld - cameraPosition;
  float dist = length(V); V /= dist;
  // albedo: dark tropical vegetation on the hills, paddy and earth on the plain, mud at the waterline
  float n1 = texture(tBase, vec3(vWorld.xz / 900.0, 0.37)).b, n2 = texture(tBase, vec3(vWorld.xz / 140.0, 0.71)).g;
  float hill = smoothstep(40.0, 260.0, vWorld.y);
  vec3 plain = mix(vec3(0.085, 0.08, 0.06), vec3(0.06, 0.075, 0.045), smoothstep(0.35, 0.65, n1)) * (0.8 + 0.4 * n2);
  vec3 forest = vec3(0.045, 0.055, 0.04) * (0.75 + 0.5 * n1);
  vec3 alb = mix(plain, forest, hill);
  alb = mix(vec3(0.07, 0.065, 0.05), alb, smoothstep(0.2, 1.6, vWorld.y));   // wet mud bank
  // the embankment: laid stone courses up the bank slope (the town's reach), mortar lines, a dark wet band and
  // moss at the waterline
  float ax = abs(vWorld.x - riverX(vWorld.z));
  float emb = smoothstep(50.5, 52.0, ax) * (1.0 - smoothstep(60.5, 61.5, ax)) * (1.0 - smoothstep(600.0, 900.0, abs(vWorld.z)));
  if (emb > 0.0) {
    float along = vWorld.z, up = vWorld.y + (ax - 52.0) * 0.32;          // courses follow the slope
    float row = floor(up / 0.32);
    float h = hash12(vec2(row, 7.0));
    float u = along / (0.55 + 0.35 * h) + row * 0.37;
    float cell = floor(u);
    vec2 f = vec2(fract(u), fract(up / 0.32));
    float mortar = smoothstep(0.0, 0.06, f.x) * smoothstep(1.0, 0.94, f.x) * smoothstep(0.0, 0.1, f.y) * smoothstep(1.0, 0.92, f.y);
    float sv = hash12(vec2(cell, row));
    vec3 stone = vec3(0.16, 0.15, 0.13) * (0.7 + 0.6 * sv) * (0.85 + 0.3 * n2) * mix(0.35, 1.0, mortar);
    float wetb = 1.0 - smoothstep(0.15, 0.7, vWorld.y);
    stone = mix(stone, stone * vec3(0.45, 0.55, 0.4), wetb);             // wet, mossy at the waterline
    alb = mix(alb, stone, emb);
  }
  // moon: Lambert (the hills' own shadowing is approximated by slope); sky: hemispherical
  float ndl = max(dot(n, uMoonDir), 0.0);
  vec3 L = alb / PI * uMoonLight * ndl;
  L += alb * mix(uAmbHor, uAmbTop, 0.5 + 0.5 * n.y) * (0.55 + 0.45 * n.y);
  // the lanterns: diffuse from the light volume (every lantern), highlights from the 8 nearest on the wet mud
  L += alb / PI * uLVcol * lanternE(lanternLight(vWorld + n * 0.3), n);
  float wet = 1.0 - smoothstep(0.3, 1.4, vWorld.y);
  if (wet > 0.0) {
    vec3 Vv = -V;
    for (int k = 0; k < 8; k++) {
      vec3 dl = uNL[k].xyz - vWorld; float d2 = dot(dl, dl); vec3 l = dl * inversesqrt(d2);
      vec3 h = normalize(l + Vv);
      float nh = max(dot(n, h), 0.0), a2 = 0.09;   // roughness 0.55²: a soft wet sheen
      float D = a2 / (PI * sq(nh * nh * (a2 - 1.0) + 1.0));
      L += uLVcol * uNL[k].w / d2 * max(dot(n, l), 0.0) * D * 0.25 * 0.04 * wet;
    }
  }
  // aerial perspective: haze thickens with distance and lies in the valley; scatters the moonlit sky
  float hk = uHaze.y, fe = exp(-max(cameraPosition.y, 0.0) / hk), k = V.y / hk;
  float od = abs(k) < 1e-6 ? fe * dist : fe * (1.0 - exp(-k * dist)) / k;
  od *= smoothstep(uHaze.z, uHaze.z * 3.0, dist);
  float fog = 1.0 - exp(-od * uHaze.x);
  vec3 fc = nightSky(normalize(vec3(V.x, max(V.y, 0.0) * 0.5 + 0.01, V.z)));
  L = mix(L, fc, fog);
  fragColor = vec4(L, 1.0);
}
`;

export class Terrain {
  constructor(sky, noise) {
    const xs = axisNodes(72, 1.0, 1.055, 650, 32000), zs = axisNodes(260, 3.0, 1.05, 800, 32000);
    const nx = xs.length, nz = zs.length;
    const pos = new Float32Array(nx * nz * 3);
    for (let j = 0; j < nz; j++) for (let i = 0; i < nx; i++) {
      const o = (j * nx + i) * 3, x = xs[i], z = zs[j];
      pos[o] = x; pos[o + 1] = heightAt(x, z); pos[o + 2] = z;
    }
    const idx = new Uint32Array((nx - 1) * (nz - 1) * 6);
    let k = 0;
    for (let j = 0; j < nz - 1; j++) for (let i = 0; i < nx - 1; i++) {
      const a = j * nx + i, b = a + 1, c = a + nx, d = c + 1;
      idx[k++] = a; idx[k++] = c; idx[k++] = b; idx[k++] = b; idx[k++] = c; idx[k++] = d;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setIndex(new THREE.BufferAttribute(idx, 1));
    g.computeVertexNormals();
    g.computeBoundingSphere();
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        ...sky.U, tBase: { value: noise.base.texture },
        uMoonLight: { value: new THREE.Vector3() }, uAmbTop: { value: new THREE.Vector3() }, uAmbHor: { value: new THREE.Vector3() },
        uHaze: { value: new THREE.Vector4(0.000045, 1600, 2500, 0) },
        uNL: { value: Array.from({ length: 8 }, () => new THREE.Vector4()) },
        tLV: { value: null }, uLVo: { value: [] }, uLVcol: { value: new THREE.Vector3() },
      },
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
    this.mesh.layers.enable(1);
    this.verts = nx * nz;
    this.sky = sky;
    this.syncSky();
  }
  syncSky() {
    const u = this.mat.uniforms, s = this.sky;
    u.uMoonLight.value.set(s.moonLight.r, s.moonLight.g, s.moonLight.b);
    u.uAmbTop.value.set(s.skyAmbTop.r, s.skyAmbTop.g, s.skyAmbTop.b);
    u.uAmbHor.value.set(s.skyAmbHor.r, s.skyAmbHor.g, s.skyAmbHor.b);
  }
}
