// QualityManager (Eye of the Storm's): the starting tier from a quick look at the GPU (or the setting / ?tier=);
// Low / Medium / High switch live (MSAA, reflection scale, depth of field, mist, bloom, stars, air, cloud resolution
// and steps, pixel budget; the noise volumes keep their size until the next load). ADAPTIVE while playing: if the
// average frame stays over 18 ms for 2 s the cloud resolution drops first (×0.85, to 62 % of the tier's), then the
// pixel ratio (×0.88, to 0.6); both climb back after 3.5 s under 12.5 ms.
import { CONFIG, URLP } from './config.js';

export class QualityManager {
  constructor(app, pref = 'auto') {
    this.app = app; this.prScale = 1; this.hist = new Float32Array(120); this.hn = 0; this.hi = 0; this.over = 0; this.under = 0; this.avg = 16.7;
    const forced = URLP.get('tier');
    this.auto = !CONFIG.tiers[forced] && !CONFIG.tiers[pref];
    this.name = CONFIG.tiers[forced] ? forced : CONFIG.tiers[pref] ? pref : this.probe();
  }
  probe() {
    try {
      const gl = this.app.renderer.getContext();
      const ext = gl.getExtension('WEBGL_debug_renderer_info');
      const s = ext ? String(gl.getParameter(ext.UNMASKED_RENDERER_WEBGL)) : '';
      const mobile = matchMedia('(pointer: coarse)').matches && Math.min(screen.width, screen.height) < 820;
      if (/SwiftShader|llvmpipe|Software|Mali-[GT]\d|Adreno \(TM\) [3-6]|PowerVR|Intel.*(UHD|HD) Graphics|Intel HD/i.test(s) || mobile) return 'low';
      if (/Apple M[2-9] (Pro|Max|Ultra)|RTX [34]0[7-9]0|RTX [45]0[89]0|Radeon RX [67][89]00/i.test(s)) return 'high';
      return 'medium';
    } catch { return 'medium'; }
  }
  /** Switch tier live. */
  apply(name) {
    const A = this.app, t = { ...CONFIG.tiers[name] };
    if (!t) return;
    this.name = name; A.tierName = name; A.tier = t; this.prScale = 1; this.hn = 0;
    A.sky.setStarCount(t.stars);
    A.refl.scale = t.refl;
    A.post.setMSAA(t.msaa);
    Object.assign(A.post.dof, { maxR: t.dofR, step: t.dofStep });
    A.post.prep.uniforms.uMist2.value.w = t.mist; A.post.prep.uniforms.uAir.value.w = t.air || 10;
    A.post.bloomLevels = t.bloom;
    A.clouds.setTier(t); A.clouds.baseScale = A.clouds.scale;
    A.resize();
  }
  /** Per frame while playing (dt in ms). */
  sample(dtMs) {
    if (!this.auto || dtMs > 80 || document.hidden) return;
    this.hist[this.hi] = dtMs; this.hi = (this.hi + 1) % 120; this.hn = Math.min(120, this.hn + 1);
    let sum = 0; const n = Math.min(this.hn, 40);
    for (let i = 0; i < n; i++) sum += this.hist[(this.hi - 1 - i + 120) % 120];
    const avg = this.avg = sum / n;
    if (avg > 18) { this.over += dtMs; this.under = 0; } else if (avg < 12.5) { this.under += dtMs; this.over = 0; } else { this.over = Math.max(0, this.over - dtMs); this.under = 0; }
    const cl = this.app.clouds, base = cl.baseScale || cl.scale;
    if (this.over > 2000) {
      this.over = 0; this.hn = 0;
      if (cl.scale > base * 0.62) { cl.scale = Math.max(base * 0.62, cl.scale * 0.85); this.app.resize(); }
      else if (this.prScale > 0.6) { this.prScale = Math.max(0.6, this.prScale * 0.88); this.app.resize(); }
    }
    if (this.under > 3500) {
      this.under = 0; this.hn = 0;
      if (this.prScale < 1) { this.prScale = Math.min(1, this.prScale / 0.88); this.app.resize(); }
      else if (cl.scale < base) { cl.scale = Math.min(base, cl.scale / 0.85); this.app.resize(); }
    }
  }
}
