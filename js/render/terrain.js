// terrain.js — the world's height field.
//
// The ground was a single flat PlaneGeometry at y=0 and everything in the game
// assumed it. This adds elevation WITHOUT touching collision: heights are a
// pure visual displacement that every ground-sitting object samples, so
// walkability, `boxBlocked`, the server's walkB64 bitmap and all multiplayer
// validation continue to work in 2D exactly as before. Two clients derive
// identical heights from the same seed, so nobody desyncs.
//
// The field is BAKED TO A GRID ONCE at boot, then sampled bilinearly. It is not
// evaluated as noise per query: grass alone asks for ~190k heights every time
// the instance window slides, and running fbm that many times per rebuild is a
// visible hitch. One 480x554 Float32Array is ~1MB and turns every later query
// into two lerps.
//
// Flattening is the part that makes it safe rather than pretty. Rivers must
// stay level or the water plane clips through its own banks, and the city's
// buildings are axis-aligned boxes that would float or sink on a slope. Both
// are flattened via the caller's `flatAt` callback, with a smooth falloff so
// the transition doesn't read as a terrace.

function rng(seed){
  let s = seed >>> 0;
  return () => {
    s = (s + 0x6D2B79F5) >>> 0;
    let t = Math.imul(s ^ (s >>> 15), 1 | s);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/**
 * @param TILE, MAP_W, MAP_H   world metrics
 * @param amplitude            peak height in world units
 * @param seed                 deterministic across clients
 * @param flatAt(tx,ty)        0 = fully flattened, 1 = full relief.
 *                             Called once per tile at bake time only.
 */
/**
 * `bedAt(tx,ty)` returns how far BELOW the flattened level this tile's ground
 * should sit, in world units. It carves riverbeds, which is what turns water
 * from a decorative plane into something with a depth you can wade or drown in.
 * Applied before the blur so the banks shelve smoothly instead of dropping off
 * a step.
 */
export function createHeightField({ TILE, MAP_W, MAP_H, amplitude = 90, seed = 1337, flatAt = null, bedAt = null }){
  const rand = rng(seed);
  // Random phase offsets so the terrain isn't visibly symmetric about the origin
  const ox = rand() * 1000, oy = rand() * 1000;

  const hash = (x, y) => {
    let h = (Math.imul(x | 0, 374761393) ^ Math.imul(y | 0, 668265263)) >>> 0;
    h = Math.imul(h ^ (h >>> 13), 1274126177);
    return ((h ^ (h >>> 16)) >>> 0) / 4294967296;
  };
  const vnoise = (x, y) => {
    const xi = Math.floor(x), yi = Math.floor(y);
    let fx = x - xi, fy = y - yi;
    fx = fx * fx * (3 - 2 * fx); fy = fy * fy * (3 - 2 * fy);
    const a = hash(xi, yi),     b = hash(xi + 1, yi);
    const c = hash(xi, yi + 1), d = hash(xi + 1, yi + 1);
    return (a + (b - a) * fx) + ((c + (d - c) * fx) - (a + (b - a) * fx)) * fy;
  };

  // Wavelengths are in TILES. The big term is the one you read as landscape —
  // broad swells you crest and descend over many seconds of walking. The finer
  // octaves only stop the slopes from looking machined; pushed any harder they
  // turn into noise that fights the grass.
  const H = new Float32Array(MAP_W * MAP_H);
  for(let ty = 0; ty < MAP_H; ty++){
    for(let tx = 0; tx < MAP_W; tx++){
      const x = tx + ox, y = ty + oy;
      let n = vnoise(x / 29, y / 29) * 0.58
            + vnoise(x / 13, y / 13) * 0.28
            + vnoise(x /  6, y /  6) * 0.14;
      // Bias downward so most of the map sits low and highs are occasional,
      // rather than the whole world hovering at half amplitude.
      n = Math.pow(n, 1.45);
      let h = n * amplitude;
      if(flatAt){
        const f = flatAt(tx, ty);
        if(f < 1) h *= f;
      }
      if(bedAt) h -= bedAt(tx, ty);
      H[ty * MAP_W + tx] = h;
    }
  }

  // Smooth the flatten seams. Carving a river valley leaves a step where the
  // flattened band meets full relief; a couple of blur passes turn that step
  // into a bank. Cheap separable box blur, run twice.
  const blur = (src) => {
    const tmp = new Float32Array(src.length), out = new Float32Array(src.length);
    for(let y = 0; y < MAP_H; y++){
      for(let x = 0; x < MAP_W; x++){
        let s = 0, n = 0;
        for(let d = -2; d <= 2; d++){
          const xx = x + d; if(xx < 0 || xx >= MAP_W) continue;
          s += src[y * MAP_W + xx]; n++;
        }
        tmp[y * MAP_W + x] = s / n;
      }
    }
    for(let y = 0; y < MAP_H; y++){
      for(let x = 0; x < MAP_W; x++){
        let s = 0, n = 0;
        for(let d = -2; d <= 2; d++){
          const yy = y + d; if(yy < 0 || yy >= MAP_H) continue;
          s += tmp[yy * MAP_W + x]; n++;
        }
        out[y * MAP_W + x] = s / n;
      }
    }
    return out;
  };
  let field = blur(blur(H));

  // Re-apply the hard flatten AFTER blurring. The blur bleeds relief back into
  // the flattened zones, which would tilt the water plane and the city's
  // buildings by a few units — small, but it's exactly the kind of thing that
  // makes a wall hover with a visible gap under one corner.
  if(flatAt){
    for(let ty = 0; ty < MAP_H; ty++){
      for(let tx = 0; tx < MAP_W; tx++){
        const i = ty * MAP_W + tx;
        const f = flatAt(tx, ty);
        // Flatten multiplies, then the bed is re-subtracted. Order matters:
        // flatAt returns 0 over water, so multiplying alone would erase the
        // carved bed and hand back a flat river with no depth to wade in.
        if(f < 1) field[i] *= f;
        if(bedAt){ const b = bedAt(tx, ty); if(b > 0) field[i] -= b; }
      }
    }
  }

  // Bilinear sample in WORLD units. Tile centres sit at +0.5, matching the
  // convention the water mask already uses.
  function heightAt(wx, wz){
    const fx = wx / TILE - 0.5, fy = wz / TILE - 0.5;
    let x0 = Math.floor(fx), y0 = Math.floor(fy);
    const ax = fx - x0, ay = fy - y0;
    let x1 = x0 + 1, y1 = y0 + 1;
    if(x0 < 0) x0 = 0; else if(x0 > MAP_W - 1) x0 = MAP_W - 1;
    if(x1 < 0) x1 = 0; else if(x1 > MAP_W - 1) x1 = MAP_W - 1;
    if(y0 < 0) y0 = 0; else if(y0 > MAP_H - 1) y0 = MAP_H - 1;
    if(y1 < 0) y1 = 0; else if(y1 > MAP_H - 1) y1 = MAP_H - 1;
    const r0 = y0 * MAP_W, r1 = y1 * MAP_W;
    const v0 = field[r0 + x0] + (field[r0 + x1] - field[r0 + x0]) * ax;
    const v1 = field[r1 + x0] + (field[r1 + x1] - field[r1 + x0]) * ax;
    return v0 + (v1 - v0) * ay;
  }

  // Surface normal by central difference — used to blend rock onto steep faces
  // and to tilt props so they sit along the slope instead of standing plumb on
  // a hillside.
  function slopeAt(wx, wz, out){
    const d = TILE;
    const hL = heightAt(wx - d, wz), hR = heightAt(wx + d, wz);
    const hD = heightAt(wx, wz - d), hU = heightAt(wx, wz + d);
    const nx = hL - hR, nz = hD - hU, ny = 2 * d;
    const len = Math.hypot(nx, ny, nz) || 1;
    if(out){ out.set(nx / len, ny / len, nz / len); return out; }
    return { x: nx / len, y: ny / len, z: nz / len };
  }

  // Displace an existing PlaneGeometry in place. It must already be rotated
  // flat (-PI/2 about X) by the caller, so the plane's local Y is world Z.
  function displacePlane(geometry, originX = 0, originZ = 0){
    const pos = geometry.attributes.position;
    for(let i = 0; i < pos.count; i++){
      // Pre-rotation local coords: x -> world X, y -> world Z (negated by the
      // -PI/2 rotation the caller applies), z -> world height.
      const wx = pos.getX(i) + originX;
      const wz = -pos.getY(i) + originZ;
      pos.setZ(i, heightAt(wx, wz));
    }
    pos.needsUpdate = true;
    geometry.computeVertexNormals();
    geometry.computeBoundingSphere();
    return geometry;
  }

  return { heightAt, slopeAt, displacePlane, amplitude, field };
}
