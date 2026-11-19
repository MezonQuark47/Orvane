// The pool as a physical object: a brass ring holding two glass orbs.
//
// Orb size follows each side's reserve, so a trade visibly shifts weight
// from one orb to the other. Particles stream between them. Around it:
//   * an aurora backdrop (shader) that drifts slowly and flares on settlement
//   * a vault floor grid receding into the fog, for depth
//   * three dust layers with different parallax
//   * per-section "poses": the vault rearranges itself as you navigate
//   * a shockwave and a dial spin whenever something settles
// Bloom, film grain and vignette are done in post. Everything calms down
// under prefers-reduced-motion.

import { Canvas, useFrame } from '@react-three/fiber'
import { Environment, Float, Lightformer, Sparkles } from '@react-three/drei'
import { Bloom, EffectComposer, Noise, Vignette } from '@react-three/postprocessing'
import { BlendFunction } from 'postprocessing'
import { useEffect, useMemo, useRef } from 'react'
import * as THREE from 'three'
import { SETTLED_EVENT } from './settle.ts'

const BRASS = new THREE.Color('#cfa960')
const VERDIGRIS = new THREE.Color('#63b59e')
const INK = new THREE.Color('#07080b')

export type VaultScene = 'hero' | 'trade' | 'liquidity' | 'payments' | 'lending' | 'lens' | 'holdings'

interface VaultProps {
  weightA: number // ~1 at the seed ratio
  weightB: number
  pulse: { id: number; from: 'USDx' | 'CCx' } | null
  scene: VaultScene
}

const reducedMotion = () => typeof window !== 'undefined' && window.matchMedia('(prefers-reduced-motion: reduce)').matches

// ---------------------------------------------------------------- poses

interface Pose {
  rot: [number, number, number]
  ringTilt: number // rotation of the ring around X; ~PI/2 is "lying flat"
  gap: number // distance between the orbs
  lift: number // vertical offset between orbs (a balance)
  fit: [number, number] // world-space width/height the pose needs inside its stage
}

const POSES: Record<VaultScene, Pose> = {
  // the landing: seen slightly from above, ring opened up towards you
  hero: { rot: [0.16, 0, 0], ringTilt: Math.PI / 2.25, gap: 1.6, lift: 0, fit: [7.4, 4.3] },
  trade: { rot: [0, 0, 0], ringTilt: Math.PI / 2.35, gap: 1.55, lift: 0, fit: [7.6, 4.1] },
  // look down into the pool; the two sides lean in towards each other
  liquidity: { rot: [0.3, 0, 0], ringTilt: Math.PI / 2.05, gap: 1.2, lift: 0, fit: [7.6, 3.9] },
  // the dial turns to face you like a vault door
  payments: { rot: [0, -0.28, 0], ringTilt: 0.12, gap: 1.45, lift: 0, fit: [7.9, 7.9] },
  // a balance: collateral on one side, debt on the other
  lending: { rot: [0, 0, 0], ringTilt: Math.PI / 2.6, gap: 1.7, lift: 0.4, fit: [7.6, 4.7] },
  lens: { rot: [0, 0, 0], ringTilt: Math.PI / 2.35, gap: 1.55, lift: 0, fit: [7.6, 4.1] },
  holdings: { rot: [0, 0.2, 0], ringTilt: Math.PI / 2.2, gap: 1.4, lift: 0, fit: [7.6, 4.1] },
}

// Depth of the stage plane: behind the page, so fog and bloom set the vault into the room.
const STAGE_Z = -2.5
// With no stage on the page (the privacy lens), the vault steps further back.
const BACKDROP = { pos: new THREE.Vector3(0, 0.4, -7), scale: 0.62 }

// Live, damped state shared by the scene parts.
interface Rig {
  gap: number
  lift: number
  ringTilt: number
  burst: number // 1 right after a settlement, decays to 0
  burstDir: 1 | -1
  burstId: number
}

export default function Vault(props: VaultProps) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ position: [0, 0, 9], fov: 38 }}
      gl={{ antialias: false, alpha: false, powerPreference: 'high-performance', stencil: false }}
      style={{ position: 'fixed', inset: 0, zIndex: 0 }}
    >
      <Scene {...props} />
    </Canvas>
  )
}

const num = (v: string | undefined) => (v === undefined || v === '' ? undefined : Number(v))

function nearestStage(vh: number): HTMLElement | null {
  const stages = document.querySelectorAll<HTMLElement>('[data-vault-stage]')
  if (stages.length < 2) return stages[0] ?? null
  let best: HTMLElement | null = null
  let bestD = Infinity
  for (const s of stages) {
    const r = s.getBoundingClientRect()
    const d = Math.abs(r.top + r.height / 2 - vh / 2)
    if (d < bestD) {
      bestD = d
      best = s
    }
  }
  return best
}

function Scene({ weightA, weightB, pulse, scene }: VaultProps) {
  const group = useRef<THREE.Group>(null)
  const orbA = useRef<THREE.Mesh>(null)
  const orbB = useRef<THREE.Mesh>(null)
  const still = useMemo(reducedMotion, [])
  const rig = useRef<Rig>({ gap: 1.55, lift: 0, ringTilt: Math.PI / 2.35, burst: 0, burstDir: 1, burstId: 0 })
  // which stage element we are fitted to, and whether we have arrived there yet
  const track = useRef<{ el: HTMLElement | null; locked: boolean }>({ el: null, locked: false })
  const weights = useRef<[number, number]>([weightA, weightB])
  const tmp = useMemo(() => ({ pos: new THREE.Vector3() }), [])

  // settlements from the provider (legacy pool) ...
  useEffect(() => {
    if (pulse && pulse.id !== rig.current.burstId) {
      rig.current.burstId = pulse.id
      rig.current.burst = 1
      rig.current.burstDir = pulse.from === 'USDx' ? 1 : -1
    }
  }, [pulse])
  // ... and from anywhere else in the app
  useEffect(() => {
    const on = (e: Event) => {
      const from = (e as CustomEvent<{ from?: 'USDx' | 'CCx' }>).detail?.from ?? 'USDx'
      rig.current.burst = 1
      rig.current.burstDir = from === 'USDx' ? 1 : -1
    }
    window.addEventListener(SETTLED_EVENT, on)
    return () => window.removeEventListener(SETTLED_EVENT, on)
  }, [])

  useFrame((state, dt) => {
    const g = group.current
    if (!g) return
    const r = rig.current
    const t = track.current
    const cam = state.camera as THREE.PerspectiveCamera
    const { width: vw, height: vh } = state.size
    const worldH = 2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * (cam.position.z - STAGE_Z)
    const worldW = worldH * (vw / vh)

    // follow the stage nearest the middle of the screen: one per page in the
    // app, several along the landing page, where the vault travels between them
    const el = nearestStage(vh)
    if (el !== t.el) {
      t.el = el
      t.locked = false
    }
    const pose = POSES[(el?.dataset.vaultStage as VaultScene | undefined) ?? scene] ?? POSES[scene]
    const rect = el?.getBoundingClientRect()

    // where the stage box is, in world units on the z=0 plane
    let scale = BACKDROP.scale
    tmp.pos.copy(BACKDROP.pos)
    if (rect) {
      tmp.pos.set(((rect.left + rect.width / 2) / vw - 0.5) * worldW, -((rect.top + rect.height / 2) / vh - 0.5) * worldH, STAGE_Z)
      scale = Math.min(((rect.width / vw) * worldW) / pose.fit[0], ((rect.height / vh) * worldH) / pose.fit[1])
    }

    // fly to a new stage, then stay glued to it so it scrolls with the page
    const k = still ? 60 : 3.2
    if (t.locked && rect) {
      g.position.copy(tmp.pos)
      g.scale.setScalar(scale)
    } else {
      g.position.x = THREE.MathUtils.damp(g.position.x, tmp.pos.x, k, dt)
      g.position.y = THREE.MathUtils.damp(g.position.y, tmp.pos.y, k, dt)
      g.position.z = THREE.MathUtils.damp(g.position.z, tmp.pos.z, k, dt)
      g.scale.setScalar(THREE.MathUtils.damp(g.scale.x, scale, k, dt))
      if (rect && g.position.distanceTo(tmp.pos) < 0.015 && Math.abs(g.scale.x - scale) < 0.004) t.locked = true
    }

    // pose rotation plus gentle pointer parallax
    const par = still ? 0 : 1
    const { x, y } = state.pointer
    const kr = still ? 60 : 2.4
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, pose.rot[0] - y * 0.12 * par, kr, dt)
    g.rotation.y = THREE.MathUtils.damp(g.rotation.y, pose.rot[1] + x * 0.2 * par, kr, dt)
    g.rotation.z = THREE.MathUtils.damp(g.rotation.z, pose.rot[2], kr, dt)

    // the page says what the orbs weigh and how the balance tips
    weights.current = [num(el?.dataset.wa) ?? weightA, num(el?.dataset.wb) ?? weightB]
    const lift = num(el?.dataset.lift) ?? pose.lift
    r.gap = THREE.MathUtils.damp(r.gap, pose.gap, kr * 0.8, dt)
    r.lift = THREE.MathUtils.damp(r.lift, lift, kr * 0.8, dt)
    r.ringTilt = THREE.MathUtils.damp(r.ringTilt, pose.ringTilt, kr * 0.7, dt)
    r.burst = Math.max(0, r.burst - dt * 0.45)
  })

  return (
    <>
      <color attach="background" args={[INK]} />
      <fog attach="fog" args={[INK, 9, 22]} />
      <ambientLight intensity={0.35} />
      <pointLight position={[-4, 3, 4]} intensity={40} color={BRASS} />
      <pointLight position={[4, -2, 3]} intensity={30} color={VERDIGRIS} />

      <Environment resolution={256} frames={1}>
        <color attach="background" args={['#1a160f']} />
        <Lightformer form="rect" intensity={4} color="#f4e6c4" position={[0, 5, -4]} scale={[12, 3, 1]} />
        <Lightformer form="rect" intensity={2.5} color="#cfa960" position={[-6, 1, 3]} rotation-y={Math.PI / 2} scale={[6, 4, 1]} />
        <Lightformer form="rect" intensity={2} color="#63b59e" position={[6, -1, 2]} scale={[3, 7, 1]} />
      </Environment>

      <Aurora rig={rig} still={still} />
      <VaultFloor rig={rig} still={still} />
      <Dust still={still} />

      <group ref={group} scale={0.6}>
        <Ring rig={rig} />
        <Shockwave rig={rig} />
        <Float speed={still ? 0 : 1.2} rotationIntensity={0.15} floatIntensity={0.3}>
          <Orb handle={orbA} color={BRASS} weights={weights} index={0} side={-1} rig={rig} />
          <Orb handle={orbB} color={VERDIGRIS} weights={weights} index={1} side={1} rig={rig} />
          <Stream rig={rig} />
        </Float>
      </group>

      <EffectComposer multisampling={0}>
        <Bloom mipmapBlur intensity={0.85} luminanceThreshold={0.55} luminanceSmoothing={0.2} />
        <Noise premultiply blendFunction={BlendFunction.SOFT_LIGHT} opacity={0.45} />
        <Vignette offset={0.28} darkness={0.72} />
      </EffectComposer>
    </>
  )
}

type RigRef = React.MutableRefObject<Rig>

// ---------------------------------------------------------------- backdrop

const auroraVertex = /* glsl */ `
  varying vec2 vUv;
  void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
`

const auroraFragment = /* glsl */ `
  uniform float uTime;
  uniform float uBurst;
  uniform vec3 uInk;
  uniform vec3 uBrass;
  uniform vec3 uVerd;
  varying vec2 vUv;

  float hash(vec2 p) { return fract(sin(dot(p, vec2(127.1, 311.7))) * 43758.5453); }
  float noise(vec2 p) {
    vec2 i = floor(p), f = fract(p);
    vec2 u = f * f * (3.0 - 2.0 * f);
    return mix(mix(hash(i), hash(i + vec2(1, 0)), u.x), mix(hash(i + vec2(0, 1)), hash(i + vec2(1, 1)), u.x), u.y);
  }
  float fbm(vec2 p) {
    float v = 0.0, a = 0.5;
    for (int i = 0; i < 5; i++) { v += a * noise(p); p *= 2.02; a *= 0.5; }
    return v;
  }

  void main() {
    vec2 uv = vUv;
    float t = uTime * 0.025;
    // two slow light pools: brass upper left, verdigris lower right
    float n = fbm(uv * 3.0 + vec2(t, -t * 0.7));
    float m = fbm(uv * 2.2 - vec2(t * 0.8, t * 0.4) + n);
    float brass = smoothstep(0.75, 0.0, distance(uv, vec2(0.28 + 0.04 * sin(t * 6.0), 0.72))) * m;
    float verd = smoothstep(0.8, 0.0, distance(uv, vec2(0.78, 0.25 + 0.05 * cos(t * 5.0)))) * fbm(uv * 2.6 + t);
    vec3 col = uInk;
    col += uBrass * brass * (0.11 + uBurst * 0.12);
    col += uVerd * verd * (0.08 + uBurst * 0.1);
    // faint drifting filaments
    float fil = smoothstep(0.62, 0.66, fbm(uv * vec2(9.0, 3.0) + vec2(t * 2.0, 0.0)));
    col += mix(uBrass, uVerd, uv.x) * fil * 0.025;
    gl_FragColor = vec4(col, 1.0);
  }
`

function Aurora({ rig, still }: { rig: RigRef; still: boolean }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(
    () => ({ uTime: { value: 0 }, uBurst: { value: 0 }, uInk: { value: INK }, uBrass: { value: BRASS }, uVerd: { value: VERDIGRIS } }),
    [],
  )
  useFrame((state) => {
    if (!mat.current) return
    mat.current.uniforms.uTime.value = still ? 0 : state.clock.elapsedTime
    mat.current.uniforms.uBurst.value = rig.current.burst
  })
  return (
    <mesh position={[0, 0, -14]} renderOrder={-1}>
      <planeGeometry args={[70, 40]} />
      <shaderMaterial ref={mat} vertexShader={auroraVertex} fragmentShader={auroraFragment} uniforms={uniforms} depthWrite={false} fog={false} />
    </mesh>
  )
}

// ---------------------------------------------------------------- floor

const floorFragment = /* glsl */ `
  uniform float uTime;
  uniform float uBurst;
  uniform vec3 uBrass;
  varying vec2 vUv;
  void main() {
    vec2 p = (vUv - 0.5) * 60.0;
    p.y += uTime * 0.35;                       // the floor slowly slides towards you
    vec2 g = abs(fract(p / 1.6) - 0.5) / fwidth(p / 1.6);
    float line = 1.0 - min(min(g.x, g.y), 1.0);
    float d = length(vUv - 0.5);
    float fade = smoothstep(0.5, 0.06, d);     // fades into the distance
    float a = line * fade * (0.16 + uBurst * 0.3);
    gl_FragColor = vec4(uBrass, a);
  }
`

function VaultFloor({ rig, still }: { rig: RigRef; still: boolean }) {
  const mat = useRef<THREE.ShaderMaterial>(null)
  const uniforms = useMemo(() => ({ uTime: { value: 0 }, uBurst: { value: 0 }, uBrass: { value: BRASS } }), [])
  useFrame((state) => {
    if (!mat.current) return
    mat.current.uniforms.uTime.value = still ? 0 : state.clock.elapsedTime
    mat.current.uniforms.uBurst.value = rig.current.burst
  })
  return (
    <mesh position={[0, -3.4, -4]} rotation={[-Math.PI / 2, 0, 0]}>
      <planeGeometry args={[60, 60]} />
      <shaderMaterial
        ref={mat}
        vertexShader={auroraVertex}
        fragmentShader={floorFragment}
        uniforms={uniforms}
        transparent
        depthWrite={false}
        extensions={{ derivatives: true } as never}
      />
    </mesh>
  )
}

// ---------------------------------------------------------------- dust

function Dust({ still }: { still: boolean }) {
  const near = useRef<THREE.Group>(null)
  const mid = useRef<THREE.Group>(null)
  const far = useRef<THREE.Group>(null)
  useFrame((state, dt) => {
    if (still) return
    const { x, y } = state.pointer
    for (const [ref, f] of [
      [near, 0.9],
      [mid, 0.45],
      [far, 0.15],
    ] as const) {
      const g = ref.current
      if (!g) continue
      g.position.x = THREE.MathUtils.damp(g.position.x, -x * f, 1.6, dt)
      g.position.y = THREE.MathUtils.damp(g.position.y, -y * f * 0.6, 1.6, dt)
    }
  })
  const speed = still ? 0 : 1
  return (
    <>
      <group ref={far}>
        <Sparkles count={90} scale={[26, 14, 4]} position={[0, 0, -8]} size={1.2} speed={0.12 * speed} opacity={0.22} color="#e9dcc0" />
      </group>
      <group ref={mid}>
        <Sparkles count={50} scale={[18, 10, 4]} position={[0, 0, -3]} size={1.8} speed={0.2 * speed} opacity={0.3} color="#f1d79b" />
      </group>
      <group ref={near}>
        <Sparkles count={18} scale={[14, 8, 2]} position={[0, 0, 3]} size={3.2} speed={0.25 * speed} opacity={0.18} color="#a6e3d2" noise={2} />
      </group>
    </>
  )
}

// ---------------------------------------------------------------- the vault

function orbRadius(weight: number) {
  // Exaggerate small reserve shifts so a single trade is visible.
  const w = THREE.MathUtils.clamp(1 + (weight - 1) * 6, 0.55, 1.6)
  return 0.95 * Math.cbrt(w)
}

function Orb({
  handle,
  color,
  weights,
  index,
  side,
  rig,
}: {
  handle: React.RefObject<THREE.Mesh | null>
  color: THREE.Color
  weights: React.MutableRefObject<[number, number]>
  index: 0 | 1
  side: -1 | 1
  rig: RigRef
}) {
  const mesh = handle
  const core = useRef<THREE.Mesh>(null)
  const coreMat = useRef<THREE.MeshStandardMaterial>(null)
  useFrame((state, dt) => {
    const m = mesh.current
    if (!m) return
    const r = rig.current
    const target = orbRadius(weights.current[index])
    const s = THREE.MathUtils.damp(m.scale.x, target * (1 + r.burst * 0.06), 3, dt)
    m.scale.setScalar(s)
    m.position.x = side * r.gap
    m.position.y = side * -r.lift + Math.sin(state.clock.elapsedTime * 0.6 + side) * 0.08
    if (core.current) {
      core.current.scale.setScalar(0.38 + Math.sin(state.clock.elapsedTime * 1.4 + side) * 0.03)
      core.current.rotation.y += dt * (0.2 + r.burst * 3)
    }
    if (coreMat.current) coreMat.current.emissiveIntensity = 2.6 + r.burst * 4
  })

  return (
    <mesh ref={mesh}>
      <sphereGeometry args={[1, 96, 96]} />
      <meshPhysicalMaterial
        color={color}
        emissive={color}
        emissiveIntensity={0.12}
        metalness={0.1}
        transmission={0.82}
        thickness={1.2}
        roughness={0.22}
        ior={1.5}
        clearcoat={0.6}
        clearcoatRoughness={0.35}
        attenuationColor={color}
        attenuationDistance={2.2}
        iridescence={0.5}
        iridescenceIOR={1.25}
        envMapIntensity={1.6}
        transparent
        opacity={0.96}
      />
      <mesh scale={1.12}>
        <sphereGeometry args={[1, 48, 48]} />
        <meshBasicMaterial color={color} transparent opacity={0.07} side={THREE.BackSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh ref={core}>
        <icosahedronGeometry args={[1, 1]} />
        <meshStandardMaterial ref={coreMat} color={color} emissive={color} emissiveIntensity={2.6} wireframe transparent opacity={0.75} toneMapped={false} />
      </mesh>
      <pointLight color={color} intensity={6} distance={4} />
    </mesh>
  )
}

function Ring({ rig }: { rig: RigRef }) {
  const tilt = useRef<THREE.Group>(null)
  const outer = useRef<THREE.Mesh>(null)
  const inner = useRef<THREE.Mesh>(null)
  const dial = useRef<THREE.Group>(null)
  useFrame((_, dt) => {
    const r = rig.current
    if (tilt.current) tilt.current.rotation.x = r.ringTilt
    // a settlement spins the dial like a combination lock, then it settles
    const spin = 1 + r.burst * r.burst * 18
    if (outer.current) outer.current.rotation.z += dt * 0.08 * spin
    if (inner.current) inner.current.rotation.z -= dt * 0.12 * spin
    if (dial.current) dial.current.rotation.z -= dt * 0.02 * spin * r.burstDir
  })
  return (
    <group ref={tilt} rotation={[Math.PI / 2.35, 0, 0]}>
      <mesh ref={outer}>
        <torusGeometry args={[3.35, 0.035, 24, 240]} />
        <meshStandardMaterial color="#cfa960" metalness={1} roughness={0.28} />
      </mesh>
      <mesh ref={inner} rotation={[0.12, 0.08, 0]}>
        <torusGeometry args={[3.0, 0.012, 16, 200]} />
        <meshStandardMaterial color="#e9dcc0" metalness={1} roughness={0.2} transparent opacity={0.6} />
      </mesh>
      <group ref={dial}>
        <Ticks />
      </group>
    </group>
  )
}

// 72 small ticks around the ring, like a vault dial.
function Ticks() {
  const geo = useMemo(() => new THREE.BoxGeometry(0.02, 0.16, 0.02), [])
  const items = useMemo(() => Array.from({ length: 72 }, (_, i) => (i / 72) * Math.PI * 2), [])
  return (
    <group>
      {items.map((a, i) => (
        <mesh key={i} geometry={geo} position={[Math.cos(a) * 3.62, Math.sin(a) * 3.62, 0]} rotation={[0, 0, a + Math.PI / 2]}>
          <meshStandardMaterial color={i % 6 === 0 ? '#f1d79b' : '#6b5a3a'} metalness={1} roughness={0.35} />
        </mesh>
      ))}
    </group>
  )
}

// An expanding ring of light in the plane of the dial.
function Shockwave({ rig }: { rig: RigRef }) {
  const mesh = useRef<THREE.Mesh>(null)
  const mat = useRef<THREE.MeshBasicMaterial>(null)
  useFrame(() => {
    const r = rig.current
    if (!mesh.current || !mat.current) return
    const p = 1 - r.burst // 0 at the moment of settlement -> 1
    mesh.current.rotation.x = r.ringTilt
    mesh.current.scale.setScalar(3.4 + p * 5)
    mat.current.opacity = r.burst > 0.01 ? Math.pow(r.burst, 1.6) * 0.55 : 0
  })
  return (
    <mesh ref={mesh}>
      <ringGeometry args={[0.97, 1, 160]} />
      <meshBasicMaterial ref={mat} color="#f1d79b" transparent opacity={0} side={THREE.DoubleSide} blending={THREE.AdditiveBlending} depthWrite={false} toneMapped={false} />
    </mesh>
  )
}

const PARTICLES = 420

function Stream({ rig }: { rig: RigRef }) {
  const points = useRef<THREE.Points>(null)

  const { positions, colors, seeds } = useMemo(() => {
    const positions = new Float32Array(PARTICLES * 3)
    const colors = new Float32Array(PARTICLES * 3)
    const seeds = new Float32Array(PARTICLES * 3)
    for (let i = 0; i < PARTICLES; i++) {
      seeds[i * 3] = Math.random()
      seeds[i * 3 + 1] = Math.random() * Math.PI * 2
      seeds[i * 3 + 2] = 0.25 + Math.random() * 0.75
    }
    return { positions, colors, seeds }
  }, [])

  const a0 = useMemo(() => new THREE.Vector3(), [])
  const a1 = useMemo(() => new THREE.Vector3(), [])
  const a2 = useMemo(() => new THREE.Vector3(), [])
  const a3 = useMemo(() => new THREE.Vector3(), [])
  const curveA = useMemo(() => new THREE.CubicBezierCurve3(a0, a1, a2, a3), [a0, a1, a2, a3])
  const b0 = useMemo(() => new THREE.Vector3(), [])
  const b1 = useMemo(() => new THREE.Vector3(), [])
  const b2 = useMemo(() => new THREE.Vector3(), [])
  const b3 = useMemo(() => new THREE.Vector3(), [])
  const curveB = useMemo(() => new THREE.CubicBezierCurve3(b0, b1, b2, b3), [b0, b1, b2, b3])
  const tmp = useMemo(() => new THREE.Vector3(), [])
  const tmpColor = useMemo(() => new THREE.Color(), [])

  useFrame((state) => {
    const r = rig.current
    // the lanes follow the orbs as the pose changes
    const g = r.gap
    const l = r.lift
    a0.set(-g, l, 0); a1.set(-0.5, 1.1 + l * 0.3, 0.6); a2.set(0.5, 1.1 - l * 0.3, -0.6); a3.set(g, -l, 0)
    b0.set(g, -l, 0); b1.set(0.5, -1.1 - l * 0.3, 0.6); b2.set(-0.5, -1.1 + l * 0.3, -0.6); b3.set(-g, l, 0)
    const t = state.clock.elapsedTime
    const pos = points.current?.geometry.attributes.position as THREE.BufferAttribute | undefined
    const col = points.current?.geometry.attributes.color as THREE.BufferAttribute | undefined
    if (!pos || !col) return
    for (let i = 0; i < PARTICLES; i++) {
      const upper = i % 2 === 0
      const speed = seeds[i * 3 + 2] * (0.06 + r.burst * 0.9)
      let p = (seeds[i * 3] + t * speed) % 1
      if (r.burst > 0.01 && upper !== (r.burstDir === 1)) p = 1 - p
      ;(upper ? curveA : curveB).getPoint(p, tmp)
      const wobble = 0.06 + r.burst * 0.18
      const ph = seeds[i * 3 + 1]
      pos.setXYZ(i, tmp.x + Math.sin(t * 2 + ph) * wobble, tmp.y + Math.cos(t * 1.7 + ph) * wobble, tmp.z + Math.sin(t + ph) * wobble)
      const c = upper ? tmpColor.copy(BRASS).lerp(VERDIGRIS, p) : tmpColor.copy(VERDIGRIS).lerp(BRASS, p)
      const glow = 0.35 + r.burst * 1.2
      col.setXYZ(i, c.r * glow, c.g * glow, c.b * glow)
    }
    pos.needsUpdate = true
    col.needsUpdate = true
  })

  return (
    <points ref={points}>
      <bufferGeometry>
        <bufferAttribute attach="attributes-position" args={[positions, 3]} />
        <bufferAttribute attach="attributes-color" args={[colors, 3]} />
      </bufferGeometry>
      <pointsMaterial size={0.045} vertexColors transparent opacity={0.9} depthWrite={false} blending={THREE.AdditiveBlending} sizeAttenuation toneMapped={false} />
    </points>
  )
}
