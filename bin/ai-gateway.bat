@echo off
setlocal
rem AI-Gateway-Hub Control Panel (Windows)
rem Usage: ai-gateway.bat          (interactive menu)
rem        ai-gateway.bat start    (direct command)

set "SCRIPT_DIR=%~dp0"

where node >nul 2>nul
if errorlevel 1 (
    echo [error] Node.js not found in PATH. Install from https://nodejs.org/
    exit /b 1
)

if "%~1"=="" (
    node "%SCRIPT_DIR%ctl.mjs"
) else (
    node "%SCRIPT_DIR%ctl.mjs" %*
)
exit /b %errorlevel%
