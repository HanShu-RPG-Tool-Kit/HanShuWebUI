import { useEffect, useRef, useState, useSyncExternalStore } from 'react'
import { getMenuCheckRevision, subscribeMenuChecks } from '../ui/viewFlags'
import { mergeMenus } from './menu/mergeMenus'
import type { MenuContext, MenuCommand, MenuDef } from './menu/types'

export type MenuBarProps = {
  ctx: MenuContext
  onAction: (item: MenuCommand) => void
}

export function MenuBar({ ctx, onAction }: MenuBarProps) {
  const menuChecks = useSyncExternalStore(subscribeMenuChecks, getMenuCheckRevision, getMenuCheckRevision)
  const menus: MenuDef[] = mergeMenus(ctx.workspaceId)
  const [openMenu, setOpenMenu] = useState<string | null>(null)
  const menubarRef = useRef<HTMLElement>(null)

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape' && openMenu) {
        menubarRef.current?.querySelector<HTMLButtonElement>('.menu-item.open .menu-trigger')?.focus()
        setOpenMenu(null)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [openMenu])

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
    <nav className="menubar" ref={menubarRef} aria-label="主菜单" data-menu-checks={menuChecks}>
      {menus.map((menu) => (
        <div
          key={menu.id}
          className={`menu-item${openMenu === menu.id ? ' open' : ''}`}
        >
          <button
            type="button"
            className="menu-trigger"
            aria-haspopup="menu"
            aria-expanded={openMenu === menu.id}
            aria-controls={openMenu === menu.id ? `main-menu-${menu.id}` : undefined}
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
            <ul id={`main-menu-${menu.id}`} className="menu-dropdown" role="menu" aria-label={menu.label}>
              {menu.items.map((entry, index) =>
                entry.type === 'separator' ? (
                  <li key={`${menu.id}-sep-${index}`} className="sep" role="separator" />
                ) : (
                  <li key={entry.id} role="none">
                    <button
                      type="button"
                      role={entry.checked ? 'menuitemcheckbox' : 'menuitem'}
                      disabled={!(entry.enabled?.(ctx) ?? true)}
                      aria-checked={entry.checked ? entry.checked(ctx) : undefined}
                      className={entry.checked?.(ctx) ? 'checked' : ''}
                      onClick={() => {
                        setOpenMenu(null)
                        onAction(entry)
                      }}
                    >
                      <span className="menu-check" aria-hidden="true">
                        {entry.checked?.(ctx) && <svg viewBox="0 0 16 16" fill="none"><path d="m3 8 3 3 7-7" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" /></svg>}
                      </span>
                      <span>{entry.label}</span>
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
