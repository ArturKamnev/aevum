import { Bot, CalendarDays, Check, ChevronDown, Clock3, Loader2, Pencil, Repeat2, Save, Sparkles, Trash2, X } from "lucide-react";
import { useState } from "react";
import { ProjectBadge } from "./Badges";
import { useI18n } from "../i18n";
import { AIProviderError } from "../services/aiService";
import type { Project, Subtask, Task } from "../types";
import { formatScheduleLabel } from "../utils/date";
import { describeRepeat } from "../utils/recurrence";

interface TaskCardProps {
  task: Task;
  project?: Project;
  onToggleTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void;
  onToggleSubtask: (taskId: string, subtaskId: string) => void;
  onBreakDownTask?: (task: Task) => Promise<string[]>;
  onEditTask?: (task: Task) => void;
}

export function TaskCard({
  task,
  project,
  onToggleTask,
  onDeleteTask,
  onUpdateTask,
  onToggleSubtask,
  onBreakDownTask,
  onEditTask,
}: TaskCardProps) {
  const { language, t } = useI18n();
  const [isEditing, setIsEditing] = useState(false);
  const [draftTitle, setDraftTitle] = useState(task.title);
  const [isExpanded, setIsExpanded] = useState(task.subtasks.length > 0);
  const [isBreakingDown, setIsBreakingDown] = useState(false);
  const [subtaskPreview, setSubtaskPreview] = useState<string[]>([]);
  const [breakdownError, setBreakdownError] = useState("");
  const completedSubtasks = task.subtasks.filter((subtask) => subtask.completed).length;

  function startEditing() {
    setDraftTitle(task.title);
    setIsEditing(true);
  }

  function saveTitle() {
    const trimmed = draftTitle.trim();
    if (trimmed && trimmed !== task.title) {
      onUpdateTask(task.id, { title: trimmed });
    }
    setIsEditing(false);
  }

  async function handleBreakDown() {
    if (!onBreakDownTask || isBreakingDown) return;
    setBreakdownError("");
    setSubtaskPreview([]);
    setIsBreakingDown(true);
    try {
      const subtasks = await onBreakDownTask(task);
      setSubtaskPreview(subtasks);
    } catch (error) {
      if (import.meta.env.DEV) {
      console.error("[Aevum] Failed to break down task", error);
      }
      setBreakdownError(formatBreakdownError(error, t));
    } finally {
      setIsBreakingDown(false);
    }
  }

  function applySubtaskPreview() {
    try {
      const newSubtasks: Subtask[] = subtaskPreview.map((title) => ({
        id: `subtask-${Date.now()}-${crypto.randomUUID()}`,
        title,
        completed: false,
      }));
      onUpdateTask(task.id, { subtasks: [...task.subtasks, ...newSubtasks] });
      setSubtaskPreview([]);
      setBreakdownError("");
      setIsExpanded(true);
    } catch (error) {
      if (import.meta.env.DEV) {
        console.error("[Aevum] Failed to save subtasks", error);
      }
      setBreakdownError(t("assistant.couldNotSaveSubtasks"));
    }
  }

  return (
    <article className={`task-card ${task.status === "completed" ? "task-card--completed" : ""}`}>
      <button className="task-check" onClick={() => onToggleTask(task.id)} aria-label={t("task.markComplete")}>
        <Check size={15} />
      </button>

      <div className="task-card__body">
        <div className="task-card__header">
          {isEditing ? (
            <input
              className="task-card__edit"
              value={draftTitle}
              onChange={(event) => setDraftTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === "Enter") saveTitle();
                if (event.key === "Escape") setIsEditing(false);
              }}
              autoFocus
            />
          ) : (
            <button className="task-card__title" onClick={startEditing}>
              {task.title}
            </button>
          )}
          <div className="task-card__actions">
            {isEditing ? (
              <>
                <button className="icon-button" onClick={saveTitle} aria-label={t("task.save")} type="button">
                  <Save size={16} />
                </button>
                <button className="icon-button" onClick={() => setIsEditing(false)} aria-label={t("settings.cancel")} type="button">
                  <X size={16} />
                </button>
              </>
            ) : null}
            {onBreakDownTask ? (
              <button className="icon-button" disabled={isBreakingDown} onClick={() => void handleBreakDown()} aria-label={t("task.breakDownWithAI")} title={t("task.breakDownWithAI")} type="button">
                {isBreakingDown ? <Loader2 size={16} className="spin-icon" /> : <Bot size={16} />}
              </button>
            ) : null}
            {onEditTask ? (
              <button className="icon-button" onClick={() => onEditTask(task)} aria-label={t("task.editTask")} type="button">
                <Pencil size={16} />
              </button>
            ) : null}
            <button className="icon-button" onClick={() => setIsExpanded((value) => !value)} aria-label={t("task.toggleSubtasks")}>
              <ChevronDown size={16} className={isExpanded ? "icon-rotated" : ""} />
            </button>
            <button className="icon-button icon-button--danger" onClick={() => onDeleteTask(task.id)} aria-label={t("task.delete")}>
              <Trash2 size={16} />
            </button>
          </div>
        </div>

        {task.description && <p className="task-card__description">{task.description}</p>}

        <div className="task-card__meta">
          <span className="date-chip">
            <CalendarDays size={14} />
            {formatScheduleLabel(
              task.scheduledAt,
              { noDate: t("date.noDate"), overdue: t("date.overdue"), today: t("date.today"), tomorrow: t("date.tomorrow") },
              language,
            )}
          </span>
          <ProjectBadge project={project} />
          {task.durationMinutes ? (
            <span className="date-chip">
              <Clock3 size={14} />
              {formatDuration(task.durationMinutes)}
            </span>
          ) : null}
          {task.repeat.enabled ? (
            <span className="date-chip">
              <Repeat2 size={14} />
              {formatRepeat(task, t)}
            </span>
          ) : null}
          {task.tags.map((tag) => (
            <span className="tag-chip" key={tag}>
              {tag}
            </span>
          ))}
        </div>

        {task.subtasks.length > 0 && (
          <div className={`subtasks ${isExpanded ? "subtasks--expanded" : ""}`}>
            <div className="subtasks__summary">
              <span>{completedSubtasks} {t("task.of")} {task.subtasks.length} {t("task.subtasks")}</span>
              <span className="subtasks__bar">
                <span style={{ width: `${(completedSubtasks / task.subtasks.length) * 100}%` }} />
              </span>
            </div>
            {isExpanded && (
              <div className="subtasks__list">
                {task.subtasks.map((subtask) => (
                  <label className="subtask" key={subtask.id}>
                    <input
                      checked={subtask.completed}
                      onChange={() => onToggleSubtask(task.id, subtask.id)}
                      type="checkbox"
                    />
                    <span>{subtask.title}</span>
                  </label>
                ))}
              </div>
            )}
          </div>
        )}

        {subtaskPreview.length > 0 && (
          <div className="ai-preview">
            <div className="ai-preview__header">
              <span>
                <Sparkles size={14} />
                {t("task.subtaskPreview")}
              </span>
              <button className="icon-button" onClick={() => setSubtaskPreview([])} type="button" aria-label={t("settings.cancel")}>
                <X size={15} />
              </button>
            </div>
            <ul>
              {subtaskPreview.map((title) => (
                <li key={title}>{title}</li>
              ))}
            </ul>
            <button className="button button--primary" onClick={applySubtaskPreview} type="button">
              <Check size={15} />
              {t("task.applySubtasks")}
            </button>
          </div>
        )}

        {breakdownError && <p className="task-card__error">{breakdownError}</p>}
      </div>
    </article>
  );
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function formatBreakdownError(error: unknown, t: ReturnType<typeof useI18n>["t"]) {
  if (error instanceof AIProviderError) {
    if (error.code === "openrouter_missing_key") return t("settings.openRouterMissingKey");
    if (error.code === "openrouter_invalid_key") return error.message || t("settings.openRouterInvalidKey");
    if (error.code === "openrouter_billing_issue") return error.message || t("settings.openRouterBillingIssue");
    if (error.code === "openrouter_model_unavailable") return error.message || t("settings.openRouterModelUnavailable");
    if (error.code === "openrouter_rate_limited") return error.message || t("settings.openRouterRateLimited");
    if (error.code === "openrouter_offline") return t("settings.openRouterOffline");
    if (error.code === "openrouter_provider_error") return error.message || t("settings.openRouterProviderError");
    if (error.code === "invalid_ai_response") return t("assistant.responseError");
    if (error.code === "model_missing") return error.message;
    if (error.code === "ollama_not_running") return t("settings.ollamaNotRunning");
  }
  return t("assistant.responseError");
}

function formatRepeat(task: Task, t: ReturnType<typeof useI18n>["t"]) {
  return describeRepeat(task.repeat, {
    everyDay: t("task.repeat.everyDay"),
    everyWeekday: t("task.repeat.everyWeekday"),
    everyWeekend: t("task.repeat.everyWeekend"),
    everyDayExcept: (days) => `${t("task.repeat.everyDay")} ${t("task.repeatExcept").toLowerCase()} ${formatWeekdayList(days, t)}`,
    everyWeekdayName: (day) => getWeekdayRepeatLabel(day, t),
    customWeekdays: t("task.repeat.customWeekdays"),
    customInterval: `${t("task.repeatEvery")} ${task.repeat.interval} ${unitLabel(task.repeat.unit, t)}`,
    noRepeat: t("task.repeat.none"),
  });
}

function formatWeekdayList(days: number[], t: ReturnType<typeof useI18n>["t"]) {
  return days.map((day) => getWeekdayShortLabel(day, t)).join(", ");
}

function getWeekdayRepeatLabel(day: number, t: ReturnType<typeof useI18n>["t"]) {
  const keys = [
    "task.repeat.everySunday",
    "task.repeat.everyMonday",
    "task.repeat.everyTuesday",
    "task.repeat.everyWednesday",
    "task.repeat.everyThursday",
    "task.repeat.everyFriday",
    "task.repeat.everySaturday",
  ] as const;
  return t(keys[day]);
}

function getWeekdayShortLabel(day: number, t: ReturnType<typeof useI18n>["t"]) {
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

function unitLabel(unit: Task["repeat"]["unit"], t: ReturnType<typeof useI18n>["t"]) {
  if (unit === "week") return t("task.repeat.weeks");
  if (unit === "month") return t("task.repeat.months");
  return t("task.repeat.days");
}
