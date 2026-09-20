#!/usr/bin/env pwsh
# DEPRECATED 2026-09-08 — replaced by tools/bake.mjs.
#
# This script only compressed files larger than 2 MB, so 19 of the 39 models were never
# processed at all: every mob (wolf, orc, rat, spider, yeti, slime, snake) slipped
# through, and wolf.glb shipped 964 KB for 1,962 triangles because half of it was
# uncompressed animation keyframes. It also needed a global CLI install and had to be
# run by hand from Windows, so nothing enforced it.
#
# The replacement processes every asset, is driven by per-class budgets in
# assets/budgets.json, runs anywhere Node runs, and is gated in CI.
#
#   npm install        # once
#   npm run assets     # bake -> integrity-compare -> budget verify
#
# Individual steps:
#   npm run inspect    # what is actually inside every GLB
#   npm run bake       # models_src/ -> models/
#   npm run compare    # confirm no animations/skins/geometry were lost
#   npm run verify     # fail if anything is over budget
#
# Originals live in models_src/. models/ is build output.

Write-Host ""
Write-Host "compress_models.ps1 is deprecated." -ForegroundColor Yellow
Write-Host "Use the Node pipeline instead -- it processes every model, not just those over 2 MB:" -ForegroundColor Yellow
Write-Host ""
Write-Host "    npm install" -ForegroundColor Cyan
Write-Host "    npm run assets" -ForegroundColor Cyan
Write-Host ""
exit 1
