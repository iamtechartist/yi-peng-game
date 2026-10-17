// Load a GLB made by the /blender scripts into plain BufferGeometries keyed by mesh name. The GLBs are quantized
// and meshopt-compressed (EXT_meshopt_compression, decoded by three's MeshoptDecoder): attributes go back to float and the node's dequantization transform is baked into the
// vertices, so object space is the model's real metres. The "Color" attribute (material id, AO, variation) becomes
// aPart (three's ShaderMaterial prefix owns the name "color").
import * as THREE from 'three';
import { GLTFLoader } from 'three/addons/loaders/GLTFLoader.js';
import { MeshoptDecoder } from 'three/addons/libs/meshopt_decoder.module.js';

export const loader = new GLTFLoader().setMeshoptDecoder(MeshoptDecoder);

export async function loadMeshes(url) {
  const gltf = await loader.loadAsync(url);
  const out = {};
  gltf.scene.updateMatrixWorld(true);
  gltf.scene.traverse((o) => {
    if (!o.isMesh) return;
    const g = o.geometry;
    for (const name of Object.keys(g.attributes)) {
      const a = g.attributes[name];
      if (a.array instanceof Float32Array && !a.normalized && !a.isInterleavedBufferAttribute) continue;
      const f = new Float32Array(a.count * a.itemSize);
      for (let i = 0; i < a.count; i++) for (let c = 0; c < a.itemSize; c++) f[i * a.itemSize + c] = a.getComponent(i, c);
      g.setAttribute(name, new THREE.BufferAttribute(f, a.itemSize));
    }
    g.applyMatrix4(o.matrixWorld);
    if (g.getAttribute('color')) { g.setAttribute('aPart', g.getAttribute('color')); g.deleteAttribute('color'); }
    g.computeBoundingBox(); g.computeBoundingSphere();
    out[o.name] = g;
  });
  return out;
}
