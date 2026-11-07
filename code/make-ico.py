"""由母版 PNG 生成 Windows 应用图标 src/shell/assets/icon.ico（多尺寸一次出齐）。

风格对齐 wslc-desktop 的 `just icon`：母版是唯一的图，ico 是产物，随时可重出。

用法：python code/make-ico.py
输入：src/shell/assets/icon-master.png
产物：src/shell/assets/icon.ico（16 / 24 / 32 / 48 / 64 / 128 / 256）
"""

import os

from PIL import Image

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
MASTER = os.path.join(REPO, 'src', 'shell', 'assets', 'icon-master.png')
OUT = os.path.join(REPO, 'src', 'shell', 'assets', 'icon.ico')

SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> None:
    src = Image.open(MASTER).convert('RGBA')
    w, h = src.size
    side = min(w, h)
    if side != w or side != h:
        left, top = (w - side) // 2, (h - side) // 2
        src = src.crop((left, top, left + side, top + side))

    # 基准图必须是最大的那张：Pillow 从基准图重采样出 sizes 里每一档，
    # 拿 16×16 当基准会得到一个只装着放大图的空壳 ico（736 字节那种）
    big = src.resize((256, 256), Image.LANCZOS)
    big.save(OUT, format='ICO', sizes=[(s, s) for s in SIZES])
    print(f'已生成 {OUT}，尺寸 {SIZES}，{os.path.getsize(OUT)} 字节')


if __name__ == '__main__':
    main()
