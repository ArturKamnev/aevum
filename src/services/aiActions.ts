import type { AssistantAction, AITaskDraft } from "./aiService";
import type { Project, Task, TaskDraft } from "../types";
import { normalizeScheduledAt } from "../utils/date";
import { calculateNextRepeatAt, defaultRepeat } from "../utils/recurrence";

export interface AIActionContext {
  projects: Project[];
  tasks?: Task[];
  addTask: (task: TaskDraft) => Task;
  addProject: (project: Omit<Project, "id">) => Project;
  updateTask?: (taskId: string, updates: Partial<Task>) => void;
  setTaskStatus?: (taskId: string, status: Task["status"]) => void;
  deleteTask?: (taskId: string) => void;
}

export interface AIActionResult {
  ok: boolean;
  message: string;
  taskIds?: string[];
}

export function applyAssistantAction(action: AssistantAction | undefined, context: AIActionContext): AIActionResult {
  if (!action) {
    return { ok: true, message: "" };
  }

  if (action.type === "create_tasks") {
    const workingContext = { ...context, projects: [...context.projects] };
    const createdTasks = action.tasks.map((draft) => createTaskFromDraft(draft, workingContext));
    return {
      ok: true,
      message: createdTasks.length === 1 ? "Task created." : `${createdTasks.length} tasks created.`,
      taskIds: createdTasks.map((task) => task.id),
    };
  }

  if (action.type === "schedule_tasks") {
    if (!context.updateTask) return { ok: false, message: "Task updates are not available." };
    action.changes.forEach((change) => {
      context.updateTask?.(change.taskId, {
        scheduledAt: normalizeScheduledAt(change.scheduledAt),
        durationMinutes: change.durationMinutes ?? null,
      });
    });
    return {
      ok: true,
      message: `${action.changes.length} tasks scheduled.`,
      taskIds: action.changes.map((change) => change.taskId),
    };
  }

  if (action.type === "manage_tasks") {
    if (!context.tasks || !context.updateTask || !context.setTaskStatus || !context.deleteTask) {
      return { ok: false, message: "Task management is not available." };
    }

    const affectedTaskIds: string[] = [];
    for (const operation of action.operations) {
      const task = context.tasks.find((item) => item.id === operation.taskId);
      if (!task) return { ok: false, message: "One of the tasks no longer exists." };

      if (operation.operation === "delete") {
        context.deleteTask(operation.taskId);
        affectedTaskIds.push(operation.taskId);
        continue;
      }

      if (operation.operation === "set_status") {
        if (task.status !== operation.status) {
          context.setTaskStatus(operation.taskId, operation.status);
          affectedTaskIds.push(operation.taskId);
        }
        continue;
      }

      const updates = normalizeManageTaskChanges(operation.changes, task, context.projects);
      if (Object.keys(updates).length > 0) {
        context.updateTask(operation.taskId, updates);
        affectedTaskIds.push(operation.taskId);
      }
    }

    return affectedTaskIds.length
      ? { ok: true, message: `${affectedTaskIds.length} task operations applied.`, taskIds: affectedTaskIds }
      : { ok: false, message: "No task changes to apply." };
  }

  return { ok: false, message: "Unsupported AI action." };
}

function normalizeManageTaskChanges(changes: Partial<Task>, task: Task, projects: Project[]): Partial<Task> {
  const updates: Partial<Task> = {};
  if (typeof changes.title === "string" && changes.title.trim() && changes.title.trim() !== task.title) updates.title = changes.title.trim();
  if (typeof changes.description === "string" && changes.description.trim() !== task.description) updates.description = changes.description.trim();
  if ("scheduledAt" in changes) {
    const scheduledAt = normalizeScheduledAt(changes.scheduledAt);
    if (scheduledAt !== task.scheduledAt) updates.scheduledAt = scheduledAt;
  }
  if ("durationMinutes" in changes && (typeof changes.durationMinutes === "number" || changes.durationMinutes === null) && changes.durationMinutes !== task.durationMinutes) {
    updates.durationMinutes = changes.durationMinutes;
  }
  if ("reminderMinutes" in changes && (changes.reminderMinutes === 0 || changes.reminderMinutes === 5 || changes.reminderMinutes === 10 || changes.reminderMinutes === 30 || changes.reminderMinutes === 60 || changes.reminderMinutes === null) && changes.reminderMinutes !== task.reminderMinutes) {
    updates.reminderMinutes = changes.reminderMinutes;
  }
  if (typeof changes.projectId === "string" && projects.some((project) => project.id === changes.projectId) && changes.projectId !== task.projectId) {
    updates.projectId = changes.projectId;
  }
  return updates;
}

function createTaskFromDraft(draft: AITaskDraft, context: AIActionContext) {
  const project = resolveProject(draft.projectName, context);
  const scheduledAt = normalizeScheduledAt(draft.scheduledAt);
  const repeat = draft.repeat ?? { ...defaultRepeat };
  return context.addTask({
    title: draft.title,
    description: draft.description ?? "",
    status: "active",
    scheduledAt,
    projectId: project?.id ?? "workspace",
    durationMinutes: draft.durationMinutes ?? null,
    reminderMinutes: draft.reminderMinutes ?? null,
    repeat,
    nextRepeatAt: calculateNextRepeatAt({ scheduledAt, repeat }),
    tags: draft.tags ?? [],
    subtasks: [],
  });
}

function resolveProject(projectName: string | undefined, context: AIActionContext) {
  const fallback = context.projects[0];
  if (!projectName) return fallback;

  const existingProject = context.projects.find((project) => project.name.toLowerCase() === projectName.toLowerCase());
  if (existingProject) return existingProject;

  const createdProject = context.addProject({
    name: projectName,
    description: "Created by Aevum.",
    color: "var(--project-sage)",
  });
  context.projects.push(createdProject);
  return createdProject;
}
