import { describe, expect, it } from "vitest";
import { filterAndSortTasks } from "./TaskList";
import type { Task } from "../types";
import { getTodayISO, getTomorrowISO } from "../utils/date";
import { defaultRepeat } from "../utils/recurrence";

describe("TaskList filtering", () => {
  it("filters selected category tasks by date without affecting other categories", () => {
    const today = getTodayISO();
    const tomorrow = getTomorrowISO();
    const tasks = [
      task({ id: "today-work", title: "Today work", projectId: "work", scheduledAt: today }),
      task({ id: "tomorrow-work", title: "Tomorrow work", projectId: "work", scheduledAt: tomorrow }),
      task({ id: "today-home", title: "Today home", projectId: "home", scheduledAt: today }),
      task({ id: "unscheduled-work", title: "Unscheduled work", projectId: "work", scheduledAt: null }),
    ];

    const visible = filterAndSortTasks({
      tasks,
      query: "",
      statusFilter: "all",
      categoryFilter: "work",
      categoryDateFilter: "today",
      sortMode: "deadline",
    });

    expect(visible.map((item) => item.id)).toEqual(["today-work"]);
  });
});

function task(overrides: Partial<Task>): Task {
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
    createdAt: "2026-06-04T08:00:00.000Z",
    updatedAt: "2026-06-04T08:00:00.000Z",
    ...overrides,
  };
}
