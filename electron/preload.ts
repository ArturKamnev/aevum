import { contextBridge, ipcRenderer } from "electron";

contextBridge.exposeInMainWorld("todoAI", {
  getSystemTheme: (): Promise<"dark" | "light"> => ipcRenderer.invoke("app:get-theme"),
  getAppVersion: (): Promise<string> => ipcRenderer.invoke("app:get-version"),
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
  cancelOllamaPull: () => ipcRenderer.invoke("ollama:cancel-pull"),
  onOllamaPullProgress: (callback: (payload: unknown) => void) => {
    const listener = (_event: Electron.IpcRendererEvent, payload: unknown) => callback(payload);
    ipcRenderer.on("ollama:pull-progress", listener);
    return () => ipcRenderer.removeListener("ollama:pull-progress", listener);
  },
  scheduleTaskNotifications: (tasks: unknown[], settings: unknown) => ipcRenderer.invoke("notifications:schedule", tasks, settings),
  showTestNotification: () => ipcRenderer.invoke("notifications:test"),
});
