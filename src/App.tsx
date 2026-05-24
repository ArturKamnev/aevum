import { FolderKanban, Inbox, ListChecks, Plus, Save, Trash2 } from "lucide-react";
import { useCallback, useEffect, useMemo, useState } from "react";
import { AIAssistantPanel } from "./components/AIAssistantPanel";
import { AppShell } from "./components/AppShell";
import { CalendarView } from "./components/CalendarView";
import { CommandPalette } from "./components/CommandPalette";
import { Dashboard } from "./components/Dashboard";
import { EmptyState } from "./components/EmptyState";
import { SettingsPage } from "./components/SettingsPage";
import { OnboardingFlow } from "./components/OnboardingFlow";
import { TaskModal } from "./components/TaskModal";
import { TaskList } from "./components/TaskList";
import { VisualizationView } from "./components/VisualizationView";
import { initialMessages } from "./data/sampleData";
import { useTheme } from "./hooks/useTheme";
import { useI18n } from "./i18n";
import { breakDownTaskWithAI } from "./services/aiService";
import { loadProjects, loadTasks, saveProjects, saveTasks } from "./services/localStore";
import type { AssistantMessage, Project, SortMode, Task, TaskDraft, TaskStatus, UserSettings, ViewId } from "./types";
import { isScheduledAfterToday, isScheduledBeforeToday, isScheduledToday } from "./utils/date";
import { createProjectId, createTaskId } from "./utils/id";
import { calculateNextRepeatAt, createNextRecurringTask } from "./utils/recurrence";

const defaultSettings: UserSettings = {
  theme: "dark",
  timeFormat: "24h",
  language: "en",
  aiProvider: "ollama",
  aiBaseUrl: "http://localhost:11434",
  localModel: "llama3.1:latest",
  cloudModel: "openrouter/free",
  notifications: true,
  defaultReminderMinutes: 0,
  availabilityBlocks: [],
  onboardingCompleted: false,
  startupBehavior: "dashboard",
  autoPlanDay: true,
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
  const [settings, setSettings] = useState<UserSettings>(() => loadSettings(theme, language));
  const [isCommandOpen, setIsCommandOpen] = useState(false);
  const [isTaskModalOpen, setIsTaskModalOpen] = useState(false);
  const [editingTask, setEditingTask] = useState<Task | null>(null);
  const [query, setQuery] = useState("");
  const [statusFilter, setStatusFilter] = useState<TaskStatus | "all">("all");
  const [categoryFilter, setCategoryFilter] = useState("all");
  const [sortMode, setSortMode] = useState<SortMode>("deadline");
  const [isLoading] = useState(false);

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

  const toggleTask = useCallback((taskId: string) => {
    setTasks((currentTasks) => {
      const now = new Date().toISOString();
      const task = currentTasks.find((item) => item.id === taskId);
      if (!task) return currentTasks;
      const nextStatus: TaskStatus = task.status === "completed" ? "active" : "completed";
      const updatedTask: Task = { ...task, status: nextStatus, updatedAt: now };
      const updatedTasks = currentTasks.map((item) => (item.id === taskId ? updatedTask : item));
      if (nextStatus !== "completed" || !task.repeat.enabled) return updatedTasks;
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

  const deleteTask = useCallback((taskId: string) => {
    const task = tasks.find((item) => item.id === taskId);
    const message = task ? `${t("task.confirmDelete")} "${task.title}"?` : t("task.confirmDelete");
    if (!window.confirm(message)) return;
    setTasks((currentTasks) => currentTasks.filter((task) => task.id !== taskId));
  }, [tasks, t]);

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

        {(activeView === "today" || activeView === "upcoming") && <TaskList tasks={scopedTasks} timeFormat={settings.timeFormat} {...taskListProps} />}

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
            addProject={addProject}
            addTask={addTask}
            messages={messages}
            onUpdateTask={updateTask}
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
    </>
  );
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
      color: "var(--project-sage)",
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
        <div>
          <h2>{t("projects.manageCategories")}</h2>
          <p>{t("projects.manageCategoriesDescription")}</p>
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
            <article className="project-card" key={project.id}>
              <span className="project-card__color" style={{ background: project.color }} />
              <div className="project-card__header">
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
              <div className="project-card__stats">
                <span>{activeCount} {t("projects.active")}</span>
                <span>{completedCount} {t("projects.done")}</span>
              </div>
              <div className="project-card__actions">
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

      <section className="project-empty-panel">
        <EmptyState
          icon={FolderKanban}
          title={t("projects.ready")}
          description={t("projects.readyDescription")}
          action={
            <button className="button button--secondary" onClick={onOpenToday}>
              <ListChecks size={16} />
              {t("projects.reviewToday")}
            </button>
          }
        />
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
