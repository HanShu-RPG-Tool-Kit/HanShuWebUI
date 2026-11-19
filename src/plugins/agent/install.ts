/**
 * 内置插件安装：把插件工厂登记给 loader，并在工程文件通道就绪后激活。
 * 该文件属于插件本体；主体只通过 `src/app/plugins.ts` 的装配行引用它。
 */
import { activateBuiltinPlugins, registerBuiltinPlugin } from '../../app/pluginLoader'
import { getProjectHost } from '../../project/projectHost'
import { subscribeProjectSession } from '../../project/projectSession'
import { agentPlugin } from './index'

registerBuiltinPlugin(() => agentPlugin)

function activateWhenReady(): void {
  if (!getProjectHost()) return
  void activateBuiltinPlugins().catch((error) => {
    console.warn('[hanshu] Agent 插件激活失败', error)
  })
}

activateWhenReady()
subscribeProjectSession(activateWhenReady)
