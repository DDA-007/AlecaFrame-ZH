@echo off
chcp 65001 >nul
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Set-AlecaFrame-ZH-OcrMode.ps1" -Mode Enable
set "ocrExitCode=%ERRORLEVEL%"
echo.
pause
exit /b %ocrExitCode%
