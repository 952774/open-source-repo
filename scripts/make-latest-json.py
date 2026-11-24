"""生成 Tauri updater 的 latest.json 静态更新清单。
从已构建的 MSI + .sig 文件自动提取数据，输出到 bundle 目录。
用法：python scripts/make-latest-json.py --repo <你的GitHub用户名/仓库名> --version 0.1.0
"""
import argparse
import json
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BUNDLE = ROOT / "src-tauri" / "target" / "release" / "bundle" / "msi"


def main():
    ap = argparse.ArgumentParser(description="生成 Tauri updater latest.json")
    ap.add_argument("--repo", required=True, help="GitHub 仓库，格式：用户名/仓库名")
    ap.add_argument("--version", default=None, help="版本号（默认从 MSI 文件名推断）")
    ap.add_argument("--notes", default="Bug fixes and improvements", help="更新说明")
    args = ap.parse_args()

    if not BUNDLE.exists():
        raise SystemExit(f"找不到 bundle 目录：{BUNDLE}\n请先运行 npm run tauri build --bundles msi")

    msis = list(BUNDLE.glob("*.msi"))
    sigs = list(BUNDLE.glob("*.msi.sig"))
    if not msis:
        raise SystemExit("找不到 MSI 文件")
    if not sigs:
        raise SystemExit("找不到 .sig 签名文件（打包时需设置 TAURI_SIGNING_PRIVATE_KEY）")

    # 按版本号精确匹配，避免 bundle 目录里残留旧版本时拿错包
    if args.version:
        msis = [m for m in msis if m.name.startswith(f"ToolArk_{args.version}_")]
        sigs = [s for s in sigs if s.name.startswith(f"ToolArk_{args.version}_")]
        if not msis:
            raise SystemExit(f"找不到 ToolArk_{args.version}_*.msi，请先打包该版本")
    msi = max(msis, key=lambda p: p.stat().st_mtime)
    sig = next((s for s in sigs if s.name == msi.name + ".sig"), None)
    if sig is None:
        raise SystemExit(f"找不到配套签名：{msi.name}.sig")
    version = args.version or msi.stem.split("_")[1]

    download_url = (
        f"https://github.com/{args.repo}/releases/download/"
        f"v{version}/{msi.name}"
    )

    latest = {
        "version": version,
        "notes": args.notes,
        # Tauri updater 必须能解析 RFC3339 时间，空字符串会报
        # invalid value for `pub_date`: the 'year' component could not be parsed
        "pub_date": __import__("datetime").datetime.now(__import__("datetime").timezone.utc)
        .strftime("%Y-%m-%dT%H:%M:%SZ"),
        "platforms": {
            "windows-x86_64": {
                "signature": sig.read_text(encoding="utf-8").strip(),
                "url": download_url,
            }
        },
    }

    out = BUNDLE / "latest.json"
    out.write_text(json.dumps(latest, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"已生成：{out}")
    print(f"下载地址：{download_url}")
    print("\n发布步骤：")
    print(f"1. 在 GitHub 创建仓库 {args.repo}")
    print(f"2. 创建 Release v{version}")
    print(f"3. 上传 {msi.name}、{sig.name}、latest.json 到 Release")
    print("4. 把 tauri.conf.json 的 endpoints 改成：")
    print(f'   "https://github.com/{args.repo}/releases/latest/download/latest.json"')


if __name__ == "__main__":
    main()
