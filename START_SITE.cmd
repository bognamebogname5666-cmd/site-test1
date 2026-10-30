@echo off
chcp 65001 >nul
setlocal
cd /d "%~dp0"
where node >nul 2>nul
if errorlevel 1 goto bundled_node
node server\launch.mjs %*
if errorlevel 1 goto failed
exit /b 0
:bundled_node
set "SITE_NODE=%USERPROFILE%\.cache\codex-runtimes\codex-primary-runtime\dependencies\node\bin\node.exe"
if exist "%SITE_NODE%" goto launch_bundled
echo Node.js 22.18 or newer is required. Install it from https://nodejs.org
pause
exit /b 1
:launch_bundled
"%SITE_NODE%" server\launch.mjs %*
if errorlevel 1 goto failed
exit /b 0
:failed
pause
exit /b 1
