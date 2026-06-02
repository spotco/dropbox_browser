@echo off
pushd "%~dp0"
set "APP_ROOT=%~dp0."
set "PYTHON_EXE=%~dp0python\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"
"%PYTHON_EXE%" -c "import sys; sys.path.insert(0, r'%APP_ROOT%'); from dropbox_browser.cli import main; raise SystemExit(main())" --remote dropbox: --client-render
popd
