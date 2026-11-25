import { useMemo, useState } from 'react';
import type { InstallJob } from '../hooks/useTools';
import type { Lang } from '../lib/i18n';

/**
 * macOS 风格圆环进度。
 *
 * 用 SVG 而不是 canvas：圆环要跟着列表缩放、要能吃 CSS 变量换主题色，
 * canvas 得自己重绘两样都要手写。stroke-dasharray 做进度是最省的做法，
 * 一个圆只画一条 dasharray + dashoffset 的动画，GPU 开销可以忽略。
 */
export function ProgressRing({
  percent,
  size = 44,
  stroke = 4,
  paused = false,
  done = false,
  failed = false,
}: {
  percent: number;
  size?: number;
  stroke?: number;
  paused?: boolean;
  done?: boolean;
  failed?: boolean;
}) {
  const r = (size - stroke) / 2;
  const c = 2 * Math.PI * r;
  const pct = Math.max(0, Math.min(100, percent));
  const offset = c * (1 - pct / 100);
  // 变量名必须是 --red / --green：index.css 里没有定义 --danger / --ok，
  // 写成那两个的话 SVG stroke 拿不到值，圆环会整圈变成透明看不见。
  const tone = failed ? 'var(--red)' : done ? 'var(--green)' : paused ? 'var(--ink-3)' : 'var(--brand)';

  return (
    <span className="ring-wrap" style={{ width: size, height: size }}>
      <svg width={size} height={size} viewBox={`0 0 ${size} ${size}`} aria-hidden="true">
        {/* 底环：一直可见，让 0% 时也能看出这是个进度环 */}
        <circle
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke="var(--edge-soft)"
          strokeWidth={stroke}
        />
        <circle
          className="ring-arc"
          cx={size / 2}
          cy={size / 2}
          r={r}
          fill="none"
          stroke={tone}
          strokeWidth={stroke}
          strokeLinecap="round"
          strokeDasharray={c}
          strokeDashoffset={offset}
          transform={`rotate(-90 ${size / 2} ${size / 2})`}
        />
      </svg>
      <span className="ring-label">
        {done ? '✓' : failed ? '!' : paused ? '❚❚' : `${Math.round(pct)}`}
      </span>
    </span>
  );
}

/**
 * 后台下载面板。
 *
 * 存在的理由：winget 装一个包要好几分钟，如果进度只能显示在模态框里，
 * 用户就被锁死了——既不能去挑下一个软件，也看不到总共在装几个。
 * 这里把它做成常驻底栏，安装全部转到后台。
 */
export function DownloadDock({
  jobs,
  onCancel,
  onTogglePause,
  onClearFinished,
  onDismiss,
  lang,
}: {
  jobs: InstallJob[];
  onCancel: (key: string) => void;
  onTogglePause: (key: string) => void;
  onClearFinished: () => void;
  onDismiss: (key: string) => void;
  lang: Lang;
}) {
  const [open, setOpen] = useState(true);
  const zh = lang === 'zh';

  const active = useMemo(
    () => jobs.filter((j) => j.phase === 'queued' || j.phase === 'running' || j.phase === 'paused'),
    [jobs],
  );
  const finished = useMemo(
    () => jobs.filter((j) => j.phase === 'done' || j.phase === 'error' || j.phase === 'cancelled'),
    [jobs],
  );

  if (jobs.length === 0) return null;

  const running = active.find((j) => j.phase === 'running') ?? active[0];
  const overall = active.length > 0 ? Math.round(active.reduce((s, j) => s + j.percent, 0) / active.length) : 100;

  const phaseText = (j: InstallJob) => {
    if (j.phase === 'queued') return zh ? '排队中' : 'Queued';
    if (j.phase === 'paused') return zh ? '已暂停' : 'Paused';
    if (j.phase === 'done') return zh ? '已安装' : 'Installed';
    if (j.phase === 'cancelled') return zh ? '已取消' : 'Cancelled';
    if (j.phase === 'error') return zh ? '失败' : 'Failed';
    if (j.hint === 'download') return zh ? '正在下载' : 'Downloading';
    if (j.hint === 'install') return zh ? '正在安装' : 'Installing';
    return zh ? '准备中' : 'Preparing';
  };

  return (
    <div className={`dock${open ? ' open' : ''}`}>
      <button className="dock-head" onClick={() => setOpen((v) => !v)}>
        <ProgressRing
          percent={overall}
          size={30}
          stroke={3}
          paused={active.length > 0 && !active.some((j) => j.phase === 'running')}
          done={active.length === 0}
          failed={false}
        />
        <span className="dock-title">
          {active.length > 0
            ? running
              ? `${phaseText(running)} · ${running.name}`
              : zh ? '准备中…' : 'Preparing…'
            : zh ? `已完成 ${finished.filter((j) => j.phase === 'done').length} 项` : `${finished.filter((j) => j.phase === 'done').length} finished`}
        </span>
        {active.length > 1 && <span className="dock-count">{active.length}</span>}
        <span className="dock-chev">{open ? '⌄' : '⌃'}</span>
      </button>

      {open && (
        <div className="dock-body">
          <div className="dock-list">
            {jobs.map((j) => (
              <div className={`dock-row ${j.phase}`} key={j.key}>
                <ProgressRing
                  percent={j.percent}
                  size={34}
                  stroke={3}
                  paused={j.phase === 'paused'}
                  done={j.phase === 'done'}
                  failed={j.phase === 'error'}
                />
                <div className="dock-info">
                  <div className="dock-name">
                    {j.name}
                    <span className="dock-phase">{phaseText(j)}</span>
                  </div>
                  <div className="dock-msg">{j.message || (zh ? '等待中…' : 'Waiting…')}</div>
                </div>
                <div className="dock-actions">
                  {(j.phase === 'running' || j.phase === 'paused') && (
                    <button
                      className="btn-ghost btn-sm"
                      onClick={() => onTogglePause(j.key)}
                      title={zh ? '冻结整棵安装进程树，已下载的字节会保留' : 'Freezes the installer process tree; downloaded bytes are kept'}
                    >
                      {j.phase === 'paused' ? (zh ? '继续' : 'Resume') : (zh ? '暂停' : 'Pause')}
                    </button>
                  )}
                  {(j.phase === 'queued' || j.phase === 'running' || j.phase === 'paused') && (
                    <button
                      className="btn-ghost btn-danger btn-sm"
                      onClick={() => onCancel(j.key)}
                      title={zh ? '结束 winget 与安装器进程，并清理已写入的残留' : 'Kills winget and the installer, then cleans up'}
                    >
                      {zh ? '取消' : 'Cancel'}
                    </button>
                  )}
                  {(j.phase === 'done' || j.phase === 'error' || j.phase === 'cancelled') && (
                    <button className="btn-ghost btn-sm" onClick={() => onDismiss(j.key)} title={zh ? '从列表移除' : 'Remove from list'}>
                      ✕
                    </button>
                  )}
                </div>
              </div>
            ))}
          </div>
          {finished.length > 0 && (
            <div className="dock-foot">
              <button className="btn-ghost btn-sm" onClick={onClearFinished}>
                {zh ? `清除已结束（${finished.length}）` : `Clear finished (${finished.length})`}
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}
