import { toast } from "sonner";

/**
 * Desktop-only escape hatch for codecs the browser engine cannot decode.
 *
 * ProRes is the motivating case: no browser decodes it, so the web build can
 * only tell you to convert the file yourself. The desktop build exposes a
 * native bridge that transcodes on import (tone-mapping HDR to SDR along the
 * way) and caches the result, so these files just import.
 *
 * In the web build `window.opencutNative` is undefined and every function here
 * is a no-op, leaving the original behaviour untouched.
 */

interface PrepareResult {
	ok: boolean;
	converted?: boolean;
	cached?: boolean;
	path?: string;
	codec?: string | null;
	tonemapped?: boolean;
	error?: string;
}

interface OpenCutNative {
	isAvailable: boolean;
	getPathForFile: (file: File) => string | null;
	prepareMedia: (args: {
		srcPath: string;
		onProgress?: ({ percent }: { percent: number }) => void;
	}) => Promise<PrepareResult>;
	readFile: (args: { filePath: string }) => Promise<ArrayBuffer>;
}

declare global {
	interface Window {
		opencutNative?: OpenCutNative;
	}
}

export const getNativeBridge = (): OpenCutNative | null => {
	if (typeof window === "undefined") return null;
	return window.opencutNative?.isAvailable ? window.opencutNative : null;
};

export const isNativeMediaAvailable = (): boolean => getNativeBridge() !== null;

const replaceExtension = ({ name }: { name: string }): string => {
	const dot = name.lastIndexOf(".");
	return `${dot === -1 ? name : name.slice(0, dot)}.mp4`;
};

/**
 * Returns a file the editor can actually decode. When no conversion is needed
 * (or we're not on desktop) the original file is passed straight back, so this
 * is safe to call for every import.
 */
export async function prepareFileForImport({
	file,
	onConvertProgress,
}: {
	file: File;
	onConvertProgress?: ({ percent }: { percent: number }) => void;
}): Promise<File> {
	const native = getNativeBridge();
	if (!native) return file;
	if (!file.type.startsWith("video/") && !/\.(mov|mxf|avi)$/i.test(file.name)) {
		return file;
	}

	const srcPath = native.getPathForFile(file);
	if (!srcPath) return file;

	const toastId = `native-transcode-${file.name}`;
	let announced = false;

	// Probing has to finish before we know whether a conversion is needed, so
	// nudge the bar off zero straight away rather than looking frozen.
	onConvertProgress?.({ percent: 2 });

	try {
		const result = await native.prepareMedia({
			srcPath,
			onProgress: ({ percent }) => {
				// Drives the caller's overall import bar, which otherwise sits
				// at 0% for the whole conversion.
				onConvertProgress?.({ percent });

				// Only surface a toast once we know work is actually happening,
				// so decodable files import without any extra UI.
				if (!announced) {
					announced = true;
					toast.loading(`Converting ${file.name}`, {
						id: toastId,
						description: "This codec can't be decoded directly, so it's being converted for the timeline.",
					});
				}
				toast.loading(`Converting ${file.name}`, {
					id: toastId,
					description: `${percent}% — this runs once, then it's cached.`,
				});
			},
		});

		if (!result.ok) {
			if (announced) toast.dismiss(toastId);
			toast.error(`Couldn't convert ${file.name}`, {
				description: result.error ?? "The native converter failed.",
			});
			return file;
		}

		if (!result.converted || !result.path) {
			if (announced) toast.dismiss(toastId);
			// Nothing to convert: this file is already decodable.
			onConvertProgress?.({ percent: 100 });
			return file;
		}

		// A cache hit skips ffmpeg entirely, so no progress has been reported
		// yet. Mark the phase boundary before the read, which for a large clip
		// is itself the slow part.
		onConvertProgress?.({ percent: announced ? 92 : 40 });
		const buffer = await native.readFile({ filePath: result.path });
		onConvertProgress?.({ percent: 100 });
		const converted = new File(
			[buffer],
			replaceExtension({ name: file.name }),
			{ type: "video/mp4" },
		);

		if (announced || result.cached) {
			toast.success(`Converted ${file.name}`, {
				id: toastId,
				description: result.tonemapped
					? "Transcoded to H.264 and tone-mapped from HDR to SDR."
					: "Transcoded to H.264 for timeline playback.",
			});
		}

		return converted;
	} catch (error) {
		if (announced) toast.dismiss(toastId);
		console.error("native transcode failed", error);
		return file;
	}
}
