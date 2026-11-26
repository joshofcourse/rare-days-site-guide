// Reveals an agent message as one slow particle animation: the whole paragraph
// rises from below as a cloud of particles that settles into the exact shape
// of its letters, then the real text takes over. It starts the moment the
// message arrives, so the voice begins while the paragraph is still forming.
//
// Particles: every word is drawn to an offscreen canvas in the page's own font
// and its inked pixels are sampled, so each particle's resting place is a real
// point on a real glyph. They are drawn as GPU points in WebGL and animated
// entirely in the vertex shader, so tens of thousands at once stay smooth.

const LIFE = 3.4; // seconds the particles live
const TEXT_AT = 2.5; // when the real text starts fading in (matches style.css)
const STAGGER_STEP = 0.012; // seconds between one letter starting and the next
const STAGGER_MAX = 0.9; // cap on the whole paragraph's stagger, first letter to last
const MAX_PARTICLES = 120000; // ring buffer size
const FLOATS = 9; // per particle: target xy, origin xy, birth, life, seed, size, scroll0

const VERT = `
attribute vec2 aTarget;   // resting point on the glyph, CSS px
attribute vec2 aOrigin;   // where it starts, CSS px
attribute float aBirth;
attribute float aLife;
attribute float aSeed;
attribute float aSize;
attribute float aScroll;  // chat scroll position when it was born
uniform float uTime;
uniform float uScroll;
uniform vec2 uView;       // viewport, CSS px
uniform float uDpr;
varying float vAlpha;

void main() {
  float k = (uTime - aBirth) / aLife;
  if (k < 0.0 || k > 1.0) {
    gl_Position = vec4(2.0, 2.0, 0.0, 1.0);
    gl_PointSize = 0.0;
    vAlpha = 0.0;
    return;
  }
  // Rise and gather during the first 74% of life, then sit on the glyph.
  float g = clamp(k / 0.74, 0.0, 1.0);
  float ease = 1.0 - pow(1.0 - g, 3.0);

  // A swirl that dies away as the particle settles, so paths curve in
  // instead of flying straight.
  float loose = 1.0 - ease;
  float a = aSeed * 6.2831 + uTime * (1.5 + aSeed * 2.0);
  vec2 swirl = vec2(cos(a), sin(a * 1.3 + aSeed * 4.0)) * (4.0 + aSeed * 9.0) * loose;

  vec2 p = mix(aOrigin, aTarget, ease) + swirl;
  p.y -= uScroll - aScroll;

  vec2 clip = (p / uView) * 2.0 - 1.0;
  gl_Position = vec4(clip.x, -clip.y, 0.0, 1.0);

  // Bigger and softer while loose, tight on the glyph.
  gl_PointSize = aSize * uDpr * (1.0 + loose * 0.9);

  float fadeIn = smoothstep(0.0, 0.14, k);
  float fadeOut = 1.0 - smoothstep(0.82, 1.0, k);
  vAlpha = fadeIn * fadeOut * (0.8 + 0.2 * ease);
}`;

const FRAG = `
precision mediump float;
uniform vec3 uColor;
varying float vAlpha;
void main() {
  vec2 d = gl_PointCoord - 0.5;
  float r = dot(d, d) * 4.0;
  float soft = 1.0 - smoothstep(0.35, 1.0, r);
  float alpha = vAlpha * soft;
  gl_FragColor = vec4(uColor * alpha, alpha);
}`;

function createParticles() {
  const canvas = document.createElement("canvas");
  canvas.className = "word-particles";
  canvas.setAttribute("aria-hidden", "true");
  // ?keepbuffer lets a screenshot tool capture the canvas; not needed otherwise.
  const gl = canvas.getContext("webgl", {
    alpha: true,
    premultipliedAlpha: true,
    antialias: false,
    preserveDrawingBuffer: location.search.includes("keepbuffer"),
  });
  if (!gl) return null;
  document.body.appendChild(canvas);

  const compile = (type, src) => {
    const shader = gl.createShader(type);
    gl.shaderSource(shader, src);
    gl.compileShader(shader);
    if (!gl.getShaderParameter(shader, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(shader));
    return shader;
  };
  let program;
  try {
    program = gl.createProgram();
    gl.attachShader(program, compile(gl.VERTEX_SHADER, VERT));
    gl.attachShader(program, compile(gl.FRAGMENT_SHADER, FRAG));
    gl.linkProgram(program);
    if (!gl.getProgramParameter(program, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(program));
  } catch (err) {
    console.warn("[particles] WebGL unavailable:", err);
    canvas.remove();
    return null;
  }
  gl.useProgram(program);

  const data = new Float32Array(MAX_PARTICLES * FLOATS);
  const buffer = gl.createBuffer();
  gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
  gl.bufferData(gl.ARRAY_BUFFER, data, gl.DYNAMIC_DRAW);
  const stride = FLOATS * 4;
  const attrib = (name, size, offset) => {
    const loc = gl.getAttribLocation(program, name);
    gl.enableVertexAttribArray(loc);
    gl.vertexAttribPointer(loc, size, gl.FLOAT, false, stride, offset * 4);
  };
  attrib("aTarget", 2, 0);
  attrib("aOrigin", 2, 2);
  attrib("aBirth", 1, 4);
  attrib("aLife", 1, 5);
  attrib("aSeed", 1, 6);
  attrib("aSize", 1, 7);
  attrib("aScroll", 1, 8);

  const uTime = gl.getUniformLocation(program, "uTime");
  const uScroll = gl.getUniformLocation(program, "uScroll");
  const uView = gl.getUniformLocation(program, "uView");
  const uDpr = gl.getUniformLocation(program, "uDpr");
  const uColor = gl.getUniformLocation(program, "uColor");

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  let dpr = 1;
  function resize() {
    dpr = Math.min(window.devicePixelRatio || 1, 2);
    canvas.width = Math.round(window.innerWidth * dpr);
    canvas.height = Math.round(window.innerHeight * dpr);
    gl.viewport(0, 0, canvas.width, canvas.height);
  }
  window.addEventListener("resize", resize);
  resize();

  let head = 0; // next free slot in the ring
  let liveUntil = 0; // nothing to draw after this time
  let scroller = null;
  const start = performance.now();
  const now = () => (performance.now() - start) / 1000;

  // ---------- sampling a word's glyph pixels ----------

  const scratch = document.createElement("canvas");
  const sctx = scratch.getContext("2d", { willReadFrequently: true });
  const SCALE = 2;

  function glyphPoints(span, rect, style) {
    const w = Math.ceil(rect.width) + 4;
    const h = Math.ceil(rect.height) + 4;
    scratch.width = w * SCALE;
    scratch.height = h * SCALE;
    sctx.setTransform(SCALE, 0, 0, SCALE, 0, 0);
    sctx.clearRect(0, 0, w, h);
    sctx.font = `${style.fontStyle} ${style.fontWeight} ${style.fontSize} ${style.fontFamily}`;
    sctx.textBaseline = "alphabetic";
    sctx.fillStyle = "#000";
    const text = span.textContent;
    const m = sctx.measureText(text);
    // An inline box is as tall as the font's ascent + descent, so centre that
    // in the box to find the baseline.
    const ascent = m.fontBoundingBoxAscent ?? parseFloat(style.fontSize) * 0.8;
    const descent = m.fontBoundingBoxDescent ?? parseFloat(style.fontSize) * 0.2;
    const baseline = 2 + (rect.height - (ascent + descent)) / 2 + ascent;
    sctx.fillText(text, 2, baseline);

    const pixels = sctx.getImageData(0, 0, scratch.width, scratch.height).data;
    const points = [];
    for (let y = 0; y < scratch.height; y++) {
      for (let x = 0; x < scratch.width; x++) {
        if (pixels[(y * scratch.width + x) * 4 + 3] > 110) points.push(x / SCALE - 2, y / SCALE - 2);
      }
    }
    // Right-hand edge of each letter, so a particle knows which letter it is on.
    const edges = [];
    for (let i = 1; i <= text.length; i++) edges.push(sctx.measureText(text.slice(0, i)).width);
    return { points, edges }; // points: flat [x, y, x, y, …] relative to the span's box
  }

  // `delay` is when this word's first letter starts; each letter after it
  // starts `step` seconds later.
  function burst(span, delay = 0, step = 0) {
    const rect = span.getBoundingClientRect();
    if (rect.width === 0 || rect.bottom < 0 || rect.top > window.innerHeight) return;
    const style = getComputedStyle(span);
    const { points, edges } = glyphPoints(span, rect, style);
    const total = points.length / 2;
    if (!total) return;

    scroller = span.closest(".log");
    const scroll0 = scroller ? scroller.scrollTop : 0;
    const rgb = style.color.match(/[\d.]+/g)?.slice(0, 3).map((v) => v / 255) ?? [0.11, 0.11, 0.12];
    gl.uniform3f(uColor, rgb[0], rgb[1], rgb[2]);

    // Enough particles to read as solid letters, capped per word so a long
    // paragraph still fits the buffer.
    const count = Math.min(total, Math.max(160, Math.min(900, Math.round(rect.width * 9))));
    const t = now();
    const first = head;
    for (let i = 0; i < count; i++) {
      const pick = Math.floor(Math.random() * total) * 2;
      let letter = 0;
      while (letter < edges.length - 1 && points[pick] > edges[letter]) letter++;
      const tx = rect.left + points[pick] + (Math.random() - 0.5) * 0.5;
      const ty = rect.top + points[pick + 1] + (Math.random() - 0.5) * 0.5;
      // Start below the paragraph, loosely under where it will land.
      const drop = 50 + Math.random() * Math.random() * 190;
      const o = head * FLOATS;
      data[o] = tx;
      data[o + 1] = ty;
      data[o + 2] = tx + (Math.random() - 0.5) * (24 + drop * 0.5);
      data[o + 3] = ty + drop;
      data[o + 4] = t + delay + letter * step + Math.random() * 0.14;
      data[o + 5] = LIFE * (0.86 + Math.random() * 0.14);
      data[o + 6] = Math.random();
      data[o + 7] = 1.3 + Math.random() * 0.6;
      data[o + 8] = scroll0;
      head = (head + 1) % MAX_PARTICLES;
    }
    // Upload just what changed (two ranges if the ring wrapped).
    gl.bindBuffer(gl.ARRAY_BUFFER, buffer);
    if (first + count <= MAX_PARTICLES) {
      gl.bufferSubData(gl.ARRAY_BUFFER, first * stride, data.subarray(first * FLOATS, (first + count) * FLOATS));
    } else {
      gl.bufferSubData(gl.ARRAY_BUFFER, first * stride, data.subarray(first * FLOATS));
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, data.subarray(0, head * FLOATS));
    }
    liveUntil = Math.max(liveUntil, t + delay + edges.length * step + LIFE + 0.6);
  }

  let cleared = true;
  function draw() {
    const t = now();
    if (t > liveUntil) {
      if (!cleared) {
        gl.clearColor(0, 0, 0, 0);
        gl.clear(gl.COLOR_BUFFER_BIT);
        cleared = true;
      }
      return;
    }
    cleared = false;
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    gl.uniform1f(uTime, t);
    gl.uniform1f(uScroll, scroller ? scroller.scrollTop : 0);
    gl.uniform2f(uView, window.innerWidth, window.innerHeight);
    gl.uniform1f(uDpr, dpr);
    gl.drawArrays(gl.POINTS, 0, MAX_PARTICLES);
  }

  return { burst, draw };
}

export function createSpeaker() {
  const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)");
  const particles = createParticles();
  const animated = () => Boolean(particles) && !reduceMotion.matches;
  if (!particles) document.documentElement.classList.add("no-particles");

  let current = null; // { row, timer, resolve } for the paragraph still forming

  function done() {
    if (!current) return;
    clearTimeout(current.timer);
    current.resolve();
    current = null;
  }

  // Show a paragraph. The text is laid out invisibly straight away, so the row
  // has its final size, then the particles form it. Resolves once the real
  // text is fully on screen.
  function say(row, text) {
    finish();
    row.textContent = "";
    row.classList.add("spoken");
    const spans = [];
    for (const part of text.split(/(\s+)/)) {
      if (!part) continue;
      if (/^\s+$/.test(part)) {
        row.appendChild(document.createTextNode(part));
        continue;
      }
      const span = document.createElement("span");
      span.className = "w";
      span.textContent = part;
      row.appendChild(span);
      spans.push(span);
    }
    // Letter by letter in reading order, each starting a touch after the last.
    // The offset is kept subtle: under a second from first letter to last.
    const letters = spans.reduce((n, span) => n + span.textContent.length, 0);
    const step = Math.min(STAGGER_STEP, STAGGER_MAX / Math.max(1, letters));
    const spread = animated() ? letters * step : 0;
    if (animated()) {
      let index = 0;
      for (const span of spans) {
        particles.burst(span, index * step, step);
        span.style.setProperty("--d", `${(index * step).toFixed(3)}s`);
        index += span.textContent.length;
      }
    }
    // Next frame, so the hidden state is painted before the fade-in is armed.
    requestAnimationFrame(() => row.classList.add("on"));
    return new Promise((resolve) => {
      const wait = animated() ? (TEXT_AT + spread + 0.7) * 1000 : 500;
      current = { row, resolve, timer: setTimeout(done, wait) };
    });
  }

  // Cut short (the visitor interrupted): put the text up now.
  function finish() {
    if (!current) return;
    current.row.classList.add("on", "now");
    done();
  }

  function frame() {
    particles?.draw();
    requestAnimationFrame(frame);
  }
  requestAnimationFrame(frame);

  return { say, finish };
}
