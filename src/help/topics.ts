import welcome from './docs/welcome.md?raw'
import docs from './docs/docs.md?raw'
import kitGuide from './docs/kit-guide.md?raw'
import kitExpr from './docs/kit-expr.md?raw'
import progressDesign from './docs/progress-design.md?raw'
import about from './docs/about.md?raw'

export type HelpTopicId = 'welcome' | 'docs' | 'kit-guide' | 'kit-expr' | 'progress-design' | 'about'

export type HelpTopic = {
  id: HelpTopicId
  title: string
  group: string
  /** 文档索引页里是否列出 */
  inDocs: boolean
  /** Markdown 正文；`[标题](#topic-id)` 链接跳转到其它条目 */
  body: string
}

export const HELP_TOPICS: HelpTopic[] = [
  { id: 'welcome', title: '欢迎', group: '开始', inDocs: false, body: welcome },
  { id: 'docs', title: '文档索引', group: '开始', inDocs: false, body: docs },
  { id: 'kit-guide', title: '礼包：超参数与修饰器', group: '礼包', inDocs: true, body: kitGuide },
  { id: 'kit-expr', title: '表达式标准 V1', group: '礼包', inDocs: true, body: kitExpr },
  { id: 'progress-design', title: '进度：任务与委托', group: '进度', inDocs: true, body: progressDesign },
  { id: 'about', title: '关于汉书', group: '关于', inDocs: false, body: about },
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
