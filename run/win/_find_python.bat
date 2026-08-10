@echo off
rem Resolve portable / configured Python into PYTHON_EXE.
rem Requires REPO_ROOT (call _repo_root.bat first).
set "PYTHON_EXE="

if defined DROPBOX_BROWSER_PYTHON (
  if exist "%DROPBOX_BROWSER_PYTHON%" set "PYTHON_EXE=%DROPBOX_BROWSER_PYTHON%"
)

rem Preferred: tool pack (same place setup_exe installs).
if not defined PYTHON_EXE (
  if exist "%REPO_ROOT%\.tools\windows-x64\python\python.exe" (
    set "PYTHON_EXE=%REPO_ROOT%\.tools\windows-x64\python\python.exe"
  )
)

rem Legacy in-repo portable CPython (while still present on disk).
if not defined PYTHON_EXE (
  if exist "%REPO_ROOT%\python\python.exe" (
    set "PYTHON_EXE=%REPO_ROOT%\python\python.exe"
  )
)

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
