import welcome from './docs/welcome.md?raw'
import docs from './docs/docs.md?raw'
import hanshuSyntax from './docs/hanshu-syntax.md?raw'
import charSyntax from './docs/char-syntax.md?raw'
import hscMachine from './docs/hsc-machine.md?raw'
import hscMachineFramework from './docs/hsc-machine-framework.md?raw'
import kitGuide from './docs/kit-guide.md?raw'
import kitExpr from './docs/kit-expr.md?raw'
import progressWorkspace from './docs/progress-workspace.md?raw'
import progressFlowModel from './docs/progress-flow-model.md?raw'
import progressDocument from './docs/progress-document.md?raw'
import progressDesign from './docs/progress-design.md?raw'
import ttsSpec from './docs/tts-spec.md?raw'
import ttsProviders from './docs/tts-providers.md?raw'
import skinLibrary from './docs/skin-library.md?raw'
import exportPak from './docs/export-pak.md?raw'
import about from './docs/about.md?raw'

/** 帮助条目 id；正文用 `[标题](#topic-id)` 互链 */
export type HelpTopicId =
  | 'welcome'
  | 'docs'
  | 'hanshu-syntax'
  | 'char-syntax'
  | 'hsc-machine'
  | 'hsc-machine-framework'
  | 'kit-guide'
  | 'kit-expr'
  | 'progress-workspace'
  | 'progress-flow-model'
  | 'progress-document'
  | 'progress-design'
  | 'tts-spec'
  | 'tts-providers'
  | 'skin-library'
  | 'export-pak'
  | 'about'

/** 受众：导航全部展示；文档索引用文案区分 */
export type HelpAudience = 'user' | 'dev' | 'both' | 'draft'

export type HelpTopic = {
  id: HelpTopicId
  title: string
  group: string
  audience: HelpAudience
  /** 文档索引页里是否列出 */
  inDocs: boolean
  /** Markdown 正文；`[标题](#topic-id)` 链接跳转到其它条目 */
  body: string
}

export const HELP_TOPICS: HelpTopic[] = [
  { id: 'welcome', title: '欢迎', group: '开始', audience: 'user', inDocs: false, body: welcome },
  { id: 'docs', title: '文档索引', group: '开始', audience: 'both', inDocs: false, body: docs },
  {
    id: 'hanshu-syntax',
    title: '.hs 语法说明',
    group: '剧本',
    audience: 'both',
    inDocs: true,
    body: hanshuSyntax,
  },
  {
    id: 'char-syntax',
    title: '.char 角色卡语法',
    group: '剧本',
    audience: 'both',
    inDocs: true,
    body: charSyntax,
  },
  {
    id: 'hsc-machine',
    title: '抽象汉书自动机',
    group: '剧本',
    audience: 'dev',
    inDocs: true,
    body: hscMachine,
  },
  {
    id: 'hsc-machine-framework',
    title: 'HSC 机器实现框架',
    group: '剧本',
    audience: 'dev',
    inDocs: true,
    body: hscMachineFramework,
  },
  {
    id: 'kit-guide',
    title: '礼包：超参数与修饰器',
    group: '礼包',
    audience: 'user',
    inDocs: true,
    body: kitGuide,
  },
  {
    id: 'kit-expr',
    title: '表达式标准 V1',
    group: '礼包',
    audience: 'dev',
    inDocs: true,
    body: kitExpr,
  },
  {
    id: 'progress-workspace',
    title: '进度工作区',
    group: '进度',
    audience: 'both',
    inDocs: true,
    body: progressWorkspace,
  },
  {
    id: 'progress-flow-model',
    title: '进度流程模型',
    group: '进度',
    audience: 'dev',
    inDocs: true,
    body: progressFlowModel,
  },
  {
    id: 'progress-document',
    title: '.progress 文档与表单',
    group: '进度',
    audience: 'both',
    inDocs: true,
    body: progressDocument,
  },
  {
    id: 'progress-design',
    title: '进度：任务与委托',
    group: '进度',
    audience: 'draft',
    inDocs: true,
    body: progressDesign,
  },
  {
    id: 'tts-spec',
    title: '配音：服务与方案规范',
    group: '配音',
    audience: 'dev',
    inDocs: true,
    body: ttsSpec,
  },
  {
    id: 'tts-providers',
    title: '配音：供应商与实现',
    group: '配音',
    audience: 'dev',
    inDocs: true,
    body: ttsProviders,
  },
  {
    id: 'skin-library',
    title: '皮肤库',
    group: '皮肤',
    audience: 'both',
    inDocs: true,
    body: skinLibrary,
  },
  {
    id: 'export-pak',
    title: '导出 PAK',
    group: '导出',
    audience: 'dev',
    inDocs: true,
    body: exportPak,
  },
  { id: 'about', title: '关于汉书', group: '关于', audience: 'user', inDocs: false, body: about },
]

export function isHelpTopicId(id: string): id is HelpTopicId {
  return HELP_TOPICS.some((topic) => topic.id === id)
}

export function helpTopic(id: HelpTopicId): HelpTopic {
  const topic = HELP_TOPICS.find((item) => item.id === id)
  if (!topic) throw new Error(`未知帮助条目：${id}`)
  return topic
}

export function docsTopics(): HelpTopic[] {
  return HELP_TOPICS.filter((topic) => topic.inDocs)
}

export function helpGroups(): { group: string; topics: HelpTopic[] }[] {
  const groups: { group: string; topics: HelpTopic[] }[] = []
  for (const topic of HELP_TOPICS) {
    const last = groups[groups.length - 1]
    if (last?.group === topic.group) last.topics.push(topic)
    else groups.push({ group: topic.group, topics: [topic] })
  }
  return groups
}
