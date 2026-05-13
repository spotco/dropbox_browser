@echo off
pushd "%~dp0"
python dropbox_browser.py --remote dropbox: --local-root "%~dp0DropboxLocal"
pause
