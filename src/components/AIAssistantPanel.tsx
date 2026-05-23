import { AlertTriangle, Bot, CheckCircle2, CornerDownLeft, Loader2, RotateCcw, Sparkles, Trash2, UserRound } from "lucide-react";
import { FormEvent, useState } from "react";
import { useI18n, type TranslationKey } from "../i18n";
import { applyAssistantAction } from "../services/aiActions";
import { AIProviderError, chatWithAssistant, type AssistantAction } from "../services/aiService";
import type { AIMode, AssistantMessage, Project, Task, TaskDraft, UserSettings } from "../types";
import { formatScheduleLabel } from "../utils/date";

interface AIAssistantPanelProps {
  addProject: (project: Omit<Project, "id">) => Project;
  addTask: (task: TaskDraft) => Task;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void;
  messages: AssistantMessage[];
  projects: Project[];
  setMessages: (messages: AssistantMessage[]) => void;
  settings: UserSettings;
  tasks: Task[];
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
};

export function AIAssistantPanel({
  addProject,
  addTask,
  onUpdateTask,
  messages,
  projects,
  setMessages,
  settings,
  tasks,
}: AIAssistantPanelProps) {
  const { language, t } = useI18n();
  const [mode, setMode] = useState<AIMode>("plan_day");
  const [input, setInput] = useState("");
  const [isThinking, setIsThinking] = useState(false);
  const [pendingRetry, setPendingRetry] = useState<string | null>(null);
  const [pendingAction, setPendingAction] = useState<AssistantAction | null>(null);
  const [confirmClear, setConfirmClear] = useState(false);

  async function sendMessage(content: string) {
    const trimmed = content.trim();
    if (!trimmed || isThinking) return;

    const userMessage: AssistantMessage = {
      id: `message-${Date.now()}-user`,
      role: "user",
      content: trimmed,
      createdAt: new Date().toISOString(),
    };
    const nextMessages = [...messages, userMessage];
    setMessages(nextMessages);
    setInput("");
    setPendingRetry(null);
    setPendingAction(null);
    setIsThinking(true);

    try {
      const result = await chatWithAssistant(trimmed, tasks, settings, mode);
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
      setPendingRetry(trimmed);
      setMessages([
        ...nextMessages,
        {
          id: `message-${Date.now()}-error`,
          role: "error",
          content: aiError,
          createdAt: new Date().toISOString(),
          metadata: {
            errorCode: error instanceof AIProviderError ? error.code : "unknown",
            retryPrompt: trimmed,
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
      const actionResult = applyAssistantAction(pendingAction, { addProject, addTask, projects, updateTask: onUpdateTask });
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

  return (
    <section className="assistant-panel">
      <div className="assistant-panel__intro">
        <div className="assistant-panel__mark">
          <Sparkles size={20} />
        </div>
        <div>
          <h2>{t("assistant.title")}</h2>
          <p>{t("assistant.description")}</p>
        </div>
        <button className="button button--secondary assistant-clear" onClick={() => setConfirmClear(true)} type="button">
          <Trash2 size={16} />
          {t("assistant.clearHistory")}
        </button>
      </div>

      <div className="assistant-modes" role="tablist" aria-label={t("assistant.modeLabel")}>
        {(Object.keys(modeMeta) as AIMode[]).map((item) => (
          <button
            className={`assistant-mode ${mode === item ? "assistant-mode--active" : ""}`}
            disabled={isThinking}
            key={item}
            onClick={() => {
              setMode(item);
              setPendingAction(null);
            }}
            role="tab"
            type="button"
            aria-selected={mode === item}
          >
            <strong>{t(modeMeta[item].title)}</strong>
            <span>{t(modeMeta[item].description)}</span>
          </button>
        ))}
      </div>

      <div className="chat-thread" aria-live="polite">
        {messages.map((message) => (
          <ChatMessage key={message.id} message={message} onRetry={message.metadata?.retryPrompt ? () => void sendMessage(message.metadata?.retryPrompt ?? "") : undefined} />
        ))}
        {isThinking && (
          <article className="chat-message chat-message--assistant">
            <div className="chat-message__avatar">
              <Bot size={16} />
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
            <button className="button button--primary" onClick={applyPendingTasks} type="button">
              <CheckCircle2 size={16} />
              {t("assistant.createTasks")}
            </button>
          </div>
          <div className="assistant-task-preview__grid">
            {pendingAction.tasks.map((task, index) => (
              <article className="assistant-task-preview__card" key={`${task.title}-${index}`}>
                <strong>{task.title}</strong>
                {task.description ? <p>{task.description}</p> : null}
                <span>{formatScheduleLabel(task.scheduledAt ?? null, scheduleLabels, language)}</span>
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
            <button className="button button--primary" onClick={applyPendingTasks} type="button">
              <CheckCircle2 size={16} />
              {t("assistant.applyPlan")}
            </button>
          </div>
          <div className="assistant-task-preview__grid">
            {pendingAction.changes.map((change) => {
              const task = tasks.find((item) => item.id === change.taskId);
              return (
                <article className="assistant-task-preview__card" key={`${change.taskId}-${change.scheduledAt}`}>
                  <strong>{task?.title ?? change.taskId}</strong>
                  <span>{formatScheduleLabel(change.scheduledAt, scheduleLabels, language)}</span>
                  <span>{change.durationMinutes ?? task?.durationMinutes ?? 30} min</span>
                  {change.reason ? <p>{change.reason}</p> : null}
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

      <form className="assistant-input" onSubmit={handleSubmit}>
        <input
          disabled={isThinking}
          value={input}
          onChange={(event) => setInput(event.target.value)}
          placeholder={t(modeMeta[mode].placeholder)}
        />
        <button className="button button--primary" disabled={isThinking || !input.trim()} type="submit">
          {isThinking ? <Loader2 size={16} className="spin-icon" /> : <CornerDownLeft size={16} />}
          {t("assistant.send")}
        </button>
      </form>

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
    </section>
  );
}

function ChatMessage({ message, onRetry }: { message: AssistantMessage; onRetry?: () => void }) {
  const { t } = useI18n();
  const Icon = message.role === "user" ? UserRound : message.role === "error" ? AlertTriangle : message.role === "action" ? CheckCircle2 : Bot;

  return (
    <article className={`chat-message chat-message--${message.role}`}>
      <div className="chat-message__avatar">
        <Icon size={16} />
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
  return t("assistant.tasksCreated");
}

function formatReminder(value: number, t: (key: TranslationKey) => string) {
  if (value === 0) return t("settings.reminderAtTime");
  if (value === 5) return t("settings.reminder5");
  if (value === 10) return t("settings.reminder10");
  if (value === 30) return t("settings.reminder30");
  return t("settings.reminder60");
}
