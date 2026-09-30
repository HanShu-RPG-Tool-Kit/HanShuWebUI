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
   `assets/<语言标签>/` 分目录,配音方案只需要能按语言给不同音色(甚至不同家服务)。
7. **克隆在厂商控制台做,工程里只引用音色 id。** 应用内不做克隆上传:
   用户在 ElevenLabs / MiniMax 控制台克隆好音色,`.tts` 里只填一个 `voice` id(见 §5.3)。
   实测结论(2026-09,真实账号):ElevenLabs 控制台克隆音色可经 API 全量列出;
   MiniMax 控制台「音色库」音色 API 列不出,但合成与校验都正常 ——
   所以自定义音色走"手填 id + 探测验证"闭环(见 §5.4)。
8. **应用侧只保留两个只读能力**:音色列表(`listVoices`,目前只有 ElevenLabs 协议支持)
   与音色验证(`probeVoice`,合成两个字符确认 id 存在,全协议通用)。
   服务定义里**没有任何"能力声明"** —— 能不能列音色由协议形态决定,
   不是用户可以开关的东西。
9. **服务定义是工程文件,凭据才留在本机。** 服务定义放
   `meta/voice/service/<服务名>.ttsservice`(挂在 `meta/voice/` 下,因为它**只服务于 TTS**),
   是复合对象:`provider`(哪家)/ `protocol`(怎么发)/ `auth`(凭什么)/ 端点 / 模型。
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
| **JSON 内嵌 base64** | MiniMax | `POST https://api.minimaxi.com/v1/t2a_v2`(国内;国际站 `api.minimax.io`,两套 key 不通用,实测) | `Authorization: Bearer` | JSON: `model` `text` `voice_id` `speed` `vol` `pitch` `format` | **JSON 里的 base64** | mp3/pcm/flac/wav |
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

**克隆端点不属于这张表,也不属于本项目。** 克隆在厂商控制台完成(见 §5.3),
工程里出现的 `voice` 一律是厂商账号下的音色 id —— 对适配器来说,
预置音色与克隆音色没有任何区别,都是请求里的一个字符串。

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
meta/voice/service/*.ttsservice  ← 协议 / 端点 / 模型 / 凭据引用（**进工程**）
        ▲                          └── *Ref ──► 本机凭据库（真实密钥，**不进工程**）
        │  每条语言条目各写一次 service: "minimax-main"
meta/voice/<角色>.tts            ← 逐语言：service 引用 + 音色 id + 语速
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

### 4.2.1 克隆不在统一接口里,也不在应用里

克隆**不在本项目做**:用户在厂商控制台上传样本、克隆音色,
应用只引用厂商账号下的音色 id。所以 `TtsRequest` 自始至终只有一个 `voice` 字段,
预置音色与克隆音色对协议层完全同构:

```
厂商控制台(上传样本 → 克隆 → 账号下的 voice_id)
        │
        ▼
.tts 里填 voice: "<voice_id>"  ──►  TtsRequest.voice  ──►  普通合成端点
```

应用侧只保留两个**只读**能力,都走服务自己的凭据(实现在 `src/tts/voices.ts`):

- **`listVoices`(音色列表)**:ElevenLabs `GET /v1/voices` 能列出账号下全部音色
  (含控制台克隆的,category 为 `cloned` / `generated`),编辑器用它做下拉选择。
  MiniMax 的 `get_voice` 列不出控制台「音色库」音色(2026-09 实测),所以列表
  能力按**协议白名单**,只有 ElevenLabs 提供;别的协议不显示「拉取音色」按钮。
- **`probeVoice`(音色验证)**:用两个字符试合成一次,音色不存在时厂商会报明确错误
  (MiniMax 报 `2054 voice id not exist`,**不会静默回退成默认音色** —— 实测),
  全协议通用。列表不可用的协议,就靠"控制台复制 id → 手填 → 点验证"闭环。

### 4.3 落点与依赖

- 代码侧:`src/tts/`(`spec.ts` / `plan.ts` / `service.ts` / `client.ts` /
  `protocols.ts` / `transport.ts` / `voices.ts`(音色列表 + 验证)/
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
- **克隆不在应用里做**,服务定义里因此没有任何"能力声明":能不能列音色由协议形态
  决定(ElevenLabs 可列,MiniMax 不可列),编辑器按协议白名单决定是否显示
  「拉取音色」按钮 —— 见 §5.4。
- 克隆样本**不进工程**:样本由用户直接传到厂商控制台,`assets/` 里不需要为它留位置,
  PAK 裁剪也不用为它特判 —— 见 §5.3。
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

### 5.3 克隆在厂商控制台做,样本不进工程

早先的设计是"`.tts` 里引用工程内样本,应用代为上传克隆,登记表存应用侧"。
2026-09 用真实账号实测后**改为:克隆动作整个交给厂商控制台,工程里只引用音色 id。**
理由:

- **控制台克隆本来就是厂商的主路径**:ElevenLabs / MiniMax 控制台都有完整的样本
  上传、命名、管理界面;用户反正要去控制台开通权限、看额度。
- **两家的 API 枚举能力不对称**:ElevenLabs `GET /v1/voices` 能列出控制台克隆音色;
  MiniMax `get_voice` **列不出**控制台「音色库」音色(只有 API 克隆、且合成用过的
  才出现 —— 实测)。应用内做克隆管理反而要维护一张"登记过哪些 id"的对照表,
  还永远对不齐控制台。
- **工程文件因此完全无状态**:`.tts` 里只有 `voice: "<id>"`,换机器、换工程不涉及
  样本与登记表的迁移;换账号就换 id,语义直白。

于是两个老问题一起消失了:

- **样本不进 `assets/`,不用讨论 PAK**:样本从用户本机直接传到厂商,工程树里没有
  参考音频,`resourcePack` 的裁剪规则无需为它特判(旧设计里"样本布局不匹配就被
  跳过"的隐式排除也随之作废)。
- **合规把关在厂商,应用不多管闲事**:声音是生物特征数据,各家控制台都有自己的
  授权流程(ElevenLabs 专业克隆要 voice captcha,Azure 要 Limited Access + 声纹核验,
  OpenAI 定制声音要同意录音)。用户在控制台完成克隆即已完成该厂商的授权流程,
  工程文件里不需要、也不应该再放 `consent` 之类的声明字段。

### 5.4 音色从哪来:列表 or 手填 + 验证

克隆移出应用后,编辑器只剩一个问题:用户怎么把音色 id 填对。按协议分两类:

- **ElevenLabs —— 可列出**。`GET /v1/voices` 返回账号下全部音色(系统预置 +
  控制台克隆,`category` 字段区分),编辑器直接给下拉框,选中即填好 id。
  注意受限 API key 可能缺 `voices_read` 权限,报错体会指明缺的权限名(实测),
  编辑器把这条错误原样显示即可。
- **其余协议 —— 手填 + 验证**。用户在控制台复制音色 id 粘贴进来,点「验证」,
  应用用两个字符试合成一次:音色不存在时 MiniMax 返回 `2054 voice id not exist`、
  ElevenLabs 返回明确 4xx,都**不会静默换成默认音色**(2026-09 实测),
  所以探测验证是**精确**的,不是"大概能合成"。

探测成本约 2 字符额度/次,可以忽略。**不要凭旧印象假设厂商会静默回退** ——
早先担心的"填错 id 悄悄换成默认音色"在实测中不存在。

详见 `docs/tts-spec.md` §5.6。

---

## 6. 建议的接入顺序

1. **`openai-compatible`** —— 一家吃下 OpenAI / Groq / OpenRouter,先跑通闭环。
2. **`minimax`** —— 中文听感与情绪控制最好,补上粤语;顺带把**音色验证**跑通
   (它的 `2054 voice id not exist` 报错清晰,适合先验证"手填 id + 探测"闭环)。
3. **`azure`** —— 中文与多语言覆盖面最好(140+ locale),且能直出单声道 PCM,转码最干净。
4. **`elevenlabs`** —— 多语言(70+)与克隆质量最好,补上"一个角色跨语言仍像同一个人";
   顺带把**音色列表**跑通(`GET /v1/voices`,目前唯一可列的协议)。
5. **`provider: "template"`** —— 预设表之外的自建 / 长尾服务:用户选一个已有协议 + 填端点。
   协议层再往外的**不做** —— 协议枚举里没有"自定义协议"(见 `docs/tts-spec.md` §5.2)。
6. Google / Polly / 聚合网关 / 流式 —— 按需再加。

> **扩展点在这个顺序里体现得很清楚:** 第 5 步之后加新供应商不再需要动代码 ——
> 只要协议已在枚举里,往预设表加一条数据就够了。而且**用户自己就能加**,
> 不用等发版:预设表是插件式的(见 §4.3)。

> 第 2 和第 4 步是**自定义音色**的主要落点:这两家的克隆在控制台做、门槛低,
> 是用户最可能用到自定义音色的地方。ElevenLabs 顺带提供音色列表,
> MiniMax 走"手填 id + 验证"(见 §5.4)。

---

## 7. 未决问题

1. `.tts` 规范已定稿到 v1(见 `docs/tts-spec.md`),剩余待确认项记在那份文档的 §11。
2. **凭据的落盘方式**:服务定义已定落 `meta/voice/service/*.ttsservice`(**跟工程**),
   而真实密钥落哪未定 —— 目前是 `localStorage` 明文,桌面端建议升级到
   OS 钥匙串(Tauri 侧),涉及打包后的安全性。
3. **音色列表要不要缓存**:目前只有 ElevenLabs 可列(`GET /v1/voices`),
   每次拉取有一次请求延迟,编辑器要不要缓存、缓存多久待定。
   其余协议靠"手填 + 验证",没有列表可缓存。
4. 是否需要"服务端代发"以避免前端暴露密钥 —— 若走 Tauri 命令,则请求/响应 DTO
   要另立 `src/tts/contracts/`。

---

*本文为技术选型参考,非法律意见。许可证信息经 2026 年 9 月核对,接入前请复核各厂商官网当前条款与价格。*
