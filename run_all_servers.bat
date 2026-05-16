@echo off
setlocal
cd /d "%~dp0"

set "TRANSLATOR_DIR=%~dp0translator-server"
set "CDP_DIR=%~dp0subtitle-cdp-reader"
set "TRANSLATOR_PY=%TRANSLATOR_DIR%\.venv\Scripts\python.exe"
set "CDP_PY=%CDP_DIR%\.venv\Scripts\python.exe"
set "CONFIG_FILE=%~dp0config.local.ps1"

if not exist "%TRANSLATOR_PY%" (
  echo Missing translator venv: %TRANSLATOR_PY%
  echo Run setup first:
  echo   "%~dp0setup_windows.bat"
  pause
  exit /b 1
)

if not exist "%CDP_PY%" (
  echo Missing CDP reader venv: %CDP_PY%
  echo Run setup first:
  echo   "%~dp0setup_windows.bat"
  pause
  exit /b 1
)

"%TRANSLATOR_PY%" -c "import sys; raise SystemExit(0 if sys.version_info[0] == 3 and (11 <= sys.version_info[1] <= 13) else 1)" >nul 2>nul
if errorlevel 1 (
  echo Translator venv is not usable on this PC.
  echo This usually means the project was copied with an old .venv or uses unsupported Python.
  echo Required Python version: 3.11-3.13. Python 3.14 is not supported by current dependencies.
  echo Run setup first to recreate local Python environments:
  echo   "%~dp0setup_windows.bat"
  pause
  exit /b 1
)

"%CDP_PY%" -c "import sys; raise SystemExit(0 if sys.version_info[0] == 3 and (11 <= sys.version_info[1] <= 13) else 1)" >nul 2>nul
if errorlevel 1 (
  echo CDP reader venv is not usable on this PC.
  echo This usually means the project was copied with an old .venv or uses unsupported Python.
  echo Required Python version: 3.11-3.13. Python 3.14 is not supported by current dependencies.
  echo Run setup first to recreate local Python environments:
  echo   "%~dp0setup_windows.bat"
  pause
  exit /b 1
)

if not exist "%CONFIG_FILE%" copy "%~dp0config.local.example.ps1" "%CONFIG_FILE%" >nul
if not exist "%TRANSLATOR_DIR%\config.yaml" copy "%TRANSLATOR_DIR%\config.example.yaml" "%TRANSLATOR_DIR%\config.yaml" >nul

echo Starting local translation stack...
echo.
echo The launcher will print health checks and the vMix/OBS overlay URL.
echo Keep this window open. Close it or press Ctrl+C to stop servers and managed Yandex CDP.
echo.

powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0scripts\run_all_servers.ps1" ^
  -ProjectRoot "%~dp0." ^
  -ConfigPath "%CONFIG_FILE%" ^
  -TranslatorDir "%TRANSLATOR_DIR%" ^
  -TranslatorPython "%TRANSLATOR_PY%" ^
  -CdpDir "%CDP_DIR%" ^
  -CdpPython "%CDP_PY%"

echo.
echo Servers stopped. Press any key to close this window.
pause >nul
