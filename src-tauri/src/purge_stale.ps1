# ToolArk 安装残留清理脚本
# 输入（环境变量）：
#   TOOLARK_NAME        要清理的软件显示名（精确或包含匹配）
#   TOOLARK_DRYRUN      1 = 只报告不删除
# 输出：单行 JSON {"removed":n,"keys":[...],"dirs":[...],"errors":[...]}
#
# 只删注册表 Uninstall 条目和"确认已无主程序"的空目录，
# 绝不递归删有内容的目录——宁可留下垃圾，也不能误删用户文件。
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$name = $env:TOOLARK_NAME
$dry = ($env:TOOLARK_DRYRUN -eq '1')
$result = [ordered]@{ removed = 0; keys = @(); dirs = @(); errors = @() }
if ([string]::IsNullOrWhiteSpace($name)) {
  $result.errors += 'no-name'
  Write-Output ($result | ConvertTo-Json -Compress)
  exit 0
}

$roots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)

$removedKeys = New-Object System.Collections.ArrayList
$dirsToTry = New-Object System.Collections.ArrayList

# 从 UninstallString 里取出卸载器路径；MsiExec 型返回 'msi'。
# 这类条目没有磁盘路径，产品数据库由 Windows Installer 维护，
# 绝不能因为 DisplayIcon 缺失就判定为残留并删掉——否则会误删
# VC++ 运行库、GameInput、XNA 这类系统组件。
function Get-UninstallerPath($cmd) {
  if (-not $cmd) { return $null }
  $s = ([string]$cmd).Trim()
  if (-not $s) { return $null }
  if ($s -match '(?i)^"?%?SystemRoot%?\\?System32\\msiexec') { return 'msi' }
  if ($s -match '(?i)^"?msiexec') { return 'msi' }
  if ($s.StartsWith('"')) {
    $end = $s.IndexOf('"', 1)
    if ($end -gt 1) { return $s.Substring(1, $end - 1) }
  }
  $m = [regex]::Match($s, '(?i)^(.*?\.exe)(\s|$)')
  if ($m.Success) { return $m.Groups[1].Value }
  return $null
}

foreach ($r in $roots) {
  if (-not (Test-Path $r)) { continue }
  foreach ($k in Get-ChildItem -Path $r -ErrorAction SilentlyContinue) {
    $p = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
    if (-not $p -or -not $p.DisplayName) { continue }
    $dn = ([string]$p.DisplayName).Trim()
    # 精确或前缀匹配（"Upscayl 2.15.0" 用 "Upscayl" 也能命中）
    if (-not ($dn -ieq $name -or $dn -ilike "$name*" -or $dn -ilike "*$name*")) { continue }

    # 还有主程序在，就不算残留，不动它
    $icon = $null
    if ($p.DisplayIcon) {
      foreach ($seg in ([string]$p.DisplayIcon -split ',')) {
        $cand = $seg.Trim().Trim('"')
        if ($cand -and ($cand -like '*.exe') -and (Test-Path -LiteralPath $cand)) { $icon = $cand; break }
      }
    }
    if ($icon) { continue }

    # 卸载器还在磁盘上 = 用户仍能正常卸载，不归我们管
    $uninstExe = Get-UninstallerPath $p.UninstallString
    if ($uninstExe -eq 'msi') { continue }
    if ($uninstExe -and (Test-Path -LiteralPath $uninstExe)) { continue }

    # 到这里才算真残留：没有程序文件、没有可用卸载器
    if ($p.InstallLocation) {
      $loc = ([string]$p.InstallLocation).Trim().Trim('"')
      if ($loc -and (Test-Path -LiteralPath $loc)) { [void]$dirsToTry.Add($loc) }
    }

    [void]$removedKeys.Add([ordered]@{ path = $k.PSPath; name = $dn })
    if (-not $dry) {
      try {
        Remove-Item -Path $k.PSPath -Recurse -Force -ErrorAction Stop
        $result.removed = [int]$result.removed + 1
      } catch {
        $result.errors += ("删除 {0} 失败: {1}" -f $dn, $_.Exception.Message)
      }
    } else {
      $result.removed = [int]$result.removed + 1
    }
  }
}
$result.keys = @($removedKeys | ForEach-Object { $_.name })

# 目录只在"里面没有 exe/dll 等可执行内容"时才删，避免误删用户放进去的文件
foreach ($d in $dirsToTry) {
  if (-not (Test-Path -LiteralPath $d)) { continue }
  $exeLeft = @(Get-ChildItem -LiteralPath $d -Filter *.exe -Recurse -Depth 2 -ErrorAction SilentlyContinue)
  if ($exeLeft.Count -gt 0) { continue }
  if (-not $dry) {
    try {
      Remove-Item -LiteralPath $d -Recurse -Force -ErrorAction Stop
      $result.dirs += $d
    } catch {
      $result.errors += ("删除目录 {0} 失败: {1}" -f $d, $_.Exception.Message)
    }
  } else {
    $result.dirs += $d
  }
}

Write-Output ($result | ConvertTo-Json -Compress)
