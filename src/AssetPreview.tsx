import { useEffect, useRef, useState } from 'react'
import type { AssetFile } from './workspace'
import {
  assetFileName,
  formatBytes,
  isAudioAsset,
  isImageAsset,
} from './assets/paths'
import { getAssetBlob } from './assets/idb'

type AssetPreviewProps = {
  packageId: string
  asset: AssetFile
}

export function AssetPreview({ packageId, asset }: AssetPreviewProps) {
  const [url, setUrl] = useState<string | null>(null)
  const [error, setError] = useState<string | null>(null)
  const urlRef = useRef<string | null>(null)

  useEffect(() => {
    let cancelled = false
    setError(null)
    setUrl(null)

    void (async () => {
      try {
        const blob = await getAssetBlob(packageId, asset.path)
        if (cancelled) return
        if (!blob) {
          setError('找不到资产数据（可能已被清除）')
          return
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
  }, [packageId, asset.id, asset.path, asset.updatedAt])

  const name = assetFileName(asset.path)
  const audio = isAudioAsset(asset.path, asset.mime)
  const image = isImageAsset(asset.path, asset.mime)

  return (
    <div className="asset-preview">
      <header className="asset-preview-header">
        <h2>{name}</h2>
        <p className="asset-preview-meta">
          <code>{asset.path}</code>
          <span>{formatBytes(asset.size)}</span>
          <span>{asset.mime || 'unknown'}</span>
        </p>
      </header>

      <div className="asset-preview-body">
        {error && <p className="asset-preview-error">{error}</p>}
        {!error && !url && <p className="asset-preview-loading">加载中…</p>}
        {url && audio && (
          <audio className="asset-preview-audio" controls src={url} />
        )}
        {url && image && (
          <img className="asset-preview-image" src={url} alt={name} />
        )}
        {url && !audio && !image && (
          <p className="asset-preview-hint">
            已存入包内资产。此类型暂无预览，导出资源包时会一并打包。
          </p>
        )}
      </div>
    </div>
  )
}
