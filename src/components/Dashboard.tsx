import { AlertTriangle, CalendarClock, CheckCircle2, Clock3, ListChecks } from "lucide-react";
import { EmptyState } from "./EmptyState";
import { LoadingSkeleton } from "./LoadingSkeleton";
import { QuickAddTask } from "./QuickAddTask";
import { TaskCard } from "./TaskCard";
import { useI18n } from "../i18n";
import type { Project, Task, TaskDraft, TimeFormat } from "../types";
import { compareScheduledAt, formatScheduleLabel, isScheduledAfterToday, isScheduledBeforeToday, isScheduledToday } from "../utils/date";

interface DashboardProps {
  tasks: Task[];
  projects: Project[];
  isLoading: boolean;
  onAddTask: (task: TaskDraft) => void;
  onToggleTask: (taskId: string) => void;
  onDeleteTask: (taskId: string) => void;
  onUpdateTask: (taskId: string, updates: Partial<Task>) => void;
  onToggleSubtask: (taskId: string, subtaskId: string) => void;
  onBreakDownTask?: (task: Task) => Promise<string[]>;
  onEditTask?: (task: Task) => void;
  timeFormat: TimeFormat;
}

export function Dashboard(props: DashboardProps) {
  const { language, t } = useI18n();
  const { tasks, projects, isLoading, onAddTask, onToggleTask, onDeleteTask, onUpdateTask, onToggleSubtask, onBreakDownTask, onEditTask, timeFormat } = props;
  const activeTasks = tasks.filter((task) => task.status === "active");
  const todaysTasks = activeTasks.filter((task) => isScheduledToday(task.scheduledAt)).sort((a, b) => compareScheduledAt(a.scheduledAt, b.scheduledAt));
  const overdueTasks = activeTasks.filter((task) => isScheduledBeforeToday(task.scheduledAt)).sort((a, b) => compareScheduledAt(a.scheduledAt, b.scheduledAt));
  const upcomingTasks = activeTasks.filter((task) => isScheduledAfterToday(task.scheduledAt)).sort((a, b) => compareScheduledAt(a.scheduledAt, b.scheduledAt)).slice(0, 3);
  const focusTask = overdueTasks[0] ?? todaysTasks[0] ?? upcomingTasks[0];
  const focusProject = focusTask ? projects.find((project) => project.id === focusTask.projectId) : undefined;
  const scheduleLabels = { noDate: t("date.noDate"), overdue: t("date.overdue"), today: t("date.today"), tomorrow: t("date.tomorrow") };

  return (
    <div className="dashboard-grid">
      <section className="dashboard-hero">
        <div className="dashboard-hero__copy">
          <span className="eyebrow">{t("dashboard.today")}</span>
          <h2>{t("dashboard.heroTitle")}</h2>
          <p>{t("dashboard.heroDescription")}</p>
        </div>
        <QuickAddTask projects={projects} onAddTask={onAddTask} />
      </section>

      <section className="dashboard-panel dashboard-panel--focus">
        <div className="panel-heading">
          <div>
            <h2>{t("dashboard.focusTask")}</h2>
            <p>{t("dashboard.focusTaskDescription")}</p>
          </div>
          <ListChecks size={17} />
        </div>
        {focusTask ? (
          <div className="dashboard-focus-task">
            <span className="dashboard-focus-task__color" style={{ background: focusProject?.color ?? "var(--accent)" }} />
            <div>
              <strong>{focusTask.title}</strong>
              <span>
                {formatScheduleLabel(focusTask.scheduledAt, scheduleLabels, language, timeFormat)}
                {" - "}
                {focusProject?.name ?? t("task.project")}
              </span>
            </div>
          </div>
        ) : (
          <EmptyState
            icon={CheckCircle2}
            title={t("dashboard.noFocusTask")}
            description={t("dashboard.noFocusTaskDescription")}
          />
        )}
      </section>

      <section className="dashboard-panel dashboard-panel--large">
        <div className="panel-heading">
          <div>
            <h2>{t("dashboard.todaysTasks")}</h2>
            <p>{todaysTasks.length} {t("dashboard.activeDueToday")}</p>
          </div>
          <Clock3 size={17} />
        </div>
        {isLoading ? (
          <LoadingSkeleton />
        ) : todaysTasks.length === 0 ? (
          <EmptyState icon={CheckCircle2} title={t("dashboard.todayClear")} description={t("dashboard.todayClearDescription")} />
        ) : (
          <div className="dashboard-task-stack">
            {todaysTasks.map((task) => (
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
            ))}
          </div>
        )}
      </section>

      <section className="dashboard-panel">
        <div className="panel-heading">
          <div>
            <h2>{t("dashboard.overdue")}</h2>
            <p>{t("dashboard.needsDecision")}</p>
          </div>
          <AlertTriangle size={17} />
        </div>
        {overdueTasks.length === 0 ? (
          <EmptyState icon={CheckCircle2} title={t("dashboard.nothingOverdue")} description={t("dashboard.nothingOverdueDescription")} />
        ) : (
          <div className="compact-stack">
            {overdueTasks.map((task) => (
              <div className="compact-task" key={task.id}>
                <strong>{task.title}</strong>
                <span>
                  {formatScheduleLabel(
                    task.scheduledAt,
                    scheduleLabels,
                    language,
                    timeFormat,
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>

      <section className="dashboard-panel">
        <div className="panel-heading">
          <div>
            <h2>{t("dashboard.upcoming")}</h2>
            <p>{t("dashboard.nextDeadlines")}</p>
          </div>
          <CalendarClock size={17} />
        </div>
        {upcomingTasks.length === 0 ? (
          <EmptyState icon={CalendarClock} title={t("dashboard.noUpcoming")} description={t("dashboard.noUpcomingDescription")} />
        ) : (
          <div className="compact-stack">
            {upcomingTasks.map((task) => (
              <div className="compact-task" key={task.id}>
                <strong>{task.title}</strong>
                <span>
                  {formatScheduleLabel(
                    task.scheduledAt,
                    scheduleLabels,
                    language,
                    timeFormat,
                  )}
                </span>
              </div>
            ))}
          </div>
        )}
      </section>
    </div>
  );
}
