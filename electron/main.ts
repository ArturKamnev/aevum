import { app, BrowserWindow, ipcMain, nativeTheme, Notification, session, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isDev = !app.isPackaged;
const ollamaDownloadUrl = "https://ollama.com/download";
const recommendedModels = new Set([
  "llama3.1:latest",
  "llama3.2:latest",
  "mistral:latest",
  "qwen2.5:latest",
  "deepseek-r1:latest",
  "llama3.1",
  "llama3.2",
  "mistral",
  "qwen2.5",
  "deepseek-r1",
]);

type UpdateStatus = "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error" | "unavailable";
type OllamaStatus = "connected" | "model-missing" | "not-running" | "not-installed";

interface OllamaModel {
  name: string;
  modifiedAt?: string;
  size?: number;
}

interface NotificationTaskPayload {
  id: string;
  title: string;
  description?: string;
  status: "active" | "completed";
  scheduledAt: string | null;
}

type ReminderOffsetMinutes = 0 | 5 | 10 | 30 | 60;

let updateState: { status: UpdateStatus; message?: string; version?: string; progress?: number } = { status: "idle" };
let activePull: ChildProcessWithoutNullStreams | null = null;
const notificationTimers = new Map<string, NodeJS.Timeout>();
const firedNotifications = new Set<string>();

autoUpdater.autoDownload = false;
autoUpdater.autoInstallOnAppQuit = false;

function createWindow() {
  const window = new BrowserWindow({
    width: 1360,
    height: 920,
    minWidth: 1040,
    minHeight: 680,
    title: "Todo AI",
    backgroundColor: nativeTheme.shouldUseDarkColors ? "#12100d" : "#f5f1ea",
    titleBarStyle: "hiddenInset",
    trafficLightPosition: { x: 18, y: 18 },
    webPreferences: {
      preload: path.join(__dirname, "preload.js"),
      contextIsolation: true,
      nodeIntegration: false,
    },
  });

  if (isDev) {
    void window.loadURL("http://127.0.0.1:5173");
  } else {
    void window.loadFile(path.join(__dirname, "../dist/index.html"));
  }
}

app.whenReady().then(() => {
  app.setAppUserModelId("com.kamartur.todoai");
  ipcMain.handle("app:get-theme", () => nativeTheme.shouldUseDarkColors ? "dark" : "light");
  ipcMain.handle("app:get-version", () => app.getVersion());
  ipcMain.handle("app:clear-cache", async () => {
    await session.defaultSession.clearCache();
    await session.defaultSession.clearStorageData({
      storages: ["cachestorage", "shadercache", "serviceworkers"],
    });
    return { ok: true };
  });
  ipcMain.handle("updates:check", async () => checkForUpdates());
  ipcMain.handle("updates:download", async () => downloadUpdate());
  ipcMain.handle("updates:install", () => {
    if (updateState.status !== "downloaded") return { ok: false, status: updateState.status };
    autoUpdater.quitAndInstall(false, true);
    return { ok: true };
  });
  ipcMain.handle("ollama:status", async (_event, selectedModel?: unknown, baseUrl?: unknown) => {
    return checkOllamaStatus(validateModelName(selectedModel, "llama3.1:latest"), validateBaseUrl(baseUrl));
  });
  ipcMain.handle("ollama:open-download", async () => {
    await shell.openExternal(ollamaDownloadUrl);
    return { ok: true };
  });
  ipcMain.handle("ollama:start", async () => startOllama());
  ipcMain.handle("ollama:pull-model", async (event, modelName?: unknown) => {
    const safeModelName = readSafeModelName(modelName);
    if (!safeModelName) return { ok: false, message: "Invalid model name." };
    return pullOllamaModel(event.sender.id, safeModelName);
  });
  ipcMain.handle("ollama:cancel-pull", () => {
    if (!activePull) return { ok: true };
    activePull.kill();
    activePull = null;
    return { ok: true };
  });
  ipcMain.handle("notifications:schedule", (_event, tasks?: unknown, settings?: unknown) => {
    return scheduleTaskNotifications(tasks, settings);
  });
  ipcMain.handle("notifications:test", () => showTaskNotification({
    title: "Todo AI",
    body: "Notifications are ready.",
  }));
  createWindow();

  app.on("activate", () => {
    if (BrowserWindow.getAllWindows().length === 0) {
      createWindow();
    }
  });
});

app.on("window-all-closed", () => {
  if (process.platform !== "darwin") {
    app.quit();
  }
});

autoUpdater.on("checking-for-update", () => setUpdateState({ status: "checking" }));
autoUpdater.on("update-available", (info) => setUpdateState({ status: "available", version: info.version }));
autoUpdater.on("update-not-available", () => setUpdateState({ status: "not-available" }));
autoUpdater.on("download-progress", (progress) => setUpdateState({ status: "downloading", progress: Math.round(progress.percent) }));
autoUpdater.on("update-downloaded", (info) => setUpdateState({ status: "downloaded", version: info.version }));
autoUpdater.on("error", (error) => setUpdateState({ status: "error", message: error.message }));

async function checkForUpdates() {
  if (isDev) {
    return setUpdateState({
      status: "unavailable",
      message: "Updates can be checked from a packaged release build.",
    });
  }

  try {
    setUpdateState({ status: "checking" });
    await autoUpdater.checkForUpdates();
    return updateState;
  } catch (error) {
    return setUpdateState({ status: "error", message: error instanceof Error ? error.message : "Could not check for updates." });
  }
}

async function downloadUpdate() {
  if (updateState.status !== "available") return { ok: false, ...updateState };
  try {
    setUpdateState({ ...updateState, status: "downloading", progress: 0 });
    await autoUpdater.downloadUpdate();
    return { ok: true, ...updateState };
  } catch (error) {
    return { ok: false, ...setUpdateState({ status: "error", message: error instanceof Error ? error.message : "Could not download the update." }) };
  }
}

function setUpdateState(nextState: typeof updateState) {
  updateState = nextState;
  broadcast("updates:status", updateState);
  return updateState;
}

function scheduleTaskNotifications(tasks: unknown, settings: unknown) {
  for (const timer of notificationTimers.values()) {
    clearTimeout(timer);
  }
  notificationTimers.clear();

  const parsedSettings = readNotificationSettings(settings);
  if (!parsedSettings.enabled) return { ok: true, scheduled: 0 };
  if (!Array.isArray(tasks)) return { ok: false, scheduled: 0 };

  const now = Date.now();
  let scheduled = 0;

  for (const item of tasks) {
    const task = readNotificationTask(item);
    if (!task || task.status === "completed") continue;
    const scheduledAt = readScheduledDate(task.scheduledAt);
    if (!scheduledAt) continue;

    const notifyAt = scheduledAt.getTime() - parsedSettings.defaultReminderMinutes * 60_000;
    if (notifyAt <= now) continue;

    const key = `${task.id}:${task.scheduledAt}:${parsedSettings.defaultReminderMinutes}`;
    if (firedNotifications.has(key)) continue;

    const timer = setTimeout(() => {
      firedNotifications.add(key);
      notificationTimers.delete(key);
      void showTaskNotification({
        title: task.title,
        body: parsedSettings.defaultReminderMinutes === 0
          ? "Scheduled now"
          : `${parsedSettings.defaultReminderMinutes} minutes before scheduled time`,
      });
    }, Math.min(notifyAt - now, 2_147_483_647));

    notificationTimers.set(key, timer);
    scheduled += 1;
  }

  return { ok: true, scheduled };
}

function showTaskNotification({ title, body }: { title: string; body: string }) {
  if (!Notification.isSupported()) return { ok: false, supported: false };
  const notification = new Notification({
    title,
    body,
    silent: false,
  });
  notification.show();
  return { ok: true, supported: true };
}

function readNotificationSettings(value: unknown) {
  if (!isRecord(value)) return { enabled: false, defaultReminderMinutes: 0 as ReminderOffsetMinutes };
  return {
    enabled: value.enabled === true,
    defaultReminderMinutes: readReminderOffset(value.defaultReminderMinutes),
  };
}

function readNotificationTask(value: unknown): NotificationTaskPayload | null {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.title !== "string") return null;
  return {
    id: value.id,
    title: value.title.slice(0, 120),
    description: typeof value.description === "string" ? value.description.slice(0, 240) : "",
    status: value.status === "completed" ? "completed" : "active",
    scheduledAt: typeof value.scheduledAt === "string" ? value.scheduledAt : null,
  };
}

function readReminderOffset(value: unknown): ReminderOffsetMinutes {
  return value === 5 || value === 10 || value === 30 || value === 60 ? value : 0;
}

function readScheduledDate(value: string | null) {
  if (!value) return null;
  const dateValue = value.includes("T") ? new Date(value) : new Date(`${value}T09:00:00`);
  return Number.isNaN(dateValue.getTime()) ? null : dateValue;
}

async function checkOllamaStatus(selectedModel: string, baseUrl = "http://localhost:11434") {
  const installed = await findOllamaExecutable();
  if (!installed) {
    return {
      status: "not-installed" satisfies OllamaStatus,
      installed: false,
      running: false,
      reachable: false,
      models: [] as OllamaModel[],
      selectedModelInstalled: false,
      selectedModel,
    };
  }

  try {
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/api/tags`, { method: "GET" });
    if (!response.ok) throw new Error(`Ollama returned ${response.status}`);
    const payload = (await response.json()) as unknown;
    const models = readOllamaModels(payload);
    const selectedModelInstalled = models.some((model) => modelMatches(model.name, selectedModel));
    return {
      status: selectedModelInstalled ? "connected" as const : "model-missing" as const,
      installed: true,
      running: true,
      reachable: true,
      executablePath: installed,
      models,
      selectedModelInstalled,
      selectedModel,
    };
  } catch {
    return {
      status: "not-running" satisfies OllamaStatus,
      installed: true,
      running: false,
      reachable: false,
      executablePath: installed,
      models: [] as OllamaModel[],
      selectedModelInstalled: false,
      selectedModel,
    };
  }
}

async function startOllama() {
  const executable = await findOllamaExecutable();
  if (!executable) return { ok: false, status: "not-installed" };

  try {
    const child = spawn(executable, ["serve"], {
      detached: true,
      stdio: "ignore",
      windowsHide: true,
    });
    child.unref();
    return { ok: true };
  } catch (error) {
    return { ok: false, message: error instanceof Error ? error.message : "Could not start Ollama." };
  }
}

async function pullOllamaModel(senderId: number, modelName: string) {
  if (!recommendedModels.has(modelName) && !isSafeModelName(modelName)) {
    return { ok: false, message: "Invalid model name." };
  }

  if (activePull) {
    return { ok: false, message: "A model install is already running." };
  }

  const executable = await findOllamaExecutable();
  if (!executable) return { ok: false, status: "not-installed" };

  return new Promise((resolve) => {
    const child = spawn(executable, ["pull", modelName], {
      windowsHide: true,
    });
    activePull = child;
    const senderWindow = BrowserWindow.getAllWindows().find((window) => window.webContents.id === senderId);
    let lastMessage = "";

    const sendProgress = (payload: Record<string, unknown>) => {
      senderWindow?.webContents.send("ollama:pull-progress", { modelName, ...payload });
    };

    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const payload = JSON.parse(line) as { status?: string; completed?: number; total?: number };
          lastMessage = payload.status ?? lastMessage;
          sendProgress({
            status: payload.status ?? "downloading",
            completed: payload.completed,
            total: payload.total,
            percent: payload.total && payload.completed ? Math.round((payload.completed / payload.total) * 100) : undefined,
          });
        } catch {
          lastMessage = line;
          sendProgress({ status: line });
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      lastMessage = data.toString("utf8").trim() || lastMessage;
      sendProgress({ status: lastMessage, type: "error-output" });
    });

    child.on("close", (code) => {
      activePull = null;
      if (code === 0) {
        sendProgress({ status: "success", percent: 100 });
        resolve({ ok: true, modelName });
      } else {
        sendProgress({ status: "error", message: lastMessage || "Model install failed." });
        resolve({ ok: false, modelName, message: lastMessage || "Model install failed." });
      }
    });
  });
}

async function findOllamaExecutable() {
  const candidates = getOllamaCandidates();
  const existing = candidates.find((candidate) => fs.existsSync(candidate));
  if (existing) return existing;

  const command = process.platform === "win32" ? "where.exe" : "which";
  return new Promise<string | null>((resolve) => {
    execFile(command, ["ollama"], { windowsHide: true }, (error, stdout) => {
      if (error) return resolve(null);
      const firstMatch = stdout.split(/\r?\n/).map((line) => line.trim()).find(Boolean);
      resolve(firstMatch ?? null);
    });
  });
}

function getOllamaCandidates() {
  if (process.platform === "win32") {
    const localAppData = process.env.LOCALAPPDATA ?? "";
    const programFiles = process.env.ProgramFiles ?? "";
    const programFilesX86 = process.env["ProgramFiles(x86)"] ?? "";
    return [
      path.join(localAppData, "Programs", "Ollama", "ollama.exe"),
      path.join(programFiles, "Ollama", "ollama.exe"),
      path.join(programFilesX86, "Ollama", "ollama.exe"),
    ].filter(Boolean);
  }

  return [
    "/usr/local/bin/ollama",
    "/opt/homebrew/bin/ollama",
    path.join(os.homedir(), ".ollama", "bin", "ollama"),
  ];
}

function readOllamaModels(payload: unknown): OllamaModel[] {
  if (!isRecord(payload) || !Array.isArray(payload.models)) return [];
  return payload.models
    .filter((model): model is { name: string; modified_at?: string; size?: number } => isRecord(model) && typeof model.name === "string")
    .map((model) => ({ name: model.name, modifiedAt: model.modified_at, size: model.size }));
}

function validateBaseUrl(value: unknown) {
  if (typeof value !== "string") return "http://localhost:11434";
  try {
    const url = new URL(value);
    if (url.protocol !== "http:" && url.protocol !== "https:") return "http://localhost:11434";
    if (!["localhost", "127.0.0.1", "::1"].includes(url.hostname)) return "http://localhost:11434";
    return value;
  } catch {
    return "http://localhost:11434";
  }
}

function validateModelName(value: unknown, fallback: string) {
  return readSafeModelName(value) ?? fallback;
}

function readSafeModelName(value: unknown) {
  if (typeof value !== "string") return null;
  const normalized = value.trim();
  return isSafeModelName(normalized) ? normalized : null;
}

function isSafeModelName(value: string) {
  return value.length > 0 && value.length <= 80 && /^[a-zA-Z0-9._/-]+(?::[a-zA-Z0-9._-]+)?$/.test(value);
}

function modelMatches(installedModel: string, selectedModel: string) {
  return installedModel === selectedModel || installedModel.replace(/:latest$/, "") === selectedModel || selectedModel.replace(/:latest$/, "") === installedModel;
}

function broadcast(channel: string, payload: unknown) {
  for (const window of BrowserWindow.getAllWindows()) {
    window.webContents.send(channel, payload);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
