## ToolArk 工具方舟 v0.8.0

**249 款全开源工具 · 11 大分类 · 修复 winget 无法启动**

### 🔧 修复：安装时报「无法启动 winget: program not found」

**这是个从第一版就埋着的 bug**，这次找到根因了：

Tauri 的 shell 权限只写了 `shell:allow-execute`，但**没有配置命令白名单（scope）**。Tauri 2 的权限模型要求显式声明允许执行哪些可执行文件，没声明就一律拒绝——报错信息就是「program not found」，看起来像找不到 winget，实际上是权限拦截。

修复方式：在 `capabilities/default.json` 里给 `shell:allow-execute` 和 `shell:allow-spawn` 都加上 `winget` 的白名单 scope。

**如果你之前装过任何版本、点安装一直失败，就是这个原因。这次修好了。**

### 📊 工具库 223 → 249

**系统增强 32 → 48**（用户重点要求），新增的一批实用小工具：

| 方向 | 新增 |
|---|---|
| 手机 ↔ 电脑互联 | KDE Connect、scrcpy 及衍生工具、QtScrcpy 类 |
| 电脑 ↔ 电脑互联 | Syncthing、Deskflow/Barrier（键鼠共享）、Wormhole |
| 系统优化与清理 | Dism++、Autoruns、Process Explorer、TCPView、NVCleanstall、DDU、CrystalDiskMark |
| 桌面增强 | AltSnap、Open-Shell、Lively Wallpaper、WinDynamicDesktop、ModernFlyouts、TranslucentTB、TaskbarX、RoundedTB、Nilesoft Shell |
| 硬件监测 | Libre Hardware Monitor、Sophia Script |
| 游戏优化 | CapFrameX、PresentMon、DXVK、VKBasalt、Borderless Gaming |

**影音工具 20 → 26**，新增开源播放器与媒体库客户端（MPC-BE、Navidrome 客户端类、IPTV 播放器等）。

巡检 **249/249 全绿**（发现 SharpKeys 停更 18 个月，已移除；其功能可由 PowerToys 键盘管理器替代）。

> **关于「能白嫖网络资源」的播放器**：我只收录了开源播放器、开源 IPTV 播放器（内容源由你提供 m3u 订阅）和开源媒体库客户端。**没有收录任何盗版影视聚合站客户端或破解去广告版**——那类软件有法律风险，也会让整个项目被下架。想看直播/影视，用 IPTV 播放器配公开 m3u 源、或用 Jellyfin 自建媒体库，都是干净的路子。

### 🏷️ 版本号与侧栏

- **侧栏底部版本号改动态读取**（之前硬编码 v0.4.0，升级后不变化）。现在始终显示真实版本。
- **移除侧栏的语言/主题切换按钮**（截图里那两个），统一收进设置页，侧栏更干净。

### 🐛 其他修复与优化

1. **详情页返回不再丢滚动位置**：从列表滚到第 30 个点开详情，返回后还停在原处（之前会跳回顶部）
2. **收藏空状态文案**：之前显示「没有找到匹配的工具」，现在是「还没有收藏任何工具，点卡片右上角的心形按钮收藏」
3. **检查更新有反馈**：点检查后会提示「发现 N 款工具可更新」或「所有工具都已是最新版本」，并且**区分「没有更新」和「winget 不可用」**
4. **设置页新增「运行环境」诊断**：直接显示 winget 版本号；不可用时会告诉你原因和解决办法（去 Microsoft Store 装「应用安装程序」）
5. 侧栏「检查更新」按钮改名为「检查应用更新」，和设置页的「检查工具更新」区分开

### 安装

下载 `ToolArk_0.8.0_x64_zh-CN.msi` 双击安装。旧版可点应用内「检查应用更新」升级。
