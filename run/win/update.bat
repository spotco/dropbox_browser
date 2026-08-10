@echo off
setlocal
call "%~dp0_repo_root.bat" || exit /b 1
pushd "%REPO_ROOT%"

echo Updating from origin/master ...
git pull origin master
set "ERR=%ERRORLEVEL%"
if not "%ERR%"=="0" (
  echo git pull failed with exit code %ERR%
  popd
  pause
  exit /b %ERR%
)

echo.
echo Optional: refresh platform tools with run\win\setup_exe.bat
popd
pause
exit /b 0
