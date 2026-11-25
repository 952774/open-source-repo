/** 应用设置：语言、主题、默认安装位置，持久化到 localStorage */
import { useCallback, useEffect, useState } from 'react';
import type { Lang } from '../lib/i18n';

export interface AppSettings {
  lang: Lang;
  dark: boolean;
  /** 默认安装位置（安装弹窗自动填入，留空用系统默认） */
  defaultLocation: string;
  /** 安装完成后自动关闭弹窗 */
  autoCloseAfterInstall: boolean;
  /** 是否已经走过（或跳过）首次启动的场景向导 */
  firstRunDone: boolean;
}

const STORAGE_KEY = 'toolark-settings';

const DEFAULTS: AppSettings = {
  lang: 'zh',
  dark: false,
  defaultLocation: '',
  autoCloseAfterInstall: false,
  firstRunDone: false,
};

function load(): AppSettings {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return DEFAULTS;
    const saved = JSON.parse(raw) as Partial<AppSettings>;
    return { ...DEFAULTS, ...saved };
  } catch {
    return DEFAULTS;
  }
}

export function useSettings() {
  const [settings, setSettings] = useState<AppSettings>(load);

  // 持久化
  useEffect(() => {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(settings));
    } catch {
      /* localStorage 不可用时静默忽略 */
    }
  }, [settings]);

  // 主题应用到根节点
  useEffect(() => {
    document.documentElement.setAttribute('data-theme', settings.dark ? 'dark' : 'light');
  }, [settings.dark]);

  const update = useCallback(<K extends keyof AppSettings>(key: K, value: AppSettings[K]) => {
    setSettings((prev) => ({ ...prev, [key]: value }));
  }, []);

  const reset = useCallback(() => setSettings(DEFAULTS), []);

  return { settings, update, reset };
}
