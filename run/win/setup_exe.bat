@echo off
setlocal
call "%~dp0_repo_root.bat" || (
  echo.
  pause
  exit /b 1
)
pushd "%REPO_ROOT%"

rem Explorer double-click often has a thinner PATH than an interactive terminal.
set "PYTHON_EXE="
if exist "%REPO_ROOT%\python\python.exe" set "PYTHON_EXE=%REPO_ROOT%\python\python.exe"
if not defined PYTHON_EXE (
  where py >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%I in ('py -3 -c "import sys; print(sys.executable)" 2^>nul') do set "PYTHON_EXE=%%I"
  )
)
if not defined PYTHON_EXE (
  where python >nul 2>nul
  if not errorlevel 1 (
    for /f "delims=" %%I in ('where python') do (
      if not defined PYTHON_EXE set "PYTHON_EXE=%%I"
    )
  )
)
if not defined PYTHON_EXE (
  echo error: python not found.
  echo Tried: "%REPO_ROOT%\python\python.exe", py -3, and PATH python.
  echo Open a terminal where "python --version" works, or install Python 3.
  popd
  echo.
  pause
  exit /b 1
)

echo Repo root:  %REPO_ROOT%
echo Python:     %PYTHON_EXE%
echo.
echo Installing Windows tool pack into:
echo   %REPO_ROOT%\.tools\windows-x64\
echo (not into run\win — look under the repo .tools folder)
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

echo.
echo Done. Start the server with:
echo   run\win\run.bat
echo Or: run\win\run_server.bat
popd
echo.
pause
exit /b 0
