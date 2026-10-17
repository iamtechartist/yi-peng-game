// The swarm: ~3,000 khom loi.
//   RELEASE cohort (~1,400): floating on and around the river at the player's start, all lifting off at t = 0.
//   STREAM cohort (~1,600): released over the festival's last 15 minutes from a handful of sites (the banks,
//     Wat Phan Tao, upstream and downstream), already aloft: carried by the wind they form long, curved, thinning
//     ribbons toward the moon (NOTES §6), the oldest burning out and fading at the far ends. Burnt-out ones are
//     reborn at their site, so the streams keep flowing.
//   HIGH FLYERS (~400): the strongest burners, released over the last 19 minutes 2.4 km upwind (west of the old
//     city) and climbing 2.2–3 m/s: a wide ribbon that crosses the run's climb column in the cloud layer (1.45–2 km)
//     and rises on above the tops toward the moon, thinning into points.
//   RIDERS (~640): lanterns caught by the run's thermal (course.js), fed in at its foot ~2.5 a second all evening:
//     they spiral up the column (kinematic in its frame: height, radius, angle), slow and bunch in the shear gaps,
//     leave its top above the cloud and drift on toward the moon. They mark the way up.
//   The release lanterns near the thermal's foot are drawn into it after lift-off and climb the same way.
// Motion: each lantern rises at its own 0.5–2 m/s (slowing as its fuel runs down, sinking once it goes out),
// follows the wind with a lag, and sways and tilts gently on its own phase.
// Drawn in four LODs by projected size: the hero mesh for the nearest few, the 752-tri mesh, a ~150-tri mesh,
// then energy-conserving points. Every lantern also feeds the light volume and the 8-nearest point lights.
import * as THREE from 'three';
import { Noise, mulberry32, smoothstep, clamp, DEG } from './util.js';
import { flicker } from './lantern.js';
import { heightAt, riverX } from './terrain.js';
import { COURSE, colCenter, core, lift } from './course.js';

const NZ = new Noise(73);
const W = new THREE.Vector3();

/** Wind (m/s) at x, y, z, time t. Sheltered over the river, freer aloft; ESE toward the moon low down, veering
 *  toward E–ENE with height (the streams bend into S-curves); meanders from the curl of a slow noise potential. */
export function wind(x, y, z, t, out) {
  const h = Math.max(y, 0);
  const sp = 0.6 + 2.2 * smoothstep(0, 260, h) + 1.8 * smoothstep(250, 1300, h);
  const az = (-24 + 14 * smoothstep(60, 1000, h)) * DEG;    // veers through the moon's bearing (−16°) with height
  const s = 1 / 340, e = 6, k = h * 0.0008 + t * 0.0004;     // a field steady over minutes: a stream holds its path
  const pot = (a, b) => NZ.n2(a * s + k, b * s - k * 0.7);
  const dpx = (pot(x + e, z) - pot(x - e, z)) / (2 * e), dpz = (pot(x, z + e) - pot(x, z - e)) / (2 * e);
  const amp = 0.5 / s * (0.6 + 0.4 * smoothstep(0, 400, h));
  out.x = sp * Math.cos(az) + dpz * amp;
  out.z = -sp * Math.sin(az) - dpx * amp;
  out.y = 0;
  return out;
}

// release sites of the earlier lanterns (x, z): the west bank by the start, the east bank downstream, the old
// city's Wat Phan Tao, upstream, and a far downstream quarter
const SITES = [[-62, -150], [70, 190], [-260, 40], [-20, -520], [-120, 460]];
// the high flyers' site: found by integrating the wind so that the stream crosses 1.7 km over the start (−14, 6)
const HIGH = 9, HIGH_SITE = [-2428, -520], HIGH_AGE = 1150;
const RIDER = 10, RIDER_CYCLE = 256, GAME = 11;   // riders: one is fed in every RIDER_CYCLE / nRiders s
const TOP = COURSE.segs[COURSE.segs.length - 1].y1;
const CC = [0, 0], CW = [0, 0];

export class Swarm {
  constructor(kit, { release = 1400, streams = 1600, high = 400, riders = 900, targets = 720, start = new THREE.Vector3(-14, 0, 6), seed = 7, keepOut = [], extraLights = 0 } = {}) {
    this.keepOut = keepOut; this.extraLights = extraLights;
    this.kit = kit;
    const N = this.N = release + streams + high + riders + targets;
    this.nRelease = release; this.nHigh = high; this.nRiders = riders; this.nTargets = targets;
    this.iHigh = release + streams; this.iRiders = release + streams + high; this.iTargets = this.iRiders + riders;
    this.noHit = new Uint8Array(N);   // the game's own lanterns you can't collide with (your followers)
    // the column (thermal) state: 0 free, 1 riding the column (height, radius as a fraction of R, angle), 2 out of its top
    this.mode = new Uint8Array(N); this.cH = new Float32Array(N); this.cR = new Float32Array(N); this.cRt = new Float32Array(N); this.cTh = new Float32Array(N); this.cB = new Float32Array(N);
    this.relT = 0;                  // when the release cohort lifts off (the game holds it until you let go)
    this.relB = new Float32Array(release);
    this.player = -1;               // the slot the game drives (its light still counts; drawn by the hero group)
    this.pos = new Float32Array(N * 3); this.vel = new Float32Array(N * 3);
    this.birth = new Float32Array(N); this.rise = new Float32Array(N); this.burn = new Float32Array(N);
    this.bright = new Float32Array(N); this.phase = new Float32Array(N); this.yaw = new Float32Array(N);
    this.spin = new Float32Array(N); this.site = new Int8Array(N); this.flame = new Float32Array(N);
    this.wc = new Float32Array(N * 2);            // cached wind (x, z), refreshed in rotation
    this.scl = new Float32Array(N); this.tx = new Float32Array(N); this.tz = new Float32Array(N);   // size, resting tilt
    this.frameNo = 0;
    this.seed = seed; this.start = start.clone();
    this.reset();
    this.allocDraw();
  }

  /** (Re)build the deterministic initial state: the release cohort floating, the streams pre-simulated to t = 0. */
  reset() {
    const N = this.N, release = this.nRelease, start = this.start;
    this.rnd = mulberry32(this.seed);
    this.time = 0;
    this.vel.fill(0); this.flame.fill(1);
    const r = this.rnd;
    const gauss = () => { let u = 0; for (let i = 0; i < 4; i++) u += r(); return (u - 2) / 0.577; };
    for (let i = 0; i < N; i++) {
      this.rise[i] = 0.5 + 1.5 * Math.pow(r(), 1.3);
      this.burn[i] = 420 + r() * 480;
      // no two alike: ±12 % size, a resting tilt of 3–11° (uneven paper, the fuel cell hanging off-centre)
      this.scl[i] = 0.88 + 0.24 * r();
      const ta = 0.05 + 0.14 * r(), tdir = r() * 6.283; this.tx[i] = ta * Math.cos(tdir); this.tz[i] = ta * Math.sin(tdir);
      this.bright[i] = 0.6 + 0.8 * r();
      this.phase[i] = r() * 100; this.yaw[i] = r() * 6.283; this.spin[i] = (r() - 0.5) * 0.25;
    }
    // release cohort: on the water around the start (denser near it), a quarter on the banks
    for (let i = 0; i < release; i++) {
      let x, z;
      let onWater = true;
      if (r() < 0.76) { z = start.z + gauss() * 75; x = riverX(z) + clamp(start.x + gauss() * 20 + (r() - 0.5) * 30, -47, 47); }
      else {
        onWater = false;
        const side = r() < 0.5 ? -1 : 1; z = start.z + gauss() * 90; x = riverX(z) + side * (64 + r() * 60);
        // not inside a building: step out onto the riverside promenade in front of it
        if (this.keepOut.some(([x0, z0, x1, z1]) => x > x0 - 1.5 && x < x1 + 1.5 && z > z0 - 1.5 && z < z1 + 1.5)) x = riverX(z) + side * (62.5 + r() * 3);
      }
      this.pos[i * 3] = x; this.pos[i * 3 + 1] = onWater ? 0.35 + r() * 0.5 : heightAt(x, z) + 1.9 + r() * 0.15; this.pos[i * 3 + 2] = z;   // on the bank: held up overhead
      this.relB[i] = r() * 1.6;                  // all at once (within a breath)
      this.birth[i] = this.relT + this.relB[i];
      this.site[i] = -1;
    }
    // stream cohort: born over the last 15 minutes at the sites, pre-simulated to now
    const n1 = this.iHigh, n2 = this.iRiders;
    for (let i = release; i < n1; i++) { this.site[i] = Math.floor(r() * SITES.length); this.birth[i] = -r() * 900; this.rise[i] = 1.0 + 0.35 * r(); this.spawnAtSite(i, this.birth[i]); }
    for (let i = n1; i < n2; i++) { this.site[i] = HIGH; this.birth[i] = -r() * HIGH_AGE; this.rise[i] = 2.2 + 0.8 * r(); this.burn[i] = 1500 + 500 * r(); this.spawnAtSite(i, this.birth[i]); }
    // riders: their own random stream (the cohorts above keep the layout already signed off)
    this.rndR = mulberry32(this.seed + 101);
    this.mode.fill(0);
    const n3 = this.iTargets;
    for (let i = n2; i < n3; i++) { this.site[i] = RIDER; this.rise[i] = 2.0 + this.rndR(); this.burn[i] = 1e6; this.spawnRider(i, -((i - n2 + this.rndR()) / this.nRiders) * RIDER_CYCLE); }
    // the game's lanterns (the dying ones on the course, your followers): placed and lit by the game; parked out of sight
    for (let i = n3; i < N; i++) { this.site[i] = GAME; this.pos[i * 3 + 1] = -5000; this.flame[i] = 0; this.birth[i] = -1; this.burn[i] = 1e6; }
    this.presimulate();
    // the release cohort as it waits on the water (a retry puts it back)
    const o0 = 0, o1 = release * 3;
    this.rel0 = { pos: this.pos.slice(o0, o1), yaw: this.yaw.slice(0, release) };
  }

  /** A rider fed into the thermal's foot at time t: low over the water, somewhere across the column. */
  spawnRider(i, t) {
    const r = this.rndR, R = COURSE.segs[0].R;
    this.mode[i] = 1; this.cH[i] = 2 + 3 * r();
    this.cR[i] = Math.min(1.25, 0.03 + Math.abs(r() + r() + r() - 1.5) * 0.75); this.cRt[i] = this.cR[i];
    this.cTh[i] = r() * 6.283; this.cB[i] = 2.0 + 2.0 * r();
    this.birth[i] = t; this.flame[i] = 1;
    colCenter(this.cH[i], CC);
    const o = i * 3, rr = this.cR[i] * R;
    this.pos[o] = CC[0] + rr * Math.cos(this.cTh[i]); this.pos[o + 1] = this.cH[i]; this.pos[o + 2] = CC[1] + rr * Math.sin(this.cTh[i]);
    this.vel[o] = this.vel[o + 1] = this.vel[o + 2] = 0;
  }

  /** Lift-off for the release cohort at time t (the game: when you let go). */
  release(t) { this.relT = t; for (let i = 0; i < this.nRelease; i++) this.birth[i] = t + this.relB[i]; }
  /** Put the release cohort back on the water, waiting (a retry). */
  restoreRelease() {
    const n = this.nRelease;
    this.pos.set(this.rel0.pos, 0); this.yaw.set(this.rel0.yaw, 0);
    this.vel.fill(0, 0, n * 3); this.mode.fill(0, 0, n); this.flame.fill(1, 0, n);
    this.relT = 1e9; for (let i = 0; i < n; i++) this.birth[i] = 1e9;
  }

  /** Jump to time t (re-simulates from the start when going back). */
  seek(t) {
    if (t < this.time) this.reset();
    while (this.time < t) { const h = Math.min(0.1, t - this.time); const tt = this.time + h; for (let i = 0; i < this.N; i++) this.stepOne(i, tt, h, (i + this.frameNo++) % 4 === 0); this.time = tt; }
  }

  spawnAtSite(i, t) {
    if (this.site[i] === RIDER) { this.spawnRider(i, t); return; }
    const r = this.rnd, hi = this.site[i] === HIGH, s = hi ? HIGH_SITE : SITES[this.site[i]], sp = hi ? 160 : 12;
    this.pos[i * 3] = s[0] + (r() - 0.5) * sp; this.pos[i * 3 + 1] = 3 + r() * 3; this.pos[i * 3 + 2] = s[1] + (r() - 0.5) * sp;
    this.vel[i * 3] = 0; this.vel[i * 3 + 1] = 0; this.vel[i * 3 + 2] = 0;
    this.birth[i] = t;
  }

  /** Integrate the stream cohort from each lantern's birth up to t = 0 (1 s steps). */
  presimulate() {
    const n0 = this.nRelease, N = this.iRiders;
    for (let t = -HIGH_AGE; t < 0; t += 1) for (let i = n0; i < N; i++) if (this.birth[i] <= t) this.stepOne(i, t, 1, true);
    for (let t = -RIDER_CYCLE; t < 0; t += 0.5) for (let i = N; i < this.iTargets; i++) if (this.birth[i] <= t) this.stepOne(i, t, 0.5, true);
  }

  stepOne(i, t, dt, refresh) {
    if (i === this.player || i >= this.iTargets) return;
    const age = t - this.birth[i], P = this.pos, V = this.vel, o = i * 3;
    if (age < 0) { this.flame[i] = 1; return; }
    if (this.mode[i] === 1) {          // riding the thermal: up the column on its own radius, swirling slowly
      core(this.cH[i], CW); const R = CW[1], rr = this.cR[i] * R;
      const w = (CW[0] * lift(rr, R) + this.cB[i]) * smoothstep(0, 2.5, age);   // (lifting off: ease into the climb)
      this.cH[i] += w * dt;
      this.cR[i] += (this.cRt[i] - this.cR[i]) * (1 - Math.exp(-dt / 9));    // the thermal draws in what it caught
      this.cTh[i] += 0.9 / Math.sqrt(Math.max(rr, 4)) * dt;
      colCenter(this.cH[i], CC);
      // (the game keeps its play plane clear: the helix is shifted beyond it, rr + m along n, so no rider ever crosses
      // the plane or passes between it and the camera; a whole shift, so nothing jumps)
      const hs = this.helixShift, sh = hs ? rr + hs.m : 0;
      const nx = CC[0] + rr * Math.cos(this.cTh[i]) + (hs ? hs.x * sh : 0), nz = CC[1] + rr * Math.sin(this.cTh[i]) + (hs ? hs.z * sh : 0);
      V[o] = (nx - P[o]) / dt; V[o + 1] = w; V[o + 2] = (nz - P[o + 2]) / dt;
      P[o] = nx; P[o + 1] = this.cH[i]; P[o + 2] = nz;
      this.yaw[i] += this.spin[i] * dt;
      if (this.cH[i] > TOP + 15) { this.mode[i] = 2; this.wc[i * 2] = V[o]; this.wc[i * 2 + 1] = V[o + 2]; }
      return;
    }
    // the release lanterns at the thermal's foot are drawn into it once they are up off the water
    if (i < this.nRelease && !this.noCapture && this.mode[i] === 0 && age > 0.4 && P[o + 1] < 300) {
      colCenter(P[o + 1], CC); core(P[o + 1], CW);
      const dx = P[o] - CC[0], dz = P[o + 2] - CC[1], r = Math.hypot(dx, dz);
      if (r < 1.35 * CW[1]) { this.mode[i] = 1; this.cH[i] = P[o + 1]; this.cR[i] = Math.max(0.04, r / CW[1]); this.cTh[i] = Math.atan2(dz, dx); this.cB[i] = 2.0 + 2.0 * ((this.phase[i] * 7.31) % 1); this.cRt[i] = 0.1 + 0.6 * ((this.phase[i] * 3.71) % 1); return; }
    }
    if (this.site[i] === RIDER && (P[o + 1] > 2800 || age > RIDER_CYCLE + 40)) { this.spawnRider(i, t); return; }
    const fuel = 1 - age / this.burn[i];
    const lit = fuel > 0;
    this.flame[i] = lit ? Math.min(1, 0.3 + 0.7 * smoothstep(0, 0.25, fuel)) : Math.max(0, this.flame[i] - dt * 0.5);
    const boost = i < this.nRelease ? this.riseBoost || 1 : 1;   // (the game lifts the release faster: a 30-second run)
    const target = lit ? boost * this.rise[i] * (0.4 + 0.6 * smoothstep(0, 0.35, fuel)) * Math.min(1, age / (i < this.nRelease && this.riseRamp || 4)) : -0.7;
    V[o + 1] += (target - V[o + 1]) * (1 - Math.exp(-dt / (i < this.nRelease && this.riseTau || 1.6)));
    // the wind is smooth over metres and seconds: each lantern re-samples it in rotation, not every frame
    if (refresh || age < dt * 2) { wind(P[o], P[o + 1], P[o + 2], t, W); this.wc[i * 2] = W.x; this.wc[i * 2 + 1] = W.z; }
    const g = (1 - Math.exp(-dt / 2.5)) * Math.min(1, age / 3);
    V[o] += (this.wc[i * 2] - V[o]) * g; V[o + 2] += (this.wc[i * 2 + 1] - V[o + 2]) * g;
    P[o] += V[o] * dt; P[o + 1] += V[o + 1] * dt; P[o + 2] += V[o + 2] * dt;
    if (P[o + 1] < 0.3) { P[o + 1] = 0.3; V[o + 1] = Math.max(V[o + 1], 0); }
    this.yaw[i] += this.spin[i] * dt;
    // a burnt-out stream lantern that has sunk away is reborn at its site
    if (this.site[i] >= 0 && !lit && (P[o + 1] < 20 || age > this.burn[i] + 90)) this.spawnAtSite(i, t);
  }

  /** Advance the whole swarm to time t (the release is at t = 0; before it the lanterns float, lit). */
  update(t) {
    let dt = t - this.time;
    if (dt < 0 || dt > 2) { dt = 0; }
    // fixed 1/60 s steps whatever the frame rate: a run replays exactly from its inputs (the swarm is what you hit)
    const steps = dt > 0 ? Math.max(1, Math.round(dt * 60)) : 0;
    for (let k = 0; k < steps; k++) { const h = dt / steps, tt = this.time + h * (k + 1), f = this.frameNo++; for (let i = 0; i < this.N; i++) this.stepOne(i, tt, h, (i + f) % 8 === 0); }
    this.time = t;
  }

  allocDraw() {
    const kit = this.kit, N = this.N;
    const mk = (geo, mat, cap, withFlame) => {
      const inst = new THREE.InstancedBufferAttribute(new Float32Array(cap * 4), 4); inst.setUsage(THREE.DynamicDrawUsage);
      geo.setAttribute('aInst', inst);
      const m = new THREE.InstancedMesh(geo, mat, cap); m.instanceMatrix.setUsage(THREE.DynamicDrawUsage);
      m.frustumCulled = false; m.layers.enable(1); m.count = 0;
      return { mesh: m, inst, cap, n: 0 };
    };
    this.lod0 = mk(kit.lod0.clone(), kit.paperMaterial(1), 3);
    this.lod1 = mk(kit.lod1.clone(), kit.paperMaterial(1), 700);
    this.lod2 = mk(kit.miniGeometry(), kit.paperMaterial(0), N);
    this.lodN = mk(kit.lod1.clone(), kit.paperMaterial(1, true), 24);   // close to the lens: faded, not cut
    this.lodN.mesh.renderOrder = 4;
    this.flames = mk(kit.flameGeometry(), kit.flameMaterial(), 703);
    this.flames.mesh.renderOrder = 10;
    this.flames.mesh.layers.set(3); this.flames.mesh.layers.enable(1);   // drawn after the clouds
    // points
    const pg = new THREE.BufferGeometry();
    this.ptPos = new Float32Array(N * 3); this.ptFlux = new Float32Array(N);
    pg.setAttribute('position', new THREE.BufferAttribute(this.ptPos, 3).setUsage(THREE.DynamicDrawUsage));
    pg.setAttribute('aFlux', new THREE.BufferAttribute(this.ptFlux, 1).setUsage(THREE.DynamicDrawUsage));
    pg.setDrawRange(0, 0);
    this.points = new THREE.Points(pg, kit.pointMaterial());
    this.points.frustumCulled = false; this.points.layers.set(3); this.points.layers.enable(1); this.points.renderOrder = 5;
    this.group = new THREE.Group();
    this.group.add(this.lod0.mesh, this.lod1.mesh, this.lod2.mesh, this.lodN.mesh, this.flames.mesh, this.points);
    // light data for the light volume: xyz + intensity (cd), 64 wide
    this.lightW = 64; this.lightH = Math.ceil((N + this.extraLights) / 64);   // lanterns, then other lights (bulbs, candles)
    this.lightData = new Float32Array(this.lightW * this.lightH * 4);
    this.lightTex = new THREE.DataTexture(this.lightData, this.lightW, this.lightH, THREE.RGBAFormat, THREE.FloatType);
    this.lightTex.minFilter = this.lightTex.magFilter = THREE.NearestFilter;
    this.near = [];     // the 8 nearest lit lanterns: [x, y, z, I]
    this._m = new THREE.Matrix4(); this._q = new THREE.Quaternion(); this._e = new THREE.Euler(0, 0, 0, 'YXZ'); this._s = new THREE.Vector3(1, 1, 1); this._p = new THREE.Vector3();
    this._fwd = new THREE.Vector3();
  }

  /** Per frame: sway, LOD buckets, flames, points, light data, nearest lights. */
  prepare(camera, heightPx, dpr, t) {
    const P = this.pos, N = this.N, kit = this.kit;
    const cp = camera.position, fwd = this._fwd.set(0, 0, -1).applyQuaternion(camera.quaternion);
    const pxPerRad = heightPx / (camera.fov * DEG);
    const I0 = kit.uniforms.uPaperK.value.x * 0.5;            // the lantern as a whole: ~half its flame's intensity escapes
    const b0 = this.lod0, b1 = this.lod1, b2 = this.lod2, bf = this.flames, bn = this.lodN;
    b0.n = b1.n = b2.n = bf.n = bn.n = 0;
    const fadeEnd = this.nearFadeEnd ?? 0;
    let np = 0;
    const nd = this._nd || (this._nd = new Float64Array(8)), ni = this._ni || (this._ni = new Int32Array(8)); let nn = 0;
    const M = this._m, Q = this._q, E = this._e, S = this._s, pp = this._p;
    const ld = this.lightData;
    for (let i = 0; i < N; i++) {
      const o = i * 3, age = t - this.birth[i], ph = this.phase[i];
      const sw = Math.min(1, Math.max(age, 0) / 3);
      const x = P[o] + 0.22 * Math.sin(t * 1.7 + ph) * sw, y = P[o + 1], z = P[o + 2] + 0.22 * Math.cos(t * 1.37 + ph * 1.3) * sw;
      const fl = this.flame[i];
      const I = I0 * this.bright[i] * fl * flicker(t, ph);
      ld[i * 4] = x; ld[i * 4 + 1] = y + 0.3; ld[i * 4 + 2] = z; ld[i * 4 + 3] = I;
      const dx = x - cp.x, dy = y + 0.5 - cp.y, dz = z - cp.z, d2 = dx * dx + dy * dy + dz * dz, d = Math.sqrt(d2);
      if (fl > 0.02 && (nn < 8 || d2 < nd[nn - 1])) {
        let k = nn < 8 ? nn++ : 7;
        while (k > 0 && nd[k - 1] > d2) { nd[k] = nd[k - 1]; ni[k] = ni[k - 1]; k--; }
        nd[k] = d2; ni[k] = i;
      }
      if (i === this.player) continue;                          // drawn by the hero group
      if (d < (this.nearCull ?? 0.9)) continue;                 // never through the lens (the game widens it in its set pieces)
      // behind the camera (with margin, for the water's reflection of what is above the frame)
      if ((dx * fwd.x + dy * fwd.y + dz * fwd.z) < -2.0) continue;
      const px = pxPerRad / Math.max(d, 0.1);                  // ≈ projected height of the 1 m lantern
      if (px < (this.pointPx ?? 2.2)) { if (fl > 0.01) { this.ptPos[np * 3] = x; this.ptPos[np * 3 + 1] = y + 0.45; this.ptPos[np * 3 + 2] = z; this.ptFlux[np] = 22 * this.bright[i] * fl * flicker(t, ph); np++; } continue; }
      const b = (d < fadeEnd && bn.n < bn.cap) ? bn : (px > 260 && b0.n < b0.cap) ? b0 : px > (this.lod1Px ?? 30) && b1.n < b1.cap ? b1 : b2;
      E.set(this.tx[i] * sw + 0.06 * Math.sin(t * 1.1 + ph) * sw, this.yaw[i], this.tz[i] * sw + 0.06 * Math.cos(t * 0.93 + ph * 0.7) * sw);
      Q.setFromEuler(E); pp.set(x, y, z); S.setScalar(this.scl[i]); M.compose(pp, Q, S);
      M.toArray(b.mesh.instanceMatrix.array, b.n * 16);
      const ia = b.inst.array; ia[b.n * 4] = ph; ia[b.n * 4 + 1] = fl; ia[b.n * 4 + 2] = this.bright[i]; ia[b.n * 4 + 3] = (ph * 0.37) % 1;
      b.n++;
      if (b !== b2 && bf.n < bf.cap) {
        M.toArray(bf.mesh.instanceMatrix.array, bf.n * 16);
        const fa = bf.inst.array; fa[bf.n * 4] = ph; fa[bf.n * 4 + 1] = fl; fa[bf.n * 4 + 2] = this.bright[i]; fa[bf.n * 4 + 3] = 0;
        bf.n++;
      }
    }
    for (const b of [b0, b1, b2, bn, bf]) { b.mesh.count = b.n; b.mesh.instanceMatrix.needsUpdate = true; b.inst.needsUpdate = true; b.mesh.instanceMatrix.clearUpdateRanges(); b.inst.clearUpdateRanges(); b.mesh.instanceMatrix.addUpdateRange(0, b.n * 16); b.inst.addUpdateRange(0, b.n * 4); }
    const pg = this.points.geometry;
    pg.setDrawRange(0, np); pg.attributes.position.needsUpdate = true; pg.attributes.aFlux.needsUpdate = true;
    pg.attributes.position.clearUpdateRanges(); pg.attributes.position.addUpdateRange(0, np * 3);
    pg.attributes.aFlux.clearUpdateRanges(); pg.attributes.aFlux.addUpdateRange(0, np);
    const pu = this.points.material.uniforms; pu.uPxPerRad.value = pxPerRad; pu.uDpr.value = dpr;
    this.lightTex.needsUpdate = true;
    // the 8 nearest lit lanterns (partial selection)
    this.near.length = 0;
    for (let k = 0; k < nn; k++) { const i = ni[k]; this.near.push([ld[i * 4], ld[i * 4 + 1], ld[i * 4 + 2], ld[i * 4 + 3]]); }
    this.counts = { lod0: b0.n, lod1: b1.n, lod2: b2.n, near: bn.n, points: np, flames: bf.n };
  }
}
