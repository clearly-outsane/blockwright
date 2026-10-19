import { VoxelSet, type Box } from '../voxel/voxels.js';
import { blockColor } from '../blocks/colors.js';
import { blockBoxes, isFullOpaque, occludes, type Box3 } from './model.js';

export const VIEWS = ['iso_ne', 'iso_nw', 'iso_se', 'iso_sw', 'top', 'north', 'south', 'east', 'west', 'eye'] as const;
export type View = (typeof VIEWS)[number];

export interface RenderOptions {
  view: View;
  /** Pixels per block along the widest axis; chosen to fit maxPixels when omitted. */
  scale?: number;
  maxPixels?: number;
  background?: [number, number, number];
  /** Block short names (or `prefix*` globs) drawn as if they were air. */
  hide?: string[];
  /** Ignore everything above this y — lets a roof be lifted off an interior. */
  cutawayY?: number;
  /** Outline every block face so single blocks can be counted (the render tool turns this on). */
  edges?: boolean;
  /** Eye view: where the camera stands and what it looks at (world coordinates). */
  eye?: [number, number, number];
  lookAt?: [number, number, number];
  /** Eye view: horizontal field of view in degrees (default 75). */
  fov?: number;
}

export interface RenderedScene {
  width: number;
  height: number;
  pixels: Uint8Array;
  blocks: number;
  scale: number;
  /** World-space box actually drawn. */
  box: Box;
}

/** Camera basis: `dir` points from the scene toward the viewer. */
function basis(view: View): { dir: [number, number, number]; right: [number, number, number]; up: [number, number, number] } {
  const d: Record<View, [number, number, number]> = {
    iso_ne: [1, 1, -1], iso_nw: [-1, 1, -1], iso_se: [1, 1, 1], iso_sw: [-1, 1, 1],
    top: [0, 1, 0], north: [0, 0, -1], south: [0, 0, 1], east: [1, 0, 0], west: [-1, 0, 0],
    eye: [0, 0, 1],   // unused: the eye view builds its own camera
  };
  const dir = norm(d[view]);
  // For a straight-down view the world up-axis is parallel to the camera, so north is used as
  // the reference instead; that also keeps north at the top of the image, like a map.
  const ref: [number, number, number] = view === 'top' ? [0, 0, -1] : [0, 1, 0];
  const right = norm(cross(ref, dir));
  const up = cross(dir, right);
  return { dir, right, up };
}

const norm = (v: [number, number, number]): [number, number, number] => {
  const l = Math.hypot(v[0], v[1], v[2]) || 1;
  return [v[0] / l, v[1] / l, v[2] / l];
};
const cross = (a: [number, number, number], b: [number, number, number]): [number, number, number] => [
  a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0],
];
const dot = (a: [number, number, number], b: [number, number, number]): number => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];

/** Outward normals of the six cube faces, with the corner order that keeps each quad convex. */
const FACES: Array<{ n: [number, number, number]; corners: Array<[keyof Box3, keyof Box3, keyof Box3]> }> = [
  { n: [0, 1, 0], corners: [['x0', 'y1', 'z0'], ['x1', 'y1', 'z0'], ['x1', 'y1', 'z1'], ['x0', 'y1', 'z1']] },
  { n: [0, -1, 0], corners: [['x0', 'y0', 'z0'], ['x0', 'y0', 'z1'], ['x1', 'y0', 'z1'], ['x1', 'y0', 'z0']] },
  { n: [1, 0, 0], corners: [['x1', 'y0', 'z0'], ['x1', 'y0', 'z1'], ['x1', 'y1', 'z1'], ['x1', 'y1', 'z0']] },
  { n: [-1, 0, 0], corners: [['x0', 'y0', 'z0'], ['x0', 'y1', 'z0'], ['x0', 'y1', 'z1'], ['x0', 'y0', 'z1']] },
  { n: [0, 0, 1], corners: [['x0', 'y0', 'z1'], ['x0', 'y1', 'z1'], ['x1', 'y1', 'z1'], ['x1', 'y0', 'z1']] },
  { n: [0, 0, -1], corners: [['x0', 'y0', 'z0'], ['x1', 'y0', 'z0'], ['x1', 'y1', 'z0'], ['x0', 'y1', 'z0']] },
];

/** Face brightness: sunlight from above and slightly to one side, so the three visible sides of
 * a cube never share a tone and edges stay readable without drawing outlines. */
function faceShade(n: [number, number, number]): number {
  if (n[1] > 0) return 1;
  if (n[1] < 0) return 0.45;
  if (n[0] !== 0) return 0.78;
  return 0.62;
}

/** Tiny glob: `*` stands for any run of characters, so `*_leaves`, `oak_*` and `*fence*` all
 * work. Anything without a `*` has to match the short name exactly. */
function matches(name: string, patterns: string[]): boolean {
  for (const p of patterns) {
    if (!p.includes('*')) {
      if (name === p) return true;
      continue;
    }
    const parts = p.split('*');
    let at = 0;
    let fits = true;
    for (let i = 0; i < parts.length && fits; i++) {
      const part = parts[i];
      if (part === '') continue;
      if (i === 0) {
        if (!name.startsWith(part)) fits = false;
        else at = part.length;
      } else if (i === parts.length - 1) {
        if (!name.endsWith(part) || name.length - part.length < at) fits = false;
      } else {
        const idx = name.indexOf(part, at);
        if (idx < 0) fits = false;
        else at = idx + part.length;
      }
    }
    if (fits) return true;
  }
  return false;
}

type Vec = [number, number, number];
type Rgb = [number, number, number];
const sub = (a: Vec, b: Vec): Vec => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];

/** See-through blocks are blended over what is behind them instead of painted solid, so a glass
 * wall shows the room inside it and a window grid reads as a grid. */
function opacity(name: string): number {
  if (/glass/.test(name)) return 0.28;
  if (name === 'water') return 0.6;
  if (/ice$/.test(name)) return 0.65;
  return 1;
}

interface Cell { x: number; y: number; z: number; color: Rgb; boxes: Box3[]; alpha: number }

function collectCells(set: VoxelSet, opts: RenderOptions): Cell[] {
  const hide = opts.hide ?? [];
  const cells: Cell[] = [];
  for (const [[x, y, z], state] of set.entries()) {
    if (state.isAir) continue;
    if (opts.cutawayY !== undefined && y > opts.cutawayY) continue;
    if (hide.length && matches(state.shortName, hide)) continue;
    const boxes = blockBoxes(state);
    if (boxes.length === 0) continue;
    // A block wrapped in full cubes contributes nothing but work: skipping it here is what keeps
    // a solid hillside from rasterising every buried stone block.
    if (occludes(state) && neighboursOpaque(set, x, y, z, hide, opts.cutawayY)) continue;
    const c = blockColor(state);
    cells.push({ x, y, z, color: [c.r, c.g, c.b], boxes, alpha: opacity(state.shortName) });
  }
  if (cells.length === 0) throw new Error('nothing to render: every block in the region is air or hidden');
  return cells;
}

const shaded = (c: Rgb, f: number): Rgb => [Math.min(255, Math.round(c[0] * f)), Math.min(255, Math.round(c[1] * f)), Math.min(255, Math.round(c[2] * f))];

export function renderScene(set: VoxelSet, opts: RenderOptions): RenderedScene {
  const bounds = set.bounds();
  if (!bounds) throw new Error('nothing to render: the region is empty');
  const cells = collectCells(set, opts);
  return opts.view === 'eye' ? renderEye(cells, opts, bounds) : renderOrtho(cells, opts, bounds);
}

function renderOrtho(cells: Cell[], opts: RenderOptions, bounds: Box): RenderedScene {
  const { dir, right, up } = basis(opts.view);
  // Painter's algorithm: for an orthographic camera and axis-aligned boxes, ordering whole cells
  // by the depth of their centre is enough — neighbouring cells never interleave.
  const depth = (c: Cell): number => dot([c.x + 0.5, c.y + 0.5, c.z + 0.5], dir);
  cells.sort((a, b2) => depth(a) - depth(b2));

  let uMin = Infinity, uMax = -Infinity, vMin = Infinity, vMax = -Infinity;
  const project = (x: number, y: number, z: number): [number, number] => [
    dot([x, y, z], right), -dot([x, y, z], up),
  ];
  for (const c of cells) {
    for (const dx of [0, 1]) for (const dy of [0, 1]) for (const dz of [0, 1]) {
      const [u, v] = project(c.x + dx, c.y + dy, c.z + dz);
      if (u < uMin) uMin = u; if (u > uMax) uMax = u;
      if (v < vMin) vMin = v; if (v > vMax) vMax = v;
    }
  }
  const maxPixels = opts.maxPixels ?? 2400;
  const spanU = Math.max(uMax - uMin, 1e-6);
  const spanV = Math.max(vMax - vMin, 1e-6);
  const scale = opts.scale ?? Math.max(1, Math.min(48, Math.floor(maxPixels / Math.max(spanU, spanV))));
  const pad = 1;
  const width = Math.max(1, Math.min(8192, Math.ceil(spanU * scale) + pad * 2));
  const height = Math.max(1, Math.min(8192, Math.ceil(spanV * scale) + pad * 2));
  const bg = opts.background ?? [150, 180, 215];
  const px = canvas(width, height, bg);
  const toPixel = (x: number, y: number, z: number): [number, number] => {
    const [u, v] = project(x, y, z);
    return [(u - uMin) * scale + pad, (v - vMin) * scale + pad];
  };
  // Block edges: a darker outline on every face so single blocks can be counted, even across a
  // wall of one material. Skipped when blocks are too small for a line to help.
  const edges = (opts.edges ?? false) && scale >= 6;

  for (const c of cells) {
    for (const bx of c.boxes) {
      for (const face of FACES) {
        if (dot(face.n, dir) <= 0) continue;
        const poly = face.corners.map(([kx, ky, kz]) => toPixel(c.x + bx[kx], c.y + bx[ky], c.z + bx[kz]));
        const rgb = shaded(c.color, faceShade(face.n));
        fillPolygon(px, width, height, poly, rgb, c.alpha);
        if (edges) strokePolygon(px, width, height, poly, shaded(rgb, 0.62), Math.min(1, c.alpha + 0.35));
      }
    }
  }
  return { width, height, pixels: px, blocks: cells.length, scale, box: bounds };
}

/**
 * Eye-level perspective: stand at `eye` and look at `lookAt`, the way a player sees the place.
 * Faces are sorted far to near by their own centre (painter's algorithm), clipped against a near
 * plane so blocks right beside the camera still draw, and faded a little with distance.
 */
function renderEye(cells: Cell[], opts: RenderOptions, bounds: Box): RenderedScene {
  if (!opts.eye || !opts.lookAt) throw new Error('the eye view needs eye and look_at');
  const eye = opts.eye as Vec;
  const f = norm(sub(opts.lookAt as Vec, eye));
  const worldUp: Vec = Math.abs(f[1]) > 0.98 ? [0, 0, -1] : [0, 1, 0];
  const r = norm(cross(f, worldUp));
  const u = cross(r, f);
  const width = Math.max(64, Math.min(4096, opts.maxPixels ?? 1600));
  const height = Math.round(width * 0.625);
  const focal = width / 2 / Math.tan(((opts.fov ?? 75) * Math.PI) / 360);
  const NEAR = 0.05;
  const bg = opts.background ?? [150, 180, 215];
  const px = canvas(width, height, bg);

  type Face = { pts: Array<[number, number]>; dist: number; rgb: Rgb; alpha: number };
  const faces: Face[] = [];
  for (const c of cells) {
    const cd = sub([c.x + 0.5, c.y + 0.5, c.z + 0.5], eye);
    if (dot(cd, f) < -1) continue;   // wholly behind the camera
    for (const bx of c.boxes) {
      for (const face of FACES) {
        const corners = face.corners.map(([kx, ky, kz]) => [c.x + bx[kx], c.y + bx[ky], c.z + bx[kz]] as Vec);
        const centre: Vec = [0, 1, 2].map((i) => corners.reduce((t, p) => t + p[i], 0) / 4) as Vec;
        if (dot(face.n, sub(eye, centre)) <= 0) continue;   // facing away
        const cam = corners.map((p) => { const d = sub(p, eye); return [dot(d, r), dot(d, u), dot(d, f)] as Vec; });
        const clipped = clipNear(cam, NEAR);
        if (clipped.length < 3) continue;
        const pts = clipped.map(([x, y, z]) => [width / 2 + (x / z) * focal, height / 2 - (y / z) * focal] as [number, number]);
        const dist = Math.hypot(...sub(centre, eye));
        const fog = Math.max(0, Math.min(0.5, (dist - 12) / 90));
        const lit = shaded(c.color, faceShade(face.n));
        const rgb: Rgb = [0, 1, 2].map((i) => Math.round(lit[i] * (1 - fog) + bg[i] * fog)) as Rgb;
        faces.push({ pts, dist, rgb, alpha: c.alpha });
      }
    }
  }
  faces.sort((a, b2) => b2.dist - a.dist);
  for (const fc of faces) {
    fillPolygon(px, width, height, fc.pts, fc.rgb, fc.alpha);
    if (opts.edges ?? false) {
      let span = 0;
      for (let i = 0; i < fc.pts.length; i++) { const [ax, ay] = fc.pts[i]; const [bx2, by] = fc.pts[(i + 1) % fc.pts.length]; span += Math.abs(bx2 - ax) + Math.abs(by - ay); }
      if (span > 16) strokePolygon(px, width, height, fc.pts, shaded(fc.rgb, 0.62), Math.min(1, fc.alpha + 0.35));
    }
  }
  return { width, height, pixels: px, blocks: cells.length, scale: Math.round(focal / 10), box: bounds };
}

/** Sutherland–Hodgman against the plane z = near, in camera space. */
function clipNear(poly: Vec[], near: number): Vec[] {
  const out: Vec[] = [];
  for (let i = 0; i < poly.length; i++) {
    const a = poly[i], b2 = poly[(i + 1) % poly.length];
    const ain = a[2] >= near, bin = b2[2] >= near;
    if (ain) out.push(a);
    if (ain !== bin) {
      const t = (near - a[2]) / (b2[2] - a[2]);
      out.push([a[0] + (b2[0] - a[0]) * t, a[1] + (b2[1] - a[1]) * t, near]);
    }
  }
  return out;
}

function canvas(width: number, height: number, bg: [number, number, number]): Uint8Array {
  const px = new Uint8Array(width * height * 3);
  for (let i = 0; i < width * height; i++) {
    px[i * 3] = bg[0]; px[i * 3 + 1] = bg[1]; px[i * 3 + 2] = bg[2];
  }
  return px;
}

function neighboursOpaque(set: VoxelSet, x: number, y: number, z: number, hide: string[], cutawayY: number | undefined): boolean {
  for (const [dx, dy, dz] of [[1, 0, 0], [-1, 0, 0], [0, 1, 0], [0, -1, 0], [0, 0, 1], [0, 0, -1]] as const) {
    const ny = y + dy;
    if (cutawayY !== undefined && ny > cutawayY) return false;
    const s = set.get(x + dx, ny, z + dz);
    if (!s || !occludes(s)) return false;
    if (hide.length && matches(s.shortName, hide)) return false;
  }
  return true;
}

function put(px: Uint8Array, i: number, rgb: Rgb, alpha: number): void {
  if (alpha >= 1) { px[i] = rgb[0]; px[i + 1] = rgb[1]; px[i + 2] = rgb[2]; return; }
  px[i] = Math.round(px[i] * (1 - alpha) + rgb[0] * alpha);
  px[i + 1] = Math.round(px[i + 1] * (1 - alpha) + rgb[1] * alpha);
  px[i + 2] = Math.round(px[i + 2] * (1 - alpha) + rgb[2] * alpha);
}

/** Scanline fill of a convex polygon. Half-open on the right/bottom edge so neighbouring faces
 * tile without leaving seams or double-drawing a shared column of pixels. */
function fillPolygon(px: Uint8Array, width: number, height: number, poly: Array<[number, number]>, rgb: Rgb, alpha = 1): void {
  let yMin = Infinity, yMax = -Infinity;
  for (const [, y] of poly) { if (y < yMin) yMin = y; if (y > yMax) yMax = y; }
  const y0 = Math.max(0, Math.floor(yMin));
  const y1 = Math.min(height - 1, Math.ceil(yMax));
  for (let y = y0; y <= y1; y++) {
    const cy = y + 0.5;
    let xLo = Infinity, xHi = -Infinity;
    for (let i = 0; i < poly.length; i++) {
      const [ax, ay] = poly[i];
      const [bx, by] = poly[(i + 1) % poly.length];
      if (ay === by) continue;
      if (cy < Math.min(ay, by) || cy >= Math.max(ay, by)) continue;
      const t = (cy - ay) / (by - ay);
      const x = ax + (bx - ax) * t;
      if (x < xLo) xLo = x;
      if (x > xHi) xHi = x;
    }
    if (xLo > xHi) continue;
    const sx = Math.max(0, Math.floor(xLo));
    const ex = Math.min(width - 1, Math.ceil(xHi) - 1);
    for (let x = sx; x <= ex; x++) put(px, (y * width + x) * 3, rgb, alpha);
  }
}

/** One-pixel outline of a polygon (DDA lines). */
function strokePolygon(px: Uint8Array, width: number, height: number, poly: Array<[number, number]>, rgb: Rgb, alpha: number): void {
  for (let i = 0; i < poly.length; i++) {
    const [ax, ay] = poly[i];
    const [bx, by] = poly[(i + 1) % poly.length];
    const n = Math.ceil(Math.max(Math.abs(bx - ax), Math.abs(by - ay)));
    for (let k = 0; k <= n; k++) {
      const t = n ? k / n : 0;
      const x = Math.floor(ax + (bx - ax) * t), y = Math.floor(ay + (by - ay) * t);
      if (x < 0 || y < 0 || x >= width || y >= height) continue;
      put(px, (y * width + x) * 3, rgb, alpha);
    }
  }
}
