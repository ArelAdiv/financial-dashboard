@echo off
cd /d "%~dp0"
echo Installing dependencies...
call npm install
if errorlevel 1 (
  echo ERROR: npm install failed. Make sure Node.js is installed.
  pause
  exit /b 1
)
echo.
echo Starting server...
echo Open browser at: http://localhost:3000
echo Press Ctrl+C to stop.
echo.
start "" "http://localhost:3000"
node server.js
pause
