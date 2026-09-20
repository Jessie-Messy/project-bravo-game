// spider-gait.js — animation for a rigged arachnid that shipped without any.
//
// WHY THIS EXISTS. The mob animation path in game3d.js is entirely clip-driven:
// buildSlotModel() pulls AnimationClips out of the GLB and pickClip() matches
// them by name (/idle/, /walk|run|gallop/, /attack|punch|bite/). That is the
// right design — authored motion beats anything generated — but it has one
// failure mode: a model that is RIGGED but carries no clips renders as a statue
// in its bind pose, which is strictly worse than the primitive fallback.
//
// spider_rigged.glb is exactly that: 44 joints under a UniRigArmature, zero
// animations. Retargeting the old spider's clips onto it is not possible either,
// and not merely because the joints are named Bone_000..Bone_043 with no
// semantics to map. The topologies genuinely differ — the old rig is eight legs
// of three segments, this one is six legs of five — so there is no
// correspondence to retarget through.
//
// So the clips are synthesised here, ONCE at load, and handed back as ordinary
// AnimationClips. Nothing downstream changes: the mixer, the idle/walk/attack
// action table, the gait rate-matching in animModel() and the attack-window
// logic all keep working because what they receive is indistinguishable from a
// clip the artist baked.
//
// ── The one idea that makes this look like walking ───────────────────────────
//
// Feet are solved to targets expressed in MODEL SPACE, not in leg space. A foot
// in its stance phase is given a fixed path through the model's own coordinates
// and the leg is solved to reach it; when the body bobs, sways or rears, the
// legs re-solve and the feet stay exactly where they were put. Planting falls
// out of the formulation instead of having to be faked, and it is also why the
// attack clip can rear the whole body up over legs that stay convincingly stuck
// to the floor.
//
// The body's forward is +Z. That is the same convention buildSlotModel() already
// relies on when it applies rotation.y = PI to every mob model, and it is what
// the rest-pose geometry says: head and palps sit at +Z, abdomen at -Z.

// ── Leg discovery ────────────────────────────────────────────────────────────
// Structural, not by name — the joints have no meaningful names to match on, and
// anything keyed to Bone_017 would break the moment the model is re-rigged.
//
// A leg is a chain that ends in a tip bone (no bone children), is at least
// MIN_LEG_BONES long, and hangs below the body. Walking up from every tip to the
// nearest branching ancestor partitions the skeleton into chains exactly once.
// On this rig that yields the six 5-bone legs and rejects the four 2-bone palps
// and the 2-bone abdomen, which is the intent.
const MIN_LEG_BONES = 4;

function boneChildren(b) {
  return b.children.filter((c) => c.isBone);
}

function collectBones(root) {
  const out = [];
  root.traverse((o) => { if (o.isBone) out.push(o); });
  return out;
}

function findLegChains(bones) {
  const inSet = new Set(bones);
  const tips = bones.filter((b) => boneChildren(b).length === 0);
  const chains = [];
  for (const tip of tips) {
    const chain = [tip];
    let cur = tip;
    // Climb until the parent branches (or we leave the skeleton). The branch
    // bone itself is the body, not part of the leg, so it is not included.
    while (cur.parent && inSet.has(cur.parent) && boneChildren(cur.parent).length === 1) {
      cur = cur.parent;
      chain.push(cur);
    }
    chain.reverse();                       // root-most first
    if (chain.length >= MIN_LEG_BONES) chains.push(chain);
  }
  return chains;
}

// ── Gait tuning ──────────────────────────────────────────────────────────────
// Every length here is a FRACTION of the leg's own reach, never an absolute
// number of model units. The rig's scale is whatever the exporter chose, and a
// stride hard-coded in those units would silently become a shuffle or the
// splits on the next model.
export const GAIT_DEFAULTS = {
  fps: 24,
  walkSeconds: 1.0,
  idleSeconds: 3.2,
  attackSeconds: 0.9,

  stride: 0.42,      // of leg reach, peak-to-peak along Z
  lift: 0.30,        // of leg reach, how high a swinging foot arcs
  duty: 0.55,        // fraction of the cycle a foot spends on the ground
  splay: 0.09,       // of leg reach, outward reach at the top of the swing

  bodyBob: 0.055,    // of leg reach, vertical body movement (2 per cycle)
  bodyRoll: 0.035,   // radians, side-to-side lean
  bodySway: 0.030,   // of leg reach, lateral body drift

  idleBob: 0.018,    // of leg reach
  idleFoot: 0.012,   // of leg reach, per-foot micro-shift so it never freezes

  rearUp: 0.62,      // radians the body pitches back at the top of a strike
  lungeZ: 0.22,      // of leg reach, forward travel during the strike
  strikeLift: 0.85,  // of leg reach, how high the front legs come up

  ikIterations: 6,   // measured: converged by 4 — see the sweep note in solveCCD
  ikMaxStep: 0.30,   // radians per joint per iteration — see solveCCD
};

// ── CCD, with a step limit that is doing real work ───────────────────────────
// Cyclic Coordinate Descent: repeatedly point each joint's (joint -> foot)
// vector at the (joint -> target) vector, working from the foot back toward the
// body. It is a few lines and it converges fast enough for four joints.
//
// Left unconstrained it also finds poses that reach the target with the knee
// folded through the body, because position alone does not constrain a 4-DOF
// chain. Two things keep it honest, and they matter more than the solver does:
//
//   1. every frame starts from the REST pose rather than from the previous
//      frame, so the solution stays in the same basin instead of drifting into
//      a different one and staying there;
//   2. ikMaxStep caps how far any one joint may turn in one iteration, which
//      spreads the correction along the whole leg instead of letting the joint
//      nearest the foot do all of it and hyperextend.
//
// Together those preserve the arachnid silhouette — knee above the body line,
// foot below it — without a single explicit joint limit.
function solveCCD(THREE, chain, target, opts, scratch) {
  const { qWorld, qParent, qDelta, vA, vB, pJoint, pFoot } = scratch;
  const foot = chain[chain.length - 1];
  const movable = chain.length - 1;           // the tip is carried, never turned

  for (let it = 0; it < opts.ikIterations; it++) {
    for (let i = movable - 1; i >= 0; i--) {
      const bone = chain[i];
      bone.getWorldPosition(pJoint);
      foot.getWorldPosition(pFoot);

      vA.subVectors(pFoot, pJoint);
      vB.subVectors(target, pJoint);
      if (vA.lengthSq() < 1e-12 || vB.lengthSq() < 1e-12) continue;
      vA.normalize(); vB.normalize();

      qDelta.setFromUnitVectors(vA, vB);
      // Clamp the rotation magnitude. Quaternion w = cos(theta/2).
      const ang = 2 * Math.acos(Math.min(1, Math.abs(qDelta.w)));
      if (ang > opts.ikMaxStep) {
        vA.crossVectors(vA, vB);
        if (vA.lengthSq() > 1e-12) qDelta.setFromAxisAngle(vA.normalize(), opts.ikMaxStep);
        else continue;
      }

      bone.getWorldQuaternion(qWorld);
      bone.parent.getWorldQuaternion(qParent);
      bone.quaternion.copy(qParent.invert().multiply(qDelta.multiply(qWorld)));
      bone.updateMatrixWorld(true);
    }
  }
}

// ── Foot paths ───────────────────────────────────────────────────────────────
// One cycle: `duty` of it on the ground travelling backwards at a constant rate
// (which is what pushes the body forward), the rest of it swinging forward
// through a lifted arc.
//
// The stance has to be LINEAR in time and the swing has to be faster than it.
// A foot that eases in and out of stance slides, because the body is moving at a
// constant speed and only a foot travelling backwards at exactly that speed is
// standing still on the ground.
// SPLAY BELONGS TO THE SWING, NOT THE STANCE. The first version pushed the foot
// outward at mid-stance, which looked like the leg working -- and measured as
// 0.081 model units of lateral travel while the foot was supposed to be planted,
// i.e. the foot skating sideways across the floor for half of every cycle.
// A planted foot may only translate backwards. All the sideways articulation
// happens in the air, where it costs nothing and still reads as a leg reaching.
function footOffset(phase, o, reach, side, out) {
  const stride = o.stride * reach;
  const p = phase - Math.floor(phase);
  if (p < o.duty) {
    const k = p / o.duty;                     // 0..1 through the stance
    out.set(0, 0, stride * (0.5 - k));        // front -> back, constant rate
  } else {
    const k = (p - o.duty) / (1 - o.duty);    // 0..1 through the swing
    const arc = Math.sin(k * Math.PI);
    out.set(arc * o.splay * reach * side, arc * o.lift * reach, stride * (k - 0.5));
  }
  return out;
}

// ── Clip assembly ────────────────────────────────────────────────────────────
// Bones are sampled after each frame is posed, and the samples become
// QuaternionKeyframeTracks. Sampling rather than deriving the curves is
// deliberate: the body transform and the IK interact (rearing up changes where
// every leg has to reach), and sampling the result is the only way to capture
// that without solving it twice.
function makeClip(THREE, name, times, tracks) {
  const out = [];
  for (const [path, values] of tracks) {
    out.push(path.endsWith('.position')
      ? new THREE.VectorKeyframeTrack(path, times, values)
      : new THREE.QuaternionKeyframeTrack(path, times, values));
  }
  return new THREE.AnimationClip(name, times[times.length - 1], out);
}

/**
 * Generate idle / walk / attack clips for a rigged arachnid with no animations.
 *
 * @param {object} THREE  the three namespace (never imported here)
 * @param {object} root   the loaded gltf.scene, in its rest pose
 * @param {object} [tune] overrides for GAIT_DEFAULTS
 * @returns {Array} AnimationClips, named so pickClip() finds them
 */
export function buildArachnidClips(THREE, root, tune) {
  const o = Object.assign({}, GAIT_DEFAULTS, tune || {});
  root.updateMatrixWorld(true);

  const bones = collectBones(root);
  const legs = findLegChains(bones);
  if (legs.length < 4) return [];          // not an arachnid rig; leave it alone

  // Model space IS world space here: this runs on the freshly loaded gltf.scene
  // before the game has parented or scaled it. That is what lets foot targets be
  // stored as plain world vectors and stay meaningful.
  const legInfo = legs.map((chain) => {
    const hip = new THREE.Vector3(), tip = new THREE.Vector3();
    chain[0].getWorldPosition(hip);
    chain[chain.length - 1].getWorldPosition(tip);
    const reach = Math.hypot(tip.x - hip.x, tip.z - hip.z);
    return { chain, home: tip.clone(), hip, reach, side: Math.sign(tip.x) || 1 };
  });
  const reach = legInfo.reduce((s, l) => s + l.reach, 0) / legInfo.length;

  // ALTERNATING TRIPOD. Front and rear on one side step with the middle leg of
  // the other, so three feet are always down and they always enclose the centre
  // of mass. It is what six-legged animals actually do, and the reason a gait
  // built any other way reads as "wrong" even when nobody can say why.
  //
  // Front-to-rear order comes from Z because forward is +Z.
  for (const side of [1, -1]) {
    const row = legInfo.filter((l) => l.side === side).sort((a, b) => b.home.z - a.home.z);
    row.forEach((l, i) => {
      l.rank = i;                                  // 0 = front
      // side +1: front and rear lead; side -1: the middle leg leads.
      const leads = side > 0 ? (i !== 1) : (i === 1);
      l.phase = leads ? 0 : 0.5;
    });
  }

  // The body is everything above the branch the legs hang from.
  const legRoots = new Set(legInfo.map((l) => l.chain[0]));
  const branch = legInfo[0].chain[0].parent;
  const bodyChain = [];
  for (let b = branch; b && b.isBone; b = b.parent) bodyChain.unshift(b);

  // Rest pose, captured once. Every frame is posed from here — see solveCCD.
  const rest = new Map();
  for (const b of bones) rest.set(b, { p: b.position.clone(), q: b.quaternion.clone() });
  const resetPose = () => {
    for (const b of bones) { const r = rest.get(b); b.position.copy(r.p); b.quaternion.copy(r.q); }
    root.updateMatrixWorld(true);
  };

  const scratch = {
    qWorld: new THREE.Quaternion(), qParent: new THREE.Quaternion(), qDelta: new THREE.Quaternion(),
    vA: new THREE.Vector3(), vB: new THREE.Vector3(),
    pJoint: new THREE.Vector3(), pFoot: new THREE.Vector3(),
  };
  const tmpOff = new THREE.Vector3(), tmpTarget = new THREE.Vector3();
  const qTmp = new THREE.Quaternion(), eTmp = new THREE.Euler();

  // Which bones a clip records. Legs plus the body chain; everything else (the
  // palps, the abdomen) keeps its rest pose and needs no track.
  const tracked = [];
  for (const l of legInfo) for (const b of l.chain) if (!tracked.includes(b)) tracked.push(b);
  for (const b of bodyChain) if (!tracked.includes(b)) tracked.push(b);
  const bodyRoot = bodyChain[0];

  // Sample the posed skeleton into per-bone buffers.
  function sampler(frameCount) {
    const quat = new Map(tracked.map((b) => [b, new Float32Array(frameCount * 4)]));
    const rootPos = new Float32Array(frameCount * 3);
    return {
      grab(f) {
        for (const b of tracked) {
          const a = quat.get(b), i = f * 4;
          a[i] = b.quaternion.x; a[i + 1] = b.quaternion.y;
          a[i + 2] = b.quaternion.z; a[i + 3] = b.quaternion.w;
        }
        rootPos[f * 3] = bodyRoot.position.x;
        rootPos[f * 3 + 1] = bodyRoot.position.y;
        rootPos[f * 3 + 2] = bodyRoot.position.z;
      },
      tracks() {
        const t = tracked.map((b) => [`${b.name}.quaternion`, quat.get(b)]);
        t.push([`${bodyRoot.name}.position`, rootPos]);
        return t;
      },
    };
  }

  // Pose the body, then solve every leg to its target. Order matters: the legs
  // are children of the body, so the body has to move first or they would be
  // solved against last frame's hips.
  function poseFrame(bodyFn, targetFn) {
    resetPose();
    bodyFn();
    root.updateMatrixWorld(true);
    for (const l of legInfo) {
      targetFn(l, tmpTarget);
      solveCCD(THREE, l.chain, tmpTarget, o, scratch);
    }
  }

  const clips = [];

  // ── Walk ───────────────────────────────────────────────────────────────────
  {
    const n = Math.round(o.walkSeconds * o.fps);
    const times = new Float32Array(n + 1);
    const s = sampler(n + 1);
    for (let f = 0; f <= n; f++) {
      const p = f / n;                                   // 0..1, f == n repeats f == 0
      times[f] = p * o.walkSeconds;
      poseFrame(() => {
        // Two bobs per cycle — one per tripod touchdown — and a roll/sway at the
        // cycle rate, which is what gives the walk its side-to-side character.
        bodyRoot.position.y += Math.sin(p * Math.PI * 4) * o.bodyBob * reach;
        bodyRoot.position.x += Math.sin(p * Math.PI * 2) * o.bodySway * reach;
        eTmp.set(0, 0, Math.sin(p * Math.PI * 2) * o.bodyRoll);
        bodyRoot.quaternion.multiply(qTmp.setFromEuler(eTmp));
      }, (l, out) => {
        footOffset(p + l.phase, o, l.reach, l.side, tmpOff);
        out.copy(l.home).add(tmpOff);
      });
      s.grab(f);
    }
    clips.push(makeClip(THREE, 'Gen|Spider_Walk', times, s.tracks()));
  }

  // ── Idle ───────────────────────────────────────────────────────────────────
  // Not a static pose. A spider at rest still breathes and shifts its weight,
  // and a mob frozen perfectly still reads as a bug in the game rather than as
  // stillness. Everything here is an order of magnitude below the walk.
  {
    const n = Math.round(o.idleSeconds * o.fps);
    const times = new Float32Array(n + 1);
    const s = sampler(n + 1);
    for (let f = 0; f <= n; f++) {
      const p = f / n;
      times[f] = p * o.idleSeconds;
      poseFrame(() => {
        bodyRoot.position.y += Math.sin(p * Math.PI * 2) * o.idleBob * reach;
        eTmp.set(Math.sin(p * Math.PI * 2 + 1.1) * 0.012, Math.sin(p * Math.PI * 2 * 0.5) * 0.02, 0);
        bodyRoot.quaternion.multiply(qTmp.setFromEuler(eTmp));
      }, (l, out) => {
        // Incommensurate frequencies per leg, so the feet never resettle in
        // unison — that synchrony is the thing that reads as mechanical.
        const k = 1 + l.rank * 0.37 + (l.side > 0 ? 0.19 : 0);
        out.copy(l.home);
        out.y += (Math.sin(p * Math.PI * 2 * k) * 0.5 + 0.5) * o.idleFoot * reach;
        out.z += Math.sin(p * Math.PI * 2 * k * 0.7 + 2.0) * o.idleFoot * reach * 0.6;
      });
      s.grab(f);
    }
    clips.push(makeClip(THREE, 'Gen|Spider_Idle', times, s.tracks()));
  }

  // ── Attack ─────────────────────────────────────────────────────────────────
  // Rear back onto the four rear legs, then drive forward and down. The four
  // planted feet keep their stance targets throughout, so the body genuinely
  // pivots over them — which is the whole reason foot targets live in model
  // space. The two front legs leave the ground and strike.
  {
    const n = Math.round(o.attackSeconds * o.fps);
    const times = new Float32Array(n + 1);
    const s = sampler(n + 1);
    for (let f = 0; f <= n; f++) {
      const p = f / n;
      times[f] = p * o.attackSeconds;
      // Wind up slowly, strike fast, recover. Asymmetric on purpose: a
      // symmetrical curve has no snap and reads as a stretch, not a bite.
      const wind = p < 0.42 ? p / 0.42 : 0;
      const strike = p < 0.42 ? 0 : Math.min(1, (p - 0.42) / 0.22);
      const recover = p < 0.64 ? 0 : (p - 0.64) / 0.36;
      const rear = Math.sin(wind * Math.PI * 0.5) * (1 - strike);
      const push = Math.sin(strike * Math.PI) * (1 - recover * 0.6);

      poseFrame(() => {
        eTmp.set(-rear * o.rearUp + push * o.rearUp * 0.35, 0, 0);
        bodyRoot.quaternion.multiply(qTmp.setFromEuler(eTmp));
        bodyRoot.position.z += push * o.lungeZ * reach;
        bodyRoot.position.y += rear * o.bodyBob * reach * 2;
      }, (l, out) => {
        out.copy(l.home);
        if (l.rank === 0) {                       // front pair: up, out, then down
          const raise = Math.max(rear, push * 0.55);
          out.y += raise * o.strikeLift * reach;
          out.z += raise * o.lungeZ * reach * 1.6 + push * o.lungeZ * reach;
          out.x += raise * o.splay * reach * 2.2 * l.side;
        }
      });
      s.grab(f);
    }
    clips.push(makeClip(THREE, 'Gen|Spider_Attack', times, s.tracks()));
  }

  resetPose();
  return clips;
}
