import { useCallback, useEffect, useRef, useState } from 'react'
import artSvg from './brand/hanshu-motion-art.svg?raw'
import circuitSvg from './brand/splash-circuit.svg?raw'
import splashSfxUrl from './brand/hanshu-splash.ogg'
import {
  startHanshuIntro,
  type HanshuIntroHandle,
} from './brand/hanshuIntroMotion.ts'
import { markSplashShown } from './splashSession.ts'
import './SplashOverlay.css'

const CREDITS_HOLD_MS = 5200

const CREDITS = [
  'Hueihuea',
  'SaltfishSheep',
  'MayIHaveK',
  'Muzermat',
  'Vallovely',
  'Sweda',
] as const

/** Brand pixel palette, light → dark (same steps as the icon). */
const PIXEL_COLORS = [
  '#FFB247',
  '#FFA13E',
  '#FF9039',
  '#FF7C35',
  '#F56936',
  '#E95538',
  '#D7463E',
  '#C63B47',
] as const

const PIXEL_COLS = 40
const PIXEL_ROWS = 7

type SplashPixel = {
  id: string
  col: number
  row: number
  color: string
  delayMs: number
}

function buildPixels(): SplashPixel[] {
  const out: SplashPixel[] = []
  for (let row = 0; row < PIXEL_ROWS; row++) {
    for (let col = 0; col < PIXEL_COLS; col++) {
      const wave = col / (PIXEL_COLS - 1)
      const depth = row / (PIXEL_ROWS - 1)
      const jitter = ((col * 7 + row * 11) % 9) / 9
      const tone = Math.min(
        PIXEL_COLORS.length - 1,
        Math.floor((wave * 0.55 + depth * 0.45 + jitter * 0.12) * PIXEL_COLORS.length),
      )
      out.push({
        id: `${col}-${row}`,
        col,
        row,
        color: PIXEL_COLORS[tone]!,
        // Left → right gather, slight row lag like the icon diagonal.
        delayMs: Math.round(col * 18 + row * 10 + jitter * 40),
      })
    }
  }
  return out
}

const SPLASH_PIXELS = buildPixels()

function prefersReducedMotion(): boolean {
  return (
    typeof window !== 'undefined' &&
    window.matchMedia('(prefers-reduced-motion: reduce)').matches
  )
}

/** Brand-kit light theme: dark HAN, warmer SHU, for the cream canvas. */
function applyLightWordmark(svg: SVGSVGElement) {
  const faces = svg.querySelectorAll<SVGElement>('.letter-face')
  faces.forEach((el, index) => {
    el.setAttribute('fill', index < 3 ? '#24262D' : '#E85829')
  })
  svg.querySelector('#subtitle-layout')?.setAttribute('fill', '#24262D')
  svg.querySelector('#accent')?.setAttribute('stroke', '#E85829')
}

type SplashOverlayProps = {
  onDone: () => void
  /** Debug/preview replay: do not persist “already shown” for this session. */
  preview?: boolean
  /** Desktop shell: fill the splash-sized window (no dimmed backdrop). */
  windowed?: boolean
}

export function SplashOverlay({
  onDone,
  preview = false,
  windowed = false,
}: SplashOverlayProps) {
  const [phase, setPhase] = useState<'play' | 'credits' | 'out'>('play')
  const hostRef = useRef<HTMLDivElement>(null)
  const motionRef = useRef<HanshuIntroHandle | null>(null)
  const audioRef = useRef<HTMLAudioElement | null>(null)
  const finished = useRef(false)
  const onDoneRef = useRef(onDone)
  const creditsTimer = useRef(0)

  useEffect(() => {
    onDoneRef.current = onDone
  }, [onDone])

  const stopAudio = useCallback(() => {
    const audio = audioRef.current
    if (!audio) return
    audio.pause()
    audio.currentTime = 0
    audioRef.current = null
  }, [])

  const finish = useCallback(() => {
    if (finished.current) return
    finished.current = true
    motionRef.current?.stop()
    stopAudio()
    if (creditsTimer.current) window.clearTimeout(creditsTimer.current)
    if (!preview) markSplashShown()
    // Desktop windowed splash: hide immediately — fading would flash the
    // gray .app background and look like the dialog morphing into main.
    if (windowed) {
      onDoneRef.current()
      return
    }
    setPhase('out')
    window.setTimeout(() => onDoneRef.current(), 280)
  }, [preview, stopAudio, windowed])

  const showCredits = useCallback(() => {
    if (finished.current) return
    motionRef.current?.stop()
    setPhase('credits')
    if (creditsTimer.current) window.clearTimeout(creditsTimer.current)
    creditsTimer.current = window.setTimeout(finish, CREDITS_HOLD_MS)
  }, [finish])

  useEffect(() => {
    if (!windowed) return
    document.documentElement.classList.add('splash-windowed')
    document.body.classList.add('splash-windowed')
    return () => {
      document.documentElement.classList.remove('splash-windowed')
      document.body.classList.remove('splash-windowed')
    }
  }, [windowed])

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    host.innerHTML = artSvg
    const svg = host.querySelector<SVGSVGElement>('svg#art')
    if (!svg) {
      finish()
      return
    }
    applyLightWordmark(svg)

    const audio = new Audio(splashSfxUrl)
    audio.preload = 'auto'
    audioRef.current = audio
    void audio.play().catch(() => {
      /* autoplay may be blocked until a gesture; preview shortcut has one */
    })

    const handle = startHanshuIntro(svg, {
      reducedMotion: prefersReducedMotion(),
      onComplete: showCredits,
    })
    motionRef.current = handle
    return () => {
      handle.stop()
      motionRef.current = null
      stopAudio()
      if (creditsTimer.current) window.clearTimeout(creditsTimer.current)
    }
  }, [finish, showCredits, stopAudio])

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape' || event.key === 'Enter' || event.key === ' ') {
        event.preventDefault()
        finish()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [finish])

  return (
    <div
      className={`splash-overlay${phase === 'out' ? ' is-out' : ''}${windowed ? ' is-windowed' : ''}`}
      role="presentation"
      onClick={finish}
    >
      <div
        className={`splash-dialog${phase !== 'play' ? ' is-credits' : ''}`}
        role="dialog"
        aria-label="HanShu splash"
        aria-modal="true"
      >
        <div className="splash-stage">
          <div
            className="splash-circuit"
            aria-hidden
            dangerouslySetInnerHTML={{ __html: circuitSvg }}
          />
          <div className="splash-banner" ref={hostRef} />
          <div
            className="splash-pixel-field"
            aria-hidden
            style={{
              gridTemplateColumns: `repeat(${PIXEL_COLS}, 1fr)`,
              gridTemplateRows: `repeat(${PIXEL_ROWS}, 1fr)`,
            }}
          >
            {SPLASH_PIXELS.map((pixel) => (
              <span
                key={pixel.id}
                className="splash-pixel"
                style={{
                  background: pixel.color,
                  transitionDelay: `${pixel.delayMs}ms`,
                }}
              />
            ))}
          </div>
          <div className="splash-credits" aria-hidden={phase === 'play'}>
            <p className="splash-product">HanShu RPG Tool Kit</p>
            <p className="splash-tagline">Your dream-making toolkit</p>
            <p className="splash-license">Open source under the MIT License</p>
            <p className="splash-thanks">{CREDITS.join('  ·  ')}</p>
          </div>
        </div>
      </div>
    </div>
  )
}
