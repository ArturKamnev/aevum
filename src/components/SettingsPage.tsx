import {
  AlertTriangle,
  Bell,
  CalendarClock,
  Check,
  CheckCircle2,
  Cpu,
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
  Sun,
  Trash2,
} from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import type { AvailabilityBlock, AIProvider, Language, ReminderOffsetMinutes, ThemeMode, UserSettings } from "../types";

interface SettingsPageProps {
  clearAiHistory: () => void;
  settings: UserSettings;
  updateSettings: (updates: Partial<UserSettings>) => void;
}

type SetupStatus = OllamaSetupStatus;
type UpdateStatus = UpdateCheckResult;
type PullState = "idle" | "loading" | "success" | "error";
type ModelGroup = "fast" | "balanced" | "smart";
type ConfirmAction = { type: "cache" } | { type: "history" } | { type: "delete-model"; modelName: string };

const recommendedModelGroups: Array<{
  id: ModelGroup;
  titleKey: "settings.fastModels" | "settings.balancedModels" | "settings.smartModels";
  descriptionKey: "settings.fastModelsDescription" | "settings.balancedModelsDescription" | "settings.smartModelsDescription";
  models: Array<{ name: string; descriptionKey: TranslationModelDescriptionKey }>;
}> = [
  {
    id: "fast",
    titleKey: "settings.fastModels",
    descriptionKey: "settings.fastModelsDescription",
    models: [
      { name: "llama3.2:latest", descriptionKey: "settings.modelDescription.llama32" },
      { name: "mistral:latest", descriptionKey: "settings.modelDescription.mistral" },
      { name: "gemma:latest", descriptionKey: "settings.modelDescription.gemma" },
    ],
  },
  {
    id: "balanced",
    titleKey: "settings.balancedModels",
    descriptionKey: "settings.balancedModelsDescription",
    models: [
      { name: "llama3.1:latest", descriptionKey: "settings.modelDescription.llama31" },
      { name: "qwen2.5:latest", descriptionKey: "settings.modelDescription.qwen" },
      { name: "neutron:latest", descriptionKey: "settings.modelDescription.neutron" },
    ],
  },
  {
    id: "smart",
    titleKey: "settings.smartModels",
    descriptionKey: "settings.smartModelsDescription",
    models: [
      { name: "deepseek-r1:latest", descriptionKey: "settings.modelDescription.deepseek" },
      { name: "qwen2.5:latest", descriptionKey: "settings.modelDescription.qwen" },
      { name: "kimi-k2-thinking:cloud", descriptionKey: "settings.modelDescription.kimi" },
      { name: "glm4:latest", descriptionKey: "settings.modelDescription.glm" },
    ],
  },
] as const;

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

type TranslationModelDescriptionKey =
  | "settings.modelDescription.llama31"
  | "settings.modelDescription.llama32"
  | "settings.modelDescription.mistral"
  | "settings.modelDescription.gemma"
  | "settings.modelDescription.qwen"
  | "settings.modelDescription.deepseek"
  | "settings.modelDescription.kimi"
  | "settings.modelDescription.glm"
  | "settings.modelDescription.neutron";

const weekdayNumbers = [1, 2, 3, 4, 5, 6, 0];

export function SettingsPage({ clearAiHistory, settings, updateSettings }: SettingsPageProps) {
  const { language, languageNames, setLanguage, t } = useI18n();
  const openRouterKeyRef = useRef<HTMLInputElement>(null);
  const [appVersion, setAppVersion] = useState("");
  const [ollamaStatus, setOllamaStatus] = useState<SetupStatus | null>(null);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [showAdvancedAI, setShowAdvancedAI] = useState(false);
  const [customModel, setCustomModel] = useState(settings.localModel);
  const [pullState, setPullState] = useState<PullState>("idle");
  const [installingModel, setInstallingModel] = useState("");
  const [pullProgress, setPullProgress] = useState<OllamaPullProgress | null>(null);
  const [pullMessage, setPullMessage] = useState("");
  const [pullNames, setPullNames] = useState<Record<string, string>>(() => getDefaultPullNames());
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

    void refreshOllamaStatus(false);
    return () => {
      isMounted = false;
      removeUpdateListener?.();
      removePullListener?.();
    };
  }, []);

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
        updateSettings({ localModel: nextModel?.name ?? "llama3.1:latest" });
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

  function addAvailabilityBlock() {
    const label = scheduleDraft.label.trim() || t("settings.unavailable");
    if (!scheduleDraft.weekdays.length || scheduleDraft.startTime >= scheduleDraft.endTime) return;
    const block: AvailabilityBlock = {
      id: `availability-${Date.now()}`,
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
      console.error("[Todo AI] Failed to clear app cache", error);
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
      <SettingsSection icon={Monitor} title={t("settings.appearance")} description={t("settings.appearanceDescription")}>
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
                <Icon size={15} />
                {option.label}
              </button>
            );
          })}
        </div>
      </SettingsSection>

      <SettingsSection icon={Languages} title={t("settings.language")} description={t("settings.languageDescription")}>
        <fieldset className="language-options" aria-label={t("settings.language")}>
          {[
            { value: "en", label: t("settings.languageEnglish"), description: t("settings.languageEnglishDescription") },
            { value: "ru", label: t("settings.languageRussian"), description: t("settings.languageRussianDescription") },
          ].map((option) => {
            const isActive = language === option.value;
            return (
              <label className={`language-option ${isActive ? "language-option--active" : ""}`} key={option.value}>
                <input
                  checked={isActive}
                  name="language"
                  onChange={() => handleLanguageChange(option.value as Language)}
                  type="radio"
                  value={option.value}
                />
                <span className="language-option__content">
                  <span className="language-option__label">{option.label}</span>
                  <span className="language-option__meta">{languageNames[option.value as Language].label}</span>
                  <span className="language-option__description">{option.description}</span>
                </span>
                <span className="language-option__check" aria-hidden="true">
                  <Check size={15} />
                </span>
              </label>
            );
          })}
        </fieldset>
      </SettingsSection>

      <SettingsSection icon={Cpu} title={t("settings.aiModels")} description={t("settings.aiSetupDescription")}>
        <div className="segmented-control">
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
                <Icon size={15} />
                {option.label}
              </button>
            );
          })}
        </div>

        {settings.aiProvider === "openrouter" ? (
          <div className="advanced-settings">
            <div className="setup-status-row">
              <span className={`status-pill status-pill--${openRouterStatus === "connected" ? "connected" : "model-missing"}`}>
                {formatOpenRouterStatus(openRouterStatus, hasOpenRouterKey, t)}
              </span>
              <strong className="readonly-value">{settings.cloudModel}</strong>
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
            <p className="settings-helper-inline">
              {t(openRouterModelOptions.find((option) => option.id === settings.cloudModel)?.descriptionKey ?? "settings.openRouterAutoFreeModelDescription")}
            </p>
            <p className="settings-helper-inline">{t("settings.openRouterFreeModelNote")}</p>
            <label className="field-row">
              <span>{t("settings.openRouterApiKey")}</span>
              <input ref={openRouterKeyRef} type="password" placeholder="sk-or-v1-..." autoComplete="off" />
            </label>
            <div className="ai-settings-actions">
              <button className="button button--primary" onClick={() => void handleSaveOpenRouterKey()} type="button">
                <KeyRound size={16} />
                {t("settings.saveApiKey")}
              </button>
              <button className="button button--secondary" disabled={!hasOpenRouterKey || openRouterStatus === "checking"} onClick={() => void handleTestOpenRouter()} type="button">
                {openRouterStatus === "checking" ? <Loader2 size={16} className="spin-icon" /> : <Check size={16} />}
                {t("settings.testConnection")}
              </button>
              <button className="button button--danger" disabled={!hasOpenRouterKey} onClick={() => void handleDeleteOpenRouterKey()} type="button">
                <Trash2 size={16} />
                {t("settings.removeApiKey")}
              </button>
            </div>
            {openRouterStatusMessage ? <p className="settings-helper-inline">{openRouterStatusMessage}</p> : null}
          </div>
        ) : null}

        {settings.aiProvider === "ollama" ? (
          <>
        <div className="setup-status-row">
          <span className={`status-pill status-pill--${aiStatusTone}`}>{aiStatusText}</span>
          <button className="button button--secondary" disabled={isRefreshingModels} onClick={() => void refreshOllamaStatus()} type="button">
            {isRefreshingModels ? <Loader2 size={16} className="spin-icon" /> : <RefreshCw size={16} />}
            {t("settings.refreshModels")}
          </button>
        </div>

        {ollamaStatus?.status === "not-installed" ? (
          <SetupCallout
            icon={<Download size={18} />}
            title={t("settings.ollamaMissingTitle")}
            description={t("settings.ollamaMissingDescription")}
            action={
              <button className="button button--primary" onClick={() => void window.todoAI?.openOllamaDownload()} type="button">
                <ExternalLink size={16} />
                {t("settings.installOllama")}
              </button>
            }
          />
        ) : null}

        {ollamaStatus?.status === "not-running" ? (
          <SetupCallout
            icon={<AlertTriangle size={18} />}
            title={t("settings.ollamaNotRunningTitle")}
            description={t("settings.ollamaNotRunningDescription")}
            action={
              <button className="button button--primary" onClick={() => void handleStartOllama()} type="button">
                <PackageCheck size={16} />
                {t("settings.startOllama")}
              </button>
            }
          />
        ) : null}

        <label className="field-row">
          <span>{t("settings.provider")}</span>
          <strong className="readonly-value">{t("settings.localAI")}</strong>
        </label>

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
          <div className="settings-warning">
            <AlertTriangle size={16} />
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
                      <Check size={16} />
                      {selected ? t("settings.selected") : t("settings.useModel")}
                    </button>
                    <button className="button button--danger" disabled={deleting} onClick={() => setConfirmAction({ type: "delete-model", modelName: model.name })} type="button">
                      {deleting ? <Loader2 size={16} className="spin-icon" /> : <Trash2 size={16} />}
                      {t("settings.deleteModel")}
                    </button>
                  </div>
                </article>
              );
            })}
          </div>
        ) : null}

        {modelActionMessage ? <p className={modelActionMessage === t("settings.modelDeleted") ? "settings-success" : "settings-error"}>{modelActionMessage}</p> : null}

        <div className="model-groups">
          {recommendedModelGroups.map((group) => (
            <div className="recommended-models smart-models" key={group.id}>
              <div>
                <strong>{t(group.titleKey)}</strong>
                <p>{t(group.descriptionKey)}</p>
              </div>
              <div className="smart-model-list">
                {group.models.map((model) => {
                  const pullName = pullNames[model.name] ?? model.name;
                  const installed = installedModels.some((installedModel) => modelMatches(installedModel.name, pullName));
                  const selected = modelMatches(settings.localModel, pullName);
                  const isInstallingThis = pullState === "loading" && installingModel === pullName;
                  return (
                    <article className="smart-model" key={`${group.id}-${model.name}`}>
                      <div>
                        <div className="smart-model__header">
                          <strong>{model.name}</strong>
                          {selected ? <span className="status-pill status-pill--connected">{t("settings.selected")}</span> : installed ? <span className="status-pill">{t("settings.installed")}</span> : null}
                        </div>
                        <p>{t(model.descriptionKey)}</p>
                        <label className="model-pull-name">
                          <span>{t("settings.pullName")}</span>
                          <input
                            value={pullName}
                            onChange={(event) => setPullNames((current) => ({ ...current, [model.name]: event.target.value }))}
                            disabled={pullState === "loading"}
                          />
                        </label>
                      </div>
                      {installed ? (
                        <button className="button button--secondary" onClick={() => updateSettings({ localModel: pullName })} type="button">
                          <Check size={16} />
                          {selected ? t("settings.selected") : t("settings.useModel")}
                        </button>
                      ) : (
                        <button
                          className="button button--secondary"
                          disabled={pullState === "loading" || ollamaStatus?.status === "not-installed"}
                          onClick={() => void handlePullModel(pullName)}
                          type="button"
                        >
                          {isInstallingThis ? <Loader2 size={16} className="spin-icon" /> : <Download size={16} />}
                          {t("settings.installModel")}
                        </button>
                      )}
                    </article>
                  );
                })}
              </div>
            </div>
          ))}
        </div>

        {missingSelectedModel || !installedModels.length ? (
          <div className="recommended-models">
            <div>
              <strong>{t("settings.recommendedModels")}</strong>
              <p>{t("settings.recommendedModelsDescription")}</p>
            </div>
            <div className="model-install-list">
              {recommendedModelGroups[0].models.map((model) => (
                <button
                  className="button button--secondary"
                  disabled={pullState === "loading" || ollamaStatus?.status === "not-installed"}
                  key={model.name}
                  onClick={() => void handlePullModel(pullNames[model.name] ?? model.name)}
                  type="button"
                >
                  {pullState === "loading" && installingModel === (pullNames[model.name] ?? model.name) ? <Loader2 size={16} className="spin-icon" /> : <Download size={16} />}
                  {t("settings.installModel")} {pullNames[model.name] ?? model.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {pullState !== "idle" ? (
          <div className={`install-progress install-progress--${pullState}`}>
            <div className="install-progress__header">
              {pullState === "success" ? <CheckCircle2 size={16} /> : pullState === "error" ? <AlertTriangle size={16} /> : <Loader2 size={16} className="spin-icon" />}
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

        <button className="text-button" onClick={() => setShowAdvancedAI((value) => !value)} type="button">
          {showAdvancedAI ? t("settings.hideAdvanced") : t("settings.showAdvanced")}
        </button>

        {showAdvancedAI ? (
          <div className="advanced-settings">
            <label className="field-row">
              <span>{t("settings.baseUrl")}</span>
              <input value={settings.aiBaseUrl} onChange={(event) => updateSettings({ aiBaseUrl: event.target.value })} placeholder="http://localhost:11434" />
            </label>
            <label className="field-row">
              <span>{t("settings.customModel")}</span>
              <input value={customModel} onChange={(event) => setCustomModel(event.target.value)} placeholder="llama3.1:latest" />
            </label>
            <button className="button button--secondary" onClick={() => updateSettings({ localModel: customModel.trim() || settings.localModel })} type="button">
              {t("settings.useCustomModel")}
            </button>
          </div>
        ) : null}
          </>
        ) : null}
      </SettingsSection>

      <SettingsSection icon={CalendarClock} title={t("settings.schedule")} description={t("settings.scheduleDescription")}>
        <div className="availability-editor">
          <input value={scheduleDraft.label} onChange={(event) => setScheduleDraft((current) => ({ ...current, label: event.target.value }))} placeholder={t("settings.scheduleLabelPlaceholder")} />
          <div className="weekday-picker">
            {weekdayNumbers.map((day) => (
              <button className={`weekday-chip ${scheduleDraft.weekdays.includes(day) ? "weekday-chip--active" : ""}`} key={day} onClick={() => toggleScheduleWeekday(day)} type="button">
                {getWeekdayShort(day, t)}
              </button>
            ))}
          </div>
          <div className="task-modal__grid">
            <input value={scheduleDraft.startTime} onChange={(event) => setScheduleDraft((current) => ({ ...current, startTime: event.target.value }))} type="time" aria-label={t("settings.scheduleStart")} />
            <input value={scheduleDraft.endTime} onChange={(event) => setScheduleDraft((current) => ({ ...current, endTime: event.target.value }))} type="time" aria-label={t("settings.scheduleEnd")} />
          </div>
          <button className="button button--primary" disabled={!scheduleDraft.weekdays.length || scheduleDraft.startTime >= scheduleDraft.endTime} onClick={addAvailabilityBlock} type="button">
            {t("settings.addUnavailableBlock")}
          </button>
        </div>
        <div className="installed-model-list">
          {settings.availabilityBlocks.length ? settings.availabilityBlocks.map((block) => (
            <article className="installed-model" key={block.id}>
              <div>
                <strong>{block.label}</strong>
                <span>{block.weekdays.map((day) => getWeekdayShort(day, t)).join(", ")} · {block.startTime}-{block.endTime}</span>
              </div>
              <button className="button button--danger" onClick={() => deleteAvailabilityBlock(block.id)} type="button">
                <Trash2 size={16} />
                {t("settings.delete")}
              </button>
            </article>
          )) : <p className="settings-helper-inline">{t("settings.noUnavailableBlocks")}</p>}
        </div>
      </SettingsSection>

      <SettingsSection icon={Info} title={t("settings.aboutTitle")} description={t("settings.aboutDescription")}>
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
            <PlayCircle size={16} />
            {t("settings.runOnboardingAgain")}
          </button>
          <button className="button button--secondary" disabled={isCheckingUpdates || updateStatus.status === "checking"} onClick={() => void handleCheckForUpdates()} type="button">
            {isCheckingUpdates || updateStatus.status === "checking" ? <Loader2 size={16} className="spin-icon" /> : <RefreshCw size={16} />}
            {t("settings.checkForUpdates")}
          </button>
          {updateStatus.status === "available" ? (
            <button className="button button--primary" onClick={() => void handleDownloadUpdate()} type="button">
              <Download size={16} />
              {t("settings.downloadUpdate")}
            </button>
          ) : null}
          {updateStatus.status === "downloaded" ? (
            <button className="button button--primary" onClick={() => void window.todoAI?.installUpdate()} type="button">
              <RotateCcw size={16} />
              {t("settings.restartToInstall")}
            </button>
          ) : null}
        </div>
        {updateStatus.message ? <p className="settings-helper-inline">{updateStatus.message}</p> : null}
      </SettingsSection>

      <SettingsSection icon={Bell} title={t("settings.notifications")} description={t("settings.notificationsSectionDescription")}>
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
            <Bell size={16} />
            {t("settings.testNotification")}
          </button>
          {notificationStatus ? <span className="settings-helper-inline">{notificationStatus}</span> : null}
        </div>
      </SettingsSection>

      <SettingsSection icon={Monitor} title={t("settings.notificationsStartup")} description={t("settings.notificationsStartupDescription")}>
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
      </SettingsSection>

      <SettingsSection icon={Database} title={t("settings.data")} description={t("settings.dataDescription")}>
        <div className="data-actions">
          <button className="button button--secondary" disabled={cacheStatus === "loading"} onClick={() => setConfirmAction({ type: "cache" })} type="button">
            <Download size={16} />
            {cacheStatus === "loading" ? t("settings.clearingCache") : t("settings.clearCache")}
          </button>
          <button className="button button--secondary" onClick={() => setConfirmAction({ type: "history" })} type="button">
            <Download size={16} />
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
                className={confirmAction.type === "delete-model" ? "button button--danger" : "button button--primary"}
                onClick={() => {
                  if (confirmAction.type === "cache") void handleClearCache();
                  if (confirmAction.type === "history") handleClearHistory();
                  if (confirmAction.type === "delete-model") void handleDeleteModel(confirmAction.modelName);
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
      <div>
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
  children,
}: {
  icon: typeof Monitor;
  title: string;
  description: string;
  children: ReactNode;
}) {
  return (
    <section className="settings-section">
      <div className="settings-section__header">
        <div className="settings-section__icon">
          <Icon size={18} />
        </div>
        <div>
          <h2>{title}</h2>
          <p>{description}</p>
        </div>
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

function getDefaultPullNames() {
  return Object.fromEntries(recommendedModelGroups.flatMap((group) => group.models.map((model) => [model.name, model.name])));
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
  return t("settings.confirmDeleteModelTitle");
}

function getConfirmDescription(
  action: ConfirmAction,
  t: ReturnType<typeof useI18n>["t"],
) {
  if (action.type === "cache") return t("settings.confirmClearCacheDescription");
  if (action.type === "history") return t("settings.confirmClearHistoryDescription");
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
