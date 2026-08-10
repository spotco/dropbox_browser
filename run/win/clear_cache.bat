@echo off
setlocal
call "%~dp0_repo_root.bat" || exit /b 1
pushd "%REPO_ROOT%"

del /q "Cache\FolderInfo\*.json" 2>nul
del /q "Cache\ListingCache\*.json" 2>nul
del /q "Temp\foldercache_threads.jsonl" 2>nul
echo Cache cleared under "%REPO_ROOT%"

popd
exit /b 0
