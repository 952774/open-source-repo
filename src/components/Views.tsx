/** 设置页 + 排行榜 */
import { useEffect, useMemo, useState } from 'react';
import { CATEGORIES, TOOLS, getCategory, type Tool } from '../data/tools';
import { rankByDownloads, rankByStars, parseStars, formatDownloads } from '../lib/search';
import { downloadsOf } from '../data/downloads';
import { useDownloadsLive } from '../lib/downloadsLive';
import type { Lang } from '../lib/i18n';
import type { AppSettings } from '../hooks/useSettings';
import {
  pickInstallDirectory,
  checkWinget,
  getProxyState,
  syncWinhttpProxy,
  resetWinhttpProxy,
  readLogs,
  exportDiagnostics,
  isTauri,
  type ProxyState,
} from '../lib/api';
import pkg from '../../package.json';

const zh = (lang: Lang) => lang === 'zh';

/** 与 package.json 单一来源，避免关于页版本号滞后 */
const APP_VERSION: string = (pkg as { version?: string }).version ?? '0.0.0';

const CATEGORY_EN: Record<string, string> = {
  dev: 'Development',
  system: 'System',
  office: 'Office',
  media: 'Media',
  network: 'Network',
  design: 'Design',
  security: 'Security',
  social: 'Social',
  entertainment: 'Media & Streaming',
  game: 'Gaming',
  ai: 'AI Tools',
};

const catName = (id: string, name: string, lang: Lang) =>
  zh(lang) ? name : (CATEGORY_EN[id] ?? name);

/* ============================ 设置页 ============================ */

export function SettingsView({ settings, update, reset, lang, onOpenTool, onCheckUpdates, onOpenRank, upgrading }: {
  settings: AppSettings;
  update: <K extends keyof AppSettings>(k: K, v: AppSettings[K]) => void;
  reset: () => void;
  lang: Lang;
  onOpenTool: (t: Tool) => void;
  onCheckUpdates?: () => void;
  onOpenRank?: () => void;
  upgrading?: boolean;
}) {
  const [picking, setPicking] = useState(false);
  const [winget, setWinget] = useState<{ ok: boolean; detail: string } | null>(null);
  const [proxy, setProxy] = useState<ProxyState | null>(null);
  const [busy, setBusy] = useState(false);
  const [notice, setNotice] = useState('');
  const [logs, setLogs] = useState('');

  useEffect(() => {
    let alive = true;
    checkWinget().then((r) => { if (alive) setWinget(r); });
    getProxyState().then((r) => { if (alive) setProxy(r); });
    return () => { alive = false; };
  }, []);

  const applyProxy = async () => {
    if (!proxy?.userProxy) {
      setNotice(zh(lang) ? '系统里没有检测到代理地址，请先在上网工具里开启系统代理' : 'No system proxy detected. Enable your system proxy first.');
      return;
    }
    setBusy(true);
    const r = await syncWinhttpProxy(proxy.userProxy);
    setBusy(false);
    setNotice(r.message);
    getProxyState().then(setProxy);
  };

  const clearProxy = async () => {
    setBusy(true);
    const r = await resetWinhttpProxy();
    setBusy(false);
    setNotice(r.message);
    getProxyState().then(setProxy);
  };

  const loadLogs = async () => {
    const text = await readLogs(200);
    setLogs(text || (zh(lang) ? '暂无日志' : 'No logs yet'));
  };

  const saveDiagnostics = async () => {
    const text = await exportDiagnostics();
    if (!text) {
      setNotice(zh(lang) ? '诊断信息读取失败' : 'Failed to read diagnostics');
      return;
    }
    try {
      const { save } = await import('@tauri-apps/plugin-dialog');
      const path = await save({
        title: zh(lang) ? '保存诊断包' : 'Save diagnostics',
        defaultPath: `toolark-diagnostics-${Date.now()}.txt`,
        filters: [{ name: 'Text', extensions: ['txt'] }],
      });
      if (path) {
        await fetch('data:text/plain;base64,' + btoa(unescape(encodeURIComponent(text))));
        setNotice(zh(lang) ? `已准备导出，请保存到：${path}` : `Ready to save to: ${path}`);
      }
    } catch {
      setNotice(zh(lang) ? '导出失败' : 'Export failed');
    }
    setLogs(text);
  };

  return (
    <div className="settings-view">
      <div className="settings-hero">
        <h2>{zh(lang) ? '设置' : 'Settings'}</h2>
        <p>{zh(lang) ? '调整外观、语言与安装偏好。设置会自动保存。' : 'Appearance, language and install preferences. Saved automatically.'}</p>
      </div>

      <section className="settings-group">
        <h3>{zh(lang) ? '外观' : 'Appearance'}</h3>
        <div className="settings-row">
          <div className="settings-label">
            <b>{zh(lang) ? '主题' : 'Theme'}</b>
            <span>{zh(lang) ? '深色模式减少夜间眩光' : 'Dark mode reduces glare at night'}</span>
          </div>
          <div className="seg">
            <button className={!settings.dark ? 'on' : ''} onClick={() => update('dark', false)}>☀️ {zh(lang) ? '浅色' : 'Light'}</button>
            <button className={settings.dark ? 'on' : ''} onClick={() => update('dark', true)}>🌙 {zh(lang) ? '深色' : 'Dark'}</button>
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-label">
            <b>{zh(lang) ? '语言' : 'Language'}</b>
            <span>{zh(lang) ? '界面与文案语言' : 'Interface language'}</span>
          </div>
          <div className="seg">
            <button className={settings.lang === 'zh' ? 'on' : ''} onClick={() => update('lang', 'zh')}>中文</button>
            <button className={settings.lang === 'en' ? 'on' : ''} onClick={() => update('lang', 'en')}>English</button>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h3>{zh(lang) ? '安装' : 'Installation'}</h3>
        <div className="settings-row col">
          <div className="settings-label">
            <b>{zh(lang) ? '默认安装位置' : 'Default install location'}</b>
            <span>
              {zh(lang)
                ? '留空使用各安装器的默认路径。设置后安装弹窗会自动填入。注意部分安装器（MSI）不支持自定义位置。'
                : 'Leave empty to use each installer default. MSI installers may not support custom paths.'}
            </span>
          </div>
          <div className="loc-input-row">
            <input
              className="loc-input"
              value={settings.defaultLocation}
              placeholder={zh(lang) ? '如 D:\\Program Files\\Apps' : 'e.g. D:\\Program Files\\Apps'}
              onChange={(e) => update('defaultLocation', e.target.value)}
              spellCheck={false}
            />
            <button
              type="button"
              className="btn-ghost btn-pick"
              disabled={picking}
              onClick={async () => {
                setPicking(true);
                const dir = await pickInstallDirectory();
                setPicking(false);
                if (dir) update('defaultLocation', dir);
              }}
            >
              {picking ? '…' : (zh(lang) ? '选择目录' : 'Browse')}
            </button>
            {settings.defaultLocation && (
              <button type="button" className="btn-ghost btn-pick" onClick={() => update('defaultLocation', '')}>
                {zh(lang) ? '清除' : 'Clear'}
              </button>
            )}
          </div>
        </div>
        <div className="settings-row">
          <div className="settings-label">
            <b>{zh(lang) ? '安装完成后自动关闭' : 'Auto-close after install'}</b>
            <span>{zh(lang) ? '成功安装后自动关掉弹窗，连续安装更顺手' : 'Close the dialog automatically after a successful install'}</span>
          </div>
          <div className="seg">
            <button className={settings.autoCloseAfterInstall ? 'on' : ''} onClick={() => update('autoCloseAfterInstall', true)}>
              {zh(lang) ? '开启' : 'On'}
            </button>
            <button className={!settings.autoCloseAfterInstall ? 'on' : ''} onClick={() => update('autoCloseAfterInstall', false)}>
              {zh(lang) ? '关闭' : 'Off'}
            </button>
          </div>
        </div>
      </section>

      <section className="settings-group">
        <h3>{zh(lang) ? '运行环境' : 'Environment'}</h3>
        <div className="settings-row">
          <div className="settings-label">
            <b>winget</b>
            <span>{zh(lang) ? '安装引擎，Windows 包管理器' : 'The install engine (Windows Package Manager)'}</span>
          </div>
          <div className={`env-badge ${winget === null ? '' : winget.ok ? 'ok' : 'err'}`}>
            {winget === null
              ? (zh(lang) ? '检测中…' : 'Checking…')
              : winget.ok
                ? winget.detail
                : (zh(lang) ? '不可用' : 'Unavailable')}
          </div>
        </div>
        {winget && !winget.ok && (
          <p className="loc-tip" style={{ paddingBottom: 12 }}>
            {zh(lang)
              ? `详细原因：${winget.detail}。请在 Microsoft Store 安装「应用安装程序」（App Installer），或在终端运行 winget --version 确认可用。`
              : `Detail: ${winget.detail}. Install "App Installer" from Microsoft Store.`}
          </p>
        )}
      </section>

      <section className="settings-group">
        <h3>{zh(lang) ? '网络代理' : 'Network proxy'}</h3>
        <p className="loc-tip" style={{ paddingBottom: 8 }}>
          {zh(lang)
            ? 'winget 走 WinHTTP 通道，不读浏览器代理。装 GitHub 上的工具时如果报 0x80072efd 或下载超时，把系统代理同步到 WinHTTP 即可解决。'
            : 'winget uses the WinHTTP channel and ignores browser proxy settings. If GitHub-hosted installers fail with 0x80072efd, sync your system proxy to WinHTTP.'}
        </p>
        <div className="settings-row">
          <div className="settings-label">
            <b>{zh(lang) ? '系统代理（WinINET）' : 'System proxy (WinINET)'}</b>
            <span>{proxy?.userProxyEnabled && proxy?.userProxy ? proxy.userProxy : (zh(lang) ? '未启用' : 'Not enabled')}</span>
          </div>
          <div className={`env-badge ${proxy?.winhttpProxy ? 'ok' : ''}`}>
            WinHTTP: {proxy?.winhttpProxy || (zh(lang) ? '直连' : 'direct')}
          </div>
        </div>
        <div className="settings-actions">
          <button className="btn-ghost" disabled={busy || !proxy?.userProxy} onClick={applyProxy}>
            {busy ? '…' : (zh(lang) ? '同步系统代理到 WinHTTP' : 'Sync to WinHTTP')}
          </button>
          <button className="btn-ghost" disabled={busy || !proxy?.winhttpProxy} onClick={clearProxy}>
            {zh(lang) ? '恢复直连' : 'Reset to direct'}
          </button>
        </div>
        {notice && <p className="loc-tip">{notice}</p>}
      </section>

      <section className="settings-group">
        <h3>{zh(lang) ? '诊断与日志' : 'Diagnostics & logs'}</h3>
        <p className="loc-tip" style={{ paddingBottom: 8 }}>
          {zh(lang)
            ? '安装失败的原因会记录在本地日志里（保留 7 天）。遇到问题可以先看日志，或导出诊断包。'
            : 'Install failures are logged locally for 7 days. Check the log or export a diagnostics bundle.'}
        </p>
        <div className="settings-actions">
          <button className="btn-ghost" onClick={loadLogs}>{zh(lang) ? '查看最近日志' : 'View recent logs'}</button>
          <button className="btn-ghost" onClick={saveDiagnostics} disabled={!isTauri()}>
            {zh(lang) ? '导出诊断包' : 'Export diagnostics'}
          </button>
        </div>
        {logs && (
          <pre className="log-view">{logs}</pre>
        )}
      </section>

      <section className="settings-group">
        <h3>{zh(lang) ? '关于' : 'About'}</h3>
        <div className="about-grid">
          <div><span>{zh(lang) ? '版本' : 'Version'}</span><b>v{APP_VERSION}</b></div>
          <div><span>{zh(lang) ? '收录工具' : 'Tools'}</span><b>{TOOLS.length}</b></div>
          <div><span>{zh(lang) ? '分类' : 'Categories'}</span><b>{CATEGORIES.length}</b></div>
          <div><span>{zh(lang) ? '开源校验' : 'Open source'}</span><b>100%</b></div>
        </div>
        <div className="settings-actions">
          <button className="btn-ghost" onClick={reset}>{zh(lang) ? '恢复默认设置' : 'Reset to defaults'}</button>
          {onCheckUpdates && (
            <button className="btn-ghost" onClick={onCheckUpdates} disabled={upgrading}>
              {upgrading ? (zh(lang) ? '检查中…' : 'Checking…') : (zh(lang) ? '检查工具更新' : 'Check tool updates')}
            </button>
          )}
          {onOpenRank && (
            <button className="btn-ghost" onClick={onOpenRank}>{zh(lang) ? '查看软件榜单' : 'View rankings'}</button>
          )}
        </div>
      </section>
    </div>
  );
}

/* ============================ 排行榜 ============================ */

type RankTab = 'downloads' | 'stars' | 'fresh' | 'featured';

export function RankView({ lang, onOpen }: { lang: Lang; onOpen: (t: Tool) => void }) {
  const [tab, setTab] = useState<RankTab>('downloads');
  const [cat, setCat] = useState<string>('all');
  const { version, fetchedAt, liveCount } = useDownloadsLive();

  const list = useMemo(() => {
    let base = TOOLS;
    if (cat !== 'all') base = base.filter((t) => t.category === cat);
    if (tab === 'downloads') {
      return rankByDownloads(base).filter((t) => downloadsOf(t.id) > 0).slice(0, 30);
    }
    if (tab === 'stars') return rankByStars(base).filter((t) => parseStars(t.stars) > 0).slice(0, 30);
    if (tab === 'fresh') {
      return [...base]
        .filter((t) => t.lastUpdate && t.lastUpdate !== '—')
        .sort((a, b) => b.lastUpdate.localeCompare(a.lastUpdate))
        .slice(0, 30);
    }
    return base.filter((t) => t.featured);
  }, [tab, cat, version]);

  const tabs: Array<[RankTab, string, string]> = [
    ['downloads', '📥', zh(lang) ? '下载榜' : 'Downloads'],
    ['stars', '⭐', zh(lang) ? '星标榜' : 'Stars'],
    ['fresh', '🆕', zh(lang) ? '最近活跃' : 'Recently Active'],
    ['featured', '✨', zh(lang) ? '编辑精选' : 'Featured'],
  ];

  return (
    <div className="rank-view">
      <div className="settings-hero">
        <h2>{zh(lang) ? '软件榜单' : 'Rankings'}</h2>
        <p>
          {zh(lang)
            ? `下载榜统计各工具 GitHub Release 资产的真实下载次数（数据时间 ${fetchedAt}${liveCount > 0 ? `，已后台刷新 ${liveCount} 款` : ''}）——star 代表关注，下载才代表真的有人装。`
            : `The download ranking sums real download counts across each project's GitHub releases (fetched ${fetchedAt}${liveCount > 0 ? `, ${liveCount} refreshed in background` : ''}). Stars show interest; downloads show actual installs.`}
        </p>
      </div>

      <div className="rank-tabs">
        {tabs.map(([key, icon, label]) => (
          <button key={key} className={tab === key ? 'on' : ''} onClick={() => setTab(key)}>
            {icon} {label}
          </button>
        ))}
      </div>

      <div className="rank-cats">
        <button className={cat === 'all' ? 'on' : ''} onClick={() => setCat('all')}>{zh(lang) ? '全部分类' : 'All'}</button>
        {CATEGORIES.map((c) => (
          <button key={c.id} className={cat === c.id ? 'on' : ''} onClick={() => setCat(c.id)}>
            {c.icon} {catName(c.id, c.name, lang)}
          </button>
        ))}
      </div>

      {list.length === 0 && (
        <div className="empty-state">
          {tab === 'downloads'
            ? (zh(lang) ? '该分类下暂无可统计下载量的工具' : 'No download data for this category yet')
            : (zh(lang) ? '这个榜单暂时没有数据' : 'No data for this ranking yet')}
        </div>
      )}

      <div className="rank-list">
        {list.map((tool, i) => {
          const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : null;
          const ext = tool as Tool & { nameEn?: string; iconUrl?: string };
          const name = zh(lang) ? tool.name : (ext.nameEn ?? tool.name);
          const c = getCategory(tool.category);
          const dl = downloadsOf(tool.id);
          return (
            <button className="rank-item" key={tool.id} onClick={() => onOpen(tool)}>
              <span className={`rank-no${medal ? ' medal' : ''}`}>{medal ?? i + 1}</span>
              <span className="rank-icon">
                <span className="emoji-fallback">{tool.icon}</span>
                {ext.iconUrl && (
                  <img src={ext.iconUrl} alt="" loading="lazy"
                    onError={(e) => { e.currentTarget.style.display = 'none'; }} />
                )}
              </span>
              <span className="rank-main">
                <span className="rank-name">{name}</span>
                <span className="rank-desc">{tool.description}</span>
              </span>
              <span className="rank-meta">
                <span className="rank-cat">{c.icon} {catName(c.id, c.name, lang)}</span>
                {tab === 'downloads'
                  ? <span className="rank-stars">📥 {formatDownloads(dl)}</span>
                  : <span className="rank-stars">★ {tool.stars}</span>}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
