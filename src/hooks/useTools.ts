import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { TOOLS, type CategoryId, type Tool, BUNDLES } from '../data/tools';
import {
  installTool,
  cancelInstall as cancelInstallApi,
  pauseInstall as pauseInstallApi,
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
  forceUninstall,
  cleanDownloadCache,
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

/** 后台安装队列里的一项 */
export interface InstallJob {
  /** 队列内唯一键：同一工具重复入队时用序号区分 */
  key: string;
  toolId: string;
  name: string;
  phase: 'queued' | 'running' | 'paused' | 'done' | 'error' | 'cancelled';
  percent: number;
  /** download / install / done */
  hint: string;
  message: string;
  location: string;
}

/** 判断一个工具是否还在队列里跑着（同工具不重复入队） */
function isActive(j: InstallJob) {
  return j.phase === 'queued' || j.phase === 'running' || j.phase === 'paused';
}

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
  /** 强力卸载中的软件名（按钮显示进度） */
  const [forceBusy, setForceBusy] = useState<string | null>(null);
  /** 清缓存中 */
  const [cacheBusy, setCacheBusy] = useState(false);
  const [scanningLocal, setScanningLocal] = useState(false);
  // 打开失败但被判定为安装残留时，弹一键清理
  const [stalePrompt, setStalePrompt] = useState<{ name: string; message: string } | null>(null);
  // 后台安装队列：关掉安装窗也能继续装，用户可以去挑别的软件
  const [jobs, setJobs] = useState<InstallJob[]>([]);
  const queueRef = useRef<InstallJob[]>([]);
  // 队列串行执行：winget 自己也会串行装，并发跑两个会争抢同一个 msiexec
  const pumpingRef = useRef(false);
  /** pump 的引用，供「继续」等外部动作重新唤醒队列（避免闭包循环依赖） */
  const pumpRef = useRef<() => void>(() => {});
  // 后台刷新到新下载量后，让分类/全部视图重排
  const { version: downloadsVersion } = useDownloadsLive();

  /** 队列状态同时写进 ref 和 state：pump 循环里要读到最新值，不能依赖闭包 */
  const syncJobs = useCallback(() => {
    setJobs([...queueRef.current]);
  }, []);

  const patchJob = useCallback((key: string, patch: Partial<InstallJob>) => {
    queueRef.current = queueRef.current.map((j) => (j.key === key ? { ...j, ...patch } : j));
    syncJobs();
  }, [syncJobs]);

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
    // 不在这里等安装跑完：winget 装一个包动辄几分钟，把用户锁在模态框里
    // 就没法继续挑别的软件。入队后立刻关窗，进度转到「正在下载」面板。
    enqueue([tool], location);
    setInstall(initialInstall);
    setToast(`已加入下载队列：${tool.name}`);
  }, [install.tool, install.location]);

  /** 取消队列里某一项：先置 UI 为取消中，再让 Rust 结束整棵进程树 */
  const cancelJob = useCallback(async (key: string) => {
    const job = queueRef.current.find((j) => j.key === key);
    if (!job || !isActive(job)) return;
    patchJob(key, { message: '正在终止安装进程…' });
    const r = await cancelInstallApi(job.toolId);
    if (!r.ok) {
      setToast(`取消失败：${r.message}`);
      patchJob(key, { message: job.message });
      return;
    }
    // Rust 侧会把「杀掉几个进程、清了几个孤儿、释放多少下载残留」都算出来，
    // 直接回显给用户——取消后风扇停了，得让人知道是工具干的。
    if (r.message && r.message !== '没有正在进行的安装') {
      setToast(r.message);
    }
    // 队列里排队的项直接标成已取消，不必等 pump（它此刻正卡在被取消的那一项上）
    if (job.phase === 'queued') {
      patchJob(key, { phase: 'cancelled', message: '已取消' });
    }
    // 成功时 running 项不必改 phase：install_tool 的 Promise 会以取消原因 reject，
    // 由 pump 统一落到 cancelled 分支
  }, [patchJob]);

  /** 暂停 / 继续某一项（冻结整棵进程树，已下载字节保留） */
  const togglePauseJob = useCallback(async (key: string) => {
    const job = queueRef.current.find((j) => j.key === key);
    if (!job) return;
    const wantPause = job.phase === 'running';
    if (job.phase !== 'running' && job.phase !== 'paused') return;
    const r = await pauseInstallApi(job.toolId, wantPause);
    if (!r.ok) {
      setToast(`${wantPause ? '暂停' : '继续'}失败：${r.message}`);
      return;
    }
    patchJob(key, {
      phase: wantPause ? 'paused' : 'running',
      message: wantPause ? '已暂停（进程已冻结，字节保留）' : job.message,
    });
    // 继续之后要重新唤醒队列：暂停时 pump 已经退出了，
    // 不重新启动的话后面排队的项会一直卡在「排队中」。
    if (!wantPause) pumpRef.current();
  }, [patchJob]);

  /** 清掉已完成/失败/已取消的项 */
  const clearFinishedJobs = useCallback(() => {
    queueRef.current = queueRef.current.filter(isActive);
    syncJobs();
  }, [syncJobs]);

  /** 移除单项（仅限已结束的） */
  const dismissJob = useCallback((key: string) => {
    queueRef.current = queueRef.current.filter((j) => j.key !== key || isActive(j));
    syncJobs();
  }, [syncJobs]);

  /**
   * 队列执行器：串行取下一个排队项跑安装。
   *
   * 串行的原因：winget 内部对 msiexec 是独占的，两个 install 并发跑会互相
   * 抢锁、报 0x800700aa（资源忙）。用户要的是"能一边装一边挑软件"，不是
   * "同时装十个"，串行足够。
   */
  const pump = useCallback(async () => {
    if (pumpingRef.current) return;
    pumpingRef.current = true;
    try {
      for (;;) {
        // 有任务被暂停时不能再开下一个：暂停只是把 winget 与安装器进程挂起，
        // 它们的文件锁和 msiexec 独占还握着，此时并发装第二个必炸。
        if (queueRef.current.some((j) => j.phase === 'paused' || j.phase === 'running')) break;
        const next = queueRef.current.find((j) => j.phase === 'queued');
        if (!next) break;
        const tool = TOOLS.find((t) => t.id === next.toolId);
        if (!tool) {
          patchJob(next.key, { phase: 'error', message: '清单里找不到这个工具' });
          continue;
        }
        patchJob(next.key, { phase: 'running', message: '正在准备安装环境…', percent: 0, hint: '' });

        const result = await installTool(
          tool.id,
          tool.wingetId,
          tool.name,
          next.location || undefined,
          (p) => {
            // 进度只增不减：winget 回退阶段会重新从 0 开始报，直接覆盖会让进度条倒退
            const cur = queueRef.current.find((j) => j.key === next.key);
            if (!cur || cur.phase === 'paused') return;
            patchJob(next.key, {
              percent: Math.max(cur.percent, p.percent),
              message: p.message || cur.message,
              hint: p.phase,
            });
          },
        );

        if (result.ok) {
          markInstalled(tool.id);
          patchJob(next.key, { phase: 'done', percent: 100, message: result.message });
        } else {
          // 取消不是失败：UI 上分开显示，不要把 winget 的堆栈糊给用户
          const cancelled = /已取消|已由用户取消/.test(result.message);
          patchJob(next.key, {
            phase: cancelled ? 'cancelled' : 'error',
            message: result.message,
          });
        }
        // 每个包结束后重扫一次：安装器改注册表有延迟，靠下一次 refresh 才能看到
        void refreshInstalled();
      }
    } finally {
      pumpingRef.current = false;
    }
  }, [patchJob, markInstalled, refreshInstalled]);

  // pump 定义之后回填引用：togglePauseJob 需要在「继续」时重新驱动队列，
  // 但直接把它列进依赖会让两个 useCallback 互相依赖。
  useEffect(() => {
    pumpRef.current = () => {
      void pump();
    };
  }, [pump]);

  /** 入队：已在队列里的同工具不重复加，避免用户连点「获取」塞进去一串 */
  const enqueue = useCallback((tools: Tool[], location = '') => {
    const fresh = tools.filter(
      (t) => !queueRef.current.some((j) => j.toolId === t.id && isActive(j)),
    );
    if (fresh.length === 0) {
      setToast('这些工具已经在下载队列里了');
      return;
    }
    const stamp = Date.now();
    queueRef.current = [
      ...queueRef.current,
      ...fresh.map((t, i) => ({
        key: `${t.id}-${stamp}-${i}`,
        toolId: t.id,
        name: t.name,
        phase: 'queued' as const,
        percent: 0,
        hint: '',
        message: '排队中',
        location,
      })),
    ];
    syncJobs();
    void pump();
  }, [pump, syncJobs]);

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

  /**
   * 套装安装：不再在点击处死等，改为整批入队。
   * 用户点完可以去挑别的软件，队列在后台一个个装。
   */
  const installBundle = useCallback(
    (bundleId: string) => {
      const bundle = BUNDLES.find((b) => b.id === bundleId);
      if (!bundle) return;
      const todo = bundle.toolIds
        .map((id) => TOOLS.find((t) => t.id === id))
        .filter((t): t is Tool => !!t && !installed.has(t.id));
      if (todo.length === 0) {
        setToast('这个套装里的工具都已经装好了');
        return;
      }
      enqueue(todo);
      setToast(`套装「${bundle.name}」${todo.length} 款已加入下载队列`);
    },
    [installed, enqueue],
  );

  /** 批量安装指定工具列表（场景向导 / 套装二级菜单用） */
  const installTools = useCallback(
    (tools: Tool[]) => {
      const todo = tools.filter((t) => !installed.has(t.id));
      if (todo.length === 0) {
        setToast('这些工具都已经装好了');
        return;
      }
      enqueue(todo);
      setToast(`${todo.length} 款已加入下载队列`);
    },
    [installed, enqueue],
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

  /**
   * 强力卸载。
   *
   * 普通卸载走 winget，遇到注册表残留 / 卸载器要交互 / 程序被占用就直接失败，
   * 用户只能自己去翻注册表。这里交给 force_uninstall.ps1 分五步做完：
   * 结束占用进程 → 调卸载器 → 清 ARP 条目 → 删残留目录 → 清快捷方式。
   * 每一步的结果都会回报，用户能看清到底动了什么。
   */
  const forceUninstallApp = useCallback(async (app: LocalApp) => {
    setForceBusy(app.name);
    try {
      const r = await forceUninstall({
        name: app.name,
        exe: app.exe || null,
        location: app.installLocation || null,
        uninstallString: app.uninstallString || null,
      });
      if (!r) {
        setToast('强力卸载失败：桌面版才能调用系统卸载接口');
        return null;
      }
      const done = r.steps.filter((s) => s.done).map((s) => s.text);
      setToast(
        r.ok
          ? `已卸载 ${app.name}${r.removed > 0 ? `，清理 ${r.removed} 个注册表项` : ''}${done.length ? '：' + done.join('、') : ''}`
          : `卸载 ${app.name} 未完全成功：${r.errors.join('；') || '未知原因'}`,
      );
      await Promise.all([refreshInstalled(), refreshLocalApps()]);
      return r;
    } finally {
      setForceBusy(null);
    }
  }, [refreshInstalled, refreshLocalApps]);

  /** 清 winget 下载缓存：装失败的安装包会一直留在 Temp 里 */
  const cleanCache = useCallback(async () => {
    setCacheBusy(true);
    try {
      const r = await cleanDownloadCache();
      if (!r) {
        setToast('清理缓存失败：桌面版才能访问下载目录');
        return null;
      }
      setToast(r.files > 0
        ? `已清理 ${r.files} 个缓存文件，释放 ${(r.bytes / 1024 / 1024).toFixed(1)} MB`
        : '没有可清理的下载缓存');
      return r;
    } finally {
      setCacheBusy(false);
    }
  }, []);

  return {
    view, setView, query, setQuery, filtered, installed, favorites, toggleFavorite,
    selected, setSelected,
    install, openPreview, confirmInstall, closeInstall, setInstallLocation,
    // 后台队列
    jobs, enqueue, cancelJob, togglePauseJob, clearFinishedJobs, dismissJob,
    uninstallTargets, uninstalling, uninstallProgress, requestUninstall, doUninstall, cancelUninstall,
    toast, closeToast,
    loadingBundle, installBundle, installTools,
    upgradable, checkingUpdates, upgrading, checkUpdates, doUpgrade,
    launching, launchTool, refreshInstalled,
    localApps, scanningLocal, refreshLocalApps,
    forceUninstallApp, forceBusy, cleanCache, cacheBusy,
    stalePrompt, purgeStaleApp, dismissStalePrompt,
    isTauri: isTauri(),
    total: TOOLS.length,
  };
}
