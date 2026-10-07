import type { Monaco } from '@monaco-editor/react'
import { LOCALE_KEY_TEXT_RE } from '../i18n/textMap'

export const CHAR_LANGUAGE_ID = 'hanshu-char'
export const CHAR_THEME_ID = 'hanshu-char-dark-v1'

/**
 * `.char` 着色：只有 `key:msg//` 与 `#` 注释。
 */
export function registerCharLanguage(monaco: Monaco) {
  const registered = monaco.languages
    .getLanguages()
    .some((lang: { id: string }) => lang.id === CHAR_LANGUAGE_ID)

  if (!registered) {
    monaco.languages.register({ id: CHAR_LANGUAGE_ID })
  }

  monaco.editor.defineTheme(CHAR_THEME_ID, {
    base: 'vs-dark',
    inherit: true,
    rules: [
      { token: 'char.key', foreground: '4FC1FF', fontStyle: 'bold' },
      { token: 'char.punct', foreground: 'D4D4D4' },
      { token: 'char.text', foreground: 'CE9178' },
      { token: 'char.block.end', foreground: '808080', fontStyle: 'bold' },
      { token: 'char.keyname', foreground: '9CDCFE' },
      { token: 'char.directive', foreground: '569CD6', fontStyle: 'bold' },
    ],
    colors: {},
  })

  monaco.languages.setLanguageConfiguration(CHAR_LANGUAGE_ID, {})

  monaco.languages.setMonarchTokensProvider(CHAR_LANGUAGE_ID, {
    defaultToken: '',
    tokenizer: {
      root: [
        [/^(#stopparse)([ \t]*)$/, ['char.directive', 'white']],
        [/^\s*#.*$/, 'comment'],
        [
          /^([a-zA-Z_][a-zA-Z0-9_]*)(:)/,
          ['char.key', { token: 'char.punct', next: '@body' }],
        ],
      ],
      body: [
        [/\/\/\s*$/, { token: 'char.block.end', next: 'root' }],
        [LOCALE_KEY_TEXT_RE, 'char.keyname'],
        [/[^/\n]+/, 'char.text'],
        [/./, 'char.text'],
      ],
    },
  })
}
