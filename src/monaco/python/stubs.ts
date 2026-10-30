export const PLAYER_CLASS = 'net.minecraft.server.level.ServerPlayer'

export type JavaStub = { name: string; module: string; symbol: string; source: string; dependencies: string[] }
export type StubResponse = { schemaVersion: 1; runtimeId: string; classes: JavaStub[]; missing: string[] }

export function javaModule(name: string) {
  return `jvm_${name.replaceAll('_', '__').replaceAll('.', '_d_').replaceAll('$', '_s_')}`
}

export function javaSymbol(name: string) { return name.split(/[.$]/).at(-1)! }

export const KIT_CONTEXT = `from typing import Any
from ${javaModule(PLAYER_CLASS)} import ServerPlayer

class KitHandle:
    @property
    def id(self) -> str: ...
    @property
    def tags(self) -> tuple[str, ...]: ...
    def param(self, name: str) -> Any: ...
    def mod(self, name: str, x: float) -> float: ...
    def expr(self, src: str) -> float: ...

kit: KitHandle
player: ServerPlayer
players: tuple[ServerPlayer, ...]
def random() -> float: ...
`

// Only the documented injection is available offline. No invented Minecraft API.
export const SHOP_CONTEXT = `from typing import Any
from ${javaModule(PLAYER_CLASS)} import ServerPlayer
class ShopEntryHandle:
    id: str
    tags: tuple[str, ...]
    quantity: int
    delta: int
    current: int
    initialCapacity: int
    maxCapacity: int
    def adjustDelta(self, amount: int) -> None: ...
class ShopHandle:
    id: str
    tags: tuple[str, ...]
    def param(self, name: str) -> Any: ...
    def mod(self, name: str, x: float) -> float: ...
    def expr(self, source: str) -> float: ...
    def condition(self, source: str) -> bool: ...
    def entry(self, id: str) -> ShopEntryHandle: ...
    def entries(self, tag: str | None = None) -> tuple[ShopEntryHandle, ...]: ...
shop: ShopHandle
player: ServerPlayer
`
export const BASE_STUBS:Record<string,string>={'__builtins__.pyi':'from builtins import *\n'}

/** Discover explicit Java imports; all semantic inference remains in Pyright. */
export function importedJavaClasses(source: string): string[] {
  const names = new Set<string>()
  for (const match of source.matchAll(/^\s*from\s+([A-Za-z_][\w.]*)\s+import[ \t]*(\([\s\S]*?\)|[^\r\n#]+)/gm)) {
    for (const item of match[2].replace(/#[^\r\n]*/g, '').replace(/[()]/g, '').split(',')) {
      const symbol = item.trim().split(/\s+as\s+/)[0]
      if (/^[A-Za-z_$][\w$]*$/.test(symbol)) names.add(`${match[1]}.${symbol}`)
    }
  }
  const javaNames = new Set(['java'])
  for (const match of source.matchAll(/^\s*import\s+([^\n#]+)/gm)) for (const item of match[1].split(',')) {
    const alias = /^\s*java\s+as\s+([A-Za-z_][\w]*)\s*$/.exec(item)
    if (alias) javaNames.add(alias[1])
  }
  const calls = new RegExp(`\\b(?:${[...javaNames].join('|')})\\.type\\(\\s*['"]([\\w.$]+)['"]\\s*\\)|\\bjava_type\\(\\s*['"]([\\w.$]+)['"]\\s*\\)`, 'g')
  for (const match of source.matchAll(calls)) names.add(match[1] ?? match[2])
  return [...names]
}

/** Flat per-class modules avoid cyclic imports. Package exports support GraalPy imports. */
export function buildJavaFiles(stubs: Iterable<JavaStub>, base:Record<string,string> = BASE_STUBS): { files: Record<string, string>; byUri: Map<string, string> } {
  const files: Record<string, string> = { ...base }
  const byUri = new Map<string, string>()
  const classes = [...stubs]
  const known = new Set(classes.map(stub => stub.name))
  for (const stub of classes) {
    for (const name of stub.dependencies) {
      if (!known.has(name)) files[`${javaModule(name)}.pyi`] = `class ${javaSymbol(name)}: ...\n`
      byUri.set(`file:///typings/${javaModule(name)}.pyi`, name)
    }
    files[`${stub.module}.pyi`] = stub.source
    byUri.set(`file:///typings/${stub.module}.pyi`, stub.name)
    const split = stub.name.lastIndexOf('.')
    const packagePath = stub.name.slice(0, split).replaceAll('.', '/')
    if (split < 0 || stub.name.includes('$')) continue
    const pieces = packagePath.split('/')
    for (let i = 1; i <= pieces.length; i++) files[`${pieces.slice(0, i).join('/')}/__init__.pyi`] ??= ''
    files[`${packagePath}/__init__.pyi`] += `from ${stub.module} import ${stub.symbol} as ${stub.symbol}\n`
  }
  if (classes.length) {
    const overloads = classes.map((stub, i) => `import ${stub.module} as _c${i}\n`).join('')
      + classes.map((stub, i) => `@overload\ndef type(name: Literal["${stub.name}"]) -> builtins.type[_c${i}.${stub.symbol}]: ...\n`).join('')
    files['java/__init__.pyi'] = (files['java/__init__.pyi'] ?? '')
      + `import builtins\nfrom typing import Any, Literal, overload\n${overloads}@overload\ndef type(name: str) -> Any: ...\n`
  }
  return { files, byUri }
}
