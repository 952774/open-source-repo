/** 社区提交 manifest（F4）：前端生成符合规范的 manifest 片段，用户复制到 GitHub PR */
import { useCallback, useState } from 'react';

export interface SubmitForm {
  name: string;
  category: string;
  description: string;
  license: string;
  repo: string;
  homepage: string;
  wingetId: string;
  scenarios: string;
}

const empty: SubmitForm = {
  name: '', category: 'dev', description: '', license: 'MIT',
  repo: '', homepage: '', wingetId: '', scenarios: '',
};

export function validateSubmit(form: SubmitForm): string | null {
  if (!form.name.trim()) return '请填写工具名称';
  if (!form.description.trim()) return '请填写工具描述';
  if (!/^https:\/\/github\.com\/[^/]+\/[^/]+/.test(form.repo.trim())) return '仓库地址必须是 https://github.com/... 格式';
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(form.wingetId.trim())) return 'winget ID 格式不合法';
  if (!form.license.trim()) return '请填写许可证';
  return null;
}

export function buildManifestYaml(form: SubmitForm): string {
  const id = form.name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '').slice(0, 40) || 'new-tool';
  const scenarios = form.scenarios.split(/[,，、]/).map((s) => s.trim()).filter(Boolean);
  return `# ToolArk manifest - 由社区提交生成
id: ${id}
name: ${form.name}
category: ${form.category}
icon: '🧩'
description: ${form.description}
scenarios: [${scenarios.map((s) => `'${s}'`).join(', ')}]
license: ${form.license}
openSource: true
wingetId: ${form.wingetId}
repo: ${form.repo}
stars: '—'
lastUpdate: '—'
tags: [${scenarios.slice(0, 2).map((s) => `'${s}'`).join(', ')}]
homepage: ${form.homepage || form.repo}
`;
}

export function useSubmit() {
  const [form, setForm] = useState<SubmitForm>(empty);
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [copied, setCopied] = useState(false);

  const update = useCallback((key: keyof SubmitForm, value: string) => {
    setForm((f) => ({ ...f, [key]: value }));
    setError(null);
  }, []);

  const generate = useCallback(() => {
    const err = validateSubmit(form);
    if (err) { setError(err); return; }
    setResult(buildManifestYaml(form));
    setCopied(false);
  }, [form]);

  const copy = useCallback(async () => {
    if (!result) return;
    try {
      await navigator.clipboard.writeText(result);
      setCopied(true);
    } catch {
      setCopied(false);
    }
  }, [result]);

  const reset = useCallback(() => { setForm(empty); setResult(null); setError(null); setCopied(false); }, []);

  return { form, update, result, error, copied, generate, copy, reset };
}
