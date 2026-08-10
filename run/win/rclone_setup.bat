@echo off
setlocal
call "%~dp0_repo_root.bat" || exit /b 1
pushd "%REPO_ROOT%"

echo rclone Dropbox Setup

set "RCLONE="
if exist "%REPO_ROOT%\.tools\windows-x64\rclone.exe" set "RCLONE=%REPO_ROOT%\.tools\windows-x64\rclone.exe"
if not defined RCLONE if exist "%REPO_ROOT%\rclone.exe" set "RCLONE=%REPO_ROOT%\rclone.exe"
if not defined RCLONE (
  where rclone >nul 2>nul
  if not errorlevel 1 for /f "delims=" %%I in ('where rclone') do if not defined RCLONE set "RCLONE=%%I"
)

if not defined RCLONE (
  echo error: rclone not found. Run run\win\setup_exe.bat first.
  popd
  pause
  exit /b 1
)

echo Using: %RCLONE%
"%RCLONE%" config create dropbox dropbox
set "ERR=%ERRORLEVEL%"
popd
pause
exit /b %ERR%
