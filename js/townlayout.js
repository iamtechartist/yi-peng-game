// Where everything in the town stands. The Ping runs north–south (z); the water is |x| < ~54, the bank crest at
// |x| = 61. A promenade runs along both banks (61–67 m), the houses stand behind it with their verandas facing the
// river, palms line the promenade, banyans shade the temple compound (east bank, across from the start), rain
// trees grow in the lanes, boats are moored at the water's edge and at the jetties. The festival: strings of bulbs
// on the verandas, along the temple promenade and radiating from the chedi's spire; the crowd on the banks holding
// their lanterns overhead; krathongs drifting downstream with their candles lit. Beyond the riverside, the wider
// town: low concrete blocks with lit windows, and street lamps out to the hills.
import * as THREE from 'three';
import { loadMeshes } from './gltf.js';
import { heightAt, riverX } from './terrain.js';
import { CONFIG } from './config.js';
import { mulberry32, blackbody, DEG } from './util.js';
import { CLOUD_T_GLSL } from './clouds.js';

const HOUSE = [{ W: 8.0, D: 6.0, ver: 2.2, floor: 2.6 }, { W: 10.0, D: 7.0, ver: 2.2, floor: 2.9 }, { W: 7.0, D: 5.5, ver: 1.6, floor: 2.4 }];
const PROM = 67;            // the houses' veranda fronts stand this far from the river's axis
const JETTIES = [[-1, -210], [-1, 140], [-1, 330], [1, -260], [1, 128], [1, 250]];

const mat4 = (x, y, z, yaw = 0, s = 1) => new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), yaw), new THREE.Vector3(s, s, s));

/** Points of light: lamps of intensity I (cd) drawn as energy-conserving gaussians (E = I / d² over one pixel).
 *  With a source radius r, they fade in only once the source mesh would shrink below ~2 px. */
function lightPoints(pts, cols, I, r, cloudU) {
  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pts.flat(), 3));
  g.setAttribute('aCol', new THREE.Float32BufferAttribute(cols.flat(), 3));
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending,
    uniforms: { ...cloudU, uPxPerRad: { value: 1000 }, uDpr: { value: 1 }, uI: { value: I }, uR: { value: r } },
    vertexShader: CLOUD_T_GLSL + /* glsl */`
      in vec3 aCol; uniform float uPxPerRad, uDpr, uI, uR; out vec3 vCol; out float vSig;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.0); gl_Position = projectionMatrix * mv;
        float d = max(-mv.z, 1.0), sig = 0.6 * uDpr;
        float fade = uR > 0.0 ? 1.0 - smoothstep(1.0, 2.0, uR * uPxPerRad / d) : 1.0;
        float L = uI / (d * d) * uPxPerRad * uPxPerRad * fade;
        vSig = sig; vCol = aCol * L / (6.2831853 * sig * sig) * cloudTransmit(cameraPosition, (modelMatrix * vec4(position, 1.0)).xyz);
        gl_PointSize = fade > 0.0 ? ceil(sig * 5.0) + 1.0 : 0.0;
      }`,
    fragmentShader: /* glsl */`
      in vec3 vCol; in float vSig; layout(location = 0) out vec4 fragColor;
      void main() { vec2 q = (gl_PointCoord - 0.5) * (ceil(vSig * 5.0) + 1.0); fragColor = vec4(vCol * exp(-dot(q, q) / (2.0 * vSig * vSig)), 1.0); }`,
  });
  const p = new THREE.Points(g, m); p.frustumCulled = false; p.layers.set(3); p.layers.enable(1); p.userData.town = true;
  return p;
}

/** Chiang Mai beyond the modelled 3 km square: ~28 000 lights on the valley floor (not on the river, not up the hills). */
function farCity(na, le, unit, cloudU) {
  const r = mulberry32(4242), pts = [], cols = [];
  const g = () => { let u = 0; for (let i = 0; i < 4; i++) u += r(); return (u - 2) / 0.577; };
  const put = (x, z) => {
    if (Math.abs(x) < 1500 && Math.abs(z) < 1500) return;                 // the modelled town has its own
    if (Math.hypot(x, z) > 9500) return;
    if (Math.abs(x - riverX(z)) < 70) return;
    const h = heightAt(x, z);
    if (h > 40) return;                                                     // the hills stay dark
    pts.push([x, h + 6 + r() * 4, z]); cols.push(unit(r() < 0.72 ? na : le));
  };
  for (let k = 0; k < 11; k++) {                                            // roads out of the old city
    const a = (k / 11) * 6.283 + (r() - 0.5) * 0.4, wob = r() * 6.283;
    let built = true, next = 1300 + r() * 600;
    for (let d = 1300; d < 9500; d += 26 + r() * 22) {
      if (d > next) { built = r() < 0.6; next = d + 250 + r() * 700; }   // stretches through town, gaps through fields
      const aa = a + 0.025 * Math.sin(d / 2600 + wob), x = Math.cos(aa) * d, z = Math.sin(aa) * d;
      if (built ? r() < 0.75 : r() < 0.18) put(x + (r() - 0.5) * 14, z + (r() - 0.5) * 14);
      if (built) for (let j = r() < 0.5 ? 1 : 2; j > 0; j--) put(x + g() * 55, z + g() * 55);   // ribbon building along it
    }
  }
  for (let k = 0; k < 140; k++) {                                           // suburbs and villages, thinning outward
    const d = 1600 + 7500 * Math.pow(r(), 1.4), a = r() * 6.283;
    const cx = Math.cos(a) * d, cz = Math.sin(a) * d, rad = 120 + 300 * r(), n = Math.round((60 + 220 * r()) * (1.3 - d / 9500));
    for (let i = 0; i < n; i++) put(cx + g() * rad, cz + g() * rad);
  }
  for (let i = 0; i < 7000; i++) { const d = 1500 + 8000 * Math.pow(r(), 1.6), a = r() * 6.283; put(Math.cos(a) * d, Math.sin(a) * d); }
  return lightPoints(pts, cols, 380, 0, cloudU);
}

/** A catenary between a and b with sag, sampled every `step` metres. */
function catenary(a, b, sag, step) {
  const n = Math.max(2, Math.round(a.distanceTo(b) / step));
  const out = [];
  for (let k = 0; k <= n; k++) { const t = k / n; out.push(new THREE.Vector3().lerpVectors(a, b, t).add(new THREE.Vector3(0, -4 * sag * t * (1 - t), 0))); }
  return out;
}

export async function layoutTown(town) {
  const H = await loadMeshes('assets/houses.glb');
  const T = await loadMeshes('assets/trees.glb');
  const S = await loadMeshes('assets/small.glb');
  const rnd = mulberry32(2026);
  const temple = CONFIG.town.temple, chedi = CONFIG.town.chedi;
  const inTemple = (x, z) => x > 58 && x < 140 && z > 5 && z < 100;
  const nearJetty = (side, z) => JETTIES.some(([s, jz]) => s === side && Math.abs(z - jz) < 9);
  const bulbs = [];           // world positions of every festoon bulb
  const wires = [];           // line segments of their wires
  const string = (pts) => { for (let k = 0; k < pts.length; k++) { if (k) wires.push(pts[k - 1], pts[k]); if (k % 1 === 0) bulbs.push(pts[k].clone()); } };

  // ---------------- houses, their strings of lights, boats moored in front ----------------
  const houses = [[], [], []], boats = [[], []];
  for (const side of [-1, 1]) {
    let z = -470 + rnd() * 10;
    while (z < 470) {
      const v = Math.floor(rnd() * 3), Hh = HOUSE[v];
      const zc = z + Hh.W / 2;
      z += Hh.W + 3 + rnd() * 9;
      if ((side > 0 && inTemple(70, zc)) || nearJetty(side, zc) || (side < 0 && zc > -40 && zc < 40 && rnd() < 0.5)) continue;
      const off = Hh.D / 2 + Hh.ver;
      const rc = riverX(zc), slope = (riverX(zc + 2) - riverX(zc - 2)) / 4;
      const xc = rc + side * (PROM + off);
      const g = heightAt(xc, zc);
      houses[v].push(mat4(xc, g, zc, (side > 0 ? Math.PI : 0) - Math.atan(slope), 1));
      town.keepOut.push([Math.min(xc - side * off, xc + side * Hh.D / 2) - 0.5, zc - Hh.W / 2 - 0.5, Math.max(xc - side * off, xc + side * Hh.D / 2) + 0.5, zc + Hh.W / 2 + 0.5]);
      if (rnd() < 0.6) {      // a string of bulbs under the veranda eave
        const y = g + Hh.floor + 1.55, x = rc + side * (PROM - 0.05);
        string(catenary(new THREE.Vector3(x, y, zc - Hh.W / 2), new THREE.Vector3(x, y, zc + Hh.W / 2), 0.22, 0.55));
      }
      if (rnd() < 0.45) {     // a boat at the water's edge
        const bz = zc + (rnd() - 0.5) * 6;
        boats[rnd() < 0.4 ? 0 : 1].push(mat4(riverX(bz) + side * (51.5 + rnd() * 2.0), -0.12, bz, (rnd() < 0.5 ? 1 : -1) * Math.PI / 2 + (rnd() - 0.5) * 0.2, 1));
      }
    }
  }
  houses.forEach((list, v) => list.length && town.add(H[`house${v}`], null, list));
  // jetties, each with a boat or two alongside
  const jet = [];
  for (const [side, jz] of JETTIES) {
    const rj = riverX(jz);
    jet.push(mat4(rj + side * 61, 1.0, jz, side > 0 ? Math.PI : 0));
    for (let k = 0; k < 1 + (rnd() < 0.5 ? 1 : 0); k++) boats[k % 2].push(mat4(rj + side * (50 - k * 2.2), -0.12, jz + (k ? -2.2 : 2.2), Math.PI / 2 * (k ? -1 : 1), 1));
  }
  town.add(H.jetty, null, jet);
  boats.forEach((list, v) => list.length && town.add(H[`boat${v}`], null, list));

  // ---------------- trees ----------------
  const palms = [[], []], rain = [], banyan = [];
  for (const side of [-1, 1]) {
    for (let z = -460; z < 460; z += 14 + rnd() * 16) {
      const x = riverX(z) + side * (62 + rnd() * 4);
      if (side > 0 && z > 26 && z < 54) continue;          // keep the temple's front clear
      if (nearJetty(side, z)) continue;
      palms[rnd() < 0.5 ? 0 : 1].push(mat4(x, heightAt(x, z) - 0.3, z, rnd() * 6.28, 0.85 + rnd() * 0.3));
    }
    for (let k = 0; k < 16; k++) {
      const z = -420 + rnd() * 840, x = riverX(z) + side * (86 + rnd() * 40);
      if (inTemple(x, z)) continue;
      rain.push(mat4(x, heightAt(x, z) - 0.2, z, rnd() * 6.28, 0.8 + rnd() * 0.5));
    }
  }
  for (const [x, z, s] of [[70, 10, 1.0], [74, 96, 0.9], [134, 30, 1.1], [-84, -70, 1.0], [-80, 250, 0.85]]) banyan.push(mat4(x, heightAt(x, z) - 0.3, z, rnd() * 6.28, s));
  // near / far LODs per 160 m tile (the far meshes: fewer leaflets, canopy clumps without their loose leaves)
  palms.forEach((list, v) => list.length && (town.addLOD(T[`palm${v}`], T[`palm${v}_far`], list, 70).userData.kind = 'tree'));
  town.addLOD(T.raintree, T.raintree_far, rain, 45, { reflect: false }).userData.kind = 'tree';   // inland: never in the river's mirror
  town.addLOD(T.banyan, T.banyan_far, banyan, 60, { tile: 60 }).userData.kind = 'tree';
  for (const M of banyan) { const p = new THREE.Vector3().setFromMatrixPosition(M); town.keepOut.push([p.x - 4, p.z - 4, p.x + 4, p.z + 4]); }

  // ---------------- the temple's steps down to the water (whitewashed; krathongs are launched from them) ----------------
  {
    const g = new THREE.BufferGeometry(), parts = [];
    const z0 = temple.z, W = 16, n = 11;
    for (let i = 0; i < n; i++) {
      const x0 = 52.6 + i * 0.75, top = -0.35 + (i + 1) * (temple.ground + 0.35) / n;
      const b = new THREE.BoxGeometry(0.78, top + 1.2, W); b.translate(x0 + 0.375, (top - 1.2) / 2, z0);
      parts.push(b);
    }
    for (const sz of [-1, 1]) { const b = new THREE.BoxGeometry(8.6, 1.0, 0.5); b.translate(56.9, temple.ground - 0.2, z0 + sz * (W / 2 + 0.25)); parts.push(b); }
    const merged = parts.map((b) => b.toNonIndexed());
    let count = 0; for (const b of merged) count += b.getAttribute('position').count;
    const P = new Float32Array(count * 3), N = new Float32Array(count * 3), U = new Float32Array(count * 2), A = new Float32Array(count * 4);
    let o = 0;
    for (const b of merged) {
      const c = b.getAttribute('position').count;
      P.set(b.getAttribute('position').array, o * 3); N.set(b.getAttribute('normal').array, o * 3); U.set(b.getAttribute('uv').array, o * 2);
      for (let i = 0; i < c; i++) { A[(o + i) * 4] = 0.5 / 16; A[(o + i) * 4 + 1] = 0.85; A[(o + i) * 4 + 2] = rnd(); A[(o + i) * 4 + 3] = 1; }
      o += c;
    }
    g.setAttribute('position', new THREE.BufferAttribute(P, 3)); g.setAttribute('normal', new THREE.BufferAttribute(N, 3));
    g.setAttribute('uv', new THREE.BufferAttribute(U, 2)); g.setAttribute('aPart', new THREE.BufferAttribute(A, 4));
    town.add(g, new THREE.Matrix4());
  }

  // ---------------- festival lights at the temple ----------------
  const g0 = temple.ground;
  // along the promenade in front of the temple, pole to pole
  for (let z = -6; z < 110; z += 12) string(catenary(new THREE.Vector3(61.5, g0 + 3.4, z), new THREE.Vector3(61.5, g0 + 3.4, z + 12), 0.55, 0.6));
  // from the chedi's spire down to the compound's fence posts
  const top = new THREE.Vector3(chedi.x, g0 + 19.5, chedi.z);
  for (let k = 0; k < 10; k++) {
    const a = k / 10 * Math.PI * 2 + 0.2;
    const end = new THREE.Vector3(chedi.x + Math.cos(a) * 24, g0 + 2.6, chedi.z + Math.sin(a) * 24);
    string(catenary(top, end, 1.4, 0.75));
  }
  // bulbs (mesh) + wires (lines)
  town.add(S.bulb, null, bulbs.map((p) => mat4(p.x, p.y, p.z, 0, 1)));
  const wg = new THREE.BufferGeometry().setFromPoints(wires);
  const wire = new THREE.LineSegments(wg, new THREE.LineBasicMaterial({ color: 0x000000 }));
  wire.layers.enable(1); town.group.add(wire);
  town.bulbs = bulbs;

  // ---------------- the wider town ----------------
  const box = new THREE.BoxGeometry(1, 1, 1); box.translate(0, 0.5, 0);
  const n = box.getAttribute('position').count, ap = new Float32Array(n * 4);
  for (let i = 0; i < n; i++) { const y = box.getAttribute('position').getY(i); ap[i * 4] = (6 + 0.5) / 16; ap[i * 4 + 1] = 0.55 + 0.45 * y; ap[i * 4 + 2] = 0.5; ap[i * 4 + 3] = 1; }
  box.setAttribute('aPart', new THREE.BufferAttribute(ap, 4));
  const blocks = [], lamps = [];
  for (let bx = -1500; bx < 1300; bx += 46) for (let bz = -1500; bz < 1500; bz += 46) {
    if (Math.abs(bx + 23 - riverX(bz + 23)) < 115) continue;   // the riverside strip (houses, temple) is hand-placed
    if (bx > 40 && bx < 150 && bz > -20 && bz < 110) continue;   // the temple compound
    if (rnd() < 0.3) continue;
    const nb = 1 + Math.floor(rnd() * 3);
    for (let k = 0; k < nb; k++) {
      const far = Math.hypot(bx - temple.x, bz - temple.z);
      // low shophouses near the river; taller blocks only far out (they never rise behind the temple)
      const w = 8 + rnd() * 14, d = 8 + rnd() * 14, h = far < 450 || rnd() < 0.85 ? 4 + rnd() * (far < 450 ? 3.5 : 6) : 10 + rnd() * 16;
      const x = bx + 6 + rnd() * (34 - w), z = bz + 6 + rnd() * (34 - d);
      blocks.push(new THREE.Matrix4().compose(new THREE.Vector3(x + w / 2, heightAt(x + w / 2, z + d / 2) - 0.3, z + d / 2), new THREE.Quaternion(), new THREE.Vector3(w, h, d)));
    }
    if (rnd() < 0.55) lamps.push([bx + 2, heightAt(bx, bz) + 6.5, bz + 2 + rnd() * 40]);
    if (rnd() < 0.3) lamps.push([bx + 2 + rnd() * 40, heightAt(bx, bz) + 6.5, bz + 2]);
  }
  town.add(box, null, blocks, { reflect: false });
  // street lamps: points of light (sodium and LED), energy-conserving footprints like the far lanterns
  const na = blackbody(2000), le = blackbody(4300), unit = (c) => { const L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2]; return [c[0] / L, c[1] / L, c[2] / L]; };
  town.lamps = lightPoints(lamps, lamps.map(() => unit(rnd() < 0.75 ? na : le)), 650, 0, town.cloudU);
  // the festoon bulbs again, as points: a 3 cm bulb is sub-pixel beyond ~40 m, where its mesh would vanish
  const bc = unit(blackbody(2400));
  town.bulbPts = lightPoints(bulbs.map((p) => [p.x, p.y - 0.06, p.z]), bulbs.map(() => bc), 8, 0.03, town.cloudU);
  town.group.add(town.lamps, town.bulbPts);
  // the rest of Chiang Mai: beyond the modelled town, the valley floor's lights out to ~9 km (seen from the climb):
  // roads radiating from the old city, suburbs and villages, a scatter; points only (one draw), their own random stream
  town.farLights = farCity(na, le, unit, town.cloudU);
  town.group.add(town.farLights);

  // ---------------- krathongs: drifting downstream, candles lit ----------------
  // most are launched from the temple steps and from the bank near the start, so they drift in loose clusters
  const NK = 300, kr = [];
  const gauss = () => { let u = 0; for (let i = 0; i < 4; i++) u += rnd(); return (u - 2) / 0.577; };
  for (let i = 0; i < NK; i++) {
    const r = rnd();
    let x, z;
    if (r < 0.35) { x = 50 - Math.abs(gauss()) * 4.5; z = temple.z + 4 + Math.abs(gauss()) * 30 + gauss() * 4; }       // off the temple steps, drifting downstream
    else if (r < 0.7) { x = -49 + Math.abs(gauss()) * 5; z = -10 + gauss() * 35; }                                     // along the start bank
    else { const side = rnd() < 0.5 ? -1 : 1; z = -360 + rnd() * 720; x = side * (40 + rnd() * 11); }
    kr.push({ x, z, v: 0.22 + rnd() * 0.18, yaw: rnd() * 6.28, spin: (rnd() - 0.5) * 0.25, ph: rnd() * 6.28, variant: i & 1 });
  }
  const km = [0, 1].map((v) => { const m = town.add(S[`krathong${v}`], null, kr.filter((k) => k.variant === v).map(() => new THREE.Matrix4()), { chunk: false }); m.instanceMatrix.setUsage(THREE.DynamicDrawUsage); m.frustumCulled = false; return m; });   // they move: no stale bounds
  town.krathongs = { list: kr, meshes: km };

  // ---------------- the crowd is placed once the swarm exists (under its bank lanterns) ----------------
  town.crowdGeos = [0, 1, 2, 3, 4, 5].map((p) => S[`crowd${p}`]);
  town.lampPos = lamps;
  town.extraLights = bulbs.length + NK + lamps.length;
  return town;
}

/** People on the banks: one under every bank lantern (holding it overhead), more along the promenade. */
export function layoutCrowd(town, swarm) {
  const rnd = mulberry32(77);
  const per = [[], [], [], [], [], []], spots = [];
  const ok = (x, z) => !town.keepOut.some(([x0, z0, x1, z1]) => x > x0 && x < x1 && z > z0 && z < z1) && !spots.some(([a, b]) => (a - x) ** 2 + (b - z) ** 2 < 0.36);
  for (let i = 0; i < swarm.nRelease; i++) {
    const x = swarm.pos[i * 3], z = swarm.pos[i * 3 + 2];
    if (Math.abs(x - riverX(z)) < 55) continue;
    const pose = rnd() < 0.85 ? 1 : 5;
    spots.push([x, z]);
    per[pose].push(mat4(x - Math.sign(x) * 0.1, heightAt(x, z), z, (x > 0 ? Math.PI : 0) + (rnd() - 0.5) * 0.8, 1));
  }
  // onlookers on the far (east) bank promenade
  for (let k = 0; k < 520; k++) {
    const z = -200 + rnd() * 420, x = riverX(z) + 61.5 + rnd() * 5;
    if (!ok(x, z)) continue;
    spots.push([x, z]);
    const r = rnd(), pose = r < 0.4 ? 0 : r < 0.6 ? 2 : r < 0.75 ? 3 : r < 0.92 ? 4 : 5;
    per[pose].push(mat4(x, heightAt(x, z), z, Math.PI + (rnd() - 0.5) * 1.2, 1));
  }
  per.forEach((list, p) => list.length && (town.add(town.crowdGeos[p], null, list).userData.kind = 'crowd'));
  return spots.length;
}

/** Per frame: krathongs drift with the current; their candles and the bulbs feed the light volume. */
export function updateTown(town, t, swarm, camera, heightPx, dpr) {
  const K = town.krathongs, M = new THREE.Matrix4(), Q = new THREE.Quaternion(), P = new THREE.Vector3(), Sc = new THREE.Vector3(1, 1, 1), up = new THREE.Vector3(0, 1, 0);
  const counts = [0, 0];
  const ld = swarm.lightData, base = swarm.N * 4;
  K.list.forEach((k, i) => {
    let z = k.z + k.v * t; z = ((z + 360) % 720 + 720) % 720 - 360;
    const y = -0.025 + 0.012 * Math.sin(t * 1.3 + k.ph);
    Q.setFromAxisAngle(up, k.yaw + k.spin * t); P.set(riverX(z) + k.x + 0.6 * Math.sin(t * 0.05 + k.ph), y, z); M.compose(P, Q, Sc);
    const m = K.meshes[k.variant]; M.toArray(m.instanceMatrix.array, counts[k.variant]++ * 16);
    const o = base + (town.bulbs.length + i) * 4;
    ld[o] = P.x; ld[o + 1] = y + 0.18; ld[o + 2] = P.z; ld[o + 3] = 1.0;    // a candle: ~1 cd
  });
  for (const m of K.meshes) m.instanceMatrix.needsUpdate = true;
  if (!town._bulbsWritten) {
    town.bulbs.forEach((p, i) => { const o = base + i * 4; ld[o] = p.x; ld[o + 1] = p.y - 0.06; ld[o + 2] = p.z; ld[o + 3] = 8.0; });   // a 10 W festoon bulb: ~8 cd
    // street lamps: most of a lamp's light is thrown down onto the street (the volume treats it as isotropic)
    const lb = base + (town.bulbs.length + K.list.length) * 4;
    town.lampPos.forEach((q, i) => { const o = lb + i * 4; ld[o] = q[0]; ld[o + 1] = q[1]; ld[o + 2] = q[2]; ld[o + 3] = 600; });
    town._bulbsWritten = true;
  }
  for (const pts of [town.lamps, town.bulbPts, town.farLights]) { const u = pts.material.uniforms; u.uPxPerRad.value = heightPx / (camera.fov * DEG); u.uDpr.value = dpr; }
}
