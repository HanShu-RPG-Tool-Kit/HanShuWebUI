/** Intro-only paint loop, adapted from brand kit HanShu-motion.html. */

/** Hold then hand off to credits/lift — synced to SFX reverb at 4.2s. */
export const INTRO_DURATION = 4.2
/** Fully-formed pose used when reduced motion is preferred. */
export const INTRO_REST_TIME = 3.2

type PixelState = {
  el: SVGElement
  x: number
  y: number
  diagonal: number
  jitter: number
  color: string
}

function clamp(v: number, a = 0, b = 1): number {
  return Math.min(b, Math.max(a, v))
}

function ease(t: number): number {
  t = clamp(t)
  return 1 - (1 - t) ** 3
}

function smooth(t: number): number {
  t = clamp(t)
  return t * t * (3 - 2 * t)
}

function phase(t: number, start: number, length: number): number {
  return clamp((t - start) / length)
}

function qs<T extends Element>(root: ParentNode, sel: string): T {
  const el = root.querySelector(sel)
  if (!el) throw new Error(`Hanshu motion missing: ${sel}`)
  return el as T
}

export type HanshuIntroHandle = {
  stop: () => void
}

export function startHanshuIntro(
  root: SVGSVGElement,
  options: {
    reducedMotion?: boolean
    onComplete: () => void
  },
): HanshuIntroHandle {
  const underlay = qs<SVGElement>(root, '#pixel-underlay')
  const shovel = qs<SVGGElement>(root, '#shovel-motion')
  const subtitle = qs<SVGGElement>(root, '#subtitle-layout')
  const accent = qs<SVGPathElement>(root, '#accent')
  const letters = [...root.querySelectorAll<SVGGElement>('.letter-motion')]
  const pixels: PixelState[] = [
    ...root.querySelectorAll<SVGElement>('.pixel'),
  ].map((el) => {
    const x = Number(el.dataset.x)
    const y = Number(el.dataset.y)
    return {
      el,
      x,
      y,
      diagonal: (x + 256 - y) / 512,
      jitter: (((x / 16) * 7 + (y / 16) * 11) % 9) / 9,
      color: el.dataset.color ?? el.getAttribute('fill') ?? '#FF7C35',
    }
  })

  // Splash always uses the landscape brand composition.
  root.setAttribute('viewBox', '-15 -25 460 170')
  qs<SVGSVGElement>(root, '#icon-layout').setAttribute('x', '0')
  qs<SVGSVGElement>(root, '#icon-layout').setAttribute('y', '0')
  qs<SVGGElement>(root, '#wordmark-layout').setAttribute(
    'transform',
    'translate(142 27) skewX(-5)',
  )
  subtitle.setAttribute('transform', 'translate(174 100)')
  accent.setAttribute('d', 'M136 96H158')

  const paint = (t: number) => {
    underlay.style.opacity = String(smooth(phase(t, 1.65, 0.25)))

    for (const p of pixels) {
      const start = 0.12 + p.diagonal * 0.95 + p.jitter * 0.13
      const k = ease(phase(t, start, 0.56))
      const alpha = smooth(phase(t, start, 0.22))
      const scale = 0.4 + 0.6 * k
      const dx = (p.x - 120) * 0.18 * (1 - k)
      const dy = 22 * (1 - k)
      p.el.style.opacity = alpha.toFixed(3)
      p.el.style.transform = `translate(${dx.toFixed(2)}px, ${dy.toFixed(2)}px) scale(${scale.toFixed(3)})`
      p.el.setAttribute('fill', p.color)
    }

    {
      const k = ease(phase(t, 1.05, 0.55))
      shovel.style.opacity = smooth(phase(t, 1.05, 0.35)).toFixed(3)
      shovel.setAttribute('transform', `translate(0 ${(8 * (1 - k)).toFixed(2)})`)
    }

    letters.forEach((el, i) => {
      const k = ease(phase(t, 1.47 + i * 0.095, 0.48))
      el.style.opacity = smooth(phase(t, 1.47 + i * 0.095, 0.24)).toFixed(3)
      el.setAttribute('transform', `translate(0 ${(9 * (1 - k)).toFixed(2)})`)
    })

    const sub = smooth(phase(t, 2.08, 0.48))
    subtitle.style.opacity = (sub * 0.66).toFixed(3)
    accent.style.opacity = sub.toFixed(3)
    accent.setAttribute('stroke-dashoffset', String(22 * (1 - sub)))
  }

  let frame = 0
  let last: number | null = null
  let time = options.reducedMotion ? INTRO_REST_TIME : 0
  let stopped = false

  const stop = () => {
    stopped = true
    if (frame) cancelAnimationFrame(frame)
    frame = 0
    last = null
  }

  paint(time)

  if (options.reducedMotion) {
    const idle = window.setTimeout(() => {
      if (!stopped) options.onComplete()
    }, 900)
    return {
      stop: () => {
        stop()
        window.clearTimeout(idle)
      },
    }
  }

  const tick = (now: number) => {
    if (stopped) return
    if (last !== null) time += Math.min((now - last) / 1000, 0.12)
    last = now
    if (time >= INTRO_DURATION) {
      time = INTRO_DURATION
      paint(time)
      if (!stopped) options.onComplete()
      return
    }
    paint(time)
    frame = requestAnimationFrame(tick)
  }

  frame = requestAnimationFrame(tick)
  return { stop }
}
