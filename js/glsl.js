// Shared GLSL chunks. Concatenated into shaders at definition time.

export const FS_VERT = /* glsl */`
out vec2 vUv;
void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
`;

export const COMMON = /* glsl */`
#define PI 3.14159265359
float sat(float x) { return clamp(x, 0.0, 1.0); }
vec3 sat3(vec3 x) { return clamp(x, 0.0, 1.0); }
float sq(float x) { return x * x; }
float remap(float v, float a, float b, float c, float d) { return c + (v - a) * (d - c) / (b - a); }
float hash12(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * 0.1031); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.x + p3.y) * p3.z); }
float hash11(float p) { p = fract(p * 0.1031); p *= p + 33.33; p *= p + p; return fract(p); }
vec2 hash22(vec2 p) { vec3 p3 = fract(vec3(p.xyx) * vec3(0.1031, 0.1030, 0.0973)); p3 += dot(p3, p3.yzx + 33.33); return fract((p3.xx + p3.yz) * p3.zy); }
vec3 hash33(vec3 p) { p = fract(p * vec3(0.1031, 0.1030, 0.0973)); p += dot(p, p.yxz + 33.33); return fract((p.xxy + p.yxx) * p.zyx); }
float luma(vec3 c) { return dot(c, vec3(0.2126, 0.7152, 0.0722)); }
float viewZFromDepth(float d, float n, float f) { return (n * f) / ((f - n) * d - f); }
float hgPhase(float c, float g) { float g2 = g * g; return (1.0 - g2) / (4.0 * PI * pow(max(1.0 + g2 - 2.0 * g * c, 1e-4), 1.5)); }
`;

/* AgX (Blender / Filament, rec.2020 working space) with an adjustable look applied after the sigmoid:
   uAgxLook = (slope, power, saturation, offset). Inputs are exposed linear sRGB. */
export const AGX = /* glsl */`
uniform vec4 uAgxLook;
vec3 agxContrast(vec3 x) {
  vec3 x2 = x * x, x4 = x2 * x2;
  return + 15.5 * x4 * x2 - 40.14 * x4 * x + 31.96 * x4 - 6.868 * x2 * x + 0.4298 * x2 + 0.1191 * x - 0.00232;
}
vec3 agx(vec3 color) {
  const mat3 toRec2020 = mat3(0.6274, 0.0691, 0.0164, 0.3293, 0.9195, 0.0880, 0.0433, 0.0114, 0.8956);
  const mat3 fromRec2020 = mat3(1.6605, -0.1246, -0.0182, -0.5876, 1.1329, -0.1006, -0.0728, -0.0083, 1.1187);
  const mat3 inset = mat3(vec3(0.856627153315983, 0.137318972929847, 0.11189821299995), vec3(0.0951212405381588, 0.761241990602591, 0.0767994186031903), vec3(0.0482516061458583, 0.101439036467562, 0.811302368396859));
  const mat3 outset = mat3(vec3(1.1271005818144368, -0.1413297634984383, -0.14132976349843826), vec3(-0.11060664309660323, 1.157823702216272, -0.11060664309660294), vec3(-0.016493938717834573, -0.016493938717834257, 1.2519364065950405));
  const float minEv = -12.47393, maxEv = 4.026069;
  color = inset * (toRec2020 * color);
  color = clamp((log2(max(color, 1e-10)) - minEv) / (maxEv - minEv), 0.0, 1.0);
  color = agxContrast(color);
  // look: slope / power / saturation (Blender's "Punchy" is 1, 1.35, 1.4)
  vec3 v = pow(max(color * uAgxLook.x + uAgxLook.w, 0.0), vec3(uAgxLook.y));
  float l = dot(v, vec3(0.2126, 0.7152, 0.0722));
  color = l + uAgxLook.z * (v - l);
  color = outset * color;
  color = pow(max(color, 0.0), vec3(2.2));
  return clamp(fromRec2020 * color, 0.0, 1.0);
}
vec3 srgbEncode(vec3 c) { return mix(c * 12.92, 1.055 * pow(c, vec3(1.0 / 2.4)) - 0.055, step(0.0031308, c)); }
`;

/* Night sky radiance (shared by the sky dome, distant terrain haze and the water).
   skyLUT: Rayleigh + Mie single scattering of MOONLIGHT (Eye of the Storm's day-sky LUT with the moon
   as the light, scaled by uSkyK). On top: the moon's aureole in humid air, warm city glow at the horizon. */
export const SKY = /* glsl */`
uniform sampler2D tSkyLUT;
uniform vec3 uMoonDir, uMoonCol;   // direction to the moon; moon disc colour × luminance (nits)
uniform vec4 uSkyK;                // x LUT scale, y city glow (nits), z aureole gain, w horizon haze
vec3 skyLUT(vec3 d) {
  float el = asin(clamp(d.y, -1.0, 1.0));
  float az = atan(d.z, d.x);
  float v = 0.5 + 0.5 * sign(el) * sqrt(abs(el) / (0.5 * PI));
  return texture(tSkyLUT, vec2(az / (2.0 * PI) + 0.5, clamp(v, 0.505, 0.999))).rgb;
}
vec3 nightSky(vec3 d) {
  vec3 dd = vec3(d.x, max(d.y, 0.004), d.z);
  vec3 c = skyLUT(normalize(dd)) * uSkyK.x;
  float mu = dot(d, uMoonDir);
  // aureole: forward scattering by haze and humidity around the moon (a soft silver halo)
  float moonL = luma(uMoonCol);
  c += uMoonCol / max(moonL, 1e-4) * uSkyK.z * (0.012 * exp(-(1.0 - mu) * 900.0) + 0.0035 * exp(-(1.0 - mu) * 90.0) + 0.0012 * exp(-(1.0 - mu) * 12.0));
  // light pollution: warm sodium / LED glow from the city, low on the horizon
  float h = max(d.y, 0.0);
  c += vec3(1.0, 0.72, 0.48) * uSkyK.y * (exp(-h * 26.0) * 0.8 + exp(-h * 7.0) * 0.2);
  return c;
}
`;
