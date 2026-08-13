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

    // ⚠ These regexes are a COPY of buildSlotModel's, and the first version drifted
    // from it within one model: the checker reported walk → Limping_Walk_3_inplace
    // while the game's pickWalk() excludes in-place clips entirely. A checker that
    // does not test the real matcher tests itself. They are pulled from the source
    // at runtime now, so they cannot disagree.
    const src = await fetch('js/game3d.js').then(r => r.text());
    const block = src.slice(src.indexOf('const actions = {'), src.indexOf('const inst = { type, obj'));
    const reOf = name => {
      const m = new RegExp(name + ':\\s*mk\\(([\\s\\S]*?)\\),\\n').exec(block);
      return m ? m[1] : null;
    };
    const pick = re => (gltf.animations.find(a => re.test(a.name)) || {}).name || null;
    const evalPick = expr => {
      if (!expr) return null;
      for (const m of expr.matchAll(/\/((?:[^\/\\]|\\.)+)\/([a-z]*)/g)) {
        const hit = pick(new RegExp(m[1], m[2]));
        if (hit) return hit;
      }
      return null;
    };
    // walk goes through pickWalk(); mirror its exclusion rule.
    const walkList = gltf.animations.filter(a => /walk|shamble|shuffle|limp/i.test(a.name)
                                             && !/inplace|in_place/i.test(a.name)).map(a => a.name);
    out.states = {
      idle:   evalPick(reOf('idle')),
      walk:   walkList[0] || evalPick(reOf('walk')),
      run:    evalPick(reOf('run')),
      attack: evalPick(reOf('attack')),
      hit:    evalPick(reOf('hit')),
      death:  evalPick(reOf('death')),
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
      // ⚠ Sample the whole clip, not two instants. A walk cycle returns to nearly
      // the same pose at its midpoint, so a single before/after comparison
      // reported Quick_Walk as "never moves the skeleton" — a false alarm about
      // a perfectly good animation, which is how a checker gets switched off.
      const pts = [];
      for (let k = 0; k <= 8; k++) {
        mixer.setTime(clip.duration * k / 8);
        gltf.scene.updateMatrixWorld(true);
        const p = new THREE.Vector3(); bone.getWorldPosition(p); pts.push(p);
      }
      let maxD = 0;
      for (let a = 0; a < pts.length; a++) for (let b = a + 1; b < pts.length; b++)
        maxD = Math.max(maxD, pts[a].distanceTo(pts[b]));
      out.motion[state] = +maxD.toFixed(4);
    }
    // Walk variety: a model with several walk clips should hand a different one
    // to each pool slot rather than making every instance shamble in lockstep.
    const walks = gltf.animations.filter(a => /walk|shamble|shuffle|limp/i.test(a.name)
                                          && !/inplace|in_place/i.test(a.name)).map(a => a.name);
    out.walkVariants = walks;
    // Boss abilities name their own clip (BOSS_ABILITIES.anim). Those are USED,
    // and reporting them as unused would send the next person hunting for a bug
    // that is not there.
    const esrc = await fetch('js/enemies.js').then(r => r.text());
    const abilityAnims = [...esrc.matchAll(/anim:\s*'([^']+)'/g)].map(m => m[1]);
    out.abilityAnims = abilityAnims.filter(n => gltf.animations.some(a => a.name === n));
    out.unusedClips = gltf.animations.map(a => a.name)
      .filter(n => !Object.values(out.states).includes(n) && !walks.includes(n)
                && !abilityAnims.includes(n));
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
  if (r.abilityAnims && r.abilityAnims.length)
    console.log(`  ability clips: ${r.abilityAnims.join(', ')}  (BOSS_ABILITIES.anim)`);
  if (r.unusedClips.length) console.log(`  unused clips : ${r.unusedClips.join(', ')}`);
  console.log(fails.length ? '\nFAIL\n  ' + fails.join('\n  ') : '\nPASS');
  process.exit(fails.length ? 1 : 0);
}, {});
