/*!
 * Loupe — image zoom with a gliding lens. MIT © 2026 Yagnik Barasiya
 * https://github.com/YagnikBarasiya23/loupe-image-zoom
 */

export const clamp = (value, min, max) => Math.max(min, Math.min(max, value));

/**
 * Lens mode. `point` is the pointer inside the image (px). The lens is centred
 * on it; the magnified copy inside is scaled by `zoom` from its top-left and
 * shifted so the same image point sits under the lens centre.
 */
export function lensTransform(point, zoom, lensSize) {
  const r = lensSize / 2;
  return {
    lens: { x: point.x - r, y: point.y - r },
    inner: { x: r - point.x * zoom, y: r - point.y * zoom },
  };
}

/**
 * Inside mode. The image itself scales by `zoom` so the point under the
 * pointer stays under the pointer, which keeps the edges of the image pinned
 * to the frame edges.
 */
export const insideTransform = (point, zoom) => ({ x: point.x * (1 - zoom), y: point.y * (1 - zoom) });

/** Keeps a scaled image covering its frame: no gaps at any edge. */
export function clampPan(x, y, scale, size) {
  return {
    x: clamp(x, size.width * (1 - scale), 0),
    y: clamp(y, size.height * (1 - scale), 0),
  };
}

/**
 * Two-finger gesture. Given the pan/scale when the pinch began, the midpoint
 * and distance then, and the midpoint and distance now, returns the new pan
 * and scale so the content under the fingers stays under the fingers.
 */
export function pinch(start, from, to, { min = 1, max = 6 } = {}) {
  const scale = clamp(start.scale * (to.distance / from.distance), min * 0.8, max * 1.15);
  const ratio = scale / start.scale;
  return {
    scale,
    x: to.mid.x - (from.mid.x - start.x) * ratio,
    y: to.mid.y - (from.mid.y - start.y) * ratio,
  };
}

const reduced = () => typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches;
const fine = () => typeof matchMedia === 'function' && matchMedia('(hover: hover) and (pointer: fine)').matches;

export default class Loupe {
  constructor(root, { mode = 'lens', zoom = 2.5, min = 1.5, max = 6, size = 180, src, wheel = false, stiffness = 320, damping = 30 } = {}) {
    this.root = root;
    this.img = root.querySelector('img');
    this.options = { mode, min, max, size, wheel, stiffness, damping };
    this.src = src ?? root.dataset.zoomSrc ?? this.img.currentSrc ?? this.img.src;
    // Spring state: pointer point (x, y), zoom level (z), lens visibility (v),
    // and touch pan/scale (px, py, ps). Each has a target (t*) and velocity (d*).
    this.s = { x: 0, y: 0, z: zoom, v: 0, px: 0, py: 0, ps: 1 };
    this.t = { ...this.s };
    this.d = { x: 0, y: 0, z: 0, v: 0, px: 0, py: 0, ps: 0 };
    this.frame = 0;
    this.active = false;
    this.pointers = new Map();

    root.classList.add('loupe');
    root.tabIndex = 0;
    root.setAttribute('role', 'group');
    root.setAttribute('aria-roledescription', 'zoomable image');
    root.setAttribute('aria-label', `${this.img.alt || 'Image'}. Press Enter to zoom, arrow keys to move, plus and minus to change zoom.`);

    this.lens = document.createElement('div');
    this.lens.className = 'loupe-lens';
    this.lens.setAttribute('aria-hidden', 'true');
    this.inner = document.createElement('img');
    this.inner.className = 'loupe-lens-img';
    this.inner.alt = '';
    this.inner.decoding = 'async';
    this.lens.append(this.inner);
    this.status = document.createElement('span');
    this.status.className = 'loupe-status';
    this.status.setAttribute('aria-live', 'polite');
    root.append(this.lens, this.status);
    this.setImage(this.img.currentSrc || this.img.src, this.src, this.img.alt);

    const on = (target, type, fn, opts) => {
      target.addEventListener(type, fn, opts);
      return () => target.removeEventListener(type, fn, opts);
    };
    this.off = [
      on(root, 'pointerenter', this.onEnter),
      on(root, 'pointermove', this.onMove),
      on(root, 'pointerleave', this.onLeave),
      on(root, 'pointerdown', this.onDown),
      on(root, 'pointerup', this.onUp),
      on(root, 'pointercancel', this.onUp),
      on(root, 'wheel', this.onWheel, { passive: false }),
      on(root, 'keydown', this.onKey),
      on(root, 'blur', () => this.keyboard && this.deactivate()),
    ];
    this.resize = new ResizeObserver(() => this.measure());
    this.resize.observe(root);
    this.measure();
  }

  /** Swaps to another picture; `zoomSrc` is the high-resolution file for magnifying. */
  setImage(src, zoomSrc = src, alt) {
    this.deactivate(true);
    this.img.src = src;
    if (alt !== undefined) this.img.alt = alt;
    // Absolute URL, so comparing with img.src never reloads the same file.
    this.src = new URL(zoomSrc, document.baseURI).href;
    this.inner.src = this.src;
    this.loaded = false;
    // Warm the large file so the first zoom is sharp.
    const probe = new Image();
    probe.decoding = 'async';
    probe.src = zoomSrc;
    probe.decode?.().then(() => { this.loaded = true; }).catch(() => {});
    this.resetTouch(true);
    this.measure();
  }

  configure(options) {
    if (options.mode && options.mode !== this.options.mode) this.deactivate(true);
    Object.assign(this.options, options);
    if (options.zoom !== undefined) this.setZoom(options.zoom);
    this.measure();
    return this;
  }

  setZoom(zoom) {
    this.t.z = clamp(zoom, this.options.min, this.options.max);
    this.root.dispatchEvent(new CustomEvent('loupe:zoom', { detail: { zoom: this.t.z } }));
    this.run();
  }

  destroy() {
    cancelAnimationFrame(this.frame);
    this.off.forEach(off => off());
    this.resize.disconnect();
    this.lens.remove();
    this.status.remove();
    this.img.style.transform = '';
    this.root.classList.remove('loupe', 'is-active', 'is-inside', 'is-touch');
  }

  measure() {
    // Layout size, not the on-screen box: the image may be scaled right now.
    const rect = { width: this.img.offsetWidth, height: this.img.offsetHeight };
    this.size = rect;
    this.lens.style.width = this.lens.style.height = `${this.options.size}px`;
    this.inner.style.width = `${rect.width}px`;
    this.inner.style.height = `${rect.height}px`;
    this.root.classList.toggle('is-inside', this.options.mode === 'inside');
    this.paint();
  }

  point(event) {
    const frame = this.root.getBoundingClientRect();
    return { x: clamp(event.clientX - frame.left, 0, this.size.width), y: clamp(event.clientY - frame.top, 0, this.size.height) };
  }

  activate(at, snap) {
    this.active = true;
    this.root.classList.add('is-active');
    if (this.options.mode === 'inside' && this.img.src !== this.src) this.img.src = this.src;
    this.t.x = at.x;
    this.t.y = at.y;
    this.t.v = 1;
    if (snap) {
      this.s.x = at.x;
      this.s.y = at.y;
    }
    this.run();
  }

  deactivate(now = false) {
    if (!this.active && !now) return;
    this.active = false;
    this.keyboard = false;
    this.root.classList.remove('is-active');
    this.t.v = 0;
    if (now) {
      this.s.v = 0;
      this.d.v = 0;
      this.paint();
    } else {
      this.run();
    }
  }

  resetTouch(now) {
    Object.assign(this.t, { px: 0, py: 0, ps: 1 });
    if (now) Object.assign(this.s, { px: 0, py: 0, ps: 1 });
    this.root.classList.remove('is-touch');
    this.run();
  }

  onEnter = event => {
    if (event.pointerType !== 'mouse' || !fine()) return;
    // The lens appears exactly under the cursor, then glides from there.
    this.activate(this.point(event), true);
  };

  onMove = event => {
    if (event.pointerType !== 'mouse') return this.onTouchMove(event);
    if (!this.active) return;
    const p = this.point(event);
    this.t.x = p.x;
    this.t.y = p.y;
    this.run();
  };

  onLeave = event => {
    if (event.pointerType === 'mouse') this.deactivate();
  };

  onWheel = event => {
    if (!this.options.wheel || !this.active) return;
    event.preventDefault();
    this.setZoom(this.t.z * Math.exp(-event.deltaY * 0.0015));
  };

  /* ---------- Touch: pinch, pan, double-tap ---------- */

  onDown = event => {
    if (event.pointerType === 'mouse') return;
    // Capture can fail if the pointer already lifted; the gesture still works without it.
    try { this.root.setPointerCapture(event.pointerId); } catch {}
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const now = event.timeStamp;
    if (this.pointers.size === 1) {
      if (now - (this.lastTap ?? 0) < 280) {
        this.doubleTap(event);
        this.lastTap = 0;
        return;
      }
      this.lastTap = now;
    }
    this.gesture = this.snapshot();
  };

  onTouchMove(event) {
    if (!this.pointers.has(event.pointerId)) return;
    this.pointers.set(event.pointerId, { x: event.clientX, y: event.clientY });
    const now = this.snapshot();
    const start = this.gesture;
    if (!start || now.count !== start.count) {
      this.gesture = now;
      return;
    }
    const origin = { x: start.pan.x, y: start.pan.y, scale: start.pan.scale };
    let next;
    if (now.count >= 2) {
      next = pinch(origin, start, now, this.options);
    } else {
      if (this.t.ps <= 1.01) return; // let the page scroll when not zoomed
      next = { scale: origin.scale, x: origin.x + now.mid.x - start.mid.x, y: origin.y + now.mid.y - start.mid.y };
    }
    event.preventDefault();
    this.lastTap = 0;
    this.root.classList.add('is-touch');
    if (this.img.src !== this.src) this.img.src = this.src;
    // Follow the fingers directly; springs take over on release.
    Object.assign(this.t, { px: next.x, py: next.y, ps: next.scale });
    Object.assign(this.s, { px: next.x, py: next.y, ps: next.scale });
    this.paint();
  }

  onUp = event => {
    if (event.pointerType === 'mouse') return;
    this.pointers.delete(event.pointerId);
    this.gesture = this.pointers.size ? this.snapshot() : null;
    if (this.pointers.size) return;
    // Settle: back to fit below 1×, into range above max, edges covered.
    if (this.t.ps < 1.05) return this.resetTouch();
    const scale = Math.min(this.t.ps, this.options.max);
    const ratio = scale / this.t.ps;
    const mid = this.lastMid ?? { x: this.size.width / 2, y: this.size.height / 2 };
    const pan = clampPan(mid.x - (mid.x - this.t.px) * ratio, mid.y - (mid.y - this.t.py) * ratio, scale, this.size);
    Object.assign(this.t, { px: pan.x, py: pan.y, ps: scale });
    this.run();
  };

  doubleTap(event) {
    const p = this.point(event);
    if (this.t.ps > 1.05) return this.resetTouch();
    const scale = clamp(this.t.z, this.options.min, this.options.max);
    const pan = clampPan(p.x * (1 - scale), p.y * (1 - scale), scale, this.size);
    this.root.classList.add('is-touch');
    if (this.img.src !== this.src) this.img.src = this.src;
    Object.assign(this.t, { px: pan.x, py: pan.y, ps: scale });
    this.run();
  }

  /** Pointer positions in frame coordinates; the frame itself never transforms. */
  snapshot() {
    const frame = this.root.getBoundingClientRect();
    const pts = [...this.pointers.values()].map(p => ({ x: p.x - frame.left, y: p.y - frame.top }));
    const mid = { x: pts.reduce((a, p) => a + p.x, 0) / pts.length, y: pts.reduce((a, p) => a + p.y, 0) / pts.length };
    const distance = pts.length > 1 ? Math.hypot(pts[0].x - pts[1].x, pts[0].y - pts[1].y) : 1;
    this.lastMid = mid;
    return { count: pts.length, mid, distance, pan: { x: this.s.px, y: this.s.py, scale: this.s.ps } };
  }

  /* ---------- Keyboard ---------- */

  onKey = event => {
    const step = (event.shiftKey ? 0.15 : 0.05) * Math.max(this.size.width, this.size.height);
    const keys = {
      Enter: () => (this.active ? this.deactivate() : this.startKeyboard()),
      ' ': () => (this.active ? this.deactivate() : this.startKeyboard()),
      Escape: () => this.deactivate(),
      '+': () => this.zoomBy(1.25),
      '=': () => this.zoomBy(1.25),
      '-': () => this.zoomBy(0.8),
      ArrowLeft: () => this.nudge(-step, 0),
      ArrowRight: () => this.nudge(step, 0),
      ArrowUp: () => this.nudge(0, -step),
      ArrowDown: () => this.nudge(0, step),
    };
    const action = keys[event.key];
    if (!action) return;
    if (event.key.startsWith('Arrow') && !this.active) return;
    event.preventDefault();
    action();
  };

  startKeyboard() {
    this.keyboard = true;
    this.activate({ x: this.size.width / 2, y: this.size.height / 2 }, true);
    this.announce();
  }

  nudge(dx, dy) {
    this.t.x = clamp(this.t.x + dx, 0, this.size.width);
    this.t.y = clamp(this.t.y + dy, 0, this.size.height);
    this.run();
  }

  zoomBy(factor) {
    this.setZoom(this.t.z * factor);
    this.announce();
  }

  announce() {
    this.status.textContent = `Zoom ${Math.round(this.t.z * 100)}%`;
  }

  /* ---------- Animation ---------- */

  run() {
    if (reduced()) {
      Object.assign(this.s, this.t);
      this.paint();
      return;
    }
    if (!this.frame) {
      this.last = performance.now();
      this.frame = requestAnimationFrame(this.tick);
    }
  }

  tick = now => {
    const dt = Math.min((now - this.last) / 1000, 1 / 30);
    this.last = now;
    const { stiffness, damping } = this.options;
    let busy = false;
    for (const key of Object.keys(this.s)) {
      // Visibility pops a little faster than position; zoom eases a little slower.
      const k = key === 'v' ? 1.4 : key === 'z' ? 0.6 : 1;
      for (let i = 0; i < 4; i++) {
        const a = -stiffness * k * (this.s[key] - this.t[key]) - damping * Math.sqrt(k) * this.d[key];
        this.d[key] += a * (dt / 4);
        this.s[key] += this.d[key] * (dt / 4);
      }
      if (Math.abs(this.s[key] - this.t[key]) > 0.001 || Math.abs(this.d[key]) > 0.01) busy = true;
      else {
        this.s[key] = this.t[key];
        this.d[key] = 0;
      }
    }
    this.paint();
    this.frame = busy ? requestAnimationFrame(this.tick) : 0;
  };

  paint() {
    if (!this.size) return;
    const { s } = this;
    const zoom = Math.max(1, s.z);
    if (this.options.mode === 'inside') {
      this.lens.style.opacity = '0';
      // Blend from fit to zoomed with visibility, so entering and leaving ease.
      const scale = 1 + (zoom - 1) * clamp(s.v, 0, 1);
      const shift = insideTransform(s, scale);
      const touch = s.ps !== 1 || s.px || s.py;
      this.img.style.transform = touch ? `translate3d(${s.px}px, ${s.py}px, 0) scale(${s.ps})` : `translate3d(${shift.x}px, ${shift.y}px, 0) scale(${scale})`;
      return;
    }
    const { lens, inner } = lensTransform(s, zoom, this.options.size);
    const v = clamp(s.v, 0, 1.2);
    this.lens.style.opacity = String(clamp(s.v * 1.5, 0, 1));
    this.lens.style.transform = `translate3d(${lens.x}px, ${lens.y}px, 0) scale(${0.3 + 0.7 * v})`;
    this.inner.style.transform = `translate3d(${inner.x}px, ${inner.y}px, 0) scale(${zoom})`;
    this.img.style.transform = s.ps !== 1 || s.px || s.py ? `translate3d(${s.px}px, ${s.py}px, 0) scale(${s.ps})` : '';
  }
}
