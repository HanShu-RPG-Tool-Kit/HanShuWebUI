import {
  BoolGoalWidget,
  NumberGoalWidget,
  SelectGoalWidget,
  SliderGoalWidget,
  TextGoalWidget,
} from './builtins'
import { registerGoalWidgetEditor } from './registry'

registerGoalWidgetEditor({ id: 'text', order: 10, Editor: TextGoalWidget })
registerGoalWidgetEditor({ id: 'number', order: 20, Editor: NumberGoalWidget })
registerGoalWidgetEditor({ id: 'slider', order: 30, Editor: SliderGoalWidget })
registerGoalWidgetEditor({ id: 'select', order: 40, Editor: SelectGoalWidget })
registerGoalWidgetEditor({ id: 'bool', order: 50, Editor: BoolGoalWidget })
// suggest / tags：有 RPC 实现后再 register；当前 resolve 会回退 text
