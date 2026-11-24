#!/usr/bin/env python3
"""
抓取每个工具的 GitHub Release 资产累计下载量，生成 src/data/downloads.ts

为什么用 release 资产下载量：GitHub 没有"仓库总下载量"API，唯一真实可得的
二进制分发量就是各 release 下 assets[].download_count 之和。star 只代表关注度，
不等于实际使用；下载量才是"多少人真的装了"。

用法：
    python scripts/fetch_downloads.py            # 抓取并写入
    python scripts/fetch_downloads.py --dry-run  # 只打印，不写文件

认证：优先读项目根 .github-token（PAT，5000 次/小时）；没有则匿名（60 次/小时，
289 个仓库会不够，脚本会提示）。
"""
from __future__ import annotations

import json
import re
import sys
import time
import urllib.error
import urllib.request
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TOOLS_TS = ROOT / "src" / "data" / "tools.ts"
OUT_TS = ROOT / "src" / "data" / "downloads.ts"
TOKEN_FILE = ROOT / ".github-token"

API = "https://api.github.com"


def read_token() -> str | None:
    if not TOKEN_FILE.exists():
        return None
    token = TOKEN_FILE.read_text(encoding="utf-8").strip()
    return token or None


def parse_repos() -> list[tuple[str, str, str]]:
    """从 tools.ts 里提取 (toolId, owner, repo)。"""
    text = TOOLS_TS.read_text(encoding="utf-8")
    out: list[tuple[str, str, str]] = []
    current_id: str | None = None
    for line in text.splitlines():
        m_id = re.search(r"^\s*id:\s*'([^']+)'", line)
        if m_id:
            current_id = m_id.group(1)
        m_repo = re.search(r"repo:\s*'https://github\.com/([^/']+)/([^/']+)'", line)
        if m_repo and current_id:
            owner, repo = m_repo.group(1), m_repo.group(2)
            # 注意：不能用 rstrip(".git")——它按字符集剥离，会把 lazygit 截成 lazy。
            if repo.endswith(".git"):
                repo = repo[: -len(".git")]
            out.append((current_id, owner, repo))
            current_id = None
    return out


def get_json(url: str, token: str | None) -> tuple[object | None, int, dict]:
    req = urllib.request.Request(url)
    req.add_header("Accept", "application/vnd.github+json")
    req.add_header("User-Agent", "ToolArk-downloads-fetcher")
    if token:
        req.add_header("Authorization", f"Bearer {token}")
    try:
        with urllib.request.urlopen(req, timeout=25) as resp:
            return json.loads(resp.read().decode("utf-8")), resp.status, dict(resp.headers)
    except urllib.error.HTTPError as e:
        return None, e.code, dict(e.headers or {})
    except Exception as e:  # 网络抖动
        return None, 0, {"error": str(e)}


def sum_release_downloads(owner: str, repo: str, token: str | None) -> tuple[int, int]:
    """返回 (总下载量, release 数量)。无 release 的仓库返回 (0, 0)。"""
    total = 0
    count = 0
    page = 1
    while page <= 3:  # 最多 300 个 release，足够
        url = f"{API}/repos/{owner}/{repo}/releases?per_page=100&page={page}"
        data, status, headers = get_json(url, token)
        if status == 403 and headers.get("x-ratelimit-remaining") == "0":
            reset = headers.get("x-ratelimit-reset")
            wait = max(0, int(reset) - int(time.time())) + 2 if reset else 60
            print(f"  ! 触发限流，等待 {wait}s", flush=True)
            time.sleep(min(wait, 120))
            continue
        if not isinstance(data, list) or not data:
            break
        for rel in data:
            count += 1
            for asset in rel.get("assets") or []:
                total += int(asset.get("download_count") or 0)
        if len(data) < 100:
            break
        page += 1
    return total, count


def main() -> int:
    dry = "--dry-run" in sys.argv
    token = read_token()
    repos = parse_repos()
    print(f"共 {len(repos)} 个仓库，token={'有' if token else '无（匿名限流 60/h）'}", flush=True)

    result: dict[str, int] = {}
    release_counts: dict[str, int] = {}
    failed: list[str] = []

    for i, (tool_id, owner, repo) in enumerate(repos, 1):
        downloads, rel_count = sum_release_downloads(owner, repo, token)
        if rel_count == 0 and downloads == 0:
            # 区分"确实没有 release"与"请求失败"：再探一次仓库元信息
            data, status, _ = get_json(f"{API}/repos/{owner}/{repo}", token)
            if status != 200:
                failed.append(f"{tool_id} ({owner}/{repo}) status={status}")
        result[tool_id] = downloads
        release_counts[tool_id] = rel_count
        if i % 25 == 0 or i == len(repos):
            print(f"  进度 {i}/{len(repos)}  已累计 {sum(result.values()):,}", flush=True)
        time.sleep(0.05)

    nonzero = sum(1 for v in result.values() if v > 0)
    print(f"\n完成：{nonzero}/{len(result)} 个工具有真实下载量，合计 {sum(result.values()):,}", flush=True)
    if failed:
        print(f"请求失败 {len(failed)} 个：", flush=True)
        for f in failed[:20]:
            print("  -", f, flush=True)

    if dry:
        top = sorted(result.items(), key=lambda kv: -kv[1])[:20]
        print("\nTop 20：")
        for tid, dl in top:
            print(f"  {tid:24s} {dl:>10,}")
        return 0

    lines = [
        "/**",
        " * GitHub Release 资产累计下载量（自动生成，勿手改）",
        " * 由 scripts/fetch_downloads.py 生成；0 表示该仓库没有发布过带资产的 release。",
        " * 注意：star 是关注度，下载量才是实际分发量，榜单以此为准。",
        " */",
        "",
        "export const DOWNLOADS: Record<string, number> = {",
    ]
    for tool_id, _owner, _repo in repos:
        lines.append(f"  '{tool_id}': {result.get(tool_id, 0)},")
    lines.append("};")
    lines.append("")
    lines.append("export const RELEASE_COUNTS: Record<string, number> = {")
    for tool_id, _owner, _repo in repos:
        lines.append(f"  '{tool_id}': {release_counts.get(tool_id, 0)},")
    lines.append("};")
    lines.append("")
    stamp = datetime.now(timezone.utc).strftime("%Y-%m-%dT%H:%M:%SZ")
    lines.append(f"export const DOWNLOADS_FETCHED_AT = '{stamp}';")
    lines.append("")
    lines.append("export function downloadsOf(toolId: string): number {")
    lines.append("  return DOWNLOADS[toolId] ?? 0;")
    lines.append("}")
    lines.append("")
    OUT_TS.write_text("\n".join(lines), encoding="utf-8")
    print(f"已写入 {OUT_TS.relative_to(ROOT)}", flush=True)
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
