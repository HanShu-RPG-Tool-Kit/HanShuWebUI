import { useEffect, useRef, useState } from 'react'
import Editor, { type OnMount } from '@monaco-editor/react'
import type { AssetFile } from './workspace'
import { editorLanguageForFile } from './workspace'
import {
  assetFileName,
  isAudioAsset,
  isImageAsset,
  isJsonAsset,
  isTextAsset,
} from './assets/paths'
import { getAssetBlob } from './assets/idb'
import { HANSHU_THEME_ID, registerHanshuLanguage } from './monaco/hanshuLanguage'

type AssetPreviewProps = {
  packageId: string
  asset: AssetFile
  /**
   * 文本/JSON 资产（`.lang`、`.voice`）的保存回调。
   * 提供后文本资产用**可写** JSON 编辑器打开；不提供则只读呈现。
   */
  onSaveText?: (content: string) => void | Promise<void>
}

/** 只读呈现时尽量格式化；解析失败就原样显示（损坏的 lang 也要能看见） */
function formatJsonText(raw: string): string {
  try {
    return JSON.stringify(JSON.parse(raw), null, 2)
  } catch {
    return raw
  }
}

/** JSON 资产的语法错误信息；合法或不要求校验时返回 null */
function jsonErrorOf(raw: string, enabled: boolean): string | null {
  if (!enabled) return null
  try {
    JSON.parse(raw)
    return null
  } catch (err) {
    return err instanceof Error ? err.message : String(err)
  }
}

export function AssetPreview({
  packageId,
  asset,
  onSaveText,
}: AssetPreviewProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [text, setText] = useState<string | null>(null)
  const [draft, setDraft] = useState<string | null>(null)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef<string | null>(null)
  const draftRef = useRef<string | null>(null)
  const textRef = useRef<string | null>(null)
  const savingRef = useRef(false)

  const json = isJsonAsset(asset.path, asset.mime)
  const texty = isTextAsset(asset.path, asset.mime)
  const editable = texty && onSaveText != null

  useEffect(() => {
    let cancelled = false
    setError(null)
    setUrl(null)
    setText(null)

    void (async () => {
      try {
        const blob = await getAssetBlob(packageId, asset.path)
        if (cancelled) return
        if (!blob) {
          setError('找不到资产数据（可能已被清除）')
          return
        }
        // 文本资产直接把内容读出来（音频/图片仍走 object URL）
        if (isTextAsset(asset.path, asset.mime)) {
          const raw = await blob.text()
          if (cancelled) return
          setText(raw)
          // 只有在没有未保存草稿时才清空草稿：否则外部写入（例如键槽编辑）
          // 触发的重读会把用户正在编辑的内容丢掉。
          setDraft((prev) => (prev === null || prev === raw ? null : prev))
        }
        const next = URL.createObjectURL(blob)
        if (urlRef.current) URL.revokeObjectURL(urlRef.current)
        urlRef.current = next
        setUrl(next)
      } catch (err) {
        if (!cancelled) {
          setError(err instanceof Error ? err.message : String(err))
        }
      }
    })()

    return () => {
      cancelled = true
      if (urlRef.current) {
        URL.revokeObjectURL(urlRef.current)
        urlRef.current = null
      }
    }
  }, [packageId, asset.id, asset.path, asset.mime, asset.updatedAt])

  const name = assetFileName(asset.path)
  const audio = isAudioAsset(asset.path, asset.mime)
  const image = isImageAsset(asset.path, asset.mime)
  const current = draft ?? text ?? ''
  const dirty = draft !== null && draft !== text
  const syntaxError = dirty ? jsonErrorOf(current, json) : null
  draftRef.current = draft
  textRef.current = text
  savingRef.current = saving

  const save = async () => {
    if (!onSaveText || savingRef.current) return
    const next = draftRef.current
    const baseline = textRef.current
    if (next === null || next === baseline) return
    const err = jsonErrorOf(next, json)
    if (err) return
    setSaving(true)
    try {
      await onSaveText(next)
      // 保存成功后以草稿为准，避免 updatedAt 变化触发的重读把光标跳走
      setText(next)
      setDraft(null)
    } finally {
      setSaving(false)
    }
  }

  const handleMount: OnMount = (editor, monaco) => {
    editor.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => {
      void save()
    })
  }

  return (
    <div className="asset-preview">
      {error && <p className="asset-preview-error">{error}</p>}
      {!error && !url && <p className="asset-preview-loading">加载中…</p>}
      {url && audio && (
        <audio className="asset-preview-audio" controls src={url} />
      )}
      {url && image && (
        <img className="asset-preview-image" src={url} alt={name} />
      )}
      {url && syntaxError && (
        <p className="asset-preview-error">JSON 语法错误：{syntaxError}</p>
      )}
      {url && !audio && !image && editable && (
        <div className="asset-preview-editor">
          <Editor
            height="100%"
            language={editorLanguageForFile(asset.path)}
            theme={HANSHU_THEME_ID}
            beforeMount={registerHanshuLanguage}
            value={current}
            onChange={(next) => setDraft(next ?? '')}
            onMount={handleMount}
            options={{
              readOnly: false,
              minimap: { enabled: false },
              fontSize: 13,
              scrollBeyondLastLine: false,
              tabSize: 2,
              automaticLayout: true,
              wordWrap: 'on',
            }}
          />
        </div>
      )}
      {url && !audio && !image && !editable && texty && (
        <pre className="asset-preview-text">
          {json ? formatJsonText(text ?? '') : text ?? ''}
        </pre>
      )}
      {url && !audio && !image && !texty && (
        <p className="asset-preview-hint">
          已存入包内资产。此类型暂无预览，导出工程包时会原样带上。
        </p>
      )}
    </div>
  )
}
