import { useDeferredValue, useMemo } from 'react'
import Editor from '@monaco-editor/react'
import {
  HANSHU_LANGUAGE_ID,
  HANSHU_THEME_ID,
  registerHanshuLanguage,
} from './monaco/hanshuLanguage'
import { compileHsToHsc } from './hanshu/lines'

type HscPreviewProps = {
  source: string
}

/** .hs → .hsc 只读视角（去注释/空行、hash 替换、去掉 //） */
export function HscPreview({ source }: HscPreviewProps) {
  const deferred = useDeferredValue(source)
  const hsc = useMemo(() => compileHsToHsc(deferred), [deferred])

  return (
    <div className="hsc-preview" aria-label="编译后 .hsc 预览">
      <div className="hsc-preview-label">.hsc</div>
      <div className="hsc-preview-editor">
        <Editor
          height="100%"
          language={HANSHU_LANGUAGE_ID}
          theme={HANSHU_THEME_ID}
          value={hsc}
          beforeMount={registerHanshuLanguage}
          options={{
            readOnly: true,
            domReadOnly: true,
            fontSize: 16,
            fontFamily:
              'Consolas, "Courier New", "Sarasa Mono SC", monospace',
            lineHeight: 26,
            minimap: { enabled: false },
            wordWrap: 'on',
            scrollBeyondLastLine: false,
            automaticLayout: true,
            padding: { top: 14, bottom: 14 },
            renderLineHighlight: 'none',
            cursorBlinking: 'solid',
            overviewRulerBorder: false,
            stickyScroll: { enabled: false },
            scrollbar: {
              verticalScrollbarSize: 14,
              horizontalScrollbarSize: 14,
            },
          }}
        />
      </div>
    </div>
  )
}
