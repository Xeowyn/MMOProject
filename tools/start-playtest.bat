@echo off
cd /d "%~dp0.."

echo Starting the MMOProject server...
start "MMOProject Server" cmd /k "npm run dev"

echo Waiting a few seconds for the server to come up...
timeout /t 4 /nobreak >nul

echo Starting the Cloudflare Tunnel (this makes your game reachable from the internet)...
start "MMOProject Tunnel - SHARE THIS URL" cmd /k "tools\cloudflared.exe tunnel --url http://localhost:3002"

echo.
echo Two windows just opened:
echo   1. "MMOProject Server"                - the actual game server. Leave it running.
echo   2. "MMOProject Tunnel - SHARE THIS URL" - look in THIS window for a line like:
echo        https://some-random-words.trycloudflare.com
echo      That https:// link is what you paste to your friends. Nothing else needed
echo      - no router setup, no port forwarding.
echo.
echo If Windows SmartScreen pops up asking about cloudflared.exe, click "More info"
echo then "Run anyway" - that's normal for a freshly downloaded tool, it's safe.
echo.
echo Keep both windows open for the whole test. If the tunnel window ever closes and
echo you have to restart it, you'll get a DIFFERENT url - re-share it with everyone.
echo.
pause
