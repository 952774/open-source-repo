# ToolArk 安装包体积探测
# 输入（环境变量）：TOOLARK_WINGET_ID
# 输出：单行 JSON {"ok":bool,"bytes":n,"url":"...","note":"..."}
#
# 为什么不能直接读 winget 的输出：
# `winget show` 只有"安装程序 URL"，没有体积字段。manifest 里虽然有
# InstallerSha256，但没有 Size。所以只能对安装器 URL 发 HEAD 取
# Content-Length——这也正好是用户真正要下载的字节数。
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$pkgId = [string]$env:TOOLARK_WINGET_ID
$result = [ordered]@{ ok = $false; bytes = 0; url = ''; note = '' }

if ([string]::IsNullOrWhiteSpace($pkgId)) {
  $result.note = 'no-id'
  Write-Output ($result | ConvertTo-Json -Compress)
  exit 0
}

$winget = $null
foreach ($c in @(
    (Join-Path $env:LOCALAPPDATA 'Microsoft\WindowsApps\winget.exe'),
    (Join-Path $env:ProgramFiles 'WindowsApps\winget.exe')
  )) {
  if (Test-Path -LiteralPath $c) { $winget = $c; break }
}
if (-not $winget) { $winget = 'winget.exe' }

$show = & $winget show --id $pkgId --exact --source winget --disable-interactivity 2>$null
if (-not $show) {
  $result.note = 'show-failed'
  Write-Output ($result | ConvertTo-Json -Compress)
  exit 0
}

# 中英文两套标签都认：安装程序 URL / Installer Url
$url = ''
foreach ($line in $show) {
  if ($line -match '(安装程序\s*URL|Installer\s*Url)\s*[:：]\s*(\S+)') {
    $url = $Matches[2].Trim()
    break
  }
}
if (-not $url) {
  $result.note = 'no-url'
  Write-Output ($result | ConvertTo-Json -Compress)
  exit 0
}
$result.url = $url

# 本地已有缓存包时直接读文件大小，省一次网络往返
$cacheRoot = Join-Path $env:LOCALAPPDATA 'Packages\Microsoft.DesktopAppInstaller_8wekyb3d8bbwe\LocalState\Temp'
if (Test-Path -LiteralPath $cacheRoot) {
  $leaf = Split-Path -Leaf ([uri]$url).AbsolutePath
  $hit = Get-ChildItem -LiteralPath $cacheRoot -Recurse -Filter $leaf -File -ErrorAction SilentlyContinue |
    Select-Object -First 1
  if ($hit) {
    $result.bytes = [long]$hit.Length
    $result.ok = $true
    $result.note = 'cache'
    Write-Output ($result | ConvertTo-Json -Compress)
    exit 0
  }
}

# HEAD 取 Content-Length；部分 CDN 不支持 HEAD，退回带 Range 的 GET
try {
  $r = Invoke-WebRequest -Uri $url -Method Head -MaximumRedirection 8 -TimeoutSec 15 `
    -UseBasicParsing -ErrorAction Stop
  $len = $r.Headers['Content-Length']
  if ($len) {
    $result.bytes = [long]$len
    $result.ok = $true
    $result.note = 'head'
  }
} catch {
  $result.note = 'head-failed'
}

if (-not $result.ok) {
  try {
    $r2 = Invoke-WebRequest -Uri $url -Method Get -Headers @{ Range = 'bytes=0-0' } `
      -MaximumRedirection 8 -TimeoutSec 15 -UseBasicParsing -ErrorAction Stop
    $cr = [string]$r2.Headers['Content-Range']
    if ($cr -match '/(\d+)$') {
      $result.bytes = [long]$Matches[1]
      $result.ok = $true
      $result.note = 'range'
    }
  } catch {
    if (-not $result.note) { $result.note = 'range-failed' }
  }
}

Write-Output ($result | ConvertTo-Json -Compress)
