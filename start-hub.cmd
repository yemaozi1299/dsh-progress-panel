@echo off
rem ===========================================================================
rem  启动进度中枢。双击即可。
rem
rem  已经在跑的话，hub.py 自己会认出来并直接退出，不会重复占端口。
rem  这个窗口要一直开着——关掉就等于中枢停了，悬浮窗也就什么都不显示了。
rem  想让它开机自启，把本文件的快捷方式丢进 shell:startup 就行。
rem ===========================================================================
chcp 65001 >nul
cd /d "%~dp0"
if not exist ".dsh-progress" mkdir ".dsh-progress"

echo.
echo   正在启动进度中枢（这个窗口别关）...
echo.

python hub\hub.py %*

echo.
echo   中枢已退出。
pause
