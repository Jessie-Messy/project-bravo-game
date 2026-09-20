// tools/lib/io.mjs — one configured NodeIO, shared by inspect / bake / verify.
//
// Without the Draco and Meshopt dependencies registered, reading an already-compressed
// GLB fails with a bare "Cannot read properties of undefined (reading 'DT_FLOAT32')",
// which looks like a corrupt file but only means the decoder is missing. Twenty of the
// models in this project are Draco-compressed, so every tool needs these.

import { NodeIO } from '@gltf-transform/core';
import { ALL_EXTENSIONS } from '@gltf-transform/extensions';
import draco3d from 'draco3dgltf';
import { MeshoptDecoder, MeshoptEncoder } from 'meshoptimizer';

let cached = null;

export async function getIO() {
  if (cached) return cached;

  await MeshoptDecoder.ready;
  await MeshoptEncoder.ready;

  cached = new NodeIO().registerExtensions(ALL_EXTENSIONS).registerDependencies({
    'draco3d.decoder': await draco3d.createDecoderModule(),
    'draco3d.encoder': await draco3d.createEncoderModule(),
    'meshopt.decoder': MeshoptDecoder,
    'meshopt.encoder': MeshoptEncoder,
  });
  return cached;
}
