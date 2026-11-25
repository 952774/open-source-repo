# ToolArk 强力卸载 / 注册表清理
# 输入（环境变量）：
#   TOOLARK_NAME        显示名（用于匹配 ARP 键、快捷方式）
#   TOOLARK_EXE         主程序完整路径（可空）
#   TOOLARK_LOCATION    安装目录（可空）
#   TOOLARK_UNINSTALL   卸载命令行（可空）
#   TOOLARK_DRY         1 = 只报告不执行
# 输出：单行 JSON，含 steps[] 与 removed 计数
#
# 为什么需要这个脚本：
# 走 winget uninstall 时，只要安装器本身坏了（0x800401f5 Application not found、
# 文件被手工删过、ARP 键指向不存在的卸载器），winget 就彻底没辙，用户被卡在
# "卸载不掉"的状态。这里直接按 Windows 卸载的实际组成清理四件事：
#   进程 → 卸载器 → ARP 注册表键 → 残留目录与快捷方式
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$name = [string]$env:TOOLARK_NAME
$exe = [string]$env:TOOLARK_EXE
$location = [string]$env:TOOLARK_LOCATION
$uninstallCmd = [string]$env:TOOLARK_UNINSTALL
$dry = ([string]$env:TOOLARK_DRY) -eq '1'

$result = [ordered]@{
  ok      = $false
  dry     = $dry
  name    = $name
  steps   = @()
  removed = 0
  errors  = @()
}

function Add-Step([string]$text, [bool]$done, [string]$detail) {
  $result.steps += [ordered]@{ text = $text; done = $done; detail = $detail }
}

if ([string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace($exe)) {
  $result.errors += 'no-target'
  Write-Output ($result | ConvertTo-Json -Compress -Depth 5)
  exit 0
}

# ── 1. 结束占用进程 ────────────────────────────────────────────────
# 不结束进程就删目录，十有八九遇到"文件正在使用"，然后留下一半文件。
$killed = @()
if ($exe -and (Test-Path -LiteralPath $exe)) {
  $leaf = [System.IO.Path]::GetFileNameWithoutExtension($exe)
  foreach ($p in @(Get-Process -Name $leaf -ErrorAction SilentlyContinue)) {
    if ($dry) { $killed += $p.Id; continue }
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $killed += $p.Id } catch {
      $result.errors += ("结束进程 {0} 失败: {1}" -f $p.Id, $_.Exception.Message)
    }
  }
}
if ($location -and (Test-Path -LiteralPath $location)) {
  # 目录里其他常驻进程（更新器、托盘助手）也要一起停
  $inside = @(Get-Process -ErrorAction SilentlyContinue | Where-Object {
      $_.Path -and $_.Path.StartsWith($location, [StringComparison]::OrdinalIgnoreCase)
    })
  foreach ($p in $inside) {
    if ($killed -contains $p.Id) { continue }
    if ($dry) { $killed += $p.Id; continue }
    try { Stop-Process -Id $p.Id -Force -ErrorAction Stop; $killed += $p.Id } catch { }
  }
}
Add-Step '结束占用进程' ($killed.Count -gt 0) (($killed | ForEach-Object { "pid $_" }) -join ', ')

# ── 2. 调卸载器（静默） ────────────────────────────────────────────
$ranUninstaller = $false
if ($uninstallCmd) {
  $cmdLine = $uninstallCmd.Trim()
  # MsiExec 型：/X{GUID} 后面补静默参数
  if ($cmdLine -match '(?i)msiexec') {
    if ($cmdLine -notmatch '(?i)/qn|/quiet') { $cmdLine = "$cmdLine /qn /norestart" }
  } elseif ($cmdLine -match '(?i)\.exe') {
    if ($cmdLine -notmatch '(?i)/S\b|/silent|/verysilent|--uninstall') {
      $cmdLine = "$cmdLine /S"
    }
  }
  if ($dry) {
    Add-Step '调用卸载器' $false $cmdLine
    $ranUninstaller = $true
  } else {
    try {
      $p = Start-Process -FilePath 'cmd.exe' -ArgumentList '/c', $cmdLine -Wait -PassThru -WindowStyle Hidden
      $ranUninstaller = $true
      Add-Step '调用卸载器' $true ("exit " + $p.ExitCode)
    } catch {
      Add-Step '调用卸载器' $false $_.Exception.Message
      $result.errors += ("卸载器执行失败: " + $_.Exception.Message)
    }
  }
} else {
  Add-Step '调用卸载器' $false '没有可用的卸载命令'
}

# ── 3. 清理 ARP 注册表键 ──────────────────────────────────────────
# 三根都要看：64 位、32 位（WOW6432Node）、当前用户。
$arpRoots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)
$arpRemoved = @()
foreach ($root in $arpRoots) {
  if (-not (Test-Path $root)) { continue }
  foreach ($key in @(Get-ChildItem $root -ErrorAction SilentlyContinue)) {
    $props = Get-ItemProperty $key.PSPath -ErrorAction SilentlyContinue
    if (-not $props) { continue }
    $dn = [string]$props.DisplayName
    if ([string]::IsNullOrWhiteSpace($dn)) { continue }

    $match = $false
    if ($name -and $dn -eq $name) { $match = $true }
    # DisplayName 常带版本号后缀（"Upscayl 2.15.0"），去掉再比
    if (-not $match -and $name -and ($dn -replace '\s+v?\d[\d.]*$', '') -eq $name) { $match = $true }
    if (-not $match -and $location -and $props.InstallLocation) {
      $il = ([string]$props.InstallLocation).Trim().Trim('"').TrimEnd('\')
      if ($il -and $il -eq $location.TrimEnd('\')) { $match = $true }
    }
    if (-not $match) { continue }

    if ($dry) {
      $arpRemoved += $dn
      continue
    }
    try {
      Remove-Item -LiteralPath $key.PSPath -Recurse -Force -ErrorAction Stop
      $arpRemoved += $dn
    } catch {
      $result.errors += ("删除注册表项 {0} 失败: {1}" -f $dn, $_.Exception.Message)
    }
  }
}
Add-Step '清理卸载注册表项' ($arpRemoved.Count -gt 0) ($arpRemoved -join ' | ')

# ── 4. 删残留目录 ─────────────────────────────────────────────────
# 只在目录里已经没有任何 exe 时才整目录删——还有 exe 说明程序可能还在用，
# 强行删会把用户正在用的软件弄坏。
$dirRemoved = ''
if ($location -and (Test-Path -LiteralPath $location)) {
  $exes = @(Get-ChildItem -LiteralPath $location -Filter '*.exe' -File -Recurse -Depth 2 -ErrorAction SilentlyContinue)
  if ($exes.Count -eq 0) {
    if ($dry) {
      $dirRemoved = $location
    } else {
      try {
        Remove-Item -LiteralPath $location -Recurse -Force -ErrorAction Stop
        $dirRemoved = $location
      } catch {
        $result.errors += ("删除目录失败: " + $_.Exception.Message)
      }
    }
  } else {
    $result.errors += ("目录里还有 {0} 个可执行文件，已保留：{1}" -f $exes.Count, $location)
  }
}
Add-Step '删除残留目录' ([bool]$dirRemoved) $dirRemoved

# ── 5. 清快捷方式 ─────────────────────────────────────────────────
$lnks = @()
if ($name) {
  $dirs = @(
    (Join-Path $env:APPDATA 'Microsoft\Windows\Start Menu\Programs'),
    (Join-Path $env:ProgramData 'Microsoft\Windows\Start Menu\Programs'),
    ([Environment]::GetFolderPath('Desktop')),
    (Join-Path $env:PUBLIC 'Desktop')
  )
  foreach ($d in $dirs) {
    if (-not (Test-Path -LiteralPath $d)) { continue }
    $hits = @(Get-ChildItem -LiteralPath $d -Filter '*.lnk' -File -Recurse -Depth 3 -ErrorAction SilentlyContinue |
        Where-Object { $_.BaseName -eq $name -or $_.BaseName -like "$name *" })
    foreach ($h in $hits) {
      if ($dry) { $lnks += $h.FullName; continue }
      try { Remove-Item -LiteralPath $h.FullName -Force -ErrorAction Stop; $lnks += $h.FullName } catch { }
    }
  }
}
Add-Step '清理快捷方式' ($lnks.Count -gt 0) (($lnks | ForEach-Object { Split-Path -Leaf $_ }) -join ', ')

$result.removed = $arpRemoved.Count + $lnks.Count
$result.ok = ($result.errors.Count -eq 0 -or $arpRemoved.Count + $lnks.Count + $(if ($dirRemoved) { 1 } else { 0 }) -gt 0)
Write-Output ($result | ConvertTo-Json -Compress -Depth 5)
