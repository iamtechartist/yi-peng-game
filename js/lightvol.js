// The swarm's light: every lantern is SPLATTED each frame into a low-resolution 3D light volume, which the
// water, banks, roofs, mist and the humid air sample.
//
// Three cascades of 96×48×96 voxels around the camera (2 m, 8 m, 32 m voxels → 192 m, 768 m, 3 km boxes), packed
// as tiled slices in one half-float atlas (12 × 8 tiles of 96 × 48 per cascade, 1152 × 1152 in all).
// A lantern of intensity I (cd) adds to each voxel centre within reach the exact kernel
//     k(d) = I / (d² + r0²)          (irradiance from a small extended source)
// split between the cascades by smooth windows W(d/Rc) so the parts sum EXACTLY to the whole (a partition of
// unity: c0 takes k·W(d/R0), c1 takes k·(1−W(d/R0))·W(d/R1), c2 takes k·(1−W(d/R1))·W(d/R2)). Each cascade
// therefore only holds what its voxels can resolve: the sharp near field in 2 m voxels, the long tail in 32 m
// ones. Voxels store R = scalar irradiance Σk, GBA = the light vector Σk·l̂ (l̂ toward the lantern), so a surface
// can shade by its normal. The splat is one draw of instanced points (lantern × cascade × slice), each point a
// small square of voxels in one slice. Grid origins snap to whole voxels, so a moving camera never makes the
// field shimmer; lanterns move the field continuously (exact kernel values at fixed voxel centres).
import * as THREE from 'three';

export const LV = { X: 96, Y: 48, Z: 96, TX: 12, TY: 8, REACH: 4, sizes: [2, 8, 32], radii: [8, 32, 128], r0: 0.4 };
const AW = LV.X * LV.TX, AH = LV.Y * LV.TY * 3;

/* GLSL used by every surface / volume that receives lantern light. */
export const LIGHTVOL_GLSL = /* glsl */`
uniform sampler2D tLV;
uniform vec4 uLVo[3];       // cascade origin (world, voxel corner) xyz, voxel size w
uniform vec3 uLVcol;        // lantern light colour (unit luminance) × gain
const vec3 LVN = vec3(${LV.X}.0, ${LV.Y}.0, ${LV.Z}.0);
const vec2 LVA = vec2(${AW}.0, ${AH}.0);
vec4 lvTile(int c, float z, vec2 xy) {
  float col = mod(z, ${LV.TX}.0), row = floor(z / ${LV.TX}.0) + float(c * ${LV.TY});
  vec2 p = vec2(col * LVN.x, row * LVN.y) + clamp(xy, vec2(0.5), LVN.xy - 0.5);
  return texture(tLV, p / LVA);
}
vec4 lvCascade(int c, vec3 p) {
  vec3 g = (p - uLVo[c].xyz) / uLVo[c].w;
  if (any(lessThan(g, vec3(0.5))) || any(greaterThan(g, LVN - 0.5))) return vec4(0.0);
  float zf = g.z - 0.5, z0 = floor(zf);
  return mix(lvTile(c, z0, g.xy), lvTile(c, min(z0 + 1.0, LVN.z - 1.0), g.xy), zf - z0);
}
/** (scalar irradiance Σ I/d², light vector Σ (I/d²)·l̂) at p, in lux. */
vec4 lanternLight(vec3 p) { return lvCascade(0, p) + lvCascade(1, p) + lvCascade(2, p); }
/** Irradiance on a surface with normal n: Lambert from the net light vector plus a wrap term for the light
 *  arriving from every other side (many lanterns around a point partly cancel in the vector). */
float lanternE(vec4 L, vec3 n) {
  float v = length(L.yzw);
  return 0.7 * max(dot(n, L.yzw), 0.0) + 0.3 * L.x * 0.5 * (1.0 + dot(n, L.yzw / max(v, 1e-5)));
}
`;

const SPLAT_VERT = /* glsl */`
uniform sampler2D tL;        // lanterns: xyz, intensity (cd)
uniform int uLW;
uniform vec4 uO[3];
flat out vec4 vL;            // lantern position, intensity
flat out ivec4 vTile;        // tile origin in the atlas (px), cascade, slice z
flat out int vCmin;          // the finest cascade whose box holds this light (it takes the finer cascades' shares)
bool inBox(int c, vec3 p) { vec3 g = (p - uO[c].xyz) / uO[c].w; return all(greaterThan(g, vec3(${LV.REACH}.0))) && all(lessThan(g, vec3(${LV.X}.0, ${LV.Y}.0, ${LV.Z}.0) - ${LV.REACH}.0)); }
void main() {
  int c = gl_InstanceID / ${2 * LV.REACH + 1};
  int dz = gl_InstanceID % ${2 * LV.REACH + 1} - ${LV.REACH};
  vec4 L = texelFetch(tL, ivec2(gl_VertexID % uLW, gl_VertexID / uLW), 0);
  vL = L;
  gl_PointSize = 0.0; gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
  if (L.w <= 0.0) return;
  vCmin = inBox(0, L.xyz) ? 0 : inBox(1, L.xyz) ? 1 : 2;
  if (c < vCmin) return;
  vec3 g = (L.xyz - uO[c].xyz) / uO[c].w;
  ivec3 vi = ivec3(floor(g));
  int z = vi.z + dz;
  if (z < 0 || z >= ${LV.Z}) return;
  if (vi.x < -${LV.REACH} || vi.y < -${LV.REACH} || vi.x >= ${LV.X + LV.REACH} || vi.y >= ${LV.Y + LV.REACH}) return;
  ivec2 t0 = ivec2((z % ${LV.TX}) * ${LV.X}, (z / ${LV.TX} + c * ${LV.TY}) * ${LV.Y});
  vTile = ivec4(t0, c, z);
  vec2 px = vec2(t0) + vec2(vi.xy) + 0.5;
  gl_Position = vec4(px / vec2(${AW}.0, ${AH}.0) * 2.0 - 1.0, 0.0, 1.0);
  gl_PointSize = ${2 * LV.REACH + 1}.0;
}
`;
const SPLAT_FRAG = /* glsl */`
uniform vec4 uO[3];
uniform vec3 uR;             // window radii per cascade
uniform float uR0;
flat in vec4 vL;
flat in ivec4 vTile;
flat in int vCmin;
layout(location = 0) out vec4 fragColor;
float W(float x) { return 1.0 - smoothstep(0.55, 1.0, x); }
void main() {
  ivec2 local = ivec2(floor(gl_FragCoord.xy)) - vTile.xy;
  if (local.x < 0 || local.y < 0 || local.x >= ${LV.X} || local.y >= ${LV.Y}) discard;
  int c = vTile.z;
  vec3 vc = uO[c].xyz + (vec3(vec2(local), float(vTile.w)) + 0.5) * uO[c].w;
  vec3 dv = vL.xyz - vc;
  float d2 = dot(dv, dv), d = sqrt(d2);
  // a cascade standing in for finer ones holds their near field too, smoothed to its own voxel size
  float r0 = c == vCmin && c > 0 ? max(uR0, 0.6 * uO[c].w) : uR0;
  float k = vL.w / (d2 + r0 * r0);
  float Win = c == vCmin ? 0.0 : (c == 1 ? W(d / uR.x) : W(d / uR.y));   // the share already taken by finer cascades
  float Wc = c == 0 ? W(d / uR.x) : c == 1 ? W(d / uR.y) : W(d / uR.z);
  float w = (1.0 - Win) * Wc;
  if (w <= 0.0) discard;
  fragColor = vec4(k * w, dv / max(d, 1e-4) * k * w);
}
`;

export class LightVolume {
  constructor(renderer, lightTex, lightW, count) {
    this.r = renderer;
    this.rt = new THREE.WebGLRenderTarget(AW, AH, { type: THREE.HalfFloatType, depthBuffer: false, minFilter: THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: false });
    this.origins = [new THREE.Vector4(), new THREE.Vector4(), new THREE.Vector4()];
    // shared uniforms for every receiving material
    this.U = { tLV: { value: this.rt.texture }, uLVo: { value: this.origins }, uLVcol: { value: new THREE.Vector3(1, 1, 1) } };
    const g = new THREE.InstancedBufferGeometry();
    g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(count * 3), 3));
    g.instanceCount = 3 * (2 * LV.REACH + 1);
    this.mat = new THREE.ShaderMaterial({
      glslVersion: THREE.GLSL3, vertexShader: SPLAT_VERT, fragmentShader: SPLAT_FRAG,
      depthTest: false, depthWrite: false, transparent: true,
      blending: THREE.CustomBlending, blendEquation: THREE.AddEquation, blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
      uniforms: { tL: { value: lightTex }, uLW: { value: lightW }, uO: { value: this.origins }, uR: { value: new THREE.Vector3(...LV.radii) }, uR0: { value: LV.r0 } },
    });
    this.points = new THREE.Points(g, this.mat);
    this.points.frustumCulled = false;
    this.scene = new THREE.Scene(); this.scene.add(this.points);
    this.cam = new THREE.Camera();
  }
  clear() { const r = this.r, prev = r.getRenderTarget(); r.setRenderTarget(this.rt); r.setClearColor(0x000000, 0); r.clear(true, false, false); r.setRenderTarget(prev); }
  /** Re-centre the cascades on p (snapped to whole voxels) and splat every lantern. */
  update(p) {
    LV.sizes.forEach((s, c) => {
      const o = this.origins[c];
      o.set(Math.floor(p.x / s - LV.X / 2) * s, Math.floor(p.y / s - LV.Y / 2) * s, Math.floor(p.z / s - LV.Z / 2) * s, s);
    });
    const r = this.r, prev = r.getRenderTarget(), cc = r.getClearColor(new THREE.Color()), ca = r.getClearAlpha();
    r.setRenderTarget(this.rt); r.setClearColor(0x000000, 0); r.clear(true, false, false);
    r.render(this.scene, this.cam);
    r.setRenderTarget(prev); r.setClearColor(cc, ca);
  }
}
