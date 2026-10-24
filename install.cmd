@echo off
setlocal enabledelayedexpansion
chcp 65001 >nul 2>&1
title XIUMI Connector - Install

rem ============================================================
rem  XIUMI Connector installer (ASCII only, portable)
rem
rem  Optional 1st arg = install directory.
rem  Default: %USERPROFILE%\.workbuddy\skills\xiumi
rem ============================================================

set "SRC=%~dp0"
if "%SRC:~-1%"=="\" set "SRC=%SRC:~0,-1%"
set "DEST=%~1"
if "%DEST%"=="" set "DEST=%USERPROFILE%\.workbuddy\skills\xiumi"

echo.
echo  ==========================================
echo    XIUMI Connector  v3  -  Installer
echo  ==========================================
echo.

rem ---- locate node ----
set "NODE_EXE="
if exist "%ProgramFiles%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles%\nodejs\node.exe"
if not defined NODE_EXE if exist "%ProgramFiles(x86)%\nodejs\node.exe" set "NODE_EXE=%ProgramFiles(x86)%\nodejs\node.exe"
if not defined NODE_EXE if exist "%LOCALAPPDATA%\Programs\nodejs\node.exe" set "NODE_EXE=%LOCALAPPDATA%\Programs\nodejs\node.exe"
if not defined NODE_EXE for /d %%D in ("%USERPROFILE%\.workbuddy\binaries\node\versions\*") do if exist "%%~D\node.exe" set "NODE_EXE=%%~D\node.exe"
if not defined NODE_EXE for %%N in (node.exe) do if exist "%%~$PATH:N" set "NODE_EXE=%%~$PATH:N"

if not defined NODE_EXE (
  echo   [X] Node.js not found. Please install Node.js 18+ first.
  echo       https://nodejs.org
  echo.
  pause
  exit /b 1
)
echo   [i] Node: %NODE_EXE%
for /f "tokens=*" %%V in ('"%NODE_EXE%" -v') do echo   [i] Version: %%V

rem ---- same-directory guard ----
if /I "%DEST%"=="%SRC%" (
  echo   [i] Running in place, skip copy.
  goto register
)

rem ---- step 1: copy (keep user data across upgrades) ----
echo.
echo   [1/3] Copying to %DEST%
if not exist "%DEST%" mkdir "%DEST%"
for %%F in (session.json) do if exist "%DEST%\%%F" copy /Y "%DEST%\%%F" "%TEMP%\xiumi_%%F.bak" >nul 2>&1
for %%D in (out library) do if exist "%DEST%\%%D" robocopy "%DEST%\%%D" "%TEMP%\xiumi_keep_%%D" /E /NFL /NDL /NJH /NJS /NC /NS >nul 2>&1

robocopy "%SRC%" "%DEST%" /E /NFL /NDL /NJH /NJS /NC /NS /XF session.json /XD out library .git node_modules >nul 2>&1

if exist "%TEMP%\xiumi_session.json.bak" (
  copy /Y "%TEMP%\xiumi_session.json.bak" "%DEST%\session.json" >nul 2>&1
  del "%TEMP%\xiumi_session.json.bak" >nul 2>&1
)
for %%D in (out library) do if exist "%TEMP%\xiumi_keep_%%D\" robocopy "%TEMP%\xiumi_keep_%%D" "%DEST%\%%D" /E /NFL /NDL /NJH /NJS /NC /NS >nul 2>&1
for %%D in (out library) do if exist "%TEMP%\xiumi_keep_%%D\" rmdir /S /Q "%TEMP%\xiumi_keep_%%D" >nul 2>&1

rem ---- step 2: register MCP (merge, never overwrite) ----
:register
echo.
echo   [2/3] Registering MCP server (merge mode)
"%NODE_EXE%" "%DEST%\register.mjs" --dir "%DEST%" --node "%NODE_EXE%"
if errorlevel 1 (
  echo   [X] Registration failed. MCP config left untouched.
  pause
  exit /b 1
)

rem ---- step 3: self check ----
echo.
echo   [3/3] Self-check
echo.
"%NODE_EXE%" "%DEST%\xiumi.mjs" doctor

echo.
echo  ==========================================
echo    Installed
echo  ==========================================
echo.
echo   Path: %DEST%
echo.
echo   Next:
echo     1. WorkBuddy -^> Connectors -^> find "xiumi" -^> Trust
echo     2. Login, easiest way:
echo        double-click  "%DEST%\status.cmd"
echo        paste Cookie -^> Login
echo     3. How to get Cookie:
echo        open https://xiumi.us and log in -^> F12 - Network - refresh
echo        -^> click any xiumi.us request -^> Request Headers
echo        -^> copy the whole Cookie value into a txt file
echo.
echo   Try:
echo        "%DEST%\xiumi.cmd" help
echo        "%DEST%\xiumi.cmd" market --limit 10
echo        "%DEST%\xiumi.cmd" inspect 733162400
echo.
pause
