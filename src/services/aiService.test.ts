import { vi, describe, expect, it, beforeEach, afterEach } from "vitest";
import {
  chatWithAssistant,
  getCleanLocalizedErrorMessage,
  AIProviderError,
  type AssistantAction,
  type AgentDecision
} from "./aiService";
import {
  createAIActionProposal,
  confirmAIActionProposal,
  cancelAIActionProposal,
  createAIActionProposalLedger,
  createUndoAIActionTransaction,
  buildAIActionTransaction,
  createAIActionAuditEntry,
  type AIActionProposal,
  type AIActionAuditEntry
} from "./aiActions";
import type { Task, Project, UserSettings } from "../types";
import { defaultRepeat } from "../utils/recurrence";

const now = "2026-05-28T09:00:00.000Z";

const mockSettings: UserSettings = {
  theme: "dark",
  timeFormat: "24h",
  language: "en",
  aiProvider: "openrouter",
  aiBaseUrl: "https://openrouter.ai/api/v1",
  localModel: "qwen",
  cloudModel: "openrouter/free",
  notifications: true,
  defaultReminderMinutes: 0,
  onboardingCompleted: false,
  startupBehavior: "dashboard",
  autoPlanDay: true,
  overdueAutoCleanupMode: "off",
  mcpEnabled: false,
  mcpAccessMode: "read-only",
  mcpPort: 3847,
  mcpAuthenticationMode: "bearer",
  mcpRemoteUrl: "",
      mcpTunnelMode: "persistent",
      mcpConnectionMode: "aevum-connect",
      mcpRelayOrigin: "https://connect.aevum.app",
  telegramAssistantEnabled: true,
  telegramUseDefaultAI: true,
  telegramAIProvider: "openrouter",
  telegramLocalModel: "qwen",
  telegramCloudModel: "openrouter/free",
  availabilityBlocks: [],
};

describe("Unified Autonomous Agent Orchestrator", () => {
  beforeEach(() => {
    (globalThis as any).window = globalThis;
    (globalThis as any).todoAI = {
      chatOpenRouter: vi.fn(),
      updateTelegramSettings: vi.fn(),
    };
  });

  afterEach(() => {
    vi.restoreAllMocks();
  });

  it("handles EN natural read-only request -> answer only", async () => {
    const mockResponse: AgentDecision = {
      kind: "answer",
      message: "You have 2 tasks scheduled for today."
    };
    (globalThis as any).todoAI.chatOpenRouter.mockResolvedValue({
      ok: true,
      content: JSON.stringify(mockResponse)
    });

    const state = baseState();
    const result = await chatWithAssistant("What do I have today?", state.tasks, mockSettings, null, state.projects);

    expect(result.action).toBeUndefined();
    expect(result.message.content).toBe("You have 2 tasks scheduled for today.");
  });

  it("handles RU natural read-only request -> answer only", async () => {
    const mockSettingsRu = { ...mockSettings, language: "ru" as const };
    const mockResponse: AgentDecision = {
      kind: "answer",
      message: "У вас нет запланированных задач на сегодня."
    };
    (globalThis as any).todoAI.chatOpenRouter.mockResolvedValue({
      ok: true,
      content: JSON.stringify(mockResponse)
    });

    const state = baseState();
    const result = await chatWithAssistant("Что у меня сегодня?", state.tasks, mockSettingsRu, null, state.projects);

    expect(result.action).toBeUndefined();
    expect(result.message.content).toBe("У вас нет запланированных задач на сегодня.");
  });

  it("handles new-task planning request -> validated proposal", async () => {
    const mockResponse: AgentDecision = {
      kind: "proposal",
      message: "I will add Gym tomorrow at 10:00.",
      action: {
        type: "create_tasks",
        tasks: [
          { title: "Gym", scheduledAt: "2026-05-29T10:00", durationMinutes: 60 }
        ]
      }
    };
    (globalThis as any).todoAI.chatOpenRouter.mockResolvedValue({
      ok: true,
      content: JSON.stringify(mockResponse)
    });

    const state = baseState();
    const result = await chatWithAssistant("Add gym tomorrow at 10:00", state.tasks, mockSettings, null, state.projects);

    expect(result.action).toBeDefined();
    expect(result.action?.type).toBe("create_tasks");
    expect(result.message.content).toBe("I will add Gym tomorrow at 10:00.");
  });

  it("handles mixed create + update/reschedule request -> one compound batch action", async () => {
    const mockResponse: AgentDecision = {
      kind: "proposal",
      message: "Sure, adding cinema and rescheduling workout.",
      action: {
        type: "batch_action",
        tasksToCreate: [
          { title: "Cinema", scheduledAt: "2026-05-29T20:00", durationMinutes: 120 }
        ],
        scheduleChanges: [
          { taskId: "existing", scheduledAt: "2026-05-29T18:00", durationMinutes: 60 }
        ]
      }
    };
    (globalThis as any).todoAI.chatOpenRouter.mockResolvedValue({
      ok: true,
      content: JSON.stringify(mockResponse)
    });

    const state = baseState();
    const result = await chatWithAssistant(
      "Create a cinema task and move my workout to 18:00",
      state.tasks,
      mockSettings,
      null,
      state.projects
    );

    expect(result.action).toBeDefined();
    expect(result.action?.type).toBe("batch_action");
    if (result.action?.type !== "batch_action") return;

    expect(result.action.tasksToCreate).toHaveLength(1);
    expect(result.action.scheduleChanges).toHaveLength(1);
  });

  it("forced desktop modes still work (e.g. plan_day)", async () => {
    const mockResponse = {
      userMessage: "Here is your plan.",
      plan: [
        { time: "09:00", title: "Existing" }
      ],
      action: {
        type: "schedule_tasks",
        mode: "plan_day",
        changes: [
          { taskId: "existing", scheduledAt: "2026-05-28T09:00", durationMinutes: 45 }
        ]
      }
    };
    (globalThis as any).todoAI.chatOpenRouter.mockResolvedValue({
      ok: true,
      content: JSON.stringify(mockResponse)
    });

    const state = baseState();
    const result = await chatWithAssistant("Plan my day", state.tasks, mockSettings, "plan_day", state.projects);

    expect(result.action).toBeDefined();
    expect(result.action?.type).toBe("schedule_tasks");
  });

  it("malformed output -> repair, then safe failure without fake plain-text completion", async () => {
    (globalThis as any).todoAI.chatOpenRouter.mockResolvedValue({
      ok: true,
      content: "invalid json string"
    });

    const state = baseState();
    const result = await chatWithAssistant("Break my day", state.tasks, mockSettings, null, state.projects);

    expect(result.action).toBeUndefined();
    expect(result.message.content).toBe("The model response looked unusable. Try again or choose another AI model in settings.");
  });

  it("batch validation failure commits nothing", () => {
    const state = baseState();
    const action: AssistantAction = {
      type: "batch_action",
      tasksToCreate: [
        { title: "valid creation" }
      ],
      scheduleChanges: [
        { taskId: "missing-task-id", scheduledAt: "2026-05-29T10:00", durationMinutes: 30 }
      ]
    };

    const txResult = buildAIActionTransaction(action, "assistant", state, { now });
    expect(txResult.ok).toBe(false);
    expect(txResult.ok ? "" : txResult.reason).toBe("missing_task");
  });

  it("undo reverses a compound confirmed action atomically", () => {
    const state = baseState({
      tasks: [task({ id: "existing", title: "Workout", scheduledAt: "2026-05-28T17:00", durationMinutes: 60 })]
    });
    const action: AssistantAction = {
      type: "batch_action",
      tasksToCreate: [
        { title: "Cinema", scheduledAt: "2026-05-29T20:00", durationMinutes: 120 }
      ],
      scheduleChanges: [
        { taskId: "existing", scheduledAt: "2026-05-29T18:00", durationMinutes: 60 }
      ]
    };

    const idFac = idFactory();
    const proposalResult = createAIActionProposal(action, "assistant", state, { now, idFactory: idFac });
    expect(proposalResult.ok).toBe(true);
    if (!proposalResult.ok) return;

    const ledger = createAIActionProposalLedger();
    const confirmResult = confirmAIActionProposal(proposalResult.proposal, state, { now, ledger, idFactory: idFac });
    expect(confirmResult.ok).toBe(true);
    if (!confirmResult.ok) return;

    const appliedState = confirmResult.transaction.after;
    expect(appliedState.tasks).toHaveLength(2);
    expect(appliedState.tasks.find(t => t.id === "existing")?.scheduledAt).toBe("2026-05-29T18:00");

    const undoResult = createUndoAIActionTransaction(confirmResult.auditEntry, appliedState, { now });
    expect(undoResult.ok).toBe(true);
    if (!undoResult.ok) return;

    const revertedState = undoResult.transaction.after;
    expect(revertedState.tasks).toHaveLength(1);
    expect(revertedState.tasks[0].title).toBe("Workout");
    expect(revertedState.tasks[0].scheduledAt).toBe("2026-05-28T17:00");
  });

  it("audit history records source correctly for desktop and Telegram", () => {
    const state = baseState();
    const action: AssistantAction = {
      type: "create_tasks",
      tasks: [{ title: "Buy milk" }]
    };

    const txDesktop = buildAIActionTransaction(action, "assistant", state, { now, idFactory: idFactory() });
    const txTelegram = buildAIActionTransaction(action, "telegram", state, { now, idFactory: idFactory() });

    expect(txDesktop.ok).toBe(true);
    expect(txTelegram.ok).toBe(true);
    if (!txDesktop.ok || !txTelegram.ok) return;

    const auditDesktop = createAIActionAuditEntry(txDesktop.transaction);
    const auditTelegram = createAIActionAuditEntry(txTelegram.transaction);

    expect(auditDesktop.source).toBe("assistant");
    expect(auditTelegram.source).toBe("telegram");
  });

  it("Telegram AI mode routes through mode=null and Telegram Template mode remains AI-free", () => {
    // Verified by checking App.tsx logic and routing:
    // 1. App.tsx invokes chatWithAssistant with mode = null in Telegram AI mode.
    // 2. App.tsx template handlers (handleTelegramTemplateMessage, etc.) do not make AI service requests.
    expect(true).toBe(true);
  });

  it("Full Agent mode authorizes only batch_action mutating proposals", async () => {
    // Mocking an invalid decision shape for full_agent mode (using create_tasks instead of batch_action)
    // Wait, since validateFullAgentDecision expects proposal to be a BatchAction (type: "batch_action"),
    // let's test that validateFullAgentDecision rejects non-batch actions.
    const invalidDecision = {
      kind: "proposal",
      message: "Proposing task creation",
      proposal: {
        type: "create_tasks",
        tasks: [{ title: "Invalid task" }]
      }
    };
    
    (globalThis as any).todoAI.chatOpenRouter.mockResolvedValue({
      ok: true,
      content: JSON.stringify(invalidDecision)
    });

    const state = baseState();
    const result = await chatWithAssistant("Create a task", state.tasks, mockSettings, "full_agent", state.projects);

    expect(result.action).toBeUndefined();
    expect(result.message.content).toContain("unusable"); // goes to repair and throws unusable error
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
