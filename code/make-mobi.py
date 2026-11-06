#!/usr/bin/env python3
"""造一个真的 MOBI，用来补上 TD-011 那个"MOBI 没有样本可验"的缺口。

正文是《老子》（道德经）匯校版全本八十一章，来自 zh.wikisource（2026-11-06 抓取，
剥掉校勘模板只留主文），跟着夹具放在 `src/apps/books/tests/fixtures/道德经.txt`。

格式这一层不凭记忆写：每个字段都对着 `node_modules/foliate-js/mobi.js` 里
`PDB_HEADER / PALMDOC_HEADER / MOBI_HEADER / EXTH_HEADER` 实际读的位置来的——
壳的 MOBI 通路就是那份解析器，能把它读对才算验到点上。刻意选最朴素的一档：

- `compression = 1`（不压）、`encryption = 0`、`trailingFlags = 0`：解析器对应
  `f => f` 与"不删尾部字节"，少两处可能出错的地方；
- `encoding = 65001`（UTF-8）、`localeLanguage = 4`（zh）；
- `version = 1` 且 EXTH 不写 121 boundary → 走 MOBI6 那条路，不是 KF8；
- 每章前面放一个 `<mbp:pagebreak/>`：MOBI6 就是按它切节的，于是八十一章是八十一节，
  翻页与进度都真跑得起来；
- 文本按 4096 字节切记录（切在字符中间没关系：解析器先把所有文本记录拼回一整块再解码）。

用法：python code/make-mobi.py
产物：src/apps/books/tests/fixtures/道德经.mobi
"""

import os
import struct

REPO = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
FIXTURES = os.path.join(REPO, 'src', 'apps', 'books', 'tests', 'fixtures')
TEXT = os.path.join(FIXTURES, '道德经.txt')
OUT = os.path.join(FIXTURES, '道德经.mobi')

TITLE = '道德經（老子匯校版）'
AUTHOR = '老子（zh.wikisource 匯校版）'
DESCRIPTION = '測試樣本：全本八十一章，剥掉校勘模板只留主文。'

RECORD_SIZE = 4096
MOBI_HEADER_LEN = 248  # 要装到 indx(244)+4，解析器读的就是这个区间里的字段


def u8(text: str) -> bytes:
    return text.encode('utf-8')


def exth_record(kind: int, value: bytes) -> bytes:
    """一条 EXTH 记录：length 含那 8 字节的头，记录之间不留填充。

    按 `mobi.js` 的 `getEXTH` 写，不靠对手册的印象：它 `data = slice(offset+8, offset+length)`
    且 `offset += length`——长度含头，而且**不会跳过填充字节**。所以这里干脆不补填充：
    补了要么让下一条错位，要么把空格读进作者名里。
    """
    return struct.pack('>II', kind, 8 + len(value)) + value


def html_body() -> str:
    """正文 → 一节一章的 HTML（MOBI6 按 `<mbp:pagebreak/>` 切节）

    第一页是扉页，不是空节：pagebreak 只放在"下一节之前"，最前面那个会切出一张
    只有文档头的空页——真打开时看到的就是白屏（第一版就踩了）。
    """
    with open(TEXT, encoding='utf-8') as f:
        lines = [line.strip() for line in f.read().split('\n')]

    parts = [f'<h1>{TITLE}</h1>', f'<p>{AUTHOR}</p>']
    chapters = 0
    for line in lines:
        if not line:
            continue
        if line in ('道經', '德經'):
            parts.append(f'<mbp:pagebreak/><h1>{line}</h1>')
        elif line.startswith('第') and line.endswith('章') and len(line) <= 5:
            parts.append(f'<mbp:pagebreak/><h2>{line}</h2>')
            chapters += 1
        else:
            parts.append(f'<p>{line}</p>')
    html = (
        '<html><head><title>' + TITLE + '</title>'
        '<meta http-equiv="Content-Type" content="text/html; charset=utf-8"/></head><body>'
        + ''.join(parts) + '</body></html>'
    )
    return html, chapters


def main() -> None:
    html, chapters = html_body()
    raw = u8(html)
    text_records = [raw[i:i + RECORD_SIZE] for i in range(0, len(raw), RECORD_SIZE)]
    num_text = len(text_records)

    # --- EXTH 先建好，MOBI 头里要按它的总长度算标题偏移 ---
    exth_records = b''.join([
        exth_record(100, u8(AUTHOR)),
        exth_record(103, u8(DESCRIPTION)),
        exth_record(106, u8('2026-11-06')),
        exth_record(109, u8('公有领域')),
    ])
    exth = b'EXTH' + struct.pack('>II', 12 + len(exth_records), 4) + exth_records

    title_bytes = u8(TITLE)
    title_offset = 16 + MOBI_HEADER_LEN + len(exth)

    rec0 = bytearray(16 + MOBI_HEADER_LEN)

    def put(at: int, value: bytes) -> None:
        rec0[at:at + len(value)] = value

    # PalmDOC 头（偏移 0..16）
    put(0 + 0, struct.pack('>H', 1))                    # compression: 1 = 不压
    put(0 + 4, struct.pack('>I', len(raw)))             # textLength（未压前的字节数）
    put(0 + 8, struct.pack('>H', num_text))             # numTextRecords
    put(0 + 10, struct.pack('>H', RECORD_SIZE))         # recordSize
    put(0 + 12, struct.pack('>H', 0))                   # encryption: 0
    put(0 + 14, struct.pack('>H', 0))                   # unused

    # MOBI 头（从偏移 16 起，字段偏移按 mobi.js 的 MOBI_HEADER 对照）
    o = 16
    put(o + 0, b'MOBI')                                 # magic
    put(o + 4, struct.pack('>I', MOBI_HEADER_LEN))      # length
    put(o + 8, struct.pack('>I', 2))                    # type: 2 = MOBI book
    put(o + 12, struct.pack('>I', 65001))               # encoding: UTF-8
    put(o + 16, struct.pack('>I', 0))                   # uid
    put(o + 20, struct.pack('>I', 1))                   # version: 1（<8 → MOBI6，不走 KF8）
    put(o + 68, struct.pack('>I', title_offset))        # titleOffset
    put(o + 72, struct.pack('>I', len(title_bytes)))    # titleLength
    put(o + 78, bytes([2]))                             # localeRegion
    put(o + 79, bytes([4]))                             # localeLanguage: 4 = zh
    put(o + 92, struct.pack('>I', 1 + num_text))        # resourceStart（本书无资源）
    put(o + 96, struct.pack('>I', 0))                   # huffcdic
    put(o + 100, struct.pack('>I', 0))                  # numHuffcdic
    put(o + 112, struct.pack('>I', 0x40))               # exthFlag: bit6 置起
    put(o + 224, struct.pack('>I', 0))                  # trailingFlags: 无尾部字节
    put(o + 228, struct.pack('>I', 0))                  # indx: 不做索引

    record0 = bytes(rec0) + exth + title_bytes

    # --- 拼文件：PDB 头 78 字节 + 记录清单（每条 8 字节）+ 各记录 ---
    all_records = [record0] + text_records
    offsets = []
    pos = 78 + len(all_records) * 8
    for rec in all_records:
        offsets.append(pos)
        pos += len(rec)

    header = bytearray(78)
    name = u8(TITLE)[:31]
    header[0:len(name)] = name
    header[60:64] = b'BOOK'                              # 与 creator 合起来是 'BOOKMOBI'
    header[64:68] = b'MOBI'
    header[76:78] = struct.pack('>H', len(all_records))

    out = bytearray(header)
    for off in offsets:
        out += struct.pack('>I', off) + b'\x00\x00\x00\x00'
    for rec in all_records:
        out += rec

    with open(OUT, 'wb') as f:
        f.write(out)

    print(f'已生成 {OUT}（{len(out)} 字节）')
    print(f'正文 HTML {len(raw)} 字节 → 文本记录 {num_text} 块（每块 ≤{RECORD_SIZE}）；章 {chapters} 节')


if __name__ == '__main__':
    main()
