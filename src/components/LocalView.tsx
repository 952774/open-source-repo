/**
 * 本机软件视图
 *
 * 数据来自注册表 ARP 全量扫描（scan_local_apps），不只是 ToolArk 收录的 288 款。
 * 解决两个真实痛点：
 *   1. 用户已经在别处装好的开源软件，ToolArk 里还显示"未安装"；
 *   2. 注册表里躺着已删文件的残留条目（如 Upscayl），winget 认为装着但根本打不开。
 */
import { useMemo, useState } from 'react';
import type { LocalApp } from '../lib/api';
import { openUrl } from '../lib/api';
import { buildLocalIndex, matchLocalApp } from '../lib/localMatch';
import type { Lang } from '../lib/i18n';

type Filter = 'all' | 'oss' | 'stale';

interface Props {
  lang: Lang;
  apps: LocalApp[];
  scanning: boolean;
  onRescan: () => void;
  onPurge: (name: string) => void;
  /** 点「在 ToolArk 里查看」时跳到对应详情页 */
  onOpenTool: (toolId: string) => void;
}

export function LocalView({ lang, apps, scanning, onRescan, onPurge, onOpenTool }: Props) {
  const zh = lang === 'zh';
  const [filter, setFilter] = useState<Filter>('all');
  const [q, setQ] = useState('');

  const index = useMemo(buildLocalIndex, []);

  const decorated = useMemo(
    () => apps.map((a) => ({ app: a, toolId: matchLocalApp(a, index) })),
    [apps, index],
  );

  const counts = useMemo(() => ({
    all: decorated.length,
    oss: decorated.filter((d) => d.toolId).length,
    stale: decorated.filter((d) => d.app.stale).length,
  }), [decorated]);

  const rows = useMemo(() => {
    let list = decorated;
    if (filter === 'oss') list = list.filter((d) => d.toolId);
    else if (filter === 'stale') list = list.filter((d) => d.app.stale);
    const kw = q.trim().toLowerCase();
    if (kw) {
      list = list.filter(({ app }) =>
        app.name.toLowerCase().includes(kw)
        || app.publisher.toLowerCase().includes(kw)
        || app.version.toLowerCase().includes(kw));
    }
    // 残留排最前，其余按名称
    return [...list].sort((a, b) => {
      if (a.app.stale !== b.app.stale) return a.app.stale ? -1 : 1;
      return a.app.name.localeCompare(b.app.name, zh ? 'zh-Hans-CN' : 'en');
    });
  }, [decorated, filter, q, zh]);

  return (
    <div className="extra-view local-view">
      <div className="section-head">
        <h2>💻 {zh ? '本机软件' : 'On This PC'}</h2>
        <span>
          {zh
            ? `注册表扫描到 ${counts.all} 款，其中 ${counts.oss} 款在 ToolArk 收录范围内`
            : `${counts.all} found in registry, ${counts.oss} are in ToolArk's catalog`}
        </span>
        <button className="btn-ghost btn-sm" disabled={scanning} onClick={onRescan}>
          {scanning ? (zh ? '扫描中…' : 'Scanning…') : (zh ? '🔄 重新扫描' : '🔄 Rescan')}
        </button>
      </div>

      <div className="local-toolbar">
        <div className="local-tabs">
          {([
            ['all', zh ? '全部' : 'All', counts.all],
            ['oss', zh ? '开源收录' : 'In catalog', counts.oss],
            ['stale', zh ? '安装残留' : 'Leftovers', counts.stale],
          ] as Array<[Filter, string, number]>).map(([id, label, n]) => (
            <button key={id} className={`local-tab ${filter === id ? 'active' : ''}`} onClick={() => setFilter(id)}>
              {label}<b>{n}</b>
            </button>
          ))}
        </div>
        <input
          className="local-search"
          value={q}
          onChange={(e) => setQ(e.target.value)}
          placeholder={zh ? '搜索名称 / 发行方 / 版本' : 'Search name, publisher, version'}
        />
      </div>

      {counts.stale > 0 && filter !== 'stale' && (
        <div className="notice warn">
          {zh
            ? `检测到 ${counts.stale} 条安装残留：注册表里还有卸载条目，但程序文件已经不在了。这类条目 winget 认为"已安装"，打开和卸载都会失败，建议清理。`
            : `${counts.stale} leftover entries found: the uninstall record exists but the program files are gone. winget still reports them as installed; open/uninstall will fail. Cleaning is recommended.`}
        </div>
      )}

      {rows.length === 0 ? (
        <div className="empty">
          <div className="ei">{scanning ? '⏳' : '🔍'}</div>
          <p>
            {scanning
              ? (zh ? '正在读取注册表…' : 'Reading the registry…')
              : (zh ? '没有匹配的软件' : 'Nothing matched')}
          </p>
        </div>
      ) : (
        <div className="local-list">
          {rows.map(({ app, toolId }) => (
            <div className={`local-row${app.stale ? ' stale' : ''}`} key={`${app.name}|${app.version}|${app.scope}`}>
              <div className="local-main">
                <div className="local-name">
                  {app.name}
                  {app.version && <span className="local-ver">{app.version}</span>}
                  {app.stale && <span className="tag warn-tag">{zh ? '残留' : 'Leftover'}</span>}
                  {toolId && <span className="tag green">{zh ? '已收录' : 'In catalog'}</span>}
                  {!toolId && !app.stale && <span className="tag gray">{zh ? '未收录' : 'Not listed'}</span>}
                </div>
                <div className="local-sub">
                  {app.publisher || (zh ? '未知发行方' : 'Unknown publisher')}
                  {app.installLocation ? ` · ${app.installLocation}` : ''}
                  {app.scope === 'user' ? (zh ? ' · 当前用户' : ' · per-user') : ''}
                </div>
              </div>
              <div className="local-actions">
                {app.stale ? (
                  <button className="btn-danger btn-sm" onClick={() => onPurge(app.name)}>
                    {zh ? '清理残留' : 'Clean up'}
                  </button>
                ) : (
                  <>
                    {toolId && (
                      <button className="btn-ghost btn-sm" onClick={() => onOpenTool(toolId)}>
                        {zh ? '查看详情' : 'Details'}
                      </button>
                    )}
                    {app.homepage && (
                      <button className="btn-ghost btn-sm" onClick={() => void openUrl(app.homepage)}>
                        {zh ? '官网 ↗' : 'Site ↗'}
                      </button>
                    )}
                  </>
                )}
              </div>
            </div>
          ))}
        </div>
      )}

      <div className="local-foot">
        {zh
          ? `数据来源：注册表 Uninstall 三根 + App Paths。共 ${counts.all} 条，扫描不含 UWP / Microsoft Store 应用。`
          : `Source: registry Uninstall keys + App Paths. ${counts.all} entries; UWP / Store apps are excluded.`}
      </div>
    </div>
  );
}
