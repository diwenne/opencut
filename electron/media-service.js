// Native media support for codecs no browser engine can decode.
//
// Chromium (and therefore WebCodecs, and therefore OpenCut's preview) cannot
// decode ProRes at all. Since this build runs inside Electron there is a native
// side available, so undecodable sources are transcoded to H.264 on import and
// cached. HDR sources are tone-mapped to SDR Rec.709 at the same time, because
// dropping BT.2020 into an SDR canvas renders flat and washed out.
//
// Source files are only ever read. Everything written goes to the app's own
// userData directory.

const { app, ipcMain } = require("electron");
const { spawn } = require("node:child_process");
const crypto = require("node:crypto");
const fs = require("node:fs");
const fsp = require("node:fs/promises");
const path = require("node:path");

// Codecs Chromium can decode. Anything outside this list gets transcoded.
// HEVC (including Main 10) is decodable in this Electron build via the
// platform decoder, so it is deliberately included and left alone.
const DECODABLE_CODECS = new Set(["h264", "hevc", "vp8", "vp9", "av1", "theora"]);

// PQ and HLG. Either one needs tone-mapping down to SDR.
const HDR_TRANSFERS = new Set(["smpte2084", "arib-std-b67"]);

function binaryPath(mod) {
	// electron-builder copies these next to the app; in dev they resolve from
	// node_modules. asar would make them non-executable, hence extraResources.
	const packaged = path.join(process.resourcesPath, "bin", mod);
	if (app.isPackaged && fs.existsSync(packaged)) return packaged;
	return mod === "ffmpeg"
		? require("ffmpeg-static")
		: require("ffprobe-static").path;
}

function cacheDir() {
	return path.join(app.getPath("userData"), "media-cache");
}

function run(bin, args, { onStdout, onStderr } = {}) {
	return new Promise((resolve, reject) => {
		const child = spawn(bin, args);
		let out = "";
		let err = "";
		child.stdout.on("data", (d) => {
			out += d;
			if (onStdout) onStdout(String(d));
		});
		child.stderr.on("data", (d) => {
			err += d;
			if (onStderr) onStderr(String(d));
		});
		child.on("error", reject);
		child.on("close", (code) => {
			if (code === 0) resolve(out);
			else reject(new Error(`${path.basename(bin)} exited ${code}: ${err.slice(-800)}`));
		});
	});
}

async function probe(srcPath) {
	const raw = await run(binaryPath("ffprobe"), [
		"-v", "error",
		"-select_streams", "v:0",
		"-show_entries", "stream=codec_name,color_transfer,width,height",
		"-show_entries", "format=duration",
		"-of", "json",
		srcPath,
	]);
	const parsed = JSON.parse(raw);
	const stream = (parsed.streams && parsed.streams[0]) || {};
	return {
		codec: stream.codec_name || null,
		transfer: stream.color_transfer || null,
		width: stream.width || null,
		height: stream.height || null,
		duration: Number.parseFloat((parsed.format && parsed.format.duration) || "0") || 0,
	};
}

async function cacheKeyFor(srcPath) {
	const stat = await fsp.stat(srcPath);
	const hash = crypto.createHash("sha1");
	hash.update(`${srcPath}:${stat.size}:${stat.mtimeMs}`);
	return hash.digest("hex").slice(0, 16);
}

// Apple Silicon has a hardware H.264 encoder. On 4K60 footage it measured
// ~2.9x faster than libx264 -preset medium (16s vs 46s per 10s of video),
// which is the difference between a usable import and a coffee break.
// libx264 stays as a fallback for machines where VideoToolbox is unavailable.
function bitrateForWidth(width) {
	if (!width) return "20M";
	if (width >= 3840) return "50M";
	if (width >= 2560) return "30M";
	if (width >= 1920) return "20M";
	return "10M";
}

function buildArgs({ srcPath, destPath, isHdr, width, useHardware }) {
	const filters = isHdr
		? // HDR -> linear light -> Rec.709 primaries -> tone map -> SDR
			"zscale=t=linear:npl=100,format=gbrpf32le,zscale=p=bt709,tonemap=tonemap=hable:desat=0,zscale=t=bt709:m=bt709:r=tv,format=yuv420p"
		: "format=yuv420p";

	const videoArgs = useHardware
		? [
				"-c:v", "h264_videotoolbox",
				"-b:v", bitrateForWidth(width),
				// VideoToolbox warns and guesses if range is left unset.
				"-color_range", "tv",
				"-colorspace", "bt709",
				"-color_primaries", "bt709",
				"-color_trc", "bt709",
			]
		: ["-c:v", "libx264", "-profile:v", "high", "-crf", "20", "-preset", "medium"];

	return [
		"-hide_banner", "-loglevel", "error", "-y",
		"-i", srcPath,
		"-vf", filters,
		...videoArgs,
		// keyframes ~0.5s apart at 60fps so timeline scrubbing stays responsive
		"-g", "30",
		"-c:a", "aac", "-b:a", "192k", "-ac", "2",
		"-movflags", "+faststart",
		"-progress", "pipe:1", "-nostats",
		// Written to a .part file first, so the container has to be explicit:
		// ffmpeg cannot infer the format from that extension.
		"-f", "mp4",
		destPath,
	];
}

async function prepareMedia({ srcPath, onProgress }) {
	const info = await probe(srcPath);

	if (info.codec && DECODABLE_CODECS.has(info.codec)) {
		return { converted: false, reason: `${info.codec} decodes natively`, codec: info.codec };
	}

	const key = await cacheKeyFor(srcPath);
	const dir = cacheDir();
	await fsp.mkdir(dir, { recursive: true });
	const destPath = path.join(dir, `${path.parse(srcPath).name}-${key}.mp4`);

	// A cached conversion of the same source is reused verbatim.
	try {
		const cached = await fsp.stat(destPath);
		if (cached.size > 0) {
			return { converted: true, cached: true, path: destPath, codec: info.codec };
		}
	} catch {
		// not cached yet
	}

	const isHdr = Boolean(info.transfer && HDR_TRANSFERS.has(info.transfer));
	const partPath = `${destPath}.part`;

	let lastPercent = -1;
	const handlers = {
		onStdout: (chunk) => {
			if (!onProgress || !info.duration) return;
			// -progress emits `out_time_us=<n>` lines as it works.
			const match = /out_time_us=(\d+)/g;
			let found;
			let latest = null;
			while ((found = match.exec(chunk)) !== null) latest = Number(found[1]);
			if (latest === null) return;
			const percent = Math.max(0, Math.min(99, Math.round((latest / 1e6 / info.duration) * 100)));
			if (percent !== lastPercent) {
				lastPercent = percent;
				onProgress({ percent });
			}
		},
	};

	const ffmpeg = binaryPath("ffmpeg");
	const common = { srcPath, destPath: partPath, isHdr, width: info.width };
	let usedHardware = true;
	try {
		await run(ffmpeg, buildArgs({ ...common, useHardware: true }), handlers);
	} catch (hardwareError) {
		// Fall back to the software encoder rather than failing the import.
		console.error("videotoolbox encode failed, retrying with libx264:", hardwareError.message);
		usedHardware = false;
		lastPercent = -1;
		await run(ffmpeg, buildArgs({ ...common, useHardware: false }), handlers);
	}

	await fsp.rename(partPath, destPath);
	return { converted: true, cached: false, path: destPath, codec: info.codec, tonemapped: isHdr, hardware: usedHardware };
}

/**
 * macOS verifies an unsigned binary the first time it is executed, and these
 * are large: the first ffprobe call measured 8.3s cold versus 0.19s warm. That
 * delay landed entirely before the first progress event, so an import looked
 * frozen at 0%. Running both once at startup moves the cost to launch, where
 * nothing is waiting on it.
 */
function warmBinaries() {
	for (const name of ["ffprobe", "ffmpeg"]) {
		try {
			const child = spawn(binaryPath(name), ["-version"], { stdio: "ignore" });
			child.on("error", () => {});
		} catch {
			// warming is best-effort; a failure here surfaces on real use
		}
	}
}

function registerMediaHandlers() {
	ipcMain.handle("media:prepare", async (event, { srcPath, requestId }) => {
		try {
			const result = await prepareMedia({
				srcPath,
				onProgress: ({ percent }) => {
					if (!event.sender.isDestroyed()) {
						event.sender.send("media:progress", { requestId, percent });
					}
				},
			});
			return { ok: true, ...result };
		} catch (error) {
			return { ok: false, error: String((error && error.message) || error) };
		}
	});

	// Once the renderer has copied the bytes into OPFS, the cached conversion
	// is a second copy of the same video on disk. The editor decodes from its
	// own storage, so the cache entry is dropped and the import keeps exactly
	// one copy. Re-importing the same source re-encodes it.
	ipcMain.handle("media:release", async (_event, { filePath }) => {
		try {
			const dir = path.resolve(cacheDir());
			const target = path.resolve(filePath);
			// Only ever delete inside our own cache directory.
			if (!target.startsWith(dir + path.sep)) return { ok: false, reason: "outside cache" };
			await fsp.rm(target, { force: true });
			return { ok: true };
		} catch (error) {
			return { ok: false, reason: String((error && error.message) || error) };
		}
	});

	ipcMain.handle("media:read", async (_event, { filePath }) => {
		const data = await fsp.readFile(filePath);
		// Transfer as ArrayBuffer so structured clone doesn't stringify it.
		return data.buffer.slice(data.byteOffset, data.byteOffset + data.byteLength);
	});
}

module.exports = { registerMediaHandlers, warmBinaries, prepareMedia, probe, cacheDir };
