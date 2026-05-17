@echo off
pushd "%~dp0"
set "APP_ROOT=%~dp0."
"%~dp0python\python.exe" -c "import sys; sys.path.insert(0, r'%APP_ROOT%'); from dropbox_browser.cli import main; raise SystemExit(main())" --remote dropbox: --local-root "F:\Dropbox"
