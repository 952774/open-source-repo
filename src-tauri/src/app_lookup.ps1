# ToolArk 应用定位脚本
# 输入（环境变量）：TOOLARK_NAME  要查找的应用显示名（可模糊）
# 输出：单行 JSON {"exe": "...", "workdir": "...", "displayName": "...", "source": "..."}
# 找不到时 exe 为 null。
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$name = $env:TOOLARK_NAME
if ([string]::IsNullOrWhiteSpace($name)) {
  Write-Output '{"exe":null,"workdir":null,"displayName":null,"source":"no-name"}'
  exit 0
}

$roots = @(
  'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKLM:\SOFTWARE\WOW6432Node\Microsoft\Windows\CurrentVersion\Uninstall',
  'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\Uninstall'
)

$entries = New-Object System.Collections.ArrayList
foreach ($r in $roots) {
  if (-not (Test-Path $r)) { continue }
  foreach ($k in Get-ChildItem -Path $r -ErrorAction SilentlyContinue) {
    $p = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
    if ($p -and $p.DisplayName) { [void]$entries.Add($p) }
  }
}

$exact = @($entries | Where-Object { $_.DisplayName -ieq $name })
$hits  = $exact
if ($hits.Count -eq 0) {
  $hits = @($entries | Where-Object {
    $_.DisplayName -ilike "*$name*" -or $name -ilike "*$($_.DisplayName)*"
  })
}
if ($hits.Count -eq 0) {
  # 退化匹配：去掉空格与标点后比较，应对 "Visual Studio Code" vs "VisualStudioCode"
  $norm = ($name -replace '[^A-Za-z0-9\u4e00-\u9fff]', '').ToLower()
  $hits = @($entries | Where-Object {
    $dn = ($_.DisplayName -replace '[^A-Za-z0-9\u4e00-\u9fff]', '').ToLower()
    $dn -and $norm -and ($dn -eq $norm -or $dn.Contains($norm) -or $norm.Contains($dn))
  })
}

function Resolve-ExePath($entry) {
  # 1) DisplayIcon 最准，形如 "C:\path\app.exe,0"
  if ($entry.DisplayIcon) {
    $raw = [string]$entry.DisplayIcon
    $p = ($raw -split ',')[0].Trim().Trim('"')
    if ($p -and (Test-Path -LiteralPath $p) -and ($p -like '*.exe')) { return $p }
  }
  # 2) InstallLocation 下按体积挑主程序，排除卸载/更新/崩溃上报类
  if ($entry.InstallLocation) {
    $loc = ([string]$entry.InstallLocation).Trim().Trim('"')
    if ($loc -and (Test-Path -LiteralPath $loc)) {
      $cands = @(Get-ChildItem -LiteralPath $loc -Filter *.exe -Recurse -Depth 2 -ErrorAction SilentlyContinue |
        Where-Object { $_.Name -notmatch '(?i)unins|setup|install|update|upgrade|crash|report|helper|vc_redist|elevate' } |
        Sort-Object -Property Length -Descending)
      if ($cands.Count -gt 0) { return $cands[0].FullName }
    }
  }
  return $null
}

$found = $null
$src = $null
foreach ($e in $hits) {
  $exe = Resolve-ExePath $e
  if ($exe) { $found = $exe; $src = 'uninstall-key'; break }
}

# 3) 最后尝试 App Paths（很多安装器会写这里）
if (-not $found) {
  $appPaths = @(
    'HKLM:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths',
    'HKCU:\SOFTWARE\Microsoft\Windows\CurrentVersion\App Paths'
  )
  foreach ($ap in $appPaths) {
    if (-not (Test-Path $ap)) { continue }
    foreach ($k in Get-ChildItem -Path $ap -ErrorAction SilentlyContinue) {
      $leaf = [System.IO.Path]::GetFileNameWithoutExtension($k.PSChildName)
      if ($leaf -and ($leaf -ilike "*$name*" -or $name -ilike "*$leaf*")) {
        $p = Get-ItemProperty -Path $k.PSPath -ErrorAction SilentlyContinue
        $cand = $null
        if ($p.'(default)') { $cand = [string]$p.'(default)' }
        elseif ($p.Path) { $cand = [string]$p.Path }
        if ($cand) {
          $cand = $cand.Trim().Trim('"')
          if ((Test-Path -LiteralPath $cand) -and ($cand -like '*.exe')) {
            $found = $cand; $src = 'app-paths'; break
          }
        }
      }
    }
    if ($found) { break }
  }
}

$dn = $null
if ($hits.Count -gt 0) { $dn = [string]$hits[0].DisplayName }

$workdir = $null
if ($found) { $workdir = Split-Path -Parent $found }

$obj = [ordered]@{
  exe         = $found
  workdir     = $workdir
  displayName = $dn
  source      = $src
}
Write-Output ($obj | ConvertTo-Json -Compress)
