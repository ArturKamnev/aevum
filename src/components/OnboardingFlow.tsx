import { useGSAP } from "@gsap/react";
import gsap from "gsap";
import { ArrowRight, Bell, Check, Cpu, Download, KeyRound, Languages, Loader2, Moon, Plus, Sun, Monitor } from "lucide-react";
import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useI18n } from "../i18n";
import type { Language, Project, ReminderOffsetMinutes, TaskDraft, UserSettings } from "../types";
import { defaultRepeat } from "../utils/recurrence";
import aevumLogoDark from "../../media/aevum-logo-dark.png";
import aevumLogoLight from "../../media/aevum-logo-light.png";

gsap.registerPlugin(useGSAP);

interface OnboardingFlowProps {
  projects: Project[];
  settings: UserSettings;
  updateSettings: (updates: Partial<UserSettings>) => void;
  onAddTask: (task: TaskDraft) => void;
  onComplete: () => void;
}

import recommendedModelsJson from "../../electron/recommended_models.json";

const onboardingModels = recommendedModelsJson.recommendedModels.map((m) => m.name);
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

export function OnboardingFlow({ projects, settings, updateSettings, onAddTask, onComplete }: OnboardingFlowProps) {
  const { language, setLanguage, t } = useI18n();
  const rootRef = useRef<HTMLDivElement>(null);
  const openRouterKeyRef = useRef<HTMLInputElement>(null);
  const glowFrameRef = useRef<number | null>(null);
  const isStepTransitioningRef = useRef(false);
  const [stepIndex, setStepIndex] = useState(0);
  const [isStepTransitioning, setIsStepTransitioning] = useState(false);
  const [ollamaStatus, setOllamaStatus] = useState<OllamaSetupStatus | null>(null);
  const [isCheckingOllama, setIsCheckingOllama] = useState(false);
  const [installingModel, setInstallingModel] = useState("");
  const [modelInstallStatus, setModelInstallStatus] = useState("");
  const [openRouterStatus, setOpenRouterStatus] = useState("");
  const [isTestingOpenRouter, setIsTestingOpenRouter] = useState(false);
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

  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;
    const rootElement = root;
    const reduceMotionQuery = window.matchMedia("(prefers-reduced-motion: reduce)");
    const finePointerQuery = window.matchMedia("(hover: hover) and (pointer: fine)");
    const glow = {
      x: rootElement.clientWidth / 2,
      y: rootElement.clientHeight * 0.48,
      targetX: rootElement.clientWidth / 2,
      targetY: rootElement.clientHeight * 0.48,
      stretch: 0,
      rotation: 0,
    };

    function setGlowPosition(x: number, y: number, stretch: number, rotation: number) {
      rootElement.style.setProperty("--onboarding-droplet-x", `${x}px`);
      rootElement.style.setProperty("--onboarding-droplet-y", `${y}px`);
      rootElement.style.setProperty("--onboarding-droplet-scale-x", `${1 + stretch}`);
      rootElement.style.setProperty("--onboarding-droplet-scale-y", `${1 - stretch * 0.36}`);
      rootElement.style.setProperty("--onboarding-droplet-rotate", `${rotation}deg`);
    }

    function tick() {
      const deltaX = glow.targetX - glow.x;
      const deltaY = glow.targetY - glow.y;
      glow.x += deltaX * 0.075;
      glow.y += deltaY * 0.075;

      const speed = Math.hypot(deltaX, deltaY);
      const targetStretch = Math.min(speed / 1500, 0.13);
      glow.stretch += (targetStretch - glow.stretch) * 0.16;
      if (speed > 0.7) {
        glow.rotation += ((Math.atan2(deltaY, deltaX) * 180) / Math.PI - glow.rotation) * 0.18;
      }

      setGlowPosition(glow.x, glow.y, glow.stretch, glow.rotation);

      if (speed > 0.08 || glow.stretch > 0.003) {
        glowFrameRef.current = window.requestAnimationFrame(tick);
      } else {
        glow.stretch = 0;
        setGlowPosition(glow.x, glow.y, 0, glow.rotation);
        glowFrameRef.current = null;
      }
    }

    function scheduleGlow() {
      if (glowFrameRef.current === null) {
        glowFrameRef.current = window.requestAnimationFrame(tick);
      }
    }

    function handlePointerMove(event: PointerEvent) {
      if (reduceMotionQuery.matches || !finePointerQuery.matches) return;
      const rect = rootElement.getBoundingClientRect();
      glow.targetX = event.clientX - rect.left;
      glow.targetY = event.clientY - rect.top;
      scheduleGlow();
    }

    function handlePointerLeave() {
      glow.targetX = rootElement.clientWidth / 2;
      glow.targetY = rootElement.clientHeight * 0.48;
      scheduleGlow();
    }

    function handleResize() {
      if (finePointerQuery.matches) return;
      glow.x = rootElement.clientWidth / 2;
      glow.y = rootElement.clientHeight * 0.48;
      glow.targetX = glow.x;
      glow.targetY = glow.y;
      setGlowPosition(glow.x, glow.y, 0, 0);
    }

    function handleMotionPreference() {
      if (!reduceMotionQuery.matches) return;
      if (glowFrameRef.current !== null) {
        window.cancelAnimationFrame(glowFrameRef.current);
        glowFrameRef.current = null;
      }
      glow.x = rootElement.clientWidth / 2;
      glow.y = rootElement.clientHeight * 0.48;
      glow.targetX = glow.x;
      glow.targetY = glow.y;
      glow.stretch = 0;
      glow.rotation = 0;
      setGlowPosition(glow.x, glow.y, 0, 0);
    }

    setGlowPosition(glow.x, glow.y, 0, 0);
    root.addEventListener("pointermove", handlePointerMove);
    root.addEventListener("pointerleave", handlePointerLeave);
    window.addEventListener("resize", handleResize);
    reduceMotionQuery.addEventListener("change", handleMotionPreference);
    handleMotionPreference();

    return () => {
      root.removeEventListener("pointermove", handlePointerMove);
      root.removeEventListener("pointerleave", handlePointerLeave);
      window.removeEventListener("resize", handleResize);
      reduceMotionQuery.removeEventListener("change", handleMotionPreference);
      if (glowFrameRef.current !== null) {
        window.cancelAnimationFrame(glowFrameRef.current);
        glowFrameRef.current = null;
      }
    };
  }, []);

  useGSAP(() => {
    const root = rootRef.current;
    if (!root) return;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (reduceMotion) {
      gsap.set(".onboarding-animated", { autoAlpha: 1, y: 0, scale: 1, filter: "none" });
      gsap.set(".onboarding-ambient-glow", { autoAlpha: 0.58, "--onboarding-droplet-reveal-scale": 1 });
      return;
    }

    if (stepIndex === 0) {
      const timeline = gsap.timeline({ defaults: { ease: "power3.out" } });
      gsap.set(".onboarding-welcome-logo", { autoAlpha: 0, y: 34, scale: 0.94, filter: "blur(14px)" });
      gsap.set(".onboarding-ambient-glow", { autoAlpha: 0, "--onboarding-droplet-reveal-scale": 0.68 });
      gsap.set([".onboarding-welcome-title", ".onboarding-welcome-description", ".onboarding-primary-action"], { autoAlpha: 0, y: 14 });
      timeline
        .to(".onboarding-welcome-logo", { autoAlpha: 1, y: 0, scale: 1.018, filter: "blur(0px)", duration: 0.78 })
        .to(".onboarding-welcome-logo", { scale: 1, duration: 0.34, ease: "power2.out" }, "-=0.22")
        .to(".onboarding-ambient-glow", { autoAlpha: 0.68, "--onboarding-droplet-reveal-scale": 1, duration: 0.96, ease: "power2.out" }, "-=0.08")
        .to([".onboarding-welcome-title", ".onboarding-welcome-description"], { autoAlpha: 1, y: 0, duration: 0.46, stagger: 0.09 }, "-=0.34")
        .to(".onboarding-primary-action", { autoAlpha: 1, y: 0, duration: 0.38 }, "+=0.08");
      return;
    }

    gsap.set(".onboarding-ambient-glow", { autoAlpha: 0.54, "--onboarding-droplet-reveal-scale": 1 });
    const timeline = gsap.timeline({ defaults: { ease: "power3.out", overwrite: "auto" } });
    timeline
      .fromTo(".onboarding-motion-heading", { autoAlpha: 0, y: 10, scale: 0.994 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.24 })
      .fromTo(".onboarding-motion-copy", { autoAlpha: 0, y: 8 }, { autoAlpha: 1, y: 0, duration: 0.22 }, "-=0.14")
      .fromTo(".onboarding-motion-icon", { autoAlpha: 0, y: 6, scale: 0.97 }, { autoAlpha: 1, y: 0, scale: 1, duration: 0.2 }, "<")
      .fromTo(
        ".onboarding-motion-control",
        { autoAlpha: 0, y: 10, scale: 0.994 },
        { autoAlpha: 1, y: 0, scale: 1, duration: 0.22, stagger: 0.03 },
        "-=0.12",
      );
  }, { dependencies: [stepIndex], scope: rootRef, revertOnUpdate: true });

  useEffect(() => {
    if (stepIndex === 3 && settings.aiProvider === "ollama") void refreshOllamaStatus();
  }, [settings.aiProvider, stepIndex]);

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

  async function saveOpenRouterKey() {
    const input = openRouterKeyRef.current;
    const value = input?.value.trim() ?? "";
    if (input) input.value = "";
    const saved = await window.todoAI?.setOpenRouterApiKey(value);
    if (!saved?.ok) {
      setOpenRouterStatus(t("settings.openRouterInvalidKey"));
      return;
    }
    setOpenRouterStatus(t("settings.openRouterKeySaved"));
  }

  async function testOpenRouterConnection() {
    setIsTestingOpenRouter(true);
    setOpenRouterStatus(t("settings.testingConnection"));
    try {
      const tested = await window.todoAI?.testOpenRouterConnection(settings.cloudModel);
      setOpenRouterStatus(tested?.ok ? t("settings.connected") : tested?.message ?? t("settings.openRouterOffline"));
    } finally {
      setIsTestingOpenRouter(false);
    }
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
        reminderMinutes: null,
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
    goToStep(Math.min(stepIndex + 1, steps.length - 1));
  }

  function previousStep() {
    goToStep(Math.max(stepIndex - 1, 0));
  }

  function goToStep(nextIndex: number) {
    const targetIndex = Math.min(Math.max(nextIndex, 0), steps.length - 1);
    if (targetIndex === stepIndex || isStepTransitioningRef.current) return;

    const root = rootRef.current;
    const reduceMotion = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    if (!root || reduceMotion) {
      setStepIndex(targetIndex);
      return;
    }

    const direction = targetIndex > stepIndex ? -1 : 1;
    const targets = stepIndex === 0
      ? root.querySelectorAll(".onboarding-welcome-logo, .onboarding-welcome-title, .onboarding-welcome-description, .onboarding-primary-action")
      : root.querySelectorAll(".onboarding-step__content .onboarding-animated");

    isStepTransitioningRef.current = true;
    setIsStepTransitioning(true);
    gsap.to(targets, {
      autoAlpha: 0,
      y: 10 * direction,
      scale: 0.992,
      filter: stepIndex === 0 ? "blur(7px)" : "none",
      duration: stepIndex === 0 ? 0.3 : 0.16,
      ease: "power2.in",
      stagger: { each: 0.022, from: "end" },
      overwrite: "auto",
      onComplete: () => {
        setStepIndex(targetIndex);
        window.requestAnimationFrame(() => {
          isStepTransitioningRef.current = false;
          setIsStepTransitioning(false);
        });
      },
    });
  }

  const isWelcomeStep = stepIndex === 0;
  const setupStepCount = steps.length - 1;
  const setupStepNumber = Math.max(1, stepIndex);
  const progress = (setupStepNumber / setupStepCount) * 100;

  return (
    <div className={`onboarding-overlay ${isWelcomeStep ? "onboarding-overlay--welcome" : "onboarding-overlay--setup"} ${isStepTransitioning ? "onboarding-overlay--transitioning" : ""}`} ref={rootRef}>
      <div className="onboarding-ambient" aria-hidden="true">
        <span className="onboarding-ambient-glow onboarding-animated" />
      </div>
      <main className="onboarding-shell" aria-labelledby="onboarding-title">
        {isWelcomeStep ? (
          <WelcomeStep titleId="onboarding-title" onContinue={nextStep} />
        ) : (
          <>
            <div className="onboarding-chrome">
              <div>
                <span className="onboarding-kicker">{t("onboarding.firstSetup")}</span>
                <strong>{steps[stepIndex]}</strong>
              </div>
              <div className="onboarding-chrome__actions">
                <span>{setupStepNumber}/{setupStepCount}</span>
                <button className="text-button" disabled={isStepTransitioning} onClick={() => finishOnboarding(true)} type="button">
                  {t("onboarding.skip")}
                </button>
              </div>
            </div>
            <div className="onboarding-progress" aria-hidden="true">
              <span style={{ width: `${progress}%` }} />
            </div>

            <div className="onboarding-step__content">

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
              <span className="onboarding-panel__icon onboarding-motion-icon onboarding-animated"><Cpu size={22} /></span>
              <h2 className="onboarding-motion-heading onboarding-animated" id="onboarding-title">{t("onboarding.aiSetup")}</h2>
              <p className="onboarding-motion-copy onboarding-animated">{t("onboarding.aiDescription")}</p>
              <div className="segmented-control onboarding-motion-control onboarding-animated">
                <button className={settings.aiProvider === "ollama" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"} onClick={() => updateSettings({ aiProvider: "ollama" })} type="button">
                  <Cpu size={15} />
                  {t("settings.localAI")}
                </button>
                <button className={settings.aiProvider === "openrouter" ? "segmented-control__item segmented-control__item--active" : "segmented-control__item"} onClick={() => updateSettings({ aiProvider: "openrouter" })} type="button">
                  <KeyRound size={15} />
                  {t("settings.cloudAI")}
                </button>
              </div>
              {settings.aiProvider === "openrouter" ? (
                <>
                  <label className="onboarding-field onboarding-motion-control onboarding-animated">
                    <span>{t("settings.openRouterApiKey")}</span>
                    <input ref={openRouterKeyRef} type="password" placeholder="sk-or-v1-..." autoComplete="off" />
                  </label>
                  <label className="onboarding-field onboarding-motion-control onboarding-animated">
                    <span>{t("settings.cloudModel")}</span>
                    <select value={settings.cloudModel} onChange={(event) => updateSettings({ cloudModel: event.target.value })}>
                      {openRouterModelOptions.map((option) => (
                        <option key={option.id} value={option.id}>
                          {t(option.labelKey)}{option.recommended ? ` (${t("settings.recommended")})` : ""}
                        </option>
                      ))}
                    </select>
                  </label>
                  <p className="settings-helper-inline onboarding-motion-control onboarding-animated">
                    {t(openRouterModelOptions.find((option) => option.id === settings.cloudModel)?.descriptionKey ?? "settings.openRouterAutoFreeModelDescription")}
                  </p>
                  <p className="settings-helper-inline onboarding-motion-control onboarding-animated">{t("settings.openRouterFreeModelNote")}</p>
                  <div className="onboarding-action-row onboarding-motion-control onboarding-animated">
                    <button className="button button--primary" onClick={() => void saveOpenRouterKey()} type="button">
                      <KeyRound size={16} />
                      {t("settings.saveApiKey")}
                    </button>
                    <button className="button button--secondary" disabled={isTestingOpenRouter} onClick={() => void testOpenRouterConnection()} type="button">
                      {isTestingOpenRouter ? <Loader2 size={16} className="spin-icon" /> : <Check size={16} />}
                      {t("settings.testConnection")}
                    </button>
                  </div>
                  {openRouterStatus ? <p className="settings-helper-inline">{openRouterStatus}</p> : null}
                </>
              ) : (
                <>
              <div className="setup-status-row onboarding-motion-control onboarding-animated">
                <span className={`status-pill status-pill--${ollamaStatus?.status === "connected" ? "connected" : "model-missing"}`}>
                  {isCheckingOllama ? t("settings.checkingOllama") : formatOllamaStatus(ollamaStatus, t)}
                </span>
                <button className="button button--secondary" onClick={() => void refreshOllamaStatus()} type="button">
                  {isCheckingOllama ? <Loader2 size={16} className="spin-icon" /> : null}
                  {t("settings.refreshModels")}
                </button>
              </div>
              {installedModels.length ? (
                <label className="onboarding-field onboarding-motion-control onboarding-animated">
                  <span>{t("settings.installedModel")}</span>
                  <select value={settings.localModel} onChange={(event) => updateSettings({ localModel: event.target.value })}>
                    {installedModels.map((model) => (
                      <option value={model.name} key={model.name}>{model.name}</option>
                    ))}
                  </select>
                </label>
              ) : (
                <div className="model-install-list onboarding-motion-control onboarding-animated">
                  {onboardingModels.map((model) => (
                    <button className="button button--secondary" disabled={Boolean(installingModel) || ollamaStatus?.status === "not-installed"} key={model} onClick={() => void installModel(model)} type="button">
                      {installingModel === model ? <Loader2 size={16} className="spin-icon" /> : <Download size={16} />}
                      {t("settings.installModel")} {model}
                    </button>
                  ))}
                </div>
              )}
              {modelInstallStatus ? <p className="settings-helper-inline onboarding-motion-control onboarding-animated">{modelInstallStatus}</p> : null}
                </>
              )}
            </section>
          ) : null}

          {stepIndex === 4 ? (
            <section className="onboarding-panel">
              <span className="onboarding-panel__icon onboarding-motion-icon onboarding-animated"><Bell size={22} /></span>
              <h2 className="onboarding-motion-heading onboarding-animated" id="onboarding-title">{t("onboarding.notifications")}</h2>
              <p className="onboarding-motion-copy onboarding-animated">{t("onboarding.notificationsDescription")}</p>
              <label className="toggle-row onboarding-toggle onboarding-motion-control onboarding-animated">
                <span>
                  <strong>{t("settings.enableNotifications")}</strong>
                  <small>{t("settings.notificationsDescription")}</small>
                </span>
                <input checked={settings.notifications} onChange={(event) => updateSettings({ notifications: event.target.checked })} type="checkbox" />
              </label>
              <label className="onboarding-field onboarding-motion-control onboarding-animated">
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
              <span className="onboarding-panel__icon onboarding-motion-icon onboarding-animated"><Plus size={22} /></span>
              <h2 className="onboarding-motion-heading onboarding-animated" id="onboarding-title">{t("onboarding.firstTask")}</h2>
              <p className="onboarding-motion-copy onboarding-animated">{t("onboarding.firstTaskDescription")}</p>
              <input
                className="onboarding-task-input onboarding-motion-control onboarding-animated"
                value={firstTaskTitle}
                onChange={(event) => setFirstTaskTitle(event.target.value)}
                placeholder={t("onboarding.firstTaskPlaceholder")}
                autoFocus
              />
            </section>
          ) : null}
            </div>

            <div className="onboarding-card__footer">
              <button className="button button--secondary" disabled={isStepTransitioning} onClick={previousStep} type="button">
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
                <button className="button button--primary" disabled={isStepTransitioning} onClick={nextStep} type="button">
                  {t("onboarding.continue")}
                  <ArrowRight size={16} />
                </button>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function WelcomeStep({ titleId, onContinue }: { titleId: string; onContinue: () => void }) {
  const { t } = useI18n();
  return (
    <section className="onboarding-welcome">
      <span className="onboarding-welcome-logo onboarding-panel__logo onboarding-animated" aria-hidden="true">
        <img className="brand-logo__image brand-logo__image--dark" src={aevumLogoDark} alt="" />
        <img className="brand-logo__image brand-logo__image--light" src={aevumLogoLight} alt="" />
      </span>
      <div className="onboarding-welcome-copy">
        <h2 className="onboarding-welcome-title onboarding-animated" id={titleId}>{t("onboarding.welcomeTitle")}</h2>
        <p className="onboarding-welcome-description onboarding-animated">{t("onboarding.welcomeDescription")}</p>
        <button className="onboarding-primary-action onboarding-animated" onClick={onContinue} type="button">
          {t("onboarding.continue")}
          <ArrowRight size={16} />
        </button>
      </div>
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
      <span className="onboarding-panel__icon onboarding-motion-icon onboarding-animated">{icon}</span>
      <h2 className="onboarding-motion-heading onboarding-animated" id="onboarding-title">{title}</h2>
      <p className="onboarding-motion-copy onboarding-animated">{description}</p>
      <div className="onboarding-choice-grid onboarding-motion-control onboarding-animated">
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
