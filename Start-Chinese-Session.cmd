@echo off
setlocal
echo Experimental Chinese UI for Overwolf 0.310.1.1 / AlecaFrame 2.6.94
echo Integrity errors will be report-only for ALL extensions in this session.
echo Exit Overwolf first. OCR follows your saved setting; default is off.
echo Keep this launcher open; exit Overwolf normally to restore official files.
echo.
powershell.exe -NoProfile -ExecutionPolicy Bypass -File "%~dp0Start-AlecaFrame-ZH.ps1" -SessionValidationReportOnly
set "launchExitCode=%ERRORLEVEL%"
if not "%launchExitCode%"=="0" pause
exit /b %launchExitCode%
