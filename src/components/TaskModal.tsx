import { CalendarX, Save, X } from "lucide-react";
import { FormEvent, useEffect, useMemo, useRef, useState } from "react";
import { useI18n } from "../i18n";
import type { Project, ReminderOffsetMinutes, RepeatRule, RepeatUnit, Task, TaskDraft } from "../types";
import { combineDateAndTime, getScheduleDate, getScheduleTime, getTodayISO } from "../utils/date";
import { calculateNextRepeatAt, defaultRepeat } from "../utils/recurrence";

interface TaskModalProps {
  mode: "create" | "edit";
  projects: Project[];
  task?: Task;
  onClose: () => void;
  onSave: (draft: TaskDraft) => void;
}

type RepeatPreset =
  | "none"
  | "daily"
  | "weekday"
  | "weekend"
  | "monday"
  | "tuesday"
  | "wednesday"
  | "thursday"
  | "friday"
  | "saturday"
  | "sunday"
  | "custom-weekdays"
  | "custom-interval";

const weekdayPresets: Record<Exclude<RepeatPreset, "none" | "daily" | "weekday" | "weekend" | "custom-weekdays" | "custom-interval">, number> = {
  sunday: 0,
  monday: 1,
  tuesday: 2,
  wednesday: 3,
  thursday: 4,
  friday: 5,
  saturday: 6,
};

const weekdayNumbers = [1, 2, 3, 4, 5, 6, 0];

export function TaskModal({ mode, projects, task, onClose, onSave }: TaskModalProps) {
  const { t } = useI18n();
  const closeTimer = useRef<number | null>(null);
  const [isClosing, setIsClosing] = useState(false);
  const [title, setTitle] = useState("");
  const [description, setDescription] = useState("");
  const [projectId, setProjectId] = useState(projects[0]?.id ?? "");
  const [date, setDate] = useState(getTodayISO());
  const [time, setTime] = useState("");
  const [durationPreset, setDurationPreset] = useState("");
  const [customDuration, setCustomDuration] = useState("");
  const [reminderMinutes, setReminderMinutes] = useState<ReminderOffsetMinutes | null>(null);
  const [repeatPreset, setRepeatPreset] = useState<RepeatPreset>("none");
  const [repeatInterval, setRepeatInterval] = useState(1);
  const [repeatUnit, setRepeatUnit] = useState<RepeatUnit>("day");
  const [repeatWeekdays, setRepeatWeekdays] = useState<number[]>([]);
  const [excludedWeekdays, setExcludedWeekdays] = useState<number[]>([]);

  useEffect(() => {
    setTitle(task?.title ?? "");
    setDescription(task?.description ?? "");
    setProjectId(task?.projectId ?? projects[0]?.id ?? "");
    setDate(getScheduleDate(task?.scheduledAt) || getTodayISO());
    setTime(getScheduleTime(task?.scheduledAt));
    const duration = task?.durationMinutes ?? null;
    setDurationPreset(duration && [15, 30, 60, 120].includes(duration) ? String(duration) : duration ? "custom" : "");
    setCustomDuration(duration && ![15, 30, 60, 120].includes(duration) ? String(duration) : "");
    setReminderMinutes(task?.reminderMinutes ?? null);
    const repeat = task?.repeat ?? defaultRepeat;
    setRepeatPreset(repeatToPreset(repeat));
    setRepeatInterval(repeat.interval);
    setRepeatUnit(repeat.unit);
    setRepeatWeekdays(repeat.weekdays);
    setExcludedWeekdays(repeat.excludedWeekdays);
  }, [projects, task]);

  useEffect(() => () => {
    if (closeTimer.current) {
      window.clearTimeout(closeTimer.current);
    }
  }, []);

  const repeat = useMemo(
    () => buildRepeatRule(repeatPreset, repeatInterval, repeatUnit, repeatWeekdays, excludedWeekdays),
    [excludedWeekdays, repeatInterval, repeatPreset, repeatUnit, repeatWeekdays],
  );

  function handleSubmit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const trimmedTitle = title.trim();
    if (!trimmedTitle) return;
    const durationMinutes = durationPreset === "custom" ? Math.max(1, Number(customDuration) || 0) : durationPreset ? Number(durationPreset) : null;
    const scheduledAt = combineDateAndTime(date, time);

    onSave({
      title: trimmedTitle,
      description: description.trim(),
      status: task?.status ?? "active",
      scheduledAt,
      projectId: projectId || projects[0]?.id || "uncategorized",
      durationMinutes,
      reminderMinutes,
      repeat,
      nextRepeatAt: calculateNextRepeatAt({ scheduledAt, repeat }),
      tags: task?.tags ?? [],
      subtasks: task?.subtasks ?? [],
    });
  }

  function requestClose() {
    if (closeTimer.current) return;
    setIsClosing(true);
    closeTimer.current = window.setTimeout(onClose, 150);
  }

  function toggleWeekday(day: number, target: "included" | "excluded") {
    const setter = target === "included" ? setRepeatWeekdays : setExcludedWeekdays;
    setter((current) => (current.includes(day) ? current.filter((item) => item !== day) : [...current, day].sort((a, b) => a - b)));
  }

  return (
    <div className={`confirm-overlay ${isClosing ? "confirm-overlay--closing" : ""}`} role="presentation" onMouseDown={requestClose}>
      <form className={`task-modal ${isClosing ? "task-modal--closing" : ""}`} role="dialog" aria-modal="true" aria-labelledby="task-modal-title" onMouseDown={(event) => event.stopPropagation()} onSubmit={handleSubmit}>
        <div className="task-modal__header">
          <div>
            <h2 id="task-modal-title">{mode === "create" ? t("task.newTask") : t("task.editTask")}</h2>
            <p>{t("task.modalDescription")}</p>
          </div>
          <button className="icon-button" onClick={requestClose} type="button" aria-label={t("settings.cancel")}>
            <X size={16} />
          </button>
        </div>

        <label className="task-modal__field">
          <span>{t("task.title")}</span>
          <input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} placeholder={t("task.newTitle")} />
        </label>

        <label className="task-modal__field">
          <span>{t("task.description")}</span>
          <textarea value={description} onChange={(event) => setDescription(event.target.value)} placeholder={t("task.descriptionPlaceholder")} />
        </label>

        <div className="task-modal__grid">
          <label className="task-modal__field">
            <span>{t("task.project")}</span>
            <select value={projectId} onChange={(event) => setProjectId(event.target.value)}>
              {projects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          </label>
          <label className="task-modal__field">
            <span>{t("task.duration")}</span>
            <select value={durationPreset} onChange={(event) => setDurationPreset(event.target.value)}>
              <option value="">{t("task.noDuration")}</option>
              <option value="15">{t("task.duration15")}</option>
              <option value="30">{t("task.duration30")}</option>
              <option value="60">{t("task.duration60")}</option>
              <option value="120">{t("task.duration120")}</option>
              <option value="custom">{t("task.customDuration")}</option>
            </select>
          </label>
        </div>

        <label className="task-modal__field">
          <span>{t("task.reminder")}</span>
          <select value={reminderMinutes ?? ""} onChange={(event) => setReminderMinutes(event.target.value === "" ? null : Number(event.target.value) as ReminderOffsetMinutes)}>
            <option value="">{t("task.reminderDefault")}</option>
            <option value={0}>{t("settings.reminderAtTime")}</option>
            <option value={5}>{t("settings.reminder5")}</option>
            <option value={10}>{t("settings.reminder10")}</option>
            <option value={30}>{t("settings.reminder30")}</option>
            <option value={60}>{t("settings.reminder60")}</option>
          </select>
        </label>

        {durationPreset === "custom" && (
          <label className="task-modal__field">
            <span>{t("task.customDurationMinutes")}</span>
            <input min="1" value={customDuration} onChange={(event) => setCustomDuration(event.target.value)} type="number" />
          </label>
        )}

        <div className="task-modal__grid">
          <label className="task-modal__field">
            <span>{t("task.date")}</span>
            <input value={date} onChange={(event) => setDate(event.target.value)} onInput={(event) => setDate(event.currentTarget.value)} type="date" />
          </label>
          <label className="task-modal__field">
            <span>{t("task.time")}</span>
            <input value={time} onChange={(event) => setTime(event.target.value)} onInput={(event) => setTime(event.currentTarget.value)} type="time" />
          </label>
        </div>

        <label className="task-modal__field">
          <span>{t("task.repeat")}</span>
          <select value={repeatPreset} onChange={(event) => setRepeatPreset(event.target.value as RepeatPreset)}>
            <option value="none">{t("task.repeat.none")}</option>
            <option value="daily">{t("task.repeat.everyDay")}</option>
            <option value="weekday">{t("task.repeat.everyWeekday")}</option>
            <option value="weekend">{t("task.repeat.everyWeekend")}</option>
            <option value="monday">{t("task.repeat.everyMonday")}</option>
            <option value="tuesday">{t("task.repeat.everyTuesday")}</option>
            <option value="wednesday">{t("task.repeat.everyWednesday")}</option>
            <option value="thursday">{t("task.repeat.everyThursday")}</option>
            <option value="friday">{t("task.repeat.everyFriday")}</option>
            <option value="saturday">{t("task.repeat.everySaturday")}</option>
            <option value="sunday">{t("task.repeat.everySunday")}</option>
            <option value="custom-weekdays">{t("task.repeat.customWeekdays")}</option>
            <option value="custom-interval">{t("task.repeat.customInterval")}</option>
          </select>
        </label>

        {repeatPreset === "daily" && (
          <WeekdayPicker
            label={t("task.repeatExcept")}
            selected={excludedWeekdays}
            toggle={(day) => toggleWeekday(day, "excluded")}
            t={t}
          />
        )}

        {repeatPreset === "custom-weekdays" && (
          <WeekdayPicker
            label={t("task.repeatOn")}
            selected={repeatWeekdays}
            toggle={(day) => toggleWeekday(day, "included")}
            t={t}
          />
        )}

        {repeatPreset === "custom-interval" && (
          <div className="task-modal__repeat-custom">
            <label className="task-modal__field">
              <span>{t("task.repeatEvery")}</span>
              <input min="1" value={repeatInterval} onChange={(event) => setRepeatInterval(Number(event.target.value))} type="number" />
            </label>
            <label className="task-modal__field">
              <span>{t("task.repeatUnit")}</span>
              <select value={repeatUnit} onChange={(event) => setRepeatUnit(event.target.value as RepeatUnit)}>
                <option value="day">{t("task.repeat.days")}</option>
                <option value="week">{t("task.repeat.weeks")}</option>
                <option value="month">{t("task.repeat.months")}</option>
              </select>
            </label>
          </div>
        )}

        <button className="button button--secondary task-modal__clear" onClick={() => {
          setDate("");
          setTime("");
        }} type="button">
          <CalendarX size={16} />
          {t("task.clearDateTime")}
        </button>

        <div className="confirm-dialog__actions">
          <button className="button button--secondary" onClick={requestClose} type="button">
            {t("settings.cancel")}
          </button>
          <button className="button button--primary" disabled={!title.trim()} type="submit">
            <Save size={16} />
            {t("task.save")}
          </button>
        </div>
      </form>
    </div>
  );
}

function WeekdayPicker({ label, selected, toggle, t }: { label: string; selected: number[]; toggle: (day: number) => void; t: ReturnType<typeof useI18n>["t"] }) {
  return (
    <div className="task-modal__field">
      <span>{label}</span>
      <div className="weekday-picker">
        {weekdayNumbers.map((day) => (
          <button className={`weekday-chip ${selected.includes(day) ? "weekday-chip--active" : ""}`} key={day} onClick={() => toggle(day)} type="button">
            {getWeekdayShort(day, t)}
          </button>
        ))}
      </div>
    </div>
  );
}

function buildRepeatRule(preset: RepeatPreset, interval: number, unit: RepeatUnit, weekdays: number[], excludedWeekdays: number[]): RepeatRule {
  if (preset === "none") return { ...defaultRepeat };
  if (preset === "daily") return { enabled: true, type: "daily", interval: 1, unit: "day", weekdays: [], excludedWeekdays };
  if (preset === "weekday") return { enabled: true, type: "weekly", interval: 1, unit: "week", weekdays: [1, 2, 3, 4, 5], excludedWeekdays: [] };
  if (preset === "weekend") return { enabled: true, type: "weekly", interval: 1, unit: "week", weekdays: [0, 6], excludedWeekdays: [] };
  if (preset === "custom-weekdays") return { enabled: weekdays.length > 0, type: "weekly", interval: 1, unit: "week", weekdays, excludedWeekdays: [] };
  if (preset === "custom-interval") return { enabled: true, type: "custom", interval: Math.max(1, Math.floor(interval || 1)), unit, weekdays: [], excludedWeekdays: [] };
  return { enabled: true, type: "weekly", interval: 1, unit: "week", weekdays: [weekdayPresets[preset]], excludedWeekdays: [] };
}

function repeatToPreset(rule: RepeatRule): RepeatPreset {
  if (!rule.enabled) return "none";
  if (rule.type === "daily") return "daily";
  if (isSameDays(rule.weekdays, [1, 2, 3, 4, 5])) return "weekday";
  if (isSameDays(rule.weekdays, [0, 6])) return "weekend";
  const singleDay = Object.entries(weekdayPresets).find(([, day]) => isSameDays(rule.weekdays, [day]));
  if (singleDay) return singleDay[0] as RepeatPreset;
  if (rule.weekdays.length > 0) return "custom-weekdays";
  return "custom-interval";
}

function getWeekdayShort(day: number, t: ReturnType<typeof useI18n>["t"]) {
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

function isSameDays(a: number[], b: number[]) {
  const left = [...a].sort((x, y) => x - y);
  const right = [...b].sort((x, y) => x - y);
  return left.length === right.length && left.every((day, index) => day === right[index]);
}
