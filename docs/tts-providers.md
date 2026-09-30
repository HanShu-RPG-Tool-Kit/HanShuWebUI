# 云端 TTS 接入调研与统一接口设计

本文只回答三件事:常见的云端 TTS 服务长什么样、怎么用**一套接口**接进来、
以及怎么确保**不干扰本项目的 MIT 协议**。

---

## 1. 结论摘要

1. **协议层选 OpenAI 兼容的 `POST /v1/audio/speech` 作为主协议**。它已经是事实标准:
   OpenAI、Groq、OpenRouter、以及大量自建网关都实现了它。一套适配器覆盖多家。
   **ElevenLabs 例外** —— 它的 voice 在 URL 路径、鉴权头也不同,单列一个薄适配器。
2. **非兼容的厂商各写一个薄适配器**:ElevenLabs(路径 + `xi-api-key`)、
   Azure(SSML REST)、MiniMax(`t2a_v2`)、Google / Amazon Polly(REST + 各自签名)。
3. **只用 `fetch` 直连 HTTP,不引入任何厂商 SDK**。这样仓库里不会多一行第三方代码,
   许可证问题从"需要审查"降级为"不存在"。
4. **许可证红线只有两类**:copyleft(GPL / AGPL / SSPL)与**非商用**(CPML / CC-BY-NC)。
   本项目现状已核对干净(见 §2.3)。
5. **TTS 产物必须走既有转码管线**。本项目配音只认**单声道 Vorbis `.ogg`**(Opus 会被判非法),
   而云端 TTS 只会给 mp3 / wav / pcm / opus。所以 TTS 与录音棚共用同一条
   `runVoiceImport` 落地路径,不新开第二条写入通道。
6. **多语言是"语言 → 音色"的一层映射**,不是"再建一套东西":配音资产本来就按
   `assets/<语言标签>/` 分目录,角色方案只需要能按语言给不同音色(甚至不同家服务)。
7. **音色克隆是一次性登记,不是每次合成**:上传样本换 `voice_id`,登记表存应用侧。
   **参考音频当作普通 assets 资源引用** —— 由资源系统管理,但不进 PAK(见 §5.3)。
   一个语言的音色来源**二选一**:给 `voice`(预置音色)或给 `clone`(样本),
   两者并存判非法。
8. **能不能克隆由服务商决定,不由角色方案声明。** 协议不提供的开不了,
   协议提供但受限的由服务显式开启 —— 编辑器据此决定要不要显示"克隆"选项(见 §5.4)。
9. **服务定义是工程文件,凭据才留在本机。** 服务定义放
   `meta/voice/service/<服务名>.ttsservice`(挂在 `meta/voice/` 下,因为它**只服务于 TTS**),
   是复合对象:`provider`(哪家)/ `protocol`(怎么发)/ `auth`(凭什么)/ 端点 / 模型 / 能力。
   一个工程几十个角色共用一两个账号,内联在角色文件里就是几十份重复;
   抽成工程级文件后,`.tts` 的**每条语言条目**里只留 `service: "<服务 id>"` ——
   一个**工程内**引用,而不是一个别处定义的悬空 id。
   切分原则是:**端点与模型决定"合成出什么",所以必须跟着工程走;密钥不决定这件事,
   所以只在本机凭据库。** 于是工程可以被完整分享,`auth` 里永远只有 `*Ref` 引用。
   这条同时解决了"编辑器里要不要让用户填 API 地址"的问题 ——
   角色编辑器里没有,服务编辑器里有。
10. **`provider` 预设表是数据,不是代码分支,而且是"插件式"可扩展的。**
    协议枚举封闭(每个值背后一个适配器),但供应商是数据 —— 加一家只改预设表,不发版。
    **用户也能往这张表里加条目**(填一次就变成与内置等价的 `provider`)。
    因此**没有 `provider: "custom"`** —— 自定义预设就是往表里加一条;
    而"不想建预设的一次性连接"用 `provider: "template"`(它不固定协议,由用户从枚举里选)。

---

## 2. 硬约束:不干扰 MIT 协议

### 2.1 什么才算"干扰"

MIT 是宽松许可:允许闭源分发、允许商用,只要求保留版权声明。
会**传染**到本项目的只有两类:

| 类别 | 例子 | 后果 |
|---|---|---|
| **copyleft** | GPL-2.0/3.0、AGPL-3.0、SSPL | 若并入本仓库,分发时可能被要求整体以同许可开放 |
| **非商用** | CPML、CC-BY-NC-4.0 | 禁止商用;本项目 MIT 允许商用,二者直接冲突 |

以下都**不构成干扰**,可以放心用(仍建议随依赖保留许可声明):

> MIT、Apache-2.0、BSD-2/3-Clause、ISC、MPL-2.0、Zlib、Unlicense、CC0

**要区分"代码许可"和"模型/服务条款"。** TTS 是这方面最容易踩坑的领域:
一个库的代码可能是 MPL-2.0(可商用),但它默认下载的模型权重是非商用的。

### 2.2 判定规则(接新 provider 时照这个走)

1. 我们**只调用 HTTP 接口** → 服务条款(ToS)管的是"怎么用服务",不改变应用代码的许可。
   ToS 里可能有署名或用量要求,那是产品合规问题,不是许可证传染。
2. 我们**不下载、不分发任何模型权重** → 权重许可(CPML / CC-BY-NC)与我们无关。
3. 我们**不引入厂商 SDK** → 连 MIT/Apache 的署名登记都省了。
4. 任何要写进仓库的第三方代码,先看许可 → **GPL / AGPL / SSPL / 非商用一律拒绝**。

### 2.3 本项目依赖现状(已核对)

全部为 MIT 兼容,无 copyleft、无非商用:

| 依赖 | 许可 | 备注 |
|---|---|---|
| `@audio/encode-ogg` | **MIT** | **正是 Vorbis 编码器**,TTS 转码直接复用,无需新增依赖 |
| `jszip` | MIT 或 GPL-3.0-or-later | 双许可,取 MIT 分支即可 |
| `pako` | MIT 与 Zlib | ✅ |
| `dompurify` | MPL-2.0 或 Apache-2.0 | ✅ |
| `marked` | MIT | ✅ |

> 结论:TTS 接入**不需要新增任何依赖**。这点很重要——见 §4.3。

### 2.4 必须避开的"看着开源其实不能商用"

这些不是云端 API,而是本地引擎/模型,经常被推荐,但对本项目**都不安全**:

| 名称 | 许可 | 判定 |
|---|---|---|
| **edge-tts**(社区包) | **GPL-3.0**,且用的是**非官方接口** | ❌ 双重理由避开 |
| **Coqui XTTS-v2** 权重 | **CPML(非商用)**,且 Coqui 公司 2024 年已关闭、无处购买商用授权 | ❌ |
| **F5-TTS** | **CC-BY-NC-4.0(非商用)** | ❌ |
| **Piper** | 有来源称 2025 年起改为 **GPL-3.0-or-later**(原为 MIT) | ⚠️ 用前必须自行核实 |
| Kokoro-82M | Apache-2.0 | ✅ 可商用 |
| Orpheus / Bark / StyleTTS2 / MeloTTS / Chatterbox | Apache-2.0 / MIT | ✅ 可商用(需 GPU) |

> 注意 `edge-tts` 的陷阱:网上不少对比表把它标成 "MIT (client)",但仓库实际是 GPL-3.0。
> 而且它调用的是非官方接口,随时可能失效。**两条理由都足以避开。**

---

## 3. 常见云端 TTS 现状(2026)

### 3.1 质量 / 价格 / 延迟

Elo 来自 Artificial Analysis Speech Arena 的第三方快照,价格是各家高质量档位的列表价。
**均会变动,接入前请以官网为准。**

| 厂商 | 代表模型 | Elo | 价格 / 百万字符 | 首字节延迟 | 语言数 |
|---|---|---|---|---|---|
| Inworld | Realtime TTS 1.5 Max | 1210 | $35 | <250ms | 15+ |
| Google | Gemini 3.1 Flash TTS | 1206 | $36.61 | 200–300ms | 75+ |
| ElevenLabs | Eleven v3 | 1178 | $100–165 | 300–600ms | 29–74 |
| MiniMax | Speech 2.8 HD | 1164 | $100 | 400ms+ | 40 |
| **OpenAI** | `gpt-4o-mini-tts` / `tts-1` | 1106 | **$15** | 200–400ms | 50+ |
| Cartesia | Sonic 3 | 1054 | $50 | <100ms | 10–40 |
| **Azure** | Neural / Neural HD | ~1040 | **$16** | 200–500ms | **140+ locale** |
| **Amazon Polly** | Neural / Generative | ~1020 | $16 | 100–250ms | 30–40 |

据此对本项目的取舍:

- **性价比首选 OpenAI 兼容路线**($15/百万字符,延迟中等,4000 字符/请求)。
- **中文 + 多语言覆盖面首选 Azure**(140+ locale,400+ 音色,可直出**单声道 PCM**)。
- **中文听感首选 MiniMax**(40 语言含**粤语**,7 种情绪,10k 字符/请求)。
- **ElevenLabs 音质/克隆最好但最贵**,作为可选。
- **OpenRouter / LLM Gateway 这类聚合网关**值得留一个位置:一个 key 通多家,
  自带 fallback,代价是多一个中间方(隐私与加价)。

### 3.2 API 形态分类(决定要写几个适配器)

| 形态 | 厂商 | 端点 | 鉴权 | 请求体 | 返回 | 输出格式 |
|---|---|---|---|---|---|---|
| **OpenAI 兼容** | OpenAI、Groq、OpenRouter、LLM Gateway、各类自建网关 | `POST /v1/audio/speech` | `Authorization: Bearer` | JSON: `model` `input` `voice` `response_format` `speed` `instructions` | **裸音频字节** | mp3(默认)/opus/aac/flac/wav/pcm |
| **ElevenLabs** | ElevenLabs | `POST /v1/text-to-speech/{voice_id}` | **`xi-api-key` 头** | JSON: `text` `model_id` `voice_settings` `language_code` | **裸音频字节** | `output_format` 需带采样率,如 `mp3_44100_128` / `wav_44100` / `pcm_24000` |
| **SSML REST** | Azure | `POST https://{region}.tts.speech.microsoft.com/cognitiveservices/v1` | `Ocp-Apim-Subscription-Key`(或 Bearer) | **SSML XML** | 裸音频字节 | `X-Microsoft-OutputFormat` 指定,如 `riff-24khz-16bit-mono-pcm` |
| **JSON 内嵌 base64** | MiniMax | `POST https://api.minimax.io/v1/t2a_v2` | `Authorization: Bearer` | JSON: `model` `text` `voice_id` `speed` `vol` `pitch` `format` | **JSON 里的 base64** | mp3/pcm/flac/wav |
| **AWS 签名** | Amazon Polly | `SynthesizeSpeech` | SigV4 签名 | JSON | 裸音频字节 | mp3/ogg_vorbis/pcm |
| **OAuth2** | Google Cloud | `text:synthesize` | Service Account | JSON + SSML 字段 | JSON 内 base64 | LINEAR16 / MP3 / **OGG_OPUS** |
| **WebSocket 状态机** | MiniMax、阿里云 DashScope(CosyVoice) | `wss://…` | 握手头 | 事件流 `run-task` → `continue-task` → `finish-task` | 二进制/十六进制分片 | 各家自定义 |

**要点:**前三类覆盖了绝大多数需求,且都是"一次 HTTP 请求换一段音频",实现成本很低。
WebSocket 那类是为**边生成边播**设计的,本项目是"生成后落成配音资产",用不上流式,
**建议不列入首期**。

**ElevenLabs 为什么不能塞进"OpenAI 兼容":** `voice` 在 **URL 路径**里
(`/v1/text-to-speech/{voice_id}`),鉴权用 `xi-api-key` 头而不是 `Authorization: Bearer`,
请求体键名也不同(`text` / `model_id` 而非 `input` / `model`)。硬塞需要一层
路径 + 键名 + 鉴权头的特例改写,不如单列一个薄适配器干净。

**克隆端点不属于这张表。** 克隆是**一次性登记**(上传样本换一个 `voice_id`),
不是每次合成都要走的路径。详见 §5.3。

---

## 4. 统一接口设计

### 4.1 主协议为什么选 OpenAI 兼容

- 覆盖面最广:一家适配器吃下 OpenAI、Groq、OpenRouter 及所有兼容网关(含自建)。
- 契约最小:只有 `model` / `input` / `voice` 三个必填字段,返回裸音频字节。
- 迁移成本最低:换厂商只改 `model` 与 `voice` 两行,端点与鉴权不动。
- 缺点要记住:字段是各家的**最小公约数**。协议私有的参数由**适配器自己处理**
  (比如 Azure 的 SSML 包装),不要往上冒成用户可见的配置项 ——
  用户能决定的只有"用哪家 + 哪个音色",其余是适配器的事。

### 4.2 分层

```
meta/voice/service/*.ttsservice  ← 协议 / 端点 / 模型 / 能力 / 凭据引用（**进工程**）
        ▲                          └── *Ref ──► 本机凭据库（真实密钥，**不进工程**）
        │  每条语言条目各写一次 service: "minimax-main"
meta/voice/<角色>.tts            ← 逐语言：service 引用 + 音色 + 语速 + 克隆声明
        │
        ▼
调用方(录音棚 / Agent / 批量)
        │
        ▼
  TtsRequest(统一请求类型)          ← 唯一需要认识的接口
        │
        ▼
  协议适配器(按 protocol 分派)
   ├─ openai-compatible   → OpenAI / Groq / OpenRouter / 自建网关
   ├─ elevenlabs          → 路径带 voice_id + xi-api-key 头
   ├─ azure               → SSML REST,可直出单声道 PCM
   ├─ minimax             → t2a_v2,base64 解码
   ├─ google / polly      → 各自 REST
   └─ template            → 用户自定义请求模板（v2）
        │
        ▼
   音频字节(wav / pcm / mp3)
        │
        ▼
  既有转码:runVoiceImport → 单声道 Vorbis .ogg → 对等文件
```

统一请求类型只需覆盖各家交集,厂商私有能力放 `extra` 透传:

```ts
export type TtsRequest = {
  text: string
  voice: string
  /** 目标语言标签(zh_cn / en_us…)。适配器负责翻成该协议要的语言码 */
  language?: string
  /** 首选输出格式;wav / pcm 无二次损失,优先于 mp3 */
  format?: 'wav' | 'pcm' | 'mp3'
  speed?: number
  /** 协议私有参数,由适配器自己填 —— 不是用户可见配置的来源 */
  extra?: Record<string, unknown>
}
```

**多语言落在这一个 `language` 字段上。** 各家形态不一,适配器负责翻译:
ElevenLabs 要 ISO 639-1(`zh`)、Azure 要 BCP-47(`zh-CN`)、
OpenAI 兼容与 MiniMax **没有这个字段**(按正文自动判语言,传了也得丢)。
项目语言标签(`zh_cn`)与协议语言码的映射表复用 `src/i18n/locales.ts`,不另建一份。

> **"逐语言换一家服务"在适配层是免费的。** 一个角色的中文用 MiniMax、英文用
> ElevenLabs,只是同一个合成循环里换了一次 `protocol` 与服务 —— `TtsRequest`
> 不用改,适配器也不用知道。这一层完全由 `.tts` 的 `voices.<语言>.service` 表达:
> **每条语言自带服务,没有顶层默认值可以继承**,见 `docs/tts-spec.md` §5.5。

### 4.2.1 克隆登记不在统一接口里

克隆是**一次性**的:上传样本 → 换一个 `voice_id` → 之后合成走上面的普通端点。
所以它不进 `TtsRequest`,而是独立的一个"登记"动作:

```
样本资源(assets/…) ──► 克隆端点 ──► provider voice_id
                                            │
                                            ▼
                    应用侧登记表 [服务id + 样本哈希 → voice_id]
                                            │
                             之后每次合成：填进 TtsRequest.voice
```

- **登记表的键带 `服务id` 前缀** —— 同一份样本在不同 provider / 不同账号下是不同 id。
- **登记表失配时重新克隆并更新登记表**。`.tts` 里存的是样本而不是 id,
  所以换账号、换机器都不需要改文件 —— 见 `docs/tts-spec.md` §5.6。

> 注意:`TtsRequest` 本身**不区分**"预置音色"和"克隆音色" —— 两者在协议侧
> 都是个字符串 id。区分只在 `.tts` 的声明层(`voices.<k>` 里 `voice` 与 `clone` 二选一),
> 不污染请求层。

### 4.3 落点与依赖

- 代码侧:`src/tts/`(`spec.ts` / `client.ts` / `protocols/` / `cloneRegistry.ts` /
  **`providers.ts` 预设表**)。
- **工程侧**:服务定义放 `meta/voice/service/<服务名>.ttsservice`(一个账号一个文件),
  角色的配音方案放 `meta/voice/<角色名>.tts`(**一个文件一个角色**),
  **逐语言**写全自己的 `service`、音色来源与语速 —— 没有顶层默认值,也没有兜底项。
  格式见 **`docs/tts-spec.md`**。
  `src/workspace.ts` 的 `FILE_DIRS` 增两项即可,不需要新的读写通道。
- **应用侧(新)**:本机**凭据库**,沿用 `localStorage` + `hanshu.*` 键命名。
  它只存真实密钥,按 `*Ref` 里的名字索引,**不进工程**。
  工程打开时比对"用到哪些 `*Ref` / 本机缺哪几个",列成待填清单。
- **服务定义是复合对象**,三个正交轴:`provider`(哪家) / `protocol`(怎么发) /
  `auth`(凭什么)。厂商单独成轴,是因为同一协议下不同厂商的差异是真实的 ——
  官方 OpenAI 与 Groq 都是 `openai-compatible`,但模型、音色、能力都不同,
  折进 `baseUrl` 会丢掉这些语义。详见 `docs/tts-spec.md` §4。
- **`provider` 预设表是数据,不是代码分支,而且是插件式的。** 加一家供应商 = 加一条数据,
  不发版、不新写适配器(前提是它的协议已在枚举里)。这是本方案真正的扩展点。
  内置那批住代码(`src/tts/providers.ts`),**用户自建那批住应用级存储**、与内置同权,
  所以预设管理是一个**可增删的列表**,不是只读表格。一次性连接走 `provider: "template"`。
- **能力开关是"克隆由服务商约束"的落点**:协议不提供克隆的(google / polly)开不了;
  协议提供但受限的(azure / openai)要服务显式开启。编辑器据此决定要不要显示"克隆"选项。
- 克隆样本是 `assets/` 下的**普通资源**(`.tts` 里写资源路径引用),
  由资源系统统一管理 —— 见 §5.3。
- 依赖:**零新增**。`fetch`、Vorbis 编码(已有的 `@audio/encode-ogg`,MIT)、
  `JSON.parse` 都是现成的(`.tts` 定为 JSON,与 `.lang` / `.voice` 对齐)。

---

## 5. 本项目特有的四个约束(容易漏)

### 5.1 产物必须是单声道 Vorbis ogg

语音资产只认 `assets/<语言标签>/voice_<后缀>/…/<键名>.ogg`,且必须是**单声道 Vorbis**。
判定里明确把 **Opus 判为非法**,所以:

- ❌ **绝不要向 OpenAI 兼容接口请求 `response_format: "opus"`** —— 返回的是 Ogg Opus,会被拒收。
- ✅ 优先 `wav` / `pcm`(无损,重编码不掉质量);`mp3` 是二次有损,仅在厂商只给 mp3 时用。
- ✅ Azure 可直接要 `riff-24khz-16bit-mono-pcm`,省一步。
- 无论来源,**统一交给 `runVoiceImport`** 转码并写到对等文件,与录音棚、拖拽导入同一条路。

### 5.2 长文本要自己切分

OpenAI 兼容接口单请求上限约 **4096 字符**,MiniMax 是 10000,`gpt-4o-mini-tts`
按 **2000 token** 计。剧本是长文本,必须按**句子/段落**切分后逐段合成再拼接——
切点要落在句末,否则拼接处会有不自然的停顿或语调断裂。

### 5.3 克隆样本是普通 assets 资源

**参考音频依旧不能进 PAK** —— 它会被打进出厂资源包,一句 10 秒的"念一下这段话"
就跟着游戏发到每个玩家手里。但"不进 PAK"**不等于**"不能放 `assets/`":
`resourcePack` 是**选择性导出**,不是整个 `assets/` 全收。

```ts
// src/export/resourcePack.ts —— 逐个资产判定，认不出的直接跳过
if (parseTextAssetLocale(asset.path)) { /* 导出裁剪过的 lang */ continue }
const parsed = parseVoiceAssetKey(asset.path)
if (!parsed) continue          // ← 非 lang_/voice_ 布局的资产在这里被排除
```

它只认两种布局:

- `assets/<语言标签>/lang_<后缀>/…`(按 `.hsc` 引用到的键裁剪)
- `assets/<语言标签>/voice_<后缀>/…/‹键名›.ogg`(同上)

**其余资产一律跳过。** 所以把样本放成 `assets/voice-samples/…/01.wav` 这类路径,
它进不了 PAK —— **落点由布局决定,不是由"在不在 `assets/` 里"决定。**

于是样本就当普通资源用,白拿一整套资源能力:

- 出现在**资源管理器**里,可预览、可拖拽导入、可改名;
- 保存工程时随 assets **整树重写**,不需要单独的读写通道;
- 因为它是工程资产的一部分,**跟着工程走**;
- 路径校验直接用现成的 `normalizeAssetPath`,不另写一套。

> ⚠️ 这条排除是**隐式**的 —— 靠"布局不匹配就跳过"。若将来扩大 PAK 的收录范围,
> 要显式排除样本目录。

**合规上还有一层:** 声音是生物特征数据。GDPR 把它当敏感个人数据;
Azure 要求 Limited Access 申请 + 口述授权录音 + **声纹核验**(比对授权录音与训练音频
是否同一人),且只有微软托管客户可申请;ElevenLabs 专业克隆加 voice captcha;
OpenAI 定制声音要求声优按指定语句录同意录音,每组织上限 20 个。
所以 `.tts` 的 `voices.<语言>.clone.consent` 是**必需字段** ——
让"没有同意"这件事在编辑期就写不出来。

### 5.4 克隆的可用性由服务商决定

写 `clone` 不等于能克隆。**能不能克隆是服务的能力,不是角色方案的属性** ——
所以判断依据是那个语言条目里 `service` 指向的**服务定义**,而不是 `.tts` 里写了什么。

分两级:

- **协议不提供克隆的**(`google` / `polly`)→ 服务也开不了;
- **协议提供但受限的**(`azure` 需 Limited Access、`openai` 需 sales 审批)
  → 由服务定义显式开启能力开关;
- **协议默认可用的**(`elevenlabs` / `minimax`)→ 开箱即用。

落地方式:服务定义带一个可省的 `capabilities`,默认值来自 **`provider` 预设表**,
且**只能收窄不能放宽**(`capabilities ⊆ 预设`)。**编辑器在该服务不具备能力时
根本不显示"克隆"选项** —— 用户不该先选了一个做不到的东西,再被报错拦下。

详见 `docs/tts-spec.md` §4.6 与 §5.6。

---

## 6. 建议的接入顺序

1. **`openai-compatible`** —— 一家吃下 OpenAI / Groq / OpenRouter,先跑通闭环。
2. **`minimax`** —— 中文听感与情绪控制最好,补上粤语;顺带把**克隆登记**跑通
   (它的流程最短:上传 → `voice_clone` → 拿 `voice_id`)。
3. **`azure`** —— 中文与多语言覆盖面最好(140+ locale),且能直出单声道 PCM,转码最干净。
   ⚠️ 但它的**克隆**是 Limited Access,只有微软托管客户可申请,别把它当克隆主力。
4. **`elevenlabs`** —— 多语言(70+)与克隆质量最好,补上"一个角色跨语言仍像同一个人"。
5. **`provider: "template"`** —— 预设表之外的自建 / 长尾服务:用户选一个已有协议 + 填端点。
   协议层再往外的**不做** —— 协议枚举里没有"自定义协议"(见 `docs/tts-spec.md` §5.2)。
6. Google / Polly / 聚合网关 / 流式 —— 按需再加。

> **扩展点在这个顺序里体现得很清楚:** 第 5 步之后加新供应商不再需要动代码 ——
> 只要协议已在枚举里,往预设表加一条数据就够了。而且**用户自己就能加**,
> 不用等发版:预设表是插件式的(见 §4.3)。

> 第 2 和第 4 步是**克隆能力**的主要落点。这两家的克隆默认可用;
> `azure` / `openai-compatible` 虽然协议里有克隆入口,但都要额外审批,
> 所以**默认关闭、由服务显式开启**(见 §5.4)。

---

## 7. 未决问题

1. `.tts` 规范已定稿到 v1(见 `docs/tts-spec.md`),剩余待确认项记在那份文档的 §11。
2. **凭据的落盘方式**:服务定义已定落 `meta/voice/service/*.ttsservice`(**跟工程**),
   而真实密钥落哪未定 —— `localStorage` 还是 Tauri 安全存储?涉及打包后的安全性。
   克隆登记表里存的是 `voice_id`(不是密钥),可以放宽。
3. 音色列表要不要缓存?各家的 `voices/list` 接口形态不一(Azure / Polly 有,OpenAI 是固定枚举,
   ElevenLabs 有 `/v1/voices`,MiniMax 有音色列表但克隆音色要单独查)。克隆登记表的
   失效策略也依赖这个。
4. 是否需要"服务端代发"以避免前端暴露密钥 —— 若走 Tauri 命令,则请求/响应 DTO
   要另立 `src/tts/contracts/`。

---

*本文为技术选型参考,非法律意见。许可证信息经 2026 年 9 月核对,接入前请复核各厂商官网当前条款与价格。*
