@echo off
echo ============================================
echo   Project Bravo - Deploy WORLD SERVER to VPS
echo ============================================
echo.
echo Rebuilding world-data.json from client map and world_edits.json...
node "%~dp0server\build-world-data.mjs"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: Rebuilding world-data.json failed. Deployment aborted.
    goto :fail
)
echo.

echo Copying server files (index.js, bravo-room.js, storage.js, mobs.js, world-data.json, package.json)...
ssh -i "%USERPROFILE%\.ssh\vps_ed25519" ubuntu@135.148.120.186 "mkdir -p /home/ubuntu/bravo-server"
if %ERRORLEVEL% NEQ 0 goto :fail

scp -i "%USERPROFILE%\.ssh\vps_ed25519" "%~dp0server\index.js" "%~dp0server\bravo-room.js" "%~dp0server\storage.js" "%~dp0server\mobs.js" "%~dp0server\world-data.json" "%~dp0server\package.json" ubuntu@135.148.120.186:/home/ubuntu/bravo-server/
if %ERRORLEVEL% NEQ 0 goto :fail

echo Installing dependencies and (re)starting under pm2...
ssh -i "%USERPROFILE%\.ssh\vps_ed25519" ubuntu@135.148.120.186 "cd /home/ubuntu/bravo-server && npm install --omit=dev --no-audit --no-fund && (command -v pm2 >/dev/null || sudo npm i -g pm2) && (pm2 restart bravo 2>/dev/null || pm2 start index.js --name bravo) && pm2 save && sleep 1 && curl -s localhost:2567/health"
if %ERRORLEVEL% NEQ 0 goto :fail

echo.
echo SUCCESS! World server is live (see health JSON above).
echo Reminder: nginx needs the /bravo-ws/ location block once - see server/README.md
goto :end
:fail
echo.
echo FAILED - check SSH key / VPS connection / pm2 output above.
:end
echo.
rem pause
