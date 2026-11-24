#!/usr/bin/env bash
# ToolArk 桌面版编译（Git Bash 环境）
# 解决：1) Git Bash 自带 link 抢先 2) MSVC 需要 LIB/INCLUDE 指向 Windows SDK
set -e

TOOLARK_DIR="$(cd "$(dirname "$0")/.." && pwd)"
MSVC_BASE="/c/Program Files (x86)/Microsoft Visual Studio/2022/BuildTools/VC/Tools/MSVC"
SDK_BASE="/c/Program Files (x86)/Windows Kits/10"

# 找 MSVC 版本目录
MSVC_VER=$(ls "$MSVC_BASE" 2>/dev/null | sort -V | tail -1)
if [ -z "$MSVC_VER" ]; then echo "ERROR: 未找到 MSVC 工具链，请先装 VS Build Tools (VCTools)"; exit 1; fi
MSVC_BIN="$MSVC_BASE/$MSVC_VER/bin/Hostx64/x64"

# 找 Windows SDK 版本目录
SDK_VER=$(ls "$SDK_BASE/Lib" 2>/dev/null | sort -V | tail -1)
if [ -z "$SDK_VER" ]; then echo "ERROR: 未找到 Windows SDK Lib，SDK 可能还在安装中"; exit 1; fi

# 检查 kernel32.Lib 是否就位（SDK 装完的标志）
if [ ! -f "$SDK_BASE/Lib/$SDK_VER/um/x64/kernel32.Lib" ]; then
  echo "ERROR: kernel32.Lib 未就位（SDK 下载中？），路径: $SDK_BASE/Lib/$SDK_VER/um/x64/kernel32.Lib"
  exit 1
fi

echo "MSVC: $MSVC_VER"
echo "Windows SDK: $SDK_VER"

# 关键：MSVC bin 置顶，覆盖 Git Bash 的 link
export PATH="$MSVC_BIN:$HOME/.cargo/bin:$PATH"

# MSVC 需要这些环境变量才能找到 SDK 的库与头文件
SDK_WIN=$(cygpath -w "$SDK_BASE")
export LIB="$(cygpath -w "$MSVC_BIN/..")";
export LIB="$LIB;$SDK_WIN\\Lib\\$SDK_VER\\um\\x64;$SDK_WIN\\Lib\\$SDK_VER\\ucrt\\x64"
export INCLUDE="$SDK_WIN\\Include\\$SDK_VER\\um;$SDK_WIN\\Include\\$SDK_VER\\ucrt;$SDK_WIN\\Include\\$SDK_VER\\shared;$SDK_WIN\\Include\\$SDK_VER\\winrt;$SDK_WIN\\Include\\$SDK_VER\\cppwinrt"

echo "验证链接器: $(which link)"
echo "=== cargo check ==="
cd "$TOOLARK_DIR/src-tauri"
cargo check

echo "=== 前端构建 ==="
cd "$TOOLARK_DIR"
npm run build

echo "=== 打包（国内需设 GitHub 镜像，否则 WiX 下载失败）==="
if [ -f "$TOOLARK_DIR/.tauri-keys/toolark.key" ]; then
  export TAURI_SIGNING_PRIVATE_KEY="$(cat "$TOOLARK_DIR/.tauri-keys/toolark.key")"
fi
export TAURI_BUNDLER_TOOLS_GITHUB_MIRROR="${TAURI_BUNDLER_TOOLS_GITHUB_MIRROR:-https://gh-proxy.com/https://github.com}"
npx tauri build --bundles msi

echo "ALL GREEN - 安装包: src-tauri/target/release/bundle/msi/"
