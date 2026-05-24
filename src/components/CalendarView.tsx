import { CalendarDays } from "lucide-react";
import { useMemo, useState } from "react";
import { useI18n } from "../i18n";
import type { Project, Task, TimeFormat } from "../types";
import { compareScheduledAt, formatScheduleLabel, getRelativeDateLabel, getScheduleDate, getTodayISO, getTomorrowISO } from "../utils/date";

interface CalendarViewProps {
  tasks: Task[];
  projects: Project[];
  timeFormat: TimeFormat;
}

type CalendarTab = "today" | "tomorrow" | "week" | "upcoming";

export function CalendarView({ tasks, projects, timeFormat }: CalendarViewProps) {
  const { language, t } = useI18n();
  const [activeTab, setActiveTab] = useState<CalendarTab>("today");
  const scheduleLabels = { noDate: t("date.noDate"), overdue: t("date.overdue"), today: t("date.today"), tomorrow: t("date.tomorrow") };
  const groupedTasks = useMemo(() => {
    return tasks
      .filter((task) => task.status === "active" && task.scheduledAt && matchesTab(task.scheduledAt, activeTab))
      .sort((a, b) => compareScheduledAt(a.scheduledAt, b.scheduledAt))
      .reduce<Record<string, Task[]>>((groups, task) => {
        const date = getScheduleDate(task.scheduledAt);
        groups[date] = [...(groups[date] ?? []), task];
        return groups;
      }, {});
  }, [activeTab, tasks]);

  const tabs: Array<{ id: CalendarTab; label: string }> = [
    { id: "today", label: t("calendar.today") },
    { id: "tomorrow", label: t("calendar.tomorrow") },
    { id: "week", label: t("calendar.thisWeek") },
    { id: "upcoming", label: t("calendar.upcoming") },
  ];

  return (
    <section className="calendar-view">
      <div className="calendar-tabs">
        {tabs.map((item) => (
          <button className={activeTab === item.id ? "calendar-tabs__item calendar-tabs__item--active" : "calendar-tabs__item"} key={item.id} onClick={() => setActiveTab(item.id)} type="button">
            {item.label}
          </button>
        ))}
      </div>

      <div className="timeline">
        {Object.entries(groupedTasks).map(([date, dateTasks]) => (
          <section className="timeline-day" key={date}>
            <div className="timeline-day__date">
              <CalendarDays size={17} />
              <span>{getRelativeDateLabel(date, scheduleLabels, language)}</span>
              <strong>{formatScheduleLabel(date, scheduleLabels, language, timeFormat)}</strong>
            </div>
            <div className="timeline-day__tasks">
              {dateTasks.map((task) => {
                const project = projects.find((item) => item.id === task.projectId);
                return (
                  <article className="timeline-task" key={task.id}>
                    <span className="timeline-task__rail" style={{ background: project?.color }} />
                    <div>
                      <h3>{task.title}</h3>
                      <p>
                        {formatScheduleLabel(task.scheduledAt, scheduleLabels, language, timeFormat)}
                        {" · "}
                        {project?.name ?? t("task.project")}
                      </p>
                    </div>
                  </article>
                );
              })}
            </div>
          </section>
        ))}
      </div>
    </section>
  );
}

function matchesTab(value: string | null, tab: CalendarTab) {
  const date = getScheduleDate(value);
  if (!date) return false;
  const today = getTodayISO();
  const tomorrow = getTomorrowISO();
  if (tab === "today") return date === today;
  if (tab === "tomorrow") return date === tomorrow;
  if (tab === "upcoming") return date >= today;

  const endOfWeek = new Date(`${today}T12:00:00`);
  endOfWeek.setDate(endOfWeek.getDate() + 6);
  return date >= today && date <= getTodayISO(endOfWeek);
}
