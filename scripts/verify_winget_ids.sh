#!/usr/bin/env bash
# 批量验证 winget ID 是否存在（ToolArk 清单准入门槛）
IDS=(
"Neovim.Neovim" "Helix.Editor" "GitHub.cli" "dandavison.delta" "sharkdp.bat"
"eza-community.eza" "jqlang.jq" "Microsoft.PowerShell" "astral-sh.uv" "jj-vcs.jj"
"denoland.deno" "Rufus.Rufus" "Ventoy.Ventoy" "ShareX.ShareX" "FilesCommunity.Files"
"hluk.CopyQ" "M2Team.NanaZip" "zhongyang219.TrafficMonitor" "CrystalDewWorld.CrystalDiskInfo"
"ONLYOFFICE.DesktopEditors" "logseq.Logseq" "Calibre.Calibre" "JGraph.Draw"
"mifi.LosslessCut" "Upscayl.Upscayl" "Kodi.Kodi" "yt-dlp.yt-dlp"
"RustDesk.RustDesk" "LocalSend.LocalSend" "Insecure.Nmap" "PuTTY.PuTTY"
"Cryptomator.Cryptomator" "GnuPG.GnuPG" "FreeTube.FreeTube" "Stellarium.Stellarium"
"Motrix.Motrix" "PeaZip.PeaZip" "mkvtoolnix.mkvtoolnix" "Neovide.Neovide"
)
for id in "${IDS[@]}"; do
  if winget show --id "$id" --exact --source winget --accept-source-agreements --disable-interactivity >/dev/null 2>&1; then
    echo "OK   $id"
  else
    echo "FAIL $id"
  fi
done
