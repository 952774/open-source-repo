"""ToolArk 清单维护：移除所有 openSource: false 的工具块。
用法：python scripts/filter_opensource.py [--check]
默认直接修改 src/data/tools.ts；--check 只检查不修改。
"""
import re
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TARGET = ROOT / "src" / "data" / "tools.ts"

text = TARGET.read_text(encoding="utf-8")
lines = text.splitlines(keepends=True)

# 识别以 "  {" 开头、"  }," 结尾的工具对象块
blocks = []
start = None
for i, line in enumerate(lines):
    if line.rstrip("\n") == "  {":
        start = i
    elif start is not None and line.rstrip("\n") == "  },":
        blocks.append((start, i))
        start = None

removed = []
keep = []
cursor = 0
for start, end in blocks:
    keep.extend(lines[cursor:start])
    block = "".join(lines[start:end + 1])
    if "openSource: false" in block:
        m = re.search(r"id: '([^']+)'", block)
        removed.append(m.group(1) if m else "?")
    else:
        keep.extend(lines[start:end + 1])
    cursor = end + 1
keep.extend(lines[cursor:])

print(f"工具块总数: {len(blocks)}")
print(f"移除闭源工具 {len(removed)}: {', '.join(removed)}")
print(f"剩余工具块: {len(blocks) - len(removed)}")

if "--check" in sys.argv:
    # CI 模式：发现闭源工具时返回非零退出码，阻止构建
    if removed:
        print(f"ERROR: 发现 {len(removed)} 款闭源工具，违反开源定位！", file=sys.stderr)
        sys.exit(1)
else:
    TARGET.write_text("".join(keep), encoding="utf-8")
    print(f"已更新: {TARGET}")
