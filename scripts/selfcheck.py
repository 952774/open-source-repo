"""自检脚本：核对 i18n key 完整性、遗留排序口径、数据文件一致性。

用法：python scripts/selfcheck.py
"""
from __future__ import annotations

import pathlib
import re
import sys

ROOT = pathlib.Path(__file__).resolve().parent.parent
SRC = ROOT / "src"


def check_i18n() -> list[str]:
    problems: list[str] = []
    i18n = (SRC / "lib" / "i18n.ts").read_text(encoding="utf-8")
    zh_block = i18n.split("zh: {", 1)[1].split("en: {", 1)[0]
    en_block = i18n.split("en: {", 1)[1].split("}", 1)[0]
    zh_keys = set(re.findall(r"(\w+):\s*'", zh_block))
    en_keys = set(re.findall(r"(\w+):\s*'", en_block))
    print(f"i18n keys: zh={len(zh_keys)} en={len(en_keys)}")
    only_zh = sorted(zh_keys - en_keys)
    only_en = sorted(en_keys - zh_keys)
    if only_zh:
        problems.append(f"仅中文有的 key: {only_zh}")
    if only_en:
        problems.append(f"仅英文有的 key: {only_en}")

    used: set[str] = set()
    for f in SRC.rglob("*.tsx"):
        text = f.read_text(encoding="utf-8")
        used |= set(re.findall(r"\bT\('(\w+)'\)", text))
        used |= set(re.findall(r"\bt\(lang,\s*'(\w+)'\)", text))
    missing = sorted(used - zh_keys)
    print(f"used keys: {len(used)}")
    if missing:
        problems.append(f"代码引用但未定义的 key: {missing}")
    unused = sorted(zh_keys - used)
    if unused:
        print(f"未使用的 key（可清理）: {unused}")
    return problems


def check_sorting() -> list[str]:
    for f in list(SRC.rglob("*.ts")) + list(SRC.rglob("*.tsx")):
        if f.name.endswith(".test.ts"):
            continue
        for i, line in enumerate(f.read_text(encoding="utf-8").splitlines(), 1):
            if "parseStars(" in line and "export function" not in line:
                print(f"parseStars 使用点 {f.relative_to(ROOT)}:{i}  {line.strip()[:90]}")
    return []


def check_data() -> list[str]:
    problems: list[str] = []
    tools = (SRC / "data" / "tools.ts").read_text(encoding="utf-8")
    # 只取带 wingetId 的对象块，套装（BUNDLES）不算工具
    blocks = re.split(r"\n  \{", tools)
    ids: list[str] = []
    for b in blocks:
        m = re.search(r"id: '([^']+)'", b)
        if m and "wingetId:" in b:
            ids.append(m.group(1))
    print(f"tools: {len(ids)} 条，唯一 {len(set(ids))}")

    downloads = (SRC / "data" / "downloads.ts").read_text(encoding="utf-8")
    stamp = re.search(r"DOWNLOADS_FETCHED_AT\s*=\s*'([^']*)'", downloads)
    stamp_val = stamp.group(1) if stamp else "<缺失>"
    print(f"下载量数据时间: {stamp_val}")
    if stamp_val == "pending":
        problems.append("downloads.ts 仍是占位数据，需要先跑 scripts/fetch_downloads.py")

    dl_keys = set(re.findall(r"^\s{2}'([^']+)':", downloads, re.M))
    print(f"有下载量记录: {len(dl_keys)} / {len(ids)}（其余为 0 下载，正常）")

    shots = (SRC / "data" / "shots.ts").read_text(encoding="utf-8")
    shot_keys = set(re.findall(r"^\s{2}'([^']+)':", shots, re.M))
    no_shot = [i for i in ids if i not in shot_keys]
    print(f"有截图: {len(shot_keys)} / {len(ids)}")
    if no_shot:
        problems.append(f"缺少截图的工具: {no_shot[:10]}")
    return problems


def check_release_meta() -> list[str]:
    problems: list[str] = []
    pkg = (ROOT / "package.json").read_text(encoding="utf-8")
    conf = (ROOT / "src-tauri" / "tauri.conf.json").read_text(encoding="utf-8")
    cargo = (ROOT / "src-tauri" / "Cargo.toml").read_text(encoding="utf-8")
    v_pkg = re.search(r'"version":\s*"([^"]+)"', pkg).group(1)
    v_conf = re.search(r'"version":\s*"([^"]+)"', conf).group(1)
    v_cargo = re.search(r'^version\s*=\s*"([^"]+)"', cargo, re.M).group(1)
    print(f"版本: package.json={v_pkg} tauri.conf.json={v_conf} Cargo.toml={v_cargo}")
    if len({v_pkg, v_conf, v_cargo}) != 1:
        problems.append("三处版本号不一致")
    if '"csp": null' in conf:
        problems.append("CSP 仍为 null")
    if "tauri-plugin-shell" in cargo:
        problems.append("Cargo.toml 仍依赖 tauri-plugin-shell（已无前端引用）")
    if "tauri-plugin-single-instance" not in cargo:
        problems.append("缺少 single-instance 插件")
    return problems


def main() -> int:
    problems: list[str] = []
    for name, fn in [
        ("i18n", check_i18n),
        ("排序口径", check_sorting),
        ("数据文件", check_data),
        ("发布元数据", check_release_meta),
    ]:
        print(f"\n--- {name} ---")
        problems += fn()
    print("\n--- 结论 ---")
    if problems:
        for p in problems:
            print(f"✗ {p}")
        return 1
    print("✓ 全部检查通过")
    return 0


if __name__ == "__main__":
    sys.exit(main())
