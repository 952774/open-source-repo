# ToolArk 国内网络环境说明

## 实测发现（2026-11-24）

### 已修复：winget msstore 源导致安装失败

**现象**：`winget install --id <id>` 在国内报 `0x80070020` / `WinHttpSendRequest 12029`，因为 winget 默认搜索所有源（含 msstore），msstore 连不上导致整个命令失败。

**修复**：所有 winget 命令强制指定 `--source winget`：
- `src-tauri/src/lib.rs`：install / uninstall / rollback 三处
- `scripts/health_check.py`：show 校验
- `src/App.tsx`：安装预览显示的命令

### 环境限制：winget 下载 GitHub Release 文件失败

**现象**：`winget install --id BurntSushi.ripgrep.MSVC --source winget` 能找到包、能解析到 GitHub 下载地址，但下载时报 `InternetOpenUrl() failed / 0x80072efd`。

**根因**：
- 本机系统代理是 `http://127.0.0.1:6129`（HTTPS_PROXY 环境变量）
- curl 走这个代理能正常下载 GitHub Release（实测 200，1.7MB）
- **但 winget 用 Windows WinHTTP，不读 HTTPS_PROXY 环境变量**，所以直连 GitHub 失败

**影响范围**：GitHub 系开源工具的 winget 包，绝大多数安装器 URL 指向 GitHub Releases（ripgrep、7-Zip 等都是），在国内代理环境下 winget 安装会失败。这是**环境问题，不是 ToolArk 代码 bug**。

**解决方案（按侵入性排序）**：

1. **系统级 WinHTTP 代理**（一劳永逸，需用户确认）：
   ```cmd
   netsh winhttp set proxy 127.0.0.1:6129
   ```
   注意：这改的是全局系统设置，会影响所有走 WinHTTP 的程序。

2. **用户手动下载**：ToolArk 可在安装失败时提示"请手动下载安装包"，附上 GitHub 仓库链接（详情页已有）。

3. **应用内代理配置**（未来功能）：在 ToolArk 设置里让用户填代理，Rust 端为 winget 进程设置 `HTTP_PROXY`/`HTTPS_PROXY`（winget 部分版本支持）+ 提示配置 WinHTTP。

4. **GitHub 镜像源**（未来功能）：检测到 GitHub 下载失败时，用 `gh-proxy.com` 等镜像手动下载安装包，再调用本地安装器。这能绕过 winget 的下载环节，但要处理校验和安装器类型。

**当前状态**：ToolArk 会如实展示 winget 的错误信息（含 0x80072efd），用户可据此排查代理。详情页提供 GitHub 源码入口，用户可手动下载。

## 已验证通过的部分

- ✅ MSI 静默安装成功（winget 识别 ToolArk 0.1.0）
- ✅ winget 包解析、版本查询、--source winget 指定源
- ✅ 修复 msstore 源 bug 后，安装流程能正确走到下载阶段
- ✅ 卸载命令闭环（见下）
