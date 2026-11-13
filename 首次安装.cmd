@echo off
chcp 65001 >nul
cd /d "%~dp0"
call npm ci
if errorlevel 1 goto end
call npm run build
:end
pause
