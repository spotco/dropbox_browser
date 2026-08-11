@echo off
rem Resolve the only supported Windows runtime Python into PYTHON_EXE.
rem Requires REPO_ROOT (call _repo_root.bat first). The tool pack is installed
rem by setup_exe.bat using PowerShell, so no system Python is ever required.
set "PYTHON_EXE="

if exist "%REPO_ROOT%\.tools\windows-x64\python\python.exe" (
  set "PYTHON_EXE=%REPO_ROOT%\.tools\windows-x64\python\python.exe"
)
