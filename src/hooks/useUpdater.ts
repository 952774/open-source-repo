/** 应用自更新状态（仅 Tauri 桌面模式真实可用） */
import { useCallback, useState } from 'react';
import { isTauri } from '../lib/api';

export type UpdatePhase = 'idle' | 'checking' | 'available' | 'downloading' | 'done' | 'error' | 'unavailable';

export interface UpdateState {
  phase: UpdatePhase;
  version?: string;
  notes?: string;
  message?: string;
  progress?: number;
}

const initial: UpdateState = { phase: 'idle' };

export function useUpdater() {
  const [state, setState] = useState<UpdateState>(initial);

  /**
   * 检查更新。
   * @param silent 启动时静默检查：无更新或检查失败都不弹窗，只在发现新版本时提示
   */
  const checkUpdate = useCallback(async (silent = false) => {
    if (!isTauri()) {
      if (!silent) {
        setState({
          phase: 'unavailable',
          message: '检查更新仅在桌面版可用。浏览器预览模式无需更新。',
        });
      }
      return;
    }
    if (!silent) setState({ phase: 'checking' });
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const update = await check();
      if (!update) {
        if (!silent) setState({ phase: 'idle', message: '当前已是最新版本' });
        return;
      }
      // 发现新版本：即使静默模式也弹窗让用户决定
      setState({
        phase: 'available',
        version: update.version,
        notes: update.body,
        message: `发现新版本 ${update.version}`,
      });
    } catch (err) {
      if (silent) {
        // 静默模式不打扰用户，直接回到空闲
        setState({ phase: 'idle' });
        return;
      }
      setState({
        phase: 'error',
        message: `检查更新失败（更新源不可达）：${String(err)}`,
      });
    }
  }, []);

  const installUpdate = useCallback(async () => {
    setState((s) => ({ ...s, phase: 'downloading', progress: 0 }));
    try {
      const { check } = await import('@tauri-apps/plugin-updater');
      const { relaunch } = await import('@tauri-apps/plugin-process');
      const update = await check();
      if (!update) {
        setState({ phase: 'idle', message: '没有可用更新' });
        return;
      }
      let downloaded = 0;
      let total = 0;
      await update.downloadAndInstall((event) => {
        if (event.event === 'Started') total = event.data.contentLength ?? 0;
        if (event.event === 'Progress' && total > 0) {
          downloaded += event.data.chunkLength;
          setState((s) => ({ ...s, progress: Math.round((downloaded / total) * 100) }));
        }
      });
      setState({ phase: 'done', message: '更新已安装，即将重启…' });
      await relaunch();
    } catch (err) {
      setState({ phase: 'error', message: `更新失败：${String(err)}` });
    }
  }, []);

  const reset = useCallback(() => setState(initial), []);

  return { state, checkUpdate, installUpdate, reset };
}
