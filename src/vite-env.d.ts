/// <reference types="vite/client" />

interface Window {
  todoAI?: {
    getSystemTheme: () => Promise<"dark" | "light">;
    getAppVersion: () => Promise<string>;
    clearAppCache: () => Promise<{ ok: boolean }>;
    checkForUpdates: () => Promise<UpdateCheckResult>;
    downloadUpdate: () => Promise<UpdateCheckResult & { ok?: boolean }>;
    installUpdate: () => Promise<{ ok: boolean; status?: string }>;
    onUpdateStatus: (callback: (payload: UpdateCheckResult) => void) => () => void;
    checkOllamaStatus: (selectedModel: string, baseUrl: string) => Promise<OllamaSetupStatus>;
    openOllamaDownload: () => Promise<{ ok: boolean }>;
    startOllama: () => Promise<{ ok: boolean; status?: string; message?: string }>;
    pullOllamaModel: (modelName: string) => Promise<{ ok: boolean; modelName?: string; status?: string; message?: string }>;
    cancelOllamaPull: () => Promise<{ ok: boolean }>;
    onOllamaPullProgress: (callback: (payload: OllamaPullProgress) => void) => () => void;
    scheduleTaskNotifications: (tasks: NotificationTaskPayload[], settings: NotificationSettingsPayload) => Promise<{ ok: boolean; scheduled: number }>;
    showTestNotification: () => Promise<{ ok: boolean; supported: boolean }>;
  };
}

type UpdateCheckResult = {
  status: "idle" | "checking" | "available" | "not-available" | "downloading" | "downloaded" | "error" | "unavailable";
  message?: string;
  version?: string;
  progress?: number;
};

type OllamaSetupStatus = {
  status: "connected" | "model-missing" | "not-running" | "not-installed";
  installed: boolean;
  running: boolean;
  reachable: boolean;
  executablePath?: string;
  models: Array<{ name: string; modifiedAt?: string; size?: number }>;
  selectedModelInstalled: boolean;
  selectedModel: string;
};

type OllamaPullProgress = {
  modelName: string;
  status?: string;
  completed?: number;
  total?: number;
  percent?: number;
  message?: string;
  type?: string;
};

type NotificationTaskPayload = {
  id: string;
  title: string;
  description?: string;
  status: "active" | "completed";
  scheduledAt: string | null;
};

type NotificationSettingsPayload = {
  enabled: boolean;
  defaultReminderMinutes: 0 | 5 | 10 | 30 | 60;
};
