@echo off
setlocal
rem  Switch console to UTF-8 so Chinese output renders correctly
chcp 65001 >nul 2>&1
title XIUMI Connector - Status

rem Auto-locate Node.js (portable, no hard-coded paths)
set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE if exist "%APPDATA%\npm\node.exe" set "NODE_EXE=%APPDATA%\npm\node.exe"
if not defined NODE_EXE for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%~D\node.exe" set "NODE_EXE=%%~D\node.exe"
if not defined NODE_EXE for %%N in (node.exe) do if exist "%%~$PATH:N" set "NODE_EXE=%%~$PATH:N"

if not defined NODE_EXE goto NO_NODE

echo.
echo   Starting XIUMI status window ... (close this window to stop)
echo.
"%NODE_EXE%" "%~dp0status-server.mjs" --port 47820 %1 %2 %3 %4 %5 %6 %7 %8 %9
exit /b %ERRORLEVEL%

:NO_NODE
echo.
echo   [X] Node.js not found.
echo.
echo       Please install Node.js 18 or newer: https://nodejs.org
echo.
pause
exit /b 1
