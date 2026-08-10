@echo off
setlocal
cd /d "%~dp0"

where python >nul 2>nul
if errorlevel 1 (
  echo error: python not found on PATH
  exit /b 1
)

echo Installing Windows tool pack into .tools\windows-x64 ...
python tools\bootstrap_tools.py %*
if errorlevel 1 exit /b 1

echo.
echo Done. Start the server with:
echo   python dropbox_browser.py --remote dropbox:
echo Or: run_server.bat
exit /b 0
