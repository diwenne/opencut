/**
 * Look presets applied per visual element.
 *
 * These are expressed as Canvas2D filter strings rather than GPU effect passes
 * on purpose: the effect pipeline's shaders live inside the `opencut-wasm`
 * package, so adding a shader would mean rebuilding that Rust crate. Canvas2D
 * filters are applied while building the source texture, which means the same
 * code path feeds both the live preview and the exporter.
 */

export interface FilterPreset {
	id: string;
	label: string;
	/** Canvas2D / CSS filter string. Empty means "leave the frame alone". */
	css: string;
}

export const FILTER_PRESETS: FilterPreset[] = [
	{ id: "none", label: "None", css: "" },

	// Desaturated and cold. This is the "sad" look: sepia warms the image,
	// then hue-rotate swings that warmth around to blue, which gives a cooler
	// grey than grayscale() alone can produce.
	{
		id: "melancholy",
		label: "Melancholy",
		css: "grayscale(0.7) sepia(0.3) hue-rotate(180deg) saturate(0.8) brightness(0.92) contrast(1.02)",
	},
	{ id: "greyscale", label: "Greyscale", css: "grayscale(1)" },
	{
		id: "noir",
		label: "Noir",
		css: "grayscale(1) contrast(1.35) brightness(0.9)",
	},

	{
		id: "vibrant",
		label: "Vibrant",
		css: "saturate(1.6) contrast(1.1)",
	},
	{
		id: "la",
		label: "LA",
		css: "sepia(0.3) saturate(1.4) hue-rotate(-10deg) brightness(1.08) contrast(1.02)",
	},
	{
		id: "rio",
		label: "Rio",
		css: "saturate(1.7) hue-rotate(-5deg) contrast(1.08) brightness(1.04)",
	},
	{
		id: "tokyo",
		label: "Tokyo",
		css: "grayscale(0.45) sepia(0.35) hue-rotate(175deg) saturate(1.4) contrast(1.12) brightness(0.97)",
	},
	{
		id: "paris",
		label: "Paris",
		css: "sepia(0.18) saturate(1.05) contrast(0.96) brightness(1.05)",
	},
	{
		id: "vintage",
		label: "Vintage",
		css: "sepia(0.5) saturate(0.85) contrast(0.92) brightness(1.03)",
	},
	{
		id: "cool",
		label: "Cool",
		css: "grayscale(0.35) sepia(0.3) hue-rotate(178deg) saturate(1.2) brightness(1.0)",
	},
	{
		id: "warm",
		label: "Warm",
		css: "sepia(0.25) saturate(1.2) hue-rotate(-12deg) brightness(1.03)",
	},
];

export const DEFAULT_FILTER_ID = "none";

export const FILTER_OPTIONS = FILTER_PRESETS.map((preset) => ({
	value: preset.id,
	label: preset.label,
}));

const FILTER_BY_ID = new Map(FILTER_PRESETS.map((preset) => [preset.id, preset]));

/**
 * Resolves a stored param value to a filter string. Unknown ids fall back to
 * no filtering so an old project referencing a removed preset still renders.
 */
export function getFilterCss({ id }: { id: unknown }): string {
	if (typeof id !== "string") return "";
	return FILTER_BY_ID.get(id)?.css ?? "";
}

export function isFilterId({ id }: { id: unknown }): boolean {
	return typeof id === "string" && FILTER_BY_ID.has(id);
}

/**
 * Reads the stored filter id off an element's params, falling back to the
 * default when the value is missing or references a preset that no longer
 * exists.
 */
export function readFilterFromParams({
	params,
}: {
	params: Record<string, unknown>;
}): string {
	const value = params.filter;
	return isFilterId({ id: value }) ? (value as string) : DEFAULT_FILTER_ID;
}
