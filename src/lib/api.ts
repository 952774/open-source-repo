/**
 * 双模式适配层
 * - Tauri 环境：invoke 调用 Rust 后端，真实执行 winget
 * - 浏览器环境：模拟安装 + localStorage 记录，方便零依赖预览 UI
 */
import { invoke } from '@tauri-apps/api/core';
import { listen } from '@tauri-apps/api/event';

export const isTauri = () =>
  typeof window !== 'undefined' && '__TAURI_INTERNALS__' in window;

export interface CommandResult {
  ok: boolean;
  message: string;
}

/** winget 执行进度 */
export interface ProgressInfo {
  tool_id: string;
  percent: number;
  message: string;
  phase: 'download' | 'install' | 'done' | string;
}

type ProgressHandler = (p: ProgressInfo) => void;

const delay = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** 浏览器演示模式：模拟一段有起伏的进度，让 UI 效果可见 */
async function simulateProgress(onProgress?: ProgressHandler, totalMs = 1600) {
  if (!onProgress) {
    await delay(totalMs);
    return;
  }
  const steps = [8, 22, 37, 51, 66, 78, 88, 95, 100];
  const per = totalMs / steps.length;
  for (const pct of steps) {
    await delay(per);
    onProgress({
      tool_id: '',
      percent: pct,
      message: pct < 60 ? '演示模式：模拟下载中…' : '演示模式：模拟安装中…',
      phase: pct < 60 ? 'download' : 'install',
    });
  }
}

export async function installTool(
  toolId: string,
  wingetId: string,
  name: string,
  installLocation?: string,
  onProgress?: ProgressHandler,
): Promise<CommandResult> {
  if (isTauri()) {
    let unlisten: (() => void) | undefined;
    try {
      if (onProgress) {
        unlisten = await listen<ProgressInfo>('install-progress', (e) => {
          if (!e.payload.tool_id || e.payload.tool_id === toolId) onProgress(e.payload);
        });
      }
      const message = await invoke<string>('install_tool', {
        toolId,
        wingetId,
        name,
        installLocation: installLocation ?? null,
      });
      return { ok: true, message };
    } catch (err) {
      return { ok: false, message: String(err) };
    } finally {
      unlisten?.();
    }
  }
  await simulateProgress(onProgress);
  return {
    ok: true,
    message: `演示模式：已模拟安装「${name}」${installLocation ? `到 ${installLocation}` : ''}。安装 Rust 后运行 npm run tauri dev 即为真实安装。`,
  };
}

/**
 * 取消正在进行的安装。
 * Rust 侧会 taskkill /T 结束 winget 及其派生的 msiexec，然后按失败走回滚清理。
 */
export async function cancelInstall(toolId: string): Promise<CommandResult> {
  if (!isTauri()) return { ok: false, message: '仅桌面版可取消' };
  try {
    const message = await invoke<string>('cancel_install', { toolId });
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

/** 清理上次异常退出留下的孤儿安装进程（msiexec / setup.exe 等） */
export async function cleanOrphanInstallers(): Promise<CommandResult> {
  if (!isTauri()) return { ok: false, message: '仅桌面版可执行' };
  try {
    const message = await invoke<string>('clean_orphan_installers');
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

/** 打开系统目录选择器（仅桌面版；浏览器返回 null） */
export async function pickInstallDirectory(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { open } = await import('@tauri-apps/plugin-dialog');
    const picked = await open({ directory: true, multiple: false, title: '选择安装位置' });
    return typeof picked === 'string' ? picked : null;
  } catch {
    return null;
  }
}

/**
 * 暂停 / 继续正在进行的安装。
 *
 * 后端用 NtSuspendProcess 冻结整棵进程树（winget + 安装器 + 安装器的子进程），
 * 已下载的字节与内存都保留，继续时原地恢复，不从 0% 重来。
 */
export async function pauseInstall(
  toolId: string,
  paused: boolean,
): Promise<CommandResult> {
  if (!isTauri()) return { ok: false, message: '仅桌面版可暂停' };
  try {
    const message = await invoke<string>('pause_install', { toolId, paused });
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

/** 安装器体积探测结果 */
export interface PackageSize {
  ok: boolean;
  bytes: number;
  url: string;
  note: string;
}

/**
 * 查一个包要下载多少字节。
 * winget show 只有安装器 URL、没有体积字段，后端对 URL 发 HEAD 取 Content-Length。
 */
export async function fetchPackageSize(wingetId: string): Promise<PackageSize | null> {
  if (!isTauri() || !wingetId) return null;
  try {
    return await invoke<PackageSize>('fetch_package_size', { wingetId });
  } catch {
    return null;
  }
}

export interface ForceUninstallStep {
  text: string;
  done: boolean;
  detail: string;
}

export interface ForceUninstallResult {
  ok: boolean;
  steps: ForceUninstallStep[];
  removed: number;
  errors: string[];
}

/**
 * 强力卸载：不依赖安装器是否完好。
 * 按 Windows 卸载的实际组成逐项清理：进程 → 卸载器 → ARP 注册表 → 残留目录 → 快捷方式。
 */
export async function forceUninstall(input: {
  name: string;
  exe?: string | null;
  location?: string | null;
  uninstallString?: string | null;
  dryRun?: boolean;
}): Promise<ForceUninstallResult | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<ForceUninstallResult>('force_uninstall', {
      name: input.name,
      exe: input.exe ?? null,
      location: input.location ?? null,
      uninstallString: input.uninstallString ?? null,
      dryRun: input.dryRun ?? false,
    });
  } catch {
    return null;
  }
}

export interface CacheCleanResult {
  files: number;
  bytes: number;
  dirs: string[];
}

/** 清理 winget 下载缓存（取消/失败留下的安装器包，单个可能上 GB） */
export async function cleanDownloadCache(): Promise<CacheCleanResult | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<CacheCleanResult>('clean_download_cache');
  } catch {
    return null;
  }
}

export interface UpgradableInfo {
  wingetId: string;
  name: string;
  current: string;
  available: string;
}

/** 查询已安装且可升级的工具；null 表示检查失败（与没有更新区分） */
export async function listUpgradable(): Promise<UpgradableInfo[] | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<UpgradableInfo[]>('list_upgradable');
  } catch {
    return null;
  }
}

/** 升级指定工具 */
export async function upgradeTool(
  wingetId: string,
  name: string,
  onProgress?: ProgressHandler,
): Promise<CommandResult> {
  if (isTauri()) {
    let unlisten: (() => void) | undefined;
    try {
      if (onProgress) {
        unlisten = await listen<ProgressInfo>('upgrade-progress', (e) => onProgress(e.payload));
      }
      const message = await invoke<string>('upgrade_tool', { wingetId, name });
      return { ok: true, message };
    } catch (err) {
      return { ok: false, message: String(err) };
    } finally {
      unlisten?.();
    }
  }
  await simulateProgress(onProgress, 1200);
  return { ok: true, message: `演示模式：已模拟升级「${name}」` };
}

export async function uninstallTool(
  toolId: string,
  wingetId: string,
  name: string,
  cleanConfig = false,
  onProgress?: ProgressHandler,
): Promise<CommandResult> {
  if (isTauri()) {
    let unlisten: (() => void) | undefined;
    try {
      if (onProgress) {
        unlisten = await listen<ProgressInfo>('uninstall-progress', (e) => {
          if (!e.payload.tool_id || e.payload.tool_id === toolId) onProgress(e.payload);
        });
      }
      const message = await invoke<string>('uninstall_tool', { toolId, wingetId, name, cleanConfig });
      return { ok: true, message };
    } catch (err) {
      return { ok: false, message: String(err) };
    } finally {
      unlisten?.();
    }
  }
  await simulateProgress(onProgress, 900);
  return { ok: true, message: `演示模式：已模拟卸载「${name}」${cleanConfig ? '并清理配置' : ''}。` };
}

/* ---------- 已安装状态 ---------- */

export interface InstalledPackage {
  id: string;
  name: string;
  version: string;
}

/**
 * 读取本地记录的已安装工具 ID（只做补充）。
 * 真正的"装没装"由 scanInstalled() 查 winget list 决定。
 */
export async function listInstalled(): Promise<string[]> {
  if (isTauri()) {
    try {
      return await invoke<string[]>('list_installed');
    } catch {
      return [];
    }
  }
  try {
    return JSON.parse(localStorage.getItem('toolark-installed') || '[]');
  } catch {
    return [];
  }
}

/** 把校准后的已安装 ID 写回本地记录 */
export async function persistInstalled(ids: string[]): Promise<void> {
  if (isTauri()) {
    try {
      await invoke('persist_installed', { ids });
    } catch {
      /* 写入失败不影响 UI */
    }
    return;
  }
  localStorage.setItem('toolark-installed', JSON.stringify(ids));
}

/**
 * 扫描系统真实已安装的 winget 包。
 * 这是"已安装"的唯一真相来源：用户自己在命令行装的、在别处卸载的，都能纠正过来。
 * 返回 null 表示扫描失败（例如 winget 不可用），此时退回本地记录。
 */
export async function scanInstalled(): Promise<InstalledPackage[] | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<InstalledPackage[]>('scan_installed');
  } catch {
    return null;
  }
}

/* ---------- 打开应用 / 快捷方式 ---------- */

export interface OpenResult {
  ok: boolean;
  message: string;
  exe: string | null;
  /** 安装残留（注册表有条目但程序文件已不在），界面应引导一键清理 */
  stale?: boolean;
  /** 清理残留时传给 purge_stale 的软件名 */
  staleName?: string | null;
}

export interface AppTarget {
  exe: string | null;
  workdir: string | null;
  displayName: string | null;
  /** 注册表 InstallLocation 回读值，用来核实安装位置是否被安装器采纳 */
  installLocation?: string | null;
  source: string | null;
}

/** 启动已安装的应用 */
export async function openTool(name: string, toolId?: string): Promise<OpenResult> {
  if (!isTauri()) {
    return { ok: false, message: '打开应用仅在桌面版可用', exe: null };
  }
  try {
    return await invoke<OpenResult>('open_tool', { name, toolId: toolId ?? null });
  } catch (err) {
    return { ok: false, message: String(err), exe: null };
  }
}

/* ---------- 本机软件扫描 / 残留清理 ---------- */

/** 注册表里扫描到的一条本机软件 */
export interface LocalApp {
  name: string;
  version: string;
  publisher: string;
  installLocation: string | null;
  exe: string | null;
  homepage: string;
  uninstallString: string;
  scope: string;
  /** 注册表有条目但程序文件已不在 = 安装残留 */
  stale: boolean;
}

/**
 * 扫描本机注册表里的全部软件（不限于 ToolArk 收录的清单）。
 * 用于「本机软件」视图：用户已经装过的东西不该再显示成"未安装"。
 */
export async function scanLocalApps(): Promise<LocalApp[]> {
  if (!isTauri()) return [];
  try {
    return await invoke<LocalApp[]>('scan_local_apps');
  } catch {
    return [];
  }
}

/** 清理某个软件的安装残留（注册表条目 + 确认无主程序的空目录） */
export async function purgeStale(name: string): Promise<CommandResult> {
  if (!isTauri()) return { ok: false, message: '仅桌面版可用' };
  try {
    const message = await invoke<string>('purge_stale', { name });
    return { ok: true, message };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

/** 查询应用的可执行文件路径（不启动） */
export async function resolveApp(name: string): Promise<AppTarget | null> {
  if (!isTauri()) return null;
  try {
    return await invoke<AppTarget | null>('resolve_app', { name });
  } catch {
    return null;
  }
}

/** 重新创建桌面快捷方式，返回 .lnk 路径 */
export async function makeDesktopShortcut(name: string): Promise<CommandResult> {
  if (!isTauri()) return { ok: false, message: '仅桌面版可用' };
  try {
    const path = await invoke<string>('make_desktop_shortcut', { name });
    return { ok: true, message: path };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

/** 用系统默认浏览器打开链接 */
export async function openUrl(url: string): Promise<boolean> {
  if (isTauri()) {
    try {
      await invoke('open_url', { url });
      return true;
    } catch {
      return false;
    }
  }
  window.open(url, '_blank', 'noopener,noreferrer');
  return true;
}

/* ---------- 网络诊断 ---------- */

export interface ProxyState {
  userProxy: string | null;
  userProxyEnabled: boolean;
  winhttpProxy: string;
}

export async function getProxyState(): Promise<ProxyState | null> {
  if (!isTauri()) return null;
  try {
    const raw = await invoke<{ user_proxy: string | null; user_proxy_enabled: boolean; winhttp_proxy: string }>(
      'get_proxy_state',
    );
    return {
      userProxy: raw.user_proxy,
      userProxyEnabled: raw.user_proxy_enabled,
      winhttpProxy: raw.winhttp_proxy,
    };
  } catch {
    return null;
  }
}

/** 把代理同步到 WinHTTP（winget 走 WinHTTP，不读浏览器代理），会弹 UAC */
export async function syncWinhttpProxy(proxy: string): Promise<CommandResult> {
  if (!isTauri()) return { ok: false, message: '仅桌面版可用' };
  try {
    const msg = await invoke<string>('sync_winhttp_proxy', { proxy });
    return { ok: true, message: msg };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

/** 撤销 WinHTTP 代理，恢复直连 */
export async function resetWinhttpProxy(): Promise<CommandResult> {
  if (!isTauri()) return { ok: false, message: '仅桌面版可用' };
  try {
    const msg = await invoke<string>('reset_winhttp_proxy');
    return { ok: true, message: msg };
  } catch (err) {
    return { ok: false, message: String(err) };
  }
}

/* ---------- 日志与诊断 ---------- */

export async function readLogs(maxLines = 400): Promise<string> {
  if (!isTauri()) return '';
  try {
    return await invoke<string>('read_logs', { maxLines });
  } catch {
    return '';
  }
}

export async function exportDiagnostics(): Promise<string> {
  if (!isTauri()) return '';
  try {
    return await invoke<string>('export_diagnostics');
  } catch {
    return '';
  }
}

/* ---------- 收藏（本地持久化，桌面与浏览器一致） ---------- */
const FAV_KEY = 'toolark-favorites';

export function loadFavorites(): string[] {
  try {
    const raw = localStorage.getItem(FAV_KEY);
    return raw ? (JSON.parse(raw) as string[]) : [];
  } catch {
    return [];
  }
}

export function persistFavorites(ids: string[]) {
  try {
    localStorage.setItem(FAV_KEY, JSON.stringify(ids));
  } catch {
    /* 忽略存储失败 */
  }
}

/** 诊断 winget 是否可用（返回版本字符串，失败抛错信息） */
export async function checkWinget(): Promise<{ ok: boolean; detail: string }> {
  if (!isTauri()) return { ok: false, detail: '浏览器预览模式不可用' };
  try {
    const v = await invoke<string>('check_winget');
    return { ok: true, detail: v };
  } catch (err) {
    return { ok: false, detail: String(err) };
  }
}

/* ---------- 网络错误识别 ---------- */

export interface NetworkHint {
  kind: 'proxy' | 'dns' | 'unknown';
  title: string;
  detail: string;
  /** 是否建议走 WinHTTP 代理 */
  suggestProxy: boolean;
}

/**
 * 识别 winget 下载失败的错误码。
 * winget 走 WinHTTP 而不是浏览器代理，所以即使用户浏览器能上 GitHub，
 * 装 GitHub Releases 上的安装包仍会 0x80072efd（无法解析/连接）。
 */
export function analyzeNetworkError(message: string): NetworkHint | null {
  const m = message.toLowerCase();
  const has = (...keys: string[]) => keys.some((k) => m.includes(k));

  if (has('0x80072efd', '12029', '0x80072ee7', '12007', '0x80072ee2', '12002')) {
    return {
      kind: 'proxy',
      title: '下载被网络阻断',
      detail:
        'winget 走 WinHTTP 通道，不读浏览器/系统 IE 代理设置。该工具的安装包托管在 GitHub Releases，直连会超时。可以：① 一键把当前系统代理同步到 WinHTTP；② 用浏览器手动下载安装包；③ 打开官网换用镜像源。',
      suggestProxy: true,
    };
  }
  if (has('0x80072ee2', 'timeout', '超时')) {
    return {
      kind: 'dns',
      title: '连接超时',
      detail: '到下载源的连接超时。可先重试一次；若持续失败，把系统代理同步到 WinHTTP 后再试。',
      suggestProxy: true,
    };
  }
  if (has('0x80070005', 'access is denied', '拒绝访问')) {
    return {
      kind: 'unknown',
      title: '权限不足',
      detail: '安装器需要管理员权限。请确认 UAC 提示已允许，或改用系统级安装。',
      suggestProxy: false,
    };
  }
  return null;
}
