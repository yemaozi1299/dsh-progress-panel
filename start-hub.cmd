@echo off
rem ===========================================================================
rem  Start the progress hub. Double-click this file.
rem
rem  NOTE: this file is deliberately ASCII-only. A batch file that contains
rem  non-ASCII text AND calls "chcp" gets misparsed by cmd.exe: the codepage
rem  change makes cmd re-read the file at a wrong byte offset, and fragments
rem  of Chinese comments end up being executed as commands. All Chinese output
rem  comes from hub.py, which starts after the codepage has been switched.
rem
rem  Keep this window open - closing it stops the hub, and then the floating
rem  panel shows nothing. To start it at logon, run autostart-on.cmd.
rem ===========================================================================
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".dsh-progress" mkdir ".dsh-progress"

python hub\hub.py %*

echo.
echo [hub exited]
pause
