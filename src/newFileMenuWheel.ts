/**
 * 下拉菜单上的一次滚轮：该不该**拦下**（`preventDefault`）。
 *
 * 为什么单独抽成一个纯函数：这段判据全是边界算术（能不能滚、在不在顶/底、
 * `deltaY` 的正负），而它错一格的后果是"滚轮滚不动"或"滚轮穿透去滚背后的资源树
 * → 菜单被关掉"—— 两种都是用户直接看得见的坏。抽出来之后 verify-new-file-types
 * 可以对它做穷举（成百上千组尺寸/位置/方向的组合），不用起浏览器也不用模拟 DOM。
 * 与 `textLiveGeometry` / `textSlotStyles` 的计量逻辑同一套路。
 *
 * 背景（为什么需要拦）：新建文件类型菜单是 `position: fixed`，不跟锚点走。
 * 一旦滚轮穿透去滚了背后的资源树，资源树那条**捕获阶段**的 scroll 监听就会把菜单关掉。
 * 所以只要菜单自己吃不下这一下，就必须拦，不能让事件落到树上。
 *
 * 判据：菜单自己**还能**沿 `deltaY` 方向滚 → 不拦（交给浏览器原生滚，手感最好）；
 * 否则（不可滚 / 已经在该方向的尽头）→ 拦。
 */
export type MenuWheelMetrics = {
  /** 菜单当前的滚动位置 */
  scrollTop: number
  /** 菜单可视高度 */
  clientHeight: number
  /** 菜单内容总高 */
  scrollHeight: number
  /** 本次滚轮的方向与幅度（只用到符号） */
  deltaY: number
}

export function shouldHoldWheel({
  scrollTop,
  clientHeight,
  scrollHeight,
  deltaY,
}: MenuWheelMetrics): boolean {
  /*
   * 容差 1px：`scrollHeight` / `clientHeight` 是**取整**过的（缩放不是 100% 时尤其明显），
   * 直接用 `<` 会把"其实还差不到 1px 就能滚"的菜单判成不可滚 —— 于是这一下被拦掉，
   * 表现为"再滚一点点就到底了，但最后一点滚不动"。
   *
   * `clientHeight > 0` 那半条是穷举测出来的：还没量到尺寸的元素 `clientHeight` 是 0、
   * 而 `scrollHeight` 已经非 0，只按上面那条会把它判成"可滚"→ 不拦 → 滚轮穿透去滚资源树
   * → 菜单被关掉。可视高度为 0 时本来就没什么可滚的，拦下最安全。
   */
  const scrollable = clientHeight > 0 && scrollHeight > clientHeight + 1
  if (!scrollable) return true
  const atTop = scrollTop <= 0
  const atBottom = scrollTop + clientHeight >= scrollHeight - 1
  if (deltaY < 0) return atTop
  if (deltaY > 0) return atBottom
  // deltaY === 0：纵向不会滚，也就没有"穿透去滚树"这回事（横向不归这里管）
  return false
}