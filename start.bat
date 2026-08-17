@echo off
cd /d "%~dp0"

if not exist node_modules (
    echo First time setup - installing dependencies, this takes a minute...
    call npm install
)

echo Freeing port 3002 if anything is still using it from a previous run...
for /f "tokens=5" %%a in ('netstat -aon ^| findstr :3002 ^| findstr LISTENING') do (
    taskkill /F /PID %%a >nul 2>&1
)

echo Starting the MMOProject server...
start "MMOProject Server - close this window to stop the game" cmd /k "npm run dev"

echo Waiting a few seconds for the server to come up...
timeout /t 4 /nobreak >nul

start http://localhost:3002

echo.
echo The game just opened in your browser. A second window titled
echo "MMOProject Server" is running the game in the background - leave it
echo open while you play, close it when you're done.
echo.
pause
