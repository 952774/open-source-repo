import { useMemo, useState } from 'react';
import { getTool, type Bundle, type Tool } from '../data/tools';
import type { Lang } from '../lib/i18n';

/**
 * 套装二级面板。
 *
 * 原来点一个套装就直接把十几个包塞进 winget 队列——用户根本不知道
 * 里面装了些什么，装完才发现有一半自己不需要。这里展开成可勾选清单，
 * 默认全选，但每一项都能单独去掉。
 */
export function BundlePanel({
  bundle,
  installed,
  onInstall,
  onClose,
  lang,
}: {
  bundle: Bundle;
  installed: Set<string>;
  onInstall: (tools: Tool[]) => void;
  onClose: () => void;
  lang: Lang;
}) {
  const zh = lang === 'zh';
  const tools = useMemo(
    () => bundle.toolIds.map((id) => getTool(id)).filter(Boolean) as Tool[],
    [bundle],
  );

  // 默认勾上还没装的：已经装过的再勾一次只会浪费时间走 winget 的空转
  const [picked, setPicked] = useState<Set<string>>(
    () => new Set(tools.filter((t) => !installed.has(t.id)).map((t) => t.id)),
  );

  const toggle = (id: string) => {
    setPicked((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  };

  const allOn = picked.size === tools.length;
  const toggleAll = () => setPicked(allOn ? new Set() : new Set(tools.map((t) => t.id)));
  const chosen = tools.filter((t) => picked.has(t.id));

  return (
    <>
      <div className="overlay" onClick={onClose} />
      <div className="modal bundle-modal">
        <div className="modal-head">
          <span className="mi">{bundle.icon}</span>
          <div>
            <h3>{bundle.name}</h3>
            <p>{bundle.desc}</p>
          </div>
        </div>

        <div className="bundle-bar">
          <button className="bundle-pickall" onClick={toggleAll}>
            {allOn ? (zh ? '全不选' : 'Deselect all') : (zh ? '全选' : 'Select all')}
          </button>
          <span className="bundle-tally">
            {zh ? `已选 ${picked.size} / ${tools.length}` : `${picked.size} of ${tools.length} selected`}
          </span>
        </div>

        <div className="bundle-list">
          {tools.map((t) => {
            const on = picked.has(t.id);
            const has = installed.has(t.id);
            return (
              <button
                className={`bundle-item${on ? ' on' : ''}`}
                key={t.id}
                onClick={() => toggle(t.id)}
                title={zh ? '点击切换是否安装' : 'Toggle selection'}
              >
                <span className="bi-check">{on ? '✓' : ''}</span>
                <span className="bi-icon">{t.icon}</span>
                <span className="bi-main">
                  <span className="bi-name">
                    {t.name}
                    {has && <span className="bi-tag">{zh ? '已安装' : 'Installed'}</span>}
                  </span>
                  <span className="bi-desc">{t.description}</span>
                </span>
                <span className="bi-meta">{t.license}</span>
              </button>
            );
          })}
        </div>

        <div className="modal-actions">
          <button className="btn-ghost" onClick={onClose}>{zh ? '取消' : 'Cancel'}</button>
          <button
            className="btn-primary"
            disabled={chosen.length === 0}
            onClick={() => {
              onInstall(chosen);
              onClose();
            }}
          >
            {zh ? `加入队列（${chosen.length}）` : `Add to downloads (${chosen.length})`}
          </button>
        </div>
      </div>
    </>
  );
}
