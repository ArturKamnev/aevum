import { Search, SlidersHorizontal } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "./EmptyState";
import { TaskCard } from "./TaskCard";
import { useI18n } from "../i18n";
import type { Project, SortMode, Task, TaskStatus, TimeFormat } from "../types";
import { compareScheduledAt } from "../utils/date";

interface TaskListProps {
  tasks: Task[];
  projects: Project[];
  query: string;
  setQuery: (query: string) => void;
  statusFilter: TaskStatus | "all";
  setStatusFilter: (status: TaskStatus | "all") => void;
  categoryFilter: string;
  setCategoryFilter: (projectId: string) => void;
  sortMode: SortMode;
  setSortMode: (mode: SortMode) => void;
  onToggleTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void;
  onToggleSubtask: (taskId: string, subtaskId: string) => void;
  onBreakDownTask?: (task: Task) => Promise<string[]>;
  onEditTask?: (task: Task) => void;
  timeFormat: TimeFormat;
}

const statusScore: Record<TaskStatus, number> = { active: 0, completed: 1 };

export function filterAndSortTasks({
  tasks,
  query,
  statusFilter,
  categoryFilter,
  sortMode,
}: Pick<TaskListProps, "tasks" | "query" | "statusFilter" | "categoryFilter" | "sortMode">) {
  const normalizedQuery = query.trim().toLowerCase();

  return tasks
    .filter((task) => {
      const matchesQuery =
        !normalizedQuery ||
        task.title.toLowerCase().includes(normalizedQuery) ||
        task.description.toLowerCase().includes(normalizedQuery) ||
        task.tags.some((tag) => tag.toLowerCase().includes(normalizedQuery));
      const matchesStatus = statusFilter === "all" || task.status === statusFilter;
      const matchesCategory = categoryFilter === "all" || task.projectId === categoryFilter;
      return matchesQuery && matchesStatus && matchesCategory;
    })
    .sort((a, b) => {
      if (sortMode === "status") return statusScore[a.status] - statusScore[b.status];
      return compareScheduledAt(a.scheduledAt, b.scheduledAt);
    });
}

export function TaskList(props: TaskListProps) {
  const { t } = useI18n();
  const {
    tasks,
    projects,
    query,
    setQuery,
    statusFilter,
    setStatusFilter,
    categoryFilter,
    setCategoryFilter,
    sortMode,
    setSortMode,
    onToggleTask,
    onDeleteTask,
  onUpdateTask,
  onToggleSubtask,
  onBreakDownTask,
  onEditTask,
  timeFormat,
  } = props;

  const visibleTasks = useMemo(
    () => filterAndSortTasks({ tasks, query, statusFilter, categoryFilter, sortMode }),
    [categoryFilter, query, sortMode, statusFilter, tasks],
  );

  return (
    <section className="task-list-panel">
      <div className="panel-heading">
        <div>
          <h2>{t("task.tasks")}</h2>
          <p>{visibleTasks.length} {t("task.matchingItems")}</p>
        </div>
        <SlidersHorizontal size={18} />
      </div>

      <div className="task-toolbar">
        <label className="search-field">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("task.searchPlaceholder")} />
        </label>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")}>
          <option value="all">{t("task.allStatuses")}</option>
          <option value="active">{t("task.active")}</option>
          <option value="completed">{t("task.completed")}</option>
        </select>
        <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
          <option value="all">{t("task.allCategories")}</option>
          {projects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
          <option value="deadline">{t("task.sort.deadline")}</option>
          <option value="status">{t("task.sort.status")}</option>
        </select>
      </div>

      <div className="task-list">
        {visibleTasks.length === 0 ? (
          <EmptyState
            icon={Search}
            title={t("task.noMatch")}
            description={t("task.noMatchDescription")}
          />
        ) : (
          visibleTasks.map((task) => (
            <TaskCard
              key={task.id}
              task={task}
              project={projects.find((project) => project.id === task.projectId)}
              onToggleTask={onToggleTask}
              onDeleteTask={onDeleteTask}
              onUpdateTask={onUpdateTask}
              onToggleSubtask={onToggleSubtask}
              onBreakDownTask={onBreakDownTask}
              onEditTask={onEditTask}
              timeFormat={timeFormat}
            />
          ))
        )}
      </div>
    </section>
  );
}
