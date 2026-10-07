/**
 * `.char` 角色卡语法（唯一正文形态：`key:msg//`）。
 *
 * - 角色 id = 文件名（不含后缀），**不**写在文件里。
 * - `key` / `msg` 语义由作者自定（如 name、称呼）；标准不规定键名词汇表。
 * - 可本地化与配音与 `.hs` 同源：成键 → `lang_char` / `voice_char`。
 */

/** 单行槽位：`key:正文//`（须行尾 `//`） */
export const CHAR_ENTRY_LINE =
  /^([a-zA-Z_][a-zA-Z0-9_]*):(.*)\/\/\s*$/

/** 注释：行首（可含前导空白）的 `#` */
export const CHAR_COMMENT_LINE = /^\s*#/

/** 从逻辑文件名取角色 id：`notch.char` → `notch`；`src/character/a.char` → `a` */
export function charIdFromSourceName(sourceName: string): string {
  const base =
    sourceName
      .trim()
      .replace(/\\/g, '/')
      .split('/')
      .pop()
      ?.replace(/\.char$/i, '') ?? ''
  return base
}
