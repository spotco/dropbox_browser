@echo off
setlocal
call "%~dp0_repo_root.bat" || (
  echo.
  pause
  exit /b 1
)
pushd "%REPO_ROOT%"
call "%~dp0_find_python.bat"
if not defined PYTHON_EXE (
  echo error: python not found.
  echo Need a bootstrap interpreter once: repo python\python.exe, py -3, or PATH python.
  echo After setup_exe, runtime uses .tools\windows-x64\python\python.exe from the pack.
  popd
  echo.
  pause
  exit /b 1
)

echo Repo root:  %REPO_ROOT%
echo Bootstrap Python: %PYTHON_EXE%
echo.
echo Installing Windows tool pack (rclone/ffmpeg/magick + portable python) into:
echo   %REPO_ROOT%\.tools\windows-x64\
echo.

"%PYTHON_EXE%" tools\bootstrap_tools.py %*
if errorlevel 1 (
  echo.
  echo setup_exe failed.
  popd
  echo.
  pause
  exit /b 1
)

echo.
echo Installed tools (if present):
if exist ".tools\windows-x64\rclone.exe" (
  echo   %REPO_ROOT%\.tools\windows-x64\rclone.exe
) else (
  echo   rclone.exe MISSING
)
if exist ".tools\windows-x64\ffmpeg.exe" (
  echo   %REPO_ROOT%\.tools\windows-x64\ffmpeg.exe
) else (
  echo   ffmpeg.exe MISSING
)
if exist ".tools\windows-x64\ffprobe.exe" (
  echo   %REPO_ROOT%\.tools\windows-x64\ffprobe.exe
) else (
  echo   ffprobe.exe MISSING
)
if exist ".tools\windows-x64\ImageMagick\magick.exe" (
  echo   %REPO_ROOT%\.tools\windows-x64\ImageMagick\magick.exe
) else (
  echo   magick.exe MISSING
)
if exist ".tools\windows-x64\python\python.exe" (
  echo   %REPO_ROOT%\.tools\windows-x64\python\python.exe
) else (
  echo   portable python.exe MISSING
)

echo.
echo Done. Start the server with:
echo   run\win\run.bat
echo Or: run\win\run_server.bat
popd
echo.
pause
exit /b 0
