const { app, BrowserWindow, Menu } = require("electron");
const { spawn } = require("node:child_process");
const http = require("node:http");
const path = require("node:path");

const port = 43127;
const origin = `http://127.0.0.1:${port}`;
const root = path.join(__dirname, "..");

let serverProcess = null;
let windowRef = null;

const gotLock = app.requestSingleInstanceLock();
if (!gotLock) {
  app.quit();
  process.exit(0);
}

function ping() {
  return new Promise((resolve) => {
    const request = http.get(`${origin}/api/bootstrap`, (response) => {
      response.resume();
      resolve(response.statusCode === 200);
    });
    request.on("error", () => resolve(false));
    request.setTimeout(1500, () => {
      request.destroy();
      resolve(false);
    });
  });
}

async function waitForServer() {
  const started = Date.now();
  while (Date.now() - started < 60000) {
    if (await ping()) return;
    await new Promise((resolve) => setTimeout(resolve, 400));
  }
  throw new Error("讯栈服务没有在 60 秒内启动");
}

function startServer() {
  const nextBin = path.join(root, "node_modules", "next", "dist", "bin", "next");
  serverProcess = spawn(
    process.execPath,
    [nextBin, "dev", "--hostname", "127.0.0.1", "--port", String(port)],
    {
      cwd: root,
      env: {
        ...process.env,
        ELECTRON_RUN_AS_NODE: "1",
        BROWSER: "none",
      },
      stdio: "inherit",
    },
  );
  serverProcess.on("exit", (code) => {
    if (code && code !== 0 && windowRef && !windowRef.isDestroyed()) {
      windowRef.webContents.executeJavaScript(
        `document.body.insertAdjacentHTML('afterbegin', '<p style="padding:16px">服务已退出（${code}）</p>')`,
      ).catch(() => undefined);
    }
  });
}

function createWindow() {
  const window = new BrowserWindow({
    width: 1280,
    height: 860,
    minWidth: 960,
    minHeight: 640,
    title: "讯栈",
    backgroundColor: "#f4efe4",
    autoHideMenuBar: true,
    webPreferences: {
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: true,
    },
  });
  windowRef = window;
  window.loadURL(origin);
  window.on("closed", () => {
    windowRef = null;
  });
}

function stopServer() {
  if (!serverProcess || serverProcess.killed) return;
  serverProcess.kill("SIGTERM");
  serverProcess = null;
}

app.on("second-instance", () => {
  if (!windowRef) return;
  if (windowRef.isMinimized()) windowRef.restore();
  windowRef.focus();
});

app.whenReady().then(async () => {
  Menu.setApplicationMenu(null);
  const alreadyRunning = await ping();
  if (!alreadyRunning) {
    startServer();
    await waitForServer();
  }
  createWindow();
});

app.on("window-all-closed", () => {
  stopServer();
  app.quit();
});

app.on("before-quit", () => {
  stopServer();
});
