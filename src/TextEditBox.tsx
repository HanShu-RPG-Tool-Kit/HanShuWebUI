import {
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
  type CSSProperties,
  type KeyboardEvent as ReactKeyboardEvent,
} from 'react'
import type {
  TextEditCommitReason,
  TextEditExitDirection,
  TextEditFont,
  TextEditInputState,
  TextEditMode,
  TextEditSpot,
  TextRect,
} from './monaco/textEditor'
import { normalizeLocaleKey } from './i18n/textMap'
import { lineIndexOfOffset } from './monaco/textKeyRules'

type Props = {
  mode: TextEditMode
  initial: string
  rect: TextRect
  /** 初始插入位置（位置驱动 / 点击进框时由编辑器算好：点哪插哪） */
  caretIndex?: number
  /** 与框逐像素对齐用的字体（照抄框的 computed style） */
  font?: TextEditFont
  /** 空值的占位文本：框里显示的是键名，编辑框照抄，免得空着看不懂 */
  placeholder?: string
  /**
   * 订阅编辑器推来的实时位置（滚轮 / 布局变化后框会挪，编辑框得跟着）。
   * 位置刻意存在**组件自己的 state** 里而不是上层：滚动时每帧都在变，
   * 让整个工作区跟着重渲染太亏，这里只重渲染这个输入框。
   */
  subscribeSpot?: (onSpot: (spot: TextEditSpot) => void) => () => void
  /**
   * 点在**另一个键框**上时问一句（返回回调，不是则 null）：
   * 提交这一份之后调它，编辑器就把编辑目标排进切换队列、等这一按抬起来切过去
   * （不用再点第二次）。见 textEditor.grabBoxAt。
   */
  grabBoxAt?: (clientX: number, clientY: number) => (() => void) | null
  onCommit: (value: string, reason: TextEditCommitReason) => void
  onCancel: () => void
  /**
   * 每次草稿变化时上报**原始**文本（未归一化）：编辑器据此实时重算黄底框与
   * 正文里键名槽位的宽度，打字过程中框就跟着变宽变窄（见 TextEditRequest.onDraftChange）。
   * 上报原始草稿而不是归一化后的值 —— 归一化会在打字中途补全 / 截断，
   * 拿它量宽度会让框宽忽大忽小。
   */
  onDraftChange?: (text: string) => void
  /** 出框：返回是否真的出框了（外面没地方去 = false，编辑框留着别关） */
  onExit: (
    direction: TextEditExitDirection,
    input: TextEditInputState,
  ) => boolean
}

/**
 * 覆盖在黄底框上的可编辑文本框 —— **与框等大、都贴着文字**。
 *
 * 尺寸不另算：宽高直接吃编辑器量出来的框矩形（见 textEditor.rectForSpan），
 * 字体照抄框的 computed style，行高按编辑器行高给，因此框里那行字和输入框里的字
 * 逐像素重合；边框用 inset 阴影画（不占布局），焦点环不会把文字挤偏。
 *
 * 光标是**连续**的：方向键在边缘继续向外挪 = 出框（onExit，由编辑器预判 Monaco 落点），
 * 多行值的内部翻行仍归输入框自己。
 * - 改键名：单行，回车 / 点外部提交（非法键名不提交，标红），Esc 取消
 * - 改映射值：多行，回车 / 点外部提交，Shift+回车换行，Esc 取消
 */
export function TextEditBox({
  mode,
  initial,
  rect,
  caretIndex,
  font,
  placeholder,
  subscribeSpot,
  grabBoxAt,
  onCommit,
  onCancel,
  onDraftChange,
  onExit,
}: Props) {
  const [draft, setDraft] = useState(initial)
  const [invalid, setInvalid] = useState(false)
  /**
   * 编辑器推来的实时位置与尺寸（null = 还用打开那一刻的矩形）。
   * `visible: false` = 框滚出可视区了：编辑框隐身但**不卸载**，否则会丢输入焦点。
   * 宽高也在里面：打字时编辑器每帧重算一次推过来，框就跟着草稿变宽变高（见下）。
   */
  const [spot, setSpot] = useState<TextEditSpot | null>(null)
  const rootRef = useRef<HTMLDivElement | null>(null)
  const inputRef = useRef<HTMLInputElement | HTMLTextAreaElement | null>(null)
  const doneRef = useRef(false)

  const lineHeight = font?.lineHeightPx ?? 28
  /**
   * 可见行数由**实时草稿**推导（原来是按 initial 算一次就定死）：
   * Shift+Enter 加一行，输入框和它外面的框要一起长高 —— 按 initial 算的话
   * 多出来的那一行会被 frame 的 overflow: hidden 裁掉，用户看不见自己刚加的行。
   */
  const lines = Math.max(1, draft.split('\n').length)
  /**
   * 尺寸优先用编辑器推来的**实时**值：它是由同一把 meter 量出来的显示文本宽度，
   * 与正文里的槽位、背后的黄底框同源。打开那一刻的 `rect` 只当兜底
   * （订阅还没推来第一帧时用，比如编辑器量不出几何的无头环境）。
   */
  const width = spot?.width ?? rect.width
  const height = spot?.height ?? rect.height

  // 挂载即聚焦：插入位置由编辑器预判（点击 = 点哪插哪；方向键 = 框内比例）。
  // 依赖刻意留空 —— 之后光标归用户；编辑框每次打开都是新的 key，重挂载才重新摆
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.focus()
    if (caretIndex != null) {
      const index = Math.max(0, Math.min(caretIndex, el.value.length))
      el.setSelectionRange(index, index)
      return
    }
    if (mode === 'key') {
      el.select()
      return
    }
    const end = el.value.length
    el.setSelectionRange(end, end)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  // 跟着框走：编辑器在滚动 / 布局变化后推来新位置（订阅时会立刻补一次当前值）。
  // 依赖只有 subscribeSpot 本身 —— 它在打开的请求里造好、身份不变，所以只订阅一次。
  useEffect(() => {
    if (!subscribeSpot) return
    return subscribeSpot(setSpot)
  }, [subscribeSpot])

  /** 提交；返回**这一下是不是真提交了**（键名非法时只标红、留在框里，返回 false） */
  const commit = (reason: TextEditCommitReason): boolean => {
    if (doneRef.current) return false
    const next = mode === 'key' ? normalizeLocaleKey(draft) : draft
    if (mode === 'key' && !next) {
      // 键名必须是 8 位十六进制：不提交，标红提示
      setInvalid(true)
      inputRef.current?.focus()
      return false
    }
    doneRef.current = true
    onCommit(next, reason)
    return true
  }

  const commitRef = useRef(commit)
  const cancelRef = useRef(onCancel)
  const exitRef = useRef(onExit)
  const grabBoxRef = useRef(grabBoxAt)
  useEffect(() => {
    commitRef.current = commit
    cancelRef.current = onCancel
    exitRef.current = onExit
    grabBoxRef.current = grabBoxAt
  })

  useEffect(() => {
    const onPointerDown = (event: PointerEvent) => {
      const root = rootRef.current
      if (root && root.contains(event.target as Node)) return
      /**
       * 点在**另一个键框**上 = 切换编辑目标：提交这一份，然后把编辑目标交给那个框
       * （不用点第二次 —— 不然只会脱出当前编辑）。
       *
       * 句柄必须在提交**之前**拿：提交会让正文重排、框挪位，之后再按坐标找就可能开到别的框。
       * 拿到句柄也不当场开框：编辑器只把它排进队列，等这一按抬起来再开 ——
       * 按下就开的话，紧接着的 mousedown 会把焦点从刚聚焦的输入框抢走，新框里就没光标了。
       * 配音按钮 / 空白 / 正在编辑的这个框拿不到句柄，照旧只当"点了外面"。
       */
      const handoff = grabBoxRef.current?.(event.clientX, event.clientY) ?? null
      // 键名非法时 commit 会拒绝提交、把框留着标红：这时不能把编辑目标切走
      if (commitRef.current('outside')) handoff?.()
    }
    document.addEventListener('pointerdown', onPointerDown, true)
    return () => document.removeEventListener('pointerdown', onPointerDown, true)
  }, [])

  const handleChange = (
    event: ChangeEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    const next = event.target.value
    setDraft(next)
    if (invalid) setInvalid(false)
    // 上报原始草稿：编辑器据此实时改框宽高与正文槽位（不等提交）
    onDraftChange?.(next)
  }

  /**
   * 方向键挪到编辑框边缘后**再向外一步** = 出框：
   * 左右在首 / 末字符处，上下在首行 / 末行（多行值的中间行照常由输入框翻行）。
   * 有选区、按了 Shift / Ctrl / Alt 时一般不出框：那些是选择与词跳，属于输入框自己的事。
   * 例外是**单行框（改键名）里的上下键**：打开时整段键名是选中的，而单行输入框里
   * 上下键本来就没有任何框内行为（浏览器置若罔闻，选区一直不散），
   * 照"必须有选区就退出"就会永远卡在框里 —— 所以这种一按就出框。
   */
  const maybeExit = (
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ): boolean => {
    const el = inputRef.current
    if (!el) return false
    // 输入法组字中（中日韩）：方向键在选候选词，这一按是输入法的，别抢
    if (event.nativeEvent.isComposing) return false
    if (event.shiftKey || event.ctrlKey || event.metaKey || event.altKey) {
      return false
    }
    const caret = el.selectionStart ?? 0
    const collapsed = caret === (el.selectionEnd ?? 0)
    const vertical = event.key === 'ArrowUp' || event.key === 'ArrowDown'
    if (!collapsed && !(mode === 'key' && vertical)) return false
    const text = el.value
    const direction: TextEditExitDirection | null =
      event.key === 'ArrowLeft' && caret === 0
        ? 'left'
        : event.key === 'ArrowRight' && caret === text.length
          ? 'right'
          : event.key === 'ArrowUp' && lineIndexOfOffset(text, caret) === 0
            ? 'up'
            : event.key === 'ArrowDown' &&
                lineIndexOfOffset(text, caret) === lineIndexOfOffset(text, text.length)
              ? 'down'
              : null
    if (!direction) return false
    event.preventDefault()
    if (doneRef.current) return true
    /**
     * 出框 = **提交**（与回车 / 点外部同一个语义）：先把非法键名拦在这里。
     *
     * 编辑器那边的出框会写草稿，但"写失败"它只能返回"没出去"——那时用户看到的是
     * "按了方向键没反应"，不知道是键名错了。所以校验放在这里：就地标红、留在框里，
     * 与回车提交被拒绝时的反馈一模一样（见 commit）。
     * 判据与 commit 同源（同一个 normalizeLocaleKey），不会出现两处口径不一致。
     */
    if (mode === 'key' && draft !== initial && !normalizeLocaleKey(draft)) {
      setInvalid(true)
      return true
    }
    // 出不去（框贴文档头 / 尾、已在首行末行）时编辑框留着，这一按当无事发生
    doneRef.current = exitRef.current(direction, {
      text,
      caretIndex: caret,
      scrollLeft: el.scrollLeft,
    })
    return true
  }

  const handleKeyDown = (
    event: ReactKeyboardEvent<HTMLInputElement | HTMLTextAreaElement>,
  ) => {
    if (event.key === 'Escape') {
      event.preventDefault()
      event.stopPropagation()
      if (doneRef.current) return
      doneRef.current = true
      cancelRef.current()
      return
    }
    if (event.key === 'Enter' && !event.shiftKey) {
      event.preventDefault()
      commitRef.current('enter')
      return
    }
    maybeExit(event)
  }

  /** 字体照抄框：字距 / 连字设置都会影响文字落点，一个都不能漏。
   *  宽高就是编辑器量出来的实时矩形 —— 不多一分（多留内边距 / 边框都会把文字挤偏）。 */
  const frameStyle = useMemo<CSSProperties>(() => {
    const style: CSSProperties = { width, height }
    if (!font) return style
    style.fontFamily = font.family
    style.fontSize = font.size
    style.fontWeight = font.weight
    style.letterSpacing = font.letterSpacing
    style.fontFeatureSettings = font.featureSettings
    style.fontVariationSettings = font.variationSettings
    style.lineHeight = `${font.lineHeightPx}px`
    return style
  }, [font, width, height])

  const inputStyle: CSSProperties = {
    height:
      mode === 'key' ? `${lineHeight}px` : `${lines * lineHeight}px`,
  }

  const className = `hs-lang-edit-input${invalid ? ' invalid' : ''}`
  const left = spot?.left ?? rect.left
  const top = spot?.top ?? rect.top
  const hidden = spot != null && !spot.visible
  /**
   * 编辑器可视区之外的裁切。编辑框是 `position: fixed`，不受编辑器自己的 overflow 约束 ——
   * 框滚到上下边缘时半截身体盖在工具栏 / 底栏上，所以按编辑器的矩形裁一下。
   * 用**实时**宽高算内缩：打字把框变宽变高之后，裁切范围也要跟着走，
   * 否则框长高了、下半截却仍然被按旧高度裁掉。
   */
  const clipPath = useMemo(() => {
    const clip = spot?.clip
    if (!clip || !spot) return undefined
    const insetTop = Math.max(0, clip.top - spot.top)
    const insetLeft = Math.max(0, clip.left - spot.left)
    const insetRight = Math.max(0, spot.left + width - (clip.left + clip.width))
    const insetBottom = Math.max(
      0,
      spot.top + height - (clip.top + clip.height),
    )
    if (insetTop === 0 && insetLeft === 0 && insetRight === 0 && insetBottom === 0) {
      return undefined
    }
    return `inset(${insetTop}px ${insetRight}px ${insetBottom}px ${insetLeft}px)`
  }, [spot, width, height])

  return (
    <div
      className="hs-lang-edit"
      ref={rootRef}
      style={{
        left,
        top,
        // 框滚出可视区：隐身但留在 DOM 里（卸载会丢焦点，滚回来还得重新点一次）
        visibility: hidden ? 'hidden' : undefined,
        clipPath,
      }}
      title={
        mode === 'key'
          ? '修改键名（8 位十六进制）：回车 / 点击外部提交，方向键挪到边缘可退出，Esc 取消'
          : '修改本地化文本：回车 / 点击外部提交，Shift+回车换行，方向键挪到边缘可退出，Esc 取消'
      }
    >
      {/* 尺寸即覆盖框尺寸：内层裁掉框底那几像素缝隙，让文字与框内文字逐像素重合 */}
      <div
        className={`hs-lang-edit-frame${invalid ? ' invalid' : ''}`}
        style={frameStyle}
      >
        {mode === 'key' ? (
          <input
            className={className}
            style={inputStyle}
            ref={(node) => {
              inputRef.current = node
            }}
            value={draft}
            placeholder={placeholder}
            spellCheck={false}
            autoComplete="off"
            onChange={handleChange}
            onKeyDown={handleKeyDown}
          />
        ) : (
          <textarea
            className={className}
            style={inputStyle}
            ref={(node) => {
              inputRef.current = node
            }}
            value={draft}
            placeholder={placeholder}
            wrap="off"
            spellCheck={false}
            autoComplete="off"
            onChange={handleChange}
            onKeyDown={handleKeyDown}
          />
        )}
      </div>
      {invalid && <div className="hs-lang-edit-hint">键名须为 8 位十六进制</div>}
    </div>
  )
}