import type { RepeatRule, RepeatType, RepeatUnit, Task } from "../types";
import { getScheduleDate, getScheduleTime, normalizeScheduledAt, toDateInputValue } from "./date";
import { createSubtaskId, createTaskId } from "./id";

export const defaultRepeat: RepeatRule = {
  enabled: false,
  type: "daily",
  interval: 1,
  unit: "day",
  weekdays: [],
  excludedWeekdays: [],
};

export function normalizeRepeat(value: unknown): RepeatRule {
  if (!isRecord(value)) return { ...defaultRepeat };

  const type = readRepeatType(value.type);
  const unit = readRepeatUnit(value.unit);
  const interval = readInterval(value.interval);
  return {
    enabled: value.enabled === true,
    type,
    interval,
    unit,
    weekdays: readWeekdays(value.weekdays),
    excludedWeekdays: readWeekdays(value.excludedWeekdays),
  };
}

export function migrateLegacyRepeat(value: Record<string, unknown>): RepeatRule {
  const legacyType = value.repeatType;
  if (legacyType !== "daily" && legacyType !== "weekly" && legacyType !== "monthly" && legacyType !== "custom") {
    return { ...defaultRepeat };
  }

  const legacyUnit = value.repeatUnit === "weeks" ? "week" : value.repeatUnit === "months" ? "month" : "day";
  return {
    enabled: true,
    type: legacyType,
    interval: readInterval(value.repeatInterval),
    unit: legacyType === "weekly" ? "week" : legacyType === "monthly" ? "month" : legacyUnit,
    weekdays: [],
    excludedWeekdays: [],
  };
}

export function calculateNextRepeatAt(task: Pick<Task, "scheduledAt" | "repeat">) {
  if (!task.repeat.enabled) return null;
  const source = task.scheduledAt ? normalizeScheduledAt(task.scheduledAt) : toDateInputValue(new Date());
  if (!source) return null;

  const datePart = getScheduleDate(source);
  const timePart = getScheduleTime(source);
  const start = new Date(`${datePart}T${timePart || "12:00"}:00`);
  if (Number.isNaN(start.getTime())) return null;

  const next = findNextDate(start, task.repeat);
  if (!next) return null;

  const nextDate = toDateInputValue(next);
  const hours = String(next.getHours()).padStart(2, "0");
  const minutes = String(next.getMinutes()).padStart(2, "0");
  return timePart ? `${nextDate}T${hours}:${minutes}` : nextDate;
}

export function createNextRecurringTask(task: Task, now = new Date().toISOString()): Task | null {
  const nextRepeatAt = calculateNextRepeatAt(task);
  if (!nextRepeatAt) return null;

  const nextTask: Task = {
    ...task,
    id: createTaskId(),
    status: "active",
    scheduledAt: nextRepeatAt,
    nextRepeatAt: calculateNextRepeatAt({ ...task, scheduledAt: nextRepeatAt }),
    recurringParentId: task.recurringParentId ?? task.id,
    subtasks: task.subtasks.map((subtask) => ({ ...subtask, id: createSubtaskId(), completed: false })),
    createdAt: now,
    updatedAt: now,
  };

  return nextTask;
}

export function describeRepeat(rule: RepeatRule, labels: {
  everyDay: string;
  everyWeekday: string;
  everyWeekend: string;
  everyDayExcept: (days: number[]) => string;
  everyWeekdayName: (day: number) => string;
  customWeekdays: string;
  customInterval: string;
  noRepeat: string;
}) {
  if (!rule.enabled) return labels.noRepeat;
  const weekdays = [...rule.weekdays].sort((a, b) => a - b);
  const excludedWeekdays = [...rule.excludedWeekdays].sort((a, b) => a - b);
  if (rule.type === "daily" && rule.excludedWeekdays.length === 0) return labels.everyDay;
  if (rule.type === "daily" && excludedWeekdays.length > 0) return labels.everyDayExcept(excludedWeekdays);
  if (isSameDays(weekdays, [1, 2, 3, 4, 5])) return labels.everyWeekday;
  if (isSameDays(weekdays, [0, 6])) return labels.everyWeekend;
  if (rule.type === "weekly" && weekdays.length === 1) return labels.everyWeekdayName(weekdays[0]);
  if (weekdays.length > 0) return labels.customWeekdays;
  return labels.customInterval;
}

function findNextDate(start: Date, rule: RepeatRule) {
  if (rule.type === "monthly" || rule.unit === "month") {
    const next = new Date(start);
    next.setMonth(next.getMonth() + rule.interval);
    return next;
  }

  if (rule.type === "custom" && rule.unit === "week" && rule.weekdays.length === 0) {
    const next = new Date(start);
    next.setDate(next.getDate() + rule.interval * 7);
    return next;
  }

  if (rule.type === "custom" && rule.unit === "day" && rule.weekdays.length === 0 && rule.excludedWeekdays.length === 0) {
    const next = new Date(start);
    next.setDate(next.getDate() + rule.interval);
    return next;
  }

  const allowedWeekdays = getAllowedWeekdays(rule);
  if (allowedWeekdays.length === 0) return null;

  for (let offset = 1; offset <= 370; offset += 1) {
    const candidate = new Date(start);
    candidate.setDate(candidate.getDate() + offset);
    if (allowedWeekdays.includes(candidate.getDay())) return candidate;
  }
  return null;
}

function getAllowedWeekdays(rule: RepeatRule) {
  if (rule.weekdays.length > 0) return rule.weekdays.filter((day) => !rule.excludedWeekdays.includes(day));
  const allDays = [0, 1, 2, 3, 4, 5, 6];
  if (rule.type === "daily") return allDays.filter((day) => !rule.excludedWeekdays.includes(day));
  return allDays.filter((day) => !rule.excludedWeekdays.includes(day));
}

function readRepeatType(value: unknown): RepeatType {
  return value === "weekly" || value === "monthly" || value === "custom" || value === "daily" ? value : "daily";
}

function readRepeatUnit(value: unknown): RepeatUnit {
  return value === "week" || value === "month" || value === "day" ? value : "day";
}

function readInterval(value: unknown) {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? Math.floor(value) : 1;
}

function readWeekdays(value: unknown) {
  if (!Array.isArray(value)) return [];
  return [...new Set(value.filter((day): day is number => Number.isInteger(day) && day >= 0 && day <= 6))];
}

function isSameDays(a: number[], b: number[]) {
  return a.length === b.length && a.every((day, index) => day === b[index]);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
