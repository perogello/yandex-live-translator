@echo off
setlocal
cd /d "%~dp0"

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\setup_windows.ps1" -ProjectRoot "%~dp0."

echo.
echo Setup finished. Press any key to close this window.
pause >nul
