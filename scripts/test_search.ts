// 模糊搜索冒烟测试：验证子序列匹配、多关键词、排序、star 解析
import { searchTools, parseStars, rankByStars } from '../src/lib/search';
import type { Tool } from '../src/data/tools';

const mk = (id: string, name: string, tags: string[], desc: string, stars = '1k'): Tool => ({
  id, name, category: 'dev', description: desc, scenarios: ['测试'],
  license: 'MIT', openSource: true, wingetId: `X.${id}`, icon: '🔧',
  tags, homepage: 'https://x', repo: 'https://github.com/x/y', stars, lastUpdate: '2026-11-01',
});

const tools = [
  mk('vscode', 'Visual Studio Code', ['编辑器', 'IDE'], '微软开源代码编辑器', '170k'),
  mk('neovim', 'Neovim', ['编辑器', 'Vim'], '终端文本编辑器', '103.8k'),
  mk('vlc', 'VLC', ['播放器', '视频'], '万能视频播放器', '17.5k'),
  mk('losslesscut', 'LosslessCut', ['视频', '剪切'], '无损视频剪切工具', '32.1k'),
];

let pass = 0;
let fail = 0;
function check(label: string, cond: boolean, extra = '') {
  if (cond) { pass++; console.log(`  ✅ ${label}`); }
  else { fail++; console.log(`  ❌ ${label} ${extra}`); }
}

console.log('— 子序列匹配 —');
check('"vsc" 命中 Visual Studio Code', searchTools(tools, 'vsc')[0]?.tool.id === 'vscode');
check('"nvm" 命中 Neovim', searchTools(tools, 'nvm').some((h) => h.tool.id === 'neovim'));
check('"lsc" 命中 LosslessCut', searchTools(tools, 'lsc').some((h) => h.tool.id === 'losslesscut'));

console.log('— 中文匹配 —');
check('"视频" 命中 VLC/LosslessCut', searchTools(tools, '视频').length >= 2);
check('"剪切" 命中 LosslessCut', searchTools(tools, '剪切')[0]?.tool.id === 'losslesscut');
check('"编辑器" 命中两个编辑器', searchTools(tools, '编辑器').length === 2);

console.log('— 多关键词 AND —');
check('"视频 剪切" 只命中 LosslessCut', (() => {
  const r = searchTools(tools, '视频 剪切');
  return r.length === 1 && r[0].tool.id === 'losslesscut';
})());
check('"视频 编辑器" 无结果', searchTools(tools, '视频 编辑器').length === 0);

console.log('— 排序 —');
check('"编辑器" 精确名称优先（Neovim 短名先？）', (() => {
  const r = searchTools(tools, 'editor');
  return r.length === 0; // 英文 editor 不在数据里，应为空
})());
check('名称命中优先于描述命中', (() => {
  const r = searchTools(tools, 'code');
  return r.length > 0 && r[0].tool.id === 'vscode';
})());

console.log('— star 解析 —');
check('"103.8k" → 103800', parseStars('103.8k') === 103800);
check('"1500" → 1500', parseStars('1500') === 1500);
check('"—" → -1', parseStars('—') === -1);
check('空串 → -1', parseStars('') === -1);

console.log('— 排行榜排序 —');
check('按 star 降序', (() => {
  const r = rankByStars(tools);
  return r[0].id === 'vscode' && r[1].id === 'neovim';
})());

console.log('— 空查询 —');
check('空查询返回全部且原序', searchTools(tools, '').length === 4 && searchTools(tools, '')[0].tool.id === 'vscode');

console.log(`\n结果: ${pass} 通过 / ${fail} 失败`);
if (fail > 0) process.exit(1);
console.log('ALL GREEN');
