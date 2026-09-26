// pets.mjs — wild cats, taming, and the pet.
//
// WHY THIS EXISTS. The pet is an ordinary enemy record with `tame` set, which
// is what lets it reuse every mob system — and exactly why it can go wrong
// quietly: if updateEnemy stops skipping tame mobs the pet fights its owner;
// if the passive branch drifts below the combat AI a wild cat attacks; if the
// save forgets `pet` the cat is gone after the next login; if the pet ever
// picks targets from the player list, region/PvP rules are bypassed.
//
// Usage: node tools/test/pets.mjs   (or npm run test:pets)
import fs from 'node:fs';

globalThis.document = { createElement: () => ({ width: 0, height: 0, getContext: () => ({}) }) };
globalThis.localStorage = { getItem: () => null, setItem: () => {}, removeItem: () => {} };
const E  = await import('../../js/enemies.js');
const W  = await import('../../js/world.js');
const S  = await import('../../js/state.js');
const CD = await import('../../js/corpse-data.js');

let fail = 0, checked = 0;
const bad = (m) => { console.log('  FAIL  ' + m); fail++; };
const check = (name, cond, detail) => { checked++; if (!cond) bad(name + (detail ? ' — ' + detail : '')); };
const game = fs.readFileSync('js/game3d.js', 'utf8');
const enemies = fs.readFileSync('js/enemies.js', 'utf8');

// ── The wild cat ────────────────────────────────────────────────────
const cat = E.ENEMY_CFG.cat;
check('cat is a mob type', !!cat);
check('cat is passive', cat && cat.passive === true);
check('cat does no damage', cat && cat.damage === 0 && cat.aggroRange === 0);
check('cats are never harvested', CD.NEVER_HARVEST.has('cat') && !CD.HARVEST.cat);
check('the cat has a model entry', /\bcat:\s*\{file:'Calico_Cat_Pet\.glb'/.test(game));
check('the cat model is baked', fs.existsSync('models/Calico_Cat_Pet.glb'));

// Passive wildlife must leave updateEnemy BEFORE any aggro/attack code runs.
{
  const i = enemies.indexOf('export function updateEnemy');
  const passive = enemies.indexOf('if(pcfg && pcfg.passive){', i);
  const aggro = enemies.indexOf("if(playerVisible&&dist<=e.aggroRange) e.state='aggro';", i);
  const attack = enemies.indexOf('damagePlayer(e.damage, e)', i);
  check('the passive branch runs before aggro and attacks', passive > i && passive < aggro && passive < attack);
  check('a tame mob is skipped by the mob AI', /if\(pcfg && pcfg\.passive\)\{\s*\n\s*if\(e\.tame\) return;/.test(enemies));
}

// ── Spawns land on real ground ──────────────────────────────────────
const map = S.map;
const allCats = [...W.CAT_SPAWNS, ...W.coastCatSpawns()];
check('there are wild cats', allCats.length > 0);
for (const [x, y] of allCats) {
  let ok = false;
  for (let r = 0; r <= 6 && !ok; r++) for (let dy = -r; dy <= r && !ok; dy++) for (let dx = -r; dx <= r; dx++)
    if (map[y + dy] && map[y + dy][x + dx] === 0) { ok = true; break; }
  check(`cat spawn ${x},${y} finds grass within 6`, ok, 'makeEnemy would silently spawn nothing');
}

// ── The pet ─────────────────────────────────────────────────────────
check('taming costs meat', /inv\.cooked_meat--; else inv\.raw_meat--;/.test(game));
check('the pet is saved', /pet:player\.pet\?\{\.\.\.player\.pet\}:null/.test(game));
check('the pet is loaded', /player\.pet = \(s\.pet && typeof s\.pet==='object' && s\.pet\.type\)/.test(game));
check('a new character has no pet', S.player.pet === undefined || S.player.pet === null);
{
  const a = game.indexOf('function updatePet(dt)'), b = game.indexOf('\nfunction petGainXp', a);
  const body = game.slice(a, b);
  check('updatePet exists', a > 0 && b > a);
  check('the pet only ever targets mobs, never players', !/net\.remotes|netPvp|damagePlayer/.test(body));
  check('the pet never attacks another tame mob or wildlife', body.includes('o.tame') && body.includes('.passive'));
  check('the pet hits through damageEnemy (kill credit, corpses)', body.includes('damageEnemy(t, st.dmg)'));
}
// ── The pet is not an enemy (critic P8) ──────────────────────────────
check('a tame record is not hostile', !E.isHostile({ type: 'cat', tame: true }) && !E.isHostile({ type: 'wolf', tame: true }));
check('a wild cat is not hostile', !E.isHostile({ type: 'cat' }));
check('a wolf is hostile', E.isHostile({ type: 'wolf' }));
check('damageEnemy refuses non-hostiles first', /export function damageEnemy\(e, dmg\) \{\s*if \(!isHostile\(e\)\) return;/.test(enemies));
check('target pickers skip non-hostiles', /function nearestEnemy[^]*?!isHostile\(e\)\)continue;/.test(game) && /isHostile\(e\)&&Math\.hypot\(e\.x-player\.x,e\.y-player\.y\)<TILE\*12/.test(game));
check('the mob AI never ticks the pet', game.includes('if(!e.srv && !e.tame) updateEnemy(e,dt);'));
{
  const a2 = game.indexOf('function summonPet()'), b2 = game.indexOf('\n}', a2);
  check('the pet is summoned without a grass search (dungeon/caves)', a2 > 0 && !game.slice(a2, b2).includes('makeEnemy('));
  const f = game.indexOf('function updatePet(dt)'), g = game.indexOf('\nfunction petGainXp', f);
  check('a fainted pet is revived in place, never spliced (slotModel indices)', f > 0 && !game.slice(f, g).includes('enemies.splice'));
}
check('a dungeon shrine never clears your pet', enemies.includes('!em.isChamp && !em.floorBoss && !em.tame'));
check('only one pet at a time', /if\(player\.pet\)\{ addFloater\(player\.x,player\.y-30,'you already have a pet'\)/.test(game));

console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
