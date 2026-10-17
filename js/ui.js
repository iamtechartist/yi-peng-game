// The interface, ported from Eye of the Storm's liquid-glass UI: Settings (localStorage, every access guarded), the
// HUD (beat pill: the beat, the run's time and your near misses / crashes, a progress ring to the cloud top;
// altitude / climb, the stoke ring, warnings, near-miss pops, controls card, big messages) and the Menus (title,
// settings, pause, results; keyboard navigable). Text is written only on change.
import * as THREE from 'three';
import { CLOUD } from './clouds.js';
import { BEATS, gustAt } from './beats.js';

const $ = (id) => document.getElementById(id);
export const fmtTime = (s) => { const m = Math.floor(s / 60), r = s - m * 60; return `${m}:${r < 10 ? '0' : ''}${r.toFixed(1)}`; };

/* ---------------- settings ---------------- */
export class Settings {
  constructor() {
    const rm = !!(window.matchMedia && matchMedia('(prefers-reduced-motion: reduce)').matches);
    this.data = { quality: 'auto', music: 0.6, fx: 0.85, mouse: true, shake: !rm, fps: false, seenControls: false };
    try { const s = localStorage.getItem('lanternNight.settings.v1'); if (s) Object.assign(this.data, JSON.parse(s)); } catch { /* storage unavailable */ }
    this.onChange = null;
  }
  save() { try { localStorage.setItem('lanternNight.settings.v1', JSON.stringify(this.data)); } catch { /* storage unavailable */ } }
  set(k, v) { this.data[k] = v; this.save(); if (this.onChange) this.onChange(k, v); }
}

/* ---------------- HUD ---------------- */
const V = new THREE.Vector3();
const TOP = () => CLOUD.colTop + 60;            // the altitude bar's scale: the run ends above the cloud
export class HUD {
  constructor(app) {
    this.app = app;
    this.el = { beat: $('beat'), lbl: $('beatLbl'), lit: $('litN'), litOf: $('litOf'), litLine: $('litLine'), mult: $('mult'), pts: $('pts'), prog: $('beatProg'),
      alt: $('rAlt'), climb: $('rClimb'), altBar: $('altBar'), altCloud: $('altCloud'), flame: $('rFlame'), ring: $('flameRing'), flameBox: $('flameBox'),
      toasts: $('toasts'), ctrl: $('ctrlCard'), big: $('bigmsg'), bigSub: $('bigsub'), fps: $('fps'), brackets: $('brackets'), pops: $('pops') };
    this.warn = { wind: $('wWind'), flame: $('wFlame'), cloud: $('wCloud') };
    this.last = {}; this.beatKey = ''; this.cloudT = 0; this.wasCloud = false; this.ctrlT = 0; this.spentT = 0;
    this.el.altCloud.style.bottom = `${(CLOUD.base / TOP()) * 100}%`;
  }
  set(key, el, v) { if (this.last[key] !== v) { this.last[key] = v; el.textContent = v; } }
  style(key, el, prop, v) { if (this.last[key] !== v) { this.last[key] = v; el.style[prop] = v; } }
  cls(key, el, name, on) { if (this.last[key] !== on) { this.last[key] = on; el.classList.toggle(name, on); } }

  beatOf(G) {
    if (G.state === 'break' || G.state === 'done') return 'Moonlight';
    if (G.state === 'crash') return 'Crashed';
    return BEATS[G.beat].name;
  }

  update(dt) {
    const G = this.app.game, e = this.el;
    if (!G) return;
    const name = this.beatOf(G);
    if (name !== this.beatKey) { this.beatKey = name; e.lbl.textContent = name; e.beat.classList.remove('flash'); void e.beat.offsetWidth; e.beat.classList.add('flash'); }
    this.set('lit', e.lit, String(Math.min(G.beat + 1, BEATS.length)));
    this.set('litof', e.litOf, ` of ${BEATS.length}`);
    // the run's time (clock + penalties − near misses), and what went into it
    this.set('mult', e.mult, fmtTime(G.state === 'break' || G.state === 'done' ? G.result.time : G.time));
    this.cls('multon', e.mult, 'on', G.state !== 'ready');
    this.set('pts', e.pts, `${G.nears} near${G.crashes ? ` · ${G.crashes} crash${G.crashes > 1 ? 'es' : ''}` : ''}`);
    const prog = Math.max(0, Math.min(1, G.p.y / CLOUD.colTop));
    this.style('prog', e.prog, 'strokeDasharray', `${(prog * 100.5).toFixed(1)} 101`);
    this.set('alt', e.alt, String(Math.round(G.p.y)));
    const vy = Math.round(G.v.y);
    this.set('climb', e.climb, `${vy > 0 ? '+' : vy < 0 ? '−' : ''}${Math.abs(vy)}`);
    this.style('altbar', e.altBar, 'height', `${Math.min(100, (G.p.y / TOP()) * 100).toFixed(1)}%`);
    // the flame meter (stoke)
    const f = G.meter;
    this.set('flame', e.flame, String(Math.round(f * 100)));
    this.style('ring', e.ring, 'strokeDasharray', `${(f * 106.8).toFixed(1)} 106.8`);
    this.style('ringc', e.ring, 'stroke', G.stokeOn ? '#FFE7C2' : f < 0.2 ? '#FF6B5E' : '#FFB547');
    const flying = G.state === 'fly';
    if (flying && G.wantStoke() && f <= 0.02) this.spentT = 1.2; else this.spentT = Math.max(0, this.spentT - dt);
    // warnings: the gust while it shoves you; the cloud as you enter it; the stoke spent
    const inCloud = flying && G.p.y > CLOUD.base;
    if (inCloud && !this.wasCloud) this.cloudT = 2.4;
    this.wasCloud = inCloud; this.cloudT = Math.max(0, this.cloudT - dt);
    this.cls('wwind', this.warn.wind, 'on', flying && Math.abs(gustAt(G.p.y)) > 1);
    this.cls('wflame', this.warn.flame, 'on', this.spentT > 0);
    this.cls('wcloud', this.warn.cloud, 'on', flying && this.cloudT > 0);
    if (this.ctrlT > 0) { this.ctrlT -= dt; if (this.ctrlT <= 0 || G.lastInput > 2.5) this.hideControls(); }
    if (document.body.classList.contains('showfps')) this.set('fps', e.fps, `${this.app.fps.toFixed(0)} fps · ${this.app.tierName}`);
  }

  pop(pos, text, sub, miss = false) {
    V.copy(pos); V.y += 0.5; V.project(this.app.camera);
    if (V.z > 1) return;
    const x = (V.x * 0.5 + 0.5) * innerWidth, y = (0.5 - V.y * 0.5) * innerHeight;
    const d = document.createElement('div');
    d.className = `pop${miss ? ' miss' : ''}`; d.innerHTML = `${text}${sub ? `<small>${sub}</small>` : ''}`;
    d.style.setProperty('--t', `translate(${x.toFixed(0)}px, ${y.toFixed(0)}px) translate(-50%, -100%)`);
    this.el.pops.appendChild(d);
    while (this.el.pops.children.length > 6) this.el.pops.firstChild.remove();
    setTimeout(() => d.remove(), 1200);
  }
  /** A near miss: a pop where the lantern passed you, the tally bumps. */
  near(n, pos) {
    this.pop(pos, 'Close', '−0.25 s');
    const l = this.el.pts; l.classList.remove('bump'); void l.offsetWidth; l.classList.add('bump');
  }
  /** A new beat: its name and what to do, briefly, in the middle of the frame. */
  beat(n, b) { this.big(b.name, b.hint, 1500); }
  crash(e) {
    this.big('Crashed', `Back to ${e.name} · +2 s`, 1100);
    const b = this.el.flameBox; b.classList.remove('hit'); void b.offsetWidth; b.classList.add('hit');
  }

  toast(title, value, warn = false) {
    const t = document.createElement('div');
    t.className = 'toast glass pill'; t.innerHTML = `${title}${value ? ` <b${warn ? ' style="color:var(--red)"' : ''}>${value}</b>` : ''}`;
    this.el.toasts.appendChild(t);
    while (this.el.toasts.children.length > 3) this.el.toasts.firstChild.remove();
    setTimeout(() => t.remove(), 2500);
  }
  big(msg, sub, ms = 3200) {
    const e = this.el; e.big.textContent = msg; e.bigSub.textContent = sub || '';
    e.big.classList.add('on'); clearTimeout(this._bt); if (ms) this._bt = setTimeout(() => e.big.classList.remove('on'), ms);
  }
  hideBig() { clearTimeout(this._bt); this.el.big.classList.remove('on'); }
  showControls() {
    const k = (keys, label) => `<span class="k">${keys.map((x) => `<kbd>${x}</kbd>`).join('')}${label}</span>`;
    this.el.ctrl.innerHTML = `<div class="ks">${k(['A', 'D'], 'Steer')}${k(['Mouse'], 'Hold to steer')}${k(['Space'], 'Stoke')}${k(['Shift'], 'Ease off')}${k(['R'], 'Again')}${k(['Esc'], 'Pause')}</div>`
      + '<div class="note">Yours is the <b style="color:#FF7A5C">crimson</b> lantern with the ring. The line above it is where you will pass: keep it off the lanterns coming at you.</div>';
    this.el.ctrl.classList.add('on'); this.ctrlT = 6;
  }
  hideControls() { this.ctrlT = 0; this.el.ctrl.classList.remove('on'); }
}

/* ---------------- menus ---------------- */
export class Menus {
  constructor(app) {
    this.app = app; this.stack = [];
    this.panels = { title: $('title'), settings: $('settings'), pause: $('pause'), results: $('results') };
    document.querySelectorAll('#menus [data-act]').forEach((b) => b.addEventListener('click', (e) => { e.stopPropagation(); this.act(b.dataset.act); }));
    this.buildSettings();
    addEventListener('keydown', (e) => this.key(e), true);
  }
  open(name) {
    for (const k in this.panels) this.panels[k].classList.toggle('on', k === name);
    this.current = name;
    if (name) { const P = this.panels[name], f = P.querySelector('.btn.primary') || P.querySelector('button'); if (f) setTimeout(() => f.focus({ preventScroll: true }), 60); }
    this.app.audio?.ui('open');
  }
  close() { for (const k in this.panels) this.panels[k].classList.remove('on'); this.current = null; }
  act(a) {
    const A = this.app, G = A.game;
    A.audio?.unlock(); A.audio?.ui('click');
    if (a === 'start') { this.close(); A.startRun(); }
    else if (a === 'settings') { this.back = this.current; this.open('settings'); }
    else if (a === 'back') { this.open(this.back || 'title'); }
    else if (a === 'resume') { this.close(); A.pause(false); }
    else if (a === 'retry') { this.close(); A.pause(false, true); G.retry(true); }
    else if (a === 'quit') { this.close(); A.pause(false, true); A.toTitle(); }
  }
  key(e) {
    if (!this.current) return;
    const items = [...this.panels[this.current].querySelectorAll('button, input')].filter((b) => b.offsetParent !== null);
    const i = items.indexOf(document.activeElement);
    if (e.code === 'ArrowDown' || e.code === 'ArrowUp') {
      if (document.activeElement && document.activeElement.type === 'range') return;
      e.preventDefault(); const n = items.length; if (!n) return;
      items[(i + (e.code === 'ArrowDown' ? 1 : -1) + n) % n].focus(); this.app.audio?.ui('tick');
    } else if (e.code === 'Escape' && this.current === 'settings') { e.preventDefault(); e.stopImmediatePropagation(); this.act('back'); }
  }
  /** Your best on the title card. */
  refreshTitle() {
    const b = this.app.game?.best;
    $('titleBest').textContent = b ? fmtTime(b.time) : '';
    $('titleMedals').innerHTML = b ? `<div class="medal ${b.medal || ''}"></div><span>Best ${fmtTime(b.time)}${b.medal ? ' · ' + b.medal : ''}</span>` : '<span>Gold under 0:32 · silver 0:36 · bronze 0:42</span>';
  }
  showResults(r) {
    $('resMedal').className = `medal ${r.medal || ''}`;
    $('resSub').textContent = r.medal ? `${r.medal} · through the cloud` : 'Through the cloud';
    $('resTime').textContent = fmtTime(r.time);
    const best = this.app.game.best;
    const rows = [['Climb', fmtTime(r.clock)], ['Crashes', `${r.crashes}${r.crashes ? ` · +${r.penalty.toFixed(0)} s` : ''}`], ['Near misses', `${r.nears} · −${(r.nears * 0.25).toFixed(2)} s`]];
    $('resScore').innerHTML = rows.map(([a, b]) => `<span>${a}</span><span>${b}</span>`).join('')
      + `<span class="div"></span><span class="tot">Time</span><span class="tot">${fmtTime(r.time)}</span>`
      + (r.isBest ? '<span class="best">New best</span><span class="best">★</span>' : (best ? `<span>Best</span><span>${fmtTime(best.time)}</span>` : ''));
    this.open('results');
  }
  buildSettings() {
    const S = this.app.settings, body = $('settingsBody');
    const seg = (k, label, opts, note) => `<div class="set"><label>${label}</label><div class="ctl"><div class="seg" data-k="${k}">${opts.map(([v, t]) => `<button data-v="${v}">${t}</button>`).join('')}</div></div>${note ? `<div class="note">${note}</div>` : ''}</div>`;
    const range = (k, label) => `<div class="set"><label for="s_${k}">${label}</label><div class="ctl"><input type="range" id="s_${k}" data-k="${k}" min="0" max="1" step="0.05"><output data-for="${k}"></output></div></div>`;
    const tog = (k, label) => `<div class="set"><label>${label}</label><div class="ctl"><button class="tog" role="switch" data-k="${k}" aria-label="${label}"></button></div></div>`;
    body.innerHTML = '<h3>Picture</h3>' + seg('quality', 'Quality', [['auto', 'Auto'], ['low', 'Low'], ['medium', 'Medium'], ['high', 'High']], 'Auto starts from your graphics card and eases the cloud resolution if frames run long.')
      + tog('fps', 'Show frame rate') + tog('shake', 'Camera shake on a knock')
      + '<h3>Sound</h3>' + range('music', 'Music') + range('fx', 'Effects')
      + '<h3>Controls</h3>' + tog('mouse', 'Hold the mouse to steer toward the cursor')
      + '<div class="keys" style="margin-top:8px"><b>W A S D / arrows</b><span>steer (relative to the view)</span><b>Mouse (hold)</b><span>steer toward the cursor</span><b>Space / click</b><span>let go</span><b>R</b><span>start again</span><b>Esc / P</b><span>pause</span></div>';
    const sync = () => {
      body.querySelectorAll('.seg').forEach((g) => g.querySelectorAll('button').forEach((b) => b.setAttribute('aria-pressed', String(S.data[g.dataset.k] === b.dataset.v))));
      body.querySelectorAll('input[type=range]').forEach((i) => { i.value = S.data[i.dataset.k]; i.style.setProperty('--p', `${i.value * 100}%`); body.querySelector(`output[data-for=${i.dataset.k}]`).textContent = `${Math.round(i.value * 100)}`; });
      body.querySelectorAll('.tog').forEach((t) => t.setAttribute('aria-checked', String(!!S.data[t.dataset.k])));
    };
    body.addEventListener('click', (e) => {
      const b = e.target.closest('button'); if (!b) return;
      if (b.classList.contains('tog')) S.set(b.dataset.k, !S.data[b.dataset.k]);
      else if (b.parentElement.classList.contains('seg')) S.set(b.parentElement.dataset.k, b.dataset.v);
      this.app.audio?.ui('click'); sync();
    });
    body.addEventListener('input', (e) => { const i = e.target; if (i.type === 'range') { S.set(i.dataset.k, +i.value); sync(); } });
    sync();
  }
}
