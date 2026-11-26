// A brilliant-cut diamond drawn as particles on a 2D canvas.
// It turns slowly on its own, leans toward the pointer, and particles near the
// pointer get pushed away and spring back. `energy()` (0–1, e.g. the agent's
// output volume) makes it swell and shimmer while the agent talks.

const TAU = Math.PI * 2;

// ---------- geometry (unit size, y up) ----------

function buildGeometry() {
  const ring = (n, r, y, offset = 0) =>
    Array.from({ length: n }, (_, i) => {
      const a = (i / n) * TAU + offset;
      return [Math.cos(a) * r, y, Math.sin(a) * r];
    });

  const table = ring(8, 0.54, 0.42); // flat top
  const girdle = ring(16, 1, 0); // widest ring
  const culet = [0, -1.08, 0]; // bottom point
  const tableCentre = [0, 0.42, 0];

  const edges = [];
  const tris = [];
  const g = (j) => girdle[(j + 16) % 16];
  const t = (i) => table[(i + 8) % 8];

  for (let i = 0; i < 8; i++) {
    edges.push([t(i), t(i + 1)]); // table outline
    edges.push([t(i), g(2 * i)]); // crown mains
    edges.push([t(i), g(2 * i + 1)]); // star facets
    edges.push([t(i + 1), g(2 * i + 1)]);
    tris.push([tableCentre, t(i), t(i + 1)]);
    tris.push([t(i), g(2 * i), g(2 * i + 1)]);
    tris.push([t(i), t(i + 1), g(2 * i + 1)]);
    tris.push([t(i + 1), g(2 * i + 1), g(2 * i + 2)]);
  }
  for (let j = 0; j < 16; j++) {
    edges.push([g(j), g(j + 1)]); // girdle
    edges.push([g(j), culet]); // pavilion
    tris.push([culet, g(j), g(j + 1)]);
  }
  return { edges, tris };
}

const sub = (a, b) => [a[0] - b[0], a[1] - b[1], a[2] - b[2]];
const len = (v) => Math.hypot(v[0], v[1], v[2]);
const triArea = (a, b, c) => {
  const u = sub(b, a);
  const v = sub(c, a);
  return len([u[1] * v[2] - u[2] * v[1], u[2] * v[0] - u[0] * v[2], u[0] * v[1] - u[1] * v[0]]) / 2;
};

// Pick an item with probability proportional to its weight.
function weightedPicker(items, weights) {
  const total = weights.reduce((s, w) => s + w, 0);
  const cumulative = [];
  let acc = 0;
  for (const w of weights) cumulative.push((acc += w / total));
  return () => {
    const r = Math.random();
    let lo = 0;
    let hi = cumulative.length - 1;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (cumulative[mid] < r) lo = mid + 1;
      else hi = mid;
    }
    return items[lo];
  };
}

function samplePoints(count) {
  const { edges, tris } = buildGeometry();
  const pickEdge = weightedPicker(edges, edges.map(([a, b]) => len(sub(b, a))));
  const pickTri = weightedPicker(tris, tris.map(([a, b, c]) => triArea(a, b, c)));
  const points = [];
  const onEdges = Math.round(count * 0.4); // the rest fill the faces

  for (let i = 0; i < count; i++) {
    let p;
    if (i < onEdges) {
      const [a, b] = pickEdge();
      const k = Math.random();
      p = [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
    } else {
      const [a, b, c] = pickTri();
      let u = Math.random();
      let v = Math.random();
      if (u + v > 1) {
        u = 1 - u;
        v = 1 - v;
      }
      p = [
        a[0] + (b[0] - a[0]) * u + (c[0] - a[0]) * v,
        a[1] + (b[1] - a[1]) * u + (c[1] - a[1]) * v,
        a[2] + (b[2] - a[2]) * u + (c[2] - a[2]) * v,
      ];
    }
    points.push({ home: p, edge: i < onEdges });
  }
  return points;
}

// ---------- renderer ----------

export function createDiamond(canvas, { energy = () => 0 } = {}) {
  const ctx = canvas.getContext("2d");
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  let w = 0;
  let h = 0;
  let dpr = 1;
  let particles = [];
  let ink = "#141414";
  const YELLOW = "#f2b705"; // a deeper cut of the brand yellow, so it reads on cream

  const pointer = { x: -1e4, y: -1e4, nx: 0, ny: 0, active: false };
  const lean = { x: 0, y: 0 };
  let level = 0; // smoothed energy

  function readInk() {
    ink = getComputedStyle(canvas).getPropertyValue("--ink").trim() || ink;
  }

  function resize() {
    const rect = canvas.getBoundingClientRect();
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    w = Math.max(1, Math.round(rect.width * dpr));
    h = Math.max(1, Math.round(rect.height * dpr));
    canvas.width = w;
    canvas.height = h;

    // Particle count follows the canvas size so small screens stay light.
    const count = Math.round(Math.min(11000, Math.max(3000, (rect.width * rect.height) / 45)));
    if (particles.length !== count) {
      const fresh = samplePoints(count).map((p) => ({
        ...p,
        // Start scattered so the diamond assembles on load.
        x: Math.random() * w,
        y: Math.random() * h,
        vx: 0,
        vy: 0,
        phase: Math.random() * TAU,
        // Roughly a third of the particles are yellow, the rest ink.
        yellow: Math.random() < 0.36,
        speed: 0.6 + Math.random() * 0.8,
      }));
      // Keep each colour together so the canvas switches paint only once a frame.
      particles = fresh.sort((a, b) => a.yellow - b.yellow);
    }
  }

  function onPointerMove(event) {
    const rect = canvas.getBoundingClientRect();
    pointer.x = (event.clientX - rect.left) * dpr;
    pointer.y = (event.clientY - rect.top) * dpr;
    // Lean follows the pointer anywhere on the page, normalised to -1..1.
    pointer.nx = (event.clientX / window.innerWidth) * 2 - 1;
    pointer.ny = (event.clientY / window.innerHeight) * 2 - 1;
    pointer.active = true;
  }

  function onPointerLeave() {
    pointer.x = -1e4;
    pointer.y = -1e4;
    pointer.active = false;
  }

  // Clicking the diamond blows it apart; it then drifts back together slowly.
  // `blast` runs from 1 (just exploded) down to 0 (back to normal).
  let blast = 0;
  const BLAST_SECONDS = 4.5;

  function onPointerDown(event) {
    if (event.button !== 0) return;
    // Leave clicks on work cards, buttons and the message box alone.
    if (event.target.closest?.("a, button, input, textarea")) return;
    const rect = canvas.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    ) {
      return;
    }
    const cx = (event.clientX - rect.left) * dpr;
    const cy = (event.clientY - rect.top) * dpr;
    for (const p of particles) {
      const dx = p.x - cx;
      const dy = p.y - cy;
      const d = Math.hypot(dx, dy) || 1;
      // Outward from the click, with some scatter so it isn't a clean ring.
      const angle = Math.atan2(dy, dx) + (Math.random() - 0.5) * 0.9;
      const speed = (10 + Math.random() * Math.random() * 46) * dpr * (0.55 + 0.45 / (1 + d / (160 * dpr)));
      p.vx += Math.cos(angle) * speed;
      p.vy += Math.sin(angle) * speed;
    }
    blast = 1;
  }

  window.addEventListener("pointerdown", onPointerDown);
  window.addEventListener("pointermove", onPointerMove, { passive: true });
  document.addEventListener("pointerleave", onPointerLeave);
  window.addEventListener("blur", onPointerLeave);
  new ResizeObserver(resize).observe(canvas);
  window.matchMedia("(prefers-color-scheme: dark)").addEventListener("change", readInk);
  readInk();
  resize();

  let last = performance.now();
  let spin = 0;

  function frame(now) {
    const dt = Math.min(0.05, (now - last) / 1000);
    last = now;
    const calm = reduceMotion.matches;
    const t = now / 1000;

    level += ((Math.min(1, energy() * 1.6) || 0) - level) * 0.12;

    spin += dt * (calm ? 0.06 : 0.22 + level * 0.5);
    const targetX = pointer.active ? pointer.nx : 0;
    const targetY = pointer.active ? pointer.ny : 0;
    lean.x += (targetX - lean.x) * 0.04;
    lean.y += (targetY - lean.y) * 0.04;

    const rotY = spin + lean.x * 0.6;
    const rotX = -0.32 + lean.y * 0.28;
    const cy = Math.cos(rotY);
    const sy = Math.sin(rotY);
    const cx = Math.cos(rotX);
    const sx = Math.sin(rotX);

    const size = Math.min(w, h) * 0.3 * (1 + level * 0.1);
    const ox = w / 2;
    // The shape runs from +0.42 (table) to -1.08 (culet), so lift it to centre it.
    const oy = h / 2 - size * 0.33 + (calm ? 0 : Math.sin(t * 0.7) * size * 0.04);
    const camera = 3.4;
    const repelRadius = 120 * dpr;

    // While blown apart the pull home is almost off and particles coast; both
    // ease back to normal as `blast` runs down, so the shape reforms slowly.
    blast = Math.max(0, blast - dt / BLAST_SECONDS);
    const settle = (1 - blast) ** 3;
    const pull = 0.002 + 0.068 * settle;
    const drag = 0.8 + 0.165 * (1 - settle);
    const shimmer = calm ? 0 : 0.006 + level * 0.03;

    ctx.clearRect(0, 0, w, h);
    let painting = "";

    for (const p of particles) {
      let [x, y, z] = p.home;
      if (shimmer) {
        const s = Math.sin(t * p.speed * 2 + p.phase) * shimmer;
        x += x * s;
        y += y * s;
        z += z * s;
      }
      // rotate around Y, then X
      const x1 = x * cy + z * sy;
      const z1 = -x * sy + z * cy;
      const y2 = y * cx - z1 * sx;
      const z2 = y * sx + z1 * cx;

      const persp = camera / (camera - z2);
      const tx = ox + x1 * size * persp;
      const ty = oy - y2 * size * persp;

      // spring toward the projected home position
      p.vx += (tx - p.x) * pull;
      p.vy += (ty - p.y) * pull;

      // pointer pushes nearby particles away
      const dx = p.x - pointer.x;
      const dy = p.y - pointer.y;
      const d2 = dx * dx + dy * dy;
      if (d2 < repelRadius * repelRadius && d2 > 0.01) {
        const d = Math.sqrt(d2);
        const f = (1 - d / repelRadius) ** 2 * 9 * dpr;
        p.vx += (dx / d) * f;
        p.vy += (dy / d) * f;
      }

      p.vx *= drag;
      p.vy *= drag;
      p.x += p.vx;
      p.y += p.vy;

      // nearer particles are bigger and brighter; edges read stronger than faces
      const depth = (z2 + 1.1) / 2.2; // ~0 back, ~1 front
      const r = (p.edge ? 2.2 : 1.8) * dpr * (0.7 + depth * 0.75);
      const colour = p.yellow ? YELLOW : ink;
      if (colour !== painting) {
        ctx.fillStyle = colour;
        painting = colour;
      }
      // Yellow is a light colour on a light page, so it runs at fuller strength.
      ctx.globalAlpha = p.yellow
        ? 0.75 + depth * 0.25
        : (p.edge ? 0.7 : 0.45) + depth * (p.edge ? 0.3 : 0.4);
      ctx.fillRect(p.x - r / 2, p.y - r / 2, r, r);
    }
    ctx.globalAlpha = 1;
    requestAnimationFrame(frame);
  }

  requestAnimationFrame(frame);
}
