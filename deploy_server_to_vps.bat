@echo off
echo ============================================
echo   Project Bravo - Deploy WORLD SERVER to VPS
echo ============================================
echo.

rem ── Preflight ───────────────────────────────────────────────────────────
rem  Catches the failure this script SHIPPED once: it listed the server files
rem  by hand, so every file added afterwards (accounts.js, character.js, tx.js,
rem  and the whole shared/ folder) was silently left behind. The server then
rem  crash-looped on require() the moment it restarted, with a perfectly healthy
rem  looking deploy log. check_deploy.mjs reads THIS script and proves every
rem  local require and fetch is actually covered.
echo Preflight: verifying the deploy covers every file the code needs...
node "%~dp0tools\check_deploy.mjs"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: preflight failed - see above. Deployment aborted.
    goto :fail
)
echo.

echo Rebuilding world-data.json from client map and world_edits.json...
node "%~dp0server\build-world-data.mjs"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: Rebuilding world-data.json failed. Deployment aborted.
    goto :fail
)
echo.

echo Copying server files...
ssh -i "%USERPROFILE%\.ssh\vps_ed25519" ubuntu@135.148.120.186 "mkdir -p /home/ubuntu/bravo-server /home/ubuntu/bravo-server/shared"
if %ERRORLEVEL% NEQ 0 goto :fail

rem  ⚠ WILDCARD, not a hand-written list. The old list went stale the first time
rem  a file was added and nobody noticed until the server was down.
scp -i "%USERPROFILE%\.ssh\vps_ed25519" "%~dp0server\*.js" "%~dp0server\world-data.json" "%~dp0server\package.json" ubuntu@135.148.120.186:/home/ubuntu/bravo-server/
if %ERRORLEVEL% NEQ 0 goto :fail

rem  shared/ holds the economy tables (recipes, shop prices). server/tx.js
rem  require()s them at load, so a server without this directory does not start.
scp -i "%USERPROFILE%\.ssh\vps_ed25519" "%~dp0shared\*.json" ubuntu@135.148.120.186:/home/ubuntu/bravo-server/shared/
if %ERRORLEVEL% NEQ 0 goto :fail

echo Installing dependencies and (re)starting under pm2...
ssh -i "%USERPROFILE%\.ssh\vps_ed25519" ubuntu@135.148.120.186 "cd /home/ubuntu/bravo-server && npm install --omit=dev --no-audit --no-fund && (command -v pm2 >/dev/null || sudo npm i -g pm2) && (pm2 restart bravo 2>/dev/null || pm2 start index.js --name bravo) && pm2 save"
if %ERRORLEVEL% NEQ 0 goto :fail

rem ── Post-deploy verification ────────────────────────────────────────────
rem  ⚠ A restart "succeeding" proves nothing: pm2 reports success and then
rem  crash-loops on a missing require, and /health can still be answered by a
rem  STALE process during the gap. Wait, then check the process is actually up
rem  with no restarts, and that the health endpoint answers from the new one.
echo.
echo Verifying the server actually came up (not crash-looping)...
ssh -i "%USERPROFILE%\.ssh\vps_ed25519" ubuntu@135.148.120.186 "sleep 6 && pm2 describe bravo | grep -E 'status|restarts' && echo '--- health:' && curl -s --max-time 5 localhost:2567/health && echo '' && echo '--- last 25 log lines:' && pm2 logs bravo --lines 25 --nostream"
if %ERRORLEVEL% NEQ 0 goto :fail

echo.
echo ============================================
echo  CHECK THE OUTPUT ABOVE BEFORE WALKING AWAY:
echo    status must be 'online'
echo    restarts must NOT be climbing
echo    health must return JSON
echo    logs must show 'world server listening on :2567'
echo    logs must NOT show 'no resource layer'
echo ============================================
echo.
echo Reminder: nginx needs BOTH location blocks - /bravo-ws/ AND /auth/
echo           (see docs/HOTFIX.md - accounts 404 in production without /auth/)
goto :end
:fail
echo.
echo FAILED - check SSH key / VPS connection / pm2 output above.
:end
echo.
rem pause
