/**
 * 下载量后台刷新
 *
 * 内置的 downloads.ts 是构建时快照，会随时间失真。这里在应用启动后异步补一次：
 * 只拉「下载榜靠前」的仓库（排名靠后的工具即便涨了也不会挤进榜，不必花请求），
 * 成功后合并进内存并通知 UI 重排；失败就静默保留内置数据，绝不弹错。
 *
 * 为什么不在 Rust 侧做：这一步只读公开 API、不需要任何系统权限，
 * 走前端 fetch 既能复用浏览器缓存，也让 CSP 的 connect-src 一处管到底。
 * 为什么限量：GitHub 未认证限流 60 次/小时，一次性刷 288 个仓库会被打回 403。
 */
import { useSyncExternalStore } from 'react';
import {
  currentFetchedAt,
  downloadsOf,
  downloadsVersion,
  liveDownloadCount,
  setLiveDownloads,
  subscribeDownloads,
} from '../data/downloads';
import { TOOLS } from '../data/tools';

/** 单次刷新最多请求多少个仓库（留足未认证限流余量） */
const MAX_REPOS = 48;
/** 两次自动刷新之间的最小间隔：12 小时 */
const TTL_MS = 12 * 60 * 60 * 1000;
/** 启动后延迟多久开始，避开首屏渲染与 winget 扫描 */
const START_DELAY_MS = 8000;
/** 并发上限，太高会被 GitHub 判为滥用 */
const CONCURRENCY = 6;

const CACHE_KEY = 'toolark-downloads-live';
const CACHE_AT_KEY = 'toolark-downloads-live-at';

interface LiveCache {
  at: number;
  data: Record<string, number>;
}

function readCache(): LiveCache | null {
  try {
    const at = Number(localStorage.getItem(CACHE_AT_KEY) || 0);
    const raw = localStorage.getItem(CACHE_KEY);
    if (!raw || !at) return null;
    return { at, data: JSON.parse(raw) as Record<string, number> };
  } catch {
    return null;
  }
}

function writeCache(data: Record<string, number>) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
    localStorage.setItem(CACHE_AT_KEY, String(Date.now()));
  } catch {
    /* 存储满或被禁用时忽略：下次启动重新拉即可 */
  }
}

/** 从 repo URL 里取出 owner/repo */
function ownerRepo(repo: string | undefined): string | null {
  if (!repo) return null;
  const m = /github\.com\/([^/]+)\/([^/#?]+)/.exec(repo);
  if (!m) return null;
  return `${m[1]}/${m[2].replace(/\.git$/, '')}`;
}

interface GhAsset {
  download_count?: number;
}
interface GhRelease {
  assets?: GhAsset[];
  draft?: boolean;
}

/** 单个仓库：累加所有 release 资产的下载次数 */
async function fetchRepo(slug: string, signal: AbortSignal): Promise<number | null> {
  const res = await fetch(`https://api.github.com/repos/${slug}/releases?per_page=100`, {
    signal,
    headers: { Accept: 'application/vnd.github+json' },
  });
  if (!res.ok) return null;
  const list = (await res.json()) as GhRelease[];
  if (!Array.isArray(list)) return null;
  let sum = 0;
  for (const rel of list) {
    if (rel.draft) continue;
    for (const a of rel.assets ?? []) sum += a.download_count ?? 0;
  }
  return sum;
}

/** 受控并发跑一批任务 */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let cursor = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    for (;;) {
      const i = cursor++;
      if (i >= items.length) return;
      out[i] = await fn(items[i]);
    }
  });
  await Promise.all(workers);
  return out;
}

/**
 * 拉一次实时下载量并合并到内存。
 * 返回 true 表示至少有一条数据被更新。
 */
export async function refreshDownloads(): Promise<boolean> {
  // 按当前（可能是内置快照的）下载量取前 N 个仓库；没有 GitHub 仓库的工具跳过
  const targets = TOOLS.filter((t) => ownerRepo(t.repo))
    .slice()
    .sort((a, b) => downloadsOf(b.id) - downloadsOf(a.id))
    .slice(0, MAX_REPOS)
    .map((t) => ({ id: t.id, slug: ownerRepo(t.repo) as string }));

  if (targets.length === 0) return false;

  const ac = new AbortController();
  // 整体超时：宁可放弃这次刷新，也不要挂着几十个请求耗电
  const timer = setTimeout(() => ac.abort(), 30_000);

  try {
    const sums = await mapLimit(targets, CONCURRENCY, (t) => fetchRepo(t.slug, ac.signal));
    const fresh: Record<string, number> = {};
    targets.forEach((t, i) => {
      const v = sums[i];
      if (typeof v === 'number' && v > 0) fresh[t.id] = v;
    });
    if (Object.keys(fresh).length === 0) return false;
    setLiveDownloads(fresh, new Date().toISOString());
    writeCache(fresh);
    return true;
  } catch {
    return false;
  } finally {
    clearTimeout(timer);
  }
}

/**
 * 启动钩子：先用缓存（若有）点亮界面，再视 TTL 决定是否真去拉。
 * 静默失败——下载量是锦上添花，不该因为网络问题打扰用户。
 */
export function bootstrapDownloads() {
  const cached = readCache();
  if (cached && Object.keys(cached.data).length > 0) {
    setLiveDownloads(cached.data, new Date(cached.at).toISOString());
    if (Date.now() - cached.at < TTL_MS) return;
  }
  setTimeout(() => {
    void refreshDownloads();
  }, START_DELAY_MS);
}

/**
 * 订阅下载量变化：数据到位后组件自动重排榜单。
 * 返回的数据版本号变化即触发重渲染，业务代码只需照常调用 downloadsOf()。
 */
export function useDownloadsLive(): { version: number; fetchedAt: string; liveCount: number } {
  const version = useSyncExternalStore(subscribeDownloads, downloadsVersion, downloadsVersion);
  return { version, fetchedAt: currentFetchedAt(), liveCount: liveDownloadCount() };
}