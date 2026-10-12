@echo off
rem ASCII-only on purpose - see the note in start-hub.cmd.
rem Chinese output comes from autostart.ps1.
chcp 65001 >nul
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0autostart.ps1" -Off %*
echo.
pause
