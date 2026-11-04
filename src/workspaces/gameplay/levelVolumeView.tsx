import { useEffect, useRef } from 'react'
import {
  AxesHelper,
  Fog,
  BoxGeometry,
  BufferGeometry,
  DoubleSide,
  EdgesGeometry,
  GridHelper,
  Line,
  LineBasicMaterial,
  LineSegments,
  Mesh,
  MeshBasicMaterial,
  PerspectiveCamera,
  Plane,
  Raycaster,
  Scene,
  SphereGeometry,
  Vector2,
  Vector3,
  WebGLRenderer,
  type Intersection,
  type Material,
  type Object3D,
} from 'three'
import { editingBandAuthorY, initialDocumentOrbit, panOffset, placeOrbitCamera, selectionFocusOrbit, viewAngles } from './levelVolumeCamera'
import { buildAreaGeometry } from './levelVolumeGeometry'
import { stringifyLevelDocument, type LevelArea, type LevelCircleArea, type LevelDocument, type LevelPolygonArea, type LevelRectArea, type LevelY } from './levelDoc'
import {
  addArea,
  addLandmark,
  circleFromDrag,
  polygonFromPoints,
  rectFromDrag,
  replaceArea,
  setAreaY,
  setLandmarkParam,
} from './levelEdit'
import {
  anchoredPoint,
  authorPointFromWorld,
  circleWorldCenter,
  decimalAdd,
  decimalSub,
  polygonWorldPoint,
  rectWorldBox,
  snapAbsolute,
  translateDelta,
  withinCoordinateLimit,
  worldYSpan,
  type LevelViewCommand,
  type SnapStep,
} from './levelGeometry'
import {
  movePolygonVertex,
  resizeCircle,
  resizeRect,
  translateArea,
  yFromHandle,
  type LevelSelection,
  type LevelTool,
  type RectHandle,
} from './levelVolumeEdit'
import {
  HANDLE_TARGET_PX,
  LANDMARK_TARGET_PX,
  areaDimensionText,
  handleActionText,
  hoverCursorClass,
  landmarkDimensionText,
  stableHandleScale,
} from './levelVolumeViewport'
import './levelVolumeView.css'
import { effectColor, fullShader, type RegionEffectSections, type ShaderRef } from './regionEffects'

/** 地标高度旋钮与作者 Y 的世界间距，对齐原生 AXIS = 1。 */
const LANDMARK_Y_AXIS = 1

export type LevelVolumeProps = {
  base: LevelDocument
  shown: LevelDocument
  effectAudition?: { regionId: string; effects: RegionEffectSections } | null
  tool: LevelTool
  selection: LevelSelection
  draftPoints: readonly [number, number][]
  disabled?: boolean
  resetToken: string
  onHover: (hover: [number, number, number] | null) => void
  onPreview: (doc: LevelDocument | null) => void
  onCommit: (doc: LevelDocument) => void
  onSelection: (selection: LevelSelection) => void
  onDraftPoints: (points: [number, number][]) => void
  /** 默认 1。Alt 同样把步进收成 0.1。 */
  snapStep?: SnapStep
  viewCommand?: LevelViewCommand
  onViewportHint?: (hint: string | null) => void
}

type PickData = {
  pick?: 'area' | 'landmark' | 'handle'
  regionId?: string
  index?: number
  landmarkId?: string
  handle?: 'rect' | 'radius' | 'vertex' | 'y' | 'landmark-y' | 'move'
  edge?: string
  vertex?: number
  sharedGeometry?: boolean
  sharedMaterial?: boolean
  /** 未缩放时的世界尺寸。渲染时按距离换成稳定像素。 */
  pixelTarget?: number
  baseSize?: number
  hot?: boolean
}

type OrbitGesture = {
  kind: 'orbit'
  x: number
  y: number
  theta: number
  phi: number
}

type PanGesture = {
  kind: 'pan'
  x: number
  y: number
  target: Vector3
}

type DrawGesture = { kind: 'rect' | 'circle'; x: number; z: number; planeY: number; regionId: string | null }

type MoveAreaGesture = {
  kind: 'move-area'
  regionId: string
  index: number
  area: LevelArea
  grabX: number
  grabZ: number
  planeY: number
}

type ResizeRectGesture = {
  kind: 'resize-rect'
  regionId: string
  index: number
  area: LevelRectArea
  edge: RectHandle
  planeY: number
  anchorX: number
  anchorZ: number
  grabX: number
  grabZ: number
}

type RadiusGesture = {
  kind: 'resize-radius'
  regionId: string
  index: number
  area: LevelCircleArea
  planeY: number
  anchorX: number
  anchorZ: number
  grabX: number
  grabZ: number
}

type VertexGesture = {
  kind: 'vertex'
  regionId: string
  index: number
  area: LevelPolygonArea
  vertex: number
  planeY: number
  anchorX: number
  anchorZ: number
  grabX: number
  grabZ: number
}

type AreaYGesture = {
  kind: 'area-y'
  regionId: string
  index: number
  edge: 'min' | 'max'
  startY: LevelY
  origin: Vector3
  anchorY: number
  grabY: number
}

type LandmarkGesture = {
  kind: 'landmark'
  id: string
  startX: number
  startZ: number
  grabX: number
  grabZ: number
  planeY: number
}

type LandmarkYGesture = {
  kind: 'landmark-y'
  id: string
  origin: Vector3
  anchorY: number
  grabY: number
}

type Gesture =
  | OrbitGesture
  | PanGesture
  | DrawGesture
  | MoveAreaGesture
  | ResizeRectGesture
  | RadiusGesture
  | VertexGesture
  | AreaYGesture
  | LandmarkGesture
  | LandmarkYGesture

type VolumeApi = {
  sync: () => void
  audition: () => void
  cancelGesture: () => void
  applyCommand: (command: LevelViewCommand) => void
  dispose: () => void
}

const AFFORDANCE_CLASSES = [
  'is-hover-move', 'is-hover-x', 'is-hover-z', 'is-hover-y', 'is-hover-corner', 'is-hover-radius', 'is-hover-handle',
  'is-active-move', 'is-active-x', 'is-active-z', 'is-active-y', 'is-active-corner', 'is-active-radius',
]

export function LevelVolumeView(props: LevelVolumeProps) {
  const hostRef = useRef<HTMLDivElement>(null)
  const apiRef = useRef<VolumeApi | null>(null)
  const propsRef = useRef(props)
  propsRef.current = props

  useEffect(() => {
    const host = hostRef.current
    if (!host) return
    const api = mountLevelVolume(host, () => propsRef.current)
    apiRef.current = api
    api.sync()
    return () => {
      api.dispose()
      if (apiRef.current === api) apiRef.current = null
    }
  }, [])

  useEffect(() => {
    apiRef.current?.sync()
  }, [props.shown, props.selection, props.draftPoints, props.tool])
  useEffect(() => { apiRef.current?.audition() }, [props.effectAudition])

  // resetToken 只取消手势。父级在撤销、外部回声、切模式和保存前都会递增它，这里重装相机会把普通编辑的视角拽走。
  useEffect(() => {
    apiRef.current?.cancelGesture()
  }, [props.resetToken])

  useEffect(() => {
    hostRef.current?.classList.toggle('is-read-only', Boolean(props.disabled))
    if (props.disabled) apiRef.current?.cancelGesture()
  }, [props.disabled])

  useEffect(() => {
    const command = props.viewCommand
    if (command) apiRef.current?.applyCommand(command)
  }, [props.viewCommand])

  return <div ref={hostRef} className="level-volume" tabIndex={0} aria-label="三维体积视图" />
}

function mountLevelVolume(host: HTMLDivElement, getProps: () => LevelVolumeProps): VolumeApi {
  let renderer: WebGLRenderer
  try {
    renderer = new WebGLRenderer({
      antialias: true,
      alpha: false,
      powerPreference: 'low-power',
      preserveDrawingBuffer: true,
    })
  } catch {
    host.dataset.error = 'webgl'
    host.textContent = '三维视图需要 WebGL'
    return { sync() {}, audition() {}, cancelGesture() {}, applyCommand() {}, dispose() { host.textContent = '' } }
  }

  const scene = new Scene()
  scene.background = null
  const camera = new PerspectiveCamera(40, 1, 0.05, 20000)
  const orbit = { target: new Vector3(32, 0, 32), radius: 86, theta: 0.6, phi: 0.72 }
  const cameraKeys = new Set<string>()
  let navigationFrame = 0, navigationTime = 0
  let clickPlacing = false
  let creationPress: { x: number; y: number } | null = null
  const contentRoot = new Mesh()
  contentRoot.raycast = () => {}
  scene.add(contentRoot)
  const handleRoot = new Mesh()
  handleRoot.raycast = () => {}
  scene.add(handleRoot)
  const grid = new GridHelper(512, 64, 0x3c4654, 0x2a3138)
  scene.add(grid)
  const gizmoScene = new Scene()
  const gizmo = new AxesHelper(1.15)
  gizmo.raycast = () => {}
  gizmoScene.add(gizmo)
  const gizmoCamera = new PerspectiveCamera(32, 1, 0.05, 20)
  const drawingSize = new Vector2()
  const gizmoOffset = new Vector3()

  const fill = (color: number, opacity: number) => new MeshBasicMaterial({
    color,
    transparent: true,
    opacity,
    side: DoubleSide,
    depthWrite: false,
    polygonOffset: true,
    polygonOffsetFactor: 1,
    polygonOffsetUnits: 1,
  })
  const solid = (color: number) => new MeshBasicMaterial({ color, depthWrite: false })
  const areaMaterial = fill(0xc5d4e4, 0.07)
  const selectedMaterial = fill(0xffe2b0, 0.13)
  const ghostMaterial = new MeshBasicMaterial({
    color: 0xb7c6d6,
    transparent: true,
    opacity: 0.045,
    side: DoubleSide,
    depthWrite: false,
  })
  const landmarkMaterial = solid(0xe08484)
  const selectedLandmarkMaterial = solid(0xffd2d2)
  const xHandleMaterial = solid(0xe23b3b)
  const zHandleMaterial = solid(0x3b6fe2)
  const yHandleMaterial = solid(0x3dce6a)
  const cornerHandleMaterial = solid(0xf4f7fb)
  const moveHandleMaterial = solid(0xf0c27a)
  const radiusHandleMaterial = solid(0xe8a23a)
  const edgeMaterial = new LineBasicMaterial({ color: 0xd7e2ee })
  const selectedEdgeMaterial = new LineBasicMaterial({ color: 0xfff1cc })
  const ghostEdgeMaterial = new LineBasicMaterial({ color: 0x9eb0c4, transparent: true, opacity: 0.55 })
  const draftMaterial = new LineBasicMaterial({ color: 0xe8b45a })
  const handleGeometry = new BoxGeometry(0.7, 0.7, 0.7)
  const markerGeometry = new SphereGeometry(0.5, 16, 12)
  const sharedMaterials = [
    areaMaterial,
    selectedMaterial,
    ghostMaterial,
    landmarkMaterial,
    selectedLandmarkMaterial,
    xHandleMaterial,
    zHandleMaterial,
    yHandleMaterial,
    cornerHandleMaterial,
    moveHandleMaterial,
    radiusHandleMaterial,
    edgeMaterial,
    selectedEdgeMaterial,
    ghostEdgeMaterial,
    draftMaterial,
  ]

  const ndc = new Vector2()
  const hitPoint = new Vector3()
  const plane = new Plane()
  const yAxis = new Vector3(0, 1, 0)
  const forward = new Vector3()
  const horizontal = new Vector3()
  const raycaster = new Raycaster()
  let gesture: Gesture | null = null
  let activePointer: number | null = null
  let suppressLostCapture = false
  let fitted = false
  let disposed = false
  let seenSequence: number | null = null
  let hotObject: Object3D | null = null
  let publishedHint: string | null | undefined

  renderer.setClearColor(0x121314, 1)
  renderer.setPixelRatio(Math.min(window.devicePixelRatio || 1, 2))
  host.appendChild(renderer.domElement)

  function placeCamera() {
    placeOrbitCamera(camera, orbit)
  }

  function publishOrbit() {
    host.dataset.orbit = [
      orbit.radius.toFixed(3),
      orbit.theta.toFixed(3),
      orbit.phi.toFixed(3),
      orbit.target.x.toFixed(2),
      orbit.target.y.toFixed(2),
      orbit.target.z.toFixed(2),
    ].join(' ')
    host.dataset.tool = getProps().tool
  }

  function clearAffordance() {
    host.classList.remove(...AFFORDANCE_CLASSES)
  }

  function scaleAffordances() {
    const height = host.clientHeight
    const visit = (object: Object3D) => {
      const data = object.userData as PickData
      if (!data.pixelTarget || !data.baseSize) return
      const distance = Math.max(camera.position.distanceTo(object.position), 0.5)
      const boost = data.hot ? 1.18 : 1
      const scale = stableHandleScale(distance, height, camera.fov, data.baseSize, data.pixelTarget) * boost
      object.scale.setScalar(Number.isFinite(scale) ? scale : 1)
    }
    for (const child of handleRoot.children) visit(child)
    for (const child of contentRoot.children) visit(child)
  }

  function paintFrame() {
    // Renderer viewport/scissor coordinates are CSS pixels; it applies DPR itself.
    renderer.getSize(drawingSize)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, drawingSize.x, drawingSize.y)
    renderer.render(scene, camera)
    gizmoOffset.copy(camera.position).sub(orbit.target)
    if (gizmoOffset.lengthSq() < 1e-8) gizmoOffset.set(0.4, 1, 0.4)
    gizmoOffset.normalize().multiplyScalar(3.4)
    gizmoCamera.up.setFromMatrixColumn(camera.matrixWorld, 1)
    gizmoCamera.position.copy(gizmoOffset)
    gizmoCamera.lookAt(0, 0, 0)
    gizmoCamera.updateMatrixWorld()
    const span = 78
    const margin = 10
    const originX = Math.max(0, drawingSize.x - span - margin)
    const originY = margin
    renderer.clearDepth()
    renderer.setScissorTest(true)
    renderer.setScissor(originX, originY, span, span)
    renderer.setViewport(originX, originY, span, span)
    renderer.render(gizmoScene, gizmoCamera)
    renderer.setScissorTest(false)
    renderer.setViewport(0, 0, drawingSize.x, drawingSize.y)
  }

  function render() {
    if (disposed) return
    placeCamera()
    scaleAffordances()
    grid.position.set(orbit.target.x, 0, orbit.target.z)
    paintFrame()
    publishOrbit()
  }

  function resize() {
    const width = host.clientWidth
    const height = host.clientHeight
    if (width < 2 || height < 2) return
    camera.aspect = width / height
    camera.updateProjectionMatrix()
    renderer.setSize(width, height, false)
    host.dataset.ready = '1'
    render()
  }

  function setRay(clientX: number, clientY: number): boolean {
    const rect = host.getBoundingClientRect()
    if (rect.width <= 0 || rect.height <= 0) return false
    ndc.set(((clientX - rect.left) / rect.width) * 2 - 1, -((clientY - rect.top) / rect.height) * 2 + 1)
    raycaster.setFromCamera(ndc, camera)
    return true
  }

  function horizontalHit(clientX: number, clientY: number, planeY: number): Vector3 | null {
    if (!setRay(clientX, clientY)) return null
    plane.set(yAxis, -planeY)
    return raycaster.ray.intersectPlane(plane, hitPoint)?.clone() ?? null
  }

  function verticalHit(clientX: number, clientY: number, origin: Vector3): number | null {
    if (!setRay(clientX, clientY)) return null
    camera.getWorldDirection(forward)
    horizontal.set(forward.x, 0, forward.z)
    if (horizontal.lengthSq() < 1e-8) horizontal.set(0, 0, 1)
    else horizontal.normalize()
    plane.setFromNormalAndCoplanarPoint(horizontal, origin)
    const hit = raycaster.ray.intersectPlane(plane, hitPoint)
    return hit ? hit.y : null
  }

  function stepFor(altKey: boolean): SnapStep {
    if (altKey || getProps().snapStep === 0.1) return 0.1
    return 1
  }

  function setHint(hint: string | null) {
    if (hint === publishedHint) return
    publishedHint = hint
    if (hint) host.dataset.hint = hint
    else delete host.dataset.hint
    getProps().onViewportHint?.(hint)
  }

  function setHot(object: Object3D | null): boolean {
    if (hotObject === object) return false
    if (hotObject) (hotObject.userData as PickData).hot = false
    hotObject = object
    if (object) (object.userData as PickData).hot = true
    return true
  }

  function updateEffectAudition() {
    const props = getProps()
    const environment = props.effectAudition?.effects.environment
    const fog = environment?.effects.fog?.parameters
    scene.fog = fog ? new Fog(effectColor(fog.color)?.hex ?? '#a9c4d0', Number(fog.start ?? 0), Number(fog.end ?? 96)) : null
    const sky = environment?.effects.sky?.parameters.layers as ShaderRef[] | undefined
    const lastSky = sky?.length ? fullShader(sky[sky.length - 1]) : null
    const skyColors = lastSky?.params
    host.style.backgroundImage = lastSky ? `linear-gradient(${effectColor(skyColors?.zenith)?.hex ?? effectColor(skyColors?.color)?.hex ?? '#25395b'},${effectColor(skyColors?.horizon)?.hex ?? '#c3988b'},#17252d)` : ''
    const filters: string[] = []
    for (const ref of environment?.effects.post?.parameters.filters as ShaderRef[] ?? []) {
      const entry = fullShader(ref), p = entry.params ?? {}, strength = entry.strength ?? 1
      if (entry.shader.endsWith(':color_grade')) filters.push(`brightness(${2 ** (Number(p.exposure ?? -.25) * strength)}) contrast(${1 + (Number(p.contrast ?? 1.25) - 1) * strength}) saturate(${1 + (Number(p.saturation ?? 1.2) - 1) * strength})`)
      if (entry.shader.endsWith(':monochrome')) filters.push(`grayscale(${strength})`)
      if (entry.shader.endsWith(':blur')) filters.push(`blur(${Math.min(10, Number(p.radius ?? 8) * strength)}px)`)
    }
    renderer.domElement.style.filter = filters.join(' ')
  }

  function focusHint(): string {
    const props = getProps()
    const selection = props.selection
    if (selection?.kind === 'region') {
      const area = props.shown.regions.find((region) => region.id === selection.id)?.areas[selection.area]
      return area ? `对准 · ${areaDimensionText(area)}` : '对准整场'
    }
    if (selection?.kind === 'landmark') {
      const point = props.shown.landmarks.find((item) => item.id === selection.id)
      return point ? `对准 · ${landmarkDimensionText(point.param.x, point.param.y, point.param.z)}` : '对准整场'
    }
    return '对准整场'
  }

  function focusSelection() {
    const props = getProps()
    const next = selectionFocusOrbit(props.shown, props.selection, { theta: orbit.theta, phi: orbit.phi })
    orbit.target.copy(next.target)
    orbit.radius = next.radius
    orbit.theta = next.theta
    orbit.phi = Math.min(1.45, Math.max(0.12, next.phi))
    render()
    setHint(focusHint())
  }

  function applyCommand(command: LevelViewCommand) {
    if (disposed) return
    if (seenSequence === command.sequence) return
    const opening = seenSequence === null
    seenSequence = command.sequence
    if (command.kind === 'focus') {
      focusSelection()
      return
    }
    const angles = viewAngles(command.kind, orbit.theta)
    orbit.theta = angles.theta
    orbit.phi = Math.min(1.45, Math.max(0.12, angles.phi))
    if (!(opening && command.sequence === 0 && command.kind === 'perspective')) setHint(null)
    render()
  }

  function regionIdForNew(): string | null {
    const selection = getProps().selection
    return selection?.kind === 'region' ? selection.id : null
  }

  function areaOf(doc: LevelDocument, regionId: string, index: number): LevelArea | null {
    return doc.regions.find((region) => region.id === regionId)?.areas[index] ?? null
  }

  function finishNewRegion(next: LevelDocument, regionId: string | null) {
    if (regionId) return
    const created = next.regions.at(-1)
    if (created) getProps().onSelection({ kind: 'region', id: created.id, area: 0 })
  }

  function sameDocument(next: LevelDocument, base: LevelDocument): boolean {
    return stringifyLevelDocument(next) === stringifyLevelDocument(base)
  }

  function previewOrCommit(next: LevelDocument | null, commit: boolean, created?: { regionId: string | null }) {
    const props = getProps()
    if (!next || sameDocument(next, props.base)) {
      props.onPreview(null)
      return
    }
    if (!commit) {
      props.onPreview(next)
      return
    }
    props.onPreview(null)
    props.onCommit(next)
    if (created) finishNewRegion(next, created.regionId)
  }

  function documentFromGesture(current: Gesture, clientX: number, clientY: number, step: SnapStep): LevelDocument | null {
    const base = getProps().base
    if (current.kind === 'rect' || current.kind === 'circle') {
      const hit = horizontalHit(clientX, clientY, current.planeY)
      if (!hit) return null
      const drag = { worldFaces: true as const, step }
      const area = current.kind === 'rect'
        ? rectFromDrag(current.x, current.z, hit.x, hit.z, 'all', drag)
        : circleFromDrag(current.x, current.z, hit.x, hit.z, 'all', drag)
      return area ? addArea(base, current.regionId, area) : base
    }
    if (current.kind === 'move-area') {
      const hit = horizontalHit(clientX, clientY, current.planeY)
      if (!hit) return null
      const dx = translateDelta(current.grabX, hit.x, step)
      const dz = translateDelta(current.grabZ, hit.z, step)
      return replaceArea(base, current.regionId, current.index, translateArea(current.area, dx, dz))
    }
    if (current.kind === 'resize-rect') {
      const hit = horizontalHit(clientX, clientY, current.planeY)
      if (!hit) return null
      const x = anchoredPoint(current.anchorX, current.grabX, hit.x, step)
      const z = anchoredPoint(current.anchorZ, current.grabZ, hit.z, step)
      return replaceArea(base, current.regionId, current.index, resizeRect(current.area, current.edge, x, z, step))
    }
    if (current.kind === 'resize-radius') {
      const hit = horizontalHit(clientX, clientY, current.planeY)
      if (!hit) return null
      const x = anchoredPoint(current.anchorX, current.grabX, hit.x, step)
      const z = anchoredPoint(current.anchorZ, current.grabZ, hit.z, step)
      return replaceArea(base, current.regionId, current.index, resizeCircle(current.area, x, z, step))
    }
    if (current.kind === 'vertex') {
      const hit = horizontalHit(clientX, clientY, current.planeY)
      if (!hit) return null
      const x = anchoredPoint(current.anchorX, current.grabX, hit.x, step)
      const z = anchoredPoint(current.anchorZ, current.grabZ, hit.z, step)
      return replaceArea(base, current.regionId, current.index, movePolygonVertex(current.area, current.vertex, x, z, step))
    }
    if (current.kind === 'area-y') {
      const y = verticalHit(clientX, clientY, current.origin)
      if (y === null) return null
      const proposed = anchoredPoint(current.anchorY, current.grabY, y, step)
      return setAreaY(base, current.regionId, current.index, yFromHandle(current.startY, current.edge, proposed, step))
    }
    if (current.kind === 'landmark') {
      const hit = horizontalHit(clientX, clientY, current.planeY)
      if (!hit) return null
      const point = base.landmarks.find((item) => item.id === current.id)
      if (!point) return null
      const x = decimalAdd(current.startX, translateDelta(current.grabX, hit.x, step))
      const z = decimalAdd(current.startZ, translateDelta(current.grabZ, hit.z, step))
      if (!withinCoordinateLimit(x) || !withinCoordinateLimit(z)) return base
      return setLandmarkParam(base, current.id, { ...point.param, x, z })
    }
    if (current.kind === 'landmark-y') {
      const y = verticalHit(clientX, clientY, current.origin)
      if (y === null) return null
      const point = base.landmarks.find((item) => item.id === current.id)
      if (!point) return null
      const nextY = decimalSub(anchoredPoint(current.anchorY, current.grabY, y, step), LANDMARK_Y_AXIS)
      if (!withinCoordinateLimit(nextY)) return base
      return setLandmarkParam(base, current.id, { ...point.param, y: nextY })
    }
    return null
  }

  function releasePointer(id: number | null) {
    if (id === null) return
    try {
      if (host.hasPointerCapture(id)) host.releasePointerCapture(id)
    } catch {
      // 捕获已经不在这只指针上。
    }
  }

  function matchesPointer(event: PointerEvent): boolean {
    return activePointer === null || event.pointerId === activePointer
  }

  function dropGesture(clearPreview: boolean): number | null {
    const current = gesture
    const id = activePointer
    gesture = null
    clickPlacing = false; creationPress = null
    activePointer = null
    host.classList.remove('is-orbit', 'is-pan')
    clearAffordance()
    if (clearPreview && current && current.kind !== 'orbit' && current.kind !== 'pan') {
      getProps().onPreview(null)
      setHint(null)
    }
    return id
  }

  function cancelGesture() {
    if (!gesture) return
    const id = dropGesture(true)
    suppressLostCapture = true
    releasePointer(id)
    suppressLostCapture = false
  }

  function activeClass(current: Gesture): string | null {
    if (current.kind === 'move-area' || current.kind === 'landmark' || current.kind === 'rect' || current.kind === 'circle') return 'is-active-move'
    if (current.kind === 'area-y' || current.kind === 'landmark-y') return 'is-active-y'
    if (current.kind === 'resize-radius') return 'is-active-radius'
    if (current.kind === 'vertex') return 'is-active-corner'
    if (current.kind === 'resize-rect') {
      if (current.edge === 'minX' || current.edge === 'maxX') return 'is-active-x'
      if (current.edge === 'minZ' || current.edge === 'maxZ') return 'is-active-z'
      return 'is-active-corner'
    }
    return null
  }

  function arm(event: PointerEvent, next: Gesture) {
    gesture = next
    clickPlacing = false
    creationPress = next.kind === 'rect' || next.kind === 'circle' ? { x: event.clientX, y: event.clientY } : null
    activePointer = event.pointerId
    host.setPointerCapture(event.pointerId)
    const name = activeClass(next)
    if (!name) return
    clearAffordance()
    host.classList.add(name)
  }

  function finishPointer(event: PointerEvent) {
    if (!gesture || !matchesPointer(event)) return
    const current = gesture
    const id = activePointer
    if ((current.kind === 'rect' || current.kind === 'circle') && !clickPlacing && creationPress
      && Math.hypot(event.clientX - creationPress.x, event.clientY - creationPress.y) < 4) {
      activePointer = null; clickPlacing = true
      suppressLostCapture = true; releasePointer(id); suppressLostCapture = false
      previewOrCommit(documentFromGesture(current, event.clientX, event.clientY, stepFor(event.altKey)), false)
      setHint('移动鼠标预览，再次左键确认；Esc取消')
      return
    }
    gesture = null
    clickPlacing = false; creationPress = null
    activePointer = null
    host.classList.remove('is-orbit', 'is-pan')
    clearAffordance()
    suppressLostCapture = true
    releasePointer(id)
    suppressLostCapture = false
    if (current.kind === 'orbit' || current.kind === 'pan') return
    if (getProps().disabled) {
      getProps().onPreview(null)
      return
    }
    const next = documentFromGesture(current, event.clientX, event.clientY, stepFor(event.altKey))
    const created = current.kind === 'rect' || current.kind === 'circle' ? { regionId: current.regionId } : undefined
    previewOrCommit(next, true, created)
  }

  function onPointerDown(event: PointerEvent) {
    host.focus({ preventScroll: true })
    if (event.button === 2) {
      event.preventDefault()
      clearAffordance()
      setHint(null)
      host.classList.add('is-orbit')
      arm(event, { kind: 'orbit', x: event.clientX, y: event.clientY, theta: orbit.theta, phi: orbit.phi })
      return
    }
    if (event.button === 1) {
      event.preventDefault()
      placeCamera()
      clearAffordance()
      setHint(null)
      host.classList.add('is-pan')
      arm(event, { kind: 'pan', x: event.clientX, y: event.clientY, target: orbit.target.clone() })
      return
    }
    if (event.button !== 0) return
    host.focus({ preventScroll: true })
    const props = getProps()
    if (props.disabled) {
      selectAt(event.clientX, event.clientY, props)
      return
    }
    if (clickPlacing && gesture && (gesture.kind === 'rect' || gesture.kind === 'circle')) {
      activePointer = event.pointerId; host.setPointerCapture(event.pointerId); return
    }
    const step = stepFor(event.altKey)
    if (props.tool === 'polygon') {
      const hit = horizontalHit(event.clientX, event.clientY, editingBandAuthorY(props.shown))
      if (!hit) return
      const authored = authorPointFromWorld(hit.x, hit.z, step)
      if (!authored) return
      const points = props.draftPoints
      const first = points[0]
      if (first && points.length >= 3 && Math.hypot(authored[0] - first[0], authored[1] - first[1]) <= 1) {
        const area = polygonFromPoints(points, 'all', { authored: true })
        if (!area) return
        const regionId = regionIdForNew()
        const next = addArea(props.base, regionId, area)
        props.onDraftPoints([])
        props.onCommit(next)
        finishNewRegion(next, regionId)
      } else {
        props.onDraftPoints([...points, authored])
      }
      return
    }
    if (props.tool === 'rect' || props.tool === 'circle') {
      const planeY = editingBandAuthorY(props.shown)
      const hit = horizontalHit(event.clientX, event.clientY, planeY)
      if (!hit) return
      arm(event, { kind: props.tool, x: hit.x, z: hit.z, planeY, regionId: regionIdForNew() })
      return
    }
    if (props.tool === 'landmark') {
      const selected = props.selection?.kind === 'landmark'
        ? props.base.landmarks.find((point) => point.id === props.selection?.id)
        : undefined
      const planeY = selected?.param.y ?? editingBandAuthorY(props.shown)
      const hit = horizontalHit(event.clientX, event.clientY, planeY)
      if (!hit) return
      const placed = addLandmark(props.base, hit.x, hit.z, planeY)
      props.onCommit(placed.doc)
      props.onSelection({ kind: 'landmark', id: placed.id })
      return
    }
    const picked = pickObject(event.clientX, event.clientY)
    if (!picked) {
      props.onSelection(null)
      return
    }
    const data = picked.object.userData as PickData
    if (data.pick === 'handle' && data.regionId !== undefined && data.index !== undefined) {
      const area = areaOf(props.base, data.regionId, data.index)
      if (!area) return
      const planeY = picked.point.y
      if (data.handle === 'y' && (data.edge === 'min' || data.edge === 'max') && area.y !== 'all') {
        const span = worldYSpan(area.y)
        const anchorY = data.edge === 'max' ? span[1] : span[0]
        const center = areaWorldCenter(area)
        const origin = new Vector3(center[0], anchorY, center[1])
        const grabY = verticalHit(event.clientX, event.clientY, origin) ?? anchorY
        arm(event, {
          kind: 'area-y',
          regionId: data.regionId,
          index: data.index,
          edge: data.edge,
          startY: area.y,
          origin,
          anchorY,
          grabY,
        })
      } else if (data.handle === 'rect' && area.kind === 'rect' && isRectHandle(data.edge)) {
        const anchor = rectHandleAnchor(area, data.edge)
        const hit = horizontalHit(event.clientX, event.clientY, planeY) ?? picked.point
        arm(event, {
          kind: 'resize-rect',
          regionId: data.regionId,
          index: data.index,
          area,
          edge: data.edge,
          planeY,
          anchorX: anchor.x,
          anchorZ: anchor.z,
          grabX: hit.x,
          grabZ: hit.z,
        })
      } else if (data.handle === 'radius' && area.kind === 'circle') {
        const [centerX, centerZ] = circleWorldCenter(area.center[0], area.center[1])
        const hit = horizontalHit(event.clientX, event.clientY, planeY) ?? picked.point
        arm(event, {
          kind: 'resize-radius',
          regionId: data.regionId,
          index: data.index,
          area,
          planeY,
          anchorX: decimalAdd(centerX, area.radius),
          anchorZ: centerZ,
          grabX: hit.x,
          grabZ: hit.z,
        })
      } else if (data.handle === 'vertex' && area.kind === 'polygon' && data.vertex !== undefined) {
        const point = area.points[data.vertex]
        if (!point) return
        const [anchorX, anchorZ] = polygonWorldPoint(point[0], point[1])
        const hit = horizontalHit(event.clientX, event.clientY, planeY) ?? picked.point
        arm(event, {
          kind: 'vertex',
          regionId: data.regionId,
          index: data.index,
          area,
          vertex: data.vertex,
          planeY,
          anchorX,
          anchorZ,
          grabX: hit.x,
          grabZ: hit.z,
        })
      } else if (data.handle === 'move') {
        const hit = horizontalHit(event.clientX, event.clientY, planeY) ?? picked.point
        arm(event, {
          kind: 'move-area',
          regionId: data.regionId,
          index: data.index,
          area,
          grabX: hit.x,
          grabZ: hit.z,
          planeY,
        })
        props.onSelection({ kind: 'region', id: data.regionId, area: data.index })
      }
      return
    }
    if (data.pick === 'handle' && data.handle === 'landmark-y' && data.landmarkId) {
      const point = props.base.landmarks.find((item) => item.id === data.landmarkId)
      if (!point) return
      const anchorY = decimalAdd(point.param.y, LANDMARK_Y_AXIS)
      const origin = new Vector3(point.param.x, anchorY, point.param.z)
      const grabY = verticalHit(event.clientX, event.clientY, origin) ?? picked.point.y
      arm(event, { kind: 'landmark-y', id: data.landmarkId, origin, anchorY, grabY })
      props.onSelection({ kind: 'landmark', id: data.landmarkId })
      return
    }
    if (data.pick === 'landmark' && data.landmarkId) {
      const point = props.base.landmarks.find((item) => item.id === data.landmarkId)
      if (!point) return
      const hit = horizontalHit(event.clientX, event.clientY, point.param.y) ?? picked.point
      arm(event, {
        kind: 'landmark',
        id: point.id,
        startX: point.param.x,
        startZ: point.param.z,
        grabX: hit.x,
        grabZ: hit.z,
        planeY: point.param.y,
      })
      props.onSelection({ kind: 'landmark', id: point.id })
      return
    }
    if (data.pick === 'area' && data.regionId !== undefined && data.index !== undefined) {
      const area = areaOf(props.base, data.regionId, data.index)
      if (!area) return
      const hit = horizontalHit(event.clientX, event.clientY, picked.point.y) ?? picked.point
      arm(event, {
        kind: 'move-area',
        regionId: data.regionId,
        index: data.index,
        area,
        grabX: hit.x,
        grabZ: hit.z,
        planeY: picked.point.y,
      })
      props.onSelection({ kind: 'region', id: data.regionId, area: data.index })
    }
  }

  function pickObject(clientX: number, clientY: number): Intersection | null {
    if (!setRay(clientX, clientY)) return null
    const handleHits = raycaster.intersectObjects(handleRoot.children, true)
    const handle = handleHits.find((item) => (item.object.userData as PickData).pick)
    if (handle) return handle
    const contentHits = raycaster.intersectObjects(contentRoot.children, true)
    return contentHits.find((item) => (item.object.userData as PickData).pick) ?? null
  }

  function selectionFromPick(data: PickData): LevelSelection {
    if (data.landmarkId && (data.pick === 'landmark' || data.handle === 'landmark-y')) {
      return { kind: 'landmark', id: data.landmarkId }
    }
    if (data.regionId !== undefined && data.index !== undefined) {
      return { kind: 'region', id: data.regionId, area: data.index }
    }
    return null
  }

  function selectAt(clientX: number, clientY: number, props: LevelVolumeProps) {
    const picked = pickObject(clientX, clientY)
    if (!picked) {
      props.onSelection(null)
      return
    }
    props.onSelection(selectionFromPick(picked.object.userData as PickData))
  }

  function onPointerMove(event: PointerEvent) {
    const step = stepFor(event.altKey)
    const ground = horizontalHit(event.clientX, event.clientY, 0)
    getProps().onHover(ground ? [snapAbsolute(ground.x, step), snapAbsolute(ground.y, step), snapAbsolute(ground.z, step)] : null)
    const current = gesture
    if (current && matchesPointer(event)) {
      if (current.kind === 'orbit') {
        orbit.theta = current.theta - (event.clientX - current.x) * 0.005
        orbit.phi = Math.min(1.45, Math.max(0.12, current.phi - (event.clientY - current.y) * 0.005))
        setHint(null)
        render()
        return
      }
      if (current.kind === 'pan') {
        const start = { target: current.target, radius: orbit.radius, theta: orbit.theta, phi: orbit.phi }
        placeOrbitCamera(camera, start)
        const offset = panOffset(camera, start, host.clientHeight, event.clientX - current.x, event.clientY - current.y)
        orbit.target.copy(current.target).add(offset)
        setHint(null)
        render()
        return
      }
      if (getProps().disabled) {
        cancelGesture()
        return
      }
      const next = documentFromGesture(current, event.clientX, event.clientY, step)
      if (next) previewOrCommit(next, false)
      setHint(gestureDimension(current, next))
      return
    }
    if (!current) {
      if (getProps().tool === 'select') updateHover(event.clientX, event.clientY)
      else { clearAffordance(); if (setHot(null)) render(); setHint(null) }
    }
  }

  function gestureDimension(current: Gesture, next: LevelDocument | null): string | null {
    if (!next) return null
    if (current.kind === 'rect' || current.kind === 'circle') {
      const area = next.regions.at(-1)?.areas.at(-1)
      return area ? areaDimensionText(area) : null
    }
    if (current.kind === 'move-area' || current.kind === 'resize-rect' || current.kind === 'resize-radius' || current.kind === 'vertex' || current.kind === 'area-y') {
      const area = areaOf(next, current.regionId, current.index)
      if (!area) return null
      const action = current.kind === 'resize-rect'
        ? handleActionText('rect', current.edge)
        : current.kind === 'resize-radius'
          ? handleActionText('radius')
          : current.kind === 'vertex'
            ? handleActionText('vertex')
            : current.kind === 'area-y'
              ? handleActionText('y', current.edge)
              : handleActionText('move')
      return `${action} · ${areaDimensionText(area)}`
    }
    if (current.kind === 'landmark' || current.kind === 'landmark-y') {
      const point = next.landmarks.find((item) => item.id === current.id)
      if (!point) return null
      const action = current.kind === 'landmark-y' ? handleActionText('landmark-y') : handleActionText('move')
      return `${action} · ${landmarkDimensionText(point.param.x, point.param.y, point.param.z)}`
    }
    return null
  }

  function hoverDimension(data: PickData): string | null {
    const props = getProps()
    if (data.landmarkId) {
      const point = props.shown.landmarks.find((item) => item.id === data.landmarkId)
      if (!point) return null
      const label = landmarkDimensionText(point.param.x, point.param.y, point.param.z)
      return data.handle ? `${handleActionText(data.handle, data.edge)} · ${label}` : label
    }
    if (data.regionId === undefined || data.index === undefined) return null
    const area = props.shown.regions.find((region) => region.id === data.regionId)?.areas[data.index]
    if (!area) return null
    const label = areaDimensionText(area)
    return data.handle ? `${handleActionText(data.handle, data.edge)} · ${label}` : label
  }

  function updateHover(clientX: number, clientY: number) {
    const picked = pickObject(clientX, clientY)
    if (!picked) {
      clearAffordance()
      if (setHot(null)) render()
      setHint(null)
      return
    }
    const data = picked.object.userData as PickData
    clearAffordance()
    const cursor = hoverCursorClass(data.pick, data.handle, data.edge)
    if (cursor) host.classList.add(cursor)
    if (setHot(data.pixelTarget ? picked.object : null)) render()
    setHint(hoverDimension(data))
  }

  function onPointerUp(event: PointerEvent) {
    if (!gesture || !matchesPointer(event)) return
    finishPointer(event)
  }

  function onPointerCancel(event: PointerEvent) {
    if (!gesture || !matchesPointer(event)) return
    cancelGesture()
  }

  function onLostPointerCapture(event: PointerEvent) {
    // Between the two clicks there is intentionally no captured pointer; its asynchronous release is expected.
    if (suppressLostCapture || clickPlacing && activePointer === null || !gesture || !matchesPointer(event)) return
    dropGesture(true)
  }

  function onBlur() {
    stopNavigation()
    if (gesture) cancelGesture()
  }

  function onVisibility() {
    if (document.visibilityState === 'hidden') stopNavigation()
    if (document.visibilityState === 'hidden' && gesture) cancelGesture()
  }

  function onEscape(event: KeyboardEvent) {
    if (event.key !== 'Escape' || !gesture) return
    event.preventDefault()
    event.stopPropagation()
    cancelGesture()
  }

  function onHostKey(event: KeyboardEvent) {
    if (!event.metaKey && !event.ctrlKey && !event.altKey && /^(Key[WASDQE]|Space|ShiftLeft|ShiftRight)$/.test(event.code)) {
      event.preventDefault(); event.stopPropagation()
      if (gesture && !event.code.startsWith('Shift')) cancelGesture()
      cameraKeys.add(event.code)
      if (!navigationFrame) { navigationTime = performance.now(); navigationFrame = requestAnimationFrame(navigate) }
      return
    }
    if (event.key !== 'f' && event.key !== 'F') return
    if (event.metaKey || event.ctrlKey || event.altKey || event.shiftKey) return
    event.preventDefault()
    focusSelection()
  }

  function stopNavigation() {
    cameraKeys.clear(); cancelAnimationFrame(navigationFrame); navigationFrame = 0
  }

  function onHostKeyUp(event: KeyboardEvent) {
    cameraKeys.delete(event.code)
    if (!cameraKeys.size) stopNavigation()
  }

  function navigate(now: number) {
    navigationFrame = 0
    if (disposed || document.activeElement !== host || document.hidden || !cameraKeys.size) { stopNavigation(); return }
    const dt = Math.min(.05, (now - navigationTime) / 1000); navigationTime = now
    const right = new Vector3(Math.cos(orbit.theta), 0, -Math.sin(orbit.theta))
    const forward = new Vector3(-Math.sin(orbit.theta), 0, -Math.cos(orbit.theta))
    const direction = new Vector3()
    if (cameraKeys.has('KeyW')) direction.add(forward)
    if (cameraKeys.has('KeyS')) direction.sub(forward)
    if (cameraKeys.has('KeyD')) direction.add(right)
    if (cameraKeys.has('KeyA')) direction.sub(right)
    if (cameraKeys.has('KeyQ')) direction.y -= 1
    if (cameraKeys.has('KeyE') || cameraKeys.has('Space')) direction.y += 1
    const boost = cameraKeys.has('ShiftLeft') || cameraKeys.has('ShiftRight') ? 3 : 1
    orbit.target.add(direction.normalize().multiplyScalar(Math.max(4, Math.min(300, orbit.radius * .6)) * dt * boost))
    render()
    navigationFrame = requestAnimationFrame(navigate)
  }

  function onWheel(event: WheelEvent) {
    event.preventDefault()
    const factor = Math.exp(event.deltaY * 0.0012)
    orbit.radius = Math.min(8000, Math.max(2, orbit.radius * factor))
    render()
  }

  function onContextMenu(event: Event) {
    event.preventDefault()
  }

  function clearGroup(root: Object3D) {
    for (const child of [...root.children]) {
      root.remove(child)
      disposeObject(child)
    }
  }

  function sync() {
    if (disposed) return
    updateEffectAudition()
    const props = getProps()
    if (!fitted) {
      const initial = initialDocumentOrbit(props.shown)
      orbit.target.copy(initial.target)
      orbit.radius = initial.radius
      orbit.theta = initial.theta
      orbit.phi = initial.phi
      fitted = true
    }
    host.classList.toggle('is-read-only', Boolean(props.disabled))
    if (hotObject) (hotObject.userData as PickData).hot = false
    hotObject = null
    clearGroup(contentRoot)
    clearGroup(handleRoot)
    props.shown.regions.forEach((region) => {
      region.areas.forEach((area, index) => {
        const selected = props.selection?.kind === 'region' && props.selection.id === region.id && props.selection.area === index
        addAreaMesh(region.id, index, area, selected, props.tool === 'select', editingBandAuthorY(props.shown))
      })
    })
    for (const point of props.shown.landmarks) {
      const selected = props.selection?.kind === 'landmark' && props.selection.id === point.id
      addLandmarkMesh(point.id, point.param.x, point.param.y, point.param.z, selected, props.tool === 'select')
    }
    if (props.draftPoints.length > 0) addDraft(props.draftPoints)
    resize()
  }

  function addAreaMesh(regionId: string, index: number, area: LevelArea, selected: boolean, handles: boolean, bandY: number) {
    if (area.y === 'all') addAllHeightGhost(area)
    const display = area.y === 'all' ? { ...area, y: [bandY, bandY] as [number, number] } : area
    const geometry = buildAreaGeometry(display, orbit.radius)
    if (!geometry) return
    const mesh = new Mesh(geometry, selected ? selectedMaterial : areaMaterial)
    mesh.renderOrder = 2
    const data = mesh.userData as PickData
    data.pick = 'area'
    data.regionId = regionId
    data.index = index
    data.sharedMaterial = true
    const edges = new LineSegments(new EdgesGeometry(geometry), selected ? selectedEdgeMaterial : edgeMaterial)
    edges.raycast = () => {}
    edges.renderOrder = 3
    ;(edges.userData as PickData).sharedMaterial = true
    mesh.add(edges)
    contentRoot.add(mesh)
    if (handles && selected) addAreaHandles(regionId, index, area, bandY)
  }

  function addAllHeightGhost(area: LevelArea) {
    const column = buildAreaGeometry(area, orbit.radius)
    if (!column) return
    const ghost = new Mesh(column, ghostMaterial)
    ghost.raycast = () => {}
    ghost.renderOrder = 0
    ;(ghost.userData as PickData).sharedMaterial = true
    const outline = new LineSegments(new EdgesGeometry(column), ghostEdgeMaterial)
    outline.raycast = () => {}
    outline.renderOrder = 1
    ;(outline.userData as PickData).sharedMaterial = true
    ghost.add(outline)
    contentRoot.add(ghost)
  }

  function addAreaHandles(regionId: string, index: number, area: LevelArea, bandY: number) {
    const [y0, y1] = area.y === 'all' ? worldYSpan([bandY, bandY]) : worldYSpan(area.y)
    const midY = (y0 + y1) / 2
    const center = areaWorldCenter(area)
    if (area.kind === 'rect') {
      const box = rectWorldBox(area.x, area.z, area.y === 'all' ? [bandY, bandY] : area.y)
      const midX = (box.minX + box.maxX) / 2
      const midZ = (box.minZ + box.maxZ) / 2
      addHandle(box.minX, midY, midZ, regionId, index, 'rect', 'minX')
      addHandle(box.maxX, midY, midZ, regionId, index, 'rect', 'maxX')
      addHandle(midX, midY, box.minZ, regionId, index, 'rect', 'minZ')
      addHandle(midX, midY, box.maxZ, regionId, index, 'rect', 'maxZ')
      const corners: [RectHandle, number, number][] = [
        ['minXminZ', box.minX, box.minZ],
        ['maxXminZ', box.maxX, box.minZ],
        ['minXmaxZ', box.minX, box.maxZ],
        ['maxXmaxZ', box.maxX, box.maxZ],
      ]
      for (const [edge, x, z] of corners) addHandle(x, midY, z, regionId, index, 'rect', edge)
    } else if (area.kind === 'circle') {
      const [centerX, centerZ] = circleWorldCenter(area.center[0], area.center[1])
      addHandle(decimalAdd(centerX, area.radius), midY, centerZ, regionId, index, 'radius')
    } else {
      area.points.forEach(([x, z], vertex) => {
        const [worldX, worldZ] = polygonWorldPoint(x, z)
        addHandle(worldX, midY, worldZ, regionId, index, 'vertex', undefined, vertex)
      })
    }
    addHandle(center[0], midY, center[1], regionId, index, 'move')
    if (area.y === 'all') return
    addHandle(center[0], y1, center[1], regionId, index, 'y', 'max')
    addHandle(center[0], y0, center[1], regionId, index, 'y', 'min')
  }

  function addHandle(
    x: number,
    y: number,
    z: number,
    regionId: string,
    index: number,
    handle: PickData['handle'],
    edge?: string,
    vertex?: number,
  ) {
    const mesh = new Mesh(handleGeometry, materialForHandle(handle, edge))
    mesh.position.set(x, y, z)
    const data = mesh.userData as PickData
    data.pick = 'handle'
    data.regionId = regionId
    data.index = index
    data.handle = handle
    data.edge = edge
    data.vertex = vertex
    data.sharedGeometry = true
    data.sharedMaterial = true
    data.pixelTarget = HANDLE_TARGET_PX
    data.baseSize = 0.7
    handleRoot.add(mesh)
  }

  function materialForHandle(handle: PickData['handle'], edge?: string): Material {
    if (handle === 'y' || handle === 'landmark-y') return yHandleMaterial
    if (handle === 'radius') return radiusHandleMaterial
    if (handle === 'move') return moveHandleMaterial
    if (edge === 'minX' || edge === 'maxX') return xHandleMaterial
    if (edge === 'minZ' || edge === 'maxZ') return zHandleMaterial
    return cornerHandleMaterial
  }

  function addLandmarkMesh(id: string, x: number, y: number, z: number, selected: boolean, handles: boolean) {
    const mesh = new Mesh(markerGeometry, selected ? selectedLandmarkMaterial : landmarkMaterial)
    mesh.position.set(x, y, z)
    const data = mesh.userData as PickData
    data.pick = 'landmark'
    data.landmarkId = id
    data.sharedGeometry = true
    data.sharedMaterial = true
    data.pixelTarget = LANDMARK_TARGET_PX
    data.baseSize = 1
    contentRoot.add(mesh)
    if (!handles || !selected) return
    const knob = new Mesh(handleGeometry, yHandleMaterial)
    knob.position.set(x, decimalAdd(y, LANDMARK_Y_AXIS), z)
    const knobData = knob.userData as PickData
    knobData.pick = 'handle'
    knobData.handle = 'landmark-y'
    knobData.landmarkId = id
    knobData.sharedGeometry = true
    knobData.sharedMaterial = true
    knobData.pixelTarget = HANDLE_TARGET_PX
    knobData.baseSize = 0.7
    handleRoot.add(knob)
  }

  function addDraft(points: readonly [number, number][]) {
    const band = editingBandAuthorY(getProps().shown)
    const world = points.map(([x, z]) => polygonWorldPoint(x, z))
    const geometry = new BufferGeometry().setFromPoints(world.map(([x, z]) => new Vector3(x, band + 0.08, z)))
    const line = new Line(geometry, draftMaterial)
    line.raycast = () => {}
    ;(line.userData as PickData).sharedMaterial = true
    contentRoot.add(line)
    for (const [x, z] of world) {
      const marker = new Mesh(markerGeometry, selectedMaterial)
      marker.position.set(x, band, z)
      const markerData = marker.userData as PickData
      markerData.sharedGeometry = true
      markerData.sharedMaterial = true
      markerData.pixelTarget = 8
      markerData.baseSize = 1
      contentRoot.add(marker)
    }
  }

  function dispose() {
    if (disposed) return
    disposed = true
    cancelGesture()
    stopNavigation()
    host.removeEventListener('pointerdown', onPointerDown)
    host.removeEventListener('pointermove', onPointerMove)
    host.removeEventListener('pointerup', onPointerUp)
    host.removeEventListener('pointercancel', onPointerCancel)
    host.removeEventListener('lostpointercapture', onLostPointerCapture)
    host.removeEventListener('wheel', onWheel)
    host.removeEventListener('contextmenu', onContextMenu)
    window.removeEventListener('keydown', onEscape, true)
    host.removeEventListener('keydown', onHostKey)
    host.removeEventListener('keyup', onHostKeyUp)
    host.removeEventListener('blur', onBlur)
    window.removeEventListener('blur', onBlur)
    document.removeEventListener('visibilitychange', onVisibility)
    observer.disconnect()
    clearGroup(contentRoot)
    clearGroup(handleRoot)
    setHint(null)
    disposeObject(gizmo)
    disposeObject(scene)
    handleGeometry.dispose()
    markerGeometry.dispose()
    for (const material of sharedMaterials) material.dispose()
    renderer.dispose()
    renderer.forceContextLoss()
    renderer.domElement.remove()
  }

  const observer = new ResizeObserver(() => resize())
  host.addEventListener('pointerdown', onPointerDown)
  host.addEventListener('pointermove', onPointerMove)
  host.addEventListener('pointerup', onPointerUp)
  host.addEventListener('pointercancel', onPointerCancel)
  host.addEventListener('lostpointercapture', onLostPointerCapture)
  host.addEventListener('wheel', onWheel, { passive: false })
  host.addEventListener('contextmenu', onContextMenu)
  window.addEventListener('keydown', onEscape, true)
  host.addEventListener('keydown', onHostKey)
  host.addEventListener('keyup', onHostKeyUp)
  host.addEventListener('blur', onBlur)
  window.addEventListener('blur', onBlur)
  document.addEventListener('visibilitychange', onVisibility)
  observer.observe(host)
  resize()

  return { sync, audition() { updateEffectAudition(); render() }, cancelGesture, applyCommand, dispose }
}

function isRectHandle(edge: string | undefined): edge is RectHandle {
  return edge === 'minX' || edge === 'maxX' || edge === 'minZ' || edge === 'maxZ'
    || edge === 'minXminZ' || edge === 'maxXminZ' || edge === 'minXmaxZ' || edge === 'maxXmaxZ'
}

function rectHandleAnchor(area: LevelRectArea, edge: RectHandle): { x: number; z: number } {
  const box = rectWorldBox(area.x, area.z, area.y)
  const x = edge.includes('minX') ? box.minX : edge.includes('maxX') ? box.maxX : (box.minX + box.maxX) / 2
  const z = edge.includes('minZ') ? box.minZ : edge.includes('maxZ') ? box.maxZ : (box.minZ + box.maxZ) / 2
  return { x, z }
}

function areaWorldCenter(area: LevelArea): [number, number] {
  if (area.kind === 'rect') {
    const box = rectWorldBox(area.x, area.z, area.y)
    return [(box.minX + box.maxX) / 2, (box.minZ + box.maxZ) / 2]
  }
  if (area.kind === 'circle') return circleWorldCenter(area.center[0], area.center[1])
  const world = area.points.map(([x, z]) => polygonWorldPoint(x, z))
  const x = world.reduce((sum, point) => sum + point[0], 0) / world.length
  const z = world.reduce((sum, point) => sum + point[1], 0) / world.length
  return [x, z]
}

function disposeObject(object: Object3D) {
  object.traverse((child) => {
    const mesh = child as Mesh
    const data = mesh.userData as PickData
    if (mesh.geometry && !data.sharedGeometry) mesh.geometry.dispose()
    const material = mesh.material as Material | Material[] | undefined
    if (!material || data.sharedMaterial) return
    if (Array.isArray(material)) for (const item of material) item.dispose()
    else material.dispose()
  })
}
