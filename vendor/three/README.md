# Vendored three.js r160

Only the modules `js/snowboard/*` imports, fetched from
`https://cdn.jsdelivr.net/npm/three@0.160.0/` with their transitive relative
imports followed. Directory layout matches the npm package, so the importmap in
`snowboard.html` (`three` → `build/three.module.js`, `three/addons/` →
`examples/jsm/`) resolves both bare and relative specifiers unchanged.

To refresh, re-run the same recursive fetch against a newer tag and re-test —
do not hand-edit these files.

MIT licensed, see LICENSE.
