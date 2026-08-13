// Does a mob model load, skin, and drive every animation state?
//   node tools/check_model.mjs        (needs playwright + a static server on :5173)
//
// ⚠ Checks the things that are invisible in a still frame and expensive to find
// by eye: that the skeleton actually DEFORMS (a model can load, render, and never
// move), that each state resolved to a DIFFERENT clip (a rig that maps walk and
// run to the same clip looks fine until you wonder why nobody ever runs), and
// that the material is not self-lit — the bug that shipped twice in this project.
import { withGame } from './rig.mjs';
const FILE = process.argv[2] || 'models/zombie.glb';
await withGame(async (page, ctx) => {
  page.setDefaultTimeout(180000);
  const r = await page.evaluate(async (file) => {
    const THREE = await import('three');
    const { GLTFLoader } = await import('three/addons/loaders/GLTFLoader.js');
    const gltf = await new Promise((res, rej) => new GLTFLoader().load(file, res, undefined, rej));
    const out = { clips: gltf.animations.map(a => a.name) };

    let mat = null, bones = 0, tris = 0;
    gltf.scene.traverse(o => {
      if (!o.isSkinnedMesh) return;
      bones = o.skeleton.bones.length; mat = o.material;
      tris += o.geometry.index ? o.geometry.index.count / 3 : 0;
    });
    out.bones = bones; out.tris = Math.round(tris);
    out.selfLit = !!(mat && (mat.emissiveMap || (mat.emissive && mat.emissive.getHex() !== 0)));
    out.transparent = !!(mat && mat.transparent);
    out.doubleSided = !!(mat && mat.side === THREE.DoubleSide);

    // Same matcher the game uses (buildSlotModel). Kept in step by eye, which is
    // why this test prints the mapping rather than just asserting it is non-null.
    const pick = re => (gltf.animations.find(a => re.test(a.name)) || {}).name || null;
    out.states = {
      idle:   pick(/(^|\|)idle$/i) || pick(/idle/i) || pick(/inplace|in_place/i),
      walk:   pick(/shaky_walk|limping_walk/i) || pick(/(^|\|)walk/i) || pick(/gallop|run/i),
      run:    pick(/(^|\|)running|(^|\|)run$|gallop|sprint/i),
      attack: pick(/attack|punch|bite|scream/i),
      hit:    pick(/hit_?reaction|hit|flinch|damage/i),
      death:  pick(/(^|\|)dead|death|dying/i),
    };

    // Every state must actually move the skeleton, and by a DIFFERENT amount —
    // two states resolving to the same clip is the failure this catches.
    const mixer = new THREE.AnimationMixer(gltf.scene);
    const bone = gltf.scene.getObjectByProperty('isBone', true);
    out.motion = {};
    for (const [state, name] of Object.entries(out.states)) {
      if (!name) { out.motion[state] = null; continue; }
      mixer.stopAllAction();
      const clip = gltf.animations.find(a => a.name === name);
      mixer.clipAction(clip).reset().play();
      mixer.setTime(0); gltf.scene.updateMatrixWorld(true);
      const p0 = new THREE.Vector3(); bone.getWorldPosition(p0);
      mixer.setTime(Math.min(clip.duration * 0.5, 1.0)); gltf.scene.updateMatrixWorld(true);
      const p1 = new THREE.Vector3(); bone.getWorldPosition(p1);
      out.motion[state] = +p0.distanceTo(p1).toFixed(4);
    }
    // Walk variety: a model with several walk clips should hand a different one
    // to each pool slot rather than making every instance shamble in lockstep.
    const walks = gltf.animations.filter(a => /walk|shamble|shuffle|limp/i.test(a.name)
                                          && !/inplace|in_place/i.test(a.name)).map(a => a.name);
    out.walkVariants = walks;
    out.unusedClips = gltf.animations.map(a => a.name)
      .filter(n => !Object.values(out.states).includes(n) && !walks.includes(n));
    return out;
  }, FILE);

  const fails = [];
  if (!r.bones) fails.push('no skeleton — the model cannot animate');
  if (r.selfLit) fails.push('SELF-LIT material (emissive) — it will glow at night, ignoring scene light');
  if (r.transparent) fails.push('transparent material — costs a sorted pass for an opaque character');
  if (r.doubleSided) fails.push('double-sided — doubles fragment cost for no gain');
  for (const [s, name] of Object.entries(r.states))
    if (!name) fails.push(`no clip resolved for state "${s}"`);
  for (const [s, d] of Object.entries(r.motion))
    if (d !== null && d === 0) fails.push(`state "${s}" resolves to a clip that never moves the skeleton`);
  const used = Object.values(r.states).filter(Boolean);
  if (new Set(used).size < used.length)
    fails.push(`two states share one clip: ${JSON.stringify(r.states)}`);
  const errs = ctx.errors.filter(e => !/matchmake|colyseus/.test(e));
  if (errs.length) fails.push('page errors: ' + errs.slice(0, 3).join(' ~ '));

  console.log(`${FILE}: ${r.tris} tris, ${r.bones} bones, ${r.clips.length} clips`);
  for (const [s, n] of Object.entries(r.states))
    console.log(`  ${s.padEnd(7)} → ${String(n).padEnd(24)} bone moves ${r.motion[s]}`);
  console.log(`  walk variants: ${r.walkVariants.join(', ') || 'none'}  (one per pool slot)`);
  if (r.unusedClips.length) console.log(`  unused clips : ${r.unusedClips.join(', ')}`);
  console.log(fails.length ? '\nFAIL\n  ' + fails.join('\n  ') : '\nPASS');
  process.exit(fails.length ? 1 : 0);
}, {});
