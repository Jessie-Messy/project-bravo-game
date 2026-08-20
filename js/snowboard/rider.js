// rider.js — the rider and the board, both built from numbers.
//
// The rider is a segmented figure, not a skinned mesh: capsules parented at the
// joints and rotated per frame. That is a deliberate trade. A skinned character
// needs a rig, weights and animation clips — three asset pipelines — and at the
// distance this camera actually sits, a clean segmented figure with good
// silhouette and good pose reads BETTER than a low-budget skinned one, because
// there is no weight-painting to go wrong at the shoulder and hip.
//
// Everything is driven from one pose object, so the same class serves the game,
// the character-select turntable and the board-select turntable.
//
// Stance geometry: the board's long axis is local Z, the rider stands across it
// facing local +X (the toe edge), bindings angled +15°/-6° like a real
// all-mountain setup. Edge angle rolls the whole assembly about local Z, which
// is exactly what a carve is.

import * as THREE from 'three';

const CAP = (r, len, seg = 8) => new THREE.CapsuleGeometry(r, len, 3, seg);

function mat(color, opts = {}) {
  return new THREE.MeshStandardMaterial({
    color, roughness: opts.roughness ?? 0.72, metalness: opts.metalness ?? 0.02,
    envMapIntensity: opts.env ?? 1.0, ...(opts.extra || {}),
  });
}

// ── Topsheet art ──────────────────────────────────────────────────
// Painted into a canvas at load. Six patterns, each a few lines, and the board
// list can grow without a single image file.
function makeTopsheet(art) {
  const W = 256, H = 1024;
  const cv = document.createElement('canvas');
  cv.width = W; cv.height = H;
  const g = cv.getContext('2d');
  g.fillStyle = art.base; g.fillRect(0, 0, W, H);

  const grd = g.createLinearGradient(0, 0, 0, H);
  grd.addColorStop(0, 'rgba(255,255,255,0.16)');
  grd.addColorStop(0.5, 'rgba(0,0,0,0.0)');
  grd.addColorStop(1, 'rgba(0,0,0,0.22)');
  g.fillStyle = grd; g.fillRect(0, 0, W, H);

  g.save();
  switch (art.pattern) {
    case 'ridge': {
      // Layered mountain silhouettes marching up the board.
      for (let l = 0; l < 4; l++) {
        g.fillStyle = l % 2 ? art.accent : art.ink;
        g.globalAlpha = 0.28 + l * 0.2;
        g.beginPath();
        const baseY = H * (0.72 - l * 0.11);
        g.moveTo(0, H);
        for (let x = 0; x <= W; x += 8) {
          const t = x / W;
          const y = baseY - Math.abs(Math.sin(t * 3.1 + l)) * 90 - Math.sin(t * 11 + l * 2) * 12;
          g.lineTo(x, y);
        }
        g.lineTo(W, H); g.closePath(); g.fill();
      }
      break;
    }
    case 'splatter': {
      for (let i = 0; i < 220; i++) {
        g.fillStyle = i % 3 === 0 ? art.ink : art.accent;
        g.globalAlpha = 0.25 + Math.random() * 0.6;
        const r = 2 + Math.random() * 26;
        g.beginPath(); g.arc(Math.random() * W, Math.random() * H, r, 0, 6.283); g.fill();
      }
      break;
    }
    case 'wave': {
      for (let i = 0; i < 26; i++) {
        g.strokeStyle = i % 2 ? art.accent : art.ink;
        g.globalAlpha = 0.5;
        g.lineWidth = 3 + (i % 4);
        g.beginPath();
        for (let y = 0; y <= H; y += 10) {
          const x = W * 0.5 + Math.sin(y * 0.012 + i * 0.5) * (30 + i * 4);
          y === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.stroke();
      }
      break;
    }
    case 'race': {
      g.fillStyle = art.accent; g.globalAlpha = 1;
      g.fillRect(W * 0.36, 0, W * 0.10, H);
      g.fillStyle = art.ink;
      g.fillRect(W * 0.50, 0, W * 0.05, H);
      g.globalAlpha = 0.9; g.fillStyle = art.accent;
      for (let i = 0; i < 9; i++) g.fillRect(0, H * (0.08 + i * 0.1), W, 6);
      break;
    }
    case 'topo': {
      g.strokeStyle = art.accent; g.globalAlpha = 0.55; g.lineWidth = 2;
      for (let i = 0; i < 22; i++) {
        g.beginPath();
        for (let a = 0; a <= 6.4; a += 0.15) {
          const rr = 40 + i * 16 + Math.sin(a * 3 + i) * 12;
          const x = W * 0.5 + Math.cos(a) * rr * 0.5;
          const y = H * 0.5 + Math.sin(a) * rr * 1.5;
          a === 0 ? g.moveTo(x, y) : g.lineTo(x, y);
        }
        g.stroke();
      }
      break;
    }
    case 'aurora': {
      for (let i = 0; i < 8; i++) {
        const gg = g.createLinearGradient(0, H * (i / 8), W, H * ((i + 3) / 8));
        gg.addColorStop(0, 'rgba(0,0,0,0)');
        gg.addColorStop(0.5, i % 2 ? art.accent : art.ink);
        gg.addColorStop(1, 'rgba(0,0,0,0)');
        g.fillStyle = gg; g.globalAlpha = 0.42;
        g.beginPath();
        g.moveTo(0, H * (i / 8));
        for (let x = 0; x <= W; x += 8) g.lineTo(x, H * (i / 8) + Math.sin(x * 0.03 + i) * 40 + 60);
        for (let x = W; x >= 0; x -= 8) g.lineTo(x, H * (i / 8) + Math.sin(x * 0.03 + i) * 40 - 40);
        g.closePath(); g.fill();
      }
      break;
    }
  }
  g.restore();

  // Edge inlay + a maker's mark, so the board reads as a product.
  g.globalAlpha = 1;
  g.strokeStyle = 'rgba(255,255,255,0.35)'; g.lineWidth = 6;
  g.strokeRect(10, 10, W - 20, H - 20);

  const t = new THREE.CanvasTexture(cv);
  t.colorSpace = THREE.SRGBColorSpace;
  t.anisotropy = 8;
  return t;
}

// ── Board geometry ────────────────────────────────────────────────
// Lofted from the sidecut: a real board is a waisted outline with a wider nose
// than tail (taper), camber arching the middle up off the snow, and rocker
// lifting both tips. All four are in the data, so a swallowtail powder board
// and an alpine race plate come out visibly different.
function makeBoardGeometry(b) {
  const N = 48, TH = 0.014;
  const top = [], bot = [];
  for (let i = 0; i <= N; i++) {
    const t = (i / N) * 2 - 1;              // -1 tail … +1 nose
    const at = Math.abs(t);

    // Outline: waist at centre, flaring toward the contact points, then the
    // tips round off. Taper makes the tail narrower than the nose.
    let hw = b.waist * 0.5 * (1 + 0.30 * at * at);
    hw *= (t > 0 ? 1 + b.taper * 0.5 : 1 - b.taper * 0.5);
    hw *= 1 - Math.pow(Math.max(0, at - 0.90) / 0.10, 1.6) * 0.92;   // rounded tips

    // Profile: camber arch through the middle, rocker lifting the tips.
    const camber = b.camber * (1 - Math.min(1, at / 0.78) ** 2);
    const rocker = Math.pow(Math.max(0, at - 0.62) / 0.38, 2.2) * (t > 0 ? b.nose : b.nose * 0.62) * 0.13;
    const y = camber + rocker;
    const z = t * b.length * 0.5;

    top.push([-hw, y + TH, z], [hw, y + TH, z]);
    bot.push([-hw, y, z], [hw, y, z]);
  }

  const pos = [], uv = [], idx = [];
  const pushRing = (arr) => { for (const p of arr) { pos.push(p[0], p[1], p[2]); } };
  pushRing(top); pushRing(bot);
  for (let i = 0; i <= N; i++) {
    const t = i / N;
    uv.push(0, t, 1, t);      // top face gets the topsheet
  }
  for (let i = 0; i <= N; i++) { const t = i / N; uv.push(0, t, 1, t); }

  const TOPBASE = 0, BOTBASE = (N + 1) * 2;
  for (let i = 0; i < N; i++) {
    const a = TOPBASE + i * 2, b2 = a + 1, c = a + 2, d = a + 3;
    idx.push(a, c, b2, b2, c, d);                                   // top face
    const e = BOTBASE + i * 2, f = e + 1, g2 = e + 2, h = e + 3;
    idx.push(e, f, g2, f, h, g2);                                   // base
    // Sidewalls
    idx.push(a, e, c, c, e, g2);
    idx.push(b2, d, f, d, h, f);
  }
  // Tip caps
  idx.push(TOPBASE, TOPBASE + 1, BOTBASE, TOPBASE + 1, BOTBASE + 1, BOTBASE);
  const lt = TOPBASE + N * 2, lb = BOTBASE + N * 2;
  idx.push(lt + 1, lt, lb + 1, lt, lb, lb + 1);

  const geo = new THREE.BufferGeometry();
  geo.setAttribute('position', new THREE.Float32BufferAttribute(pos, 3));
  geo.setAttribute('uv', new THREE.Float32BufferAttribute(uv, 2));
  geo.setIndex(idx);
  geo.computeVertexNormals();
  return geo;
}

export function createBoard(boardDef, { shadows = true } = {}) {
  const grp = new THREE.Group();
  const tex = makeTopsheet(boardDef.art);
  const deck = new THREE.Mesh(
    makeBoardGeometry(boardDef),
    new THREE.MeshStandardMaterial({ map: tex, roughness: 0.24, metalness: 0.12, envMapIntensity: 1.3 }),
  );
  deck.castShadow = shadows;
  grp.add(deck);

  // Steel edges: two thin strips that catch the sun on a carve.
  const edgeMat = new THREE.MeshStandardMaterial({ color: 0xdfe6f0, roughness: 0.16, metalness: 0.95, envMapIntensity: 1.8 });
  for (const s of [-1, 1]) {
    const e = new THREE.Mesh(new THREE.BoxGeometry(0.006, 0.006, boardDef.length * 0.94), edgeMat);
    e.position.set(s * boardDef.waist * 0.5, 0.001, 0);
    grp.add(e);
  }

  // Bindings — highback, straps, baseplate — angled like a real stance.
  const bindMat = mat(0x14171f, { roughness: 0.55 });
  const strapMat = mat(0x2b313d, { roughness: 0.8 });
  const stance = boardDef.length * 0.175;
  const angles = [15, -6];
  const bindings = [];
  for (let i = 0; i < 2; i++) {
    const b = new THREE.Group();
    const base = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.02, 0.26), bindMat);
    base.position.y = 0.022; b.add(base);
    const high = new THREE.Mesh(new THREE.BoxGeometry(0.13, 0.17, 0.03), bindMat);
    high.position.set(0, 0.11, -0.11); high.rotation.x = -0.22; b.add(high);
    for (const sy of [0.055, 0.11]) {
      const st = new THREE.Mesh(new THREE.BoxGeometry(0.14, 0.026, 0.02), strapMat);
      st.position.set(0, sy, 0.03); b.add(st);
    }
    b.position.set(0, 0.014, (i === 0 ? 1 : -1) * stance);
    b.rotation.y = THREE.MathUtils.degToRad(angles[i]);
    b.castShadow = shadows;
    grp.add(b);
    bindings.push(b);
  }

  grp.userData.dispose = () => {
    deck.geometry.dispose(); deck.material.dispose(); tex.dispose();
    edgeMat.dispose(); bindMat.dispose(); strapMat.dispose();
  };
  grp.userData.bindings = bindings;
  grp.userData.stance = stance;
  return grp;
}

// ── Rider ─────────────────────────────────────────────────────────
export function createRider(riderDef, boardDef, { shadows = true } = {}) {
  const fit = riderDef.fit, build = riderDef.build;
  const H = build.height;
  const S = H / 1.75;                      // scale everything off a 1.75 m base

  const root = new THREE.Group();          // world placement
  const tilt = new THREE.Group();          // edge angle — rolls about the board
  root.add(tilt);

  const board = createBoard(boardDef, { shadows });
  tilt.add(board);

  const body = new THREE.Group();          // everything above the bindings
  tilt.add(body);

  const jacket = mat(fit.jacket, { roughness: 0.62 });
  const jacketAlt = mat(fit.jacketAlt, { roughness: 0.62 });
  const pants = mat(fit.pants, { roughness: 0.78 });
  const bootM = mat(fit.boots, { roughness: 0.5 });
  const skin = mat(fit.skin, { roughness: 0.85 });
  const hairM = mat(fit.hair, { roughness: 0.9 });
  const lensM = new THREE.MeshStandardMaterial({
    color: fit.goggle, roughness: 0.08, metalness: 0.65, envMapIntensity: 2.2,
    emissive: new THREE.Color(fit.goggle).multiplyScalar(0.12),
  });
  const frameM = mat(fit.goggleFrame, { roughness: 0.5 });
  const mats = [jacket, jacketAlt, pants, bootM, skin, hairM, lensM, frameM];

  const stance = board.userData.stance;
  const legL = 0.44 * S, shinL = 0.42 * S;

  // Legs: hip → knee → ankle, one chain per side, ankles pinned to the bindings.
  const legs = [];
  for (let i = 0; i < 2; i++) {
    const sign = i === 0 ? 1 : -1;
    const hip = new THREE.Group();
    hip.position.set(0, 0.86 * S, sign * stance * 0.55);
    const thigh = new THREE.Mesh(CAP(0.085 * S, legL * 0.75), pants);
    thigh.position.y = -legL * 0.5; thigh.castShadow = shadows;
    hip.add(thigh);

    const knee = new THREE.Group();
    knee.position.y = -legL;
    const shin = new THREE.Mesh(CAP(0.070 * S, shinL * 0.72), pants);
    shin.position.y = -shinL * 0.5; shin.castShadow = shadows;
    knee.add(shin);

    const ankle = new THREE.Group();
    ankle.position.y = -shinL;
    const boot = new THREE.Mesh(new THREE.BoxGeometry(0.115 * S, 0.20 * S, 0.24 * S), bootM);
    boot.position.y = -0.05 * S;
    boot.castShadow = shadows;
    ankle.add(boot);
    knee.add(ankle);

    hip.add(knee);
    body.add(hip);
    legs.push({ hip, knee, ankle, sign });
  }

  // Torso
  const pelvis = new THREE.Group();
  pelvis.position.y = 0.88 * S;
  body.add(pelvis);
  const hipMesh = new THREE.Mesh(CAP(0.135 * S, 0.10 * S), pants);
  hipMesh.rotation.z = Math.PI / 2; hipMesh.castShadow = shadows;
  pelvis.add(hipMesh);

  const spine = new THREE.Group();
  spine.position.y = 0.04 * S;
  pelvis.add(spine);
  const chest = new THREE.Mesh(CAP(build.chest * S, 0.30 * S), jacket);
  chest.position.y = 0.22 * S; chest.castShadow = shadows;
  spine.add(chest);
  // Shoulder yoke in the contrast colour — the detail that stops the jacket
  // reading as a single extruded tube.
  const yoke = new THREE.Mesh(CAP(build.chest * S * 1.02, 0.10 * S), jacketAlt);
  yoke.position.y = 0.34 * S; yoke.castShadow = shadows;
  spine.add(yoke);

  if (fit.scarf) {
    const sc = new THREE.Mesh(new THREE.TorusGeometry(0.10 * S, 0.038 * S, 6, 14), mat(fit.scarf, { roughness: 0.9 }));
    sc.rotation.x = Math.PI / 2; sc.position.y = 0.44 * S;
    spine.add(sc);
    mats.push(sc.material);
  }

  // Head
  const neck = new THREE.Group();
  neck.position.y = 0.46 * S;
  spine.add(neck);
  const head = new THREE.Mesh(new THREE.SphereGeometry(0.105 * S, 14, 12), skin);
  head.scale.set(0.94, 1.06, 1.0);
  head.position.y = 0.10 * S; head.castShadow = shadows;
  neck.add(head);

  if (fit.helmet) {
    const hel = new THREE.Mesh(new THREE.SphereGeometry(0.122 * S, 16, 12, 0, Math.PI * 2, 0, Math.PI * 0.62), mat(fit.helmet, { roughness: 0.28, metalness: 0.1 }));
    hel.position.y = 0.115 * S; hel.castShadow = shadows;
    neck.add(hel);
    mats.push(hel.material);
  } else {
    const bn = new THREE.Mesh(new THREE.SphereGeometry(0.120 * S, 14, 12, 0, Math.PI * 2, 0, Math.PI * 0.60), mat(fit.beanie || 0x333333, { roughness: 0.95 }));
    bn.position.y = 0.118 * S; bn.castShadow = shadows;
    neck.add(bn);
    const cuff = new THREE.Mesh(new THREE.TorusGeometry(0.108 * S, 0.024 * S, 6, 16), bn.material);
    cuff.rotation.x = Math.PI / 2; cuff.position.y = 0.10 * S;
    neck.add(cuff);
    const bob = new THREE.Mesh(new THREE.SphereGeometry(0.042 * S, 10, 8), bn.material);
    bob.position.y = 0.235 * S;
    neck.add(bob);
    mats.push(bn.material);
    // Hair spilling out under the beanie.
    const hair = new THREE.Mesh(new THREE.SphereGeometry(0.112 * S, 12, 10, 0, Math.PI * 2, Math.PI * 0.42, Math.PI * 0.30), hairM);
    hair.position.y = 0.10 * S;
    neck.add(hair);
  }

  // Goggles — strap band plus a wraparound lens.
  const strap = new THREE.Mesh(new THREE.TorusGeometry(0.113 * S, 0.020 * S, 6, 18), frameM);
  strap.rotation.x = Math.PI / 2; strap.position.y = 0.115 * S;
  neck.add(strap);
  const lens = new THREE.Mesh(new THREE.SphereGeometry(0.108 * S, 16, 10, -0.95, 1.9, 0.85, 0.62), lensM);
  lens.position.y = 0.112 * S;
  lens.rotation.y = Math.PI * 0.5;
  lens.scale.set(1.06, 1.0, 1.10);
  neck.add(lens);

  // Arms: shoulder → elbow → glove.
  const arms = [];
  for (let i = 0; i < 2; i++) {
    const sign = i === 0 ? 1 : -1;
    const sh = new THREE.Group();
    sh.position.set(0, 0.38 * S, sign * build.shoulders * 0.5 * S);
    const upper = new THREE.Mesh(CAP(0.055 * S, 0.22 * S), jacket);
    upper.position.y = -0.16 * S; upper.castShadow = shadows;
    sh.add(upper);
    const el = new THREE.Group();
    el.position.y = -0.32 * S;
    const fore = new THREE.Mesh(CAP(0.048 * S, 0.20 * S), jacket);
    fore.position.y = -0.14 * S; fore.castShadow = shadows;
    el.add(fore);
    const glove = new THREE.Mesh(new THREE.SphereGeometry(0.062 * S, 10, 8), jacketAlt);
    glove.position.y = -0.29 * S; glove.scale.set(1, 0.9, 1.15);
    el.add(glove);
    sh.add(el);
    spine.add(sh);
    arms.push({ sh, el, sign, glove });
  }

  // ── Pose ────────────────────────────────────────────────────────
  const pose = {
    crouch: 0.35,   // 0 = standing tall, 1 = fully compressed
    edge: 0,        // -1 heelside … +1 toeside
    lean: 0,        // fore/aft weight
    twist: 0,       // torso counter-rotation, radians
    air: 0,         // 0 on snow, 1 fully airborne
    grab: 0,        // 0 none, 1 grabbing
    grabType: 0,    // 0 indy, 1 melon, 2 nose, 3 tail
    crash: 0,       // 0 upright, 1 wiped out
    speed: 0,       // 0..1, tucks the rider down at speed
    t: 0,
  };

  function updatePose(dt) {
    pose.t += dt;
    const c = pose.crouch;
    const air = pose.air;
    const crash = pose.crash;

    // Edge roll is the whole point — everything else hangs off it.
    tilt.rotation.z = pose.edge * 0.62;

    // Knees and hips compress together. Airborne, the rider tucks harder.
    const kneeBend = 0.35 + c * 1.05 + air * 0.55;
    const hipBend = 0.22 + c * 0.55 + air * 0.35;
    for (const l of legs) {
      l.hip.rotation.x = hipBend * (1 + l.sign * pose.lean * 0.35);
      l.knee.rotation.x = -kneeBend * (1 + l.sign * pose.lean * 0.2);
      // Ankles ride the bindings, so the leg splays with the stance angle.
      l.hip.rotation.z = -l.sign * (0.06 + c * 0.10) - pose.edge * 0.10;
      // The boot stays flat on the deck no matter what the shin is doing —
      // counter-rotate it out of the chain.
      l.ankle.rotation.x = -(l.hip.rotation.x + l.knee.rotation.x);
    }

    // Stand the figure ON the board rather than above it. Solve the two-link
    // leg for the height the hips must sit at for the ankles to land on the
    // bindings: thigh and shin each contribute their length times the cosine of
    // their own absolute angle. Without this the whole rider floats half a
    // metre over the deck as soon as the knees bend, which is what a fixed
    // "drop" fudge gets you.
    const shinAngle = hipBend - kneeBend;
    const hipY = 0.20 * S + legL * Math.cos(hipBend) + shinL * Math.cos(shinAngle);
    body.position.y = hipY - 0.86 * S + air * 0.02;

    pelvis.rotation.x = -hipBend * 0.6 + pose.lean * 0.16;
    spine.rotation.x = hipBend * 0.34 - pose.lean * 0.30 - pose.speed * 0.35;
    spine.rotation.y = pose.twist;
    spine.rotation.z = pose.edge * 0.12;

    neck.rotation.x = -spine.rotation.x * 0.75 - pelvis.rotation.x * 0.4 + pose.speed * 0.12;
    neck.rotation.y = -pose.twist * 0.55;

    // Arms: out for balance on snow, reaching for the board in the air, and
    // flailing on a crash.
    const flail = crash * (Math.sin(pose.t * 21) * 0.9 + 0.4);
    for (let i = 0; i < arms.length; i++) {
      const a = arms[i];
      const lead = a.sign > 0;      // front arm
      let sw = 0.9 + c * 0.5 + air * 0.5;
      let fw = -0.35 - pose.edge * a.sign * 0.55 + pose.lean * 0.3;
      let elb = -0.35 - c * 0.35;

      if (pose.grab > 0.01 && air > 0.2) {
        // Grab poses: the trailing hand goes to the board and the leading hand
        // counterweights, which is what makes the shape read as a trick.
        const g = pose.grab * air;
        const grabbing = (pose.grabType === 2) ? lead : !lead;
        if (grabbing) {
          sw = THREE.MathUtils.lerp(sw, 2.05, g);
          fw = THREE.MathUtils.lerp(fw, pose.grabType === 1 ? 0.85 : -0.55, g);
          elb = THREE.MathUtils.lerp(elb, -1.55, g);
        } else {
          sw = THREE.MathUtils.lerp(sw, 0.35, g);
          fw = THREE.MathUtils.lerp(fw, a.sign * 1.0, g);
          elb = THREE.MathUtils.lerp(elb, -0.55, g);
        }
      }
      a.sh.rotation.set(sw + flail * (i ? 1 : -1), 0, fw + a.sign * (0.5 + air * 0.35));
      a.el.rotation.x = elb - flail * 0.6;
    }

    if (crash > 0.01) {
      // A tumble, not a ragdoll: spin the whole assembly and let the limbs
      // flail. Cheap, and at 25 m/s nobody is inspecting the joint solution.
      root.rotation.x = crash * Math.sin(pose.t * 6.5) * 1.2;
      tilt.rotation.z += crash * Math.sin(pose.t * 8.1) * 1.6;
      body.rotation.z = crash * 0.5 * Math.sin(pose.t * 5.0);
    } else {
      root.rotation.x *= 0.86;
      body.rotation.z *= 0.86;
    }
  }

  updatePose(0);

  return {
    group: root, tilt, body, board, pose,
    update: updatePose,
    /** Board tip position in world space — used to site the spray emitter. */
    boardWorld(out) { return board.getWorldPosition(out); },
    dispose() {
      board.userData.dispose();
      for (const m of mats) m.dispose();
      root.traverse(o => { if (o.isMesh) o.geometry.dispose(); });
    },
  };
}
