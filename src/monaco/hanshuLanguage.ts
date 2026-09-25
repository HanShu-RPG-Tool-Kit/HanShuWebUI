import type { Monaco } from '@monaco-editor/react'

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

        [/^-+/, { token: 'hanshu.choice.mark', next: '@choiceLine' }],

        [
          /^([a-zA-Z_][a-zA-Z0-9_]*)(:)/,
          ['hanshu.speaker', { token: 'hanshu.punct', next: '@speakerBody' }],
        ],
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
        [/\/\//, { token: 'hanshu.block.end', next: '@pop' }],
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
        // 字符类里的 @ 同样要 @@ 转义，否则会吞掉注入点
        [/[^#@@\\\/'\n]+/, 'hanshu.dialogue'],
        [/./, 'hanshu.dialogue'],
      ],

      choiceLine: [
        [/\\>>/, 'hanshu.escape'],
        [/\\-/, 'hanshu.escape'],
        [/@@[^\s@@][^\s]*/, 'hs.inject'],
        [
          /(>>)([a-zA-Z_][a-zA-Z0-9_]*)/,
          ['hanshu.call.mark', 'hanshu.call.name'],
        ],
        [/\/\//, { token: 'hanshu.block.end', next: '@pop' }],
        [/:/, { token: 'hanshu.punct', switchTo: '@choiceReply' }],
        [/[^:@@\\/\n]+/, 'hanshu.choice.label'],
        [/./, 'hanshu.choice.label'],
        [/\n/, { token: '', next: '@pop' }],
      ],

      choiceReply: [
        [/\\>>/, 'hanshu.escape'],
        [/\\<</, 'hanshu.escape'],
        [/\\-/, 'hanshu.escape'],
        [/@@[^\s@@][^\s]*/, 'hs.inject'],
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
        [/\/\//, { token: 'hanshu.block.end', next: '@pop' }],
        [/[^:@@\\/\n]+/, 'hanshu.choice.reply'],
        [/./, 'hanshu.choice.reply'],
        [/\n/, { token: '', next: '@pop' }],
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
