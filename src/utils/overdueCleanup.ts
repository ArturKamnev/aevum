import type { OverdueAutoCleanupMode, Task } from "../types";
import { getScheduleDate, getTodayISO } from "./date";
import { createNextRecurringTask } from "./recurrence";

export function cleanupOverdueTasks(
  tasks: Task[],
  mode: OverdueAutoCleanupMode,
  now = new Date(),
): Task[] {
  if (mode === "off") return tasks;

  const today = getTodayISO(now);
  const timestamp = now.toISOString();
  const generated: Task[] = [];
  let changed = false;

  const remaining = tasks.flatMap((task) => {
    const scheduledDate = getScheduleDate(task.scheduledAt);
    const isOverdue = task.status === "active" && Boolean(scheduledDate) && scheduledDate < today;
    if (!isOverdue) return [task];

    if (task.repeat.enabled) {
      const nextTask = createNextRecurringTask(task, timestamp);
      if (nextTask && !hasRecurringOccurrence(tasks, generated, task, nextTask.scheduledAt)) {
        generated.push(nextTask);
      }
    }

    changed = true;
    if (mode === "delete") return [];
    return [{ ...task, status: "completed" as const, updatedAt: timestamp }];
  });

  return changed ? [...generated, ...remaining] : tasks;
}

function hasRecurringOccurrence(
  tasks: Task[],
  generated: Task[],
  source: Task,
  scheduledAt: string | null,
) {
  const recurringRoot = source.recurringParentId ?? source.id;
  return [...tasks, ...generated].some(
    (task) =>
      task.id !== source.id &&
      (task.recurringParentId ?? task.id) === recurringRoot &&
      task.scheduledAt === scheduledAt,
  );
}
