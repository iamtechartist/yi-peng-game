// Lantern Night: boot, render loop, camera shots and debug hooks.
import * as THREE from 'three';
import { CONFIG, URLP, DEBUG } from './config.js';
import { DEG, fovFromFocal, clamp, blackbody, smoothstep } from './util.js';
import { NoiseVolumes, buildBlueNoise, buildRippleTexture } from './noise.js';
import { NightSky } from './sky.js';
import { Terrain } from './terrain.js';
import { PlanarReflection, River } from './water.js';
import { LanternKit, LanternGroup, flicker } from './lantern.js';
import { Swarm } from './swarm.js';
import { LightVolume } from './lightvol.js';
import { Town } from './town.js';
import { Clouds, CLOUD } from './clouds.js';
import { layoutTown, layoutCrowd, updateTown } from './townlayout.js';
import { Post } from './post.js';
import { Game, BEATS } from './game.js';
import { gustAt } from './beats.js';
import { Settings, HUD, Menus, fmtTime } from './ui.js';
import { AudioEngine } from './audio.js';
import { QualityManager } from './quality.js';

const $ = (id) => document.getElementById(id);
const setLoad = (p, step) => { const b = $('loadBar'); if (b) b.style.width = `${Math.round(p * 100)}%`; if (step && $('loadStep')) $('loadStep').textContent = step; };

class App {
  constructor() {
    const canvas = $('gl');
    this.renderer = new THREE.WebGLRenderer({ canvas, antialias: false, powerPreference: 'high-performance', stencil: false, preserveDrawingBuffer: false });
    this.renderer.outputColorSpace = THREE.LinearSRGBColorSpace;   // the final pass writes sRGB itself
    this.renderer.toneMapping = THREE.NoToneMapping;
    this.renderer.autoClear = false;
    // the tier: ?tier= > the setting > a look at the GPU (QualityManager)
    this.settings = new Settings();
    this.quality = new QualityManager(this, this.settings.data.quality);
    this.tierName = this.quality.name;
    this.tier = { ...CONFIG.tiers[this.tierName] };
    if (URLP.has('msaa')) this.tier.msaa = +URLP.get('msaa');
    this.scene = new THREE.Scene();
    this.camera = new THREE.PerspectiveCamera(50, 16 / 9, CONFIG.world.near, CONFIG.world.far);
    this.time = 0; this.frame = 0; this.ev = CONFIG.camera.ev100; this.cloudTime = 0;
    this.frameMs = 16.7; this.fps = 60;
    this.lens = { focalMM: 35, fstop: 2.8, focus: 30 };
  }

  async init() {
    const r = this.renderer;
    setLoad(0.05, 'Noise');
    this.noise = new NoiseVolumes(r);
    await this.noise.build(this.tierName === 'low' ? 64 : 128, 32, (f) => setLoad(0.05 + 0.3 * f));
    this.blue = buildBlueNoise();
    setLoad(0.4, 'Water');
    this.ripples = buildRippleTexture();
    setLoad(0.5, 'Sky');
    this.sky = new NightSky(r, this.noise);
    this.sky.setStarCount(this.tier.stars);
    new THREE.TextureLoader().load('assets/moon.jpg', (t) => { t.colorSpace = THREE.NoColorSpace; t.minFilter = THREE.LinearMipmapLinearFilter; t.anisotropy = 4; this.sky.setMoonTexture(t); });
    this.scene.add(this.sky.dome, this.sky.stars);
    setLoad(0.6, 'Valley');
    this.terrain = new Terrain(this.sky, this.noise);
    this.scene.add(this.terrain.mesh);
    this.refl = new PlanarReflection(this.tier.refl);
    this.river = new River(this.sky, this.ripples, this.refl);
    this.scene.add(this.river.mesh);
    setLoad(0.7, 'Lanterns');
    this.kit = await new LanternKit().load('', this.noise);
    this.buildLanterns();
    setLoad(0.72, 'Town');
    this.town = await new Town(this.sky, this.noise).load();
    this.town.cloudU = this.kit.cloudU;
    await layoutTown(this.town);
    this.scene.add(this.town.group);
    setLoad(0.75, 'Swarm');
    const scale = URLP.has('n') ? +URLP.get('n') / 3000 : 1;
    this.swarm = new Swarm(this.kit, { release: Math.round(1400 * scale), streams: Math.round(1600 * scale), start: new THREE.Vector3(-14, 0, 6), keepOut: this.town.keepOut, extraLights: this.town.extraLights });
    this.crowdCount = layoutCrowd(this.town, this.swarm);
    this.scene.add(this.swarm.group);
    // game mode unless a look-dev shot is asked for (?shot=…); the game holds the release until you let go
    this.gameMode = !URLP.has('shot') || URLP.has('play');
    this.swT = this.gameMode ? 0 : URLP.has('t') ? +URLP.get('t') : -3;   // swarm clock: the release is at 0 (look-dev)
    this.swarm.seek(Math.max(0, this.swT));
    setLoad(0.8, 'Lens');
    this.post = new Post(r, this.tier, { blue: this.blue, base: this.noise.base.texture, moonDir: this.sky.moonDir });
    // the swarm's light volume, shared by the banks, the river, the mist and the air
    this.lv = new LightVolume(r, this.swarm.lightTex, this.swarm.lightW, this.swarm.N + this.town.extraLights);
    const fc = this.kit.flameCol, pt = this.kit.uniforms.uPaperTint.value;
    const lc = new THREE.Vector3(fc.x * pt.x, fc.y * pt.y, fc.z * pt.z); lc.multiplyScalar(1 / (0.2126 * lc.x + 0.7152 * lc.y + 0.0722 * lc.z));
    this.lv.U.uLVcol.value.copy(lc);
    for (const m of [this.terrain.mat, this.river.mat, this.post.prep, this.town.mat]) Object.assign(m.uniforms, this.lv.U);
    // the cloud layer (lights at index ≥ spillFrom are street lamps: only their upward spill reaches the clouds)
    this.clouds = new Clouds(r, { noise: this.noise, blue: this.blue, sky: this.sky, lightTex: this.swarm.lightTex, lightW: this.swarm.lightW,
      count: this.swarm.N + this.town.extraLights, spillFrom: this.swarm.N + this.town.bulbs.length + this.town.krathongs.list.length });
    this.clouds.setTier(this.tier);
    // light from below, as the camera sees it after a kilometre of air: the lanterns aloft amber (their paper's
    // mid-tones, not the deep red of the bare flame), the wash from the ground a more neutral warm (the city's LED
    // and sodium lamps mixed in). Pre-white-balance colours at unit luminance.
    const unit = (v) => v.multiplyScalar(1 / (0.2126 * v.x + 0.7152 * v.y + 0.0722 * v.z));
    this.clouds.traceMat.uniforms.uFluxColH.value.copy(unit(new THREE.Vector3(1, 0.36, 0.08)));
    this.clouds.traceMat.uniforms.uFluxCol.value.copy(unit(new THREE.Vector3(1, 0.5, 0.22)));
    this.clouds.U.uCW = this.kit.cloudU.uCW;   // one wind offset for the trace and the late lights
    this.clouds.traceMat.uniforms.uCW = this.kit.cloudU.uCW;
    this.clouds.traceMat.uniforms.uCD = this.kit.cloudU.uCD; this.clouds.U.uCD = this.kit.cloudU.uCD;
    this.town.bakeShadows(r, this.scene);
    this.post.bloomLevels = this.tier.bloom;
    this.setWB(CONFIG.camera.wbK);
    const cu = this.post.comp.uniforms;
    cu.uMoonLight.value.set(this.sky.moonLight.r, this.sky.moonLight.g, this.sky.moonLight.b);
    cu.uAmb.value.set(this.sky.skyAmbTop.r, this.sky.skyAmbTop.g, this.sky.skyAmbTop.b);
    addEventListener('resize', () => this.resize());
    this.resize();
    this.shot(URLP.get('shot') || 'wide');
    if (this.gameMode) { this.game = new Game(this); this.game.update(0); this.setupGame(); }
    setLoad(0.9, 'Compiling');
    r.compile(this.scene, this.camera);
    this.render(0);
    setLoad(1, 'Ready');
    document.body.classList.remove('loading');
    $('loader').classList.add('done');
    this.last = performance.now();
    const loop = (t) => { this.raf = requestAnimationFrame(loop); if (this.hold) return; const dt = Math.min((t - this.last) / 1000, 0.1); this.last = t; this.tick(dt); };
    this.raf = requestAnimationFrame(loop);
    if (DEBUG && !this.gameMode) this.debugControls();
    // perf isolation switches: ?off=mist,dof,refl,terrain,water,dome,stars,bloom,lanterns
    const off = new Set((URLP.get('off') || '').split(',').filter(Boolean));
    this.off = off;
    if (off.has('terrain')) this.terrain.mesh.visible = false;
    if (off.has('water')) this.river.mesh.visible = false;
    if (off.has('dome')) this.sky.dome.visible = false;
    if (off.has('stars')) this.sky.stars.visible = false;
    if (off.has('lanterns')) { this.lanterns.paper.visible = false; this.lanterns.flame.visible = false; }
    if (off.has('mist')) this.post.comp.uniforms.uMist.value.x = 0;
    if (off.has('dof')) this.post.dof.enabled = false;
    if (off.has('bloom')) this.post.bloomOff = true;
    if (off.has('lv')) this.lvOff = true;
    if (off.has('clouds')) this.post.cloudsOff = true;
    if (off.has('town')) this.town.group.visible = false;
    if (off.has('trees')) this.town.group.children.forEach((m) => { if (m.userData.kind === 'tree') m.visible = false; });
    if (off.has('crowd')) this.town.group.children.forEach((m) => { if (m.userData.kind === 'crowd') m.visible = false; });
    if (off.has('townrefl')) this.town.group.traverse((m) => m.layers.disable(1));
  }

  /* ---------------- the game's presentation: title, HUD, menus, sound ---------------- */
  setupGame() {
    const G = this.game, S = this.settings, B = document.body;
    this.hud = new HUD(this); this.audio = new AudioEngine(this); this.menus = new Menus(this);
    this.clouds.baseScale = this.clouds.scale;
    const apply = (k, v) => {
      if (k === 'quality') { this.quality.auto = v === 'auto'; this.quality.apply(v === 'auto' ? this.quality.probe() : v); }
      if (k === 'music' || k === 'fx') this.audio.applyVolumes();
      if (k === 'mouse') G.mouseSteer = v;
      if (k === 'shake') G.shake = v;
      if (k === 'fps') B.classList.toggle('showfps', !!v);
    };
    S.onChange = apply;
    for (const k of ['mouse', 'shake', 'fps']) apply(k, S.data[k]);
    G.on.release = () => {
      B.classList.add('playing'); B.classList.remove('title', 'cine'); this.audio.release();
      if (this.firstRun !== false) this.hud.showControls();
      this.firstRun = false;
    };
    G.on.beat = (n, b) => { this.hud.hideControls(); this.hud.beat(n, b); this.audio.checkpoint(n); };
    G.on.near = (n, pos) => { this.hud.near(n, pos); this.audio.near(n); };
    G.on.crash = (e) => { this.hud.crash(e); this.audio.crash(); };
    G.on.fade = (on) => { const f = $('fade'); if (f) f.classList.toggle('on', on); };
    G.on.respawn = () => { this.hud.hideBig(); this.audio.respawn(); };
    G.on.breakthrough = (r) => { B.classList.add('cine'); this.hud.hideControls(); this.hud.big('Through the cloud', `${fmtTime(r.time)}${r.medal ? ' · ' + r.medal : ''}`, 2600); this.audio.breakthrough(); };
    G.on.done = (r) => { clearTimeout(this.resT); this.resT = setTimeout(() => { if (G.state === 'done') this.menus.showResults(r); }, 2200); };
    G.on.retry = () => { clearTimeout(this.resT); this.hud.hideBig(); this.menus.close(); B.classList.remove('cine'); };
    // keys: let go, pause, start again
    addEventListener('keydown', (e) => {
      if (e.repeat) return;
      this.audio.unlock();
      const menu = this.menus.current;
      const onButton = document.activeElement && document.activeElement.tagName === 'BUTTON';
      if ((e.code === 'Space' || e.code === 'Enter') && G.state === 'ready' && (!menu || (menu === 'title' && !onButton))) { e.preventDefault(); this.startRun(); return; }
      if ((e.code === 'Escape' || e.code === 'KeyP') && menu === 'pause') { e.preventDefault(); this.menus.act('resume'); return; }
      if ((e.code === 'Escape' || e.code === 'KeyP') && !menu && ['release', 'fly', 'out', 'break', 'done'].includes(G.state)) { e.preventDefault(); this.pause(true); return; }
      if (e.code === 'KeyR' && (!menu || menu === 'results' || menu === 'pause') && G.state !== 'ready') { e.preventDefault(); this.menus.close(); this.pause(false, true); G.retry(true); }
    });
    this.renderer.domElement.addEventListener('pointerdown', () => { this.audio.unlock(); if (!this.menus.current && G.state === 'ready' && !B.classList.contains('title')) this.startRun(); });
    addEventListener('pointerdown', () => this.audio.unlock(), { once: true });
    this.toTitle();
  }
  startRun() { this.audio.unlock(); this.menus.close(); document.body.classList.remove('title'); if (this.game.state === 'ready') this.game.release(); }
  toTitle() {
    const B = document.body; clearTimeout(this.resT);
    this.game.reset(); this.hud.hideBig(); this.hud.hideControls();
    B.classList.remove('playing', 'cine'); B.classList.add('title');
    this.menus.refreshTitle(); this.menus.open('title');
  }
  pause(on, silent = false) {
    if (on) { this.paused = true; this.menus.open('pause'); this.audio.suspend(true); }
    else { this.paused = false; this.audio.suspend(false); if (!silent) this.menus.close(); }
  }

  pixelRatio() {
    const t = this.tier;
    return Math.max(0.5, Math.min(devicePixelRatio || 1, t.maxDpr, Math.sqrt((t.mp * 1e6) / (innerWidth * innerHeight))) * (this.quality ? this.quality.prScale : 1));
  }
  resize(w = innerWidth, h = innerHeight, pr = this.pixelRatio()) {
    w = Math.max(w, 16); h = Math.max(h, 16);   // a hidden page reports 0×0: never size targets to nothing
    this.renderer.setPixelRatio(pr);
    this.renderer.setSize(w, h, !this.fixedSize);
    this.camera.aspect = w / h; this.camera.updateProjectionMatrix();
    const W = Math.round(w * pr), H = Math.round(h * pr);
    this.W = W; this.H = H; this.dpr = pr;
    this.post.setSize(W, H);
    if (this.clouds) this.clouds.setSize(W, H);
    this.refl.setSize(W, H);
  }

  /** White balance: gains that make a blackbody at T read neutral (luminance kept). */
  setWB(T) {
    const c = blackbody(T), L = 0.2126 / c[0] + 0.7152 / c[1] + 0.0722 / c[2];
    this.post.final.uniforms.uWB.value.set(1 / c[0] / L, 1 / c[1] / L, 1 / c[2] / L);
  }

  setLens(focalMM, fstop, focus) {
    this.lens = { focalMM, fstop, focus };
    this.camera.fov = fovFromFocal(focalMM); this.camera.updateProjectionMatrix();
    Object.assign(this.post.dof, { focalMM, fstop, focus });
  }

  /** Stage 3: the hero lantern over the river and a dozen real ones around it (the swarm comes in Stage 4). */
  buildLanterns() {
    const rnd = (() => { let a = 99; return () => { a = (a * 16807) % 2147483647; return a / 2147483647; }; })();
    const mats = [];
    const put = (x, y, z, tilt, yaw) => mats.push(new THREE.Matrix4().compose(new THREE.Vector3(x, y, z), new THREE.Quaternion().setFromEuler(new THREE.Euler(tilt * Math.cos(yaw), yaw, tilt * Math.sin(yaw), 'YXZ')), new THREE.Vector3(1, 1, 1)));
    this.heroPos = new THREE.Vector3(-14, 6.5, 6);
    put(this.heroPos.x, this.heroPos.y, this.heroPos.z, 0.05, 0.4);
    this.lanterns = new LanternGroup(this.kit, mats);
    // yours is the crimson one (every other lantern in the sky is gold): you always know which is you
    this.lanterns.paper.material.uniforms.uPaperTint = { value: new THREE.Vector3(1.0, 0.26, 0.16) };
    // your lantern never dissolves (the swarm's near-lens fade is theirs only)
    const keep = { value: new THREE.Vector2(-2, -1) };
    this.lanterns.paper.material.uniforms.uNearFade = keep; this.lanterns.flame.material.uniforms.uNearFade = keep;
    this.scene.add(this.lanterns.paper, this.lanterns.flame);
    this.setHero(false);
  }

  /** Show the hero lantern, optionally moved to \`at\` (its base); its flame then also lights the cloud around it. */
  setHero(on, at = null) {
    const L = this.lanterns; L.paper.visible = L.flame.visible = on;
    const o = at ? at.clone().sub(this.heroPos) : new THREE.Vector3();
    for (const m of [L.paper, L.flame]) { m.position.copy(o); m.updateMatrixWorld(); }
    this.heroLight = on && at ? [at.x, at.y + 0.04, at.z, 30] : null;
  }
  /** The chase position: the player's lantern a few metres ahead of the camera, below and to one side. */
  heroAhead(dist = 4.5, down = 0.9, side = 0.7) {
    const c = this.camera; c.updateMatrixWorld();
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(c.quaternion), r = new THREE.Vector3(1, 0, 0).applyQuaternion(c.quaternion), u = new THREE.Vector3(0, 1, 0).applyQuaternion(c.quaternion);
    this.setHero(true, c.position.clone().addScaledVector(f, dist).addScaledVector(u, -down).addScaledVector(r, side).add(new THREE.Vector3(0, -0.5, 0)));
  }

  /** Named camera set-ups (look-dev and checkpoint screenshots). */
  shot(name) {
    const c = this.camera, md = this.sky.moonDir;
    const look = (px, py, pz, az, el) => { c.position.set(px, py, pz); const d = NightSky.dirFrom(el, az, new THREE.Vector3()); c.lookAt(px + d.x, py + d.y, pz + d.z); };
    this.shotName = name;
    this.setHero(/^lantern/.test(name));
    if (name === 'wide') { look(-47, 1.7, 8, CONFIG.moon.azim + 4, 6.5); this.setLens(24, 5.6, 40); this.ev = 4.0; }
    else if (name === 'bokeh') {
      // 135 mm f/1.8 focused on the nearest light ~10 m out toward the moon: the rest of the grid and the
      // far group fall behind it as large overlapping discs (long-lens release photos, refs 04–06)
      c.position.set(-47, 2.0, 2);
      const want = c.position.clone().addScaledVector(new THREE.Vector3(0.955, 0.14, 0.296).normalize(), 12);
      let best = null, bd = 1e9;
      for (const m of this.lanterns.matrices) { const v = new THREE.Vector3().setFromMatrixPosition(m).add(new THREE.Vector3(0, 0.5, 0)), dd = v.distanceTo(want); if (dd < bd) { bd = dd; best = v; } }
      const aim = best.clone().lerp(c.position.clone().addScaledVector(new THREE.Vector3(0.955, 0.075, 0.296).normalize(), best.distanceTo(c.position)), 0.7);
      c.lookAt(aim); this.setLens(135, 1.8, c.position.distanceTo(best)); this.ev = 4.0;
    }
    else if (name === 'river') { look(-40, 0.85, 12, CONFIG.moon.azim + 2, -2.5); this.setLens(35, 4, 18); this.ev = 4.0; }
    else if (name === 'lantern2m' || name === 'lantern10m' || name === 'lanternBottom') {
      const H = this.heroPos, ctr = H.clone().add(new THREE.Vector3(0, 0.5, 0));
      if (name === 'lantern2m') { c.position.copy(H).add(new THREE.Vector3(-1.95, 0.05, 0.8)); c.lookAt(ctr); this.setLens(40, 2.8, c.position.distanceTo(ctr) - 0.3); }
      else if (name === 'lantern10m') { c.position.copy(H).add(new THREE.Vector3(-9.3, -2.6, 3.0)); c.lookAt(ctr); this.setLens(85, 2.8, c.position.distanceTo(ctr)); }
      else { c.position.copy(H).add(new THREE.Vector3(0.42, -0.5, 0.3)); c.lookAt(H.clone().add(new THREE.Vector3(-0.03, 0.32, -0.02))); this.setLens(20, 4, 0.75); }   // up into the opening from one side (ref 07)
      this.ev = 4.0;
    }
    else if (name === 'swarmLow') {        // the release, seconds after lift-off: low over the water, toward the moon
      this.swarm.seek(9); this.swT = 9;
      look(-34, 1.4, 34, CONFIG.moon.azim + 12, 9); this.setLens(28, 2.8, 22); this.ev = 4.0;
    }
    else if (name === 'swarmMid') {        // a minute in: up among the climbing lanterns, the streams beyond
      this.swarm.seek(65); this.swT = 65;
      look(-30, 70, 60, CONFIG.moon.azim + 20, 6); this.setLens(30, 2.8, 30); this.ev = 4.0;
    }
    else if (name === 'streams') {         // long lens from the west bank, before the release: the earlier lanterns streaming across the moon
      this.swarm.seek(0); this.swT = -3;
      // walk the bank for the spot where a stream passes in front of the moon
      const S = this.swarm, P = S.pos, best = { z: 8, n: -1 }, p = new THREE.Vector3(), d = new THREE.Vector3();
      for (let z = -700; z <= 700; z += 20) {
        p.set(-47, 1.7, z); let n = 0;
        for (let i = S.nRelease; i < S.N; i++) { if (S.flame[i] < 0.1) continue; d.set(P[i * 3] - p.x, P[i * 3 + 1] - p.y, P[i * 3 + 2] - p.z).normalize(); if (d.dot(md) > Math.cos(1.6 * DEG)) n++; }
        if (n > best.n) { best.n = n; best.z = z; }
      }
      this.streamsHit = best;
      look(-47, 1.7, best.z, CONFIG.moon.azim, CONFIG.moon.elev + 7.5); this.setLens(50, 4, 600); this.ev = 4.0;   // the stream climbs out of the frame through the moon (ref 12)
    }
    else if (name === 'templeWater') {      // the temple at the waterline: from a boat on the river, the chedi under the moon
      this.swarm.seek(0); this.swT = -3;
      const T = CONFIG.town.temple;
      c.position.set(T.x - 52, 1.2, T.z - 2); c.lookAt(T.x - 4, 8.5, T.z + 1); this.setLens(35, 4, 46); this.ev = 4.0;
    }
    else if (name === 'riverbank') {        // the east bank downstream of the temple: houses, boats, krathongs drifting by
      this.swarm.seek(0); this.swT = -3; this.time = 40;
      c.position.set(38, 0.55, -22); c.lookAt(62, 1.8, 18); this.setLens(28, 2.8, 9); this.ev = 4.0;
    }
    else if (name === 'town100') {          // the town from 100 m up: the river, the temple, the release spread on the water
      this.swarm.seek(0); this.swT = -3;
      c.position.set(-150, 100, -190); c.lookAt(40, 0, 60); this.setLens(24, 5.6, 300); this.ev = 3.2;   // no lantern near the lens: open up a stop
    }
    else if (name === 'krathongDebug') {    // a close look at the krathongs drifting off the temple steps
      this.swarm.seek(0); this.swT = -3; this.time = 20;
      const T = CONFIG.town.temple;
      c.position.set(45, 0.7, T.z + 2); c.lookAt(49, 0.0, T.z + 16); this.setLens(35, 2.8, 8); this.ev = 4.0;
    }
    else if (name === 'templeDebug') {      // daylight-free look at the model: close, front three-quarter
      const T = CONFIG.town.temple;
      c.position.set(T.x - 34, 6, T.z - 18); c.lookAt(T.x - 10, 6, T.z); this.setLens(35, 8, 30); this.ev = 4.0;
    }
    else if (name === 'underClouds') {      // 230 m under the base, beside the high flyers' stream: the layer overhead glowing warm where it
      this.swarm.seek(0); this.swT = -3;    // enters, silver-edged cumulus round a gap with the moon, your lantern ahead
      look(-1016, 1220, 23, CONFIG.moon.azim - 15, 34); this.setLens(20, 4, 4.5); this.ev = 4.0; this.heroAhead(4.5, 0.9, -0.9);
    }
    else if (name === 'inClouds') {         // inside the climb column, ~70 m under its top: fog lit by your lantern and the stream
      this.swarm.seek(0); this.swT = -3;
      look(-14, 1740, 6, CONFIG.moon.azim + 26, 22); this.setLens(24, 4, 4.5); this.ev = 3.4; this.heroAhead(4.5, 0.8, 0.5);   // (EV 3.4: the eye opens up in the fog)
    }
    else if (name === 'aboveClouds') {      // through: 350 m over the climb column, towers and gaps silver under a sharp moon, the stream rising on toward it
      this.swarm.seek(0); this.swT = -3;
      look(-14, 2150, 6, CONFIG.moon.azim + 8, 2); this.setLens(24, 4, 4.5); this.ev = 4.0; this.heroAhead(4.5, 0.6, 0.6);
    }
    else if (name === 'moon') { look(-47, 1.7, 8, CONFIG.moon.azim, CONFIG.moon.elev); this.setLens(400, 5.6, 1e4); this.ev = 4.0; }
    c.updateMatrixWorld();
  }

  tick(dt) {
    const t0 = performance.now();
    this.frame++;
    if (this.game) {
      const ds = this.paused ? 0 : this.game.update(dt); this.time += ds; this.swT += ds; this.runClouds(ds);
      if (this.hud) this.hud.update(dt);
      if (this.audio) this.audioFrame(dt);
      if (!this.paused && ['release', 'fly'].includes(this.game.state)) this.quality.sample(dt * 1000);
    }
    else { this.time += dt; if (!this.swPause) this.swT += dt; }
    if (this.fly) this.fly(dt);
    this.render(dt);
    const ms = dt * 1000;
    this.frameMs += (ms - this.frameMs) * 0.05; this.fps = 1000 / this.frameMs;
    if (DEBUG && (this.frame % 15) === 0 && $('dbg')) $('dbg').textContent = `${this.tierName} ${this.W}×${this.H} ${this.fps.toFixed(0)} fps · ${this.shotName || ''} · ${this.lens.focalMM}mm f/${this.lens.fstop} @${this.lens.focus.toFixed(1)}m · EV${this.ev.toFixed(1)}`;
    this.cpuMs = performance.now() - t0;
  }

  render(dt) {
    const r = this.renderer, cam = this.camera;
    cam.updateMatrixWorld();
    this.sky.update(cam, this.H, this.dpr);
    this.sky.U.uSkyK.value.y = CONFIG.sky.cityGlow * (1 - smoothstep(CLOUD.base - 140, CLOUD.colTop + 150, cam.position.y));   // above the layer the city is hidden
    this.river.update(this.time);
    // the swarm: simulate to the swarm clock, then LOD buckets / points / light data for this camera
    this.kit.uniforms.uTime.value = this.time;
    this.swarm.update(this.swT);
    this.swarm.prepare(cam, this.H, this.dpr, this.swT);
    // the town (krathongs drift; their candles and the bulbs join the lanterns' light data)
    // the budget goes where the camera is: once you are up in the air the town's buildings and the river's mirror
    // are a few pixels below (looking up the climb), so they stop being drawn; their lights stay
    const high = cam.position.y > 70;
    if (high !== this.wasHigh) { this.wasHigh = high; for (const m of this.town.group.children) if (!m.isPoints) m.visible = !high; }
    this.town.update(this.time, this.swarm.near, cam);
    updateTown(this.town, this.time, this.swarm, cam, this.H, this.dpr);
    this.clouds.update(this.game ? this.cloudTime : this.time, cam, this.swarm.near, this.heroLight);
    // every light into the light volume; the 8 nearest lanterns as point lights (highlights)
    if (!this.lvOff) this.lv.update(cam.position); else this.lv.clear();
    const near = this.swarm.near, nl = this.terrain.mat.uniforms.uNL.value;
    for (let j = 0; j < 8; j++) { const q = near[j]; if (q) nl[j].set(q[0], q[1], q[2], q[3]); else nl[j].set(0, -1e4, 0, 0); }
    if ((!this.off || !this.off.has('refl')) && !high) { this.town.mat.uniforms.uCheap.value = 1; this.refl.render(r, this.scene, cam, 0, [this.river.mesh]); this.town.mat.uniforms.uCheap.value = 0; }
    const expo = 1 / (1.2 * Math.pow(2, this.ev));
    this.post.render(this, dt, expo);
  }

  /** The clouds drift on the run's own clock (still on the title, from 0 at every let-go), so a run — and the replay
   *  of its key log — meets the same cloud top however long the title was up. */
  runClouds(ds) { if (['release', 'fly', 'crash', 'break', 'done'].includes(this.game.state)) this.cloudTime += ds; }

  /** The sound's view of the game, once a frame. */
  audioFrame(dt) {
    const G = this.game, st = G.state, h = G.p.y;
    this.audio.update(dt, {
      title: document.body.classList.contains('title'), playing: ['release', 'fly', 'break'].includes(st), alt: h, climb: G.v.y,
      flame: st === 'crash' ? 0.3 : 1, stoke: G.stokeOn, flicker: 0.75 + 0.25 * Math.sin(this.time * 37.0) * Math.sin(this.time * 13.3),
      gap: st === 'fly' && Math.abs(gustAt(h)) > 1, cloud: st === 'fly' && h > CLOUD.base, out: st === 'crash', done: st === 'done' || st === 'break', timeScale: G.timeScale,
    });
  }

  /** Game mode, for tests and capture: step the game and the swarm for sec (no rendering). */
  advance(sec, fps = 60) {
    const dt = 1 / fps;
    for (let t = 0; t < sec - 1e-6; t += dt) { const ds = this.game.update(dt); this.time += ds; this.swT += ds; this.runClouds(ds); this.swarm.update(this.swT); }
  }

  /** Save the current frame as it stands (no time passes: a played run stays deterministic). */
  async view(path, w = 960, h = 540) {
    this.hold = true; this.fixedSize = true;
    const prevW = innerWidth, prevH = innerHeight;
    this.resize(w, h, 1);
    // (a resize clears the clouds' temporal history: 3 frames left the fog a mottled maze in every still; 12 settle it
    // the way a held camera would — judge the fog in motion from the 1× replay video, not from these)
    for (let i = 0; i < 12; i++) this.render(0);
    if (this.hud) this.hud.update(0);
    const url = this.renderer.domElement.toDataURL('image/png');
    this.fixedSize = false; this.resize(prevW, prevH);
    const res = await fetch(`/__save?path=${encodeURIComponent(path)}`, { method: 'POST', body: url });
    return res.text();
  }

  /** Render one frame at w×h and save it as PNG under shots/ (dev server). */
  async snap(path, w = 1920, h = 1080, frames = 4) {
    this.hold = true;
    this.fixedSize = true;
    const prevW = innerWidth, prevH = innerHeight;
    this.resize(w, h, 1);
    for (let i = 0; i < frames; i++) { this.time += 1 / 60; this.render(1 / 60); }
    const url = this.renderer.domElement.toDataURL('image/png');
    this.fixedSize = false;
    this.resize(prevW, prevH);
    this.hold = false; this.last = performance.now();
    const res = await fetch(`/__save?path=${encodeURIComponent(path)}`, { method: 'POST', body: url });
    return res.text();
  }

  /** Frame-time measurement at a fixed internal size (the canvas is CSS-scaled to the window). */
  perf(seconds = 8, w = 1920, h = 1080) {
    return new Promise((res) => {
      this.fixedSize = true; this.resize(w, h, 1); this.renderer.domElement.style.width = '100vw'; this.renderer.domElement.style.height = '100vh';
      const dts = []; let last = performance.now(); const t0 = last;
      const step = (t) => {
        dts.push(t - last); last = t;
        if (t - t0 < seconds * 1000) requestAnimationFrame(step);
        else {
          this.fixedSize = false; this.resize();
          const a = dts.slice(30).sort((x, y) => x - y), mean = a.reduce((s, x) => s + x, 0) / a.length;
          res({ frames: a.length, mean: +mean.toFixed(2), p50: +a[a.length >> 1].toFixed(2), p95: +a[Math.floor(a.length * 0.95)].toFixed(2), fps: +(1000 / mean).toFixed(1), size: `${w}x${h}`, tier: this.tierName });
        }
      };
      requestAnimationFrame(step);
    });
  }

  /** Throughput benchmark: n frames rendered back-to-back at w×h, synced by a pixel readback (the GPU runs
   *  flat out, so its clocks ramp up: frame-locked GPU time overstates cost on Apple GPUs). Returns ms/frame. */
  bench(n = 120, w = 1920, h = 1080) {
    this.hold = true; this.fixedSize = true; this.resize(w, h, 1);
    const gl = this.renderer.getContext(), px = new Uint8Array(4);
    for (let i = 0; i < 20; i++) { this.time += 1 / 60; this.render(1 / 60); }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const t0 = performance.now();
    for (let i = 0; i < n; i++) { this.time += 1 / 60; this.render(1 / 60); }
    gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, px);
    const ms = (performance.now() - t0) / n;
    this.fixedSize = false; this.resize(); this.hold = false; this.last = performance.now();
    return +ms.toFixed(2);
  }

  debugControls() {
    const keys = new Set(); let drag = null;
    addEventListener('keydown', (e) => keys.add(e.code)); addEventListener('keyup', (e) => keys.delete(e.code));
    const cv = this.renderer.domElement;
    cv.addEventListener('pointerdown', (e) => { drag = [e.clientX, e.clientY]; });
    addEventListener('pointerup', () => { drag = null; });
    addEventListener('pointermove', (e) => {
      if (!drag) return;
      const dx = e.clientX - drag[0], dy = e.clientY - drag[1]; drag = [e.clientX, e.clientY];
      const k = this.camera.fov / innerHeight * DEG;
      const eu = new THREE.Euler().setFromQuaternion(this.camera.quaternion, 'YXZ');
      eu.y -= dx * k; eu.x = clamp(eu.x - dy * k, -1.5, 1.5); eu.z = 0;
      this.camera.quaternion.setFromEuler(eu);
    });
    this.fly = (dt) => {
      const v = new THREE.Vector3((keys.has('KeyD') ? 1 : 0) - (keys.has('KeyA') ? 1 : 0), (keys.has('KeyE') ? 1 : 0) - (keys.has('KeyQ') ? 1 : 0), (keys.has('KeyS') ? 1 : 0) - (keys.has('KeyW') ? 1 : 0));
      if (v.lengthSq() === 0) return;
      v.applyQuaternion(this.camera.quaternion).multiplyScalar(dt * (keys.has('ShiftLeft') ? 60 : 8));
      this.camera.position.add(v);
    };
  }
}

const app = new App();
/* My play harness (no autopilot): real key events into the page, the game stepped in short slices, a frame to look at.
   __play.keys(['KeyD','Space']) holds exactly those keys (releases the rest); __play.step(sec) advances the game;
   __play.view(path) saves the current frame; __play.state() reports where the run is. The run's key log replays at 1×. */
window.__play = {
  start() { const A = app; A.hold = true; A.audio.suspend(true); A.toTitle(); A.startRun(); return this.state(); },
  keys(list) {
    const G = app.game, want = new Set(list);
    for (const c of [...G.keys]) if (!want.has(c)) dispatchEvent(new KeyboardEvent('keyup', { code: c }));
    for (const c of want) if (!G.keys.has(c)) dispatchEvent(new KeyboardEvent('keydown', { code: c }));
  },
  step(sec) { app.advance(sec, 60); return this.state(); },
  /** Human reaction: what I decided on the frame I looked at lands REACT s later (the previous keys held meanwhile),
   *  then is held for `hold` s. A person can't press on the frame they see; neither do I. */
  react(list, hold, REACT = 0.25) { app.advance(REACT, 60); this.keys(list); app.advance(hold, 60); return this.state(); },
  /** Practise one beat: let go, then start at beat k's restart point (as after a crash there, without the penalty). */
  startAt(k) { this.start(); app.advance(2.4, 60); const G = app.game; G.practice = true; G.beat = k; G.respawn(); G.ghost = 0; return this.state(); },
  async view(path, w = 960, h = 540) { return app.view(path, w, h); },
  state() { const G = app.game; return { t: +G.t.toFixed(2), state: G.state, y: Math.round(G.p.y), beat: BEATS[G.beat].name, crashes: G.crashes, nears: G.nears, time: +G.time.toFixed(1), meter: +G.meter.toFixed(2), keys: [...G.keys].join(',') }; },
  log() { return JSON.stringify(app.game.log); },
};
window.__ln = { app, THREE, advance: (s, f) => app.advance(s, f), shot: (n) => app.shot(n), snap: (p, w, h, f) => app.snap(p, w, h, f), perf: (s, w, h) => app.perf(s, w, h), bench: (n, w, h) => app.bench(n, w, h) };
app.init().catch((e) => { console.error(e); const f = $('fatal'); if (f) { f.classList.add('show'); $('fatalMsg').textContent = String(e && e.message || e); } });
