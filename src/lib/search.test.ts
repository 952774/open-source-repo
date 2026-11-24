/**
 * search.ts 纯函数回归测试（node --test 直接跑 .ts，无需 tsx）。
 * 覆盖：模糊匹配、缩写、权重排序、下载量格式化。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { searchTools, parseStars, formatDownloads, acronym, scoreTool } from './search.ts';
import type { Tool } from '../data/tools';

const mk = (over: Partial<Tool> & { id: string; name: string }): Tool => ({
  category: 'dev',
  description: '',
  scenarios: [],
  license: 'MIT',
  openSource: true,
  wingetId: 'X.Y',
  icon: '📦',
  tags: [],
  homepage: 'https://example.com',
  repo: 'https://github.com/example/example',
  stars: '1k',
  lastUpdate: '2026-01-01',
  ...over,
} as Tool);

const POOL: Tool[] = [
  mk({ id: 'vscode', name: 'Visual Studio Code', nameEn: 'Visual Studio Code', tags: ['编辑器', 'editor'], stars: '150k' }),
  mk({ id: 'sublime', name: 'Sublime Text', tags: ['编辑器', 'editor'], stars: '20k' }),
  mk({ id: 'obsidian', name: 'Obsidian', description: '本地 Markdown 笔记', tags: ['笔记'], stars: '30k' }),
  mk({ id: 'siyuan', name: '思源笔记', nameEn: 'SiYuan', tags: ['笔记', '双链'], stars: '20k' }),
  mk({ id: 'bitwarden', name: 'Bitwarden', tags: ['密码'], stars: '12k' }),
];

test('精确名称命中排在最前', () => {
  const hits = searchTools(POOL, 'obsidian');
  assert.equal(hits[0].tool.id, 'obsidian');
});

test('首字母缩写能找到工具', () => {
  const hits = searchTools(POOL, 'vsc');
  assert.ok(hits.some((h) => h.tool.id === 'vscode'), 'vsc 应命中 vscode');
});

test('中文标签能搜到', () => {
  const ids = searchTools(POOL, '笔记').map((h) => h.tool.id);
  assert.ok(ids.includes('obsidian'));
  assert.ok(ids.includes('siyuan'));
});

test('英文名可被搜索（nameEn 参与打分）', () => {
  const ids = searchTools(POOL, 'siyuan').map((h) => h.tool.id);
  assert.ok(ids.includes('siyuan'));
});

test('空查询原样返回全部工具（不排序）', () => {
  const hits = searchTools(POOL, '   ');
  assert.equal(hits.length, POOL.length);
  assert.equal(hits[0].tool.id, POOL[0].id);
  assert.ok(hits.every((h) => h.score === 0));
});

test('无匹配返回空数组', () => {
  assert.deepEqual(searchTools(POOL, 'zzzznotexist'), []);
});

test('多关键词按 AND 收窄', () => {
  const both = searchTools(POOL, '笔记 双链').map((h) => h.tool.id);
  assert.deepEqual(both, ['siyuan']);
});

test('parseStars 解析 k/m 与占位符', () => {
  assert.equal(parseStars('150k'), 150000);
  assert.equal(parseStars('1.2m'), 1200000);
  assert.equal(parseStars('890'), 890);
  assert.equal(parseStars('—'), -1);
  assert.equal(parseStars(undefined), -1);
});

test('formatDownloads 分级与去尾零', () => {
  assert.equal(formatDownloads(0), '—');
  assert.equal(formatDownloads(-5), '—');
  assert.equal(formatDownloads(999), '999');
  assert.equal(formatDownloads(1000), '1k');
  assert.equal(formatDownloads(1500), '1.5k');
  assert.equal(formatDownloads(2_000_000), '2M');
  assert.equal(formatDownloads(2_400_000), '2.4M');
});

test('acronym 取大写与词首', () => {
  assert.equal(acronym('Visual Studio Code'), 'vsc');
  assert.equal(acronym('Sublime Text'), 'st');
});

test('scoreTool 对名称命中给更高权重', () => {
  const nameHit = scoreTool(POOL[0], 'visual').score;
  const descHit = scoreTool(POOL[2], 'markdown').score;
  assert.ok(nameHit > 0);
  assert.ok(descHit > 0);
  assert.ok(nameHit > descHit, '名称命中应高于描述命中');
});
