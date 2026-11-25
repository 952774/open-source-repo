# ToolArk 本机软件扫描脚本
# 输出：JSON 数组，每项一个"系统里真实存在的程序"
#   {"name","version","publisher","installLocation","exe","homepage","uninstallString","scope","stale"}
#
# 数据来源只用注册表 Uninstall 三根（ARP）+ App Paths：
# 这是"控制面板里能看到什么"的同一份真相，比遍历 Program Files 更准，
# 也不会把一堆 VC 运行库 DLL 目录误当软件。
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$roots = @(
  @{ Path = 'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; Scope = 'machine' },
  @{ Path = 'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall'; Scope = 'machine-x86' },
  @{ Path = 'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'; Scope = 'user' }
)

# 这些不是"用户会打开的软件"，扫进来只会污染列表
$skipName = '(?i)^(Update for |Security Update for |Hotfix for |KB\d{6,}|Microsoft Visual C\+\+ \d{4} Redistributable|Microsoft \.NET|Microsoft Edge Update|Microsoft Update Health Tools|Windows Software Development Kit|Windows SDK|Microsoft Windows Desktop Runtime|Microsoft ASP\.NET Core|Microsoft\.NET Runtime)'
$skipFlags = @('SystemComponent', 'ParentKeyName', 'NoDisplay', 'ReleaseType')

function Get-ExeFromIcon($icon) {
  if (-not $icon) { return $null }
  foreach ($seg in ([string]$icon -split ',')) {
    $p = $seg.Trim().Trim('"')
    if ($p -and ($p -like '*.exe') -and (Test-Path -LiteralPath $p)) { return $p }
  }
  return $null
}

# 从 UninstallString 里取出卸载器可执行文件的路径。
# 关键点：MsiExec.exe 型条目（/X{GUID}）没有磁盘路径可查，由 Windows Installer
# 自己维护产品数据库，不能因为 DisplayIcon 缺失就当成残留——那会误报一大片
# VC++ 运行库和系统组件。
function Get-UninstallerPath($cmd) {
  if (-not $cmd) { return $null }
  $s = ([string]$cmd).Trim()
  if (-not $s) { return $null }
  if ($s -match '(?i)^"?%?SystemRoot%?\\?System32\\msiexec') { return 'msi' }
  if ($s -match '(?i)^"?msiexec') { return 'msi' }
  # 带引号：取第一段
  if ($s.StartsWith('"')) {
    $end = $s.IndexOf('"', 1)
    if ($end -gt 1) { return $s.Substring(1, $end - 1) }
  }
  # 不带引号：取到第一个 .exe 为止
  $m = [regex]::Match($s, '(?i)^(.*?\.exe)(\s|$)')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

$out = New-Object System.Collections.ArrayList
$seen = New-Object System.Collections.Generic.HashSet[string]

foreach ($r in $roots) {
  if (-not (Test-Path $r.Path)) { continue }
  foreach ($k in Get-ChildItem -Path $r.Path -ErrorAction SilentlyContinue) {
    $p = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
    if (-not $p -or -not $p.DisplayName) { continue }

    $name = ([string]$p.DisplayName).Trim()
    if (-not $name -or $name -match $skipName) { continue }

    # SystemComponent=1 / 有 ParentKeyName / ReleaseType=Update 的都是补丁或子组件
    $bad = $false
    if ($p.SystemComponent -eq 1) { $bad = $true }
    if ($p.ParentKeyName) { $bad = $true }
    if ($p.ReleaseType) { $bad = $true }
    if ($bad) { continue }

    $exe = Get-ExeFromIcon $p.DisplayIcon
    $loc = $null
    if ($p.InstallLocation) {
      $cand = ([string]$p.InstallLocation).Trim().Trim('"')
      if ($cand -and (Test-Path -LiteralPath $cand)) { $loc = $cand }
    }
    if (-not $loc -and $exe) { $loc = Split-Path -Parent $exe }

    # 残留判定：程序文件找不到，且卸载器也确认已从磁盘消失。
    # 只有「明确证明卸载器文件不在了」才敢标 stale——MsiExec 型条目没有磁盘路径，
    # 由 Windows Installer 数据库维护，永远不算残留。
    $uninstExe = Get-UninstallerPath $p.UninstallString
    $uninstMissing = $false
    if ($uninstExe -and $uninstExe -ne 'msi') {
      if (-not (Test-Path -LiteralPath $uninstExe)) { $uninstMissing = $true }
    }
    $isStale = [bool]((-not $exe) -and (-not $loc) -and $uninstMissing)

    # 去重：同名同版本只留一条（x86/x64 双注册很常见）
    $key = ($name.ToLower() + '|' + ([string]$p.DisplayVersion))
    if (-not $seen.Add($key)) { continue }

    $obj = [ordered]@{
      name            = $name
      version         = [string]$p.DisplayVersion
      publisher       = [string]$p.Publisher
      installLocation = $loc
      exe             = $exe
      homepage        = [string]$p.URLInfoAbout
      uninstallString = [string]$p.UninstallString
      scope           = $r.Scope
      stale           = $isStale
    }
    [void]$out.Add($obj)
  }
}

# App Paths 里还有一批没写 Uninstall 条目的（绿色版、开发者工具链）
foreach ($ap in @('HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
                  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths')) {
  if (-not (Test-Path $ap)) { continue }
  foreach ($k in Get-ChildItem -Path $ap -ErrorAction SilentlyContinue) {
    $p = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
    $cand = $null
    if ($p.'(default)') { $cand = [string]$p.'(default)' }
    elseif ($p.Path) { $cand = [string]$p.Path }
    if (-not $cand) { continue }
    $cand = $cand.Trim().Trim('"')
    if (-not (Test-Path -LiteralPath $cand)) { continue }
    $name = [System.IO.Path]::GetFileNameWithoutExtension($k.PSChildName)
    if (-not $name) { continue }
    $key = $name.ToLower() + '|'
    if ($seen.Contains($key)) { continue }
    # 已经有 ARP 条目的同名软件不重复登记
    $dup = $false
    foreach ($e in $out) { if ($e.name -ieq $name) { $dup = $true; break } }
    if ($dup) { continue }
    [void]$seen.Add($key)
    [void]$out.Add([ordered]@{
      name            = $name
      version         = ''
      publisher       = ''
      installLocation = (Split-Path -Parent $cand)
      exe             = $cand
      homepage        = ''
      uninstallString = ''
      scope           = 'app-paths'
      stale           = $false
    })
  }
}

Write-Output (ConvertTo-Json -InputObject @($out) -Depth 4 -Compress)
