import type { AssistantAction, AITaskDraft } from "./aiService";
import type { Project, Task, TaskDraft } from "../types";
import { normalizeScheduledAt } from "../utils/date";
import { calculateNextRepeatAt, defaultRepeat } from "../utils/recurrence";

export interface AIActionContext {
  projects: Project[];
  addTask: (task: TaskDraft) => Task;
  addProject: (project: Omit<Project, "id">) => Project;
  updateTask?: (taskId: string, updates: Partial<Task>) => void;
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

  return { ok: false, message: "Unsupported AI action." };
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
