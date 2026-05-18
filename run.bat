@echo off
pushd "%~dp0"
set "APP_ROOT=%~dp0."
set "PYTHON_EXE=%~dp0python\python.exe"
if not exist "%PYTHON_EXE%" set "PYTHON_EXE=python"
start "Dropbox Browser Server" "%PYTHON_EXE%" -c "import sys; sys.path.insert(0, r'%APP_ROOT%'); from dropbox_browser.cli import main; raise SystemExit(main())" --remote dropbox:
powershell -NoProfile -ExecutionPolicy Bypass -Command "$url = 'http://127.0.0.1:8000/'; for ($i = 0; $i -lt 60; $i++) { try { $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { Start-Process $url; exit 0 } } catch { Start-Sleep -Milliseconds 500 } }; Write-Host 'Server did not respond at http://127.0.0.1:8000/ within 30 seconds.'; exit 1"
popd