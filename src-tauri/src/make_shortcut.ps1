# ToolArk 桌面快捷方式创建脚本
# 输入（环境变量）：
#   TOOLARK_TARGET   目标 exe 完整路径
#   TOOLARK_LNKNAME  快捷方式显示名（不含 .lnk）
#   TOOLARK_WORKDIR  起始位置（可空）
# 输出：单行 JSON {"ok":true,"path":"C:\\Users\\...\\Desktop\\X.lnk"}
$ErrorActionPreference = 'Stop'
$ProgressPreference = 'SilentlyContinue'

$target = $env:TOOLARK_TARGET
$lnkName = $env:TOOLARK_LNKNAME
$workdir = $env:TOOLARK_WORKDIR

function Out-Json($ok, $path, $err) {
  $o = [ordered]@{ ok = $ok; path = $path; error = $err }
  Write-Output ($o | ConvertTo-Json -Compress)
}

if ([string]::IsNullOrWhiteSpace($target) -or -not (Test-Path -LiteralPath $target)) {
  Out-Json $false $null '目标程序不存在'
  exit 0
}
if ([string]::IsNullOrWhiteSpace($lnkName)) { $lnkName = [System.IO.Path]::GetFileNameWithoutExtension($target) }

# 快捷方式名里不能出现这些字符
$lnkName = ($lnkName -replace '[\\/:*?"<>|]', '_').Trim()
if ([string]::IsNullOrWhiteSpace($lnkName)) { $lnkName = 'ToolArk App' }

$desktop = [Environment]::GetFolderPath('Desktop')
if ([string]::IsNullOrWhiteSpace($desktop) -or -not (Test-Path -LiteralPath $desktop)) {
  Out-Json $false $null '无法定位桌面目录'
  exit 0
}

$lnkPath = Join-Path $desktop ($lnkName + '.lnk')
try {
  $shell = New-Object -ComObject WScript.Shell
  $sc = $shell.CreateShortcut($lnkPath)
  $sc.TargetPath = $target
  if (-not [string]::IsNullOrWhiteSpace($workdir) -and (Test-Path -LiteralPath $workdir)) {
    $sc.WorkingDirectory = $workdir
  } else {
    $sc.WorkingDirectory = Split-Path -Parent $target
  }
  $sc.IconLocation = $target + ',0'
  $sc.Description = $lnkName
  $sc.WindowStyle = 1
  $sc.Save()
  Out-Json $true $lnkPath $null
} catch {
  Out-Json $false $null $_.Exception.Message
}
