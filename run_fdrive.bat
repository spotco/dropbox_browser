@echo off
pushd "%~dp0"
python dropbox_browser.py --remote dropbox: --local-root "F:\Dropbox"
pause
