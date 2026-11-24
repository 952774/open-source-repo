## ToolArk v0.9.0

### 修好了：无法启动 winget（这次是从根上修）

前面两个版本都误判成「权限不足」，方向是错的。真正的原因在于 `winget.exe` 是一个指向受保护目录的 **reparse point（应用执行别名）**，交给 shell 插件去解析就会报 `program not found`。

本版直接改成**原生进程调用**，并准备了 5 级候选路径，挨个尝试直到成功：

1. 用户级别名 `%LOCALAPPDATA%\Microsoft\WindowsApps\winget.exe`
2. `C:\Program Files\WindowsApps` 下真实的 DesktopAppInstaller 包目录（取最高版本）
3. 扫描 `PATH` 里所有 `winget.exe`
4. 裸命令名，交给系统解析
5. `cmd.exe /c winget` 兜底

全部失败时，报错信息会列出**每一种尝试过的路径和原因**，不再只说一句 program not found。实测本机三条路径都能正常拉起 `v1.29.380`。

### 顺手修掉的其它问题

- **安装进度卡死**：原来用 `lines()` 读输出，遇到非 UTF-8 字节会直接返回错误并停止读取，管道塞满后进程假死。改为按字节读 + UTF-8/GBK 自动回退解码。
- **卸载后列表不刷新**：卸载完成不会重新检测可更新列表，已补上。
- **进度条倒退**：多行输出会来回跳百分比，现在只前进不后退。
- **中文输入法打断搜索**：拼音输入过程中就触发搜索，现在等候选词上屏后再搜。
- **底部版本号滞后**：改为与 `package.json` 同源，构建时自动同步。
- **窄屏排行榜错位**：640px 以下收敛列宽，不再挤压。

### 软件库：250 → 288

- 新增 **39 款**，全部经过 `winget show --exact` 逐个校验，安装 ID 真实可用。
- 覆盖各分类的高星项目：AFFiNE、LobeChat、Bun、Typst、mise、lazydocker、hyperfine、fastfetch、bottom、Portmaster、ProtonVPN、KiCad、MeshLab、Pixelorama、FontForge、Trilium、superProductivity、Jitsi Meet、Mumble、DeltaChat、Tauon、gPodder、86Box、DOSBox-X、ScummVM、itch、Pinokio、Dive、AIChat 等。
- **13 处分类纠正**：按 GitHub 官方分类重新归档，开发/游戏/网络/社交等归类更准。

### 已知限制

- winget 修复需要真机验证。装好这版后点任意软件的「安装」，如果还有问题，报错里会带着尝试过的路径，把那行发我就能直接定位。
