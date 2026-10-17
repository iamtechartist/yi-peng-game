// THE RUN: thirty seconds, one lantern — yours, the crimson one — from the river up through the swarm and the cloud
// into the moonlight. Six beats, each a different danger (course.js BEATS); touch any lantern and you crash back to
// the start of the beat (+2 s). Near misses (passing a lantern closer than 1.6 m without touching) take time off.
//   STEER: WASD / arrows (relative to the view) or hold the mouse and steer toward the cursor.
//   SPACE: stoke the flame (climb faster; drains the flame meter, which refills on its own). SHIFT: ease off.
// The camera follows loosely (your lantern swings across the frame as you steer) from below and behind, looking up
// the climb: what comes down at you is what you play.
// Every run is deterministic in its inputs (fixed steps): the key log replays exactly (this.replay).
import * as THREE from 'three';
import { COURSE, colCenter, colTopAt } from './course.js';
import { BEATS, LANE, Course, beatSpeed, beatAt, gustAt } from './beats.js';
import { CLOUD, cloudWind } from './clouds.js';
import { wind } from './swarm.js';
import { clamp, smoothstep, lerp } from './util.js';

export const TUNE = {
  climb: 34, stoke: 14, ease: 14, minVy: 8, vyTau: 0.25,
  steer: 13, steerTau: 0.08, lane: 24,   // (played at human latency: at 17 m/s a release 0.1 s late was 1.7 m off, past a gap's
  // margin; with a 0.15 s lag the lantern slid on 1.1 m after I let go, into the next one)
  drain: 0.45, refill: 0.12,
  body: 0.62, bodyH: 0.95, near: 1.6, nearBonus: 0.25, crashPenalty: 2,
  crashT: 1.1, ghostT: 0.8, slow: 0.25,
};
export { BEATS };
const BEST_KEY = 'lanternNight.run.best';
const STEP = 1 / 60;                    // the run's fixed step (s)
const CC = [0, 0];
const W = new THREE.Vector3(), TIP = new THREE.Vector3(), UP = new THREE.Vector3(0, 1, 0);
const QT = new THREE.Quaternion(), QY = new THREE.Quaternion();
const WARN = new THREE.Vector3(1.0, 0.14, 0.06);
const ease = (x) => x * x * (3 - 2 * x);
const KEYS = ['KeyA', 'KeyD', 'KeyW', 'KeyS', 'ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Space', 'ShiftLeft', 'ShiftRight'];

export class Game {
  constructor(app) {
    this.app = app;
    const S = app.swarm, st = COURSE.start;
    // your lantern: the release lantern floating nearest the column's foot (its light stays in the swarm's data)
    let best = -1, bd = 1e9;
    for (let i = 0; i < S.nRelease; i++) { const dx = S.pos[i * 3] - st[0], dz = S.pos[i * 3 + 2] - st[1], d = dx * dx + dz * dz; if (S.pos[i * 3 + 1] < 1.5 && d < bd) { bd = d; best = i; } }
    this.slot = best; S.player = best; S.bright[best] = 1.15;
    S.riseBoost = 8; S.riseRamp = 1.0; S.riseTau = 0.6; S.noCapture = true;   // the release lifts with you (playing it: at ×3 over 4 s it was
    // still on the water while you climbed away; only a respawn showed the crush); no lantern is drawn into the old column
    this.course = new Course(); this.cpos = {};
    this.home = new THREE.Vector3(S.pos[best * 3], S.pos[best * 3 + 1], S.pos[best * 3 + 2]);
    const md = app.sky.moonDir; this.yaw0 = Math.atan2(md.z, md.x);
    S.helixShift = { x: Math.cos(this.yaw0), z: Math.sin(this.yaw0), m: 9 };   // the column's riders climb beyond your plane
    this.clearOpening();
    this.p = new THREE.Vector3(); this.v = new THREE.Vector3();
    this.keys = new Set(); this.mouse = { down: false, x: 0, y: 0 };
    this.cam = { pos: new THREE.Vector3(), look: new THREE.Vector3(), anchor: new THREE.Vector3(), yaw: this.yaw0, shake: 0 };
    this.prevDy = new Float32Array(S.N).fill(1e9);
    this.best = this.loadBest();
    this.on = {};
    this.mouseSteer = true; this.shake = true; this.lastInput = 0;
    this.targets = []; this.total = 0; this.relit = 0; this.streak = 0; this.points = 0;   // (HUD compatibility)
    this.marker = makeMarker(); this.aim = makeAim();
    app.scene.add(this.marker, this.aim);
    this.bindInput();
    this.reset();
  }

  /** The opening frame belongs to your lantern: floating lanterns between the lens and it, or crowding it, drift aside. */
  clearOpening() {
    const S = this.app.swarm, cam = new THREE.Vector3(), look = new THREE.Vector3();
    this.readyPose(cam, look);
    const a = new THREE.Vector3(cam.x, 0, cam.z), b = new THREE.Vector3(this.home.x, 0, this.home.z), ab = b.clone().sub(a), L = ab.length(); ab.normalize();
    const n = new THREE.Vector3(-ab.z, 0, ab.x);
    for (let i = 0; i < S.nRelease; i++) {
      if (i === this.slot) continue;
      const o = i * 3, q = new THREE.Vector3(S.pos[o], 0, S.pos[o + 2]).sub(a);
      const along = q.dot(ab), side = q.dot(n);
      const nearLine = along > -2 && along < L + 2.5 && Math.abs(side) < 2.4;
      const nearHero = Math.hypot(S.pos[o] - this.home.x, S.pos[o + 2] - this.home.z) < 2.6;
      if (!nearLine && !nearHero) continue;
      const push = (side >= 0 ? 1 : -1) * (3.2 - Math.abs(side)) + (side >= 0 ? 1.2 : -1.2);
      S.pos[o] += n.x * push; S.pos[o + 2] += n.z * push;
      S.rel0.pos[o] = S.pos[o]; S.rel0.pos[o + 2] = S.pos[o + 2];
    }
  }

  /* ---------------- state ---------------- */
  reset() {
    const A = this.app, S = A.swarm;
    S.restoreRelease(); A.cloudTime = 0; this.course && this.course.resetAim();                // (behind the retry fade: the clouds back where every run starts)
    this.state = 'ready'; this.t = 0; this.clock = 0; this.penalty = 0; this.beat = 0; this.beatReached = 0;
    this.meter = 1; this.stokeOn = false; this.easeOn = false; this.ghost = 0; this.crashT = 0; this.fading = false;
    this.crashes = 0; this.nears = 0; this.result = null; this.breakT = 0; this.timeScale = 1;
    this.p.copy(this.home); this.v.set(0, 0, 0); this.steer = new THREE.Vector2(); this.x = 0; this.vx = 0;
    this.tilt = new THREE.Vector2(); this.spin = 0; this.yawL = 0.4; this.ev = 4;
    this.cam.yaw = this.yaw0; this.prevDy.fill(1e9);
    this.log = []; this.replayAt = 0; this.practice = false; this.acc = 0; this.warnK = 0;
    this.readyPose(this.cam.pos, this.cam.look);
    this.cam.anchor.copy(this.home);
    this.placeCourse();
    this.writeSlot();
  }
  emit(k, ...a) { const f = this.on[k]; if (f) try { f(...a); } catch (e) { console.error(e); } }

  readyPose(pos, look) {
    const md = this.app.sky.moonDir, fx = md.x, fz = md.z, n = Math.hypot(fx, fz);
    const f = new THREE.Vector3(fx / n, 0, fz / n), r = new THREE.Vector3(-f.z, 0, f.x);
    pos.copy(this.home).addScaledVector(f, -5.2).addScaledVector(r, -1.1); pos.y = 1.25;
    look.copy(this.home).addScaledVector(f, 30); look.y = 3.2;
  }

  release() {
    const A = this.app;
    A.swarm.release(A.swT + 0.15); A.cloudTime = 0;
    this.p.copy(this.home);                      // (not wherever the title's idle bob left it: every run starts alike)
    this.state = 'release'; this.t = 0; this.clock = 0; this.replayAt = 0;
    this.camFrom = { pos: this.cam.pos.clone(), look: this.cam.look.clone() };
    this.log = [];
    this.emit('release');
  }

  /** The score: the clock + crash penalties − near-miss bonuses. */
  get time() { return Math.max(0, this.clock + this.penalty - this.nears * TUNE.nearBonus); }

  /* ---------------- per frame ---------------- */
  /** The run steps on a fixed 1/60 s clock whatever the display does, so it plays the same on every machine and a key
   *  log replays exactly live (playing it in Chrome: on real frame times my run drifted off its inputs within 5 s).
   *  rAF jitter round 60 Hz is snapped to one step; at 120 Hz every other frame steps (60 fps motion, evenly paced). */
  update(dt) {
    if (dt <= 0) return this.tick(0);
    if (Math.abs(dt - STEP) < 0.0025) dt = STEP;
    this.acc = Math.min((this.acc || 0) + dt, 0.25);
    let ds = 0;
    while (this.acc >= STEP - 1e-6) { this.acc -= STEP; ds += this.tick(STEP); }
    return ds;
  }

  tick(dt) {
    if (this.replay) this.applyReplay();
    if (this.state === 'break') {
      this.breakT += dt;
      const b = this.breakT;
      this.timeScale = b < 0.25 ? lerp(1, TUNE.slow, b / 0.25) : b < 1.9 ? TUNE.slow : b < 2.6 ? lerp(TUNE.slow, 1, (b - 1.9) / 0.7) : 1;
      if (b > 2.6) this.finishBreak();
    } else this.timeScale = 1;
    const ds = dt * this.timeScale;
    this.t += ds;
    if (['release', 'fly', 'crash'].includes(this.state)) this.clock += ds;
    if (this.state === 'crash') {
      this.crashT += dt;
      if (this.crashT > 0.7 && !this.fading) { this.fading = true; this.emit('fade', true); }
      if (this.crashT > TUNE.crashT) { this.respawn(); this.fading = false; this.emit('fade', false); }
    }
    this.ghost = Math.max(0, this.ghost - ds);
    this.placeCourse(ds);
    this.clearPlane(ds);
    const n = Math.max(1, Math.round(ds * 120));
    for (let k = 0; k < n; k++) this.step(ds / n);
    this.writeSlot();
    this.camera(dt, ds);
    return ds;
  }

  step(dt) {
    const A = this.app, p = this.p, v = this.v, st = this.state;
    if (st === 'ready') { p.copy(this.home); p.y = this.home.y + 0.04 * Math.sin(A.time * 1.3); return; }
    if (st === 'crash') {
      v.y += (-3 - v.y) * (1 - Math.exp(-dt / 0.15)); v.x *= Math.exp(-dt / 0.5); v.z *= Math.exp(-dt / 0.5);
      p.addScaledVector(v, dt); this.spin += dt * 5;
      return;
    }
    const h = p.y;
    // you fly in the lane's plane: across (x, left / right as you see it) and up; the beat sets the climb
    const ctl = st === 'fly' || (st === 'release' && this.t > 1.6);
    const ramp = st === 'release' ? smoothstep(0.2, 2.2, this.t) : 1;
    this.stokeOn = ctl && this.wantStoke() && this.meter > 0.02;
    this.easeOn = ctl && !this.stokeOn && this.wantEase();
    const sp = beatSpeed(h);
    let vyT = sp * ramp;
    if (this.stokeOn) vyT += TUNE.stoke * sp / 30;
    if (this.easeOn) vyT = Math.max(TUNE.minVy, vyT * 0.55);
    v.y += (vyT - v.y) * (1 - Math.exp(-dt / TUNE.vyTau));
    this.meter = clamp(this.meter + (this.stokeOn ? -TUNE.drain : TUNE.refill) * dt, 0, 1);
    const s = this.input();
    const push = gustAt(h);
    const k = 1 - Math.exp(-dt / TUNE.steerTau);
    const pvx = this.vx;
    this.vx += ((ctl ? s.x * TUNE.steer : 0) + push - this.vx) * k;
    this.x += this.vx * dt;
    if (Math.abs(this.x) > LANE) { this.x = Math.sign(this.x) * LANE; this.vx = 0; }
    p.y += v.y * dt;
    if (p.y < 0.3) { p.y = 0.3; v.y = Math.max(v.y, 0); }
    colCenter(p.y, CC);
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw);
    p.x = CC[0] - sy * this.x; p.z = CC[1] + cy * this.x;
    v.x = -sy * this.vx; v.z = cy * this.vx;
    // the lantern banks into a turn and leans with its speed across
    const lat = (this.vx - pvx) / dt;
    this.tilt.x += (clamp(lat * 0.006 + this.vx * 0.014, -0.45, 0.45) - this.tilt.x) * (1 - Math.exp(-dt / 0.12));
    this.tilt.y += (0 - this.tilt.y) * (1 - Math.exp(-dt / 0.2));
    if (st === 'done' || st === 'break') return;
    if (st === 'release' && this.t > 2.2) this.state = 'fly';
    // beats: reaching a new one makes it your restart point
    while (this.beat + 1 < BEATS.length && h >= BEATS[this.beat + 1].y0) { this.beat++; this.emit('beat', this.beat, BEATS[this.beat]); }
    if (this.t > 2.0) this.collide();
    if (this.state === 'crash') return;
    // the breakthrough: the camera (below and behind you) comes clear of the cloud's top
    const cw = cloudWind(A.cloudTime, this._cw || (this._cw = [0, 0]));
    const ct = colTopAt(p.x, p.z, cw[0], cw[1], CLOUD.colTop, CLOUD.base, this._ct || (this._ct = {}));
    if (h >= ct.surface - 2) {
      const ctc = colTopAt(this.cam.pos.x, this.cam.pos.z, cw[0], cw[1], CLOUD.colTop, CLOUD.base, this._ct2 || (this._ct2 = {}));
      if (this.cam.pos.y > ctc.cap - 3 || h > ct.cap + 25) this.breakthrough();
    }
  }

  /** You against every lantern: a touch is a crash; a lantern passing your height closer than TUNE.near is a near miss. */
  collide() {
    const S = this.app.swarm, P = S.pos, p = this.p, pd = this.prevDy;
    const ghost = this.ghost > 0;
    for (let i = S.iTargets; i < S.iTargets + this.course.list.length; i++) {
      if (i === this.slot) continue;
      const o = i * 3, dy = P[o + 1] - p.y;
      if (dy > 3 || dy < -3) { pd[i] = dy; continue; }
      const dx = P[o] - p.x, dz = P[o + 2] - p.z, d2 = dx * dx + dz * dz;
      if (d2 > 9) { pd[i] = dy; continue; }
      if (!ghost && dy < TUNE.bodyH && dy > -TUNE.bodyH && d2 < TUNE.body * TUNE.body) { this.crash(i); return; }
      if (!ghost && pd[i] > 0 && dy <= 0 && d2 < TUNE.near * TUNE.near && S.flame[i] > 0.02) { this.nears++; this.emit('near', this.nears, new THREE.Vector3(P[o], P[o + 1], P[o + 2])); }
      pd[i] = dy;
    }
  }

  crash(i) {
    if (this.state === 'crash') return;
    this.state = 'crash'; this.crashT = 0; this.crashes++; this.penalty += TUNE.crashPenalty;
    { const S0 = this.app.swarm, c = this.course.list[i - S0.iTargets] || {}; this.lastHit = { k: i - S0.iTargets, kind: c.kind, y0: c.y0, t: this.t, y: this.p.y, x: this.x, hx: S0.pos[i * 3], hy: S0.pos[i * 3 + 1], hz: S0.pos[i * 3 + 2], px: this.p.x, pz: this.p.z }; }
    if (this.shake) this.cam.shake = 0.6;
    const S = this.app.swarm, o = i * 3;
    S.vel[o] += (S.pos[o] - this.p.x) * 3; S.vel[o + 2] += (S.pos[o + 2] - this.p.z) * 3;   // the one you hit is knocked away
    this.emit('crash', { beat: this.beat, name: BEATS[this.beat].name });
  }

  /** The course's lanterns into the game's pool slots: where each is now (in your plane), its flame and tumble. */
  placeCourse(dt = 0) {
    if (this.state === 'fly' || this.state === 'release') this.course.aim(this.t, this.p.y, this.x, dt);
    const S = this.app.swarm, C = this.course, o = this.cpos, cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw);
    for (let k = 0; k < C.list.length; k++) {
      const i = S.iTargets + k;
      C.place(k, this.t, o);
      colCenter(o.y, CC);
      S.pos[i * 3] = CC[0] - sy * o.x + cy * o.d; S.pos[i * 3 + 1] = o.y; S.pos[i * 3 + 2] = CC[1] + cy * o.x + sy * o.d;
      S.flame[i] = o.flame; S.bright[i] = o.flame < 0.5 ? 0.8 : 1.0; S.tx[i] = o.tx; S.tz[i] = o.tz;
      // a lean across your plane: yaw the lantern so its local −x is your +x, then tip it about its z
      if (o.lean) { S.yaw[i] = Math.atan2(cy, sy); S.tz[i] = o.lean; }
    }
  }

  /** Keeps your plane for the course: background lanterns (release, streams, riders) near your height drift out of the
   *  slab around your plane (all the way to the camera, 8 m beyond), so a lantern that looks in your way is one you can
   *  hit. (Playing it: a release lantern 5 m behind the plane sat on my aim line between two rows, a lantern I could
   *  never touch that looked like one I had to dodge; then one between the lens and the plane filled a corner.) In the gust's band they are carried across with it, so the
   *  whole sky slides the way it shoves you. */
  clearPlane(dt) {
    if (!['release', 'fly', 'crash'].includes(this.state) || dt <= 0) return;
    const S = this.app.swarm, P = S.pos, p = this.p, w0 = smoothstep(4, 12, p.y);
    if (w0 <= 0) return;
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw), k = (1 - Math.exp(-dt / 0.35)) * w0;
    for (let i = 0; i < S.iTargets; i++) {
      if (i === this.slot) continue;
      const o = i * 3, dy = P[o + 1] - p.y;
      if (dy < -12 || dy > 80) continue;
      colCenter(P[o + 1], CC);
      const gx = gustAt(P[o + 1]) * 1.3 * dt;
      if (gx) { P[o] -= sy * gx; P[o + 2] += cy * gx; }
      const d = cy * (P[o] - CC[0]) + sy * (P[o + 2] - CC[1]);
      if (d <= -7.5 || d >= 8) continue;
      const to = d < 1 ? -7.5 : 8, m = (to - d) * k;
      P[o] += cy * m; P[o + 2] += sy * m;
    }
  }

  /** Back to the start of the beat you were in (the course carries on; a short grace). You come back lined up under
   *  the gap the beat's first row will have when you reach it (playing it: respawned 6 m from a gap sliding away, with
   *  0.7 s to reach it — only the grace got me through). */
  respawn() {
    const h = Math.max(BEATS[this.beat].y0 + 3, 25), C = this.course;
    colCenter(h, CC);
    this.x = 0; this.vx = 0;
    const rw = C.firstRowAbove(h);
    if (rw && beatAt(rw.h) === this.beat) {
      let t = this.t + 0.15;                                   // (the climb picks up from 60 % in ~0.15 s)
      for (let y = h; y < rw.h; y += 0.5) t += 0.5 / beatSpeed(y);
      this.x = clamp(C.gapX(rw, t, 0), -LANE, LANE);
    }
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw);
    this.p.set(CC[0] - sy * this.x, h, CC[1] + cy * this.x); this.v.set(0, beatSpeed(h) * 0.6, 0);
    this.spin = 0; this.tilt.set(0, 0);
    this.state = 'fly'; this.ghost = TUNE.ghostT; this.meter = Math.max(this.meter, 0.5);
    this.prevDy.fill(1e9);
    this.cam.anchor.set(lerp(CC[0], this.p.x, 0.72), 0, lerp(CC[1], this.p.z, 0.72));
    this.chasePose(this.cam.pos, this.cam.look);
    this.emit('respawn', { beat: this.beat });
  }

  makeResult() {
    const time = Math.round(this.time * 10) / 10;
    // (a clean run at an even climb is ~35 s; stoking and near misses win back ~3: gold needs both)
    const medal = time <= 32 ? 'gold' : time <= 36 ? 'silver' : time <= 42 ? 'bronze' : null;
    const prev = this.best, isBest = (!prev || time < prev.time) && !this.replay && !this.practice;   // (a practised beat is not a run)
    if (isBest) { this.best = { time, medal }; this.saveBest(this.best); }
    return { time, clock: this.clock, penalty: this.penalty, nears: this.nears, crashes: this.crashes, medal, isBest };
  }
  breakthrough() { this.state = 'break'; this.breakT = 0; this.finalClock = this.clock; this.result = this.makeResult(); this.emit('breakthrough', this.result); }
  finishBreak() { this.state = 'done'; this.emit('done', this.result); }

  /** Your lantern into its swarm slot (light) and the hero group (drawing). */
  writeSlot() {
    const A = this.app, S = A.swarm, i = this.slot, p = this.p;
    S.pos[i * 3] = p.x; S.pos[i * 3 + 1] = p.y; S.pos[i * 3 + 2] = p.z;
    const crash = this.state === 'crash';
    const fl = crash ? Math.max(0.12, 1 - this.crashT * 1.4) : this.stokeOn ? 1.35 : 1.0;
    S.flame[i] = fl;
    const L = A.lanterns;
    this.yawL += 0.08 * (1 / 60);
    const cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw);
    // bank: the top tips toward where you steer (view frame → world), over its own slow spin; tumbling in a crash
    const tx = this.tilt.x, ty = this.tilt.y;
    TIP.set(-sy * tx + cy * ty + 0.03 * Math.sin(A.time * 1.1) + (crash ? 0.8 * Math.sin(this.spin) : 0), 1,
      cy * tx + sy * ty + 0.03 * Math.cos(A.time * 0.9) + (crash ? 0.7 * Math.cos(this.spin * 1.3) : 0)).normalize();
    QT.setFromUnitVectors(UP, TIP); QY.setFromAxisAngle(UP, this.yawL + this.spin * 0.6);
    const q = QT.multiply(QY);
    const M = new THREE.Matrix4().compose(p, q, new THREE.Vector3(1.15, 1.15, 1.15));
    L.paper.setMatrixAt(0, M); L.flame.setMatrixAt(0, M);
    L.paper.instanceMatrix.needsUpdate = true; L.flame.instanceMatrix.needsUpdate = true;
    L.paper.position.set(0, 0, 0); L.flame.position.set(0, 0, 0); L.paper.updateMatrixWorld(); L.flame.updateMatrixWorld();
    const ia = L.paper.geometry.attributes.aInst; ia.array[1] = fl; ia.array[2] = 1.6; ia.needsUpdate = true;
    const blink = this.ghost > 0 && Math.sin(this.ghost * 22) > 0.2;
    L.paper.visible = !blink; L.flame.visible = !blink;
    // the marker: a ring under your lantern's opening (seen from below as an ellipse round it), pulses rippling out
    const mk = this.marker, mu = mk.material.uniforms, flying = this.state !== 'ready';
    // on a collision course the ring turns red where your eyes are (the line's far end is small at the top of the frame)
    const hitAt = this.state === 'fly' && this.ghost <= 0 ? this.lineHit() : -1;
    this.warnK += ((hitAt > 0 ? 1 : 0) - this.warnK) * 0.35;
    mu.uCol.value.set(1.0, 0.82, 0.56).lerp(WARN, this.warnK).multiplyScalar(14 - 6 * this.warnK);   // (dimmer red stays red through the tone map)
    mk.visible = flying;
    mk.position.set(p.x, p.y - 0.3, p.z);
    mu.uTime.value = A.time;
    const fadeT = crash ? Math.max(0, 1 - this.crashT * 2) : this.state === 'release' ? smoothstep(0.3, 1.2, this.t) : 1;
    mu.uFade.value = fadeT * (blink ? 0.35 : 1);
    // the aim line: straight up from your lantern in your plane — where you cross the rows above if you hold your line
    // (playing it: looking up, the rows' gaps sit off your vertical, so I lined up with the wrong place)
    // (kept through the ash and the cloud: looking up, what falls at you reads farther than it is; on the line = in your way)
    const am = this.aim, au = am.material.uniforms, rows = smoothstep(40, 55, p.y) * (1 - smoothstep(CLOUD.colTop - 30, CLOUD.colTop, p.y));
    am.visible = flying && rows > 0.01;
    // the line leans along your course (local +x is your −x): where you will be, not just what is straight above
    const lean = this.state === 'fly' ? Math.atan2(this.predLean || 0, Math.max(this.v.y, 4)) : 0;
    am.position.set(p.x, p.y + 0.75, p.z); am.rotation.order = 'YXZ'; am.rotation.set(0, Math.PI / 2 - this.cam.yaw, lean);
    au.uTime.value = A.time; au.uFade.value = fadeT * rows * (blink ? 0.35 : 1);
    au.uHit.value = hitAt > 0 ? hitAt / Math.cos(lean) : -1;
  }

  /** Where your line meets a lantern: how far up it (m) the first one you would touch if you held your line sits, within
   *  ~1.4 s of closing; −1 if none. Each lantern is taken where it will be when you meet it (rows drift, ash falls).
   *  (Played at human speed: looking up the climb, a lantern 5 m above fills half the frame's height and read as
   *  "far"; it hit me 0.18 s later. The line says it plainly: red from where it meets one. It follows your course —
   *  in the gust a straight-up line said "clear" while the wind carried me into a wall.) */
  lineHit() {
    const S = this.app.swarm, C = this.course, P = S.pos, p = this.p, o = this._lh || (this._lh = {});
    // your course for the next 1.4 s as the game will fly it: the keys you hold now and the gust ahead (a line from
    // your present speed warned 0.3 s before a wall: the gust builds as you climb into it)
    const pr = this._pred || (this._pred = new Float32Array(29)), dt = 0.05, s = this.input().x * TUNE.steer;
    let x = this.x, vx = this.vx, y = p.y; pr[0] = x;
    for (let k = 1; k < pr.length; k++) {
      vx += (s + gustAt(y) - vx) * (1 - Math.exp(-dt / TUNE.steerTau));
      x = Math.max(-LANE, Math.min(LANE, x + vx * dt)); y += this.v.y * dt; pr[k] = x;
    }
    this.predLean = (pr[16] - pr[0]) / 0.8;          // the line leans along the next 0.8 s
    let best = -1;
    for (let k = 0; k < C.list.length; k++) {
      const i = S.iTargets + k, dy = P[i * 3 + 1] - p.y;
      if (dy < 0.5 || dy > 40) continue;
      const c = C.list[k], vyL = c.kind === 'ash' ? -c.v : c.kind === 'crush' || c.kind === 'cloud' ? c.v : 0;
      const close = this.v.y - vyL; if (close < 1) continue;
      const tm = dy / close; if (tm > 1.4) continue;
      C.place(k, this.t + tm, o);
      const f = tm / dt, j = Math.min(Math.floor(f), pr.length - 2), xm = pr[j] + (pr[j + 1] - pr[j]) * (f - j);
      if (Math.abs(o.x - xm) < TUNE.body + 0.35 && (best < 0 || dy < best)) best = dy;
    }
    return best;
  }

  /* ---------------- camera ---------------- */
  /** The climb: below and behind, looking up. It follows a point between the column and you, so your lantern swings
   *  across the frame as you steer (a locked camera made steering move the world, not you). */
  chasePose(pos, look) {
    const a = this.cam.anchor, p = this.p, cy = Math.cos(this.cam.yaw), sy = Math.sin(this.cam.yaw);
    const up = smoothstep(4, 45, p.y);            // near the water: look across the release; then up the climb
    // look further up the climb than a chase cam would: the next row must be on screen ~1.4 s before you reach it
    // (played at human speed: the next wall showed only 29 m / 1.1 s out); faster beats look further still
    const ahead = 2.4 * smoothstep(20, 45, p.y) + clamp((beatSpeed(p.y) - 26) * 0.25, 0, 2.5);
    pos.set(a.x - cy * 5.0, p.y - lerp(1.4, 3.8, up), a.z - sy * 5.0);
    look.set(a.x + cy * lerp(14, 4, up), p.y + lerp(1.6, 6.6, up) + ahead, a.z + sy * lerp(14, 4, up));
  }

  camera(dt) {
    const A = this.app, c = A.camera, cam = this.cam, p = this.p;
    // the anchor: 45 % of the way from the column's centre to you, smoothed; never let you leave the frame
    if (this.state === 'fly' || this.state === 'release' || this.state === 'crash') {
      colCenter(p.y, CC);
      // (playing it: at 45 % / 6.5 m your lantern was thrown from one edge of the frame to the other)
      const tx = lerp(CC[0], p.x, 0.72), tz = lerp(CC[1], p.z, 0.72), k = 1 - Math.exp(-dt / 0.22);
      cam.anchor.x += (tx - cam.anchor.x) * k; cam.anchor.z += (tz - cam.anchor.z) * k;
      const ox = p.x - cam.anchor.x, oz = p.z - cam.anchor.z, o = Math.hypot(ox, oz);
      if (o > 3.2) { cam.anchor.x += ox * (1 - 3.2 / o); cam.anchor.z += oz * (1 - 3.2 / o); }
    }
    const P = new THREE.Vector3(), L = new THREE.Vector3();
    if (this.state === 'ready') {
      this.readyPose(P, L); const t = A.time;
      P.x += 0.22 * Math.sin(t * 0.21); P.z += 0.18 * Math.sin(t * 0.17 + 1); P.y += 0.06 * Math.sin(t * 0.6);
      L.y += 0.25 * Math.sin(t * 0.13);
      cam.pos.copy(P); cam.look.copy(L); A.setLens(32, 2.8, 5.4);
    } else if (this.state === 'release') {
      const u = ease(clamp(this.t / 2.2, 0, 1));
      this.chasePose(P, L); P.y = Math.max(P.y, 0.6);
      cam.pos.lerpVectors(this.camFrom.pos, P, u); cam.look.lerpVectors(this.camFrom.look, L, u);
      A.setLens(lerp(32, 20, u), 2.8, cam.pos.distanceTo(p));
    } else if (this.state === 'break' || this.state === 'done') {
      const md = A.sky.moonDir, n = Math.hypot(md.x, md.z), fx = md.x / n, fz = md.z / n;
      const a = 0.5, sx = fx * Math.cos(a) - fz * Math.sin(a), sz = fx * Math.sin(a) + fz * Math.cos(a);
      const C = new THREE.Vector3(), CL = new THREE.Vector3();
      this.chasePose(C, CL);
      P.set(p.x - sx * 9, p.y - 1.2, p.z - sz * 9); L.set(p.x + sx * 6, p.y + 0.8, p.z + sz * 6);
      const u = this.state === 'done' ? 1 : ease(clamp(this.breakT / 2.3, 0, 1));
      const oc = C.sub(p), os = P.clone().sub(p), lc = oc.length(), ls = os.length();
      const qa = new THREE.Quaternion().setFromUnitVectors(oc.clone().normalize(), os.clone().normalize());
      const q = new THREE.Quaternion().slerp(qa, u);
      cam.pos.copy(oc.normalize().applyQuaternion(q).multiplyScalar(lerp(lc, ls, u))).add(p);
      cam.look.copy(CL.sub(p).lerp(L.clone().sub(p), u)).add(p);
      A.setLens(lerp(20, 24, u), 2.8, cam.pos.distanceTo(p));
    } else if (this.state === 'crash') {
      // the camera eases after the tumbling lantern (playing it: held still at 36 m/s, it watched you shrink away)
      this.chasePose(P, L);
      cam.pos.lerp(P, 1 - Math.exp(-dt / 0.35)); cam.look.lerp(p, 1 - Math.exp(-dt / 0.25));
      A.setLens(20, 2.8, cam.pos.distanceTo(p));
    } else {
      this.chasePose(P, L);
      cam.pos.copy(P); cam.look.copy(L);
      A.setLens(20, 2.8, cam.pos.distanceTo(p));
    }
    const swing = this.state === 'break' || this.state === 'done';
    A.swarm.nearCull = this.state === 'ready' ? 0.9 : swing ? 2.0 : 0.9;
    A.swarm.nearFadeEnd = this.state === 'ready' ? 0 : swing ? 5.0 : 3.0;
    A.kit.uniforms.uNearFade.value.set(this.state === 'ready' ? -2 : A.swarm.nearCull, this.state === 'ready' ? -1 : A.swarm.nearFadeEnd);
    const inCl = this.state === 'fly' && p.y > CLOUD.base - 20 && p.y < CLOUD.colTop;
    this.ev += ((inCl ? 3.5 : 4.0) - this.ev) * (1 - Math.exp(-dt / 1.2));
    A.ev = this.ev;
    c.position.copy(cam.pos);
    if (cam.shake > 0) { cam.shake = Math.max(0, cam.shake - dt); const s = cam.shake * 0.18; c.position.x += (Math.random() - 0.5) * s; c.position.y += (Math.random() - 0.5) * s; }
    c.up.set(0, 1, 0); c.lookAt(cam.look);
    if (this.state === 'fly') { const lat = -Math.sin(cam.yaw) * this.v.x + Math.cos(cam.yaw) * this.v.z; c.rotateZ(clamp(-lat * 0.004, -0.05, 0.05)); }
    c.updateMatrixWorld();
  }

  /* ---------------- input ---------------- */
  wantStoke() { return this.keys.has('Space') || this.keys.has('KeyW') || this.keys.has('ArrowUp'); }
  wantEase() { return this.keys.has('ShiftLeft') || this.keys.has('ShiftRight') || this.keys.has('KeyS') || this.keys.has('ArrowDown'); }
  input() {
    const k = this.keys, s = this.steer.set(0, 0);
    if (k.has('KeyA') || k.has('ArrowLeft')) s.x -= 1;
    if (k.has('KeyD') || k.has('ArrowRight')) s.x += 1;
    if (s.x === 0 && this.mouse.down && this.mouseSteer) {
      const v = this.p.clone().project(this.app.camera);
      s.x = clamp((this.mouse.x - (v.x * 0.5 + 0.5) * innerWidth) / (0.12 * innerWidth), -1, 1);
    }
    if (s.lengthSq() > 1) s.normalize();
    if (s.lengthSq() > 0.01) this.lastInput += 1 / 120;
    return s;
  }

  bindInput() {
    const rec = (code, down) => { if (KEYS.includes(code) && ['release', 'fly', 'crash'].includes(this.state) && !this.replay) this.log.push([+this.t.toFixed(6), code, down ? 1 : 0]); };
    addEventListener('keydown', (e) => {
      if (this.replay && !e.isReplay) return;
      if (!this.keys.has(e.code)) rec(e.code, true);
      this.keys.add(e.code);
      if (e.code.startsWith('Arrow') || e.code === 'Space') { if (!document.querySelector('.panel.on')) e.preventDefault(); }
    });
    addEventListener('keyup', (e) => { if (this.replay && !e.isReplay) return; if (this.keys.has(e.code)) rec(e.code, false); this.keys.delete(e.code); });
    addEventListener('blur', () => this.keys.clear());
    const cv = this.app.renderer.domElement;
    cv.addEventListener('pointerdown', (e) => { this.mouse.down = true; this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    addEventListener('pointermove', (e) => { this.mouse.x = e.clientX; this.mouse.y = e.clientY; });
    addEventListener('pointerup', () => { this.mouse.down = false; });
  }

  /** Replays a key log (from a run I played): each event lands at the same game time it was made. */
  applyReplay() {
    const L = this.replay;
    while (this.replayAt < L.length && L[this.replayAt][0] <= this.t + 1e-4) {   // (frames are ≥ 1/240 s apart; a log at 4 decimals once
      // rounded a key-up past its frame and the replay held the key one frame longer)
      const [, code, down] = L[this.replayAt++];
      if (down) this.keys.add(code); else this.keys.delete(code);
    }
  }

  retry(auto = false) {
    const fade = document.getElementById('fade');
    if (fade) fade.classList.add('on');
    this.emit('retry');
    setTimeout(() => { this.reset(); if (fade) fade.classList.remove('on'); if (auto) setTimeout(() => { if (this.state === 'ready') this.release(); }, 650); }, 360);
  }

  loadBest() { try { const s = localStorage.getItem(BEST_KEY); return s ? JSON.parse(s) : null; } catch { return null; } }
  saveBest(b) { try { localStorage.setItem(BEST_KEY, JSON.stringify(b)); } catch { /* private mode */ } }
}

export const fmt = (s) => `${Math.floor(s / 60)}:${(s % 60).toFixed(1).padStart(4, '0')}`;

/** The aim line: a thin vertical strip standing in your plane from the top of your lantern up ~30 m, faint, with
 *  dashes running up it (the way you go); it fades with height so it never competes with the rows. */
function makeAim() {
  const g = new THREE.PlaneGeometry(0.5, 46); g.translate(0, 23, 0);   // (46 m: the warning reaches 1.4 s up the climb)
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uFade: { value: 1 }, uHit: { value: -1 }, uCol: { value: new THREE.Vector3(1.0, 0.86, 0.62).multiplyScalar(9) } },
    vertexShader: /* glsl */`out vec2 vQ; void main() { vQ = position.xy; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      in vec2 vQ; layout(location = 0) out vec4 fragColor;
      uniform float uTime, uFade, uHit; uniform vec3 uCol;
      void main() {
        float aa = fwidth(vQ.x);
        // red from where your line meets a lantern: thicker, solid, pulsing (a warning, not decoration)
        float hit = uHit > 0.0 ? smoothstep(uHit - 1.2, uHit - 0.4, vQ.y) : 0.0;
        float w = max(0.02 + 0.03 * hit, aa * 0.9);                  // never thinner than ~2 px
        float core = 1.0 - smoothstep(w - aa, w + aa, abs(vQ.x));
        float dash = smoothstep(0.25, 0.4, fract(vQ.y / 2.2 - uTime * 2.2)) * smoothstep(1.0, 0.85, fract(vQ.y / 2.2 - uTime * 2.2));
        float hfade = smoothstep(0.0, 1.2, vQ.y) * (1.0 - smoothstep(8.0, 30.0, vQ.y) * (1.0 - hit));
        vec3 red = vec3(1.0, 0.16, 0.08) * 16.0 * (0.8 + 0.2 * sin(uTime * 26.0));
        vec3 c = mix(uCol * (0.35 + 0.65 * dash), red, hit) * core * hfade;
        if (max(c.r, max(c.g, c.b)) < 1e-3) discard;
        fragColor = vec4(c * uFade, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.layers.set(3); mesh.frustumCulled = false; mesh.renderOrder = 12;
  return mesh;
}

/** Your marker: a horizontal ring under your lantern (procedural, anti-aliased lines on one quad): a steady ring just
 *  wider than the lantern and two pulses that ripple outward and fade. Additive, drawn with the lights (layer 3:
 *  after the clouds, never in the river's reflection), depth-tested so nearer lanterns cover it. */
function makeMarker() {
  const g = new THREE.PlaneGeometry(4.4, 4.4); g.rotateX(-Math.PI / 2);
  const m = new THREE.ShaderMaterial({
    glslVersion: THREE.GLSL3, transparent: true, depthWrite: false, depthTest: true, side: THREE.DoubleSide, blending: THREE.AdditiveBlending,
    uniforms: { uTime: { value: 0 }, uFade: { value: 1 }, uCol: { value: new THREE.Vector3(1.0, 0.82, 0.56).multiplyScalar(14) } },
    vertexShader: /* glsl */`out vec2 vQ; void main() { vQ = position.xz; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }`,
    fragmentShader: /* glsl */`
      in vec2 vQ; layout(location = 0) out vec4 fragColor;
      uniform float uTime, uFade; uniform vec3 uCol;
      float ring(float r, float R, float w) { float aa = fwidth(r) * 1.2; return 1.0 - smoothstep(w - aa, w + aa, abs(r - R)); }
      void main() {
        float r = length(vQ);
        float steady = ring(r, 0.6, 0.022) * (0.85 + 0.15 * sin(uTime * 3.0));
        float pulse = 0.0;
        for (int k = 0; k < 2; k++) {
          float ph = fract(uTime * 0.7 + float(k) * 0.5);
          pulse += ring(r, mix(0.6, 2.05, ph), mix(0.03, 0.012, ph)) * (1.0 - ph) * (1.0 - ph);
        }
        float halo = exp(-pow((r - 0.6) / 0.09, 2.0)) * 0.18;
        vec3 c = uCol * (steady + 0.75 * pulse + halo);
        if (max(c.r, max(c.g, c.b)) < 1e-3) discard;
        fragColor = vec4(c * uFade, 1.0);
      }`,
  });
  const mesh = new THREE.Mesh(g, m);
  mesh.layers.set(3); mesh.frustumCulled = false; mesh.renderOrder = 12;
  return mesh;
}
