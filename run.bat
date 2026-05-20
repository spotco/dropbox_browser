@echo off
setlocal
pushd "%~dp0"
start "" powershell -WindowStyle Hidden -NoProfile -ExecutionPolicy Bypass -Command "$url = 'http://127.0.0.1:8000/'; for ($i = 0; $i -lt 60; $i++) { try { $response = Invoke-WebRequest -UseBasicParsing -Uri $url -TimeoutSec 1; if ($response.StatusCode -ge 200 -and $response.StatusCode -lt 500) { Start-Process $url; exit 0 } } catch { Start-Sleep -Milliseconds 500 } }; Write-Host 'Server did not respond at http://127.0.0.1:8000/ within 30 seconds.'; exit 1"
call "%~dp0run_server.bat"
popd
