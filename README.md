# ToolArk · 工具方舟

GitHub 开源工具聚合桌面应用。**只收免费开源软件**，统一发现、安装、管理。

> 定位原则：只收源码公开、许可清晰的开源软件。闭源免费软件一律不收。
> CI 会拦截闭源工具混入（`scripts/filter_opensource.py --check`）。

Windows 10/11 · Tauri 2 + Rust + React 18 · MIT

---

## 它解决什么问题

在 Windows 上装开源工具，通常要经历：搜 GitHub → 找 release → 认不清该下哪个包 → 手动解压 →
自己建快捷方式 → 半年后忘了装过什么、也不知道有新版本。

ToolArk 把这些压成一件事：**点一下，走 winget 装，装完桌面上就有图标**。
它不自己下载安装包，所有安装动作都交给系统自带的 `winget`，来源固定为官方社区仓库。

## 核心能力

### 真实下载榜，不是 star 榜

GitHub 没有「仓库总下载量」API，唯一可得的真实分发量是各 release 下
`assets[].download_count` 之和。`scripts/fetch_downloads.py` 会把它抓下来生成
`src/data/downloads.ts`，榜单按这个数字排序，star 只作为并列时的兜底。

当前快照：284 个仓库，248 个有真实下载量，合计约 72.9 亿次。

界面上的卡片、详情页、对比表都直接显示这个数字（`1.2k` / `2.4M` 这种量级）。

刷新数据：

```bash
python scripts/fetch_downloads.py          # 需要项目根 .github-token
```

### 已安装状态来自 winget，不是本地记账

以前「已安装」列表只读自己写的 `installed.json`，结果是：你自己用 `winget install` 装的东西
永远显示「未安装」，手动卸载过的又一直显示「已安装」。

现在 `scan_installed` 命令会跑 `winget list --source winget`，解析真实包列表，
再和本地记录取交集。解析器 `parse_package_table()` 不按固定列宽切分——中文双宽字符会让列错位，
所以改成「从右往左」定位包 ID、名称与版本，附 4 个单元测试。

### 安装后自动建桌面快捷方式

安装成功后自动定位真实可执行文件，三级回退：

1. 卸载注册表项（HKLM / WOW6432Node / HKCU）的 `DisplayIcon`
2. `InstallLocation` 递归找主 exe（排除 `unins` / `setup` / `crash` / `vc_redist` 这类）
3. `App Paths`

然后建 `.lnk`。两个 PowerShell 助手脚本用 `include_str!` 编进二进制，运行时释放到
`app_data_dir/scripts/`，不会出现「exe 与脚本版本不一致」。

### 应用页「打开」按钮

已安装的工具，卡片和详情页都有「▶ 打开应用」。`open_tool` 命令用 DETACHED_PROCESS 启动，
不占用应用进程；定位结果缓存在 `app-paths.json`，exe 不存在时自动重查。

### 网络失败能自救

winget 走 WinHTTP 通道，**不读浏览器/系统 IE 代理设置**。开了代理但没同步到 WinHTTP 时，
从 GitHub Releases 下安装包会报 `0x80072efd`，而错误信息本身不会告诉你原因。

`analyzeNetworkError()` 识别 `0x80072efd` / `12029` / `0x80072ee7` / `12007` /
`0x80072ee2` / `12002` 等错误码，安装失败时弹卡片给出三个动作：

- 一键把系统代理同步到 WinHTTP（UAC 提权执行 `netsh winhttp set proxy`）
- 恢复直连（`netsh winhttp reset proxy`）
- 反馈问题

设置页也有「网络代理」区块，显示 `系统代理（WinINET）` 与 `WinHTTP` 的当前值。

### 其余

- **界面预览**：`scripts/fetch_shots.py` 从各仓库 README 提取真实界面截图
  （过滤徽章、头像、Discord 嵌入图），284 个工具全部有图；README 无图时退回仓库社交预览图。
- **模糊搜索**：子序列 + 驼峰缩写（`vsc` → Visual Studio Code）+ 多关键词 AND，
  名称 > 标签 > 场景 > 描述 加权，中英文名都可搜。
- **更新检查**：`winget upgrade` 集成，「已安装」视图自动检测可更新项，支持单款与一键全部升级。
- **配置备份/还原**：白名单路径（VS Code / starship / lazygit）导出 JSON 快照。
- **诊断**：`%APPDATA%\com.toolark.app\logs\day-<n>.log` 保留 7 天，设置页可查看与导出诊断包。
- **单实例**：`tauri-plugin-single-instance`，避免两个进程并发写 `installed.json` 互相覆盖。
- **Liquid Glass 界面**：四色流动光斑 + 多层半透明玻璃（blur 34px / saturate 175%），
  深色模式同步适配；OPPO Sans 4.0 可变字重（子集化到 2.7MB woff2）。

## 工具清单（289 款 · 11 大类 · 全开源）

| 分类 | 数量 | 代表工具 |
|---|---|---|
| 🛠️ 开发效率 | 45 | VS Code、Neovim、Git、Bun、mise、lazydocker、hyperfine、PyCharm CE |
| 🖥️ 系统增强 | 47 | PowerToys、Files、ShareX、Rufus、Mem Reduct、fastfetch、bottom、TranslucentTB |
| ⚡ 效率办公 | 25 | Joplin、Logseq、LibreOffice、Typst、Trilium、superProductivity、Zotero、思源笔记 |
| 🎬 媒体处理 | 21 | FFmpeg、HandBrake、LosslessCut、Upscayl、ImageGlass、LMMS、OpenShot |
| 🌐 网络下载 | 24 | LocalSend、Motrix、Brave、mitmproxy、Nextcloud、Portmaster、qBittorrent |
| 🎨 设计创作 | 21 | Inkscape、Blender、Krita、KiCad、MeshLab、Pixelorama、FontForge |
| 🔐 安全隐私 | 17 | KeePassXC、VeraCrypt、Cryptomator、ProtonVPN、GnuPG、Restic |
| 💬 社交沟通 | 16 | Telegram、Signal、Jitsi Meet、Mumble、DeltaChat、Whalebird、Zulip |
| 🤖 AI 工具 | 18 | Ollama、Open WebUI、LobeChat、Pinokio、Dive、AIChat、Langflow |
| 🎬 影音工具 | 31 | VLC、mpv、Navidrome、Tauon、gPodder、Strawberry、IPTV 播放器 |
| 🎮 游戏工具 | 23 | Dolphin、PPSSPP、ScummVM、DOSBox-X、86Box、itch、Playnite、Sunshine |

全部 winget ID 经 `winget show --exact` 逐条校验，无重复 ID、全部标记 `openSource: true`。

7 个场景套装：新机开荒 / 开发利器 / 创作工具箱 / 隐私守卫 / 日常必备 / 娱乐中心 / 本地 AI 全家桶。

## 开发

```bash
npm install
npm run dev            # 浏览器预览 http://127.0.0.1:5173
npm run tauri dev      # 桌面版（需 Rust + MSVC Build Tools）
npm run build          # tsc --noEmit && vite build
npm test               # node --test 直跑 TS 用例
cd src-tauri && cargo test --lib
```

打包（Windows，需 MSVC 与 Windows SDK）：

```powershell
$env:TAURI_SIGNING_PRIVATE_KEY = Get-Content .tauri-keys/toolark.key -Raw
$env:TAURI_BUNDLER_TOOLS_GITHUB_MIRROR = "https://gh-proxy.com/https://github.com"
npx tauri build --bundles msi
```

产物在 `src-tauri/target/release/bundle/msi/`。

发布：

```powershell
python scripts/make-latest-json.py --repo 952774/open-source-repo --version 1.0.0
python scripts/publish_release.py --version 1.0.0
```

## 项目结构

```text
toolark/
├── src/
│   ├── data/tools.ts          # 工具 manifest（单一数据源，289 条）
│   ├── data/downloads.ts      # 下载量快照（fetch_downloads.py 生成）
│   ├── data/shots.ts          # 界面截图快照（fetch_shots.py 生成）
│   ├── data/scenarios.ts      # 场景问卷 + 对比数据
│   ├── hooks/useTools.ts      # 工具状态、安装/卸载/校准/启动
│   ├── hooks/useUpdater.ts    # 应用自更新
│   ├── hooks/useConfig.ts     # 配置备份还原
│   ├── hooks/useSubmit.ts     # 社区提交 manifest 生成
│   ├── lib/api.ts             # Tauri / 浏览器双模式适配层
│   ├── lib/search.ts          # 模糊搜索 + 榜单排序
│   ├── lib/i18n.ts            # 中英双语字典
│   ├── components/Views.tsx       # 设置 / 榜单
│   ├── components/ExtraViews.tsx  # 场景 / 对比 / 配置 / 提交
│   ├── App.tsx                # 主界面 + 四类弹窗
│   └── index.css              # 玻璃质感主题 + 深色主题
├── src-tauri/
│   ├── src/lib.rs             # winget 引擎 + 19 个 IPC 命令 + 单元测试
│   ├── src/app_lookup.ps1     # 注册表定位 exe
│   ├── src/make_shortcut.ps1  # 建桌面快捷方式
│   ├── capabilities/default.json
│   └── tauri.conf.json
├── scripts/
│   ├── fetch_downloads.py     # GitHub Release 下载量
│   ├── fetch_shots.py         # README 界面截图
│   ├── health_check.py        # 活跃度巡检
│   ├── filter_opensource.py   # 开源校验（CI 用）
│   ├── make-latest-json.py    # updater 清单
│   └── publish_release.py     # 发布到 GitHub Release
└── .github/workflows/         # build.yml + health-check.yml（均 windows-latest）
```

## 安全

见 [SECURITY.md](SECURITY.md)。要点：不下载执行远程代码、不上报数据、不读浏览器数据、
不擅自改系统代理（需你在设置页主动点）。Tauri capabilities 只开放
`core` / `updater` / `process` / `dialog` 四项，前端拿不到任意命令执行能力。

**已知风险**：MSI 与 exe 未代码签名，首次安装会弹 SmartScreen「未知发布者」。
这是缺证书导致的，可用 `latest.json` 里的 minisign 签名核对产物。

## 许可

MIT，见 [LICENSE](LICENSE)。收录的第三方工具各自遵循其原许可。
