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
    deleteOllamaModel: (modelName: string) => Promise<{ ok: boolean; modelName?: string; status?: string; message?: string }>;
    cancelOllamaPull: () => Promise<{ ok: boolean }>;
    onOllamaPullProgress: (callback: (payload: OllamaPullProgress) => void) => () => void;
    setOpenRouterApiKey: (apiKey: string) => Promise<{ ok: boolean; status?: string; message?: string }>;
    hasOpenRouterApiKey: () => Promise<{ ok: boolean; hasKey: boolean }>;
    deleteOpenRouterApiKey: () => Promise<{ ok: boolean }>;
    testOpenRouterConnection: (model: string) => Promise<OpenRouterResult>;
    chatOpenRouter: (payload: OpenRouterRequest) => Promise<OpenRouterResult>;
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
  speedBytesPerSecond?: number;
  step?: string;
  details?: string;
  message?: string;
  type?: string;
};

type NotificationTaskPayload = {
  id: string;
  title: string;
  description?: string;
  status: "active" | "completed";
  scheduledAt: string | null;
  reminderMinutes?: 0 | 5 | 10 | 30 | 60 | null;
};

type NotificationSettingsPayload = {
  enabled: boolean;
  defaultReminderMinutes: 0 | 5 | 10 | 30 | 60;
};

type OpenRouterRequest = {
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>;
  model: string;
  json?: boolean;
  mode?: string;
};

type OpenRouterResult = {
  ok: boolean;
  status: "connected" | "missing-key" | "invalid-key" | "billing-issue" | "model-unavailable" | "rate-limited" | "provider-unavailable" | "offline" | "provider-error" | "unexpected-response" | "invalid" | "invalid-request";
  content?: string;
  model?: string;
  requestedModel?: string;
  actualModel?: string;
  message?: string;
  httpStatus?: number;
};
