import { projects as seedProjects } from "../data/sampleData";
import type { Project, ReminderOffsetMinutes, Task } from "../types";
import { normalizeScheduledAt } from "../utils/date";
import { calculateNextRepeatAt, migrateLegacyRepeat, normalizeRepeat } from "../utils/recurrence";

const tasksStorageKey = "todo-ai-tasks-v1";
const projectsStorageKey = "todo-ai-projects-v1";
const uncategorizedProject: Project = {
  id: "uncategorized",
  name: "Uncategorized",
  color: "var(--project-sage)",
  description: "Tasks without a category.",
};

export function loadTasks() {
  return loadArray<Task>(tasksStorageKey, migrateTask, () => []);
}

export function saveTasks(tasks: Task[]) {
  saveArray(tasksStorageKey, tasks.map(migrateTask));
}

export function loadProjects() {
  const projects = loadArray<Project>(projectsStorageKey, migrateProject, () => [uncategorizedProject]);
  return ensureUncategorizedProject(projects);
}

export function saveProjects(projects: Project[]) {
  saveArray(projectsStorageKey, projects.map(migrateProject));
}

function loadArray<T>(key: string, migrate: (value: unknown) => T | undefined, seed: () => T[]) {
  try {
    const stored = window.localStorage.getItem(key);
    if (stored === null) {
      const seeded = seed();
      saveArray(key, seeded);
      return seeded;
    }

    const parsed = JSON.parse(stored) as unknown;
    if (!Array.isArray(parsed)) return [];
    return parsed.map(migrate).filter((item): item is T => Boolean(item));
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn(`[Todo AI] Failed to load ${key}`, error);
    }
    return [];
  }
}

function saveArray<T>(key: string, value: T[]) {
  try {
    window.localStorage.setItem(key, JSON.stringify(value));
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn(`[Todo AI] Failed to save ${key}`, error);
    }
  }
}

function migrateTask(value: unknown): Task | undefined {
  if (!isRecord(value) || typeof value.title !== "string" || typeof value.id !== "string") return undefined;
  const now = new Date().toISOString();
  const status = value.status === "completed" ? "completed" : "active";
  const legacyDeadline = typeof value.deadline === "string" ? value.deadline : undefined;
  const scheduledAt = normalizeScheduledAt(typeof value.scheduledAt === "string" ? value.scheduledAt : legacyDeadline);
  const repeat = isRecord(value.repeat) ? normalizeRepeat(value.repeat) : migrateLegacyRepeat(value);
  const migratedTask = {
    id: value.id,
    title: value.title,
    description: typeof value.description === "string" ? value.description : "",
    status,
    scheduledAt,
    projectId: typeof value.projectId === "string" ? value.projectId : seedProjects[0]?.id ?? uncategorizedProject.id,
    durationMinutes: typeof value.durationMinutes === "number" && value.durationMinutes > 0 ? Math.floor(value.durationMinutes) : null,
    reminderMinutes: readReminderMinutes(value.reminderMinutes),
    repeat,
    nextRepeatAt: normalizeScheduledAt(typeof value.nextRepeatAt === "string" ? value.nextRepeatAt : null),
    recurringParentId: typeof value.recurringParentId === "string" ? value.recurringParentId : undefined,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string") : [],
    subtasks: Array.isArray(value.subtasks)
      ? value.subtasks
          .filter((subtask): subtask is { id?: unknown; title?: unknown; completed?: unknown } => isRecord(subtask))
          .map((subtask, index) => ({
            id: typeof subtask.id === "string" ? subtask.id : `${value.id}-subtask-${index}`,
            title: typeof subtask.title === "string" ? subtask.title : "Untitled subtask",
            completed: subtask.completed === true,
          }))
      : [],
    createdAt: typeof value.createdAt === "string" ? value.createdAt : now,
    updatedAt: typeof value.updatedAt === "string" ? value.updatedAt : now,
  } satisfies Task;

  return {
    ...migratedTask,
    nextRepeatAt: migratedTask.nextRepeatAt ?? calculateNextRepeatAt(migratedTask),
  };
}

function readReminderMinutes(value: unknown): ReminderOffsetMinutes | null {
  return value === 0 || value === 5 || value === 10 || value === 30 || value === 60 ? value : null;
}

function migrateProject(value: unknown): Project | undefined {
  if (!isRecord(value) || typeof value.id !== "string" || typeof value.name !== "string") return undefined;
  return {
    id: value.id,
    name: value.name,
    color: typeof value.color === "string" ? value.color : "var(--project-sage)",
    description: typeof value.description === "string" ? value.description : "",
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function ensureUncategorizedProject(projects: Project[]) {
  if (projects.some((project) => project.id === uncategorizedProject.id)) return projects;
  return [uncategorizedProject, ...projects];
}
