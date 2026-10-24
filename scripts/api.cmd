@echo off
REM Start the OneMemory HTTP API (localhost:8790) for the phone command page.
REM Only the tunnel hostname below may make browser requests to it.
cd /d "%~dp0.."
set ONEMEMORY_ALLOWED_ORIGINS=https://onememory.calasautomations.com
REM Serve the phone signing page at /sign (off by default in the package).
set ONEMEMORY_ENABLE_SIGN_PAGE=1
call npm run build || exit /b 1
call npm run api
