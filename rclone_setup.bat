@echo off
echo rclone Dropbox Setup
set RCLONE=".\rclone.exe"

%RCLONE% config create dropbox dropbox
pause