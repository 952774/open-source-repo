import { useEffect, useRef, useState } from 'react';
import { CATEGORIES, BUNDLES, TOOLS, getCategory, type Tool } from './data/tools';
import { downloadsOf } from './data/downloads';
import { shotsOf } from './data/shots';
import { rankByStars, formatDownloads } from './lib/search';
import { useTools, type View } from './hooks/useTools';
import { useUpdater } from './hooks/useUpdater';
import { useSettings } from './hooks/useSettings';
import { t as tr, type Lang, type StringKey } from './lib/i18n';
import {
  pickInstallDirectory,
  analyzeNetworkError,
  getProxyState,
  syncWinhttpProxy,
  openUrl,
  isTauri,
} from './lib/api';
import { SceneGuide, CompareView, ConfigView, SubmitView } from './components/ExtraViews';
import { LocalView } from './components/LocalView';
import { SettingsView, RankView } from './components/Views';
import pkg from '../package.json';

/** 构建期版本号：与 package.json 保持单一来源，避免底部版本号滞后 */
const APP_VERSION: string = (pkg as { version?: string }).version ?? '0.0.0';

type ExtraView = 'none' | 'scene' | 'compare' | 'config' | 'submit' | 'rank' | 'settings' | 'local';

/** 分类英文名（避免直接拼音化显示） */
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

function viewTitle(view: View, query: string, lang: Lang) {
  if (query.trim()) return lang === 'zh' ? '搜索结果' : 'Search Results';
  if (view === 'featured') return lang === 'zh' ? '精选工具' : 'Featured';
  if (view === 'all') return lang === 'zh' ? '全部工具' : 'All Tools';
  if (view === 'installed') return lang === 'zh' ? '已安装' : 'Installed';
  if (view === 'favorites') return lang === 'zh' ? '我的收藏' : 'Favorites';
  const c = getCategory(view);
  return lang === 'zh' ? c.name : (CATEGORY_EN[c.id] ?? c.name);
}

function Sidebar({
  view, setView, installed, favorites, total, updater, lang, extra, setExtra, T,
  open, onClose, appVersion,
}: {
  view: View; setView: (v: View) => void; installed: Set<string>; favorites: Set<string>; total: number;
  updater: ReturnType<typeof useUpdater>; lang: Lang;
  extra: ExtraView; setExtra: (v: ExtraView) => void; T: (k: StringKey) => string;
  open?: boolean; onClose?: () => void; appVersion?: string;
}) {
  const nav = (v: View, ic: string, label: string, cnt?: number) => (
    <button className={`nav-item ${view === v && extra === 'none' ? 'active' : ''}`}
      onClick={() => { setView(v); setExtra('none'); onClose?.(); }}>
      <span className="ic">{ic}</span><span>{label}</span>
      {cnt !== undefined && <span className="cnt">{cnt}</span>}
    </button>
  );
  const extraNav = (v: ExtraView, ic: string, label: string) => (
    <button className={`nav-item ${extra === v ? 'active' : ''}`} onClick={() => { setExtra(v); onClose?.(); }}>
      <span className="ic">{ic}</span><span>{label}</span>
    </button>
  );
  return (
    <aside className={`sidebar${open ? " open" : ""}`}>
      <div className="brand">
        <div className="brand-mark">🛡️</div>
        <div><div className="brand-name">ToolArk</div><div className="brand-sub">工具方舟</div></div>
      </div>
      <div className={`mode-badge${isTauri() ? ' real' : ''}`} id="mode-badge">
        <span className="d" /><span>{isTauri() ? T('desktopMode') : T('previewMode')}</span>
      </div>
      {/* 榜单入口：放在最显眼的位置 */}
      <button className={`rank-cta ${extra === 'rank' ? 'active' : ''}`} onClick={() => setExtra('rank')}>
        <span className="rc-icon">🏆</span>
        <span className="rc-text">
          <span className="rc-title">{lang === 'zh' ? '软件榜单' : 'Rankings'}</span>
          <span className="rc-sub">{lang === 'zh' ? '下载榜 · 星标 · 精选' : 'Downloads · Stars · Picks'}</span>
        </span>
        <span className="rc-arrow">→</span>
      </button>
      <div className="nav-label">{T('workspace')}</div>
      {nav('featured', '⭐', T('featured'))}
      {nav('all', '📚', T('all'), total)}
      {nav('installed', '✅', T('installed'), installed.size)}
      {nav('favorites', '❤️', lang === 'zh' ? '我的收藏' : 'Favorites', favorites.size)}
      {extraNav('local', '💻', lang === 'zh' ? '本机软件' : 'On This PC')}
      <div className="nav-label">{T('categories')}</div>
      {CATEGORIES.map((c) => nav(c.id, c.icon, lang === 'zh' ? c.name : (CATEGORY_EN[c.id] ?? c.name)))}
      <div className="nav-label">{lang === 'zh' ? '工具' : 'Tools'}</div>
      {extraNav('scene', '🧭', T('sceneGuide'))}
      {extraNav('compare', '⚖️', T('compare'))}
      {extraNav('config', '💾', T('configBackup'))}
      {extraNav('submit', '🤝', T('submit'))}
      <div className="nav-label">{lang === 'zh' ? '应用' : 'App'}</div>
      {extraNav('settings', '⚙️', lang === 'zh' ? '设置' : 'Settings')}
      <button className="check-update-btn" onClick={() => updater.checkUpdate()} disabled={updater.state.phase === 'checking'}>
        <span>⬆️</span>{updater.state.phase === 'checking' ? T('checking') : (lang === 'zh' ? '检查应用更新' : 'Check app update')}
      </button>
      <div className="sidebar-foot">
        <b>{total}</b> {T('tools')} · {T('installedCount')} <b>{installed.size}</b><br />
        100% Open Source · No Ads<br />
        <span className="version">v{appVersion || APP_VERSION}</span>
      </div>
    </aside>
  );
}

/** 搜索高亮：优先连续子串，否则按子序列逐字符高亮 */
function Highlight({ text, query }: { text: string; query: string }) {
  const q = query.trim();
  if (!q) return <>{text}</>;
  const kw = q.split(/\s+/)[0].toLowerCase();
  if (!kw) return <>{text}</>;
  const lower = text.toLowerCase();

  const idx = lower.indexOf(kw);
  if (idx >= 0) {
    return (
      <>
        {text.slice(0, idx)}
        <mark className="hl">{text.slice(idx, idx + kw.length)}</mark>
        {text.slice(idx + kw.length)}
      </>
    );
  }

  // 子序列高亮
  const marks = new Set<number>();
  let ti = 0;
  for (const ch of kw) {
    const found = lower.indexOf(ch, ti);
    if (found === -1) break;
    marks.add(found);
    ti = found + 1;
  }
  if (marks.size === 0) return <>{text}</>;
  return (
    <>
      {[...text].map((c, i) =>
        marks.has(i) ? <mark className="hl" key={i}>{c}</mark> : <span key={i}>{c}</span>,
      )}
    </>
  );
}

function ToolCard({
  tool, isInstalled, onDetail, onInstall, onUninstall, onOpen, lang, hasUpdate, isFavorite, onToggleFavorite, query = '',
}: {
  tool: Tool; isInstalled: boolean; onDetail: () => void; onInstall: () => void;
  onUninstall: () => void; onOpen: () => void; lang: Lang; hasUpdate?: boolean;
  isFavorite?: boolean; onToggleFavorite?: () => void; query?: string;
}) {
  const iconUrl = (tool as Tool & { iconUrl?: string }).iconUrl;
  const displayName = lang === 'en' ? ((tool as Tool & { nameEn?: string }).nameEn ?? tool.name) : tool.name;
  const dl = downloadsOf(tool.id);
  const zh = lang === 'zh';
  const cat = getCategory(tool.category);
  const catName = zh ? cat.name : (CATEGORY_EN[cat.id] ?? cat.name);
  return (
    <div className="tool-card" onClick={onDetail}>
      <div className="tool-top">
        <div className="tool-icon">
          <span className="emoji-fallback">{tool.icon}</span>
          {iconUrl && (
            <img src={iconUrl} alt="" loading="lazy"
              onError={(e) => { e.currentTarget.style.display = 'none'; }} />
          )}
        </div>
        <div className="tool-head">
          <div className="tool-name"><Highlight text={displayName} query={query} /></div>
          <div className="tool-sub">
            {catName}
            {dl > 0 ? ` · ${formatDownloads(dl)} ${zh ? '次下载' : 'downloads'}` : ''}
          </div>
        </div>
        <button
          className={`fav-btn${isFavorite ? ' on' : ''}`}
          title={isFavorite ? (zh ? '取消收藏' : 'Unfavorite') : (zh ? '收藏' : 'Favorite')}
          onClick={(e) => { e.stopPropagation(); onToggleFavorite?.(); }}
        >
          {isFavorite ? '❤️' : '🤍'}
        </button>
      </div>

      <p className="tool-desc"><Highlight text={tool.description} query={query} /></p>

      <div className="tool-foot">
        <div className="tool-meta">
          <span className="tag verified">✓ {zh ? '开源' : 'OSS'}</span>
          <span className="tag gray">{tool.license}</span>
          {hasUpdate && <span className="tag update">⬆ {zh ? '有新版' : 'Update'}</span>}
          {isInstalled && !hasUpdate && <span className="tag green">{zh ? '已安装' : 'Installed'}</span>}
        </div>
        <div className="card-actions">
          {isInstalled && (
            <button className="btn-card btn-card-ghost" onClick={(e) => { e.stopPropagation(); onOpen(); }}>
              {zh ? '打开' : 'Open'}
            </button>
          )}
          <button className={`btn-card ${isInstalled ? 'btn-card-danger' : 'btn-card-primary'}`}
            onClick={(e) => { e.stopPropagation(); isInstalled ? onUninstall() : onInstall(); }}>
            {isInstalled ? (zh ? '卸载' : 'Uninstall') : (zh ? '获取' : 'GET')}
          </button>
        </div>
      </div>
    </div>
  );
}

function ToolDetailPage({
  tool, isInstalled, onBack, onInstall, onUninstall, onOpen, lang, T, onOpenRelated,
  isFavorite, onToggleFavorite,
}: {
  tool: Tool; isInstalled: boolean; onBack: () => void; onInstall: () => void; onUninstall: () => void;
  onOpen: () => void; lang: Lang; T: (k: StringKey) => string; onOpenRelated: (t: Tool) => void;
  isFavorite?: boolean; onToggleFavorite?: () => void;
}) {
  const stars = tool.stars;
  const lastUpdate = tool.lastUpdate;
  const repo = tool.repo;
  const licenseUrl = `https://choosealicense.com/licenses/${tool.license.split(/[\s/]/)[0].toLowerCase()}/`;
  const cat = getCategory(tool.category);
  const ext = tool as Tool & { nameEn?: string; iconUrl?: string; screenshots?: string[] };
  const displayName = lang === 'en' ? (ext.nameEn ?? tool.name) : tool.name;
  // 截图：优先用手写字段，没有则用 README 抓取快照（scripts/fetch_shots.py 生成）
  const shots = Array.isArray(ext.screenshots) && ext.screenshots.length > 0
    ? ext.screenshots
    : shotsOf(tool.id);
  const related = rankByStars(TOOLS.filter((t) => t.category === tool.category && t.id !== tool.id)).slice(0, 4);
  const dl = downloadsOf(tool.id);

  return (
    <div className="detail-page">
      <button className="detail-back" onClick={onBack}>
        <span className="db-arrow">←</span>
        {lang === 'zh' ? '返回' : 'Back'}
      </button>

      {/* Hero：大图标 + 名称 + 操作 */}
      <div className="detail-hero">
        <div className="detail-hero-icon">
          <span className="emoji-fallback">{tool.icon}</span>
          {ext.iconUrl && <img src={ext.iconUrl} alt="" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
        </div>
        <div className="detail-hero-info">
          <h1>{displayName}</h1>
          {lang === 'zh' && ext.nameEn && <div className="detail-subname">{ext.nameEn}</div>}
          <div className="detail-hero-meta">
            <span className="dhm-cat">{cat.icon} {cat.name}</span>
            <span className="dhm-dot">·</span>
            <span className="dhm-oss">✓ {T('verified')}</span>
            {stars && stars !== '—' && (<><span className="dhm-dot">·</span><span>★ {stars}</span></>)}
            {dl > 0 && (<><span className="dhm-dot">·</span><span>📥 {formatDownloads(dl)}</span></>)}
          </div>
          <div className="detail-hero-actions">
            {isInstalled ? (
              <>
                <button className="btn-get launch" onClick={onOpen}>
                  ▶ {lang === 'zh' ? '打开应用' : 'Open app'}
                </button>
                <button className="btn-get installed" onClick={onUninstall}>{T('uninstall')}</button>
              </>
            ) : (
              <button className="btn-get" onClick={onInstall}>{T('install')}</button>
            )}
            <button
              className={`btn-icon${isFavorite ? ' on' : ''}`}
              onClick={onToggleFavorite}
              title={isFavorite ? (lang === 'zh' ? '取消收藏' : 'Unfavorite') : (lang === 'zh' ? '收藏' : 'Favorite')}
            >
              {isFavorite ? '❤️' : '🤍'}
            </button>
          </div>
        </div>
      </div>

      {/* 截图区 */}
      <section className="detail-block">
        <h3>{lang === 'zh' ? '界面预览' : 'Screenshots'}</h3>
        {shots.length > 0 ? (
          <div className="shot-scroll">
            {shots.map((src) => (
              <div className="shot-item" key={src}>
                <img src={src} alt={`${tool.name}`} loading="lazy"
                  onError={(e) => { e.currentTarget.closest('.shot-item')?.remove(); }} />
              </div>
            ))}
          </div>
        ) : (
          <div className="shot-placeholder">
            <span className="sp-icon">🖼️</span>
            <span>{lang === 'zh' ? '该工具暂未内置截图' : 'No screenshot bundled yet'}</span>
            <span>
              {lang === 'zh' ? '前往 ' : 'See '}
              <a href={tool.homepage} target="_blank" rel="noreferrer">{lang === 'zh' ? '官方网站' : 'official site'}</a>
              {repo && (
                <>
                  {lang === 'zh' ? ' 或 ' : ' or '}
                  <a href={repo} target="_blank" rel="noreferrer">GitHub</a>
                </>
              )}
              {lang === 'zh' ? ' 查看实际界面' : ''}
            </span>
          </div>
        )}
      </section>

      {/* 说明 */}
      <section className="detail-block">
        <h3>{lang === 'zh' ? '关于这个工具' : 'About'}</h3>
        <p className="detail-full-desc">{tool.description}</p>
        <div className="chips" style={{ marginTop: 12 }}>
          {tool.scenarios.map((sc) => <span className="chip" key={sc}>{sc}</span>)}
        </div>
        <div className="meta-chips" style={{ marginTop: 10 }}>
          {tool.tags.map((tag) => <span className="meta-chip" key={tag}>#{tag}</span>)}
        </div>
      </section>

      {/* 两栏：信息 + 同类 */}
      <div className="detail-columns">
        <section className="detail-block">
          <h3>{T('info')}</h3>
          <div className="meta-row"><span className="k">{T('license')}</span><span className="v"><a href={licenseUrl} target="_blank" rel="noreferrer">{tool.license} ↗</a></span></div>
          <div className="meta-row"><span className="k">{T('openSource')}</span><span className="v">✓ Yes</span></div>
          <div className="meta-row"><span className="k">{T('stars')}</span><span className="v">★ {stars ?? '—'}</span></div>
          <div className="meta-row">
            <span className="k">{lang === 'zh' ? '下载量' : 'Downloads'}</span>
            <span className="v">{dl > 0 ? `📥 ${formatDownloads(dl)}` : '—'}</span>
          </div>
          <div className="meta-row"><span className="k">{T('updated')}</span><span className="v">{lastUpdate ?? '—'}</span></div>
          <div className="meta-row"><span className="k">{T('packageId')}</span><span className="v">{tool.wingetId}</span></div>
          <div className="meta-row"><span className="k">{T('repo')}</span><span className="v">{repo ? <a href={repo} target="_blank" rel="noreferrer">GitHub ↗</a> : '—'}</span></div>
          <div className="meta-row"><span className="k">{T('homepage')}</span><span className="v"><a href={tool.homepage} target="_blank" rel="noreferrer">{lang === 'zh' ? '访问 ↗' : 'Open ↗'}</a></span></div>
        </section>

        <section className="detail-block">
          <h3>{lang === 'zh' ? `同类推荐 · ${cat.name}` : `More in ${CATEGORY_EN[cat.id] ?? cat.name}`}</h3>
          {related.length > 0 ? (
            <div className="related-list">
              {related.map((r) => {
                const rExt = r as Tool & { iconUrl?: string };
                return (
                  <button className="related-card" key={r.id} onClick={() => onOpenRelated(r)}>
                    <span className="ri">
                      <span className="emoji-fallback">{r.icon}</span>
                      {rExt.iconUrl && <img src={rExt.iconUrl} alt="" loading="lazy" onError={(e) => { e.currentTarget.style.display = 'none'; }} />}
                    </span>
                    <span style={{ minWidth: 0 }}>
                      <span className="rn">{r.name}</span>
                      <span className="rs"> ★ {r.stars}</span>
                    </span>
                  </button>
                );
              })}
            </div>
          ) : (
            <p className="detail-full-desc">{lang === 'zh' ? '这个分类下暂无其他工具' : 'No other tools in this category'}</p>
          )}
        </section>
      </div>

      <section className="detail-block">
        <h3>{lang === 'zh' ? '安装方式' : 'How it installs'}</h3>
        <p className="detail-full-desc">
          {lang === 'zh'
            ? `通过官方 winget 源精确匹配包 ID 安装，全程不执行任何第三方脚本。安装过程会显示实时下载与安装进度，装完自动创建桌面快捷方式，之后可在本页点「打开应用」或去「已安装」一键卸载${tool.category === 'system' ? '，卸载时可选择同时清理配置目录' : ''}。`
            : 'Installed via the official winget source with an exact package ID match — no third-party scripts. Live progress is shown, a desktop shortcut is created after install, and you can launch it from this page or uninstall it anytime.'}
        </p>
      </section>
    </div>
  );
}

/** 网络类安装失败的专用引导卡片 */
function NetworkErrorCard({ message, lang }: { message: string; lang: Lang }) {
  const hint = analyzeNetworkError(message);
  const [busy, setBusy] = useState(false);
  const [done, setDone] = useState('');
  if (!hint) return null;
  const zh = lang === 'zh';

  const applyProxy = async () => {
    setBusy(true);
    const state = await getProxyState();
    if (!state?.userProxy) {
      setBusy(false);
      setDone(zh ? '系统里没有检测到代理地址，请先在代理工具里开启系统代理' : 'No system proxy found. Enable your system proxy first.');
      return;
    }
    const r = await syncWinhttpProxy(state.userProxy);
    setBusy(false);
    setDone(r.message);
  };

  return (
    <div className="net-card">
      <div className="net-head">🌐 {hint.title}</div>
      <p className="net-detail">{hint.detail}</p>
      {done && <p className="net-done">{done}</p>}
      <div className="net-actions">
        {hint.suggestProxy && (
          <button className="btn-primary" disabled={busy} onClick={applyProxy}>
            {busy ? '…' : (zh ? '一键同步代理到 WinHTTP' : 'Sync proxy to WinHTTP')}
          </button>
        )}
        <button className="btn-ghost" onClick={() => void openUrl('https://github.com/952774/open-source-repo/issues')}>
          {zh ? '反馈问题' : 'Report issue'}
        </button>
      </div>
      <p className="net-tip">
        {zh
          ? '提示：也可以在「设置 → 网络代理」里随时同步或恢复直连；下载失败的工具仍可手动到官网获取。'
          : 'You can also sync or reset the proxy anytime in Settings → Network proxy.'}
      </p>
    </div>
  );
}

function InstallModal({ state, onConfirm, onClose, onLocationChange, onCancelInstall, T, lang }: {
  state: ReturnType<typeof useTools>['install']; onConfirm: () => void; onClose: () => void;
  onLocationChange: (v: string) => void;
  onCancelInstall: () => void;
  T: (k: StringKey) => string;
  lang: Lang;
}) {
  const tool = state.tool;
  if (!tool) return null;
  const phase = state.phase;
  const repo = tool.repo;
  return (
    <>
      <div className="overlay" onClick={phase === 'installing' ? undefined : onClose} />
      <div className="modal">
        <div className="modal-head">
          <span className="mi">{tool.icon}</span>
          <div><h3>{phase === 'done' ? (T('done')) : phase === 'error' ? 'Error' : phase === 'installing' ? T('installing') : T('installPreview')}</h3><p>{tool.name}</p></div>
        </div>
        {phase === 'preview' && (
          <>
            <div className="plan">
              <div className="plan-row"><span className="k">✓ Open Source</span><span className="v">{tool.license}</span></div>
              <div className="plan-row"><span className="k">{T('repo')}</span><span className="v">{repo ? <a href={repo} target="_blank" rel="noreferrer">GitHub ↗</a> : '—'}</span></div>
              <div className="plan-row"><span className="k">{T('packageId')}</span><span className="v">{tool.wingetId}</span></div>
              <div className="plan-row"><span className="k">Command</span><span className="v">winget install --id {tool.wingetId} --source winget</span></div>
            </div>
            <div className="loc-field">
              <label>{T('installLocation')}</label>
              <div className="loc-input-row">
                <input
                  className="loc-input"
                  placeholder={T('installLocationHint')}
                  value={state.location}
                  onChange={(e) => onLocationChange(e.target.value)}
                  spellCheck={false}
                />
                <button
                  type="button"
                  className="btn-ghost btn-pick"
                  onClick={async () => {
                    const dir = await pickInstallDirectory();
                    if (dir) onLocationChange(dir);
                  }}
                  title={T('browse')}
                >
                  {T('browse')}
                </button>
              </div>
              <p className="loc-tip">{T('installLocationTip')}</p>
            </div>
            <div className="notice">✓ 100% 开源软件 · 源码公开可查 · 仅从 winget 可信源安装，不执行任何脚本</div>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={onClose}>{T('cancel')}</button>
              <button className="btn-primary" onClick={onConfirm}>{T('confirmInstall')}</button>
            </div>
          </>
        )}
        {phase === 'installing' && (
          <>
            <div className="progress-track">
              <div
                className={`progress-fill${state.percent >= 100 ? ' done' : ''}`}
                style={{ width: `${Math.max(2, state.percent)}%` }}
              />
            </div>
            <div className="progress-meta">
              <span>
                {state.phase_hint === 'download'
                  ? (lang === 'zh' ? '正在下载…' : 'Downloading…')
                  : state.phase_hint === 'install'
                    ? (lang === 'zh' ? '正在安装…' : 'Installing…')
                    : T('installing')}
              </span>
              <b>{state.percent}%</b>
            </div>
            {state.message && <div className="progress-text">{state.message}</div>}
            <div className="modal-actions">
              <button
                className="btn-ghost btn-danger"
                onClick={onCancelInstall}
                disabled={state.cancelling}
                title={T('cancelInstallTip')}
              >
                {state.cancelling ? T('cancelling') : T('cancelInstall')}
              </button>
            </div>
          </>
        )}
        {(phase === 'done' || phase === 'error') && (
          <>
            <div className={`notice ${phase === 'done' ? 'ok' : 'err'}`}>{state.message}</div>
            {phase === 'error' && <NetworkErrorCard message={state.message} lang={lang} />}
            <div className="modal-actions"><button className="btn-primary" onClick={onClose}>{T('done')}</button></div>
          </>
        )}
      </div>
    </>
  );
}

function UninstallModal({ tools, busy, onConfirm, onCancel, cleanConfig, setCleanConfig, T, progress }: {
  tools: Tool[]; busy: boolean; onConfirm: (clean: boolean) => void; onCancel: () => void;
  cleanConfig: boolean; setCleanConfig: (v: boolean) => void; T: (k: StringKey) => string;
  progress?: { index: number; total: number; percent: number; currentName: string };
}) {
  const many = tools.length > 1;
  return (
    <>
      <div className="overlay" onClick={busy ? undefined : onCancel} />
      <div className="modal">
        <div className="modal-head">
          <span className="mi">🗑️</span>
          <div><h3>{T('uninstallConfirm')}{many ? ` ${tools.length}` : ''}</h3><p>{T('uninstallHint')}</p></div>
        </div>
        <div className="uninstall-list">
          {tools.map((t) => <div className="uninstall-item" key={t.id}><span>{t.icon}</span><b>{t.name}</b><code>{t.wingetId}</code></div>)}
        </div>
        <label className="checkbox-row">
          <input type="checkbox" checked={cleanConfig} onChange={(e) => setCleanConfig(e.target.checked)} disabled={busy} />
          <span>{T('cleanConfig')}</span>
        </label>
        {busy && progress && progress.total > 0 && (
          <>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${Math.max(2, progress.percent)}%` }} />
            </div>
            <div className="progress-meta">
              <span>{progress.currentName || T('uninstalling')}</span>
              <b>
                {Math.min(progress.index + 1, progress.total)}/{progress.total}
                {progress.percent > 0 ? ` · ${progress.percent}%` : ''}
              </b>
            </div>
          </>
        )}
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onCancel} disabled={busy}>{T('cancel')}</button>
          <button className="btn-danger" onClick={() => onConfirm(cleanConfig)} disabled={busy}>
            {busy ? T('uninstalling') : T('uninstallConfirm')}
          </button>
        </div>
      </div>
    </>
  );
}

/**
 * 安装残留处置弹窗
 *
 * 打开失败但注册表里还留着条目（典型：用户手动删了安装目录，或安装器中途崩了），
 * 这时只报一句"未找到启动程序"没有任何意义——用户需要的是一个能立刻收尾的动作。
 */
function StaleModal({ name, message, onPurge, onClose, lang }: {
  name: string; message: string; onPurge: () => void; onClose: () => void; lang: Lang;
}) {
  const zh = lang === 'zh';
  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="modal">
        <div className="modal-head">
          <span className="mi">🧹</span>
          <div>
            <h3>{zh ? '发现安装残留' : 'Installation leftover'}</h3>
            <p>{name}</p>
          </div>
        </div>
        <div className="notice warn">{message}</div>
        <p className="loc-tip" style={{ marginTop: 12 }}>
          {zh
            ? '清理会移除注册表里这条软件留下的卸载条目，以及确认没有程序文件的空目录。不会动其它软件，也不会删你的个人文件。'
            : 'Cleanup removes this program’s leftover uninstall entry and any empty folders with no executables left. Nothing else is touched.'}
        </p>
        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>{zh ? '先不管' : 'Not now'}</button>
          <button className="btn-danger" onClick={onPurge}>{zh ? '清理残留' : 'Clean up'}</button>
        </div>
      </div>
    </>
  );
}

function UpdateModal({ state, onInstall, onClose, T, lang, appVersion }: {  state: ReturnType<typeof useUpdater>['state']; onInstall: () => void; onClose: () => void;
  T: (k: StringKey) => string; lang: Lang; appVersion: string;
}) {
  const zh = lang === 'zh';
  const phase = state.phase;
  const closable = ['unavailable', 'error', 'done'].includes(phase) || (phase === 'idle' && !!state.message);

  const title =
    phase === 'checking' ? (zh ? '正在检查更新…' : 'Checking for updates…')
    : phase === 'available' ? (zh ? '发现新版本' : 'Update available')
    : phase === 'downloading' ? (zh ? '正在下载更新' : 'Downloading update')
    : phase === 'done' ? (zh ? '更新完成' : 'Update complete')
    : phase === 'error' ? (zh ? '检查失败' : 'Check failed')
    : (zh ? '已是最新版本' : 'Up to date');

  return (
    <>
      <div className="overlay" onClick={closable ? onClose : undefined} />
      <div className="modal">
        <div className="modal-head">
          <span className="mi">⬆️</span>
          <div>
            <h3>{title}</h3>
            <p>{zh ? `当前版本 v${appVersion}` : `Current version v${appVersion}`}</p>
          </div>
        </div>

        {phase === 'checking' && (
          <>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: '38%' }} />
            </div>
            <div className="progress-text">{zh ? '正在连接更新源…' : 'Contacting update server…'}</div>
          </>
        )}

        {phase === 'available' && (
          <>
            <div className="plan">
              <div className="plan-row"><span className="k">{zh ? '当前版本' : 'Current'}</span><span className="v">v{appVersion}</span></div>
              <div className="plan-row"><span className="k">{zh ? '最新版本' : 'Latest'}</span><span className="v">v{state.version}</span></div>
            </div>
            {state.notes && (
              <div className="notice" style={{ maxHeight: 190, overflowY: 'auto', whiteSpace: 'pre-wrap' }}>
                {state.notes}
              </div>
            )}
            <p className="loc-tip" style={{ marginTop: 10 }}>
              {zh
                ? '升级会在后台下载并自动替换当前版本，完成后应用会自动重启，版本号同步更新。'
                : 'The update downloads in the background and replaces the current version, then the app restarts automatically.'}
            </p>
            <div className="modal-actions">
              <button className="btn-ghost" onClick={onClose}>{zh ? '稍后再说' : 'Later'}</button>
              <button className="btn-primary" onClick={onInstall}>{zh ? '立即升级' : 'Update now'}</button>
            </div>
          </>
        )}

        {phase === 'downloading' && (
          <>
            <div className="progress-track">
              <div className="progress-fill" style={{ width: `${Math.max(2, state.progress ?? 0)}%` }} />
            </div>
            <div className="progress-meta">
              <span>{zh ? '正在下载并安装…' : 'Downloading and installing…'}</span>
              <b>{state.progress ?? 0}%</b>
            </div>
            <p className="loc-tip">{zh ? '请勿关闭应用，完成后会自动重启。' : 'Please keep the app open; it will restart automatically.'}</p>
          </>
        )}

        {(phase === 'done' || phase === 'error' || phase === 'unavailable' || (phase === 'idle' && state.message)) && (
          <>
            <div className={`notice ${phase === 'done' ? 'ok' : phase === 'error' ? 'err' : ''}`}>{state.message}</div>
            <div className="modal-actions">
              <button className="btn-primary" onClick={onClose}>{zh ? '知道了' : 'OK'}</button>
            </div>
          </>
        )}
      </div>
    </>
  );
}

export default function App() {
  const { settings, update: updateSetting, reset: resetSettings } = useSettings();
  const s = useTools(settings.defaultLocation);
  const updater = useUpdater();
  const lang = settings.lang;
  const dark = settings.dark;
  const setLang = (v: Lang) => updateSetting('lang', v);
  const setDark = (v: boolean) => updateSetting('dark', v);
  const [extra, setExtra] = useState<ExtraView>('none');
  const [licenseFilter, setLicenseFilter] = useState('all');
  const [cleanConfig, setCleanConfig] = useState(false);
  const [sidebarOpen, setSidebarOpen] = useState(false);
  const [appVersion, setAppVersion] = useState(APP_VERSION);
  // 记住列表滚动位置，从详情返回时恢复到原位
  const listScrollRef = useRef(0);
  const openDetail = (t: Tool) => {
    const el = document.querySelector('.content');
    listScrollRef.current = el ? el.scrollTop : 0;
    s.setSelected(t);
  };
  const backToList = () => {
    s.setSelected(null);
    requestAnimationFrame(() => {
      const el = document.querySelector('.content');
      if (el) el.scrollTop = listScrollRef.current;
    });
  };
  useEffect(() => {
    if (!s.isTauri) return;
    import('@tauri-apps/api/app')
      .then((m) => m.getVersion())
      .then((v) => setAppVersion(v))
      .catch(() => {});
  }, [s.isTauri]);
  const T = (k: StringKey) => tr(lang, k);

  // 安装成功后按设置自动关闭弹窗（连续安装更顺手）
  useEffect(() => {
    if (s.install.phase === 'done' && settings.autoCloseAfterInstall) {
      const timer = setTimeout(() => s.closeInstall(), 1200);
      return () => clearTimeout(timer);
    }
  }, [s.install.phase, settings.autoCloseAfterInstall, s.closeInstall]);

  // 首次进入「已安装」时自动检查一次工具更新（桌面版）
  const autoChecked = useRef(false);
  useEffect(() => {
    if (s.view === 'installed' && s.isTauri && !autoChecked.current) {
      autoChecked.current = true;
      s.checkUpdates();
    }
  }, [s.view, s.isTauri, s.checkUpdates]);

  // 启动后静默检查应用更新：有新版本才弹窗，无更新或失败都不打扰
  useEffect(() => {
    if (!s.isTauri) return;
    const timer = setTimeout(() => { void updater.checkUpdate(true); }, 2500);
    return () => clearTimeout(timer);
  }, [s.isTauri, updater.checkUpdate]);

  // 进入详情页时把内容区滚回顶部
  useEffect(() => {
    if (s.selected) {
      const el = document.querySelector('.content');
      if (el) el.scrollTop = 0;
    }
  }, [s.selected?.id]);

  // 全局快捷键：Ctrl/⌘+K 聚焦搜索，Esc 关闭弹层
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        document.querySelector<HTMLInputElement>('.search input')?.focus();
        return;
      }
      if (e.key === 'Escape') {
        if (s.selected) s.setSelected(null);
        else if (s.install.phase === 'preview' || s.install.phase === 'error') s.closeInstall();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [s.selected, s.install.phase, s.setSelected, s.closeInstall]);

  const licenses = Array.from(new Set(s.filtered.map((t) => t.license.split(/[\s/]/)[0]))).sort();
  const visible = licenseFilter === 'all' ? s.filtered : s.filtered.filter((t) => t.license.startsWith(licenseFilter));
  const showBundles = s.view === 'featured' || s.view === 'all';
  const upgradableIds = new Set(s.upgradable.map((u) => u.wingetId.toLowerCase()));
  // 分批渲染：一次最多显示 60 张卡片，避免 200 款同时挂载造成卡顿
  const [showCount, setShowCount] = useState(60);
  useEffect(() => { setShowCount(60); }, [s.view, s.query, licenseFilter]);
  const displayTools = visible.slice(0, showCount);
  const hasMore = visible.length > showCount;

  return (
    <div className="app-shell">
      <Sidebar view={s.view} setView={s.setView} installed={s.installed} favorites={s.favorites} total={s.total} updater={updater}
        lang={lang} open={sidebarOpen} onClose={() => setSidebarOpen(false)} appVersion={appVersion}
        extra={extra} setExtra={setExtra} T={T} />

      <main className="main">
        <header className="topbar">
          <button className="menu-btn" onClick={() => setSidebarOpen(true)} title="菜单">☰</button>
          <div className="search"><span className="si">🔍</span>
            <input
              value={s.query}
              onChange={(e) => {
                // 中文输入法拼音组合阶段不触发搜索，避免输入 "shipin" 时闪出无结果
                if ((e.nativeEvent as InputEvent).isComposing) return;
                s.setQuery(e.target.value);
              }}
              placeholder={T('search')}
            />
            {!s.query && <kbd className="search-kbd">Ctrl K</kbd>}
            {s.query && <button className="search-clear" onClick={() => s.setQuery('')} title="清除">×</button>}
          </div>
          <div className="top-stat"><span>{T('all')} <b>{s.total}</b></span><span>{T('installedCount')} <b>{s.installed.size}</b></span></div>
        </header>

        <div className="content">
          {s.selected ? (
            <ToolDetailPage
              tool={s.selected}
              isInstalled={s.installed.has(s.selected.id)}
              onBack={backToList}
              onInstall={() => s.openPreview(s.selected!)}
              onUninstall={() => s.requestUninstall(s.selected!)}
              onOpen={() => s.launchTool(s.selected!)}
              lang={lang}
              T={T}
              onOpenRelated={(t) => s.setSelected(t)}
              isFavorite={s.favorites.has(s.selected!.id)}
              onToggleFavorite={() => s.toggleFavorite(s.selected!.id)}
            />
          ) : (
            <>
          {extra === 'scene' && <SceneGuide t={T} lang={lang} onInstall={(tools) => { s.installTools(tools); setExtra('none'); }} />}
          {extra === 'compare' && <CompareView t={T} lang={lang} />}
          {extra === 'config' && <ConfigView t={T} />}
          {extra === 'submit' && <SubmitView t={T} lang={lang} />}
          {extra === 'rank' && <RankView lang={lang} onOpen={openDetail} />}
          {extra === 'local' && (
            <LocalView
              lang={lang}
              apps={s.localApps}
              scanning={s.scanningLocal}
              onRescan={() => void s.refreshLocalApps()}
              onPurge={(name) => void s.purgeStaleApp(name)}
              onOpenTool={(id) => { const t = TOOLS.find((x) => x.id === id); if (t) openDetail(t); }}
            />
          )}
          {extra === 'settings' && (
            <SettingsView settings={settings} update={updateSetting} reset={resetSettings}
              lang={lang} onOpenTool={openDetail}
              onCheckUpdates={s.checkUpdates} upgrading={s.checkingUpdates}
              onOpenRank={() => setExtra('rank')} />
          )}

          {extra === 'none' && (
            <>
              {showBundles && (
                <>
                  <div className="section-head"><h2>⚡ {T('quickBundles')}</h2><span>{T('bundleHint')}</span></div>
                  <div className="bundles">
                    {BUNDLES.map((b) => (
                      <button className="bundle" key={b.id} disabled={s.loadingBundle !== null} onClick={() => s.installBundle(b.id)}>
                        <span className="bi">{b.icon}</span><span><span className="bt">{b.name}</span><span className="bd">{s.loadingBundle === b.id ? T('installing') : b.desc}</span></span>
                      </button>
                    ))}
                  </div>
                </>
              )}
              <div className="section-head">
                <h2>{viewTitle(s.view, s.query, lang)}</h2><span>{visible.length} {T('tools')}</span>
                {s.view === 'installed' && visible.length > 0 && (
                  <button className="batch-uninstall-btn" onClick={() => s.requestUninstall(visible)}>🗑️ {T('batchUninstall')}（{visible.length}）</button>
                )}
                {s.view === 'installed' && visible.length > 0 && (
                  <>
                    <button className="check-upd-inline" disabled={s.checkingUpdates || s.upgrading} onClick={s.checkUpdates}>
                      {s.checkingUpdates ? (lang === 'zh' ? '检查中…' : 'Checking…') : (lang === 'zh' ? '🔍 检查更新' : '🔍 Check updates')}
                    </button>
                    {s.upgradable.length > 0 && (
                      <button className="upgrade-all-btn" disabled={s.upgrading} onClick={() => s.doUpgrade()}>
                        {s.upgrading ? (lang === 'zh' ? '升级中…' : 'Upgrading…') : (lang === 'zh' ? `⬆️ 全部更新（${s.upgradable.length}）` : `⬆️ Update all (${s.upgradable.length})`)}
                      </button>
                    )}
                  </>
                )}
              </div>
              {s.view === 'installed' && s.upgradable.length > 0 && (
                <div className="upgrade-banner">
                  <span className="ub-icon">⬆️</span>
                  <span className="ub-text">
                    <b>{lang === 'zh' ? `${s.upgradable.length} 款工具有新版本` : `${s.upgradable.length} updates available`}</b>
                    <span>
                      {s.upgradable.slice(0, 4).map((u) => `${u.name} ${u.current}→${u.available}`).join(' · ')}
                      {s.upgradable.length > 4 ? (lang === 'zh' ? ' …' : ' …') : ''}
                    </span>
                  </span>
                  <button className="ub-action" disabled={s.upgrading} onClick={() => s.doUpgrade()}>
                    {s.upgrading ? '…' : (lang === 'zh' ? '一键升级' : 'Upgrade')}
                  </button>
                </div>
              )}
              <div className="license-bar">
                <span>📜 {T('licenseFilter')}:</span>
                <button className={`license-chip ${licenseFilter === 'all' ? 'active' : ''}`} onClick={() => setLicenseFilter('all')}>{T('allLicenses')}</button>
                {licenses.map((lic) => <button key={lic} className={`license-chip ${licenseFilter === lic ? 'active' : ''}`} onClick={() => setLicenseFilter(lic)}>{lic}</button>)}
              </div>
              {visible.length > 0 ? (
                <div className="grid">
                  {displayTools.map((tool) => <ToolCard key={tool.id} tool={tool} isInstalled={s.installed.has(tool.id)}
                    onDetail={() => openDetail(tool)} onInstall={() => s.openPreview(tool)}
                    onUninstall={() => s.requestUninstall(tool)} onOpen={() => s.launchTool(tool)} lang={lang}
                    hasUpdate={upgradableIds.has(tool.wingetId.toLowerCase())}
                    isFavorite={s.favorites.has(tool.id)} onToggleFavorite={() => s.toggleFavorite(tool.id)}
                    query={s.query} />)}
                </div>
              ) : null}
              {visible.length > 0 && hasMore && (
                <div className="load-more-wrap">
                  <button className="load-more" onClick={() => setShowCount((n) => n + 60)}>
                    {lang === 'zh'
                      ? `加载更多（还有 ${visible.length - showCount} 款）`
                      : `Load more (${visible.length - showCount} left)`}
                  </button>
                </div>
              )}
              {visible.length === 0 && (s.query.trim() ? (
                <div className="empty-search">
                  <div className="es-icon">🔍</div>
                  <h3>{lang === 'zh' ? `没有找到「${s.query}」` : `No results for "${s.query}"`}</h3>
                  <p>
                    {lang === 'zh'
                      ? '搜索支持模糊匹配：输入首字母或部分文字即可，比如 vsc 能找到 Visual Studio Code，中英文都行。'
                      : 'Fuzzy search is supported — try initials like "vsc" for Visual Studio Code.'}
                  </p>
                  <div className="es-examples">
                    {(lang === 'zh' ? ['编辑器', '视频', '密码', '下载'] : ['editor', 'video', 'password', 'download']).map((w) => (
                      <button key={w} onClick={() => s.setQuery(w)}>{w}</button>
                    ))}
                  </div>
                </div>
              ) : (
                <div className="empty">
                  <div className="ei">{s.view === 'favorites' ? '🤍' : '🔭'}</div>
                  <p>
                    {s.view === 'installed' ? T('noInstalled')
                      : s.view === 'favorites'
                        ? (lang === 'zh' ? '还没有收藏任何工具，点卡片右上角的心形按钮收藏' : 'No favorites yet — tap the heart on a card to save it')
                        : T('noResult')}
                  </p>
                </div>
              ))}
            </>
          )}
            </>
          )}
        </div>
      </main>
      {sidebarOpen && <div className="sidebar-scrim" onClick={() => setSidebarOpen(false)} />}

      {s.install.phase !== 'idle' && <InstallModal state={s.install} onConfirm={s.confirmInstall} onClose={s.closeInstall} onLocationChange={s.setInstallLocation} onCancelInstall={s.cancelInstall} T={T} lang={lang} />}
      {s.uninstallTargets && <UninstallModal tools={s.uninstallTargets} busy={s.uninstalling}
        onConfirm={(clean) => s.doUninstall(clean)} onCancel={s.cancelUninstall}
        cleanConfig={cleanConfig} setCleanConfig={setCleanConfig} T={T} progress={s.uninstallProgress} />}
      {(updater.state.phase !== 'idle' || !!updater.state.message) && (
        <UpdateModal state={updater.state} onInstall={updater.installUpdate} onClose={updater.reset}
          T={T} lang={lang} appVersion={appVersion} />
      )}
      {s.stalePrompt && (
        <StaleModal
          name={s.stalePrompt.name}
          message={s.stalePrompt.message}
          onPurge={() => void s.purgeStaleApp(s.stalePrompt!.name)}
          onClose={s.dismissStalePrompt}
          lang={lang}
        />
      )}
      {s.toast && <div className="toast" onClick={s.closeToast}>{s.toast}</div>}
    </div>
  );
}
