@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\cleanup.ps1" -ProjectRoot "%~dp0."

echo.
echo Press any key to close this window.
pause >nul
