// Escena 3D del gemelo digital. Dibuja lo que calcula `twin-model.ts`; no
// conoce la API ni React. Se carga aparte (Three.js pesa) sólo al abrir el
// Mapa vivo.

import * as THREE from 'three'
import { OrbitControls } from 'three/examples/jsm/controls/OrbitControls.js'
import { CSS2DObject, CSS2DRenderer } from 'three/examples/jsm/renderers/CSS2DRenderer.js'
import type { DocumentListItem } from '@/lib/api'
import { qty } from '@/lib/format'
import { cn } from '@/lib/utils'
import { documentNode, type NodeId } from './flow-model'
import {
  docFamily,
  PLACE_IDS,
  PLACES,
  ROUTES,
  type DocFamily,
  type PlaceId,
  type RackSlot,
  type RouteKind,
  type Truck,
} from './twin-model'

export interface TwinState {
  docs: DocumentListItem[]
  docCounts: Partial<Record<NodeId, number>>
  taskCounts: Partial<Record<NodeId, number>>
  trucks: Truck[]
  racks: RackSlot[]
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
  private rackGroup = new THREE.Group()
  private rackKey = ''
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
    this.scene.add(this.truckGroup, this.rackGroup)

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
    for (const [id, view] of this.places) {
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
    this.syncRacks(state.racks)
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

    const people: THREE.Object3D[] = []
    if (place.kind === 'office') {
      const desks = place.w >= 6 ? 2 : 1
      for (let i = 0; i < desks; i++) {
        const x = place.x + (desks === 1 ? -0.6 : -1.4 + i * 2.2)
        this.addDesk(x, place.z - 0.6)
        people.push(this.addPerson(x, place.z + 0.3))
      }
    } else if (place.kind === 'plant') {
      this.addMachine(place.x - 2.5, place.z - 1.6)
      this.addMachine(place.x + 2.5, place.z - 1.6)
      people.push(this.addPerson(place.x - 2.5, place.z - 0.1), this.addPerson(place.x + 2.5, place.z - 0.1))
    } else if (place.kind === 'warehouse') {
      people.push(this.addPerson(place.x + place.w / 2 - 1.2, place.z + place.d / 2 - 1.6))
    } else {
      this.addBuilding(id, place.x, place.z - (id === 'BAN' ? 0 : place.d / 2 - 1.8))
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
    if (isNode(id)) {
      docsBadge = badge('bg-[#185FA5] text-white', 'documentos abiertos')
      tasksBadge = badge('bg-amber-400 text-[#1C2B4A]', 'tareas pendientes')
      label.append(docsBadge, tasksBadge)
      label.addEventListener('click', () => this.callbacks.onSelectPlace(id))
      if (label instanceof HTMLButtonElement) label.type = 'button'
    }
    const anchor = new CSS2DObject(label)
    anchor.position.set(place.x, place.kind === 'office' ? 2.2 : 3.6, place.z - place.d / 2 + 0.4)
    this.scene.add(anchor)

    this.places.set(id, { floor, base, label, docsBadge, tasksBadge, people })
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

  private addPerson(x: number, z: number) {
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
    for (const part of [body, head]) part.castShadow = true
    person.add(body, head)
    person.position.set(x, FLOOR_Y, z)
    person.userData = { busy: false, phase: Math.random() * Math.PI * 2 }
    this.scene.add(person)
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
    const mat = new THREE.MeshStandardMaterial({ color: id === 'BAN' ? 0xb8c6d6 : 0xc2cad4 })
    const body = new THREE.Mesh(new THREE.BoxGeometry(3.4, id === 'BAN' ? 2.6 : 2, 2.6), mat)
    body.position.set(x, FLOOR_Y + (id === 'BAN' ? 1.3 : 1), z)
    body.castShadow = true
    this.scene.add(body)
    const roof = new THREE.Mesh(new THREE.BoxGeometry(3.8, 0.25, 3), new THREE.MeshStandardMaterial({ color: C.navy }))
    roof.position.set(x, body.position.y * 2 + 0.12, z)
    this.scene.add(roof)
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
    const group = new THREE.Group()
    const cargo = new THREE.Mesh(
      new THREE.BoxGeometry(2.4, 1.2, 1.2),
      new THREE.MeshStandardMaterial({ color: truck.direction === 'in' ? C.truckIn : C.truckOut }),
    )
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
    const tip =
      truck.direction === 'in'
        ? `${truck.label}: mercadería en camino a Depósito`
        : `${truck.label}: remito en preparación para despachar`
    group.traverse((obj) => {
      if (obj instanceof THREE.Mesh) {
        obj.castShadow = true
        obj.userData = { docId: truck.docId, tip }
      }
    })
    const label = document.createElement('div')
    label.className = 'rounded bg-white/90 px-1.5 text-[10px] font-medium text-[#1C2B4A] shadow-sm'
    label.textContent = truck.label
    const anchor = new CSS2DObject(label)
    anchor.position.set(0, 2, 0)
    group.add(anchor)
    return group
  }

  private syncRacks(slots: RackSlot[]) {
    const key = slots.map((s) => `${s.key}:${s.level.toFixed(2)}:${s.tone}:${s.reserved}`).join(',')
    if (key === this.rackKey) return
    this.rackKey = key
    this.clearGroup(this.rackGroup)
    const postMat = new THREE.MeshStandardMaterial({ color: C.rack })
    const toneMat = {
      ok: new THREE.MeshStandardMaterial({ color: C.ok }),
      warning: new THREE.MeshStandardMaterial({ color: C.warning }),
      danger: new THREE.MeshStandardMaterial({ color: C.danger }),
    }
    const capMat = new THREE.MeshStandardMaterial({ color: C.navy })
    for (const placeId of ['DEP_MP', 'DEP_PT'] as const) {
      const place = PLACES[placeId]
      const list = slots.filter((s) => s.place === placeId)
      if (list.length === 0) continue
      // Las estanterías ocupan la parte de atrás; adelante queda el muelle.
      const cols = Math.min(6, Math.max(2, Math.ceil(Math.sqrt(list.length * 1.6))))
      const rows = Math.ceil(list.length / cols)
      const cell = Math.min((place.w - 1.2) / cols, 1.6)
      const depth = Math.min((place.d - 3) / rows, 1.8)
      list.forEach((slot, i) => {
        const x = place.x - ((cols - 1) * cell) / 2 + (i % cols) * cell
        const z = place.z - place.d / 2 + 1.1 + Math.floor(i / cols) * depth
        const rack = new THREE.Group()
        for (const dx of [-0.5, 0.5]) {
          const post = new THREE.Mesh(new THREE.BoxGeometry(0.06, 2.6, 0.06), postMat)
          post.position.set(dx * cell * 0.85, 1.3, 0)
          rack.add(post)
        }
        const boxes = slot.qty > 0 ? Math.max(1, Math.round(slot.level * 4)) : 0
        for (let b = 0; b < boxes; b++) {
          const box = new THREE.Mesh(new THREE.BoxGeometry(cell * 0.7, 0.5, 0.7), toneMat[slot.tone])
          box.position.set(0, 0.3 + b * 0.58, 0)
          box.castShadow = true
          rack.add(box)
        }
        if (slot.reserved && boxes > 0) {
          const cap = new THREE.Mesh(new THREE.BoxGeometry(cell * 0.72, 0.08, 0.72), capMat)
          cap.position.set(0, 0.3 + (boxes - 1) * 0.58 + 0.29, 0)
          rack.add(cap)
        }
        const tip = `${slot.code} · ${slot.name} · ${qty(slot.qty)}${slot.reserved ? ' · con reserva' : ''}`
        rack.traverse((obj) => {
          if (obj instanceof THREE.Mesh) obj.userData = { placeId, tip }
        })
        rack.position.set(x, FLOOR_Y, z)
        this.rackGroup.add(rack)
      })
    }
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
      if (this.replayEnvelope.visible) this.replayEnvelope.rotation.y = Math.sin(t * 2) * 0.25
    } else if (this.pulse.visible) {
      this.pulse.scale.setScalar((this.pulse.userData.size as number) ?? 4)
    }

    this.controls.update()
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
  return id !== 'SUP' && id !== 'CLI' && id !== 'BAN'
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
