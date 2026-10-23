import { useEffect, useRef, useState } from 'react'
import { mergeMenus } from './menu/mergeMenus'
import type { MenuContext, MenuCommand, MenuDef } from './menu/types'

export type MenuBarProps = {
  ctx: MenuContext
  onAction: (item: MenuCommand) => void
}

export function MenuBar({ ctx, onAction }: MenuBarProps) {
  const menus: MenuDef[] = mergeMenus(ctx.workspaceId)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const menubarRef = useRef<HTMLElement>(null)

  useEffect(() => {
    setOpenMenu(null)
  }, [ctx.workspaceId])

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      if (menubarRef.current && !menubarRef.current.contains(event.target as Node)) {
        setOpenMenu(null)
      }
    }
    document.addEventListener('pointerdown', onPointerDown)
    return () => document.removeEventListener('pointerdown', onPointerDown)
  }, [])

  return (
    <nav className="menubar" ref={menubarRef} aria-label="主菜单">
      {menus.map((menu) => (
        <div
          key={menu.id}
          className={`menu-item${openMenu === menu.id ? ' open' : ''}`}
        >
          <button
            type="button"
            className="menu-trigger"
            onClick={() =>
              setOpenMenu((current) => (current === menu.id ? null : menu.id))
            }
            onMouseEnter={() => {
              if (openMenu) setOpenMenu(menu.id)
            }}
          >
            {menu.label}
          </button>
          {openMenu === menu.id && (
            <ul className="menu-dropdown" role="menu">
              {menu.items.map((entry, index) =>
                entry.type === 'separator' ? (
                  <li key={`${menu.id}-sep-${index}`} className="sep" />
                ) : (
                  <li key={entry.id} role="none">
                    <button
                      type="button"
                      role="menuitem"
                      disabled={!(entry.enabled?.(ctx) ?? true)}
                      aria-checked={entry.checked?.(ctx) ? true : undefined}
                      className={entry.checked?.(ctx) ? 'checked' : ''}
                      onClick={() => {
                        setOpenMenu(null)
                        onAction(entry)
                      }}
                    >
                      {entry.label}
                    </button>
                  </li>
                ),
              )}
            </ul>
          )}
        </div>
      ))}
    </nav>
  )
}
