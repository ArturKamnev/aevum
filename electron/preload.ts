import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("todoAI", {
  getSystemTheme: (): Promise<"dark" | "light"> => ipcRenderer.invoke("app:get-theme"),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:get-version"),
  openExternalLink: (url: string): Promise<{ ok: boolean; status?: string }> => ipcRenderer.invoke("app:open-external-link", url),
  clearAppCache: (): Promise<{ ok: boolean }> => ipcRenderer.invoke("app:clear-cache"),
  checkForUpdates: () => ipcRenderer.invoke("updates:check"),
  downloadUpdate: () => ipcRenderer.invoke("updates:download"),
  installUpdate: () => ipcRenderer.invoke("updates:install"),
  onUpdateStatus: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("updates:status", listener);
    return () => ipcRenderer.removeListener("updates:status", listener);
  },
  checkOllamaStatus: (selectedModel: string, baseUrl: string) => ipcRenderer.invoke("ollama:status", selectedModel, baseUrl),
  openOllamaDownload: () => ipcRenderer.invoke("ollama:open-download"),
  startOllama: () => ipcRenderer.invoke("ollama:start"),
  pullOllamaModel: (modelName: string) => ipcRenderer.invoke("ollama:pull-model", modelName),
  deleteOllamaModel: (modelName: string) => ipcRenderer.invoke("ollama:delete-model", modelName),
  cancelOllamaPull: () => ipcRenderer.invoke("ollama:cancel-pull"),
  onOllamaPullProgress: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("ollama:pull-progress", listener);
    return () => ipcRenderer.removeListener("ollama:pull-progress", listener);
  },
  setOpenRouterApiKey: (apiKey: string) => ipcRenderer.invoke("openrouter:set-api-key", apiKey),
  hasOpenRouterApiKey: () => ipcRenderer.invoke("openrouter:has-api-key"),
  deleteOpenRouterApiKey: () => ipcRenderer.invoke("openrouter:delete-api-key"),
  testOpenRouterConnection: (model: string) => ipcRenderer.invoke("openrouter:test-connection", model),
  chatOpenRouter: (payload: unknown) => ipcRenderer.invoke("ai:chat-openrouter", payload),
  scheduleTaskNotifications: (tasks: unknown[], settings: unknown) => ipcRenderer.invoke("notifications:schedule", tasks, settings),
  showTestNotification: () => ipcRenderer.invoke("notifications:test"),
  getTelegramStatus: () => ipcRenderer.invoke("telegram:get-status"),
  setTelegramBotToken: (token: string) => ipcRenderer.invoke("telegram:set-token", token),
  disconnectTelegramBot: () => ipcRenderer.invoke("telegram:disconnect"),
  unpairTelegramChat: () => ipcRenderer.invoke("telegram:unpair"),
  reconnectTelegramPolling: () => ipcRenderer.invoke("telegram:reconnect-polling"),
  updateTelegramSettings: (settings: unknown) => ipcRenderer.invoke("telegram:update-settings", settings),
  markTelegramRendererReady: () => ipcRenderer.invoke("telegram:renderer-ready"),
  sendTelegramRendererResponse: (payload: unknown) => ipcRenderer.invoke("telegram:renderer-response", payload),
  onTelegramStatus: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("telegram:status", listener);
    return () => ipcRenderer.removeListener("telegram:status", listener);
  },
  onTelegramMessageRequest: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("telegram:message-request", listener);
    return () => ipcRenderer.removeListener("telegram:message-request", listener);
  },
  onTelegramDecisionRequest: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("telegram:decision-request", listener);
    return () => ipcRenderer.removeListener("telegram:decision-request", listener);
  },
  onTelegramCallbackRequest: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("telegram:callback-request", listener);
    return () => ipcRenderer.removeListener("telegram:callback-request", listener);
  },
  getMcpStatus: () => ipcRenderer.invoke("mcp:get-status"),
  updateMcpSettings: (settings: unknown) => ipcRenderer.invoke("mcp:update-settings", settings),
  getMcpToken: () => ipcRenderer.invoke("mcp:get-token"),
  regenerateMcpToken: () => ipcRenderer.invoke("mcp:regenerate-token"),
  markMcpRendererReady: () => ipcRenderer.invoke("mcp:renderer-ready"),
  sendMcpRendererResponse: (payload: unknown) => ipcRenderer.invoke("mcp:renderer-response", payload),
  onMcpStatus: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("mcp:status", listener);
    return () => ipcRenderer.removeListener("mcp:status", listener);
  },
  onMcpSnapshotRequest: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("mcp:snapshot-request", listener);
    return () => ipcRenderer.removeListener("mcp:snapshot-request", listener);
  },
  onMcpProposalRequest: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("mcp:proposal-request", listener);
    return () => ipcRenderer.removeListener("mcp:proposal-request", listener);
  },
  getAevumConnectStatus: () => ipcRenderer.invoke("aevum-connect:get-status"),
  updateAevumConnectSettings: (settings: unknown) => ipcRenderer.invoke("aevum-connect:update-settings", settings),
  resetAevumConnect: () => ipcRenderer.invoke("aevum-connect:reset"),
  listAevumConnectClients: () => ipcRenderer.invoke("aevum-connect:list-clients"),
  revokeAevumConnectClient: (clientId: string) => ipcRenderer.invoke("aevum-connect:revoke-client", clientId),
  revokeAllAevumConnectClients: () => ipcRenderer.invoke("aevum-connect:revoke-all"),
  onAevumConnectStatus: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("aevum-connect:status", listener);
    return () => ipcRenderer.removeListener("aevum-connect:status", listener);
  },
});
