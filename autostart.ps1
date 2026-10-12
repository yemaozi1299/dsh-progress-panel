<#
  把进度中枢设成开机自启（或取消）。

      powershell -File autostart.ps1          # 开启
      powershell -File autostart.ps1 -Off     # 关闭
      powershell -File autostart.ps1 -Status  # 只看状态

  做法是在「启动」文件夹里放一个指向 start-hub.cmd 的快捷方式（最小化启动）。
  选它而不是计划任务，因为：你能在文件管理器里直接看见它、删掉就等于取消、
  出问题时那个最小化的窗口里还有中枢的日志可看。
#>
[CmdletBinding()]
param(
    [switch]$Off,
    [switch]$Status
)

$ErrorActionPreference = 'Stop'
$root = Split-Path -Parent $MyInvocation.MyCommand.Path
$target = Join-Path $root 'start-hub.cmd'
$startup = [Environment]::GetFolderPath('Startup')
$link = Join-Path $startup 'dsh-progress-hub.lnk'

function Show-Status {
    if (Test-Path $link) {
        Write-Host "开机自启：已开启" -ForegroundColor Green
        Write-Host "  快捷方式：$link"
    } else {
        Write-Host "开机自启：未开启" -ForegroundColor Yellow
    }
    # 顺便看看现在有没有在跑
    $running = $null
    foreach ($p in 8791..8800) {
        try {
            $r = Invoke-RestMethod -Uri "http://127.0.0.1:$p/api/health" -TimeoutSec 1
            if ($r.ok) { $running = $p; break }
        } catch { }
    }
    if ($running) {
        Write-Host "中枢：正在运行  http://127.0.0.1:$running/" -ForegroundColor Green
    } else {
        Write-Host "中枢：没在跑（现在悬浮窗不会显示任何东西）" -ForegroundColor Yellow
    }
}

if ($Status) { Show-Status; exit 0 }

if ($Off) {
    if (Test-Path $link) {
        Remove-Item $link -Force
        Write-Host "已取消开机自启。" -ForegroundColor Green
    } else {
        Write-Host "本来就没开启，什么都没做。" -ForegroundColor Yellow
    }
    exit 0
}

if (-not (Test-Path $target)) {
    throw "找不到 $target —— 这个脚本要放在仓库根目录。"

}
$shell = New-Object -ComObject WScript.Shell
$sc = $shell.CreateShortcut($link)
$sc.TargetPath = $target
$sc.WorkingDirectory = $root
$sc.WindowStyle = 7          # 7 = 最小化，眼不见但还在
$sc.Description = 'DSH 进度中枢（进度悬浮窗的数据来源）'
$sc.Save()

Write-Host "已设置开机自启。" -ForegroundColor Green
Write-Host "  快捷方式：$link"
Write-Host "  下次登录会自动启动（最小化）。想立刻生效就现在双击 start-hub.cmd。"
Write-Host ""
Show-Status
