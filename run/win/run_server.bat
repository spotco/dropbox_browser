@echo off
setlocal
call "%~dp0_repo_root.bat" || exit /b 1
pushd "%REPO_ROOT%"
call "%~dp0_find_python.bat"
if not defined PYTHON_EXE (
  echo error: python not found. Run run\win\setup_exe.bat first.
  popd
  exit /b 1
)

set "DROPBOX_BROWSER_PYTHON=%PYTHON_EXE%"
"%PYTHON_EXE%" -c "import sys; sys.path.insert(0, r'%REPO_ROOT%'); from dropbox_browser.cli import main; raise SystemExit(main())" --remote dropbox: %*
set "ERR=%ERRORLEVEL%"
popd
exit /b %ERR%
