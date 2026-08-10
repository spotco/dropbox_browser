@echo off
setlocal
call "%~dp0_repo_root.bat" || exit /b 1
pushd "%REPO_ROOT%"

set "PYTHON_EXE=%REPO_ROOT%\python\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"

"%PYTHON_EXE%" -c "import sys; sys.path.insert(0, r'%REPO_ROOT%'); from dropbox_browser.cli import main; raise SystemExit(main())" --remote dropbox: %*
set "ERR=%ERRORLEVEL%"
popd
exit /b %ERR%
