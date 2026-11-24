import { useCallback, useEffect, useMemo, useState } from 'react';
import { TOOLS, type CategoryId, type Tool, BUNDLES } from '../data/tools';
import {
  installTool,
  listInstalled,
  persistInstalled,
  uninstallTool,
  isTauri,
  listUpgradable,
  upgradeTool,
  loadFavorites,
  persistFavorites,
  scanInstalled,
  openTool,
  type UpgradableInfo,
} from '../lib/api';
import { searchTools, rankByDownloads } from '../lib/search';

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

  /** 用 winget list 校准已安装集合：用户自己装的能显示、手动卸载的会消失 */
  const refreshInstalled = useCallback(async () => {
    const local = await listInstalled();
    const packages = await scanInstalled();
    const next = calibrate(local, packages);
    setInstalled(next);
    // 校准结果回写，下次冷启动在 winget 不可用时仍有可用缓存
    if (packages !== null) persistInstalled([...next]);
    return next;
  }, []);

  useEffect(() => {
    void refreshInstalled();
  }, [refreshInstalled]);

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
  }, [view, query, installed, favorites]);

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
    }));
  }, [install.tool, install.location, markInstalled]);

  /** 启动已安装的工具（Rust 侧按 DisplayName 定位真实 exe） */
  const launchTool = useCallback(async (tool: Tool) => {
    setLaunching(tool.id);
    const r = await openTool(tool.name, tool.id);
    setLaunching(null);
    if (!r.ok) setToast(`启动失败：${r.message}`);
  }, []);

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
    install, openPreview, confirmInstall, closeInstall, setInstallLocation,
    uninstallTargets, uninstalling, uninstallProgress, requestUninstall, doUninstall, cancelUninstall,
    toast, closeToast,
    loadingBundle, installBundle, installTools,
    upgradable, checkingUpdates, upgrading, checkUpdates, doUpgrade,
    launching, launchTool, refreshInstalled,
    isTauri: isTauri(),
    total: TOOLS.length,
  };
}
