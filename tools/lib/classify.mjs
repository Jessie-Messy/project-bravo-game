// tools/lib/classify.mjs — decide which budget class a model belongs to.
//
// One place, used by inspect, bake and verify, so all three always agree.
// Rules are ordered: the first match wins, and `default` catches anything new.
// Add a new asset and it is classified automatically -- that is the point. Nothing
// ships unbudgeted just because someone forgot to add it to a list.

import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const here = dirname(fileURLToPath(import.meta.url));
const budgets = JSON.parse(readFileSync(join(here, '..', '..', 'assets', 'budgets.json'), 'utf8'));

/**
 * @param {string} filename  e.g. "Sword_Basic.glb"
 * @returns {{name: string, maxTexture: number, maxTriangles: number, maxBytes: number, reason: string}}
 */
export function classify(filename) {
  const base = filename.replace(/\.glb$/i, '');
  for (const rule of budgets.classes) {
    if (rule.match.some((pattern) => new RegExp(pattern, 'i').test(base))) {
      return { name: rule.name, ...rule.budget, reason: rule.reason };
    }
  }
  return { name: budgets.default.name, ...budgets.default.budget, reason: budgets.default.reason };
}

export { budgets };
