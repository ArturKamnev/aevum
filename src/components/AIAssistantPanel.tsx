import { AlertTriangle, ArrowUp, Bot, CalendarClock, CheckCircle2, ChevronDown, Loader2, Pencil, Plus, RotateCcw, Trash2, UserRound } from "lucide-react";
import { FormEvent, useEffect, useRef, useState, KeyboardEvent, type ReactNode } from "react";
import { useI18n, type TranslationKey } from "../i18n";
import { applyAssistantAction } from "../services/aiActions";
import { AIProviderError, chatWithAssistant, type AssistantAction, type ManageTaskOperation } from "../services/aiService";
import type { AIMode, AssistantMessage, Project, Task, TaskDraft, UserSettings, ViewId } from "../types";
import { formatScheduleLabel } from "../utils/date";
import aevumLogoDark from "../../media/aevum-logo-dark.png";
import aevumLogoLight from "../../media/aevum-logo-light.png";

interface AIAssistantPanelProps {
  addProject: (project: Omit<Project, "id">) => Project;
  addTask: (task: TaskDraft) => Task;
  onDeleteTask: (taskId: string) => void;
  onSetTaskStatus: (taskId: string, status: Task["status"]) => void;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void;
  messages: AssistantMessage[];
  projects: Project[];
  setMessages: (messages: AssistantMessage[]) => void;
  settings: UserSettings;
  tasks: Task[];
  updateSettings: (updates: Partial<UserSettings>) => void;
  setActiveView?: (view: ViewId) => void;
}

const modeMeta: Record<AIMode, { title: TranslationKey; description: TranslationKey; placeholder: TranslationKey }> = {
  plan_day: {
    title: "assistant.mode.planDay",
    description: "assistant.mode.planDayDescription",
    placeholder: "assistant.placeholder.planDay",
  },
  create_tasks: {
    title: "assistant.mode.createTasks",
    description: "assistant.mode.createTasksDescription",
    placeholder: "assistant.placeholder.createTasks",
  },
  replan_tasks: {
    title: "assistant.mode.replanTasks",
    description: "assistant.mode.replanTasksDescription",
    placeholder: "assistant.placeholder.replanTasks",
  },
  manage_tasks: {
    title: "assistant.mode.manageTasks",
    description: "assistant.mode.manageTasksDescription",
    placeholder: "assistant.placeholder.manageTasks",
  },
};

const openRouterModelOptions = [
  {
    id: "openrouter/free",
    labelKey: "settings.openRouterAutoFreeModel" as const,
  },
  {
    id: "deepseek/deepseek-v4-flash:free",
    labelKey: "settings.openRouterDeepseekModel" as const,
  },
] as const;

export function AIAssistantPanel({
  addProject,
  addTask,
  onDeleteTask,
  onSetTaskStatus,
  onUpdateTask,
  messages,
  projects,
  setMessages,
  settings,
  tasks,
  updateSettings,
  setActiveView,
}: AIAssistantPanelProps) {
  const { language, t } = useI18n();
  const [activeTool, setActiveTool] = useState<AIMode | null>(null);
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [pendingRetry, setPendingRetry] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<AssistantAction | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);
  const [showToolsDropdown, setShowToolsDropdown] = useState(false);
  const [isComposerFocused, setIsComposerFocused] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement>(null);

  const [panelState, setPanelState] = useState<"empty" | "leaving-empty" | "conversation">(
    messages.length === 0 ? "empty" : "conversation"
  );

  useEffect(() => {
    if (messages.length === 0) {
      setPanelState("empty");
    } else {
      if (panelState === "empty") {
        setPanelState("leaving-empty");
        const timer = setTimeout(() => {
          setPanelState("conversation");
        }, 600);
        return () => clearTimeout(timer);
      } else if (panelState !== "leaving-empty") {
        setPanelState("conversation");
      }
    }
  }, [messages.length, panelState]);

  const [ollamaStatus, setOllamaStatus] = useState<OllamaSetupStatus | null>(null);
  const [hasOpenRouterKey, setHasOpenRouterKey] = useState(false);
  const [showModelDropdown, setShowModelDropdown] = useState(false);
  const [showOllamaSetup, setShowOllamaSetup] = useState(false);
  const [ollamaLoading, setOllamaLoading] = useState(false);
  const [showOpenRouterSetup, setShowOpenRouterSetup] = useState(false);
  const [openRouterKeyInput, setOpenRouterKeyInput] = useState("");
  const [selectedModelToSetup, setSelectedModelToSetup] = useState<string | null>(null);
  const [setupError, setSetupError] = useState("");
  const [setupLoading, setSetupLoading] = useState(false);

  const activeModel = settings.aiProvider === "openrouter" ? settings.cloudModel : settings.localModel;

  const truncateModelName = (name: string) => {
    const clean = name.replace(/^openrouter\//, "").replace(/:latest$/, "");
    return clean.length > 18 ? clean.slice(0, 16) + "..." : clean;
  };

  const getOllamaStatusKey = (status: "connected" | "model-missing" | "not-running" | "not-installed"): TranslationKey => {
    if (status === "connected") return "settings.connected";
    if (status === "model-missing") return "settings.modelMissing";
    if (status === "not-running") return "settings.notRunning";
    return "settings.notInstalled";
  };

  const checkStatus = async () => {
    if (!window.todoAI) return;
    try {
      const status = await window.todoAI.checkOllamaStatus(settings.localModel, settings.aiBaseUrl);
      setOllamaStatus(status);
    } catch (e) {
      console.error("[Aevum] Failed to fetch Ollama status", e);
    }
    try {
      const keyResult = await window.todoAI.hasOpenRouterApiKey();
      setHasOpenRouterKey(Boolean(keyResult?.hasKey));
    } catch (e) {
      console.error("[Aevum] Failed to check OpenRouter API key status", e);
    }
  };

  useEffect(() => {
    void checkStatus();
  }, [settings.localModel, settings.aiBaseUrl]);

  useEffect(() => {
    const handleGlobalKeyDown = (e: globalThis.KeyboardEvent) => {
      if (e.key === "Escape") {
        setShowModelDropdown(false);
      }
    };
    window.addEventListener("keydown", handleGlobalKeyDown);
    return () => window.removeEventListener("keydown", handleGlobalKeyDown);
  }, []);

  const adjustTextareaHeight = () => {
    const textarea = textareaRef.current;
    if (!textarea) return;
    textarea.style.height = "auto";
    textarea.style.height = `${Math.min(textarea.scrollHeight, 120)}px`;
  };

  useEffect(() => {
    adjustTextareaHeight();
  }, [input]);

  const handleKeyDown = (event: KeyboardEvent<HTMLTextAreaElement>) => {
    if (event.key === "Enter" && !event.shiftKey) {
      event.preventDefault();
      if (input.trim() && !isThinking) {
        void sendMessage(input);
      }
    }
  };

  async function sendMessage(content: string) {
    const hasText = content.trim();
    if (!hasText || isThinking) return;
    const originalContent = content;

    const userMessage: AssistantMessage = {
      id: `message-${Date.now()}-user`,
      role: "user",
      content: originalContent,
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setPendingRetry(null);
    setPendingAction(null);
    setIsThinking(true);

    try {
      const result = await chatWithAssistant(originalContent, tasks, settings, activeTool, projects);
      if (result.action) {
        setPendingAction(result.action);
      }
      setMessages([...nextMessages, result.message]);
    } catch (error) {
      const aiError = normalizeAIError(error, t);
      console.error("[Aevum] Assistant request failed", {
        provider: settings.aiProvider,
        baseUrl: settings.aiBaseUrl,
        model: settings.aiProvider === "openrouter" ? settings.cloudModel : settings.localModel,
        message: aiError,
      });
      setPendingRetry(originalContent);
      setMessages([
        ...nextMessages,
        {
          id: `message-${Date.now()}-error`,
          role: "error",
          content: aiError,
          createdAt: new Date().toISOString(),
          metadata: {
            errorCode: error instanceof AIProviderError ? error.code : "unknown",
            retryPrompt: originalContent,
          },
        },
      ]);
    } finally {
      setIsThinking(false);
    }
  }

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    void sendMessage(input);
  }

  function applyPendingTasks() {
    if (!pendingAction) return;
    try {
      const actionResult = applyAssistantAction(pendingAction, {
        addProject,
        addTask,
        deleteTask: onDeleteTask,
        projects,
        setTaskStatus: onSetTaskStatus,
        tasks,
        updateTask: onUpdateTask,
      });
      setMessages([
        ...messages,
        {
          id: `message-${Date.now()}-action`,
          role: actionResult.ok ? "action" : "error",
          content: actionResult.ok ? getAppliedMessage(pendingAction, t) : t("assistant.couldNotSaveTask"),
          createdAt: new Date().toISOString(),
          metadata: { actionType: pendingAction.type },
        },
      ]);
      if (actionResult.ok) {
        setPendingAction(null);
      }
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error("[Aevum] Failed to save AI-created tasks", error);
      }
      setMessages([
        ...messages,
        {
          id: `message-${Date.now()}-save-error`,
          role: "error",
          content: pendingAction.type === "schedule_tasks" ? t("assistant.couldNotSavePlan") : t("assistant.couldNotSaveTask"),
          createdAt: new Date().toISOString(),
          metadata: { actionType: pendingAction.type },
        },
      ]);
    }
  }

  function clearHistory() {
    setMessages([]);
    setPendingAction(null);
    setConfirmClear(false);
  }

  const scheduleLabels = { noDate: t("date.noDate"), overdue: t("date.overdue"), today: t("date.today"), tomorrow: t("date.tomorrow") };
  const isEmpty = messages.length === 0;
  const isMultiline = input.includes("\n") || input.length > 50;

  return (
    <section className={`assistant-panel assistant-panel--${panelState}`}>
      <div className="assistant-workspace">
        <div className="assistant-conversation-area">
          {!isEmpty && (
            <div className="assistant-conversation-header">
              <span className="assistant-conversation-header__title">{t("assistant.title")}</span>
              <button className="assistant-clear-ghost" onClick={() => setConfirmClear(true)} type="button" title={t("assistant.clearHistory")}>
                <Trash2 size={14} />
                <span>{t("assistant.clearHistory")}</span>
              </button>
            </div>
          )}

          <div className="chat-thread" aria-live="polite">
            {messages.map((message) => (
              <ChatMessage key={message.id} message={message} onRetry={message.metadata?.retryPrompt ? () => void sendMessage(message.metadata?.retryPrompt ?? "") : undefined} />
            ))}
            {isThinking && (
              <article className="chat-message chat-message--assistant">
                <div className="chat-message__avatar">
                  <div className="brand-logo" aria-hidden="true" style={{ width: "100%", height: "100%" }}>
                    <img className="brand-logo__image brand-logo__image--dark" src={aevumLogoDark} alt="" />
                    <img className="brand-logo__image brand-logo__image--light" src={aevumLogoLight} alt="" />
                  </div>
                </div>
                <div className="thinking">
                  <Loader2 size={15} />
                  {t("assistant.thinking")}
                </div>
              </article>
            )}
          </div>

          {pendingAction?.type === "create_tasks" && (
            <div className="assistant-task-preview">
              <div className="assistant-task-preview__header">
                <div>
                  <strong>{t("assistant.taskPreviewTitle")}</strong>
                  <span>{t("assistant.taskPreviewDescription")}</span>
                </div>
                <div className="assistant-task-preview__actions">
                  <button className="button button--secondary" onClick={() => setPendingAction(null)} type="button">
                    {t("assistant.cancelPreview")}
                  </button>
                  <button className="button button--primary" onClick={applyPendingTasks} type="button">
                    <CheckCircle2 size={16} />
                    {t("assistant.createTasks")}
                  </button>
                </div>
              </div>
              <div className="assistant-task-preview__grid">
                {pendingAction.tasks.map((task, index) => (
                  <article className="assistant-task-preview__card" key={`${task.title}-${index}`} style={{ "--index": index } as React.CSSProperties}>
                    <strong>{task.title}</strong>
                    {task.description ? <p>{task.description}</p> : null}
                    <span>{formatScheduleLabel(task.scheduledAt ?? null, scheduleLabels, language, settings.timeFormat)}</span>
                    {task.durationMinutes ? <span>{task.durationMinutes} min</span> : null}
                    {task.reminderMinutes !== null && task.reminderMinutes !== undefined ? <span>{formatReminder(task.reminderMinutes, t)}</span> : null}
                    {task.projectName ? <span>{task.projectName}</span> : null}
                  </article>
                ))}
              </div>
            </div>
          )}

          {pendingAction?.type === "schedule_tasks" && (
            <div className="assistant-task-preview">
              <div className="assistant-task-preview__header">
                <div>
                  <strong>{pendingAction.mode === "replan_tasks" ? t("assistant.replanPreviewTitle") : t("assistant.planPreviewTitle")}</strong>
                  <span>{t("assistant.planPreviewDescription")}</span>
                </div>
                <div className="assistant-task-preview__actions">
                  <button className="button button--secondary" onClick={() => setPendingAction(null)} type="button">
                    {t("assistant.cancelPreview")}
                  </button>
                  <button className="button button--primary" onClick={applyPendingTasks} type="button">
                    <CheckCircle2 size={16} />
                    {t("assistant.applyPlan")}
                  </button>
                </div>
              </div>
              <div className="assistant-task-preview__grid">
                {pendingAction.changes.map((change, index) => {
                  const task = tasks.find((item) => item.id === change.taskId);
                  return (
                    <article className="assistant-task-preview__card" key={`${change.taskId}-${change.scheduledAt}`} style={{ "--index": index } as React.CSSProperties}>
                      <strong>{task?.title ?? change.taskId}</strong>
                      <span>{formatScheduleLabel(change.scheduledAt, scheduleLabels, language, settings.timeFormat)}</span>
                      <span>{change.durationMinutes ?? task?.durationMinutes ?? 30} min</span>
                      {change.reason ? <p>{change.reason}</p> : null}
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {pendingAction?.type === "manage_tasks" && (
            <div className="assistant-task-preview assistant-task-preview--manage">
              <div className="assistant-task-preview__header">
                <div>
                  <strong>{t("assistant.managePreviewTitle")}</strong>
                  <span>{t("assistant.managePreviewDescription")}</span>
                </div>
                <div className="assistant-task-preview__actions">
                  <button className="button button--secondary" onClick={() => setPendingAction(null)} type="button">
                    {t("assistant.cancelPreview")}
                  </button>
                  <button className="button button--primary" onClick={applyPendingTasks} type="button">
                    <CheckCircle2 size={16} />
                    {t("assistant.applyChanges")}
                  </button>
                </div>
              </div>
              <div className="assistant-manage-preview__list">
                {pendingAction.operations.map((operation, index) => {
                  const task = tasks.find((item) => item.id === operation.taskId);
                  const isDelete = operation.operation === "delete";
                  const Icon = isDelete ? Trash2 : operation.operation === "set_status" ? CheckCircle2 : operation.changes.scheduledAt !== undefined ? CalendarClock : Pencil;
                  return (
                    <article className={`assistant-manage-preview__item ${isDelete ? "assistant-manage-preview__item--danger" : ""}`} key={`${operation.operation}-${operation.taskId}-${index}`} style={{ "--index": index } as React.CSSProperties}>
                      <div className="assistant-manage-preview__icon">
                        <Icon size={16} />
                      </div>
                      <div className="assistant-manage-preview__content">
                        <div className="assistant-manage-preview__title">
                          <strong>{task?.title ?? t("assistant.taskUnavailable")}</strong>
                          <span>{getManageOperationLabel(operation.operation, t)}</span>
                        </div>
                        {task ? (
                          <div className="assistant-manage-preview__changes">
                            {renderManageOperationChanges(operation, task, projects, scheduleLabels, language, settings.timeFormat, t)}
                          </div>
                        ) : (
                          <p>{t("assistant.taskUnavailableDescription")}</p>
                        )}
                        {operation.reason ? <p>{operation.reason}</p> : null}
                      </div>
                    </article>
                  );
                })}
              </div>
            </div>
          )}

          {pendingRetry && (
            <div className="assistant-error-strip">
              <AlertTriangle size={16} />
              <span>{t("assistant.error")}</span>
              <button className="button button--secondary" disabled={isThinking} onClick={() => void sendMessage(pendingRetry)}>
                <RotateCcw size={15} />
                {t("assistant.retry")}
              </button>
            </div>
          )}
        </div>

        <div className="assistant-empty-spacer assistant-empty-spacer--top" />

        <h2 className="assistant-hero-title">{t("assistant.emptyStateTitle")}</h2>

        <div className="composer-outer">
          <div className={`composer-ambient-glow composer-ambient-glow--${panelState} ${isComposerFocused ? "composer-ambient-glow--focused" : ""}`} aria-hidden="true" />
          <form className={`composer-container ${isComposerFocused ? "composer-container--focused" : ""} ${isMultiline ? "composer-container--multiline" : ""}`} onSubmit={handleSubmit}>
            <div className="composer-tools-area">
              <div className="composer-tool-select">
                <button
                  className="composer-tool-btn"
                  type="button"
                  onClick={() => setShowToolsDropdown(!showToolsDropdown)}
                  title={t("assistant.modeLabel")}
                >
                  <Plus size={16} />
                  {activeTool === null && <span>{t("assistant.toolsLabel")}</span>}
                  <ChevronDown size={14} />
                </button>
                {showToolsDropdown && (
                  <>
                    <div className="composer-dropdown-backdrop" onClick={() => setShowToolsDropdown(false)} />
                    <div className="composer-tool-dropdown">
                      {(["create_tasks", "plan_day", "manage_tasks"] as AIMode[]).map((item) => (
                        <button
                          className={`composer-tool-item ${activeTool === item ? "composer-tool-item--active" : ""}`}
                          key={item}
                          onClick={() => {
                            setActiveTool(item);
                            setPendingAction(null);
                            setShowToolsDropdown(false);
                          }}
                          type="button"
                        >
                          <strong>{t(modeMeta[item].title)}</strong>
                          <span>{t(modeMeta[item].description)}</span>
                        </button>
                      ))}
                    </div>
                  </>
                )}
              </div>

              {activeTool !== null && (
                <div className="composer-active-chip">
                  <span>{t(modeMeta[activeTool].title)}</span>
                  <button
                    type="button"
                    className="composer-active-chip__remove"
                    onClick={() => {
                      setActiveTool(null);
                      setPendingAction(null);
                    }}
                    title={t("assistant.removeTool")}
                  >
                    ×
                  </button>
                </div>
              )}
            </div>

            <textarea
              ref={textareaRef}
              disabled={isThinking}
              value={input}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={handleKeyDown}
              onFocus={() => setIsComposerFocused(true)}
              onBlur={() => setIsComposerFocused(false)}
              placeholder={activeTool === null ? t("assistant.placeholder.guide") : t(modeMeta[activeTool].placeholder)}
              rows={1}
            />

            <div className="composer-actions-area">
              <div className="composer-model-select">
                <button
                  type="button"
                  className="composer-model-badge"
                  onClick={() => {
                    const nextShow = !showModelDropdown;
                    setShowModelDropdown(nextShow);
                    if (nextShow) {
                      void checkStatus();
                    }
                  }}
                  title={activeModel}
                >
                  {truncateModelName(activeModel)}
                </button>
                {showModelDropdown && (
                  <>
                    <div className="composer-dropdown-backdrop" onClick={() => setShowModelDropdown(false)} />
                    <div className="composer-model-dropdown">
                      <div className="composer-model-dropdown__group-title">
                        {t("assistant.model.localModels")}
                      </div>
                      
                      {ollamaStatus?.status === "connected" && ollamaStatus.models.length > 0 ? (
                        ollamaStatus.models.map((model) => {
                          const isActive = settings.aiProvider === "ollama" && settings.localModel === model.name;
                          return (
                            <button
                              key={model.name}
                              type="button"
                              className={`composer-model-item ${isActive ? "composer-model-item--active" : ""}`}
                              onClick={() => {
                                updateSettings({
                                  aiProvider: "ollama",
                                  localModel: model.name
                                });
                                setShowModelDropdown(false);
                              }}
                            >
                              <span style={{ overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: "150px" }} title={model.name}>
                                {model.name}
                              </span>
                              <span className="composer-model-item__meta">
                                {t("settings.localAI").split(" ")[0]}
                              </span>
                            </button>
                          );
                        })
                      ) : (
                        <button
                          type="button"
                          className="composer-model-item composer-model-item--action"
                          onClick={() => {
                            setShowModelDropdown(false);
                            setShowOllamaSetup(true);
                          }}
                        >
                          <span style={{ color: "var(--danger)" }}>
                            {ollamaStatus ? t(`settings.${ollamaStatus.status === "not-running" ? "notRunning" : ollamaStatus.status === "not-installed" ? "notInstalled" : "modelMissing"}`) : t("assistant.model.checkingOllama")}
                          </span>
                          <span className="composer-model-item__meta" style={{ color: "var(--danger)", borderColor: "var(--danger)" }}>
                            !
                          </span>
                        </button>
                      )}

                      <div className="composer-model-dropdown__divider" />

                      <div className="composer-model-dropdown__group-title">
                        {t("assistant.model.cloudModels")}
                      </div>
                      <p className="composer-model-dropdown__note">{t("settings.openRouterFreeModelNote")}</p>
                      
                      {openRouterModelOptions.map((option) => {
                        const isActive = settings.aiProvider === "openrouter" && settings.cloudModel === option.id;
                        return (
                          <button
                            key={option.id}
                            type="button"
                            className={`composer-model-item ${isActive ? "composer-model-item--active" : ""}`}
                            onClick={async () => {
                              setShowModelDropdown(false);
                              if (hasOpenRouterKey) {
                                updateSettings({
                                  aiProvider: "openrouter",
                                  cloudModel: option.id
                                });
                              } else {
                                setSelectedModelToSetup(option.id);
                                setShowOpenRouterSetup(true);
                              }
                            }}
                          >
                            <span>{t(option.labelKey)}</span>
                            <span className="composer-model-item__meta">
                              {t("settings.cloudAI").split(" ")[0]}
                            </span>
                          </button>
                        );
                      })}

                      {setActiveView && (
                        <>
                          <div className="composer-model-dropdown__divider" />
                          <button
                            type="button"
                            className="composer-model-item composer-model-item--action"
                            onClick={() => {
                              setShowModelDropdown(false);
                              setActiveView("settings");
                            }}
                          >
                            <span>{t("assistant.model.configureAI")}</span>
                          </button>
                        </>
                      )}
                    </div>
                  </>
                )}
              </div>
              <button className="composer-send-btn" disabled={isThinking || !input.trim()} type="submit" title={t("assistant.send")}>
                {isThinking ? <Loader2 size={16} className="spin-icon" /> : <ArrowUp size={16} />}
              </button>
            </div>
          </form>
          <p className="composer-disclaimer">
            {language === "ru"
              ? "ИИ может допускать ошибки, так как приложение находится в бета-тестировании."
              : "AI can make mistakes while the app is in beta testing."}
          </p>
        </div>

        <div className="assistant-empty-spacer assistant-empty-spacer--bottom" />
      </div>

      {confirmClear && (
        <div className="confirm-overlay" role="presentation" onMouseDown={() => setConfirmClear(false)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="clear-ai-history-title" onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="clear-ai-history-title">{t("settings.confirmClearHistoryTitle")}</h2>
            <p>{t("settings.confirmClearHistoryDescription")}</p>
            <div className="confirm-dialog__actions">
              <button className="button button--secondary" onClick={() => setConfirmClear(false)}>
                {t("settings.cancel")}
              </button>
              <button className="button button--primary" onClick={clearHistory}>
                {t("settings.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showOpenRouterSetup && (
        <div className="confirm-overlay" role="presentation" onMouseDown={() => setShowOpenRouterSetup(false)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="openrouter-setup-title" onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="openrouter-setup-title">{t("assistant.model.connectOpenRouter")}</h2>
            <p>{t("assistant.model.enterApiKey")}</p>
            <input
              type="password"
              placeholder="sk-or-v1-..."
              className="settings-key-input"
              value={openRouterKeyInput}
              onChange={(e) => setOpenRouterKeyInput(e.target.value)}
              style={{
                width: "100%",
                padding: "8px 12px",
                borderRadius: "var(--radius-md)",
                border: "1px solid var(--border)",
                background: "var(--surface)",
                color: "var(--text)",
                marginTop: "8px",
                marginBottom: "12px",
                outline: "none"
              }}
              autoFocus
            />
            {setupError && (
              <p className="task-card__error" style={{ margin: "0 0 12px 0", fontSize: "var(--font-sm)" }}>
                {setupError}
              </p>
            )}
            <div className="confirm-dialog__actions">
              <button className="button button--secondary" onClick={() => setShowOpenRouterSetup(false)} disabled={setupLoading}>
                {t("settings.cancel")}
              </button>
              <button
                className="button button--primary"
                onClick={async () => {
                  setSetupError("");
                  setSetupLoading(true);
                  try {
                    const result = await window.todoAI?.setOpenRouterApiKey(openRouterKeyInput.trim());
                    if (result?.ok) {
                      setHasOpenRouterKey(true);
                      updateSettings({
                        aiProvider: "openrouter",
                        cloudModel: selectedModelToSetup || settings.cloudModel
                      });
                      setShowOpenRouterSetup(false);
                      setOpenRouterKeyInput("");
                    } else {
                      setSetupError(result?.message || t("settings.openRouterInvalidKey"));
                    }
                  } catch (err) {
                    setSetupError(t("settings.ollamaUnexpected"));
                  } finally {
                    setSetupLoading(false);
                  }
                }}
                disabled={setupLoading || !openRouterKeyInput.trim()}
              >
                {setupLoading ? <Loader2 size={16} className="spin-icon" /> : t("task.save")}
              </button>
            </div>
          </div>
        </div>
      )}

      {showOllamaSetup && (
        <div className="confirm-overlay" role="presentation" onMouseDown={() => setShowOllamaSetup(false)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="ollama-setup-title" onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="ollama-setup-title">{t("settings.aiSetup")}</h2>
            
            <div style={{ margin: "12px 0", display: "flex", flexDirection: "column", gap: "12px" }}>
              <div className="setup-status-row" style={{ display: "flex", justifyContent: "space-between", alignItems: "center" }}>
                <span className={`status-pill status-pill--${ollamaStatus?.status === "connected" ? "connected" : "model-missing"}`}>
                  {ollamaStatus ? t(getOllamaStatusKey(ollamaStatus.status)) : t("settings.checkingOllama")}
                </span>
                <button
                  className="button button--secondary"
                  disabled={ollamaLoading}
                  onClick={async () => {
                    setOllamaLoading(true);
                    await checkStatus();
                    setOllamaLoading(false);
                  }}
                  type="button"
                >
                  {ollamaLoading ? <Loader2 size={14} className="spin-icon" /> : t("settings.refreshModels")}
                </button>
              </div>

              {ollamaStatus?.status === "not-installed" && (
                <div className="setup-help-box">
                  <strong>{t("settings.ollamaMissingTitle")}</strong>
                  <p style={{ margin: "4px 0 8px 0", fontSize: "var(--font-sm)", color: "var(--text-soft)" }}>
                    {t("settings.ollamaMissingDescription")}
                  </p>
                  <button
                    className="button button--primary"
                    onClick={() => void window.todoAI?.openOllamaDownload()}
                    type="button"
                  >
                    {t("settings.installOllama")}
                  </button>
                </div>
              )}

              {ollamaStatus?.status === "not-running" && (
                <div className="setup-help-box">
                  <strong>{t("settings.ollamaNotRunningTitle")}</strong>
                  <p style={{ margin: "4px 0 8px 0", fontSize: "var(--font-sm)", color: "var(--text-soft)" }}>
                    {t("settings.ollamaNotRunningDescription")}
                  </p>
                  <button
                    className="button button--primary"
                    disabled={ollamaLoading}
                    onClick={async () => {
                      setOllamaLoading(true);
                      await window.todoAI?.startOllama();
                      window.setTimeout(async () => {
                        await checkStatus();
                        setOllamaLoading(false);
                      }, 1500);
                    }}
                    type="button"
                  >
                    {ollamaLoading ? <Loader2 size={14} className="spin-icon" /> : t("settings.startOllama")}
                  </button>
                </div>
              )}

              {(ollamaStatus?.status === "connected" || ollamaStatus?.status === "model-missing") && ollamaStatus?.models.length === 0 && (
                <div className="setup-help-box">
                  <strong>{t("assistant.model.ollamaUnavailable")}</strong>
                  <p style={{ margin: "4px 0 8px 0", fontSize: "var(--font-sm)", color: "var(--text-soft)" }}>
                    Ollama is running, but no models are installed. Please configure models in settings.
                  </p>
                </div>
              )}
            </div>

            <div className="confirm-dialog__actions" style={{ marginTop: "16px" }}>
              <button className="button button--secondary" onClick={() => setShowOllamaSetup(false)}>
                {t("settings.cancel")}
              </button>
              {setActiveView && (
                <button
                  className="button button--primary"
                  onClick={() => {
                    setActiveView("settings");
                    setShowOllamaSetup(false);
                  }}
                >
                  {t("assistant.model.configureAI")}
                </button>
              )}
            </div>
          </div>
        </div>
      )}
    </section>
  );
}

function ChatMessage({ message, onRetry }: { message: AssistantMessage; onRetry?: () => void }) {
  const { t } = useI18n();
  const Icon = message.role === "user" ? UserRound : message.role === "error" ? AlertTriangle : message.role === "action" ? CheckCircle2 : Bot;

  return (
    <article className={`chat-message chat-message--${message.role}`}>
      <div className="chat-message__avatar">
        {message.role === "assistant" ? (
          <div className="brand-logo" aria-hidden="true" style={{ width: "100%", height: "100%" }}>
            <img className="brand-logo__image brand-logo__image--dark" src={aevumLogoDark} alt="" />
            <img className="brand-logo__image brand-logo__image--light" src={aevumLogoLight} alt="" />
          </div>
        ) : (
          <Icon size={16} />
        )}
      </div>
      <div className="chat-message__bubble">
        <p>{message.content}</p>
        {message.role === "error" && onRetry && (
          <button className="button button--secondary" onClick={onRetry}>
            <RotateCcw size={15} />
            {t("assistant.retry")}
          </button>
        )}
      </div>
    </article>
  );
}

function normalizeAIError(error: unknown, t: (key: TranslationKey) => string) {
  if (error instanceof AIProviderError) {
    if (error.code === "ollama_not_running") return t("settings.ollamaNotRunning");
    if (error.code === "model_missing") return error.message;
    if (error.code === "cors_blocked") return t("settings.ollamaCors");
    if (error.code === "unexpected_response") return t("settings.ollamaUnexpected");
    if (error.code === "invalid_ai_response") return t("assistant.responseError");
    if (error.code === "openrouter_missing_key") return t("settings.openRouterMissingKey");
    if (error.code === "openrouter_invalid_key") return error.message || t("settings.openRouterInvalidKey");
    if (error.code === "openrouter_billing_issue") return error.message || t("settings.openRouterBillingIssue");
    if (error.code === "openrouter_model_unavailable") return error.message || t("settings.openRouterModelUnavailable");
    if (error.code === "openrouter_rate_limited") return error.message || t("settings.openRouterRateLimited");
    if (error.code === "openrouter_offline") return t("settings.openRouterOffline");
    if (error.code === "openrouter_provider_error") return error.message || t("settings.openRouterProviderError");
    return t("settings.ollamaWrongUrl");
  }

  return error instanceof Error ? error.message : t("settings.ollamaUnexpected");
}

function getAppliedMessage(action: AssistantAction, t: (key: TranslationKey) => string) {
  if (action.type === "schedule_tasks") return t("assistant.planApplied");
  if (action.type === "manage_tasks") return t("assistant.changesApplied");
  return t("assistant.tasksCreated");
}

function getManageOperationLabel(operation: ManageTaskOperation["operation"], t: (key: TranslationKey) => string) {
  if (operation === "delete") return t("assistant.manageDelete");
  if (operation === "set_status") return t("assistant.manageStatus");
  return t("assistant.manageUpdate");
}

function renderManageOperationChanges(
  operation: ManageTaskOperation,
  task: Task,
  projects: Project[],
  scheduleLabels: { noDate: string; overdue: string; today: string; tomorrow: string },
  language: UserSettings["language"],
  timeFormat: UserSettings["timeFormat"],
  t: (key: TranslationKey) => string,
) {
  if (operation.operation === "delete") {
    return (
      <span className="assistant-manage-preview__line assistant-manage-preview__line--danger">
        {t("assistant.manageDeleteWarning")} {formatScheduleLabel(task.scheduledAt, scheduleLabels, language, timeFormat)}
      </span>
    );
  }

  if (operation.operation === "set_status") {
    return (
      <span className="assistant-manage-preview__line">
        {formatStatus(task.status, t)} -&gt; {formatStatus(operation.status, t)}
      </span>
    );
  }

  const rows: ReactNode[] = [];
  const changes = operation.changes;
  const pushRow = (key: string, label: string, before: string, after: string) => {
    rows.push(
      <span className="assistant-manage-preview__line" key={key}>
        <b>{label}</b>
        <span>{before || t("assistant.emptyValue")} -&gt; {after || t("assistant.emptyValue")}</span>
      </span>,
    );
  };

  if (changes.title !== undefined) pushRow("title", t("task.title"), task.title, changes.title);
  if (changes.description !== undefined) pushRow("description", t("task.description"), task.description, changes.description);
  if (changes.scheduledAt !== undefined) {
    pushRow("scheduledAt", t("settings.schedule"), formatScheduleLabel(task.scheduledAt, scheduleLabels, language, timeFormat), formatScheduleLabel(changes.scheduledAt, scheduleLabels, language, timeFormat));
  }
  if (changes.durationMinutes !== undefined) pushRow("duration", t("task.duration"), formatDurationPreview(task.durationMinutes, t), formatDurationPreview(changes.durationMinutes, t));
  if (changes.reminderMinutes !== undefined) pushRow("reminder", t("task.reminder"), formatReminderPreview(task.reminderMinutes, t), formatReminderPreview(changes.reminderMinutes, t));
  if (changes.projectId !== undefined) pushRow("project", t("task.project"), formatProjectName(task.projectId, projects, t), formatProjectName(changes.projectId, projects, t));

  return rows;
}

function formatStatus(status: Task["status"], t: (key: TranslationKey) => string) {
  return status === "completed" ? t("task.completed") : t("task.active");
}

function formatDurationPreview(value: number | null, t: (key: TranslationKey) => string) {
  return value ? `${value} min` : t("task.noDuration");
}

function formatReminderPreview(value: number | null, t: (key: TranslationKey) => string) {
  return value === null ? t("task.reminderDefault") : formatReminder(value, t);
}

function formatProjectName(projectId: string, projects: Project[], t: (key: TranslationKey) => string) {
  return projects.find((project) => project.id === projectId)?.name ?? t("task.project");
}

function formatReminder(value: number, t: (key: TranslationKey) => string) {
  if (value === 0) return t("settings.reminderAtTime");
  if (value === 5) return t("settings.reminder5");
  if (value === 10) return t("settings.reminder10");
  if (value === 30) return t("settings.reminder30");
  return t("settings.reminder60");
}
