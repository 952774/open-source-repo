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
    $dnNorm = ($_.DisplayName -replace '[^A-Za-z0-9\u4e00-\u9fff]', '').ToLower()
    $dnNorm -and $norm -and ($dnNorm -eq $norm -or $dnNorm.Contains($norm) -or $norm.Contains($dnNorm))
  })
}

# 下面要用 $dn 承载"命中条目的显示名"。必须先显式置空：
# Where-Object 的脚本块里赋值不会创建局部变量，而是直接落到当前作用域，
# 上面退化匹配里的临时变量一旦同名就会把最后一轮遍历的值漏出来
# （实测 TranslucentTB 会显示成"夸克"——那是 Get-ChildItem 扫到的最后一条 ARP 记录）。
$dn = $null

function Resolve-ExePath($entry) {
  # DisplayIcon 形如 "C:\path\app.exe,0"。
  # 但它不一定指向主程序：Git 的 DisplayIcon 指向 git-lfs.exe，
  # 所以先收集候选，最终由"文件名与应用名相似度"决定，而不是盲信 DisplayIcon。
  $pool = New-Object System.Collections.ArrayList
  if ($entry.DisplayIcon) {
    $raw = [string]$entry.DisplayIcon
    foreach ($seg in ($raw -split ',')) {
      $p = $seg.Trim().Trim('"')
      if ($p -and ($p -like '*.exe') -and (Test-Path -LiteralPath $p)) { [void]$pool.Add((Get-Item -LiteralPath $p)) }
    }
  }
  if ($entry.InstallLocation) {
    $loc = ([string]$entry.InstallLocation).Trim().Trim('"')
    if ($loc -and (Test-Path -LiteralPath $loc)) {
      $skip = '(?i)unins|setup|install[-_]|update|upgrade|crash|report|helper|vc_redist|elevate'
      $grab = {
        param($depth)
        @(Get-ChildItem -LiteralPath $loc -Filter *.exe -Recurse -Depth $depth -ErrorAction SilentlyContinue |
          Where-Object { $_.Name -notmatch $skip })
      }
      # 先浅搜（快）；浅搜里没有文件名能对上应用名的，再深搜
      # （Epic 这类主 exe 埋在 Launcher\Portal\Binaries\Win64 下，Depth 2 够不到）
      foreach ($depth in @(2, 4)) {
        $found = @(& $grab $depth)
        if ($found.Count -gt 0) {
          $before = $pool.Count
          foreach ($f in $found) { [void]$pool.Add($f) }
          # 浅搜阶段如果已经出现文件名命中，就不必再深搜
          $keys0 = @($name)
          if ($entry.DisplayName) { $keys0 += [string]$entry.DisplayName }
          $nk = @($keys0 | ForEach-Object { ($_ -replace '[^A-Za-z0-9]', '').ToLower() } | Where-Object { $_ })
          $hit = $false
          foreach ($f in $found) {
            $st = ($f.BaseName -replace '[^A-Za-z0-9]', '').ToLower()
            foreach ($k in $nk) { if ($st -and $k -and ($st -eq $k -or $st -like "$k*" -or $k -like "$st*")) { $hit = $true } }
          }
          if ($hit -or $pool.Count -gt $before + 40) { break }
        }
      }
    }
  }
  if ($pool.Count -eq 0) { return $null }

  # 用应用名、显示名、安装目录名三路归一化后与文件名比对
  $keys = @($name)
  if ($entry.DisplayName) { $keys += [string]$entry.DisplayName }
  if ($entry.InstallLocation) { $keys += (Split-Path -Leaf ([string]$entry.InstallLocation).Trim().Trim('"')) }
  $normKeys = @($keys | ForEach-Object { ($_ -replace '[^A-Za-z0-9]', '').ToLower() } | Where-Object { $_ })
  # 明确的主程序名（如 code / git / obsidian 这类短名）加分项
  $best = $null
  $bestScore = -1
  foreach ($c in $pool) {
    $stem = ($c.BaseName -replace '[^A-Za-z0-9]', '').ToLower()
    if (-not $stem) { continue }
    $score = 0
    foreach ($k in $normKeys) {
      if ($stem -eq $k) { if ($score -lt 100) { $score = 100 } }
      elseif ($k -like "$stem*" -or $stem -like "$k*") { if ($score -lt 80) { $score = 80 } }
      elseif ($k.Contains($stem) -or $stem.Contains($k)) { if ($score -lt 60) { $score = 60 } }
    }
    # 带附属后缀的明显不是主程序
    if ($c.BaseName -match '(?i)lfs|daemon|service|cli|console|crashpad|updater|unins') { $score -= 40 }
    if ($score -gt $bestScore -or ($score -eq $bestScore -and $best -and $c.Length -gt $best.Length)) {
      $best = $c
      $bestScore = $score
    }
  }
  if ($best) { return $best.FullName }
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

# 4) AppX / MSIX 兜底
# winget 里 installer type 为 msix 的包（TranslucentTB、Windows Terminal 的 Store 版等）
# 根本不写 ARP 三根注册表，它们归 AppX 部署服务管，只能用 Get-AppxPackage 查。
# 这类包也没有"可以直接 spawn 的 exe"——文件在 WindowsApps 下受保护目录里，
# 唯一正确的启动方式是 shell:AppsFolder\<PackageFamilyName>!<ApplicationId>。
$launchUri = $null
$appxFull = $null
$loc = $null
if (-not $found) {
  $appxAll = @(Get-AppxPackage -ErrorAction SilentlyContinue)
  $cand = @($appxAll | Where-Object {
      $n = [string]$_.Name
      $n -and ($n -ilike "*$name*" -or $name -ilike "*$n*")
    })
  if ($cand.Count -eq 0) {
    # 退化：去掉空格标点再比（"Windows Terminal" vs "Microsoft.WindowsTerminal"）
    $normA = ($name -replace '[^A-Za-z0-9]', '').ToLower()
    if ($normA) {
      $cand = @($appxAll | Where-Object {
          $n = ([string]$_.Name -replace '[^A-Za-z0-9]', '').ToLower()
          $n -and ($n -eq $normA -or $n.Contains($normA) -or $normA.Contains($n))
        })
    }
  }
  if ($cand.Count -gt 0) {
    # 同一个包常有多个架构/版本并存，取版本最高的那个
    $pkg = @($cand | Sort-Object -Property Version -Descending)[0]
    $appId = $null
    $manifest = Join-Path $pkg.InstallLocation 'AppxManifest.xml'
    if (Test-Path -LiteralPath $manifest) {
      $xml = Get-Content -LiteralPath $manifest -Raw -Encoding UTF8 -ErrorAction SilentlyContinue
      if ($xml -match '<Application\s[^>]*Id="([^"]+)"') { $appId = $Matches[1] }
    }
    if (-not $appId) { $appId = 'App' }
    $pfn = [string]$pkg.PackageFamilyName
    if ($pfn) {
      $launchUri = "shell:AppsFolder\$pfn!$appId"
      $appxFull = $pfn
      $src = 'appx'
      $dn = [string]$pkg.Name
      if ($pkg.InstallLocation) { $loc = [string]$pkg.InstallLocation }
    }
  }
}

if (-not $dn -and $hits.Count -gt 0) { $dn = [string]$hits[0].DisplayName }

$workdir = $null
if ($found) { $workdir = Split-Path -Parent $found }

# 注册表里的 InstallLocation 是判断"实际装到哪了"的唯一可靠来源。
# 很多 MSI 静默忽略 winget 的 --location 却仍返回 0，
# 所以安装后必须回读这个值再和用户选的目标目录比对。
# 注意不能无条件置空：AppX 分支已经写好了 $loc，这里再清一次会把结果丢掉。
if (-not $loc) {
  foreach ($e in $hits) {
    if ($e.InstallLocation) {
      $cand = ([string]$e.InstallLocation).Trim().Trim('"')
      if ($cand -and (Test-Path -LiteralPath $cand)) { $loc = $cand; break }
    }
  }
}
if (-not $loc -and $found) { $loc = $workdir }

# 残留判定：注册表里有这个软件的条目，但主程序文件已经不在了。
# 典型成因是安装器崩溃、用户手动删目录、或卸载程序自身丢失（0x800401f5），
# 此时 winget list 仍会把它列为"已安装"，点打开必然失败——必须给出可操作的处置。
# AppX 包拿到 launchUri 就不算残留：它本来就没有可以直接 spawn 的 exe。
$stale = ($hits.Count -gt 0 -and -not $found -and -not $launchUri)

$uninst = $null
foreach ($e in $hits) {
  if ($e.UninstallString) { $uninst = ([string]$e.UninstallString).Trim(); break }
}

$obj = [ordered]@{
  exe             = $found
  workdir         = $workdir
  displayName     = $dn
  installLocation = $loc
  uninstallString = $uninst
  # AppX/MSIX 包专用：没有 exe，靠这个 shell URI 启动
  launchUri       = $launchUri
  packageFamily   = $appxFull
  stale           = $stale
  matches         = $hits.Count
  source          = $src
}
Write-Output ($obj | ConvertTo-Json -Compress)
