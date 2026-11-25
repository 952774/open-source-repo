/**
 * 本机注册表记录 ↔ ToolArk 清单 的匹配
 *
 * 为什么要单独一层：
 *   winget list 只认它自己数据库里的包。用户用官方安装包装的、绿色版、
 *   或者装完手动删了目录，winget 都给不出正确答案。注册表 ARP 里的
 *   DisplayName / InstallLocation 才是"这台机器上到底装了什么"的原始事实。
 *
 * 匹配难点：注册表名带版本号、带发行方后缀、大小写不一致，例如
 *   "Upscayl 2.15.0" / "Microsoft Visual Studio Code (User)" / "Git"
 *   而清单里是 name "Git" + wingetId "Git.Git"。
 */
import { TOOLS, type Tool } from '../data/tools.ts';
import type { LocalApp } from './api.ts';

export interface LocalIndex {
  /** 归一化后的 名称 / wingetId 尾段 → toolId */
  byName: Map<string, string>;
  tools: Tool[];
}

/** 统一小写、压空白、去首尾 */
function normalize(s: string): string {
  return s.toLowerCase().replace(/\s+/g, ' ').trim();
}

/** 去掉注册表名里的版本号与架构后缀："Upscayl 2.15.0" → "upscayl" */
function stripVersion(raw: string): string {
  return raw
    .replace(/\s+v?\d[\d.\-+]*$/, '')
    .replace(/\s*\((?:user|machine|x64|x86|64-bit|32-bit|per-user)\)$/, '')
    .trim();
}

export function buildLocalIndex(): LocalIndex {
  const byName = new Map<string, string>();
  for (const t of TOOLS) {
    byName.set(normalize(t.name), t.id);
    // wingetId 形如 "Microsoft.VisualStudioCode" → 尾段 "visualstudiocode"
    const tail = t.wingetId.split('.').pop();
    if (tail) byName.set(normalize(tail), t.id);
  }
  return { byName, tools: TOOLS };
}

/**
 * 判断一条本机记录对应清单里的哪个工具，未收录返回 null。
 *
 * 分档打分，取最长命中，避免 "code" 这类短词误伤 "visual studio code"：
 *   100 名称完全一致 / 80 去版本号后一致 / 60 词边界前缀 / 40 安装目录名一致
 */
export function matchLocalApp(app: LocalApp, index: LocalIndex): string | null {
  const raw = normalize(app.name);
  const base = stripVersion(raw);
  let best: { id: string; score: number; len: number } | null = null;

  const consider = (id: string, score: number, key: string) => {
    if (!best || score > best.score || (score === best.score && key.length > best.len)) {
      best = { id, score, len: key.length };
    }
  };

  for (const [key, id] of index.byName) {
    if (key === raw) consider(id, 100, key);
    else if (key === base) consider(id, 80, key);
    else if (key.length >= 3 && (base.startsWith(`${key} `) || base.startsWith(`${key}-`))) {
      // 词边界前缀："git version 2.56" 命中 "git"，但 "digit" 不会
      consider(id, 60, key);
    }
  }
  if (best) return (best as { id: string }).id;

  // 安装目录兜底：目录名往往就是产品名（"C:\Program Files\Git\"）
  if (app.installLocation) {
    const dir = normalize(app.installLocation.replace(/[\\/]+$/, '').split(/[\\/]/).pop() ?? '');
    if (dir.length >= 3) {
      const hit = index.byName.get(dir);
      if (hit) return hit;
    }
  }
  return null;
}

/**
 * 从本机扫描结果里取出「确实装着的、且在清单收录范围内」的 toolId 集合。
 * 残留条目（程序文件已不在）不算已安装——否则用户会看到"已安装"却打不开。
 */
export function installedFromLocal(apps: LocalApp[], index: LocalIndex): Set<string> {
  const out = new Set<string>();
  for (const app of apps) {
    if (app.stale) continue;
    const id = matchLocalApp(app, index);
    if (id) out.add(id);
  }
  return out;
}
