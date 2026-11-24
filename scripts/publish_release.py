"""创建 GitHub Release 并上传 MSI / 签名 / latest.json。

用法：
    python scripts/publish_release.py --version 0.4.0 --notes-file /path/to/notes.md
    python scripts/publish_release.py --version 0.4.0 --notes "一句话说明"

依赖：项目根目录 .github-token（需 repo 权限），以及已打包好的 bundle/msi 目录。
"""
import argparse
import json
import urllib.request
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REPO = "952774/open-source-repo"


def main():
    ap = argparse.ArgumentParser(description="发布 ToolArk Release")
    ap.add_argument("--version", required=True, help="版本号，如 0.4.0")
    ap.add_argument("--notes", default="", help="更新说明（纯文本）")
    ap.add_argument("--notes-file", default="", help="从文件读取更新说明（Markdown）")
    ap.add_argument("--repo", default=REPO, help="GitHub 仓库 owner/name")
    args = ap.parse_args()

    token = (ROOT / ".github-token").read_text(encoding="utf-8").strip()
    base = ROOT / "src-tauri" / "target" / "release" / "bundle" / "msi"
    notes = args.notes
    if args.notes_file:
        notes = Path(args.notes_file).read_text(encoding="utf-8")
    if not notes:
        notes = f"ToolArk {args.version}"

    # 文件名随 WiX 语言变化（zh-CN / en-US），用 glob 自动匹配
    msi_candidates = sorted(base.glob(f"ToolArk_{args.version}_x64_*.msi"))
    if not msi_candidates:
        raise SystemExit(f"找不到 ToolArk_{args.version}_x64_*.msi，请先打包")
    msi = msi_candidates[0]
    sig = msi.with_suffix(msi.suffix + ".sig")
    latest = base / "latest.json"
    for f, label in [(msi, "MSI"), (sig, "签名"), (latest, "latest.json")]:
        if not f.exists():
            raise SystemExit(f"缺少 {label}: {f}\n请先打包并生成 latest.json")

    def api(url, data=None, method="GET", raw=None, ctype=None):
        headers = {"Authorization": f"Bearer {token}", "User-Agent": "toolark"}
        if data is not None or ctype:
            headers["Accept"] = "application/vnd.github+json"
        if ctype:
            headers["Content-Type"] = ctype
        req = urllib.request.Request(url, data=raw if raw else (json.dumps(data).encode() if data else None), headers=headers, method=method)
        return json.load(urllib.request.urlopen(req, timeout=180))

    tag = f"v{args.version}"
    # 已存在同名 Release 时先删掉（便于重发）
    try:
        existing = api(f"https://api.github.com/repos/{args.repo}/releases/tags/{tag}")
        api(f"https://api.github.com/repos/{args.repo}/releases/{existing['id']}", method="DELETE")
        print(f"已删除旧 Release {tag}（准备重发）")
    except urllib.error.HTTPError:
        pass

    rel = api(
        f"https://api.github.com/repos/{args.repo}/releases",
        data={"tag_name": tag, "name": f"ToolArk {args.version}", "body": notes, "draft": False, "prerelease": False},
        method="POST",
        ctype="application/json",
    )
    print(f"Release 创建成功: {rel['html_url']}")

    for path, ctype in [(msi, "application/octet-stream"), (sig, "application/octet-stream"), (latest, "application/json")]:
        d = api(
            f"https://uploads.github.com/repos/{args.repo}/releases/{rel['id']}/assets?name={path.name}",
            method="POST", raw=path.read_bytes(), ctype=ctype,
        )
        print(f"  uploaded {path.name} ({d['size']} bytes)")

    print("发布完成")


if __name__ == "__main__":
    main()
