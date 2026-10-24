@echo off
REM Start the OneMemory command runner. Double-click to run it in a window,
REM or let the Scheduled Task call it at logon.
cd /d "%~dp0.."
call npm run build || exit /b 1
call npm run runner
