/** F1/F2/F3/F4 附加视图：场景向导、工具对比、配置备份、社区提交 */
import { useState } from 'react';
import { TOOLS, type Tool, CATEGORIES } from '../data/tools';
import { SCENE_QUESTIONS, COMPARE_GROUPS } from '../data/scenarios';
import { useConfig } from '../hooks/useConfig';
import { useSubmit } from '../hooks/useSubmit';
import { downloadsOf } from '../data/downloads';
import { formatDownloads } from '../lib/search';
import { openUrl } from '../lib/api';
import type { Lang, StringKey } from '../lib/i18n';

type TFunc = (key: StringKey) => string;

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

const catLabel = (id: string, name: string, lang: Lang) => (lang === 'zh' ? name : (CATEGORY_EN[id] ?? name));

/* ---------- F2 场景向导 ---------- */
export function SceneGuide({ t, lang, onInstall }: { t: TFunc; lang: Lang; onInstall: (tools: Tool[]) => void }) {
  const [step, setStep] = useState(0);
  const [picks, setPicks] = useState<string[]>([]);
  const q = SCENE_QUESTIONS[step];
  const done = step >= SCENE_QUESTIONS.length;

  const toggle = (toolIds: string[]) => {
    setPicks((prev) => {
      const next = new Set(prev);
      toolIds.forEach((id) => next.add(id));
      return [...next];
    });
  };

  const recommended = picks.map((id) => TOOLS.find((x) => x.id === id)).filter(Boolean) as Tool[];

  if (done) {
    return (
      <div className="extra-view">
        <div className="section-head"><h2>✨ {t('sceneNext')}</h2><span>{recommended.length} {lang === 'zh' ? '款推荐工具' : 'recommended'}</span></div>
        <div className="grid">
          {recommended.map((tool) => (
            <div className="tool-card" key={tool.id}>
              <div className="tool-top">
                <div className="tool-icon">{tool.icon}</div>
                <div><div className="tool-name">{tool.name}</div><div className="tool-license">{tool.license}</div></div>
              </div>
              <p className="tool-desc">{tool.description}</p>
            </div>
          ))}
        </div>
        <div className="modal-actions" style={{ maxWidth: 420, margin: '22px auto' }}>
          <button className="btn-ghost" onClick={() => { setStep(0); setPicks([]); }}>{t('sceneBack')}</button>
          <button className="btn-primary" onClick={() => onInstall(recommended)}>{t('sceneDone')}（{recommended.length}）</button>
        </div>
      </div>
    );
  }

  return (
    <div className="extra-view">
      <div className="scene-head">
        <div className="scene-step">STEP {step + 1} / {SCENE_QUESTIONS.length}</div>
        <h2>{lang === 'zh' ? q.question : q.questionEn}</h2>
        <p>{t('sceneHint')}</p>
      </div>
      <div className="scene-options">
        {q.options.map((opt) => (
          <button className="scene-option" key={opt.id} onClick={() => { toggle(opt.toolIds); setStep(step + 1); }}>
            <span className="so-icon">{opt.icon}</span>
            <span className="so-label">{lang === 'zh' ? opt.label : opt.labelEn}</span>
            <span className="so-arrow">→</span>
          </button>
        ))}
      </div>
      {step > 0 && <button className="btn-ghost" onClick={() => setStep(step - 1)}>{t('sceneBack')}</button>}
    </div>
  );
}

/* ---------- F3 工具对比 ---------- */
export function CompareView({ t, lang }: { t: TFunc; lang: Lang }) {
  const [groupId, setGroupId] = useState(COMPARE_GROUPS[0].id);
  const group = COMPARE_GROUPS.find((g) => g.id === groupId)!;
  const tools = group.toolIds.map((id) => TOOLS.find((x) => x.id === id)).filter(Boolean) as Tool[];
  const zh = lang === 'zh';

  return (
    <div className="extra-view">
      <div className="section-head"><h2>⚖️ {t('compareTitle')}</h2><span>{t('compareHint')}</span></div>
      <div className="compare-tabs">
        {COMPARE_GROUPS.map((g) => (
          <button key={g.id} className={`compare-tab ${groupId === g.id ? 'active' : ''}`} onClick={() => setGroupId(g.id)}>
            {zh ? g.title : g.titleEn}
          </button>
        ))}
      </div>
      {tools.length === 0 ? (
        <div className="empty"><div className="ei">🔭</div><p>{t('noCompare')}</p></div>
      ) : (
        <div className="compare-table-wrap">
          <table className="compare-table">
            <thead>
              <tr>
                <th>{zh ? '工具' : 'Tool'}</th>
                <th>{zh ? '许可证' : 'License'}</th>
                <th>{zh ? '下载量' : 'Downloads'}</th>
                <th>{zh ? 'Star' : 'Stars'}</th>
                <th>{zh ? '场景' : 'Scenarios'}</th>
                <th>{zh ? '最近更新' : 'Updated'}</th>
              </tr>
            </thead>
            <tbody>
              {tools.map((tool) => {
                const dl = downloadsOf(tool.id);
                return (
                  <tr key={tool.id}>
                    <td><b>{tool.icon} {tool.name}</b></td>
                    <td><span className="tag">{tool.license}</span></td>
                    <td>{dl > 0 ? `📥 ${formatDownloads(dl)}` : '—'}</td>
                    <td>{tool.stars}</td>
                    <td>{tool.scenarios.slice(0, 2).join(zh ? '、' : ', ')}</td>
                    <td>{tool.lastUpdate}</td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      )}
    </div>
  );
}

/* ---------- F1 配置备份 ---------- */
export function ConfigView({ t }: { t: TFunc }) {
  const cfg = useConfig();

  return (
    <div className="extra-view">
      <div className="section-head"><h2>💾 {t('configBackup')}</h2></div>
      <div className="notice">{t('configTip')}</div>
      <div className="config-actions">
        <button className="btn-primary" onClick={cfg.backup} disabled={cfg.busy}>📦 {t('exportConfig')}</button>
        <label className="btn-ghost config-import-label">
          📥 {t('importConfig')}
          <input type="file" accept="application/json" style={{ display: 'none' }}
            onChange={(e) => { const f = e.target.files?.[0]; if (f) cfg.restore(f); }} />
        </label>
        {cfg.snapshot && <button className="btn-ghost" onClick={cfg.download}>⬇️ 下载 JSON</button>}
      </div>
      {cfg.message && <div className="notice ok">{cfg.message}</div>}
      {cfg.snapshot && (
        <div className="config-list">
          <h4>已备份 {cfg.snapshot.entries.length} 个配置文件</h4>
          {cfg.snapshot.entries.map((e, i) => (
            <div className="config-item" key={i}><b>{e.toolId}</b><code>{e.fileName}</code></div>
          ))}
        </div>
      )}
    </div>
  );
}

/* ---------- F4 社区提交 ---------- */
export function SubmitView({ t, lang }: { t: TFunc; lang: Lang }) {
  const sub = useSubmit();
  const zh = lang === 'zh';
  const categories = CATEGORIES;

  return (
    <div className="extra-view">
      <div className="section-head"><h2>🤝 {t('submitTitle')}</h2><span>{t('submitHint')}</span></div>
      <div className="notice">
        {zh
          ? '这里会生成符合收录规范的 manifest 片段。复制后到 GitHub 仓库新建 Issue 粘贴，维护者核对 winget ID 与开源许可证后合并进清单。'
          : 'This generates a manifest snippet that matches our inclusion rules. Copy it into a new GitHub issue; maintainers verify the winget ID and OSS license before merging.'}
      </div>
      <div className="submit-form">
        <div className="form-row"><label>{zh ? '名称' : 'Name'}</label><input value={sub.form.name} onChange={(e) => sub.update('name', e.target.value)} placeholder="e.g. Alacritty" /></div>
        <div className="form-row"><label>{zh ? '分类' : 'Category'}</label><select value={sub.form.category} onChange={(e) => sub.update('category', e.target.value)}>
          {categories.map((c) => <option key={c.id} value={c.id}>{catLabel(c.id, c.name, lang)}</option>)}
        </select></div>
        <div className="form-row"><label>{zh ? '描述' : 'Description'}</label><input value={sub.form.description} onChange={(e) => sub.update('description', e.target.value)} placeholder={zh ? '一句话说明它是什么' : 'One line about what it is'} /></div>
        <div className="form-row"><label>{zh ? 'GitHub 仓库' : 'GitHub repo'}</label><input value={sub.form.repo} onChange={(e) => sub.update('repo', e.target.value)} placeholder="https://github.com/owner/repo" /></div>
        <div className="form-row"><label>winget ID</label><input value={sub.form.wingetId} onChange={(e) => sub.update('wingetId', e.target.value)} placeholder="Owner.Package" /></div>
        <div className="form-row"><label>{zh ? '许可证' : 'License'}</label><input value={sub.form.license} onChange={(e) => sub.update('license', e.target.value)} placeholder="MIT" /></div>
        <div className="form-row"><label>{zh ? '场景（逗号分隔）' : 'Scenarios (comma separated)'}</label><input value={sub.form.scenarios} onChange={(e) => sub.update('scenarios', e.target.value)} placeholder={zh ? '终端,GPU加速' : 'terminal,GPU'} /></div>
        {sub.error && <div className="notice err">{sub.error}</div>}
        <button className="btn-primary" onClick={sub.generate}>{zh ? '生成 Manifest' : 'Generate manifest'}</button>
      </div>
      {sub.result && (
        <div className="submit-result">
          <div className="section-head">
            <h3>manifest YAML</h3>
            <button className="btn-ghost" onClick={sub.copy}>{sub.copied ? (zh ? '✓ 已复制' : '✓ Copied') : (zh ? '复制' : 'Copy')}</button>
          </div>
          <pre>{sub.result}</pre>
          <div className="notice">{t('submitOk')}</div>
          <div className="config-actions">
            <button className="btn-ghost" onClick={sub.reset}>{zh ? '清空重填' : 'Clear'}</button>
            <button className="btn-ghost" onClick={() => void openUrl('https://github.com/952774/open-source-repo/issues/new')}>
              {zh ? '在 GitHub 新建 Issue ↗' : 'Open a GitHub issue ↗'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
