import { createContext, type RefObject } from "react"

export const PanelDockBottomTarget = createContext<RefObject<HTMLElement | null> | null>(null)
