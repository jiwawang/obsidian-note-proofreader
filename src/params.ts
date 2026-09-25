/** Tunable numbers for the particle rewrite. Frozen once tuned on the demo page. */
export interface AnimationParams {
	/** "ink": particles keep the text colour. "ember": they burn gold → orange → red and glow. */
	style: "ink" | "ember";
	/** Halo strength around ember particles, 0–1. */
	glow: number;
	/**
	 * How changed text is marked afterwards: a fading underlay, a fading bold, or a
	 * marker written into the note (==highlight== or **bold**).
	 */
	mark: "underlay" | "bold" | "highlight-permanent" | "bold-permanent";
	/** "passage": the whole selection dissolves and re-forms. "changes": only the changed spans do. */
	scope: "passage" | "changes";
	/** With "changes": how long the gap eases from the old width to the new one, ms. */
	shiftMs: number;
	/** How much of a phase is spent sweeping left to right across the glyphs (0 = all at once, 1 = one after another). */
	sweep: number;
	/**
	 * Fraction of the gather phase during which the real text is already showing
	 * underneath while the particles fade out, so the handoff doesn't pop.
	 */
	handoff: number;
	/** Time for one changed span to dissolve and re-form, ms. */
	durationMs: number;
	/** Delay between consecutive changed spans, ms. */
	staggerMs: number;
	/** How much the gather overlaps the dissolve (0 = one after the other, 1 = together). */
	overlap: number;
	/** Side of one particle, CSS px. */
	particleSize: number;
	/** Fraction of sampled points that become particles (0–1). */
	density: number;
	/** How far particles scatter, in em (1 = one glyph box). */
	spread: number;
	/** Upward drift while dissolving, in em. */
	drift: number;
	/** Extra random jitter of each particle's start time, as a fraction of its phase. */
	jitter: number;
	/** How long the mark stays on changed text, ms (ignored for bold-permanent). */
	holdMs: number;
	/** Length of the "checked, nothing to change" double flash, ms. */
	flashMs: number;
}

export const DEFAULT_PARAMS: AnimationParams = {
	style: "ink",
	glow: 0.5,
	mark: "highlight-permanent",
	scope: "passage",
	shiftMs: 1200,
	sweep: 0,
	handoff: 0.6,
	durationMs: 2600,
	staggerMs: 150,
	overlap: 0.2,
	particleSize: 1,
	density: 1,
	spread: 0.3,
	drift: 0,
	jitter: 0.55,
	holdMs: 6000,
	flashMs: 2000,
};
