// The pool as a physical object: a brass ring holding two glass orbs.
// Orb size follows each side's reserve relative to its starting point, so a
// trade visibly shifts weight from one orb to the other. Particles stream
// between them; a settled swap fires a burst in the trade's direction.

import { Canvas, useFrame, useThree } from '@react-three/fiber'
import { Environment, Float, Lightformer, Sparkles } from '@react-three/drei'
import { useMemo, useRef } from 'react'
import * as THREE from 'three'

const BRASS = new THREE.Color('#cfa960')
const VERDIGRIS = new THREE.Color('#63b59e')

interface VaultProps {
  weightA: number // ~1 at the seed ratio
  weightB: number
  pulse: { id: number; from: 'USDx' | 'CCx' } | null
  focus: number // 0..1, how much the scene steps back for dense pages
}

export default function Vault(props: VaultProps) {
  return (
    <Canvas
      dpr={[1, 1.75]}
      camera={{ position: [0, 0, 9], fov: 38 }}
      gl={{ antialias: true, alpha: true, powerPreference: 'high-performance' }}
      style={{ position: 'fixed', inset: 0, zIndex: 0 }}
    >
      <Scene {...props} />
    </Canvas>
  )
}

function Scene({ weightA, weightB, pulse, focus }: VaultProps) {
  const group = useRef<THREE.Group>(null)
  const { viewport } = useThree()
  const narrow = viewport.width < 7

  useFrame((state, dt) => {
    const g = group.current
    if (!g) return
    // gentle pointer parallax
    const { x, y } = state.pointer
    g.rotation.y = THREE.MathUtils.damp(g.rotation.y, x * 0.25, 2, dt)
    g.rotation.x = THREE.MathUtils.damp(g.rotation.x, -y * 0.15, 2, dt)
    // Sit above the headline in the left column; drift back on dense pages.
    const targetX = narrow ? 0 : THREE.MathUtils.lerp(-2.3, 0, focus)
    const targetY = narrow ? 1.7 : THREE.MathUtils.lerp(1.3, 0.2, focus)
    const targetZ = THREE.MathUtils.lerp(0, -6, focus)
    g.position.x = THREE.MathUtils.damp(g.position.x, targetX, 2.5, dt)
    g.position.y = THREE.MathUtils.damp(g.position.y, targetY, 2.5, dt)
    g.position.z = THREE.MathUtils.damp(g.position.z, targetZ, 2.5, dt)
  })

  return (
    <>
      <color attach="background" args={['#07080b']} />
      <fog attach="fog" args={['#07080b', 9, 20]} />
      <ambientLight intensity={0.35} />
      <pointLight position={[-4, 3, 4]} intensity={40} color={BRASS} />
      <pointLight position={[4, -2, 3]} intensity={30} color={VERDIGRIS} />

      <Environment resolution={256} frames={1}>
        <color attach="background" args={['#1a160f']} />
        <Lightformer form="rect" intensity={4} color="#f4e6c4" position={[0, 5, -4]} scale={[12, 3, 1]} />
        <Lightformer form="rect" intensity={2.5} color="#cfa960" position={[-6, 1, 3]} rotation-y={Math.PI / 2} scale={[6, 4, 1]} />
        <Lightformer form="rect" intensity={2} color="#63b59e" position={[6, -1, 2]} scale={[3, 7, 1]} />
      </Environment>

      <group ref={group} scale={0.66}>
        <Ring />
        <Float speed={1.2} rotationIntensity={0.25} floatIntensity={0.6}>
          <Orb color={BRASS} weight={weightA} side={-1} />
          <Orb color={VERDIGRIS} weight={weightB} side={1} />
          <Stream pulse={pulse} />
        </Float>
      </group>

      <Sparkles count={70} scale={[16, 9, 6]} size={1.6} speed={0.25} opacity={0.35} color="#e9dcc0" />
    </>
  )
}

const ORB_GAP = 1.55

function orbRadius(weight: number) {
  // Exaggerate small reserve shifts so a single trade is visible.
  const w = THREE.MathUtils.clamp(1 + (weight - 1) * 6, 0.55, 1.6)
  return 0.95 * Math.cbrt(w)
}

function Orb({ color, weight, side }: { color: THREE.Color; weight: number; side: -1 | 1 }) {
  const mesh = useRef<THREE.Mesh>(null)
  const core = useRef<THREE.Mesh>(null)
  const target = orbRadius(weight)

  useFrame((state, dt) => {
    const m = mesh.current
    if (!m) return
    const s = THREE.MathUtils.damp(m.scale.x, target, 3, dt)
    m.scale.setScalar(s)
    m.position.x = side * ORB_GAP
    m.position.y = Math.sin(state.clock.elapsedTime * 0.6 + side) * 0.08
    if (core.current) {
      core.current.scale.setScalar(0.38 + Math.sin(state.clock.elapsedTime * 1.4 + side) * 0.03)
    }
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
      {/* rim halo */}
      <mesh scale={1.12}>
        <sphereGeometry args={[1, 48, 48]} />
        <meshBasicMaterial color={color} transparent opacity={0.07} side={THREE.BackSide} blending={THREE.AdditiveBlending} depthWrite={false} />
      </mesh>
      <mesh ref={core}>
        <icosahedronGeometry args={[1, 1]} />
        <meshStandardMaterial color={color} emissive={color} emissiveIntensity={2.6} wireframe transparent opacity={0.75} toneMapped={false} />
      </mesh>
      <pointLight color={color} intensity={6} distance={4} />
    </mesh>
  )
}

function Ring() {
  const outer = useRef<THREE.Mesh>(null)
  const inner = useRef<THREE.Mesh>(null)
  useFrame((_, dt) => {
    if (outer.current) outer.current.rotation.z += dt * 0.08
    if (inner.current) inner.current.rotation.z -= dt * 0.12
  })
  return (
    <group rotation={[Math.PI / 2.35, 0, 0]}>
      <mesh ref={outer}>
        <torusGeometry args={[3.35, 0.035, 24, 240]} />
        <meshStandardMaterial color="#cfa960" metalness={1} roughness={0.28} />
      </mesh>
      <mesh ref={inner} rotation={[0.12, 0.08, 0]}>
        <torusGeometry args={[3.0, 0.012, 16, 200]} />
        <meshStandardMaterial color="#e9dcc0" metalness={1} roughness={0.2} transparent opacity={0.6} />
      </mesh>
      <Ticks />
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

const PARTICLES = 420

function Stream({ pulse }: { pulse: VaultProps['pulse'] }) {
  const points = useRef<THREE.Points>(null)
  const burst = useRef({ strength: 0, dir: 1, lastId: 0 })

  const { positions, colors, seeds } = useMemo(() => {
    const positions = new Float32Array(PARTICLES * 3)
    const colors = new Float32Array(PARTICLES * 3)
    const seeds = new Float32Array(PARTICLES * 3)
    for (let i = 0; i < PARTICLES; i++) {
      seeds[i * 3] = Math.random() // progress offset
      seeds[i * 3 + 1] = Math.random() * Math.PI * 2 // phase
      seeds[i * 3 + 2] = 0.25 + Math.random() * 0.75 // speed
    }
    return { positions, colors, seeds }
  }, [])

  const curveA = useMemo(
    () => new THREE.CubicBezierCurve3(new THREE.Vector3(-ORB_GAP, 0, 0), new THREE.Vector3(-0.5, 1.1, 0.6), new THREE.Vector3(0.5, 1.1, -0.6), new THREE.Vector3(ORB_GAP, 0, 0)),
    [],
  )
  const curveB = useMemo(
    () => new THREE.CubicBezierCurve3(new THREE.Vector3(ORB_GAP, 0, 0), new THREE.Vector3(0.5, -1.1, 0.6), new THREE.Vector3(-0.5, -1.1, -0.6), new THREE.Vector3(-ORB_GAP, 0, 0)),
    [],
  )
  const tmp = useMemo(() => new THREE.Vector3(), [])
  const tmpColor = useMemo(() => new THREE.Color(), [])

  useFrame((state, dt) => {
    const b = burst.current
    if (pulse && pulse.id !== b.lastId) {
      b.lastId = pulse.id
      b.strength = 1
      b.dir = pulse.from === 'USDx' ? 1 : -1
    }
    b.strength = Math.max(0, b.strength - dt * 0.45)
    const t = state.clock.elapsedTime
    const pos = points.current?.geometry.attributes.position as THREE.BufferAttribute | undefined
    const col = points.current?.geometry.attributes.color as THREE.BufferAttribute | undefined
    if (!pos || !col) return
    for (let i = 0; i < PARTICLES; i++) {
      const upper = i % 2 === 0
      const speed = seeds[i * 3 + 2] * (0.06 + b.strength * 0.9)
      let p = (seeds[i * 3] + t * speed) % 1
      // during a burst, the traded side's lane runs in the trade direction
      if (b.strength > 0.01 && upper !== (b.dir === 1)) p = 1 - p
      const curve = upper ? curveA : curveB
      curve.getPoint(p, tmp)
      const wobble = 0.06 + b.strength * 0.18
      const ph = seeds[i * 3 + 1]
      pos.setXYZ(i, tmp.x + Math.sin(t * 2 + ph) * wobble, tmp.y + Math.cos(t * 1.7 + ph) * wobble, tmp.z + Math.sin(t + ph) * wobble)
      const c = upper ? tmpColor.copy(BRASS).lerp(VERDIGRIS, p) : tmpColor.copy(VERDIGRIS).lerp(BRASS, p)
      const glow = 0.35 + b.strength * 0.9
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
      <pointsMaterial size={0.045} vertexColors transparent opacity={0.9} depthWrite={false} blending={THREE.AdditiveBlending} sizeAttenuation />
    </points>
  )
}
