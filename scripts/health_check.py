#!/usr/bin/env python3
"""ToolArk 工具清单健康巡检（仅使用 Python 标准库）。

功能：
  1. 从 src/data/tools.ts 正则提取每个工具的 id / name / repo / wingetId / lastUpdate；
     repo 与 lastUpdate 字段允许缺失（清单升级过程中的兼容）。
  2. 对每个配置了 repo 的工具调用 GitHub REST API，检查归档、长期未更新、仓库不存在。
  3. 对每个工具调用 winget show 验证 wingetId 是否仍有效（可用 --skip-winget 跳过）。
  4. 生成 reports/health-report.md；发现异常时退出码 1（--no-fail 强制 0）。

用法：
  python scripts/health_check.py [--skip-winget] [--no-fail]
  GITHUB_TOKEN=ghp_xxx python scripts/health_check.py   # 可选，提升 API 限额
"""

from __future__ import annotations

import argparse
import calendar
import json
import os
import re
import shutil
import subprocess
import sys
from datetime import datetime, timezone
from pathlib import Path
from urllib.error import HTTPError, URLError
from urllib.parse import quote
from urllib.request import Request, urlopen

ROOT = Path(__file__).resolve().parent.parent
TOOLS_FILE = ROOT / "src" / "data" / "tools.ts"
REPORT_FILE = ROOT / "reports" / "health-report.md"

STALE_MONTHS = 18
HTTP_TIMEOUT = 15
WINGET_TIMEOUT = 30
GITHUB_API = "https://api.github.com"


def extract_field(block: str, name: str, default: str = "") -> str:
    """提取形如 `name: 'value'` 或 `name: "value"` 的字段。"""
    pattern = r"\b" + re.escape(name) + r"\s*:\s*['\"]([^'\"]*)['\"]"
    match = re.search(pattern, block)
    return match.group(1) if match else default


def parse_tools(text: str) -> list[dict]:
    """在 TOOLS 数组范围内按对象块解析工具条目。"""
    start = text.find("export const TOOLS")
    if start == -1:
        raise ValueError("tools.ts 中未找到 export const TOOLS")
    bracket = text.find("[", start)
    end = text.find("\n];", bracket)
    section = text[bracket + 1 : end if end != -1 else len(text)]

    tools = []
    # 兼容多行与单行对象写法；工具条目内无嵌套花括号，遇到第一个 } 即结束
    for match in re.finditer(r"\{[^{}]*\bid\s*:\s*['\"][^'\"]+['\"][^{}]*\}", section, re.DOTALL):
        block = match.group(0)
        tools.append(
            {
                "id": extract_field(block, "id", "?"),
                "name": extract_field(block, "name"),
                "repo": extract_field(block, "repo"),
                "wingetId": extract_field(block, "wingetId"),
                "lastUpdate": extract_field(block, "lastUpdate"),
            }
        )
    return tools


def repo_slug(repo: str) -> str | None:
    """把 GitHub URL / git@ 地址 / owner/repo 统一转成 owner/repo。"""
    value = repo.strip().rstrip("/")
    if not value:
        return None
    value = re.sub(r"^(https?://(www\.)?github\.com/|git@github\.com:)", "", value, flags=re.I)
    value = re.sub(r"\.git$", "", value, flags=re.I)
    parts = value.split("/")
    if len(parts) == 2 and all(parts):
        return f"{quote(parts[0], safe='')}/{quote(parts[1], safe='')}"
    return None


def subtract_months(moment: datetime, months: int) -> datetime:
    total = moment.year * 12 + moment.month - 1 - months
    year, month_index = divmod(total, 12)
    month = month_index + 1
    day = min(moment.day, calendar.monthrange(year, month)[1])
    return moment.replace(year=year, month=month, day=day)


def is_stale(iso_date: str) -> bool:
    """判断日期是否早于 18 个月前；格式无法识别时不误报。"""
    try:
        moment = datetime.fromisoformat(iso_date.strip().replace("Z", "+00:00"))
    except (ValueError, AttributeError):
        return False
    if moment.tzinfo is None:
        moment = moment.replace(tzinfo=timezone.utc)
    return moment < subtract_months(datetime.now(timezone.utc), STALE_MONTHS)


def github_get(path: str, token: str) -> dict:
    headers = {
        "Accept": "application/vnd.github+json",
        "User-Agent": "toolark-health-check",
        "X-GitHub-Api-Version": "2022-11-28",
    }
    if token:
        headers["Authorization"] = f"Bearer {token}"
    request = Request(f"{GITHUB_API}{path}", headers=headers)
    with urlopen(request, timeout=HTTP_TIMEOUT) as response:
        return json.loads(response.read().decode("utf-8"))


def is_rate_limit(error: HTTPError) -> bool:
    remaining = error.headers.get("X-RateLimit-Remaining") if error.headers else None
    try:
        body = error.read().decode("utf-8", "ignore").lower()
    except Exception:
        body = ""
    return remaining == "0" or "rate limit" in body or "abuse detection" in body


def winget_id_valid(winget_id: str) -> bool:
    command = [
        "winget",
        "show",
        "--id",
        winget_id,
        "--exact",
        "--source",
        "winget",
        "--accept-source-agreements",
        "--disable-interactivity",
    ]
    result = subprocess.run(command, capture_output=True, text=True, timeout=WINGET_TIMEOUT)
    output = (result.stdout or "") + (result.stderr or "")
    if result.returncode != 0:
        return False
    return not re.search(r"no package found|no available package|未找到.*包", output, re.I)


def tool_label(tool: dict) -> str:
    name = tool["name"] or tool["id"]
    return f"{name} (`{tool['id']}`)" if name != tool["id"] else f"`{tool['id']}`"


def cell(value: str) -> str:
    return value.replace("|", "\\|").replace("\n", " ")


def main() -> int:
    parser = argparse.ArgumentParser(description="ToolArk 工具清单健康巡检")
    parser.add_argument("--skip-winget", action="store_true", help="跳过 winget ID 校验（较慢）")
    parser.add_argument("--no-fail", action="store_true", help="即使发现异常也返回退出码 0")
    args = parser.parse_args()

    try:
        tools = parse_tools(TOOLS_FILE.read_text(encoding="utf-8"))
    except (OSError, ValueError) as error:
        print(f"[ERROR] 读取工具清单失败: {error}", file=sys.stderr)
        return 2
    if not tools:
        print("[ERROR] 未从 tools.ts 解析到任何工具", file=sys.stderr)
        return 2

    # token 优先级：环境变量 > 本地 .github-token 文件（gitignore 保护）
    token = os.environ.get("GITHUB_TOKEN", "").strip()
    token_file = ROOT / ".github-token"
    if not token and token_file.exists():
        token = token_file.read_text(encoding="utf-8").strip()
    print(f"解析到 {len(tools)} 个工具；GitHub API {'使用 GITHUB_TOKEN' if token else '匿名访问（限流 60 次/小时）'}")

    abnormal: list[tuple[dict, list[tuple[str, str]]]] = []
    notes: set[str] = set()
    github_checked = 0
    github_skipped_no_repo = 0
    github_limited = False
    winget_checked = 0
    winget_skip_reason = "--skip-winget 参数" if args.skip_winget else ""
    if not winget_skip_reason and (sys.platform != "win32" or shutil.which("winget") is None):
        winget_skip_reason = "当前环境无 winget（仅 Windows 可用，CI 自动跳过）"

    for index, tool in enumerate(tools):
        issues: list[tuple[str, str]] = []

        slug = repo_slug(tool["repo"])
        github_ok = False
        if not slug:
            github_skipped_no_repo += 1
        elif github_limited:
            pass
        else:
            try:
                data = github_get(f"/repos/{slug}", token)
                github_ok = True
                github_checked += 1
                if data.get("archived"):
                    issues.append(("仓库已归档", "迁移到活跃替代项目，或接手维护 fork"))
                pushed_at = data.get("pushed_at") or ""
                if pushed_at and is_stale(pushed_at):
                    issues.append(
                        (
                            f"长期未更新（最后推送 {pushed_at[:10]}）",
                            "寻找活跃替代品，或自行维护 fork",
                        )
                    )
            except HTTPError as error:
                if error.code == 404:
                    issues.append(("仓库不存在（GitHub 404）", "核对 repo 地址，或项目已删除/更名"))
                elif error.code == 403 and is_rate_limit(error):
                    github_limited = True
                    notes.add(
                        "GitHub API 触发限流（403），后续 GitHub 检查已跳过；"
                        "设置环境变量 GITHUB_TOKEN 可提升限额。"
                    )
                else:
                    notes.add(f"{tool_label(tool)}：GitHub 检查失败（HTTP {error.code}），未判定异常")
            except (URLError, TimeoutError, OSError, ValueError) as error:
                notes.add(f"{tool_label(tool)}：GitHub 检查不可用（{type(error).__name__}），未判定异常")

        # repo 缺失 / GitHub 不可用时，退而使用清单里的 lastUpdate 判断陈旧度
        if not github_ok and not github_limited and tool["lastUpdate"] and is_stale(tool["lastUpdate"]):
            issues.append(
                (
                    f"清单标记长期未更新（lastUpdate {tool['lastUpdate']}）",
                    "核实项目状态，必要时更换为活跃工具",
                )
            )

        if not winget_skip_reason and tool["wingetId"]:
            try:
                if not winget_id_valid(tool["wingetId"]):
                    issues.append(("winget ID 已失效", "核对 wingetId 是否改名或下架，更新为有效 ID"))
                winget_checked += 1
            except subprocess.TimeoutExpired:
                notes.add(f"{tool_label(tool)}：winget 检查超时（{WINGET_TIMEOUT}s），未判定异常")
            except OSError as error:
                winget_skip_reason = f"winget 不可用（{error}）"
                notes.add("winget 命令不可用，后续 winget 检查已跳过")

        if issues:
            abnormal.append((tool, issues))

    normal = len(tools) - len(abnormal)
    now_iso = datetime.now(timezone.utc).strftime("%Y-%m-%d %H:%M:%S UTC")

    lines = [
        "# ToolArk 工具清单健康巡检报告",
        "",
        f"- 生成时间：{now_iso}",
        f"- 工具总数：**{len(tools)}**",
        f"- 正常工具：**{normal}**",
        f"- 异常工具：**{len(abnormal)}**",
        f"- 检查范围：GitHub {github_checked}/{len(tools)}，winget {winget_checked}/{len(tools)}",
        "",
        "## 异常工具清单",
        "",
    ]
    if abnormal:
        lines.extend(["| 工具 | 问题 | 建议动作 |", "| --- | --- | --- |"])
        for tool, issues in abnormal:
            problems = "; ".join(cell(problem) for problem, _ in issues)
            actions = "; ".join(cell(action) for _, action in issues)
            lines.append(f"| {cell(tool_label(tool))} | {problems} | {actions} |")
    else:
        lines.append("未发现异常工具。")

    if github_skipped_no_repo or winget_skip_reason or notes:
        lines.extend(["", "## 检查受限与跳过说明", ""])
        if github_skipped_no_repo:
            lines.append(f"- {github_skipped_no_repo} 个工具未配置 repo 字段，已跳过 GitHub 检查")
        if winget_skip_reason:
            lines.append(f"- winget 检查已跳过：{winget_skip_reason}")
        lines.extend(f"- {note}" for note in sorted(notes))

    REPORT_FILE.parent.mkdir(parents=True, exist_ok=True)
    REPORT_FILE.write_text("\n".join(lines) + "\n", encoding="utf-8")

    print(f"巡检完成：共 {len(tools)} 个工具，正常 {normal} 个，异常 {len(abnormal)} 个")
    print(f"报告已生成：{REPORT_FILE}")
    if notes:
        print(f"有 {len(notes)} 条检查受限提示，详见报告")
    return 1 if abnormal and not args.no_fail else 0


if __name__ == "__main__":
    sys.exit(main())
