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
import { EffectComposer } from 'three/examples/jsm/postprocessing/EffectComposer.js'
import { RenderPass } from 'three/examples/jsm/postprocessing/RenderPass.js'
import { ShaderPass } from 'three/examples/jsm/postprocessing/ShaderPass.js'
import { UnrealBloomPass } from 'three/examples/jsm/postprocessing/UnrealBloomPass.js'
import { SETTLED_EVENT } from './settle.ts'
import { landingStage } from './stageBus.ts'
import type { StageScene } from './stage.tsx'

export type ParticleScene = StageScene

// which shape each page shows
const SHAPE: Record<StageScene, number> = { hero: 0, trade: 0, markets: 2, how: 1, liquidity: 1, payments: 1, lending: 2, holdings: 3 }

const vertexShader = /* glsl */ `
  attribute vec3 pB, pC, pD;
  attribute float side, rnd, shell;
  uniform float uP, uTime, uConvert, uPix, uSwirl;
  uniform vec3 uMouse, uCC, uUSD;
  // shock waves: (x, y, start time, strength); one from clicks, one ambient
  uniform vec4 uShock, uPing;
  varying vec3 vCol;
  varying float vA;
  vec3 rotY(vec3 p, vec3 c, float a) {
    p -= c;
    float s = sin(a), k = cos(a);
    return vec3(k * p.x + s * p.z, p.y, -s * p.x + k * p.z) + c;
  }
  vec3 rotZ(vec3 p, vec3 c, float a) {
    p -= c;
    float s = sin(a), k = cos(a);
    return vec3(k * p.x - s * p.y, s * p.x + k * p.y, p.z) + c;
  }
  // simplex noise (Ashima Arts / Stefan Gustavson, MIT)
  vec3 m289(vec3 x) { return x - floor(x / 289.) * 289.; }
  vec4 m289(vec4 x) { return x - floor(x / 289.) * 289.; }
  vec4 perm(vec4 x) { return m289((x * 34. + 1.) * x); }
  float snoise(vec3 v) {
    const vec2 C = vec2(1. / 6., 1. / 3.);
    vec3 i = floor(v + dot(v, C.yyy));
    vec3 x0 = v - i + dot(i, C.xxx);
    vec3 g = step(x0.yzx, x0.xyz), l = 1. - g;
    vec3 i1 = min(g, l.zxy), i2 = max(g, l.zxy);
    vec3 x1 = x0 - i1 + C.xxx, x2 = x0 - i2 + C.yyy, x3 = x0 - .5;
    i = m289(i);
    vec4 p = perm(perm(perm(i.z + vec4(0., i1.z, i2.z, 1.)) + i.y + vec4(0., i1.y, i2.y, 1.)) + i.x + vec4(0., i1.x, i2.x, 1.));
    vec4 j = p - 49. * floor(p / 49.);
    vec4 x_ = floor(j / 7.), y_ = floor(j - 7. * x_);
    vec4 x = (x_ * 2. + .5) / 7. - 1., y = (y_ * 2. + .5) / 7. - 1.;
    vec4 h = 1. - abs(x) - abs(y);
    vec4 b0 = vec4(x.xy, y.xy), b1 = vec4(x.zw, y.zw);
    vec4 s0 = floor(b0) * 2. + 1., s1 = floor(b1) * 2. + 1., sh = -step(h, vec4(0.));
    vec4 a0 = b0.xzyw + s0.xzyw * sh.xxyy, a1 = b1.xzyw + s1.xzyw * sh.zzww;
    vec3 g0 = vec3(a0.xy, h.x), g1 = vec3(a0.zw, h.y), g2 = vec3(a1.xy, h.z), g3 = vec3(a1.zw, h.w);
    vec4 nr = 1.79284291400159 - .85373472095314 * vec4(dot(g0, g0), dot(g1, g1), dot(g2, g2), dot(g3, g3));
    g0 *= nr.x; g1 *= nr.y; g2 *= nr.z; g3 *= nr.w;
    vec4 m = max(.6 - vec4(dot(x0, x0), dot(x1, x1), dot(x2, x2), dot(x3, x3)), 0.);
    m = m * m;
    return 42. * dot(m * m, vec4(dot(g0, x0), dot(g1, x1), dot(g2, x2), dot(g3, x3)));
  }
  float hash1(float x) { return fract(sin(x * 127.1 + 311.7) * 43758.5453); }
  vec3 dirFrom(vec2 r) {
    float z = r.x * 2. - 1., ph = r.y * 6.2831853, s = sqrt(max(0., 1. - z * z));
    return vec3(s * cos(ph), z, s * sin(ph));
  }
  // light on the current shape, and how close to white-hot it runs
  float gLit, gHot;
  // A sphere is a small world: a dotted globe on a tilted axis, turning
  // slowly, with a day side facing the other token and a night side away
  // from it, a thin atmosphere at the rim, continents that rotate with it,
  // a surface that boils faintly like a star, and now and then a flare.
  // The inside is a soft even dust that drifts at its own pace.
  vec3 globe(vec3 p, vec3 c, float tilt, float spin) {
    float a = uTime * spin * (shell > .5 ? 1. : .6 + rnd * .8);
    vec3 q = rotY(p, c, a);
    q = rotZ(q, c, tilt);
    vec3 r = (q - c) * (1. + .012 * sin(uTime * .7 + side * 3.14159));
    gHot = 0.;
    if (shell < .5) { gLit = 1.; return c + r; }
    // features live in the globe's own frame, so they turn with it
    vec3 d0 = normalize(p - c);
    float land = smoothstep(-.05, .3, snoise(d0 * 1.5 + side * 7.) + .45 * snoise(d0 * 3.6 + side * 3.));
    float boil = snoise(d0 * 6. + vec3(0., uTime * .14, side * 5.));
    float cyc = uTime * .07 + side * .5;
    float ci = floor(cyc), life = fract(cyc);
    vec3 fd = dirFrom(vec2(.25 + .5 * hash1(ci + side * 3.1), hash1(ci * 1.7 + side)));
    float flare = pow(max(dot(d0, fd), 0.), 90.) * pow(sin(life * 3.14159), 2.);
    r *= 1. + .018 * land + .05 * flare;
    vec3 n = normalize(r);
    // the day side faces the other sphere, a little from above and in front
    vec3 L = normalize(vec3(c.x > .1 ? -1. : c.x < -.1 ? 1. : -.4, .45, .7));
    float day = smoothstep(-.3, .4, dot(n, L));
    float rim = 1. - abs(n.z);
    gLit = (.15 + 1.7 * day) * (.3 + 1.4 * land) * (1. + .25 * boil) + .9 * pow(rim, 2.8) + 1.6 * flare;
    gHot = .35 * land * day + .7 * flare;
    return c + r;
  }
  // rings flow along themselves, each particle at its own speed
  vec3 flowRing(vec3 p, vec3 c, float spin, bool inPlane) {
    float a = uTime * spin * (.55 + rnd * .9);
    gLit = 1.;
    gHot = 0.;
    return inPlane ? rotZ(p, c, a) : rotY(p, c, a);
  }
  vec3 shape(int i) {
    if (i == 0) {
      vec3 c = vec3(side > .5 ? 2.9 : -2.9, 0., 0.);
      return globe(position, c, side > .5 ? -.38 : .38, .11);
    }
    if (i == 1) return flowRing(pB, vec3(0., 0., -.2), .22, false);
    if (i == 2) return side > .5 ? flowRing(pC, vec3(.9, 0., 0.), .3, false) : flowRing(pC, vec3(-.9, 0., 0.), .3, true);
    return globe(pD, vec3(0.), .3, .09);
  }
  // The exchange, one 24 s act in three beats. First a stream of blue arcs
  // over and settles evenly through the inside of the ember world, keeping
  // its colour, so the world's structure stays and it simply carries blue.
  // Then ember sends a stream underneath into the blue world. Last, both
  // send their guests home at once and the two worlds are as they began.
  // Only inner dust travels, so the globes' surfaces never break.
  float gTravel, gGuest;
  vec3 bez(vec3 a, vec3 k, vec3 b, float u) { return mix(mix(a, k, u), mix(k, b, u), u); }
  // One journey, u from 0 to 1. The travellers gather from all through
  // their world to one point on its face, leave as a slim ribbon that
  // winds around its own arc, swelling in the middle, and at the far world
  // open out again to their places. Departures are staggered, so the
  // ribbon is drawn out along the whole arc rather than flying as a blob.
  vec3 flight(vec3 a, vec3 ca, vec3 b, vec3 cb, float u, float lift) {
    vec3 ax = normalize(cb - ca);
    vec3 S = ca + ax * 1.45, E = cb - ax * 1.45;
    vec3 K = (S + E) * .5 + vec3(0., lift * 1.9, .7);
    float v = clamp((u - .15) / .7, 0., 1.);
    v = v * v * (3. - 2. * v);
    vec3 on = bez(S, K, E, v);
    vec3 T = normalize(mix(K - S, E - K, v));
    vec3 N = normalize(cross(T, vec3(0., 0., 1.)));
    vec3 B = cross(T, N);
    // two soft strands twined around the arc; each traveller sits loosely
    // on one of them, so the ribbon reads as silk rather than a coil
    float h = fract(rnd * 7919.);
    float ang = (h < .5 ? 0. : 3.14159) + (fract(rnd * 311.) - .5) * 1.1 + v * 7. + uTime * .9;
    float rad = (.03 + .17 * sin(v * 3.14159)) * (.55 + .45 * fract(rnd * 53.));
    on += (N * cos(ang) + B * sin(ang)) * rad;
    float gather = smoothstep(0., .18, u), open = smoothstep(.82, 1., u);
    gTravel = .6 * gather * (1. - open);
    return mix(mix(a, on, gather), b, open);
  }
  vec3 courier(vec3 p) {
    gTravel = 0.;
    gGuest = 0.;
    if (shell > .5 || rnd >= .3) return p;
    float tau = fract(uTime / 24. - rnd * .3);
    bool blue = side < .5;
    float leave = blue ? 0. : .33, back = .66, F = .1;
    if (tau < leave || tau >= back + F) return p;
    vec3 c = vec3(blue ? -2.9 : 2.9, 0., 0.);
    // guests spread over a thin layer just under the other world's surface,
    // each in its own direction, so together they draw that world's globe
    // in their colour, lit by its day side like the rest of it
    vec3 dir = normalize(p - c + 1e-4);
    vec3 there = -c + dir * (1.3 + .12 * fract(rnd * 37.));
    float day = smoothstep(-.3, .4, dot(dir, normalize(vec3(c.x > 0. ? 1. : -1., .45, .7))));
    float shade = .3 + .9 * day + .6 * pow(1. - abs(dir.z), 2.8);
    if (tau >= leave + F && tau < back) {
      gGuest = smoothstep(leave + F, leave + F + .03, tau) * (1. - smoothstep(back - .03, back, tau)) * shade;
      return there;
    }
    bool going = tau < leave + F;
    float u = going ? (tau - leave) / F : (tau - back) / F;
    // blue goes over and comes home under; ember the other way round
    float lift = (blue ? 1. : -1.) * (going ? 1. : -1.);
    return going ? flight(p, c, there, -c, u, lift) : flight(there, -c, p, c, u, lift);
  }
  // a smooth, ever-changing flow field: two octaves of crossed sines, close
  // enough to curl noise to read as smoke, cheap enough for every particle
  vec3 field(vec3 p, float t) {
    return vec3(
      sin(p.y * 1.7 + t * .5) + sin(p.z * 1.3 - t * .37),
      sin(p.z * 1.5 + t * .43) + sin(p.x * 1.1 + t * .29),
      sin(p.x * 1.6 - t * .41) + sin(p.y * 1.2 + t * .53)) * .5;
  }
  vec2 rot2(vec2 v, float a) {
    float s = sin(a), k = cos(a);
    return vec2(k * v.x - s * v.y, s * v.x + k * v.y);
  }
  // a ring of light running out from where a shock wave started
  float shock(vec4 s, vec3 pos, out vec2 dir) {
    vec2 d = pos.xy - s.xy;
    float dist = length(d) + 1e-4;
    dir = d / dist;
    float age = uTime - s.z;
    if (s.w <= 0. || age < 0. || age > 3.5) return 0.;
    float front = age * 4.2;
    return s.w * exp(-pow((dist - front) * 2.4, 2.)) * exp(-age * 1.15);
  }
  void main() {
    float p = clamp(uP, 0., 3.);
    int i = int(min(floor(p), 2.));
    float f = clamp((p - float(i) - rnd * .35) / .65, 0., 1.);
    f = f * f * (3. - 2. * f);
    vec3 a = shape(i);
    float litA = gLit, hotA = gHot;
    vec3 b = shape(i + 1);
    float lit = mix(litA, gLit, f), hot = mix(hotA, gHot, f);
    vec3 pos = mix(a, b, f);
    // couriers fly only while the two spheres are at rest
    float rest = 1. - smoothstep(0., .3, uP);
    vec3 flown = courier(pos);
    pos = mix(pos, flown, rest);
    gTravel *= rest;
    gGuest *= rest;
    // how much the cloud is a sphere right now: spheres stay calm and crisp,
    // the rings and the journeys between shapes flow like smoke
    float calm = max(rest, smoothstep(2.7, 3., uP));
    float tr = sin(f * 3.14159);
    pos += tr * vec3(sin(rnd * 40. + uTime), cos(rnd * 23. + uTime * .8), sin(rnd * 61.)) * .9;
    pos += (.16 + .1 * rnd) * (1. - .92 * calm) * (field(pos, uTime) + .5 * field(pos * 2.1 + 4., uTime * 1.3));
    // the cursor is a small black hole: particles near it wind around it,
    // the closer the faster, and heat up; moving the mouse stirs harder
    vec2 d = pos.xy - uMouse.xy;
    float g = exp(-dot(d, d) * 1.05);
    pos.xy = uMouse.xy + rot2(d, g * (1.5 + uSwirl * 2.5)) * (1. + g * .22);
    pos.z += g * .5;
    // shock waves push a bright ring outwards
    vec2 sd, pd;
    float ring = shock(uShock, pos, sd);
    float ping = shock(uPing, pos, pd);
    pos.xy += sd * ring * .75 + pd * ping * .55;
    pos.z += (ring + ping) * .5;
    float push = min(1., g * .9 + ring + ping);
    vec4 mv = modelViewMatrix * vec4(pos, 1.);
    gl_Position = projectionMatrix * mv;
    float dot0 = mix(1.4 + rnd * 1.8, shell > .5 ? 1.5 + rnd * .5 : 1.5 + rnd * 1.5, calm);
    gl_PointSize = uPix * (dot0 + gTravel * .9 + gGuest * .85 + push * .9) * (8. / -mv.z);
    float conv = smoothstep(rnd * .6, rnd * .6 + .4, uConvert);
    vCol = mix(mix(uCC, uUSD, side), uUSD, conv);
    vCol = mix(vCol, vec3(1.), min(1., push * .3 + gTravel * .25 + gGuest * .15 + hot));
    // a soft shimmer runs across the dots, never a flicker
    float glint = pow(.5 + .5 * sin(uTime * (.6 + rnd * .9) + rnd * 60.), 8.);
    float base = mix(.55 + .45 * rnd, shell > .5 ? .8 : .45, calm);
    vA = base * lit * (.85 + .35 * glint) + gTravel * .5 + gGuest * (.4 + .3 * glint) + push * .2;
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

// The lens: colours split a touch towards the edges, like real glass, and
// the corners fall off into the dark.
const LensShader = {
  uniforms: { tDiffuse: { value: null }, uAmount: { value: 0.0035 } },
  vertexShader: /* glsl */ `
    varying vec2 vUv;
    void main() { vUv = uv; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.); }`,
  fragmentShader: /* glsl */ `
    uniform sampler2D tDiffuse;
    uniform float uAmount;
    varying vec2 vUv;
    void main() {
      vec2 d = vUv - .5;
      vec2 off = d * dot(d, d) * uAmount * 40.;
      vec3 c = vec3(texture2D(tDiffuse, vUv + off).r, texture2D(tDiffuse, vUv).g, texture2D(tDiffuse, vUv - off).b);
      c *= mix(1., .72, smoothstep(.35, .95, length(d * vec2(1.25, 1.))));
      gl_FragColor = vec4(c, 1.);
    }`,
}

// A far field of faint stars behind everything, each breathing slowly.
function buildStars(n: number) {
  const pos = new Float32Array(n * 3), seed = new Float32Array(n)
  for (let i = 0; i < n; i++) {
    pos.set([(Math.random() - 0.5) * 60, (Math.random() - 0.5) * 34, -12 - Math.random() * 26], i * 3)
    seed[i] = Math.random()
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pos, 3))
  geo.setAttribute('seed', new THREE.BufferAttribute(seed, 1))
  const uniforms = { uTime: { value: 0 }, uPix: { value: Math.min(window.devicePixelRatio, 2) } }
  const mat = new THREE.ShaderMaterial({
    uniforms,
    transparent: true,
    depthWrite: false,
    blending: THREE.AdditiveBlending,
    vertexShader: /* glsl */ `
      attribute float seed;
      uniform float uTime, uPix;
      varying float vA;
      varying vec3 vC;
      void main() {
        vec4 mv = modelViewMatrix * vec4(position, 1.);
        gl_Position = projectionMatrix * mv;
        gl_PointSize = uPix * (.8 + seed * 1.6);
        vA = (.12 + .3 * seed) * (.55 + .45 * sin(uTime * (.3 + seed * .7) + seed * 40.));
        vC = mix(vec3(.75, .82, 1.), vec3(1., .86, .78), step(.82, seed));
      }`,
    fragmentShader: /* glsl */ `
      varying float vA;
      varying vec3 vC;
      void main() {
        float d = length(gl_PointCoord - .5);
        if (d > .5) discard;
        gl_FragColor = vec4(vC, vA * smoothstep(.5, 0., d));
      }`,
  })
  const points = new THREE.Points(geo, mat)
  points.frustumCulled = false
  return {
    points,
    uniforms,
    dispose: () => {
      geo.dispose()
      mat.dispose()
    },
  }
}

// Points evenly spread over a sphere (a Fibonacci lattice): k of n.
const GOLDEN = Math.PI * (3 - Math.sqrt(5))
function lattice(k: number, n: number, r: number, out: THREE.Vector3) {
  const y = 1 - (2 * (k + 0.5)) / n
  const ring = Math.sqrt(1 - y * y)
  const phi = k * GOLDEN
  return out.set(Math.cos(phi) * ring * r, y * r, Math.sin(phi) * ring * r)
}

// Under half of a sphere's particles sit on its surface lattice; the rest
// fill its inside evenly.
const SHELL = 0.45

function buildGeometry(n: number) {
  const pA = new Float32Array(n * 3), pB = new Float32Array(n * 3), pC = new Float32Array(n * 3), pD = new Float32Array(n * 3)
  const side = new Float32Array(n), rnd = new Float32Array(n), shell = new Float32Array(n)
  const v = new THREE.Vector3()
  const half = n / 2
  const shellPer = Math.floor(half * SHELL)
  // a cube root spreads the inside evenly through the volume
  const dust = (r: number) => v.randomDirection().multiplyScalar(r * 0.93 * Math.cbrt(Math.random()))
  for (let i = 0; i < n; i++) {
    const s = i < half ? 0 : 1
    const li = s ? i - half : i
    const onShell = li < shellPer
    side[i] = s
    rnd[i] = Math.random()
    shell[i] = onShell ? 1 : 0
    // 0: one globe per token
    if (onShell) lattice(li, shellPer, 1.45, v)
    else dust(1.45)
    pA.set([v.x + (s ? 2.9 : -2.9), v.y, v.z], i * 3)
    // 1: the pool ring
    const a = Math.random() * Math.PI * 2, b = Math.random() * Math.PI * 2, rr = 0.42 * Math.sqrt(Math.random())
    const R = 2.3 + rr * Math.cos(b)
    pB.set([R * Math.cos(a), rr * Math.sin(b) * 1.2, R * Math.sin(a) * 0.9 - 0.2], i * 3)
    // 2: two interlocked rings
    const t = Math.random() * Math.PI * 2, w = (Math.random() - 0.5) * 0.18, q = (Math.random() - 0.5) * 0.18
    if (s === 0) pC.set([Math.cos(t) * 1.8 - 0.9 + w, Math.sin(t) * 1.8 + q, w], i * 3)
    else pC.set([Math.cos(t) * 1.8 + 0.9 + w, q, Math.sin(t) * 1.8 + w], i * 3)
    // 3: one globe, both tokens woven through the same lattice
    if (onShell) lattice(li * 2 + s, shellPer * 2, 1.5, v)
    else dust(1.5)
    pD.set([v.x, v.y, v.z], i * 3)
  }
  const geo = new THREE.BufferGeometry()
  geo.setAttribute('position', new THREE.BufferAttribute(pA, 3))
  geo.setAttribute('pB', new THREE.BufferAttribute(pB, 3))
  geo.setAttribute('pC', new THREE.BufferAttribute(pC, 3))
  geo.setAttribute('pD', new THREE.BufferAttribute(pD, 3))
  geo.setAttribute('side', new THREE.BufferAttribute(side, 1))
  geo.setAttribute('rnd', new THREE.BufferAttribute(rnd, 1))
  geo.setAttribute('shell', new THREE.BufferAttribute(shell, 1))
  return geo
}

// the landing's horizontal placement per stage, on the side opposite the
// text: hero text left, pool text right, checks text left, swap card left
const LANDING_X = [2.4, -2.6, 3.2, 0.4]
function landingX(s: number) {
  const i = Math.max(0, Math.min(2, Math.floor(s)))
  const f = Math.max(0, Math.min(1, s - i))
  const e = f * f * (3 - 2 * f)
  return LANDING_X[i] + (LANDING_X[i + 1] - LANDING_X[i]) * e
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
    // reduced motion slows the cloud down instead of freezing it; followed live
    const reduceQuery = window.matchMedia('(prefers-reduced-motion: reduce)')
    let reduce = reduceQuery.matches
    const onReduce = (e: MediaQueryListEvent) => (reduce = e.matches)
    reduceQuery.addEventListener('change', onReduce)
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
      uSwirl: { value: 0 },
      uShock: { value: new THREE.Vector4(0, 0, -99, 0) },
      uPing: { value: new THREE.Vector4(0, 0, -99, 0) },
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
    const stars = buildStars(narrow ? 700 : 1800)
    world.add(stars.points)
    const cam = new THREE.PerspectiveCamera(42, 1, 0.1, 100)
    cam.position.set(0, 0, 9.5)
    // glow: the particles bloom, then pass through the lens. No OutputPass:
    // the shaders already write display colours, and a second conversion
    // would wash the background out to grey
    const composer = new EffectComposer(renderer)
    composer.setPixelRatio(Math.min(window.devicePixelRatio, 1.5))
    composer.addPass(new RenderPass(world, cam))
    const bloom = new UnrealBloomPass(new THREE.Vector2(window.innerWidth, window.innerHeight), 1.05, 0.55, 0.18)
    composer.addPass(bloom)
    composer.addPass(new ShaderPass(LensShader))
    const resize = () => {
      renderer.setSize(window.innerWidth, window.innerHeight, false)
      composer.setSize(window.innerWidth, window.innerHeight)
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
    // a click on the empty page sends a shock wave through the cloud
    const toLocal = (x: number, y: number) => {
      ndc.set((x / window.innerWidth) * 2 - 1, -(y / window.innerHeight) * 2 + 1)
      ray.setFromCamera(ndc, cam)
      return ray.ray.intersectPlane(plane, hit) ? points.worldToLocal(hit.clone()) : null
    }
    const onDown = (e: PointerEvent) => {
      if ((e.target as Element | null)?.closest('button, a, input, select, textarea, label, [role="button"], .panel, .ex-card, .dialog')) return
      const at = toLocal(e.clientX, e.clientY)
      if (at) uni.uShock.value.set(at.x, at.y, uni.uTime.value, 1)
    }
    window.addEventListener('pointerdown', onDown)
    window.addEventListener('pointermove', onMove)
    document.addEventListener('pointerleave', onLeave)
    const onSettled = () => {
      convertKick.current = performance.now()
      // a settled swap rings out from the middle of the cloud
      uni.uShock.value.set(0, 0, uni.uTime.value, 1.3)
    }
    window.addEventListener(SETTLED_EVENT, onSettled)

    let stage = 0, x = 2.4, y = 0, scale = 1, raf = 0, prev = performance.now()
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame)
      if (document.hidden) return
      const dt = Math.min((now - prev) / 1000, 0.05)
      prev = now
      uni.uTime.value += reduce ? dt * 0.5 : dt
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

      // how hard the mouse is stirring
      const before = uni.uMouse.value.clone()
      uni.uMouse.value.lerp(mouseTarget, Math.min(1, dt * 8))
      const speed = mouseTarget.x > 50 ? 0 : before.distanceTo(uni.uMouse.value) / Math.max(dt, 1e-3)
      uni.uSwirl.value += (Math.min(1, speed / 6) - uni.uSwirl.value) * Math.min(1, dt * 3)

      // a world rings softly as a stream lands in it: blue lands in ember at
      // 0.14 of the 24 s act, ember in blue at 0.47, and at 0.8 both come
      // home together, so the ring starts between them and reaches both
      if (stage < 0.3) {
        const tt = uni.uTime.value
        for (const [phase, x] of [[0.14, 2.9], [0.47, -2.9], [0.8, 0]]) {
          const landAt = (Math.floor(tt / 24 - phase) + phase) * 24
          if (tt - landAt >= 0 && tt - landAt < dt * 1.5 + 0.02 && uni.uPing.value.z !== landAt) {
            uni.uPing.value.set(x, 0, landAt, x === 0 ? 0.5 : 0.4)
          }
        }
      }
      const t = uni.uTime.value
      points.rotation.y = Math.sin(t * 0.12) * 0.12 + (stage > 1 && stage < 2.5 ? (stage - 1) * 0.35 : stage >= 2.5 ? 0.525 * (3 - stage) * 2 : 0)
      points.rotation.x =
        Math.sin(t * 0.09) * 0.05 +
        (stage > 0.5 && stage < 1.5 ? 0.35 * Math.sin((stage - 0.5) * Math.PI) : 0) +
        (stage > 1.5 && stage < 2.8 ? 0.55 * Math.sin(((stage - 1.5) / 1.3) * Math.PI) : 0)
      // the far stars drift a touch against the cursor, for depth
      stars.uniforms.uTime.value = t
      const px = mouseTarget.x > 50 ? 0 : ndc.x, py = mouseTarget.x > 50 ? 0 : ndc.y
      stars.points.position.x += (-px * 0.6 - stars.points.position.x) * Math.min(1, dt * 2)
      stars.points.position.y += (-py * 0.35 - stars.points.position.y) * Math.min(1, dt * 2)
      composer.render()
    }
    raf = requestAnimationFrame(frame)

    return () => {
      cancelAnimationFrame(raf)
      reduceQuery.removeEventListener('change', onReduce)
      window.removeEventListener('resize', resize)
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerdown', onDown)
      document.removeEventListener('pointerleave', onLeave)
      window.removeEventListener(SETTLED_EVENT, onSettled)
      geo.dispose()
      mat.dispose()
      stars.dispose()
      composer.dispose()
      renderer.dispose()
    }
  }, [])

  return <canvas ref={canvasRef} className="particles" aria-hidden />
}
