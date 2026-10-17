// Sound: Web Audio only, fully synthesised, started by the first click / key (Eye of the Storm's approach: looping
// noise beds through filters, one-shots scheduled ahead on the audio clock, an adaptive score on a look-ahead beat).
//   GROUND (fades as you climb): the river (low water + lapping), crickets (chirp trains, a few voices panned), the
//     crowd's murmur and its cheer at the release.
//   AIR: wind that grows with height and climb speed, gusty in the shear gaps, soft and close in the cloud.
//   YOUR FLAME: a hiss with the flicker in it, crackles; it sputters when weak, gutters on a knock.
//   CLOUD: everything outside goes muffled (a low-pass on the ground / air buses and the music).
//   SCORE (original): D major pentatonic. Warm pads (D, Bm, G, A colours), a khim-like plucked line whose density
//     rises with the climb, a soft low pulse; tense and sparse in the crosswinds; held breath in the cloud; at the
//     breakthrough the wind falls away under a wide chord and a cascade of bells, then a slow moonlight theme.
const PENTA = [146.83, 164.81, 185.0, 220.0, 246.94];                      // D E F# A B (D3…)
const CHORDS = [[73.42, 146.83, 220.0, 329.63, 369.99], [61.74, 123.47, 185.0, 293.66, 440.0],
  [49.0, 98.0, 246.94, 293.66, 369.99], [55.0, 110.0, 220.0, 329.63, 493.88]];
const BELLS = [587.33, 659.25, 739.99, 880.0, 987.77, 1174.66, 1318.5, 1479.98];
const rand = (a, b) => a + Math.random() * (b - a);
const clamp = (x, a, b) => Math.min(b, Math.max(a, x));
const lerp = (a, b, t) => a + (b - a) * t;
const sstep = (a, b, x) => { const t = clamp((x - a) / (b - a), 0, 1); return t * t * (3 - 2 * t); };

export class AudioEngine {
  constructor(app) { this.app = app; this.ctx = null; this.on = false; this.nextBeat = 0; this.beat = 0; this.nextChord = 0; this.chord = 0; this.nextBell = 0; this.nextCricket = 0; this.nextLap = 0; this.nextCrackle = 0; this.cloud = 0; this.alt = 0; this.calm = 0; }
  unlock() {
    try { if (!this.ctx) this.init(); if (this.ctx && this.ctx.state === 'suspended') this.ctx.resume(); } catch (e) { /* audio unavailable */ }
  }
  init() {
    const AC = window.AudioContext || window.webkitAudioContext;
    if (!AC) return;
    const ctx = this.ctx = new AC();
    const gain = (v = 0) => { const g = ctx.createGain(); g.gain.value = v; return g; };
    const comp = ctx.createDynamicsCompressor(); comp.threshold.value = -16; comp.ratio.value = 3; comp.attack.value = 0.01; comp.release.value = 0.3;
    this.master = gain(0); this.master.connect(comp).connect(ctx.destination);
    this.fx = gain(0.85); this.music = gain(0.6); this.fx.connect(this.master); this.music.connect(this.master);
    // the world outside your lantern: muffled in the cloud
    this.outF = ctx.createBiquadFilter(); this.outF.type = 'lowpass'; this.outF.frequency.value = 18000; this.outF.connect(this.fx);
    this.ground = gain(1); this.ground.connect(this.outF);
    this.air = gain(1); this.air.connect(this.outF);
    this.musF = ctx.createBiquadFilter(); this.musF.type = 'lowpass'; this.musF.frequency.value = 18000; this.musF.connect(this.music);
    let seed = 99; const rng = () => { seed = (seed * 16807) % 2147483647; return seed / 2147483647; };
    const buf = (sec, kind) => {
      const n = Math.floor(ctx.sampleRate * sec), b = ctx.createBuffer(1, n, ctx.sampleRate), d = b.getChannelData(0);
      let last = 0, b0 = 0, b1 = 0, b2 = 0;
      for (let i = 0; i < n; i++) {
        const w = rng() * 2 - 1;
        if (kind === 'white') d[i] = w;
        else if (kind === 'brown') { last = (last + 0.02 * w) / 1.02; d[i] = last * 3.5; }
        else { b0 = 0.997 * b0 + w * 0.029; b1 = 0.985 * b1 + w * 0.032; b2 = 0.95 * b2 + w * 0.048; d[i] = (b0 + b1 + b2 + w * 0.02) * 2.2; }
      }
      const f = 2048; for (let i = 0; i < f; i++) { const t = i / f; d[n - f + i] = d[n - f + i] * (1 - t) + d[i] * t; }
      return b;
    };
    this.white = buf(2, 'white'); this.pink = buf(4, 'pink'); this.brown = buf(4, 'brown');
    const loop = (b, rate = 1) => { const s = ctx.createBufferSource(); s.buffer = b; s.loop = true; s.playbackRate.value = rate; s.start(0, rng() * 1.5); return s; };
    const filt = (type, f, q = 0.7) => { const x = ctx.createBiquadFilter(); x.type = type; x.frequency.value = f; x.Q.value = q; return x; };
    this.filt = filt;
    // ground: river (low body + a ripple band breathing slowly), crowd murmur (three formant bands)
    this.riverF = filt('lowpass', 520, 0.6); this.riverG = gain(0.0);
    loop(this.brown, 0.9).connect(this.riverF).connect(this.riverG).connect(this.ground);
    this.ripF = filt('bandpass', 900, 0.9); this.ripG = gain(0.0);
    loop(this.pink, 1.2).connect(this.ripF).connect(this.ripG).connect(this.ground);
    this.crowd = [380, 760, 1450].map((f, i) => { const fl = filt('bandpass', f, 1.6), g = gain(0); loop(this.pink, 0.8 + 0.1 * i).connect(fl).connect(g).connect(this.ground); return { g, f }; });
    // air: wind body + roughness
    this.windF = filt('bandpass', 420, 0.6); this.windG = gain(0);
    loop(this.pink).connect(this.windF).connect(this.windG).connect(this.air);
    this.roughF = filt('highpass', 2600, 0.5); this.roughG = gain(0);
    loop(this.white, 0.7).connect(this.roughF).connect(this.roughG).connect(this.air);
    // your flame (not muffled: it is right there)
    this.hissF = filt('bandpass', 3200, 0.8); this.hissG = gain(0);
    loop(this.white, 0.9).connect(this.hissF).connect(this.hissG).connect(this.fx);
    this.roarF = filt('lowpass', 240, 0.7); this.roarG = gain(0);
    loop(this.brown, 1.4).connect(this.roarF).connect(this.roarG).connect(this.fx);
    // music buses
    this.padBus = gain(0); this.padBus.connect(this.musF);
    this.pluckBus = gain(0); this.pluckBus.connect(this.musF);
    this.pulseBus = gain(0); this.pulseBus.connect(this.musF);
    this.bellBus = gain(0); this.bellBus.connect(this.music);
    this.on = true;
    this.master.gain.setTargetAtTime(0.9, ctx.currentTime, 0.5);
    this.applyVolumes();
    const h = document.getElementById('hint'); if (h) h.textContent = 'Space or click to let go';
  }
  ok() { return this.ctx && this.on && this.ctx.state === 'running'; }
  applyVolumes() {
    if (!this.ctx) return;
    const S = this.app.settings.data, t = this.ctx.currentTime;
    this.fx.gain.setTargetAtTime(S.fx, t, 0.1); this.music.gain.setTargetAtTime(S.music * 0.8, t, 0.1);
  }
  suspend(yes) { if (!this.ctx) return; try { if (yes) this.ctx.suspend(); else this.ctx.resume(); } catch { /* ignore */ } }
  env(g, t, a, peak, d) { g.gain.setValueAtTime(0, t); g.gain.linearRampToValueAtTime(peak, t + a); g.gain.exponentialRampToValueAtTime(0.0001, t + a + d); }
  noise(t, dur, type, f, q, peak, dest, buf = this.white, a = 0.003, sweep) {
    const c = this.ctx, s = c.createBufferSource(), fl = c.createBiquadFilter(), g = c.createGain();
    s.buffer = buf; fl.type = type; fl.frequency.setValueAtTime(f, t); fl.Q.value = q;
    if (sweep) fl.frequency.exponentialRampToValueAtTime(sweep, t + dur);
    this.env(g, t, a, peak, dur); s.connect(fl).connect(g).connect(dest); s.start(t, Math.random() * 1.2); s.stop(t + a + dur + 0.05);
  }
  tone(t, f, dur, type, peak, dest, a = 0.005, f2, pan = 0) {
    const c = this.ctx, o = c.createOscillator(), g = c.createGain();
    o.type = type; o.frequency.setValueAtTime(f, t); if (f2) o.frequency.exponentialRampToValueAtTime(f2, t + dur);
    this.env(g, t, a, peak, dur);
    if (pan && c.createStereoPanner) { const p = c.createStereoPanner(); p.pan.value = pan; o.connect(g).connect(p).connect(dest); } else o.connect(g).connect(dest);
    o.start(t); o.stop(t + a + dur + 0.05);
  }
  /** A khim-like pluck: a hammered string (fundamental + a slightly sharp octave, fast decay, a soft click). */
  pluck(t, f, peak, pan = 0) {
    this.tone(t, f, 1.6, 'triangle', peak, this.pluckBus, 0.002, null, pan);
    this.tone(t, f * 2.003, 0.7, 'sine', peak * 0.45, this.pluckBus, 0.002, null, pan);
    this.tone(t, f * 3.01, 0.25, 'sine', peak * 0.15, this.pluckBus, 0.001, null, pan);
  }
  pad(t, notes, peak, dur) {
    for (const f of notes) for (const det of [-4, 4]) {
      const o = this.ctx.createOscillator(), g = this.ctx.createGain(), lp = this.ctx.createBiquadFilter();
      o.type = f < 100 ? 'triangle' : 'sawtooth'; o.frequency.value = f; o.detune.value = det;
      lp.type = 'lowpass'; lp.frequency.value = 600 + f * 1.5; lp.Q.value = 0.3;
      g.gain.setValueAtTime(0.0001, t); g.gain.linearRampToValueAtTime(peak, t + dur * 0.35); g.gain.linearRampToValueAtTime(peak * 0.8, t + dur * 0.8); g.gain.exponentialRampToValueAtTime(0.0001, t + dur * 1.25);
      o.connect(lp).connect(g).connect(this.padBus); o.start(t); o.stop(t + dur * 1.3);
    }
  }
  ui(kind) {
    if (!this.ok()) return; const t = this.ctx.currentTime;
    if (kind === 'click') this.tone(t, 1180, 0.05, 'sine', 0.05, this.fx);
    else if (kind === 'tick') this.tone(t, 1600, 0.025, 'sine', 0.025, this.fx);
    else if (kind === 'open') this.tone(t, 740, 0.14, 'sine', 0.035, this.fx, 0.01, 1100);
  }
  /** The release: a breath of the crowd rising into a cheer, the whoosh of a thousand lanterns lifting. */
  release() {
    if (!this.ok()) return; const t = this.ctx.currentTime;
    for (let i = 0; i < 3; i++) this.noise(t + 0.1 + i * 0.05, 3.2, 'bandpass', [520, 900, 1800][i], 1.2, 0.12, this.ground, this.pink, 0.9);
    this.noise(t, 2.5, 'bandpass', 300, 0.6, 0.18, this.ground, this.pink, 0.6, 900);
    for (let i = 0; i < 28; i++) this.noise(t + 0.4 + rand(0, 2.2), 0.05, 'bandpass', rand(1400, 2600), 1.5, 0.05, this.ground, this.white, 0.002);
    this.swell(t + 0.2, 0.06);
  }
  swell(t, peak) { this.pad(t, CHORDS[0], peak, 6); }
  checkpoint(i) {
    if (!this.ok()) return; const t = this.ctx.currentTime, f = BELLS[(2 + i * 2) % BELLS.length];
    this.tone(t, f, 1.6, 'sine', 0.09, this.fx, 0.004); this.tone(t + 0.08, f * 1.5, 1.4, 'sine', 0.05, this.fx, 0.004);
    this.tone(t + 0.08, f * 3, 0.5, 'sine', 0.012, this.fx, 0.004);
  }
  /** A relight: the catch of a wick (a soft whoomp), then a plucked note that climbs the scale with your streak, a
   *  second voice a fifth up on a perfect pass. */
  relight(streak, perfect) {
    if (!this.ok()) return; const t = this.ctx.currentTime;
    this.noise(t, 0.35, 'bandpass', 700, 0.8, 0.09, this.fx, this.pink, 0.01, 2600);
    const scale = [293.66, 329.63, 369.99, 440.0, 493.88, 587.33, 659.25, 739.99, 880.0, 987.77, 1174.66];
    const f = scale[Math.min(streak - 1, scale.length - 1)];
    this.tone(t + 0.02, f, 1.4, 'triangle', 0.09, this.fx, 0.003); this.tone(t + 0.02, f * 2.003, 0.6, 'sine', 0.035, this.fx, 0.002);
    if (perfect) { this.tone(t + 0.09, f * 1.5, 1.2, 'sine', 0.06, this.fx, 0.004); this.tone(t + 0.09, f * 3, 0.4, 'sine', 0.015, this.fx, 0.004); }
  }
  /** A crash: paper crumpling, a hollow thump, the flame guttering. */
  /** A near miss: air torn past you (a falling whoosh) and a bright note that climbs with the count. */
  near(n) {
    if (!this.ok()) return; const t = this.ctx.currentTime;
    this.noise(t, 0.32, 'bandpass', 2400, 1.1, 0.08, this.fx, this.pink, 0.004, 500);
    const f = BELLS[Math.min(n - 1, BELLS.length - 1) % BELLS.length];
    this.tone(t + 0.04, f, 0.7, 'sine', 0.045, this.fx, 0.003, null, rand(-0.4, 0.4));
  }
  crash() {
    if (!this.ok()) return; const t = this.ctx.currentTime;
    this.tone(t, 110, 0.35, 'sine', 0.3, this.fx, 0.003, 45);
    for (let i = 0; i < 7; i++) this.noise(t + i * rand(0.02, 0.06), 0.05, 'bandpass', rand(1800, 4200), 1.6, 0.07, this.fx, this.white, 0.002);
    this.noise(t + 0.05, 0.9, 'bandpass', 1500, 0.9, 0.12, this.fx, this.white, 0.01, 300);
    [369.99, 329.63, 246.94].forEach((f, i) => this.pluck(t + 0.25 + i * 0.22, f, 0.035));
  }
  respawn() {
    if (!this.ok()) return; const t = this.ctx.currentTime;
    this.noise(t, 0.8, 'bandpass', 500, 0.7, 0.07, this.fx, this.pink, 0.2, 1500);
  }
  /** A knock: paper thump, crinkle, the flame guttering. */
  hit() {
    if (!this.ok()) return; const t = this.ctx.currentTime;
    this.tone(t, 130, 0.22, 'sine', 0.22, this.fx, 0.003, 60);
    this.noise(t, 0.18, 'bandpass', 2600, 1.4, 0.12, this.fx, this.white, 0.002);
    this.noise(t + 0.03, 0.5, 'lowpass', 900, 0.7, 0.16, this.fx, this.pink, 0.01, 200);
  }
  breakthrough() {
    if (!this.ok()) return; const t = this.ctx.currentTime;
    this.pad(t + 0.05, [73.42, 146.83, 220.0, 277.18, 329.63, 440.0, 554.37], 0.07, 9);
    for (let i = 0; i < 12; i++) { const f = BELLS[i % BELLS.length] * (i > 7 ? 2 : 1); this.tone(t + 0.15 + i * 0.11, f, 2.6, 'sine', 0.05, this.bellBus, 0.004, null, rand(-0.6, 0.6)); }
    this.noise(t, 1.6, 'bandpass', 600, 0.6, 0.1, this.fx, this.pink, 0.02, 2600);
  }
  flameOut() {
    if (!this.ok()) return; const t = this.ctx.currentTime;
    this.noise(t, 0.9, 'bandpass', 2200, 1, 0.12, this.fx, this.white, 0.005, 400);
    [440, 369.99, 329.63, 246.94].forEach((f, i) => this.pluck(t + 0.5 + i * 0.42, f, 0.05));
  }
  /** Per frame. s = { title, playing, alt, climb, flame, flicker, gap, cloud, out, done, timeScale } */
  update(dt, s) {
    if (!this.ok()) return;
    const c = this.ctx, t = c.currentTime;
    const alt = this.alt = lerp(this.alt, s.alt, 1 - Math.exp(-dt / 0.6));
    const cloud = this.cloud = lerp(this.cloud, s.cloud ? 1 : 0, 1 - Math.exp(-dt / 0.5));
    const calm = this.calm = lerp(this.calm, s.done ? 1 : 0, 1 - Math.exp(-dt / 1.5));
    const slow = s.timeScale < 0.9 ? 1 : 0;
    // the world outside: muffled in the cloud (and in the slow motion)
    this.outF.frequency.setTargetAtTime(cloud > 0.5 || slow ? 900 : 18000, t, 0.25);
    this.musF.frequency.setTargetAtTime(cloud > 0.5 ? 1400 : 18000, t, 0.4);
    // ground: fades with height (gone by ~250 m), the crowd quieter once the release is past
    const g = Math.exp(-alt / 70);
    this.riverG.gain.setTargetAtTime(0.12 * g, t, 0.3); this.ripG.gain.setTargetAtTime(0.05 * g * (0.6 + 0.4 * Math.sin(t * 0.7)), t, 0.4);
    this.crowd.forEach((v, i) => v.g.gain.setTargetAtTime(0.03 * g * (s.title ? 0.7 : 1) * (0.7 + 0.3 * Math.sin(t * (0.3 + i * 0.17) + i)), t, 0.6));
    // lapping and crickets (scheduled), only near the ground
    this.nextLap -= dt; if (g > 0.1 && this.nextLap <= 0) { this.noise(t, rand(0.12, 0.3), 'bandpass', rand(380, 900), 2, 0.05 * g, this.ground, this.pink, 0.02); this.nextLap = rand(0.2, 0.9); }
    this.nextCricket -= dt;
    if (g > 0.05 && this.nextCricket <= 0) {
      const f = rand(4100, 5200), pan = rand(-0.9, 0.9), n = 2 + Math.floor(Math.random() * 3);
      for (let k = 0; k < n; k++) this.tone(t + k * 0.034, f, 0.022, 'sine', 0.012 * g, this.ground, 0.002, null, pan);
      this.nextCricket = rand(0.08, 0.35);
    }
    // air: wind with height and climb; gusts in the gaps; in the cloud close and soft; gone in the moonlight
    const climb = clamp(s.climb / 30, 0, 1.3), gust = s.gap ? 0.6 + 0.4 * Math.sin(t * 7.3) * Math.sin(t * 2.1) : 0;
    const w = 0.7 * (0.03 + 0.12 * sstep(20, 600, alt) + 0.08 * climb + 0.16 * gust) * (1 - 0.7 * calm) * (s.title ? 0.3 : 1);
    this.windG.gain.setTargetAtTime(w, t, 0.15);
    this.windF.frequency.setTargetAtTime(260 + 500 * climb + 600 * gust + 200 * Math.random() * gust, t, 0.2);
    this.roughG.gain.setTargetAtTime((0.004 + 0.03 * gust + 0.01 * climb) * (1 - calm), t, 0.15);
    // your flame: a hiss with the flicker, a low roar under it; sputtering when weak; out = silence
    const fl = s.out ? 0 : s.flame;
    const sput = fl < 0.3 ? (Math.random() < 0.3 ? 0.2 : 1) : 1;
    const stoke = s.stoke ? 1 : 0;
    this.hissG.gain.setTargetAtTime((s.title ? 0.006 : 0.022 + 0.03 * stoke) * fl * s.flicker * sput, t, 0.04);
    this.roarG.gain.setTargetAtTime((s.title ? 0.02 : 0.05 + 0.12 * stoke) * fl * sput, t, stoke ? 0.05 : 0.15);
    this.roarF.frequency.setTargetAtTime(stoke ? 420 : 240, t, 0.1);
    this.nextCrackle -= dt;
    if (fl > 0.05 && this.nextCrackle <= 0) { this.noise(t, 0.01, 'bandpass', rand(2500, 4500), 1.2, 0.012 * fl, this.fx, this.white, 0.001); this.nextCrackle = rand(0.25, 1.4) / (0.5 + fl); }
    // ---- the score ----
    const play = s.playing && !s.out;
    const act = s.title ? 0.25 : play ? 0.4 + 0.6 * sstep(0, 800, alt) : s.done ? 0 : 0.15;
    this.padBus.gain.setTargetAtTime(0.055 * (s.title ? 0.8 : 1) * (s.out ? 0.3 : 1), t, 1.2);
    this.pluckBus.gain.setTargetAtTime(0.95 * (s.title ? 0.6 : act) * (s.gap ? 0.6 : 1) * (1 - 0.6 * cloud), t, 0.8);
    this.pulseBus.gain.setTargetAtTime(play ? 0.35 * (0.3 + 0.7 * act) * (s.gap ? 1.2 : 1) : 0, t, 0.6);
    this.bellBus.gain.setTargetAtTime(0.5 * Math.max(calm, s.title ? 0.4 : 0), t, 1.2);
    if (this.nextChord < t) {
      const ch = s.gap ? [[61.74, 123.47, 185.0, 246.94, 369.99]][0] : CHORDS[this.chord++ % 4];
      this.pad(t + 0.05, ch, 0.05, 8.5); this.nextChord = t + 8;
    }
    if (this.nextBeat < t) this.nextBeat = t + 0.05;
    const bpm = s.title ? 60 : 66 + 18 * act, spb = 60 / bpm;
    while (this.nextBeat < t + 0.25) {
      const bt = this.nextBeat, b = this.beat++;
      if (play && b % 2 === 0) { this.tone(bt, 62, 0.45, 'sine', 0.3, this.pulseBus, 0.004, 40); }
      // plucked line: one note a beat on the title, up to three as you climb; sparse in the cloud
      const per = s.title ? 1 : 1 + Math.round(2 * act * (1 - 0.7 * cloud));
      for (let k = 0; k < per; k++) {
        if (Math.random() < (s.title ? 0.55 : 0.8)) {
          const deg = [0, 2, 4, 3, 1, 4, 2, 0][(b * per + k) % 8] + (Math.random() < 0.25 ? 2 : 0);
          const oct = deg >= 5 ? 2 : 1, f = PENTA[deg % 5] * oct * (alt > 900 && Math.random() < 0.4 ? 2 : 1);
          this.pluck(bt + k * spb / per, f, 0.045, rand(-0.5, 0.5));
        }
      }
      this.nextBeat += spb;
    }
    // moonlight: slow bells
    if (Math.max(calm, s.title ? 0.4 : 0) > 0.05 && this.nextBell < t) {
      const f = BELLS[Math.floor(Math.random() * BELLS.length)];
      this.tone(t + 0.02, f, 2.4, 'sine', 0.05, this.bellBus, 0.005, null, rand(-0.5, 0.5)); this.tone(t + 0.02, f * 2, 1.2, 'sine', 0.012, this.bellBus, 0.005);
      this.nextBell = t + rand(1.4, 3.2);
    }
  }
}
