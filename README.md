# ToolArk · 工具方舟

GitHub 开源工具聚合桌面应用。**只收免费开源软件**，统一发现、安装、配置、管理。

> 定位原则：只收源码公开、许可清晰的开源软件。闭源免费软件一律不收。
> CI 会拦截闭源工具混入（`scripts/filter_opensource.py --check`）。

## 快速开始

```bash
cd E:/AI/2026-11-24-14-10-00/toolark
npm run dev                 # 浏览器预览 → http://127.0.0.1:5173
npm run tauri dev           # 真桌面版（需 Rust + MSVC）
npm run tauri build         # 打包 .msi / .exe
```

## 已实现功能（20 条优化建议全部落地）

### 数据层
- **D1 GitHub 元数据**：每款工具含 repo / stars / 最近更新
- **D2 活跃度巡检**：`scripts/health_check.py` 检查归档/长期未更新/404，出 Markdown 报告
- **D3 工具扩充**：见下方清单
- **D4 许可证筛选**：按 MIT / GPL / Apache 等协议过滤

### 信任与体验层
- **T1** 详情页 GitHub 入口 + Star 数 + 许可证全文链接
- **T2** 「已验证开源」徽章 + 来源透明标识
- **T3** 安装预览显示源码仓库地址
- **T4** 卸载时可勾选「同时清理配置目录」（Rust 端白名单路径）

### 功能层
- **F1** 配置备份/还原（浏览器 localStorage / Tauri 文件读写，导出 JSON）
- **F2** 场景推荐问卷（3 步引导 → 推荐工具 → 批量安装）
- **F3** 工具对比（终端/搜索/音乐/密码/编辑器 5 组横向对比）
- **F4** 社区提交 manifest（表单 → 校验 → 生成 YAML → 复制去提 PR）
- **F5** 中英双语切换（侧栏底部 🌐 按钮）
- **F6** 深浅主题切换（侧栏底部 🌙/☀️ 按钮）

### v0.5 新增
- **Liquid Glass 全新界面**：参考 macOS 27 液态玻璃设计——四色流动光斑背景、多层半透明玻璃面板（blur 34px + saturate 175%）、内壁高光、弹性动效、光泽扫过、统一大圆角。全部视图（侧栏、卡片、弹窗、抽屉、设置、榜单）风格统一，深色模式同步适配
- **OPPO Sans 4.0 字体**：可变字重（100-700），从 22MB 子集化到 2.7MB woff2，超出字符自动回退系统字体
- **工具更新检查**：`winget upgrade` 集成——「已安装」视图自动检测哪些工具有了新版本，显示「旧版本 → 新版本」，支持单款升级与一键全部更新
- **软件榜单前移**：侧栏顶部独立渐变入口卡片（带光泽动画），不再藏在二级菜单
- **真实软件图标**：接入 simple-icons 图标 CDN，加载失败自动回退 emoji，不会出现空白
- **中英文工具名**：详情页中文名下方显示英文原名
- **界面预览区**：详情页新增截图区域（无内置截图时给出官网/GitHub 链接，不编造图片）
- **修复更新报错**：`latest.json` 的 `pub_date` 空值导致「检查更新失败（invalid value for pub_date）」，已改为标准 RFC3339 时间
- **性能**：工具列表分批渲染（每批 60 款 + 加载更多），避免数百款同时挂载卡顿

### v0.4 新增
- **模糊搜索**：子序列匹配 + 驼峰缩写（`vsc` → Visual Studio Code）+ 多关键词 AND + 相关度排序（名称 > 标签 > 场景 > 描述），中英文均可，零依赖实现
- **软件榜单**：热门榜（按 GitHub Star）、最近活跃榜、编辑精选，支持分类筛选，前三名金银铜牌
- **设置页**：主题 / 语言 / 默认安装位置 / 安装后自动关闭，全部自动持久化（localStorage）
- **安装位置选择**：安装弹窗可自定义目录，支持系统原生目录选择器；不支持自定义位置的安装器自动回退并提示
- **详情页增强**：特性标签、安装方式说明、同类推荐（同分类按 Star 排序的真实数据）
- **中文安装界面**：MSI 安装向导语言设为简体中文
- **快捷键**：`Ctrl/⌘ + K` 聚焦搜索，`Esc` 关闭弹层；搜索框内显式提示
- **搜索空状态**：无结果时给出模糊搜索提示与可点击的示例词
- **AI 分类**：新增「AI 工具」大类，覆盖本地大模型、图像生成、语音识别、AI 客户端等

### 工程层
- **E1** Rust 1.100 已装（清华镜像）；MSVC Build Tools 安装中
- **E2** updater 签名密钥已生成，公钥已填入 `tauri.conf.json`
- **E3** GitHub Actions：每周巡检 + PR 构建校验（`.github/workflows/`）
- **E4** 安装失败自动回滚（winget uninstall 清理残留）

## 自动更新签名密钥（E2）

密钥对已生成在 `.tauri-keys/`（**已 gitignore，私钥不要提交**）：
- `toolark.key` — 私钥，打包时通过环境变量提供
- `toolark.key.pub` — 公钥，已填入 `tauri.conf.json`

打包命令：
```bash
export TAURI_SIGNING_PRIVATE_KEY="<私钥内容或路径>"   # Windows 用 $env:
npm run tauri build
```

更新源 `endpoints` 已指向正式地址：
`https://github.com/952774/open-source-repo/releases/latest/download/latest.json`

## 工具清单（288 款 · 11 大分类 · 全开源）

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

**288 个 winget ID 全部经 `winget show --exact` 逐条校验**，无重复 ID、无重名、全部标记 `openSource: true`。

8 个场景套装（新机开荒 / 开发利器 / 创作工具箱 / 隐私守卫 / 日常必备 / 娱乐中心 / 本地 AI 全家桶）。每款含 GitHub 仓库 / Star 数 / 最近更新元数据。

## 项目结构

```text
toolark/
├── src/
│   ├── data/tools.ts          # 工具 manifest（单一数据源）
│   ├── data/scenarios.ts      # 场景问卷 + 工具对比数据
│   ├── hooks/useTools.ts      # 工具状态、安装/卸载/批量
│   ├── hooks/useUpdater.ts    # 应用自更新
│   ├── hooks/useConfig.ts     # 配置备份还原
│   ├── hooks/useSubmit.ts     # 社区提交
│   ├── lib/i18n.ts            # 中英双语字典
│   ├── lib/api.ts             # 双模式适配层
│   ├── components/ExtraViews.tsx  # 场景/对比/配置/提交视图
│   ├── App.tsx                # 主界面 + 四类弹窗
│   └── index.css              # 玻璃质感主题 + 深色主题
├── src-tauri/
│   ├── src/lib.rs             # winget 引擎 + 5 个 IPC 命令
│   ├── capabilities/default.json
│   ├── icons/                 # 全套图标
│   └── tauri.conf.json
├── scripts/
│   ├── make_icon.py           # 图标生成
│   ├── filter_opensource.py   # 开源校验（CI 用）
│   └── health_check.py        # 活跃度巡检
├── .github/workflows/         # build.yml + health-check.yml
├── .tauri-keys/               # 签名密钥（gitignore）
└── reports/health-report.md   # 巡检报告
```

## 商业模式

完全免费。核心发现/安装/管理永久免费，无广告无推荐位。

## Git Bash 下编译桌面版（已实测通过 ✅）

两个国内网络/环境坑，脚本已全部处理：

1. Git Bash 自带 `link` 抢先 MSVC 的 `link.exe` → 需把 MSVC bin 置顶 PATH
2. tauri 打包要从 GitHub 下载 WiX（国内 502）→ 设 `TAURI_BUNDLER_TOOLS_GITHUB_MIRROR` 走 gh-proxy 镜像

```bash
bash scripts/build-desktop.sh    # 自动定位 MSVC+SDK、设镜像、带签名打包
```

脚本会检查 `kernel32.Lib`（SDK 装完标志），缺依赖会明确报错。**手动打包时务必设镜像**：

```bash
export TAURI_BUNDLER_TOOLS_GITHUB_MIRROR="https://gh-proxy.com/https://github.com"
export TAURI_SIGNING_PRIVATE_KEY="$(cat .tauri-keys/toolark.key)"
npm run tauri build --bundles msi
```

### 已验证产物（2026-11-24）

| 产物 | 路径 | 大小 |
|---|---|---|
| 可执行程序 | `src-tauri/target/release/toolark.exe` | 15 MB |
| MSI 安装包 | `src-tauri/target/release/bundle/msi/ToolArk_0.1.0_x64_en-US.msi` | 5.41 MB |
| 更新签名 | `...msi.sig` | 436 B |

桌面应用已实测可启动（WebView2 窗口正常创建），自动更新签名链路闭环。

## 发布更新到 GitHub Releases（任务1）

仓库名确定后，三条命令搞定：

```bash
bash scripts/configure-updater.sh <你的用户名/仓库名>   # 改 endpoints
bash scripts/build-desktop.sh                           # 重新打包+签名
python scripts/make-latest-json.py --repo <你的用户名/仓库名>  # 生成 latest.json
```

然后在 GitHub 建 Release（tag `v0.1.0`），上传这三个文件：
- `ToolArk_0.1.0_x64_en-US.msi`
- `ToolArk_0.1.0_x64_en-US.msi.sig`
- `latest.json`

用户点「检查更新」就能收到新版本。

## 提高巡检限额（任务2）

GitHub 匿名 API 只有 60 次/小时，66 款工具一次就超。配 PAT 提到 5000 次/小时：

1. GitHub → Settings → Developer settings → Personal access tokens → Generate new token（classic），只勾 `public_repo`
2. 把 token 写到项目根目录的 `.github-token` 文件（已 gitignore），或 `export GITHUB_TOKEN=xxx`
3. 运行 `python scripts/health_check.py --skip-winget --no-fail`

脚本优先读环境变量，其次读 `.github-token` 文件。

## 已完成验证

- ✅ MSI 静默安装成功（winget 识别到 ToolArk 0.1.0）
- ✅ winget 安装命令实测（发现并修复 msstore 源导致的失败——现已强制 `--source winget`）
- ✅ 自动更新签名链路（.msi.sig 生成）

## 待办

- 用户提供 GitHub 仓库名后完成实际发布（脚本已就绪）
- 用户提供 PAT 后跑完整活跃巡检（脚本已就绪）
