// The backdrop: one cloud of particles, half CC (ice blue), half the other
// token (ember). The same particles move between four shapes:
//   0  two separate token spheres
//   1  one pool, a ring both sides pour into
//   2  two interlocked rings, one per check
//   3  everything gathered into the one thing you get back
// On the landing the shape follows the scroll (landingStage). On the other
// pages the cloud fits itself into the page's [data-vault-stage] box. When a
// swap settles, every particle turns into the output token's colour.

import { useEffect, useRef } from 'react'
import * as THREE from 'three'
import { SETTLED_EVENT } from './settle.ts'
import { landingStage } from './stageBus.ts'
import type { StageScene } from './stage.tsx'

export type ParticleScene = StageScene

// which shape each page shows
const SHAPE: Record<StageScene, number> = { hero: 0, trade: 0, liquidity: 1, payments: 1, lending: 2, holdings: 3 }

const vertexShader = /* glsl */ `
  attribute vec3 pB, pC, pD;
  attribute float side, rnd;
  uniform float uP, uTime, uConvert, uPix;
  uniform vec3 uMouse, uCC, uUSD;
  varying vec3 vCol;
  varying float vA;
  vec3 shape(int i) { return i == 0 ? position : i == 1 ? pB : i == 2 ? pC : pD; }
  void main() {
    float p = clamp(uP, 0., 3.);
    int i = int(min(floor(p), 2.));
    float f = clamp((p - float(i) - rnd * .35) / .65, 0., 1.);
    f = f * f * (3. - 2. * f);
    vec3 pos = mix(shape(i), shape(i + 1), f);
    // in transit the particles swirl instead of sliding in straight lines
    float tr = sin(f * 3.14159);
    pos += tr * vec3(sin(rnd * 40. + uTime), cos(rnd * 23. + uTime * .8), sin(rnd * 61.)) * .9;
    pos += .035 * vec3(sin(uTime * .7 + rnd * 30.), cos(uTime * .9 + rnd * 17.), sin(uTime * .6 + rnd * 11.));
    // the cursor pushes particles aside
    vec2 d = pos.xy - uMouse.xy;
    float push = exp(-dot(d, d) * 1.4) * .75;
    pos.xy += normalize(d + 1e-4) * push;
    vec4 mv = modelViewMatrix * vec4(pos, 1.);
    gl_Position = projectionMatrix * mv;
    gl_PointSize = uPix * (1.4 + rnd * 1.8) * (8. / -mv.z);
    float conv = smoothstep(rnd * .6, rnd * .6 + .4, uConvert);
    vCol = mix(mix(uCC, uUSD, side), uUSD, conv);
    vCol = mix(vCol, vec3(1.), push * .6);
    vA = .55 + .45 * rnd;
  }`

const fragmentShader = /* glsl */ `
  varying vec3 vCol;
  varying float vA;
  void main() {
    vec2 c = gl_PointCoord - .5;
    float d = length(c);
    if (d > .5) discard;
    gl_FragColor = vec4(vCol, vA * smoothstep(.5, .1, d) * .9);
  }`

function buildGeometry(n: number) {
  const pA = new Float32Array(n * 3), pB = new Float32Array(n * 3), pC = new Float32Array(n * 3), pD = new Float32Array(n * 3)
  const side = new Float32Array(n), rnd = new Float32Array(n)
  const v = new THREE.Vector3()
  const onSphere = (r: number, thick: number) => v.randomDirection().multiplyScalar(r * (1 - thick * Math.random() ** 2))
  for (let i = 0; i < n; i++) {
    const s = i < n / 2 ? 0 : 1
    side[i] = s
    rnd[i] = Math.random()
    onSphere(1.45, 0.5)
    pA.set([v.x + (s ? 2.9 : -2.9), v.y, v.z], i * 3)
    const a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI * 2, rr = 0.42 * Math.sqrt(Math.random())
    const R = 2.3 + rr * Math.cos(b)
    pB.set([R * Math.cos(a), rr * Math.sin(b) * 1.2, R * Math.sin(a) * 0.9 - 0.2], i * 3)
    const t = Math.random() * Math.PI * 2, w = (Math.random() - 0.5) * 0.18, q = (Math.random() - 0.5) * 0.18
    if (s === 0) pC.set([Math.cos(t) * 1.8 - 0.9 + w, Math.sin(t) * 1.8 + q, w], i * 3)
    else pC.set([Math.cos(t) * 1.8 + 0.9 + w, q, Math.sin(t) * 1.8 + w], i * 3)
    onSphere(1.5, 0.35)
    pD.set([v.x, v.y, v.z], i * 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pA, 3))
  geo.setAttribute('pB', new THREE.BufferAttribute(pB, 3))
  geo.setAttribute('pC', new THREE.BufferAttribute(pC, 3))
  geo.setAttribute('pD', new THREE.BufferAttribute(pD, 3))
  geo.setAttribute('side', new THREE.BufferAttribute(side, 1))
  geo.setAttribute('rnd', new THREE.BufferAttribute(rnd, 1))
  return geo
}

// the landing's horizontal placement per stage: away from the text column
function landingX(s: number) {
  if (s < 0.5) return 2.4
  if (s < 1.5) return -2.6 * (s - 0.5) + 2.4 * (1.5 - s)
  if (s < 2.5) return 1.6 * (s - 1.5) - 2.6 * (2.5 - s)
  return 1.6 * (3 - s) + 0.4 * (s - 2.5)
}

export default function Particles({ scene, pulse }: { scene: ParticleScene; pulse?: { id: number } | null }) {
  const canvasRef = useRef<HTMLCanvasElement>(null)
  const sceneRef = useRef(scene)
  sceneRef.current = scene
  const convertKick = useRef(0)

  // a pool fill (LocalNet) turns the cloud like a settled swap does
  useEffect(() => {
    if (pulse) convertKick.current = performance.now()
  }, [pulse])

  useEffect(() => {
    const canvas = canvasRef.current
    if (!canvas) return
    const reduce = window.matchMedia('(prefers-reduced-motion: reduce)').matches
    const narrow = window.innerWidth < 860
    const geo = buildGeometry(narrow ? 14000 : 34000)
    const uni = {
      uP: { value: 0 },
      uTime: { value: 0 },
      uConvert: { value: 0 },
      uMouse: { value: new THREE.Vector3(99, 99, 0) },
      uPix: { value: Math.min(window.devicePixelRatio, 2) },
      uCC: { value: new THREE.Color('#7fa8ff') },
      uUSD: { value: new THREE.Color('#ff7a3d') },
    }
    const mat = new THREE.ShaderMaterial({ uniforms: uni, vertexShader, fragmentShader, transparent: true, depthWrite: false, blending: THREE.AdditiveBlending })
    const points = new THREE.Points(geo, mat)
    points.frustumCulled = false

    let renderer: THREE.WebGLRenderer
    try {
      renderer = new THREE.WebGLRenderer({ canvas, antialias: false, alpha: false, powerPreference: 'high-performance' })
    } catch {
      return // no WebGL: the page still works on the plain background
    }
    renderer.setPixelRatio(Math.min(window.devicePixelRatio, 1.75))
    renderer.setClearColor('#08090b')
    const world = new THREE.Scene()
    world.add(points)
    const cam = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
    cam.position.set(0, 0, 9.5)
    const resize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight, false)
      cam.aspect = window.innerWidth / window.innerHeight
      cam.updateProjectionMatrix()
    }
    resize()
    window.addEventListener('resize', resize)

    // cursor -> the z=0 plane, in the cloud's own coordinates
    const ray = new THREE.Raycaster(), plane = new THREE.Plane(new THREE.Vector3(0, 0, 1), 0), ndc = new THREE.Vector2(), hit = new THREE.Vector3()
    const mouseTarget = new THREE.Vector3(99, 99, 0)
    const onMove = (e: PointerEvent) => {
      ndc.set((e.clientX / window.innerWidth) * 2 - 1, -(e.clientY / window.innerHeight) * 2 + 1)
      ray.setFromCamera(ndc, cam)
      if (ray.ray.intersectPlane(plane, hit)) mouseTarget.copy(points.worldToLocal(hit.clone()))
    }
    const onLeave = () => mouseTarget.set(99, 99, 0)
    window.addEventListener('pointermove', onMove)
    document.addEventListener('pointerleave', onLeave)
    const onSettled = () => (convertKick.current = performance.now())
    window.addEventListener(SETTLED_EVENT, onSettled)

    let stage = 0, x = 2.4, y = 0, scale = 1, raf = 0, prev = performance.now()
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (document.hidden) return
      const dt = Math.min((now - prev) / 1000, 0.05)
      prev = now
      if (!reduce) uni.uTime.value += dt
      const k = Math.min(1, dt * 4)

      // where the cloud should be and which shape it should take
      let tStage: number, tx: number, ty = 0, ts = 1
      const box = sceneRef.current === 'hero' ? null : document.querySelector<HTMLElement>('[data-vault-stage]')
      if (landingStage.active && sceneRef.current === 'hero') {
        tStage = landingStage.value
        tx = narrow ? 0 : landingX(stage)
        ts = narrow ? 0.7 : 1
      } else if (box) {
        tStage = SHAPE[sceneRef.current] ?? 0
        const r = box.getBoundingClientRect()
        const perPx = (2 * Math.tan(THREE.MathUtils.degToRad(cam.fov / 2)) * cam.position.z) / window.innerHeight
        tx = (r.left + r.width / 2 - window.innerWidth / 2) * perPx
        ty = -(r.top + r.height / 2 - window.innerHeight / 2) * perPx
        ts = Math.max(0.3, Math.min(1.1, Math.min((r.width * perPx) / 9, (r.height * perPx) / 3.6)))
      } else {
        tStage = SHAPE[sceneRef.current] ?? 0
        tx = narrow ? 0 : 2.4
      }
      stage += (tStage - stage) * k
      x += (tx - x) * k
      y += (ty - y) * k
      scale += (ts - scale) * k
      uni.uP.value = stage
      points.position.set(x, y, 0)
      points.scale.setScalar(scale)

      // a settled swap: turn to the output colour, hold, turn back
      const since = (now - convertKick.current) / 1000
      const conv = convertKick.current === 0 ? 0 : since < 2.4 ? since / 2.4 : since < 5.4 ? 1 : since < 6.6 ? 1 - (since - 5.4) / 1.2 : 0
      uni.uConvert.value = conv * conv * (3 - 2 * conv)

      uni.uMouse.value.lerp(mouseTarget, Math.min(1, dt * 8))
      const t = uni.uTime.value
      points.rotation.y = Math.sin(t * 0.12) * 0.12 + (stage > 1 && stage < 2.5 ? (stage - 1) * 0.35 : stage >= 2.5 ? 0.525 * (3 - stage) * 2 : 0)
      points.rotation.x =
        Math.sin(t * 0.09) * 0.05 +
        (stage > 0.5 && stage < 1.5 ? 0.35 * Math.sin((stage - 0.5) * Math.PI) : 0) +
        (stage > 1.5 && stage < 2.8 ? 0.55 * Math.sin(((stage - 1.5) / 1.3) * Math.PI) : 0)
      renderer.render(world, cam)
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      document.removeEventListener('pointerleave', onLeave)
      window.removeEventListener(SETTLED_EVENT, onSettled)
      geo.dispose()
      mat.dispose()
      renderer.dispose()
    }
  }, [])

  return <canvas ref={canvasRef} className="particles" aria-hidden />
}
