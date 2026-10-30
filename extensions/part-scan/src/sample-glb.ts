/** A dependency-free GLB fixture: a blue 40 × 20 × 10 mm box in metre units. */
export const SAMPLE_DIMS = {
  bboxMm: { length: 40, width: 20, height: 10 },
  orientedBboxMm: { length: 40, width: 20, height: 10 },
  surfaceAreaMm2: 2800,
  volumeMm3: 8000,
  watertight: true,
  scaleSource: "bundled 40 × 20 × 10 mm verification fixture",
  reprojectionErrorPx: 0,
  scaleErrorMm: 0,
};

function aligned(value: number): number {
  return (value + 3) & ~3;
}

export function sampleGlb(): Buffer {
  const positions = new Float32Array([
    -0.02, -0.01, -0.005, 0.02, -0.01, -0.005, 0.02, 0.01, -0.005, -0.02, 0.01, -0.005,
    -0.02, -0.01, 0.005, 0.02, -0.01, 0.005, 0.02, 0.01, 0.005, -0.02, 0.01, 0.005,
  ]);
  const indices = new Uint16Array([
    0, 2, 1, 0, 3, 2, 4, 5, 6, 4, 6, 7, 0, 1, 5, 0, 5, 4,
    1, 2, 6, 1, 6, 5, 2, 3, 7, 2, 7, 6, 3, 0, 4, 3, 4, 7,
  ]);
  const positionBytes = Buffer.from(positions.buffer);
  const indexOffset = aligned(positionBytes.length);
  const binLength = aligned(indexOffset + indices.byteLength);
  const bin = Buffer.alloc(binLength);
  positionBytes.copy(bin, 0);
  Buffer.from(indices.buffer).copy(bin, indexOffset);
  const gltf = {
    asset: { version: "2.0", generator: "InfiniBot Part Scan fixture" },
    scene: 0,
    scenes: [{ nodes: [0] }],
    nodes: [{ mesh: 0, name: "40x20x10mm sample" }],
    meshes: [{ primitives: [{ attributes: { POSITION: 0 }, indices: 1, material: 0 }] }],
    materials: [{ pbrMetallicRoughness: { baseColorFactor: [0.08, 0.52, 0.95, 1], metallicFactor: 0.1, roughnessFactor: 0.34 } }],
    accessors: [
      { bufferView: 0, componentType: 5126, count: 8, type: "VEC3", min: [-0.02, -0.01, -0.005], max: [0.02, 0.01, 0.005] },
      { bufferView: 1, componentType: 5123, count: indices.length, type: "SCALAR" },
    ],
    bufferViews: [
      { buffer: 0, byteOffset: 0, byteLength: positions.byteLength, target: 34962 },
      { buffer: 0, byteOffset: indexOffset, byteLength: indices.byteLength, target: 34963 },
    ],
    buffers: [{ byteLength: binLength }],
  };
  const jsonRaw = Buffer.from(JSON.stringify(gltf), "utf8");
  const jsonLength = aligned(jsonRaw.length);
  const total = 12 + 8 + jsonLength + 8 + binLength;
  const out = Buffer.alloc(total, 0x20);
  out.writeUInt32LE(0x46546c67, 0);
  out.writeUInt32LE(2, 4);
  out.writeUInt32LE(total, 8);
  out.writeUInt32LE(jsonLength, 12);
  out.writeUInt32LE(0x4e4f534a, 16);
  jsonRaw.copy(out, 20);
  const binHeader = 20 + jsonLength;
  out.writeUInt32LE(binLength, binHeader);
  out.writeUInt32LE(0x004e4942, binHeader + 4);
  bin.copy(out, binHeader + 8);
  return out;
}
