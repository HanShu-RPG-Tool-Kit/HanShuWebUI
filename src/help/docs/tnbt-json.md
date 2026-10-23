# Typed NBT JSON（TNBT JSON）

HanShu 定义的带类型 NBT JSON 值表示，当前规范 v1；不是 Minecraft 官方 JSON 格式。`.item` v2、`.itemstack` v3、礼包内嵌物品和编译后的 `.it` 共用这一组件表示。文件 schemaVersion 标识整体结构，不是 Minecraft 版本。

每个值严格是 `{ "type": "类型", "value": 值 }`，不允许其他字段：

| type | value |
| --- | --- |
| byte | JSON 整数，-128..127 |
| short | JSON 整数，-32768..32767 |
| int | JSON 整数，-2147483648..2147483647 |
| long | 有符号 64 位十进制整数字符串 |
| float | 数值字符串，按 IEEE f32 舍入 |
| double | 数值字符串，按 IEEE f64 舍入 |
| string | 字符串，可为空 |
| compound | 键到 TNBT 值的对象；允许空键和 `__proto__` 等普通键 |
| list | TNBT 值数组；目标 MC 26.1.2 允许不同类型元素 |
| byte_array | byte 范围的 JSON 整数数组 |
| int_array | int 范围的 JSON 整数数组 |
| long_array | long 范围的十进制字符串数组 |

浮点支持 `NaN`、`Infinity`、`-Infinity`、`-0`。有限数值使用十进制或指数语法；有限文本溢出时拒绝，不能悄悄转换为 Infinity。保存规范化数值，不保证原数字拼写、compound 键顺序或 NaN payload 位模式。Long 全程禁止经 JS Number 中转。容器嵌套最多 32 层；输入 JSON 最大 16 MiB、200000 个值，包装层另有 96 层上限。

```json
{
  "minecraft:custom_data": {
    "type": "compound",
    "value": {
      "": { "type": "string", "value": "空键" },
      "flag": { "type": "byte", "value": 1 },
      "serial": { "type": "long", "value": "9223372036854775807" },
      "samples": { "type": "long_array", "value": ["1", "9223372036854775807"] }
    }
  }
}
```

组件 ID 必须完整带命名空间，例如 `minecraft:damage`。集合缺失键表示组件不存在，不表示继承；删除条目即删除组件。TNBT 没有 null 或 boolean 标签；空字符串、空容器与不存在是不同的值。拒绝重复 JSON 键。

TNBT 是持久化权威，树和卡片都修改同一值。SNBT 可作为未来的文本编辑视图，但当前不提供独立 SNBT 编辑器；不能强行把 SNBT 无法表示的节点转换成字符串。仅承诺 NBT 值的表达能力，不表示任意 TNBT 都符合某个组件的 Codec。

WebUI 做结构、数值范围与类型检查；Mod 的交换层使用 registry-aware NBT ops、组件 Codec 和物品严格校验，并在 NBT passthrough 中保留 -0。未知组件留在源文件，生成失败时明确报错；不采用 partial Codec 结果。游戏解析结果不反写覆盖源文档。

快照指纹包含 NBT 类型、值、列表顺序；排序对象键，不包含数量。显示用的普通 JSON 投影禁止用于保存或游戏转换。更换游戏、模组或数据包环境后应主动刷新快照，当前缓存没有自动检测游戏环境变化。

开发入口：`tnbtJson.ts` 定义值与校验；`NbtComponentsEditor.tsx` 是共享类型树；`itemComponents/registry.ts` 的扩展卡片必须收发 NbtValue。没有旧版普通 JSON 到 TNBT 的自动迁移，旧文件需从新版 Mod 重新导出。
