// tiers.mjs — the tier arrays must stay in sync.
//
// WHY THIS EXISTS, in the project's own words (HANDOFF, "Known gotchas"):
//
//   "Tier lookup arrays must stay in sync with the recipes (this bit us hard).
//    The Mithril/Runic session added crafting, shop entries and boss drops that
//    set swordTier/bowTier to 4-5 and call equipArmorPiece(5|6), but never
//    extended the arrays those index into. Result: every endgame weapon and
//    armor piece silently produced NaN damage / damage-reduction."
//
// An out-of-range index in JS gives `undefined`, and `undefined` in arithmetic
// gives NaN — which renders as "NaN" in the HUD and does nothing loud anywhere
// else. Nobody notices until an endgame player says their sword does nothing.
//
// So: parse the arrays straight out of game3d.js and assert they agree with each
// other and with what the recipes and drops actually reference.
//
// Usage: node tools/test/tiers.mjs   (or npm run test:tiers)
import fs from 'node:fs';

const src = fs.readFileSync('js/game3d.js', 'utf8');
let fail = 0, checked = 0;
const bad = m => { console.log('  FAIL  ' + m); fail++; };

function arr(name) {
  const m = src.match(new RegExp('const ' + name + '\\s*=\\s*\\[([^\\]]*)\\]'));
  if (!m) { bad('could not find ' + name + ' in js/game3d.js'); return null; }
  return m[1].split(',').map(x => x.trim()).filter(x => x.length);
}

const TIER_NAMES = arr('TIER_NAMES');
const TIER_MULT  = arr('TIER_MULT');
const ARMOR_MATS = arr('ARMOR_MATS');
const ARMOR_DR   = arr('ARMOR_DR');
const ARMOR_COLS = arr('ARMOR_COLS');
if (!TIER_NAMES || !TIER_MULT || !ARMOR_MATS || !ARMOR_DR || !ARMOR_COLS) process.exit(1);

// ── The weapon pair ─────────────────────────────────────────────────
checked++;
if (TIER_NAMES.length !== TIER_MULT.length)
  bad('TIER_NAMES (' + TIER_NAMES.length + ') and TIER_MULT (' + TIER_MULT.length +
      ') differ — the highest weapon tier would multiply damage by undefined');

// ── The armour trio ─────────────────────────────────────────────────
checked++;
if (!(ARMOR_MATS.length === ARMOR_DR.length && ARMOR_DR.length === ARMOR_COLS.length))
  bad('ARMOR_MATS/ARMOR_DR/ARMOR_COLS lengths differ: ' +
      [ARMOR_MATS.length, ARMOR_DR.length, ARMOR_COLS.length].join('/') +
      ' — the top material gets undefined DR or no colour');

// ── Monotonic: a higher tier must actually be better ────────────────
const nums = a => a.map(Number);
checked++;
{
  const m = nums(TIER_MULT);
  for (let i = 2; i < m.length; i++)
    if (!(m[i] > m[i - 1])) { bad('TIER_MULT is not increasing at index ' + i + ' (' + m[i - 1] + ' -> ' + m[i] + ')'); break; }
}
checked++;
{
  const d = nums(ARMOR_DR);
  for (let i = 2; i < d.length; i++)
    if (!(d[i] > d[i - 1])) { bad('ARMOR_DR is not increasing at index ' + i + ' (' + d[i - 1] + ' -> ' + d[i] + ')'); break; }
  if (d[d.length - 1] >= 1) bad('ARMOR_DR tops out at ' + d[d.length - 1] + ' — 1.0 is total immunity');
}

// ── Nothing references a tier the arrays cannot serve ───────────────
// This is the check that would have caught the Mithril/Runic bug: find every
// literal tier the source assigns or compares against, and make sure the arrays
// are long enough to be indexed by it.
const maxWeaponTier = TIER_NAMES.length - 1;
const maxArmorMat   = ARMOR_MATS.length - 1;

checked++;
for (const m of src.matchAll(/(?:swordTier|bowTier|pickaxeTier)\s*(?:=|>=|===)\s*(\d+)/g)) {
  const t = +m[1];
  if (t > maxWeaponTier) { bad('source references weapon tier ' + t + ' but TIER_NAMES only goes to ' + maxWeaponTier); break; }
}
checked++;
for (const m of src.matchAll(/equipArmorPiece\s*\(\s*[^,)]+,\s*(\d+)\s*\)/g)) {
  const t = +m[1];
  if (t > maxArmorMat) { bad('equipArmorPiece references material ' + t + ' but ARMOR_MATS only goes to ' + maxArmorMat); break; }
}

// ── Every material above bronze needs a tint in updateArmorVisuals ──
// It reuses the iron art and recolours it; a material with no tint entry renders
// in bare iron, which looks like a bug rather than a tier.
checked++;
{
  const tint = src.match(/const matTint\s*=\s*m\s*=>([^;]*);/);
  if (!tint) bad('could not find matTint in updateArmorVisuals');
  else for (let m = 4; m <= maxArmorMat; m++)
    if (!new RegExp('m===' + m + '\\s*\\?').test(tint[1]))
      bad('armour material ' + m + ' (' + ARMOR_MATS[m].replace(/['"]/g, '') +
          ') has no matTint entry — it would render as bare iron');
}

console.log('weapon tiers: ' + TIER_NAMES.map(x => x.replace(/['"]/g, '')).join(' '));
console.log('armour mats : ' + ARMOR_MATS.map(x => x.replace(/['"]/g, '')).join(' '));
console.log('\n' + checked + ' checks, ' + fail + ' failure' + (fail === 1 ? '' : 's'));
process.exit(fail ? 1 : 0);
