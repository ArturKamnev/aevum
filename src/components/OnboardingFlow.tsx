import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { Bell, Check, Cpu, Download, Languages, Loader2, Moon, Plus, Sparkles, Sun, Monitor } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import type { Language, Project, ReminderOffsetMinutes, TaskDraft, ThemeMode, UserSettings } from "../types";
import { defaultRepeat } from "../utils/recurrence";

gsap.registerPlugin(useGSAP);

interface OnboardingFlowProps {
  projects: Project[];
  settings: UserSettings;
  updateSettings: (updates: Partial<UserSettings>) => void;
  onAddTask: (task: TaskDraft) => void;
  onComplete: () => void;
}

const onboardingModels = ["llama3.1:latest", "llama3.2:latest", "mistral:latest"];

export function OnboardingFlow({ projects, settings, updateSettings, onAddTask, onComplete }: OnboardingFlowProps) {
  const { language, setLanguage, t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const [stepIndex, setStepIndex] = useState(0);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaSetupStatus | null>(null);
  const [isCheckingOllama, setIsCheckingOllama] = useState(false);
  const [installingModel, setInstallingModel] = useState("");
  const [modelInstallStatus, setModelInstallStatus] = useState("");
  const [firstTaskTitle, setFirstTaskTitle] = useState("");

  const installedModels = ollamaStatus?.models ?? [];
  const steps = useMemo(
    () => [
      t("onboarding.welcome"),
      t("onboarding.language"),
      t("onboarding.theme"),
      t("onboarding.aiSetup"),
      t("onboarding.notifications"),
      t("onboarding.firstTask"),
    ],
    [t],
  );

  useGSAP(() => {
    const root = rootRef.current;
    if (!root) return;
    const mm = gsap.matchMedia(root);
    mm.add(
      {
        reduceMotion: "(prefers-reduced-motion: reduce)",
      },
      (context) => {
        const reduceMotion = context.conditions?.reduceMotion;
        gsap.fromTo(
          ".onboarding-step__content > *",
          { autoAlpha: 0, y: reduceMotion ? 0 : 12, scale: reduceMotion ? 1 : 0.985 },
          {
            autoAlpha: 1,
            y: 0,
            scale: 1,
            duration: reduceMotion ? 0.01 : 0.32,
            ease: "power3.out",
            stagger: reduceMotion ? 0 : 0.035,
            overwrite: "auto",
          },
        );
      },
    );
    return () => mm.revert();
  }, { dependencies: [stepIndex], scope: rootRef, revertOnUpdate: true });

  useEffect(() => {
    if (stepIndex === 3) void refreshOllamaStatus();
  }, [stepIndex]);

  function handleLanguageChange(nextLanguage: Language) {
    setLanguage(nextLanguage);
    updateSettings({ language: nextLanguage });
  }

  async function refreshOllamaStatus() {
    setIsCheckingOllama(true);
    try {
      const status = await window.todoAI?.checkOllamaStatus(settings.localModel, settings.aiBaseUrl);
      if (status) setOllamaStatus(status);
    } finally {
      setIsCheckingOllama(false);
    }
  }

  async function installModel(modelName: string) {
    setInstallingModel(modelName);
    setModelInstallStatus(t("settings.installingModel"));
    const result = await window.todoAI?.pullOllamaModel(modelName);
    if (!result?.ok) {
      setModelInstallStatus(result?.message ?? t("settings.modelInstallFailed"));
      setInstallingModel("");
      return;
    }
    updateSettings({ localModel: modelName });
    setModelInstallStatus(t("settings.modelInstalled"));
    setInstallingModel("");
    await refreshOllamaStatus();
  }

  function finishOnboarding(skipTask = false) {
    const title = firstTaskTitle.trim();
    if (!skipTask && title) {
      onAddTask({
        title,
        description: "",
        status: "active",
        scheduledAt: null,
        projectId: projects[0]?.id ?? "uncategorized",
        durationMinutes: null,
        repeat: { ...defaultRepeat },
        nextRepeatAt: null,
        tags: [],
        subtasks: [],
      });
    }
    onComplete();
  }

  function nextStep() {
    if (stepIndex >= steps.length - 1) {
      finishOnboarding();
      return;
    }
    setStepIndex((index) => Math.min(index + 1, steps.length - 1));
  }

  function previousStep() {
    setStepIndex((index) => Math.max(index - 1, 0));
  }

  const progress = ((stepIndex + 1) / steps.length) * 100;

  return (
    <div className="onboarding-overlay" ref={rootRef}>
      <section className="onboarding-card" role="dialog" aria-modal="true" aria-labelledby="onboarding-title">
        <div className="onboarding-progress" aria-hidden="true">
          <span style={{ width: `${progress}%` }} />
        </div>
        <div className="onboarding-card__header">
          <span className="onboarding-kicker">{t("onboarding.firstSetup")}</span>
          <button className="text-button" onClick={() => finishOnboarding(true)} type="button">
            {t("onboarding.skip")}
          </button>
        </div>

        <div className="onboarding-step__content">
          {stepIndex === 0 ? (
            <WelcomeStep titleId="onboarding-title" />
          ) : null}

          {stepIndex === 1 ? (
            <ChoiceStep
              title={t("onboarding.chooseLanguage")}
              description={t("onboarding.languageDescription")}
              icon={<Languages size={22} />}
              options={[
                { value: "en", label: "English", active: language === "en", onClick: () => handleLanguageChange("en") },
                { value: "ru", label: "Русский", active: language === "ru", onClick: () => handleLanguageChange("ru") },
              ]}
            />
          ) : null}

          {stepIndex === 2 ? (
            <ChoiceStep
              title={t("onboarding.chooseTheme")}
              description={t("onboarding.themeDescription")}
              icon={<Monitor size={22} />}
              options={[
                { value: "dark", label: t("settings.dark"), active: settings.theme === "dark", icon: <Moon size={17} />, onClick: () => updateSettings({ theme: "dark" }) },
                { value: "light", label: t("settings.light"), active: settings.theme === "light", icon: <Sun size={17} />, onClick: () => updateSettings({ theme: "light" }) },
                { value: "system", label: t("settings.system"), active: settings.theme === "system", icon: <Monitor size={17} />, onClick: () => updateSettings({ theme: "system" }) },
              ]}
            />
          ) : null}

          {stepIndex === 3 ? (
            <section className="onboarding-panel">
              <span className="onboarding-panel__icon"><Cpu size={22} /></span>
              <h2 id="onboarding-title">{t("onboarding.aiSetup")}</h2>
              <p>{t("onboarding.aiDescription")}</p>
              <div className="setup-status-row">
                <span className={`status-pill status-pill--${ollamaStatus?.status === "connected" ? "connected" : "model-missing"}`}>
                  {isCheckingOllama ? t("settings.checkingOllama") : formatOllamaStatus(ollamaStatus, t)}
                </span>
                <button className="button button--secondary" onClick={() => void refreshOllamaStatus()} type="button">
                  {isCheckingOllama ? <Loader2 size={16} className="spin-icon" /> : null}
                  {t("settings.refreshModels")}
                </button>
              </div>
              {installedModels.length ? (
                <label className="onboarding-field">
                  <span>{t("settings.installedModel")}</span>
                  <select value={settings.localModel} onChange={(event) => updateSettings({ localModel: event.target.value })}>
                    {installedModels.map((model) => (
                      <option value={model.name} key={model.name}>{model.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="model-install-list">
                  {onboardingModels.map((model) => (
                    <button className="button button--secondary" disabled={Boolean(installingModel) || ollamaStatus?.status === "not-installed"} key={model} onClick={() => void installModel(model)} type="button">
                      {installingModel === model ? <Loader2 size={16} className="spin-icon" /> : <Download size={16} />}
                      {t("settings.installModel")} {model}
                    </button>
                  ))}
                </div>
              )}
              {modelInstallStatus ? <p className="settings-helper-inline">{modelInstallStatus}</p> : null}
            </section>
          ) : null}

          {stepIndex === 4 ? (
            <section className="onboarding-panel">
              <span className="onboarding-panel__icon"><Bell size={22} /></span>
              <h2 id="onboarding-title">{t("onboarding.notifications")}</h2>
              <p>{t("onboarding.notificationsDescription")}</p>
              <label className="toggle-row onboarding-toggle">
                <span>
                  <strong>{t("settings.enableNotifications")}</strong>
                  <small>{t("settings.notificationsDescription")}</small>
                </span>
                <input checked={settings.notifications} onChange={(event) => updateSettings({ notifications: event.target.checked })} type="checkbox" />
              </label>
              <label className="onboarding-field">
                <span>{t("settings.defaultReminder")}</span>
                <select value={settings.defaultReminderMinutes} onChange={(event) => updateSettings({ defaultReminderMinutes: Number(event.target.value) as ReminderOffsetMinutes })}>
                  <option value={0}>{t("settings.reminderAtTime")}</option>
                  <option value={5}>{t("settings.reminder5")}</option>
                  <option value={10}>{t("settings.reminder10")}</option>
                  <option value={30}>{t("settings.reminder30")}</option>
                  <option value={60}>{t("settings.reminder60")}</option>
                </select>
              </label>
            </section>
          ) : null}

          {stepIndex === 5 ? (
            <section className="onboarding-panel">
              <span className="onboarding-panel__icon"><Plus size={22} /></span>
              <h2 id="onboarding-title">{t("onboarding.firstTask")}</h2>
              <p>{t("onboarding.firstTaskDescription")}</p>
              <input
                className="onboarding-task-input"
                value={firstTaskTitle}
                onChange={(event) => setFirstTaskTitle(event.target.value)}
                placeholder={t("onboarding.firstTaskPlaceholder")}
                autoFocus
              />
            </section>
          ) : null}
        </div>

        <div className="onboarding-card__footer">
          <button className="button button--secondary" disabled={stepIndex === 0} onClick={previousStep} type="button">
            {t("onboarding.back")}
          </button>
          {stepIndex === steps.length - 1 ? (
            <div className="onboarding-final-actions">
              <button className="button button--secondary" onClick={() => finishOnboarding(true)} type="button">
                {t("onboarding.skipTask")}
              </button>
              <button className="button button--primary" onClick={() => finishOnboarding(false)} type="button">
                <Check size={16} />
                {t("onboarding.finish")}
              </button>
            </div>
          ) : (
            <button className="button button--primary" onClick={nextStep} type="button">
              {t("onboarding.continue")}
            </button>
          )}
        </div>
      </section>
    </div>
  );
}

function WelcomeStep({ titleId }: { titleId: string }) {
  const { t } = useI18n();
  return (
    <section className="onboarding-panel onboarding-panel--welcome">
      <span className="onboarding-panel__icon"><Sparkles size={24} /></span>
      <h2 id={titleId}>{t("onboarding.welcomeTitle")}</h2>
      <p>{t("onboarding.welcomeDescription")}</p>
    </section>
  );
}

function ChoiceStep({
  title,
  description,
  icon,
  options,
}: {
  title: string;
  description: string;
  icon: ReactNode;
  options: Array<{ value: string; label: string; active: boolean; icon?: ReactNode; onClick: () => void }>;
}) {
  return (
    <section className="onboarding-panel">
      <span className="onboarding-panel__icon">{icon}</span>
      <h2 id="onboarding-title">{title}</h2>
      <p>{description}</p>
      <div className="onboarding-choice-grid">
        {options.map((option) => (
          <button className={`onboarding-choice ${option.active ? "onboarding-choice--active" : ""}`} key={option.value} onClick={option.onClick} type="button">
            {option.icon}
            <span>{option.label}</span>
            {option.active ? <Check size={16} /> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function formatOllamaStatus(status: OllamaSetupStatus | null, t: ReturnType<typeof useI18n>["t"]) {
  if (!status) return t("settings.checkingOllama");
  if (status.status === "connected") return t("settings.connected");
  if (status.status === "model-missing") return t("settings.modelMissing");
  if (status.status === "not-installed") return t("settings.notInstalled");
  return t("settings.notRunning");
}
