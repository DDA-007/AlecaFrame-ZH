@echo off
setlocal
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Uninstall-AlecaFrame-ZH.ps1"
set "uninstallExitCode=%ERRORLEVEL%"
echo.
pause
exit /b %uninstallExitCode%
