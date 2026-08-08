#!/usr/bin/env pwsh
# compress_models.ps1 — Batch-optimize large GLB files using gltf-transform
#
# Prerequisites:
#   npm install -g @gltf-transform/cli
#
# Usage:
#   cd "Project Bravo Game V.5 Latest Working Version"
#   .\compress_models.ps1

$modelsDir = Join-Path $PSScriptRoot "models"
$threshold = 2MB   # only compress files larger than 2 MB

Write-Host "`n============================================" -ForegroundColor Cyan
Write-Host "  GLB Model Compressor (gltf-transform)" -ForegroundColor Cyan
Write-Host "============================================`n" -ForegroundColor Cyan

# Check that gltf-transform is installed
$gtCmd = Get-Command "gltf-transform" -ErrorAction SilentlyContinue
if (-not $gtCmd) {
    Write-Host "ERROR: gltf-transform CLI not found." -ForegroundColor Red
    Write-Host "Install it with:  npm install -g @gltf-transform/cli" -ForegroundColor Yellow
    exit 1
}

$files = Get-ChildItem -Path $modelsDir -Filter "*.glb" | Where-Object { $_.Length -gt $threshold }

if ($files.Count -eq 0) {
    Write-Host "No GLB files over $([math]::Round($threshold / 1MB, 1)) MB found. Nothing to do." -ForegroundColor Green
    exit 0
}

Write-Host "Found $($files.Count) GLB file(s) over $([math]::Round($threshold / 1MB, 1)) MB:`n"

$totalBefore = 0
$totalAfter = 0

foreach ($f in $files) {
    $sizeBefore = $f.Length
    $totalBefore += $sizeBefore
    $mbBefore = [math]::Round($sizeBefore / 1MB, 2)
    
    Write-Host "  Compressing: $($f.Name)  ($mbBefore MB) ..." -NoNewline -ForegroundColor White
    
    $backupPath = "$($f.FullName).bak"
    Copy-Item $f.FullName $backupPath -Force
    
    # Optimize: Draco mesh compression + WebP texture compression
    $result = & gltf-transform optimize $f.FullName $f.FullName --compress draco --texture-compress webp 2>&1
    
    if ($LASTEXITCODE -ne 0) {
        # Draco may not be available; try without mesh compression
        Write-Host " draco failed, trying without..." -ForegroundColor Yellow -NoNewline
        Copy-Item $backupPath $f.FullName -Force
        $result = & gltf-transform optimize $f.FullName $f.FullName --texture-compress webp 2>&1
    }
    
    if ($LASTEXITCODE -ne 0) {
        # Last resort: just dedup + prune (no texture recompression)
        Write-Host " webp failed, trying dedup..." -ForegroundColor Yellow -NoNewline
        Copy-Item $backupPath $f.FullName -Force
        $result = & gltf-transform dedup $f.FullName $f.FullName 2>&1
        & gltf-transform prune $f.FullName $f.FullName 2>&1 | Out-Null
    }
    
    $sizeAfter = (Get-Item $f.FullName).Length
    $totalAfter += $sizeAfter
    $mbAfter = [math]::Round($sizeAfter / 1MB, 2)
    $pct = [math]::Round((1 - $sizeAfter / $sizeBefore) * 100, 1)
    
    if ($sizeAfter -lt $sizeBefore) {
        Write-Host " $mbAfter MB  (-$pct%)" -ForegroundColor Green
        Remove-Item $backupPath -Force
    } else {
        Write-Host " no improvement, keeping original" -ForegroundColor Yellow
        Copy-Item $backupPath $f.FullName -Force
        Remove-Item $backupPath -Force
        $totalAfter = $totalAfter - $sizeAfter + $sizeBefore
    }
}

$mbTotalBefore = [math]::Round($totalBefore / 1MB, 1)
$mbTotalAfter = [math]::Round($totalAfter / 1MB, 1)
$totalPct = [math]::Round((1 - $totalAfter / $totalBefore) * 100, 1)

Write-Host "`n--------------------------------------------" -ForegroundColor Cyan
Write-Host "  TOTAL:  $mbTotalBefore MB  ->  $mbTotalAfter MB  (-$totalPct%)" -ForegroundColor Cyan
Write-Host "--------------------------------------------`n" -ForegroundColor Cyan
Write-Host "Done! Re-run deploy_to_vps.bat to push the optimized models." -ForegroundColor Green
