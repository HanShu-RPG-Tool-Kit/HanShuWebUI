import type { Monaco } from '@monaco-editor/react'
import { LOCALE_KEY_TEXT_RE } from '../i18n/textMap'
import {
  BLOCK_END,
  TRAILING_TERMINATOR,
} from '../hanshu/hsSyntaxRules'

export const HANSHU_LANGUAGE_ID = 'hanshu'
/** `.hsc`（编译产物）单独一套着色：语句以行为界 */
export const HANSHU_HSC_LANGUAGE_ID = 'hanshu-hsc'
export const HANSHU_THEME_ID = 'hanshu-dark-v5'

/**
 * 注意：Monarch 正则里 @ 是特殊字符，字面量 @ 必须写成两个 @。
 * 因此匹配注入点 @sth 时正则里写「两个 @」；
 * 匹配终止符（行首两个 @）时正则里要写「四个 @」。
 */

/**
 * 汉书剧本语法（高亮）：
 * - # 注释 / #stopparse 指令
 * - 行首信号：`?` 条件 / `!` 行为 / `!:`·`:!` 选项附件（后两者与 `!` 分色）
 * - speaker: … // 、行首选项、- 、>>跳转 、<<回退
 * - 系统返回 `--<` / `--<<`（层级 ≥ 2）
 * - @后缀 注入点（洋红）
 * - 行首 @@ 终止符（红色）
 */

/**
 * 行首信号。匹配顺序：`!:` → `:!` → `?` → `!`（避免 `!:` 被 `!` 吃掉）。
 * `nextRoot`：在对白块内遇到信号时切回 root。
 */
function signalLineRules(nextRoot: boolean): Array<[RegExp, unknown]> {
  const tail = (token: string) =>
    nextRoot ? { token, next: 'root' as const } : token
  return [
    [
      /^(!:)([a-zA-Z_][a-zA-Z0-9_.]*)(.*)$/,
      [
        'hanshu.signal.bind.mark',
        'hanshu.signal.bind.id',
        tail('hanshu.signal.bind.args'),
      ],
    ],
    [
      /^(:!)([a-zA-Z_][a-zA-Z0-9_.]*)(.*)$/,
      [
        'hanshu.signal.bind.mark',
        'hanshu.signal.bind.id',
        tail('hanshu.signal.bind.args'),
      ],
    ],
    [
      /^(\?)([a-zA-Z_][a-zA-Z0-9_.]*)(.*)$/,
      [
        'hanshu.signal.cond.mark',
        'hanshu.signal.cond.id',
        tail('hanshu.signal.cond.args'),
      ],
    ],
    [
      /^(!)([a-zA-Z_][a-zA-Z0-9_.]*)(.*)$/,
      [
        'hanshu.signal.action.mark',
        'hanshu.signal.action.id',
        tail('hanshu.signal.action.args'),
      ],
    ],
  ]
}

/**
 * 选项行的着色规则（root 与对话块内部**共用同一份**）。
 *
 * 整行规则的口径：短横线 + 文案一次吃掉，不依赖"先进入某个状态"，块内也不会漏着色；
 * 到冒号为止再交给 `@choiceReply` —— 回复里的 `>>jump` / `<<` 必须靠子状态
 * 才分得出优先级。
 *
 * 下面四条是**实测**得出的（踩过坑，别再改回去）：
 * 1. 分组至少三段，**对象只能放最后一段**：写成两段（`[mark, {label, …}]`）时整行不上色；
 * 2. 分组内的状态切换只写**状态名**（`root` / `choiceReply` / …）：用 `@pop` 会让整行不上色，
 *    只有规则级的非分组动作才用 `@pop`；
 * 3. 需要"行尾退出"的状态，必须由**吃到行尾的那一条规则**切换状态：Monarch 逐行词法，
 *    剩余文本为空时不会再执行任何规则（零宽的 `$` 规则也不行）；
 * 4. `next` / `switchTo` 要写在**组内最后一个元素**上：写成规则第三元素不生效。
 */
/** 系统返回：必须在普通选项规则之前；`<<` 规则先于 `<`。 */
const SYSTEM_RETURN_LINE_RULES = [
  [
    /^(-{2,})(<<)(\s*\/\/)$/,
    [
      'hanshu.choice.mark',
      'hanshu.sysret.root',
      { token: 'hanshu.block.end', next: 'root' },
    ],
  ],
  [
    /^(-{2,})(<)(\s*\/\/)$/,
    [
      'hanshu.choice.mark',
      'hanshu.sysret.parent',
      { token: 'hanshu.block.end', next: 'root' },
    ],
  ],
  [
    /^(-{2,})(<<)()$/,
    [
      'hanshu.choice.mark',
      'hanshu.sysret.root',
      { token: '', next: 'root' },
    ],
  ],
  [
    /^(-{2,})(<)()$/,
    [
      'hanshu.choice.mark',
      'hanshu.sysret.parent',
      { token: '', next: 'root' },
    ],
  ],
]

const CHOICE_LINE_RULES = [
  ...SYSTEM_RETURN_LINE_RULES,
  // `-文案:`（冒号后为空）：行尾即结束 —— 没有回复可着色，别再进回复状态
  [
    /^(-+)([^:@@\\/\n]*)(:)$/,
    [
      'hanshu.choice.mark',
      'hanshu.choice.label',
      { token: 'hanshu.punct', next: 'root' },
    ],
  ],
  // `-文案:` → 冒号后交给回复子状态
  [
    /^(-+)([^:@@\\/\n]*)(:)/,
    [
      'hanshu.choice.mark',
      'hanshu.choice.label',
      { token: 'hanshu.punct', next: '@choiceReply' },
    ],
  ],
  // `-文案//`（文档 §2「只有选项文案」）：闭合符也属于选项行。
  // 注意分组与 token 必须**一一对应**：多出来的分组不会有 token，闭合符就着色不到，
  // 所以空白并进闭合符那一组一起上 block.end。
  [
    /^(-+)([^:@@\\/\n]*?)(\s*\/\/)$/,
    [
      'hanshu.choice.mark',
      'hanshu.choice.label',
      { token: 'hanshu.block.end', next: 'root' },
    ],
  ],
  // `-文案`（还没写闭合符）：仍然按选项树着色，行尾退出。
  // 形态与上面几条**保持一致**：三段分组、且只有最后一段是对象。
  // 之前写成两段（mark + {label,next}）时实测整行不上色。
  [
    /^(-+)([^:@@\\/\n]*)()$/,
    [
      'hanshu.choice.mark',
      'hanshu.choice.label',
      { token: '', next: 'root' },
    ],
  ],
]

/** `.hsc` 里"文案本身是键名"的选项行：`-abcd1234:` / `-abcd1234`（与键名形态同源） */
const HSC_CHOICE_KEY_RE = new RegExp(
  `^(-+)(${LOCALE_KEY_TEXT_RE.source})(:)$`,
  'i',
)
const HSC_CHOICE_KEY_ONLY_RE = new RegExp(
  `^(-+)(${LOCALE_KEY_TEXT_RE.source})()$`,
  'i',
)

/**
 * 行尾即结束的变体（`.hs` 的单行状态与 `.hsc` 共用）。
 *
 * 单行语句的状态必须在**行内最后一条被匹配的规则上**退出。Monaco 是逐行词法，
 * 剩余文本为空时不会再尝试任何规则（包括零宽的 `$` 规则），所以只给"正文文本"
 * 挂 pop 是不够的：`test:abcd1234`、`-文案:abcd1234` 这类以键名 / 跳转
 * 收尾的行会留在状态里，把下一行也吞进去（下一行的选项行就会按正文着色）。
 */
const KEY_AT_LINE_END_RE = new RegExp(`(${LOCALE_KEY_TEXT_RE.source})$`, 'i')
const JUMP_AT_LINE_END_RE = /(>>)([a-zA-Z_][a-zA-Z0-9_]*)$/

/**
 * 单行正文状态的规则工厂：`name:正文…` 的**同一行**部分。
 *
 * `@` 注入点 / `@@` 终止符都是行级写法，所以这里当普通文本。
 * 行尾退出：Monarch 逐行词法，剩余为空时不再执行任何规则，所以每条可能吃到
 * 行尾的规则都要自己切换状态（见文件顶部第 3 条口径）。
 *
 * @param terminated `.hs` 里这一行还可能有 `//` 收尾；`.hsc` 的 `//` 已在编译时去掉
 */
function lineBodyRules(options: {
  terminated: boolean
}): Array<[RegExp, unknown]> {
  return [
    [/\\>>$/, { token: 'hanshu.escape', next: 'root' }],
    [/\\-$/, { token: 'hanshu.escape', next: 'root' }],
    [/\\>>/, 'hanshu.escape'],
    [/\\-/, 'hanshu.escape'],
    ...(options.terminated
      ? ([[TRAILING_TERMINATOR, { token: 'hanshu.block.end', next: 'root' }]] as Array<
          [RegExp, unknown]
        >)
      : []),
    [KEY_AT_LINE_END_RE, { token: 'hanshu.key', next: 'root' }],
    [LOCALE_KEY_TEXT_RE, 'hanshu.key'],
    [/[^\\/\n]+$/, { token: 'hanshu.dialogue', next: 'root' }],
    [/[^\\/\n]+/, 'hanshu.dialogue'],
    [/./, { token: 'hanshu.dialogue', next: 'root' }],
  ]
}

/**
 * 选项回复状态的规则工厂：`-文案:` 冒号之后到行尾。
 * 只从行内进入，所以不需要"独占一行 `//`"的规则；行尾由每条收尾规则切换状态。
 *
 * @param terminated `.hs` 里回复可能以 `//` 收尾；`.hsc` 的 `//` 已在编译时去掉
 */
function choiceReplyRules(options: {
  terminated: boolean
}): Array<[RegExp, unknown]> {
  return [
    [/\\>>$/, { token: 'hanshu.escape', next: 'root' }],
    [/\\<<$/, { token: 'hanshu.escape', next: 'root' }],
    [/\\-$/, { token: 'hanshu.escape', next: 'root' }],
    [/\\>>/, 'hanshu.escape'],
    [/\\<</, 'hanshu.escape'],
    [/\\-/, 'hanshu.escape'],
    [/<<$/, { token: 'hanshu.back.mark', next: 'root' }],
    [/<</, 'hanshu.back.mark'],
    [
      JUMP_AT_LINE_END_RE,
      ['hanshu.jump.mark', { token: 'hanshu.jump.name', next: 'root' }],
    ],
    [
      /(>>)([a-zA-Z_][a-zA-Z0-9_]*)/,
      ['hanshu.jump.mark', 'hanshu.jump.name'],
    ],
    ...(options.terminated
      ? ([[TRAILING_TERMINATOR, { token: 'hanshu.block.end', next: 'root' }]] as Array<
          [RegExp, unknown]
        >)
      : []),
    [KEY_AT_LINE_END_RE, { token: 'hanshu.key', next: 'root' }],
    [LOCALE_KEY_TEXT_RE, 'hanshu.key'],
    [/[^:@@\\/\n]+$/, { token: 'hanshu.choice.reply', next: 'root' }],
    [/[^:@@\\/\n]+/, 'hanshu.choice.reply'],
    [/./, { token: 'hanshu.choice.reply', next: 'root' }],
  ]
}

/**
 * `.hsc` 的着色规则。与 `.hs` 的差别集中在一条：**语句以行为界**。
 *
 * 编译时注释、空行与 `//` 收尾都已经去掉了，所以这里没有"块结束符"：一行写完就是
 * 一条完整语句，多行只出现在未成键的多行块里，遇到下一条语句（选项行 / 新对白行 /
 * 注入点 / 信号）即结束。若沿用 `.hs` 的规则，`.hsc` 里第一个 `speaker:键` 会把后面所有行
 * 都吞成它的正文（`//` 永远不会出现，状态永远不退出）。
 */
const HSC_TOKENIZER = {
  defaultToken: '',
  tokenizer: {
    root: [
      ...signalLineRules(false),
      [/^@@@@[^\r\n]*/, 'hs.term'],
      [/@@[^\s@@][^\s]*/, 'hs.inject'],

      ...SYSTEM_RETURN_LINE_RULES,

      // 选项行：`-文案:回复` / `-文案`（行尾即结束）
      [
        HSC_CHOICE_KEY_RE,
        ['hanshu.choice.mark', 'hanshu.key', { token: 'hanshu.punct', next: 'root' }],
      ],
      [
        HSC_CHOICE_KEY_ONLY_RE,
        [
          'hanshu.choice.mark',
          'hanshu.key',
          { token: '', next: 'root' },
        ],
      ],
      // `-文案:`（冒号后为空）也要行尾退出，否则下一行会落进回复状态
      [
        /^(-+)([^:@@\\/\n]*)(:)$/,
        [
          'hanshu.choice.mark',
          'hanshu.choice.label',
          { token: 'hanshu.punct', next: 'root' },
        ],
      ],
      [
        /^(-+)([^:@@\\/\n]*)(:)/,
        [
          'hanshu.choice.mark',
          'hanshu.choice.label',
          { token: 'hanshu.punct', next: '@hscChoiceReply' },
        ],
      ],
      [
        /^(-+)([^:@@\\/\n]*)()$/,
        [
          'hanshu.choice.mark',
          'hanshu.choice.label',
          { token: '', next: 'root' },
        ],
      ],

      // 独白：`name:` 独行 → 多行块；`name:正文` → 单行
      [
        /^([a-zA-Z_][a-zA-Z0-9_]*)(:)([ \t]*)$/,
        ['hanshu.speaker', 'hanshu.punct', { token: '', next: '@hscBody' }],
      ],
      [
        /^([a-zA-Z_][a-zA-Z0-9_]*)(:)/,
        ['hanshu.speaker', { token: 'hanshu.punct', next: '@hscLineBody' }],
      ],
    ],

    /** `name:正文` 的同一行（`.hsc` 里没有 `//`） */
    hscLineBody: lineBodyRules({ terminated: false }),

    /** 未成键的多行块：后续正文行遇到下一条语句（含注入点 / 信号）即结束 */
    hscBody: [
      [/\\>>/, 'hanshu.escape'],
      [/\\-/, 'hanshu.escape'],
      ...signalLineRules(true),
      [/^@@@@[^\r\n]*/, { token: 'hs.term', next: '@pop' }],
      [/@@[^\s@@][^\s]*/, { token: 'hs.inject', next: '@pop' }],
      ...SYSTEM_RETURN_LINE_RULES,
      [
        HSC_CHOICE_KEY_RE,
        [
          'hanshu.choice.mark',
          'hanshu.key',
          { token: 'hanshu.punct', switchTo: '@hscChoiceReply' },
        ],
      ],
      [
        HSC_CHOICE_KEY_ONLY_RE,
        [
          'hanshu.choice.mark',
          'hanshu.key',
          { token: '', switchTo: 'root' },
        ],
      ],
      [
        /^(-+)([^:@@\\/\n]*)(:)/,
        [
          'hanshu.choice.mark',
          'hanshu.choice.label',
          { token: 'hanshu.punct', switchTo: '@hscChoiceReply' },
        ],
      ],
      // `-文案`（还没写闭合符或没成键）：同样三段分组、只有最后一段是对象，
      // 与上面两条保持形态一致（两段写法实测不上色）
      [
        /^(-+)([^:@@\\/\n]*)()$/,
        [
          'hanshu.choice.mark',
          'hanshu.choice.label',
          { token: '', switchTo: 'root' },
        ],
      ],
      [
        /^([a-zA-Z_][a-zA-Z0-9_]*)(:)([ \t]*)$/,
        ['hanshu.speaker', 'hanshu.punct', { token: '', switchTo: '@hscBody' }],
      ],
      [
        /^([a-zA-Z_][a-zA-Z0-9_]*)(:)/,
        ['hanshu.speaker', { token: 'hanshu.punct', switchTo: '@hscLineBody' }],
      ],
      [LOCALE_KEY_TEXT_RE, 'hanshu.key'],
      [/[^#@@\\/\n]+/, 'hanshu.dialogue'],
      [/./, 'hanshu.dialogue'],
    ],

    /** 选项回复：只从行内进入（`.hsc` 里没有 `//`） */
    hscChoiceReply: choiceReplyRules({ terminated: false }),
  },
}

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
      { token: 'hanshu.speaker', foreground: '4FC1FF', fontStyle: 'bold' },
      { token: 'hanshu.punct', foreground: 'D4D4D4' },
      { token: 'hanshu.block.end', foreground: '808080', fontStyle: 'bold' },
      { token: 'hanshu.dialogue', foreground: 'CE9178' },
      { token: 'hanshu.choice.mark', foreground: 'DCDCAA', fontStyle: 'bold' },
      { token: 'hanshu.choice.label', foreground: 'D7BA7D' },
      { token: 'hanshu.choice.reply', foreground: 'CE9178' },
      // :>>name 跳到 @name —— 与注入点同色系
      { token: 'hanshu.jump.mark', foreground: 'C586C0', fontStyle: 'bold' },
      { token: 'hanshu.jump.name', foreground: 'C586C0', fontStyle: 'italic' },
      // :<< 回整树根
      { token: 'hanshu.back.mark', foreground: '4EC9B0', fontStyle: 'bold' },
      // `--<` / `--<<` 系统返回（与普通选项文案区分）
      { token: 'hanshu.sysret.parent', foreground: '4EC9B0', fontStyle: 'bold' },
      { token: 'hanshu.sysret.root', foreground: '4EC9B0', fontStyle: 'bold italic' },
      { token: 'hanshu.escape', foreground: 'D7BA7D', fontStyle: 'italic' },
      // `?` 条件信号
      { token: 'hanshu.signal.cond.mark', foreground: '4EC9B0', fontStyle: 'bold' },
      { token: 'hanshu.signal.cond.id', foreground: '4EC9B0' },
      { token: 'hanshu.signal.cond.args', foreground: '6A9955' },
      // `!` 独立行为信号
      { token: 'hanshu.signal.action.mark', foreground: 'DCDCAA', fontStyle: 'bold' },
      { token: 'hanshu.signal.action.id', foreground: 'DCDCAA' },
      { token: 'hanshu.signal.action.args', foreground: 'B5CEA8' },
      // `!:` / `:!` 选项附件（与独立 `!` 分色）
      { token: 'hanshu.signal.bind.mark', foreground: 'D7BA7D', fontStyle: 'bold' },
      { token: 'hanshu.signal.bind.id', foreground: 'D7BA7D' },
      { token: 'hanshu.signal.bind.args', foreground: 'CE9178' },
      // 注入 @sth —— 洋红
      { token: 'hs.inject', foreground: 'C586C0', fontStyle: 'bold' },
      // 终止 @@ —— 大红
      { token: 'hs.term', foreground: 'FF2222', fontStyle: 'bold' },
      { token: 'hanshu.directive', foreground: '569CD6', fontStyle: 'bold' },
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
        // `#stopparse`：指令行 —— 从这行往后不再自动成键
        [/^(#stopparse)([ \t]*)$/, ['hanshu.directive', 'white']],
        // 只有行首（可含前导空白）才是注释，行内 `#` 属于正文：
        // 与编译去噪 src/hanshu/compiler.ts 的 `/^\s*#/` 保持一致
        [/^\s*#.*$/, 'comment'],

        ...signalLineRules(false),

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
       * `name:正文…` 的**同一行**部分（注入点 / 终止符都是行级写法，这里 `@` 是普通文本）。
       * 规则与 `.hsc` 的同名状态共用工厂，差别只有 `//` 收尾。
       */
      speakerLineBody: lineBodyRules({ terminated: true }),

      speakerBody: [
        [/\\>>/, 'hanshu.escape'],
        [/\\-/, 'hanshu.escape'],
        ...signalLineRules(true),
        [/^@@@@[^\r\n]*/, 'hs.term'],
        [/@@[^\s@@][^\s]*/, 'hs.inject'],
        // 块结束符只有两种形态（与解析器同一份正则）：独占一行、或行尾。
        // 行内 `//`（`a//b`）属于正文 —— 以前遇到任何 `//` 都 pop，和解析器不一致。
        [BLOCK_END, { token: 'hanshu.block.end', next: 'root' }],
        [TRAILING_TERMINATOR, { token: 'hanshu.block.end', next: 'root' }],
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
        // 键名：只在可能出现键的正文位置匹配（结构行/注入/转义规则已先消费掉那些位置）
        [LOCALE_KEY_TEXT_RE, 'hanshu.key'],
        // 字符类里的 @ 同样要 @@ 转义，否则会吞掉注入点
        [/[^#@@\\/\n]+/, 'hanshu.dialogue'],
        [/./, 'hanshu.dialogue'],
      ],

      /**
       * 选项回复：**只从行内进入**（由选项行的冒号切换过来），
       * 所以这里不需要 `BLOCK_END`（独占一行的 `//` 永远不会出现在行中间）。
       * 规则与 `.hsc` 的同名状态共用工厂，差别只有 `//` 收尾。
       */
      choiceReply: choiceReplyRules({ terminated: true }),
    },
  })

  // `.hsc` 单独一套语言：语句以行为界，没有 `//`
  const hscRegistered = monaco.languages
    .getLanguages()
    .some((lang: { id: string }) => lang.id === HANSHU_HSC_LANGUAGE_ID)
  if (!hscRegistered) {
    monaco.languages.register({ id: HANSHU_HSC_LANGUAGE_ID })
  }
  monaco.languages.setLanguageConfiguration(HANSHU_HSC_LANGUAGE_ID, {})
  monaco.languages.setMonarchTokensProvider(
    HANSHU_HSC_LANGUAGE_ID,
    HSC_TOKENIZER,
  )

  monaco.editor.setTheme(HANSHU_THEME_ID)
}
