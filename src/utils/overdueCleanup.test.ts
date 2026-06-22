import { describe, expect, it } from "vitest";
import type { Task } from "../types";
import { defaultRepeat } from "./recurrence";
import { cleanupOverdueTasks } from "./overdueCleanup";

const now = new Date("2026-06-21T12:00:00.000Z");

describe("cleanupOverdueTasks", () => {
  it("leaves tasks unchanged when disabled", () => {
    const tasks = [makeTask({ scheduledAt: "2026-06-20" })];
    expect(cleanupOverdueTasks(tasks, "off", now)).toBe(tasks);
  });

  it("archives or deletes only active overdue tasks", () => {
    const overdue = makeTask({ id: "overdue", scheduledAt: "2026-06-20" });
    const completed = makeTask({ id: "completed", scheduledAt: "2026-06-20", status: "completed" });
    const future = makeTask({ id: "future", scheduledAt: "2026-06-22" });
    const tasks = [overdue, completed, future];

    const archived = cleanupOverdueTasks(tasks, "archive", now);
    expect(archived.find((task) => task.id === overdue.id)?.status).toBe("completed");
    expect(archived.find((task) => task.id === completed.id)).toBe(completed);
    expect(archived.find((task) => task.id === future.id)).toBe(future);
    expect(cleanupOverdueTasks(tasks, "delete", now).map((task) => task.id)).toEqual(["completed", "future"]);
  });

  it("rolls a recurring task forward once and is idempotent", () => {
    const overdue = makeTask({
      id: "series-root",
      scheduledAt: "2026-06-20",
      repeat: { ...defaultRepeat, enabled: true },
    });

    const first = cleanupOverdueTasks([overdue], "archive", now);
    const occurrence = first.find((task) => task.id !== overdue.id);
    expect(occurrence?.scheduledAt).toBe("2026-06-21");
    expect(occurrence?.recurringParentId).toBe(overdue.id);
    expect(first.find((task) => task.id === overdue.id)?.status).toBe("completed");
    expect(cleanupOverdueTasks(first, "archive", now)).toBe(first);
  });

  it("does not duplicate an already generated recurring occurrence", () => {
    const overdue = makeTask({
      id: "series-root",
      scheduledAt: "2026-06-20",
      repeat: { ...defaultRepeat, enabled: true },
    });
    const existing = makeTask({
      id: "existing-next",
      scheduledAt: "2026-06-21",
      recurringParentId: overdue.id,
      repeat: { ...defaultRepeat, enabled: true },
    });

    const result = cleanupOverdueTasks([overdue, existing], "delete", now);
    expect(result).toEqual([existing]);
  });
});

function makeTask(overrides: Partial<Task> = {}): Task {
  return {
    id: "task",
    title: "Task",
    description: "",
    status: "active",
    scheduledAt: null,
    projectId: "uncategorized",
    durationMinutes: null,
    reminderMinutes: null,
    repeat: { ...defaultRepeat },
    nextRepeatAt: null,
    tags: [],
    subtasks: [],
    createdAt: "2026-06-01T00:00:00.000Z",
    updatedAt: "2026-06-01T00:00:00.000Z",
    ...overrides,
  };
}
