import { useMemo, useState, type CSSProperties } from "react";
import { useI18n } from "../i18n";
import type { Language, Project, Task, TimeFormat } from "../types";
import { compareScheduledAt, formatDateLabel, formatTime, getScheduleDate, getScheduleTime, getTodayISO, getTomorrowISO } from "../utils/date";

interface VisualizationViewProps {
  tasks: Task[];
  projects: Project[];
  timeFormat: TimeFormat;
}

interface ScheduledArc {
  task: Task;
  project?: Project;
  startMinutes: number;
  endMinutes: number;
  segmentStartMinutes: number;
  segmentDurationMinutes: number;
  durationMinutes: number;
  lane: number;
  period: DayPeriod;
}

type DayPeriod = "am" | "pm";

const dayMinutes = 24 * 60;
const halfDayMinutes = 12 * 60;
const dialSize = 360;
const dialCenter = dialSize / 2;
const hourNumbers = Array.from({ length: 12 }, (_, index) => (index === 0 ? 12 : index));

export function VisualizationView({ tasks, projects, timeFormat }: VisualizationViewProps) {
  const { language, t } = useI18n();
  const [selectedDate, setSelectedDate] = useState(getTodayISO());
  const [selectedArcKey, setSelectedArcKey] = useState<string | null>(null);
  const [hoveredArcKey, setHoveredArcKey] = useState<string | null>(null);
  const today = getTodayISO();
  const scheduleLabels = { noDate: t("date.noDate"), overdue: t("date.overdue"), today: t("date.today"), tomorrow: t("date.tomorrow") };
  const selectedDateLabel = getSelectedDateLabel(selectedDate, scheduleLabels, language);

  const dayTasks = useMemo(
    () =>
      tasks
        .filter((task) => task.status === "active" && getScheduleDate(task.scheduledAt) === selectedDate)
        .sort((a, b) => compareScheduledAt(a.scheduledAt, b.scheduledAt)),
    [selectedDate, tasks],
  );

  const scheduledTasks = useMemo(() => {
    const timedTasks = dayTasks.filter((task) => getScheduleTime(task.scheduledAt));
    const segments = timedTasks.flatMap((task) => {
      const startMinutes = getStartMinutes(task.scheduledAt);
      const durationMinutes = Math.max(task.durationMinutes ?? 30, 1);
      const endMinutes = Math.min(startMinutes + durationMinutes, dayMinutes);
      const project = projects.find((item) => item.id === task.projectId);
      return createSegments(task, project, startMinutes, endMinutes, durationMinutes);
    });

    const lanesByPeriod: Record<DayPeriod, number[]> = { am: [], pm: [] };
    return segments
      .sort((a, b) => a.period.localeCompare(b.period) || a.segmentStartMinutes - b.segmentStartMinutes)
      .map((segment) => {
        const lanes = lanesByPeriod[segment.period];
        const segmentEnd = segment.segmentStartMinutes + segment.segmentDurationMinutes;
        const lane = lanes.findIndex((laneEnd) => segment.segmentStartMinutes >= laneEnd);
        const nextLane = lane === -1 ? lanes.length : lane;
        lanes[nextLane] = segmentEnd;
        return { ...segment, lane: nextLane };
      });
  }, [dayTasks, projects]);

  const unscheduledTasks = dayTasks.filter((task) => !getScheduleTime(task.scheduledAt));
  const activeArcKey = hoveredArcKey ?? selectedArcKey;
  const activeTask = scheduledTasks.find((item) => getArcKey(item) === activeArcKey) ?? null;
  const currentMinutes = new Date().getHours() * 60 + new Date().getMinutes();
  const periodLaneCounts = getPeriodLaneCounts(scheduledTasks);
  const currentHand = getTextPoint(currentMinutes % halfDayMinutes, 86);

  function selectDate(nextDate: string) {
    setSelectedDate(nextDate);
    setSelectedArcKey(null);
    setHoveredArcKey(null);
  }

  return (
    <section className="visualization-page">
      <div className="visualization-header">
        <div>
          <span>{t("visualization.title")}</span>
          <h2>{selectedDateLabel}</h2>
        </div>
        <label className="visualization-date">
          <span>{t("visualization.selectedDate")}</span>
          <input value={selectedDate} onChange={(event) => selectDate(event.target.value)} type="date" />
        </label>
      </div>

      <div className="day-plan day-plan--circular">
        <div className="daily-dial-panel">
          <div className="daily-dial-wrap" key={selectedDate}>
            <svg className="daily-dial" viewBox={`0 0 ${dialSize} ${dialSize}`} role="img" aria-label={t("visualization.timeline")}>
              <circle className="daily-dial__face" cx={dialCenter} cy={dialCenter} r="151" />
              <circle className="daily-dial__period-guide daily-dial__period-guide--am" cx={dialCenter} cy={dialCenter} r="98" />
              <circle className="daily-dial__period-guide daily-dial__period-guide--pm" cx={dialCenter} cy={dialCenter} r="128" />
              {Array.from({ length: 60 }, (_, tick) => (
                <line
                  className={tick % 5 === 0 ? "daily-dial__tick daily-dial__tick--hour" : "daily-dial__tick daily-dial__tick--minute"}
                  key={tick}
                  {...getTickPoints(tick * 12, tick % 5 === 0 ? 143 : 148, 153)}
                />
              ))}
              {hourNumbers.map((hour) => (
                <text className="daily-dial__numeral" key={hour} {...getTextPoint((hour % 12) * 60, 72)}>
                  {hour}
                </text>
              ))}

              {scheduledTasks.map((item) => {
                const arcKey = getArcKey(item);
                const radius = getArcRadius(item.period, item.lane, periodLaneCounts[item.period]);
                const strokeWidth = getArcStrokeWidth(periodLaneCounts[item.period]);
                const isSelected = activeArcKey === arcKey;
                return (
                  <path
                    className={`daily-dial__arc daily-dial__arc--${item.period} ${isSelected ? "daily-dial__arc--selected" : ""}`}
                    d={describeArc(radius, item.segmentStartMinutes, item.segmentDurationMinutes)}
                    key={arcKey}
                    onBlur={() => setHoveredArcKey(null)}
                    onClick={() => setSelectedArcKey(arcKey)}
                    onFocus={() => setHoveredArcKey(arcKey)}
                    onKeyDown={(event) => {
                      if (event.key === "Enter" || event.key === " ") {
                        event.preventDefault();
                        setSelectedArcKey(arcKey);
                      }
                    }}
                    onMouseEnter={() => setHoveredArcKey(arcKey)}
                    onMouseLeave={() => setHoveredArcKey(null)}
                    role="button"
                    tabIndex={0}
                    style={{
                      "--task-color": item.project?.color ?? "var(--accent)",
                      "--arc-width": strokeWidth,
                    } as CSSProperties}
                  >
                    <title>{formatTaskRange(item, timeFormat)} - {item.task.title} - {item.project?.name ?? t("task.project")} - {formatDuration(item.durationMinutes)}</title>
                  </path>
                );
              })}

              {selectedDate === today ? (
                <g className="daily-dial__now">
                  <line x1={dialCenter} y1={dialCenter} x2={currentHand.x} y2={currentHand.y} />
                  <circle cx={dialCenter} cy={dialCenter} r="4" />
                </g>
              ) : null}
            </svg>
            {scheduledTasks.length === 0 ? <div className="daily-dial-empty">{t("visualization.noTimedTasks")}</div> : null}
          </div>
        </div>

        <div className="daily-detail-panel">
          <section className={activeTask ? "daily-detail-card daily-detail-card--visible" : "daily-detail-card"} aria-live="polite">
            {activeTask ? (
              <div className="daily-selected-task">
                <span className="daily-selected-task__color" style={{ background: activeTask.project?.color ?? "var(--accent)" }} />
                <div>
                  <strong>{activeTask.task.title}</strong>
                  <span>{formatTaskRange(activeTask, timeFormat)}</span>
                  <small>
                    {activeTask.project?.name ?? t("task.project")} - {formatDuration(activeTask.durationMinutes)}
                    {isRecurringTask(activeTask.task) ? ` - ${t("task.repeat")}` : ""}
                  </small>
                </div>
              </div>
            ) : (
              <p>{scheduledTasks.length === 0 ? t("visualization.noTimedTasks") : t("visualization.taskDetailsHint")}</p>
            )}
          </section>

          {unscheduledTasks.length > 0 ? (
            <section className="unscheduled-panel">
              <h3>{t("visualization.unscheduled")}</h3>
              <div className="compact-stack">
                {unscheduledTasks.map((task) => {
                  const project = projects.find((item) => item.id === task.projectId);
                  return (
                    <div className="compact-task compact-task--minimal" key={task.id}>
                      <strong>{task.title}</strong>
                      <span>
                        {project?.name ?? t("task.project")}
                        {isRecurringTask(task) ? ` - ${t("task.repeat")}` : ""}
                      </span>
                    </div>
                  );
                })}
              </div>
            </section>
          ) : null}
        </div>
      </div>
    </section>
  );
}

function getStartMinutes(value: string | null) {
  const time = getScheduleTime(value);
  if (!time) return 0;
  const [hours, minutes] = time.split(":").map(Number);
  return hours * 60 + minutes;
}

function createSegments(task: Task, project: Project | undefined, startMinutes: number, endMinutes: number, durationMinutes: number): Omit<ScheduledArc, "lane">[] {
  const segments: Omit<ScheduledArc, "lane">[] = [];
  const clippedEnd = Math.max(startMinutes + 1, endMinutes);

  if (startMinutes < halfDayMinutes) {
    const amEnd = Math.min(clippedEnd, halfDayMinutes);
    if (amEnd > startMinutes) {
      segments.push({
        task,
        project,
        startMinutes,
        endMinutes: clippedEnd,
        segmentStartMinutes: startMinutes,
        segmentDurationMinutes: amEnd - startMinutes,
        durationMinutes,
        period: "am",
      });
    }
  }

  if (clippedEnd > halfDayMinutes) {
    const pmStart = Math.max(startMinutes, halfDayMinutes);
    const pmEnd = Math.min(clippedEnd, dayMinutes);
    if (pmEnd > pmStart) {
      segments.push({
        task,
        project,
        startMinutes,
        endMinutes: clippedEnd,
        segmentStartMinutes: pmStart - halfDayMinutes,
        segmentDurationMinutes: pmEnd - pmStart,
        durationMinutes,
        period: "pm",
      });
    }
  }

  return segments;
}

function formatTaskRange(item: ScheduledArc, timeFormat: TimeFormat) {
  return `${formatMinutes(item.startMinutes, timeFormat)}-${formatMinutes(item.endMinutes, timeFormat, true)}`;
}

function formatMinutes(value: number, timeFormat: TimeFormat, allowEndOfDay = false) {
  if (allowEndOfDay && value >= dayMinutes && timeFormat === "24h") return "24:00";
  const minutes = allowEndOfDay && value >= dayMinutes ? 0 : ((value % dayMinutes) + dayMinutes) % dayMinutes;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return formatTime(`${String(hours).padStart(2, "0")}:${String(rest).padStart(2, "0")}`, timeFormat);
}

function formatDuration(minutes: number) {
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest ? `${hours}h ${rest}m` : `${hours}h`;
}

function isRecurringTask(task: Task) {
  return task.repeat.enabled || Boolean(task.recurringParentId);
}

function getArcKey(item: ScheduledArc) {
  return `${item.task.id}-${item.period}-${item.segmentStartMinutes}`;
}

function getSelectedDateLabel(
  value: string,
  labels: { overdue: string; today: string; tomorrow: string },
  language: Language,
) {
  if (value === getTodayISO()) return labels.today;
  if (value === getTomorrowISO()) return labels.tomorrow;
  return formatDateLabel(value, language);
}

function describeArc(radius: number, startMinutes: number, durationMinutes: number) {
  const endMinutes = startMinutes + Math.min(durationMinutes, halfDayMinutes - 0.01);
  const start = polarToCartesian(radius, endMinutes);
  const end = polarToCartesian(radius, startMinutes);
  const largeArcFlag = durationMinutes > halfDayMinutes / 2 ? 1 : 0;
  return `M ${start.x} ${start.y} A ${radius} ${radius} 0 ${largeArcFlag} 0 ${end.x} ${end.y}`;
}

function polarToCartesian(radius: number, minutes: number) {
  const angle = ((minutes % halfDayMinutes) / halfDayMinutes) * 360 - 90;
  const radians = (angle * Math.PI) / 180;
  return {
    x: dialCenter + radius * Math.cos(radians),
    y: dialCenter + radius * Math.sin(radians),
  };
}

function getTickPoints(minutes: number, innerRadius: number, outerRadius: number) {
  const inner = polarToCartesian(innerRadius, minutes);
  const outer = polarToCartesian(outerRadius, minutes);
  return { x1: inner.x, y1: inner.y, x2: outer.x, y2: outer.y };
}

function getTextPoint(minutes: number, radius: number) {
  const point = polarToCartesian(radius, minutes);
  return { x: point.x, y: point.y };
}

function getPeriodLaneCounts(tasks: ScheduledArc[]) {
  return tasks.reduce<Record<DayPeriod, number>>(
    (counts, task) => ({
      ...counts,
      [task.period]: Math.max(counts[task.period], task.lane + 1),
    }),
    { am: 1, pm: 1 },
  );
}

function getArcRadius(period: DayPeriod, lane: number, laneCount: number) {
  const step = Math.max(8.5, 18 / Math.max(laneCount, 1));
  const baseRadius = period === "am" ? 94 : 122;
  return baseRadius + lane * step;
}

function getArcStrokeWidth(laneCount: number) {
  return Math.max(3.8, Math.min(5.4, 21 / Math.max(laneCount + 2, 3)));
}
