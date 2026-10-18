# -*- coding: utf-8 -*-
"""生成安卓启动图标：深色圆角底 + 琥珀色音符。

用 Python 画而不是找素材，是为了这个仓库不引入二进制美术资源——
改颜色只要改这里几个数字，重跑一次就有新图标。
"""
from PIL import Image, ImageDraw

S = 192          # 存成 xxxhdpi 的 192px 就够（系统会缩）
BG = (14, 15, 21)
AMBER = (255, 182, 72)
R = 44           # 圆角半径

img = Image.new('RGBA', (S, S), (0, 0, 0, 0))
d = ImageDraw.Draw(img)
d.rounded_rectangle([0, 0, S - 1, S - 1], radius=R, fill=BG)

# 音符：两颗符头 + 两根符干 + 一条横杠
cx, base_y = 74, 128
r = 17
d.ellipse([cx - r, base_y - r, cx + r, base_y + r], fill=AMBER)
d.ellipse([cx + 56 - r, base_y - 24 - r, cx + 56 + r, base_y - 24 + r], fill=AMBER)
d.rounded_rectangle([cx + r - 6, 40, cx + r + 1, base_y], radius=3, fill=AMBER)
d.rounded_rectangle([cx + 56 + r - 6, 16, cx + 56 + r + 1, base_y - 24], radius=3, fill=AMBER)
d.polygon([(cx + r - 7, 40), (cx + 56 + r + 1, 16),
           (cx + 56 + r + 1, 46), (cx + r - 7, 70)], fill=AMBER)

img.save('res/mipmap-xxxhdpi/ic_launcher.png')
img.resize((96, 96), Image.LANCZOS).save('res/mipmap-xhdpi/ic_launcher.png')
img.resize((72, 72), Image.LANCZOS).save('res/mipmap-hdpi/ic_launcher.png')
print('图标已生成：mipmap-{hdpi,xhdpi,xxxhdpi}/ic_launcher.png')
