@echo off
setlocal
call "%~dp0_repo_root.bat" || exit /b 1
pushd "%REPO_ROOT%"

for /f "usebackq delims=" %%I in (`powershell -NoProfile -ExecutionPolicy Bypass -Command "Add-Type -AssemblyName System.Windows.Forms; $dialog = New-Object System.Windows.Forms.FolderBrowserDialog; $dialog.Description = 'Select the local Dropbox folder'; $dialog.ShowNewFolderButton = $true; if ($dialog.ShowDialog() -eq [System.Windows.Forms.DialogResult]::OK) { $configPath = Join-Path -Path '%REPO_ROOT%' -ChildPath 'config_local.json'; if (Test-Path $configPath) { $config = Get-Content $configPath -Raw | ConvertFrom-Json } else { $config = [pscustomobject]@{} }; $config | Add-Member -NotePropertyName DropboxFolder -NotePropertyValue $dialog.SelectedPath -Force; $config | ConvertTo-Json | Set-Content -Path $configPath -Encoding UTF8; Write-Output $dialog.SelectedPath }"`) do set "DROPBOX_FOLDER=%%I"

if not defined DROPBOX_FOLDER (
  echo No folder selected.
  popd
  pause
  exit /b 1
)

echo DropboxFolder set to "%DROPBOX_FOLDER%"
call "%~dp0run.bat" %*
set "ERR=%ERRORLEVEL%"
popd
exit /b %ERR%
