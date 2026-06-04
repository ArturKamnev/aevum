import { FolderKanban, Inbox, ListChecks, Plus, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import { AIAssistantPanel } from "./components/AIAssistantPanel";
import { AppShell } from "./components/AppShell";
import { CalendarView } from "./components/CalendarView";
import { CommandPalette } from "./components/CommandPalette";
import { Dashboard } from "./components/Dashboard";
import { SettingsPage } from "./components/SettingsPage";
import { OnboardingFlow } from "./components/OnboardingFlow";
import { TaskModal } from "./components/TaskModal";
import { TaskList } from "./components/TaskList";
import { VisualizationView } from "./components/VisualizationView";
import { initialMessages } from "./data/sampleData";
import { useTheme } from "./hooks/useTheme";
import { useI18n } from "./i18n";
import {
  cancelAIActionProposal,
  confirmAIActionProposal,
  createAIActionProposal,
  createAIActionProposalLedger,
  createAIActionUndoConflictAuditEntry,
  createUndoAIActionTransaction,
  type AIActionAuditEntry,
  type AIActionConfirmResult,
  type AIActionProposal,
  type AIActionUndoResult,
} from "./services/aiActions";
import {
  appendAIActionAuditEntry,
  loadAIActionAuditLog,
  markAIActionAuditEntryConflicted,
  markAIActionAuditEntryUndone,
  saveAIActionAuditLog,
} from "./services/aiActionAuditStore";
import { AIProviderError, breakDownTaskWithAI, chatWithAssistant, getCleanLocalizedErrorMessage, type AssistantAction } from "./services/aiService";
import { loadProjects, loadTasks, saveProjects, saveTasks } from "./services/localStore";
import type { AIMode, AssistantMessage, CategoryDateFilter, Project, ReminderOffsetMinutes, SortMode, Task, TaskDraft, TaskStatus, UserSettings, ViewId } from "./types";
import { assignCategoryColor, isAevumCategoryColor } from "./utils/categoryColors";
import { formatScheduleLabel, getTodayISO, getTomorrowISO, isScheduledAfterToday, isScheduledBeforeToday, isScheduledToday } from "./utils/date";
import { createProjectId, createTaskId } from "./utils/id";
import { getCategoryIdFromView } from "./utils/navigation";
import { calculateNextRepeatAt, createNextRecurringTask } from "./utils/recurrence";

const defaultSettings: UserSettings = {
  theme: "dark",
  timeFormat: "24h",
  language: "en",
  aiProvider: "ollama",
  aiBaseUrl: "http://localhost:11434",
  localModel: "qwen3.5:9b",
  cloudModel: "openrouter/free",
  notifications: true,
  defaultReminderMinutes: 0,
  availabilityBlocks: [],
  onboardingCompleted: false,
  startupBehavior: "dashboard",
  autoPlanDay: true,
  telegramAssistantEnabled: false,
  telegramUseDefaultAI: true,
  telegramAIProvider: "ollama",
  telegramLocalModel: "qwen3.5:9b",
  telegramCloudModel: "openrouter/free",
};

const settingsStorageKey = "todo-ai-settings";
const aiMessagesStorageKey = "todo-ai-ai-messages";
const cloudModelOptions = new Set(["openrouter/free", "deepseek/deepseek-v4-flash:free"]);

function loadSettings(theme: UserSettings["theme"], language: UserSettings["language"]): UserSettings {
  try {
    const stored = window.localStorage.getItem(settingsStorageKey);
    if (!stored) return { ...defaultSettings, theme, language };
    const parsed = JSON.parse(stored) as Record<string, unknown>;
    delete parsed.apiKey;
    if (typeof parsed.cloudModel !== "string" || !cloudModelOptions.has(parsed.cloudModel)) {
      parsed.cloudModel = defaultSettings.cloudModel;
    }
    return { ...defaultSettings, ...parsed, theme, language } as UserSettings;
  } catch {
    return { ...defaultSettings, theme, language };
  }
}

function loadMessages(): AssistantMessage[] {
  try {
    const stored = window.localStorage.getItem(aiMessagesStorageKey);
    if (!stored) return initialMessages;
    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return initialMessages;
    return parsed.filter((message): message is AssistantMessage => {
      return typeof message === "object" && message !== null && "id" in message && "role" in message && "content" in message;
    });
  } catch {
    return initialMessages;
  }
}

export function App() {
  const { theme, setTheme } = useTheme();
  const { language, t } = useI18n();
  const [activeView, setActiveView] = useState<ViewId>("dashboard");
  const [tasks, setTasks] = useState<Task[]>(loadTasks);
  const [appProjects, setAppProjects] = useState<Project[]>(loadProjects);
  const [messages, setMessages] = useState<AssistantMessage[]>(loadMessages);
  const [aiActionAuditLog, setAiActionAuditLog] = useState<AIActionAuditEntry[]>(loadAIActionAuditLog);
  const [settings, setSettings] = useState<UserSettings>(() => loadSettings(theme, language));
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [taskPendingDelete, setTaskPendingDelete] = useState<Task | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [categoryDateFilter, setCategoryDateFilter] = useState<CategoryDateFilter>("all");
  const [sortMode, setSortMode] = useState<SortMode>("deadline");
  const [isLoading] = useState(false);
  const tasksRef = useRef(tasks);
  const projectsRef = useRef(appProjects);
  const aiActionAuditLogRef = useRef(aiActionAuditLog);
  const settingsRef = useRef(settings);
  const proposalLedgerRef = useRef(createAIActionProposalLedger());
  const telegramProposalsRef = useRef(new Map<string, AIActionProposal>());
  const telegramTemplateWizardsRef = useRef(new Map<number, TelegramTemplateWizard>());
  const activeCategoryId = getCategoryIdFromView(activeView);
  const activeCategory = activeCategoryId ? appProjects.find((project) => project.id === activeCategoryId) : undefined;

  useEffect(() => {
    tasksRef.current = tasks;
  }, [tasks]);

  useEffect(() => {
    projectsRef.current = appProjects;
  }, [appProjects]);

  useEffect(() => {
    aiActionAuditLogRef.current = aiActionAuditLog;
  }, [aiActionAuditLog]);

  useEffect(() => {
    settingsRef.current = settings;
  }, [settings]);

  useEffect(() => {
    setSettings((current) => ({ ...current, theme, language }));
  }, [language, theme]);

  useEffect(() => {
    window.localStorage.setItem(settingsStorageKey, JSON.stringify(settings));
  }, [settings]);

  useEffect(() => {
    window.localStorage.setItem(aiMessagesStorageKey, JSON.stringify(messages));
  }, [messages]);

  useEffect(() => {
    saveTasks(tasks);
  }, [tasks]);

  useEffect(() => {
    saveProjects(appProjects);
  }, [appProjects]);

  useEffect(() => {
    saveAIActionAuditLog(aiActionAuditLog);
  }, [aiActionAuditLog]);

  useEffect(() => {
    if (activeCategoryId && !activeCategory) {
      setActiveView("projects");
    }
  }, [activeCategory, activeCategoryId]);

  useEffect(() => {
    if (taskPendingDelete && !tasks.some((task) => task.id === taskPendingDelete.id)) {
      setTaskPendingDelete(null);
    }
    if (editingTask && !tasks.some((task) => task.id === editingTask.id)) {
      setEditingTask(null);
    }
  }, [editingTask, taskPendingDelete, tasks]);

  useEffect(() => {
    void window.todoAI?.scheduleTaskNotifications(tasks, {
      enabled: settings.notifications,
      defaultReminderMinutes: settings.defaultReminderMinutes,
    });
  }, [settings.defaultReminderMinutes, settings.notifications, tasks]);

  useEffect(() => {
    function onKeyDown(event: KeyboardEvent) {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setIsCommandOpen((value) => !value);
      }
    }

    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, []);

  const addTask = useCallback((task: TaskDraft) => {
    const now = new Date().toISOString();
    const newTask: Task = {
      ...task,
      id: createTaskId(),
      nextRepeatAt: task.nextRepeatAt ?? calculateNextRepeatAt(task),
      createdAt: now,
      updatedAt: now,
    };
    setTasks((currentTasks) => [newTask, ...currentTasks]);
    return newTask;
  }, []);

  const addProject = useCallback((project: Omit<Project, "id">) => {
    const newProject = {
      ...project,
      color: isAevumCategoryColor(project.color) ? project.color : assignCategoryColor(projectsRef.current),
      id: createProjectId(),
    };
    setAppProjects((currentProjects) => [...currentProjects, newProject]);
    return newProject;
  }, []);

  const updateTask = useCallback((taskId: string, updates: Partial<Task>) => {
    setTasks((currentTasks) =>
      currentTasks.map((task) => {
        if (task.id !== taskId) return task;
        const nextTask = { ...task, ...updates, updatedAt: new Date().toISOString() };
        return {
          ...nextTask,
          nextRepeatAt: nextTask.repeat.enabled ? calculateNextRepeatAt(nextTask) : null,
        };
      }),
    );
  }, []);

  const setTaskStatus = useCallback((taskId: string, status: TaskStatus) => {
    setTasks((currentTasks) => {
      const now = new Date().toISOString();
      const task = currentTasks.find((item) => item.id === taskId);
      if (!task) return currentTasks;
      if (task.status === status) return currentTasks;
      const updatedTask: Task = { ...task, status, updatedAt: now };
      const updatedTasks = currentTasks.map((item) => (item.id === taskId ? updatedTask : item));
      if (status !== "completed" || !task.repeat.enabled) return updatedTasks;
      const nextRecurringTask = createNextRecurringTask(updatedTask, now);
      if (!nextRecurringTask) return updatedTasks;
      const recurringRoot = task.recurringParentId ?? task.id;
      const alreadyScheduled = updatedTasks.some(
        (item) =>
          item.id !== task.id &&
          item.status === "active" &&
          (item.recurringParentId ?? item.id) === recurringRoot &&
          item.scheduledAt === nextRecurringTask.scheduledAt,
      );
      if (alreadyScheduled) return updatedTasks;
      return [nextRecurringTask, ...updatedTasks];
    });
  }, []);

  const toggleTask = useCallback((taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;
    setTaskStatus(taskId, task.status === "completed" ? "active" : "completed");
  }, [setTaskStatus, tasks]);

  const deleteTaskDirect = useCallback((taskId: string) => {
    setTasks((currentTasks) => currentTasks.filter((task) => task.id !== taskId));
    setEditingTask((currentTask) => (currentTask?.id === taskId ? null : currentTask));
    setTaskPendingDelete((currentTask) => (currentTask?.id === taskId ? null : currentTask));
  }, []);

  const deleteTask = useCallback((taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    if (!task) return;
    setTaskPendingDelete(task);
  }, [tasks]);

  const toggleSubtask = useCallback((taskId: string, subtaskId: string) => {
    setTasks((currentTasks) =>
      currentTasks.map((task) =>
        task.id === taskId
          ? {
              ...task,
              subtasks: task.subtasks.map((subtask) =>
                subtask.id === subtaskId ? { ...subtask, completed: !subtask.completed } : subtask,
              ),
              updatedAt: new Date().toISOString(),
            }
          : task,
      ),
    );
  }, []);

  const updateProject = useCallback((projectId: string, updates: Partial<Project>) => {
    setAppProjects((currentProjects) =>
      currentProjects.map((project) => (project.id === projectId ? { ...project, ...updates } : project)),
    );
  }, []);

  const deleteProject = useCallback((projectId: string) => {
    const project = appProjects.find((item) => item.id === projectId);
    if (!project || project.id === "uncategorized") return;
    setTasks((currentTasks) =>
      currentTasks.map((task) => (task.projectId === projectId ? { ...task, projectId: "uncategorized", updatedAt: new Date().toISOString() } : task)),
    );
    setAppProjects((currentProjects) => currentProjects.filter((item) => item.id !== projectId));
  }, [appProjects]);

  const toggleTheme = useCallback(() => {
    setTheme(theme === "dark" ? "light" : "dark");
  }, [setTheme, theme]);

  const updateSettings = useCallback(
    (updates: Partial<UserSettings>) => {
      setSettings((current) => {
        const next = { ...current, ...updates };
        if (updates.theme) setTheme(updates.theme);
        return next;
      });
    },
    [setTheme],
  );

  const openNewTask = useCallback(() => {
    setIsTaskModalOpen(true);
  }, []);

  const openEditTask = useCallback((task: Task) => {
    setEditingTask(task);
  }, []);

  const handleBreakDownTask = useCallback((task: Task) => breakDownTaskWithAI(task, settings), [settings]);

  const scopedTasks = useMemo(() => {
    if (activeView === "today") return tasks.filter((task) => isScheduledToday(task.scheduledAt) || isScheduledBeforeToday(task.scheduledAt));
    if (activeView === "upcoming") return tasks.filter((task) => isScheduledAfterToday(task.scheduledAt));
    return tasks;
  }, [activeView, tasks]);

  const taskListProps = {
    projects: appProjects,
    query,
    setQuery,
    statusFilter,
    setStatusFilter,
    categoryFilter,
    setCategoryFilter,
    sortMode,
    setSortMode,
    onToggleTask: toggleTask,
    onDeleteTask: deleteTask,
    onUpdateTask: updateTask,
    onToggleSubtask: toggleSubtask,
    onBreakDownTask: handleBreakDownTask,
    onEditTask: openEditTask,
  };

  const commitAITransaction = useCallback((result: Extract<AIActionConfirmResult, { ok: true }> | Extract<AIActionUndoResult, { ok: true }>) => {
    tasksRef.current = result.transaction.after.tasks;
    projectsRef.current = result.transaction.after.projects;
    setTasks(result.transaction.after.tasks);
    setAppProjects(result.transaction.after.projects);
  }, []);

  const confirmAIProposal = useCallback((proposal: AIActionProposal): AIActionConfirmResult => {
    const result = confirmAIActionProposal(proposal, { tasks: tasksRef.current, projects: projectsRef.current }, { ledger: proposalLedgerRef.current });
    if (!result.ok) return result;
    commitAITransaction(result);
    setAiActionAuditLog((current) => appendAIActionAuditEntry(current, result.auditEntry));
    return result;
  }, [commitAITransaction]);

  const cancelAIProposal = useCallback((proposal: AIActionProposal) => {
    cancelAIActionProposal(proposal, proposalLedgerRef.current);
  }, []);

  const undoAIAction = useCallback((transactionId: string): AIActionUndoResult => {
    const entry = aiActionAuditLogRef.current.find((item) => item.transactionId === transactionId);
    if (!entry) return { ok: false, reason: "unsafe_undo" };

    const result = createUndoAIActionTransaction(entry, { tasks: tasksRef.current, projects: projectsRef.current });
    if (!result.ok) {
      const conflictEntry = createAIActionUndoConflictAuditEntry(entry, result.reason);
      setAiActionAuditLog((current) =>
        appendAIActionAuditEntry(
          markAIActionAuditEntryConflicted(current, entry.transactionId, result.reason),
          conflictEntry,
        ),
      );
      return result;
    }

    commitAITransaction(result);
    setAiActionAuditLog((current) =>
      appendAIActionAuditEntry(
        markAIActionAuditEntryUndone(current, entry.transactionId),
        result.auditEntry,
      ),
    );
    return result;
  }, [commitAITransaction]);

  useEffect(() => {
    void window.todoAI?.updateTelegramSettings({
      enabled: settings.telegramAssistantEnabled,
      language: settings.language,
      useDefaultAI: settings.telegramUseDefaultAI,
      aiProvider: settings.telegramAIProvider,
      localModel: settings.telegramLocalModel,
      cloudModel: settings.telegramCloudModel,
    });
  }, [
    settings.language,
    settings.telegramAIProvider,
    settings.telegramAssistantEnabled,
    settings.telegramCloudModel,
    settings.telegramLocalModel,
    settings.telegramUseDefaultAI,
  ]);

  useEffect(() => {
    const removeMessageListener = window.todoAI?.onTelegramMessageRequest((payload) => {
      void handleTelegramMessage(payload);
    });
    const removeDecisionListener = window.todoAI?.onTelegramDecisionRequest((payload) => {
      void handleTelegramDecision(payload);
    });
    const removeCallbackListener = window.todoAI?.onTelegramCallbackRequest((payload) => {
      void handleTelegramCallback(payload);
    });
    void window.todoAI?.markTelegramRendererReady();
    return () => {
      removeMessageListener?.();
      removeDecisionListener?.();
      removeCallbackListener?.();
    };
  }, []);

  async function handleTelegramMessage(payload: TelegramMessageRequestPayload) {
    const respond = (response: TelegramRendererResponse) => window.todoAI?.sendTelegramRendererResponse({ id: payload.id, response });
    try {
      const text = payload.text.trim();
      if (!text) {
        await respond({ ok: false, text: telegramCopy(settingsRef.current.language, "empty") });
        return;
      }

      const normalizedText = normalizeTelegramIntentText(text);
      if (normalizedText === "/start" || normalizedText === "/menu" || normalizedText === "menu" || normalizedText === "меню") {
        telegramTemplateWizardsRef.current.delete(payload.chatId);
        await respond(payload.interactionMode === "ai" ? createTelegramAiMenu(settingsRef.current) : createTelegramTemplateMenu(settingsRef.current, "templateIntro"));
        return;
      }

      if (payload.interactionMode === "template") {
        await respond(handleTelegramTemplateMessage(payload.chatId, text, tasksRef.current, projectsRef.current, settingsRef.current));
        return;
      }

      const effectiveSettings = await getTelegramAISettings(settingsRef.current);
      if ("error" in effectiveSettings) {
        await respond({ ok: false, text: effectiveSettings.error });
        return;
      }

      const result = await chatWithAssistant(text, tasksRef.current, effectiveSettings.settings, null, projectsRef.current);
      if (!result.action) {
        await respond({ ok: true, kind: "message", text: sanitizeTelegramReply(result.message.content) });
        return;
      }

      const action = sanitizeTelegramAction(result.action, projectsRef.current);
      const proposalResult = createAIActionProposal(action, "telegram", { tasks: tasksRef.current, projects: projectsRef.current }, { ttlMs: 10 * 60_000 });
      if (!proposalResult.ok) {
        await respond({ ok: false, text: telegramCopy(settingsRef.current.language, "applyFailed") });
        return;
      }
      telegramProposalsRef.current.set(proposalResult.proposal.id, proposalResult.proposal);
      const messageContent = sanitizeTelegramReply(result.message.content);
      const preview = renderTelegramActionPreview(proposalResult.proposal.action, tasksRef.current, projectsRef.current, settingsRef.current);
      const combinedText = messageContent ? `${messageContent}\n\n${preview}` : preview;
      await respond({ ok: true, kind: "proposal", proposalId: proposalResult.proposal.id, text: combinedText });
    } catch (error) {
      await respond({ ok: false, text: normalizeTelegramError(error, settingsRef.current.language) });
    }
  }

  async function handleTelegramCallback(payload: TelegramCallbackRequestPayload) {
    const respond = (response: TelegramRendererResponse) => window.todoAI?.sendTelegramRendererResponse({ id: payload.id, response });
    try {
      await respond(handleTelegramTemplateCallback(payload.chatId, payload.data, payload.interactionMode, tasksRef.current, projectsRef.current, settingsRef.current));
    } catch {
      await respond({ ok: false, text: telegramCopy(settingsRef.current.language, "error") });
    }
  }

  async function handleTelegramDecision(payload: TelegramDecisionRequestPayload) {
    const respond = (response: TelegramRendererResponse) => window.todoAI?.sendTelegramRendererResponse({ id: payload.id, response });
    const proposal = telegramProposalsRef.current.get(payload.proposalId);
    if (!proposal) {
      telegramProposalsRef.current.delete(payload.proposalId);
      await respond({ ok: false, text: telegramCopy(settingsRef.current.language, "expired") });
      return;
    }

    telegramProposalsRef.current.delete(payload.proposalId);
    if (payload.decision === "cancel") {
      cancelAIProposal(proposal);
      await respond({ ok: true, kind: "message", text: telegramCopy(settingsRef.current.language, "canceled") });
      return;
    }

    const actionResult = confirmAIProposal(proposal);
    await respond(actionResult.ok
      ? { ok: true, kind: "message", text: telegramCopy(settingsRef.current.language, "applied") }
      : { ok: false, text: telegramCopy(settingsRef.current.language, telegramFailureCopyKey(actionResult.reason)) });
  }

  function handleTelegramTemplateMessage(chatId: number, text: string, tasksValue: Task[], projectsValue: Project[], settingsValue: UserSettings): TelegramRendererResponse {
    const normalized = normalizeTelegramIntentText(text);
    if (normalized === "/start" || normalized === "/menu" || normalized === "menu" || normalized === "меню") {
      telegramTemplateWizardsRef.current.delete(chatId);
      return createTelegramTemplateMenu(settingsValue, "templateIntro");
    }

    const wizard = telegramTemplateWizardsRef.current.get(chatId);
    if (!wizard) {
      return createTelegramTemplateMenu(settingsValue, "templateTextFallback");
    }

    return advanceTelegramCreateWizardFromText(chatId, wizard, text, tasksValue, projectsValue, settingsValue);
  }

  function handleTelegramTemplateCallback(
    chatId: number,
    data: string,
    interactionMode: TelegramInteractionMode,
    tasksValue: Task[],
    projectsValue: Project[],
    settingsValue: UserSettings,
  ): TelegramRendererResponse {
    if (data === "tg:mode:ai") {
      telegramTemplateWizardsRef.current.delete(chatId);
      return createTelegramAiMenu(settingsValue);
    }
    if (data === "tg:mode:template") {
      telegramTemplateWizardsRef.current.delete(chatId);
      telegramProposalsRef.current.clear();
      return createTelegramTemplateMenu(settingsValue, "templateModeActive");
    }
    if (data === "tg:ai:help") {
      return createTelegramAiMenu(settingsValue);
    }
    if (interactionMode === "ai") {
      return createTelegramAiMenu(settingsValue);
    }
    if (data === "tg:menu") {
      telegramTemplateWizardsRef.current.delete(chatId);
      return createTelegramTemplateMenu(settingsValue, "templateIntro");
    }
    if (data === "tg:today") {
      return createTelegramButtonsResponse(renderTelegramReadOnlyAnswer("What do I have today?", tasksValue, projectsValue, settingsValue), telegramTemplateMenuButtons(settingsValue));
    }
    if (data === "tg:upcoming") {
      return createTelegramButtonsResponse(renderTelegramReadOnlyAnswer("Show upcoming tasks", tasksValue, projectsValue, settingsValue), telegramTemplateMenuButtons(settingsValue));
    }
    if (data === "tg:create") {
      telegramTemplateWizardsRef.current.set(chatId, { step: "title" });
      return createTelegramButtonsResponse(telegramCopy(settingsValue.language, "templateAskTitle"), [[telegramButton(settingsValue, "templateCancel", "tg:create:cancel")]]);
    }
    if (data === "tg:create:cancel") {
      telegramTemplateWizardsRef.current.delete(chatId);
      return createTelegramTemplateMenu(settingsValue, "templateCanceled");
    }

    const wizard = telegramTemplateWizardsRef.current.get(chatId);
    if (!wizard) return createTelegramTemplateMenu(settingsValue, "templateIntro");

    if (data.startsWith("tg:create:date:")) {
      const choice = data.slice("tg:create:date:".length);
      const date = choice === "today" ? getTodayISO() : choice === "tomorrow" ? getTomorrowISO() : null;
      const nextWizard: TelegramTemplateWizard = { ...wizard, step: date ? "time" : "duration", date, time: null };
      telegramTemplateWizardsRef.current.set(chatId, nextWizard);
      return date
        ? createTelegramButtonsResponse(telegramCopy(settingsValue.language, "templateAskTime"), [[telegramButton(settingsValue, "templateNoTime", "tg:create:time:none"), telegramButton(settingsValue, "templateCancel", "tg:create:cancel")]])
        : createTelegramDurationStep(chatId, nextWizard, settingsValue);
    }

    if (data === "tg:create:time:none") {
      const nextWizard: TelegramTemplateWizard = { ...wizard, step: "duration", time: null };
      telegramTemplateWizardsRef.current.set(chatId, nextWizard);
      return createTelegramDurationStep(chatId, nextWizard, settingsValue);
    }

    if (data.startsWith("tg:create:duration:")) {
      const rawDuration = data.slice("tg:create:duration:".length);
      const durationMinutes = rawDuration === "none" ? null : Number(rawDuration);
      const nextWizard: TelegramTemplateWizard = {
        ...wizard,
        step: "reminder",
        durationMinutes: Number.isFinite(durationMinutes) ? durationMinutes : null,
      };
      telegramTemplateWizardsRef.current.set(chatId, nextWizard);
      return createTelegramReminderStep(chatId, nextWizard, settingsValue);
    }

    if (data.startsWith("tg:create:reminder:")) {
      const rawReminder = data.slice("tg:create:reminder:".length);
      const reminderMinutes = rawReminder === "none" ? null : readTelegramReminder(rawReminder);
      const finalWizard: TelegramTemplateWizard = { ...wizard, reminderMinutes };
      return createTelegramTemplateCreateProposal(chatId, finalWizard, tasksValue, projectsValue, settingsValue);
    }

    return createTelegramTemplateMenu(settingsValue, "templateIntro");
  }

  function advanceTelegramCreateWizardFromText(
    chatId: number,
    wizard: TelegramTemplateWizard,
    text: string,
    tasksValue: Task[],
    projectsValue: Project[],
    settingsValue: UserSettings,
  ): TelegramRendererResponse {
    if (wizard.step === "title") {
      const title = text.trim().slice(0, 140);
      if (!title) return createTelegramButtonsResponse(telegramCopy(settingsValue.language, "templateAskTitle"), [[telegramButton(settingsValue, "templateCancel", "tg:create:cancel")]]);
      const nextWizard: TelegramTemplateWizard = { ...wizard, step: "date", title };
      telegramTemplateWizardsRef.current.set(chatId, nextWizard);
      return createTelegramButtonsResponse(telegramCopy(settingsValue.language, "templateAskDate"), telegramDateButtons(settingsValue));
    }

    if (wizard.step === "date") {
      const date = parseTelegramTemplateDate(text);
      if (date === undefined) return createTelegramButtonsResponse(telegramCopy(settingsValue.language, "templateInvalidDate"), telegramDateButtons(settingsValue));
      const nextWizard: TelegramTemplateWizard = { ...wizard, step: date ? "time" : "duration", date, time: null };
      telegramTemplateWizardsRef.current.set(chatId, nextWizard);
      return date
        ? createTelegramButtonsResponse(telegramCopy(settingsValue.language, "templateAskTime"), [[telegramButton(settingsValue, "templateNoTime", "tg:create:time:none"), telegramButton(settingsValue, "templateCancel", "tg:create:cancel")]])
        : createTelegramDurationStep(chatId, nextWizard, settingsValue);
    }

    if (wizard.step === "time") {
      const time = parseTelegramTemplateTime(text);
      if (time === undefined) return createTelegramButtonsResponse(telegramCopy(settingsValue.language, "templateInvalidTime"), [[telegramButton(settingsValue, "templateNoTime", "tg:create:time:none"), telegramButton(settingsValue, "templateCancel", "tg:create:cancel")]]);
      const nextWizard: TelegramTemplateWizard = { ...wizard, step: "duration", time };
      telegramTemplateWizardsRef.current.set(chatId, nextWizard);
      return createTelegramDurationStep(chatId, nextWizard, settingsValue);
    }

    if (wizard.step === "duration") {
      const durationMinutes = parseTelegramTemplateOptionalNumber(text);
      if (durationMinutes === undefined) return createTelegramDurationStep(chatId, wizard, settingsValue, "templateInvalidDuration");
      const nextWizard: TelegramTemplateWizard = { ...wizard, step: "reminder", durationMinutes };
      telegramTemplateWizardsRef.current.set(chatId, nextWizard);
      return createTelegramReminderStep(chatId, nextWizard, settingsValue);
    }

    const reminderMinutes = parseTelegramTemplateReminder(text);
    if (reminderMinutes === undefined) return createTelegramReminderStep(chatId, wizard, settingsValue, "templateInvalidReminder");
    return createTelegramTemplateCreateProposal(chatId, { ...wizard, reminderMinutes }, tasksValue, projectsValue, settingsValue);
  }

  function createTelegramDurationStep(chatId: number, wizard: TelegramTemplateWizard, settingsValue: UserSettings, copyKey = "templateAskDuration"): TelegramRendererResponse {
    telegramTemplateWizardsRef.current.set(chatId, { ...wizard, step: "duration" });
    return createTelegramButtonsResponse(telegramCopy(settingsValue.language, copyKey), [
      [
        telegramButton(settingsValue, "templateDuration15", "tg:create:duration:15"),
        telegramButton(settingsValue, "templateDuration30", "tg:create:duration:30"),
        telegramButton(settingsValue, "templateDuration60", "tg:create:duration:60"),
      ],
      [telegramButton(settingsValue, "templateNoDuration", "tg:create:duration:none"), telegramButton(settingsValue, "templateCancel", "tg:create:cancel")],
    ]);
  }

  function createTelegramReminderStep(chatId: number, wizard: TelegramTemplateWizard, settingsValue: UserSettings, copyKey = "templateAskReminder"): TelegramRendererResponse {
    telegramTemplateWizardsRef.current.set(chatId, { ...wizard, step: "reminder" });
    return createTelegramButtonsResponse(telegramCopy(settingsValue.language, copyKey), [
      [
        telegramButton(settingsValue, "templateNoReminder", "tg:create:reminder:none"),
        telegramButton(settingsValue, "templateReminder10", "tg:create:reminder:10"),
        telegramButton(settingsValue, "templateReminder30", "tg:create:reminder:30"),
      ],
      [telegramButton(settingsValue, "templateCancel", "tg:create:cancel")],
    ]);
  }

  function createTelegramTemplateCreateProposal(chatId: number, wizard: TelegramTemplateWizard, tasksValue: Task[], projectsValue: Project[], settingsValue: UserSettings): TelegramRendererResponse {
    if (!wizard.title) {
      telegramTemplateWizardsRef.current.delete(chatId);
      return createTelegramTemplateMenu(settingsValue, "templateCanceled");
    }
    const scheduledAt = wizard.date ? (wizard.time ? `${wizard.date}T${wizard.time}` : wizard.date) : null;
    const action: AssistantAction = {
      type: "create_tasks",
      tasks: [{
        title: wizard.title,
        description: "",
        scheduledAt,
        durationMinutes: wizard.durationMinutes ?? null,
        reminderMinutes: wizard.reminderMinutes ?? null,
        tags: [],
      }],
    };
    const proposalResult = createAIActionProposal(action, "telegram", { tasks: tasksValue, projects: projectsValue }, { ttlMs: 10 * 60_000 });
    if (!proposalResult.ok) {
      telegramTemplateWizardsRef.current.delete(chatId);
      return { ok: false, text: telegramCopy(settingsValue.language, "applyFailed") };
    }
    telegramProposalsRef.current.set(proposalResult.proposal.id, proposalResult.proposal);
    telegramTemplateWizardsRef.current.delete(chatId);
    return { ok: true, kind: "proposal", proposalId: proposalResult.proposal.id, text: renderTelegramActionPreview(proposalResult.proposal.action, tasksValue, projectsValue, settingsValue) };
  }

  return (
    <>
      <AppShell
        activeView={activeView}
        setActiveView={setActiveView}
        projects={appProjects}
        tasks={tasks}
        theme={theme}
        onNewTask={openNewTask}
        onOpenCommandPalette={() => setIsCommandOpen(true)}
        onToggleTheme={toggleTheme}
      >
        {activeView === "dashboard" && (
          <Dashboard
            tasks={tasks}
            projects={appProjects}
            timeFormat={settings.timeFormat}
            isLoading={isLoading}
            onAddTask={addTask}
            onToggleTask={toggleTask}
            onDeleteTask={deleteTask}
            onUpdateTask={updateTask}
            onToggleSubtask={toggleSubtask}
            onBreakDownTask={handleBreakDownTask}
            onEditTask={openEditTask}
          />
        )}

        {(activeView === "today" || activeView === "upcoming") && (
          <TaskList
            tasks={scopedTasks}
            timeFormat={settings.timeFormat}
            viewMode={activeView === "upcoming" ? "upcoming" : "today"}
            {...taskListProps}
          />
        )}

        {activeCategory && (
          <TaskList
            {...taskListProps}
            tasks={tasks}
            categoryFilter={activeCategory.id}
            setCategoryFilter={setCategoryFilter}
            categoryDateFilter={categoryDateFilter}
            setCategoryDateFilter={setCategoryDateFilter}
            timeFormat={settings.timeFormat}
            viewMode="category"
            activeCategory={activeCategory}
            hideCategoryFilter
          />
        )}

        {activeView === "projects" && (
          <ProjectsView
            projects={appProjects}
            tasks={tasks}
            onAddProject={addProject}
            onDeleteProject={deleteProject}
            onOpenToday={() => setActiveView("today")}
            onRenameProject={updateProject}
          />
        )}

        {activeView === "calendar" && <CalendarView tasks={tasks} projects={appProjects} timeFormat={settings.timeFormat} />}

        {activeView === "visualization" && <VisualizationView tasks={tasks} projects={appProjects} timeFormat={settings.timeFormat} />}

        {activeView === "assistant" && (
          <AIAssistantPanel
            aiActionAuditLog={aiActionAuditLog}
            messages={messages}
            onCancelAIProposal={cancelAIProposal}
            onConfirmAIProposal={confirmAIProposal}
            onUndoAIAction={undoAIAction}
            projects={appProjects}
            setMessages={setMessages}
            settings={settings}
            tasks={tasks}
            updateSettings={updateSettings}
            setActiveView={setActiveView}
          />
        )}

        {activeView === "settings" && (
          <SettingsPage
            clearAiHistory={() => setMessages([])}
            settings={settings}
            updateSettings={updateSettings}
          />
        )}
      </AppShell>

      {!settings.onboardingCompleted && (
        <OnboardingFlow
          projects={appProjects}
          settings={settings}
          onAddTask={addTask}
          onComplete={() => updateSettings({ onboardingCompleted: true })}
          updateSettings={updateSettings}
        />
      )}

      <CommandPalette
        isOpen={isCommandOpen}
        onClose={() => setIsCommandOpen(false)}
        setActiveView={setActiveView}
        onToggleTheme={toggleTheme}
        onAddStarterTask={openNewTask}
      />

      {isTaskModalOpen && (
        <TaskModal
          key="create-task"
          mode="create"
          projects={appProjects}
          onClose={() => setIsTaskModalOpen(false)}
          onSave={(draft) => {
            addTask(draft);
            setIsTaskModalOpen(false);
            setActiveView("today");
          }}
        />
      )}

      {editingTask && (
        <TaskModal
          key={editingTask.id}
          mode="edit"
          projects={appProjects}
          task={editingTask}
          onClose={() => setEditingTask(null)}
          onSave={(draft) => {
            updateTask(editingTask.id, draft);
            setEditingTask(null);
          }}
        />
      )}

      {taskPendingDelete && (
        <div className="confirm-overlay" role="presentation" onMouseDown={() => setTaskPendingDelete(null)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-task-title" onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="delete-task-title">{t("task.confirmDelete")}</h2>
            <p>{taskPendingDelete.title}</p>
            <div className="confirm-dialog__actions">
              <button className="button button--secondary" onClick={() => setTaskPendingDelete(null)} type="button">
                {t("settings.cancel")}
              </button>
              <button className="button button--danger" onClick={() => {
                const taskId = taskPendingDelete.id;
                setTaskPendingDelete(null);
                deleteTaskDirect(taskId);
              }} type="button">
                {t("task.delete")}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

type TelegramIntent =
  | { kind: "mode"; mode: AIMode }
  | { kind: "read_only" }
  | { kind: "guide" }
  | { kind: "ambiguous" };

type TelegramTemplateWizard = {
  step: "title" | "date" | "time" | "duration" | "reminder";
  title?: string;
  date?: string | null;
  time?: string | null;
  durationMinutes?: number | null;
  reminderMinutes?: ReminderOffsetMinutes | null;
};

function resolveTelegramIntent(text: string): TelegramIntent {
  const value = normalizeTelegramIntentText(text);

  if (isTelegramCreateIntent(value)) return { kind: "mode", mode: "create_tasks" };
  if (isTelegramReplanIntent(value)) return { kind: "mode", mode: "replan_tasks" };
  if (isTelegramManageIntent(value)) return { kind: "mode", mode: "manage_tasks" };
  if (isTelegramPlanIntent(value)) return { kind: "mode", mode: "plan_day" };
  if (isTelegramReadOnlyTaskQuery(value)) return { kind: "read_only" };
  if (isTelegramTaskReference(value) && isTelegramBareDateReference(value)) return { kind: "ambiguous" };

  return { kind: "guide" };
}

function normalizeTelegramIntentText(text: string) {
  return text.toLocaleLowerCase().replace(/[ё]/g, "е").replace(/\s+/g, " ").trim();
}

function isTelegramCreateIntent(value: string) {
  return /\b(create|add|new task|make a task|schedule a task)\b/u.test(value)
    || hasTelegramPhrase(value, ["создай", "создать", "добавь", "добавить", "новая задача", "новую задачу", "запланируй задачу", "запланировать задачу"]);
}

function isTelegramReplanIntent(value: string) {
  return /\b(replan|re-plan|plan again)\b/u.test(value)
    || hasTelegramPhrase(value, ["перепланируй", "перепланировать", "перепланировка"]);
}

function isTelegramPlanIntent(value: string) {
  return /\b(plan my day|plan the day|plan tomorrow|schedule my day)\b/u.test(value)
    || hasTelegramPhrase(value, ["спланируй", "распланируй", "план на день", "план на завтра", "составь план"]);
}

function isTelegramManageIntent(value: string) {
  return /\b(delete|remove|edit|rename|reschedule|move|complete|completed|done|reopen|restore|mark)\b/u.test(value)
    || hasTelegramPhrase(value, [
      "удали",
      "удалить",
      "убери",
      "убрать",
      "измени",
      "изменить",
      "переименуй",
      "переименовать",
      "перенеси",
      "перенести",
      "передвинь",
      "передвинуть",
      "отметь",
      "отметить",
      "выполнено",
      "выполнен",
      "сделано",
      "заверши",
      "завершить",
      "верни",
      "вернуть",
      "восстанови",
      "восстановить",
    ]);
}

function isTelegramReadOnlyTaskQuery(value: string) {
  const hasRussianQuery = hasTelegramPhrase(value, ["что у меня", "что сегодня", "что завтра", "какие задачи", "покажи", "показать", "список", "выведи", "расскажи"]);
  const hasRussianScope = hasTelegramPhrase(value, ["сегодня", "завтра", "задач", "расписан", "предстоящ", "ближайш"]);
  return /\b(what do i have|what's on|what is on|show|list|display|tell me)\b.*\b(today|tomorrow|upcoming|tasks?|schedule)\b/u.test(value)
    || /\b(tasks?|schedule)\b.*\b(for|on)\b.*\b(today|tomorrow)\b/u.test(value)
    || (hasRussianQuery && hasRussianScope)
    || /(?:^|\s)(задачи|расписание)\s+(?:на\s+)?(сегодня|завтра)(?:\s|$|[?.!])/u.test(value);
}

function isTelegramTaskReference(value: string) {
  return /\b(task|tasks|schedule)\b/u.test(value) || hasTelegramPhrase(value, ["задач", "расписан"]);
}

function isTelegramBareDateReference(value: string) {
  return /\b(today|tomorrow)\b/u.test(value) || hasTelegramPhrase(value, ["сегодня", "завтра", "сегодняшн", "завтрашн"]);
}

function hasTelegramPhrase(value: string, phrases: string[]) {
  return phrases.some((phrase) => value.includes(phrase));
}

function createTelegramTemplateMenu(settings: UserSettings, copyKey: string): TelegramRendererResponse {
  return createTelegramButtonsResponse(telegramCopy(settings.language, copyKey), telegramTemplateMenuButtons(settings));
}

function createTelegramAiMenu(settings: UserSettings): TelegramRendererResponse {
  return createTelegramButtonsResponse(telegramCopy(settings.language, "aiModeActive"), [
    [telegramButton(settings, "templateModeButton", "tg:mode:template")],
    [telegramButton(settings, "aiHelp", "tg:ai:help")],
  ]);
}

function createTelegramButtonsResponse(text: string, buttons: TelegramResponseButton[][]): TelegramRendererResponse {
  return { ok: true, kind: "buttons", text, buttons };
}

function telegramTemplateMenuButtons(settings: UserSettings): TelegramResponseButton[][] {
  return [
    [
      telegramButton(settings, "templateToday", "tg:today"),
      telegramButton(settings, "templateUpcoming", "tg:upcoming"),
    ],
    [telegramButton(settings, "templateCreate", "tg:create")],
    [telegramButton(settings, "aiModeButton", "tg:mode:ai")],
  ];
}

function telegramDateButtons(settings: UserSettings): TelegramResponseButton[][] {
  return [
    [
      telegramButton(settings, "templateToday", "tg:create:date:today"),
      telegramButton(settings, "templateTomorrow", "tg:create:date:tomorrow"),
    ],
    [telegramButton(settings, "templateNoDate", "tg:create:date:none"), telegramButton(settings, "templateCancel", "tg:create:cancel")],
  ];
}

function telegramButton(settings: UserSettings, copyKey: string, callbackData: string): TelegramResponseButton {
  return { text: telegramCopy(settings.language, copyKey), callbackData };
}

function parseTelegramTemplateDate(value: string): string | null | undefined {
  const normalized = normalizeTelegramIntentText(value);
  if (normalized === "today" || normalized.includes("сегодня")) return getTodayISO();
  if (normalized === "tomorrow" || normalized.includes("завтра")) return getTomorrowISO();
  if (normalized === "skip" || normalized === "none" || normalized === "no date" || normalized.includes("без даты")) return null;
  return /^\d{4}-\d{2}-\d{2}$/.test(normalized) ? normalized : undefined;
}

function parseTelegramTemplateTime(value: string): string | null | undefined {
  const normalized = normalizeTelegramIntentText(value);
  if (normalized === "skip" || normalized === "none" || normalized === "no time" || normalized.includes("без времени")) return null;
  const match = /^([01]?\d|2[0-3])(?::([0-5]\d))?$/.exec(normalized);
  if (!match) return undefined;
  return `${match[1].padStart(2, "0")}:${match[2] ?? "00"}`;
}

function parseTelegramTemplateOptionalNumber(value: string): number | null | undefined {
  const normalized = normalizeTelegramIntentText(value);
  if (normalized === "skip" || normalized === "none" || normalized === "no duration" || normalized.includes("без длительности")) return null;
  const match = normalized.match(/\d{1,3}/);
  if (!match) return undefined;
  const minutes = Number(match[0]);
  return minutes > 0 && minutes <= 480 ? minutes : undefined;
}

function parseTelegramTemplateReminder(value: string): ReminderOffsetMinutes | null | undefined {
  const parsed = parseTelegramTemplateOptionalNumber(value);
  if (parsed === null) return null;
  if (parsed === 0 || parsed === 5 || parsed === 10 || parsed === 30 || parsed === 60) return parsed;
  return undefined;
}

function readTelegramReminder(value: string): ReminderOffsetMinutes | null {
  const numeric = Number(value);
  return numeric === 0 || numeric === 5 || numeric === 10 || numeric === 30 || numeric === 60 ? numeric : null;
}

async function getTelegramAISettings(settings: UserSettings): Promise<{ settings: UserSettings } | { error: string }> {
  if (settings.telegramUseDefaultAI) return { settings };
  const nextSettings = {
    ...settings,
    aiProvider: settings.telegramAIProvider,
    localModel: settings.telegramLocalModel || settings.localModel,
    cloudModel: settings.telegramCloudModel || settings.cloudModel,
  };

  if (nextSettings.aiProvider === "openrouter") {
    const keyStatus = await window.todoAI?.hasOpenRouterApiKey();
    if (!keyStatus?.hasKey) return { error: telegramCopy(settings.language, "openRouterMissing") };
    return { settings: nextSettings };
  }

  const ollamaStatus = await window.todoAI?.checkOllamaStatus(nextSettings.localModel, nextSettings.aiBaseUrl);
  if (!ollamaStatus || ollamaStatus.status !== "connected") {
    return { error: telegramCopy(settings.language, ollamaStatus?.status === "model-missing" ? "ollamaModelMissing" : "ollamaUnavailable") };
  }
  return { settings: nextSettings };
}

function renderTelegramReadOnlyAnswer(text: string, tasks: Task[], projects: Project[], settings: UserSettings) {
  const value = text.toLowerCase();
  if (!isTelegramReadOnlyTaskQuery(normalizeTelegramIntentText(text))) return "";
  const asksToday = /\btoday\b|сегодня/u.test(value);
  const asksUpcoming = /\bupcoming\b|\bthis week\b|предстоящ|ближайш/u.test(value);
  const asksTomorrow = /\btomorrow\b|завтра/u.test(value);
  if (!asksToday && !asksUpcoming && !asksTomorrow && !/\bwhat.*task|что.*задач|какие.*задач/u.test(value)) return "";

  const labels = scheduleLabelsFor(settings.language);
  const relevantTasks = tasks
    .filter((task) => {
      if (task.status === "completed") return false;
      if (asksToday) return isScheduledToday(task.scheduledAt) || isScheduledBeforeToday(task.scheduledAt);
      if (asksTomorrow) return task.scheduledAt?.startsWith(getTomorrowDate()) ?? false;
      return isScheduledAfterToday(task.scheduledAt) || isScheduledToday(task.scheduledAt);
    })
    .sort((a, b) => (a.scheduledAt ?? "9999").localeCompare(b.scheduledAt ?? "9999"))
    .slice(0, 8);

  if (!relevantTasks.length) return telegramCopy(settings.language, asksToday ? "noToday" : "noUpcoming");
  const header = settings.language === "ru" ? "Ваши задачи:" : "Your tasks:";
  return [
    header,
    ...relevantTasks.map((task) => {
      const project = projects.find((item) => item.id === task.projectId)?.name;
      const schedule = formatScheduleLabel(task.scheduledAt, labels, settings.language, settings.timeFormat);
      return `• ${task.title} — ${schedule}${project ? ` · ${project}` : ""}`;
    }),
  ].join("\n");
}

function sanitizeTelegramAction(action: AssistantAction, projects: Project[]): AssistantAction {
  if (action.type === "create_tasks") {
    const knownProjectNames = new Set(projects.map((project) => project.name.toLowerCase()));
    return {
      ...action,
      tasks: action.tasks.map((task) => ({
        ...task,
        projectName: task.projectName && knownProjectNames.has(task.projectName.toLowerCase()) ? task.projectName : undefined,
      })),
    };
  }
  if (action.type === "batch_action") {
    const knownProjectNames = new Set(projects.map((project) => project.name.toLowerCase()));
    return {
      ...action,
      tasksToCreate: action.tasksToCreate?.map((task) => ({
        ...task,
        projectName: task.projectName && knownProjectNames.has(task.projectName.toLowerCase()) ? task.projectName : undefined,
      })),
    };
  }
  return action;
}

function renderTelegramActionPreview(action: AssistantAction, tasks: Task[], projects: Project[], settings: UserSettings) {
  const labels = scheduleLabelsFor(settings.language);
  if (action.type === "create_tasks") {
    return [
      settings.language === "ru" ? "Предложение создать задачи:" : "Proposed task creation:",
      ...action.tasks.map((task) => `• ${task.title}${task.scheduledAt ? ` — ${formatScheduleLabel(task.scheduledAt, labels, settings.language, settings.timeFormat)}` : ""}`),
      settings.language === "ru" ? "Ничего не будет создано без подтверждения." : "Nothing will be created without confirmation.",
    ].join("\n");
  }
  if (action.type === "schedule_tasks") {
    return [
      settings.language === "ru" ? "Предложение изменить расписание:" : "Proposed schedule:",
      ...action.changes.map((change) => {
        const task = tasks.find((item) => item.id === change.taskId);
        return `• ${task?.title ?? telegramCopy(settings.language, "task")} — ${formatScheduleLabel(change.scheduledAt, labels, settings.language, settings.timeFormat)}`;
      }),
      settings.language === "ru" ? "Применить это расписание?" : "Apply this schedule?",
    ].join("\n");
  }
  if (action.type === "batch_action") {
    const lines: string[] = [];
    lines.push(settings.language === "ru" ? "Предложение выполнить пакет действий:" : "Proposed batch actions:");
    
    if (action.tasksToCreate && action.tasksToCreate.length > 0) {
      lines.push(settings.language === "ru" ? "Создать:" : "Create:");
      for (const task of action.tasksToCreate) {
        lines.push(`• ${task.title}${task.scheduledAt ? ` — ${formatScheduleLabel(task.scheduledAt, labels, settings.language, settings.timeFormat)}` : ""}`);
      }
    }
    
    if (action.scheduleChanges && action.scheduleChanges.length > 0) {
      lines.push(settings.language === "ru" ? "Запланировать:" : "Schedule:");
      for (const change of action.scheduleChanges) {
        const task = tasks.find((item) => item.id === change.taskId);
        lines.push(`• ${task?.title ?? telegramCopy(settings.language, "task")} — ${formatScheduleLabel(change.scheduledAt, labels, settings.language, settings.timeFormat)}`);
      }
    }
    
    if (action.manageOperations && action.manageOperations.length > 0) {
      lines.push(settings.language === "ru" ? "Изменить:" : "Manage:");
      for (const operation of action.manageOperations) {
        const task = tasks.find((item) => item.id === operation.taskId);
        const title = task?.title ?? telegramCopy(settings.language, "task");
        if (operation.operation === "delete") {
          lines.push(settings.language === "ru" ? `• Удалить: ${title}` : `• Delete: ${title}`);
        } else if (operation.operation === "set_status") {
          const status = operation.status === "completed"
            ? (settings.language === "ru" ? "выполнено" : "completed")
            : (settings.language === "ru" ? "активно" : "active");
          lines.push(`• ${title}: ${status}`);
        } else {
          const fields = Object.entries(operation.changes)
            .map(([key, value]) => formatTelegramManageField(key, value, task, projects, settings, labels))
            .filter(Boolean)
            .join(", ");
          lines.push(`• ${title}: ${fields}`);
        }
      }
    }
    
    lines.push(settings.language === "ru" ? "Применить эти изменения?" : "Apply these changes?");
    return lines.join("\n");
  }

  return [
    settings.language === "ru" ? "Предложение изменить задачи:" : "Proposed task changes:",
    ...action.operations.map((operation) => {
      const task = tasks.find((item) => item.id === operation.taskId);
      const title = task?.title ?? telegramCopy(settings.language, "task");
      if (operation.operation === "delete") {
        return settings.language === "ru" ? `• Удалить: ${title}` : `• Delete: ${title}`;
      }
      if (operation.operation === "set_status") {
        const status = operation.status === "completed"
          ? (settings.language === "ru" ? "выполнено" : "completed")
          : (settings.language === "ru" ? "активно" : "active");
        return `• ${title}: ${status}`;
      }
      const fields = Object.entries(operation.changes)
        .map(([key, value]) => formatTelegramManageField(key, value, task, projects, settings, labels))
        .filter(Boolean)
        .join(", ");
      return `• ${title}: ${fields}`;
    }),
    settings.language === "ru" ? "Удаления необратимы. Применить?" : "Deletes are permanent. Apply?",
  ].join("\n");
}

function formatTelegramManageField(
  key: string,
  value: unknown,
  task: Task | undefined,
  projects: Project[],
  settings: UserSettings,
  labels: ReturnType<typeof scheduleLabelsFor>,
) {
  const language = settings.language;
  const empty = telegramCopy(language, "emptyValue");
  const projectName = (projectId: unknown) => projects.find((project) => project.id === projectId)?.name ?? empty;
  const formatValue = (field: string, raw: unknown) => {
    if (field === "scheduledAt") return typeof raw === "string" || raw === null ? formatScheduleLabel(raw, labels, language, settings.timeFormat) : empty;
    if (field === "durationMinutes") {
      if (raw === null) return language === "ru" ? "без длительности" : "no duration";
      return typeof raw === "number" ? (language === "ru" ? `${raw} мин` : `${raw} min`) : empty;
    }
    if (field === "reminderMinutes") {
      if (raw === null) return language === "ru" ? "по умолчанию" : "default";
      return typeof raw === "number" ? (language === "ru" ? `${raw} мин` : `${raw} min`) : empty;
    }
    if (field === "projectId") return projectName(raw);
    if (field === "tags") return Array.isArray(raw) && raw.length ? raw.join(", ") : empty;
    return typeof raw === "string" && raw.trim() ? raw : empty;
  };
  const fieldLabels: Record<string, string> = language === "ru"
    ? {
      title: "Название",
      description: "Описание",
      scheduledAt: "Время",
      durationMinutes: "Длительность",
      reminderMinutes: "Напоминание",
      projectId: "Категория",
      tags: "Теги",
    }
    : {
      title: "Title",
      description: "Description",
      scheduledAt: "Time",
      durationMinutes: "Duration",
      reminderMinutes: "Reminder",
      projectId: "Category",
      tags: "Tags",
    };
  const oldValues: Record<string, unknown> = {
    title: task?.title,
    description: task?.description,
    scheduledAt: task?.scheduledAt ?? null,
    durationMinutes: task?.durationMinutes ?? null,
    reminderMinutes: task?.reminderMinutes ?? null,
    projectId: task?.projectId,
    tags: task?.tags ?? [],
  };
  const label = fieldLabels[key];
  if (!label) return "";
  return `${label}: ${formatValue(key, oldValues[key])} -> ${formatValue(key, value)}`;
}

function normalizeTelegramError(error: unknown, language: UserSettings["language"]) {
  return getCleanLocalizedErrorMessage(error, language);
}

function sanitizeTelegramReply(value: string) {
  return value
    .replace(/<(?:think|thought|analysis)>[\s\S]*?<\/(?:think|thought|analysis)>/gi, "")
    .replace(/```(?:json)?[\s\S]*?```/gi, "")
    .replace(/[{}[\]]/g, "")
    .trim()
    .slice(0, 3000);
}

function scheduleLabelsFor(language: UserSettings["language"]) {
  return language === "ru"
    ? { noDate: "Без даты", overdue: "Просрочено", today: "Сегодня", tomorrow: "Завтра" }
    : { noDate: "No date", overdue: "Overdue", today: "Today", tomorrow: "Tomorrow" };
}

function getTomorrowDate() {
  const date = new Date();
  date.setDate(date.getDate() + 1);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

function telegramFailureCopyKey(reason: string) {
  if (reason === "expired" || reason === "replayed") return "expired";
  if (reason === "stale") return "stale";
  return "applyFailed";
}

function telegramCopy(language: UserSettings["language"], key: string) {
  const ru = language === "ru";
  const copy: Record<string, [string, string]> = {
    stale: ["Tasks changed after this preview. Send the request again and review a fresh proposal.", "\u0417\u0430\u0434\u0430\u0447\u0438 \u0438\u0437\u043c\u0435\u043d\u0438\u043b\u0438\u0441\u044c \u043f\u043e\u0441\u043b\u0435 \u043f\u0440\u0435\u0434\u043f\u0440\u043e\u0441\u043c\u043e\u0442\u0440\u0430. \u041e\u0442\u043f\u0440\u0430\u0432\u044c\u0442\u0435 \u0437\u0430\u043f\u0440\u043e\u0441 \u0441\u043d\u043e\u0432\u0430 \u0438 \u043f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u043d\u043e\u0432\u043e\u0435 \u043f\u0440\u0435\u0434\u043b\u043e\u0436\u0435\u043d\u0438\u0435."],
    empty: ["Send a text request.", "Отправьте текстовый запрос."],
    ambiguous: ["Please clarify what you want me to do with your tasks.", "Уточните, что нужно сделать с задачами."],
    expired: ["This confirmation expired. Send the request again.", "Это подтверждение истекло. Отправьте запрос снова."],
    canceled: ["Canceled. Nothing changed.", "Отменено. Ничего не изменилось."],
    applied: ["Done. Changes were applied in Aevum.", "Готово. Изменения применены в Aevum."],
    applyFailed: ["I could not safely apply that change. Open Aevum and try again.", "Не удалось безопасно применить изменение. Откройте Aevum и попробуйте снова."],
    openRouterMissing: ["OpenRouter setup is required in Aevum Settings.", "Нужно настроить OpenRouter в настройках Aevum."],
    ollamaUnavailable: ["Ollama is unavailable. Start Ollama on this computer and try again.", "Ollama недоступен. Запустите Ollama на этом компьютере и попробуйте снова."],
    ollamaModelMissing: ["The selected Telegram Ollama model is not installed.", "Выбранная модель Ollama для Telegram не установлена."],
    error: ["I could not handle that safely. Try again from Aevum.", "Не удалось безопасно обработать запрос. Попробуйте из Aevum."],
    noToday: ["No active tasks for today.", "На сегодня нет активных задач."],
    noUpcoming: ["No upcoming active tasks.", "Нет предстоящих активных задач."],
    task: ["Task", "Задача"],
    emptyValue: ["empty", "пусто"],
    templateIntro: ["Template Mode is active. Choose an action.", "Обычный режим активен. Выберите действие."],
    templateModeActive: ["Template Mode is active. Choose an action.", "Обычный режим активен. Выберите действие."],
    templateTextFallback: ["Use the buttons below, or switch to AI Mode for free-form requests.", "Используйте кнопки ниже или переключитесь в режим ИИ для свободных запросов."],
    aiModeActive: ["AI Mode is active. Send a request in your own words.", "Режим ИИ активен. Отправьте запрос своими словами."],
    templateToday: ["Today", "Сегодня"],
    templateTomorrow: ["Tomorrow", "Завтра"],
    templateUpcoming: ["Upcoming", "Предстоящее"],
    templateCreate: ["Create task", "Создать задачу"],
    aiModeButton: ["Switch to AI Mode", "Переключиться в режим ИИ"],
    templateModeButton: ["Return to Template Mode", "Вернуться в обычный режим"],
    aiHelp: ["Help", "Помощь"],
    templateCancel: ["Cancel", "Отменить"],
    templateCanceled: ["Canceled. Nothing changed.", "Отменено. Ничего не изменилось."],
    templateAskTitle: ["Send the task title.", "Отправьте название задачи."],
    templateAskDate: ["Choose a date, or type YYYY-MM-DD.", "Выберите дату или введите YYYY-MM-DD."],
    templateInvalidDate: ["I could not read that date. Use YYYY-MM-DD or choose a button.", "Не удалось прочитать дату. Введите YYYY-MM-DD или выберите кнопку."],
    templateNoDate: ["No date", "Без даты"],
    templateAskTime: ["Send a time like 18:00, or skip.", "Отправьте время, например 18:00, или пропустите."],
    templateInvalidTime: ["I could not read that time. Use HH:MM or skip.", "Не удалось прочитать время. Введите HH:MM или пропустите."],
    templateNoTime: ["No time", "Без времени"],
    templateAskDuration: ["Choose duration, or type minutes.", "Выберите длительность или введите минуты."],
    templateInvalidDuration: ["I could not read that duration. Choose a button or type minutes.", "Не удалось прочитать длительность. Выберите кнопку или введите минуты."],
    templateDuration15: ["15 min", "15 мин"],
    templateDuration30: ["30 min", "30 мин"],
    templateDuration60: ["60 min", "60 мин"],
    templateNoDuration: ["No duration", "Без длительности"],
    templateAskReminder: ["Choose reminder.", "Выберите напоминание."],
    templateInvalidReminder: ["Use one of the reminder buttons.", "Выберите одну из кнопок напоминания."],
    templateNoReminder: ["No reminder", "Без напоминания"],
    templateReminder10: ["10 min", "10 мин"],
    templateReminder30: ["30 min", "30 мин"],
  };
  return copy[key]?.[ru ? 1 : 0] ?? key;
}

function ProjectsView({
  projects,
  tasks,
  onAddProject,
  onDeleteProject,
  onOpenToday,
  onRenameProject,
}: {
  projects: Project[];
  tasks: Task[];
  onAddProject: (project: Omit<Project, "id">) => Project;
  onDeleteProject: (projectId: string) => void;
  onOpenToday: () => void;
  onRenameProject: (projectId: string, updates: Partial<Project>) => void;
}) {
  const { t } = useI18n();
  const [newCategoryName, setNewCategoryName] = useState("");
  const [editingCategoryId, setEditingCategoryId] = useState<string | null>(null);
  const [editingName, setEditingName] = useState("");
  const [categoryPendingDelete, setCategoryPendingDelete] = useState<Project | null>(null);

  function createCategory() {
    const name = newCategoryName.trim();
    if (!name) return;
    onAddProject({
      name,
      description: "",
      color: assignCategoryColor(projects),
    });
    setNewCategoryName("");
  }

  function saveCategoryName(projectId: string) {
    const name = editingName.trim();
    if (name) onRenameProject(projectId, { name });
    setEditingCategoryId(null);
    setEditingName("");
  }

  return (
    <div className="projects-view">
      <section className="category-create-panel">
        <div className="category-create-panel__title">
          <FolderKanban size={17} />
          <div>
            <h2>{t("projects.manageCategories")}</h2>
            <p>{t("projects.manageCategoriesDescription")}</p>
          </div>
        </div>
        <div className="category-create">
          <input
            value={newCategoryName}
            onChange={(event) => setNewCategoryName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === "Enter") createCategory();
            }}
            placeholder={t("projects.newCategoryPlaceholder")}
          />
          <button className="button button--primary" disabled={!newCategoryName.trim()} onClick={createCategory} type="button">
            <Plus size={16} />
            {t("projects.createCategory")}
          </button>
        </div>
      </section>

      <section className="projects-overview">
        {projects.map((project) => {
          const projectTasks = tasks.filter((task) => task.projectId === project.id);
          const activeCount = projectTasks.filter((task) => task.status === "active").length;
          const completedCount = projectTasks.length - activeCount;
          return (
            <article className="project-card project-row" key={project.id}>
              <span className="project-card__color project-row__color" style={{ background: project.color }} />
              <div className="project-card__header project-row__main">
                {editingCategoryId === project.id ? (
                  <input
                    value={editingName}
                    onChange={(event) => setEditingName(event.target.value)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter") saveCategoryName(project.id);
                      if (event.key === "Escape") setEditingCategoryId(null);
                    }}
                    autoFocus
                  />
                ) : (
                  <h2>{project.name}</h2>
                )}
                <p>{project.description}</p>
              </div>
              <div className="project-card__stats project-row__stats">
                <span>{activeCount} {t("projects.active")}</span>
                <span>{completedCount} {t("projects.done")}</span>
              </div>
              <div className="project-card__actions project-row__actions">
                {editingCategoryId === project.id ? (
                  <button className="icon-button" onClick={() => saveCategoryName(project.id)} type="button" aria-label={t("task.save")}>
                    <Save size={16} />
                  </button>
                ) : (
                  <button className="button button--secondary" onClick={() => {
                    setEditingCategoryId(project.id);
                    setEditingName(project.name);
                  }} type="button">
                    {t("projects.rename")}
                  </button>
                )}
                <button
                  className="icon-button icon-button--danger"
                  disabled={project.id === "uncategorized"}
                  onClick={() => setCategoryPendingDelete(project)}
                  type="button"
                  aria-label={t("projects.deleteCategory")}
                >
                  <Trash2 size={16} />
                </button>
              </div>
            </article>
          );
        })}
      </section>

      <section className="project-empty-panel project-empty-panel--compact">
        <div>
          <strong>{t("projects.ready")}</strong>
          <span>{t("projects.readyDescription")}</span>
        </div>
        <button className="button button--secondary" onClick={onOpenToday}>
          <ListChecks size={16} />
          {t("projects.reviewToday")}
        </button>
      </section>

      <section className="inbox-strip">
        <Inbox size={18} />
        <span>{t("projects.inboxStrip")}</span>
      </section>

      {categoryPendingDelete && (
        <div className="confirm-overlay" role="presentation" onMouseDown={() => setCategoryPendingDelete(null)}>
          <div className="confirm-dialog" role="dialog" aria-modal="true" aria-labelledby="delete-category-title" onMouseDown={(event) => event.stopPropagation()}>
            <h2 id="delete-category-title">{t("projects.confirmDelete")}</h2>
            <p>
              {categoryPendingDelete.name}: {tasks.filter((task) => task.projectId === categoryPendingDelete.id).length} {t("projects.tasksMoveToUncategorized")}
            </p>
            <div className="confirm-dialog__actions">
              <button className="button button--secondary" onClick={() => setCategoryPendingDelete(null)} type="button">
                {t("settings.cancel")}
              </button>
              <button className="button button--primary" onClick={() => {
                onDeleteProject(categoryPendingDelete.id);
                setCategoryPendingDelete(null);
              }} type="button">
                {t("settings.confirm")}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
