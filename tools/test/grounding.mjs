// grounding.mjs — everything that stands on the world stands on the TERRAIN.
//
// WHY THIS EXISTS. The world was flat when these were written, so a lot of
// things were placed at y = 0: other players, horses, the corpse, NPCs,
// guards, the contract board, falling trees. Once the terrain got relief,
// anyone standing on a hill rendered sunk to the chest for everybody else —
// shipped in v0.20.0 and only spotted by a synthetic-player bench shot.
// A static check, because the bug is one literal `0` in a position call.
//
// Usage: node tools/test/grounding.mjs   (or npm run test:grounding)
import fs from 'node:fs';

const game = fs.readFileSync('js/game3d.js', 'utf8');
let fail = 0, checked = 0;
const check = (name, cond, detail) => { checked++; if (!cond) { console.log('  FAIL  ' + name + (detail ? ' — ' + detail : '')); fail++; } };

// Each of these must take its height from heightAt(), never a literal 0.
const mustGround = [
  ['a remote player model',      /m\.obj\.position\.set\(v\.rx,\s*heightAt\(v\.rx,\s*v\.rz\)/],
  ['a remote horse (ridden)',    /v\.horse\.obj\.position\.set\(v\.rx,\s*heightAt\(/],
  ['a remote horse (parked)',    /v\.horse\.obj\.position\.set\(st\.horseX,\s*heightAt\(/],
  ['your parked horse',          /horse\.obj\.position\.set\(player\.horseX,\s*heightAt\(/],
  ['your corpse',                /corpseGrp\.position\.set\(G\.corpse\.x,\s*heightAt\(/],
  ['a town NPC',                 /obj\.position\.set\(cfg\.pos\.x,\s*heightAt\(/],
  ['a guard',                    /guardPool\[i\]\.position\.set\(g\.x,\s*heightAt\(/],
  ['the contract board',         /g\.position\.set\(CONTRACT_BOARD\.x,\s*heightAt\(/],
  ['a falling tree',             /a\.grp\.position\.set\(tx\*TILE\+TILE\/2,\s*heightAt\(/],
];
for (const [name, re] of mustGround) check(name + ' stands on the terrain', re.test(game));

// A rider sits ABOVE the ground, not at an absolute saddle height.
check('your rider sits above the ground', /protag\.obj\.position\.y\s*\+=\s*horse\.rideH/.test(game));
check('no remote model is pinned to y=0', !/m\.obj\.position\.set\(v\.rx,\s*st\.onHorse\?[^,]*:0,\s*v\.rz\)/.test(game));

console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
