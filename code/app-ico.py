"""把一张位图转成多尺寸 Windows .ico（应用安装器的快捷方式图标用）。

用法：python code/app-ico.py <输入图> <输出.ico>
输入是包内那张图：SVG 已由 @resvg/resvg-js 渲染成 PNG（Pillow 不认 SVG，本机事实）。
与 make-ico.py 同一条做法：先裁方、重采样到 256 当基准，再出 16~256 各档。
"""

import sys

from PIL import Image

SIZES = [16, 24, 32, 48, 64, 128, 256]


def main() -> None:
    if len(sys.argv) != 3:
        print('用法：python code/app-ico.py <输入图> <输出.ico>')
        sys.exit(1)
    src = Image.open(sys.argv[1]).convert('RGBA')
    w, h = src.size
    side = min(w, h)
    if side != w or side != h:
        left, top = (w - side) // 2, (h - side) // 2
        src = src.crop((left, top, left + side, top + side))
    big = src.resize((256, 256), Image.LANCZOS)
    big.save(sys.argv[2], format='ICO', sizes=[(s, s) for s in SIZES])
    print(f'已生成 {sys.argv[2]}，尺寸 {SIZES}')


if __name__ == '__main__':
    main()