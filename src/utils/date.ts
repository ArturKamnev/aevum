import type { Language, TimeFormat } from "../types";

const dateFormatterCache = new Map<string, Intl.DateTimeFormat>();

export function getTodayISO(date = new Date()) {
  return toDateInputValue(date);
}

export function getTomorrowISO(date = new Date()) {
  const tomorrow = new Date(date);
  tomorrow.setDate(tomorrow.getDate() + 1);
  return toDateInputValue(tomorrow);
}

export function toDateInputValue(date: Date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, "0");
  const day = String(date.getDate()).padStart(2, "0");
  return `${year}-${month}-${day}`;
}

export function normalizeScheduledAt(value: string | null | undefined) {
  if (!value) return null;
  const trimmed = value.trim();
  if (!trimmed) return null;
  if (/^\d{4}-\d{2}-\d{2}$/.test(trimmed)) return trimmed;
  const parsed = new Date(trimmed);
  if (Number.isNaN(parsed.getTime())) return null;
  const date = toDateInputValue(parsed);
  const hours = String(parsed.getHours()).padStart(2, "0");
  const minutes = String(parsed.getMinutes()).padStart(2, "0");
  return `${date}T${hours}:${minutes}`;
}

export function combineDateAndTime(date: string, time: string) {
  if (!date) return null;
  if (!time) return date;
  return `${date}T${time}`;
}

export function getScheduleDate(value: string | null | undefined) {
  if (!value) return "";
  return value.slice(0, 10);
}

export function getScheduleTime(value: string | null | undefined) {
  if (!value || !value.includes("T")) return "";
  return value.slice(11, 16);
}

export function hasScheduleTime(value: string | null | undefined) {
  return Boolean(getScheduleTime(value));
}

export function compareScheduledAt(a: string | null | undefined, b: string | null | undefined) {
  if (!a && !b) return 0;
  if (!a) return 1;
  if (!b) return -1;
  return toComparableSchedule(a).localeCompare(toComparableSchedule(b));
}

export function isScheduledToday(value: string | null | undefined) {
  return getScheduleDate(value) === getTodayISO();
}

export function isScheduledBeforeToday(value: string | null | undefined) {
  const date = getScheduleDate(value);
  return Boolean(date && date < getTodayISO());
}

export function isScheduledAfterToday(value: string | null | undefined) {
  const date = getScheduleDate(value);
  return Boolean(date && date > getTodayISO());
}

export function formatDateLabel(value: string | null | undefined, language: Language = "en") {
  const date = getScheduleDate(value);
  if (!date) return "";
  return getFormatter(language, { month: "short", day: "numeric" }).format(new Date(`${date}T12:00:00`));
}

export function formatScheduleLabel(
  value: string | null | undefined,
  labels: { noDate: string; overdue: string; today: string; tomorrow: string },
  language: Language = "en",
  timeFormat: TimeFormat = "24h",
) {
  if (!value) return labels.noDate;
  const date = getScheduleDate(value);
  const time = getScheduleTime(value);
  const relative = getRelativeDateLabel(value, labels, language);
  return time ? `${relative}, ${formatTime(time, timeFormat)}` : relative;
}

export function formatTime(value: string | null | undefined, timeFormat: TimeFormat = "24h") {
  const time = value?.includes("T") ? getScheduleTime(value) : value ?? "";
  if (!time) return "";
  const [hoursValue, minutesValue] = time.split(":").map(Number);
  if (!Number.isFinite(hoursValue) || !Number.isFinite(minutesValue)) return time;
  if (timeFormat === "24h") {
    return `${String(hoursValue).padStart(2, "0")}:${String(minutesValue).padStart(2, "0")}`;
  }
  const period = hoursValue >= 12 ? "PM" : "AM";
  const hours = hoursValue % 12 || 12;
  return `${hours}:${String(minutesValue).padStart(2, "0")} ${period}`;
}

export function getRelativeDateLabel(
  value: string | null | undefined,
  labels: { overdue: string; today: string; tomorrow: string },
  language: Language = "en",
) {
  const date = getScheduleDate(value);
  if (!date) return "";
  if (date < getTodayISO()) return labels.overdue;
  if (date === getTodayISO()) return labels.today;
  if (date === getTomorrowISO()) return labels.tomorrow;
  return formatDateLabel(date, language);
}

function toComparableSchedule(value: string) {
  const normalized = normalizeScheduledAt(value);
  if (!normalized) return "9999-12-31T23:59";
  return normalized.includes("T") ? normalized : `${normalized}T23:59`;
}

function getFormatter(language: Language, options: Intl.DateTimeFormatOptions) {
  const locale = language === "ru" ? "ru-RU" : "en";
  const key = `${locale}:${JSON.stringify(options)}`;
  const existing = dateFormatterCache.get(key);
  if (existing) return existing;
  const formatter = new Intl.DateTimeFormat(locale, options);
  dateFormatterCache.set(key, formatter);
  return formatter;
}
