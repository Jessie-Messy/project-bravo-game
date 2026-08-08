@echo off
echo ============================================
echo   Project Bravo Game - Local Server
echo ============================================
echo.
echo Starting local game server on http://localhost:5173 ...
echo Keep this window open while playing. Ctrl+C to stop.
echo.
powershell -Command "Start-Process 'http://localhost:5173/medieval_prototype.html'"
npx serve -l 5173 "%~dp0."
