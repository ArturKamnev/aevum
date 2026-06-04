import { CalendarDays, Search, SlidersHorizontal } from "lucide-react";
import { useMemo } from "react";
import { EmptyState } from "./EmptyState";
import { TaskCard } from "./TaskCard";
import { useI18n } from "../i18n";
import type { CategoryDateFilter, Project, SortMode, Task, TaskStatus, TimeFormat } from "../types";
import { compareScheduledAt, formatScheduleLabel, getRelativeDateLabel, getScheduleDate, getTodayISO, getTomorrowISO } from "../utils/date";

interface TaskListProps {
  tasks: Task[];
  projects: Project[];
  query: string;
  setQuery: (query: string) => void;
  statusFilter: TaskStatus | "all";
  setStatusFilter: (status: TaskStatus | "all") => void;
  categoryFilter: string;
  setCategoryFilter: (projectId: string) => void;
  categoryDateFilter?: CategoryDateFilter;
  setCategoryDateFilter?: (filter: CategoryDateFilter) => void;
  sortMode: SortMode;
  setSortMode: (mode: SortMode) => void;
  onToggleTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void;
  onToggleSubtask: (taskId: string, subtaskId: string) => void;
  onBreakDownTask?: (task: Task) => Promise<string[]>;
  onEditTask?: (task: Task) => void;
  timeFormat: TimeFormat;
  viewMode?: "today" | "upcoming" | "category";
  activeCategory?: Project;
  hideCategoryFilter?: boolean;
  totalCount?: number;
}

const statusScore: Record<TaskStatus, number> = { active: 0, completed: 1 };
const categoryDateFilters: CategoryDateFilter[] = ["today", "tomorrow", "week", "all"];

export function filterAndSortTasks({
  tasks,
  query,
  statusFilter,
  categoryFilter,
  categoryDateFilter = "all",
  sortMode,
}: Pick<TaskListProps, "tasks" | "query" | "statusFilter" | "categoryFilter" | "sortMode"> & { categoryDateFilter?: CategoryDateFilter }) {
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
      const matchesCategoryDate = categoryFilter === "all" || categoryDateFilter === "all" || isInCategoryDateFilter(task, categoryDateFilter);
      return matchesQuery && matchesStatus && matchesCategory && matchesCategoryDate;
    })
    .sort((a, b) => {
      if (sortMode === "status") return statusScore[a.status] - statusScore[b.status];
      return compareScheduledAt(a.scheduledAt, b.scheduledAt);
    });
}

export function TaskList(props: TaskListProps) {
  const { language, t } = useI18n();
  const {
    tasks,
    projects,
    query,
    setQuery,
    statusFilter,
    setStatusFilter,
    categoryFilter,
    setCategoryFilter,
    categoryDateFilter = "all",
    setCategoryDateFilter,
    sortMode,
    setSortMode,
    onToggleTask,
    onDeleteTask,
    onUpdateTask,
    onToggleSubtask,
    onBreakDownTask,
    onEditTask,
    timeFormat,
    viewMode = "today",
    activeCategory,
    hideCategoryFilter = false,
    totalCount,
  } = props;

  const visibleTasks = useMemo(
    () => filterAndSortTasks({ tasks, query, statusFilter, categoryFilter, categoryDateFilter, sortMode }),
    [categoryDateFilter, categoryFilter, query, sortMode, statusFilter, tasks],
  );
  const scheduleLabels = { noDate: t("date.noDate"), overdue: t("date.overdue"), today: t("date.today"), tomorrow: t("date.tomorrow") };
  const upcomingGroups = useMemo(() => {
    return visibleTasks.reduce<Record<string, Task[]>>((groups, task) => {
      const date = getScheduleDate(task.scheduledAt) || "unscheduled";
      groups[date] = [...(groups[date] ?? []), task];
      return groups;
    }, {});
  }, [visibleTasks]);

  function renderTask(task: Task) {
    return (
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
    );
  }

  return (
    <section className={`task-list-panel task-list-panel--${viewMode}`}>
      <div className="panel-heading">
        <div>
          <div className="task-list-panel__title">
            {viewMode === "category" && activeCategory ? <span className="project-dot" style={{ background: activeCategory.color }} /> : null}
            <h2>{viewMode === "category" && activeCategory ? activeCategory.name : viewMode === "upcoming" ? t("nav.upcoming") : t("nav.today")}</h2>
          </div>
          <p>{totalCount ?? visibleTasks.length} {t("task.matchingItems")}</p>
        </div>
        <SlidersHorizontal size={18} />
      </div>

      <div className={`task-toolbar ${hideCategoryFilter ? "task-toolbar--compact" : ""} ${viewMode === "category" ? "task-toolbar--category" : ""}`}>
        <label className="search-field">
          <Search size={17} />
          <input value={query} onChange={(event) => setQuery(event.target.value)} placeholder={t("task.searchPlaceholder")} />
        </label>
        <select value={statusFilter} onChange={(event) => setStatusFilter(event.target.value as TaskStatus | "all")}>
          <option value="all">{t("task.allStatuses")}</option>
          <option value="active">{t("task.active")}</option>
          <option value="completed">{t("task.completed")}</option>
        </select>
        {!hideCategoryFilter && (
          <select value={categoryFilter} onChange={(event) => setCategoryFilter(event.target.value)}>
            <option value="all">{t("task.allCategories")}</option>
            {projects.map((project) => (
              <option key={project.id} value={project.id}>
                {project.name}
              </option>
            ))}
          </select>
        )}
        {viewMode === "category" && setCategoryDateFilter ? (
          <div className="segmented-control task-toolbar__date-filter" role="group" aria-label={t("task.categoryDateFilter")}>
            {categoryDateFilters.map((filter) => (
              <button
                className={`segmented-control__item ${categoryDateFilter === filter ? "segmented-control__item--active" : ""}`}
                key={filter}
                onClick={() => setCategoryDateFilter(filter)}
                type="button"
              >
                {getCategoryDateFilterLabel(filter, t)}
              </button>
            ))}
          </div>
        ) : null}
        <select value={sortMode} onChange={(event) => setSortMode(event.target.value as SortMode)}>
          <option value="deadline">{t("task.sort.deadline")}</option>
          <option value="status">{t("task.sort.status")}</option>
        </select>
      </div>

      <div className="task-list">
        {visibleTasks.length === 0 ? (
          <EmptyState
            icon={Search}
            title={viewMode === "category" && activeCategory ? t("task.noCategoryDateMatch") : t("task.noMatch")}
            description={viewMode === "category" && activeCategory
              ? `${activeCategory.name} - ${getCategoryDateFilterLabel(categoryDateFilter, t)}. ${t("task.categoryDateEmptyDescription")}`
              : t("task.noMatchDescription")}
          />
        ) : viewMode === "upcoming" ? (
          <div className="upcoming-timeline">
            {Object.entries(upcomingGroups).map(([date, dateTasks]) => (
              <section className="upcoming-day" key={date}>
                <div className="upcoming-day__date">
                  <CalendarDays size={16} />
                  <span>{date === "unscheduled" ? t("date.noDate") : getRelativeDateLabel(date, scheduleLabels, language)}</span>
                  {date !== "unscheduled" ? <strong>{formatScheduleLabel(date, scheduleLabels, language, timeFormat)}</strong> : null}
                </div>
                <div className="upcoming-day__tasks">
                  {dateTasks.map(renderTask)}
                </div>
              </section>
            ))}
          </div>
        ) : (
          visibleTasks.map(renderTask)
        )}
      </div>
    </section>
  );
}

function isInCategoryDateFilter(task: Task, filter: CategoryDateFilter) {
  const date = getScheduleDate(task.scheduledAt);
  if (!date) return false;
  if (filter === "today") return date === getTodayISO();
  if (filter === "tomorrow") return date === getTomorrowISO();
  if (filter === "week") {
    const today = getTodayISO();
    const weekEnd = getOffsetDateISO(6);
    return date >= today && date <= weekEnd;
  }
  return true;
}

function getCategoryDateFilterLabel(filter: CategoryDateFilter, t: ReturnType<typeof useI18n>["t"]) {
  if (filter === "today") return t("task.dateFilter.today");
  if (filter === "tomorrow") return t("task.dateFilter.tomorrow");
  if (filter === "week") return t("task.dateFilter.week");
  return t("task.dateFilter.all");
}

function getOffsetDateISO(days: number) {
  const date = new Date();
  date.setDate(date.getDate() + days);
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}
