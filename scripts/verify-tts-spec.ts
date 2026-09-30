/**
 * `.tts` / `.ttsservice` 校验器与读写器的行为核对 —— 规范 `docs/tts-spec.md`。
 * Run: npm run test:tts-spec
 *
 * 覆盖的是**规范里写死的规则**，不是实现细节：两级校验的每一条、保真写入、
 * 预设合并与能力只能收窄、`template` 档的必填约束、以及录音棚两级门禁。
 */

import {
  characterNameOfFileName,
  serviceIdOfFileName,
  type Issue,
} from '../src/tts/spec.ts'
import {
  BUILTIN_PRESETS,
  resolvePresets,
  type ProviderPreset,
} from '../src/tts/providers.ts'
import {
  listPlanCharacters,
  listPlanLocales,
  readVoicePlan,
  stringifyVoicePlan,
  toVoicePlan,
  validateVoicePlanSemantics,
  validateVoicePlanStructure,
  type PlanSemanticContext,
} from '../src/tts/plan.ts'
import {
  listServiceIds,
  readServiceDefinition,
  resolveService,
  stringifyServiceDefinition,
  toServiceDefinition,
  validateServiceStructure,
  type ResolvedService,
} from '../src/tts/service.ts'

let checks = 0
const failures: string[] = []

function check(label: string, actual: unknown, expected: unknown): void {
  checks += 1
  const a = JSON.stringify(actual)
  const e = JSON.stringify(expected)
  if (a !== e) failures.push(`${label}\n       实际 ${a}\n       期望 ${e}`)
}

function section(name: string): void {
  console.log(`\n${name}`)
}

const errorPaths = (issues: readonly Issue[]) =>
  issues.filter((issue) => issue.level === 'error').map((issue) => issue.path)
const warningPaths = (issues: readonly Issue[]) =>
  issues.filter((issue) => issue.level === 'warning').map((issue) => issue.path)

const parse = (text: string): unknown => JSON.parse(text)

// 一份"到处都对"的最小 .tts，各段用它做基线
const GOOD_PLAN = '{"version":1,"voices":{"zh_cn":{"service":"openai-main","voice":"alloy"}}}'

// ===== 1. 后缀与文件名 =====

section('1. 后缀与文件名（`.ttsservice` 不会被误判成 `.tts`）')
check('服务文件名 → id', serviceIdOfFileName('minimax-main.ttsservice'), 'minimax-main')
check('大小写不影响识别', serviceIdOfFileName('MINIMAX.TTSSERVICE'), 'MINIMAX')
check('角色文件名 → 角色名（中文）', characterNameOfFileName('旁白.tts'), '旁白')
check('.tts 不是服务文件', serviceIdOfFileName('旁白.tts'), null)
check('.ttsservice 不是角色方案', characterNameOfFileName('x.ttsservice'), null)
check('含路径分隔的拒绝', serviceIdOfFileName('a/b.ttsservice'), null)
check('服务目录列举', listServiceIds(['b.ttsservice', 'a.ttsservice', '旁白.tts']), ['a', 'b'])

// ===== 2. 结构校验：.tts =====

section('2. 结构校验（.tts）')
check('最小形态零问题', validateVoicePlanStructure(parse(GOOD_PLAN), '旁白.tts'), [])

check(
  '顶层 service / speed 是错误，不是未知键',
  errorPaths(
    validateVoicePlanStructure(
      parse('{"version":1,"service":"a","speed":1,"voices":{"zh_cn":{"service":"a","voice":"b"}}}'),
    ),
  ),
  ['service', 'speed'],
)
check(
  '顶层 character 是错误（角色名只来自文件名）',
  errorPaths(
    validateVoicePlanStructure(
      parse('{"version":1,"character":"旁白","voices":{"zh_cn":{"service":"a","voice":"b"}}}'),
      '旁白.tts',
    ),
  ),
  ['character'],
)
check(
  'version 不认就报错，不静默降级',
  errorPaths(
    validateVoicePlanStructure(
      parse('{"version":2,"voices":{"zh_cn":{"service":"a","voice":"b"}}}'),
    ),
  ),
  ['version'],
)
check(
  'voices 不能为空',
  errorPaths(validateVoicePlanStructure(parse('{"version":1,"voices":{}}'))),
  ['voices'],
)
check(
  '没有 default 之类兜底键',
  errorPaths(
    validateVoicePlanStructure(
      parse('{"version":1,"voices":{"default":{"service":"a","voice":"b"}}}'),
    ),
  ),
  ['voices.default'],
)
check(
  '语言标签必须是格式化后的形式',
  errorPaths(
    validateVoicePlanStructure(
      parse('{"version":1,"voices":{"zh-CN":{"service":"a","voice":"b"}}}'),
    ),
  ),
  ['voices.zh-CN'],
)

const BOTH = '{"version":1,"voices":{"zh_cn":{"service":"a","voice":"b","clone":{"samples":["assets/x.wav"],"consent":"meta/docs/x.md"}}}}'
check(
  'voice 与 clone 同时出现',
  errorPaths(validateVoicePlanStructure(parse(BOTH))),
  ['voices.zh_cn'],
)
check(
  '音色来源缺失',
  errorPaths(validateVoicePlanStructure(parse('{"version":1,"voices":{"zh_cn":{"service":"a"}}}'))),
  ['voices.zh_cn'],
)
check(
  '每条语言都必须自带 service',
  errorPaths(validateVoicePlanStructure(parse('{"version":1,"voices":{"zh_cn":{"voice":"b"}}}'))),
  ['voices.zh_cn.service'],
)

const CLONE_BASE = (clone: string) =>
  `{"version":1,"voices":{"zh_cn":{"service":"a","clone":${clone}}}}`
check(
  '样本不能是空数组',
  errorPaths(validateVoicePlanStructure(parse(CLONE_BASE('{"samples":[],"consent":"meta/docs/x.md"}')), )),
  ['voices.zh_cn.clone.samples'],
)
check(
  '样本必须是合法 assets 路径（走 normalizeAssetPath）',
  errorPaths(
    validateVoicePlanStructure(
      parse(CLONE_BASE('{"samples":["assets/../x.wav"],"consent":"meta/docs/x.md"}')),
    ),
  ),
  ['voices.zh_cn.clone.samples[0]'],
)
check(
  '同意凭证不能在 meta/ 之外',
  errorPaths(
    validateVoicePlanStructure(
      parse(CLONE_BASE('{"samples":["assets/x.wav"],"consent":"docs/x.md"}')),
    ),
  ),
  ['voices.zh_cn.clone.consent'],
)
check(
  '同意凭证可以是 env: / app: 引用',
  validateVoicePlanStructure(
    parse(CLONE_BASE('{"samples":["assets/x.wav"],"consent":"app:voice-consent"}')),
  ),
  [],
)
check(
  'speed 必须是数值',
  errorPaths(
    validateVoicePlanStructure(
      parse('{"version":1,"voices":{"zh_cn":{"service":"a","voice":"b","speed":"fast"}}}'),
    ),
  ),
  ['voices.zh_cn.speed'],
)

section('3. 未知键：警告，不报错（§9 保留）')
check(
  '顶层未知键',
  warningPaths(validateVoicePlanStructure(parse('{"version":1,"voices":{"zh_cn":{"service":"a","voice":"b"}},"future":1}'))),
  ['future'],
)
check(
  '语言条目未知键',
  warningPaths(validateVoicePlanStructure(parse('{"version":1,"voices":{"zh_cn":{"service":"a","voice":"b","foo":1}}}'))),
  ['voices.zh_cn.foo'],
)
check(
  'clone 内未知键',
  warningPaths(
    validateVoicePlanStructure(
      parse(CLONE_BASE('{"samples":["assets/x.wav"],"consent":"meta/docs/x.md","bar":1}')),
    ),
  ),
  ['voices.zh_cn.clone.bar'],
)
check(
  '未知键不产生错误',
  errorPaths(validateVoicePlanStructure(parse('{"version":1,"voices":{"zh_cn":{"service":"a","voice":"b"}},"future":1}'))),
  [],
)

// ===== 4. 结构校验：.ttsservice =====

section('4. 结构校验（.ttsservice）')
const presets: ProviderPreset[] = resolvePresets().presets

check(
  '预设档最小形态零问题',
  validateServiceStructure(
    parse('{"version":1,"provider":"openai","auth":{"apiKeyRef":"env:OPENAI_API_KEY"}}'),
    'openai-main',
    presets,
  ),
  [],
)
check(
  'provider 必须在预设表里（或 template）',
  errorPaths(
    validateServiceStructure(parse('{"version":1,"provider":"nope","auth":{"apiKeyRef":"env:X"}}'), 'x', presets),
  ),
  ['provider'],
)
check(
  'id 不允许出现（文件名就是 id）',
  errorPaths(
    validateServiceStructure(
      parse('{"version":1,"id":"x","provider":"openai","auth":{"apiKeyRef":"env:X"}}'),
      'x',
      presets,
    ),
  ),
  ['id'],
)
check(
  'protocol 是派生值，写歪了报错',
  errorPaths(
    validateServiceStructure(
      parse('{"version":1,"provider":"openai","protocol":"azure","auth":{"apiKeyRef":"env:X"}}'),
      'x',
      presets,
    ),
  ),
  ['protocol'],
)
check(
  'template 必须自己选 protocol',
  errorPaths(
    validateServiceStructure(
      parse('{"version":1,"provider":"template","baseUrl":"https://x.test/v1","auth":{"apiKeyRef":"env:X"}}'),
      'x',
      presets,
    ),
  ),
  ['protocol'],
)
check(
  'template 必须自己填 baseUrl',
  errorPaths(
    validateServiceStructure(
      parse('{"version":1,"provider":"template","protocol":"openai-compatible","auth":{"apiKeyRef":"env:X"}}'),
      'x',
      presets,
    ),
  ),
  ['baseUrl'],
)
check(
  '预设没有默认端点时 baseUrl 必填（Azure 按区域部署）',
  errorPaths(
    validateServiceStructure(parse('{"version":1,"provider":"azure","auth":{"apiKeyRef":"env:X"}}'), 'x', presets),
  ),
  ['baseUrl'],
)
check(
  'baseUrl 只放行 https（localhost 例外）',
  errorPaths(
    validateServiceStructure(
      parse('{"version":1,"provider":"openai","baseUrl":"http://api.openai.com/v1","auth":{"apiKeyRef":"env:X"}}'),
      'x',
      presets,
    ),
  ),
  ['baseUrl'],
)
check(
  'auth 按后缀识别：不以 Ref 结尾的键是错误',
  errorPaths(
    validateServiceStructure(
      parse('{"version":1,"provider":"openai","auth":{"apiKeyRef":"env:X","key":"env:Y"}}'),
      'x',
      presets,
    ),
  ),
  ['auth.key'],
)
check(
  'auth 里只放引用，不放密钥',
  errorPaths(
    validateServiceStructure(
      parse('{"version":1,"provider":"openai","auth":{"apiKeyRef":"sk-abc123"}}'),
      'x',
      presets,
    ),
  ),
  ['auth.apiKeyRef'],
)
check(
  'auth 形态必须匹配协议（Polly 要一对）',
  errorPaths(
    validateServiceStructure(
      parse('{"version":1,"provider":"polly","baseUrl":"https://polly.us-east-1.amazonaws.com","auth":{"apiKeyRef":"env:X"}}'),
      'x',
      presets,
    ),
  ),
  ['auth.accessKeyRef', 'auth.secretKeyRef'],
)
check(
  '能力只能收窄：不能在 google 上开 clone',
  errorPaths(
    validateServiceStructure(
      parse('{"version":1,"provider":"google","baseUrl":"https://texttospeech.googleapis.com","auth":{"serviceAccountRef":"app:sa"},"capabilities":["clone"]}'),
      'x',
      presets,
    ),
  ),
  ['capabilities'],
)
check(
  '能力可以收窄：elevenlabs 上关掉 clone 合法',
  validateServiceStructure(
    parse('{"version":1,"provider":"elevenlabs","auth":{"apiKeyRef":"env:X"},"capabilities":[]}'),
    'x',
    presets,
  ),
  [],
)
check(
  '模型不在候选里只警告（厂商上新快于发版）',
  warningPaths(
    validateServiceStructure(
      parse('{"version":1,"provider":"openai","auth":{"apiKeyRef":"env:X"},"model":"nope"}'),
      'x',
      presets,
    ),
  ),
  ['model'],
)
check(
  '未知键只警告',
  warningPaths(
    validateServiceStructure(
      parse('{"version":1,"provider":"openai","auth":{"apiKeyRef":"env:X"},"foo":1}'),
      'x',
      presets,
    ),
  ),
  ['foo'],
)

// ===== 5. 能力的两层：协议提供 ≠ 默认开启 =====

section('5. 能力两层：available（协议提供）与 defaultCapabilities（默认开启）')
const resolveOf = (json: string, id = 'x'): ResolvedService =>
  resolveService(toServiceDefinition(parse(json)), id, presets)

const openaiService = resolveOf('{"version":1,"provider":"openai","auth":{"apiKeyRef":"env:OPENAI_API_KEY"}}')
const elevenService = resolveOf('{"version":1,"provider":"elevenlabs","auth":{"apiKeyRef":"env:EL_KEY"}}')
const azureService = resolveOf(
  '{"version":1,"provider":"azure","baseUrl":"https://eastasia.tts.speech.microsoft.com","auth":{"apiKeyRef":"app:azure"},"capabilities":["clone"]}',
)

check('预设带出固定协议', openaiService.protocol, 'openai-compatible')
check('预设带出默认端点与模型', [openaiService.baseUrl, openaiService.model], ['https://api.openai.com/v1', 'gpt-4o-mini-tts'])
check('OpenAI 协议提供克隆但默认关闭', openaiService.capabilities, [])
check('ElevenLabs 默认就开克隆', elevenService.capabilities, ['clone'])
check('Azure 显式开启后生效', azureService.capabilities, ['clone'])
check('凭据形态跟着协议走', [openaiService.authShape, azureService.authShape], ['apiKey', 'apiKey'])
check(
  'Polly 的凭据形态是一对',
  resolveOf('{"version":1,"provider":"polly","baseUrl":"https://polly.us-east-1.amazonaws.com","auth":{"accessKeyRef":"env:AK","secretKeyRef":"env:SK"}}').authShape,
  'awsSigV4',
)

// ===== 6. 预设表是插件式的 =====

section('6. 预设表插件化')
const clash = resolvePresets([
  { ...BUILTIN_PRESETS[0], id: 'openai' },
  { ...BUILTIN_PRESETS[0], id: 'my-lab', label: '自建实验室' },
])
check('与内置重名的用户预设被丢弃', clash.rejected, ['openai'])
check('不重名的用户预设并入表里', clash.presets.map((p) => p.id).includes('my-lab'), true)
check('内置那条没被用户预设顶掉', clash.presets.find((p) => p.id === 'openai')?.builtin, true)

// ===== 7. 语义校验 =====

section('7. 语义校验（需要工程上下文）')
const plan = toVoicePlan(parse(GOOD_PLAN))
const services = new Map<string, ResolvedService>([['openai-main', openaiService]])
const context: PlanSemanticContext = {
  services,
  assetPaths: new Set<string>(),
}

check('服务在、凭据不校验时零问题', validateVoicePlanSemantics(plan, context), [])

check(
  '服务文件不存在 → 错误（§7.2）',
  errorPaths(
    validateVoicePlanSemantics(toVoicePlan(parse('{"version":1,"voices":{"zh_cn":{"service":"ghost","voice":"alloy"}}}')), context),
  ),
  ['voices.zh_cn.service'],
)
check(
  '克隆能力由服务商决定，不由 .tts 决定',
  errorPaths(
    validateVoicePlanSemantics(
      toVoicePlan(parse('{"version":1,"voices":{"zh_cn":{"service":"openai-main","clone":{"samples":["assets/a.wav"],"consent":"meta/docs/c.md"}}}}')),
      context,
    ),
  ),
  ['voices.zh_cn.clone'],
)
check(
  '样本不在工程里 → 警告，不拦（§7.2）',
  warningPaths(
    validateVoicePlanSemantics(
      toVoicePlan(parse('{"version":1,"voices":{"zh_cn":{"service":"elevenlabs-main","clone":{"samples":["assets/a.wav"],"consent":"meta/docs/c.md"}}}}')),
      { services: new Map([['elevenlabs-main', elevenService]]), assetPaths: new Set() },
    ),
  ),
  ['voices.zh_cn.clone.samples'],
)
check(
  '缺凭据只提示不报错（协作者打开工程必然缺）',
  errorPaths(
    validateVoicePlanSemantics(plan, { ...context, hasCredential: () => false }),
  ),
  [],
)
check(
  '缺凭据给出警告',
  warningPaths(validateVoicePlanSemantics(plan, { ...context, hasCredential: () => false })),
  ['voices.zh_cn.service'],
)
check(
  '语速越界只警告（各协议区间不同）',
  warningPaths(
    validateVoicePlanSemantics(
      toVoicePlan(parse('{"version":1,"voices":{"zh_cn":{"service":"elevenlabs-main","voice":"v","speed":2}}}')),
      { services: new Map([['elevenlabs-main', elevenService]]) },
    ),
  ),
  ['voices.zh_cn.speed'],
)

// ===== 8. 保真写入 =====

section('8. 保真写入（读要宽容，写要严格，未知键原样带回）')
const RICH = `{
  "version": 1,
  "futureTop": { "a": 1 },
  "voices": {
    "zh_cn": { "service": "openai-main", "voice": "alloy", "futureEntry": "keep" },
    "ja_jp": {
      "service": "elevenlabs-main",
      "clone": {
        "samples": ["assets/s/01.wav"],
        "consent": "meta/docs/c.md",
        "futureClone": [1, 2]
      }
    }
  }
}`
const richRead = readVoicePlan(RICH, '林晚.tts')
check('读得动', richRead.ok, true)
check('未知键不产生错误', errorPaths(richRead.issues), [])
check('未知键产生警告', warningPaths(richRead.issues).length, 3)

const roundTripped = JSON.parse(stringifyVoicePlan(richRead.value)) as Record<string, unknown>
const rtVoices = roundTripped.voices as Record<string, Record<string, unknown>>
check('顶层未知键往返不丢', roundTripped.futureTop, { a: 1 })
check('语言条目未知键往返不丢', rtVoices.zh_cn.futureEntry, 'keep')
check('clone 内未知键往返不丢', (rtVoices.ja_jp.clone as Record<string, unknown>).futureClone, [1, 2])
check('规范形状写出来了', [roundTripped.version, rtVoices.zh_cn.service], [1, 'openai-main'])

const bad = readVoicePlan('{ not json', '旁白.tts')
check('坏 JSON：ok=false（不要回写）', bad.ok, false)
check('坏 JSON：报在 $ 上', errorPaths(bad.issues), ['$'])

const serviceRound = JSON.parse(
  stringifyServiceDefinition(
    toServiceDefinition(parse('{"version":1,"provider":"openai","auth":{"apiKeyRef":"env:X"},"future":9}')),
  ),
) as Record<string, unknown>
check('服务定义未知键往返不丢', serviceRound.future, 9)
check('服务定义不写 id 字段', 'id' in serviceRound, false)
check(
  '服务定义读坏 JSON 时 ok=false',
  readServiceDefinition('{', 'x', presets).ok,
  false,
)

// ===== 9. 录音棚两级门禁（§7.4）=====

section('9. 录音棚两级门禁：选不到，而不是报错')
check(
  '第①级只列 .tts，其余后缀不出现',
  listPlanCharacters(['旁白.tts', '林晚.tts', '序章.hs', 'x.md', 'svc.ttsservice'])
    .map((item) => item.name)
    .sort(),
  ['旁白', '林晚'].sort(),
)
check(
  '第②级的选项就是 voices 的键',
  listPlanLocales(toVoicePlan(parse('{"version":1,"voices":{"en_us":{"service":"a","voice":"b"},"zh_cn":{"service":"a","voice":"b"}}}'))),
  ['en_us', 'zh_cn'],
)
check('没配的语言不在列表里', listPlanLocales(toVoicePlan(parse(GOOD_PLAN))), ['zh_cn'])

// ===== 汇总 =====

console.log(
  failures.length === 0
    ? `\n全部通过（${checks} 项）\n`
    : `\n${failures.length} / ${checks} 项失败：\n\n${failures.map((f) => `  ✗ ${f}`).join('\n\n')}\n`,
)
process.exit(failures.length === 0 ? 0 : 1)
