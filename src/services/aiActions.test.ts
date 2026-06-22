import { describe, expect, it } from "vitest";
import {
  buildAIActionTransaction,
  cancelAIActionProposal,
  confirmAIActionProposal,
  createAIActionAuditEntry,
  createAIActionProposal,
  createAIActionProposalLedger,
  createUndoAIActionTransaction,
  sanitizeAIActionAuditEntryForStorage,
  type AIActionAuditEntry,
} from "./aiActions";
import type { AssistantAction } from "./aiService";
import type { Project, Task } from "../types";
import { aevumCategoryPalette } from "../utils/categoryColors";
import { defaultRepeat } from "../utils/recurrence";

const now = "2026-05-28T09:00:00.000Z";

describe("AI action protection foundation", () => {
  it("commits a valid create action atomically", () => {
    const state = baseState();
    const result = buildAIActionTransaction({
      type: "create_tasks",
      tasks: [
        { title: "Buy food", scheduledAt: "2026-05-29T09:00", tags: ["home"] },
        { title: "Book training", scheduledAt: "2026-05-29T10:00" },
      ],
    }, "assistant", state, { now, idFactory: idFactory() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(state.tasks).toHaveLength(1);
    expect(result.transaction.after.tasks).toHaveLength(3);
    expect(result.transaction.taskPatches.filter((patch) => patch.change === "created")).toHaveLength(2);
    expect(result.transaction.after.tasks[0].title).toBe("Book training");
  });

  it("rejects an invalid create action without mutations", () => {
    const state = baseState();
    const result = buildAIActionTransaction({
      type: "create_tasks",
      tasks: [{ title: "" }],
    }, "assistant", state, { now, idFactory: idFactory() });

    expect(result.ok).toBe(false);
    expect(state.tasks).toEqual(baseState().tasks);
  });

  it("updates all intended tasks for a valid schedule action", () => {
    const state = baseState({
      tasks: [task({ id: "task-a", title: "A" }), task({ id: "task-b", title: "B" })],
    });
    const result = buildAIActionTransaction({
      type: "schedule_tasks",
      mode: "plan_day",
      changes: [
        { taskId: "task-a", scheduledAt: "2026-05-29T09:00", durationMinutes: 30 },
        { taskId: "task-b", scheduledAt: "2026-05-29T10:00", durationMinutes: 45 },
      ],
    }, "assistant", state, { now, idFactory: idFactory() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transaction.after.tasks.find((item) => item.id === "task-a")?.scheduledAt).toBe("2026-05-29T09:00");
    expect(result.transaction.after.tasks.find((item) => item.id === "task-b")?.durationMinutes).toBe(45);
    expect(result.transaction.taskPatches).toHaveLength(2);
  });

  it("rejects a schedule action when one operation is invalid", () => {
    const state = baseState({ tasks: [task({ id: "task-a", title: "A" })] });
    const result = buildAIActionTransaction({
      type: "schedule_tasks",
      mode: "plan_day",
      changes: [
        { taskId: "task-a", scheduledAt: "2026-05-29T09:00", durationMinutes: 30 },
        { taskId: "missing", scheduledAt: "2026-05-29T10:00", durationMinutes: 30 },
      ],
    }, "assistant", state, { now, idFactory: idFactory() });

    expect(result.ok).toBe(false);
    expect(state.tasks[0].scheduledAt).toBeNull();
  });

  it("commits all operations in a valid manage action", () => {
    const state = baseState({
      tasks: [
        task({ id: "task-a", title: "A" }),
        task({ id: "task-b", title: "B" }),
        task({ id: "task-c", title: "C" }),
      ],
    });
    const result = buildAIActionTransaction({
      type: "manage_tasks",
      operations: [
        { operation: "update", taskId: "task-a", changes: { title: "A renamed", scheduledAt: "2026-05-29T11:00" } },
        { operation: "set_status", taskId: "task-b", status: "completed" },
        { operation: "delete", taskId: "task-c" },
      ],
    }, "assistant", state, { now, idFactory: idFactory() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.transaction.after.tasks.find((item) => item.id === "task-a")?.title).toBe("A renamed");
    expect(result.transaction.after.tasks.find((item) => item.id === "task-b")?.status).toBe("completed");
    expect(result.transaction.after.tasks.some((item) => item.id === "task-c")).toBe(false);
    expect(result.transaction.taskPatches).toHaveLength(3);
  });

  it("rejects a manage action when one operation is invalid", () => {
    const state = baseState({ tasks: [task({ id: "task-a", title: "A" })] });
    const result = buildAIActionTransaction({
      type: "manage_tasks",
      operations: [
        { operation: "update", taskId: "task-a", changes: { title: "A renamed" } },
        { operation: "delete", taskId: "missing" },
      ],
    }, "assistant", state, { now, idFactory: idFactory() });

    expect(result.ok).toBe(false);
    expect(state.tasks[0].title).toBe("A");
  });

  it("rejects stale proposal confirmation without mutations", () => {
    const state = baseState({ tasks: [task({ id: "task-a", title: "A" })] });
    const proposalResult = createAIActionProposal({
      type: "schedule_tasks",
      mode: "plan_day",
      changes: [{ taskId: "task-a", scheduledAt: "2026-05-29T09:00", durationMinutes: 30 }],
    }, "assistant", state, { now, ttlMs: 60000, idFactory: idFactory() });
    expect(proposalResult.ok).toBe(true);
    if (!proposalResult.ok) return;

    const current = {
      ...state,
      tasks: [{ ...state.tasks[0], title: "User edited", updatedAt: "2026-05-28T09:05:00.000Z" }],
    };
    const confirmed = confirmAIActionProposal(proposalResult.proposal, current, { now: "2026-05-28T09:00:30.000Z", ledger: createAIActionProposalLedger() });

    expect(confirmed.ok).toBe(false);
    expect(confirmed.ok ? "" : confirmed.reason).toBe("stale");
    expect(current.tasks[0].scheduledAt).toBeNull();
  });

  it("prevents repeated confirmation of the same proposal", () => {
    const state = baseState();
    const ledger = createAIActionProposalLedger();
    const proposalResult = createAIActionProposal({
      type: "create_tasks",
      tasks: [{ title: "One" }],
    }, "telegram", state, { now, ttlMs: 60000, idFactory: idFactory() });
    expect(proposalResult.ok).toBe(true);
    if (!proposalResult.ok) return;

    const first = confirmAIActionProposal(proposalResult.proposal, state, { now, ledger });
    expect(first.ok).toBe(true);
    const nextState = first.ok ? first.transaction.after : state;
    const second = confirmAIActionProposal(proposalResult.proposal, nextState, { now, ledger });
    expect(second.ok).toBe(false);
    expect(second.ok ? "" : second.reason).toBe("replayed");
  });

  it("cancel consumes a proposal and applies nothing", () => {
    const state = baseState();
    const ledger = createAIActionProposalLedger();
    const proposalResult = createAIActionProposal({
      type: "create_tasks",
      tasks: [{ title: "One" }],
    }, "assistant", state, { now, ttlMs: 60000, idFactory: idFactory() });
    expect(proposalResult.ok).toBe(true);
    if (!proposalResult.ok) return;

    expect(cancelAIActionProposal(proposalResult.proposal, ledger).ok).toBe(true);
    const confirmed = confirmAIActionProposal(proposalResult.proposal, state, { now, ledger });
    expect(confirmed.ok).toBe(false);
    expect(state.tasks).toHaveLength(1);
  });

  it("undo restores exact task data after delete", () => {
    const originalTask = task({ id: "task-a", title: "Delete me", description: "Full data", tags: ["x"] });
    const state = baseState({ tasks: [originalTask] });
    const applied = mustTransaction(buildAIActionTransaction({
      type: "manage_tasks",
      operations: [{ operation: "delete", taskId: "task-a" }],
    }, "assistant", state, { now, idFactory: idFactory() }));
    const undo = createUndoAIActionTransaction(createAIActionAuditEntry(applied), applied.after, { now: "2026-05-28T10:00:00.000Z" });

    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.transaction.after.tasks.find((item) => item.id === "task-a")).toEqual(originalTask);
  });

  it("undo restores original values after update and reschedule", () => {
    const originalTask = task({ id: "task-a", title: "Original", scheduledAt: "2026-05-28T12:00", durationMinutes: 30 });
    const state = baseState({ tasks: [originalTask] });
    const applied = mustTransaction(buildAIActionTransaction({
      type: "schedule_tasks",
      mode: "replan_tasks",
      changes: [{ taskId: "task-a", scheduledAt: "2026-05-29T09:00", durationMinutes: 60 }],
    }, "assistant", state, { now, idFactory: idFactory() }));
    const undo = createUndoAIActionTransaction(createAIActionAuditEntry(applied), applied.after, { now: "2026-05-28T10:00:00.000Z" });

    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.transaction.after.tasks.find((item) => item.id === "task-a")).toEqual(originalTask);
  });

  it("undoing recurring completion removes the generated occurrence", () => {
    const recurring = task({
      id: "task-repeat",
      title: "Daily habit",
      scheduledAt: "2026-05-28T08:00",
      repeat: { ...defaultRepeat, enabled: true, type: "daily" },
      nextRepeatAt: "2026-05-29T08:00",
    });
    const state = baseState({ tasks: [recurring] });
    const applied = mustTransaction(buildAIActionTransaction({
      type: "manage_tasks",
      operations: [{ operation: "set_status", taskId: "task-repeat", status: "completed" }],
    }, "assistant", state, { now, idFactory: idFactory() }));

    expect(applied.after.tasks).toHaveLength(2);
    expect(applied.generatedRecurringTaskIds).toHaveLength(1);
    const undo = createUndoAIActionTransaction(createAIActionAuditEntry(applied), applied.after, { now: "2026-05-28T10:00:00.000Z" });

    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.transaction.after.tasks).toHaveLength(1);
    expect(undo.transaction.after.tasks[0]).toEqual(recurring);
  });

  it("handles AI-created categories safely during apply and undo", () => {
    const state = baseState();
    const applied = mustTransaction(buildAIActionTransaction({
      type: "create_tasks",
      tasks: [{ title: "Train", projectName: "Health" }],
    }, "assistant", state, { now, idFactory: idFactory() }));

    const createdProject = applied.after.projects.find((projectItem) => projectItem.name === "Health");
    expect(createdProject).toBeDefined();
    const undo = createUndoAIActionTransaction(createAIActionAuditEntry(applied), applied.after, { now: "2026-05-28T10:00:00.000Z" });
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.transaction.after.projects.some((projectItem) => projectItem.name === "Health")).toBe(false);
    expect(undo.transaction.after.tasks.some((item) => item.title === "Train")).toBe(false);
  });

  it("preserves a created category during undo when another task now uses it", () => {
    const applied = mustTransaction(buildAIActionTransaction({
      type: "create_tasks",
      tasks: [{ title: "Train", projectName: "Health" }],
    }, "assistant", baseState(), { now, idFactory: idFactory() }));
    const createdProject = applied.after.projects.find((projectItem) => projectItem.name === "Health");
    expect(createdProject).toBeDefined();
    if (!createdProject) return;
    const current = {
      tasks: [task({ id: "manual", title: "Manual", projectId: createdProject.id }), ...applied.after.tasks],
      projects: applied.after.projects,
    };

    const undo = createUndoAIActionTransaction(createAIActionAuditEntry(applied), current, { now: "2026-05-28T10:00:00.000Z" });
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.warnings).toContain("created-project-still-used");
    expect(undo.transaction.after.projects.some((projectItem) => projectItem.id === createdProject.id)).toBe(true);
  });

  it("prevents unsafe undo after a later edit", () => {
    const state = baseState({ tasks: [task({ id: "task-a", title: "Original" })] });
    const applied = mustTransaction(buildAIActionTransaction({
      type: "manage_tasks",
      operations: [{ operation: "update", taskId: "task-a", changes: { title: "AI title" } }],
    }, "assistant", state, { now, idFactory: idFactory() }));
    const current = {
      ...applied.after,
      tasks: applied.after.tasks.map((item) => item.id === "task-a" ? { ...item, title: "Manual title" } : item),
    };
    const undo = createUndoAIActionTransaction(createAIActionAuditEntry(applied), current, { now: "2026-05-28T10:00:00.000Z" });

    expect(undo.ok).toBe(false);
    expect(undo.ok ? "" : undo.reason).toBe("conflict");
  });

  it("assistant and Telegram sources share equivalent transaction behavior and audit source", () => {
    const action: AssistantAction = {
      type: "schedule_tasks",
      mode: "plan_day",
      changes: [{ taskId: "task-a", scheduledAt: "2026-05-29T09:00", durationMinutes: 30 }],
    };
    const state = baseState({ tasks: [task({ id: "task-a", title: "A" })] });
    const assistant = mustTransaction(buildAIActionTransaction(action, "assistant", state, { now, idFactory: idFactory() }));
    const telegram = mustTransaction(buildAIActionTransaction(action, "telegram", state, { now, idFactory: idFactory() }));
    const assistantAudit = createAIActionAuditEntry(assistant);
    const telegramAudit = createAIActionAuditEntry(telegram);

    expect(assistant.after.tasks[0].scheduledAt).toBe(telegram.after.tasks[0].scheduledAt);
    expect(assistantAudit.source).toBe("assistant");
    expect(telegramAudit.source).toBe("telegram");
    expect(telegramAudit.actionKind).toBe("schedule");
  });

  it("confirms and undoes MCP proposals through the shared transaction engine", () => {
    const state = baseState({ tasks: [task({ id: "task-a", title: "Before" })] });
    const proposal = createAIActionProposal({
      type: "manage_tasks",
      operations: [{ operation: "update", taskId: "task-a", changes: { title: "After" } }],
    }, "mcp", state, { now, idFactory: idFactory() });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;
    const confirmed = confirmAIActionProposal(proposal.proposal, state, { now, ledger: createAIActionProposalLedger(), idFactory: idFactory() });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.auditEntry.source).toBe("mcp");
    expect(confirmed.transaction.after.tasks[0].title).toBe("After");
    const undo = createUndoAIActionTransaction(confirmed.auditEntry, confirmed.transaction.after, { now, idFactory: idFactory() });
    expect(undo.ok).toBe(true);
    if (undo.ok) expect(undo.transaction.after.tasks[0].title).toBe("Before");
  });

  it("applies Full Access category and task proposals through MCP audit and undo", () => {
    const state = baseState();
    const proposal = createAIActionProposal({
      type: "batch_action",
      categoriesToCreate: [{ ref: "work", name: "Work" }],
      tasksToCreate: [{ title: "MCP task", categoryTarget: { kind: "new", ref: "work" } }],
    }, "mcp", state, { now, idFactory: idFactory() });
    expect(proposal.ok).toBe(true);
    if (!proposal.ok) return;

    const confirmed = confirmAIActionProposal(proposal.proposal, state, { now, ledger: createAIActionProposalLedger(), idFactory: idFactory() });
    expect(confirmed.ok).toBe(true);
    if (!confirmed.ok) return;
    expect(confirmed.auditEntry).toMatchObject({ source: "mcp", actionKind: "batch", status: "applied" });
    expect(confirmed.transaction.after.projects.some((project) => project.name === "Work")).toBe(true);
    expect(confirmed.transaction.after.tasks.some((item) => item.title === "MCP task")).toBe(true);

    const undo = createUndoAIActionTransaction(confirmed.auditEntry, confirmed.transaction.after, { now, idFactory: idFactory() });
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;
    expect(undo.transaction.after.projects.some((project) => project.name === "Work")).toBe(false);
    expect(undo.transaction.after.tasks.some((item) => item.title === "MCP task")).toBe(false);
  });

  it("audit records do not persist secrets or raw model content", () => {
    const applied = mustTransaction(buildAIActionTransaction({
      type: "create_tasks",
      tasks: [{ title: "Safe task" }],
    }, "assistant", baseState(), { now, idFactory: idFactory() }));
    const entry = createAIActionAuditEntry(applied);
    const withSecret: AIActionAuditEntry = {
      ...entry,
      taskPatches: entry.taskPatches.map((patch) => ({
        ...patch,
        after: patch.after ? { ...patch.after, description: "token sk-or-v1-secretvalue" } : patch.after,
      })),
    };
    const sanitized = sanitizeAIActionAuditEntryForStorage(withSecret);
    const serialized = JSON.stringify(sanitized).toLowerCase();

    expect(serialized).not.toContain("sk-or-v1-secretvalue");
    expect(serialized).not.toContain("rawllm");
    expect(serialized).not.toContain("reasoning");
    expect(sanitized.containsRedactions).toBe(true);
  });

  it("resolves category references correctly within a batch", () => {
    const state = baseState();
    const result = buildAIActionTransaction({
      type: "batch_action",
      categoriesToCreate: [{ ref: "temp-health", name: "Health" }],
      tasksToCreate: [
        { title: "Workout", categoryTarget: { kind: "new", ref: "temp-health" } },
      ],
    }, "assistant", state, { now, idFactory: idFactory() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const addedProj = result.transaction.after.projects.find(p => p.name === "Health");
    expect(addedProj).toBeDefined();
    expect(aevumCategoryPalette).toContain(addedProj?.color);
    const workoutTask = result.transaction.after.tasks.find(t => t.title === "Workout");
    expect(workoutTask?.projectId).toBe(addedProj?.id);
  });

  it("assigns varied safe colors to AI-created categories", () => {
    const state = baseState();
    const result = buildAIActionTransaction({
      type: "batch_action",
      categoriesToCreate: [
        { ref: "health", name: "Health" },
        { ref: "finance", name: "Finance" },
        { ref: "study", name: "Study" },
      ],
    }, "assistant", state, { now, idFactory: idFactory() });

    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const createdColors = result.transaction.after.projects
      .filter((projectItem) => ["Health", "Finance", "Study"].includes(projectItem.name))
      .map((projectItem) => projectItem.color);
    expect(createdColors).toHaveLength(3);
    expect(new Set(createdColors).size).toBe(3);
    createdColors.forEach((color) => expect(aevumCategoryPalette).toContain(color));
  });

  it("prevents creating duplicate categories case-insensitively and space-normalized", () => {
    const state = baseState({
      projects: [project({ id: "uncategorized", name: "Uncategorized" }), project({ id: "work", name: "Work Stuff" })],
    });

    const result1 = buildAIActionTransaction({
      type: "batch_action",
      categoriesToCreate: [{ ref: "t1", name: "  work  stuff " }],
    }, "assistant", state, { now, idFactory: idFactory() });
    expect(result1.ok).toBe(false);

    const result2 = buildAIActionTransaction({
      type: "batch_action",
      categoriesToCreate: [
        { ref: "t1", name: "Study" },
        { ref: "t2", name: "study" },
      ],
    }, "assistant", state, { now, idFactory: idFactory() });
    expect(result2.ok).toBe(false);
  });

  it("rejects conflicting category rename operations", () => {
    const state = baseState({
      projects: [project({ id: "p1", name: "Health" }), project({ id: "p2", name: "Finance" })],
    });

    const result1 = buildAIActionTransaction({
      type: "batch_action",
      categoriesToRename: [
        { categoryId: "p1", newName: "Fitness" },
        { categoryId: "p1", newName: "Wellness" },
      ],
    }, "assistant", state, { now, idFactory: idFactory() });
    expect(result1.ok).toBe(false);

    const result2 = buildAIActionTransaction({
      type: "batch_action",
      categoriesToRename: [{ categoryId: "p1", newName: "Finance" }],
    }, "assistant", state, { now, idFactory: idFactory() });
    expect(result2.ok).toBe(false);
  });

  it("protects special fallback category from renaming and mutation", () => {
    const state = baseState({
      projects: [project({ id: "uncategorized", name: "Uncategorized" })],
    });

    const result = buildAIActionTransaction({
      type: "batch_action",
      categoriesToRename: [{ categoryId: "uncategorized", newName: "General" }],
    }, "assistant", state, { now, idFactory: idFactory() });
    expect(result.ok).toBe(false);
  });

  it("rolls back completely on invalid category target reference", () => {
    const state = baseState();

    const result = buildAIActionTransaction({
      type: "batch_action",
      categoriesToCreate: [{ ref: "t1", name: "Work" }],
      tasksToCreate: [
        { title: "Task 1", categoryTarget: { kind: "new", ref: "temp-missing" } },
      ],
    }, "assistant", state, { now, idFactory: idFactory() });

    expect(result.ok).toBe(false);
    expect(state.tasks).toHaveLength(1);
    expect(state.projects).toHaveLength(1);
  });

  it("performs atomic undo of mixed category and task operations", () => {
    const state = baseState({
      projects: [project({ id: "uncategorized", name: "Uncategorized" }), project({ id: "p1", name: "Fitness" })],
      tasks: [task({ id: "task-1", title: "Jogging", projectId: "p1" })],
    });

    const applied = mustTransaction(buildAIActionTransaction({
      type: "batch_action",
      categoriesToCreate: [{ ref: "t-fin", name: "Finance" }],
      categoriesToRename: [{ categoryId: "p1", newName: "Gym" }],
      tasksToCreate: [{ title: "Pay bills", categoryTarget: { kind: "new", ref: "t-fin" } }],
      manageOperations: [
        { operation: "update", taskId: "task-1", changes: { title: "Jogging updated" } },
      ],
    }, "assistant", state, { now, idFactory: idFactory() }));

    const financeProj = applied.after.projects.find(p => p.name === "Finance");
    expect(financeProj).toBeDefined();
    const gymProj = applied.after.projects.find(p => p.id === "p1");
    expect(gymProj?.name).toBe("Gym");

    const undo = createUndoAIActionTransaction(createAIActionAuditEntry(applied), applied.after, { now });
    expect(undo.ok).toBe(true);
    if (!undo.ok) return;

    expect(undo.transaction.after.projects.some(p => p.name === "Finance")).toBe(false);
    expect(undo.transaction.after.projects.find(p => p.id === "p1")?.name).toBe("Fitness");
    expect(undo.transaction.after.tasks.some(t => t.title === "Pay bills")).toBe(false);
    expect(undo.transaction.after.tasks.find(t => t.id === "task-1")?.title).toBe("Jogging");
  });

  it("blocks unsafe undo of renamed category if manual edits occurred afterwards", () => {
    const state = baseState({
      projects: [project({ id: "p1", name: "Health" })],
    });

    const applied = mustTransaction(buildAIActionTransaction({
      type: "batch_action",
      categoriesToRename: [{ categoryId: "p1", newName: "Fitness" }],
    }, "assistant", state, { now, idFactory: idFactory() }));

    const modifiedState = {
      ...applied.after,
      projects: applied.after.projects.map(p => p.id === "p1" ? { ...p, name: "Manual Rename" } : p),
    };

    const undo = createUndoAIActionTransaction(createAIActionAuditEntry(applied), modifiedState, { now });
    expect(undo.ok).toBe(false);
    expect(undo.ok ? "" : undo.reason).toBe("conflict");
  });
});

function baseState(overrides: Partial<{ tasks: Task[]; projects: Project[] }> = {}) {
  return {
    tasks: overrides.tasks ?? [task({ id: "existing", title: "Existing" })],
    projects: overrides.projects ?? [project()],
  };
}

function task(overrides: Partial<Task> = {}): Task {
  const repeat = overrides.repeat ?? { ...defaultRepeat };
  return {
    id: "task-a",
    title: "Task",
    description: "",
    status: "active",
    scheduledAt: null,
    projectId: "uncategorized",
    durationMinutes: null,
    reminderMinutes: null,
    repeat,
    nextRepeatAt: repeat.enabled ? "2026-05-29T08:00" : null,
    tags: [],
    subtasks: [],
    createdAt: "2026-05-28T08:00:00.000Z",
    updatedAt: "2026-05-28T08:00:00.000Z",
    ...overrides,
  };
}

function project(overrides: Partial<Project> = {}): Project {
  return {
    id: "uncategorized",
    name: "Uncategorized",
    color: "var(--project-sage)",
    description: "",
    ...overrides,
  };
}

function idFactory() {
  let taskCount = 0;
  let projectCount = 0;
  let transactionCount = 0;
  let proposalCount = 0;
  return {
    taskId: () => `task-new-${++taskCount}`,
    projectId: () => `project-new-${++projectCount}`,
    transactionId: () => `aitx-test-${++transactionCount}`,
    proposalId: () => `proposal-test-${++proposalCount}`,
  };
}

function mustTransaction(result: ReturnType<typeof buildAIActionTransaction>) {
  expect(result.ok).toBe(true);
  if (!result.ok) throw new Error(result.reason);
  return result.transaction;
}
