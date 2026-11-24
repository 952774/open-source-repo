#!/usr/bin/env bash
# 一键配置 Tauri updater 的 GitHub Releases 更新源
# 用法：bash scripts/configure-updater.sh <你的GitHub用户名/仓库名>
set -e

REPO="$1"
if [ -z "$REPO" ]; then
  echo "用法: bash scripts/configure-updater.sh <用户名/仓库名>"
  echo "示例: bash scripts/configure-updater.sh zhangsan/toolark"
  exit 1
fi

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
CONFIG="$ROOT/src-tauri/tauri.conf.json"
URL="https://github.com/$REPO/releases/latest/download/latest.json"

python - "$CONFIG" "$URL" <<'PY'
import json, sys
path, url = sys.argv[1], sys.argv[2]
with open(path, encoding="utf-8") as f:
    cfg = json.load(f)
cfg["plugins"]["updater"]["endpoints"] = [url]
with open(path, "w", encoding="utf-8") as f:
    json.dump(cfg, f, ensure_ascii=False, indent=2)
    f.write("\n")
print("已设置更新源:", url)
PY

echo ""
echo "下一步："
echo "1. 重新打包: bash scripts/build-desktop.sh"
echo "2. 生成清单: python scripts/make-latest-json.py --repo $REPO"
echo "3. 在 GitHub 创建 Release，上传 msi / .sig / latest.json"
