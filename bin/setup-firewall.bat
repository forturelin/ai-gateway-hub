@echo off
setlocal EnableExtensions EnableDelayedExpansion
rem ============================================================
rem AI-Gateway-Hub firewall helper (Windows)
rem
rem Usage:
rem   bin\setup-firewall.bat add      - add inbound TCP rule for the listen port
rem   bin\setup-firewall.bat remove   - remove the rule
rem   bin\setup-firewall.bat status   - print rule state (no admin needed)
rem
rem Reads port from project config.json (defaults to 44559).
rem Rule name: ai-gateway-hub-<port>   (profile = private,domain)
rem ============================================================

set "ACTION=%~1"
if "%ACTION%"=="" set "ACTION=status"

set "SCRIPT_DIR=%~dp0"
set "PROJECT_ROOT=%SCRIPT_DIR%.."
set "CONFIG_FILE=%PROJECT_ROOT%\config.json"

rem ---- Resolve port from config.json (fallback 44559) ----
set "PORT=44559"
if exist "%CONFIG_FILE%" (
    for /f "tokens=2 delims=:," %%a in ('findstr /R /C:"\"port\"" "%CONFIG_FILE%"') do (
        for /f "tokens=* delims= " %%b in ("%%a") do set "PORT=%%b"
    )
)
rem strip surrounding spaces / trailing characters just in case
set "PORT=%PORT: =%"
set "RULE_NAME=ai-gateway-hub-%PORT%"

rem ---- Dispatch ----
if /I "%ACTION%"=="status" goto :status
if /I "%ACTION%"=="add"    goto :need_admin_then_add
if /I "%ACTION%"=="remove" goto :need_admin_then_remove
echo Unknown action: %ACTION%
echo Use: add ^| remove ^| status
exit /b 2

:status
rem netsh exit code 1 when no matching rule
netsh advfirewall firewall show rule name="%RULE_NAME%" >nul 2>&1
if errorlevel 1 (
    echo MISSING port=%PORT% rule="%RULE_NAME%"
    exit /b 1
) else (
    echo PRESENT port=%PORT% rule="%RULE_NAME%"
    exit /b 0
)

:need_admin_then_add
call :check_admin || exit /b 5
echo [add] creating inbound rule "%RULE_NAME%" for TCP %PORT% (private,domain) ...
rem Remove any stale rule with the same name first, ignore errors
netsh advfirewall firewall delete rule name="%RULE_NAME%" >nul 2>&1
netsh advfirewall firewall add rule ^
    name="%RULE_NAME%" ^
    description="AI-Gateway-Hub inbound (managed by setup-firewall.bat)" ^
    dir=in action=allow protocol=TCP localport=%PORT% ^
    profile=private,domain enable=yes
if errorlevel 1 (
    echo [add] FAILED
    exit /b 3
)
echo [add] OK
exit /b 0

:need_admin_then_remove
call :check_admin || exit /b 5
echo [remove] deleting rule "%RULE_NAME%" ...
netsh advfirewall firewall delete rule name="%RULE_NAME%" >nul 2>&1
echo [remove] OK
exit /b 0

:check_admin
rem `net session` requires admin; non-zero exit = not elevated
net session >nul 2>&1
if errorlevel 1 (
    echo [error] This action requires administrator privileges.
    echo         Right-click cmd / PowerShell -^> "Run as administrator", then re-run:
    echo            "%~f0" %ACTION%
    exit /b 5
)
exit /b 0
