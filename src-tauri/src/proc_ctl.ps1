# ToolArk 安装进程控制脚本
# 输入（环境变量）：
#   TOOLARK_PID       winget 进程 PID
#   TOOLARK_ACTION    suspend | resume | kill | sweep
#   TOOLARK_SINCE     （可选）sweep 用：只清理此时间之后启动的孤儿安装进程，Unix 秒
# 输出：单行 JSON {"ok":true,"count":n,"pids":[...],"errors":[...]}
#
# 为什么要挂起整棵进程树而不是只挂 winget：
# winget 只是个调度器，真正下载/解包/写盘的是它拉起的安装器（msiexec、
# Inno Setup 的 setup.exe、NSIS 的临时 exe）。只挂 winget 的话安装器
# 仍在后台跑满 CPU、继续往磁盘写，用户看到的"暂停"就是假的。
#
# 用 NtSuspendProcess 而不是 Stop-Process：后者是终止，前者是冻结，
# 冻结的进程可以原样恢复，已下载的字节不会丢。
#
# kill 与 sweep 的区别：
#   kill  —— 按 PID 干掉整棵树（取消安装时用，先杀子后杀父）
#   sweep —— 没有根 PID 可用时，扫出「父进程已经不存在」的安装器孤儿。
#            取消安装后 winget 被 taskkill 杀掉，它拉起的 msiexec 有时会
#            被系统重新挂到别的父进程上继续跑，CPU/GPU 一直占着。
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$rootPid = 0
[int]::TryParse([string]$env:TOOLARK_PID, [ref]$rootPid) | Out-Null
$action = [string]$env:TOOLARK_ACTION
$since = 0
[long]::TryParse([string]$env:TOOLARK_SINCE, [ref]$since) | Out-Null

$result = [ordered]@{ ok = $false; count = 0; pids = @(); errors = @() }
if (($action -ne 'sweep') -and ($rootPid -le 0 -or ($action -ne 'suspend' -and $action -ne 'resume' -and $action -ne 'kill'))) {
  $result.errors += 'bad-args'
  Write-Output ($result | ConvertTo-Json -Compress)
  exit 0
}
if ($action -notin @('suspend', 'resume', 'kill', 'sweep')) {
  $result.errors += 'bad-action'
  Write-Output ($result | ConvertTo-Json -Compress)
  exit 0
}

if (-not ('ArkProc' -as [type])) {
  Add-Type -Namespace '' -Name 'ArkProc' -MemberDefinition @'
[System.Runtime.InteropServices.DllImport("ntdll.dll")]
public static extern int NtSuspendProcess(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("ntdll.dll")]
public static extern int NtResumeProcess(System.IntPtr h);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern System.IntPtr OpenProcess(uint access, bool inherit, uint pid);
[System.Runtime.InteropServices.DllImport("kernel32.dll", SetLastError = true)]
public static extern bool CloseHandle(System.IntPtr h);
'@
}

# 递归收集整棵进程树：winget → 安装器 → 安装器再拉起的辅助进程
$all = @()
try {
  $all = @(Get-CimInstance Win32_Process -Property ProcessId, ParentProcessId, Name, CreationDate -ErrorAction Stop)
} catch {
  $result.errors += ("枚举进程失败: " + $_.Exception.Message)
  Write-Output ($result | ConvertTo-Json -Compress)
  exit 0
}

$tree = New-Object System.Collections.ArrayList
if ($action -eq 'sweep') {
  # 孤儿安装器：父进程已不在，且名字属于安装器家族。
  # 只认这几个名字，绝不按"资源占用高"去猜——那会误杀用户自己的程序。
  $live = New-Object System.Collections.Generic.HashSet[int]
  foreach ($p in $all) { [void]$live.Add([int]$p.ProcessId) }
  $installerNames = @('msiexec', 'setup', 'install', 'installer', 'unins000', 'uninstall',
    'winget', 'AppInstallerCLI', 'dpinst', 'vc_redist.x64')
  foreach ($p in $all) {
    if ($installerNames -notcontains [string]$p.Name) { continue }
    $parent = [int]$p.ParentProcessId
    if ($parent -eq 0) { continue }
    if ($live.Contains($parent)) { continue }
    if ($since -gt 0) {
      $ct = 0
      try { $ct = [long]([datetimeoffset]$p.CreationDate).ToUnixTimeSeconds() } catch { $ct = 0 }
      if ($ct -gt 0 -and $ct -lt $since) { continue }
    }
    [void]$tree.Add([int]$p.ProcessId)
  }
} else {
  $queue = New-Object System.Collections.Queue
  [void]$queue.Enqueue($rootPid)
  $guard = 0
  while ($queue.Count -gt 0 -and $guard -lt 512) {
    $guard++
    $cur = [int]$queue.Dequeue()
    if ($tree -contains $cur) { continue }
    [void]$tree.Add($cur)
    foreach ($c in $all) {
      if ([int]$c.ParentProcessId -eq $cur) { [void]$queue.Enqueue([int]$c.ProcessId) }
    }
  }
}

if ($action -eq 'kill' -or $action -eq 'sweep') {
  # 倒序杀：先杀子孙再杀父。反过来的话父进程一死，子进程立刻被系统重新挂载，
  # 下一次枚举就找不到它们了。
  $done = 0
  $ordered = @($tree)
  [array]::Reverse($ordered)
  foreach ($p in $ordered) {
    if ($p -eq $PID) { continue }
    $proc = Get-Process -Id $p -ErrorAction SilentlyContinue
    if (-not $proc) { continue }
    try {
      Stop-Process -Id $p -Force -ErrorAction Stop
      $done++
      $result.pids += $p
    } catch {
      $result.errors += ("pid {0}: {1}" -f $p, $_.Exception.Message)
    }
  }
  $result.count = $done
  $result.ok = ($done -gt 0)
  Write-Output ($result | ConvertTo-Json -Compress)
  exit 0
}

$PROCESS_SUSPEND_RESUME = 0x0800
$done = 0
foreach ($p in $tree) {
  $h = [ArkProc]::OpenProcess($PROCESS_SUSPEND_RESUME, $false, [uint32]$p)
  if ($h -eq [System.IntPtr]::Zero) {
    # 进程已退出或权限不足都走这里，不算致命错误
    continue
  }
  try {
    if ($action -eq 'suspend') { [void][ArkProc]::NtSuspendProcess($h) }
    else { [void][ArkProc]::NtResumeProcess($h) }
    $done++
    $result.pids += $p
  } catch {
    $result.errors += ("pid {0}: {1}" -f $p, $_.Exception.Message)
  } finally {
    [void][ArkProc]::CloseHandle($h)
  }
}

$result.count = $done
$result.ok = ($done -gt 0)
Write-Output ($result | ConvertTo-Json -Compress)
