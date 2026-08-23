@echo off
cd /d "%~dp0"
set "NODE24_DIR=C:\Users\Administrator\AppData\Local\Microsoft\WinGet\Packages\OpenJS.NodeJS.LTS_Microsoft.Winget.Source_8wekyb3d8bbwe\node-v24.16.0-win-x64"
set "PATH=%NODE24_DIR%;%PATH%"
call "%NODE24_DIR%\npx.cmd" wrangler deploy %*
