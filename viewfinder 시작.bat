@echo off
cd /d "%~dp0"

set RELAY_PORT=8787
for /f "tokens=2 delims==" %%A in ('findstr /b "RELAY_PORT=" .env 2^>nul') do set RELAY_PORT=%%A

netstat -ano | findstr ":%RELAY_PORT% " | findstr "LISTENING" >nul
if %errorlevel%==0 (
  echo Relay already running on port %RELAY_PORT% - skipping.
) else (
  echo Starting upload relay...
  start "Upload Relay - keep this window open" cmd /k node hetzner-upload-relay.js
  timeout /t 2 /nobreak >nul
)

start "" "viewfinder.html"
exit
