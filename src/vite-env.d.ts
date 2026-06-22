/// <reference types="vite/client" />

interface Window {
  todoAI?: {
    getSystemTheme: () => Promise<"dark" | "light">;
    getAppVersion: () => Promise<string>;
    openExternalLink: (url: string) => Promise<{ ok: boolean; status?: string }>;
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
    getTelegramStatus: () => Promise<TelegramStatusResult>;
    setTelegramBotToken: (token: string) => Promise<TelegramStatusResult & { ok: boolean }>;
    disconnectTelegramBot: () => Promise<TelegramStatusResult & { ok: boolean }>;
    unpairTelegramChat: () => Promise<TelegramStatusResult & { ok: boolean }>;
    reconnectTelegramPolling: () => Promise<TelegramStatusResult & { ok: boolean }>;
    updateTelegramSettings: (settings: TelegramSettingsPayload) => Promise<TelegramStatusResult>;
    markTelegramRendererReady: () => Promise<{ ok: boolean }>;
    sendTelegramRendererResponse: (payload: TelegramRendererResponsePayload) => Promise<{ ok: boolean }>;
    onTelegramStatus: (callback: (payload: TelegramStatusResult) => void) => () => void;
    onTelegramMessageRequest: (callback: (payload: TelegramMessageRequestPayload) => void) => () => void;
    onTelegramDecisionRequest: (callback: (payload: TelegramDecisionRequestPayload) => void) => () => void;
    onTelegramCallbackRequest: (callback: (payload: TelegramCallbackRequestPayload) => void) => () => void;
    getMcpStatus: () => Promise<McpStatusResult>;
    updateMcpSettings: (settings: McpSettingsPayload) => Promise<McpStatusResult>;
    getMcpToken: () => Promise<{ ok: boolean; token: string }>;
    regenerateMcpToken: () => Promise<{ ok: boolean; token: string; status: McpStatusResult }>;
    markMcpRendererReady: () => Promise<{ ok: boolean }>;
    sendMcpRendererResponse: (payload: McpRendererResponsePayload) => Promise<{ ok: boolean }>;
    onMcpStatus: (callback: (payload: McpStatusResult) => void) => () => void;
    onMcpSnapshotRequest: (callback: (payload: McpRendererRequestPayload) => void) => () => void;
    onMcpProposalRequest: (callback: (payload: McpRendererRequestPayload) => void) => () => void;
    getAevumConnectStatus: () => Promise<AevumConnectStatusResult>;
    updateAevumConnectSettings: (settings: AevumConnectSettingsPayload) => Promise<AevumConnectStatusResult>;
    resetAevumConnect: () => Promise<AevumConnectStatusResult>;
    listAevumConnectClients: () => Promise<AevumConnectAuthorizedClient[]>;
    revokeAevumConnectClient: (clientId: string) => Promise<boolean>;
    revokeAllAevumConnectClients: () => Promise<boolean>;
    onAevumConnectStatus: (callback: (payload: AevumConnectStatusResult) => void) => () => void;
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

type TelegramBridgeStatus = "disabled" | "connecting" | "connected" | "reconnecting" | "invalid-token" | "not-paired" | "webhook-conflict" | "error";
type TelegramInteractionMode = "template" | "ai";

type TelegramStatusResult = {
  status: TelegramBridgeStatus;
  enabled: boolean;
  hasToken: boolean;
  bot?: {
    id: number;
    username?: string;
    firstName?: string;
  };
  pairedChat?: {
    id: number;
    username?: string;
    firstName?: string;
  };
  pairingCode?: string;
  pairingExpiresAt?: string;
  interactionMode: TelegramInteractionMode;
  message?: string;
};

type TelegramSettingsPayload = {
  enabled: boolean;
  language: "en" | "ru";
  useDefaultAI: boolean;
  aiProvider: "ollama" | "openrouter";
  localModel: string;
  cloudModel: string;
};

type TelegramMessageRequestPayload = {
  id: string;
  chatId: number;
  messageId: number;
  text: string;
  interactionMode: TelegramInteractionMode;
};

type TelegramDecisionRequestPayload = {
  id: string;
  proposalId: string;
  decision: "confirm" | "cancel";
  chatId: number;
};

type TelegramCallbackRequestPayload = {
  id: string;
  chatId: number;
  data: string;
  interactionMode: TelegramInteractionMode;
};

type TelegramResponseButton = {
  text: string;
  callbackData: string;
};

type TelegramRendererResponse =
  | { ok: true; kind: "message"; text: string }
  | { ok: true; kind: "buttons"; text: string; buttons: TelegramResponseButton[][] }
  | { ok: true; kind: "proposal"; proposalId: string; text: string }
  | { ok: false; text: string };

type TelegramRendererResponsePayload = {
  id: string;
  response: TelegramRendererResponse;
};

type McpAccessMode = "read-only" | "proposals" | "full-access";
type McpServerState = "disabled" | "starting" | "running" | "error";
type McpAuthenticationMode = "bearer" | "oauth";
type McpTunnelMode = "temporary" | "persistent";
type McpSettingsPayload = { enabled: boolean; accessMode: McpAccessMode; port: number; authenticationMode: McpAuthenticationMode; remoteUrl: string; tunnelMode: McpTunnelMode };
type McpStatusResult = McpSettingsPayload & {
  status: McpServerState;
  endpoint: string;
  hasToken: boolean;
  remoteEndpoint?: string;
  oauth: {
    currentStage?: "pending_browser_consent" | "pending_native_approval" | "approved" | "denied" | "expired" | "consumed";
    activeSessionCount: number;
    registeredClientCount: number;
    activeGrantCount: number;
    lastGrantedScopes?: string[];
    lastError?: string;
    lastRedirectStatus?: string;
  };
  toolAccess: {
    selectedMode: McpAccessMode;
    grantedScopes: string[];
    registeredClientCount: number;
    activeGrantCount: number;
    writeToolsExposed: boolean;
    lastToolListMode?: McpAccessMode;
    lastToolError?: string;
  };
  tunnel: {
    state: "disabled" | "starting" | "running" | "error" | "missing";
    origin?: string;
    connectorUrl?: string;
    error?: string;
  };
  message?: string;
};
type McpRendererRequestPayload = { id: string; payload: unknown };
type McpRendererResponsePayload = { id: string; ok: boolean; data?: unknown; message?: string };
type AevumConnectSettingsPayload = { enabled: boolean; relayOrigin: string; accessMode: McpAccessMode; provisionIdentity?: boolean };
type AevumConnectStatusResult = {
  state: "disabled" | "connecting" | "connected" | "offline" | "error";
  enabled: boolean;
  relayOrigin: string;
  accessMode: McpAccessMode;
  connectorUrl?: string;
  devicePublicId?: string;
  webSocketUrl?: string;
  devicePublicIdPreview?: string;
  lastReconnectReason?: string;
  lastSafeError?: string;
  lastConnectedAt?: string;
  connectorUrlAvailable: boolean;
  message?: string;
  clients?: AevumConnectAuthorizedClient[];
};
type AevumConnectAuthorizedClient = { clientId: string; name: string; scopes: string[]; createdAt: string; lastUsedAt?: string };
