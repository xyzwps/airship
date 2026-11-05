#!/usr/bin/env python3
"""造一个带内嵌封面的最小 EPUB，用来复现与验证"书架封面显示"。

为什么要有这个脚本：封面那条路（foliate getCover → 写进 covers/ → 渲染侧 <img>）
只有拿真 EPUB 跑一遍才看得见，手搓假数据验不到。

正文是《金刚经》（姚秦鸠摩罗什译本）的**节选**，只取开篇与几段人人认得的四句偈，
不是全本；这个文件的用途是测试样本，别当经文读。
封面图直接用仓库里真实的 assets/icon.png——不自己画图。

用法：python code/make-jingang-epub.py
产物：src/apps/books/tests/fixtures/金刚经.epub
"""

import io
import os
import zipfile

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
OUT = os.path.join(REPO, 'src', 'apps', 'books', 'tests', 'fixtures', '金刚经.epub')
COVER = os.path.join(REPO, 'assets', 'icon.png')

BOOK_ID = 'urn:uuid:6b9d2f4a-1f0e-4c1a-9d3b-0d6e2f7a1b55'
TITLE = '金刚经（测试节选）'
AUTHOR = '鸠摩罗什译（节选）'

# 节选：开篇 + 三段流传最广的经文。只作测试文本用。
CHAPTERS = [
    (
        '开篇',
        [
            '如是我闻。一时佛在舍卫国祇树给孤独园。与大比丘众千二百五十人俱。',
            '尔时世尊食时，著衣持钵，入舍卫大城乞食。于其城中次第乞已，还至本处。',
            '饭食讫，收衣钵，洗足已，敷座而坐。',
        ],
    ),
    (
        '四相',
        [
            '佛告须菩提："诸菩萨摩诃萨应如是降伏其心：所有一切众生之类，若卵生、若胎生、若湿生、若化生，'
            '若有色、若无色、若有想、若无想、若非有想非无想，我皆令入无余涅槃而灭度之。"',
            '如是灭度无量无数无边众生，实无众生得灭度者。',
            '何以故？须菩提！若菩萨有我相、人相、众生相、寿者相，即非菩萨。',
        ],
    ),
    (
        '虚妄相',
        [
            '凡所有相，皆是虚妄。若见诸相非相，即见如来。',
        ],
    ),
    (
        '末后四句偈',
        [
            '一切有为法，如梦幻泡影，如露亦如电，应作如是观。',
            '若以色见我，以音声求我，是人行邪道，不能见如来。',
        ],
    ),
]

MIMETYPE = 'application/epub+zip'

CONTAINER = """<?xml version="1.0" encoding="UTF-8"?>
<container version="1.0" xmlns="urn:oasis:names:tc:opendocument:xmlns:container">
  <rootfiles>
    <rootfile full-path="OEBPS/content.opf" media-type="application/oebps-package+xml"/>
  </rootfiles>
</container>
"""

STYLE = """@page { margin: 1.2em; }
body { font-family: serif; line-height: 1.8; }
h1 { font-size: 1.3em; text-align: center; }
p { text-indent: 2em; margin: 0 0 .6em; }
"""


def xhtml(title: str, paras: list[str]) -> str:
    body = '\n'.join(f'    <p>{p}</p>' for p in paras)
    return (
        '<?xml version="1.0" encoding="UTF-8"?>\n'
        '<!DOCTYPE html>\n'
        '<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">\n'
        '<head><title>' + title + '</title><link rel="stylesheet" type="text/css" href="style.css"/></head>\n'
        '<body>\n  <h1>' + title + '</h1>\n' + body + '\n</body>\n</html>\n'
    )


def opf(items: list[tuple[str, str, str, str]]) -> str:
    """items: (id, href, media-type, properties)"""
    manifest = '\n'.join(
        f'    <item id="{i}" href="{h}" media-type="{m}"{f' properties="{p}"' if p else ''}/>' for i, h, m, p in items
    )
    spine = '\n'.join(f'    <itemref idref="{i}"/>' for i, h, m, p in items if h.startswith('ch'))
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="uid" xml:lang="zh-CN">
  <metadata xmlns:dc="http://purl.org/dc/elements/1.1/">
    <dc:identifier id="uid">{BOOK_ID}</dc:identifier>
    <dc:title>{TITLE}</dc:title>
    <dc:creator id="creator">{AUTHOR}</dc:creator>
    <dc:language>zh-CN</dc:language>
    <meta property="dcterms:modified">2026-11-06T00:00:00Z</meta>
    <!-- 封面：EPUB3 用 properties，EPUB2 用 meta name="cover"，两条都给，foliate 认哪条都能拿到 -->
    <meta name="cover" content="cover-image"/>
  </metadata>
  <manifest>
    <item id="nav" href="nav.xhtml" media-type="application/xhtml+xml" properties="nav"/>
    <item id="ncx" href="toc.ncx" media-type="application/x-dtbncx+xml"/>
    <item id="css" href="style.css" media-type="text/css"/>
    <item id="cover-image" href="images/cover.png" media-type="image/png" properties="cover-image"/>
{manifest}
  </manifest>
  <spine toc="ncx">
{spine}
  </spine>
</package>
"""


def nav(chapters: list[tuple[str, str]]) -> str:
    lis = '\n'.join(f'      <li><a href="ch{n:02d}.xhtml">{t}</a></li>' for n, (t, _) in enumerate(chapters, 1))
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE html>
<html xmlns="http://www.w3.org/1999/xhtml" xmlns:epub="http://www.idpf.org/2007/ops" xml:lang="zh-CN">
<head><title>{TITLE}</title></head>
<body>
  <nav epub:type="toc"><ol>
{lis}
  </ol></nav>
</body>
</html>
"""


def ncx(chapters: list[tuple[str, str]]) -> str:
    points = '\n'.join(
        f"""    <navPoint id="np{n}" playOrder="{n}">
      <navLabel><text>{t}</text></navLabel><content src="ch{n:02d}.xhtml"/>
    </navPoint>"""
        for n, (t, _) in enumerate(chapters, 1)
    )
    return f"""<?xml version="1.0" encoding="UTF-8"?>
<ncx xmlns="http://www.daisy.org/z3986/2005/ncx/" version="2005-1">
  <head><meta name="dtb:uid" content="{BOOK_ID}"/></head>
  <docTitle><text>{TITLE}</text></docTitle>
  <navMap>
{points}
  </navMap>
</ncx>
"""


def build() -> None:
    chapters = [(t, ps) for t, ps in CHAPTERS]
    items = []
    for n, (t, _) in enumerate(chapters, 1):
        items.append((f'ch{n:02d}', f'ch{n:02d}.xhtml', 'application/xhtml+xml', ''))

    os.makedirs(os.path.dirname(OUT), exist_ok=True)
    with open(COVER, 'rb') as f:
        cover_bytes = f.read()

    with zipfile.ZipFile(OUT, 'w') as z:
        # mimetype 必须是第一个条目且不压缩，否则部分阅读器不认
        z.writestr(zipfile.ZipInfo('mimetype'), MIMETYPE)
        z.writestr('META-INF/container.xml', CONTAINER)
        z.writestr('OEBPS/content.opf', opf(items))
        z.writestr('OEBPS/toc.ncx', ncx(chapters))
        z.writestr('OEBPS/nav.xhtml', nav(chapters))
        z.writestr('OEBPS/style.css', STYLE)
        z.writestr('OEBPS/images/cover.png', io.BytesIO(cover_bytes).read())
        for n, (t, ps) in enumerate(chapters, 1):
            z.writestr(f'OEBPS/ch{n:02d}.xhtml', xhtml(t, ps))

    print(f'已生成 {OUT}  {os.path.getsize(OUT)} 字节，章节 {len(chapters)} 节，封面 {len(cover_bytes)} 字节')


if __name__ == '__main__':
    build()
