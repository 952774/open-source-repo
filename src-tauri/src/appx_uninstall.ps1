# ToolArk AppX / MSIX 卸载
# 输入（环境变量）：
#   TOOLARK_NAME      显示名，用于模糊匹配包名
#   TOOLARK_PACKAGE   PackageFamilyName（优先，精确）
#   TOOLARK_DRY       1 = 只报告不执行
# 输出：单行 JSON {"ok":bool,"removed":n,"names":[...],"errors":[...]}
#
# 为什么需要这个脚本：
# winget 里 installer type 为 msix 的包（TranslucentTB、Store 版 Windows Terminal 等）
# 不走 ARP 卸载流程，它们的卸载器是 AppX 部署服务。winget uninstall 失败时
# 报的是 0x800401f5 Application not found，看着像"安装器丢失"，
# 实际是找错了地方——ARP 里根本没有这个条目，purge_stale 自然也清不掉。
# 正确做法是 Get-AppxPackage + Remove-AppxPackage。
$ErrorActionPreference = 'SilentlyContinue'
$ProgressPreference = 'SilentlyContinue'

$name = [string]$env:TOOLARK_NAME
$family = [string]$env:TOOLARK_PACKAGE
$dry = ([string]$env:TOOLARK_DRY) -eq '1'

$result = [ordered]@{
  ok      = $false
  dry     = $dry
  removed = 0
  names   = @()
  errors  = @()
}

if ([string]::IsNullOrWhiteSpace($name) -and [string]::IsNullOrWhiteSpace($family)) {
  $result.errors += 'no-target'
  Write-Output ($result | ConvertTo-Json -Compress -Depth 5)
  exit 0
}

$all = @(Get-AppxPackage -ErrorAction SilentlyContinue)

$targets = @()
if ($family) {
  $targets = @($all | Where-Object { [string]$_.PackageFamilyName -eq $family })
}
if ($targets.Count -eq 0 -and $name) {
  $targets = @($all | Where-Object {
      $n = [string]$_.Name
      $n -and ($n -ilike "*$name*" -or $name -ilike "*$n*")
    })
}
if ($targets.Count -eq 0 -and $name) {
  # 退化匹配：去空格标点后比较（"Windows Terminal" vs "Microsoft.WindowsTerminal"）
  $norm = ($name -replace '[^A-Za-z0-9]', '').ToLower()
  if ($norm) {
    $targets = @($all | Where-Object {
        $n = ([string]$_.Name -replace '[^A-Za-z0-9]', '').ToLower()
        $n -and ($n -eq $norm -or $n.Contains($norm) -or $norm.Contains($n))
      })
  }
}

if ($targets.Count -eq 0) {
  $result.errors += 'not-found'
  Write-Output ($result | ConvertTo-Json -Compress -Depth 5)
  exit 0
}

foreach ($p in $targets) {
  $full = [string]$p.PackageFullName
  if ($dry) {
    $result.names += $full
    continue
  }
  try {
    Remove-AppxPackage -Package $full -ErrorAction Stop
    $result.names += $full
    $result.removed++
  } catch {
    $result.errors += ("移除 {0} 失败: {1}" -f $full, $_.Exception.Message)
  }
}

$result.ok = ($result.removed -gt 0 -or ($dry -and $result.names.Count -gt 0))
Write-Output ($result | ConvertTo-Json -Compress -Depth 5)
