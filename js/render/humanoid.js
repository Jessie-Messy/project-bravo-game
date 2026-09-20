// humanoid.js — procedural people, for everyone who has no character model.
//
// The stand-in rig was a BoxGeometry torso, a SphereGeometry head and four
// BoxGeometry limbs. Next to a modelled NPC it reads as a missing asset, which
// is what it was.
//
// THE CONSTRAINT THAT SHAPES EVERYTHING HERE: game3d.js's animateRig() drives a
// rig by destructuring `g.children` as [body, head, armL, armR, legL, legR,
// prop] and scaling each one to the size it wants. So the parts cannot become
// several meshes each — the whole silhouette has to be carried by the SAME
// SEVEN MESHES, in the same unit spaces, or every scale/position calculation in
// that file breaks at once.
//
// That is not a limitation so much as the interesting part. A box has no
// shoulders, no waist and no jaw, and all three are available for free from the
// same vertex budget if the vertices are put somewhere better. The unit spaces
// are load-bearing and must be preserved exactly:
//
//   torso   spans -0.5..0.5 on every axis   (was BoxGeometry(1,1,1))
//   head    spans -1..1 on every axis       (was SphereGeometry(1,8,6))
//   limb    spans -1..0 in Y, -0.5..0.5 XZ  (was a box translated -0.5 in Y,
//                                            so it pivots at the shoulder/hip)
//
// Everything a role needs beyond a body — a hood, a hat, a robe, an apron, a
// pauldron — is DRESSING, built separately and merged down to one geometry per
// style so it costs one draw call however many pieces it is made of, and cached
// by style so twenty guards share one helmet.
//
// ── WHICH WAY IS FORWARD ─────────────────────────────────────────────────────
// THE RIG FACES -Z. Not +Z. Every face, nose, eye, brow, beard, apron, buckle
// and nasal bar belongs at NEGATIVE z, and the cloak and the back of the skull
// at positive z. This is not a matter of taste — three separate places in
// game3d.js agree on it and would all have to change together:
//
//   applyProp()    puts a held weapon at  z = -bd*0.3   (in front of the body)
//   configureRig() puts a quadruped head at z = -(bd*0.5 + …)  (its front)
//   animateRig()   turns toward  atan2(-dx, -dz)        (-Z is forward)
//
// Getting this backwards builds a person whose face is on the back of their
// head — which looks exactly as odd as it sounds, and is easy to miss because
// the body is near enough symmetric that only the face gives it away.

import { mergeGeometries } from 'three/addons/utils/BufferGeometryUtils.js';

// three is passed in by the caller rather than imported, for the same reason
// grass.js and trees.js do it: this file must not decide which three the game
// is using. Every exported function sets it before doing anything, so the
// helpers below can rely on it.
let THREE = null;

// ── Ring-stitched tubes ──────────────────────────────────────────────────────
// Every body part here is a stack of horizontal rings joined into a tube. It is
// the same idea as a lathe, except each ring carries its own half-width AND
// half-depth, which is what allows a torso to be broad across the shoulders and
// shallow front-to-back — the single thing a box most obviously cannot do.

// One ring of `n` points around a superellipse. `k` blends circle (1) to
// rectangle (~3): shoulders want to be squarer than a waist.
function ring(y, hw, hd, n, k = 1.6) {
  const pts = [];
  for (let i = 0; i < n; i++) {
    const a = (i / n) * Math.PI * 2;
    const c = Math.cos(a), s = Math.sin(a);
    // Superellipse: |x|^k + |z|^k = 1, solved radially.
    const r = 1 / Math.pow(Math.pow(Math.abs(c), k) + Math.pow(Math.abs(s), k), 1 / k);
    pts.push(c * r * hw, y, s * r * hd);
  }
  return pts;
}

// Stitch a stack of rings into a closed tube, capped top and bottom.
function tube(rings, n, colorFor) {
  const pos = [], col = [], idx = [];
  for (const r of rings) for (let i = 0; i < n; i++) {
    pos.push(r[i * 3], r[i * 3 + 1], r[i * 3 + 2]);
    const c = colorFor ? colorFor(r[i * 3 + 1]) : null;
    if (c) col.push(c[0], c[1], c[2]);
  }
  for (let s = 0; s < rings.length - 1; s++) {
    const a = s * n, b = (s + 1) * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      idx.push(a + i, b + i, a + j,  a + j, b + i, b + j);
    }
  }
  // Caps. A fan to the ring's own centre, so the cap follows the ring's shape
  // rather than being a flat disc that pokes out of a non-circular profile.
  const cap = (rIdx, flip) => {
    const r = rings[rIdx], base = pos.length / 3;
    let cx = 0, cz = 0;
    for (let i = 0; i < n; i++) { cx += r[i * 3]; cz += r[i * 3 + 2]; }
    pos.push(cx / n, r[1], cz / n);
    if (col.length) { const c = colorFor ? colorFor(r[1]) : [1, 1, 1]; col.push(c[0], c[1], c[2]); }
    const off = rIdx * n;
    for (let i = 0; i < n; i++) {
      const j = (i + 1) % n;
      if (flip) idx.push(base, off + j, off + i);
      else      idx.push(base, off + i, off + j);
    }
  };
  cap(0, true); cap(rings.length - 1, false);

  const g = new THREE.BufferGeometry();
  g.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  if (col.length) g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  g.setIndex(idx);
  g.computeVertexNormals();
  return g;
}

// ── The three body parts ─────────────────────────────────────────────────────

/**
 * Torso. Unit box bounds (-0.5..0.5), so every `body.scale.set(bw, torso, bd)`
 * in game3d.js keeps meaning exactly what it meant.
 *
 * The profile is the whole point: narrow at the hips, pinched at the waist,
 * broad and square across the shoulders, then a short neck. Depth stays well
 * under width throughout — a person is a slab, not a column, and a box gave
 * them equal width and depth which is most of why it read as furniture.
 */
export function makeTorsoGeometry(three) {
  THREE = three;
  const N = 10;
  const rings = [
    ring(-0.50, 0.30, 0.24, N, 1.5),   // hips
    ring(-0.34, 0.34, 0.26, N, 1.5),
    ring(-0.14, 0.30, 0.22, N, 1.4),   // waist — the pinch
    ring( 0.10, 0.36, 0.25, N, 1.6),   // ribs
    ring( 0.32, 0.44, 0.26, N, 1.9),   // chest
    ring( 0.44, 0.50, 0.24, N, 2.4),   // shoulders — squarest ring
    ring( 0.48, 0.34, 0.19, N, 2.0),   // trapezius fall-off
    ring( 0.50, 0.12, 0.11, N, 1.2),   // neck
  ];
  return tube(rings, N);
}

/**
 * Head. Unit sphere bounds (-1..1), matching SphereGeometry(1, 8, 6).
 *
 * A sphere has no face. This has a cranium, a brow, cheekbones that are wider
 * than the jaw, a chin, and a nose — which sounds like a lot for something a
 * few pixels tall, but the silhouette is what the eye reads at distance, and a
 * head that narrows toward the chin is instantly a head.
 */
export function makeHeadGeometry(three) {
  THREE = three;
  // These were near 0.8 wide and squarish (k up to 1.6), which at the head
  // radius configureRig asks for produced a slab as wide as the shoulders — a
  // tombstone with a chin. A head is ROUND and it is small: 0.60 at the
  // cheekbones, k barely above 1, and the crown pulled in to 0.88 so the whole
  // thing does not fill its own unit box.
  const N = 12;
  const rings = [
    ring(-0.86, 0.17, 0.19, N, 1.1),   // under the chin
    ring(-0.66, 0.35, 0.39, N, 1.2),   // jaw
    ring(-0.40, 0.49, 0.53, N, 1.2),   // mouth line
    ring(-0.10, 0.58, 0.58, N, 1.2),   // cheekbones — widest
    ring( 0.18, 0.60, 0.56, N, 1.2),   // brow
    ring( 0.48, 0.55, 0.51, N, 1.1),   // upper skull
    ring( 0.72, 0.41, 0.38, N, 1.1),
    ring( 0.88, 0.16, 0.15, N, 1.1),   // crown
  ];
  const g = tube(rings, N);

  // The nose. Pushed out of the existing brow/cheek rings rather than added as
  // a separate lump, so it cannot detach from the face at any scale.
  const p = g.attributes.position;
  for (let i = 0; i < p.count; i++) {
    const x = p.getX(i), y = p.getY(i), z = p.getZ(i);
    if (z >= 0) continue;                                   // front half only (-Z)
    const face = Math.max(0, 1 - Math.abs(x) / 0.16);       // centred on the midline
    const height = Math.max(0, 1 - Math.abs(y + 0.12) / 0.32);
    if (face > 0 && height > 0) p.setZ(i, z - 0.15 * face * height);
  }
  // Flatten the back of the skull a little — a perfectly round back of the head
  // reads as a ball however good the front is. The back is +Z; see the facing
  // note at the top of this file.
  for (let i = 0; i < p.count; i++) {
    const z = p.getZ(i);
    if (z > 0) p.setZ(i, z * 0.86);
  }
  p.needsUpdate = true;
  g.computeVertexNormals();
  return g;
}

/**
 * Limb. Top-pivot: spans -1..0 in Y so `rotation.x` swings it from the
 * shoulder or hip, exactly as the box it replaces did.
 *
 * Tapered, with a slight swell at the top (deltoid / thigh) and a rounded end
 * for the hand or foot. The taper is what stops arms reading as planks.
 */
export function makeLimbGeometry(three) {
  THREE = three;
  const N = 8;
  const rings = [
    ring( 0.00, 0.46, 0.46, N, 1.3),   // shoulder / hip socket
    ring(-0.12, 0.50, 0.50, N, 1.3),   // swell
    ring(-0.45, 0.38, 0.38, N, 1.2),   // mid
    ring(-0.74, 0.30, 0.30, N, 1.2),   // wrist / ankle
    ring(-0.80, 0.37, 0.39, N, 1.2),   // cuff — where the boot or glove starts
    ring(-0.94, 0.38, 0.44, N, 1.2),   // hand / foot
    ring(-1.00, 0.26, 0.34, N, 1.2),
  ];
  // A boot and a glove, as a vertex-colour ramp rather than as extra meshes.
  //
  // Dressing cannot do this: dressing is parented to the group and the legs
  // SWING, so a boot built there would stand still while its leg walked out of
  // it. Baking it into the limb means it swings with the limb for free — and
  // because the limb material multiplies its colour by this attribute, the same
  // geometry gives dark boots on tan trousers and dark gloves on a pale sleeve
  // without anything having to know which limb it is.
  const g = tube(rings, N);
  const p = g.attributes.position, n = p.count, col = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) {
    // 1.0 above the cuff, 0.42 below it — a multiplier, not a colour.
    const v = p.getY(i) > -0.78 ? 1.0 : 0.42;
    col[i * 3] = v; col[i * 3 + 1] = v; col[i * 3 + 2] = v;
  }
  g.setAttribute('color', new THREE.Float32BufferAttribute(col, 3));
  return g;
}

// ── Dressing ─────────────────────────────────────────────────────────────────
// Everything that makes a role legible at a glance. Merged to ONE geometry per
// style with vertex colours, so a hooded robe with a rope belt and a satchel is
// still a single draw call and a single material.

// Vertex colours are consumed in the renderer's WORKING colour space, which is
// linear — unlike material.color, whose setHex() converts from sRGB for you.
// Dividing the hex bytes by 255 and storing that directly hands linear-space
// values that were authored as sRGB, and every colour comes out washed pale:
// a navy cloak (0x243352) rendered as periwinkle and a dark leather belt as
// beige. THREE.Color does the conversion; let it.
const _col = (hex) => {
  const c = new THREE.Color();
  c.setHex(hex, THREE.SRGBColorSpace);
  return [c.r, c.g, c.b];
};

function paint(geo, hex) {
  const n = geo.attributes.position.count, c = _col(hex), arr = new Float32Array(n * 3);
  for (let i = 0; i < n; i++) { arr[i * 3] = c[0]; arr[i * 3 + 1] = c[1]; arr[i * 3 + 2] = c[2]; }
  geo.setAttribute('color', new THREE.Float32BufferAttribute(arr, 3));
  return geo;
}
function ringTube(rings, n, hex) {
  return paint(tube(rings, n), hex);
}
function slab(w, h, d, hex, x = 0, y = 0, z = 0, rot = 0) {
  const g = new THREE.BoxGeometry(w, h, d);
  // `rot` was rotX-only. A number still means rotX, so every existing caller is
  // untouched; an object {x,y,z} rotates on any axis, which is what a sash
  // across the chest and a quiver slung on the back both need.
  if (typeof rot === 'number') { if (rot) g.rotateX(rot); }
  else if (rot) { if (rot.x) g.rotateX(rot.x); if (rot.y) g.rotateY(rot.y); if (rot.z) g.rotateZ(rot.z); }
  g.translate(x, y, z);
  // mergeGeometries refuses a set whose attributes do not match exactly, and
  // BoxGeometry ships a uv that tube() has no reason to produce — the dressing
  // material is vertex-coloured and carries no map, so the uv is dead weight
  // that would silently return null from every merge it took part in.
  g.deleteAttribute('uv');
  return paint(g, hex);
}

// Rotate and place an already-built piece. Kept separate from ringTube so a
// tube can be slung at an angle — a quiver across the back, a scroll case at
// the hip — without every ring having to be authored in the rotated frame.
// Order is rotate-then-translate, matching slab().
function oriented(g, rx = 0, ry = 0, rz = 0, x = 0, y = 0, z = 0) {
  if (rx) g.rotateX(rx);
  if (ry) g.rotateY(ry);
  if (rz) g.rotateZ(rz);
  if (x || y || z) g.translate(x, y, z);
  return g;
}

/**
 * Body dressing, in RIG-LOCAL space (the same space configureRig positions the
 * body and legs in), so it is built per body size.
 *
 * @param dims { bw, bh, bd, legH, torso }  already scaled by OBJ_SCALE
 */
export function buildBodyDressing(three, style, dims) {
  THREE = three;
  const { bw, bh, bd, legH, torso } = dims;
  const parts = [];
  const S = style || {};

  // Robe / long tunic: a flared skirt hanging from the waist. This is the
  // single highest-value piece of dressing there is — it replaces two bare
  // legs with a silhouette, and legs are the part a box rig gets most wrong.
  if (S.robe) {
    const top = legH + torso * 0.30, bot = legH * (S.robeShort ? 0.55 : 0.06);
    const N = 12;
    parts.push(ringTube([
      ring(top,                    bw * 0.42, bd * 0.62, N, 1.5),
      ring(top - (top - bot) * 0.4, bw * 0.60, bd * 0.80, N, 1.4),
      ring(bot + (top - bot) * 0.12, bw * 0.78, bd * 1.00, N, 1.3),
      ring(bot,                    bw * 0.84, bd * 1.06, N, 1.3),
    ], N, S.robe));
  }

  // Apron: a flat panel over the front, for anyone who works with their hands.
  if (S.apron) {
    parts.push(slab(bw * 0.78, torso * 0.62, bd * 0.16, S.apron,
                    0, legH + torso * 0.34, -bd * 0.46));
    parts.push(slab(bw * 0.18, torso * 0.30, bd * 0.10, S.apron,
                    0, legH + torso * 0.78, -bd * 0.44));   // bib
  }

  // Belt, and the buckle that makes it read as a belt rather than a stripe.
  if (S.belt) {
    const N = 10;
    parts.push(ringTube([
      ring(legH + torso * 0.06, bw * 0.54, bd * 0.62, N, 1.6),
      ring(legH + torso * 0.16, bw * 0.54, bd * 0.62, N, 1.6),
    ], N, S.belt));
    parts.push(slab(bw * 0.20, torso * 0.13, bd * 0.14, S.buckle || 0xd8c060,
                    0, legH + torso * 0.11, -bd * 0.60));
  }

  // Shoulder pauldrons: the fastest way to say "armoured" from any distance.
  if (S.pauldron) {
    for (const sx of [-1, 1]) {
      const N = 8, y = legH + torso * 0.92;
      parts.push(ringTube([
        ring(y + torso * 0.10, bw * 0.28, bd * 0.50, N, 1.3),
        ring(y - torso * 0.04, bw * 0.34, bd * 0.60, N, 1.4),
        ring(y - torso * 0.22, bw * 0.28, bd * 0.50, N, 1.4),
      ], N, S.pauldron).translate(sx * bw * 0.44, 0, 0));
    }
  }

  // Cloak. Built as a tube, not a panel: a flat slab the width of the body read
  // as a signboard strapped to the back, and being perfectly rectangular it hid
  // the belt and pauldrons behind it. Rings let it start narrow at the
  // shoulders, wrap slightly around the ribs and flare as it falls, which is
  // what a cloak does and what makes it read as cloth from any angle.
  if (S.cloak) {
    const N = 12, top = legH + torso * 1.02, bot = legH * 0.16;
    parts.push(ringTube([
      ring(top,                      bw * 0.38, bd * 0.30, N, 1.5),
      ring(top - (top - bot) * 0.30, bw * 0.50, bd * 0.44, N, 1.4),
      ring(top - (top - bot) * 0.70, bw * 0.62, bd * 0.54, N, 1.3),
      ring(bot,                      bw * 0.70, bd * 0.60, N, 1.3),
    ], N, S.cloak).translate(0, 0, bd * 0.34));
    // Clasp at the throat.
    parts.push(slab(bw * 0.26, torso * 0.09, bd * 0.18, S.buckle || 0xd8c060,
                    0, legH + torso * 1.00, -bd * 0.30));
  }

  // Satchel on the hip, for merchants and anyone who carries stock.
  if (S.satchel) {
    parts.push(slab(bw * 0.34, torso * 0.30, bd * 0.30, S.satchel,
                    bw * 0.55, legH + torso * 0.08, bd * 0.10));
  }

  // ── Role pieces ────────────────────────────────────────────────────────────
  // Everything above dresses a generic person. Everything below says WHICH
  // person. The rule they all follow: a piece must change the OUTLINE, because
  // the outline is all that survives being twelve pixels tall across a
  // courtyard. Colour alone does not — eleven figures in eleven colours still
  // read as eleven copies of one figure.

  // Tabard: livery panels front and back, hanging from the shoulders. The
  // single strongest "this person serves someone" signal, and it costs two
  // slabs. Front and back are separate so the arms swing between them.
  if (S.tabard) {
    const top = legH + torso * 0.92, bot = legH * 0.55;
    const h = top - bot, midY = (top + bot) * 0.5;
    for (const sz of [-1, 1])
      parts.push(slab(bw * 0.62, h, bd * 0.14, S.tabard, 0, midY, sz * bd * 0.52));
    // A band across the chest is what makes it livery rather than a bib.
    if (S.tabardTrim)
      parts.push(slab(bw * 0.66, torso * 0.10, bd * 0.17, S.tabardTrim,
                      0, top - h * 0.26, -bd * 0.52));
  }

  // Sash worn across the chest. Rotated on Z about the midline, so it stays
  // centred on the body and reads as a diagonal band from every angle.
  if (S.sash) {
    parts.push(slab(bw * 1.15, torso * 0.17, bd * 0.16, S.sash,
                    0, legH + torso * 0.56, -bd * 0.48, { z: 0.55 }));
  }

  // Mantle: a short shoulder cape. Distinct from `cloak` on purpose — a cloak
  // falls past the knee and hides the legs, a mantle stops at the ribs and
  // broadens the shoulders instead, which is a different silhouette entirely.
  if (S.mantle) {
    const N = 12, top = legH + torso * 1.04, bot = legH + torso * 0.40;
    parts.push(ringTube([
      ring(top,                       bw * 0.40, bd * 0.44, N, 1.4),
      ring(top - (top - bot) * 0.45,  bw * 0.68, bd * 0.64, N, 1.3),
      ring(bot,                       bw * 0.80, bd * 0.74, N, 1.3),
    ], N, S.mantle));
  }

  // Fur collar. Sits where the mantle ends, and is the cheapest way to make a
  // figure look WEALTHY rather than merely dressed.
  if (S.collar) {
    const N = 10, y = legH + torso * 1.00;
    parts.push(ringTube([
      ring(y - torso * 0.06, bw * 0.30, bd * 0.36, N, 1.2),
      ring(y + torso * 0.05, bw * 0.42, bd * 0.48, N, 1.2),
      ring(y + torso * 0.15, bw * 0.30, bd * 0.36, N, 1.2),
    ], N, S.collar));
  }

  // Gorget: the throat plate. Armour reads from the neck down, and a helm with
  // a bare throat under it looks like a costume.
  if (S.gorget) {
    const N = 10, y = legH + torso * 1.00;
    parts.push(ringTube([
      ring(y - torso * 0.02, bw * 0.28, bd * 0.32, N, 1.4),
      ring(y + torso * 0.11, bw * 0.23, bd * 0.27, N, 1.4),
    ], N, S.gorget));
  }

  // Chain of office: two links down to a pendant. For anyone whose authority is
  // the point — the curator, the banker.
  if (S.medallion) {
    const chain = S.chain || 0xd8c060;
    for (const sx of [-1, 1])
      parts.push(slab(bw * 0.055, torso * 0.44, bd * 0.06, chain,
                      sx * bw * 0.17, legH + torso * 0.80, -bd * 0.50, { z: sx * 0.32 }));
    parts.push(slab(bw * 0.24, bw * 0.24, bd * 0.11, S.medallion,
                    0, legH + torso * 0.58, -bd * 0.54));
  }

  // Coin pouch. Deliberately on the OPPOSITE hip from `satchel` so a merchant
  // can carry both and still be asymmetric — symmetry is what makes a figure
  // read as a mannequin.
  //
  // ⚠ It has to clear a FULL-LENGTH ROBE. At the old hip height the healer's
  // skirt was already ~6.9 half-widths out against a pouch reaching 6.2, so the
  // pouch was sealed inside the cloth and never drew. A full robe hangs from
  // `legH + torso*0.30`, so on those styles the pouch rides at the belt above
  // the skirt line instead of at the hip.
  if (S.pouch) {
    const onRobe = S.robe && !S.robeShort;
    parts.push(slab(bw * 0.22, torso * 0.17, bd * 0.20, S.pouch,
                    -bw * (onRobe ? 0.46 : 0.42),
                    legH + torso * (onRobe ? 0.40 : 0.04),
                    -bd * 0.38));
  }

  // Scroll case at the hip, slung on its strap.
  if (S.scrollCase) {
    const N = 8;
    parts.push(oriented(ringTube([
      ring(-torso * 0.30, bw * 0.10, bw * 0.10, N, 1.1),
      ring( torso * 0.30, bw * 0.10, bw * 0.10, N, 1.1),
    ], N, S.scrollCase), 0, 0, 0.62, bw * 0.34, legH + torso * 0.42, bd * 0.42));
  }

  // Quiver on the back, with fletchings showing over the shoulder. The
  // fletchings are the part that reads — a plain tube on someone's back is a
  // bedroll.
  if (S.quiver) {
    const N = 8, rz = -0.40;
    const qx = -bw * 0.36, qy = legH + torso * 0.56, qz = bd * 0.46;
    const topY = torso * 0.30;              // the tube's own top ring, unrotated
    parts.push(oriented(ringTube([
      ring(-torso * 0.34, bw * 0.14, bw * 0.14, N, 1.1),
      ring( topY,         bw * 0.16, bw * 0.16, N, 1.1),
    ], N, S.quiver), 0, 0, rz, qx, qy, qz));
    // Where that top ring ACTUALLY lands. The arrows were placed from the
    // tube's pre-rotation anchor, which leaves them beside the mouth rather
    // than in it — oriented() rotates THEN translates, so the mouth moves.
    // rotateZ: x' = -y·sin, y' = y·cos, for a point on the tube's axis.
    const mx = qx - topY * Math.sin(rz), my = qy + topY * Math.cos(rz);
    for (const dx of [-1, 0, 1])
      parts.push(slab(bw * 0.05, torso * 0.24, bw * 0.05, S.fletching || 0xe4e0d4,
                      mx + dx * bw * 0.085, my + torso * 0.10, qz));
  }

  // Tools hanging off the belt, in descending lengths. Three is enough to read
  // as a working belt; more just becomes fringe.
  if (S.toolLoop) {
    for (let i = 0; i < 3; i++)
      parts.push(slab(bw * 0.075, torso * (0.15 + i * 0.055), bd * 0.075, S.toolLoop,
                      bw * (0.28 + i * 0.12), legH - torso * 0.02, -bd * 0.36));
  }

  // Pack on the back, with the two straps that come over the shoulders. Without
  // the straps it floats.
  if (S.backpack) {
    parts.push(slab(bw * 0.62, torso * 0.60, bd * 0.38, S.backpack,
                    0, legH + torso * 0.60, bd * 0.62));
    for (const sx of [-1, 1])
      parts.push(slab(bw * 0.11, torso * 0.72, bd * 0.11, S.strap || S.belt || S.backpack,
                      sx * bw * 0.27, legH + torso * 0.68, -bd * 0.44));
  }

  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}

/**
 * Head dressing, in HEAD-LOCAL space — the head mesh spans -1..1 and is scaled
 * by the head radius, so a hat parented to it inherits both the scale and the
 * idle bob for free. Parenting it to the group instead would leave hats
 * hovering while their owner breathed.
 */
export function buildHeadDressing(three, style) {
  THREE = three;
  const S = style || {};
  const parts = [];

  // EYES. The single highest-value detail on the whole figure: a blank oval is
  // a mannequin at any distance, and two dark marks make it a person looking at
  // you. They cannot be vertex colours on the head — twelve points per ring is
  // far too coarse to paint a spot that small without it smearing across half
  // the cheek — so they are geometry, and they ride the head dressing that
  // already exists rather than costing a mesh of their own.
  //
  // Set on every style, because every style here is a person. An undressed rig
  // (an enemy, a stand-in before its outfit is chosen) gets no head dressing at
  // all and so gets no eyes, which is the right answer for those too.
  if (S.eyes !== false) {
    for (const sx of [-1, 1]) {
      // Sized for the art style, not for anatomy. At the head radius these rigs
      // use, an anatomically-proportioned eye is about 1% of the figure's
      // height — two pixels at the distance you actually play at, which is the
      // same as having none. Every stylised character does this.
      parts.push(slab(0.30, 0.19, 0.12, S.eye || 0x241c14, sx * 0.26, -0.02, -0.48));
      // A brow above each: it is what turns two dots into a face rather than
      // two holes, and it survives being lit from directly overhead at noon.
      parts.push(slab(0.36, 0.10, 0.09, S.brow || (S.hair || 0x3a2a1a), sx * 0.27, 0.15, -0.47));
    }
  }

  // Wide-brimmed pointed hat. The brim is what reads at distance; the point
  // just says which kind of person is under it.
  if (S.hat) {
    const N = 12;
    parts.push(ringTube([
      ring(0.78, 1.62, 1.62, N, 1.1),
      ring(0.94, 1.50, 1.50, N, 1.1),
      ring(0.98, 1.00, 1.00, N, 1.1),
    ], N, S.hat));                                    // brim
    parts.push(ringTube([
      ring(0.96, 0.98, 0.98, N, 1.1),
      ring(1.70, 0.62, 0.62, N, 1.1),
      ring(2.40, 0.16, 0.16, N, 1.1),
    ], N, S.hat));                                    // cone
    if (S.hatBand) parts.push(ringTube([
      ring(1.02, 1.00, 1.00, N, 1.1),
      ring(1.20, 0.94, 0.94, N, 1.1),
    ], N, S.hatBand));
  }

  // Hood: a cowl with an OPEN FRONT, so there is a face inside it.
  //
  // ⚠ This used to be a closed tube pushed 0.30 back, on the theory that it
  // "leaves the face in shadow". It did not leave the face in shadow — it
  // sealed the head inside an opaque bag. Its widest ring reached hd 1.14,
  // putting the front surface at z -0.84, while the eye slabs' front face is at
  // z -0.54 and the nose reaches -0.73. Everything on the face was INSIDE the
  // cloth: eyes, brows, beard, and anything a hooded style might add. That is
  // why the scholar's spectacles and the cryptologist's mask rendered as
  // nothing at all, and why four hooded NPCs were interchangeable silhouettes.
  //
  // Built the same way as `coif` and `longHair` now are: a crown cap plus back
  // and side slabs, leaving the front open, with a brow overhang above the eyes
  // to give the cowl its depth. The overhang sits at y 0.47..0.77 — clear of
  // the brow ridge at 0.15 — so it shades the face without covering it.
  if (S.hood) {
    const N = 12;
    parts.push(ringTube([
      ring(0.16, 1.02, 1.08, N, 1.35),
      ring(0.70, 0.92, 0.98, N, 1.3),
      ring(1.12, 0.48, 0.54, N, 1.2),
    ], N, S.hood).translate(0, 0, 0.08));
    parts.push(slab(1.72, 1.62, 0.36, S.hood, 0, -0.50, 0.84));      // back fall
    for (const sx of [-1, 1])
      parts.push(slab(0.36, 1.48, 1.42, S.hood, sx * 0.90, -0.44, 0.14));   // sides
    parts.push(slab(1.34, 0.30, 0.58, S.hood, 0, 0.62, -0.60));      // brow overhang
    // Collar around the throat, so the hood reads as attached to something.
    parts.push(ringTube([
      ring(-0.70, 0.78, 0.84, N, 1.3),
      ring(-0.38, 0.86, 0.92, N, 1.3),
    ], N, S.hood).translate(0, 0, 0.12));
  }

  // Flat cap, for townsfolk.
  if (S.cap) {
    const N = 10;
    parts.push(ringTube([
      ring(0.72, 1.10, 1.14, N, 1.3),
      ring(1.02, 1.02, 1.06, N, 1.3),
      ring(1.16, 0.72, 0.76, N, 1.2),
    ], N, S.cap));
  }

  // Helmet with a nasal bar.
  if (S.helm) {
    const N = 10;
    parts.push(ringTube([
      ring( 0.16, 0.72, 0.72, N, 1.3),   // rim sits ABOVE the eyes
      ring( 0.26, 0.84, 0.84, N, 1.3),   // flare — the shadow line that reads
      ring( 0.36, 0.73, 0.73, N, 1.3),
      ring( 0.62, 0.69, 0.69, N, 1.2),
      ring( 0.86, 0.48, 0.48, N, 1.2),
      ring( 1.00, 0.14, 0.14, N, 1.1),
    ], N, S.helm));
    // Nasal bar, hanging from the rim down over the nose. This is the piece
    // that says "helmet" rather than "hat" once the face below it is visible.
    parts.push(slab(0.13, 0.52, 0.14, S.helm, 0, -0.06, -0.60));
  }

  // Beard. Hangs from the jaw, widening as it falls — the single detail that
  // ages a face, and the reason the healers and the antiquarian get one.
  // Measured, not guessed: at the head radius configureRig asks for, the head
  // OVERLAPS the torso — there is no neck gap at all. A beard hanging to -1.55
  // put 87% of itself inside the chest and showed as a sliver. This one stops
  // just past the chin and is broader instead of longer, so all of it is in
  // open air and it reads as a full beard rather than as a point.
  if (S.beard) {
    const N = 10;
    parts.push(ringTube([
      ring(-0.24, 0.60, 0.56, N, 1.3),
      ring(-0.52, 0.68, 0.66, N, 1.3),
      ring(-0.80, 0.60, 0.62, N, 1.2),
      ring(-1.02, 0.30, 0.34, N, 1.1),
    ], N, S.beard).translate(0, 0, -0.16));
  }

  // Hair: a skull cap that stops short of the brow.
  if (S.hair) {
    const N = 10;
    parts.push(ringTube([
      ring(0.28, 0.86, 0.84, N, 1.5),   // hairline — above the brow, not on it
      ring(0.64, 0.82, 0.78, N, 1.4),
      ring(0.94, 0.60, 0.58, N, 1.2),
    ], N, S.hair));
  }

  // ── Role headwear ──────────────────────────────────────────────────────────
  //
  // ⚠ THE RULE EVERY PIECE BELOW OBEYS: anything that wraps the head is built
  // from SLABS at the back and sides, never as a closed tube. The head's front
  // reaches z -0.73 at the nose and the eye slabs' front face sits at z -0.54.
  // A tube wide enough to clear the ears (radius ~0.9) therefore passes in
  // FRONT of the eyes and blanks the face — the figure loses the one detail
  // that makes it a person, and it does so silently, because from behind the
  // piece looks perfect. `hood` gets away with a tube only because it is pushed
  // 0.30 back and is MEANT to leave the face in shadow.

  // Long hair: skull cap, a fall down the back, and a curtain either side.
  if (S.longHair) {
    const N = 10;
    parts.push(ringTube([
      ring(0.28, 0.88, 0.86, N, 1.5),
      ring(0.64, 0.84, 0.80, N, 1.4),
      ring(0.94, 0.62, 0.60, N, 1.2),
    ], N, S.longHair));
    parts.push(slab(1.34, 1.70, 0.32, S.longHair, 0, -0.48, 0.74));
    for (const sx of [-1, 1])
      parts.push(slab(0.30, 1.42, 1.12, S.longHair, sx * 0.78, -0.34, 0.16));
  }

  // Topknot.
  if (S.topknot) {
    const N = 8;
    parts.push(ringTube([
      ring(0.94, 0.24, 0.24, N, 1.1),
      ring(1.28, 0.32, 0.32, N, 1.1),
      ring(1.56, 0.13, 0.13, N, 1.1),
    ], N, S.topknot));
  }

  // Mail coif: crown cap plus a drape over the back and sides, face open.
  //
  // ⚠ THE CROWN MUST FIT UNDER THE HELM. A coif is worn beneath a helmet, and
  // `guard` sets both. The first version built the crown at r 0.94/0.86 against
  // a helm of r 0.73/0.69 — the mail swelled straight out through the steel on
  // all twenty guards. These radii are taken from the helm profile minus a
  // margin, so it reads as padding under the dome instead of through it. If you
  // change the helm rings, change these with them.
  if (S.coif) {
    const N = 12;
    parts.push(ringTube([
      ring(0.18, 0.66, 0.68, N, 1.3),
      ring(0.62, 0.60, 0.62, N, 1.3),
      ring(0.92, 0.36, 0.38, N, 1.2),
    ], N, S.coif));
    // ⚠ THE DRAPE MUST TOP OUT BELOW THE HELM RIM (y 0.16), not beside it.
    // Shrinking only the crown was not enough: measured in-page, the side
    // panels reached radius 1.27 at y 0.26 against a helm flare of 0.84, so the
    // mail flared out through the rim like ears. Below y 0.16 there is no helm
    // at any radius, so ending the panels at 0.14 removes the conflict outright
    // rather than trying to tune a width that fits under it.
    parts.push(slab(1.58, 1.38, 0.34, S.coif, 0, -0.55, 0.78));
    for (const sx of [-1, 1])
      parts.push(slab(0.34, 1.30, 1.34, S.coif, sx * 0.84, -0.51, 0.10));
  }

  // Circlet across the brow, with an optional stone at the front. The head is
  // ~0.57 wide at this height, so 0.66 sits proud of it rather than embedded.
  if (S.circlet) {
    const N = 12;
    parts.push(ringTube([
      ring(0.30, 0.66, 0.64, N, 1.2),
      ring(0.44, 0.66, 0.64, N, 1.2),
    ], N, S.circlet));
    if (S.gem) parts.push(slab(0.22, 0.20, 0.15, S.gem, 0, 0.37, -0.62));
  }

  // Spectacles. Built as four bars per lens rather than a filled rectangle: a
  // solid block at this size is two black eyes, which is what the eye slabs
  // underneath already are. The frame has to be a FRAME to read as glass.
  if (S.spectacles) {
    const f = S.spectacles;
    for (const sx of [-1, 1]) {
      parts.push(slab(0.36, 0.05, 0.06, f, sx * 0.26,  0.11, -0.57));
      parts.push(slab(0.36, 0.05, 0.06, f, sx * 0.26, -0.15, -0.57));
      parts.push(slab(0.05, 0.26, 0.06, f, sx * 0.43, -0.02, -0.57));
      parts.push(slab(0.05, 0.26, 0.06, f, sx * 0.09, -0.02, -0.57));
    }
    parts.push(slab(0.20, 0.05, 0.06, f, 0, -0.02, -0.57));   // bridge
  }

  // Scarf pulled up over the mouth and jaw. Sits BELOW the eyes (y -0.02), so
  // unlike everything else in this section it can safely be a tube.
  if (S.maskScarf) {
    const N = 10;
    parts.push(ringTube([
      ring(-0.18, 0.63, 0.63, N, 1.2),
      ring(-0.52, 0.58, 0.60, N, 1.2),
      ring(-0.80, 0.40, 0.44, N, 1.2),
    ], N, S.maskScarf).translate(0, 0, -0.04));
  }

  // Feather in the hat or helm. Angled back and out, because a plume standing
  // straight up reads as an antenna.
  if (S.plume) {
    const N = 6;
    parts.push(oriented(ringTube([
      ring(0.00, 0.11, 0.06, N, 1.1),
      ring(0.58, 0.19, 0.09, N, 1.1),
      ring(1.10, 0.05, 0.04, N, 1.1),
    ], N, S.plume), -0.34, 0, 0.30, 0.36, 0.90, 0.14));
  }

  // Moustache, for a face that wants age without the bulk of a full beard.
  if (S.mustache) {
    parts.push(slab(0.54, 0.13, 0.15, S.mustache, 0, -0.34, -0.52));
  }

  if (!parts.length) return null;
  const merged = mergeGeometries(parts, false);
  for (const p of parts) p.dispose();
  return merged;
}
