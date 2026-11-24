"""生成 ToolArk 品牌图标源图（1024x1024 PNG）。
设计：蓝紫渐变圆角方形底 + 白色盾牌 + 盾内工具箱手柄意象。
无外部素材依赖，纯 Pillow 绘制。
"""
from PIL import Image, ImageDraw
import math
import os

SIZE = 1024
img = Image.new("RGBA", (SIZE, SIZE), (0, 0, 0, 0))
px = img.load()

# 圆角矩形渐变背景（半径 220），从左上 indigo 到右下 violet
R = 220
def in_rounded(x, y):
    if R <= x <= SIZE - R or R <= y <= SIZE - R:
        return True
    cx = R if x < R else SIZE - R
    cy = R if y < R else SIZE - R
    return (x - cx) ** 2 + (y - cy) ** 2 <= R ** 2

for y in range(SIZE):
    for x in range(SIZE):
        if in_rounded(x, y):
            t = (x / SIZE) * 0.5 + (y / SIZE) * 0.5
            r = int(79 + (124 - 79) * t)
            g = int(70 + (58 - 70) * t)
            b = int(229 + (237 - 229) * t)
            px[x, y] = (r, g, b, 255)

d = ImageDraw.Draw(img)

# 盾牌外轮廓（白色半透明）
shield = [
    (512, 200),
    (800, 300),
    (800, 560),
    (762, 720),
    (512, 880),
    (262, 720),
    (224, 560),
    (224, 300),
]
d.polygon(shield, fill=(255, 255, 255, 245))

# 内盾（浅色描边层次）
inner = [
    (512, 258),
    (748, 342),
    (748, 552),
    (716, 682),
    (512, 812),
    (308, 682),
    (276, 552),
    (276, 342),
]
d.line(inner + [inner[0]], fill=(124, 58, 237, 90), width=6, joint="curve")

# 盾内：工具箱主体（紫色）
box_l, box_r, box_t, box_b = 360, 664, 470, 660
d.rounded_rectangle([box_l, box_t, box_r, box_b], radius=26, fill=(79, 70, 229, 255))
# 工具箱手柄
d.arc([448, 386, 576, 500], start=180, end=360, fill=(79, 70, 229, 255), width=26)
# 工具箱搭扣
d.rounded_rectangle([492, 470, 532, 520], radius=8, fill=(255, 255, 255, 255))
# 箱面分割线
d.line([(box_l + 24, 560), (box_r - 24, 560)], fill=(255, 255, 255, 120), width=8)

out = os.path.join(os.path.dirname(__file__), "..", "app-icon.png")
img.save(out)
print("saved:", os.path.abspath(out))
