import { PutObjectCommand, S3Client, CreateBucketCommand, HeadBucketCommand, ListBucketsCommand } from '@aws-sdk/client-s3'

/**
 * 给本机 RustFS 灌一份可验证的材料：两个桶、几层前缀、一段中文文本、一张位图。
 *
 * 它是 S3 那个应用 `just shot` 与真机走查吃的材料，跟 make-mobi.py / make-jingang-epub.py 同一族：
 * 判据要看得见，就得先有东西可看。
 *
 * 用法（本机起着 RustFS）：
 *   node code/make-rustfs-demo.mjs
 *   S3_ENDPOINT=http://localhost:9000 S3_AK=rustfsadmin S3_SK=rustfsadmin node code/make-rustfs-demo.mjs
 */

const endpoint = process.env.S3_ENDPOINT ?? 'http://localhost:9000'
const accessKeyId = process.env.S3_AK ?? 'rustfsadmin'
const secretAccessKey = process.env.S3_SK ?? 'rustfsadmin'

const client = new S3Client({
  region: 'us-east-1',
  endpoint,
  credentials: { accessKeyId, secretAccessKey },
  forcePathStyle: true,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED'
})

const TEXT = '对象存储的中文文本。\n第二行也在这一段里。\n'
const PNG_1PX = Buffer.from(
  'iVBORw0KGgoAAAANSUhEUgAAAAQAAAAECAYAAACp8Z5+AAAAF0lEQVR42mP8z8Dwk4EBBAEhQgQAZIsG/Y9hY9IAAAAASUVORK5CYII=',
  'base64'
)

/** 一张最小的真位图：预览那一条判据要的是"图真画出来了"，好看与否不归它管 */
const items = [
  { bucket: 'demo', key: '说明.txt', body: Buffer.from(TEXT, 'utf8'), type: 'text/plain; charset=utf-8' },
  { bucket: 'demo', key: 'logs/2026-11/run.txt', body: Buffer.from('这一条在 logs/2026-11/ 这一层里。\n', 'utf8'), type: 'text/plain; charset=utf-8' },
  { bucket: 'demo', key: 'logs/2026-10/run.txt', body: Buffer.from('上一月的。\n', 'utf8'), type: 'text/plain; charset=utf-8' },
  { bucket: 'demo', key: 'pic.png', body: PNG_1PX, type: 'image/png' },
  { bucket: 'demo', key: 'big.bin', body: Buffer.alloc(3 * 1024 * 1024, 7), type: 'application/octet-stream' },
  { bucket: 'archive', key: 'README.md', body: Buffer.from('# 另一个桶\n', 'utf8'), type: 'text/markdown' }
]

async function ensureBucket(name) {
  try {
    await client.send(new HeadBucketCommand({ Bucket: name }))
    return '已有'
  } catch {
    await client.send(new CreateBucketCommand({ Bucket: name }))
    return '新建'
  }
}

for (const name of ['demo', 'archive']) {
  console.log(`bucket ${name}: ${await ensureBucket(name)}`)
}

for (const it of items) {
  await client.send(new PutObjectCommand({ Bucket: it.bucket, Key: it.key, Body: it.body, ContentType: it.type }))
  console.log(`put ${it.bucket}/${it.key} ${it.body.length} 字节`)
}

const list = await client.send(new ListBucketsCommand({}))
console.log('列出来是：', (list.Buckets ?? []).map((b) => b.Name).join(', '))
