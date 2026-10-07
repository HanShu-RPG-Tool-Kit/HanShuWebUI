# 导出 PAK

> 状态：**已落地骨架**（编译注册表、分平面、整包加密）。域编译器（kit / nav / hflow 等）可继续往注册表挂。

PAK 是给引擎用的运行时包。流水线：**编译图 → 接线校验 → 按平面分包 → 可选加密**。

工程包（可继续编辑的源）不在本文范围，见 `src/export/projectPack.ts`。

## 1. 原则

- **编译一次，产物打标签**；打包只消费产物。
- **任意源类型可注册编译器**；未注册且位于 `src/` 的走 Identity（原样 + 默认平面）。
- **一次导出可产出多个 pak**：client / server / shared / combined。
- **`meta/` 不进 PAK**。

## 2. 代码入口

| 路径 | 职责 |
| --- | --- |
| `src/export/compile/` | 类型、注册表、接线、`buildCompileGraph` |
| `src/export/compile/compilers/` | 内置 Hanshu / Identity / LocaleAssets |
| `src/export/pack/exportPaks.ts` | 总入口 `exportPaks` |
| `src/export/pack/planes.ts` | 平面过滤 |
| `src/export/pack/encrypt.ts` | AES-256-GCM 整包加密 |
| `src/export/resourcePack.ts` | `buildResourcePackZip` = combined 兼容封装 |

菜单：

- **导出PAK** → combined 单文件（兼容旧行为）
- **导出PAK（分平面）** → client + server + shared，打成外层 zip；可提示口令加密 server

## 3. 注册编译器

```ts
import { registerFileCompiler } from '../export/compile'

registerFileCompiler({
  id: 'kit',
  match: (file) => file.name.endsWith('.kit'),
  async compile(file, ctx) {
    // …校验 / 变换…
    return [{
      path: `gift/${file.name}`,
      bytes: file.content,
      plane: 'server',
      packageName: ctx.index.package.name,
      sourcePath: file.name,
      provides: [{ kind: 'kitId', id: '…' }],
      requires: [{ kind: 'goalDef', id: '…' }],
    }]
  },
})
```

包级后处理（依赖其它产物的 `requires`，如按键裁剪 lang）用 `registerPackagePass`。

编辑器编译预览应调用与导出相同的 `compile`（`.hs` 已共用 `compileHsToHsc`）。

## 4. 平面

| 平面 | 含义 | 默认后缀（`FILE_PLANE`） |
| --- | --- | --- |
| `client` | 仅客户端 | `.hs` / `.char`；lang / voice 产物 |
| `server` | 仅服务端 | `.py`（`script/` 与 `goal/`）/ `.progress` / `.kit` |
| `shared` | 两端都要 | `.hflow` / `.nav`；未列出后缀默认 shared |

### 源目录与 PAK 顶层

工程 `src/<kind>/` 与 PAK 顶层 `<kind>/` 对齐：

| kind | 内容 |
| --- | --- |
| `script` | 普通脚本 `.py`（进度「脚本」分类根下） |
| `goal` | 目标定义 `.py`（「目标定义」二级分类；**不在** `script/` 下） |
| `hanshu` / `character` / `progress` / `story` / `navigator` / `gift` | 其它源类型 |

旧工程若仍有 `src/scripts/`，加载时按 `script` 认领，保存后迁到 `src/script/`。

导出目标：

- `client` pak = client ∪ shared
- `server` pak = server ∪ shared
- `shared` pak = 仅 shared
- `combined` = 三平面合一

**跨平面**：client↔server 直接依赖为 **error**（须升为 shared 契约）。

## 5. 接线

产物声明 `provides` / `requires`（如 `localeKey`、`hsInject`）。`LinkChecker`：

| 级别 | 典型 |
| --- | --- |
| error | 非本地化依赖缺失、重复 provide（含跨文件重复 `@` 注入点）、跨 plane、悬空 `.ref`（抛错中止） |
| warning | 未提供的 localeKey、未引用的非 locale / 非 `hsInject` 符号、`.hs` 单文件编译失败 |
| deprecation | 引用弃用符号 |

`.hs` 为每个 `@name` **provide** `hsInject`；选项 `:>>name` **require** 同名。未被子跳转引用的注入点仍可作引擎入口，不报 unused。

## 6. 路径编码（强制 UTF-8）

PAK 本体是 ZIP。内部条目路径：

- **字节**：UTF-8
- **标志**：每条 local / central 记录均置 Language encoding flag（general purpose **bit 11**）

导出后由 `forceZipUtf8PathFlags` 补全（JSZip 默认只对含非 ASCII 的路径打该标志）。引擎应按 UTF-8 解路径，勿按 CP437。

整包加密时，加密层包在已强制标志的 ZIP 之外。

## 7. 加密

- 格式：`HSPAK1` + salt + iv + AES-256-GCM ciphertext（口令经 PBKDF2-SHA256）
- 默认仅在「分平面」导出时可选加密 **server**
- 口令不进工程、不进仓库

## 8. 与工程包

| | PAK | 工程包 |
| --- | --- | --- |
| 目的 | 引擎运行 | 继续编辑 |
| 编译 | 编译图 | 无 |
| 裁剪 | 引用 / 平面 | 全量 |
| `.ref` | → `.ogg` | 原样 |
| `meta/` | 不进 | 带上 |
