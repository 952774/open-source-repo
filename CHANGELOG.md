# 更新日志

本项目遵循语义化版本。清单（tools.ts）的增删不计入版本号，随发布一起更新。

## v1.0.0 — 2026-11-24

首个正式版。相较 v0.9.0 的改动全部围绕「用户能不能信这个工具」展开。

### 榜单口径修正

- **下载榜取代星标榜**。`src/lib/search.ts` 新增 `rankByDownloads()`，排序键改为
  `src/data/downloads.ts` 里的 GitHub Release 资产累计下载量（`assets[].download_count` 求和），
  star 只作为并列时的兜底。新增 `scripts/fetch_downloads.py` 生成该快照，
  `npm run fetch-downloads` 可随时刷新。
- 排行榜默认标签从「热门」改为「📥 下载榜」，并删掉了原来那句
  「星标比任何"下载量"都透明」的说明——那句话是在为用户没要的指标找理由。
- 界面上的每张卡片、详情页、对比表都显示真实下载量（`formatDownloads`：1.2k / 2.4M）。

### 已安装状态改为可信

- 新增 `scan_installed` 命令，跑 `winget list --source winget` 并解析真实包列表；
  前端 `useTools.ts` 的 `calibrate()` 把本地记录与真实包列表取交集。
  以前只读本地 `installed.json`，用户自己用 winget 装的工具永远显示「未安装」，
  手动卸载的又一直显示「已安装」。
- 新增 `parse_package_table()` 解析器：不按固定列宽切分（中文双宽字符会让列错位），
  改为「从右往左」定位包 ID、名称与版本。附 4 个单元测试。
- 本地记录改为 `persist_installed` 命令写入，逐项 `validate_id` 过滤后去重。

### 安装后自动建桌面快捷方式 + 应用页「打开」按钮

- 安装成功后自动定位真实可执行文件（三级回退：卸载注册表项的 `DisplayIcon` →
  `InstallLocation` 递归找主 exe → `App Paths`），并在桌面创建 `.lnk`。
  两个 PowerShell 助手脚本用 `include_str!` 编进二进制，运行时释放到
  `app_data_dir/scripts/`，不会出现「exe 与脚本版本不一致」。
- 工具卡片与详情页新增「▶ 打开应用」按钮（`open_tool` 命令，DETACHED_PROCESS 启动，
  不占用应用进程）。定位结果缓存在 `app-paths.json`，exe 不存在时自动重查。

### 网络失败可自救

- 新增 `analyzeNetworkError()`：识别 `0x80072efd` / `12029` / `0x80072ee7` / `12007` /
  `0x80072ee2` / `12002` 等错误码，判定为「winget 走 WinHTTP 通道，不读浏览器代理」。
- 安装失败时不再只显示一行红字，而是弹出网络卡片，给出一键
  「把系统代理同步到 WinHTTP」（`sync_winhttp_proxy`，UAC 提权执行 `netsh`）、
  「恢复直连」（`reset_winhttp_proxy`）、「反馈问题」三个动作。
- 设置页新增「网络代理」区块，显示 `系统代理（WinINET）` 与 `WinHTTP` 当前值。

### 工程与安全

- `tauri.conf.json` 的 `csp` 从 `null` 改为白名单策略（脚本仅 `'self'`，
  图片放行 `cdn.simpleicons.org` / `raw.githubusercontent.com`，`frame-src 'none'`）。
- `capabilities/default.json` 删掉三条已失效的 `shell:allow-*` 权限；
  `Cargo.toml` 移除 `tauri-plugin-shell`，改用 `tauri-plugin-single-instance`
  （多实例会并发写 `installed.json` 互相覆盖）。
- release 构建开启 `lto = true` / `codegen-units = 1` / `strip = true`。
- 新增日志落盘：`%APPDATA%\com.toolark.app\logs\day-<n>.log`，保留 7 天；
  设置页可「查看最近日志」与「导出诊断包」（含版本、winget 版本、代理状态、日志）。
- 新增测试：`src/lib/search.test.ts`（11 个前端用例，`node --test` 直跑 TS）、
  `src-tauri/src/lib.rs` 的 4 个 Rust 用例。
- CI：`build.yml` 与 `health-check.yml` 从 `ubuntu-latest` 换到 `windows-latest`，
  否则 `scripts/health_check.py:185` 的 `sys.platform != "win32"` 判断会让 winget 校验
  永远跳过（历史报告里就是 `winget 0/250`）。新增 `cargo fmt --check`、`cargo test --lib`
  与 MSI 打包 smoke job。
- 补齐 `LICENSE`（MIT）、`SECURITY.md`。

### 修掉的 bug

- 对比页 `<td>tool.stars</td>` / `<td>tool.lastUpdate</td>` 漏花括号，
  页面上直接渲染出 `tool.stars` 字面量。
- 设置页「关于」硬编码 `v0.4.0`，改为读 `package.json`。
- `parseStars()` 遇到缺失的 `stars` 字段抛 `TypeError`，改为容忍 `undefined`。
- `scripts/fetch_downloads.py` 用 `repo.rstrip(".git")` 剥后缀，`rstrip` 按字符集剥离，
  把 `lazygit` 截成 `lazy`、`git` 截成空串，导致 35 个仓库 404。改用后缀判断。
- 侧栏语言/主题按钮的 props 早已没有渲染，仍一路传参；`mode-badge` 靠 DOM
  `textContent` 篡改文案。两处都改成正常的 React 数据流。

### 尚未做

- MSI 与 exe 仍未代码签名（`Get-AuthenticodeSignature` → `NotSigned`），
  首次安装会弹 SmartScreen「未知发布者」。签名需要代码签名证书，不在本次范围。
