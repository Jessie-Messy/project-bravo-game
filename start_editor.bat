@echo off
echo ============================================
echo   Project Bravo - World Editor Launcher
echo ============================================
echo.
echo Starting local game & editor server on http://localhost:5173
echo.
start "" "http://localhost:5173/editor.html"
npx serve -l 5173 "%~dp0."
