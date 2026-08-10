@echo off
setlocal
call "%~dp0_repo_root.bat" || exit /b 1
pushd "%REPO_ROOT%"

where python >nul 2>nul
if errorlevel 1 (
  echo error: python not found on PATH
  popd
  exit /b 1
)

echo Installing Windows tool pack into .tools\windows-x64 ...
python tools\bootstrap_tools.py %*
if errorlevel 1 (
  popd
  exit /b 1
)

echo.
echo Done. Start the server with:
echo   run\win\run.bat
echo Or: run\win\run_server.bat
popd
exit /b 0
