import type {
  AICategoryDraft,
  AICategoryTarget,
  AITaskDraft,
  AssistantAction,
  BatchAction,
  CategoryDeleteDraft,
  CategoryRenameDraft,
  CategoryUpdateDraft,
  CreateTasksAction,
  ManageTaskChanges,
  ManageTaskOperation,
  ManageTasksAction,
  ScheduleChangeDraft,
  ScheduleTasksAction,
} from "./aiService";
import type { Project, ReminderOffsetMinutes, RepeatRule, Task } from "../types";
import { assignCategoryColor } from "../utils/categoryColors";
import { getScheduleTime, normalizeScheduledAt } from "../utils/date";
import { createProjectId, createSubtaskId, createTaskId } from "../utils/id";
import { calculateNextRepeatAt, createNextRecurringTask, defaultRepeat, normalizeRepeat } from "../utils/recurrence";

export type AIActionSource = "assistant" | "telegram" | "mcp";
export type AIActionKind = "create" | "schedule" | "replan" | "manage" | "undo" | "batch";
export type AIActionFailureReason =
  | "missing_action"
  | "invalid_action"
  | "missing_task"
  | "missing_project"
  | "expired"
  | "stale"
  | "replayed"
  | "conflict"
  | "unsafe_undo";

export interface AIActionStateSnapshot {
  tasks: readonly Task[];
  projects: readonly Project[];
}

export interface AIActionProposal {
  schemaVersion: 1;
  id: string;
  source: AIActionSource;
  actionType: AssistantAction["type"];
  actionKind: AIActionKind;
  action: AssistantAction;
  createdAt: string;
  expiresAt?: string;
  preview: AIActionPreview;
  preconditions: AIActionPreconditions;
}

export interface AIActionPreview {
  summary: AIActionSummary;
  items: AIActionPreviewItem[];
}

export interface AIActionPreviewItem {
  kind: "create" | "schedule" | "update" | "status" | "delete";
  title: string;
  before?: string;
  after?: string;
  destructive?: boolean;
}

export interface AIActionSummary {
  kind: AIActionKind;
  taskTitles: string[];
  taskCount: number;
  projectNames: string[];
  createdTaskCount: number;
  updatedTaskCount: number;
  deletedTaskCount: number;
  completedTaskCount: number;
  reopenedTaskCount: number;
  destructive: boolean;
}

export interface AIActionPreconditions {
  tasks: AIActionTaskPrecondition[];
  projects: AIActionProjectPrecondition[];
}

export interface AIActionTaskPrecondition {
  taskId: string;
  fingerprint: string;
  status: Task["status"];
  updatedAt: string;
}

export interface AIActionProjectPrecondition {
  projectId: string;
  fingerprint: string;
}

export interface AIActionProposalLedger {
  consumedProposalIds: Set<string>;
}

export interface AIActionTransaction {
  schemaVersion: 1;
  transactionId: string;
  proposalId?: string;
  source: AIActionSource;
  actionType: AssistantAction["type"];
  actionKind: AIActionKind;
  createdAt: string;
  confirmedAt: string;
  appliedAt: string;
  before: {
    tasks: Task[];
    projects: Project[];
  };
  after: {
    tasks: Task[];
    projects: Project[];
  };
  taskPatches: AIActionTaskPatch[];
  projectPatches: AIActionProjectPatch[];
  createdTaskIds: string[];
  deletedTaskIds: string[];
  updatedTaskIds: string[];
  createdProjectIds: string[];
  generatedRecurringTaskIds: string[];
  summary: AIActionSummary;
}

export interface AIActionTaskPatch {
  taskId: string;
  before?: Task;
  after?: Task;
  change: "created" | "updated" | "deleted";
  generatedByRecurringCompletion?: boolean;
}

export interface AIActionProjectPatch {
  projectId: string;
  before?: Project;
  after?: Project;
  change: "created" | "updated" | "deleted";
}

export interface AIActionAuditEntry {
  schemaVersion: 1;
  transactionId: string;
  originalTransactionId?: string;
  source: AIActionSource;
  actionKind: AIActionKind;
  actionType: AssistantAction["type"] | "undo";
  createdAt: string;
  confirmedAt: string;
  appliedAt: string;
  summary: AIActionSummary;
  taskPatches: AIActionTaskPatch[];
  projectPatches: AIActionProjectPatch[];
  status: "applied" | "undone" | "conflicted" | "failed";
  undoWarnings?: string[];
  undoUnavailableReason?: AIActionFailureReason;
  containsRedactions?: boolean;
}

export type AIActionProposalResult =
  | { ok: true; proposal: AIActionProposal }
  | { ok: false; reason: AIActionFailureReason };

export type AIActionConfirmResult =
  | { ok: true; transaction: AIActionTransaction; auditEntry: AIActionAuditEntry }
  | { ok: false; reason: AIActionFailureReason };

export type AIActionTransactionResult =
  | { ok: true; transaction: AIActionTransaction }
  | { ok: false; reason: AIActionFailureReason };

export type AIActionUndoResult =
  | { ok: true; transaction: AIActionTransaction; auditEntry: AIActionAuditEntry; warnings: string[] }
  | { ok: false; reason: AIActionFailureReason };

export type AIActionUndoAvailability =
  | { available: true; warnings: string[] }
  | { available: false; reason: AIActionFailureReason };

interface AIActionIdFactory {
  proposalId?: () => string;
  transactionId?: () => string;
  taskId?: () => string;
  projectId?: () => string;
}

interface AIActionProposalOptions {
  now?: string;
  ttlMs?: number;
  idFactory?: AIActionIdFactory;
}

interface AIActionTransactionOptions {
  now?: string;
  createdAt?: string;
  confirmedAt?: string;
  proposalId?: string;
  transactionId?: string;
  idFactory?: AIActionIdFactory;
}

interface AIActionConfirmOptions extends AIActionTransactionOptions {
  ledger?: AIActionProposalLedger;
}

interface AIActionUndoOptions {
  now?: string;
  transactionId?: string;
  idFactory?: AIActionIdFactory;
}

const maxDurationMinutes = 24 * 60;
const secretPatterns = [
  /sk-or-v1-[A-Za-z0-9_-]+/g,
  /\b\d{8,12}:[A-Za-z0-9_-]{30,}\b/g,
];

export function createAIActionProposalLedger(): AIActionProposalLedger {
  return { consumedProposalIds: new Set<string>() };
}

export function createAIActionProposal(
  action: AssistantAction | undefined,
  source: AIActionSource,
  state: AIActionStateSnapshot,
  options: AIActionProposalOptions = {},
): AIActionProposalResult {
  if (!action) return { ok: false, reason: "missing_action" };

  const now = options.now ?? new Date().toISOString();
  const normalized = normalizeAssistantAction(action, state);
  if (!normalized.ok) return normalized;

  const transactionCheck = buildAIActionTransaction(normalized.action, source, state, {
    now,
    createdAt: now,
    confirmedAt: now,
    idFactory: options.idFactory,
  });
  if (!transactionCheck.ok) return { ok: false, reason: transactionCheck.reason };

  const proposal: AIActionProposal = {
    schemaVersion: 1,
    id: options.idFactory?.proposalId?.() ?? createProposalId(),
    source,
    actionType: normalized.action.type,
    actionKind: getActionKind(normalized.action),
    action: normalized.action,
    createdAt: now,
    expiresAt: options.ttlMs ? new Date(new Date(now).getTime() + options.ttlMs).toISOString() : undefined,
    preview: {
      summary: transactionCheck.transaction.summary,
      items: createPreviewItems(normalized.action, state),
    },
    preconditions: createPreconditions(normalized.action, state),
  };

  return { ok: true, proposal };
}

export function cancelAIActionProposal(
  proposal: AIActionProposal,
  ledger?: AIActionProposalLedger,
): { ok: true } | { ok: false; reason: AIActionFailureReason } {
  if (ledger?.consumedProposalIds.has(proposal.id)) return { ok: false, reason: "replayed" };
  ledger?.consumedProposalIds.add(proposal.id);
  return { ok: true };
}

export function confirmAIActionProposal(
  proposal: AIActionProposal,
  state: AIActionStateSnapshot,
  options: AIActionConfirmOptions = {},
): AIActionConfirmResult {
  if (options.ledger?.consumedProposalIds.has(proposal.id)) return { ok: false, reason: "replayed" };
  options.ledger?.consumedProposalIds.add(proposal.id);

  const now = options.now ?? new Date().toISOString();
  if (proposal.expiresAt && proposal.expiresAt <= now) return { ok: false, reason: "expired" };
  if (!preconditionsMatch(proposal.preconditions, state)) return { ok: false, reason: "stale" };

  const result = buildAIActionTransaction(proposal.action, proposal.source, state, {
    ...options,
    now,
    createdAt: proposal.createdAt,
    confirmedAt: now,
    proposalId: proposal.id,
  });
  if (!result.ok) return result;

  const auditEntry = createAIActionAuditEntry(result.transaction);
  return { ok: true, transaction: result.transaction, auditEntry };
}

export function buildAIActionTransaction(
  action: AssistantAction | undefined,
  source: AIActionSource,
  state: AIActionStateSnapshot,
  options: AIActionTransactionOptions = {},
): AIActionTransactionResult {
  if (!action) return { ok: false, reason: "missing_action" };

  const normalized = normalizeAssistantAction(action, state);
  if (!normalized.ok) return normalized;

  const now = options.now ?? new Date().toISOString();
  const beforeTasks = state.tasks.map(cloneTask);
  const beforeProjects = state.projects.map(cloneProject);
  const workingTasks = state.tasks.map(cloneTask);
  const workingProjects = state.projects.map(cloneProject);
  const generatedRecurringTaskIds: string[] = [];
  const createdTaskIds: string[] = [];
  const deletedTaskIds: string[] = [];
  const updatedTaskIds: string[] = [];
  const createdProjectIds: string[] = [];
  const renamedProjectIds: string[] = [];
  const updatedProjectIds: string[] = [];
  const deletedProjectIds: string[] = [];

  const taskIds = new Set(workingTasks.map((task) => task.id));
  const projectIds = new Set(workingProjects.map((project) => project.id));

  if (normalized.action.type === "create_tasks") {
    const createdTasks: Task[] = [];
    for (const draft of normalized.action.tasks) {
      const project = resolveProjectForDraft(draft, workingProjects, projectIds, createdProjectIds, options.idFactory);
      const task = createTaskFromDraft(draft, project?.id ?? workingProjects[0]?.id ?? "uncategorized", now, taskIds, options.idFactory);
      createdTasks.push(task);
      createdTaskIds.push(task.id);
    }
    workingTasks.unshift(...createdTasks.slice().reverse());
  }

  if (normalized.action.type === "schedule_tasks") {
    const validation = validateScheduleConstraints(normalized.action.changes, workingTasks);
    if (!validation.ok) return validation;
    for (const change of normalized.action.changes) {
      const index = workingTasks.findIndex((task) => task.id === change.taskId);
      if (index < 0) return { ok: false, reason: "missing_task" };
      const task = workingTasks[index];
      const nextTask = recalculateTask({
        ...task,
        scheduledAt: normalizeScheduledAt(change.scheduledAt),
        durationMinutes: change.durationMinutes ?? task.durationMinutes ?? 30,
        updatedAt: now,
      });
      workingTasks[index] = nextTask;
      updatedTaskIds.push(task.id);
    }
  }

  if (normalized.action.type === "manage_tasks") {
    for (const operation of normalized.action.operations) {
      const index = workingTasks.findIndex((task) => task.id === operation.taskId);
      if (index < 0) return { ok: false, reason: "missing_task" };
      const task = workingTasks[index];

      if (operation.operation === "delete") {
        workingTasks.splice(index, 1);
        deletedTaskIds.push(task.id);
        continue;
      }

      if (operation.operation === "update") {
        const nextTask = recalculateTask({ ...task, ...operation.changes, updatedAt: now });
        workingTasks[index] = nextTask;
        updatedTaskIds.push(task.id);
        continue;
      }

      const nextTask = recalculateTask({ ...task, status: operation.status, updatedAt: now });
      workingTasks[index] = nextTask;
      updatedTaskIds.push(task.id);

      if (operation.status === "completed" && task.status !== "completed" && task.repeat.enabled) {
        const nextRecurringTask = createNextRecurringTask(nextTask, now);
        if (nextRecurringTask) {
          nextRecurringTask.id = createUniqueTaskId(taskIds, options.idFactory);
          const recurringRoot = task.recurringParentId ?? task.id;
          const alreadyScheduled = workingTasks.some(
            (item) =>
              item.id !== task.id &&
              item.status === "active" &&
              (item.recurringParentId ?? item.id) === recurringRoot &&
              item.scheduledAt === nextRecurringTask.scheduledAt,
          );
          if (!alreadyScheduled) {
            workingTasks.unshift(nextRecurringTask);
            generatedRecurringTaskIds.push(nextRecurringTask.id);
            createdTaskIds.push(nextRecurringTask.id);
          }
        }
      }
    }
  }

  if (normalized.action.type === "batch_action") {
    const tempRefToProjectId = new Map<string, string>();
    if (normalized.action.categoriesToCreate) {
      for (const cat of normalized.action.categoriesToCreate) {
        const id = createUniqueProjectId(projectIds, options.idFactory);
        const newProject: Project = {
          id,
          name: cat.name,
          description: cat.description ?? "Created by Aevum.",
          color: cat.color ?? assignCategoryColor(workingProjects),
        };
        workingProjects.push(newProject);
        createdProjectIds.push(id);
        tempRefToProjectId.set(cat.ref, id);
      }
    }

    if (normalized.action.categoriesToRename) {
      for (const rename of normalized.action.categoriesToRename) {
        const index = workingProjects.findIndex((p) => p.id === rename.categoryId);
        if (index >= 0) {
          workingProjects[index] = {
            ...workingProjects[index],
            name: rename.newName,
          };
          renamedProjectIds.push(rename.categoryId);
        }
      }
    }

    if (normalized.action.categoriesToUpdate) {
      for (const update of normalized.action.categoriesToUpdate) {
        const index = workingProjects.findIndex((p) => p.id === update.categoryId);
        if (index >= 0) {
          workingProjects[index] = {
            ...workingProjects[index],
            ...(update.name === undefined ? {} : { name: update.name }),
            ...(update.color === undefined ? {} : { color: update.color }),
            ...(update.description === undefined ? {} : { description: update.description }),
          };
          updatedProjectIds.push(update.categoryId);
        }
      }
    }

    if (normalized.action.categoriesToDelete) {
      for (const deletion of normalized.action.categoriesToDelete) {
        const index = workingProjects.findIndex((p) => p.id === deletion.categoryId);
        if (index < 0) return { ok: false, reason: "missing_project" };

        if (deletion.strategy.mode === "delete_tasks_too") {
          const remainingTasks = workingTasks.filter((task) => task.projectId !== deletion.categoryId);
          deletedTaskIds.push(...workingTasks.filter((task) => task.projectId === deletion.categoryId).map((task) => task.id));
          workingTasks.splice(0, workingTasks.length, ...remainingTasks);
        } else {
          const targetProjectId = deletion.strategy.mode === "move_tasks_to_category"
            ? deletion.strategy.targetCategoryId
            : "uncategorized";
          for (let taskIndex = 0; taskIndex < workingTasks.length; taskIndex += 1) {
            const task = workingTasks[taskIndex];
            if (task.projectId !== deletion.categoryId) continue;
            workingTasks[taskIndex] = { ...task, projectId: targetProjectId, updatedAt: now };
            updatedTaskIds.push(task.id);
          }
        }

        workingProjects.splice(index, 1);
        deletedProjectIds.push(deletion.categoryId);
      }
    }

    if (normalized.action.tasksToCreate) {
      const createdTasks: Task[] = [];
      for (const draft of normalized.action.tasksToCreate) {
        let projectId = workingProjects[0]?.id ?? "uncategorized";
        if (draft.categoryTarget) {
          if (draft.categoryTarget.kind === "existing") {
            projectId = draft.categoryTarget.categoryId;
          } else if (draft.categoryTarget.kind === "new") {
            const mappedId = tempRefToProjectId.get(draft.categoryTarget.ref);
            if (mappedId) {
              projectId = mappedId;
            }
          }
        } else {
          const project = resolveProjectForDraft(draft, workingProjects, projectIds, createdProjectIds, options.idFactory);
          projectId = project?.id ?? projectId;
        }

        const task = createTaskFromDraft(draft, projectId, now, taskIds, options.idFactory);
        createdTasks.push(task);
        createdTaskIds.push(task.id);
      }
      workingTasks.unshift(...createdTasks.slice().reverse());
    }

    if (normalized.action.scheduleChanges) {
      const validation = validateScheduleConstraints(normalized.action.scheduleChanges, workingTasks);
      if (!validation.ok) return validation;
      for (const change of normalized.action.scheduleChanges) {
        const index = workingTasks.findIndex((task) => task.id === change.taskId);
        if (index < 0) return { ok: false, reason: "missing_task" };
        const task = workingTasks[index];
        const nextTask = recalculateTask({
          ...task,
          scheduledAt: normalizeScheduledAt(change.scheduledAt),
          durationMinutes: change.durationMinutes ?? task.durationMinutes ?? 30,
          updatedAt: now,
        });
        workingTasks[index] = nextTask;
        updatedTaskIds.push(task.id);
      }
    }

    if (normalized.action.manageOperations) {
      for (const operation of normalized.action.manageOperations) {
        const index = workingTasks.findIndex((task) => task.id === operation.taskId);
        if (index < 0) return { ok: false, reason: "missing_task" };
        const task = workingTasks[index];

        if (operation.operation === "delete") {
          workingTasks.splice(index, 1);
          deletedTaskIds.push(task.id);
          continue;
        }

        if (operation.operation === "update") {
          const nextTask = recalculateTask({ ...task, ...operation.changes, updatedAt: now });
          workingTasks[index] = nextTask;
          updatedTaskIds.push(task.id);
          continue;
        }

        const nextTask = recalculateTask({ ...task, status: operation.status, updatedAt: now });
        workingTasks[index] = nextTask;
        updatedTaskIds.push(task.id);

        if (operation.status === "completed" && task.status !== "completed" && task.repeat.enabled) {
          const nextRecurringTask = createNextRecurringTask(nextTask, now);
          if (nextRecurringTask) {
            nextRecurringTask.id = createUniqueTaskId(taskIds, options.idFactory);
            const recurringRoot = task.recurringParentId ?? task.id;
            const alreadyScheduled = workingTasks.some(
              (item) =>
                item.id !== task.id &&
                item.status === "active" &&
                (item.recurringParentId ?? item.id) === recurringRoot &&
                item.scheduledAt === nextRecurringTask.scheduledAt,
            );
            if (!alreadyScheduled) {
              workingTasks.unshift(nextRecurringTask);
              generatedRecurringTaskIds.push(nextRecurringTask.id);
              createdTaskIds.push(nextRecurringTask.id);
            }
          }
        }
      }
    }
  }

  const taskPatches = buildTaskPatches(beforeTasks, workingTasks, [
    ...createdTaskIds,
    ...deletedTaskIds,
    ...updatedTaskIds,
  ], generatedRecurringTaskIds);
  const projectPatches = buildProjectPatches(beforeProjects, workingProjects, [
    ...createdProjectIds,
    ...renamedProjectIds,
    ...updatedProjectIds,
    ...deletedProjectIds,
  ]);
  const summary = createTransactionSummary(normalized.action, taskPatches, projectPatches, state);

  return {
    ok: true,
    transaction: {
      schemaVersion: 1,
      transactionId: options.transactionId ?? options.idFactory?.transactionId?.() ?? createTransactionId(),
      proposalId: options.proposalId,
      source,
      actionType: normalized.action.type,
      actionKind: getActionKind(normalized.action),
      createdAt: options.createdAt ?? now,
      confirmedAt: options.confirmedAt ?? now,
      appliedAt: now,
      before: {
        tasks: beforeTasks,
        projects: beforeProjects,
      },
      after: {
        tasks: workingTasks,
        projects: workingProjects,
      },
      taskPatches,
      projectPatches,
      createdTaskIds: unique(createdTaskIds),
      deletedTaskIds: unique(deletedTaskIds),
      updatedTaskIds: unique(updatedTaskIds),
      createdProjectIds: unique(createdProjectIds),
      generatedRecurringTaskIds: unique(generatedRecurringTaskIds),
      summary,
    },
  };
}

export function createUndoAIActionTransaction(
  entry: AIActionAuditEntry,
  state: AIActionStateSnapshot,
  options: AIActionUndoOptions = {},
): AIActionUndoResult {
  if (entry.status !== "applied" || entry.actionKind === "undo" || entry.containsRedactions) {
    return { ok: false, reason: "unsafe_undo" };
  }

  const availability = getAIActionUndoAvailability(entry, state);
  if (!availability.available) return { ok: false, reason: availability.reason };

  const now = options.now ?? new Date().toISOString();
  let workingTasks = state.tasks.map(cloneTask);
  let workingProjects = state.projects.map(cloneProject);
  const warnings: string[] = [];

  for (const patch of entry.taskPatches) {
    if (patch.change === "created") {
      workingTasks = workingTasks.filter((task) => task.id !== patch.taskId);
      continue;
    }
    if (patch.change === "deleted" && patch.before) {
      workingTasks = [cloneTask(patch.before), ...workingTasks];
      continue;
    }
    if (patch.change === "updated" && patch.before) {
      workingTasks = workingTasks.map((task) => (task.id === patch.taskId ? cloneTask(patch.before as Task) : task));
    }
  }

  for (const patch of entry.projectPatches) {
    if (patch.change === "created" && patch.after) {
      const stillUsed = workingTasks.some((task) => task.projectId === patch.projectId);
      if (stillUsed) {
        warnings.push("created-project-still-used");
        continue;
      }
      workingProjects = workingProjects.filter((project) => project.id !== patch.projectId);
    } else if (patch.change === "updated" && patch.before) {
      workingProjects = workingProjects.map((project) =>
        project.id === patch.projectId ? cloneProject(patch.before as Project) : project
      );
    } else if (patch.change === "deleted" && patch.before) {
      if (!workingProjects.some((project) => project.id === patch.projectId)) {
        workingProjects = [cloneProject(patch.before), ...workingProjects];
      }
    }
  }

  const taskPatches = buildUndoTaskPatches(entry.taskPatches);
  const projectPatches = buildUndoProjectPatches(entry.projectPatches, workingTasks);
  const transaction: AIActionTransaction = {
    schemaVersion: 1,
    transactionId: options.transactionId ?? options.idFactory?.transactionId?.() ?? createTransactionId(),
    source: entry.source,
    actionType: "manage_tasks",
    actionKind: "undo",
    createdAt: now,
    confirmedAt: now,
    appliedAt: now,
    before: {
      tasks: state.tasks.map(cloneTask),
      projects: state.projects.map(cloneProject),
    },
    after: {
      tasks: workingTasks,
      projects: workingProjects,
    },
    taskPatches,
    projectPatches,
    createdTaskIds: taskPatches.filter((patch) => patch.change === "created").map((patch) => patch.taskId),
    deletedTaskIds: taskPatches.filter((patch) => patch.change === "deleted").map((patch) => patch.taskId),
    updatedTaskIds: taskPatches.filter((patch) => patch.change === "updated").map((patch) => patch.taskId),
    createdProjectIds: [],
    generatedRecurringTaskIds: [],
    summary: {
      ...entry.summary,
      kind: "undo",
      destructive: false,
    },
  };

  return {
    ok: true,
    transaction,
    auditEntry: createAIActionUndoAuditEntry(entry, transaction, warnings),
    warnings,
  };
}

export function getAIActionUndoAvailability(entry: AIActionAuditEntry, state: AIActionStateSnapshot): AIActionUndoAvailability {
  if (entry.status !== "applied" || entry.actionKind === "undo" || entry.containsRedactions) {
    return { available: false, reason: "unsafe_undo" };
  }

  for (const patch of entry.taskPatches) {
    const current = state.tasks.find((task) => task.id === patch.taskId);
    if (patch.after) {
      if (!current || !sameTask(current, patch.after)) return { available: false, reason: "conflict" };
      continue;
    }
    if (current) return { available: false, reason: "conflict" };
  }

  for (const patch of entry.projectPatches) {
    if (patch.change === "created" && patch.after) {
      const current = state.projects.find((project) => project.id === patch.projectId);
      if (!current || !sameProject(current, patch.after)) return { available: false, reason: "conflict" };
    } else if (patch.change === "updated" && patch.after) {
      const current = state.projects.find((project) => project.id === patch.projectId);
      if (!current || !sameProject(current, patch.after)) return { available: false, reason: "conflict" };
    } else if (patch.change === "deleted") {
      const current = state.projects.find((project) => project.id === patch.projectId);
      if (current) return { available: false, reason: "conflict" };
    }
  }

  return { available: true, warnings: [] };
}

export function createAIActionAuditEntry(transaction: AIActionTransaction): AIActionAuditEntry {
  return sanitizeAuditEntry({
    schemaVersion: 1,
    transactionId: transaction.transactionId,
    source: transaction.source,
    actionKind: transaction.actionKind,
    actionType: transaction.actionType,
    createdAt: transaction.createdAt,
    confirmedAt: transaction.confirmedAt,
    appliedAt: transaction.appliedAt,
    summary: transaction.summary,
    taskPatches: transaction.taskPatches,
    projectPatches: transaction.projectPatches,
    status: "applied",
  });
}

export function createAIActionUndoAuditEntry(
  originalEntry: AIActionAuditEntry,
  transaction: AIActionTransaction,
  warnings: string[] = [],
): AIActionAuditEntry {
  return sanitizeAuditEntry({
    schemaVersion: 1,
    transactionId: transaction.transactionId,
    originalTransactionId: originalEntry.transactionId,
    source: originalEntry.source,
    actionKind: "undo",
    actionType: "undo",
    createdAt: transaction.createdAt,
    confirmedAt: transaction.confirmedAt,
    appliedAt: transaction.appliedAt,
    summary: transaction.summary,
    taskPatches: transaction.taskPatches,
    projectPatches: transaction.projectPatches,
    status: "applied",
    undoWarnings: warnings.length ? warnings : undefined,
  });
}

export function createAIActionUndoConflictAuditEntry(
  originalEntry: AIActionAuditEntry,
  reason: AIActionFailureReason,
  now = new Date().toISOString(),
  transactionId = createTransactionId(),
): AIActionAuditEntry {
  return sanitizeAuditEntry({
    schemaVersion: 1,
    transactionId,
    originalTransactionId: originalEntry.transactionId,
    source: originalEntry.source,
    actionKind: "undo",
    actionType: "undo",
    createdAt: now,
    confirmedAt: now,
    appliedAt: now,
    summary: {
      ...originalEntry.summary,
      kind: "undo",
      destructive: false,
    },
    taskPatches: [],
    projectPatches: [],
    status: "conflicted",
    undoUnavailableReason: reason,
  });
}

export function sanitizeAIActionAuditEntryForStorage(entry: AIActionAuditEntry): AIActionAuditEntry {
  return sanitizeAuditEntry(entry);
}

function normalizeAssistantAction(
  action: AssistantAction,
  state: AIActionStateSnapshot,
): { ok: true; action: AssistantAction } | { ok: false; reason: AIActionFailureReason } {
  if (action.type === "create_tasks") return normalizeCreateAction(action);
  if (action.type === "schedule_tasks") return normalizeScheduleAction(action, state);
  if (action.type === "manage_tasks") return normalizeManageAction(action, state);
  if (action.type === "batch_action") return normalizeBatchAction(action, state);
  return { ok: false, reason: "invalid_action" };
}

function normalizeBatchAction(
  action: BatchAction,
  state: AIActionStateSnapshot,
): { ok: true; action: BatchAction } | { ok: false; reason: AIActionFailureReason } {
  const projectFinalNames = new Map<string, string>();
  const renamedIds = new Set<string>();
  const updatedCategoryIds = new Set<string>();
  const deletedCategoryIds = new Set<string>();
  const categoriesToRename: CategoryRenameDraft[] = [];
  const categoriesToUpdate: CategoryUpdateDraft[] = [];
  const categoriesToDelete: CategoryDeleteDraft[] = [];

  if (action.categoriesToRename) {
    for (const rename of action.categoriesToRename) {
      if (!rename || typeof rename.categoryId !== "string" || typeof rename.newName !== "string") {
        return { ok: false, reason: "invalid_action" };
      }
      const categoryId = rename.categoryId.trim();
      const newName = rename.newName.trim().replace(/\s+/g, " ");
      if (!categoryId || !newName || newName.length > 80) return { ok: false, reason: "invalid_action" };
      if (hasSecretLikeText([newName])) return { ok: false, reason: "invalid_action" };
      if (categoryId === "uncategorized") return { ok: false, reason: "invalid_action" };

      const project = state.projects.find((p) => p.id === categoryId);
      if (!project) return { ok: false, reason: "missing_project" };

      if (renamedIds.has(categoryId)) return { ok: false, reason: "invalid_action" };
      renamedIds.add(categoryId);

      projectFinalNames.set(categoryId, newName.toLowerCase());
      categoriesToRename.push({ categoryId, newName });
    }
  }

  if (action.categoriesToUpdate) {
    for (const update of action.categoriesToUpdate) {
      if (!update || typeof update.categoryId !== "string") return { ok: false, reason: "invalid_action" };
      const categoryId = update.categoryId.trim();
      if (!categoryId || categoryId === "uncategorized") return { ok: false, reason: "invalid_action" };
      const project = state.projects.find((p) => p.id === categoryId);
      if (!project) return { ok: false, reason: "missing_project" };
      if (updatedCategoryIds.has(categoryId) || renamedIds.has(categoryId)) return { ok: false, reason: "invalid_action" };

      const name = typeof update.name === "string" ? normalizeText(update.name, 80) : undefined;
      const color = typeof update.color === "string" ? normalizeText(update.color, 80) : undefined;
      const description = typeof update.description === "string" ? normalizeText(update.description, 240) ?? "" : undefined;
      if ("name" in update && !name) return { ok: false, reason: "invalid_action" };
      if (name && hasSecretLikeText([name])) return { ok: false, reason: "invalid_action" };
      if (color && hasSecretLikeText([color])) return { ok: false, reason: "invalid_action" };
      if (description && hasSecretLikeText([description])) return { ok: false, reason: "invalid_action" };
      if (name) projectFinalNames.set(categoryId, name.toLowerCase());

      const normalized: CategoryUpdateDraft = {
        categoryId,
        ...(name !== undefined && name !== project.name ? { name } : {}),
        ...(color !== undefined && color !== project.color ? { color } : {}),
        ...(description !== undefined && description !== project.description ? { description } : {}),
      };
      if (Object.keys(normalized).length === 1) return { ok: false, reason: "invalid_action" };
      updatedCategoryIds.add(categoryId);
      categoriesToUpdate.push(normalized);
    }
  }

  if (action.categoriesToDelete) {
    for (const deletion of action.categoriesToDelete) {
      if (!deletion || typeof deletion.categoryId !== "string" || !deletion.strategy) return { ok: false, reason: "invalid_action" };
      const categoryId = deletion.categoryId.trim();
      if (!categoryId || categoryId === "uncategorized" || deletedCategoryIds.has(categoryId)) return { ok: false, reason: "invalid_action" };
      if (updatedCategoryIds.has(categoryId) || renamedIds.has(categoryId)) return { ok: false, reason: "invalid_action" };
      const project = state.projects.find((p) => p.id === categoryId);
      if (!project) return { ok: false, reason: "missing_project" };

      if (deletion.strategy.mode === "move_tasks_to_uncategorized") {
        categoriesToDelete.push({ categoryId, strategy: { mode: "move_tasks_to_uncategorized" } });
      } else if (deletion.strategy.mode === "move_tasks_to_category") {
        const targetCategoryId = typeof deletion.strategy.targetCategoryId === "string" ? deletion.strategy.targetCategoryId.trim() : "";
        if (!targetCategoryId || targetCategoryId === categoryId) return { ok: false, reason: "invalid_action" };
        if (!state.projects.some((p) => p.id === targetCategoryId)) return { ok: false, reason: "missing_project" };
        categoriesToDelete.push({ categoryId, strategy: { mode: "move_tasks_to_category", targetCategoryId } });
      } else if (deletion.strategy.mode === "delete_tasks_too" && deletion.strategy.confirmTaskDeletion === true) {
        categoriesToDelete.push({ categoryId, strategy: { mode: "delete_tasks_too", confirmTaskDeletion: true } });
      } else {
        return { ok: false, reason: "invalid_action" };
      }
      deletedCategoryIds.add(categoryId);
    }
  }

  for (const deletion of categoriesToDelete) {
    if (deletion.strategy.mode === "move_tasks_to_category" && deletedCategoryIds.has(deletion.strategy.targetCategoryId)) {
      return { ok: false, reason: "invalid_action" };
    }
  }

  for (const p of state.projects) {
    if (deletedCategoryIds.has(p.id)) continue;
    if (!projectFinalNames.has(p.id)) {
      projectFinalNames.set(p.id, p.name.trim().replace(/\s+/g, " ").toLowerCase());
    }
  }

  const finalNamesSet = new Set<string>();
  for (const name of projectFinalNames.values()) {
    if (finalNamesSet.has(name)) return { ok: false, reason: "invalid_action" };
    finalNamesSet.add(name);
  }

  const categoriesToCreate: AICategoryDraft[] = [];
  const newCategoryRefs = new Set<string>();
  const newCategoryNames = new Set<string>();
  if (action.categoriesToCreate) {
    for (const cat of action.categoriesToCreate) {
      if (!cat || typeof cat.ref !== "string" || typeof cat.name !== "string") {
        return { ok: false, reason: "invalid_action" };
      }
      const ref = cat.ref.trim();
      const name = cat.name.trim().replace(/\s+/g, " ");
      const color = typeof cat.color === "string" ? normalizeText(cat.color, 80) : undefined;
      const description = typeof cat.description === "string" ? normalizeText(cat.description, 240) ?? "" : undefined;
      if (!ref || !name || name.length > 80) return { ok: false, reason: "invalid_action" };
      if (hasSecretLikeText([name, color ?? "", description ?? ""])) return { ok: false, reason: "invalid_action" };

      if (newCategoryRefs.has(ref)) return { ok: false, reason: "invalid_action" };
      newCategoryRefs.add(ref);

      const nameKey = name.toLowerCase();
      if (newCategoryNames.has(nameKey)) return { ok: false, reason: "invalid_action" };
      newCategoryNames.add(nameKey);

      if (finalNamesSet.has(nameKey)) return { ok: false, reason: "invalid_action" };

      categoriesToCreate.push({ ref, name, ...(color ? { color } : {}), ...(description ? { description } : {}) });
    }
  }

  const tasksToCreate: AITaskDraft[] = [];
  if (action.tasksToCreate) {
    for (const draft of action.tasksToCreate) {
      const normalized = normalizeTaskDraft(draft);
      if (!normalized) return { ok: false, reason: "invalid_action" };
      
      if (draft.categoryTarget) {
        if (draft.categoryTarget.kind === "existing") {
          const categoryId = draft.categoryTarget.categoryId;
          const exists = state.projects.some((p) => p.id === categoryId);
          if (!exists || deletedCategoryIds.has(categoryId)) return { ok: false, reason: "invalid_action" };
          normalized.categoryTarget = { kind: "existing", categoryId };
        } else if (draft.categoryTarget.kind === "new") {
          const ref = draft.categoryTarget.ref;
          if (!newCategoryRefs.has(ref)) return { ok: false, reason: "invalid_action" };
          normalized.categoryTarget = { kind: "new", ref };
        } else {
          return { ok: false, reason: "invalid_action" };
        }
      }

      tasksToCreate.push(normalized);
    }
  }

  const scheduleChanges: ScheduleChangeDraft[] = [];
  if (action.scheduleChanges) {
    const seen = new Set<string>();
    for (const change of action.scheduleChanges) {
      if (!change || typeof change.taskId !== "string" || seen.has(change.taskId)) return { ok: false, reason: "invalid_action" };
      const task = state.tasks.find((item) => item.id === change.taskId);
      if (!task) return { ok: false, reason: "missing_task" };
      if (task.status === "completed") return { ok: false, reason: "invalid_action" };
      const scheduledAt = normalizeScheduledAt(change.scheduledAt);
      if (!scheduledAt || !getScheduleTime(scheduledAt)) return { ok: false, reason: "invalid_action" };
      const durationMinutes = normalizeDuration(change.durationMinutes ?? task.durationMinutes ?? 30);
      if (durationMinutes === null) return { ok: false, reason: "invalid_action" };
      seen.add(change.taskId);
      scheduleChanges.push({
        taskId: task.id,
        scheduledAt,
        durationMinutes,
        reason: typeof change.reason === "string" ? change.reason.trim().slice(0, 240) : undefined,
      });
    }
  }

  const manageOperations: ManageTaskOperation[] = [];
  if (action.manageOperations) {
    const seen = new Set<string>();
    for (const operation of action.manageOperations) {
      if (!operation || typeof operation.taskId !== "string" || seen.has(operation.taskId)) return { ok: false, reason: "invalid_action" };
      const task = state.tasks.find((item) => item.id === operation.taskId);
      if (!task) return { ok: false, reason: "missing_task" };
      seen.add(operation.taskId);

      if (operation.operation === "delete") {
        manageOperations.push({ operation: "delete", taskId: task.id, reason: normalizeReason(operation.reason) });
        continue;
      }

      if (operation.operation === "set_status") {
        if (operation.status !== "active" && operation.status !== "completed") return { ok: false, reason: "invalid_action" };
        if (operation.status === task.status) return { ok: false, reason: "invalid_action" };
        manageOperations.push({ operation: "set_status", taskId: task.id, status: operation.status, reason: normalizeReason(operation.reason) });
        continue;
      }

      if (operation.operation === "update") {
        const changes = normalizeManageChanges(operation.changes, task, state.projects);
        if (!changes) return { ok: false, reason: "invalid_action" };
        if (changes.projectId && deletedCategoryIds.has(changes.projectId)) return { ok: false, reason: "invalid_action" };
        manageOperations.push({ operation: "update", taskId: task.id, changes, reason: normalizeReason(operation.reason) });
        continue;
      }

      return { ok: false, reason: "invalid_action" };
    }
  }

  if (
    categoriesToCreate.length === 0 &&
    categoriesToRename.length === 0 &&
    categoriesToUpdate.length === 0 &&
    categoriesToDelete.length === 0 &&
    tasksToCreate.length === 0 &&
    scheduleChanges.length === 0 &&
    manageOperations.length === 0
  ) {
    return { ok: false, reason: "invalid_action" };
  }

  return {
    ok: true,
    action: {
      type: "batch_action",
      categoriesToCreate: categoriesToCreate.length ? categoriesToCreate : undefined,
      categoriesToRename: categoriesToRename.length ? categoriesToRename : undefined,
      categoriesToUpdate: categoriesToUpdate.length ? categoriesToUpdate : undefined,
      categoriesToDelete: categoriesToDelete.length ? categoriesToDelete : undefined,
      tasksToCreate: tasksToCreate.length ? tasksToCreate : undefined,
      scheduleChanges: scheduleChanges.length ? scheduleChanges : undefined,
      manageOperations: manageOperations.length ? manageOperations : undefined,
    },
  };
}

function normalizeCreateAction(action: CreateTasksAction): { ok: true; action: CreateTasksAction } | { ok: false; reason: AIActionFailureReason } {
  if (!Array.isArray(action.tasks) || action.tasks.length === 0) return { ok: false, reason: "invalid_action" };
  const tasks: AITaskDraft[] = [];
  for (const draft of action.tasks) {
    const normalized = normalizeTaskDraft(draft);
    if (!normalized) return { ok: false, reason: "invalid_action" };
    tasks.push(normalized);
  }
  return { ok: true, action: { type: "create_tasks", tasks } };
}

function normalizeScheduleAction(
  action: ScheduleTasksAction,
  state: AIActionStateSnapshot,
): { ok: true; action: ScheduleTasksAction } | { ok: false; reason: AIActionFailureReason } {
  if (!Array.isArray(action.changes) || action.changes.length === 0) return { ok: false, reason: "invalid_action" };
  const seen = new Set<string>();
  const changes: ScheduleChangeDraft[] = [];
  for (const change of action.changes) {
    if (!change || typeof change.taskId !== "string" || seen.has(change.taskId)) return { ok: false, reason: "invalid_action" };
    const task = state.tasks.find((item) => item.id === change.taskId);
    if (!task) return { ok: false, reason: "missing_task" };
    if (task.status === "completed") return { ok: false, reason: "invalid_action" };
    const scheduledAt = normalizeScheduledAt(change.scheduledAt);
    if (!scheduledAt || !getScheduleTime(scheduledAt)) return { ok: false, reason: "invalid_action" };
    const durationMinutes = normalizeDuration(change.durationMinutes ?? task.durationMinutes ?? 30);
    if (durationMinutes === null) return { ok: false, reason: "invalid_action" };
    seen.add(change.taskId);
    changes.push({
      taskId: task.id,
      scheduledAt,
      durationMinutes,
      reason: typeof change.reason === "string" ? change.reason.trim().slice(0, 240) : undefined,
    });
  }
  return {
    ok: true,
    action: {
      type: "schedule_tasks",
      mode: action.mode === "replan_tasks" ? "replan_tasks" : "plan_day",
      changes,
    },
  };
}

function normalizeManageAction(
  action: ManageTasksAction,
  state: AIActionStateSnapshot,
): { ok: true; action: ManageTasksAction } | { ok: false; reason: AIActionFailureReason } {
  if (!Array.isArray(action.operations) || action.operations.length === 0) return { ok: false, reason: "invalid_action" };
  const seen = new Set<string>();
  const operations: ManageTaskOperation[] = [];
  for (const operation of action.operations) {
    if (!operation || typeof operation.taskId !== "string" || seen.has(operation.taskId)) return { ok: false, reason: "invalid_action" };
    const task = state.tasks.find((item) => item.id === operation.taskId);
    if (!task) return { ok: false, reason: "missing_task" };
    seen.add(operation.taskId);

    if (operation.operation === "delete") {
      operations.push({ operation: "delete", taskId: task.id, reason: normalizeReason(operation.reason) });
      continue;
    }

    if (operation.operation === "set_status") {
      if (operation.status !== "active" && operation.status !== "completed") return { ok: false, reason: "invalid_action" };
      if (operation.status === task.status) return { ok: false, reason: "invalid_action" };
      operations.push({ operation: "set_status", taskId: task.id, status: operation.status, reason: normalizeReason(operation.reason) });
      continue;
    }

    if (operation.operation === "update") {
      const changes = normalizeManageChanges(operation.changes, task, state.projects);
      if (!changes) return { ok: false, reason: "invalid_action" };
      operations.push({ operation: "update", taskId: task.id, changes, reason: normalizeReason(operation.reason) });
      continue;
    }

    return { ok: false, reason: "invalid_action" };
  }
  return { ok: true, action: { type: "manage_tasks", operations } };
}

function normalizeTaskDraft(draft: AITaskDraft): AITaskDraft | undefined {
  if (!draft || typeof draft.title !== "string") return undefined;
  const title = normalizeText(draft.title, 180);
  if (!title) return undefined;
  const description = typeof draft.description === "string" ? normalizeText(draft.description, 1000) ?? "" : "";
  const scheduledAt = normalizeScheduledAt(draft.scheduledAt ?? null);
  const durationMinutes = draft.durationMinutes === null || draft.durationMinutes === undefined ? null : normalizeDuration(draft.durationMinutes);
  if (draft.durationMinutes !== null && draft.durationMinutes !== undefined && durationMinutes === null) return undefined;
  const reminderMinutes = normalizeReminder(draft.reminderMinutes);
  if (draft.reminderMinutes !== null && draft.reminderMinutes !== undefined && reminderMinutes === null) return undefined;
  const repeat = draft.repeat ? normalizeRepeat(draft.repeat) : { ...defaultRepeat };
  const projectName = typeof draft.projectName === "string" ? normalizeText(draft.projectName, 80) : undefined;
  const tags = Array.isArray(draft.tags)
    ? unique(draft.tags.map((tag) => normalizeText(tag, 40)).filter((tag): tag is string => Boolean(tag))).slice(0, 10)
    : [];
  const subtasks = Array.isArray(draft.subtasks)
    ? draft.subtasks
        .map((subtask) => normalizeSubtaskDraft(subtask))
        .filter((subtask): subtask is { title: string; completed: boolean } => Boolean(subtask))
        .slice(0, 50)
    : [];
  if (Array.isArray(draft.subtasks) && subtasks.length !== draft.subtasks.length) return undefined;

  let categoryTarget: AICategoryTarget | undefined;
  if (draft.categoryTarget) {
    if (draft.categoryTarget.kind === "existing" && typeof draft.categoryTarget.categoryId === "string") {
      categoryTarget = { kind: "existing", categoryId: draft.categoryTarget.categoryId.trim() };
    } else if (draft.categoryTarget.kind === "new" && typeof draft.categoryTarget.ref === "string") {
      categoryTarget = { kind: "new", ref: draft.categoryTarget.ref.trim() };
    } else {
      return undefined;
    }
  }

  if (hasSecretLikeText([title, description, projectName ?? "", ...tags])) return undefined;
  if (hasSecretLikeText(subtasks.map((subtask) => subtask.title))) return undefined;

  return {
    title,
    description,
    scheduledAt,
    durationMinutes,
    reminderMinutes,
    repeat,
    projectName,
    categoryTarget,
    tags,
    subtasks,
  };
}

function normalizeManageChanges(changes: ManageTaskChanges, task: Task, projects: readonly Project[]): ManageTaskChanges | undefined {
  if (!changes || typeof changes !== "object") return undefined;
  const updates: ManageTaskChanges = {};

  if ("title" in changes) {
    const title = typeof changes.title === "string" ? normalizeText(changes.title, 180) : undefined;
    if (!title || hasSecretLikeText([title])) return undefined;
    if (title !== task.title) updates.title = title;
  }

  if ("description" in changes) {
    if (typeof changes.description !== "string") return undefined;
    const description = normalizeText(changes.description, 1000) ?? "";
    if (hasSecretLikeText([description])) return undefined;
    if (description !== task.description) updates.description = description;
  }

  if ("scheduledAt" in changes) {
    const scheduledAt = normalizeScheduledAt(changes.scheduledAt ?? null);
    if (scheduledAt !== task.scheduledAt) updates.scheduledAt = scheduledAt;
  }

  if ("durationMinutes" in changes) {
    const durationMinutes = changes.durationMinutes === null ? null : normalizeDuration(changes.durationMinutes);
    if (changes.durationMinutes !== null && durationMinutes === null) return undefined;
    if (durationMinutes !== task.durationMinutes) updates.durationMinutes = durationMinutes;
  }

  if ("reminderMinutes" in changes) {
    const reminderMinutes = changes.reminderMinutes === null ? null : normalizeReminder(changes.reminderMinutes);
    if (changes.reminderMinutes !== null && reminderMinutes === null) return undefined;
    if (reminderMinutes !== task.reminderMinutes) updates.reminderMinutes = reminderMinutes;
  }

  if ("projectId" in changes) {
    if (typeof changes.projectId !== "string") return undefined;
    const project = projects.find((item) => item.id === changes.projectId);
    if (!project) return undefined;
    if (project.id !== task.projectId) updates.projectId = project.id;
  }

  if ("repeat" in changes) {
    const repeat = normalizeRepeat(changes.repeat);
    if (JSON.stringify(repeat) !== JSON.stringify(task.repeat)) updates.repeat = repeat;
  }

  if ("tags" in changes) {
    if (!Array.isArray(changes.tags)) return undefined;
    const tags = unique(changes.tags.map((tag) => normalizeText(tag, 40)).filter((tag): tag is string => Boolean(tag))).slice(0, 10);
    if (tags.length !== changes.tags.length || hasSecretLikeText(tags)) return undefined;
    if (JSON.stringify(tags) !== JSON.stringify(task.tags)) updates.tags = tags;
  }

  if ("subtasks" in changes) {
    if (!Array.isArray(changes.subtasks)) return undefined;
    const subtasks = changes.subtasks
      .map((subtask) => normalizeSubtaskUpdate(subtask))
      .filter((subtask): subtask is NonNullable<ReturnType<typeof normalizeSubtaskUpdate>> => Boolean(subtask))
      .slice(0, 50);
    if (subtasks.length !== changes.subtasks.length || hasSecretLikeText(subtasks.map((subtask) => subtask.title))) return undefined;
    const nextSubtasks = subtasks.map((subtask) => ({
      id: subtask.id ?? createSubtaskId(),
      title: subtask.title,
      completed: subtask.completed,
    }));
    if (JSON.stringify(nextSubtasks) !== JSON.stringify(task.subtasks)) updates.subtasks = nextSubtasks;
  }

  return Object.keys(updates).length ? updates : undefined;
}

function normalizeSubtaskDraft(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? normalizeText(record.title, 180) : undefined;
  if (!title) return undefined;
  return { title, completed: record.completed === true };
}

function normalizeSubtaskUpdate(value: unknown) {
  if (!value || typeof value !== "object") return undefined;
  const record = value as Record<string, unknown>;
  const title = typeof record.title === "string" ? normalizeText(record.title, 180) : undefined;
  if (!title) return undefined;
  const id = typeof record.id === "string" && record.id.trim() ? record.id.trim().slice(0, 200) : undefined;
  return { id, title, completed: record.completed === true };
}

function resolveProjectForDraft(
  draft: AITaskDraft,
  projects: Project[],
  projectIds: Set<string>,
  createdProjectIds: string[],
  idFactory?: AIActionIdFactory,
) {
  const fallback = projects[0];
  if (!draft.projectName) return fallback;
  const existing = projects.find((project) => project.name.toLowerCase() === draft.projectName?.toLowerCase());
  if (existing) return existing;

  const project: Project = {
    id: createUniqueProjectId(projectIds, idFactory),
    name: draft.projectName,
    description: "Created by Aevum.",
    color: assignCategoryColor(projects),
  };
  projects.push(project);
  createdProjectIds.push(project.id);
  return project;
}

function createTaskFromDraft(
  draft: AITaskDraft,
  projectId: string,
  now: string,
  taskIds: Set<string>,
  idFactory?: AIActionIdFactory,
): Task {
  const scheduledAt = normalizeScheduledAt(draft.scheduledAt ?? null);
  const repeat = draft.repeat ?? { ...defaultRepeat };
  return {
    id: createUniqueTaskId(taskIds, idFactory),
    title: draft.title,
    description: draft.description ?? "",
    status: "active",
    scheduledAt,
    projectId,
    durationMinutes: draft.durationMinutes ?? null,
    reminderMinutes: draft.reminderMinutes ?? null,
    repeat,
    nextRepeatAt: calculateNextRepeatAt({ scheduledAt, repeat }),
    tags: draft.tags ?? [],
    subtasks: (draft.subtasks ?? []).map((subtask) => ({
      id: createSubtaskId(),
      title: subtask.title,
      completed: subtask.completed === true,
    })),
    createdAt: now,
    updatedAt: now,
  };
}

function validateScheduleConstraints(
  changes: ScheduleChangeDraft[],
  tasks: Task[],
): { ok: true } | { ok: false; reason: AIActionFailureReason } {
  const proposed = new Map<string, ScheduleChangeDraft>();
  for (const change of changes) proposed.set(change.taskId, change);

  const projectedTasks = tasks.map((task) => {
    const change = proposed.get(task.id);
    return change
      ? { ...task, scheduledAt: change.scheduledAt, durationMinutes: change.durationMinutes ?? task.durationMinutes ?? 30 }
      : task;
  });

  for (const task of projectedTasks) {
    if (task.status !== "active" || !task.scheduledAt || !getScheduleTime(task.scheduledAt)) continue;
    const duration = task.durationMinutes ?? 30;
    if (!Number.isFinite(duration) || duration <= 0) return { ok: false, reason: "invalid_action" };
    for (const other of projectedTasks) {
      if (other.id <= task.id || other.status !== "active" || !other.scheduledAt || !getScheduleTime(other.scheduledAt)) continue;
      const otherDuration = other.durationMinutes ?? 30;
      if (rangesOverlap(task.scheduledAt, duration, other.scheduledAt, otherDuration)) {
        return { ok: false, reason: "invalid_action" };
      }
    }
  }

  return { ok: true };
}

function recalculateTask(task: Task): Task {
  return {
    ...task,
    nextRepeatAt: task.repeat.enabled ? calculateNextRepeatAt(task) : null,
  };
}

function createPreconditions(action: AssistantAction, state: AIActionStateSnapshot): AIActionPreconditions {
  const taskIds = new Set<string>();
  const projectIds = new Set<string>();

  if (action.type === "schedule_tasks") {
    action.changes.forEach((change) => taskIds.add(change.taskId));
  }

  if (action.type === "manage_tasks") {
    action.operations.forEach((operation) => {
      taskIds.add(operation.taskId);
      if (operation.operation === "update" && operation.changes.projectId) {
        projectIds.add(operation.changes.projectId);
      }
    });
  }

  if (action.type === "batch_action") {
    if (action.scheduleChanges) {
      action.scheduleChanges.forEach((change) => taskIds.add(change.taskId));
    }
    if (action.manageOperations) {
      action.manageOperations.forEach((operation) => {
        taskIds.add(operation.taskId);
        if (operation.operation === "update" && operation.changes.projectId) {
          projectIds.add(operation.changes.projectId);
        }
      });
    }
    if (action.categoriesToRename) {
      action.categoriesToRename.forEach((rename) => {
        projectIds.add(rename.categoryId);
      });
    }
    if (action.categoriesToUpdate) {
      action.categoriesToUpdate.forEach((update) => {
        projectIds.add(update.categoryId);
      });
    }
    if (action.categoriesToDelete) {
      action.categoriesToDelete.forEach((deletion) => {
        projectIds.add(deletion.categoryId);
        if (deletion.strategy.mode === "move_tasks_to_category") projectIds.add(deletion.strategy.targetCategoryId);
        state.tasks.forEach((task) => {
          if (task.projectId === deletion.categoryId) taskIds.add(task.id);
        });
      });
    }
  }

  return {
    tasks: [...taskIds].map((taskId) => {
      const task = state.tasks.find((item) => item.id === taskId);
      return task
        ? {
            taskId,
            fingerprint: fingerprintTask(task),
            status: task.status,
            updatedAt: task.updatedAt,
          }
        : {
            taskId,
            fingerprint: "missing",
            status: "active",
            updatedAt: "",
          };
    }),
    projects: [...projectIds].map((projectId) => {
      const project = state.projects.find((item) => item.id === projectId);
      return {
        projectId,
        fingerprint: project ? fingerprintProject(project) : "missing",
      };
    }),
  };
}

function preconditionsMatch(preconditions: AIActionPreconditions, state: AIActionStateSnapshot) {
  for (const precondition of preconditions.tasks) {
    const task = state.tasks.find((item) => item.id === precondition.taskId);
    if (!task || fingerprintTask(task) !== precondition.fingerprint) return false;
  }
  for (const precondition of preconditions.projects) {
    const project = state.projects.find((item) => item.id === precondition.projectId);
    if (!project || fingerprintProject(project) !== precondition.fingerprint) return false;
  }
  return true;
}

function createPreviewItems(action: AssistantAction, state: AIActionStateSnapshot): AIActionPreviewItem[] {
  if (action.type === "create_tasks") {
    return action.tasks.map((task) => ({ kind: "create", title: task.title, after: task.scheduledAt ?? undefined }));
  }

  if (action.type === "schedule_tasks") {
    return action.changes.map((change) => {
      const task = state.tasks.find((item) => item.id === change.taskId);
      return {
        kind: "schedule",
        title: task?.title ?? "",
        before: task?.scheduledAt ?? undefined,
        after: change.scheduledAt,
      };
    });
  }

  if (action.type === "batch_action") {
    const items: AIActionPreviewItem[] = [];
    if (action.categoriesToCreate) {
      action.categoriesToCreate.forEach((cat) => {
        items.push({ kind: "create", title: `Category: ${cat.name}` });
      });
    }
    if (action.categoriesToRename) {
      action.categoriesToRename.forEach((rename) => {
        const project = state.projects.find((p) => p.id === rename.categoryId);
        items.push({
          kind: "update",
          title: `Category: ${project?.name ?? rename.categoryId}`,
          before: project?.name,
          after: rename.newName,
        });
      });
    }
    if (action.categoriesToUpdate) {
      action.categoriesToUpdate.forEach((update) => {
        const project = state.projects.find((p) => p.id === update.categoryId);
        items.push({
          kind: "update",
          title: `Category: ${project?.name ?? update.categoryId}`,
          before: project?.name,
          after: update.name ?? project?.name,
        });
      });
    }
    if (action.categoriesToDelete) {
      action.categoriesToDelete.forEach((deletion) => {
        const project = state.projects.find((p) => p.id === deletion.categoryId);
        items.push({ kind: "delete", title: `Category: ${project?.name ?? deletion.categoryId}`, destructive: true });
      });
    }
    if (action.tasksToCreate) {
      action.tasksToCreate.forEach((task) => {
        items.push({ kind: "create", title: task.title, after: task.scheduledAt ?? undefined });
      });
    }
    if (action.scheduleChanges) {
      action.scheduleChanges.forEach((change) => {
        const task = state.tasks.find((item) => item.id === change.taskId);
        items.push({
          kind: "schedule",
          title: task?.title ?? "",
          before: task?.scheduledAt ?? undefined,
          after: change.scheduledAt,
        });
      });
    }
    if (action.manageOperations) {
      action.manageOperations.forEach((operation) => {
        const task = state.tasks.find((item) => item.id === operation.taskId);
        if (operation.operation === "delete") {
          items.push({ kind: "delete", title: task?.title ?? "", destructive: true });
        } else if (operation.operation === "set_status") {
          items.push({ kind: "status", title: task?.title ?? "", before: task?.status, after: operation.status });
        } else {
          items.push({ kind: "update", title: task?.title ?? "" });
        }
      });
    }
    return items;
  }

  return action.operations.map((operation) => {
    const task = state.tasks.find((item) => item.id === operation.taskId);
    if (operation.operation === "delete") return { kind: "delete", title: task?.title ?? "", destructive: true };
    if (operation.operation === "set_status") {
      return { kind: "status", title: task?.title ?? "", before: task?.status, after: operation.status };
    }
    return { kind: "update", title: task?.title ?? "" };
  });
}

function createTransactionSummary(
  action: AssistantAction,
  taskPatches: AIActionTaskPatch[],
  projectPatches: AIActionProjectPatch[],
  state: AIActionStateSnapshot,
): AIActionSummary {
  const taskTitles = taskPatches.map((patch) => patch.after?.title ?? patch.before?.title).filter((title): title is string => Boolean(title));
  const projectNames = projectPatches.map((patch) => patch.after?.name ?? patch.before?.name).filter((name): name is string => Boolean(name));
  const createdTaskCount = taskPatches.filter((patch) => patch.change === "created" && !patch.generatedByRecurringCompletion).length;
  const deletedTaskCount = taskPatches.filter((patch) => patch.change === "deleted").length;
  const updatedTaskCount = taskPatches.filter((patch) => patch.change === "updated").length;
  const deletedProjectCount = projectPatches.filter((patch) => patch.change === "deleted").length;
  let completedTaskCount = 0;
  let reopenedTaskCount = 0;

  if (action.type === "manage_tasks" || action.type === "batch_action") {
    const operations = action.type === "manage_tasks" ? action.operations : (action.manageOperations ?? []);
    for (const operation of operations) {
      if (operation.operation === "set_status" && operation.status === "completed") completedTaskCount += 1;
      if (operation.operation === "set_status" && operation.status === "active") reopenedTaskCount += 1;
    }
  }

  if (action.type === "schedule_tasks") {
    const titles = action.changes
      .map((change) => state.tasks.find((task) => task.id === change.taskId)?.title)
      .filter((title): title is string => Boolean(title));
    taskTitles.splice(0, taskTitles.length, ...titles);
  }

  return {
    kind: getActionKind(action),
    taskTitles,
    taskCount: taskTitles.length,
    projectNames,
    createdTaskCount,
    updatedTaskCount,
    deletedTaskCount,
    completedTaskCount,
    reopenedTaskCount,
    destructive: deletedTaskCount > 0 || deletedProjectCount > 0,
  };
}

function buildTaskPatches(beforeTasks: Task[], afterTasks: Task[], affectedTaskIds: string[], generatedRecurringTaskIds: string[]) {
  const ids = new Set(affectedTaskIds);
  const patches: AIActionTaskPatch[] = [];
  ids.forEach((taskId) => {
    const before = beforeTasks.find((task) => task.id === taskId);
    const after = afterTasks.find((task) => task.id === taskId);
    if (!before && !after) return;
    if (before && after && sameTask(before, after)) return;
    patches.push({
      taskId,
      before: before ? cloneTask(before) : undefined,
      after: after ? cloneTask(after) : undefined,
      change: before && after ? "updated" : before ? "deleted" : "created",
      generatedByRecurringCompletion: generatedRecurringTaskIds.includes(taskId) || undefined,
    });
  });
  return patches;
}

function buildProjectPatches(beforeProjects: Project[], afterProjects: Project[], affectedProjectIds: string[]) {
  const ids = new Set(affectedProjectIds);
  const patches: AIActionProjectPatch[] = [];
  ids.forEach((projectId) => {
    const before = beforeProjects.find((project) => project.id === projectId);
    const after = afterProjects.find((project) => project.id === projectId);
    if (!before && !after) return;
    if (before && after && sameProject(before, after)) return;
    patches.push({
      projectId,
      before: before ? cloneProject(before) : undefined,
      after: after ? cloneProject(after) : undefined,
      change: before && after ? "updated" : before ? "deleted" : "created",
    });
  });
  return patches;
}

function buildUndoTaskPatches(originalPatches: AIActionTaskPatch[]): AIActionTaskPatch[] {
  return originalPatches.map((patch) => ({
    taskId: patch.taskId,
    before: patch.after ? cloneTask(patch.after) : undefined,
    after: patch.before ? cloneTask(patch.before) : undefined,
    change: patch.change === "created" ? "deleted" : patch.change === "deleted" ? "created" : "updated",
    generatedByRecurringCompletion: patch.generatedByRecurringCompletion,
  }));
}

function buildUndoProjectPatches(originalPatches: AIActionProjectPatch[], workingTasks: Task[]): AIActionProjectPatch[] {
  const patches: AIActionProjectPatch[] = [];
  for (const patch of originalPatches) {
    if (patch.change === "created") {
      if (workingTasks.some((task) => task.projectId === patch.projectId)) continue;
      patches.push({
        projectId: patch.projectId,
        before: patch.after ? cloneProject(patch.after) : undefined,
        after: undefined,
        change: "deleted",
      });
    } else if (patch.change === "updated") {
      patches.push({
        projectId: patch.projectId,
        before: patch.after ? cloneProject(patch.after) : undefined,
        after: patch.before ? cloneProject(patch.before) : undefined,
        change: "updated",
      });
    } else if (patch.change === "deleted") {
      patches.push({
        projectId: patch.projectId,
        before: undefined,
        after: patch.before ? cloneProject(patch.before) : undefined,
        change: "created",
      });
    }
  }
  return patches;
}

function getActionKind(action: AssistantAction): AIActionKind {
  if (action.type === "create_tasks") return "create";
  if (action.type === "schedule_tasks") return action.mode === "replan_tasks" ? "replan" : "schedule";
  if (action.type === "batch_action") return "batch";
  return "manage";
}

function createUniqueTaskId(taskIds: Set<string>, idFactory?: AIActionIdFactory) {
  let id = idFactory?.taskId?.() ?? createTaskId();
  while (taskIds.has(id)) id = idFactory?.taskId?.() ?? createTaskId();
  taskIds.add(id);
  return id;
}

function createUniqueProjectId(projectIds: Set<string>, idFactory?: AIActionIdFactory) {
  let id = idFactory?.projectId?.() ?? createProjectId();
  while (projectIds.has(id)) id = idFactory?.projectId?.() ?? createProjectId();
  projectIds.add(id);
  return id;
}

function createProposalId() {
  return `proposal-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function createTransactionId() {
  return `aitx-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 10)}`;
}

function cloneTask(task: Task): Task {
  return {
    ...task,
    repeat: { ...task.repeat, weekdays: [...task.repeat.weekdays], excludedWeekdays: [...task.repeat.excludedWeekdays] },
    tags: [...task.tags],
    subtasks: task.subtasks.map((subtask) => ({ ...subtask })),
  };
}

function cloneProject(project: Project): Project {
  return { ...project };
}

function sameTask(a: Task, b: Task) {
  return fingerprintTask(a) === fingerprintTask(b);
}

function sameProject(a: Project, b: Project) {
  return fingerprintProject(a) === fingerprintProject(b);
}

function fingerprintTask(task: Task) {
  return JSON.stringify(cloneTask(task));
}

function fingerprintProject(project: Project) {
  return JSON.stringify(cloneProject(project));
}

function normalizeText(value: string, maxLength: number) {
  const trimmed = value.trim().replace(/\s+/g, " ");
  if (!trimmed) return undefined;
  return trimmed.slice(0, maxLength);
}

function normalizeReason(value: unknown) {
  return typeof value === "string" ? normalizeText(value, 240) : undefined;
}

function normalizeDuration(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const minutes = Math.floor(value);
  return minutes <= maxDurationMinutes ? minutes : null;
}

function normalizeReminder(value: unknown): ReminderOffsetMinutes | null {
  return value === 0 || value === 5 || value === 10 || value === 30 || value === 60 ? value : null;
}

function rangesOverlap(aStart: string, aDuration: number, bStart: string, bDuration: number) {
  const aDate = aStart.slice(0, 10);
  const bDate = bStart.slice(0, 10);
  if (aDate !== bDate) return false;
  const a = toMinutes(getScheduleTime(aStart));
  const b = toMinutes(getScheduleTime(bStart));
  return a < b + bDuration && b < a + aDuration;
}

function toMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function unique<T>(items: T[]): T[] {
  return [...new Set(items)];
}

function hasSecretLikeText(values: string[]) {
  return values.some((value) => secretPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(value);
  }));
}

function sanitizeAuditEntry(entry: AIActionAuditEntry): AIActionAuditEntry {
  const serialized = JSON.stringify(entry);
  const redacted = redactSecrets(serialized);
  const sanitized = JSON.parse(redacted) as AIActionAuditEntry;
  return {
    ...sanitized,
    containsRedactions: serialized !== redacted || entry.containsRedactions || undefined,
  };
}

function redactSecrets(value: string) {
  let next = value;
  for (const pattern of secretPatterns) {
    pattern.lastIndex = 0;
    next = next.replace(pattern, "[redacted]");
  }
  return next;
}
