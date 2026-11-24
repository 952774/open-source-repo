/**
 * 轻量模糊搜索：零依赖，支持子序列匹配 + 权重打分 + 多关键词
 * - "vsc"    → 命中 Visual Studio Code（首字母/子序列）
 * - "视频 剪辑" → 两个词都要命中（AND）
 * - 打分优先级：名称 > 标签 > 场景 > 描述
 */
import type { Tool } from '../data/tools';
import { downloadsOf } from '../data/downloads.ts';

export interface SearchHit {
  tool: Tool;
  score: number;
  /** 命中的最强字段，用于界面提示 */
  field: 'name' | 'tag' | 'scenario' | 'desc' | 'license';
}

/** 提取驼峰缩写：Visual Studio Code → vsc，LosslessCut → lc */
export function acronym(text: string): string {
  const caps = text.match(/[A-Z]/g);
  if (caps && caps.length >= 2) return caps.join('').toLowerCase();
  // 多词英文名取每词首字母：visual studio code → vsc
  const words = text.split(/[\s_-]+/).filter(Boolean);
  if (words.length >= 2 && words.every((w) => /^[a-zA-Z]/.test(w))) {
    return words.map((w) => w[0].toLowerCase()).join('');
  }
  return '';
}

/** 子序列模糊匹配：query 的字符按顺序出现在 text 中即命中（不要求连续） */
function subsequenceScore(text: string, query: string): number {
  if (!query) return 0;
  const t = text.toLowerCase();
  const q = query.toLowerCase();
  // 完全相等 > 前缀 > 包含 > 驼峰缩写 > 子序列
  if (t === q) return 100;
  if (t.startsWith(q)) return 90;
  const idx = t.indexOf(q);
  if (idx >= 0) return 80 - Math.min(idx, 20) * 0.5;

  // 驼峰缩写精确匹配（vsc → Visual Studio Code）
  const ac = acronym(text);
  if (ac && ac === q) return 88;
  if (ac && ac.startsWith(q) && q.length >= 2) return 70;

  // 子序列匹配：逐字符游标推进，记录连续性
  let ti = 0;
  let streak = 0;
  let best = 0;
  for (const ch of q) {
    const found = t.indexOf(ch, ti);
    if (found === -1) return 0;
    if (found === ti) streak += 1;
    else streak = 1;
    best = Math.max(best, streak);
    ti = found + 1;
  }
  // 子序列基础分 40，最长连续片段加权
  return 40 + Math.min(best, 6) * 3;
}

/** 单关键词在一个工具上的最佳得分 */
export function scoreTool(tool: Tool, keyword: string): { score: number; field: SearchHit['field'] } {
  const weights: Array<[SearchHit['field'], string, number]> = [
    ['name', `${tool.name} ${tool.nameEn ?? ''}`, 1.0],
    ['tag', tool.tags.join(' '), 0.72],
    ['scenario', tool.scenarios.join(' '), 0.66],
    ['desc', tool.description, 0.5],
    ['license', tool.license, 0.35],
  ];
  let best = { score: 0, field: 'desc' as SearchHit['field'] };
  for (const [field, text, w] of weights) {
    const s = subsequenceScore(text, keyword) * w;
    if (s > best.score) best = { score: s, field };
  }
  // id 与 wingetId 也参与（权重低）
  const idScore = subsequenceScore(tool.id, keyword) * 0.6;
  if (idScore > best.score) best = { score: idScore, field: 'name' };
  const widScore = subsequenceScore(tool.wingetId, keyword) * 0.3;
  if (widScore > best.score) best = { score: widScore, field: 'name' };
  return best;
}

/** 搜索：多关键词 AND，结果按相关度降序；空查询返回原顺序 */
export function searchTools(tools: Tool[], query: string): SearchHit[] {
  const q = query.trim();
  if (!q) return tools.map((tool) => ({ tool, score: 0, field: 'name' as const }));
  const keywords = q.split(/\s+/).filter(Boolean);

  const hits: SearchHit[] = [];
  for (const tool of tools) {
    let total = 0;
    let weakestField: SearchHit['field'] = 'name';
    let allMatched = true;
    for (const kw of keywords) {
      const { score, field } = scoreTool(tool, kw);
      if (score <= 0) {
        allMatched = false;
        break;
      }
      total += score;
      if (score < 60) weakestField = field;
    }
    if (allMatched) {
      hits.push({ tool, score: total / keywords.length, field: weakestField });
    }
  }
  return hits.sort((a, b) => b.score - a.score);
}

/** 解析 "103.8k" / "1500" / "—" 这类 star 字符串为数字，用于排行榜排序 */
export function parseStars(s: string | undefined | null): number {
  const v = (s ?? '').trim().toLowerCase();
  if (!v || v === '—') return -1;
  const m = v.match(/^([\d.]+)\s*(k|m)?$/);
  if (!m) return -1;
  const n = parseFloat(m[1]);
  if (Number.isNaN(n)) return -1;
  if (m[2] === 'k') return n * 1000;
  if (m[2] === 'm') return n * 1_000_000;
  return n;
}

/** 按 star 降序（保留给"关注度"视角使用） */
export function rankByStars(tools: Tool[]): Tool[] {
  return [...tools].sort((a, b) => parseStars(b.stars) - parseStars(a.stars));
}

/**
 * 按真实下载量降序。
 * 这是默认榜单口径：star 只说明"有多少人关注"，下载量才说明"有多少人真的装了"。
 * 没有发布过带资产 release 的工具（downloads = 0）排在后面，组内再按 star 兜底。
 */
export function rankByDownloads(tools: Tool[]): Tool[] {
  return [...tools].sort((a, b) => {
    const d = downloadsOf(b.id) - downloadsOf(a.id);
    if (d !== 0) return d;
    return parseStars(b.stars) - parseStars(a.stars);
  });
}

/** 格式化下载量：1234 → 1.2k，1234567 → 1.2M */
export function formatDownloads(n: number): string {
  if (n <= 0) return '—';
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, '')}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, '')}k`;
  return String(n);
}
