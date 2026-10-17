// The night sky: a moonlit Rayleigh/Mie sky (Eye of the Storm's sky-view LUT solver with the full moon as
// the light source), the moon disc, real-looking stars (points with magnitudes and colours, never sprites
// of anything: a star IS a point), a faint Milky Way and the city's light pollution at the horizon.
import * as THREE from 'three';
import { FullScreenQuad } from 'three/addons/postprocessing/Pass.js';
import { FS_VERT, COMMON, SKY } from './glsl.js';
import { CONFIG } from './config.js';
import { DEG, TAU, mulberry32, blackbody } from './util.js';

/* Analytic single-scattering sky (Rayleigh + Mie) baked into a sky-view LUT (azimuth × elevation, extra
   resolution near the horizon). Verbatim from Eye of the Storm. */
const SKY_LUT = COMMON + /* glsl */`
in vec2 vUv;
uniform vec3 uSunDir;
uniform float uSunI;
layout(location = 0) out vec4 fragColor;
const float Re = 6360e3, Ra = 6420e3;
const vec3 bR = vec3(5.8e-6, 13.5e-6, 33.1e-6);
const float bM = 9e-6;
vec2 raySphere(vec3 ro, vec3 rd, float R) {
  float b = dot(ro, rd), c = dot(ro, ro) - R * R, h = b * b - c;
  if (h < 0.0) return vec2(-1.0);
  h = sqrt(h); return vec2(-b - h, -b + h);
}
void main() {
  float az = (vUv.x - 0.5) * 2.0 * PI;
  float v = vUv.y - 0.5;
  float el = sign(v) * sq(2.0 * abs(v)) * 0.5 * PI;
  el = max(el, -0.02);
  vec3 dir = vec3(cos(el) * cos(az), sin(el), cos(el) * sin(az));
  vec3 ro = vec3(0.0, Re + 300.0, 0.0);
  vec2 ta = raySphere(ro, dir, Ra);
  vec2 tg = raySphere(ro, dir, Re);
  float tMax = ta.y;
  if (tg.x > 0.0) tMax = min(tMax, tg.x);
  const int N = 16;
  float ds = tMax / float(N);
  float odR = 0.0, odM = 0.0, odO = 0.0;
  vec3 sumR = vec3(0.0), sumM = vec3(0.0);
  const vec3 bO = vec3(0.65e-6, 1.881e-6, 0.085e-6);
  for (int i = 0; i < N; i++) {
    vec3 pos = ro + dir * (float(i) + 0.5) * ds;
    float h = length(pos) - Re;
    float hr = exp(-h / 8000.0) * ds, hm = exp(-h / 1200.0) * ds;
    odR += hr; odM += hm; odO += max(0.0, 1.0 - abs(h - 25000.0) / 15000.0) * ds;
    vec2 tl = raySphere(pos, uSunDir, Ra);
    float dl = tl.y / 6.0, lR = 0.0, lM = 0.0, lO = 0.0; bool shadow = false;
    for (int j = 0; j < 6; j++) {
      vec3 q = pos + uSunDir * (float(j) + 0.5) * dl;
      float hh = length(q) - Re;
      if (hh < 0.0) { shadow = true; break; }
      lR += exp(-hh / 8000.0) * dl; lM += exp(-hh / 1200.0) * dl; lO += max(0.0, 1.0 - abs(hh - 25000.0) / 15000.0) * dl;
    }
    if (shadow) continue;
    vec3 tau = bR * (odR + lR) + bM * 1.1 * (odM + lM) + bO * (odO + lO);
    vec3 at = exp(-tau);
    sumR += at * hr; sumM += at * hm;
  }
  float mu = dot(dir, uSunDir);
  float pR = 3.0 / (16.0 * PI) * (1.0 + mu * mu);
  float g = 0.76;
  float pM = 3.0 / (8.0 * PI) * ((1.0 - g * g) * (1.0 + mu * mu)) / ((2.0 + g * g) * pow(max(1.0 + g * g - 2.0 * g * mu, 1e-4), 1.5));
  vec3 col = uSunI * (sumR * bR * pR + sumM * bM * pM);
  float lowSky = pow(1.0 - min(abs(el) / (0.5 * PI), 1.0), 6.0);
  float wMs = 0.6 * lowSky * (1.0 - smoothstep(0.2, 0.85, mu)) * smoothstep(0.03, 0.22, uSunDir.y);
  col = mix(col, vec3(luma(col)) * vec3(0.9, 0.98, 1.14), wMs);
  fragColor = vec4(col, 1.0);
}
`;

const DOME_VERT = /* glsl */`
out vec3 vDir;
void main() {
  vDir = position;
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;   // at the far plane
}
`;
const DOME_FRAG = COMMON + SKY + /* glsl */`
in vec3 vDir;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tMoon;
uniform sampler3D tBase;
uniform vec4 uMoonDisc;     // sin(angular radius), albedo gain, has texture, 0
uniform vec4 uMilky;        // galactic plane normal xyz, core luminance (nits)
uniform vec3 uMilkyC;       // direction of the band's brightest stretch (Cygnus side)
void main() {
  vec3 d = normalize(vDir);
  vec3 col = nightSky(d);
  // ---- Milky Way: a great-circle band with clumped star clouds and a dark rift; extinguished near the horizon ----
  if (uMilky.w > 0.0) {
    float b = dot(d, uMilky.xyz);
    float band = exp(-sq(b / 0.17));
    if (band > 0.003) {
      float along = 0.6 + 0.4 * dot(d, uMilkyC);
      vec3 q = d * 2.3;
      float n1 = texture(tBase, q * 0.9 + 0.13).b, n2 = texture(tBase, q * 2.7 + 0.41).g;
      float clouds = smoothstep(0.3, 0.85, n1 * 0.7 + n2 * 0.5);
      float rift = smoothstep(0.035, 0.0, abs(b - 0.025 * (n1 - 0.5) * 3.0)) * smoothstep(0.35, 0.7, n2);
      float m = band * along * (0.25 + 0.9 * clouds) * (1.0 - 0.7 * rift);
      float ext = smoothstep(0.02, 0.35, d.y);
      col += vec3(0.86, 0.9, 1.0) * uMilky.w * m * ext;
    }
  }
  // ---- the moon ----
  // disc coordinates and their screen derivatives OUTSIDE any branch (fwidth is undefined at a branch edge)
  float sr = uMoonDisc.x;
  vec3 upv = abs(uMoonDir.y) > 0.99 ? vec3(1.0, 0.0, 0.0) : vec3(0.0, 1.0, 0.0);
  vec3 rgt = normalize(cross(upv, uMoonDir)), upm = cross(uMoonDir, rgt);
  vec2 q = vec2(dot(d, rgt), dot(d, upm)) / sr;
  float r = dot(d, uMoonDir) > 0.0 ? length(q) : 1e3;
  float aa = min(fwidth(r), 0.5) * 1.2 + 1e-4;
  float cov = 1.0 - smoothstep(1.0 - aa, 1.0 + aa, r);
  {
    if (cov > 0.0) {
      vec2 qq = q / max(r, 1.0);
      vec3 n = vec3(qq.x, qq.y, sqrt(max(0.0, 1.0 - dot(qq, qq))));
      float alb;
      if (uMoonDisc.z > 0.5) {
        // a photograph of the full moon's near side (it always faces us): sample by disc position, rotated
        // by the parallactic angle (a rising moon seen from 19° N leans its north pole to the left)
        float ca = cos(uMoonDisc.w), sa = sin(uMoonDisc.w);
        vec2 rq = vec2(ca * qq.x - sa * qq.y, sa * qq.x + ca * qq.y);
        alb = texture(tMoon, 0.5 + 0.5 * rq * 0.995).r * uMoonDisc.y;
      } else {
        // procedural: dark maria in the northern / eastern quadrants + fine craters
        vec3 p = n * 1.6;
        float mar = smoothstep(0.42, 0.62, texture(tBase, p * 0.6 + 0.2).b) * smoothstep(-0.6, 0.4, n.y + 0.3 * n.x);
        alb = 1.12 - 0.42 * mar - 0.12 * (texture(tBase, p * 3.0).g - 0.5);
      }
      // a full moon shows almost no limb darkening (opposition surge); a whisper of it
      alb *= 0.9 + 0.1 * n.z;
      col = mix(col, uMoonCol * alb, cov);
    }
  }
  fragColor = vec4(col, 1.0);
}
`;

const STAR_VERT = /* glsl */`
in float aMag;
in vec3 aCol;
uniform float uPx;           // pixels per radian (vertical)
uniform float uStarK;        // flux scale (nits·px² per unit 10^-0.4m)
uniform float uDpr;
out vec3 vCol;
out float vSig;
void main() {
  vec4 p = projectionMatrix * modelViewMatrix * vec4(position, 1.0);
  gl_Position = p.xyww;
  vec3 d = normalize(position);
  // atmospheric extinction toward the horizon (airmass ≈ 1/sin(el)), ~0.25 mag per airmass
  float am = 1.0 / max(d.y + 0.035, 0.035);
  float flux = pow(10.0, -0.4 * (aMag + 0.25 * am));
  float sig = 0.62 * uDpr;                 // seeing + lens PSF (px)
  vSig = sig;
  // peak value of a normalised 2D gaussian = flux / (2π σ²)
  vCol = aCol * uStarK * flux / (6.2831853 * sig * sig);
  gl_PointSize = ceil(sig * 6.0) + 1.0;
  if (d.y < -0.01) gl_PointSize = 0.0;
}
`;
const STAR_FRAG = /* glsl */`
in vec3 vCol;
in float vSig;
layout(location = 0) out vec4 fragColor;
void main() {
  vec2 q = (gl_PointCoord - 0.5) * (ceil(vSig * 6.0) + 1.0);
  float g = exp(-dot(q, q) / (2.0 * vSig * vSig));
  fragColor = vec4(vCol * g, 1.0);
}
`;

export class NightSky {
  constructor(renderer, noise) {
    this.r = renderer;
    const M = CONFIG.moon, S = CONFIG.sky;
    this.moonDir = new THREE.Vector3();
    this.moonCol = new THREE.Color();
    this.moonLight = new THREE.Color();     // illuminance colour (lux) for lit surfaces
    this.skyAmbTop = new THREE.Color(); this.skyAmbHor = new THREE.Color();
    this.lut = new THREE.WebGLRenderTarget(192, 96, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter });
    this.lut.texture.wrapS = THREE.RepeatWrapping;
    this.lutMat = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: FS_VERT, fragmentShader: SKY_LUT, depthTest: false, depthWrite: false, uniforms: { uSunDir: { value: this.moonDir }, uSunI: { value: 1 } } });
    this.quad = new FullScreenQuad(this.lutMat);
    this.buf = new Uint16Array(192 * 96 * 4);

    // shared sky uniforms (also used by terrain haze and water)
    this.U = {
      tSkyLUT: { value: this.lut.texture },
      uMoonDir: { value: this.moonDir }, uMoonCol: { value: new THREE.Vector3() },
      uSkyK: { value: new THREE.Vector4(1, S.cityGlow, 1, 0) },
    };

    // moon texture: optional real map (NASA LROC, public domain) or the procedural fallback
    this.moonTex = null;
    const milkyN = this.galacticPlane();
    this.dome = new THREE.Mesh(new THREE.SphereGeometry(1, 96, 48), new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: DOME_VERT, fragmentShader: DOME_FRAG, side: THREE.BackSide, depthWrite: false, depthTest: false,
      uniforms: {
        ...this.U, tMoon: { value: null }, tBase: { value: noise.base.texture },
        uMoonDisc: { value: new THREE.Vector4(Math.sin(M.radiusDeg * DEG), 1, 0, 0) },
        uMilky: { value: new THREE.Vector4(milkyN.n.x, milkyN.n.y, milkyN.n.z, S.milkyWay) }, uMilkyC: { value: milkyN.c },
      },
    }));
    this.dome.renderOrder = -1000; this.dome.frustumCulled = false;
    this.dome.scale.setScalar(20000);
    this.dome.layers.enable(1);

    this.stars = this.buildStars(CONFIG.tiers.high.stars);
    this.stars.renderOrder = -999; this.stars.frustumCulled = false;
    this.stars.layers.enable(1);

    this.setMoon(M.elev, M.azim);
  }

  /** Direction from (elevation, azimuth°): azimuth from east, counterclockwise toward north (−z). */
  static dirFrom(elevDeg, azimDeg, out) {
    const e = elevDeg * DEG, a = azimDeg * DEG;
    return out.set(Math.cos(e) * Math.cos(a), Math.sin(e), -Math.cos(e) * Math.sin(a)).normalize();
  }

  /** The Milky Way's plane, as seen from Chiang Mai on a November evening: low in the WNW, high across the
   *  north, down to the ESE (so the moon washes out its fainter Auriga–Taurus end). */
  galacticPlane() {
    const A = NightSky.dirFrom(6, 90 - 292, new THREE.Vector3()), B = NightSky.dirFrom(52, 90 - 5, new THREE.Vector3());
    const n = new THREE.Vector3().crossVectors(A, B).normalize();
    return { n, c: A.clone() };
  }

  buildStars(count) {
    const rnd = mulberry32(2026), pos = new Float32Array(count * 3), mag = new Float32Array(count), col = new Float32Array(count * 3);
    const m0 = -1.2, m1 = 6.6, k = 0.44;   // N(<m) ∝ 10^(k m): many faint stars, a handful of bright ones
    const a0 = Math.pow(10, k * m0), a1 = Math.pow(10, k * m1);
    for (let i = 0; i < count; i++) {
      const z = rnd() * 2 - 1, ph = rnd() * TAU, s = Math.sqrt(1 - z * z);
      pos[i * 3] = s * Math.cos(ph) * 15000; pos[i * 3 + 1] = z * 15000; pos[i * 3 + 2] = s * Math.sin(ph) * 15000;
      mag[i] = Math.log10(a0 + rnd() * (a1 - a0)) / k;
      // spectral class mix: mostly white / yellow-white, some blue-white, some orange
      const r = rnd(), T = r < 0.12 ? 9500 + rnd() * 12000 : r < 0.62 ? 5600 + rnd() * 2600 : r < 0.9 ? 4300 + rnd() * 1200 : 3300 + rnd() * 900;
      const c = blackbody(T); const s3 = 1 / Math.max(c[0], c[1], c[2]);
      // stars look less saturated than their blackbody: the eye / sensor sees them through a bright core
      col[i * 3] = 0.45 + 0.55 * c[0] * s3; col[i * 3 + 1] = 0.45 + 0.55 * c[1] * s3; col[i * 3 + 2] = 0.45 + 0.55 * c[2] * s3;
    }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(pos, 3));
    g.setAttribute('aMag', new THREE.BufferAttribute(mag, 1));
    g.setAttribute('aCol', new THREE.BufferAttribute(col, 3));
    const m = new THREE.ShaderMaterial({ glslVersion: THREE.GLSL3, vertexShader: STAR_VERT, fragmentShader: STAR_FRAG, depthWrite: false, depthTest: false, blending: THREE.AdditiveBlending,
      uniforms: { uPx: { value: 1000 }, uStarK: { value: 1 }, uDpr: { value: 1 } } });
    const pts = new THREE.Points(g, m);
    pts.userData.count = count;
    return pts;
  }

  setStarCount(n) { this.stars.geometry.setDrawRange(0, Math.min(n, this.stars.userData.count)); }

  setMoonTexture(tex) {
    this.moonTex = tex;
    const u = this.dome.material.uniforms;
    u.tMoon.value = tex; u.uMoonDisc.value.z = tex ? 1 : 0;
    // normalise by the photo's mean disc grey so the disc's mean luminance stays CONFIG.moon.lum
    u.uMoonDisc.value.y = tex ? 1 / 0.47 : 1;
    u.uMoonDisc.value.w = -0.6;
  }

  setMoon(elevDeg, azimDeg) {
    const M = CONFIG.moon, S = CONFIG.sky;
    NightSky.dirFrom(elevDeg, azimDeg, this.moonDir);
    // moon colour: sunlight reflected by the lunar regolith (≈4100 K) reddened by the air mass toward it
    const z = 90 - elevDeg, m = 1 / (Math.cos(z * DEG) + 0.50572 * Math.pow(Math.max(96.07995 - z, 0.5), -1.6364));
    const bR = [5.8e-6, 13.5e-6, 33.1e-6], bO = [0.65e-6, 1.881e-6, 0.085e-6], bM = 9e-6 * 1.1;
    const tr = bR.map((b, i) => Math.exp(-(b * 8000 + bM * 1200 + bO[i] * 15000) * m * 0.3));
    const bb = blackbody(4100);
    const c = [bb[0] * tr[0], bb[1] * tr[1], bb[2] * tr[2]], L = 0.2126 * c[0] + 0.7152 * c[1] + 0.0722 * c[2];
    this.moonCol.setRGB(c[0] / L, c[1] / L, c[2] / L);
    this.U.uMoonCol.value.set(this.moonCol.r * M.lum, this.moonCol.g * M.lum, this.moonCol.b * M.lum);
    this.moonLight.setRGB(this.moonCol.r * M.illum, this.moonCol.g * M.illum, this.moonCol.b * M.illum);
    // the LUT: a day-sky solver lit by a "sun" 400 000× dimmer, times the night gain
    this.lutMat.uniforms.uSunI.value = 1;
    this.U.uSkyK.value.x = 60 * S.lutI * S.nightGain * S.skyGain;
    const r = this.r, prev = r.getRenderTarget();
    r.setRenderTarget(this.lut); this.quad.render(r); r.setRenderTarget(prev);
    // ambient: cosine-weighted averages of the LUT over the upper hemisphere and the horizon band
    try {
      r.readRenderTargetPixels(this.lut, 0, 0, 192, 96, this.buf);
      const f = THREE.DataUtils.fromHalfFloat, B = this.buf, sd = this.moonDir, K = this.U.uSkyK.value.x;
      const band = (r0, r1, out) => {
        let a = 0, b = 0, cc = 0, w = 0;
        for (let row = r0; row <= r1; row++) {
          const v = (row + 0.5) / 96 - 0.5, el = Math.sign(v) * (2 * Math.abs(v)) ** 2 * Math.PI / 2;
          for (let i = 0; i < 192; i += 2) {
            const az = ((i + 0.5) / 192 - 0.5) * TAU, dx = Math.cos(el) * Math.cos(az), dy = Math.sin(el), dz = Math.cos(el) * Math.sin(az);
            if (dx * sd.x + dy * sd.y + dz * sd.z > 0.9) continue;
            const o = (row * 192 + i) * 4, wt = Math.max(dy, 0.05);
            a += f(B[o]) * wt; b += f(B[o + 1]) * wt; cc += f(B[o + 2]) * wt; w += wt;
          }
        }
        return out.setRGB(a / w * K, b / w * K, cc / w * K);
      };
      band(66, 95, this.skyAmbTop); band(49, 60, this.skyAmbHor);
    } catch (e) { this.skyAmbTop.setRGB(0.004, 0.007, 0.016); this.skyAmbHor.setRGB(0.008, 0.011, 0.02); }
  }

  /** Per frame: follow the camera, scale stars to the current projection. */
  update(camera, heightPx, dpr) {
    this.dome.position.copy(camera.position);
    this.stars.position.copy(camera.position);
    const u = this.stars.material.uniforms;
    u.uPx.value = heightPx / (camera.fov * DEG);
    u.uDpr.value = dpr;
    // a magnitude-0 star delivers 2.1e-6 lux; spread over the PSF it reads as a few px of luminance.
    // Luminance·px² = E / Ω_px with Ω_px = (1/uPx)²; times the night gain.
    u.uStarK.value = 2.1e-6 * u.uPx.value * u.uPx.value * CONFIG.sky.nightGain * CONFIG.sky.starGain;
    // above the cloud layer: no haze, no city glow and a darker sky: the star field comes out clear (~1.8 mag)
    const y = camera.position.y, k = Math.min(Math.max((y - 400) / 450, 0), 1);   // (the cloud deck: ~540–800 m)
    u.uStarK.value *= 1 + 4.2 * k * k * (3 - 2 * k);
  }
}
