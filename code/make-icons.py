"""从母版图重出壳用的图标尺寸，并顺手把主色取出来给标题栏那颗品牌图形用。

用法：python code/make-icons.py
输入：assets/icon-master.png（用户给的 800×800 母版）
产物：assets/icon.png（256×256，窗口图标）、assets/tray.png（16×16，托盘默认图标）
"""

import io
import os

from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(REPO, 'assets', 'icon-master.png')


def center_square(im: Image.Image) -> Image.Image:
    """母版不是正方形的话裁中间那块，别拉变形"""
    w, h = im.size
    side = min(w, h)
    left = (w - side) // 2
    top = (h - side) // 2
    return im.crop((left, top, left + side, top + side))


def main() -> None:
    src = center_square(Image.open(MASTER).convert('RGBA'))
    print('母版', src.size)

    # 窗口图标：256 够任务栏与 Alt-Tab 用，Electron 自己会再缩
    src.resize((256, 256), Image.LANCZOS).save(os.path.join(REPO, 'assets', 'icon.png'), optimize=True)

    # 托盘 16×16：先盒式缩小（保留四块色的存在感），再转最近邻避免糊成一团灰
    src.resize((16, 16), Image.BOX).save(os.path.join(REPO, 'assets', 'tray.png'), optimize=True)

    # 取四个象限的主色，给标题栏那颗 SVG 当常量
    big = src.resize((200, 200), Image.LANCZOS)
    spots = {
        '左上（橙）': (70, 70),
        '右上（绿）': (130, 70),
        '左下（蓝）': (70, 135),
        '右下（粉）': (130, 135),
        '底': (100, 20),
    }
    for name, xy in spots.items():
        r, g, b, _ = big.getpixel(xy)
        print(f'  {name}: #{r:02x}{g:02x}{b:02x}')

    for f in ('assets/icon.png', 'assets/tray.png'):
        p = os.path.join(REPO, f)
        i = Image.open(p)
        print(f, i.size, os.path.getsize(p), '字节')


if __name__ == '__main__':
    main()
