const { app, BrowserWindow, shell, dialog } = require("electron");
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { registerMediaHandlers } = require("./media-service");

// In a packaged app the Next standalone bundle lives in Resources/app-next.
// In dev we point straight at the build output in the repo.
// Either way the entry is <standalone-root>/apps/web/server.js — the bundle's
// traced dependencies sit in a hoisted node_modules at the standalone root,
// which server.js resolves by walking up, so the whole tree must stay intact.
const STANDALONE_ROOT = app.isPackaged
	? path.join(process.resourcesPath, "app-next")
	: path.join(__dirname, "..", "apps", "web", ".next", "standalone");

const SERVER_ROOT = path.join(STANDALONE_ROOT, "apps", "web");

const SERVER_ENTRY = path.join(SERVER_ROOT, "server.js");

let serverProcess = null;
let mainWindow = null;

// A normal quit tears the server down via the handlers at the bottom of this
// file. A crash or force-kill can't, so the pid is recorded and any survivor
// from a previous run is reaped on the next launch.
function pidFilePath() {
	return path.join(app.getPath("userData"), "next-server.pid");
}

function writePidFile(pid) {
	try {
		fs.mkdirSync(app.getPath("userData"), { recursive: true });
		fs.writeFileSync(pidFilePath(), String(pid));
	} catch (err) {
		console.error("could not write pid file:", err);
	}
}

function clearPidFile() {
	try {
		fs.rmSync(pidFilePath(), { force: true });
	} catch {
		// nothing useful to do here
	}
}

function reapStaleServer() {
	let stale;
	try {
		stale = Number.parseInt(fs.readFileSync(pidFilePath(), "utf8").trim(), 10);
	} catch {
		return; // no pid file: nothing to reap
	}
	if (!Number.isInteger(stale) || stale <= 0) return;
	try {
		process.kill(stale, "SIGTERM");
		console.log(`reaped orphaned server from a previous run (pid ${stale})`);
	} catch {
		// already gone, or not ours anymore
	}
	clearPidFile();
}

function findOpenPort() {
	return new Promise((resolve, reject) => {
		const probe = net.createServer();
		probe.unref();
		probe.on("error", reject);
		probe.listen(0, "127.0.0.1", () => {
			const { port } = probe.address();
			probe.close(() => resolve(port));
		});
	});
}

function waitForServer({ port, timeoutMs = 30000 }) {
	const deadline = Date.now() + timeoutMs;
	return new Promise((resolve, reject) => {
		const attempt = () => {
			const socket = net.connect(port, "127.0.0.1");
			socket.once("connect", () => {
				socket.destroy();
				resolve();
			});
			socket.once("error", () => {
				socket.destroy();
				if (Date.now() > deadline) {
					reject(new Error(`Server did not start within ${timeoutMs}ms`));
					return;
				}
				setTimeout(attempt, 200);
			});
		};
		attempt();
	});
}

function startServer(port) {
	// The editor is fully client-side; these values only satisfy the app's
	// startup env validation (src/env/web.ts). Nothing here talks to a real
	// database or third-party service in local desktop use.
	const env = {
		...process.env,
		NODE_ENV: "production",
		PORT: String(port),
		HOSTNAME: "127.0.0.1",
		NEXT_PUBLIC_SITE_URL: `http://127.0.0.1:${port}`,
		NEXT_PUBLIC_MARBLE_API_URL: "https://api.marblecms.com",
		DATABASE_URL: "postgresql://opencut:opencut@127.0.0.1:5432/opencut",
		BETTER_AUTH_SECRET: "local-desktop-only-secret-not-used-for-auth-0000",
		UPSTASH_REDIS_REST_URL: "http://127.0.0.1:8079",
		UPSTASH_REDIS_REST_TOKEN: "local-desktop-placeholder",
		MARBLE_WORKSPACE_KEY: "local-desktop-placeholder",
		FREESOUND_CLIENT_ID: "local-desktop-placeholder",
		FREESOUND_API_KEY: "local-desktop-placeholder",
		// Run the bundled Next server with Electron's own Node runtime,
		// so no system Node install is required.
		ELECTRON_RUN_AS_NODE: "1",
	};

	serverProcess = spawn(process.execPath, [SERVER_ENTRY], {
		cwd: SERVER_ROOT,
		env,
		stdio: ["ignore", "pipe", "pipe"],
	});

	writePidFile(serverProcess.pid);

	serverProcess.stdout.on("data", (d) => console.log(`[next] ${d}`));
	serverProcess.stderr.on("data", (d) => console.error(`[next] ${d}`));
	serverProcess.on("exit", (code) => {
		console.log(`[next] server exited with code ${code}`);
		serverProcess = null;
	});
}

function createWindow(port) {
	mainWindow = new BrowserWindow({
		width: 1440,
		height: 900,
		// The editor renders a "Desktop only" gate below 1024px wide.
		minWidth: 1024,
		minHeight: 700,
		backgroundColor: "#0a0a0a",
		titleBarStyle: "hiddenInset",
		show: false,
		webPreferences: {
			contextIsolation: true,
			nodeIntegration: false,
			preload: path.join(__dirname, "preload.js"),
		},
	});

	mainWindow.once("ready-to-show", () => mainWindow.show());
	mainWindow.loadURL(`http://127.0.0.1:${port}/projects`);

	// Keep external links in the user's real browser, not in the app shell.
	mainWindow.webContents.setWindowOpenHandler(({ url }) => {
		if (!url.startsWith(`http://127.0.0.1:${port}`)) {
			shell.openExternal(url);
			return { action: "deny" };
		}
		return { action: "allow" };
	});

	mainWindow.on("closed", () => {
		mainWindow = null;
	});
}

app.whenReady().then(async () => {
	try {
		registerMediaHandlers();
		reapStaleServer();
		const port = await findOpenPort();
		startServer(port);
		await waitForServer({ port });
		createWindow(port);

		app.on("activate", () => {
			if (BrowserWindow.getAllWindows().length === 0) createWindow(port);
		});
	} catch (err) {
		dialog.showErrorBox("OpenCut failed to start", String(err));
		app.quit();
	}
});

function stopServer() {
	if (serverProcess) {
		serverProcess.kill();
		serverProcess = null;
	}
	clearPidFile();
}

app.on("window-all-closed", () => {
	if (process.platform !== "darwin") app.quit();
});

app.on("before-quit", stopServer);
app.on("will-quit", stopServer);
process.on("exit", stopServer);
