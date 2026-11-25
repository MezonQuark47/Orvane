// Where the landing is in its story, for the particle scene: 0 two tokens,
// 1 one pool, 2 two checks, 3 your swap. The landing writes it on scroll and
// the scene reads it every frame. Kept free of three.js so the landing does
// not pull the 3D bundle in.

export const landingStage = { value: 0, active: false }
