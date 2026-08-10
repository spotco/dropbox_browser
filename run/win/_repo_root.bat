@echo off
rem Resolve repository root from this script's location (run\win\ -> repo root).
rem Callers: call "%~dp0_repo_root.bat" then use %REPO_ROOT%.
set "REPO_ROOT="
for %%I in ("%~dp0..\..") do set "REPO_ROOT=%%~fI"
if not exist "%REPO_ROOT%\dropbox_browser.py" (
  echo error: could not resolve repo root from "%~dp0"
  echo expected dropbox_browser.py under "%REPO_ROOT%"
  exit /b 1
)
