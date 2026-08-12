@echo off
echo ============================================
echo   Project Bravo Game - Deploy to VPS
echo ============================================
echo.
echo Deploying medieval_prototype.html, js/, shared/, models/, sounds/, img/ (+ world_edits.json if present)...
echo.
echo Preflight: verifying the deploy covers every file the code needs...
node "%~dp0tools\check_deploy.mjs"
if %ERRORLEVEL% NEQ 0 (
    echo.
    echo ERROR: preflight failed - see above. Deployment aborted.
    goto :fail
)
echo.
ssh -i "%USERPROFILE%\.ssh\vps_ed25519" ubuntu@135.148.120.186 "rm -rf /tmp/medieval_prototype.html /tmp/js /tmp/shared /tmp/models /tmp/sounds /tmp/img /tmp/world_edits.json /tmp/water_texture.png"
if %ERRORLEVEL% NEQ 0 goto :fail

scp -i "%USERPROFILE%\.ssh\vps_ed25519" "%~dp0medieval_prototype.html" ubuntu@135.148.120.186:/tmp/medieval_prototype.html
if %ERRORLEVEL% NEQ 0 goto :fail

scp -i "%USERPROFILE%\.ssh\vps_ed25519" "%~dp0water_texture.png" ubuntu@135.148.120.186:/tmp/water_texture.png
if %ERRORLEVEL% NEQ 0 goto :fail

scp -i "%USERPROFILE%\.ssh\vps_ed25519" -r "%~dp0js" ubuntu@135.148.120.186:/tmp/js
if %ERRORLEVEL% NEQ 0 goto :fail

rem  ⚠ shared/ holds the economy tables. game3d.js FETCHES shared/recipes.json at
rem  boot and refuses every craft if it 404s — which is exactly what happened the
rem  first time this folder existed and this script did not know about it. The
rem  failure is silent in the deploy log and only shows up as "crafting is broken
rem  in production but fine locally".
scp -i "%USERPROFILE%\.ssh\vps_ed25519" -r "%~dp0shared" ubuntu@135.148.120.186:/tmp/shared
if %ERRORLEVEL% NEQ 0 goto :fail

scp -i "%USERPROFILE%\.ssh\vps_ed25519" -r "%~dp0models" ubuntu@135.148.120.186:/tmp/models
if %ERRORLEVEL% NEQ 0 goto :fail

scp -i "%USERPROFILE%\.ssh\vps_ed25519" -r "%~dp0sounds" ubuntu@135.148.120.186:/tmp/sounds
if %ERRORLEVEL% NEQ 0 goto :fail

scp -i "%USERPROFILE%\.ssh\vps_ed25519" -r "%~dp0img" ubuntu@135.148.120.186:/tmp/img
if %ERRORLEVEL% NEQ 0 goto :fail

rem --- optional: the edited world (map/mobs/skins) so every player gets it ---
if exist "%~dp0world_edits.json" (
    scp -i "%USERPROFILE%\.ssh\vps_ed25519" "%~dp0world_edits.json" ubuntu@135.148.120.186:/tmp/world_edits.json
    if %ERRORLEVEL% NEQ 0 goto :fail
)

ssh -i "%USERPROFILE%\.ssh\vps_ed25519" ubuntu@135.148.120.186 "sudo mkdir -p /var/www/orion-syndicate/js /var/www/orion-syndicate/shared /var/www/orion-syndicate/models /var/www/orion-syndicate/sounds /var/www/orion-syndicate/img && sudo cp /tmp/medieval_prototype.html /var/www/orion-syndicate/medieval_prototype.html && cp /tmp/medieval_prototype.html /home/ubuntu/orionuo-relay/medieval_prototype.html && sudo cp /tmp/water_texture.png /var/www/orion-syndicate/water_texture.png && sudo cp -r /tmp/js/* /var/www/orion-syndicate/js/ && sudo cp -r /tmp/shared/* /var/www/orion-syndicate/shared/ && sudo cp -r /tmp/models/* /var/www/orion-syndicate/models/ && sudo cp -r /tmp/sounds/* /var/www/orion-syndicate/sounds/ && sudo cp -r /tmp/img/* /var/www/orion-syndicate/img/ && ([ -f /tmp/world_edits.json ] && sudo cp /tmp/world_edits.json /var/www/orion-syndicate/world_edits.json || true) && sudo rm -f /var/www/orion-syndicate/js/game.js /var/www/orion-syndicate/js/draw.js /var/www/orion-syndicate/js/world_edits.json && sudo chown -R www-data:www-data /var/www/orion-syndicate && rm -rf /tmp/medieval_prototype.html /tmp/js /tmp/shared /tmp/models /tmp/sounds /tmp/img /tmp/world_edits.json /tmp/water_texture.png"
if %ERRORLEVEL% EQU 0 (
    echo.
    echo SUCCESS!
    echo Live at: https://orionsyndicateguild.org/medieval_prototype.html
    goto :end
)
:fail
echo.
echo FAILED - check SSH key and VPS connection.
:end
echo.
rem pause
