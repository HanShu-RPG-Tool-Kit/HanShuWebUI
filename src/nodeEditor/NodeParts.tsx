import { portSide, portOffset } from './geometry'
import type { Port } from './types'
import type { CSSProperties, HTMLAttributes, ReactNode } from 'react'
import './NodeParts.css'

/** Visual primitives only: business state, form values and commits stay with the caller. */
export function NodeFrame({ selected, dragging, accent, className = '', style, ...props }: HTMLAttributes<HTMLDivElement> & { selected?: boolean; dragging?: boolean; accent?: string }) {
  return <div {...props} className={`node-frame${selected ? ' is-selected' : ''}${dragging ? ' is-dragging' : ''} ${className}`} style={{ '--node-selection': accent, ...style } as CSSProperties} />
}
export function NodeHeader({ icon, title, badge, color, className = '' }: { icon?: ReactNode; title: ReactNode; badge?: ReactNode; color?: string; className?: string }) {
  return <header className={`node-header ${className}`} style={{ background: color }}>{icon != null && <span className="node-header-icon" aria-hidden="true">{icon}</span>}<span className="node-header-title">{title}</span>{badge != null && <span className="node-header-badge">{badge}</span>}</header>
}
/** Shares the socket side and axis offset; does not infer visual side from input/output. */
export function PortLabel({ direction, side, x, y, color, children, className = '' }: Pick<Port, 'direction' | 'side' | 'x' | 'y' | 'color'> & { children: ReactNode; className?: string }) {
  const port = {direction,side,x,y}, resolved = portSide(port)
  return <span className={`node-port-label is-${direction} is-side-${resolved} ${className}`} style={{ ...(resolved === 'top' || resolved === 'bottom' ? {left:portOffset(port)} : {top:portOffset(port)}), color }}>{children}</span>
}
export function NodeField({ label, children, className = '' }: { label: ReactNode; children: ReactNode; className?: string }) {
  return <label className={`node-field nodrag nopan nowheel ${className}`}><span className="node-field-label">{label}</span><span className="node-field-control">{children}</span></label>
}
