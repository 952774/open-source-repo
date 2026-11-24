# 安全说明

## 报告问题

发现安全问题请通过 GitHub 私密安全公告提交：
<https://github.com/952774/open-source-repo/security/advisories/new>

请不要先公开提 Issue。我会在 7 天内确认，30 天内给出修复或说明。

## 这个程序会做什么

ToolArk 是一个 Windows 桌面应用（Tauri 2 + Rust + React），它本身**不下载、不执行任何远程代码**，
只做三件事：

1. **调用 winget 安装/卸载/升级**。所有安装动作都通过系统自带的 `winget.exe` 完成，
   包来源固定为 `--source winget`（即微软官方社区仓库），不使用 `msstore` 源。
   实际下载与安装由 winget 负责，ToolArk 只读取它的输出流并展示进度。
2. **读注册表定位已安装程序**。为了让「打开应用」和「自动建桌面快捷方式」能工作，
   会读取三个 Uninstall 注册表根（HKLM / WOW6432Node / HKCU）的 `DisplayName`、
   `DisplayIcon`、`InstallLocation`，以及 `App Paths`。
   只读取，不写入（除桌面 `.lnk` 与自身 `%APPDATA%\com.toolark.app\` 下的文件）。
3. **在桌面创建 .lnk 快捷方式**。仅在你通过 ToolArk 安装某个工具之后执行一次，
   目标路径来自上一步查到的真实 exe。

## 它不会做什么

- 不上传任何使用数据、不联网上报（除下面列的公开只读接口）。
- 不修改系统代理设置，除非你在「设置 → 网络代理」里主动点了按钮
  （该动作会走 UAC 提权执行 `netsh winhttp set proxy`）。
- 不读取浏览器数据、不读聊天记录、不读任意用户目录。
- 不包含任何远程配置下发或热更新代码。应用自身的更新走 Tauri updater，
  校验 minisign 签名后才安装。

## 网络访问清单

| 目标 | 用途 | 时机 |
| --- | --- | --- |
| `github.com/952774/open-source-repo/releases/latest/download/latest.json` | 检查应用自身更新 | 启动 2.5 秒后静默检查一次；手动点「检查更新」 |
| `cdn.simpleicons.org` | 部分工具的图标 | 打开对应卡片时 |
| `raw.githubusercontent.com` | 部分工具的图标 | 打开对应卡片时 |
| `api.github.com` | 构建期抓取下载量（`scripts/fetch_downloads.py`），**运行时不访问** | 仅开发/CI |

`connect-src` 的 CSP 白名单与上表一致，未列出的域名在运行时无法被页面脚本请求。

## 权限模型

Tauri capabilities 只开放四项：`core:default`、`updater:default`、`process:default`、
`dialog:default`。v0.9.0 遗留的 `shell:allow-execute` / `shell:allow-spawn` / `shell:allow-kill`
已移除——winget 调用改为 Rust 侧原生进程，前端拿不到任意命令执行能力。

## 已知风险

- **安装包未签名**。MSI 与 exe 均为 `NotSigned`，Windows 会弹 SmartScreen 警告。
  这是缺代码签名证书导致的，不是行为可疑。校验方式：比对 GitHub Release 页面上
  `latest.json` 里 `signature` 字段的 minisign 签名。
- **winget 的包元数据由微软社区维护**。ToolArk 收录时校验过 `winget show --exact` 可解析，
  但不审计每个包的上游安装器行为。
