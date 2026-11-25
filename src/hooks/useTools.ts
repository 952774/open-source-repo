import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TOOLS, type CategoryId, type Tool, BUNDLES } from '../data/tools';
import {
  installTool,
  cancelInstall as cancelInstallApi,
  listInstalled,
  persistInstalled,
  uninstallTool,
  isTauri,
  listUpgradable,
  upgradeTool,
  loadFavorites,
  persistFavorites,
  scanInstalled,
  scanLocalApps,
  purgeStale,
  openTool,
  type UpgradableInfo,
  type LocalApp,
} from '../lib/api';
import { searchTools, rankByDownloads } from '../lib/search';
import { useDownloadsLive } from '../lib/downloadsLive';
import { buildLocalIndex, installedFromLocal } from '../lib/localMatch';

export type View = 'all' | 'featured' | 'installed' | 'favorites' | CategoryId;
export type InstallPhase = 'idle' | 'preview' | 'installing' | 'done' | 'error';

export interface InstallState {
  phase: InstallPhase;
  tool: Tool | null;
  message: string;
  /** 自定义安装位置（可选，留空用默认路径） */
  location: string;
  /** 安装进度百分比（0-100） */
  percent: number;
  /** 当前阶段：download / install / done */
  phase_hint: string;
  /** 是否已发出取消请求（UI 显示"正在取消…"并禁用按钮） */
  cancelling?: boolean;
}

const initialInstall: InstallState = { phase: 'idle', tool: null, message: '', location: '', percent: 0, phase_hint: '' };

/**
 * 把 winget 实际安装列表换算成「清单里哪些工具真的装着」。
 * winget 的包 ID 大小写不敏感，这里统一转小写比对。
 */
function calibrate(localIds: string[], packages: Array<{ id: string }> | null): Set<string> {
  if (packages === null) {
    // 拿不到 winget 列表时退回本地记录，至少不比之前更差
    return new Set(localIds);
  }
  const present = new Set(packages.map((p) => p.id.toLowerCase()));
  return new Set(TOOLS.filter((t) => present.has(t.wingetId.toLowerCase())).map((t) => t.id));
}

export function useTools(defaultLocation = '') {
  const [view, setView] = useState<View>('featured');
  const [query, setQuery] = useState('');
  const [installed, setInstalled] = useState<Set<string>>(new Set());
  const [selected, setSelected] = useState<Tool | null>(null);
  const [install, setInstall] = useState<InstallState>(initialInstall);
  const [favorites, setFavorites] = useState<Set<string>>(new Set<string>(loadFavorites()));
  const [toast, setToast] = useState<string | null>(null);
  const [loadingBundle, setLoadingBundle] = useState<string | null>(null);
  const [uninstallTargets, setUninstallTargets] = useState<Tool[] | null>(null);
  const [uninstalling, setUninstalling] = useState(false);
  const [uninstallProgress, setUninstallProgress] = useState({ index: 0, total: 0, percent: 0, currentName: '' });
  const [upgradable, setUpgradable] = useState<UpgradableInfo[]>([]);
  const [checkingUpdates, setCheckingUpdates] = useState(false);
  const [upgrading, setUpgrading] = useState(false);
  const [launching, setLaunching] = useState<string | null>(null);
  // 本机注册表扫描出的全部软件（不限于清单收录），「本机软件」视图用
  const [localApps, setLocalApps] = useState<LocalApp[]>([]);
  const [scanningLocal, setScanningLocal] = useState(false);
  // 打开失败但被判定为安装残留时，弹一键清理
  const [stalePrompt, setStalePrompt] = useState<{ name: string; message: string } | null>(null);
  // 后台刷新到新下载量后，让分类/全部视图重排
  const { version: downloadsVersion } = useDownloadsLive();

  const localIndex = useMemo(buildLocalIndex, []);
  // 手动标记的已安装（本次会话内安装成功的），registry 扫描可能还没跟上
  const markedRef = useRef<Set<string>>(new Set());

  /**
   * 校准已安装集合。两个来源合并：
   *   1. winget list —— 认 winget 数据库里的包
   *   2. 注册表 ARP 扫描 —— 认官方安装包/绿色版/手动装的开源软件
   * 只靠 winget 会把用户自己装好的 VS Code、Git 显示成"未安装"。
   */
  const refreshInstalled = useCallback(async () => {
    const [local, packages, apps] = await Promise.all([listInstalled(), scanInstalled(), scanLocalApps()]);
    setLocalApps(apps);
    const merged = calibrate(local, packages);
    for (const id of installedFromLocal(apps, localIndex)) merged.add(id);
    for (const id of markedRef.current) merged.add(id);
    setInstalled(merged);
    // 校准结果回写，下次冷启动在 winget 不可用时仍有可用缓存
    if (packages !== null || apps.length > 0) persistInstalled([...merged]);
    return merged;
  }, [localIndex]);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

  /**
   * 只重扫注册表（「本机软件」页的刷新按钮）。
   * 会把新发现的收录工具并入已安装集合，但不会移除 winget 认为装着的项。
   */
  const refreshLocalApps = useCallback(async () => {
    setScanningLocal(true);
    try {
      const apps = await scanLocalApps();
      setLocalApps(apps);
      const found = installedFromLocal(apps, localIndex);
      if (found.size > 0) {
        setInstalled((prev) => {
          const next = new Set(prev);
          for (const id of found) next.add(id);
          return next;
        });
      }
      return apps;
    } finally {
      setScanningLocal(false);
    }
  }, [localIndex]);

  const filtered = useMemo(() => {
    let list = TOOLS;
    if (view === 'featured') list = list.filter((t) => t.featured);
    else if (view === 'installed') list = list.filter((t) => installed.has(t.id));
    else if (view === 'favorites') list = list.filter((t) => favorites.has(t.id));
    else if (view !== 'all') list = list.filter((t) => t.category === view);
    const hits = searchTools(list, query);
    // 有搜索词：按相关度；无搜索词且是分类/全部视图：按真实下载量降序
    if (query.trim()) return hits.map((h) => h.tool);
    const isCategoryView = view !== 'installed' && view !== 'favorites';
    if (isCategoryView) return rankByDownloads(hits.map((h) => h.tool));
    return hits.map((h) => h.tool);
  }, [view, query, installed, favorites, downloadsVersion]);

  const toggleFavorite = useCallback((id: string) => {
    setFavorites((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      persistFavorites([...next]);
      return next;
    });
  }, []);

  const markInstalled = useCallback((id: string) => {
    // 记进 markedRef：注册表扫描有延迟，刚装完的不能被下一次 refresh 抹掉
    markedRef.current.add(id);
    setInstalled((prev) => {
      const next = new Set(prev);
      next.add(id);
      persistInstalled([...next]);
      return next;
    });
  }, []);

  const openPreview = useCallback((tool: Tool) => {
    setSelected(null);
    setInstall({ phase: 'preview', tool, message: '', location: defaultLocation, percent: 0, phase_hint: '' });
  }, [defaultLocation]);

  const setInstallLocation = useCallback((location: string) => {
    setInstall((prev) => ({ ...prev, location }));
  }, []);

  const confirmInstall = useCallback(async () => {
    const tool = install.tool;
    if (!tool) return;
    const location = install.location.trim();
    setInstall((prev) => ({ ...prev, phase: 'installing', message: '正在准备安装环境…', percent: 0, phase_hint: '' }));
    const result = await installTool(tool.id, tool.wingetId, tool.name, location || undefined, (p) => {
      setInstall((prev) =>
        prev.phase === 'installing'
          ? {
              ...prev,
              percent: Math.max(prev.percent, p.percent),
              message: p.message || prev.message,
              phase_hint: p.phase,
            }
          : prev,
      );
    });
    if (result.ok) markInstalled(tool.id);
    setInstall((prev) => ({
      ...prev,
      phase: result.ok ? 'done' : 'error',
      message: result.message,
      percent: result.ok ? 100 : prev.percent,
      cancelling: false,
    }));
  }, [install.tool, install.location, markInstalled]);

  /** 取消正在进行的安装：先置 UI 为取消中，再让 Rust 结束进程树 */
  const cancelInstall = useCallback(async () => {
    const tool = install.tool;
    if (!tool || install.phase !== 'installing') return;
    setInstall((prev) => ({ ...prev, cancelling: true, message: '正在终止安装进程…' }));
    const r = await cancelInstallApi(tool.id);
    if (!r.ok) {
      setToast(`取消失败：${r.message}`);
      setInstall((prev) => ({ ...prev, cancelling: false }));
    }
    // 成功时不必改动 phase：install_tool 的 Promise 很快会以取消原因 reject，
    // 由 confirmInstall 统一落到 error 分支并显示"已取消…"
  }, [install.tool, install.phase]);

  /** 启动已安装的工具（Rust 侧按 DisplayName 定位真实 exe） */
  const launchTool = useCallback(async (tool: Tool) => {
    setLaunching(tool.id);
    const r = await openTool(tool.name, tool.id);
    setLaunching(null);
    if (r.ok) return;
    // 定位失败且被判定为安装残留：不弹干巴巴的错误，直接给一键清理入口
    if (r.stale) {
      setStalePrompt({ name: r.staleName || tool.name, message: r.message });
      return;
    }
    setToast(`启动失败：${r.message}`);
  }, []);

  /** 清理安装残留，然后重新扫描本机软件 */
  const purgeStaleApp = useCallback(async (name: string) => {
    const r = await purgeStale(name);
    setStalePrompt(null);
    setToast(r.ok ? r.message : `清理失败：${r.message}`);
    if (r.ok) {
      await Promise.all([refreshInstalled(), refreshLocalApps()]);
    }
    return r;
  }, [refreshInstalled, refreshLocalApps]);

  const dismissStalePrompt = useCallback(() => setStalePrompt(null), []);

  /** 请求卸载：弹二次确认，不立即执行 */
  const requestUninstall = useCallback((tools: Tool | Tool[]) => {
    setSelected(null);
    setUninstallTargets(Array.isArray(tools) ? tools : [tools]);
  }, []);

  /** 检查已装工具是否有新版本 */
  const checkUpdates = useCallback(async () => {
    setCheckingUpdates(true);
    try {
      const items = await listUpgradable();
      if (items === null) {
        setToast('检查更新失败：无法调用 winget，请到「设置 → 运行环境」查看状态');
        return;
      }
      // 只保留清单里收录的工具
      const known = new Set(TOOLS.map((t) => t.wingetId.toLowerCase()));
      const found = items.filter((i) => known.has(i.wingetId.toLowerCase()));
      setUpgradable(found);
      setToast(found.length > 0 ? `发现 ${found.length} 款工具可更新` : '所有工具都已是最新版本');
    } finally {
      setCheckingUpdates(false);
    }
  }, []);

  const doUninstall = useCallback(async (cleanConfig = false) => {
    if (!uninstallTargets || uninstallTargets.length === 0) return;
    setUninstalling(true);
    const total = uninstallTargets.length;
    setUninstallProgress({ index: 0, total, percent: 0, currentName: uninstallTargets[0]?.name ?? '' });
    let okCount = 0;
    let failMsg = '';
    for (const [idx, tool] of uninstallTargets.entries()) {
      setUninstallProgress({ index: idx, total, percent: 0, currentName: tool.name });
      const result = await uninstallTool(tool.id, tool.wingetId, tool.name, cleanConfig, (p) => {
        setUninstallProgress({ index: idx, total, percent: p.percent, currentName: tool.name });
      });
      if (result.ok) {
        okCount++;
        markedRef.current.delete(tool.id);
        setInstalled((prev) => {
          const next = new Set(prev);
          next.delete(tool.id);
          persistInstalled([...next]);
          return next;
        });
      } else {
        failMsg = `${tool.name}: ${result.message}`;
      }
      setUninstallProgress({ index: idx + 1, total, percent: 0, currentName: tool.name });
    }
    setUninstalling(false);
    setUninstallTargets(null);
    setUninstallProgress({ index: 0, total: 0, percent: 0, currentName: '' });
    setToast(failMsg ? `已卸载 ${okCount} 款；失败：${failMsg}` : `已卸载 ${okCount} 款工具${cleanConfig ? '（含配置）' : ''}`);
    // 卸载后用 winget 实际状态再校准一次，避免残留
    void refreshInstalled();
    if (upgradable.length > 0) void checkUpdates();
  }, [uninstallTargets, upgradable.length, checkUpdates, refreshInstalled]);

  const cancelUninstall = useCallback(() => setUninstallTargets(null), []);

  const installBundle = useCallback(
    async (bundleId: string) => {
      const bundle = BUNDLES.find((b) => b.id === bundleId);
      if (!bundle) return;
      setLoadingBundle(bundleId);
      const todo = bundle.toolIds.filter((id) => !installed.has(id));
      if (todo.length === 0) {
        setToast('这个套装里的工具都已经装好了');
        setLoadingBundle(null);
        return;
      }
      const fails: string[] = [];
      for (const id of todo) {
        const tool = TOOLS.find((t) => t.id === id);
        if (!tool) continue;
        const result = await installTool(tool.id, tool.wingetId, tool.name);
        if (result.ok) markInstalled(id);
        else fails.push(tool.name);
      }
      setLoadingBundle(null);
      setToast(fails.length
        ? `套装「${bundle.name}」完成 ${todo.length - fails.length}/${todo.length}，失败：${fails.join('、')}`
        : `套装「${bundle.name}」全部安装完成`);
    },
    [installed, markInstalled],
  );

  /** 批量安装指定工具列表（场景向导用） */
  const installTools = useCallback(
    async (tools: Tool[]) => {
      const todo = tools.filter((t) => !installed.has(t.id));
      if (todo.length === 0) {
        setToast('这些工具都已经装好了');
        return;
      }
      setLoadingBundle('__custom__');
      let ok = 0;
      const fails: string[] = [];
      for (const tool of todo) {
        const result = await installTool(tool.id, tool.wingetId, tool.name);
        if (result.ok) { markInstalled(tool.id); ok++; }
        else fails.push(tool.name);
      }
      setLoadingBundle(null);
      setToast(fails.length ? `已安装 ${ok}/${todo.length} 款，失败：${fails.join('、')}` : `已安装 ${ok} 款推荐工具`);
    },
    [installed, markInstalled],
  );

  const closeToast = useCallback(() => setToast(null), []);
  const closeInstall = useCallback(() => setInstall(initialInstall), []);

  /** 一键升级（单款或全部） */
  const doUpgrade = useCallback(async (targets?: UpgradableInfo[]) => {
    const list = targets ?? upgradable;
    if (list.length === 0) return;
    setUpgrading(true);
    let ok = 0;
    const fails: string[] = [];
    for (const item of list) {
      const r = await upgradeTool(item.wingetId, item.name);
      if (r.ok) ok++;
      else fails.push(item.name);
    }
    setUpgrading(false);
    await checkUpdates();
    setToast(fails.length ? `已升级 ${ok} 款；失败：${fails.join('、')}` : `已升级 ${ok} 款工具`);
  }, [upgradable, checkUpdates]);

  return {
    view, setView, query, setQuery, filtered, installed, favorites, toggleFavorite,
    selected, setSelected,
    install, openPreview, confirmInstall, closeInstall, setInstallLocation, cancelInstall,
    uninstallTargets, uninstalling, uninstallProgress, requestUninstall, doUninstall, cancelUninstall,
    toast, closeToast,
    loadingBundle, installBundle, installTools,
    upgradable, checkingUpdates, upgrading, checkUpdates, doUpgrade,
    launching, launchTool, refreshInstalled,
    localApps, scanningLocal, refreshLocalApps,
    stalePrompt, purgeStaleApp, dismissStalePrompt,
    isTauri: isTauri(),
    total: TOOLS.length,
  };
}
