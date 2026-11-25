/**
 * localMatch.ts 回归测试（node --test 直接跑 .ts）。
 *
 * 这里守的是「用户自己装的开源软件要显示成已安装」这条链路：
 * 注册表名带版本号/发行方后缀，匹配错了会让 288 款工具里正确的那个永远显示未安装。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { buildLocalIndex, matchLocalApp, installedFromLocal } from './localMatch.ts';
import type { LocalApp } from './api.ts';

const index = buildLocalIndex();

const app = (over: Partial<LocalApp> & { name: string }): LocalApp => ({
  version: '',
  publisher: '',
  installLocation: null,
  exe: null,
  homepage: '',
  uninstallString: '',
  scope: 'machine',
  stale: false,
  ...over,
});

test('注册表名带版本号仍能匹配清单工具', () => {
  // "Git 2.56.1" → 清单 name "Git"
  assert.ok(matchLocalApp(app({ name: 'Git 2.56.1' }), index));
  // "Upscayl 2.15.0" → 清单 name "Upscayl"
  assert.equal(matchLocalApp(app({ name: 'Upscayl 2.15.0' }), index), matchLocalApp(app({ name: 'Upscayl' }), index));
});

test('精确名优先于包含匹配', () => {
  const exact = matchLocalApp(app({ name: 'Git' }), index);
  assert.ok(exact);
  assert.equal(matchLocalApp(app({ name: 'git' }), index), exact);
});

test('短词不做词内误伤：digit 不该命中 git', () => {
  const gitId = matchLocalApp(app({ name: 'Git' }), index);
  const other = matchLocalApp(app({ name: 'Digit Recognizer Tool' }), index);
  assert.notEqual(other, gitId);
});

test('安装目录兜底：名字认不出时用目录名', () => {
  const hit = matchLocalApp(
    app({ name: '某个看不出名字的发行包', installLocation: 'C:\\Program Files\\Git\\' }),
    index,
  );
  assert.equal(hit, matchLocalApp(app({ name: 'Git' }), index));
});

test('残留条目不计入已安装', () => {
  const alive = app({ name: 'Git 2.56.1' });
  const dead = app({ name: 'Git 2.56.1', stale: true });
  const got = installedFromLocal([alive, dead], index);
  const id = matchLocalApp(alive, index);
  assert.ok(id);
  assert.ok(got.has(id));
  // 只有 stale 条目时不该进集合
  assert.equal(installedFromLocal([dead], index).size, 0);
});

test('完全无关的软件不硬塞进已安装', () => {
  assert.equal(matchLocalApp(app({ name: 'AntiCheatExpert', publisher: 'Tencent' }), index), null);
});
