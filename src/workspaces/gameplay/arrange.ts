import { layoutCanvas,moveCanvasNodes,nodeMetrics } from './canvas'
import type { ProgressFlow } from './model'
import { arrangeNodes } from '../../nodeEditor/arrange'
export function smartArrangeCanvas(flow:ProgressFlow,ids:string[]):ProgressFlow {
  const layout=layoutCanvas(flow)
  const positions=arrangeNodes(layout.ids.map(id=>({id,position:layout.positions.get(id)!,...nodeMetrics(flow,id)})),ids)
  return Object.keys(positions).length?moveCanvasNodes(flow,positions):flow
}
