//! ToolArk 桌面端核心
//!
//! 三块职责：
//! 1. winget 安装引擎（流式进度、失败回滚、自定义位置回退）
//! 2. 已安装状态校准（以 `winget list` 为真相，不再只信本地记录）
//! 3. 应用启动与桌面快捷方式（注册表定位 exe → 启动 / 建 .lnk）
//!
//! 安全原则：ID 白名单校验 / 参数化调用（不拼 shell 字符串）/ 最小权限

#[cfg(windows)]
use std::os::windows::process::CommandExt;
use std::path::{Path, PathBuf};
use std::process::Stdio;

use encoding_rs::GBK;
use tauri::{AppHandle, Emitter, Manager};
use tokio::io::{AsyncBufReadExt, BufReader};
use tokio::process::Command;

// ─────────────────────────────────────────────────────────────
// 基础工具
// ─────────────────────────────────────────────────────────────

/// winget ID 与 tool ID 只允许安全字符，杜绝命令注入
fn validate_id(id: &str) -> Result<(), String> {
    if id.is_empty() || id.len() > 120 {
        return Err("无效的 ID：长度异常".into());
    }
    if !id
        .chars()
        .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-')
    {
        return Err("无效的 ID：包含非法字符".into());
    }
    Ok(())
}

fn data_dir(app: &AppHandle) -> Result<PathBuf, String> {
    let dir = app
        .path()
        .app_data_dir()
        .map_err(|e| format!("无法获取数据目录: {}", e))?;
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建数据目录: {}", e))?;
    Ok(dir)
}

fn records_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join("installed.json"))
}

fn read_records(app: &AppHandle) -> Vec<String> {
    let Ok(path) = records_path(app) else {
        return vec![];
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return vec![];
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_records(app: &AppHandle, ids: &[String]) -> Result<(), String> {
    let path = records_path(app)?;
    let text = serde_json::to_string_pretty(ids).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("写入安装记录失败: {}", e))
}

// ─────────────────────────────────────────────────────────────
// 日志落盘（保留 7 天）
// ─────────────────────────────────────────────────────────────

fn logs_dir(app: &AppHandle) -> Option<PathBuf> {
    let dir = data_dir(app).ok()?.join("logs");
    std::fs::create_dir_all(&dir).ok()?;
    Some(dir)
}

fn today_stamp() -> String {
    // 用本地时间做文件名：UTC 秒数 + 东八区偏移近似即可，仅用于分文件
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let days = secs / 86_400;
    format!("day-{}", days)
}

/// 追加一行日志到 logs/day-<n>.log，并顺手清理 7 天前的文件
fn log_line(app: &AppHandle, scope: &str, text: &str) {
    let Some(dir) = logs_dir(app) else { return };
    let path = dir.join(format!("{}.log", today_stamp()));
    let stamp = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    let line = format!("[{}] [{}] {}\n", stamp, scope, text);
    use std::io::Write;
    if let Ok(mut f) = std::fs::OpenOptions::new()
        .create(true)
        .append(true)
        .open(&path)
    {
        let _ = f.write_all(line.as_bytes());
    }
    prune_logs(&dir, 7);
}

fn prune_logs(dir: &Path, keep: usize) {
    let Ok(entries) = std::fs::read_dir(dir) else {
        return;
    };
    let mut files: Vec<(u64, PathBuf)> = entries
        .flatten()
        .filter_map(|e| {
            let p = e.path();
            if p.extension().and_then(|x| x.to_str()) != Some("log") {
                return None;
            }
            let name = p.file_stem()?.to_str()?.to_string();
            let day: u64 = name.strip_prefix("day-")?.parse().ok()?;
            Some((day, p))
        })
        .collect();
    if files.len() <= keep {
        return;
    }
    files.sort_by(|a, b| b.0.cmp(&a.0));
    for (_, p) in files.into_iter().skip(keep) {
        let _ = std::fs::remove_file(p);
    }
}

fn summarize(stdout: &[u8], stderr: &[u8]) -> String {
    let err = String::from_utf8_lossy(stderr);
    let out = String::from_utf8_lossy(stdout);
    let s = if err.trim().is_empty() {
        out.trim()
    } else {
        err.trim()
    };
    if s.is_empty() {
        "未知错误".to_string()
    } else {
        s.to_string()
    }
}

/// 从 winget 输出中提取百分比（取本段内最高值）
fn parse_percent(text: &str) -> Option<u8> {
    let chars: Vec<char> = text.chars().collect();
    let mut best: Option<u8> = None;
    for (i, &c) in chars.iter().enumerate() {
        if c != '%' {
            continue;
        }
        let mut j = i;
        while j > 0 && (chars[j - 1].is_ascii_digit() || chars[j - 1] == '.') {
            j -= 1;
        }
        let num: String = chars[j..i].iter().collect();
        if let Ok(v) = num.parse::<f64>() {
            let p = v.round().clamp(0.0, 100.0) as u8;
            if best.map_or(true, |b| p > b) {
                best = Some(p);
            }
        }
    }
    best
}

/// 进度事件负载
#[derive(Clone, serde::Serialize)]
struct ProgressPayload {
    tool_id: String,
    percent: u8,
    message: String,
    phase: String,
}

/// 解码 winget 输出：优先 UTF-8，非法字节回退 GBK（中文 Windows 控制台常见）。
/// 用字节读取而非 lines()，因为 lines() 遇到非 UTF-8 会返回 Err，
/// 一旦中断读取，子进程 stdout 管道塞满后会直接卡死。
fn decode_output(bytes: &[u8]) -> String {
    match std::str::from_utf8(bytes) {
        Ok(v) => v.to_string(),
        Err(_) => {
            let (cow, _, _) = GBK.decode(bytes);
            cow.into_owned()
        }
    }
}

// ─────────────────────────────────────────────────────────────
// winget 定位与执行
// ─────────────────────────────────────────────────────────────

/// 列出所有可能的 winget 启动方式，按优先级排列。
/// winget.exe 在 WindowsApps 下是一个指向受保护目录的 reparse point，
/// 直接用裸命令名在部分环境下会 NotFound，因此准备多级回退：
/// 别名 → 真实包目录 → PATH 扫描 → 裸命令 → 系统命令解释器。
fn winget_candidates() -> Vec<(String, Vec<String>)> {
    let mut list: Vec<(String, Vec<String>)> = Vec::new();

    // 1) 用户级应用执行别名（最常见、权限正常）
    if let Ok(local) = std::env::var("LOCALAPPDATA") {
        let alias = format!("{local}\\Microsoft\\WindowsApps\\winget.exe");
        if Path::new(&alias).exists() {
            list.push((alias, Vec::new()));
        }
    }

    // 2) WindowsApps 下的真实安装目录（DesktopAppInstaller 包）
    let base = Path::new("C:\\Program Files\\WindowsApps");
    if let Ok(entries) = std::fs::read_dir(base) {
        let mut found: Vec<(u64, String)> = Vec::new();
        for entry in entries.flatten() {
            let name = entry.file_name().to_string_lossy().to_string();
            if name.starts_with("Microsoft.DesktopAppInstaller_") && name.contains("_x64__") {
                let exe = entry.path().join("winget.exe");
                if exe.exists() {
                    let ver: u64 = name
                        .split('_')
                        .nth(1)
                        .and_then(|v| v.split('.').next())
                        .and_then(|maj| maj.parse().ok())
                        .unwrap_or(0);
                    found.push((ver, exe.to_string_lossy().to_string()));
                }
            }
        }
        found.sort_by(|a, b| b.0.cmp(&a.0));
        for (_, path) in found {
            list.push((path, Vec::new()));
        }
    }

    // 3) 扫描 PATH（有些机器别名被删掉，但 WindowsApps 仍在 PATH 里）
    if let Ok(path) = std::env::var("PATH") {
        for dir in path.split(';') {
            let dir = dir.trim().trim_matches('"');
            if dir.is_empty() {
                continue;
            }
            let exe = Path::new(dir).join("winget.exe");
            if exe.exists() {
                let s = exe.to_string_lossy().to_string();
                if !list.iter().any(|(p, _)| p.eq_ignore_ascii_case(&s)) {
                    list.push((s, Vec::new()));
                }
            }
        }
    }

    // 4) 裸命令名，交给 CreateProcess 自己解析
    list.push(("winget.exe".to_string(), Vec::new()));

    // 5) 兜底：交给系统命令解释器解析（它能正确处理 App Execution Alias）
    list.push((
        "cmd.exe".to_string(),
        vec!["/c".to_string(), "winget".to_string()],
    ));

    list
}

/// 运行中 winget 进程注册表 + 取消标记。
///
/// 之前安装一旦开始就没有出口：某个包卡在 GitHub Release 上反复重试时，
/// 用户除了结束 ToolArk 进程别无办法。这里按 tool_id 记住子进程 PID，
/// 取消时用 taskkill /T 连同安装器的孙进程一起结束。
#[derive(Default)]
struct RunRegistry {
    pids: std::sync::Mutex<std::collections::HashMap<String, u32>>,
    cancelled: std::sync::Mutex<std::collections::HashSet<String>>,
}

fn register_pid(app: &AppHandle, tool_id: &str, pid: u32) {
    if let Ok(mut m) = app.state::<RunRegistry>().pids.lock() {
        m.insert(tool_id.to_string(), pid);
    }
}

fn unregister_pid(app: &AppHandle, tool_id: &str) {
    if let Ok(mut m) = app.state::<RunRegistry>().pids.lock() {
        m.remove(tool_id);
    }
}

fn cancel_requested(app: &AppHandle, tool_id: &str) -> bool {
    app.state::<RunRegistry>()
        .cancelled
        .lock()
        .map(|s| s.contains(tool_id))
        .unwrap_or(false)
}

fn clear_cancel(app: &AppHandle, tool_id: &str) {
    if let Ok(mut s) = app.state::<RunRegistry>().cancelled.lock() {
        s.remove(tool_id);
    }
}

/// 流式执行 winget：原生进程 + 逐行读输出 + emit 进度事件。
/// 返回 (是否成功, 合并后的完整输出)
async fn run_winget_stream(
    app: &AppHandle,
    args: Vec<String>,
    tool_id: &str,
    event_name: &str,
) -> Result<(bool, String), String> {
    let mut spawned: Option<tokio::process::Child> = None;
    let mut tried: Vec<String> = Vec::new();
    let mut candidates = winget_candidates();
    let cmd_fallback = if candidates.last().map_or(false, |(e, _)| e == "cmd.exe") {
        candidates.pop()
    } else {
        None
    };

    for (exe, prefix) in candidates {
        let mut cmd = Command::new(&exe);
        cmd.args(&prefix);
        cmd.args(&args)
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000); // CREATE_NO_WINDOW
        }
        match cmd.spawn() {
            Ok(child) => {
                spawned = Some(child);
                break;
            }
            Err(e) => tried.push(format!("{exe}（{e}）")),
        }
    }

    if spawned.is_none() {
        if let Some((exe, prefix)) = cmd_fallback {
            let mut cmd = Command::new(&exe);
            cmd.args(&prefix);
            cmd.args(&args)
                .stdout(Stdio::piped())
                .stderr(Stdio::piped())
                .stdin(Stdio::null());
            #[cfg(windows)]
            {
                cmd.creation_flags(0x0800_0000);
            }
            match cmd.spawn() {
                Ok(child) => spawned = Some(child),
                Err(e) => tried.push(format!("{exe}（{e}）")),
            }
        }
    }

    let mut child = match spawned {
        Some(c) => c,
        None => {
            return Err(format!(
                "无法启动 winget，已尝试 {} 种方式均失败：{}。请确认「应用安装程序 / App Installer」已安装。",
                tried.len(),
                tried.join("；")
            ))
        }
    };

    // 登记 PID，让 cancel_install 能杀掉整棵进程树
    if let Some(pid) = child.id() {
        register_pid(app, tool_id, pid);
    }

    let (tx, mut rx) = tokio::sync::mpsc::unbounded_channel::<String>();

    if let Some(out) = child.stdout.take() {
        let tx = tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(out);
            let mut buf: Vec<u8> = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let text = decode_output(&buf);
                        if tx.send(text).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
    if let Some(err) = child.stderr.take() {
        let tx2 = tx.clone();
        tauri::async_runtime::spawn(async move {
            let mut reader = BufReader::new(err);
            let mut buf: Vec<u8> = Vec::new();
            loop {
                buf.clear();
                match reader.read_until(b'\n', &mut buf).await {
                    Ok(0) => break,
                    Ok(_) => {
                        let text = decode_output(&buf);
                        if tx2.send(text).is_err() {
                            break;
                        }
                    }
                    Err(_) => break,
                }
            }
        });
    }
    drop(tx);

    let mut collected = String::new();
    while let Some(text) = rx.recv().await {
        if let Some(pct) = parse_percent(&text) {
            let lower = text.to_lowercase();
            let phase =
                if lower.contains("download") || text.contains("下载") || lower.contains(" mb") {
                    "download"
                } else {
                    "install"
                };
            let _ = app.emit(
                event_name,
                ProgressPayload {
                    tool_id: tool_id.to_string(),
                    percent: pct,
                    message: text.trim().chars().take(180).collect(),
                    phase: phase.to_string(),
                },
            );
        }
        collected.push_str(&text);
        collected.push('\n');
    }

    let status = child
        .wait()
        .await
        .map_err(|e| format!("等待 winget 结束失败：{}", e))?;
    unregister_pid(app, tool_id);

    // 被取消的进程不管退出码是什么都按失败上报，让上层走回滚分支
    if cancel_requested(app, tool_id) {
        collected.push_str("\n[已由用户取消]\n");
        return Ok((false, collected));
    }

    Ok((status.success(), collected))
}

fn install_args(winget_id: &str, location: Option<&str>) -> Vec<String> {
    let mut args: Vec<String> = vec![
        "install".into(),
        "--id".into(),
        winget_id.to_string(),
        "--exact".into(),
        "--source".into(),
        "winget".into(),
        "--accept-package-agreements".into(),
        "--accept-source-agreements".into(),
        "--disable-interactivity".into(),
    ];
    if let Some(l) = location {
        args.push("--location".into());
        args.push(l.to_string());
    }
    args
}

// ─────────────────────────────────────────────────────────────
// PowerShell 助手（应用定位 / 快捷方式）
// ─────────────────────────────────────────────────────────────

const APP_LOOKUP_PS1: &str = include_str!("app_lookup.ps1");
const MAKE_SHORTCUT_PS1: &str = include_str!("make_shortcut.ps1");
const SCAN_LOCAL_PS1: &str = include_str!("scan_local.ps1");
const PURGE_STALE_PS1: &str = include_str!("purge_stale.ps1");

/// 把脚本正文编码成落盘字节：UTF-8 BOM + 正文。
///
/// 必须带 BOM：Windows PowerShell 5.1 在无 BOM 时按系统 ANSI（简中为 GBK）解码脚本，
/// 中文注释会被拆成非法字节，导致花括号配对失衡，报
/// `表达式或语句中包含意外的标记"}"`。
fn script_bytes(body: &str) -> Vec<u8> {
    let mut bytes = Vec::with_capacity(body.len() + 3);
    bytes.extend_from_slice(&[0xEF, 0xBB, 0xBF]);
    bytes.extend_from_slice(body.as_bytes());
    bytes
}

/// 把内嵌脚本写到数据目录，返回路径（每次覆盖，保证与程序同版本）
fn materialize_script(app: &AppHandle, name: &str, body: &str) -> Result<PathBuf, String> {
    let dir = data_dir(app)?.join("scripts");
    std::fs::create_dir_all(&dir).map_err(|e| format!("无法创建脚本目录: {e}"))?;
    let path = dir.join(name);
    std::fs::write(&path, script_bytes(body)).map_err(|e| format!("写入脚本失败: {e}"))?;
    Ok(path)
}

fn powershell_exe() -> String {
    // 64 位系统上 System32 里的 Windows PowerShell 一定存在
    let sys = std::env::var("SystemRoot").unwrap_or_else(|_| "C:\\Windows".to_string());
    format!("{sys}\\System32\\WindowsPowerShell\\v1.0\\powershell.exe")
}

async fn run_ps1(
    app: &AppHandle,
    script: &str,
    body: &str,
    envs: &[(&str, String)],
) -> Result<String, String> {
    let path = materialize_script(app, script, body)?;
    let mut cmd = Command::new(powershell_exe());
    cmd.arg("-NoProfile")
        .arg("-NonInteractive")
        .arg("-ExecutionPolicy")
        .arg("Bypass")
        .arg("-File")
        .arg(&path)
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null());
    for (k, v) in envs {
        cmd.env(k, v);
    }
    #[cfg(windows)]
    {
        cmd.creation_flags(0x0800_0000);
    }
    let out = cmd
        .output()
        .await
        .map_err(|e| format!("启动 PowerShell 失败: {e}"))?;
    let stdout = decode_output(&out.stdout);
    let stderr = decode_output(&out.stderr);
    if !out.status.success() && stdout.trim().is_empty() {
        log_line(app, "ps1", &format!("{script} 失败: {}", stderr.trim()));
        return Err(format!("脚本执行失败: {}", stderr.trim()));
    }
    Ok(stdout)
}

#[derive(Clone, serde::Serialize, serde::Deserialize)]
pub struct AppTarget {
    exe: Option<String>,
    workdir: Option<String>,
    #[serde(rename = "displayName")]
    display_name: Option<String>,
    /// 注册表 InstallLocation 回读值；用来核实"用户选的目录"是否真被安装器采纳
    #[serde(rename = "installLocation", default)]
    install_location: Option<String>,
    /// 注册表里的卸载命令，残留清理时回显给用户
    #[serde(rename = "uninstallString", default)]
    uninstall_string: Option<String>,
    /// 注册表有条目但主程序文件已不存在（安装残留）
    #[serde(default)]
    stale: Option<bool>,
    /// 命中的卸载注册表条目数
    #[serde(default)]
    matches: Option<u32>,
    source: Option<String>,
}

/// 缓存表：显示名 → 解析结果，避免每次点「打开」都跑一遍注册表扫描
///
/// 文件名带 CACHE_VERSION：解析策略改动后（例如修掉 Git 被定位成 git-lfs.exe），
/// 老缓存里的错误结果必须作废，否则用户升级后仍然打开错程序。
///
/// v3：AppTarget 新增 installLocation。v2 写下的条目没有这个字段，
/// 反序列化后是 None，而命中缓存的判定只要求 exe 存在，
/// 于是升级到 1.1.x 的用户做安装位置核对时永远拿不到注册表回读值。
const CACHE_VERSION: u32 = 3;

fn app_cache_path(app: &AppHandle) -> Result<PathBuf, String> {
    Ok(data_dir(app)?.join(format!("app-paths.v{CACHE_VERSION}.json")))
}

fn read_app_cache(app: &AppHandle) -> std::collections::HashMap<String, AppTarget> {
    let Ok(path) = app_cache_path(app) else {
        return Default::default();
    };
    let Ok(text) = std::fs::read_to_string(path) else {
        return Default::default();
    };
    serde_json::from_str(&text).unwrap_or_default()
}

fn write_app_cache(
    app: &AppHandle,
    map: &std::collections::HashMap<String, AppTarget>,
) -> Result<(), String> {
    let path = app_cache_path(app)?;
    let text = serde_json::to_string_pretty(map).map_err(|e| e.to_string())?;
    std::fs::write(path, text).map_err(|e| format!("写入应用路径缓存失败: {e}"))
}

async fn lookup_app(app: &AppHandle, name: &str) -> Option<AppTarget> {
    let mut cache = read_app_cache(app);
    if let Some(hit) = cache.get(name) {
        if let Some(exe) = &hit.exe {
            if Path::new(exe).exists() {
                return Some(hit.clone());
            }
        }
    }
    let out = run_ps1(
        app,
        "app_lookup.ps1",
        APP_LOOKUP_PS1,
        &[("TOOLARK_NAME", name.to_string())],
    )
    .await
    .ok()?;
    let line = out.lines().find(|l| l.trim_start().starts_with('{'))?;
    let parsed: AppTarget = serde_json::from_str(line.trim()).ok()?;
    if parsed.exe.is_none() {
        log_line(app, "lookup", &format!("未定位到应用: {name}"));
        return None;
    }
    cache.insert(name.to_string(), parsed.clone());
    let _ = write_app_cache(app, &cache);
    Some(parsed)
}

async fn create_shortcut(app: &AppHandle, name: &str, target: &AppTarget) -> Option<String> {
    let exe = target.exe.clone()?;
    let workdir = target.workdir.clone().unwrap_or_default();
    let out = run_ps1(
        app,
        "make_shortcut.ps1",
        MAKE_SHORTCUT_PS1,
        &[
            ("TOOLARK_TARGET", exe),
            ("TOOLARK_LNKNAME", name.to_string()),
            ("TOOLARK_WORKDIR", workdir),
        ],
    )
    .await
    .ok()?;
    let line = out.lines().find(|l| l.trim_start().starts_with('{'))?;
    let v: serde_json::Value = serde_json::from_str(line.trim()).ok()?;
    if v.get("ok").and_then(|x| x.as_bool()).unwrap_or(false) {
        v.get("path")
            .and_then(|x| x.as_str())
            .map(|s| s.to_string())
    } else {
        log_line(
            app,
            "shortcut",
            &format!(
                "创建快捷方式失败: {}",
                v.get("error").and_then(|x| x.as_str()).unwrap_or("?")
            ),
        );
        None
    }
}

// ─────────────────────────────────────────────────────────────
// 命令：安装 / 卸载
// ─────────────────────────────────────────────────────────────

/// 本机扫描出的一条软件记录（来自注册表 ARP 与 App Paths）
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct LocalApp {
    pub name: String,
    #[serde(default)]
    pub version: String,
    #[serde(default)]
    pub publisher: String,
    #[serde(rename = "installLocation", default)]
    pub install_location: Option<String>,
    #[serde(default)]
    pub exe: Option<String>,
    #[serde(default)]
    pub homepage: String,
    #[serde(rename = "uninstallString", default)]
    pub uninstall_string: String,
    #[serde(default)]
    pub scope: String,
    /// 注册表有条目但找不到程序文件 = 安装残留
    #[serde(default)]
    pub stale: bool,
}

/// 残留清理结果
#[derive(Clone, Debug, serde::Serialize, serde::Deserialize)]
pub struct PurgeResult {
    #[serde(default)]
    pub removed: usize,
    #[serde(default)]
    pub keys: Vec<String>,
    #[serde(default)]
    pub dirs: Vec<String>,
    #[serde(default)]
    pub errors: Vec<String>,
}

/// 扫描本机注册表里的全部软件（含未收录在 ToolArk 清单里的）
#[tauri::command]
async fn scan_local_apps(app: AppHandle) -> Result<Vec<LocalApp>, String> {
    let out = run_ps1(&app, "scan_local.ps1", SCAN_LOCAL_PS1, &[]).await?;
    let line = out
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('[') || l.trim_start().starts_with('{'))
        .ok_or_else(|| "扫描脚本没有返回数据".to_string())?;
    // ConvertTo-Json 在只有一项时会输出对象而不是数组，这里统一成数组再解析
    let text = line.trim();
    let items: Vec<LocalApp> = if text.starts_with('[') {
        serde_json::from_str(text).map_err(|e| format!("解析扫描结果失败: {e}"))?
    } else {
        vec![serde_json::from_str(text).map_err(|e| format!("解析扫描结果失败: {e}"))?]
    };
    log_line(&app, "scan-local", &format!("本机软件 {} 个", items.len()));
    Ok(items)
}

/// 清理某个软件的安装残留（注册表 Uninstall 条目 + 确认无主程序的空目录）
async fn purge_stale_entries(
    app: &AppHandle,
    name: &str,
    dry_run: bool,
) -> Result<PurgeResult, String> {
    let out = run_ps1(
        app,
        "purge_stale.ps1",
        PURGE_STALE_PS1,
        &[
            ("TOOLARK_NAME", name.to_string()),
            ("TOOLARK_DRYRUN", if dry_run { "1" } else { "0" }.to_string()),
        ],
    )
    .await?;
    let line = out
        .lines()
        .rev()
        .find(|l| l.trim_start().starts_with('{'))
        .ok_or_else(|| "清理脚本没有返回数据".to_string())?;
    let r: PurgeResult =
        serde_json::from_str(line.trim()).map_err(|e| format!("解析清理结果失败: {e}"))?;
    log_line(
        app,
        "purge",
        &format!(
            "{name}: dry_run={dry_run} removed={} dirs={} errors={}",
            r.removed,
            r.dirs.len(),
            r.errors.join("|")
        ),
    );
    Ok(r)
}

/// 清理安装残留（前端显式调用，用于「打开失败 → 一键清理」）
#[tauri::command]
async fn purge_stale(app: AppHandle, name: String) -> Result<String, String> {
    if name.trim().is_empty() || name.len() > 200 {
        return Err("无效的软件名".into());
    }
    let r = purge_stale_entries(&app, &name, false).await?;
    if r.removed == 0 {
        return Err(format!(
            "没找到 {name} 的残留注册表条目{}",
            if r.errors.is_empty() {
                String::new()
            } else {
                format!("（{}）", r.errors.join("；"))
            }
        ));
    }
    Ok(format!(
        "已清理 {} 条残留记录{}{}",
        r.removed,
        if r.dirs.is_empty() {
            String::new()
        } else {
            format!("、{} 个空目录", r.dirs.len())
        },
        if r.errors.is_empty() {
            String::new()
        } else {
            format!("；{} 项未能处理", r.errors.len())
        }
    ))
}

#[tauri::command]
fn cancel_install(app: AppHandle, tool_id: String) -> Result<String, String> {
    validate_id(&tool_id)?;
    if let Ok(mut s) = app.state::<RunRegistry>().cancelled.lock() {
        s.insert(tool_id.clone());
    }
    let pid = app
        .state::<RunRegistry>()
        .pids
        .lock()
        .ok()
        .and_then(|m| m.get(&tool_id).copied());
    let Some(pid) = pid else {
        return Ok("没有正在进行的安装".into());
    };
    // /T 连孙进程（msiexec、安装器本体）一起结束，只杀 winget 会留下孤儿安装进程
    let out = std::process::Command::new("taskkill")
        .args(["/PID", &pid.to_string(), "/T", "/F"])
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .stdin(Stdio::null())
        .output();
    let msg = match out {
        Ok(o) if o.status.success() => format!("已终止安装进程 {pid}"),
        Ok(o) => format!("终止进程返回 {}", o.status),
        Err(e) => return Err(format!("终止安装进程失败：{e}")),
    };
    log_line(&app, "cancel", &format!("{tool_id}: {msg}"));
    Ok(msg)
}

#[tauri::command]
async fn install_tool(
    app: AppHandle,
    tool_id: String,
    winget_id: String,
    name: String,
    install_location: Option<String>,
) -> Result<String, String> {
    validate_id(&tool_id)?;
    validate_id(&winget_id)?;

    // 清掉上一次同 ID 的取消标记，否则这次一开始就被判为已取消
    clear_cancel(&app, &tool_id);

    let location = install_location
        .map(|p| p.trim().to_string())
        .filter(|p| !p.is_empty());
    if let Some(ref loc) = location {
        if !loc
            .chars()
            .next()
            .map(|c| c.is_ascii_alphabetic())
            .unwrap_or(false)
            || !loc.contains(':')
            || loc.contains('\n')
            || loc.contains('\r')
            || loc.contains('"')
        {
            return Err(format!("安装路径无效：{loc}"));
        }
        if !Path::new(loc).exists() {
            std::fs::create_dir_all(loc).map_err(|e| format!("无法创建安装目录 {loc}: {e}"))?;
        }
    }

    log_line(
        &app,
        "install",
        &format!("开始 {name} ({winget_id}) location={location:?}"),
    );

    let mut used_location = location.is_some();
    let (mut ok, mut log) = run_winget_stream(
        &app,
        install_args(&winget_id, location.as_deref()),
        &tool_id,
        "install-progress",
    )
    .await?;

    // 部分安装器（MSI 等）不支持自定义位置：识别后自动回退默认路径重试
    if !ok && used_location {
        let unsupported = [
            "does not support a custom install location",
            "不支持",
            "--location",
            "0x8A15002B",
            "installer type",
        ]
        .iter()
        .any(|k| log.contains(k));
        if unsupported {
            used_location = false;
            let _ = app.emit(
                "install-progress",
                ProgressPayload {
                    tool_id: tool_id.clone(),
                    percent: 0,
                    message: "该安装器不支持自定义位置，正在改用默认路径…".into(),
                    phase: "install".into(),
                },
            );
            let (ok2, log2) = run_winget_stream(
                &app,
                install_args(&winget_id, None),
                &tool_id,
                "install-progress",
            )
            .await?;
            ok = ok2;
            log = log2;
        }
    }

    if !ok {
        let was_cancelled = cancel_requested(&app, &tool_id);
        log_line(
            &app,
            "install",
            &format!(
                "{} {name}: {}",
                if was_cancelled { "已取消" } else { "失败" },
                log.chars().take(500).collect::<String>()
            ),
        );
        let (rolled, _) = run_winget_stream(
            &app,
            vec![
                "uninstall".into(),
                "--id".into(),
                winget_id.clone(),
                "--exact".into(),
                "--source".into(),
                "winget".into(),
                "--disable-interactivity".into(),
            ],
            &tool_id,
            "install-progress",
        )
        .await?;
        clear_cancel(&app, &tool_id);
        // 用户主动取消不是"失败"，不要拿 winget 的堆栈去糊用户一脸
        if was_cancelled {
            return Err(format!(
                "已取消 {} 的安装{}",
                name,
                if rolled { "，残留已清理" } else { "" }
            ));
        }
        let suffix = if rolled {
            "；已自动回滚清理残留"
        } else {
            "；回滚未执行（包可能未安装）"
        };
        return Err(format!(
            "安装 {} 失败: {}{}",
            name,
            summarize(log.as_bytes(), b""),
            suffix
        ));
    }

    let _ = app.emit(
        "install-progress",
        ProgressPayload {
            tool_id: tool_id.clone(),
            percent: 100,
            message: "安装完成".into(),
            phase: "done".into(),
        },
    );

    let mut ids = read_records(&app);
    if !ids.contains(&tool_id) {
        ids.push(tool_id.clone());
        write_records(&app, &ids)?;
    }

    // 安装成功后：定位真实 exe 并建桌面快捷方式
    let mut notes: Vec<String> = Vec::new();
    let mut actual_location: Option<String> = None;
    match lookup_app(&app, &name).await {
        Some(target) => {
            actual_location = target.install_location.clone();
            if let Some(lnk) = create_shortcut(&app, &name, &target).await {
                let file = Path::new(&lnk)
                    .file_name()
                    .map(|s| s.to_string_lossy().to_string())
                    .unwrap_or(lnk);
                notes.push(format!("已创建桌面快捷方式 {file}"));
            } else {
                notes.push("未能创建桌面快捷方式（可手动右键程序创建）".into());
            }
        }
        None => notes.push("未能定位程序路径，快捷方式已跳过".into()),
    }

    // 位置提示必须来自注册表回读，不能信 winget 的退出码：
    // 大量 MSI 会静默忽略 --location 却仍然返回 0，用户选 D 盘却装进 C 盘。
    notes.push(describe_location(
        location.as_deref(),
        actual_location.as_deref(),
        used_location,
    ));
    log_line(
        &app,
        "install",
        &format!(
            "位置核对 {name}: 请求={location:?} 实际={actual_location:?} used_location={used_location}"
        ),
    );

    Ok(format!("{} 安装成功（{}）", name, notes.join("；")))
}

/// 把「请求的安装位置」与「注册表回读的真实位置」比对成一句人话。
fn describe_location(requested: Option<&str>, actual: Option<&str>, used_location: bool) -> String {
    let Some(req) = requested else {
        return match actual {
            Some(a) => format!("已安装到 {a}"),
            None => "已安装到默认位置".into(),
        };
    };
    let Some(act) = actual else {
        // 回读不到：只能如实说是推测值，不要给出"已装到自定义位置"这种臆断
        return if used_location {
            "安装器未报告安装目录，无法确认是否采用了你选择的路径".into()
        } else {
            "该工具不支持自定义位置，已装到默认路径".into()
        };
    };
    let norm = |s: &str| s.trim().trim_end_matches(['\\', '/']).to_lowercase();
    let (n_req, n_act) = (norm(req), norm(act));
    if n_req == n_act || n_act.starts_with(&format!("{n_req}\\")) {
        format!("已装到自定义位置 {act}")
    } else if used_location {
        format!("该安装器忽略了你指定的目录，实际装在 {act}")
    } else {
        format!("该工具不支持自定义位置，实际装在 {act}")
    }
}

#[tauri::command]
async fn uninstall_tool(
    app: AppHandle,
    tool_id: String,
    winget_id: String,
    name: String,
    clean_config: Option<bool>,
) -> Result<String, String> {
    validate_id(&tool_id)?;
    validate_id(&winget_id)?;

    let (ok, log) = run_winget_stream(
        &app,
        vec![
            "uninstall".into(),
            "--id".into(),
            winget_id.clone(),
            "--exact".into(),
            "--source".into(),
            "winget".into(),
            "--disable-interactivity".into(),
        ],
        &tool_id,
        "uninstall-progress",
    )
    .await?;

    if !ok {
        log_line(
            &app,
            "uninstall",
            &format!("失败 {name}: {}", log.chars().take(500).collect::<String>()),
        );

        // winget 卸载失败最常见的原因是安装器本身已丢失（0x800401f5 Application not found），
        // 此时 winget 仍认为包装着，但注册表里的卸载器指向一个不存在的文件。
        // 这种情况下自动降级为「清理注册表残留」，否则用户永远卸不掉这个幽灵条目。
        let looks_stale = log.contains("0x800401f5")
            || log.contains("Application not found")
            || log.contains("应用程序未找到")
            || log.contains("0x80070002");
        if looks_stale {
            match purge_stale_entries(&app, &name, false).await {
                Ok(p) if p.removed > 0 => {
                    let mut ids = read_records(&app);
                    ids.retain(|x| x != &tool_id);
                    let _ = write_records(&app, &ids);
                    log_line(
                        &app,
                        "uninstall",
                        &format!("{name} 卸载器丢失，已清理 {} 条残留注册表项", p.removed),
                    );
                    return Ok(format!(
                        "{} 的卸载程序已丢失，已改为清理安装残留：移除 {} 条注册表记录{}",
                        name,
                        p.removed,
                        if p.dirs.is_empty() {
                            String::new()
                        } else {
                            format!("、{} 个空目录", p.dirs.len())
                        }
                    ));
                }
                Ok(p) => {
                    return Err(format!(
                        "卸载 {} 失败：安装器已丢失，但自动清理没找到可移除的注册表条目（{}）。可在「设置 → 诊断」导出日志后手动清理。",
                        name,
                        if p.errors.is_empty() {
                            "无匹配项".to_string()
                        } else {
                            p.errors.join("；")
                        }
                    ));
                }
                Err(e) => {
                    return Err(format!(
                        "卸载 {} 失败：安装器已丢失，自动清理残留也出错（{}）。原始错误：{}",
                        name,
                        e,
                        summarize(log.as_bytes(), b"")
                    ));
                }
            }
        }

        return Err(format!(
            "卸载 {} 失败: {}",
            name,
            summarize(log.as_bytes(), b"")
        ));
    }

    let _ = app.emit(
        "uninstall-progress",
        ProgressPayload {
            tool_id: tool_id.clone(),
            percent: 100,
            message: "卸载完成".into(),
            phase: "done".into(),
        },
    );

    let mut ids = read_records(&app);
    ids.retain(|x| x != &tool_id);
    write_records(&app, &ids)?;

    if clean_config.unwrap_or(false) {
        let appdata = std::env::var("APPDATA").unwrap_or_default();
        if !appdata.is_empty() {
            let safe_name = tool_id.replace(|c: char| !c.is_ascii_alphanumeric() && c != '-', "_");
            let config_dir = Path::new(&appdata).join(&safe_name);
            if config_dir.exists() && config_dir.is_dir() {
                let _ = std::fs::remove_dir_all(&config_dir);
            }
        }
    }
    log_line(&app, "uninstall", &format!("完成 {name}"));
    Ok(format!(
        "{} 已卸载{}",
        name,
        if clean_config.unwrap_or(false) {
            "（含配置）"
        } else {
            ""
        }
    ))
}

// ─────────────────────────────────────────────────────────────
// 命令：已安装校准（以 winget list 为真相）
// ─────────────────────────────────────────────────────────────

#[derive(Clone, Debug, serde::Serialize)]
pub struct InstalledPackage {
    /// winget 包 ID（如 Microsoft.VisualStudioCode）
    id: String,
    /// 显示名
    name: String,
    /// 已安装版本
    version: String,
}

/// 解析 `winget list` / `winget upgrade` 的表格行。
///
/// 真实输出（winget 1.29）只有「名称 / ID / 版本 / 可用」四列，**没有 Source 列**，
/// 所以不能按"行尾必须是 winget"来判断。列宽还会因中文双宽字符错位，不能按固定
/// 偏移切。这里按"从右往左找包 ID"定位：ID 是含 '.'、全部 ASCII、且至少有一个
/// ASCII 字母的 token；ID 左边全是名称，右边第一段以数字开头的 token 是当前版本，
/// 再往右若是版本号则是可用版本。
fn parse_package_table(stdout: &str) -> Vec<InstalledPackage> {
    fn is_pkg_id(t: &str) -> bool {
        t.contains('.')
            && t.chars()
                .all(|c| c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == '+')
            && t.chars().any(|c| c.is_ascii_alphabetic())
    }
    fn is_version(t: &str) -> bool {
        t.chars()
            .next()
            .map(|c| c.is_ascii_digit())
            .unwrap_or(false)
            && t.chars()
                .all(|c| c.is_ascii_digit() || c == '.' || c == '-' || c == '+' || c == '_')
    }

    let mut out = Vec::new();
    for line in stdout.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty()
            || trimmed.starts_with('-')
            || trimmed.starts_with('\\')
            || trimmed.starts_with('=')
        {
            continue;
        }
        let tokens: Vec<&str> = trimmed.split_whitespace().collect();
        if tokens.len() < 2 {
            continue;
        }
        let first = tokens[0];
        if first == "Name" || first == "名称" || first.eq_ignore_ascii_case("name") {
            continue;
        }

        // 末尾若是 winget / msstore（带 Source 列的旧格式或 upgrade 输出），先剥掉
        let mut end = tokens.len();
        if end > 0 && (tokens[end - 1] == "winget" || tokens[end - 1] == "msstore") {
            end -= 1;
        }
        if end < 2 {
            continue;
        }

        // 从右往左找包 ID
        let mut id_idx: Option<usize> = None;
        for i in (0..end).rev() {
            if is_pkg_id(tokens[i]) {
                id_idx = Some(i);
                break;
            }
        }
        let Some(idx) = id_idx else { continue };
        if idx == 0 {
            // 没有名称列，只可能是表头或脏数据
            continue;
        }

        let id = tokens[idx].to_string();
        let name = tokens[..idx].join(" ");
        let version = tokens
            .get(idx + 1)
            .filter(|t| is_version(t))
            .map(|t| t.to_string())
            .unwrap_or_default();

        out.push(InstalledPackage { id, name, version });
    }
    out
}

/// 读取系统真实已安装的 winget 包列表。
/// 这一步是"已安装"状态的唯一真相来源：本地 installed.json 只做补充，
/// 用户用 winget 自己装的、或在外部卸载的，都能被纠正。
#[tauri::command]
async fn scan_installed(app: AppHandle) -> Result<Vec<InstalledPackage>, String> {
    let (_ok, log) = run_winget_stream(
        &app,
        vec![
            "list".into(),
            "--source".into(),
            "winget".into(),
            "--accept-source-agreements".into(),
            "--disable-interactivity".into(),
        ],
        "diag",
        "scan-progress",
    )
    .await?;
    let items = parse_package_table(&log);
    log_line(
        &app,
        "scan",
        &format!("winget list 解析出 {} 个包", items.len()),
    );
    Ok(items)
}

#[tauri::command]
fn list_installed(app: AppHandle) -> Result<Vec<String>, String> {
    Ok(read_records(&app))
}

#[tauri::command]
fn persist_installed(app: AppHandle, ids: Vec<String>) -> Result<(), String> {
    let mut clean: Vec<String> = Vec::new();
    for id in ids {
        if validate_id(&id).is_ok() && !clean.contains(&id) {
            clean.push(id);
        }
    }
    write_records(&app, &clean)
}

// ─────────────────────────────────────────────────────────────
// 命令：打开应用 / 快捷方式
// ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct OpenResult {
    ok: bool,
    message: String,
    exe: Option<String>,
    /// 安装残留（注册表有条目但程序文件已不在）：界面应引导清理而不是只报错
    stale: bool,
    /// 残留清理可用的软件名（就是传给清理脚本的名字）
    stale_name: Option<String>,
}

/// 打开已安装的应用
#[tauri::command]
async fn open_tool(
    app: AppHandle,
    name: String,
    _tool_id: Option<String>,
) -> Result<OpenResult, String> {
    let Some(target) = lookup_app(&app, &name).await else {
        // 连注册表条目都没命中：既可能是便携版，也可能是彻底没装
        return Ok(OpenResult {
            ok: false,
            message: format!(
                "没能找到 {name} 的安装记录。它可能已被卸载、或是免安装的绿色版——可以在「已安装」里移除这条记录，或重新安装一次。"
            ),
            exe: None,
            stale: true,
            stale_name: Some(name),
        });
    };

    let Some(exe) = target.exe.clone() else {
        // 注册表有条目但没有可执行文件：这是 ARP 残留
        let loc = target.install_location.clone().unwrap_or_default();
        let detail = if loc.is_empty() {
            "注册表里还留着它的卸载条目，但程序文件已经不在了。".to_string()
        } else {
            format!("注册表指向 {loc}，但那里的程序文件已经不在了。")
        };
        log_line(&app, "open", &format!("残留 {name}: {detail}"));
        return Ok(OpenResult {
            ok: false,
            message: format!("{detail}这是安装残留，可以一键清理掉。"),
            exe: None,
            stale: true,
            stale_name: Some(name),
        });
    };

    // 缓存可能指向已删除的文件（用户在资源管理器里手动删过目录）
    if !Path::new(&exe).exists() {
        log_line(&app, "open", &format!("残留 {name}: 缓存路径已失效 {exe}"));
        let mut cache = read_app_cache(&app);
        cache.remove(&name);
        let _ = write_app_cache(&app, &cache);
        return Ok(OpenResult {
            ok: false,
            message: format!("{name} 的程序文件 {exe} 已不存在，已清除失效的路径缓存。可以在「已安装」里清理这条残留记录。"),
            exe: None,
            stale: true,
            stale_name: Some(name),
        });
    }

    let mut cmd = std::process::Command::new(&exe);
    if let Some(dir) = &target.workdir {
        if Path::new(dir).exists() {
            cmd.current_dir(dir);
        }
    }
    #[cfg(windows)]
    {
        // DETACHED_PROCESS：不继承控制台，避免带出黑窗
        cmd.creation_flags(0x0000_0008);
    }
    match cmd.spawn() {
        Ok(_) => {
            log_line(&app, "open", &format!("启动 {name} → {exe}"));
            Ok(OpenResult {
                ok: true,
                message: format!("已启动 {name}"),
                exe: Some(exe),
                stale: false,
                stale_name: None,
            })
        }
        Err(e) => Ok(OpenResult {
            ok: false,
            message: format!("启动 {name} 失败：{e}（文件在 {exe}）"),
            exe: Some(exe),
            stale: false,
            stale_name: None,
        }),
    }
}

/// 查询程序位置（不启动），供详情页显示路径 / 判断是否可打开
#[tauri::command]
async fn resolve_app(app: AppHandle, name: String) -> Result<Option<AppTarget>, String> {
    Ok(lookup_app(&app, &name).await)
}

/// 手动（重新）创建桌面快捷方式
#[tauri::command]
async fn make_desktop_shortcut(app: AppHandle, name: String) -> Result<String, String> {
    let Some(target) = lookup_app(&app, &name).await else {
        return Err(format!("未能定位 {name} 的程序路径"));
    };
    match create_shortcut(&app, &name, &target).await {
        Some(path) => Ok(path),
        None => Err("创建桌面快捷方式失败".into()),
    }
}

/// 打开网址（官网 / 仓库 / 镜像下载）
#[tauri::command]
fn open_url(app: AppHandle, url: String) -> Result<(), String> {
    let lower = url.to_lowercase();
    if !(lower.starts_with("https://") || lower.starts_with("http://")) {
        return Err("只允许打开 http/https 链接".into());
    }
    log_line(&app, "open", &format!("打开链接 {url}"));
    #[cfg(windows)]
    {
        std::process::Command::new("cmd.exe")
            .args(["/c", "start", "", &url])
            .creation_flags(0x0800_0000)
            .spawn()
            .map_err(|e| format!("打开链接失败: {e}"))?;
    }
    #[cfg(not(windows))]
    {
        std::process::Command::new("xdg-open")
            .arg(&url)
            .spawn()
            .map_err(|e| format!("打开链接失败: {e}"))?;
    }
    Ok(())
}

// ─────────────────────────────────────────────────────────────
// 命令：网络诊断与 WinHTTP 代理
// ─────────────────────────────────────────────────────────────

#[derive(serde::Serialize)]
pub struct ProxyState {
    /// WinINET（浏览器/大部分程序）代理，如 127.0.0.1:6129
    user_proxy: Option<String>,
    user_proxy_enabled: bool,
    /// WinHTTP（winget 走这条）代理，空字符串表示直连
    winhttp_proxy: String,
}

#[tauri::command]
async fn get_proxy_state(app: AppHandle) -> Result<ProxyState, String> {
    // WinINET：HKCU\...\Internet Settings
    let out = run_ps1(&app, "proxy_state.ps1", PROXY_STATE_PS1, &[])
        .await
        .unwrap_or_else(|_| "{}".to_string());
    let line = out
        .lines()
        .find(|l| l.trim_start().starts_with('{'))
        .unwrap_or("{}");
    let v: serde_json::Value = serde_json::from_str(line.trim()).unwrap_or(serde_json::json!({}));
    Ok(ProxyState {
        user_proxy: v
            .get("userProxy")
            .and_then(|x| x.as_str())
            .filter(|s| !s.is_empty())
            .map(|s| s.to_string()),
        user_proxy_enabled: v
            .get("userProxyEnabled")
            .and_then(|x| x.as_bool())
            .unwrap_or(false),
        winhttp_proxy: v
            .get("winhttpProxy")
            .and_then(|x| x.as_str())
            .unwrap_or("")
            .to_string(),
    })
}

const PROXY_STATE_PS1: &str = r#"
$ErrorActionPreference = 'SilentlyContinue'
$key = 'HKCU:\Software\Microsoft\Windows\CurrentVersion\Internet Settings'
$p = Get-ItemProperty -Path $key
$userProxy = $null
if ($p.ProxyServer) { $userProxy = [string]$p.ProxyServer }
$enabled = $false
if ($p.ProxyEnable -eq 1) { $enabled = $true }
$winhttp = ''
try {
  $txt = & netsh winhttp show proxy 2>$null | Out-String
  if ($txt -match '(?im)^\s*(?:Proxy Server\(s\)|代理服务器)\s*:\s*(.+)$') {
    $v = $matches[1].Trim()
    if ($v -notmatch '(?i)direct|直接') { $winhttp = $v }
  }
} catch {}
$o = [ordered]@{ userProxy = $userProxy; userProxyEnabled = $enabled; winhttpProxy = $winhttp }
Write-Output ($o | ConvertTo-Json -Compress)
"#;

/// 把系统 WinINET 代理同步到 WinHTTP（winget 只认 WinHTTP）
/// 需要管理员权限，用 UAC 提权执行 netsh。
#[tauri::command]
async fn sync_winhttp_proxy(app: AppHandle, proxy: String) -> Result<String, String> {
    let proxy = proxy.trim().to_string();
    if proxy.is_empty() {
        return Err("代理地址为空".into());
    }
    // 只允许 host:port 形式，防止命令注入
    let ok_chars = proxy.chars().all(|c| {
        c.is_ascii_alphanumeric() || c == '.' || c == ':' || c == '-' || c == '[' || c == ']'
    });
    if !ok_chars || !proxy.contains(':') {
        return Err(format!("代理地址格式无效：{proxy}"));
    }
    let cmdline = format!("netsh winhttp set proxy {proxy}");
    let ps = format!(
        "Start-Process -FilePath 'netsh.exe' -ArgumentList 'winhttp','set','proxy','{}' -Verb RunAs -Wait -WindowStyle Hidden",
        proxy
    );
    let out = run_ps1(
        &app,
        "elevate_proxy.ps1",
        &format!(
            "$ErrorActionPreference='Stop'\n{}\nWrite-Output '{{\"ok\":true}}'",
            ps
        ),
        &[],
    )
    .await?;
    log_line(&app, "proxy", &format!("执行 {cmdline} → {}", out.trim()));
    Ok(format!("已将 WinHTTP 代理设为 {proxy}"))
}

/// 撤销 WinHTTP 代理（恢复直连）
#[tauri::command]
async fn reset_winhttp_proxy(app: AppHandle) -> Result<String, String> {
    let ps = "Start-Process -FilePath 'netsh.exe' -ArgumentList 'winhttp','reset','proxy' -Verb RunAs -Wait -WindowStyle Hidden";
    let out = run_ps1(
        &app,
        "elevate_proxy_reset.ps1",
        &format!(
            "$ErrorActionPreference='Stop'\n{}\nWrite-Output '{{\"ok\":true}}'",
            ps
        ),
        &[],
    )
    .await?;
    log_line(
        &app,
        "proxy",
        &format!("重置 WinHTTP 代理 → {}", out.trim()),
    );
    Ok("已恢复 WinHTTP 直连".into())
}

// ─────────────────────────────────────────────────────────────
// 命令：配置备份 / 升级 / 诊断
// ─────────────────────────────────────────────────────────────

#[tauri::command]
fn backup_configs() -> Result<serde_json::Value, String> {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    let mut entries = Vec::new();
    if !appdata.is_empty() {
        let base = Path::new(&appdata);
        let candidates = [
            ("vscode", "Code/User/settings.json"),
            ("starship", "starship.toml"),
            ("lazygit", "lazygit/config.yml"),
        ];
        for (tool, rel) in candidates {
            let path = base.join(rel);
            if let Ok(content) = std::fs::read_to_string(&path) {
                entries.push(serde_json::json!({
                    "toolId": tool,
                    "fileName": Path::new(rel).file_name().unwrap_or_default().to_string_lossy(),
                    "content": content,
                }));
            }
        }
    }
    Ok(serde_json::json!({
        "version": env!("CARGO_PKG_VERSION"),
        "exportedAt": chrono_now(),
        "entries": entries,
    }))
}

#[tauri::command]
fn restore_configs(snapshot: serde_json::Value) -> Result<String, String> {
    let appdata = std::env::var("APPDATA").unwrap_or_default();
    if appdata.is_empty() {
        return Err("无法定位 APPDATA".into());
    }
    let entries = snapshot
        .get("entries")
        .and_then(|v| v.as_array())
        .ok_or("备份格式无效")?;
    let map = [
        ("vscode", "Code/User/settings.json"),
        ("starship", "starship.toml"),
        ("lazygit", "lazygit/config.yml"),
    ];
    let mut count = 0;
    for entry in entries {
        let tool = entry.get("toolId").and_then(|v| v.as_str()).unwrap_or("");
        let content = entry.get("content").and_then(|v| v.as_str()).unwrap_or("");
        if let Some((_, rel)) = map.iter().find(|(t, _)| *t == tool) {
            let path = Path::new(&appdata).join(rel);
            if let Some(parent) = path.parent() {
                let _ = std::fs::create_dir_all(parent);
            }
            std::fs::write(&path, content).map_err(|e| format!("写入 {} 失败: {}", tool, e))?;
            count += 1;
        }
    }
    Ok(format!("已还原 {} 个配置文件", count))
}

fn chrono_now() -> String {
    let secs = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_secs())
        .unwrap_or(0);
    format!("{}", secs)
}

#[derive(serde::Serialize)]
struct Upgradable {
    winget_id: String,
    name: String,
    current: String,
    available: String,
}

#[tauri::command]
async fn list_upgradable(app: AppHandle) -> Result<Vec<Upgradable>, String> {
    let (_ok, log) = run_winget_stream(
        &app,
        vec![
            "upgrade".into(),
            "--include-unknown".into(),
            "--source".into(),
            "winget".into(),
            "--accept-source-agreements".into(),
            "--disable-interactivity".into(),
        ],
        "diag",
        "upgrade-scan",
    )
    .await?;

    let items: Vec<Upgradable> = parse_package_table(&log)
        .into_iter()
        .map(|p| Upgradable {
            winget_id: p.id,
            name: p.name,
            current: p.version,
            available: String::new(),
        })
        .collect();
    // 从原始表格补出 available 列（第 idx+2 个 token）
    let mut fixed = Vec::new();
    for line in log.lines() {
        let trimmed = line.trim();
        if trimmed.is_empty() || trimmed.starts_with('-') {
            continue;
        }
        let tokens: Vec<&str> = trimmed.split_whitespace().collect();
        if tokens.len() < 4 {
            continue;
        }
        let last = tokens[tokens.len() - 1];
        if last != "winget" && last != "msstore" {
            continue;
        }
        let mut id_idx = None;
        for i in (0..tokens.len() - 1).rev() {
            let t = tokens[i];
            if t.contains('.')
                && t.chars().all(|c| {
                    c.is_ascii_alphanumeric() || c == '.' || c == '_' || c == '-' || c == '+'
                })
                && t.chars().any(|c| c.is_ascii_alphabetic())
            {
                id_idx = Some(i);
                break;
            }
        }
        let Some(idx) = id_idx else { continue };
        if idx == 0 {
            continue;
        }
        let name = tokens[..idx].join(" ");
        let current = tokens.get(idx + 1).unwrap_or(&"").to_string();
        let available = tokens.get(idx + 2).unwrap_or(&"").to_string();
        fixed.push(Upgradable {
            winget_id: tokens[idx].to_string(),
            name,
            current,
            available,
        });
    }
    if fixed.is_empty() {
        Ok(items)
    } else {
        Ok(fixed)
    }
}

#[tauri::command]
async fn upgrade_tool(app: AppHandle, winget_id: String, name: String) -> Result<String, String> {
    validate_id(&winget_id)?;
    let (ok, log) = run_winget_stream(
        &app,
        vec![
            "upgrade".into(),
            "--id".into(),
            winget_id.clone(),
            "--exact".into(),
            "--source".into(),
            "winget".into(),
            "--accept-package-agreements".into(),
            "--accept-source-agreements".into(),
            "--disable-interactivity".into(),
        ],
        &winget_id,
        "upgrade-progress",
    )
    .await?;

    if !ok {
        log_line(
            &app,
            "upgrade",
            &format!("失败 {name}: {}", log.chars().take(500).collect::<String>()),
        );
        return Err(format!(
            "升级 {} 失败: {}",
            name,
            summarize(log.as_bytes(), b"")
        ));
    }
    log_line(&app, "upgrade", &format!("完成 {name}"));
    Ok(format!("{} 已升级", name))
}

/// 诊断：逐一尝试候选启动方式，报告真正可用的那个路径
#[tauri::command]
async fn check_winget(_app: AppHandle) -> Result<String, String> {
    let mut tried: Vec<String> = Vec::new();
    for (exe, prefix) in winget_candidates() {
        let mut cmd = Command::new(&exe);
        cmd.args(&prefix)
            .arg("--version")
            .stdout(Stdio::piped())
            .stderr(Stdio::piped())
            .stdin(Stdio::null());
        #[cfg(windows)]
        {
            cmd.creation_flags(0x0800_0000);
        }
        match cmd.output().await {
            Ok(out) if out.status.success() => {
                let ver = decode_output(&out.stdout)
                    .trim()
                    .lines()
                    .next()
                    .unwrap_or("winget")
                    .trim()
                    .to_string();
                return Ok(format!("{ver} · {exe}"));
            }
            Ok(out) => {
                let msg = decode_output(&out.stderr);
                tried.push(format!(
                    "{exe}（{}）",
                    msg.trim().chars().take(80).collect::<String>()
                ));
            }
            Err(e) => tried.push(format!("{exe}（{e}）")),
        }
    }
    Err(format!(
        "winget 不可用，已尝试 {} 种方式：{}",
        tried.len(),
        tried.join("；")
    ))
}

/// 读取日志（设置页展示 / 导出诊断包）
#[tauri::command]
fn read_logs(app: AppHandle, max_lines: Option<usize>) -> Result<String, String> {
    let Some(dir) = logs_dir(&app) else {
        return Ok(String::new());
    };
    let limit = max_lines.unwrap_or(400);
    let mut files: Vec<PathBuf> = std::fs::read_dir(&dir)
        .map_err(|e| e.to_string())?
        .flatten()
        .map(|e| e.path())
        .filter(|p| p.extension().and_then(|x| x.to_str()) == Some("log"))
        .collect();
    files.sort();
    let mut all: Vec<String> = Vec::new();
    for f in files {
        if let Ok(text) = std::fs::read_to_string(&f) {
            all.extend(text.lines().map(|l| l.to_string()));
        }
    }
    if all.len() > limit {
        all = all.split_off(all.len() - limit);
    }
    Ok(all.join("\n"))
}

/// 导出诊断信息（环境 + 日志），前端负责保存成文件
#[tauri::command]
async fn export_diagnostics(app: AppHandle) -> Result<String, String> {
    let winget = check_winget(app.clone()).await.unwrap_or_else(|e| e);
    let logs = read_logs(app.clone(), Some(600)).unwrap_or_default();
    let proxy = get_proxy_state(app.clone())
        .await
        .map(|p| {
            format!(
                "userProxy={:?} enabled={} winhttp={:?}",
                p.user_proxy, p.user_proxy_enabled, p.winhttp_proxy
            )
        })
        .unwrap_or_else(|e| e);
    Ok(format!(
        "ToolArk {} 诊断包\n时间(UNIX): {}\nOS: {} {}\nwinget: {}\nproxy: {}\n\n==== 日志 ====\n{}",
        env!("CARGO_PKG_VERSION"),
        chrono_now(),
        std::env::consts::OS,
        std::env::consts::ARCH,
        winget,
        proxy,
        logs
    ))
}

// ─────────────────────────────────────────────────────────────
// 单元测试：纯函数解析
// ─────────────────────────────────────────────────────────────

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn validate_id_rejects_injection() {
        assert!(validate_id("Microsoft.VisualStudioCode").is_ok());
        assert!(validate_id("a; rm -rf /").is_err());
        assert!(validate_id("a b").is_err());
        assert!(validate_id("").is_err());
    }

    #[test]
    fn parse_percent_takes_max() {
        assert_eq!(parse_percent("下载 10%"), Some(10));
        assert_eq!(parse_percent("10% 然后 88%"), Some(88));
        assert_eq!(parse_percent("没有百分比"), None);
        assert_eq!(parse_percent("100.4%"), Some(100));
    }

    #[test]
    fn parse_package_table_reads_winget_list() {
        let out = "\
Name                          Id                              Version      Available    Source
---------------------------------------------------------------------------------------------
Visual Studio Code            Microsoft.VisualStudioCode      1.95.0       1.96.0       winget
7-Zip 24.09 (x64)             7zip.7zip                       24.09                     winget
Git                           Git.Git                         2.47.0                    winget
";
        let items = parse_package_table(out);
        assert_eq!(items.len(), 3);
        assert_eq!(items[0].id, "Microsoft.VisualStudioCode");
        assert_eq!(items[0].version, "1.95.0");
        assert_eq!(items[1].id, "7zip.7zip");
        assert_eq!(items[1].name, "7-Zip 24.09 (x64)");
        assert_eq!(items[2].id, "Git.Git");
    }

    /// 真实 winget 1.29 的中文输出只有四列（名称/ID/版本/可用），没有 Source 列。
    /// 曾经因为强制要求行尾是 winget/msstore，导致 scan_installed 解析出 0 个包。
    #[test]
    fn parse_package_table_reads_real_four_column_output() {
        let out = "\
名称                                                         ID                                     版本            可用
---------------------------------------------------------------------------------------------------------------------------------
Apple Mobile Device Support                                  Apple.AppleMobileDeviceSupport         19.4.0.10       
Bandizip                                                     Bandisoft.Bandizip                     8.0 Beta 10     
Epic Games Launcher                                          EpicGames.EpicGamesLauncher            1.3.176.0       1.3.210.0
Git                                                          Git.Git                                2.56.1          
Microsoft Build of OpenJDK  17.0.18+8 (x64)                  Microsoft.OpenJDK.17                   17.0.18.8       17.0.21.102
Microsoft Visual C++ 2015 UWP Desktop Runtime Package        Microsoft.VCLibs.Desktop.14            14.0.33728.0    
";
        let items = parse_package_table(out);
        assert_eq!(items.len(), 6, "四列输出应全部解析出来，实际 {:?}", items);
        assert_eq!(items[0].id, "Apple.AppleMobileDeviceSupport");
        assert_eq!(items[0].name, "Apple Mobile Device Support");
        assert_eq!(items[0].version, "19.4.0.10");
        assert_eq!(items[1].id, "Bandisoft.Bandizip");
        // 版本号里带空格（"8.0 Beta 10"）时只取第一段数字，不报错即可
        assert_eq!(items[1].version, "8.0");
        assert_eq!(items[2].id, "EpicGames.EpicGamesLauncher");
        assert_eq!(items[2].name, "Epic Games Launcher");
        assert_eq!(items[3].id, "Git.Git");
        assert_eq!(items[3].version, "2.56.1");
        assert_eq!(items[4].id, "Microsoft.OpenJDK.17");
        assert_eq!(items[4].name, "Microsoft Build of OpenJDK 17.0.18+8 (x64)");
        assert_eq!(items[5].id, "Microsoft.VCLibs.Desktop.14");
    }

    /// 名称里带点的包（如 7-Zip 24.09）不能被误认成 ID。
    #[test]
    fn parse_package_table_prefers_rightmost_id() {
        let out = "7-Zip 24.09 (x64)   7zip.7zip   24.09\n";
        let items = parse_package_table(out);
        assert_eq!(items.len(), 1);
        assert_eq!(items[0].id, "7zip.7zip");
        assert_eq!(items[0].name, "7-Zip 24.09 (x64)");
    }

    #[test]
    fn parse_package_table_skips_header_and_short_lines() {
        assert!(parse_package_table("Name Id Version\n---\n").is_empty());
    }

    /// PowerShell 5.1 在无 BOM 时按 GBK 解码脚本，中文注释会让脚本解析失败。
    #[test]
    fn script_bytes_starts_with_utf8_bom() {
        let b = script_bytes("# 中文注释\nWrite-Output 1\n");
        assert_eq!(&b[..3], &[0xEF, 0xBB, 0xBF], "必须以 UTF-8 BOM 开头");
        let rest = std::str::from_utf8(&b[3..]).expect("正文应是合法 UTF-8");
        assert!(rest.starts_with("# 中文注释"));
        assert!(rest.contains("Write-Output 1"));
    }

    /// 内嵌的两个 PS1 脚本都必须含中文（否则 BOM 问题不会显现，测试也就失去意义）。
    #[test]
    fn embedded_scripts_contain_cjk() {
        assert!(APP_LOOKUP_PS1.chars().any(|c| c as u32 > 0x2E80));
        assert!(MAKE_SHORTCUT_PS1.chars().any(|c| c as u32 > 0x2E80));
    }

    /// 注册表回读值必须决定提示文案，不能靠 winget 退出码臆断"已装到自定义位置"。
    #[test]
    fn describe_location_compares_requested_with_registry_value() {
        // 一致（忽略大小写与尾部分隔符）
        assert_eq!(
            describe_location(Some("D:\\Apps\\Foo"), Some("d:\\apps\\foo\\"), true),
            "已装到自定义位置 d:\\apps\\foo\\"
        );
        // MSI 静默忽略 --location 但 winget 返回 0：必须如实说"忽略了你指定的目录"
        assert_eq!(
            describe_location(Some("D:\\Apps\\Foo"), Some("C:\\Program Files\\Foo"), true),
            "该安装器忽略了你指定的目录，实际装在 C:\\Program Files\\Foo"
        );
        // 不支持自定义位置
        assert_eq!(
            describe_location(Some("D:\\Apps\\Foo"), Some("C:\\Program Files\\Foo"), false),
            "该工具不支持自定义位置，实际装在 C:\\Program Files\\Foo"
        );
        // 回读不到：不能凭空断言装到了自定义位置
        assert_eq!(
            describe_location(Some("D:\\Apps\\Foo"), None, true),
            "安装器未报告安装目录，无法确认是否采用了你选择的路径"
        );
        // 未请求自定义位置
        assert_eq!(
            describe_location(None, Some("C:\\Program Files\\Foo"), false),
            "已安装到 C:\\Program Files\\Foo"
        );
        assert_eq!(describe_location(None, None, false), "已安装到默认位置");
    }
}

#[cfg_attr(mobile, tauri::mobile_entry_point)]
pub fn run() {
    tauri::Builder::default()
        // 单实例必须最先注册：重复启动时聚焦已有窗口，避免两个进程并发写 installed.json
        .plugin(tauri_plugin_single_instance::init(|app, _argv, _cwd| {
            if let Some(w) = app.get_webview_window("main") {
                let _ = w.unminimize();
                let _ = w.set_focus();
            }
        }))
        .plugin(tauri_plugin_updater::Builder::new().build())
        .plugin(tauri_plugin_process::init())
        .plugin(tauri_plugin_dialog::init())
        .manage(RunRegistry::default())
        .invoke_handler(tauri::generate_handler![
            install_tool,
            cancel_install,
            uninstall_tool,
            list_installed,
            persist_installed,
            scan_installed,
            open_tool,
            resolve_app,
            make_desktop_shortcut,
            open_url,
            get_proxy_state,
            sync_winhttp_proxy,
            reset_winhttp_proxy,
            backup_configs,
            restore_configs,
            list_upgradable,
            upgrade_tool,
            check_winget,
            read_logs,
            export_diagnostics,
            scan_local_apps,
            purge_stale
        ])
        .run(tauri::generate_context!())
        .expect("error while running tauri application");
}
