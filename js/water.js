// The river: a planar reflection (mirrored camera, oblique near plane) sampled through ripple slopes.
// Each pixel reflects along its own perturbed normal, so a light above the water breaks into a vertical
// column of horizontal dashes (one per ripple facet that tilts toward the eye), the way the golden
// columns do in the reference photos. Slope VARIANCE (LEAN-mapped ripple texture) spreads extra taps
// along the reflected elevation, so distant water blurs into smooth streaks instead of shimmering.
import * as THREE from 'three';
import { COMMON, SKY } from './glsl.js';
import { LIGHTVOL_GLSL } from './lightvol.js';
import { CONFIG } from './config.js';
import { riverX } from './terrain.js';

export class PlanarReflection {
  constructor(scale = 0.5) {
    this.scale = scale;
    this.rt = new THREE.WebGLRenderTarget(4, 4, { type: THREE.HalfFloatType, depthBuffer: true, samples: 0 });
    const t = this.rt.texture;
    t.generateMipmaps = true; t.minFilter = THREE.LinearMipmapLinearFilter; t.magFilter = THREE.LinearFilter;
    this.cam = new THREE.PerspectiveCamera();
    this.vp = new THREE.Matrix4();
    this._q = new THREE.Vector4(); this._clip = new THREE.Vector4(); this._plane = new THREE.Plane();
  }
  setSize(w, h) { this.rt.setSize(Math.max(16, Math.round(w * this.scale)), Math.max(16, Math.round(h * this.scale))); }
  /** Mirror `camera` in the plane y = level and render `scene` (layer 1 only) into the target. */
  render(renderer, scene, camera, level = 0, hide = []) {
    const c = this.cam;
    c.copy(camera);
    c.layers.set(1);
    const p = camera.position;
    c.position.set(p.x, 2 * level - p.y, p.z);
    // mirror the orientation: reflect the forward and up vectors in the plane
    const f = new THREE.Vector3(0, 0, -1).applyQuaternion(camera.quaternion), u = new THREE.Vector3(0, 1, 0).applyQuaternion(camera.quaternion);
    f.y = -f.y; u.y = -u.y;
    c.up.copy(u);
    c.lookAt(c.position.x + f.x, c.position.y + f.y, c.position.z + f.z);
    c.updateMatrixWorld();
    c.projectionMatrix.copy(camera.projectionMatrix);
    // oblique near plane = the water plane (Lengyel)
    this._plane.set(new THREE.Vector3(0, 1, 0), -level).applyMatrix4(c.matrixWorldInverse);
    const cp = this._clip.set(this._plane.normal.x, this._plane.normal.y, this._plane.normal.z, this._plane.constant);
    const P = c.projectionMatrix.elements, q = this._q;
    q.x = (Math.sign(cp.x) + P[8]) / P[0]; q.y = (Math.sign(cp.y) + P[9]) / P[5]; q.z = -1; q.w = (1 + P[10]) / P[14];
    cp.multiplyScalar(2 / cp.dot(q));
    P[2] = cp.x; P[6] = cp.y; P[10] = cp.z + 1 - 0.0005; P[14] = cp.w;
    c.projectionMatrixInverse.copy(c.projectionMatrix).invert();
    this.vp.multiplyMatrices(c.projectionMatrix, c.matrixWorldInverse);
    for (const o of hide) o.visible = false;
    const prev = renderer.getRenderTarget();
    renderer.setRenderTarget(this.rt);
    renderer.setClearColor(0x000000, 0); renderer.clear(true, true, false);
    renderer.render(scene, c);
    renderer.setRenderTarget(prev);
    for (const o of hide) o.visible = true;
  }
}

const VERT = /* glsl */`
out vec3 vWorld;
void main() {
  vec4 wp = modelMatrix * vec4(position, 1.0);
  vWorld = wp.xyz;
  gl_Position = projectionMatrix * viewMatrix * wp;
}
`;
const FRAG = COMMON + SKY + LIGHTVOL_GLSL + /* glsl */`
in vec3 vWorld;
layout(location = 0) out vec4 fragColor;
uniform sampler2D tRefl, tRipple;
uniform mat4 uReflVP;
uniform vec2 uReflRes;
uniform float uTime;
uniform vec4 uRip;      // tile A (m), tile B (m), rms slope, flow speed (m/s, +z)
uniform vec4 uRip2;     // unresolved variance, reflected-distance assumption (m), lod bias, 0
uniform vec3 uBody;     // water body colour × in-scattered light (nits)
vec2 reflUV(vec3 P, vec3 R) {
  vec4 c = uReflVP * vec4(P + R * uRip2.y, 1.0);
  return c.xy / c.w * 0.5 + 0.5;
}
void main() {
  vec3 V = vWorld - cameraPosition;
  float dist = length(V); V /= dist;
  // ---- ripple slopes: two layers drifting with the current and a light breeze ----
  vec2 flow = vec2(0.0, uRip.w * uTime);
  vec2 uvA = (vWorld.xz + flow) / uRip.x;
  vec2 uvB = (mat2(0.8, -0.6, 0.6, 0.8) * vWorld.xz + flow * 0.6 + vec2(uTime * 0.21, 0.0)) / uRip.y;
  vec4 a = texture(tRipple, uvA), b = texture(tRipple, uvB);
  float kA = uRip.z, kB = uRip.z * 0.5;
  vec2 s = a.xy * kA + b.xy * kB;
  vec2 var = max(a.zw - a.xy * a.xy, 0.0) * kA * kA + max(b.zw - b.xy * b.xy, 0.0) * kB * kB + uRip2.x;
  // the spread that matters is along the view's horizontal direction (it tilts the reflection up/down)
  vec2 tv = normalize(V.xz + 1e-5);
  float sigV = sqrt(dot(var, tv * tv)), sigH = sqrt(dot(var, tv.yx * tv.yx));
  // ---- reflection: centre tap at the mean slope + four taps spread along the reflected elevation ----
  float lod = log2(max(1.0, sigH * 2.0 * uReflRes.y * 0.6)) + uRip2.z;
  vec3 refl = vec3(0.0); float ws = 0.0;
  const float O[5] = float[5](0.0, -0.75, 0.75, -1.6, 1.6);
  const float Wt[5] = float[5](1.0, 0.8, 0.8, 0.35, 0.35);
  for (int i = 0; i < 5; i++) {
    vec2 sk = s + tv * sigV * O[i];
    vec3 N = normalize(vec3(-sk.x, 1.0, -sk.y));
    vec3 R = reflect(V, N);
    R.y = max(R.y, 0.002);
    vec2 uv = reflUV(vWorld, R);
    vec4 rc = textureLod(tRefl, uv, lod);
    // nothing was rendered there (alpha 0): the sky beyond the reflection camera's view
    vec3 c = rc.a > 0.5 ? rc.rgb : nightSky(R);
    refl += c * Wt[i]; ws += Wt[i];
  }
  refl /= ws;
  vec3 N0 = normalize(vec3(-s.x, 1.0, -s.y));
  float cosT = clamp(dot(-V, N0), 0.0, 1.0);
  float F = 0.02 + 0.98 * pow(1.0 - cosT, 5.0);
  // the turbid river body scatters some of the lantern light falling on it back up (golden-brown, ref 14)
  vec3 body = uBody + vec3(0.9, 0.75, 0.5) * uLVcol * (0.03 / PI) * lanternE(lanternLight(vWorld + vec3(0.0, 0.25, 0.0)), vec3(0.0, 1.0, 0.0));
  vec3 col = refl * F + body * (1.0 - F);
  fragColor = vec4(col, 1.0);
}
`;

export class River {
  constructor(sky, rippleTex, refl) {
    const W = CONFIG.world;
    // the water follows the river's centreline: dense rows through the town, then coarser out to the horizon
    const zs = [];
    for (let z = -32000; z <= 32000;) { zs.push(z); const a = Math.abs(z); z += a < 1500 ? 8 : a < 6000 ? 60 : 800; }
    const hw = W.riverHalf + 20, pos = [], idx = [];
    zs.forEach((z) => { const c = riverX(z); pos.push(c - hw, 0, z, c + hw, 0, z); });
    for (let j = 0; j < zs.length - 1; j++) { const a = j * 2; idx.push(a, a + 2, a + 1, a + 1, a + 2, a + 3); }
    const g = new THREE.BufferGeometry();
    g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
    g.setIndex(idx);
    this.refl = refl;
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: VERT, fragmentShader: FRAG,
      uniforms: {
        ...sky.U, tRefl: { value: refl.rt.texture }, tRipple: { value: rippleTex },
        uReflVP: { value: refl.vp }, uReflRes: { value: new THREE.Vector2(1, 1) }, uTime: { value: 0 },
        uRip: { value: new THREE.Vector4(2.4, 6.8, 0.05, 0.55) },
        uRip2: { value: new THREE.Vector4(0.0006, 140, 0, 0) },
        uBody: { value: new THREE.Vector3(0.0009, 0.0009, 0.0006) },
        tLV: { value: null }, uLVo: { value: [] }, uLVcol: { value: new THREE.Vector3() },
      },
    });
    this.mesh = new THREE.Mesh(g, this.mat);
    this.mesh.frustumCulled = false;
  }
  update(t, w, h) {
    const u = this.mat.uniforms;
    u.uTime.value = t;
    u.uReflRes.value.set(this.refl.rt.width, this.refl.rt.height);
  }
}
