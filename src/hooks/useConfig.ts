/** 配置备份与还原（F1）
 * 浏览器模式：用 localStorage 模拟配置存储
 * Tauri 模式：通过 IPC 读写文件（Rust 端 backup_configs/restore_configs）
 */
import { useCallback, useState } from 'react';
import { isTauri } from '../lib/api';
import { invoke } from '@tauri-apps/api/core';

const STORAGE_KEY = 'toolark-config-backup';

export interface ConfigSnapshot {
  version: string;
  exportedAt: string;
  entries: { toolId: string; fileName: string; content: string }[];
}

export function useConfig() {
  const [snapshot, setSnapshot] = useState<ConfigSnapshot | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');

  const backup = useCallback(async () => {
    setBusy(true);
    setMessage('');
    try {
      let data: ConfigSnapshot;
      if (isTauri()) {
        data = await invoke<ConfigSnapshot>('backup_configs');
      } else {
        // 浏览器模式：生成演示快照
        const demo = JSON.parse(localStorage.getItem(STORAGE_KEY) || 'null');
        data = demo ?? {
          version: '0.1.0',
          exportedAt: new Date().toISOString(),
          entries: [
            { toolId: 'vscode', fileName: 'settings.json', content: '{\n  "editor.fontSize": 14\n}' },
            { toolId: 'starship', fileName: 'starship.toml', content: '# starship config\nformat = "$directory $git_branch"' },
          ],
        };
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      }
      setSnapshot(data);
      setMessage(`已备份 ${data.entries.length} 个配置文件`);
    } catch (err) {
      setMessage(`备份失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  const download = useCallback(() => {
    if (!snapshot) return;
    const blob = new Blob([JSON.stringify(snapshot, null, 2)], { type: 'application/json' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `toolark-config-${new Date().toISOString().slice(0, 10)}.json`;
    a.click();
    URL.revokeObjectURL(url);
    setMessage('备份文件已下载');
  }, [snapshot]);

  const restore = useCallback(async (file: File) => {
    setBusy(true);
    setMessage('');
    try {
      const text = await file.text();
      const data = JSON.parse(text) as ConfigSnapshot;
      if (!data.entries || !Array.isArray(data.entries)) throw new Error('备份文件格式不正确');
      if (isTauri()) {
        await invoke('restore_configs', { snapshot: data });
      } else {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(data));
      }
      setSnapshot(data);
      setMessage(`已还原 ${data.entries.length} 个配置文件`);
    } catch (err) {
      setMessage(`还原失败：${String(err)}`);
    } finally {
      setBusy(false);
    }
  }, []);

  return { snapshot, busy, message, backup, download, restore, setMessage };
}
