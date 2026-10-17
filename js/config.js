// Lantern Night configuration: world layout, light levels, camera, quality tiers.
// World: metres, x east, y up, z south. Water level y = 0. The Ping river runs north–south along z.
// Light levels are scene-referred luminance in cd/m² (nits). The camera turns them into exposure with
// EV100 (exposure = 1 / (1.2 · 2^EV100)); AgX then maps that to the display.
export const URLP = new URLSearchParams(location.search);
export const DEBUG = URLP.has('debug');

export const CONFIG = {
  world: {
    riverHalf: 52,        // half-width of the water (m); the Ping is ~90–110 m wide through Chiang Mai
    bankTop: 2.4,         // bank height above the water (m)
    near: 0.06, far: 60000,
  },
  moon: {
    elev: 13.5, azim: -16,       // low over the eastern hills, slightly south of east (azimuth from east, CCW toward north)
    radiusDeg: 0.26 * 1.55,      // true 0.26°, enlarged for presence at normal focal lengths
    lum: 2600,                   // disc luminance (nits): a full moon
    illum: 0.32,                 // illuminance on a surface facing it (lux, ~1.5× a real full moon at this altitude: the "night gain")
  },
  sky: {
    nightGain: 9.0,              // moonlit sky / stars brightened ~9× over real (what a long exposure / high ISO does)
    lutI: 2600 / 400000,         // the sky LUT is a day-sky solver: moon ≈ sun / 400 000
    starGain: 1.0,
    milkyWay: 0.012,             // nits at the band core (faint under a full moon)
    cityGlow: 0.012,             // warm light pollution at the horizon (nits)
    skyGain: 2.2,                // extra lift of the sky dome over the stars / moonlit ground (deep navy, not black)
  },
  camera: { ev100: 4.0, wbK: 3800 },   // ≈ f/2.8, 1/60 s, ISO 3200; white balance set for warm light (moonlight goes blue)
  lantern: { flameK: 1750 },
  town: {
    temple: { x: 84, z: 40, ground: 2.5 }, chedi: { x: 112, z: 68 },
    // flat ground pads (x0, z0, x1, z1, height): the temple compound
    pads: [[63, 18, 132, 86, 2.5]],
  },
  tiers: {
    low:    { label: 'Low',    msaa: 0, maxDpr: 1,   mp: 1.2, refl: 0.33, dofR: 7,  dofStep: 1.35, mist: 6,  bloom: 5, stars: 2500, air: 6, cloudScale: 0.36, cloudSteps: 40 },
    medium: { label: 'Medium', msaa: 2, maxDpr: 1.5, mp: 2.1, refl: 0.42,  dofR: 11, dofStep: 1.15, mist: 10, bloom: 6, stars: 5000, air: 10, cloudScale: 0.45, cloudSteps: 56 },
    high:   { label: 'High',   msaa: 4, maxDpr: 2,   mp: 3.7, refl: 0.6,  dofR: 15, dofStep: 1.0,  mist: 14, bloom: 6, stars: 8000, air: 14, cloudScale: 0.6, cloudSteps: 80 },
  },
};
