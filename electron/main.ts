import { app, BrowserWindow, ipcMain, nativeTheme, Notification, session, shell } from "electron";
import { autoUpdater } from "electron-updater";
import { execFile, spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import fs from "node:fs";
import keytar from "keytar";
import os from "node:os";
import path from "node:path";

const isDev = !app.isPackaged;
const ollamaDownloadUrl = "https://ollama.com/download";
const openRouterService = "Todo AI";
const openRouterAccount = "openrouter";
const defaultOpenRouterModel = "openrouter/free";
const openRouterModels = new Set(["openrouter/free", "deepseek/deepseek-v4-flash:free"]);
const openRouterEndpoint = "https://openrouter.ai/api/v1/chat/completions";
const recommendedModels = new Set([
  "llama3.1:latest",
  "llama3.2:latest",
  "mistral:latest",
  "gemma:latest",
  "qwen2.5:latest",
  "deepseek-r1:latest",
  "kimi-k2-thinking:cloud",
  "glm4:latest",
  "neutron:latest",
  "llama3.1",
  "llama3.2",
  "mistral",
  "gemma",
  "qwen2.5",
  "deepseek-r1",
  "kimi-k2-thinking",
  "glm4",
  "neutron",
]);

type UpdateStatus = "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error" | "unavailable";
type OllamaStatus = "connected" | "model-missing" | "not-running" | "not-installed";
type OpenRouterRole = "system" | "user" | "assistant";
type OpenRouterStatus =
  | "connected"
  | "missing-key"
  | "invalid-key"
  | "billing-issue"
  | "model-unavailable"
  | "rate-limited"
  | "provider-unavailable"
  | "offline"
  | "provider-error"
  | "unexpected-response"
  | "invalid-request";

interface OllamaModel {
  name: string;
  modifiedAt?: string;
  size?: number;
}

interface PullProgressPayload {
  status?: string;
  completed?: number;
  total?: number;
  percent?: number;
  speedBytesPerSecond?: number;
  step?: string;
  details?: string;
  message?: string;
  type?: string;
}

interface OpenRouterChatRequest {
  messages: Array<{ role: OpenRouterRole; content: string }>;
  model: string;
}

interface NotificationTaskPayload {
  id: string;
  title: string;
  description?: string;
  status: "active" | "completed";
  scheduledAt: string | null;
  reminderMinutes?: ReminderOffsetMinutes | null;
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
  ipcMain.handle("ollama:delete-model", async (_event, modelName?: unknown) => {
    const safeModelName = readSafeModelName(modelName);
    if (!safeModelName) return { ok: false, message: "Invalid model name." };
    return deleteOllamaModel(safeModelName);
  });
  ipcMain.handle("ollama:cancel-pull", () => {
    if (!activePull) return { ok: true };
    activePull.kill();
    activePull = null;
    return { ok: true };
  });
  ipcMain.handle("openrouter:set-api-key", async (_event, apiKey?: unknown) => setOpenRouterApiKey(apiKey));
  ipcMain.handle("openrouter:has-api-key", async () => hasOpenRouterApiKey());
  ipcMain.handle("openrouter:delete-api-key", async () => deleteOpenRouterApiKey());
  ipcMain.handle("openrouter:test-connection", async (_event, selectedModel?: unknown) => testOpenRouterConnection(selectedModel));
  ipcMain.handle("ai:chat-openrouter", async (_event, payload?: unknown) => chatOpenRouter(payload));
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

    const reminderMinutes = task.reminderMinutes ?? parsedSettings.defaultReminderMinutes;
    const notifyAt = scheduledAt.getTime() - reminderMinutes * 60_000;
    if (notifyAt <= now) continue;

    const key = `${task.id}:${task.scheduledAt}:${reminderMinutes}`;
    if (firedNotifications.has(key)) continue;

    const timer = setTimeout(() => {
      firedNotifications.add(key);
      notificationTimers.delete(key);
      void showTaskNotification({
        title: task.title,
        body: reminderMinutes === 0
          ? "Scheduled now"
          : `${reminderMinutes} minutes before scheduled time`,
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
    reminderMinutes: readReminderOffsetOrNull(value.reminderMinutes),
  };
}

function readReminderOffset(value: unknown): ReminderOffsetMinutes {
  return value === 5 || value === 10 || value === 30 || value === 60 ? value : 0;
}

function readReminderOffsetOrNull(value: unknown): ReminderOffsetMinutes | null {
  return value === 0 || value === 5 || value === 10 || value === 30 || value === 60 ? value : null;
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
    let lastCompleted = 0;
    let lastTimestamp = Date.now();

    const sendProgress = (payload: PullProgressPayload) => {
      senderWindow?.webContents.send("ollama:pull-progress", { modelName, ...payload });
    };

    child.stdout.on("data", (data: Buffer) => {
      const lines = data.toString("utf8").split(/\r?\n/).filter(Boolean);
      for (const line of lines) {
        try {
          const payload = JSON.parse(line) as { status?: string; completed?: number; total?: number };
          lastMessage = payload.status ?? lastMessage;
          const now = Date.now();
          const completed = typeof payload.completed === "number" ? payload.completed : undefined;
          const total = typeof payload.total === "number" ? payload.total : undefined;
          const elapsedSeconds = Math.max(0.1, (now - lastTimestamp) / 1000);
          const speedBytesPerSecond = completed !== undefined && completed >= lastCompleted
            ? Math.round((completed - lastCompleted) / elapsedSeconds)
            : undefined;
          if (completed !== undefined) {
            lastCompleted = completed;
            lastTimestamp = now;
          }
          sendProgress({
            status: payload.status ?? "downloading",
            step: normalizePullStep(payload.status),
            completed,
            total,
            speedBytesPerSecond,
            percent: total && completed !== undefined ? Math.round((completed / total) * 100) : undefined,
            details: line,
          });
        } catch {
          lastMessage = line;
          sendProgress({ status: "working", step: normalizePullStep(line), details: line });
        }
      }
    });

    child.stderr.on("data", (data: Buffer) => {
      lastMessage = data.toString("utf8").trim() || lastMessage;
      sendProgress({ status: "working", step: normalizePullStep(lastMessage), details: lastMessage, type: "error-output" });
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

async function deleteOllamaModel(modelName: string) {
  const executable = await findOllamaExecutable();
  if (!executable) return { ok: false, status: "not-installed", message: "Ollama is not installed." };

  return new Promise((resolve) => {
    execFile(executable, ["rm", modelName], { windowsHide: true }, (error, stdout, stderr) => {
      if (error) {
        const message = sanitizeCommandMessage(stderr || stdout || error.message || "Could not delete model.");
        resolve({ ok: false, modelName, message });
        return;
      }
      resolve({ ok: true, modelName });
    });
  });
}

async function setOpenRouterApiKey(value: unknown) {
  if (typeof value !== "string") return { ok: false, status: "invalid" };
  const apiKey = value.trim();
  if (!/^sk-or-v1-[A-Za-z0-9_-]{20,}$/.test(apiKey)) return { ok: false, status: "invalid" };
  await keytar.setPassword(openRouterService, openRouterAccount, apiKey);
  return { ok: true };
}

async function hasOpenRouterApiKey() {
  const apiKey = await keytar.getPassword(openRouterService, openRouterAccount);
  return { ok: true, hasKey: Boolean(apiKey) };
}

async function deleteOpenRouterApiKey() {
  await keytar.deletePassword(openRouterService, openRouterAccount);
  return { ok: true };
}

async function testOpenRouterConnection(selectedModel?: unknown) {
  const result = await chatOpenRouter({
    model: readOpenRouterModel(selectedModel),
    messages: [
      { role: "system", content: "Reply with exactly: OK" },
      { role: "user", content: "test" },
    ],
  }, true);
  if (!result.ok) return result;
  const content = "content" in result ? result.content : "";
  if (typeof content !== "string" || !content.trim()) {
    return { ok: false, status: "unexpected-response", message: "OpenRouter returned an empty response.", model: readOpenRouterModel(selectedModel) };
  }
  return { ok: true, status: "connected", message: "Connected", model: readOpenRouterModel(selectedModel) };
}

async function chatOpenRouter(payload: unknown, isTest = false) {
  const apiKey = await keytar.getPassword(openRouterService, openRouterAccount);
  if (!apiKey) return { ok: false, status: "missing-key", message: "OpenRouter API key is missing." };
  const request = readOpenRouterRequest(payload);
  if (!request) return { ok: false, status: "invalid-request", message: "Invalid AI request." };

  try {
    return await sendOpenRouterChat(apiKey, request, isTest);
  } catch (error) {
    logOpenRouterDebug("OpenRouter network error", {
      provider: "openrouter",
      model: request?.model ?? defaultOpenRouterModel,
      error: error instanceof Error ? error.message : String(error),
    });
    return { ok: false, status: "offline", message: "OpenRouter is unreachable. Check your internet connection." };
  }
}

async function sendOpenRouterChat(apiKey: string, request: OpenRouterChatRequest, isTest: boolean) {
  logOpenRouterDebug("Sending OpenRouter chat request", {
    provider: "openrouter",
    model: request.model,
    requestType: isTest ? "connection-test" : "chat",
  });

  const response = await fetch(openRouterEndpoint, {
    method: "POST",
    headers: {
      "Authorization": `Bearer ${apiKey}`,
      "Content-Type": "application/json",
      "HTTP-Referer": "https://github.com/ArturKamnev/todo-list",
      "X-Title": "Todo AI",
    },
    body: JSON.stringify({
      model: request.model,
      messages: request.messages,
      stream: false,
    }),
  });

  logOpenRouterDebug("OpenRouter HTTP response", {
    provider: "openrouter",
    model: request.model,
    httpStatus: response.status,
  });

  const bodyText = await response.text();
  if (!response.ok) {
    const errorMessage = readOpenRouterErrorMessage(bodyText, response.status);
    const status = mapOpenRouterHttpStatus(response.status);
    logOpenRouterDebug("OpenRouter error response", {
      provider: "openrouter",
      model: request.model,
      httpStatus: response.status,
      sanitizedErrorBody: sanitizeProviderBody(bodyText),
    });
    return { ok: false, status, httpStatus: response.status, message: errorMessage, model: request.model };
  }

  const data = parseJsonSafely(bodyText);
  const content = readOpenRouterContent(data);
  logOpenRouterDebug("OpenRouter assistant content", {
    provider: "openrouter",
    model: request.model,
    httpStatus: response.status,
    rawAssistantContent: content,
  });
  if (!content) {
    return {
      ok: false,
      status: "unexpected-response" satisfies OpenRouterStatus,
      httpStatus: response.status,
      message: "OpenRouter returned a valid response, but no assistant text was found.",
      model: request.model,
    };
  }
  return { ok: true, status: "connected" satisfies OpenRouterStatus, model: request.model, content, httpStatus: response.status };
}

function readOpenRouterRequest(value: unknown): OpenRouterChatRequest | null {
  if (!isRecord(value) || !Array.isArray(value.messages)) return null;
  const messages = value.messages
    .map((message) => {
      if (!isRecord(message) || (message.role !== "system" && message.role !== "user" && message.role !== "assistant") || typeof message.content !== "string") return null;
      return { role: message.role, content: message.content.slice(0, 12000) };
    })
    .filter((message): message is { role: "system" | "user" | "assistant"; content: string } => Boolean(message));
  if (!messages.length) return null;
  return { messages, model: readOpenRouterModel(value.model) };
}

function readOpenRouterModel(value: unknown) {
  return typeof value === "string" && openRouterModels.has(value) ? value : defaultOpenRouterModel;
}

function readOpenRouterContent(value: unknown) {
  if (!isRecord(value) || !Array.isArray(value.choices)) return "";
  const choice = value.choices[0];
  if (!isRecord(choice) || !isRecord(choice.message) || typeof choice.message.content !== "string") return "";
  return choice.message.content.trim();
}

function mapOpenRouterHttpStatus(status: number): OpenRouterStatus {
  if (status === 401 || status === 403) return "invalid-key";
  if (status === 402) return "billing-issue";
  if (status === 404) return "model-unavailable";
  if (status === 429) return "rate-limited";
  if (status === 502 || status === 503) return "provider-unavailable";
  return "provider-error";
}

function readOpenRouterErrorMessage(bodyText: string, status: number) {
  const payload = parseJsonSafely(bodyText);
  const fallback = openRouterStatusMessage(status);
  if (isRecord(payload)) {
    const error = payload.error;
    if (isRecord(error) && typeof error.message === "string") return addOpenRouterStatusHint(sanitizeProviderMessage(error.message), fallback, status);
    if (typeof payload.message === "string") return addOpenRouterStatusHint(sanitizeProviderMessage(payload.message), fallback, status);
  }
  const sanitized = sanitizeProviderBody(bodyText);
  return sanitized ? addOpenRouterStatusHint(sanitizeProviderMessage(sanitized), fallback, status) : fallback;
}

function addOpenRouterStatusHint(message: string, fallback: string, status: number) {
  if (![402, 429, 502, 503].includes(status)) return message;
  if (!message || message === fallback) return fallback;
  const combined = `${message} ${fallback}`;
  return combined.length > 320 ? `${combined.slice(0, 317)}...` : combined;
}

function openRouterStatusMessage(status: number) {
  if (status === 401 || status === 403) return "Invalid API key.";
  if (status === 402) return "Free model unavailable or this account cannot use free requests. Check your OpenRouter balance.";
  if (status === 404) return "Model unavailable or invalid model ID.";
  if (status === 429) return "Free request limit reached. Try again later.";
  if (status === 502 || status === 503) return "Selected provider unavailable. Try again or switch to Auto Free Model.";
  return "OpenRouter could not complete the request.";
}

function parseJsonSafely(value: string) {
  try {
    return JSON.parse(value) as unknown;
  } catch {
    return null;
  }
}

function sanitizeProviderBody(value: string) {
  const sanitized = value
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "sk-or-v1-[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > 800 ? `${sanitized.slice(0, 797)}...` : sanitized;
}

function sanitizeProviderMessage(value: string) {
  const sanitized = sanitizeProviderBody(value);
  return sanitized.length > 240 ? `${sanitized.slice(0, 237)}...` : sanitized || "OpenRouter could not complete the request.";
}

function logOpenRouterDebug(message: string, data: Record<string, string | number | boolean | undefined>) {
  if (!isDev) return;
  console.info(`[Todo AI] ${message}`, data);
}

function normalizePullStep(status: string | undefined) {
  if (!status) return "Preparing download";
  const normalized = status.toLowerCase();
  if (normalized.includes("pulling manifest")) return "Reading model manifest";
  if (normalized.includes("pulling") || normalized.includes("downloading")) return "Downloading model files";
  if (normalized.includes("verifying")) return "Verifying download";
  if (normalized.includes("writing")) return "Writing model to disk";
  if (normalized.includes("removing")) return "Cleaning up";
  if (normalized.includes("success")) return "Installed";
  if (normalized.includes("error")) return "Install failed";
  return status.length > 120 ? `${status.slice(0, 117)}...` : status;
}

function sanitizeCommandMessage(value: string) {
  const normalized = value.replace(/\u001b\[[0-9;]*m/g, "").replace(/\s+/g, " ").trim();
  return normalized.length > 220 ? `${normalized.slice(0, 217)}...` : normalized || "Command failed.";
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
