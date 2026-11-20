import { describe, expect, it } from 'vitest'
import {
  describeRunIssue,
  emptyRunSpec,
  quote,
  recordRunHistory,
  runArgs,
  runCommand,
  tokenize,
  tryParseRun,
  validateRunSpec,
  type LabelRow,
  type PortRow,
  type RunSpec
} from '../run'

/**
 * 编排页的纯逻辑（node 环境，不开界面）：拼装、校验、分词转义与读回。
 *
 * 这一层的判据全部来自原项目 wslc-desktop 对 wslc 3.0.x 的实测
 * （docs/notes/run-command.md），用例是把那张实测表换一种语言再钉一遍：
 * 顺序恒定、同源一致、显示 → 读回 → 显示 逐字不变。
 */

const port = (patch: Partial<PortRow> = {}): PortRow => ({
  hostIp: '',
  hostPort: '',
  containerPort: '',
  protocol: 'tcp',
  ...patch
})

const label = (key: string, value: string): LabelRow => ({ key, value })

/** 每一族选项至少有一行值的满表——顺序样例与同源断言都吃它 */
function fullSpec(): RunSpec {
  return {
    ...emptyRunSpec(),
    image: 'nginx:1.27',
    detach: true,
    interactive: true,
    tty: true,
    rm: true,
    publishAll: true,
    pullPolicy: 'always',
    name: 'web',
    hostname: 'myhost',
    network: 'host',
    cpus: '2',
    memory: '512m',
    shmSize: '64m',
    workdir: '/app',
    user: '1000:1000',
    envFile: '.env',
    entrypoint: 'sh',
    healthCmd: 'curl -f localhost',
    healthInterval: '30s',
    healthTimeout: '5s',
    healthRetries: '3',
    healthStartPeriod: '10s',
    extraArgs: '--gpus all',
    command: 'sleep',
    arguments: 'infinity',
    envVars: [
      { key: 'KEY', value: 'val' },
      { key: 'EMPTY', value: '' }
    ],
    labels: [label('app', 'web')],
    ports: [port({ hostPort: '8080', containerPort: '80' }), port({ hostIp: '127.0.0.1', hostPort: '53', containerPort: '53', protocol: 'udp' })],
    tmpfsPaths: [{ path: '/tmp' }],
    volumes: [{ source: 'C:\\data', target: '/app', readOnly: true }]
  }
}

describe('拼装（RB-004 RB-005 RB-006 RB-007 RB-050）', () => {
  it('RB-005 固定顺序拿一条满表核对，逐段不差', () => {
    expect(runArgs(fullSpec())).toEqual([
      'run', '-d', '-i', '-t', '--rm', '-P',
      '--pull', 'always', '--name', 'web', '-h', 'myhost',
      '--network', 'host', '--cpus', '2', '-m', '512m', '--shm-size', '64m',
      '-w', '/app', '-u', '1000:1000',
      '-e', 'KEY=val', '-e', 'EMPTY=', '--env-file', '.env',
      '-l', 'app=web',
      '-p', '8080:80', '-p', '127.0.0.1:53:53/udp',
      '--entrypoint', 'sh', '--tmpfs', '/tmp', '-v', 'C:\\data:/app:ro',
      '--health-cmd', 'curl -f localhost', '--health-interval', '30s',
      '--health-timeout', '5s', '--health-retries', '3', '--health-start-period', '10s',
      '--gpus', 'all',
      'nginx:1.27', 'sleep', 'infinity'
    ])
  })

  it('RB-005 册子样例逐字核对：一条带端口/挂载/其他参数的命令', () => {
    const spec: RunSpec = {
      ...emptyRunSpec(),
      rm: true,
      pullPolicy: 'always',
      name: 'web',
      workdir: '/srv',
      user: '1000:1000',
      envVars: [{ key: 'TZ', value: 'Asia/Shanghai' }],
      ports: [port({ hostPort: '18080', containerPort: '80', protocol: 'udp' })],
      volumes: [{ source: 'data', target: '/app', readOnly: true }],
      extraArgs: '--dns 8.8.8.8',
      image: 'docker.1ms.run/library/nginx',
      command: 'nginx'
    }
    expect(runCommand(spec)).toBe(
      'wslc run -d --rm --pull always --name web -w /srv -u 1000:1000 ' +
        '-e TZ=Asia/Shanghai -p 18080:80/udp -v data:/app:ro --dns 8.8.8.8 ' +
        'docker.1ms.run/library/nginx nginx'
    )
  })

  it('RB-006 RB-007 留空的值字段不产出选项；整行留空视同这一行不存在', () => {
    const spec: RunSpec = {
      ...emptyRunSpec(),
      detach: false,
      image: 'x',
      name: '  ',
      ports: [port()],
      volumes: [{ source: '', target: '', readOnly: false }],
      envVars: [{ key: '', value: '' }],
      labels: [{ key: '', value: '' }],
      tmpfsPaths: [{ path: '' }]
    }
    expect(runArgs(spec)).toEqual(['run', 'x'])
  })

  it('RB-004 填表顺序不动命令长相（拼装只认状态，不认先后）', () => {
    const a = fullSpec()
    const b = fullSpec()
    b.image = 'nginx:1.27'
    b.ports = [...b.ports]
    expect(runArgs(a)).toEqual(runArgs(b))
  })

  it('RB-050 长尾选项原样透传、不校验', () => {
    const spec: RunSpec = { ...emptyRunSpec(), image: 'x', extraArgs: '--mount a --ip 1.2.3.4 --cidfile ""' }
    expect(validateRunSpec(spec)).toEqual([])
    expect(runArgs(spec)).toEqual(['run', '-d', '--mount', 'a', '--ip', '1.2.3.4', '--cidfile', '', 'x'])
  })
})

describe('同源与分词转义（RB-003 tokenize/quote）', () => {
  it('RB-003 界面上那条分词后与交给 wslc 的参数逐段相同', () => {
    const spec = fullSpec()
    expect(tokenize(runCommand(spec))).toEqual(['wslc', ...runArgs(spec)])
  })

  it('tokenize 认引号、反斜杠与单引号段', () => {
    expect(tokenize('a  b\tc')).toEqual(['a', 'b', 'c'])
    expect(tokenize('"hello world" x')).toEqual(['hello world', 'x'])
    expect(tokenize('C:\\data\\')).toEqual(['C:\\data\\'])
    expect(tokenize('"a\\b"')).toEqual(['a\\b'])
    expect(tokenize("'a b' c")).toEqual(['a b', 'c'])
    expect(tokenize('"say \\"hi\\""')).toEqual(['say "hi"'])
    expect(tokenize('')).toEqual([])
  })

  it('quote 只在需要时罩引号', () => {
    expect(quote('plain')).toBe('plain')
    expect(quote('C:\\data:/app:ro')).toBe('C:\\data:/app:ro')
    expect(quote('a b')).toBe('"a b"')
    expect(quote('a;b')).toBe('"a;b"')
    expect(quote('x&y')).toBe('"x&y"')
    expect(quote('')).toBe('""')
  })

  it('quote 是 tokenize 的逆：各种怪值转义再分词回到原值', () => {
    for (const token of ['plain', 'a b', 'C:\\data\\', 'say "hi"', 'a;b&c|d(<x>)^$`', "it's", '']) {
      expect(tokenize(quote(token))).toEqual([token])
    }
  })
})

describe('校验（RB-008 RB-009 RB-011~RB-019）', () => {
  const codes = (spec: RunSpec) => validateRunSpec(spec).map((i) => `${i.code}@${i.row ?? '-'}`)

  it('RB-008 光一张空表，唯一的问题就是镜像没填', () => {
    const issues = validateRunSpec(emptyRunSpec())
    expect(issues).toHaveLength(1)
    expect(issues[0]!.code).toBe('image-missing')
    expect(describeRunIssue(issues[0]!)).toBe('镜像不能为空 —— 至少要指定一个镜像。')
  })

  it('RB-009 RB-011 RB-012 RB-013 端口各行的问题一次列全、各带行号与原值', () => {
    const spec: RunSpec = {
      ...emptyRunSpec(),
      image: 'x',
      ports: [
        port({ hostPort: '8080' }), // 1：缺容器端口
        port({ containerPort: 'abc' }), // 2：不是端口
        port({ hostPort: '70000', containerPort: '80' }), // 3：超范围
        port({ hostPort: '8000-8010', containerPort: '80' }), // 4：一端范围一端单口
        port({ hostPort: '9000-9010', containerPort: '8000-8010' }), // 5：等长范围，合法
        port({ containerPort: '80', protocol: 'sctp' }) // 6：协议不认
      ]
    }
    expect(codes(spec)).toEqual(['port-container@1', 'port-number@2', 'port-number@3', 'port-range@4', 'port-protocol@6'])
    const issues = validateRunSpec(spec)
    expect(issues[1]!.value).toBe('abc')
    expect(issues[2]!.value).toBe('70000')
    expect(describeRunIssue(issues[1]!)).toBe('端口第 2 行：abc 不像端口（可用 8080 或 8000-8010）。')
  })

  it('RB-012 单端口与合法范围都放行', () => {
    const spec: RunSpec = {
      ...emptyRunSpec(),
      image: 'x',
      ports: [
        port({ hostPort: '8080', containerPort: '80' }),
        port({ hostPort: '8000-8010', containerPort: '8000-8010' }),
        port({ hostPort: '1', containerPort: '65535' })
      ]
    }
    expect(validateRunSpec(spec)).toEqual([])
  })

  it('RB-011 0 与倒着写的范围都不像端口', () => {
    const spec: RunSpec = {
      ...emptyRunSpec(),
      image: 'x',
      ports: [port({ containerPort: '0' }), port({ containerPort: '90-80' })]
    }
    const issues = validateRunSpec(spec)
    expect(issues).toHaveLength(2)
    expect(issues.every((i) => i.code === 'port-number')).toBe(true)
  })

  it('RB-014 RB-015 RB-016 RB-017 挂载/tmpfs/变量/标签各报各的行', () => {
    const spec: RunSpec = {
      ...emptyRunSpec(),
      image: 'x',
      volumes: [
        { source: '', target: '/app', readOnly: false },
        { source: 'data', target: 'app', readOnly: false }
      ],
      tmpfsPaths: [{ path: 'tmp' }],
      envVars: [
        { key: '', value: 'orphan' },
        { key: 'A=B', value: '' }
      ],
      labels: [label('k=v', '')]
    }
    expect(codes(spec)).toEqual([
      'volume-source@1',
      'volume-target@2',
      'tmpfs-path@1',
      'env-key@1',
      'env-key@2',
      'label-key@1'
    ])
  })

  it('RB-018 RB-019 重试次数要非负整数、CPU 数要正数', () => {
    const base: RunSpec = { ...emptyRunSpec(), image: 'x' }
    expect(codes({ ...base, healthRetries: '3.5' })).toEqual(['health-retries@-'])
    expect(codes({ ...base, healthRetries: 'abc' })).toEqual(['health-retries@-'])
    expect(codes({ ...base, healthRetries: '-1' })).toEqual(['health-retries@-'])
    expect(describeRunIssue(validateRunSpec({ ...base, healthRetries: '3.5' })[0]!)).toBe(
      '健康检查的重试次数需要是整数。'
    )
    expect(codes({ ...base, cpus: 'abc' })).toEqual(['cpus@-'])
    expect(codes({ ...base, cpus: '0' })).toEqual(['cpus@-'])
    expect(codes({ ...base, cpus: '-2.5' })).toEqual(['cpus@-'])
    expect(describeRunIssue(validateRunSpec({ ...base, cpus: '0' })[0]!)).toBe('CPU 数需要是数字，例如 0.5、1、2.5。')
    expect(validateRunSpec({ ...base, healthRetries: '0', cpus: '0.5' })).toEqual([])
  })
})

describe('读回（RB-028 RB-029 RB-031 RB-032 RB-033 RB-034）', () => {
  it('RB-028 四种前缀写法都认', () => {
    for (const line of [
      'wslc run -d nginx',
      'wslc.exe run -d nginx',
      'C:\\tools\\wslc.exe run -d nginx',
      'c:\\Tools\\WSLC.EXE container run -d nginx'
    ]) {
      const parsed = tryParseRun(line)
      expect(parsed, line).not.toBeNull()
      expect(parsed!.image).toBe('nginx')
      expect(parsed!.detach).toBe(true)
    }
  })

  it('RB-029 不是 wslc run 的一律拒绝', () => {
    for (const line of ['', '   ', 'docker run nginx', 'wslc', 'wslc ps -a']) {
      expect(tryParseRun(line), line).toBeNull()
    }
  })

  it('RB-031 RB-033 端口/挂载/变量/拉取策略各归各位，盘符与带空格的值读得回来', () => {
    const parsed = tryParseRun(
      'wslc run -d --name web -p 8080:80/udp -p 127.0.0.1:53:53 -v C:\\data:/app:ro -e MODE=fast --pull never nginx'
    )
    expect(parsed).not.toBeNull()
    expect(parsed!.name).toBe('web')
    expect(parsed!.pullPolicy).toBe('never')
    expect(parsed!.ports).toHaveLength(2)
    expect(parsed!.ports[0]!.protocol).toBe('udp')
    expect(parsed!.ports[0]!.hostPort).toBe('8080')
    expect(parsed!.ports[0]!.containerPort).toBe('80')
    expect(parsed!.ports[1]!.hostIp).toBe('127.0.0.1')
    expect(parsed!.ports[1]!.protocol).toBe('tcp')
    expect(parsed!.volumes).toEqual([{ source: 'C:\\data', target: '/app', readOnly: true }])
    expect(parsed!.envVars).toEqual([{ key: 'MODE', value: 'fast' }])

    const spaced = tryParseRun('wslc run -e "A=b c" nginx')
    expect(spaced!.envVars).toEqual([{ key: 'A', value: 'b c' }])
  })

  it('RB-032 认不出的选项连取值整段进其他参数', () => {
    const odd = tryParseRun('wslc run --pull if-not-present nginx')
    expect(odd!.pullPolicy).toBe('')
    expect(odd!.extraArgs).toBe('--pull if-not-present')
    expect(runCommand(odd)).toContain('--pull if-not-present')

    const long = tryParseRun('wslc run --gpus all --dns 8.8.8.8 --ulimit nofile=1024:2048 nginx')
    expect(long!.image).toBe('nginx')
    expect(long!.extraArgs).toBe('--gpus all --dns 8.8.8.8 --ulimit nofile=1024:2048')
  })

  it('RB-034 显示 → 读回 → 再显示，结果不变', () => {
    const display = runCommand(fullSpec())
    const parsed = tryParseRun(display)
    expect(parsed).not.toBeNull()
    expect(runCommand(parsed!)).toBe(display)
  })
})

describe('执行历史的记录半边（RB-043 RB-044）', () => {
  it('RB-043 最新在前；连续同一条只记一次', () => {
    let list = recordRunHistory([], 'wslc run a', 1)
    list = recordRunHistory(list, 'wslc run b', 2)
    list = recordRunHistory(list, 'wslc run b', 3)
    expect(list.map((e) => e.command)).toEqual(['wslc run b', 'wslc run a'])
  })

  it('RB-044 超出 100 条挤掉最旧的', () => {
    let list = recordRunHistory([], 'wslc run b', 1)
    for (let i = 0; i < 120; i++) list = recordRunHistory(list, `wslc run #${i}`, i + 1000)
    expect(list).toHaveLength(100)
    expect(list[0]!.command).toBe('wslc run #119')
    expect(list.some((e) => e.command === 'wslc run b')).toBe(false)
    expect(/^\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(list[0]!.timeText)).toBe(true)
  })
})
