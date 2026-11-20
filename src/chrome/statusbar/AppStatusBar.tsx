import type { Ref } from 'react'
import { ActivityPanel } from '../../activity'
import { setStatusBarHost } from './statusBarHosts'
import './AppStatusBar.css'

/** IDE 唯一底栏：左槽 | 右槽 | 固定活动铃铛 */
export function AppStatusBar({ ref }: { ref?: Ref<HTMLElement> }) {
  return (
    <footer ref={ref} className="app-statusbar" aria-label="状态栏">
      <div
        className="app-statusbar-left"
        ref={(el) => setStatusBarHost('left', el)}
      />
      <div className="app-statusbar-right">
        <div
          className="app-statusbar-right-slots"
          ref={(el) => setStatusBarHost('right', el)}
        />
        <ActivityPanel />
      </div>
    </footer>
  )
}
