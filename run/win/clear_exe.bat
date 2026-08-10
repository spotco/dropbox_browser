@echo off
setlocal
call "%~dp0_repo_root.bat" || exit /b 1
pushd "%REPO_ROOT%"

echo Clearing platform tool binaries under "%REPO_ROOT%" ...

if exist ".tools" (
  rmdir /s /q ".tools"
  echo removed .tools\
) else (
  echo .tools\ not present
)

if exist "tools-packs" (
  rmdir /s /q "tools-packs"
  echo removed tools-packs\
) else (
  echo tools-packs\ not present
)

rem Legacy in-repo Windows binaries (if any remain on disk)
if exist "rclone.exe" (
  del /q "rclone.exe"
  echo removed rclone.exe
)
if exist "FFmpeg\bin\ffmpeg.exe" del /q "FFmpeg\bin\ffmpeg.exe"
if exist "FFmpeg\bin\ffprobe.exe" del /q "FFmpeg\bin\ffprobe.exe"
for %%F in (magick compare composite conjure identify mogrify montage stream) do (
  if exist "ImageMagick\%%F.exe" del /q "ImageMagick\%%F.exe"
)

echo.
echo Done. Reinstall tools with: run\win\setup_exe.bat
popd
exit /b 0
