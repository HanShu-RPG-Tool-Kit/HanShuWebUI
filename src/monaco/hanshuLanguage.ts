import type { Monaco } from '@monaco-editor/react'
import { LOCALE_KEY_TEXT_RE } from '../i18n/langTextMap'
import {
  BLOCK_END,
  TRAILING_TERMINATOR,
} from '../hanshu/hsSyntaxRules'

export const HANSHU_LANGUAGE_ID = 'hanshu'
export const HANSHU_THEME_ID = 'hanshu-dark-v3'

/**
 * 注意：Monarch 正则里 @ 是特殊字符，字面量 @ 必须写成两个 @。
 * 因此匹配注入点 @sth 时正则里写「两个 @」；
 * 匹配终止符（行首两个 @）时正则里要写「四个 @」。
 */

/**
 * 汉书剧本语法（高亮）：
 * - #define / # 注释 / '''' Python
 * - speaker: … // 、行首选项、- 、>>调用 、>跳转 、<<回退
 * - @后缀 注入点（洋红）
 * - 行首 @@ 终止符（红色）
 */
/**
 * 选项行的着色规则（root 与对话块内部**共用同一份**）。
 *
 * - 短横线 + 文案用整行规则一次吃掉：不依赖"先进入某个状态"，块内也不会漏着色；
 * - 到冒号为止再交给 `@choiceReply` —— 回复里的 `>>func` / `>jump` / `<<` 必须靠子状态
 *   才分得出优先级；
 * - **状态切换要写在分组最后一个元素的 action 对象里**：写成第三元素 `next` 不生效
 *   （回复会整段退化成普通文本）；
 * - 行尾 `@pop`：Monarch 是逐行词法，`[/\n/]` 规则不会触发，必须"吃到行尾就退出"，
 *   否则状态会带到下一行。
 */
const CHOICE_LINE_RULES = [
  [
    /^(-+)([^:@@\\/\n]*)(:)/,
    [
      'hanshu.choice.mark',
      'hanshu.choice.label',
      { token: 'hanshu.punct', next: '@choiceReply' },
    ],
  ],
  [
    /^(-+)([^:@@\\/\n]*)$/,
    ['hanshu.choice.mark', { token: 'hanshu.choice.label', next: '@pop' }],
  ],
]

export function registerHanshuLanguage(monaco: Monaco) {
  const registered = monaco.languages
    .getLanguages()
    .some((lang: { id: string }) => lang.id === HANSHU_LANGUAGE_ID)

  if (!registered) {
    monaco.languages.register({ id: HANSHU_LANGUAGE_ID })
  }

  monaco.editor.defineTheme(HANSHU_THEME_ID, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'hanshu.embed', foreground: 'C586C0', fontStyle: 'bold' },
      { token: 'hanshu.speaker', foreground: '4FC1FF', fontStyle: 'bold' },
      { token: 'hanshu.punct', foreground: 'D4D4D4' },
      { token: 'hanshu.block.end', foreground: '808080', fontStyle: 'bold' },
      { token: 'hanshu.dialogue', foreground: 'CE9178' },
      { token: 'hanshu.choice.mark', foreground: 'DCDCAA', fontStyle: 'bold' },
      { token: 'hanshu.choice.label', foreground: 'D7BA7D' },
      { token: 'hanshu.choice.reply', foreground: 'CE9178' },
      { token: 'hanshu.call.mark', foreground: 'C586C0', fontStyle: 'bold' },
      { token: 'hanshu.call.name', foreground: 'DCDCAA', fontStyle: 'italic' },
      // :>name 跳到 @name —— 与注入点同色系
      { token: 'hanshu.jump.mark', foreground: 'C586C0', fontStyle: 'bold' },
      { token: 'hanshu.jump.name', foreground: 'C586C0', fontStyle: 'italic' },
      // :<< 退回上一级重选
      { token: 'hanshu.back.mark', foreground: '4EC9B0', fontStyle: 'bold' },
      { token: 'hanshu.escape', foreground: 'D7BA7D', fontStyle: 'italic' },
      // 注入 @sth —— 洋红
      { token: 'hs.inject', foreground: 'C586C0', fontStyle: 'bold' },
      // 终止 @@ —— 大红
      { token: 'hs.term', foreground: 'FF2222', fontStyle: 'bold' },
      { token: 'hanshu.define.kw', foreground: '569CD6', fontStyle: 'bold' },
      { token: 'hanshu.define.name', foreground: '4EC9B0', fontStyle: 'bold' },
      { token: 'hanshu.define.body', foreground: 'CE9178' },
      // 键名（8 位 hex）：只在可能出现键的正文位置着色，见 tokenizer 里的 key 规则
      { token: 'hanshu.key', foreground: '9CDCFE' },
    ],
    colors: {},
  })

  monaco.languages.setLanguageConfiguration(HANSHU_LANGUAGE_ID, {})

  monaco.languages.setMonarchTokensProvider(HANSHU_LANGUAGE_ID, {
    defaultToken: '',
    tokenizer: {
      root: [
        [
          /^(#define)(\s+)([a-zA-Z_][a-zA-Z0-9_]*)(\s+)(.*)$/,
          [
            'hanshu.define.kw',
            'white',
            'hanshu.define.name',
            'white',
            'hanshu.define.body',
          ],
        ],
        // 只有行首（可含前导空白）才是注释，行内 `#` 属于正文：
        // 与编译去噪 src/hanshu/lines.ts 的 `/^\s*#/` 保持一致
        [/^\s*#.*$/, 'comment'],
        [
          /''''/,
          {
            token: 'hanshu.embed',
            next: '@pythonBlock',
            nextEmbedded: 'python',
          },
        ],

        // 行首终止符：字面量 @@  → Monarch 写成 @@@@
        [/^@@@@[^\r\n]*/, 'hs.term'],

        // 注入点：字面量 @ + 非 @ 后缀 → Monarch 写成 @@…
        // [^\s@@] = 非空白且非字面量 @
        [/@@[^\s@@][^\s]*/, 'hs.inject'],

        ...CHOICE_LINE_RULES,

        // `name:` 独占一行 → 多行块：正文在后续行，那里行首的 `@` 才是注入点
        [
          /^([a-zA-Z_][a-zA-Z0-9_]*)(:)([ \t]*)$/,
          [
            'hanshu.speaker',
            'hanshu.punct',
            { token: '', next: '@speakerBody' },
          ],
        ],
        // `name:正文…` 单行：**同一行**里的 `@` 只是普通文本（注入点是行级写法）
        [
          /^([a-zA-Z_][a-zA-Z0-9_]*)(:)/,
          ['hanshu.speaker', { token: 'hanshu.punct', next: '@speakerLineBody' }],
        ],
      ],

      /**
       * `name:正文…` 的**同一行**部分。
       * 注入点 / 终止符都是行级写法，所以这里的 `@` 当普通文本；`//` 是单行写法的收尾。
       * 行尾退出：Monarch 逐行词法，`[/\n/]` 规则不会触发，靠带 `$` 的规则 pop。
       */
      speakerLineBody: [
        [/\\>>/, 'hanshu.escape'],
        [/\\-/, 'hanshu.escape'],
        [
          /(>>)([a-zA-Z_][a-zA-Z0-9_]*)/,
          ['hanshu.call.mark', 'hanshu.call.name'],
        ],
        [TRAILING_TERMINATOR, { token: 'hanshu.block.end', next: '@pop' }],
        [LOCALE_KEY_TEXT_RE, 'hanshu.key'],
        [
          /''''/,
          {
            token: 'hanshu.embed',
            next: '@pythonBlock',
            nextEmbedded: 'python',
          },
        ],
        [/[^\\/'\n]+$/, { token: 'hanshu.dialogue', next: '@pop' }],
        [/[^\\/'\n]+/, 'hanshu.dialogue'],
        [/./, { token: 'hanshu.dialogue', next: '@pop' }],
      ],

      speakerBody: [
        [/\\>>/, 'hanshu.escape'],
        [/\\-/, 'hanshu.escape'],
        [/^@@@@[^\r\n]*/, 'hs.term'],
        [/@@[^\s@@][^\s]*/, 'hs.inject'],
        [
          /(>>)([a-zA-Z_][a-zA-Z0-9_]*)/,
          ['hanshu.call.mark', 'hanshu.call.name'],
        ],
        // 块结束符只有两种形态（与解析器同一份正则）：独占一行、或行尾。
        // 行内 `//`（`a//b`）属于正文 —— 以前遇到任何 `//` 都 pop，和解析器不一致。
        [BLOCK_END, { token: 'hanshu.block.end', next: '@pop' }],
        [TRAILING_TERMINATOR, { token: 'hanshu.block.end', next: '@pop' }],
        // 块内遇到选项行：与 root 同一份规则（顺带结束块状态）
        ...CHOICE_LINE_RULES,
        // 块内遇到新语句：`name:` 独行 → 新的多行块；`name:正文` → 单行写法。
        // 这里用 switchTo（替换当前状态）：旧块已经结束，不能再回到它。
        [
          /^([a-zA-Z_][a-zA-Z0-9_]*)(:)([ \t]*)$/,
          [
            'hanshu.speaker',
            'hanshu.punct',
            { token: '', next: '@speakerBody' },
          ],
        ],
        [
          /^([a-zA-Z_][a-zA-Z0-9_]*)(:)/,
          [
            'hanshu.speaker',
            { token: 'hanshu.punct', switchTo: '@speakerLineBody' },
          ],
        ],
        // 同 root：块内也只有行首 `#` 才是注释
        [/^\s*#.*$/, 'comment'],
        [
          /''''/,
          {
            token: 'hanshu.embed',
            next: '@pythonBlock',
            nextEmbedded: 'python',
          },
        ],
        // 键名：只在可能出现键的正文位置匹配（结构行/注入/调用/转义规则已先消费掉那些位置）
        [LOCALE_KEY_TEXT_RE, 'hanshu.key'],
        // 字符类里的 @ 同样要 @@ 转义，否则会吞掉注入点
        [/[^#@@\\/'\n]+/, 'hanshu.dialogue'],
        [/./, 'hanshu.dialogue'],
      ],

      /**
       * 选项回复：**只从行内进入**（`@choiceReply` 由选项行的冒号切换过来），
       * 所以这里不需要 `BLOCK_END`（独占一行的 `//` 永远不会出现在行中间），
       * 由行尾退出兜底。
       */
      choiceReply: [
        [/\\>>/, 'hanshu.escape'],
        [/\\<</, 'hanshu.escape'],
        [/\\-/, 'hanshu.escape'],
        // 回复与 `-文案:` 同行，注入点 / 终止符都是行级写法 → 这里 `@` 只是普通文本
        [/<</, 'hanshu.back.mark'],
        // >>func 须先于 >jump，避免被单 > 吃掉
        [
          /(>>)([a-zA-Z_][a-zA-Z0-9_]*)/,
          ['hanshu.call.mark', 'hanshu.call.name'],
        ],
        [
          /(>)([a-zA-Z_][a-zA-Z0-9_]*)/,
          ['hanshu.jump.mark', 'hanshu.jump.name'],
        ],
        [TRAILING_TERMINATOR, { token: 'hanshu.block.end', next: '@pop' }],
        [LOCALE_KEY_TEXT_RE, 'hanshu.key'],
        // 行尾退出：合法回复一定带 `//`（上面那条会先弹出），这里是给没写 `//` 的兜底
        [/[^:@@\\/\n]+$/, { token: 'hanshu.choice.reply', next: '@pop' }],
        [/[^:@@\\/\n]+/, 'hanshu.choice.reply'],
        [/./, { token: 'hanshu.choice.reply', next: '@pop' }],
      ],

      pythonBlock: [
        [
          /''''/,
          {
            token: 'hanshu.embed',
            next: '@pop',
            nextEmbedded: '@pop',
          },
        ],
        [/[^']+/, ''],
        [/'/, ''],
      ],
    },
  })

  monaco.editor.setTheme(HANSHU_THEME_ID)
}
