@echo off
cd /d "%~dp0"
set "PORT=5001"
start "" cmd /c "timeout /t 2 /nobreak >nul && start http://127.0.0.1:5001"
node server-secure.js
