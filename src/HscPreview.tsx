import { useDeferredValue, useMemo } from 'react'
import Editor from '@monaco-editor/react'
import {
  HANSHU_HSC_LANGUAGE_ID,
  HANSHU_THEME_ID,
  registerHanshuLanguage,
} from './monaco/hanshuLanguage'
import { compileHsToHsc } from './hanshu/compiler'

type HscPreviewProps = {
  source: string
}

/** .hs → .hsc 只读视角（全文解析校验、去注释/空行、去掉 //） */
export function HscPreview({ source }: HscPreviewProps) {
  const deferred = useDeferredValue(source)
  // 编译会做"含键名内容必须闭合"的校验：不通过时把错误显示出来，而不是空预览
  const { hsc, error } = useMemo(() => {
    try {
      return { hsc: compileHsToHsc(deferred), error: '' }
    } catch (err) {
      return {
        hsc: '',
        error: err instanceof Error ? err.message : String(err),
      }
    }
  }, [deferred])

  return (
    <div className="hsc-preview" aria-label="编译后 .hsc 预览">
      <div className="hsc-preview-label">.hsc</div>
      {error ? (
        <div className="hsc-preview-error" role="alert">
          {error}
        </div>
      ) : (
        <div className="hsc-preview-editor">
        <Editor
          height="100%"
          language={HANSHU_HSC_LANGUAGE_ID}
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
      )}
    </div>
  )
}
