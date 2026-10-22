import { useEffect, useRef, useState } from 'react'
import { request } from '../collab/protocol'

/** Guest credentials stay in S; refresh restores this subject through an HttpOnly cookie. */
export function ProjectShareJoin({ onConnect, connected }: { onConnect: (base: string, token: string) => Promise<unknown>; connected: boolean }) {
  const [invitation] = useState(() => new URLSearchParams(window.location.hash.slice(1)).get('join'))
  const [visible, setVisible] = useState(Boolean(invitation))
  const [ready, setReady] = useState(false)
  const [name, setName] = useState('')
  const [error, setError] = useState('')
  const [busy, setBusy] = useState(false)
  const callback = useRef(onConnect); callback.current = onConnect
  const currentConnection = useRef(connected); currentConnection.current = connected
  const operation = useRef(false)
  useEffect(() => {
    let stopped = false
    let shared = false
    const connection = { url: window.location.origin, token: '' }
    void (async () => {
      try {
        const info = await request<{ service: string }>(connection, '/api/share/info')
        if (stopped || currentConnection.current || info?.service !== 'hanshu-project-share') return
        shared = true
        setReady(true)
        if (invitation) return
        setVisible(true); setBusy(true)
        const session = await request<{ token: string }>(connection, '/api/share/resume', 'POST')
        if (stopped || currentConnection.current) { void request({ ...connection, token: session.token }, '/api/sessions/current', 'DELETE').catch(() => undefined); return }
        await callback.current(connection.url, session.token)
        setVisible(false)
      } catch (e) { if (!stopped && (invitation || shared)) setError(e instanceof Error ? e.message : String(e)) }
      finally { if (!stopped) setBusy(false) }
    })()
    return () => { stopped = true }
    // Probe once per mounted browser session, independent of connection form updates.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
  if (!visible || connected) return null
  return <div className="project-connect-backdrop"><form className="project-connect-dialog" aria-label="加入共享工程" onSubmit={e => {
    e.preventDefault()
    if (!ready || !invitation || operation.current) return
    operation.current = true; setBusy(true); setError('')
    void (async () => {
      try {
        const base = window.location.origin
        const session = await request<{ token: string }>({ url: base, token: '' }, '/api/share/join', 'POST', { invitation, name: name.trim() })
        await callback.current(base, session.token)
        setVisible(false)
        const hash = new URLSearchParams(window.location.hash.slice(1)); hash.delete('join')
        window.history.replaceState(null, '', window.location.pathname + window.location.search + (hash.size ? `#${hash}` : ''))
      } catch (e) { setError(e instanceof Error ? e.message : String(e)) }
      finally { operation.current = false; setBusy(false) }
    })()
  }}><h2>加入共享工程</h2><p>{invitation ? '填一个显示名，让其他协作者知道你是谁。权限由分享者的邀请决定。' : '请使用分享者提供的邀请链接加入工程。'}</p>{invitation && <label>显示名<input aria-label="显示名" required maxLength={120} autoComplete="nickname" value={name} onChange={e => setName(e.target.value)} autoFocus /></label>}{error && <p role="alert">{error}</p>}<footer><button type="button" disabled={busy} onClick={() => setVisible(false)}>关闭</button>{invitation && <button type="submit" disabled={!ready || busy || !name.trim()}>{busy ? '正在加入…' : '加入工程'}</button>}</footer></form></div>
}
