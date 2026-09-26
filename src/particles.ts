import type { EditorView } from "@codemirror/view";
import { graphemes } from "./diff";
import type { AnimationParams } from "./params";

/** One glyph as laid out on screen, with everything needed to rasterize it. */
export interface Glyph {
	text: string;
	left: number;
	top: number;
	width: number;
	height: number;
	font: string;
	color: string;
	fontSize: number;
}

interface Particle {
	/** Anchor: where the particle belongs in the glyph. */
	ax: number;
	ay: number;
	/** Scatter offset at full displacement. */
	dx: number;
	dy: number;
	/** Start delay within the phase, 0–1 of the phase length. */
	delay: number;
	r: number;
	g: number;
	b: number;
	a: number;
	/** Per-particle variation of the ember colour, 0–1. */
	v: number;
}

interface Burst {
	particles: Particle[];
	start: number;
	duration: number;
	/** "out" scatters from the anchor; "in" gathers towards it. */
	kind: "out" | "in";
	size: number;
}

/** Screen rectangles of every grapheme in [from, to), read off the live editor. */
export function measureGlyphs(view: EditorView, from: number, to: number): Glyph[] {
	const text = view.state.sliceDoc(from, to);
	const out: Glyph[] = [];
	let pos = from;
	for (const g of graphemes(text)) {
		if (g.trim()) {
			const rect = view.coordsForChar(pos);
			if (rect) {
				const el = elementAt(view, pos);
				const cs = el ? getComputedStyle(el) : null;
				out.push({
					text: g,
					left: rect.left,
					top: rect.top,
					width: rect.right - rect.left,
					height: rect.bottom - rect.top,
					font: cs?.font || "16px sans-serif",
					color: cs?.color || "#000",
					fontSize: cs ? parseFloat(cs.fontSize) || 16 : 16,
				});
			}
		}
		pos += g.length;
	}
	return out;
}

function elementAt(view: EditorView, pos: number): Element | null {
	const { node } = view.domAtPos(pos);
	return node.nodeType === Node.TEXT_NODE ? node.parentElement : (node as Element);
}

const scratch = createEl("canvas");

/** Width `text` takes in `font`, as the browser would lay it out on one line. */
export function textWidth(text: string, font: string): number {
	const ctx = scratch.getContext("2d");
	if (!ctx || !font) return 0;
	ctx.setTransform(1, 0, 0, 1, 0, 0);
	ctx.font = font;
	return ctx.measureText(text).width;
}

/** Rasterize a glyph and turn its opaque pixels into particle anchors. */
function sample(g: Glyph, p: AnimationParams, rnd: () => number, baseDelay: number): Particle[] {
	const dpr = window.devicePixelRatio || 1;
	const w = Math.max(1, Math.ceil(g.width * dpr));
	const h = Math.max(1, Math.ceil(g.height * dpr));
	scratch.width = w;
	scratch.height = h;
	const ctx = scratch.getContext("2d", { willReadFrequently: true });
	if (!ctx) return [];
	ctx.clearRect(0, 0, w, h);
	ctx.scale(dpr, dpr);
	ctx.font = g.font;
	ctx.fillStyle = "#000";
	ctx.textBaseline = "alphabetic";
	// The content area sits centred in the line box (half-leading above and below).
	const m = ctx.measureText(g.text);
	const asc = m.fontBoundingBoxAscent || g.fontSize * 0.9;
	const desc = m.fontBoundingBoxDescent || g.fontSize * 0.2;
	const baseline = (g.height - (asc + desc)) / 2 + asc;
	ctx.fillText(g.text, 0, baseline);
	ctx.setTransform(1, 0, 0, 1, 0, 0);

	const data = ctx.getImageData(0, 0, w, h).data;
	const [r, gg, b] = parseColor(g.color);
	const step = Math.max(1, Math.round(p.particleSize * dpr));
	const em = g.fontSize;
	const out: Particle[] = [];
	for (let y = 0; y < h; y += step) {
		for (let x = 0; x < w; x += step) {
			// Average coverage over the cell.
			let sum = 0;
			let n = 0;
			for (let yy = y; yy < Math.min(h, y + step); yy++) {
				for (let xx = x; xx < Math.min(w, x + step); xx++) {
					sum += data[(yy * w + xx) * 4 + 3];
					n++;
				}
			}
			const cov = sum / (n * 255);
			if (cov < 0.3 || rnd() > p.density) continue;
			const ang = rnd() * Math.PI * 2;
			const dist = Math.sqrt(rnd()) * p.spread * em;
			out.push({
				ax: g.left + (x + step / 2) / dpr,
				ay: g.top + (y + step / 2) / dpr,
				dx: Math.cos(ang) * dist,
				dy: Math.sin(ang) * dist - p.drift * em,
				delay: Math.min(0.95, baseDelay + rnd() * p.jitter),
				r,
				g: gg,
				b,
				a: Math.min(1, cov + 0.15),
				v: rnd(),
			});
		}
	}
	return out;
}

function parseColor(c: string): [number, number, number] {
	const m = c.match(/[\d.]+/g);
	if (!m || m.length < 3) return [0, 0, 0];
	return [Number(m[0]), Number(m[1]), Number(m[2])];
}

const easeOut = (t: number) => 1 - Math.pow(1 - t, 3);

const GOLD = [255, 214, 110];
const ORANGE = [255, 126, 30];
const RED = [190, 40, 30];

/**
 * Colour of a burning particle. heat 1 = freshly lit (gold), 0 = burnt out (red,
 * or the ink colour when the particle is settling into text). `v` varies the
 * midpoint so neighbouring particles don't all flicker in step.
 */
function emberColor(heat: number, v: number, ir: number, ig: number, ib: number): [number, number, number] {
	const mid = 0.45 + v * 0.3;
	const mix = (a: number[], b: number[], t: number) => [a[0] + (b[0] - a[0]) * t, a[1] + (b[1] - a[1]) * t, a[2] + (b[2] - a[2]) * t];
	const c =
		heat > mid
			? mix(ORANGE, GOLD, (heat - mid) / (1 - mid))
			: heat > 0.15
				? mix(RED, ORANGE, (heat - 0.15) / (mid - 0.15))
				: mix([ir, ig, ib], RED, heat / 0.15);
	return [Math.round(c[0]), Math.round(c[1]), Math.round(c[2])];
}
const easeIn = (t: number) => t * t * t;

/** A full-window canvas that draws every in-flight particle burst. */
export class ParticleLayer {
	private canvas = createEl("canvas");
	private ctx: CanvasRenderingContext2D;
	private bursts: Burst[] = [];
	private raf = 0;
	private rnd = Math.random;

	constructor(private params: AnimationParams) {
		this.canvas.className = "np-particles";
		this.ctx = this.canvas.getContext("2d")!;
		this.resize();
		document.body.appendChild(this.canvas);
	}

	private resize() {
		const dpr = window.devicePixelRatio || 1;
		this.canvas.width = Math.ceil(window.innerWidth * dpr);
		this.canvas.height = Math.ceil(window.innerHeight * dpr);
		this.canvas.style.width = `${window.innerWidth}px`;
		this.canvas.style.height = `${window.innerHeight}px`;
		this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
	}

	/** Scatter `glyphs` (which should be hidden in the DOM from now on). */
	dissolve(glyphs: Glyph[], duration: number) {
		this.add(glyphs, duration, "out");
	}

	/** Gather particles into `glyphs` (hidden in the DOM until the burst ends). */
	gather(glyphs: Glyph[], duration: number) {
		this.add(glyphs, duration, "in");
	}

	private add(glyphs: Glyph[], duration: number, kind: Burst["kind"]) {
		// A left-to-right sweep: each glyph starts a little after the one before it.
		const n = Math.max(1, glyphs.length - 1);
		const particles = glyphs.flatMap((g, i) => sample(g, this.params, this.rnd, this.params.sweep * (1 - this.params.jitter) * (i / n)));
		this.bursts.push({ particles, start: performance.now(), duration, kind, size: this.params.particleSize });
		if (!this.raf) this.raf = window.requestAnimationFrame(this.frame);
	}

	private frame = (now: number) => {
		const { ctx, params } = this;
		ctx.clearRect(0, 0, this.canvas.width, this.canvas.height);
		this.bursts = this.bursts.filter((b) => now - b.start < b.duration);
		const ember = params.style === "ember";
		const halo = ember && params.glow > 0 ? Math.max(3, params.particleSize * 3) : 0;
		for (const b of this.bursts) {
			const raw = (now - b.start) / b.duration;
			for (const q of b.particles) {
				// Each particle runs its own slice of the phase, offset by its delay.
				const t = Math.min(1, Math.max(0, (raw - q.delay) / (1 - q.delay)));
				if (b.kind === "in" && t <= 0) continue;
				const disp = b.kind === "out" ? easeIn(t) : 1 - easeOut(t);
				let alpha = (b.kind === "out" ? 1 - t : easeOut(t)) * q.a;
				// Gathering particles fade out over the handoff tail; the real text is already visible beneath.
				if (b.kind === "in" && params.handoff > 0 && raw > 1 - params.handoff) {
					alpha *= Math.max(0, (1 - raw) / params.handoff);
				}
				if (alpha <= 0.01) continue;
				const x = q.ax + q.dx * disp - b.size / 2;
				const y = q.ay + q.dy * disp - b.size / 2;
				let r = q.r;
				let g = q.g;
				let bl = q.b;
				if (ember) {
					// Burning: gold → orange → deep red as the particle flies; forming text cools from gold to ink.
					const heat = b.kind === "out" ? 1 - t : 1 - easeOut(t);
					[r, g, bl] = emberColor(heat, q.v, q.r, q.g, q.b);
					if (halo) {
						ctx.fillStyle = `rgba(255,${Math.round(120 + 80 * heat)},20,${(alpha * params.glow * 0.28 * heat).toFixed(3)})`;
						ctx.fillRect(x - halo / 2 + b.size / 2, y - halo / 2 + b.size / 2, halo, halo);
					}
				}
				ctx.fillStyle = `rgba(${r},${g},${bl},${alpha.toFixed(3)})`;
				ctx.fillRect(x, y, b.size, b.size);
			}
		}
		this.raf = this.bursts.length ? window.requestAnimationFrame(this.frame) : 0;
	};

	get busy() {
		return this.bursts.length > 0;
	}

	destroy() {
		if (this.raf) window.cancelAnimationFrame(this.raf);
		this.raf = 0;
		this.bursts = [];
		this.canvas.remove();
	}
}
