// The run's beats: what you play against, laid out by hand in YOUR plane (the lane's vertical plane across the view:
// you steer left / right in it and climb up it), so every danger reads from the camera behind you and every hit is
// one you could see coming. The background swarm (the release, the streams, the riders) is scenery around it.
// All of it is a function of the run's time (deterministic: a key log replays exactly).
//   1 LIFT-OFF       the release crush: lanterns lifting all round you; weave up through them (slow, 11 m/s)
//   2 CROSSCURRENTS  rows of lanterns carried across your climb by the wind, with gaps: thread them (22 m/s)
//   3 THE GUST       the wind turns: walls sweep across and the gust shoves you sideways (26 m/s)
//   4 ASH FALL       burnt-out lanterns falling through the climb, tumbling (26 m/s)
//   5 INTO THE CLOUD lanterns loom out of the fog (32 m/s), then the breakthrough
import { mulberry32 } from './util.js';

export const BEATS = [
  { name: 'Lift-off', hint: 'Weave up through the release', y0: 0, speed: 11 },
  { name: 'Crosscurrents', hint: 'Thread the gaps', y0: 45, speed: 22 },
  { name: 'The gust', hint: 'Gusts shove you side to side', y0: 175, speed: 26, gust: { y0: 182, y1: 300, push: 4 } },
  { name: 'Ash fall', hint: 'Dodge the burnt-out lanterns', y0: 320, speed: 21 },
  { name: 'Into the cloud', hint: 'They come out of the fog', y0: 495, speed: 32 },
];
// A HUMAN HAS TO MAKE IT (the user: "if you can't play it then a human won't be"): from passing one row to reaching the
// next there must be time to see the next gap, react (~0.25 s) and steer there (≤ 4.5 m ≈ 0.4 s) with some slack:
// ≥ 1.15 s between rows at the beat's climb. (Played at human latency: rows 18 m apart at 26 m/s, 0.7 s, and a 6 m
// step crashed me at row 6; the gust's walls were 0.75 s apart with the shove on top.)
const AIMO = {};
const hash = (x) => { const s = Math.sin(x * 127.1 + 311.7) * 43758.5453; return s - Math.floor(s); };
const ASH0 = 320, ASH_H = 170;   // the ash fall's band (m): ~7.5 s, then a breath of clear air before the cloud
export const LANE = 22;          // how far you can steer from the lane's centre line (m)
const ROW_SPAN = 26, ROW_STEP = 1.25;
// three gaps a row, 17.3 m apart: wherever you arrive (a crash, a stoke and the gaps have drifted metres), one is within
// ~8.7 m, reachable after a human's reaction even against the gust. (Played at human speed: with two, 26 m apart, a
// shifted arrival put the nearest gap 13 m away against the wind; and which gap to take is now a choice.)
const GAP_SEP = 2 * ROW_SPAN / 3;

/** The climb speed at height h: each beat's, blended over the first 20 m of the next. */
export function beatSpeed(h) {
  let v = BEATS[0].speed;
  for (let k = 1; k < BEATS.length; k++) { const b = BEATS[k], u = Math.min(Math.max((h - b.y0) / 20, 0), 1); v += (b.speed - v) * u; }
  return v;
}
export function beatAt(h) { let k = 0; while (k + 1 < BEATS.length && h >= BEATS[k + 1].y0) k++; return k; }
/** The gust's lateral push at height h (m/s, + to the right). */
/** The gust swings: each wall brings its own wind, alternately from the left and the right (the wall drifts and leans
 *  with it), turning over a few metres as you pass the wall before. (Played at human speed: a gust that always shoved
 *  right pinned me at the lane's edge after a crash, the next gap past the edge or 14 m into the wind.) */
export const GUST_WALLS = [196, 226, 256, 286];
export function gustSign(h) {
  let s = 1;
  for (let k = 1; k < GUST_WALLS.length; k++) {
    const u = Math.min(Math.max((h - (GUST_WALLS[k - 1] - 1)) / 6, 0), 1);   // turns over 6 m just past wall k−1
    s += ((k % 2 ? -1 : 1) - s) * u * u * (3 - 2 * u);
  }
  return s;
}
export function gustAt(h) {
  const g = BEATS[2].gust; if (h < g.y0 - 10 || h > g.y1 + 10) return 0;
  const u = Math.min((h - (g.y0 - 10)) / 20, 1, ((g.y1 + 10) - h) / 20);
  return g.push * Math.max(u, 0) * gustSign(h);
}

/** When an unhurried run reaches height h (s from letting go): the release's ramp, then each beat's climb. */
export function arrive(h) {
  let t = 2.4, y = 9;                        // (played: 9 m up at 2.4 s, as the release ramp ends)
  for (; y < h; y += 0.5) t += 0.5 / beatSpeed(y);
  return t;
}

/** The lanterns of every beat: [kind, …params] per slot of the game's pool; place(t) gives each one's plane
 *  position (x across, y up), flame and tumble at run time t. */
export class Course {
  constructor() {
    const r = mulberry32(2026), L = this.list = [];
    this.rows = [];                           // every row's drift and gaps (for a fair respawn)
    // 1 lift-off: 80 rising with you (a little slower than you), packed across the lane, wrapping in their band
    // (playing it: 40 read as a scatter you climbed past, not a crush you had to weave through)
    for (let k = 0; k < 80; k++) L.push({ kind: 'crush', x: (r() * 2 - 1) * 15, y0: 6 + r() * 39, v: 4.5 + r() * 1.5, ph: r() * 6.28 });
    // 2 crosscurrents: five rows, 26 m apart (1.18 s at 22 m/s), each sliding across (alternating) with two gaps half a
    // row apart, so one is always in your lane. They teach, then test: the first slow with wide gaps, the last faster
    // and tighter. The gaps make a path: when an unhurried climb reaches each row one gap sits a few metres from the last
    // row's, a step that grows to 4.5 m. (Playing it: one gap per row drifted out of the lane before I got there; gaps
    // drawn independently asked for a 10 m lunge.)
    // the rows drift slowly (1.5–3.5 m/s: the gap moves ≤ 1 m while you react to it); the challenge is the move between
    // rows, not chasing a gap (at 5.5 m/s the gap I had lined up slid 1.7 m out from under me)
    const rows2 = [62, 88, 114, 140, 166], sp2 = [1.5, 2, 2.5, 3, 3.5], gap2 = [4.8, 4.5, 4.3, 4.1, 3.9];
    // each row's gap is a real move from the last (zigzag, 2.5–5.5 m: more than half a gap, so holding your line never
    // threads two rows), within what a human can make in the 1.2 s between them. (Played at human speed: steps drawn
    // either way let three rows line up, and I passed them without touching a key.)
    const step2 = [[2.5, 3.5], [3, 4], [3, 4.5], [3.5, 5], [3.5, 5.5]];
    let px = 0, sgn = r() < 0.5 ? -1 : 1;
    rows2.forEach((h, j) => {
      const d = step2[j][0] + r() * (step2[j][1] - step2[j][0]);
      if (Math.abs(px + sgn * d) > 9) sgn = -sgn;
      px += sgn * d; sgn = -sgn;
      this.row(L, r, h, (j % 2 ? -1 : 1) * (sp2[j] + 0.5 * r()), gap2[j], 'row', px);
    });
    // 3 the gust: four walls 30 m apart (1.15 s at 26 m/s), each swept across by its own gust (alternately right and
    // left), three gaps each. The gust carries you; each wall's gap is where it would carry you, less 3–5 m: lean into
    // the wind (counter-steer) a readable amount at every wall. (Played at human speed: a path laid without the drift put wall
    // 2's gap 12 m against the shove, seen 0.8 s out: nobody makes that.)
    let hPrev = rows2[rows2.length - 1];
    GUST_WALLS.forEach((h, j) => {
      let drift = 0; for (let y = hPrev; y < h; y += 0.5) drift += gustAt(y) * 0.5 / beatSpeed(y);
      const dir = j % 2 ? -1 : 1;                                   // this wall's wind
      px = Math.max(-14, Math.min(14, px + drift - dir * (3 + 2 * r()))); hPrev = h;
      // the walls hang still, leaning with their wind: the shove is this beat's one motion. (Played at human speed:
      // walls sweeping at 11–13 m/s moved their gap ~7 m between seeing it and arriving; at 4–6 m/s, gap drift + wind +
      // my steering together still had me misjudge by a metre)
      this.row(L, r, h, 0, 5.0, 'wall', px, dir);
    });
    // 4 ash fall: burnt-out lanterns falling through the band, tumbling: about one in your path every second
    // (playing it: 45 across ±20 m closing at 50 m/s were two or three red streaks a frame, 0.5 s from the top edge)
    // (spaced evenly in height and falling together, so the rain is steady: drawn at random they clumped and left my
    // line empty for 2 s; at 90 my line still went quiet for a second at a time). Closing at 30 + 7 m/s, one that
    // looked far at the top of the frame was on me 0.25 s later: the climb eases to 24 m/s here, the ash to 6.
    // (played at human speed: a lantern behind a closer one on my line, both red on red, read as one: hit the second.
    // Fewer, so each reads on its own and there is a clear way between; dodging one is a decision, not a guess)
    // About one on your line every 2 s if you hold still (40 left 4 s without one; 55 put a second one where my dodge
    // went — twice in one run at human latency). Spread so a dodge never lands on the next one: lanterns within half a second of each other (14 m of climb) are
    // ≥ 4 m apart across. (Played at human speed: two stacked on my line 4.8 m apart — dodging the first put me under
    // the second, 0.18 s away.)
    // The rhythm: SEEK of them fall on YOUR line — each takes aim at where you are ~1.2 s before it reaches you (see
    // aim()), one about every 1.1 s, so the beat is a steady run of dodges you can read. (Played at human speed: a
    // random scatter swung between 5 s with nothing on my line and two stacked where my dodge went.)
    // Around them a thin scatter for texture (dense, it was where every dodge landed: 3 crashes at human speed).
    const ASH_SEEK = 6;
    for (let k = 0; k < ASH_SEEK; k++) L.push({ kind: 'ash', seek: true, x: 0, y0: (k + 0.5) / ASH_SEEK * ASH_H, v: 5, ph: r() * 6.28 });
    this.spread(L, r, 'ash', 18, ASH_H, 13, 6, (x, y0) => ({ kind: 'ash', x, y0, v: 4.8 + r() * 0.4, ph: r() * 6.28 }), 12);
    // 5 the cloud: drifting lanterns, slow, coming out of the fog; closer together than the ash (the last test)
    for (let k = 0; k < 6; k++) L.push({ kind: 'cloud', seek: true, x: 0, y0: 535 + (k + 0.5) / 6 * 255, v: 3, ph: r() * 6.28 });
    this.spread(L, r, 'cloud', 22, 255, 12, 6, (x, y0) => ({ kind: 'cloud', x, y0: 535 + y0, v: 2.8 + r() * 0.4, ph: r() * 6.28 }), 12);
  }
  /** n lanterns evenly up a band of height H (it wraps), each placed at random across (±lim m), at least sep from those
   *  within dy of it (else the best of 80 tries). */
  spread(L, r, kind, n, H, dy, sep, make, lim = 14) {
    const put = [];
    for (let k = 0; k < n; k++) {
      const y0 = (k + 0.8 * r()) / n * H;
      let bx = 0, bd = -1;
      for (let a = 0; a < 80; a++) {
        const x = (r() * 2 - 1) * lim; let d = 1e9;
        for (const q of put) { let e = Math.abs(q[1] - y0); e = Math.min(e, H - e); if (e < dy) d = Math.min(d, Math.abs(q[0] - x)); }
        if (d > bd) { bd = d; bx = x; }
        if (d >= sep) break;               // (the first that is far enough: maximising the distance laid them on a
                                           // lattice of columns with the middle always clear)
      }
      put.push([bx, y0]); L.push(make(bx, y0));
    }
  }
  /** The next gap on the path: a step of 1.5…step metres either way from x, kept within ±lim. */
  next(r, x, step, lim) {
    const d = (1.5 + r() * (step - 1.5)) * (r() < 0.5 ? -1 : 1);
    let n = x + d; if (Math.abs(n) > lim) n = x - d;
    return Math.max(-lim, Math.min(lim, n));
  }
  /** A row at height h drifting at vx with three gaps (GAP_SEP apart); one is at xa when the climb is expected to reach
   *  it (arrive(h)). */
  row(L, r, h, vx, gap, kind, xa, dir = Math.sign(vx)) {
    const w = (a) => ((a + ROW_SPAN) % (2 * ROW_SPAN) + 2 * ROW_SPAN) % (2 * ROW_SPAN) - ROW_SPAN;
    const gx = w(xa - vx * arrive(h)), gs = [0, 1, 2].map((k) => w(gx + k * GAP_SEP));
    this.rows.push({ h, vx, gx, gap });
    for (let x = -ROW_SPAN; x < ROW_SPAN; x += ROW_STEP) {
      if (gs.some((g) => Math.abs(w(x - g)) < gap / 2)) continue;
      L.push({ kind, x, y0: h + (r() - 0.5) * 0.5, v: vx, dir, ph: r() * 6.28, d: (r() - 0.5) * 0.25 });
    }
  }
  /** The seekers take aim: on each pass one drifts across toward your line (≤ 3.5 m/s, like the wind carrying it) until
   *  it is AIM m above you, then holds that line. Called once a tick by the game; deterministic in your inputs. (A lock
   *  made in view jumped; one made far up aimed where you were 2.5 s ago.) */
  aim(t, py, px, dt) {
    for (let k = 0; k < this.list.length; k++) {
      const c = this.list[k]; if (!c.seek) continue;
      const cyc = this.cycle(c, t);
      if (c.cyc !== cyc) { c.cyc = cyc; c.held = false; c.sx = px + (hash(cyc * 3.7 + c.ph) < 0.5 ? -1 : 1) * (6 + 6 * hash(cyc + c.ph)); }
      if (c.held) continue;
      const dy = this.place(k, t, AIMO).y - py;
      if (dy < 0) { c.held = true; continue; }
      if (dy < 30) { c.held = true; c.sx = Math.max(-LANE, Math.min(LANE, c.sx)); continue; }
      const want = px + 0.6 * (hash(cyc * 7.1 + c.ph) - 0.5), m = 3.5 * dt;
      c.sx += Math.max(-m, Math.min(m, want - c.sx));
    }
  }
  resetAim() { for (const c of this.list) if (c.seek) { c.cyc = null; c.held = false; c.sx = 30; } }
  cycle(c, t) { return c.kind === 'ash' ? Math.floor((c.y0 + c.v * t) / ASH_H) : Math.floor((c.y0 - 535 + c.v * t) / 255); }
  /** The first row above height h (or null) and the centre of its gap nearest x0 that is inside your lane at time t. */
  firstRowAbove(h) { return this.rows.find((rw) => rw.h > h + 4) || null; }
  gapX(rw, t, x0) {
    const w = (a) => ((a + ROW_SPAN) % (2 * ROW_SPAN) + 2 * ROW_SPAN) % (2 * ROW_SPAN) - ROW_SPAN;
    let best = 0, bd = 1e9;
    for (let k = 0; k < 3; k++) { const g = rw.gx + k * GAP_SEP;
      const x = w(g + rw.vx * t); if (Math.abs(x) > LANE - 1) continue;
      if (Math.abs(x - x0) < bd) { bd = Math.abs(x - x0); best = x; }
    }
    return best;
  }
  /** A seeker's line now (aim() moves it). */
  seekX(c) { return c.sx ?? 30; }
  /** Lantern k at time t → out { x, y, d (depth off the plane), flame, tx, tz, lean (rad, toward +x) }. */
  place(k, t, out) {
    const c = this.list[k], w = (a) => ((a + ROW_SPAN) % (2 * ROW_SPAN) + 2 * ROW_SPAN) % (2 * ROW_SPAN) - ROW_SPAN;
    out.d = c.d || 0; out.tx = 0; out.tz = 0; out.flame = 1; out.lean = 0;
    if (c.kind === 'crush') { out.x = c.x + 0.6 * Math.sin(t * 0.7 + c.ph); out.y = 6 + ((c.y0 - 6 + c.v * t) % 40); }
    else if (c.kind === 'row' || c.kind === 'wall') {
      out.x = w(c.x + c.v * t); out.y = c.y0 + 0.15 * Math.sin(t * 1.3 + c.ph);
      // they lean into their drift (the top leads): a hint in the crosscurrents, pressed over in the gust
      out.lean = (c.kind === 'wall' ? 0.34 : 0.1) * c.dir + (c.kind === 'wall' ? 0.08 : 0.04) * Math.sin(t * (c.kind === 'wall' ? 3.3 : 2.1) + c.ph);
    }
    else if (c.kind === 'ash') {
      out.x = (c.seek ? this.seekX(c) : c.x) + 0.4 * Math.sin(t * 0.9 + c.ph);
      out.y = ASH0 + (ASH_H - ((c.y0 + c.v * t) % ASH_H));
      out.flame = 0.06; out.tx = 0.6 * Math.sin(t * 1.4 + c.ph); out.tz = 0.5 * Math.cos(t * 1.1 + c.ph);
    } else { out.x = (c.seek ? this.seekX(c) : c.x) + 0.4 * Math.sin(t * 0.5 + c.ph); out.y = 535 + ((c.y0 - 535 + c.v * t) % 255); }
    return out;
  }
}
