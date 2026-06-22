import {
  AlertTriangle,
  Bell,
  CalendarClock,
  Check,
  CheckCircle2,
  Clock3,
  Cpu,
  Copy,
  Database,
  Download,
  ExternalLink,
  Info,
  KeyRound,
  Languages,
  Loader2,
  Monitor,
  Moon,
  PackageCheck,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Send,
  Server,
  ShieldCheck,
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import type { AvailabilityBlock, AIProvider, Language, McpAccessMode, McpConnectionMode, McpTunnelMode, OverdueAutoCleanupMode, ReminderOffsetMinutes, ThemeMode, TimeFormat, UserSettings } from "../types";
import { normalizeMcpPublicOrigin } from "../services/mcpSettings";
import { createAvailabilityId } from "../utils/id";
import { SettingsHelpPopover } from "./SettingsHelpPopover";
import recommendedModelsJson from "../../electron/recommended_models.json";

interface SettingsPageProps {
  clearAiHistory: () => void;
  settings: UserSettings;
  updateSettings: (updates: Partial<UserSettings>) => void;
}

type SetupStatus = OllamaSetupStatus;
type UpdateStatus = UpdateCheckResult;
type PullState = "idle" | "loading" | "success" | "error";
type ConfirmAction =
  | { type: "cache" }
  | { type: "history" }
  | { type: "delete-model"; modelName: string }
  | { type: "overdue-delete" };


const openRouterModelOptions = [
  {
    id: "openrouter/free",
    labelKey: "settings.openRouterAutoFreeModel",
    descriptionKey: "settings.openRouterAutoFreeModelDescription",
    recommended: true,
  },
  {
    id: "deepseek/deepseek-v4-flash:free",
    labelKey: "settings.openRouterDeepseekModel",
    descriptionKey: "settings.openRouterDeepseekModelDescription",
    recommended: false,
  },
] as const;



const weekdayNumbers = [1, 2, 3, 4, 5, 6, 0];

export function SettingsPage({ clearAiHistory, settings, updateSettings }: SettingsPageProps) {
  const { language, languageNames, setLanguage, t } = useI18n();
  const openRouterKeyRef = useRef<HTMLInputElement>(null);
  const telegramTokenRef = useRef<HTMLInputElement>(null);
  const [appVersion, setAppVersion] = useState("");
  const [ollamaStatus, setOllamaStatus] = useState<SetupStatus | null>(null);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [showAdvancedAI, setShowAdvancedAI] = useState(false);
  const [customModel, setCustomModel] = useState(settings.localModel);
  const [pullState, setPullState] = useState<PullState>("idle");
  const [installingModel, setInstallingModel] = useState("");
  const [pullProgress, setPullProgress] = useState<OllamaPullProgress | null>(null);
  const [pullMessage, setPullMessage] = useState("");
  const [showTechnicalDetails, setShowTechnicalDetails] = useState(false);
  const [deletingModel, setDeletingModel] = useState("");
  const [modelActionMessage, setModelActionMessage] = useState("");
  const [openRouterStatus, setOpenRouterStatus] = useState<"idle" | "checking" | "connected" | "missing-key" | "invalid-key" | "billing-issue" | "model-unavailable" | "rate-limited" | "provider-unavailable" | "offline" | "error">("idle");
  const [openRouterStatusMessage, setOpenRouterStatusMessage] = useState("");
  const [hasOpenRouterKey, setHasOpenRouterKey] = useState(false);
  const [scheduleDraft, setScheduleDraft] = useState({ label: "", weekdays: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "17:00" });
  const [notificationStatus, setNotificationStatus] = useState("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ status: "idle" });
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [storageNotice, setStorageNotice] = useState("");
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [telegramStatus, setTelegramStatus] = useState<TelegramStatusResult | null>(null);
  const [telegramConnecting, setTelegramConnecting] = useState(false);
  const [telegramNotice, setTelegramNotice] = useState("");
  const [mcpStatus, setMcpStatus] = useState<McpStatusResult | null>(null);
  const [aevumConnectStatus, setAevumConnectStatus] = useState<AevumConnectStatusResult | null>(null);
  const [mcpNotice, setMcpNotice] = useState("");
  const [mcpPortDraft, setMcpPortDraft] = useState(String(settings.mcpPort));
  const [mcpRemoteUrlDraft, setMcpRemoteUrlDraft] = useState(settings.mcpRemoteUrl);

  const installedModels = ollamaStatus?.models ?? [];
  const selectedModelInstalled = ollamaStatus?.selectedModelInstalled ?? installedModels.some((model) => model.name === settings.localModel);
  const missingSelectedModel = Boolean(ollamaStatus && ollamaStatus.status === "model-missing");

  useEffect(() => {
    void refreshOpenRouterKeyStatus();
  }, []);

  useEffect(() => {
    let isMounted = true;
    window.todoAI?.getAppVersion()
      .then((version) => {
        if (isMounted) setAppVersion(version);
      })
      .catch(() => {
        if (isMounted) setAppVersion("");
      });

    const removeUpdateListener = window.todoAI?.onUpdateStatus((payload) => setUpdateStatus(payload));
    const removePullListener = window.todoAI?.onOllamaPullProgress((payload) => {
      setPullProgress(payload);
      if (payload.step || payload.status) setPullMessage(payload.step ?? payload.status ?? "");
      if (payload.status === "success") {
        setPullState("success");
        setInstallingModel("");
        void refreshOllamaStatus(false);
      }
      if (payload.status === "error") setPullState("error");
    });
    const removeTelegramListener = window.todoAI?.onTelegramStatus((payload) => setTelegramStatus(payload));
    const removeMcpListener = window.todoAI?.onMcpStatus((payload) => setMcpStatus(payload));
    const removeAevumConnectListener = window.todoAI?.onAevumConnectStatus((payload) => setAevumConnectStatus(payload));

    void refreshOllamaStatus(false);
    void refreshTelegramStatus();
    void refreshMcpStatus();
    void refreshAevumConnectStatus();
    return () => {
      isMounted = false;
      removeUpdateListener?.();
      removePullListener?.();
      removeTelegramListener?.();
      removeMcpListener?.();
      removeAevumConnectListener?.();
    };
  }, []);

  async function refreshMcpStatus() {
    const status = await window.todoAI?.getMcpStatus();
    if (status) setMcpStatus(status);
  }

  async function refreshAevumConnectStatus() {
    const status = await window.todoAI?.getAevumConnectStatus();
    if (status) setAevumConnectStatus(status);
  }

  async function copyMcpToken() {
    const result = await window.todoAI?.getMcpToken();
    if (!result?.token) return setMcpNotice(t("settings.mcpCopyFailed"));
    await navigator.clipboard.writeText(result.token);
    setMcpNotice(t("settings.mcpTokenCopied"));
  }

  async function regenerateMcpToken() {
    const result = await window.todoAI?.regenerateMcpToken();
    if (!result?.ok) return setMcpNotice(t("settings.mcpRegenerateFailed"));
    setMcpStatus(result.status);
    setMcpNotice(t("settings.mcpTokenRegenerated"));
  }

  async function copyMcpConfig() {
    const endpoint = settings.mcpAuthenticationMode === "oauth"
      ? mcpStatus?.remoteEndpoint ?? `${settings.mcpRemoteUrl.replace(/\/$/, "")}/mcp`
      : mcpStatus?.endpoint ?? `http://127.0.0.1:${settings.mcpPort}/mcp`;
    let config: Record<string, unknown> = { mcpServers: { aevum: { url: endpoint } } };
    if (settings.mcpAuthenticationMode === "bearer") {
      const result = await window.todoAI?.getMcpToken();
      if (!result?.token) return setMcpNotice(t("settings.mcpCopyFailed"));
      config = { mcpServers: { aevum: { url: endpoint, headers: { Authorization: `Bearer ${result.token}` } } } };
    }
    await navigator.clipboard.writeText(JSON.stringify(config, null, 2));
    setMcpNotice(t("settings.mcpConfigCopied"));
  }

  async function copyMcpConnectorUrl() {
    let connectorUrl = settings.mcpConnectionMode === "aevum-connect" ? aevumConnectStatus?.connectorUrl : mcpStatus?.tunnel.connectorUrl ?? mcpStatus?.remoteEndpoint;
    if (settings.mcpConnectionMode === "aevum-connect" && !connectorUrl) {
      const status = await window.todoAI?.updateAevumConnectSettings({
        enabled: settings.mcpEnabled,
        relayOrigin: settings.mcpRelayOrigin,
        accessMode: settings.mcpAccessMode,
        provisionIdentity: true,
      }).catch(() => undefined);
      if (status) setAevumConnectStatus(status);
      connectorUrl = status?.connectorUrl;
    }
    if (!connectorUrl) return setMcpNotice(t("settings.mcpCopyFailed"));
    await navigator.clipboard.writeText(connectorUrl);
    setMcpNotice(t("settings.mcpConnectorCopied"));
  }

  async function resetAevumConnect() {
    const status = await window.todoAI?.resetAevumConnect();
    if (status) setAevumConnectStatus(status);
    setMcpNotice(status?.state === "error" ? "" : t("settings.mcpConnectResetDone"));
  }

  async function refreshAevumConnectClients() {
    const clients = await window.todoAI?.listAevumConnectClients().catch(() => undefined);
    if (clients) setAevumConnectStatus((current) => current ? { ...current, clients } : current);
  }

  async function revokeAevumConnectClient(clientId: string) {
    await window.todoAI?.revokeAevumConnectClient(clientId);
    await refreshAevumConnectClients();
  }

  async function revokeAllAevumConnectClients() {
    await window.todoAI?.revokeAllAevumConnectClients();
    await refreshAevumConnectClients();
  }

  function commitMcpPort() {
    const port = Number(mcpPortDraft);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) {
      setMcpPortDraft(String(settings.mcpPort));
      setMcpNotice(t("settings.mcpInvalidPort"));
      return;
    }
    updateSettings({ mcpPort: port });
  }

  function commitMcpRemoteUrl() {
    const normalized = normalizeMcpPublicOrigin(mcpRemoteUrlDraft);
    if (normalized) {
      setMcpRemoteUrlDraft(normalized);
      updateSettings({ mcpRemoteUrl: normalized });
      setMcpNotice("");
    } else {
      setMcpNotice(t("settings.mcpInvalidRemoteUrl"));
    }
  }

  function updateMcpAccessMode(accessMode: McpAccessMode) {
    const rank: Record<McpAccessMode, number> = { "read-only": 0, proposals: 1, "full-access": 2 };
    const expanded = rank[accessMode] > rank[settings.mcpAccessMode];
    updateSettings({ mcpAccessMode: accessMode });
    setMcpNotice(expanded ? t("settings.mcpReconnectRequired") : t("settings.mcpPermissionsReduced"));
  }

  useEffect(() => {
    setMcpRemoteUrlDraft(settings.mcpRemoteUrl);
  }, [settings.mcpRemoteUrl]);

  useEffect(() => {
    setCustomModel(settings.localModel);
  }, [settings.localModel]);

  useEffect(() => {
    if (!ollamaStatus || !installedModels.length) return;
    if (!settings.localModel || (!selectedModelInstalled && ollamaStatus.status === "connected")) {
      updateSettings({ localModel: installedModels[0].name });
    }
  }, [installedModels, ollamaStatus, selectedModelInstalled, settings.localModel, updateSettings]);

  function handleLanguageChange(nextLanguage: Language) {
    setLanguage(nextLanguage);
    updateSettings({ language: nextLanguage });
  }

  async function refreshOllamaStatus(showLoading = true) {
    if (!window.todoAI) return;
    if (showLoading) setIsRefreshingModels(true);
    try {
      const status = await window.todoAI.checkOllamaStatus(settings.localModel, settings.aiBaseUrl);
      setOllamaStatus(status);
    } finally {
      if (showLoading) setIsRefreshingModels(false);
    }
  }

  async function handleStartOllama() {
    setIsRefreshingModels(true);
    await window.todoAI?.startOllama();
    window.setTimeout(() => void refreshOllamaStatus(true), 1200);
  }

  async function handlePullModel(modelName: string) {
    const safeModelName = modelName.trim();
    if (!safeModelName) return;
    setPullState("loading");
    setInstallingModel(safeModelName);
    setPullMessage(t("settings.installingModel"));
    setPullProgress(null);
    setShowTechnicalDetails(false);
    setModelActionMessage("");
    const result = await window.todoAI?.pullOllamaModel(safeModelName);
    if (!result?.ok) {
      setPullState("error");
      setPullMessage(result?.message ?? t("settings.modelInstallFailed"));
      setInstallingModel("");
      return;
    }
    setPullState("success");
    setInstallingModel("");
    setPullMessage(t("settings.modelInstalled"));
    updateSettings({ localModel: safeModelName });
    await refreshOllamaStatus(false);
  }

  async function handleDeleteModel(modelName: string) {
    setDeletingModel(modelName);
    setModelActionMessage("");
    try {
      const result = await window.todoAI?.deleteOllamaModel(modelName);
      if (!result?.ok) {
        setModelActionMessage(result?.message ?? t("settings.modelDeleteFailed"));
        return;
      }
      setModelActionMessage(t("settings.modelDeleted"));
      if (modelMatches(settings.localModel, modelName)) {
        const nextModel = installedModels.find((model) => !modelMatches(model.name, modelName));
        updateSettings({ localModel: nextModel?.name ?? "qwen3.5:9b" });
      }
      await refreshOllamaStatus(false);
    } finally {
      setDeletingModel("");
      setConfirmAction(null);
    }
  }

  async function refreshOpenRouterKeyStatus() {
    const result = await window.todoAI?.hasOpenRouterApiKey();
    setHasOpenRouterKey(Boolean(result?.hasKey));
    if (result?.hasKey && openRouterStatus === "missing-key") setOpenRouterStatus("idle");
  }

  async function handleSaveOpenRouterKey() {
    const input = openRouterKeyRef.current;
    const value = input?.value.trim() ?? "";
    if (input) input.value = "";
    const result = await window.todoAI?.setOpenRouterApiKey(value);
    if (!result?.ok) {
      setOpenRouterStatus("invalid-key");
      setOpenRouterStatusMessage(result?.message ?? t("settings.openRouterInvalidKey"));
      return;
    }
    setHasOpenRouterKey(true);
    setOpenRouterStatus("connected");
    setOpenRouterStatusMessage("");
  }

  async function handleTestOpenRouter() {
    setOpenRouterStatus("checking");
    const result = await window.todoAI?.testOpenRouterConnection(settings.cloudModel);
    setOpenRouterStatus(result?.ok ? "connected" : mapOpenRouterStatus(result?.status));
    setOpenRouterStatusMessage(result?.ok ? "" : result?.message ?? "");
    await refreshOpenRouterKeyStatus();
  }

  async function handleDeleteOpenRouterKey() {
    await window.todoAI?.deleteOpenRouterApiKey();
    setHasOpenRouterKey(false);
    setOpenRouterStatus("missing-key");
    setOpenRouterStatusMessage("");
  }

  async function refreshTelegramStatus() {
    const status = await window.todoAI?.getTelegramStatus();
    if (status) setTelegramStatus(status);
  }

  async function handleTelegramToggle(enabled: boolean) {
    updateSettings({ telegramAssistantEnabled: enabled });
    const status = await window.todoAI?.updateTelegramSettings({
      enabled,
      language: settings.language,
      useDefaultAI: settings.telegramUseDefaultAI,
      aiProvider: settings.telegramAIProvider,
      localModel: settings.telegramLocalModel,
      cloudModel: settings.telegramCloudModel,
    });
    if (status) setTelegramStatus(status);
  }

  async function handleConnectTelegram() {
    const input = telegramTokenRef.current;
    const token = input?.value.trim() ?? "";
    if (input) input.value = "";
    setTelegramConnecting(true);
    setTelegramNotice("");
    try {
      const result = await window.todoAI?.setTelegramBotToken(token);
      if (result) setTelegramStatus(result);
      if (!result?.ok) setTelegramNotice(result?.message ?? t("settings.telegramInvalidToken"));
      else updateSettings({ telegramAssistantEnabled: true });
    } finally {
      setTelegramConnecting(false);
    }
  }

  async function handleDisconnectTelegram() {
    const result = await window.todoAI?.disconnectTelegramBot();
    if (result) setTelegramStatus(result);
    updateSettings({ telegramAssistantEnabled: false });
    setTelegramNotice("");
  }

  async function handleUnpairTelegram() {
    const result = await window.todoAI?.unpairTelegramChat();
    if (result) setTelegramStatus(result);
  }

  async function handleReconnectTelegramPolling() {
    const result = await window.todoAI?.reconnectTelegramPolling();
    if (result) setTelegramStatus(result);
    if (!result?.ok) setTelegramNotice(result?.message ?? t("settings.telegramPollingError"));
  }

  function addAvailabilityBlock() {
    const label = scheduleDraft.label.trim() || t("settings.unavailable");
    if (!scheduleDraft.weekdays.length || scheduleDraft.startTime >= scheduleDraft.endTime) return;
    const block: AvailabilityBlock = {
      id: createAvailabilityId(),
      label,
      weekdays: scheduleDraft.weekdays,
      startTime: scheduleDraft.startTime,
      endTime: scheduleDraft.endTime,
    };
    updateSettings({ availabilityBlocks: [...settings.availabilityBlocks, block] });
    setScheduleDraft({ label: "", weekdays: [1, 2, 3, 4, 5], startTime: "09:00", endTime: "17:00" });
  }

  function deleteAvailabilityBlock(id: string) {
    updateSettings({ availabilityBlocks: settings.availabilityBlocks.filter((block) => block.id !== id) });
  }

  function toggleScheduleWeekday(day: number) {
    setScheduleDraft((current) => ({
      ...current,
      weekdays: current.weekdays.includes(day)
        ? current.weekdays.filter((item) => item !== day)
        : [...current.weekdays, day].sort((a, b) => a - b),
    }));
  }

  async function handleTestNotification() {
    const result = await window.todoAI?.showTestNotification();
    setNotificationStatus(result?.ok ? t("settings.testNotificationSent") : t("settings.testNotificationFailed"));
  }

  async function handleCheckForUpdates() {
    setIsCheckingUpdates(true);
    try {
      const result = await window.todoAI?.checkForUpdates();
      if (result) setUpdateStatus(result);
    } catch {
      setUpdateStatus({ status: "error", message: t("settings.updateCheckFailed") });
    } finally {
      setIsCheckingUpdates(false);
    }
  }

  async function handleDownloadUpdate() {
    const result = await window.todoAI?.downloadUpdate();
    if (result) setUpdateStatus(result);
  }

  async function handleClearCache() {
    setCacheStatus("loading");
    try {
      window.localStorage.removeItem("todo-ai-model-list-cache");
      await window.todoAI?.clearAppCache();
      setCacheStatus("success");
      setStorageNotice(t("settings.cacheCleared"));
    } catch (error) {
      console.error("[Aevum] Failed to clear app cache", error);
      setCacheStatus("error");
    } finally {
      setConfirmAction(null);
    }
  }

  function handleClearHistory() {
    clearAiHistory();
    setConfirmAction(null);
    setCacheStatus("success");
    setStorageNotice(t("assistant.historyCleared"));
  }

  const aiStatusText = useMemo(() => {
    if (!window.todoAI) return t("settings.desktopBridgeUnavailable");
    if (!ollamaStatus) return t("settings.checkingOllama");
    if (ollamaStatus.status === "connected") return t("settings.connected");
    if (ollamaStatus.status === "model-missing") return t("settings.modelMissing");
    if (ollamaStatus.status === "not-installed") return t("settings.notInstalled");
    return t("settings.notRunning");
  }, [ollamaStatus, t]);

  const aiStatusTone = ollamaStatus?.status === "connected" ? "connected" : ollamaStatus?.status === "not-installed" ? "not-installed" : ollamaStatus?.status === "model-missing" ? "model-missing" : "not-connected";

  return (
    <div className="settings-page">
      <SettingsSection icon={Monitor} title={t("settings.appearance")}>
        <div className="segmented-control">
          {[
            { value: "dark", label: t("settings.dark"), icon: Moon },
            { value: "light", label: t("settings.light"), icon: Sun },
            { value: "system", label: t("settings.system"), icon: Monitor },
          ].map((option) => {
            const Icon = option.icon;
            return (
              <button
                className={settings.theme === option.value ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
                key={option.value}
                onClick={() => updateSettings({ theme: option.value as ThemeMode })}
                type="button"
              >
                <Icon size={14} />
                {option.label}
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection icon={Languages} title={t("settings.language")}>
        <div className="segmented-control">
          {[
            { value: "en", label: "English" },
            { value: "ru", label: "Русский" },
          ].map((option) => (
            <button
              className={language === option.value ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
              key={option.value}
              onClick={() => handleLanguageChange(option.value as Language)}
              type="button"
            >
              {option.label}
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection icon={Clock3} title={t("settings.timeFormat")}>
        <div className="segmented-control">
          {[
            { value: "24h", label: t("settings.timeFormat24"), meta: "18:30" },
            { value: "12h", label: t("settings.timeFormat12"), meta: "6:30 PM" },
          ].map((option) => (
            <button
              className={settings.timeFormat === option.value ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
              key={option.value}
              onClick={() => updateSettings({ timeFormat: option.value as TimeFormat })}
              type="button"
            >
              <Clock3 size={14} />
              <span>{option.label}</span>
              <small className="meta-text">{option.meta}</small>
            </button>
          ))}
        </div>
      </SettingsSection>

      <SettingsSection icon={Server} title={t("settings.mcpTitle")} description={t("settings.mcpDescription")}>
        <div className="mcp-settings-card">
          <div className="mcp-settings-heading">
            <label className="toggle-row toggle-row--compact">
              <span>
                <strong>{t("settings.mcpEnable")}</strong>
                <small>{settings.mcpConnectionMode === "aevum-connect" ? t("settings.mcpConnectDescription") : t("settings.mcpQuickTunnelTemporary")}</small>
              </span>
              <input checked={settings.mcpEnabled} onChange={(event) => updateSettings({ mcpEnabled: event.target.checked })} type="checkbox" />
            </label>
            <span className={`status-pill status-pill--${settings.mcpConnectionMode === "aevum-connect" ? aevumConnectStatusTone(aevumConnectStatus?.state) : mcpStatusTone(mcpStatus?.status)}`}>
              {settings.mcpConnectionMode === "aevum-connect" ? formatAevumConnectStatus(aevumConnectStatus?.state, t) : formatMcpStatus(mcpStatus?.status, t)}
            </span>
          </div>
          <div className="mcp-settings-grid">
            <label className="field-row">
              <span>{t("settings.mcpConnectionMode")}</span>
              <select value={settings.mcpConnectionMode} onChange={(event) => updateSettings({ mcpConnectionMode: event.target.value as McpConnectionMode })}>
                <option value="aevum-connect">{t("settings.mcpAevumConnect")}</option>
                <option value="quick-tunnel">{t("settings.mcpQuickTunnel")}</option>
              </select>
            </label>
            <label className="field-row">
              <span>{t("settings.mcpAccessMode")}</span>
              <select value={settings.mcpAccessMode} onChange={(event) => updateMcpAccessMode(event.target.value as McpAccessMode)}>
                <option value="read-only">{t("settings.mcpReadOnly")}</option>
                <option value="proposals">{t("settings.mcpProposalsOnly")}</option>
                <option value="full-access">{t("settings.mcpFullAccess")}</option>
              </select>
            </label>
            {settings.mcpConnectionMode === "quick-tunnel" ? <label className="field-row">
              <span>{t("settings.mcpPort")}</span>
              <input type="number" min={1024} max={65535} value={mcpPortDraft} onChange={(event) => setMcpPortDraft(event.target.value)} onBlur={commitMcpPort} />
            </label> : null}
          </div>
          {settings.mcpConnectionMode === "quick-tunnel" ? (
            <p className="mcp-temporary-note"><Clock3 size={13} />{t("settings.mcpQuickTunnelTemporary")}</p>
          ) : null}
          {settings.mcpConnectionMode === "quick-tunnel" ? <div className="mcp-endpoint-list">
              <>
                <div><span>{t("settings.mcpTunnelStatus")}</span><span className={`status-pill status-pill--${mcpTunnelStatusTone(mcpStatus?.tunnel.state, "temporary", Boolean(mcpStatus?.remoteEndpoint))}`}>{formatMcpTunnelStatus(mcpStatus?.tunnel.state, t, "temporary", Boolean(mcpStatus?.remoteEndpoint))}</span></div>
                <div><span>{t("settings.mcpConnectorUrl")}</span><code>{mcpStatus?.tunnel.connectorUrl ?? mcpStatus?.remoteEndpoint ?? t("settings.mcpRemoteEndpointPending")}</code></div>
              </>
          </div> : null}
        </div>
        <div className="data-actions">
          <button className="button button--secondary" onClick={() => void copyMcpConnectorUrl()} type="button">
            <Copy size={14} />
            {t("settings.mcpCopyConnectorUrl")}
          </button>
          {settings.mcpConnectionMode === "aevum-connect" ? <button className="button button--secondary" onClick={() => void resetAevumConnect()} type="button">
            <RotateCcw size={14} />
            {t("settings.mcpResetPersonalUrl")}
          </button> : null}
        </div>
        {settings.mcpConnectionMode === "aevum-connect" ? <details className="mcp-security-details" onToggle={(event) => { if (event.currentTarget.open) void refreshAevumConnectClients(); }}>
          <summary><KeyRound size={15} />{t("settings.mcpConnectedClients")}</summary>
          <div>
            {(aevumConnectStatus?.clients ?? []).length ? (aevumConnectStatus?.clients ?? []).map((client) => <div className="mcp-client-row" key={client.clientId}>
              <span><strong>{client.name}</strong><small>{client.scopes.join(" ")}{client.lastUsedAt ? ` · ${t("settings.mcpLastUsed")}: ${client.lastUsedAt}` : ""}</small></span>
              <button className="button button--secondary" onClick={() => void revokeAevumConnectClient(client.clientId)} type="button">{t("settings.mcpRevokeClient")}</button>
            </div>) : <p>{t("settings.mcpNoConnectedClients")}</p>}
            {(aevumConnectStatus?.clients ?? []).length ? <button className="button button--secondary" onClick={() => void revokeAllAevumConnectClients()} type="button">{t("settings.mcpRevokeAll")}</button> : null}
          </div>
        </details> : null}
        {settings.mcpConnectionMode === "aevum-connect" ? <details className="mcp-security-details">
          <summary><Info size={15} />{t("settings.mcpConnectDiagnostics")}</summary>
          <dl className="mcp-diagnostics">
            <div><dt>{t("settings.mcpDevicePreview")}</dt><dd>{aevumConnectStatus?.devicePublicIdPreview || "—"}</dd></div>
            <div><dt>{t("settings.mcpStatus")}</dt><dd>{formatAevumConnectStatus(aevumConnectStatus?.state, t)}</dd></div>
            <div><dt>{t("settings.mcpLastReconnectReason")}</dt><dd>{aevumConnectStatus?.lastReconnectReason || "—"}</dd></div>
            <div><dt>{t("settings.mcpLastSafeError")}</dt><dd>{aevumConnectStatus?.lastSafeError || "—"}</dd></div>
            <div><dt>{t("settings.mcpLastConnectedAt")}</dt><dd>{aevumConnectStatus?.lastConnectedAt || "—"}</dd></div>
            <div><dt>{t("settings.mcpOAuthStage")}</dt><dd>{aevumConnectStatus?.oauthDiagnostics?.lastOAuthStage || "—"}</dd></div>
            <div><dt>{t("settings.mcpLastOAuthError")}</dt><dd>{aevumConnectStatus?.oauthDiagnostics?.lastTokenError || "—"}</dd></div>
            <div><dt>{t("settings.mcpGrantedScopes")}</dt><dd>{(aevumConnectStatus?.clients ?? []).flatMap((client) => client.scopes).filter((scope, index, all) => all.indexOf(scope) === index).join(" ") || t("settings.mcpNoActiveGrant")}</dd></div>
            <div><dt>{t("settings.mcpPersistentGrant")}</dt><dd>{aevumConnectStatus?.oauthDiagnostics?.persistentGrantExists ? t("settings.mcpYes") : t("settings.mcpNo")}</dd></div>
            <div><dt>{t("settings.mcpLastRefreshStatus")}</dt><dd>{aevumConnectStatus?.oauthDiagnostics?.refreshRotationSuccess === undefined ? "—" : aevumConnectStatus.oauthDiagnostics.refreshRotationSuccess ? t("settings.mcpRefreshSucceeded") : t("settings.mcpRefreshFailed")}</dd></div>
          </dl>
        </details> : null}
        <details className="mcp-security-details">
          <summary><ShieldCheck size={15} />{t("settings.mcpSecurityDetails")}</summary>
          <div>
            <p>{t("settings.mcpWarning")}</p>
            {settings.mcpAuthenticationMode === "oauth" ? <p>{t("settings.mcpOAuthWarning")}</p> : null}
            <p>{settings.mcpAccessMode === "read-only" ? t("settings.mcpReadOnlyHint") : t("settings.mcpConfirmationPolicy")}</p>
            <dl className="mcp-diagnostics">
              <div><dt>{t("settings.mcpSelectedMode")}</dt><dd>{formatMcpAccessMode(mcpStatus?.toolAccess.selectedMode ?? settings.mcpAccessMode, t)}</dd></div>
              <div><dt>{t("settings.mcpGrantedScopes")}</dt><dd>{mcpStatus?.toolAccess.grantedScopes.join(" ") || t("settings.mcpNoActiveGrant")}</dd></div>
              <div><dt>{t("settings.mcpRegisteredClients")}</dt><dd>{mcpStatus?.toolAccess.registeredClientCount ?? 0}</dd></div>
              <div><dt>{t("settings.mcpActiveGrants")}</dt><dd>{mcpStatus?.toolAccess.activeGrantCount ?? 0}</dd></div>
              <div><dt>{t("settings.mcpWriteToolsExposed")}</dt><dd>{mcpStatus?.toolAccess.writeToolsExposed ? t("settings.mcpYes") : t("settings.mcpNo")}</dd></div>
              <div><dt>{t("settings.mcpLastToolListMode")}</dt><dd>{mcpStatus?.toolAccess.lastToolListMode ? formatMcpAccessMode(mcpStatus.toolAccess.lastToolListMode, t) : t("settings.mcpNotRequested")}</dd></div>
            </dl>
            {settings.mcpAuthenticationMode === "oauth" ? <p>{t("settings.mcpOAuthStage")}: {formatMcpOAuthStage(mcpStatus?.oauth.currentStage, t)} · {t("settings.mcpOAuthSessions")}: {mcpStatus?.oauth.activeSessionCount ?? 0}</p> : null}
          </div>
        </details>
        {mcpStatus?.oauth.lastError ? <p className="settings-error">{t("settings.mcpLastOAuthError")}: {mcpStatus.oauth.lastError}</p> : null}
        {mcpStatus?.toolAccess.lastToolError ? <p className="settings-error">{t("settings.mcpLastToolError")}: {mcpStatus.toolAccess.lastToolError}</p> : null}
        {mcpStatus?.tunnel.error ? <p className="settings-error">{mcpStatus.tunnel.state === "missing" ? t("settings.mcpCloudflaredMissing") : mcpStatus.tunnel.error}</p> : null}
        {settings.mcpConnectionMode === "aevum-connect" && aevumConnectStatus?.message ? <p className="settings-error">{aevumConnectStatus.message}</p> : null}
        {settings.mcpAccessMode === "read-only" ? <p className="settings-helper-inline">{t("settings.mcpReadOnlyHint")}</p> : null}
        {mcpNotice ? <p className="settings-success">{mcpNotice}</p> : null}
        {mcpStatus?.message ? <p className="settings-error">{mcpStatus.message}</p> : null}
      </SettingsSection>

      <SettingsSection
        icon={Cpu}
        title={t("settings.aiModels")}
        description={t("settings.aiSetupDescription")}
        help={
          settings.aiProvider === "openrouter" ? (
            <SettingsHelpPopover
              ariaLabel={t("settings.help.openRouter.aria")}
              title={t("settings.help.openRouter.title")}
              links={[{ label: t("settings.help.openRouter.link"), url: "https://openrouter.ai/settings/keys" }]}
            >
              <p>{t("settings.help.openRouter.body1")}</p>
              <p>{t("settings.help.openRouter.body2")}</p>
              <p>{t("settings.help.openRouter.body3")}</p>
            </SettingsHelpPopover>
          ) : (
            <SettingsHelpPopover
              ariaLabel={t("settings.help.ollama.aria")}
              title={t("settings.help.ollama.title")}
            >
              <p>{t("settings.help.ollama.body1")}</p>
              <p>{t("settings.help.ollama.body2")}</p>
              <p>{t("settings.help.ollama.body3")}</p>
            </SettingsHelpPopover>
          )
        }
      >
        <div className="segmented-control segmented-control-spacing">
          {[
            { value: "ollama", label: t("settings.localAI"), icon: Cpu },
            { value: "openrouter", label: t("settings.cloudAI"), icon: KeyRound },
          ].map((option) => {
            const Icon = option.icon;
            return (
              <button
                className={settings.aiProvider === option.value ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
                key={option.value}
                onClick={() => updateSettings({ aiProvider: option.value as AIProvider })}
                type="button"
              >
                <Icon size={14} />
                {option.label}
              </button>
            );
          })}
        </div>

        {settings.aiProvider === "openrouter" ? (
          <div className="advanced-settings">
            <div className="field-row">
              <span>{t("task.sort.status")}</span>
              <span className={`status-pill status-pill--${openRouterStatus === "connected" ? "connected" : "model-missing"}`}>
                {formatOpenRouterStatus(openRouterStatus, hasOpenRouterKey, t)}
              </span>
            </div>
            <label className="field-row">
              <span>{t("settings.cloudModel")}</span>
              <select value={settings.cloudModel} onChange={(event) => updateSettings({ cloudModel: event.target.value })}>
                {openRouterModelOptions.map((option) => (
                  <option key={option.id} value={option.id}>
                    {t(option.labelKey)}{option.recommended ? ` (${t("settings.recommended")})` : ""}
                  </option>
                ))}
              </select>
            </label>
            <p className="settings-helper-inline helper-margin-top">
              {t(openRouterModelOptions.find((option) => option.id === settings.cloudModel)?.descriptionKey ?? "settings.openRouterAutoFreeModelDescription")}
            </p>
            <p className="settings-helper-inline helper-margin-bottom">{t("settings.openRouterFreeModelNote")}</p>
            <label className="field-row">
              <span className="settings-label-with-help">
                {t("settings.openRouterApiKey")}
                <SettingsHelpPopover
                  ariaLabel={t("settings.help.openRouterKey.aria")}
                  title={t("settings.help.openRouterKey.title")}
                  links={[{ label: t("settings.help.openRouter.link"), url: "https://openrouter.ai/settings/keys" }]}
                >
                  <p>{t("settings.help.openRouterKey.body1")}</p>
                  <p>{t("settings.help.openRouterKey.body2")}</p>
                </SettingsHelpPopover>
              </span>
              <input ref={openRouterKeyRef} type="password" placeholder="sk-or-v1-..." autoComplete="off" />
            </label>
            <div className="ai-settings-actions">
              <button className="button button--primary" onClick={() => void handleSaveOpenRouterKey()} type="button">
                <KeyRound size={14} />
                {t("settings.saveApiKey")}
              </button>
              <button className="button button--secondary" disabled={!hasOpenRouterKey || openRouterStatus === "checking"} onClick={() => void handleTestOpenRouter()} type="button">
                {openRouterStatus === "checking" ? <Loader2 size={14} className="spin-icon" /> : <Check size={14} />}
                {t("settings.testConnection")}
              </button>
              <button className="button button--danger" disabled={!hasOpenRouterKey} onClick={() => void handleDeleteOpenRouterKey()} type="button">
                <Trash2 size={14} />
                {t("settings.removeApiKey")}
              </button>
            </div>
            {openRouterStatusMessage ? <p className="settings-helper-inline">{openRouterStatusMessage}</p> : null}
          </div>
        ) : null}

        {settings.aiProvider === "ollama" ? (
          <>
            <div className="field-row">
              <span>{t("task.sort.status")}</span>
              <div className="status-row-actions">
                <span className={`status-pill status-pill--${aiStatusTone}`}>{aiStatusText}</span>
                <button className="button button--secondary" disabled={isRefreshingModels} onClick={() => void refreshOllamaStatus()} type="button">
                  {isRefreshingModels ? <Loader2 size={14} className="spin-icon" /> : <RefreshCw size={14} />}
                  {t("settings.refreshModels")}
                </button>
              </div>
            </div>

            {ollamaStatus?.status === "not-installed" ? (
              <SetupCallout
                icon={<Download size={15} />}
                title={t("settings.ollamaMissingTitle")}
                description={t("settings.ollamaMissingDescription")}
                action={
                  <button className="button button--primary" onClick={() => void window.todoAI?.openOllamaDownload()} type="button">
                    <ExternalLink size={14} />
                    {t("settings.installOllama")}
                  </button>
                }
              />
            ) : null}

            {ollamaStatus?.status === "not-running" ? (
              <SetupCallout
                icon={<AlertTriangle size={15} />}
                title={t("settings.ollamaNotRunningTitle")}
                description={t("settings.ollamaNotRunningDescription")}
                action={
                  <button className="button button--primary" onClick={() => void handleStartOllama()} type="button">
                    <PackageCheck size={14} />
                    {t("settings.startOllama")}
                  </button>
                }
              />
            ) : null}

            <label className="field-row">
              <span>{t("settings.installedModel")}</span>
              <select
                disabled={!installedModels.length}
                value={installedModels.some((model) => model.name === settings.localModel) ? settings.localModel : ""}
                onChange={(event) => updateSettings({ localModel: event.target.value })}
              >
                {installedModels.length ? null : <option value="">{t("settings.noModels")}</option>}
                {installedModels.map((model) => (
                  <option key={model.name} value={model.name}>
                    {model.name}
                  </option>
                ))}
              </select>
            </label>

            {missingSelectedModel ? (
              <div className="settings-warning warning-margin-top">
                <AlertTriangle size={14} />
                <span>{t("settings.missingModelWarning")}</span>
              </div>
            ) : null}

            {installedModels.length ? (
              <div className="installed-model-list">
                {installedModels.map((model) => {
                  const selected = modelMatches(settings.localModel, model.name);
                  const deleting = deletingModel === model.name;
                  return (
                    <article className="installed-model" key={model.name}>
                      <div>
                        <strong>{model.name}</strong>
                        {model.size ? <span>{formatBytes(model.size)}</span> : null}
                      </div>
                      <div className="model-row-actions">
                        <button className="button button--secondary" disabled={selected} onClick={() => updateSettings({ localModel: model.name })} type="button">
                          <Check size={14} />
                          {selected ? t("settings.selected") : t("settings.useModel")}
                        </button>
                        <button className="button button--delete-model" disabled={deleting} onClick={() => setConfirmAction({ type: "delete-model", modelName: model.name })} type="button">
                          {deleting ? <Loader2 size={14} className="spin-icon" /> : <Trash2 size={14} />}
                          {t("settings.deleteModel")}
                        </button>
                      </div>
                    </article>
                  );
                })}
              </div>
            ) : null}

            {modelActionMessage ? <p className={modelActionMessage === t("settings.modelDeleted") ? "settings-success" : "settings-error"}>{modelActionMessage}</p> : null}

            <div className="recommended-models">
              <div>
                <strong>{t("settings.recommendedModels")}</strong>
                <p>{t("settings.recommendedModelsDescription")}</p>
              </div>
              <div className="smart-model-list">
                {recommendedModelsJson.recommendedModels.map((model) => {
                  const pullName = model.name;
                  const installed = installedModels.some((installedModel) => modelMatches(installedModel.name, pullName));
                  const selected = modelMatches(settings.localModel, pullName);
                  const isInstallingThis = pullState === "loading" && installingModel === pullName;
                  return (
                    <article className="smart-model" key={model.name}>
                      <div className="smart-model-desc-col">
                        <div className="smart-model__header">
                          <strong>{model.label}</strong>
                          <span className="model-tag">{model.name}</span>
                          {model.recommended ? <span className="status-pill status-pill--connected status-pill--recommended-tag">{t("settings.recommended")}</span> : null}
                          {model.isRussianRecommended && language === "ru" ? <span className="status-pill status-pill--ru-tag">RU</span> : null}
                          {model.isExperimental ? <span className="status-pill status-pill--experimental-tag">{language === "ru" ? "Экспериментально" : "Experimental"}</span> : null}
                          {selected ? <span className="status-pill status-pill--connected status-pill--compact">{t("settings.selected")}</span> : installed ? <span className="status-pill status-pill--compact">{t("settings.installed")}</span> : null}
                        </div>
                        <p>
                          {t(model.descriptionKey as any)}
                        </p>
                      </div>
                      {!installed && (
                        <button
                          className="button button--secondary"
                          disabled={pullState === "loading" || ollamaStatus?.status === "not-installed"}
                          onClick={() => void handlePullModel(pullName)}
                          type="button"
                        >
                          {isInstallingThis ? <Loader2 size={14} className="spin-icon" /> : <Download size={14} />}
                          {t("settings.installModel")}
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>

            {pullState !== "idle" ? (
              <div className={`install-progress install-progress--${pullState}`}>
                <div className="install-progress__header">
                  {pullState === "success" ? <CheckCircle2 size={14} /> : pullState === "error" ? <AlertTriangle size={14} /> : <Loader2 size={14} className="spin-icon" />}
                  <div>
                    <span>{pullState === "success" ? t("settings.modelInstalled") : pullState === "error" ? t("settings.modelInstallFailed") : t("settings.installingModel")}</span>
                    <small>{installingModel || pullProgress?.modelName || settings.localModel}</small>
                  </div>
                </div>
                <ProgressText payload={pullProgress} fallback={pullMessage} t={t} />
                <div className="install-progress__actions">
                  {pullProgress?.details ? (
                    <button className="text-button" onClick={() => setShowTechnicalDetails((value) => !value)} type="button">
                      {showTechnicalDetails ? t("settings.hideTechnicalDetails") : t("settings.showTechnicalDetails")}
                    </button>
                  ) : null}
                  {pullState === "loading" ? (
                    <button className="button button--secondary" onClick={() => void window.todoAI?.cancelOllamaPull()} type="button">
                      {t("settings.cancel")}
                    </button>
                  ) : (
                    <button className="button button--secondary" onClick={() => setPullState("idle")} type="button">
                      {t("settings.close")}
                    </button>
                  )}
                </div>
                {showTechnicalDetails && pullProgress?.details ? <pre className="install-progress__details">{pullProgress.details}</pre> : null}
              </div>
            ) : null}

            <div className="advanced-toggle-spacing">
              <button className="text-button" onClick={() => setShowAdvancedAI((value) => !value)} type="button">
                {showAdvancedAI ? t("settings.hideAdvanced") : t("settings.showAdvanced")}
              </button>
            </div>

            {showAdvancedAI ? (
              <div className="advanced-settings">
                <label className="field-row">
                  <span className="settings-label-with-help">
                    {t("settings.baseUrl")}
                    <SettingsHelpPopover
                      ariaLabel={t("settings.help.baseUrl.aria")}
                      title={t("settings.help.baseUrl.title")}
                    >
                      <p>{t("settings.help.baseUrl.body1")}</p>
                      <p>{t("settings.help.baseUrl.body2")}</p>
                    </SettingsHelpPopover>
                  </span>
                  <input value={settings.aiBaseUrl} onChange={(event) => updateSettings({ aiBaseUrl: event.target.value })} placeholder="http://localhost:11434" />
                </label>
                <label className="field-row">
                  <span className="settings-label-with-help">
                    {t("settings.customModel")}
                    <SettingsHelpPopover
                      ariaLabel={t("settings.help.customModel.aria")}
                      title={t("settings.help.customModel.title")}
                    >
                      <p>{t("settings.help.customModel.body1")}</p>
                      <p>{t("settings.help.customModel.body2")}</p>
                    </SettingsHelpPopover>
                  </span>
                  <input value={customModel} onChange={(event) => setCustomModel(event.target.value)} placeholder="qwen3.5:9b" />
                </label>
                <div className="advanced-settings-actions">
                  <button className="button button--secondary" onClick={() => updateSettings({ localModel: customModel.trim() || settings.localModel })} type="button">
                    {t("settings.useCustomModel")}
                  </button>
                </div>
              </div>
            ) : null}
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection
        icon={Send}
        title={t("settings.telegramAssistant")}
        description={t("settings.telegramAssistantDescription")}
        help={
          <SettingsHelpPopover
            ariaLabel={t("settings.help.telegram.aria")}
            title={t("settings.help.telegram.title")}
            links={[{ label: t("settings.help.telegram.link"), url: "https://t.me/BotFather" }]}
          >
            <p>{t("settings.help.telegram.body1")}</p>
            <p>{t("settings.help.telegram.body2")}</p>
            <p>{t("settings.help.telegram.body3")}</p>
          </SettingsHelpPopover>
        }
      >
        <label className="toggle-row">
          <span>
            <strong>{t("settings.telegramEnable")}</strong>
            <small>{t("settings.telegramRunNote")}</small>
          </span>
          <input checked={settings.telegramAssistantEnabled} onChange={(event) => void handleTelegramToggle(event.target.checked)} type="checkbox" />
        </label>

        <div className="field-row">
          <span>{t("task.sort.status")}</span>
          <div className="status-row-actions">
            <span className={`status-pill status-pill--${telegramStatusTone(telegramStatus?.status)}`}>
              {formatTelegramStatus(telegramStatus?.status, t)}
            </span>
            <button className="button button--secondary" onClick={() => void refreshTelegramStatus()} type="button">
              <RefreshCw size={14} />
              {t("settings.refreshModels")}
            </button>
          </div>
        </div>

        <div className="advanced-settings telegram-settings-panel">
          <label className="field-row">
            <span>{t("settings.telegramBotToken")}</span>
            <input ref={telegramTokenRef} type="password" placeholder="123456789:AA..." autoComplete="off" />
          </label>
          <div className="ai-settings-actions">
            <button className="button button--primary" disabled={telegramConnecting} onClick={() => void handleConnectTelegram()} type="button">
              {telegramConnecting ? <Loader2 size={14} className="spin-icon" /> : <KeyRound size={14} />}
              {t("settings.telegramConnect")}
            </button>
            <button className="button button--secondary" disabled={!telegramStatus?.hasToken} onClick={() => void handleDisconnectTelegram()} type="button">
              <Trash2 size={14} />
              {t("settings.telegramDisconnect")}
            </button>
          </div>
        </div>

        {telegramStatus?.status === "webhook-conflict" ? (
          <SetupCallout
            icon={<AlertTriangle size={15} />}
            title={t("settings.telegramWebhookConflict")}
            description={t("settings.telegramWebhookConflictDescription")}
            action={
              <button className="button button--primary" onClick={() => void handleReconnectTelegramPolling()} type="button">
                <RefreshCw size={14} />
                {t("settings.telegramReconnectPolling")}
              </button>
            }
          />
        ) : null}

        {telegramStatus?.hasToken && !telegramStatus.pairedChat ? (
          <div className="telegram-pairing-panel">
            <div>
              <strong>{t("settings.telegramPairingCode")}</strong>
              <p>{t("settings.telegramPairingDescription")}</p>
            </div>
            <code>{telegramStatus.pairingCode ?? "------"}</code>
          </div>
        ) : null}

        {telegramStatus?.pairedChat ? (
          <div className="setup-callout setup-callout--compact">
            <span className="setup-callout__icon"><CheckCircle2 size={15} /></span>
            <div className="callout-text-wrapper">
              <strong>{t("settings.telegramPaired")}</strong>
              <p>{formatTelegramChat(telegramStatus.pairedChat)}</p>
            </div>
            <button className="button button--secondary" onClick={() => void handleUnpairTelegram()} type="button">
              {t("settings.telegramUnpair")}
            </button>
          </div>
        ) : null}

        {telegramStatus?.pairedChat ? (
          <div className="field-row">
            <span>{t("settings.telegramCurrentMode")}</span>
            <span className="status-pill status-pill--neutral">
              {telegramStatus.interactionMode === "ai" ? t("settings.telegramAIMode") : t("settings.telegramTemplateMode")}
            </span>
          </div>
        ) : null}

        <label className="toggle-row">
          <span>
            <strong>{t("settings.telegramUseDefaultAI")}</strong>
            <small>{t("settings.telegramUseDefaultAIDescription")}</small>
          </span>
          <input checked={settings.telegramUseDefaultAI} onChange={(event) => updateSettings({ telegramUseDefaultAI: event.target.checked })} type="checkbox" />
        </label>

        {!settings.telegramUseDefaultAI ? (
          <div className="advanced-settings">
            <div className="segmented-control segmented-control-spacing">
              {[
                { value: "ollama", label: t("settings.localAI"), icon: Cpu },
                { value: "openrouter", label: t("settings.cloudAI"), icon: KeyRound },
              ].map((option) => {
                const Icon = option.icon;
                return (
                  <button
                    className={settings.telegramAIProvider === option.value ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"}
                    key={option.value}
                    onClick={() => updateSettings({ telegramAIProvider: option.value as AIProvider })}
                    type="button"
                  >
                    <Icon size={14} />
                    {option.label}
                  </button>
                );
              })}
            </div>
            {settings.telegramAIProvider === "ollama" ? (
              <label className="field-row">
                <span>{t("settings.localModel")}</span>
                <select
                  value={installedModels.some((model) => model.name === settings.telegramLocalModel) ? settings.telegramLocalModel : settings.localModel}
                  onChange={(event) => updateSettings({ telegramLocalModel: event.target.value })}
                >
                  {installedModels.length ? null : <option value={settings.localModel}>{settings.localModel}</option>}
                  {installedModels.map((model) => (
                    <option key={model.name} value={model.name}>{model.name}</option>
                  ))}
                </select>
              </label>
            ) : (
              <label className="field-row">
                <span>{t("settings.cloudModel")}</span>
                <select value={settings.telegramCloudModel} onChange={(event) => updateSettings({ telegramCloudModel: event.target.value })}>
                  {openRouterModelOptions.map((option) => (
                    <option key={option.id} value={option.id}>{t(option.labelKey)}</option>
                  ))}
                </select>
              </label>
            )}
          </div>
        ) : null}

        <p className="settings-helper-inline">{t("settings.telegramSecurityNote")}</p>
        {telegramNotice || telegramStatus?.message ? <p className="settings-error">{telegramNotice || telegramStatus?.message}</p> : null}
      </SettingsSection>

      <SettingsSection
        icon={CalendarClock}
        title={t("settings.schedule")}
        description={t("settings.scheduleDescription")}
        help={
          <SettingsHelpPopover
            ariaLabel={t("settings.help.schedule.aria")}
            title={t("settings.help.schedule.title")}
          >
            <p>{t("settings.help.schedule.body1")}</p>
            <p>{t("settings.help.schedule.body2")}</p>
          </SettingsHelpPopover>
        }
      >
        <div className="availability-editor">
          <div className="availability-editor__field">
            <span>{t("task.title")}</span>
            <input
              className="availability-editor__input"
              value={scheduleDraft.label}
              onChange={(event) => setScheduleDraft((current) => ({ ...current, label: event.target.value }))}
              placeholder={t("settings.scheduleLabelPlaceholder")}
            />
          </div>

          <div className="availability-editor__weekdays">
            <span className="availability-editor__label-text">{t("settings.scheduleDays")}</span>
            <div className="weekday-picker">
              {weekdayNumbers.map((day) => (
                <button
                  className={`weekday-chip ${scheduleDraft.weekdays.includes(day) ? "weekday-chip--active" : ""}`}
                  key={day}
                  onClick={() => toggleScheduleWeekday(day)}
                  type="button"
                >
                  {getWeekdayShort(day, t)}
                </button>
              ))}
            </div>
          </div>

          <div className="availability-editor__times">
            <label className="availability-editor__time-field">
              <span>{t("settings.scheduleStart")}</span>
              <input
                value={scheduleDraft.startTime}
                onChange={(event) => setScheduleDraft((current) => ({ ...current, startTime: event.target.value }))}
                type="time"
              />
            </label>
            <label className="availability-editor__time-field">
              <span>{t("settings.scheduleEnd")}</span>
              <input
                value={scheduleDraft.endTime}
                onChange={(event) => setScheduleDraft((current) => ({ ...current, endTime: event.target.value }))}
                type="time"
              />
            </label>
          </div>

          <div className="schedule-editor-actions">
            <button
              className="button button--primary availability-editor__add-btn"
              disabled={!scheduleDraft.weekdays.length || scheduleDraft.startTime >= scheduleDraft.endTime}
              onClick={addAvailabilityBlock}
              type="button"
            >
              {t("settings.addUnavailableBlock")}
            </button>
          </div>
        </div>
        <div className="installed-model-list list-margin-top">
          {settings.availabilityBlocks.length ? settings.availabilityBlocks.map((block) => (
            <article className="installed-model" key={block.id}>
              <div>
                <strong>{block.label}</strong>
                <span className="availability-block-time">{block.weekdays.map((day) => getWeekdayShort(day, t)).join(", ")} · {block.startTime}-{block.endTime}</span>
              </div>
              <button className="button button--secondary button--delete-model" onClick={() => deleteAvailabilityBlock(block.id)} type="button">
                <Trash2 size={14} />
                {t("settings.delete")}
              </button>
            </article>
          )) : <p className="settings-helper-inline">{t("settings.noUnavailableBlocks")}</p>}
        </div>
      </SettingsSection>

      <SettingsSection icon={Info} title={t("settings.aboutTitle")}>
        <div className="about-grid">
          <div className="about-row">
            <span>{t("settings.version")}</span>
            <strong>{appVersion || t("settings.versionUnavailable")}</strong>
          </div>
          <div className="about-row">
            <span>{t("settings.updateStatus")}</span>
            <strong>{formatUpdateStatus(updateStatus, t)}</strong>
          </div>
        </div>
        <div className="ai-settings-actions">
          <button className="button button--secondary" onClick={() => updateSettings({ onboardingCompleted: false })} type="button">
            <PlayCircle size={14} />
            {t("settings.runOnboardingAgain")}
          </button>
          <button className="button button--secondary" disabled={isCheckingUpdates || updateStatus.status === "checking"} onClick={() => void handleCheckForUpdates()} type="button">
            {isCheckingUpdates || updateStatus.status === "checking" ? <Loader2 size={14} className="spin-icon" /> : <RefreshCw size={14} />}
            {t("settings.checkForUpdates")}
          </button>
          {updateStatus.status === "available" ? (
            <button className="button button--primary" onClick={() => void handleDownloadUpdate()} type="button">
              <Download size={14} />
              {t("settings.downloadUpdate")}
            </button>
          ) : null}
          {updateStatus.status === "downloaded" ? (
            <button className="button button--primary" onClick={() => void window.todoAI?.installUpdate()} type="button">
              <RotateCcw size={14} />
              {t("settings.restartToInstall")}
            </button>
          ) : null}
        </div>
        {updateStatus.message ? <p className="settings-helper-inline">{updateStatus.message}</p> : null}
      </SettingsSection>

      <SettingsSection icon={Bell} title={t("settings.notifications")}>
        <label className="toggle-row">
          <span>
            <strong>{t("settings.enableNotifications")}</strong>
            <small>{t("settings.notificationsDescription")}</small>
          </span>
          <input checked={settings.notifications} onChange={(event) => updateSettings({ notifications: event.target.checked })} type="checkbox" />
        </label>
        <label className="field-row">
          <span>{t("settings.defaultReminder")}</span>
          <select
            value={settings.defaultReminderMinutes}
            onChange={(event) => updateSettings({ defaultReminderMinutes: Number(event.target.value) as ReminderOffsetMinutes })}
          >
            <option value={0}>{t("settings.reminderAtTime")}</option>
            <option value={5}>{t("settings.reminder5")}</option>
            <option value={10}>{t("settings.reminder10")}</option>
            <option value={30}>{t("settings.reminder30")}</option>
            <option value={60}>{t("settings.reminder60")}</option>
          </select>
        </label>
        <div className="ai-settings-actions">
          <button className="button button--secondary" disabled={!settings.notifications} onClick={() => void handleTestNotification()} type="button">
            <Bell size={14} />
            {t("settings.testNotification")}
          </button>
          {notificationStatus ? <span className="settings-helper-inline">{notificationStatus}</span> : null}
        </div>
      </SettingsSection>

      <SettingsSection icon={Monitor} title={t("settings.notificationsStartup")}>
        <label className="toggle-row">
          <span>
            <strong>{t("settings.autoPlanDay")}</strong>
            <small>{t("settings.autoPlanDayDescription")}</small>
          </span>
          <input checked={settings.autoPlanDay} onChange={(event) => updateSettings({ autoPlanDay: event.target.checked })} type="checkbox" />
        </label>
        <label className="field-row">
          <span>{t("settings.startupView")}</span>
          <select value={settings.startupBehavior} onChange={(event) => updateSettings({ startupBehavior: event.target.value as UserSettings["startupBehavior"] })}>
            <option value="dashboard">{t("settings.startupDashboard")}</option>
            <option value="today">{t("settings.startupToday")}</option>
            <option value="last-view">{t("settings.startupLastView")}</option>
          </select>
        </label>
        <label className="field-row">
          <span>
            <strong>{t("settings.overdueAutoCleanup")}</strong>
            <small>{t("settings.overdueAutoCleanupDescription")}</small>
          </span>
          <select
            value={settings.overdueAutoCleanupMode}
            onChange={(event) => {
              const mode = event.target.value as OverdueAutoCleanupMode;
              if (mode === "delete") {
                setConfirmAction({ type: "overdue-delete" });
                return;
              }
              updateSettings({ overdueAutoCleanupMode: mode });
            }}
          >
            <option value="off">{t("settings.overdueAutoCleanupOff")}</option>
            <option value="archive">{t("settings.overdueAutoCleanupArchive")}</option>
            <option value="delete">{t("settings.overdueAutoCleanupDelete")}</option>
          </select>
        </label>
        {settings.overdueAutoCleanupMode === "delete" ? (
          <div className="settings-warning" role="alert">
            <AlertTriangle size={14} />
            <span>{t("settings.overdueAutoCleanupDeleteWarning")}</span>
          </div>
        ) : null}
      </SettingsSection>

      <SettingsSection icon={Database} title={t("settings.data")}>
        <div className="data-actions">
          <button className="button button--secondary" disabled={cacheStatus === "loading"} onClick={() => setConfirmAction({ type: "cache" })} type="button">
            <Download size={14} />
            {cacheStatus === "loading" ? t("settings.clearingCache") : t("settings.clearCache")}
          </button>
          <button className="button button--secondary" onClick={() => setConfirmAction({ type: "history" })} type="button">
            <Download size={14} />
            {t("settings.clearAiHistory")}
          </button>
        </div>
        {cacheStatus === "success" && <p className="settings-success">{storageNotice}</p>}
        {cacheStatus === "error" && <p className="settings-error">{t("settings.ollamaUnexpected")}</p>}
      </SettingsSection>

      {confirmAction && (
        <div className="confirm-overlay" role="presentation" onMouseDown={() => setConfirmAction(null)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="settings-confirm-title" onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="settings-confirm-title">
              {getConfirmTitle(confirmAction, t)}
            </h2>
            <p>{getConfirmDescription(confirmAction, t)}</p>
            <div className="confirm-dialog__actions">
              <button className="button button--secondary" onClick={() => setConfirmAction(null)}>
                {t("settings.cancel")}
              </button>
              <button
                className={confirmAction.type === "delete-model" || confirmAction.type === "overdue-delete" ? "button button--danger" : "button button--primary"}
                onClick={() => {
                  if (confirmAction.type === "cache") void handleClearCache();
                  if (confirmAction.type === "history") handleClearHistory();
                  if (confirmAction.type === "delete-model") void handleDeleteModel(confirmAction.modelName);
                  if (confirmAction.type === "overdue-delete") {
                    updateSettings({ overdueAutoCleanupMode: "delete" });
                    setConfirmAction(null);
                  }
                }}
              >
                {t("settings.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function SetupCallout({ icon, title, description, action }: { icon: ReactNode; title: string; description: string; action: ReactNode }) {
  return (
    <div className="setup-callout">
      <span className="setup-callout__icon">{icon}</span>
      <div className="callout-text-wrapper">
        <strong>{title}</strong>
        <p>{description}</p>
      </div>
      {action}
    </div>
  );
}

function ProgressText({ payload, fallback, t }: { payload: OllamaPullProgress | null; fallback: string; t: ReturnType<typeof useI18n>["t"] }) {
  const percent = typeof payload?.percent === "number" ? Math.max(0, Math.min(100, payload.percent)) : undefined;
  return (
    <div className="install-progress__body">
      <p>{payload?.step || fallback}</p>
      {percent !== undefined ? (
        <div className="install-progress__bar" aria-label={`${percent}%`}>
          <span style={{ width: `${Math.max(2, percent)}%` }} />
        </div>
      ) : null}
      <div className="install-progress__meta">
        {percent !== undefined ? <span>{percent}%</span> : null}
        {typeof payload?.completed === "number" && typeof payload.total === "number" ? (
          <span>{formatBytes(payload.completed)} / {formatBytes(payload.total)}</span>
        ) : null}
        {typeof payload?.speedBytesPerSecond === "number" && payload.speedBytesPerSecond > 0 ? (
          <span>{formatBytes(payload.speedBytesPerSecond)}/s</span>
        ) : null}
        {!payload && fallback ? <span>{t("settings.preparingDownload")}</span> : null}
      </div>
    </div>
  );
}

function SettingsSection({
  icon: Icon,
  title,
  description,
  help,
  children,
}: {
  icon: typeof Monitor;
  title: string;
  description?: string;
  help?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section__header">
        <div className="settings-section__title-row">
          <Icon size={16} className="settings-section__icon" />
          <h2>{title}</h2>
          {help}
        </div>
        {description ? <p className="settings-section__description">{description}</p> : null}
      </div>
      <div className="settings-section__body">{children}</div>
    </section>
  );
}

function formatUpdateStatus(status: UpdateStatus, t: ReturnType<typeof useI18n>["t"]) {
  if (status.status === "available") return status.version ? `${t("settings.updateAvailable")} ${status.version}` : t("settings.updateAvailable");
  if (status.status === "downloaded") return t("settings.updateReady");
  if (status.status === "downloading") return status.progress ? `${t("settings.downloadingUpdate")} ${status.progress}%` : t("settings.downloadingUpdate");
  if (status.status === "not-available") return t("settings.upToDate");
  if (status.status === "checking") return t("settings.checkingUpdates");
  if (status.status === "unavailable") return t("settings.updateUnavailable");
  if (status.status === "error") return t("settings.updateCheckFailed");
  return t("settings.notChecked");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function modelMatches(installedModel: string, selectedModel: string) {
  return installedModel === selectedModel || installedModel.replace(/:latest$/, "") === selectedModel || selectedModel.replace(/:latest$/, "") === installedModel;
}



function formatBytes(value: number) {
  if (!Number.isFinite(value) || value <= 0) return "0 B";
  const units = ["B", "KB", "MB", "GB", "TB"];
  const index = Math.min(units.length - 1, Math.floor(Math.log(value) / Math.log(1024)));
  const amount = value / 1024 ** index;
  return `${amount >= 10 || index === 0 ? amount.toFixed(0) : amount.toFixed(1)} ${units[index]}`;
}

function getConfirmTitle(
  action: ConfirmAction,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (action.type === "cache") return t("settings.confirmClearCacheTitle");
  if (action.type === "history") return t("settings.confirmClearHistoryTitle");
  if (action.type === "overdue-delete") return t("settings.overdueAutoCleanupConfirmDeleteTitle");
  return t("settings.confirmDeleteModelTitle");
}

function getConfirmDescription(
  action: ConfirmAction,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (action.type === "cache") return t("settings.confirmClearCacheDescription");
  if (action.type === "history") return t("settings.confirmClearHistoryDescription");
  if (action.type === "overdue-delete") return t("settings.overdueAutoCleanupDeleteWarning");
  return `${t("settings.confirmDeleteModelDescription")} ${action.modelName}`;
}

function mapOpenRouterStatus(status: OpenRouterResult["status"] | undefined) {
  if (status === "invalid-key") return "invalid-key";
  if (status === "billing-issue") return "billing-issue";
  if (status === "model-unavailable") return "model-unavailable";
  if (status === "rate-limited") return "rate-limited";
  if (status === "provider-unavailable") return "provider-unavailable";
  if (status === "offline") return "offline";
  if (status === "missing-key") return "missing-key";
  return "error";
}

function formatOpenRouterStatus(status: "idle" | "checking" | "connected" | "missing-key" | "invalid-key" | "billing-issue" | "model-unavailable" | "rate-limited" | "provider-unavailable" | "offline" | "error", hasKey: boolean, t: ReturnType<typeof useI18n>["t"]) {
  if (status === "checking") return t("settings.testingConnection");
  if (status === "connected") return t("settings.connected");
  if (status === "invalid-key") return t("settings.openRouterInvalidKey");
  if (status === "billing-issue") return t("settings.openRouterBillingIssue");
  if (status === "model-unavailable") return t("settings.openRouterModelUnavailable");
  if (status === "rate-limited") return t("settings.openRouterRateLimited");
  if (status === "provider-unavailable") return t("settings.openRouterProviderUnavailable");
  if (status === "offline") return t("settings.openRouterOffline");
  if (status === "missing-key" || !hasKey) return t("settings.openRouterMissingKey");
  return t("settings.notChecked");
}

function formatTelegramStatus(status: TelegramBridgeStatus | undefined, t: ReturnType<typeof useI18n>["t"]) {
  if (status === "connecting") return t("settings.telegramStatusConnecting");
  if (status === "connected") return t("settings.telegramStatusConnected");
  if (status === "reconnecting") return t("settings.telegramStatusReconnecting");
  if (status === "invalid-token") return t("settings.telegramStatusInvalidToken");
  if (status === "not-paired") return t("settings.telegramStatusNotPaired");
  if (status === "webhook-conflict") return t("settings.telegramStatusWebhookConflict");
  if (status === "error") return t("settings.telegramStatusError");
  return t("settings.telegramStatusDisabled");
}

function telegramStatusTone(status: TelegramBridgeStatus | undefined) {
  if (status === "connected") return "connected";
  if (status === "not-paired" || status === "connecting" || status === "reconnecting") return "model-missing";
  return "not-connected";
}

function formatMcpStatus(status: McpServerState | undefined, t: ReturnType<typeof useI18n>["t"]) {
  if (status === "starting") return t("settings.mcpStatusStarting");
  if (status === "running") return t("settings.mcpStatusRunning");
  if (status === "error") return t("settings.mcpStatusError");
  return t("settings.mcpStatusDisabled");
}

function mcpStatusTone(status: McpServerState | undefined) {
  if (status === "running") return "connected";
  if (status === "starting") return "neutral";
  if (status === "error") return "not-connected";
  return "neutral";
}

function formatAevumConnectStatus(status: AevumConnectStatusResult["state"] | undefined, t: ReturnType<typeof useI18n>["t"]) {
  if (status === "connecting") return t("settings.mcpConnectStatusConnecting");
  if (status === "connected") return t("settings.mcpConnectStatusConnected");
  if (status === "offline") return t("settings.mcpConnectStatusOffline");
  if (status === "error") return t("settings.mcpStatusError");
  return t("settings.mcpStatusDisabled");
}

function aevumConnectStatusTone(status: AevumConnectStatusResult["state"] | undefined) {
  if (status === "connected") return "connected";
  if (status === "connecting") return "neutral";
  if (status === "offline" || status === "error") return "not-connected";
  return "neutral";
}

function formatMcpAccessMode(mode: McpAccessMode, t: ReturnType<typeof useI18n>["t"]) {
  if (mode === "full-access") return t("settings.mcpFullAccess");
  if (mode === "proposals") return t("settings.mcpProposalsOnly");
  return t("settings.mcpReadOnly");
}

function formatMcpTunnelStatus(status: McpStatusResult["tunnel"]["state"] | undefined, t: ReturnType<typeof useI18n>["t"], mode: McpTunnelMode, hasRemoteEndpoint: boolean) {
  if (mode === "persistent") return hasRemoteEndpoint ? t("settings.mcpPersistentConfigured") : t("settings.mcpPersistentNeedsOrigin");
  if (status === "starting") return t("settings.mcpTunnelStarting");
  if (status === "running") return t("settings.mcpTunnelRunning");
  if (status === "error") return t("settings.mcpTunnelError");
  if (status === "missing") return t("settings.mcpTunnelMissing");
  return t("settings.mcpTunnelDisabled");
}

function mcpTunnelStatusTone(status: McpStatusResult["tunnel"]["state"] | undefined, mode: McpTunnelMode, hasRemoteEndpoint: boolean) {
  if (mode === "persistent") return hasRemoteEndpoint ? "connected" : "neutral";
  if (status === "running") return "connected";
  if (status === "starting") return "neutral";
  if (status === "error" || status === "missing") return "not-connected";
  return "neutral";
}

function formatMcpOAuthStage(stage: McpStatusResult["oauth"]["currentStage"] | undefined, t: ReturnType<typeof useI18n>["t"]) {
  if (stage === "pending_browser_consent") return t("settings.mcpOAuthPendingBrowser");
  if (stage === "pending_native_approval") return t("settings.mcpOAuthPendingNative");
  if (stage === "approved") return t("settings.mcpOAuthApproved");
  if (stage === "denied") return t("settings.mcpOAuthDenied");
  if (stage === "expired") return t("settings.mcpOAuthExpired");
  if (stage === "consumed") return t("settings.mcpOAuthConsumed");
  return t("settings.mcpOAuthIdle");
}

function formatTelegramChat(chat: NonNullable<TelegramStatusResult["pairedChat"]>) {
  const label = chat.username ? `@${chat.username}` : chat.firstName || "Private chat";
  return `${label} · ${chat.id}`;
}

function getWeekdayShort(day: number, t: ReturnType<typeof useI18n>["t"]) {
  const keys = [
    "weekday.short.sunday",
    "weekday.short.monday",
    "weekday.short.tuesday",
    "weekday.short.wednesday",
    "weekday.short.thursday",
    "weekday.short.friday",
    "weekday.short.saturday",
  ] as const;
  return t(keys[day]);
}
