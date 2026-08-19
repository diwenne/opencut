const { contextBridge, ipcRenderer, webUtils } = require("electron");

// Bridges the renderer to native transcoding. Deliberately narrow: the page
// can ask for a path for a File it already has, request a conversion, and read
// the converted bytes back. Nothing else is exposed.
let requestCounter = 0;

contextBridge.exposeInMainWorld("opencutNative", {
	isAvailable: true,

	// Electron 32+ removed File.path; this is the supported replacement.
	getPathForFile(file) {
		try {
			return webUtils.getPathForFile(file) || null;
		} catch {
			return null;
		}
	},

	async prepareMedia({ srcPath, onProgress }) {
		const requestId = `req-${++requestCounter}`;

		const listener = (_event, payload) => {
			if (payload && payload.requestId === requestId && onProgress) {
				onProgress({ percent: payload.percent });
			}
		};
		ipcRenderer.on("media:progress", listener);

		try {
			return await ipcRenderer.invoke("media:prepare", { srcPath, requestId });
		} finally {
			ipcRenderer.removeListener("media:progress", listener);
		}
	},

	async readFile({ filePath }) {
		return ipcRenderer.invoke("media:read", { filePath });
	},
});
