// Escena 3D del gemelo digital. Dibuja lo que calcula `twin-model.ts`; no
// conoce la API ni React. Se carga aparte (Three.js pesa) sólo al abrir el
// Mapa vivo.

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { DocumentListItem } from '@/lib/api'
import { date, moneyShort, qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { documentNode, type NodeId } from './flow-model'
import {
  docFamily,
  PLACE_IDS,
  PLACES,
  ROUTES,
  type DocFamily,
  type FiscoInfo,
  type Place,
  type PlaceId,
  type RouteKind,
  type RouteTruck,
  type ShapeKind,
  type StaffFigure,
  type StockPile,
  type Truck,
  type WorkInProgress,
} from './twin-model'

export interface TwinState {
  docs: DocumentListItem[]
  docCounts: Partial<Record<NodeId, number>>
  taskCounts: Partial<Record<NodeId, number>>
  trucks: Truck[]
  /** Las hojas de ruta abiertas, los vehículos estacionados y los remitos en preparación. */
  routes: RouteTruck[]
  parked: { id: string; label: string }[]
  packages: { docId: string; label: string }[]
  piles: StockPile[]
  wip: WorkInProgress[]
  /** El personal del legajo; null si el rol no puede leerlo (quedan figuras genéricas). */
  staff: StaffFigure[] | null
  /** Saldo de los bancos y deuda con el fisco; null si el rol no los puede leer. */
  bank: number | null
  fisco: FiscoInfo | null
  focus: NodeId | null
  activeNode: NodeId | null
  selectedDocId: string | null
}

export interface TwinCallbacks {
  onSelectPlace: (id: NodeId) => void
  onSelectDoc: (id: string) => void
}

// Paleta GEST-AR y tonos neutros: la escena tiene que verse sobria.
const C = {
  navy: 0x1c2b4a,
  blue: 0x185fa5,
  celeste: 0xe8f1fa,
  ground: 0xdfe5ec,
  slab: 0xf4f6f9,
  office: 0xe8f1fa,
  warehouse: 0xe6e9ee,
  plant: 0xece8e1,
  outside: 0xcfd6df,
  focus: 0xc7ddf3,
  wall: 0xffffff,
  desk: 0xb9c4d2,
  head: 0xd8c3a9,
  rack: 0x8c97a6,
  ok: 0x185fa5,
  warning: 0xd49a2a,
  danger: 0xc0392b,
  truckIn: 0x6b7a90,
  truckOut: 0x185fa5,
  wheel: 0x2b2f36,
  machine: 0x7d8796,
  belt: 0x4a5261,
  wood: 0xa97b4f,
  carrier: 0x0f8a7e,
  pallet: 0xb08d57,
  cardboard: 0xc9a46c,
  pine: 0xd9b382,
  eucalyptus: 0xa0613a,
  mdf: 0xe6dccb,
  phenolic: 0x6b4f3a,
  mattress: 0xf1f4f8,
  stripe: 0x7fa9d6,
  metal: 0x9aa3ad,
  film: 0xdfe7ef,
  fisco: 0xd8cfbf,
  column: 0xf3efe6,
}

const FAMILY_COLORS: Record<DocFamily, number> = {
  purchasing: 0x185fa5,
  sales: 0x0f8a7e,
  production: 0x8a5a2b,
  money: 0x2e7d32,
}

const ROUTE_COLORS: Record<RouteKind, number> = {
  goods: 0x9aa5b4,
  paper: 0x7fa9d6,
  money: 0x7fbf8a,
}

const FLOOR_Y = 0.15
const ENVELOPE = { w: 1, h: 0.14, d: 0.7 }
const STACK = 6
const MAX_ENVELOPES = 18
const HOME = { direction: new THREE.Vector3(0, 1, 0.85).normalize(), target: new THREE.Vector3(0, 0, -4) }

interface Tween {
  obj: THREE.Object3D
  from: THREE.Vector3
  to: THREE.Vector3
  arc: number
  start: number
  duration: number
  scaleFrom?: number
  scaleTo?: number
  done?: () => void
}

interface PlaceView {
  floor: THREE.Mesh<THREE.BoxGeometry, THREE.MeshStandardMaterial>
  base: number
  label: HTMLButtonElement | HTMLDivElement
  docsBadge: HTMLSpanElement | null
  tasksBadge: HTMLSpanElement | null
  /** Personas del legajo en el sector. */
  staffBadge: HTMLSpanElement | null
  /** Lo que muestran el Banco y el Fisco (saldo, deuda). */
  infoEl: HTMLSpanElement | null
  people: THREE.Object3D[]
}

export function webglAvailable(): boolean {
  try {
    const canvas = document.createElement('canvas')
    return Boolean(canvas.getContext('webgl2') ?? canvas.getContext('webgl'))
  } catch {
    return false
  }
}

export class TwinScene {
  private renderer: THREE.WebGLRenderer
  private labels: CSS2DRenderer
  private scene = new THREE.Scene()
  private camera: THREE.PerspectiveCamera
  private controls: OrbitControls
  private raycaster = new THREE.Raycaster()
  private pointer = new THREE.Vector2()
  private frame = 0
  private lastRender = 0
  private tweens: Tween[] = []
  private camTween: {
    fromPos: THREE.Vector3
    toPos: THREE.Vector3
    fromTarget: THREE.Vector3
    toTarget: THREE.Vector3
    start: number
  } | null = null
  private places = new Map<PlaceId, PlaceView>()
  private envelopes = new Map<string, THREE.Mesh>()
  private envelopePlace = new Map<string, NodeId>()
  private truckGroup = new THREE.Group()
  private truckKey = ''
  private pileGroup = new THREE.Group()
  private pileKey = ''
  private pileLabels: CSS2DObject[] = []
  /** Si la cámara está cerca: recién ahí se ven los carteles de cada producto. */
  private near = false
  private staffGroup = new THREE.Group()
  private staffKey: string | null = null
  private routeGroup = new THREE.Group()
  private routeKey = ''
  private wipGroup = new THREE.Group()
  private wipKey = ''
  private movingTrucks: { group: THREE.Group; x0: number; x1: number; offset: number }[] = []
  private beltBoxes: THREE.Mesh[] = []
  private producing = false
  private pulse: THREE.Mesh
  private selectRing: THREE.Mesh
  private replayEnvelope: THREE.Mesh
  private replayTrail: THREE.Line
  private replayKey = ''
  private tip: CSS2DObject
  private tipEl: HTMLDivElement
  private reduced: boolean
  private resize: ResizeObserver
  private downAt: { x: number; y: number } | null = null
  private disposed = false
  private atHome = true
  private narrow = false

  constructor(
    private container: HTMLElement,
    private callbacks: TwinCallbacks,
  ) {
    this.reduced = window.matchMedia('(prefers-reduced-motion: reduce)').matches

    this.renderer = new THREE.WebGLRenderer({ antialias: true })
    this.renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    this.renderer.shadowMap.enabled = true
    this.renderer.shadowMap.type = THREE.PCFSoftShadowMap
    this.renderer.domElement.style.display = 'block'
    this.renderer.domElement.setAttribute('aria-hidden', 'true')
    container.appendChild(this.renderer.domElement)

    this.labels = new CSS2DRenderer()
    Object.assign(this.labels.domElement.style, { position: 'absolute', inset: '0', pointerEvents: 'none' })
    container.appendChild(this.labels.domElement)

    this.camera = new THREE.PerspectiveCamera(42, 1, 0.5, 300)
    this.camera.position.copy(HOME.direction).multiplyScalar(50).add(HOME.target)
    this.controls = new OrbitControls(this.camera, this.renderer.domElement)
    this.controls.target.copy(HOME.target)
    this.controls.enableDamping = !this.reduced
    this.controls.dampingFactor = 0.08
    this.controls.minDistance = 10
    this.controls.maxDistance = 90
    // Si el estudiante movió la cámara, un cambio de tamaño no se la devuelve al inicio.
    this.controls.addEventListener('start', () => {
      this.atHome = false
      this.camTween = null
    })
    this.controls.maxPolarAngle = 1.3
    this.controls.screenSpacePanning = false
    this.controls.update()

    this.scene.background = new THREE.Color(0xf7f9fb)
    this.scene.add(new THREE.HemisphereLight(0xffffff, 0xc9d3de, 1.6))
    const sun = new THREE.DirectionalLight(0xffffff, 1.6)
    sun.position.set(-18, 32, 20)
    sun.castShadow = true
    sun.shadow.mapSize.set(1024, 1024)
    Object.assign(sun.shadow.camera, { left: -32, right: 32, top: 26, bottom: -26, near: 1, far: 90 })
    sun.shadow.camera.updateProjectionMatrix()
    this.scene.add(sun)

    this.buildGround()
    this.buildRoutes()
    for (const id of PLACE_IDS) this.buildPlace(id)
    this.buildBelt()
    this.scene.add(this.truckGroup, this.pileGroup, this.staffGroup, this.routeGroup, this.wipGroup)

    this.pulse = new THREE.Mesh(
      new THREE.RingGeometry(0.9, 1, 48),
      new THREE.MeshBasicMaterial({ color: C.blue, transparent: true, opacity: 0.55, side: THREE.DoubleSide }),
    )
    this.pulse.rotation.x = -Math.PI / 2
    this.pulse.visible = false
    this.scene.add(this.pulse)

    this.selectRing = new THREE.Mesh(
      new THREE.TorusGeometry(0.55, 0.05, 8, 32),
      new THREE.MeshBasicMaterial({ color: C.navy }),
    )
    this.selectRing.rotation.x = -Math.PI / 2
    this.selectRing.visible = false
    this.scene.add(this.selectRing)

    this.replayEnvelope = new THREE.Mesh(
      new THREE.BoxGeometry(1.3, 0.16, 0.9),
      new THREE.MeshStandardMaterial({ color: C.navy, emissive: C.blue, emissiveIntensity: 0.35 }),
    )
    this.replayEnvelope.castShadow = true
    this.replayEnvelope.visible = false
    this.scene.add(this.replayEnvelope)
    this.replayTrail = new THREE.Line(
      new THREE.BufferGeometry(),
      new THREE.LineBasicMaterial({ color: C.navy, transparent: true, opacity: 0.8 }),
    )
    this.replayTrail.visible = false
    this.scene.add(this.replayTrail)

    this.tipEl = document.createElement('div')
    this.tipEl.className =
      'pointer-events-none whitespace-nowrap rounded-md bg-[#1C2B4A] px-2 py-1 text-[11px] font-medium text-white shadow'
    this.tip = new CSS2DObject(this.tipEl)
    this.tip.center.set(0.5, 1.4)
    this.tip.visible = false
    this.scene.add(this.tip)

    const canvas = this.renderer.domElement
    canvas.addEventListener('pointerdown', this.onPointerDown)
    canvas.addEventListener('pointerup', this.onPointerUp)
    canvas.addEventListener('pointermove', this.onPointerMove)
    canvas.addEventListener('pointerleave', this.onPointerLeave)

    this.resize = new ResizeObserver(() => this.fit())
    this.resize.observe(container)
    this.fit()
    this.frame = requestAnimationFrame(this.loop)
  }

  /** Vuelca el estado actual de la empresa en la escena. */
  update(state: TwinState) {
    this.syncStaff(state.staff)
    for (const [id, view] of this.places) {
      if (id === 'BAN' || id === 'FIS') this.updateOutside(id, view, state)
      if (!isNode(id)) continue
      const docs = state.docCounts[id] ?? 0
      const tasks = state.taskCounts[id] ?? 0
      if (view.docsBadge) {
        view.docsBadge.textContent = String(docs)
        view.docsBadge.hidden = docs === 0
      }
      if (view.tasksBadge) {
        view.tasksBadge.textContent = String(tasks)
        view.tasksBadge.hidden = tasks === 0
      }
      view.floor.material.color.setHex(state.focus === id ? C.focus : view.base)
      view.label.classList.toggle('ring-2', state.focus === id)
      for (const person of view.people) person.userData.busy = tasks > 0
    }
    this.syncEnvelopes(state)
    this.syncTrucks(state.trucks)
    this.syncRoutes(state.routes, state.parked, state.packages)
    this.syncPiles(state.piles)
    this.syncWip(state.wip)
    this.producing = state.docs.some((doc) => doc.doc_type === 'PRODUCTION_ORDER')
    for (const box of this.beltBoxes) box.visible = this.producing

    if (state.activeNode) {
      const place = PLACES[state.activeNode]
      this.pulse.position.set(place.x, FLOOR_Y + 0.05, place.z)
      this.pulse.userData.size = Math.max(place.w, place.d) * 0.62
      this.pulse.visible = true
    } else {
      this.pulse.visible = false
    }
  }

  /** Lleva la cámara al sector, o a la vista general si no hay ninguno. */
  focusPlace(id: NodeId | null) {
    this.atHome = !id
    if (!id) {
      this.flyTo(this.homePosition(), HOME.target.clone())
      return
    }
    const place = PLACES[id]
    const target = new THREE.Vector3(place.x, 0, place.z)
    const offset = new THREE.Vector3(0, 15, 14)
    this.flyTo(target.clone().add(offset), target)
  }

  resetView() {
    this.focusPlace(null)
  }

  /**
   * Recorrido de un documento: el sobre grande salta de sector en sector hasta
   * el paso `index` y deja una huella por donde pasó.
   */
  setReplay(steps: NodeId[] | null, index: number) {
    if (!steps || steps.length === 0 || index < 0) {
      this.replayEnvelope.visible = false
      this.replayTrail.visible = false
      this.replayKey = ''
      return
    }
    const key = `${steps.join('>')}#${index}`
    if (key === this.replayKey) return
    const previous = this.replayKey
    this.replayKey = key
    const visited = steps.slice(0, index + 1).map((id) => placeTop(id, 2.4))
    const to = visited[visited.length - 1]
    const from = previous && this.replayEnvelope.visible ? this.replayEnvelope.position.clone() : to
    this.replayEnvelope.visible = true
    this.tween({ obj: this.replayEnvelope, from, to, arc: from.distanceTo(to) > 0.5 ? 4 : 0, duration: 1100 })
    this.replayTrail.geometry.dispose()
    this.replayTrail.geometry = new THREE.BufferGeometry().setFromPoints(
      visited.map((p) => new THREE.Vector3(p.x, 0.35, p.z)),
    )
    this.replayTrail.visible = visited.length > 1
  }

  dispose() {
    this.disposed = true
    cancelAnimationFrame(this.frame)
    this.resize.disconnect()
    const canvas = this.renderer.domElement
    canvas.removeEventListener('pointerdown', this.onPointerDown)
    canvas.removeEventListener('pointerup', this.onPointerUp)
    canvas.removeEventListener('pointermove', this.onPointerMove)
    canvas.removeEventListener('pointerleave', this.onPointerLeave)
    this.controls.dispose()
    this.scene.traverse((obj) => {
      if (obj instanceof THREE.Mesh || obj instanceof THREE.Line) {
        obj.geometry.dispose()
        const material = obj.material as THREE.Material | THREE.Material[]
        for (const m of Array.isArray(material) ? material : [material]) m.dispose()
      }
    })
    this.renderer.dispose()
    canvas.remove()
    this.labels.domElement.remove()
  }

  // --- construcción ---------------------------------------------------------

  private buildGround() {
    const ground = new THREE.Mesh(new THREE.PlaneGeometry(90, 70), new THREE.MeshStandardMaterial({ color: C.ground }))
    ground.rotation.x = -Math.PI / 2
    ground.receiveShadow = true
    this.scene.add(ground)

    // La nave de la empresa: todo lo que no es proveedores, clientes ni banco.
    const slab = new THREE.Mesh(new THREE.BoxGeometry(37, 0.1, 26), new THREE.MeshStandardMaterial({ color: C.slab }))
    slab.position.set(-0.5, 0.05, -4.5)
    slab.receiveShadow = true
    this.scene.add(slab)

    // Pasillo que separa las oficinas de la planta.
    const aisle = new THREE.Mesh(
      new THREE.BoxGeometry(35, 0.02, 1.2),
      new THREE.MeshStandardMaterial({ color: 0xd5dde7 }),
    )
    aisle.position.set(-0.5, 0.11, -2)
    this.scene.add(aisle)
  }

  private buildRoutes() {
    for (const route of ROUTES) {
      const a = PLACES[route.from]
      const b = PLACES[route.to]
      const from = new THREE.Vector3(a.x, 0, a.z)
      const to = new THREE.Vector3(b.x, 0, b.z)
      const length = from.distanceTo(to)
      const strip = new THREE.Mesh(
        new THREE.PlaneGeometry(route.kind === 'goods' ? 0.5 : 0.22, length),
        new THREE.MeshBasicMaterial({ color: ROUTE_COLORS[route.kind], transparent: true, opacity: 0.85 }),
      )
      strip.rotation.x = -Math.PI / 2
      strip.rotation.z = -Math.atan2(to.x - from.x, to.z - from.z) + Math.PI
      strip.position.set((a.x + b.x) / 2, 0.12, (a.z + b.z) / 2)
      this.scene.add(strip)
    }
  }

  private buildPlace(id: PlaceId) {
    const place = PLACES[id]
    const base =
      place.kind === 'office'
        ? C.office
        : place.kind === 'warehouse'
          ? C.warehouse
          : place.kind === 'plant'
            ? C.plant
            : C.outside
    const floor = new THREE.Mesh(
      new THREE.BoxGeometry(place.w, FLOOR_Y, place.d),
      new THREE.MeshStandardMaterial({ color: base }),
    )
    floor.position.set(place.x, FLOOR_Y / 2 + 0.05, place.z)
    floor.receiveShadow = true
    if (isNode(id)) floor.userData = { placeId: id, tip: place.label }
    this.scene.add(floor)

    // Paredes bajas al fondo y a un costado: alcanza para leer el sector sin tapar.
    if (place.kind !== 'outside') {
      const wallMat = new THREE.MeshStandardMaterial({ color: C.wall })
      const height = place.kind === 'office' ? 0.9 : 1.6
      const back = new THREE.Mesh(new THREE.BoxGeometry(place.w, height, 0.15), wallMat)
      back.position.set(place.x, FLOOR_Y + height / 2, place.z - place.d / 2 + 0.075)
      const side = new THREE.Mesh(new THREE.BoxGeometry(0.15, height, place.d), wallMat)
      side.position.set(place.x - place.w / 2 + 0.075, FLOOR_Y + height / 2, place.z)
      for (const wall of [back, side]) {
        wall.castShadow = true
        wall.receiveShadow = true
        this.scene.add(wall)
      }
    }

    // Los muebles del sector; a las personas las pone syncStaff, con el legajo.
    if (place.kind === 'office') {
      for (const x of deskSpots(place)) this.addDesk(x, place.z - 0.6)
    } else if (place.kind === 'plant') {
      for (const x of stationSpots(place)) this.addMachine(x, place.z - 1.6)
    } else if (place.kind === 'outside') {
      this.addBuilding(id, place.x, place.z - (id === 'BAN' || id === 'FIS' ? 0 : place.d / 2 - 1.8))
    }

    const label = document.createElement(isNode(id) ? 'button' : 'div') as HTMLButtonElement | HTMLDivElement
    label.className = cn(
      'pointer-events-auto flex items-center gap-1 rounded-full border bg-white/95 px-2 py-0.5 text-[11px] font-semibold text-[#1C2B4A] shadow-sm ring-[#185FA5]',
      isNode(id) ? 'cursor-pointer hover:border-[#185FA5]' : 'pointer-events-none text-[#5b6677]',
    )
    const name = document.createElement('span')
    name.textContent = place.label
    label.appendChild(name)
    let docsBadge: HTMLSpanElement | null = null
    let tasksBadge: HTMLSpanElement | null = null
    let staffBadge: HTMLSpanElement | null = null
    let infoEl: HTMLSpanElement | null = null
    if (isNode(id)) {
      docsBadge = badge('bg-[#185FA5] text-white', 'documentos abiertos')
      tasksBadge = badge('bg-amber-400 text-[#1C2B4A]', 'tareas pendientes')
      staffBadge = badge('bg-slate-200 text-[#1C2B4A]', 'personas del legajo')
      label.append(staffBadge, docsBadge, tasksBadge)
      label.addEventListener('click', () => this.callbacks.onSelectPlace(id))
      if (label instanceof HTMLButtonElement) label.type = 'button'
    }
    if (id === 'BAN' || id === 'FIS') {
      infoEl = document.createElement('span')
      infoEl.className = 'font-normal text-[#1C2B4A]'
      infoEl.hidden = true
      label.appendChild(infoEl)
    }
    const anchor = new CSS2DObject(label)
    anchor.position.set(place.x, place.kind === 'office' ? 2.2 : 3.6, place.z - place.d / 2 + 0.4)
    this.scene.add(anchor)

    this.places.set(id, { floor, base, label, docsBadge, tasksBadge, staffBadge, infoEl, people: [] })
  }

  private addDesk(x: number, z: number) {
    const desk = new THREE.Mesh(new THREE.BoxGeometry(1.6, 0.7, 0.8), new THREE.MeshStandardMaterial({ color: C.desk }))
    desk.position.set(x, FLOOR_Y + 0.35, z)
    desk.castShadow = true
    this.scene.add(desk)
    const screen = new THREE.Mesh(
      new THREE.BoxGeometry(0.6, 0.4, 0.05),
      new THREE.MeshStandardMaterial({ color: C.navy }),
    )
    screen.position.set(x, FLOOR_Y + 0.95, z - 0.2)
    this.scene.add(screen)
  }

  /** Una persona: el cartel dice quién es y un clic abre su sector. */
  private makePerson(x: number, z: number, tip: string, placeId: NodeId) {
    const person = new THREE.Group()
    const body = new THREE.Mesh(
      new THREE.CapsuleGeometry(0.22, 0.5, 4, 10),
      new THREE.MeshStandardMaterial({ color: C.navy }),
    )
    body.position.y = 0.48
    const head = new THREE.Mesh(
      new THREE.SphereGeometry(0.19, 16, 12),
      new THREE.MeshStandardMaterial({ color: C.head }),
    )
    head.position.y = 1.08
    for (const part of [body, head]) {
      part.castShadow = true
      part.userData = { placeId, tip }
    }
    person.add(body, head)
    person.position.set(x, FLOOR_Y, z)
    person.userData = { busy: false, phase: Math.random() * Math.PI * 2 }
    return person
  }

  private addMachine(x: number, z: number) {
    const mat = new THREE.MeshStandardMaterial({ color: C.machine })
    const body = new THREE.Mesh(new THREE.BoxGeometry(2.2, 1.3, 1.4), mat)
    body.position.set(x, FLOOR_Y + 0.65, z)
    const drum = new THREE.Mesh(
      new THREE.CylinderGeometry(0.35, 0.35, 1.6, 16),
      new THREE.MeshStandardMaterial({ color: C.navy }),
    )
    drum.rotation.z = Math.PI / 2
    drum.position.set(x, FLOOR_Y + 1.5, z)
    for (const part of [body, drum]) {
      part.castShadow = true
      this.scene.add(part)
    }
  }

  private addBuilding(id: PlaceId, x: number, z: number) {
    const tall = id === 'BAN' || id === 'FIS'
    const mat = new THREE.MeshStandardMaterial({ color: id === 'BAN' ? 0xb8c6d6 : id === 'FIS' ? C.fisco : 0xc2cad4 })
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.4, tall ? 2.6 : 2, 2.6), mat)
    body.position.set(x, FLOOR_Y + (tall ? 1.3 : 1), z)
    body.castShadow = true
    if (id === 'BAN') body.userData = { tip: 'Banco: por acá pasan los pagos y los cobros' }
    if (id === 'FIS') body.userData = { tip: 'Fisco: recibe las declaraciones de Impuestos y los pagos de Tesorería' }
    this.scene.add(body)
    const roof = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.25, 3), new THREE.MeshStandardMaterial({ color: C.navy }))
    roof.position.set(x, body.position.y * 2 + 0.12, z)
    this.scene.add(roof)
    // El banco y el fisco tienen columnas al frente: no se confunden con un proveedor o un cliente.
    if (tall) {
      const columnMat = new THREE.MeshStandardMaterial({ color: C.column })
      for (const dx of [-1.2, -0.4, 0.4, 1.2]) {
        const column = new THREE.Mesh(new THREE.CylinderGeometry(0.12, 0.12, 2.4, 12), columnMat)
        column.position.set(x + dx, FLOOR_Y + 1.2, z + 1.5)
        column.castShadow = true
        this.scene.add(column)
      }
    }
  }

  /** Cinta de Producción: de materias primas a terminados. Corre si hay órdenes abiertas. */
  private buildBelt() {
    const a = PLACES.DEP_MP
    const b = PLACES.DEP_PT
    const z = PLACES.PRO.z + 2
    const from = a.x + a.w / 2 - 1
    const to = b.x - b.w / 2 + 1
    const belt = new THREE.Mesh(
      new THREE.BoxGeometry(to - from, 0.25, 0.9),
      new THREE.MeshStandardMaterial({ color: C.belt }),
    )
    belt.position.set((from + to) / 2, FLOOR_Y + 0.5, z)
    belt.castShadow = true
    this.scene.add(belt)
    for (let i = 0; i < 4; i++) {
      const box = new THREE.Mesh(
        new THREE.BoxGeometry(0.6, 0.4, 0.6),
        new THREE.MeshStandardMaterial({ color: C.wood }),
      )
      box.castShadow = true
      box.userData = { from, to, offset: i / 4 }
      box.position.set(from, FLOOR_Y + 0.83, z)
      box.visible = false
      this.beltBoxes.push(box)
      this.scene.add(box)
    }
  }

  // --- sincronización -------------------------------------------------------

  private syncEnvelopes(state: TwinState) {
    const byPlace = new Map<NodeId, DocumentListItem[]>()
    for (const doc of state.docs) {
      const place = documentNode(doc)
      const list = byPlace.get(place) ?? []
      list.push(doc)
      byPlace.set(place, list)
    }
    const alive = new Set<string>()
    for (const [placeId, docs] of byPlace) {
      docs.sort((a, b) => a.created_at.localeCompare(b.created_at))
      docs.slice(-MAX_ENVELOPES).forEach((doc, index) => {
        alive.add(doc.id)
        const target = stackSlot(placeId, index)
        if (doc.id === state.selectedDocId) target.y += 0.6
        let mesh = this.envelopes.get(doc.id)
        if (!mesh) {
          mesh = new THREE.Mesh(
            new THREE.BoxGeometry(ENVELOPE.w, ENVELOPE.h, ENVELOPE.d),
            new THREE.MeshStandardMaterial({ color: FAMILY_COLORS[docFamily(doc.doc_type)] }),
          )
          mesh.castShadow = true
          mesh.position.copy(target)
          this.scene.add(mesh)
          this.envelopes.set(doc.id, mesh)
          this.tween({ obj: mesh, from: target, to: target, arc: 0, duration: 500, scaleFrom: 0.01, scaleTo: 1 })
        } else if (!mesh.position.equals(target)) {
          const moved = this.envelopePlace.get(doc.id) !== placeId
          this.tween({
            obj: mesh,
            from: mesh.position.clone(),
            to: target,
            arc: moved ? 5 : 0,
            duration: moved ? 1800 : 400,
          })
        }
        mesh.userData = { docId: doc.id, tip: `${doc.display_number} · ${doc.status_info?.label ?? doc.status}` }
        const material = mesh.material as THREE.MeshStandardMaterial
        material.emissive.setHex(doc.id === state.selectedDocId ? C.blue : 0x000000)
        material.emissiveIntensity = doc.id === state.selectedDocId ? 0.5 : 0
        this.envelopePlace.set(doc.id, placeId)
        if (doc.id === state.selectedDocId) {
          this.selectRing.position.set(target.x, FLOOR_Y + 0.25, target.z)
          this.selectRing.visible = true
        }
      })
    }
    if (!state.selectedDocId || !alive.has(state.selectedDocId)) this.selectRing.visible = false
    for (const [id, mesh] of this.envelopes) {
      if (alive.has(id)) continue
      this.envelopes.delete(id)
      this.envelopePlace.delete(id)
      mesh.userData = {}
      this.tween({
        obj: mesh,
        from: mesh.position.clone(),
        to: mesh.position.clone().setY(mesh.position.y + 1.5),
        arc: 0,
        duration: 600,
        scaleFrom: 1,
        scaleTo: 0.01,
        done: () => this.removeObject(mesh),
      })
    }
  }

  private syncTrucks(list: Truck[]) {
    const key = list.map((t) => `${t.direction}:${t.docId}`).join(',')
    if (key === this.truckKey) return
    this.truckKey = key
    this.clearGroup(this.truckGroup)
    const lanes = { in: 0, out: 0 }
    for (const truck of list) {
      const lane = lanes[truck.direction]++
      const place = PLACES[truck.direction === 'in' ? 'SUP' : 'CLI']
      const z = place.z - 1.4 + lane * 2.2
      const parked = new THREE.Vector3(truck.direction === 'in' ? place.x + 1.2 : place.x - 1.2, 0, z)
      const group = this.buildTruck(truck)
      group.position.copy(parked)
      if (truck.direction === 'in') {
        // Entra desde afuera hasta el muelle de recepción.
        this.tween({ obj: group, from: parked.clone().setX(parked.x - 9), to: parked, arc: 0, duration: 2600 })
      }
      this.truckGroup.add(group)
    }
  }

  private buildTruck(truck: Truck) {
    const group = this.vehicleModel(truck.direction === 'in' ? C.truckIn : C.truckOut)
    this.tagVehicle(group, `${truck.label}: mercadería en camino a Depósito`, truck.docId, truck.label)
    return group
  }

  /** Un camión con caja: mira hacia +x (la cabina adelante). */
  private vehicleModel(color: number) {
    const group = new THREE.Group()
    const cargo = new THREE.Mesh(new THREE.BoxGeometry(2.4, 1.2, 1.2), new THREE.MeshStandardMaterial({ color }))
    cargo.position.set(-0.4, 0.95, 0)
    const cab = new THREE.Mesh(new THREE.BoxGeometry(0.9, 0.9, 1.15), new THREE.MeshStandardMaterial({ color: C.wall }))
    cab.position.set(1.3, 0.8, 0)
    group.add(cargo, cab)
    const wheelGeo = new THREE.CylinderGeometry(0.25, 0.25, 0.2, 14)
    const wheelMat = new THREE.MeshStandardMaterial({ color: C.wheel })
    for (const x of [-1.1, 1.3]) {
      for (const z of [-0.6, 0.6]) {
        const wheel = new THREE.Mesh(wheelGeo, wheelMat)
        wheel.rotation.x = Math.PI / 2
        wheel.position.set(x, 0.3, z)
        group.add(wheel)
      }
    }
    return group
  }

  /** El cartel y el texto al pasar el mouse; con documento, un clic lo abre. */
  private tagVehicle(group: THREE.Group, tip: string, docId: string | null, text: string) {
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true
        obj.userData = docId ? { docId, tip } : { tip }
      }
    })
    const label = document.createElement('div')
    label.className = 'rounded bg-white/90 px-1.5 text-[10px] font-medium whitespace-nowrap text-[#1C2B4A] shadow-sm'
    label.textContent = text
    const anchor = new CSS2DObject(label)
    anchor.position.set(0, 2, 0)
    group.add(anchor)
  }

  /**
   * El personal: una figura por persona del legajo en su sector (en el taller, junto a la
   * máquina de su centro de trabajo). Sin acceso al legajo, figuras genéricas como antes.
   */
  private syncStaff(staff: StaffFigure[] | null) {
    const key = staff === null ? 'genérico' : staff.map((p) => `${p.id}:${p.place}:${p.station ?? ''}`).join(',')
    if (key === this.staffKey) return
    this.staffKey = key
    this.clearGroup(this.staffGroup)
    for (const view of this.places.values()) view.people = []
    const byPlace = new Map<NodeId, { tip: string; station: string | null }[]>()
    if (staff === null) {
      for (const id of PLACE_IDS) {
        if (!isNode(id)) continue
        const place = PLACES[id]
        const n =
          place.kind === 'office'
            ? deskSpots(place).length
            : place.kind === 'plant'
              ? 2
              : place.kind === 'warehouse'
                ? 1
                : 0
        byPlace.set(
          id,
          Array.from({ length: n }, () => ({ tip: `${place.label}: personal del sector`, station: null })),
        )
      }
    } else {
      for (const person of staff) {
        byPlace.set(person.place, [...(byPlace.get(person.place) ?? []), { tip: person.tip, station: person.station }])
      }
    }
    for (const [id, view] of this.places) {
      if (!isNode(id)) continue
      const list = byPlace.get(id) ?? []
      const shown = list.slice(0, MAX_PEOPLE)
      const atStation = new Map<number, number>()
      shown.forEach((person, i) => {
        const spot = staffSpot(PLACES[id], i, shown.length, person.station, atStation)
        const figure = this.makePerson(spot.x, spot.z, person.tip, id)
        this.staffGroup.add(figure)
        view.people.push(figure)
      })
      if (view.staffBadge) {
        view.staffBadge.textContent = `${list.length} pers.`
        view.staffBadge.hidden = staff === null || list.length === 0
      }
    }
  }

  /** El Banco muestra el saldo de los bancos; el Fisco, las declaraciones que falta pagar. */
  private updateOutside(id: 'BAN' | 'FIS', view: PlaceView, state: TwinState) {
    const el = view.infoEl
    if (!el) return
    if (id === 'BAN') {
      el.hidden = state.bank === null
      if (state.bank !== null) el.textContent = `· saldo ${moneyShort(state.bank)}`
      return
    }
    const fisco = state.fisco
    el.hidden = !fisco
    if (fisco) {
      el.textContent = fisco.pending
        ? `· ${fisco.pending} DJ por pagar (${moneyShort(fisco.amount)}), vence ${date(fisco.nextDue)}`
        : '· al día'
    }
  }

  /**
   * El reparto: las hojas de ruta cargan en el muelle de terminados o van y vienen por la
   * ruta hacia Clientes; el camión propio libre espera estacionado; los remitos en
   * preparación son bultos en el muelle.
   */
  private syncRoutes(
    routes: RouteTruck[],
    parked: { id: string; label: string }[],
    boxes: { docId: string; label: string }[],
  ) {
    const key = [
      routes.map((r) => `${r.docId}:${r.moving}`).join(','),
      parked.map((p) => p.id).join(','),
      boxes.map((b) => b.docId).join(','),
    ].join('|')
    if (key === this.routeKey) return
    this.routeKey = key
    this.clearGroup(this.routeGroup)
    this.movingTrucks = []
    const dock = PLACES.DEP_PT
    const front = dock.z + dock.d / 2
    let loading = 0
    routes.forEach((route, i) => {
      const group = this.vehicleModel(route.own ? C.truckOut : C.carrier)
      const stops = `${route.stops} ${route.stops === 1 ? 'remito' : 'remitos'}`
      this.tagVehicle(
        group,
        `${route.label}: ${route.transport} · ${route.moving ? `en camino con ${stops}` : `cargando ${stops}`}`,
        route.docId,
        route.moving ? `${route.label} en camino` : `${route.label} · cargando`,
      )
      if (route.moving) {
        const x0 = dock.x + 1
        const x1 = PLACES.CLI.x - 1.5
        group.position.set((x0 + x1) / 2, 0, front + 2.4 + this.movingTrucks.length * 1.6)
        this.movingTrucks.push({ group, x0, x1, offset: i * 0.37 })
      } else {
        // De culata al depósito, la cabina hacia afuera.
        group.rotation.y = -Math.PI / 2
        group.position.set(dock.x - 3 + loading++ * 3, 0, front + 1.6)
      }
      this.routeGroup.add(group)
    })
    parked.forEach((vehicle, i) => {
      const group = this.vehicleModel(C.truckOut)
      this.tagVehicle(group, `${vehicle.label}: estacionado, sin hoja de ruta`, null, `${vehicle.label} · estacionado`)
      group.position.set(dock.x - 3 + i * 3.2, 0, front + 5.4)
      this.routeGroup.add(group)
    })
    const palletMat = new THREE.MeshStandardMaterial({ color: C.pallet })
    const cartonMat = new THREE.MeshStandardMaterial({ color: C.cardboard })
    boxes.forEach((box, i) => {
      const group = new THREE.Group()
      const pallet = new THREE.Mesh(new THREE.BoxGeometry(1, 0.12, 0.8), palletMat)
      pallet.position.y = 0.06
      group.add(pallet)
      for (const [x, y, z] of [
        [-0.22, 0.28, -0.17],
        [0.22, 0.28, -0.17],
        [0, 0.28, 0.2],
        [0, 0.6, 0],
      ]) {
        const carton = new THREE.Mesh(new THREE.BoxGeometry(0.42, 0.32, 0.36), cartonMat)
        carton.position.set(x, y, z)
        group.add(carton)
      }
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) {
          obj.castShadow = true
          obj.userData = { docId: box.docId, tip: `${box.label}: remito en preparación` }
        }
      })
      group.position.set(dock.x + 1 + i * 1.25, FLOOR_Y, front - 0.9)
      this.routeGroup.add(group)
    })
  }

  /**
   * El stock con su forma: en terminados, una figura por unidad (hasta el tope) de cada
   * mueble; en materias primas, una placa por unidad y atados, latas, cajas y rollos con una
   * altura que sigue a la cantidad. La base marca la cobertura del mínimo; la barra oscura, la
   * reserva. De cerca, cada producto muestra su cantidad (en terminados, con el nombre).
   */
  private syncPiles(piles: StockPile[]) {
    const key = piles.map((p) => `${p.key}:${p.units}:${p.more}:${p.tone}:${p.reserved}`).join(',')
    if (key === this.pileKey) return
    this.pileKey = key
    this.clearGroup(this.pileGroup)
    this.pileLabels = []
    const mat = materials()
    const toneColor = { ok: C.ok, warning: C.warning, danger: C.danger }
    for (const placeId of ['DEP_MP', 'DEP_PT'] as const) {
      const place = PLACES[placeId]
      const list = piles.filter((p) => p.place === placeId)
      if (list.length === 0) continue
      // Los productos ocupan la parte de atrás; adelante queda el muelle.
      const cols = Math.min(6, Math.max(2, Math.ceil(Math.sqrt(list.length * 1.6))))
      const rows = Math.ceil(list.length / cols)
      const cell = Math.min((place.w - 1.2) / cols, placeId === 'DEP_PT' ? 2.6 : 1.6)
      const depth = Math.min((place.d - 3) / rows, placeId === 'DEP_PT' ? 2.4 : 1.8)
      list.forEach((pile, i) => {
        const group = new THREE.Group()
        const plinth = new THREE.Mesh(new THREE.BoxGeometry(cell * 0.92, 0.04, depth * 0.92), mat(toneColor[pile.tone]))
        plinth.position.y = 0.02
        group.add(plinth)
        if (pile.reserved) {
          const bar = new THREE.Mesh(new THREE.BoxGeometry(cell * 0.5, 0.05, 0.08), mat(C.navy))
          bar.position.set(0, 0.05, depth * 0.46)
          group.add(bar)
        }
        const color = productColor(pile.name, pile.shape)
        const goods = new THREE.Group()
        goods.position.y = 0.04
        if (isFurniture(pile.shape)) {
          arrangeUnits(goods, pile.shape, pile.units, cell * 0.88, depth * 0.88, () =>
            furniture(pile.shape, mat, color),
          )
        } else {
          bulk(goods, pile.shape, pile.units, cell, depth, mat, color)
        }
        group.add(goods)
        const shown = pile.more ? ` · se ven ${pile.units}` : ''
        const tip = `${pile.code} · ${pile.name} · ${qty(pile.qty)} ${pile.uom}${shown}${pile.reserved ? ' · con reserva' : ''}`
        group.traverse((obj) => {
          if (obj instanceof THREE.Mesh) {
            obj.castShadow = true
            obj.userData = { placeId, tip }
          }
        })
        const label = document.createElement('div')
        const anchor = new CSS2DObject(label)
        if (placeId === 'DEP_PT') {
          label.className =
            'rounded bg-white/90 px-1 text-[10px] font-medium whitespace-nowrap text-[#1C2B4A] shadow-sm'
          label.textContent = `${pile.name.split(' ')[0]} · ${qty(pile.qty)}`
          anchor.position.set(0, 1.9, 0)
        } else {
          // Las celdas son chicas: una etiqueta en el piso, al frente de cada pila, con la
          // cantidad (el producto, al pasar el mouse), para no tapar lo que hay detrás.
          label.className =
            'rounded-sm bg-white/85 px-0.5 text-[9px] leading-3 font-medium whitespace-nowrap text-[#1C2B4A]'
          label.textContent = `${qty(pile.qty)} ${pile.uom}`
          anchor.position.set(0, 0.05, depth * 0.46)
        }
        anchor.visible = this.near
        group.add(anchor)
        this.pileLabels.push(anchor)
        group.position.set(
          place.x - ((cols - 1) * cell) / 2 + (i % cols) * cell,
          FLOOR_Y,
          place.z - place.d / 2 + 0.2 + depth / 2 + Math.floor(i / cols) * depth,
        )
        this.pileGroup.add(group)
      })
    }
  }

  /** Lo que se está fabricando: en la mesa de armado, la forma y la cantidad, todavía sin terminar. */
  private syncWip(list: WorkInProgress[]) {
    const key = list.map((w) => `${w.docId}:${w.units}`).join(',')
    if (key === this.wipKey) return
    this.wipKey = key
    this.clearGroup(this.wipGroup)
    const place = PLACES.PRO
    const mat = materials(0.6)
    list.forEach((work, i) => {
      const group = new THREE.Group()
      const bench = new THREE.Mesh(new THREE.BoxGeometry(3.6, 0.06, 1.3), mat(0xd8cfc2))
      bench.position.y = 0.03
      group.add(bench)
      const goods = new THREE.Group()
      goods.position.y = 0.06
      if (isFurniture(work.shape)) {
        arrangeUnits(goods, work.shape, work.units, 3.4, 1.2, () => furniture(work.shape, mat, C.wood))
      } else {
        bulk(goods, work.shape, Math.min(work.units, 6), 3.4, 1.2, mat, C.wood)
      }
      group.add(goods)
      const tip = `${work.label}: ${work.product} · ${qty(work.quantity)} en proceso${work.more ? ` (se ven ${work.units})` : ''}`
      group.traverse((obj) => {
        if (obj instanceof THREE.Mesh) obj.userData = { docId: work.docId, tip }
      })
      const label = document.createElement('div')
      label.className = 'rounded bg-white/90 px-1 text-[10px] font-medium whitespace-nowrap text-[#1C2B4A] shadow-sm'
      label.textContent = `${work.label} · ${qty(work.quantity)} en proceso`
      const anchor = new CSS2DObject(label)
      anchor.position.set(0, 1.5, 0)
      group.add(anchor)
      group.position.set(place.x - 2.2 + i * 4.4, FLOOR_Y, place.z + 0.75)
      this.wipGroup.add(group)
    })
  }

  // --- animación ------------------------------------------------------------

  private tween(t: Omit<Tween, 'start'>) {
    this.tweens = this.tweens.filter((other) => other.obj !== t.obj)
    if (this.reduced) {
      t.obj.position.copy(t.to)
      if (t.scaleTo !== undefined) t.obj.scale.setScalar(t.scaleTo)
      t.done?.()
      return
    }
    if (t.scaleFrom !== undefined) t.obj.scale.setScalar(t.scaleFrom)
    this.tweens.push({ ...t, start: performance.now() })
  }

  private flyTo(position: THREE.Vector3, target: THREE.Vector3) {
    if (this.reduced) {
      this.camera.position.copy(position)
      this.controls.target.copy(target)
      this.controls.update()
      return
    }
    this.camTween = {
      fromPos: this.camera.position.clone(),
      toPos: position,
      fromTarget: this.controls.target.clone(),
      toTarget: target,
      start: performance.now(),
    }
  }

  private loop = (now: number) => {
    if (this.disposed) return
    this.frame = requestAnimationFrame(this.loop)
    // Treinta cuadros por segundo alcanzan y cuidan las PC del aula.
    if (now - this.lastRender < 32) return
    this.lastRender = now

    this.tweens = this.tweens.filter((t) => {
      const p = Math.min(1, (now - t.start) / t.duration)
      const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2
      t.obj.position.lerpVectors(t.from, t.to, e)
      t.obj.position.y += Math.sin(Math.PI * e) * t.arc
      if (t.scaleFrom !== undefined && t.scaleTo !== undefined) {
        t.obj.scale.setScalar(t.scaleFrom + (t.scaleTo - t.scaleFrom) * e)
      }
      if (p >= 1) t.done?.()
      return p < 1
    })

    if (this.camTween) {
      const p = Math.min(1, (now - this.camTween.start) / 900)
      const e = 1 - (1 - p) ** 3
      this.camera.position.lerpVectors(this.camTween.fromPos, this.camTween.toPos, e)
      this.controls.target.lerpVectors(this.camTween.fromTarget, this.camTween.toTarget, e)
      if (p >= 1) this.camTween = null
    }

    if (!this.reduced) {
      const t = now / 1000
      for (const view of this.places.values()) {
        for (const person of view.people) {
          const phase = person.userData.phase as number
          person.position.y = FLOOR_Y + (person.userData.busy ? Math.abs(Math.sin(t * 3 + phase)) * 0.12 : 0)
          person.rotation.y = person.userData.busy ? Math.sin(t * 1.5 + phase) * 0.5 : 0
        }
      }
      if (this.pulse.visible) {
        const k = (t % 1.6) / 1.6
        this.pulse.scale.setScalar(((this.pulse.userData.size as number) ?? 4) * (0.6 + k * 0.6))
        ;(this.pulse.material as THREE.MeshBasicMaterial).opacity = 0.6 * (1 - k)
      }
      if (this.producing) {
        for (const box of this.beltBoxes) {
          const { from, to, offset } = box.userData as { from: number; to: number; offset: number }
          box.position.x = from + (to - from) * ((t / 14 + offset) % 1)
        }
      }
      for (const truck of this.movingTrucks) {
        const k = (t / 9 + truck.offset) % 2
        const going = k < 1
        const p = going ? k : 2 - k
        const e = p < 0.5 ? 2 * p * p : 1 - (-2 * p + 2) ** 2 / 2
        truck.group.position.x = truck.x0 + (truck.x1 - truck.x0) * e
        truck.group.rotation.y = going ? 0 : Math.PI
      }
      if (this.replayEnvelope.visible) this.replayEnvelope.rotation.y = Math.sin(t * 2) * 0.25
    } else if (this.pulse.visible) {
      this.pulse.scale.setScalar((this.pulse.userData.size as number) ?? 4)
    }

    this.controls.update()
    // En la vista general los carteles de los productos se pisan: aparecen al acercarse.
    const near = this.camera.position.distanceTo(this.controls.target) < NEAR_LABELS
    if (near !== this.near) {
      this.near = near
      for (const anchor of this.pileLabels) anchor.visible = near
    }
    this.renderer.render(this.scene, this.camera)
    this.labels.render(this.scene, this.camera)
  }

  // --- interacción ----------------------------------------------------------

  private pick(event: PointerEvent) {
    const rect = this.renderer.domElement.getBoundingClientRect()
    this.pointer.set(
      ((event.clientX - rect.left) / rect.width) * 2 - 1,
      -((event.clientY - rect.top) / rect.height) * 2 + 1,
    )
    this.raycaster.setFromCamera(this.pointer, this.camera)
    for (const hit of this.raycaster.intersectObjects(this.scene.children, true)) {
      if (hit.object.userData.tip) return hit
    }
    return null
  }

  private onPointerDown = (event: PointerEvent) => {
    this.downAt = { x: event.clientX, y: event.clientY }
  }

  private onPointerUp = (event: PointerEvent) => {
    const down = this.downAt
    this.downAt = null
    // Si arrastró, estaba girando la cámara: no es un clic.
    if (!down || Math.hypot(event.clientX - down.x, event.clientY - down.y) > 6) return
    const hit = this.pick(event)
    if (!hit) return
    const data = hit.object.userData as { docId?: string; placeId?: NodeId }
    if (data.docId) this.callbacks.onSelectDoc(data.docId)
    else if (data.placeId) this.callbacks.onSelectPlace(data.placeId)
  }

  private onPointerMove = (event: PointerEvent) => {
    if (this.downAt) return
    const hit = this.pick(event)
    const data = hit?.object.userData as { tip?: string; docId?: string; placeId?: string } | undefined
    this.renderer.domElement.style.cursor = data?.docId || data?.placeId ? 'pointer' : 'grab'
    if (hit && data?.tip) {
      this.tipEl.textContent = data.tip
      this.tip.position.copy(hit.point)
      this.tip.visible = true
    } else {
      this.tip.visible = false
    }
  }

  private onPointerLeave = () => {
    this.tip.visible = false
    this.downAt = null
  }

  // --- utilidades -----------------------------------------------------------

  private fit() {
    const width = this.container.clientWidth
    const height = this.container.clientHeight
    if (!width || !height) return
    this.renderer.setSize(width, height)
    this.labels.setSize(width, height)
    this.camera.aspect = width / height
    this.narrow = width < 640
    this.camera.fov = this.narrow ? 55 : 42
    // En un celular los carteles se pisan: quedan los del circuito principal.
    for (const [id, view] of this.places) {
      const minor = !isNode(id) || ['RRH', 'IMP', 'CGE', 'LOG'].includes(id)
      view.label.style.visibility = this.narrow && minor ? 'hidden' : ''
    }
    this.camera.updateProjectionMatrix()
    if (this.atHome && !this.camTween) {
      this.camera.position.copy(this.homePosition())
      this.controls.target.copy(HOME.target)
    }
  }

  /** Distancia a la que entra la planta entera, de proveedores a clientes, según el ancho. */
  private homePosition() {
    const halfWidth = this.narrow ? 17 : 28
    const halfFov = Math.atan(Math.tan(THREE.MathUtils.degToRad(this.camera.fov / 2)) * this.camera.aspect)
    const distance = THREE.MathUtils.clamp(halfWidth / Math.tan(halfFov), 34, 85)
    return HOME.direction.clone().multiplyScalar(distance).add(HOME.target)
  }

  private clearGroup(group: THREE.Group) {
    for (const child of [...group.children]) {
      this.tweens = this.tweens.filter((t) => t.obj !== child)
      this.removeObject(child)
    }
  }

  private removeObject(obj: THREE.Object3D) {
    obj.removeFromParent()
    obj.traverse((child) => {
      if (child instanceof CSS2DObject) child.element.remove()
      if (child instanceof THREE.Mesh) {
        // Liberar dos veces un material compartido no hace daño en Three.js.
        child.geometry.dispose()
        ;(child.material as THREE.Material).dispose()
      }
    })
  }
}

function isNode(id: PlaceId): id is NodeId {
  return id !== 'SUP' && id !== 'CLI' && id !== 'BAN' && id !== 'FIS'
}

/** Posición del sobre `index` en la bandeja del sector: pilas de seis. */
function stackSlot(id: NodeId, index: number) {
  const place = PLACES[id]
  const col = Math.floor(index / STACK)
  const level = index % STACK
  const anchorX = place.kind === 'office' ? place.x + place.w / 2 - 0.8 : place.x - place.w / 2 + 1.2
  const anchorZ = place.z + place.d / 2 - 0.7
  return new THREE.Vector3(
    anchorX - (place.kind === 'office' ? col * 1.15 : -col * 1.15),
    FLOOR_Y + ENVELOPE.h / 2 + level * (ENVELOPE.h + 0.02),
    anchorZ,
  )
}

function placeTop(id: NodeId, y: number) {
  const place = PLACES[id]
  return new THREE.Vector3(place.x, y, place.z)
}

function badge(classes: string, title: string) {
  const el = document.createElement('span')
  el.className = cn('tabular min-w-4 rounded-full px-1 text-center text-[10px] leading-4', classes)
  el.title = title
  el.hidden = true
  return el
}

/** Los escritorios de una oficina: dos en las grandes, uno en las chicas. */
function deskSpots(place: Place) {
  return place.w >= 6 ? [place.x - 1.4, place.x + 0.8] : [place.x - 0.6]
}

/** Los centros de trabajo del taller, en el orden de sus máquinas. */
const STATIONS = ['CORTE', 'ARMADO', 'TERMINACION']

/** Las tres máquinas del taller, una por centro de trabajo. */
function stationSpots(place: Place) {
  return [place.x - 3.2, place.x, place.x + 3.2]
}

/** Personas que se dibujan por sector como mucho (el cartel dice cuántas hay, a validar). */
const MAX_PEOPLE = 8

/** Distancia de la cámara desde la que se ven los carteles de cada producto (al enfocar un sector, unas 20). */
const NEAR_LABELS = 28

/** Dónde va la persona `i` de `n`: en su escritorio, junto a la máquina de su centro o cerca del muelle. */
function staffSpot(place: Place, i: number, n: number, station: string | null, atStation: Map<number, number>) {
  if (place.kind === 'plant') {
    const known = station ? STATIONS.indexOf(station) : -1
    const index = known >= 0 ? known : i % STATIONS.length
    const k = atStation.get(index) ?? 0
    atStation.set(index, k + 1)
    // Frente a su máquina, de a tres por fila, sin tapar la mesa de armado.
    return { x: stationSpots(place)[index] + [0, -0.7, 0.7][k % 3], z: place.z - 0.5 + Math.floor(k / 3) * 0.45 }
  }
  if (place.kind === 'warehouse') return { x: place.x + place.w / 2 - 1.2 - i * 0.7, z: place.z + place.d / 2 - 1.6 }
  const desks = deskSpots(place)
  if (n <= desks.length) return { x: desks[i], z: place.z + 0.3 }
  // Más personas que escritorios: en fila, y si no entran, una segunda fila.
  const cols = Math.min(n, 4)
  return { x: place.x - ((cols - 1) * 1.1) / 2 + (i % 4) * 1.1, z: place.z + 0.3 + Math.floor(i / 4) * 0.8 }
}

type Mats = (color: number) => THREE.Material

/** Materiales compartidos dentro de una misma actualización (con transparencia, lo que está sin terminar). */
function materials(opacity = 1): Mats {
  const cache = new Map<number, THREE.Material>()
  return (color) => {
    let material = cache.get(color)
    if (!material) {
      material = new THREE.MeshStandardMaterial({ color, transparent: opacity < 1, opacity })
      cache.set(color, material)
    }
    return material
  }
}

/** Medidas de cada mueble (ancho, profundidad, alto) y cuántos se apilan. */
const SHAPE_SIZE: Record<
  'table' | 'chair' | 'wardrobe' | 'bed' | 'mattress',
  { w: number; d: number; h: number; stack: number; step: number }
> = {
  table: { w: 1.1, d: 0.7, h: 0.62, stack: 2, step: 0.62 },
  chair: { w: 0.42, d: 0.42, h: 0.85, stack: 4, step: 0.16 },
  wardrobe: { w: 0.8, d: 0.45, h: 1.5, stack: 1, step: 0 },
  bed: { w: 1, d: 1.35, h: 0.55, stack: 2, step: 0.55 },
  mattress: { w: 0.95, d: 1.3, h: 0.18, stack: 6, step: 0.18 },
}

function isFurniture(shape: ShapeKind): shape is keyof typeof SHAPE_SIZE {
  return shape in SHAPE_SIZE
}

/** El color de un producto por su madera o su material. */
function productColor(name: string, shape: ShapeKind) {
  const text = name.toLowerCase()
  if (shape === 'mattress') return C.mattress
  if (/mdf/.test(text)) return C.mdf
  if (/fen[oó]lic/.test(text)) return C.phenolic
  if (/eucalipto/.test(text)) return C.eucalyptus
  if (/pino/.test(text)) return C.pine
  return C.wood
}

/** Un mueble con su forma, apoyado en y = 0 y centrado. */
function furniture(shape: ShapeKind, mat: Mats, color: number) {
  const group = new THREE.Group()
  if (!isFurniture(shape)) return group
  const { w, d, h } = SHAPE_SIZE[shape]
  const box = (bw: number, bh: number, bd: number, x: number, y: number, z: number, c = color) => {
    const mesh = new THREE.Mesh(new THREE.BoxGeometry(bw, bh, bd), mat(c))
    mesh.position.set(x, y, z)
    group.add(mesh)
  }
  const legs = (height: number, inset: number, size: number) => {
    for (const sx of [-1, 1]) {
      for (const sz of [-1, 1]) box(size, height, size, sx * (w / 2 - inset), height / 2, sz * (d / 2 - inset))
    }
  }
  switch (shape) {
    case 'table':
      box(w, 0.06, d, 0, h - 0.03, 0)
      legs(h - 0.06, 0.07, 0.06)
      break
    case 'chair':
      box(w, 0.05, d, 0, 0.45, 0)
      legs(0.45, 0.04, 0.04)
      box(w, 0.4, 0.04, 0, 0.67, -d / 2 + 0.02)
      break
    case 'wardrobe':
      box(w, h, d, 0, h / 2, 0)
      box(0.015, h * 0.9, 0.01, 0, h / 2, d / 2 + 0.006, C.navy)
      break
    case 'bed':
      box(w, 0.25, d, 0, 0.125, 0)
      box(w * 0.94, 0.12, d * 0.88, 0, 0.31, 0.04, C.mattress)
      box(w, 0.55, 0.06, 0, 0.275, -d / 2 + 0.03)
      break
    case 'mattress':
      box(w, h, d, 0, h / 2, 0)
      box(w + 0.01, 0.03, d + 0.01, 0, h / 2, 0, C.stripe)
      break
  }
  return group
}

/** Ubica `units` muebles en pilas sobre un área, a la escala que haga falta para que entren. */
function arrangeUnits(
  parent: THREE.Group,
  shape: ShapeKind,
  units: number,
  areaW: number,
  areaD: number,
  make: () => THREE.Group,
) {
  if (!isFurniture(shape) || units <= 0) return
  const size = SHAPE_SIZE[shape]
  const stacks = Math.ceil(units / size.stack)
  const cols = Math.ceil(Math.sqrt(stacks))
  const rows = Math.ceil(stacks / cols)
  const scale = Math.min(1, areaW / (cols * size.w * 1.15), areaD / (rows * size.d * 1.15))
  for (let i = 0; i < units; i++) {
    const stack = Math.floor(i / size.stack)
    const unit = make()
    unit.scale.setScalar(scale)
    unit.position.set(
      ((stack % cols) - (cols - 1) / 2) * size.w * 1.15 * scale,
      (i % size.stack) * size.step * scale,
      (Math.floor(stack / cols) - (rows - 1) / 2) * size.d * 1.15 * scale,
    )
    parent.add(unit)
  }
}

/** Los materiales: atados de tablas, pilas de placas (una por placa), latas, cajas de herrajes y rollos. */
function bulk(
  parent: THREE.Group,
  shape: ShapeKind,
  units: number,
  cellW: number,
  cellD: number,
  mat: Mats,
  color: number,
) {
  const add = (geo: THREE.BufferGeometry, c: number, x: number, y: number, z: number, lying = false) => {
    const mesh = new THREE.Mesh(geo, mat(c))
    mesh.position.set(x, y, z)
    if (lying) mesh.rotation.x = Math.PI / 2
    parent.add(mesh)
  }
  const grid = (k: number) => ((k % 3) - 1) * 0.3
  switch (shape) {
    case 'planks': {
      const geo = new THREE.BoxGeometry(cellW * 0.85, 0.08, 0.16)
      for (let layer = 0; layer < units; layer++) {
        for (let k = 0; k < 4; k++) add(geo, color, 0, 0.04 + layer * 0.09, (k - 1.5) * 0.19)
      }
      break
    }
    case 'boards': {
      const geo = new THREE.BoxGeometry(cellW * 0.85, 0.05, cellD * 0.55)
      for (let k = 0; k < units; k++) add(geo, color, 0, 0.025 + k * 0.06, 0)
      break
    }
    case 'cans': {
      const geo = new THREE.CylinderGeometry(0.12, 0.12, 0.28, 14)
      for (let k = 0; k < units; k++) add(geo, C.metal, grid(k), 0.14 + Math.floor(k / 3) * 0.29, 0)
      break
    }
    case 'hardware': {
      const geo = new THREE.BoxGeometry(0.28, 0.2, 0.24)
      for (let k = 0; k < units; k++) add(geo, C.cardboard, grid(k), 0.1 + Math.floor(k / 3) * 0.21, 0)
      break
    }
    case 'rolls': {
      const geo = new THREE.CylinderGeometry(0.11, 0.11, 0.5, 14)
      for (let k = 0; k < units; k++) add(geo, C.film, grid(k) * 0.8, 0.11 + Math.floor(k / 3) * 0.21, 0, true)
      break
    }
    default: {
      // De a dos por nivel: a lo sumo tres niveles, como los demás materiales.
      const geo = new THREE.BoxGeometry(cellW * 0.38, 0.24, cellD * 0.4)
      for (let k = 0; k < units; k++)
        add(geo, C.cardboard, ((k % 2) - 0.5) * cellW * 0.42, 0.12 + Math.floor(k / 2) * 0.25, 0)
    }
  }
}
