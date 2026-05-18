import {
  AlertTriangle,
  Bell,
  Check,
  CheckCircle2,
  Cpu,
  Database,
  Download,
  ExternalLink,
  Info,
  Languages,
  Loader2,
  Monitor,
  Moon,
  PackageCheck,
  PlayCircle,
  RefreshCw,
  RotateCcw,
  Sun,
} from "lucide-react";
import { useEffect, useMemo, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import type { Language, ReminderOffsetMinutes, ThemeMode, UserSettings } from "../types";

interface SettingsPageProps {
  clearAiHistory: () => void;
  settings: UserSettings;
  updateSettings: (updates: Partial<UserSettings>) => void;
}

type SetupStatus = OllamaSetupStatus;
type UpdateStatus = UpdateCheckResult;
type PullState = "idle" | "loading" | "success" | "error";

const smartModels = [
  { name: "llama3.1:latest", descriptionKey: "settings.smartModel.llama31" },
  { name: "llama3.2:latest", descriptionKey: "settings.smartModel.llama32" },
  { name: "mistral:latest", descriptionKey: "settings.smartModel.mistral" },
  { name: "qwen2.5:latest", descriptionKey: "settings.smartModel.qwen" },
  { name: "deepseek-r1:latest", descriptionKey: "settings.smartModel.deepseek" },
] as const;

export function SettingsPage({ clearAiHistory, settings, updateSettings }: SettingsPageProps) {
  const { language, languageNames, setLanguage, t } = useI18n();
  const [appVersion, setAppVersion] = useState("");
  const [ollamaStatus, setOllamaStatus] = useState<SetupStatus | null>(null);
  const [isRefreshingModels, setIsRefreshingModels] = useState(false);
  const [showAdvancedAI, setShowAdvancedAI] = useState(false);
  const [customModel, setCustomModel] = useState(settings.localModel);
  const [pullState, setPullState] = useState<PullState>("idle");
  const [installingModel, setInstallingModel] = useState("");
  const [pullProgress, setPullProgress] = useState<OllamaPullProgress | null>(null);
  const [pullMessage, setPullMessage] = useState("");
  const [notificationStatus, setNotificationStatus] = useState("");
  const [updateStatus, setUpdateStatus] = useState<UpdateStatus>({ status: "idle" });
  const [isCheckingUpdates, setIsCheckingUpdates] = useState(false);
  const [cacheStatus, setCacheStatus] = useState<"idle" | "loading" | "success" | "error">("idle");
  const [storageNotice, setStorageNotice] = useState("");
  const [confirmAction, setConfirmAction] = useState<"cache" | "history" | null>(null);

  const installedModels = ollamaStatus?.models ?? [];
  const selectedModelInstalled = ollamaStatus?.selectedModelInstalled ?? installedModels.some((model) => model.name === settings.localModel);
  const missingSelectedModel = Boolean(ollamaStatus && ollamaStatus.status === "model-missing");

  useEffect(() => {
    if (settings.aiProvider !== "ollama") updateSettings({ aiProvider: "ollama", apiKey: "" });
  }, [settings.aiProvider, updateSettings]);

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
      if (payload.status) setPullMessage(payload.status);
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
    setPullState("loading");
    setInstallingModel(modelName);
    setPullMessage(t("settings.installingModel"));
    setPullProgress(null);
    const result = await window.todoAI?.pullOllamaModel(modelName);
    if (!result?.ok) {
      setPullState("error");
      setPullMessage(result?.message ?? t("settings.modelInstallFailed"));
      setInstallingModel("");
      return;
    }
    setPullState("success");
    setInstallingModel("");
    setPullMessage(t("settings.modelInstalled"));
    updateSettings({ localModel: modelName });
    await refreshOllamaStatus(false);
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

      <SettingsSection icon={Cpu} title={t("settings.aiSetup")} description={t("settings.aiSetupDescription")}>
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

        <div className="recommended-models smart-models">
          <div>
            <strong>{t("settings.smartModels")}</strong>
            <p>{t("settings.smartModelsDescription")}</p>
          </div>
          <div className="smart-model-list">
            {smartModels.map((model) => {
              const installed = installedModels.some((installedModel) => modelMatches(installedModel.name, model.name));
              const selected = modelMatches(settings.localModel, model.name);
              const isInstallingThis = pullState === "loading" && installingModel === model.name;
              return (
                <article className="smart-model" key={model.name}>
                  <div>
                    <div className="smart-model__header">
                      <strong>{model.name}</strong>
                      {selected ? <span className="status-pill status-pill--connected">{t("settings.selected")}</span> : installed ? <span className="status-pill">{t("settings.installed")}</span> : null}
                    </div>
                    <p>{t(model.descriptionKey)}</p>
                  </div>
                  {installed ? (
                    <button className="button button--secondary" onClick={() => updateSettings({ localModel: model.name })} type="button">
                      <Check size={16} />
                      {selected ? t("settings.selected") : t("settings.useModel")}
                    </button>
                  ) : (
                    <button
                      className="button button--secondary"
                      disabled={pullState === "loading" || ollamaStatus?.status === "not-installed"}
                      onClick={() => void handlePullModel(model.name)}
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

        {missingSelectedModel || !installedModels.length ? (
          <div className="recommended-models">
            <div>
              <strong>{t("settings.recommendedModels")}</strong>
              <p>{t("settings.recommendedModelsDescription")}</p>
            </div>
            <div className="model-install-list">
              {smartModels.slice(0, 3).map((model) => (
                <button
                  className="button button--secondary"
                  disabled={pullState === "loading" || ollamaStatus?.status === "not-installed"}
                  key={model.name}
                  onClick={() => void handlePullModel(model.name)}
                  type="button"
                >
                  {pullState === "loading" && installingModel === model.name ? <Loader2 size={16} className="spin-icon" /> : <Download size={16} />}
                  {t("settings.installModel")} {model.name}
                </button>
              ))}
            </div>
          </div>
        ) : null}

        {pullState !== "idle" ? (
          <div className={`install-progress install-progress--${pullState}`}>
            <div className="install-progress__header">
              {pullState === "success" ? <CheckCircle2 size={16} /> : pullState === "error" ? <AlertTriangle size={16} /> : <Loader2 size={16} className="spin-icon" />}
              <span>{pullState === "success" ? t("settings.modelInstalled") : pullState === "error" ? t("settings.modelInstallFailed") : t("settings.installingModel")}</span>
            </div>
            <ProgressText payload={pullProgress} fallback={pullMessage} />
            {pullState === "loading" ? (
              <button className="button button--secondary" onClick={() => void window.todoAI?.cancelOllamaPull()} type="button">
                {t("settings.cancel")}
              </button>
            ) : null}
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
          <button className="button button--secondary" disabled={cacheStatus === "loading"} onClick={() => setConfirmAction("cache")} type="button">
            <Download size={16} />
            {cacheStatus === "loading" ? t("settings.clearingCache") : t("settings.clearCache")}
          </button>
          <button className="button button--secondary" onClick={() => setConfirmAction("history")} type="button">
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
              {confirmAction === "cache" ? t("settings.confirmClearCacheTitle") : t("settings.confirmClearHistoryTitle")}
            </h2>
            <p>{confirmAction === "cache" ? t("settings.confirmClearCacheDescription") : t("settings.confirmClearHistoryDescription")}</p>
            <div className="confirm-dialog__actions">
              <button className="button button--secondary" onClick={() => setConfirmAction(null)}>
                {t("settings.cancel")}
              </button>
              <button className="button button--primary" onClick={() => (confirmAction === "cache" ? void handleClearCache() : handleClearHistory())}>
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

function ProgressText({ payload, fallback }: { payload: unknown; fallback: string }) {
  if (isRecord(payload) && typeof payload.percent === "number") {
    return (
      <div className="install-progress__bar" aria-label={`${payload.percent}%`}>
        <span style={{ width: `${Math.max(2, Math.min(100, payload.percent))}%` }} />
      </div>
    );
  }
  return <p>{fallback}</p>;
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
