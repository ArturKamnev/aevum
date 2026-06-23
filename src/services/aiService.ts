import type { AIMode, AssistantMessage, AvailabilityBlock, Project, ReminderOffsetMinutes, RepeatRule, Task, TaskStatus, UserSettings } from "../types";
import { getScheduleDate, getScheduleTime, getTodayISO, normalizeScheduledAt } from "../utils/date";
import { defaultRepeat, normalizeRepeat } from "../utils/recurrence";

export type AIConnectionStatus = "idle" | "connected" | "not-connected" | "model-missing";
type StructuredSchema = "create_tasks" | "plan_day" | "replan_tasks" | "manage_tasks" | "create_subtasks" | "auto_agent" | "full_agent";
const dayMinutes = 24 * 60;
const guideMaxLength = 2000;
const taskDraftMaxLength = 800;

export interface AIModelInfo {
  name: string;
  modifiedAt?: string;
}

export type AICategoryTarget =
  | { kind: "existing"; categoryId: string }
  | { kind: "new"; ref: string };

export interface AICategoryDraft {
  ref: string;
  name: string;
  color?: string;
  description?: string;
}

export interface CategoryRenameDraft {
  categoryId: string;
  newName: string;
}

export interface CategoryUpdateDraft {
  categoryId: string;
  name?: string;
  color?: string;
  description?: string;
}

export type CategoryDeleteStrategy =
  | { mode: "move_tasks_to_uncategorized" }
  | { mode: "move_tasks_to_category"; targetCategoryId: string }
  | { mode: "delete_tasks_too"; confirmTaskDeletion: true };

export interface CategoryDeleteDraft {
  categoryId: string;
  strategy: CategoryDeleteStrategy;
}

export interface AIConnectionResult {
  status: AIConnectionStatus;
  message: string;
  models: AIModelInfo[];
  selectedModelInstalled: boolean;
  suggestedCommand?: string;
}

export interface AITaskDraft {
  title: string;
  description?: string;
  scheduledAt?: string | null;
  durationMinutes?: number | null;
  reminderMinutes?: ReminderOffsetMinutes | null;
  repeat?: RepeatRule;
  projectName?: string;
  categoryTarget?: AICategoryTarget;
  tags?: string[];
  subtasks?: Array<{ title: string; completed?: boolean }>;
}

export interface CreateTasksAction {
  type: "create_tasks";
  tasks: AITaskDraft[];
}

export interface ScheduleChangeDraft {
  taskId: string;
  scheduledAt: string;
  durationMinutes?: number | null;
  reason?: string;
}

export interface ScheduleTasksAction {
  type: "schedule_tasks";
  mode: "plan_day" | "replan_tasks";
  changes: ScheduleChangeDraft[];
}

export interface ManageTaskChanges {
  title?: string;
  description?: string;
  scheduledAt?: string | null;
  durationMinutes?: number | null;
  reminderMinutes?: ReminderOffsetMinutes | null;
  projectId?: string;
  repeat?: RepeatRule;
  tags?: string[];
  subtasks?: Task["subtasks"];
}

export interface ManageTaskUpdateOperation {
  operation: "update";
  taskId: string;
  changes: ManageTaskChanges;
  reason?: string;
}

export interface ManageTaskStatusOperation {
  operation: "set_status";
  taskId: string;
  status: TaskStatus;
  reason?: string;
}

export interface ManageTaskDeleteOperation {
  operation: "delete";
  taskId: string;
  reason?: string;
}

export type ManageTaskOperation = ManageTaskUpdateOperation | ManageTaskStatusOperation | ManageTaskDeleteOperation;

export interface ManageTasksAction {
  type: "manage_tasks";
  operations: ManageTaskOperation[];
}

export interface BatchAction {
  type: "batch_action";
  categoriesToCreate?: AICategoryDraft[];
  categoriesToRename?: CategoryRenameDraft[];
  categoriesToUpdate?: CategoryUpdateDraft[];
  categoriesToDelete?: CategoryDeleteDraft[];
  tasksToCreate?: AITaskDraft[];
  scheduleChanges?: ScheduleChangeDraft[];
  manageOperations?: ManageTaskOperation[];
}

export type AssistantAction = CreateTasksAction | ScheduleTasksAction | ManageTasksAction | BatchAction;

export type FullAgentProposal = BatchAction;

export type FullAgentDecision =
  | { kind: "answer"; message: string }
  | { kind: "clarify"; message: string }
  | { kind: "proposal"; message: string; proposal: FullAgentProposal };

export type AgentDecision =
  | { kind: "answer"; message: string }
  | { kind: "clarify"; message: string }
  | { kind: "proposal"; message: string; action: AssistantAction };

export interface AIChatResult {
  message: AssistantMessage;
  action?: AssistantAction;
}

interface PlanBlock {
  time?: string;
  title: string;
  description?: string;
}

interface PlanDayResult {
  userMessage: string;
  plan: PlanBlock[];
  action?: ScheduleTasksAction;
}

interface SubtasksResult {
  userMessage: string;
  subtasks: string[];
}

interface ManageTasksResult {
  userMessage: string;
  action?: ManageTasksAction;
}

type AIRequestMode = "guide" | "guide_repair" | StructuredSchema | `${StructuredSchema}_repair`;

export class AIProviderError extends Error {
  constructor(
    message: string,
    public readonly code:
      | "ollama_not_running"
      | "model_missing"
      | "wrong_base_url"
      | "cors_blocked"
      | "unexpected_response"
      | "invalid_ai_response"
      | "provider_not_supported"
      | "openrouter_missing_key"
      | "openrouter_invalid_key"
      | "openrouter_billing_issue"
      | "openrouter_model_unavailable"
      | "openrouter_rate_limited"
      | "openrouter_offline"
      | "openrouter_provider_error",
    public readonly debug?: Record<string, string | number | boolean | undefined>,
  ) {
    super(message);
    this.name = "AIProviderError";
  }
}

function buildGuidePrompt(taskContext: Task[], language: UserSettings["language"]) {
  const taskSummary = taskContext
    .slice(0, 10)
    .map((task) => `- ${task.title} (status: ${task.status}, scheduled: ${task.scheduledAt ?? "none"})`)
    .join("\n");

  const langBlock = language === "ru"
    ? "Отвечай только на русском языке."
    : "Respond in English only.";

  return `You are Aevum — an AI-powered desktop planner for tasks, daily schedules, reminders, recurring habits, and time visualization.
${langBlock}
Current date: ${getTodayISO()}.

Answer the user's question directly and naturally. Be concise but complete.
When the user asks what Aevum is or what you can do, describe the app's real features: creating tasks, planning the day with AI, setting reminders and recurring schedules, tracking progress on a visual timeline, and managing projects.
Do not repeat your name or role in every answer. Do not explain internal modes or restrictions unless the user asks.
If the user asks you to create, schedule, or plan tasks, tell them to tap the + button and select a tool — but only in that situation, not preemptively.
Do not output JSON, markdown fences, or motivational filler.

User's current tasks:
${taskSummary || "No tasks yet."}`;
}

function buildGuideRepairPrompt(taskContext: Task[], language: UserSettings["language"]) {
  const langName = language === "ru" ? "Russian" : "English";
  return `${buildGuidePrompt(taskContext, language)}

IMPORTANT: The previous assistant answer was broken, in the wrong language, or unusable.
Rewrite it as a single clean answer in ${langName} only.
Return plain natural text. No JSON, no markdown fences, no reasoning tags, no task mutations.`;
}

function authorizeActionResult(
  result: AIChatResult,
  mode: AIMode | null,
  language: UserSettings["language"]
): AIChatResult {
  const action = result.action;
  if (!action) return result; // No action to authorize, always allowed

  // Guide Mode / Auto Agent orchestrator: authorize all task productivity actions
  if (mode === null) {
    const isAllowedAction =
      action.type === "create_tasks" ||
      action.type === "schedule_tasks" ||
      action.type === "manage_tasks" ||
      action.type === "batch_action";

    if (!isAllowedAction) {
      return {
        message: createAssistantMessage(
          language === "ru"
            ? "Это действие не поддерживается или запрещено."
            : "This action is not supported or permitted."
        ),
        action: undefined,
      };
    }
    return result;
  }

  // Create Tasks mode: allow only create_tasks action
  if (mode === "create_tasks") {
    if (action.type === "create_tasks") {
      return result;
    } else {
      return {
        message: createAssistantMessage(
          language === "ru"
            ? "В этом режиме разрешено только создание задач. Пожалуйста, выберите инструмент «Спланировать день»."
            : "Only task creation is allowed in this mode. For planning or managing tasks, choose the matching tool."
        ),
        action: undefined,
      };
    }
  }

  // Plan My Day mode: allow only schedule_tasks action
  if (mode === "plan_day" || mode === "replan_tasks") {
    if (action.type === "schedule_tasks") {
      return result;
    } else {
      return {
        message: createAssistantMessage(
          language === "ru"
            ? "В этом режиме разрешено только планирование задач. Пожалуйста, выберите инструмент «Создать задачи»."
            : "Only task scheduling is allowed in this mode. For creating or managing tasks, choose the matching tool."
        ),
        action: undefined,
      };
    }
  }

  if (mode === "manage_tasks") {
    if (action.type === "manage_tasks") {
      return result;
    }
    return {
      message: createAssistantMessage(
        language === "ru"
          ? "\u0412 \u044d\u0442\u043e\u043c \u0440\u0435\u0436\u0438\u043c\u0435 \u043c\u043e\u0436\u043d\u043e \u0442\u043e\u043b\u044c\u043a\u043e \u0438\u0437\u043c\u0435\u043d\u044f\u0442\u044c \u0441\u0443\u0449\u0435\u0441\u0442\u0432\u0443\u044e\u0449\u0438\u0435 \u0437\u0430\u0434\u0430\u0447\u0438. \u0414\u043b\u044f \u0441\u043e\u0437\u0434\u0430\u043d\u0438\u044f \u0438\u043b\u0438 \u043f\u043b\u0430\u043d\u0430 \u0432\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u043d\u0443\u0436\u043d\u044b\u0439 \u0438\u043d\u0441\u0442\u0440\u0443\u043c\u0435\u043d\u0442."
          : "Only existing task management is allowed in this mode. To create tasks or plan a day, choose the matching tool."
      ),
      action: undefined,
    };
  }

  if (mode === "full_agent") {
    if (action.type !== "batch_action") {
      return {
        message: createAssistantMessage(
          language === "ru"
            ? "Действие запрещено. В режиме Полного Агента разрешены только пакетные действия."
            : "Action denied. Only batch actions are permitted in Full Agent mode."
        ),
        action: undefined,
      };
    }
    return result;
  }

  return result;
}

export async function chatWithAssistant(
  userMessage: string,
  taskContext: Task[],
  settings: UserSettings,
  mode: AIMode | null,
  projectContext: Project[] = [],
): Promise<AIChatResult> {
  try {
    const result = await chatWithAssistantInternal(userMessage, taskContext, settings, mode, projectContext);
    return authorizeActionResult(result, mode, settings.language);
  } catch (error) {
    const cleanMsg = getCleanLocalizedErrorMessage(error, settings.language);
    return {
      message: createAssistantMessage(cleanMsg),
      action: undefined,
    };
  }
}

async function chatWithAssistantInternal(
  userMessage: string,
  taskContext: Task[],
  settings: UserSettings,
  mode: AIMode | null,
  projectContext: Project[],
): Promise<AIChatResult> {
  if (mode === null) {
    const systemPrompt = buildAutoAgentPrompt(taskContext, projectContext, settings.availabilityBlocks, settings.language);
    const decision = await requestStructuredAI(
      userMessage,
      systemPrompt,
      "auto_agent",
      settings,
      (value) => validateAgentDecision(value, taskContext, projectContext, settings.language, settings.availabilityBlocks)
    );

    const action = decision.kind === "proposal" ? decision.action : undefined;
    return {
      message: createAssistantMessage(decision.message, action ? { actionType: action.type } : undefined),
      action,
    };
  }

  if (mode === "full_agent") {
    const systemPrompt = buildFullAgentPrompt(taskContext, projectContext, settings.availabilityBlocks, settings.language);
    const decision = await requestStructuredAI(
      userMessage,
      systemPrompt,
      "full_agent",
      settings,
      (value) => validateFullAgentDecision(value, taskContext, projectContext, settings.language, settings.availabilityBlocks)
    );

    const action = decision.kind === "proposal" ? decision.proposal : undefined;
    return {
      message: createAssistantMessage(decision.message, action ? { actionType: action.type } : undefined),
      action,
    };
  }

  if (mode === "plan_day") {
    const systemPrompt = buildPlanPrompt(taskContext, settings.availabilityBlocks, settings.language);
    const plan = await requestStructuredAI(userMessage, systemPrompt, "plan_day", settings, (value) => validatePlanDayResult(value, taskContext, settings.availabilityBlocks, "plan_day", settings.language));
    return {
      message: createAssistantMessage(renderPlanMessage(plan, settings.language)),
      action: plan.action,
    };
  }

  if (mode === "replan_tasks") {
    const systemPrompt = buildReplanPrompt(taskContext, settings.availabilityBlocks, settings.language);
    const plan = await requestStructuredAI(userMessage, systemPrompt, "replan_tasks", settings, (value) => validatePlanDayResult(value, taskContext, settings.availabilityBlocks, "replan_tasks", settings.language));
    return {
      message: createAssistantMessage(renderPlanMessage(plan, settings.language)),
      action: plan.action,
    };
  }

  if (mode === "manage_tasks") {
    const systemPrompt = buildManageTasksPrompt(taskContext, projectContext, settings.language);
    const result = await requestStructuredAI(userMessage, systemPrompt, "manage_tasks", settings, (value) => validateManageTasksResult(value, taskContext, projectContext, settings.language));
    return {
      message: createAssistantMessage(renderManageTasksMessage(result, settings.language), result.action ? { actionType: result.action.type } : undefined),
      action: result.action,
    };
  }

  const systemPrompt = buildCreateTasksPrompt(taskContext, settings.language);
  const action = await requestStructuredAI(userMessage, systemPrompt, "create_tasks", settings, validateCreateTasksAction);

  return {
    message: createAssistantMessage(renderCreateTasksMessage(action.action.tasks.length, settings.language), { actionType: action.action.type }),
    action: action.action,
  };
}

export async function breakDownTaskWithAI(task: Task, settings: UserSettings): Promise<string[]> {
  const userMessage = `Break this task into practical subtasks: ${task.title}\n\n${task.description}`;
  const result = await requestStructuredAI(userMessage, buildBreakdownPrompt(task, settings.language), "create_subtasks", settings, validateSubtasksResult);
  return result.subtasks;
}

export async function testOllamaConnection(settings: UserSettings): Promise<AIConnectionResult> {
  const endpoint = `${normalizeBaseUrl(settings.aiBaseUrl)}/api/tags`;
  logAIDebug("Testing Ollama connection", {
    provider: settings.aiProvider,
    baseUrl: settings.aiBaseUrl,
    model: settings.localModel,
    endpoint,
  });

  if (settings.aiProvider !== "ollama") {
    throw new AIProviderError("Only Local Ollama is configured in this build.", "provider_not_supported", {
      provider: settings.aiProvider,
    });
  }

  const response = await fetchWithProviderErrors(endpoint, { method: "GET" }, settings);

  logAIDebug("Ollama connection response", {
    provider: settings.aiProvider,
    baseUrl: settings.aiBaseUrl,
    model: settings.localModel,
    endpoint,
    status: response.status,
  });

  if (!response.ok) {
    throw new AIProviderError("Could not connect to the AI provider. Check the Ollama Base URL in Settings.", "wrong_base_url", {
      provider: settings.aiProvider,
      baseUrl: settings.aiBaseUrl,
      model: settings.localModel,
      endpoint,
      status: response.status,
    });
  }

  const payload = (await response.json()) as unknown;
  const models = readOllamaModels(payload);
  const selectedModelInstalled = models.some((model) => modelMatches(model.name, settings.localModel));

  return {
    status: selectedModelInstalled ? "connected" : "model-missing",
    message: selectedModelInstalled ? "Connected" : `Model not found. Run: ollama pull ${settings.localModel}`,
    models,
    selectedModelInstalled,
    suggestedCommand: selectedModelInstalled ? undefined : `ollama pull ${settings.localModel}`,
  };
}

async function requestOllamaChat(
  settings: UserSettings,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { json?: boolean; mode?: AIRequestMode } = {},
) {
  if (settings.aiProvider !== "ollama") {
    throw new AIProviderError("Only Local Ollama is configured in this build.", "provider_not_supported", {
      provider: settings.aiProvider,
    });
  }

  const endpoint = `${normalizeBaseUrl(settings.aiBaseUrl)}/api/chat`;
  logAIDebug("Sending Ollama chat request", {
    provider: settings.aiProvider,
    baseUrl: settings.aiBaseUrl,
    model: settings.localModel,
    endpoint,
    format: options.json ? "json" : "text",
    mode: options.mode,
  });

  const ollamaOptions: Record<string, unknown> = {};
  if (options.json) {
    ollamaOptions.temperature = 0.1;
    ollamaOptions.top_p = 0.9;
  }

  const response = await fetchWithProviderErrors(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.localModel,
      messages,
      stream: false,
      think: false,
      ...(options.json ? { format: "json" } : {}),
      ...(Object.keys(ollamaOptions).length > 0 ? { options: ollamaOptions } : {}),
    }),
  }, settings);

  logAIDebug("Ollama chat response", {
    provider: settings.aiProvider,
    baseUrl: settings.aiBaseUrl,
    model: settings.localModel,
    endpoint,
    status: response.status,
    mode: options.mode,
  });

  if (response.status === 404) {
    throw new AIProviderError(`Model not found. Run: ollama pull ${settings.localModel}`, "model_missing", {
      provider: settings.aiProvider,
      baseUrl: settings.aiBaseUrl,
      model: settings.localModel,
      endpoint,
      status: response.status,
    });
  }

  if (!response.ok) {
    const body = await readResponseText(response);
    const isMissingModel = body.toLowerCase().includes("model") && (body.toLowerCase().includes("not found") || body.toLowerCase().includes("pull"));
    if (isMissingModel) {
      throw new AIProviderError(`Model not found. Run: ollama pull ${settings.localModel}`, "model_missing", {
        provider: settings.aiProvider,
        baseUrl: settings.aiBaseUrl,
        model: settings.localModel,
        endpoint,
        status: response.status,
      });
    }
    throw new AIProviderError("Could not connect to the AI provider. Check the Ollama Base URL in Settings.", "wrong_base_url", {
      provider: settings.aiProvider,
      baseUrl: settings.aiBaseUrl,
      model: settings.localModel,
      endpoint,
      status: response.status,
    });
  }

  const payload = (await response.json()) as unknown;
  const rawContent = readOllamaMessage(payload);
  const content = sanitizeModelArtifacts(rawContent);
  logAIDebug("Received Ollama assistant content", {
    provider: "ollama",
    requestedModel: settings.localModel,
    actualModel: readOllamaActualModel(payload) ?? settings.localModel,
    mode: options.mode,
    status: response.status,
    sanitizedRawAssistantContent: sanitizeForDevLog(content),
  });
  return content;
}

async function requestAIChat(
  settings: UserSettings,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { json?: boolean; mode?: AIRequestMode } = {},
) {
  if (settings.aiProvider === "openrouter") {
    const result = await window.todoAI?.chatOpenRouter({ messages, model: settings.cloudModel, json: options.json, mode: options.mode });
    if (!result?.ok) throw openRouterError(result);
    if (!result.content) throw new AIProviderError("The AI provider returned an unexpected response.", "unexpected_response");
    logAIDebug("Received OpenRouter assistant content", {
      provider: "openrouter",
      requestedModel: result.requestedModel ?? settings.cloudModel,
      actualModel: result.actualModel ?? result.model ?? settings.cloudModel,
      mode: options.mode,
      httpStatus: result.httpStatus,
      sanitizedRawAssistantContent: sanitizeForDevLog(result.content),
    });
    return result.content;
  }
  return requestOllamaChat(settings, messages, options);
}

function openRouterError(result: OpenRouterResult | undefined) {
  const debug = {
    provider: "openrouter",
    status: result?.status,
    httpStatus: result?.httpStatus,
    message: result?.message,
  };
  if (result?.status === "missing-key") return new AIProviderError("Add an OpenRouter API key in Settings.", "openrouter_missing_key", debug);
  if (result?.status === "invalid-key") return new AIProviderError(result.message || "The OpenRouter API key is invalid.", "openrouter_invalid_key", debug);
  if (result?.status === "billing-issue") return new AIProviderError(result.message || "OpenRouter could not run this model because of credits, billing, or free-model account limits.", "openrouter_billing_issue", debug);
  if (result?.status === "model-unavailable") return new AIProviderError(result.message || "The configured OpenRouter model is unavailable or invalid.", "openrouter_model_unavailable", debug);
  if (result?.status === "rate-limited") return new AIProviderError(result.message || "OpenRouter rate limit reached. Try again later.", "openrouter_rate_limited", debug);
  if (result?.status === "provider-unavailable") return new AIProviderError(result.message || "The selected OpenRouter provider is unavailable. Try Auto Free Model.", "openrouter_provider_error", debug);
  if (result?.status === "offline") return new AIProviderError(result.message || "OpenRouter is unreachable. Check your internet connection.", "openrouter_offline", debug);
  if (result?.status === "provider-error") return new AIProviderError(result.message || "OpenRouter could not complete the request.", "openrouter_provider_error", debug);
  return new AIProviderError(result?.message ?? "OpenRouter returned an unexpected response.", "unexpected_response", debug);
}

async function requestGuideText(userMessage: string, taskContext: Task[], settings: UserSettings) {
  const systemPrompt = buildGuidePrompt(taskContext, settings.language);
  const raw = await requestAIChat(settings, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ], { mode: "guide" });

  if (isGuideTextSafe(raw, settings.language)) return sanitizeGuideText(raw, guideFallback(settings.language));

  logInvalidAIResponse(raw, "guide", "initial", settings);
  const repaired = await requestAIChat(settings, [
    { role: "system", content: buildGuideRepairPrompt(taskContext, settings.language) },
    { role: "user", content: userMessage },
    { role: "assistant", content: raw },
    { role: "user", content: settings.language === "ru" ? "Перепиши предыдущий ответ: естественный, краткий, полезный, только на русском языке. Без JSON." : "Rewrite the previous answer: natural, concise, useful, in English only. No JSON." },
  ], { mode: "guide_repair" });

  if (isGuideTextSafe(repaired, settings.language)) return sanitizeGuideText(repaired, guideFallback(settings.language));

  logInvalidAIResponse(repaired, "guide", "repair", settings);
  throw new AIProviderError(retryWithAnotherModelMessage(settings.language), "invalid_ai_response", {
    mode: "guide",
  });
}

async function requestStructuredAI<T>(
  userMessage: string,
  systemPrompt: string,
  schema: StructuredSchema,
  settings: UserSettings,
  validate: (value: unknown) => T | undefined,
): Promise<T> {
  const raw = await requestAIChat(settings, [
    { role: "system", content: systemPrompt },
    { role: "user", content: userMessage },
  ], { json: true, mode: schema });
  const parsed = parseStructured(raw, validate, schema, settings);
  if (parsed) return parsed;

  logInvalidAIResponse(raw, schema, "initial", settings);
  const repaired = await requestAIChat(settings, [
    { role: "system", content: `${systemPrompt}\n\nCorrection pass: the previous assistant output was invalid, malformed, wrong-language, or unusable. Use the original user request below and return exactly one valid JSON object for the same schema. Do not include markdown, commentary, or raw prose outside JSON.` },
    { role: "user", content: userMessage },
    { role: "assistant", content: raw },
    { role: "user", content: "Repair the response now. Return only valid JSON." },
  ], { json: true, mode: `${schema}_repair` });
  const repairedParsed = parseStructured(repaired, validate, schema, settings);
  if (repairedParsed) return repairedParsed;

  logInvalidAIResponse(repaired, schema, "repair", settings);
  throw new AIProviderError(retryWithAnotherModelMessage(settings.language), "invalid_ai_response", {
    schema,
  });
}

function parseStructured<T>(
  raw: string,
  validate: (value: unknown) => T | undefined,
  schema: StructuredSchema,
  settings: UserSettings,
) {
  const candidates = extractJsonCandidates(raw);
  if (!candidates.length) {
    logSchemaValidationError(schema, "No JSON object found in assistant content.", raw, settings);
  }
  for (const candidate of candidates) {
    try {
      const parsed = JSON.parse(candidate) as unknown;
      const valid = validate(parsed);
      if (valid && isLanguageSafeStructured(valid, schema, settings.language)) return valid;
      logSchemaValidationError(schema, valid ? "Structured response failed language safety validation." : "Structured response failed schema validation.", candidate, settings);
    } catch (error) {
      logSchemaValidationError(schema, error instanceof Error ? error.message : "Structured response JSON parse failed.", candidate, settings);
    }
  }
  return undefined;
}

function buildPlanPrompt(taskContext: Task[], availabilityBlocks: AvailabilityBlock[], language: UserSettings["language"]) {
  return `${baseStructuredPrompt(taskContext, availabilityBlocks, language)}
Mode: plan_day.
Return one valid JSON object only:
{
  "userMessage": "${copy(language).planUserMessage}",
  "plan": [
    { "time": "09:00", "title": "Focused work", "description": "Work on the most important task." }
  ],
  "action": {
    "type": "schedule_tasks",
    "mode": "plan_day",
    "changes": [
      { "taskId": "existing-task-id", "scheduledAt": "2026-05-22T09:00", "durationMinutes": 45, "reason": "Fits before unavailable time." }
    ]
  }
}

Rules:
- Schedule only eligible active tasks listed as eligible below.
- Eligible means unscheduled, overdue, or missed. Never move completed tasks or future scheduled tasks.
- Use each task duration when present. If missing, choose 30 minutes.
- Avoid overlaps and unavailable blocks.
- Use 3 to 8 plan blocks.
- If you cannot place a task safely, omit it from action.changes and explain briefly in the plan.
- Keep titles and descriptions practical. No motivational filler.
- Do not create tasks or claim anything was saved. The app applies changes only after confirmation.`;
}

function buildReplanPrompt(taskContext: Task[], availabilityBlocks: AvailabilityBlock[], language: UserSettings["language"]) {
  return `${baseStructuredPrompt(taskContext, availabilityBlocks, language)}
Mode: replan_tasks.
Return the same schema as plan_day, but action.mode must be "replan_tasks".

Rules:
- Schedule only overdue or missed active tasks listed as eligible below.
- Never move completed tasks or future scheduled tasks.
- Avoid overlaps and unavailable blocks.
- Preserve duration when available. If missing, choose 30 minutes.
- Do not claim anything was saved. The app applies changes only after confirmation.`;
}

function buildCreateTasksPrompt(taskContext: Task[], language: UserSettings["language"]) {
  return `${baseStructuredPrompt(taskContext, [], language)}
Mode: create_tasks.
Extract tasks from the user's description. Return one valid JSON object only:
{
  "userMessage": "${copy(language).createTasksUserMessage}",
  "action": {
    "type": "create_tasks",
    "tasks": [
      {
        "title": "Wash clothes",
        "description": "",
        "scheduledAt": "2026-05-16T18:30",
        "durationMinutes": 30,
        "reminderMinutes": 10,
        "repeat": {
          "enabled": false,
          "type": "daily",
          "interval": 1,
          "unit": "day",
          "weekdays": [],
          "excludedWeekdays": []
        },
        "projectName": "Personal",
        "tags": []
      }
    ]
  }
}

Rules:
- action.type must be "create_tasks".
- scheduledAt may be null, "YYYY-MM-DD", or "YYYY-MM-DDTHH:mm".
- durationMinutes must be null or a positive integer when the user gives an estimate.
- reminderMinutes must be null, 0, 5, 10, 30, or 60. Use it only when the user mentions a reminder.
- repeat is optional. Use it only when the user explicitly mentions recurrence.
- For weekdays use 0=Sunday, 1=Monday, 2=Tuesday, 3=Wednesday, 4=Thursday, 5=Friday, 6=Saturday.
- For every weekday use weekdays [1,2,3,4,5]. For weekend use [0,6]. For every day except Sunday use type daily and excludedWeekdays [0].
- Use exact hours and minutes when the user gives a time.
- If the user says tomorrow, resolve from current date ${getTodayISO()}.
- Do not infer private details, categories, deadlines, or durations that the user did not provide.
- Do not claim tasks were created. The app creates them after user confirmation.`;
}

function buildManageTasksPrompt(taskContext: Task[], projectContext: Project[], language: UserSettings["language"]) {
  const projectSummary = projectContext
    .slice(0, 30)
    .map((project) => `- id=${project.id} | ${project.name}`)
    .join("\n");

  return `${baseStructuredPrompt(taskContext, [], language)}
Mode: manage_tasks.
The user wants to manage existing tasks. Return one valid JSON object only.
When a safe mutation is possible:
{
  "userMessage": "${language === "ru" ? "\u041f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f \u043f\u0435\u0440\u0435\u0434 \u043f\u0440\u0438\u043c\u0435\u043d\u0435\u043d\u0438\u0435\u043c." : "Review these changes before applying them."}",
  "action": {
    "type": "manage_tasks",
    "operations": [
      {
        "operation": "update",
        "taskId": "existing-task-id",
        "changes": {
          "title": "New title",
          "description": "New description",
          "scheduledAt": "2026-05-28T18:00",
          "durationMinutes": 45,
          "reminderMinutes": 10,
          "projectId": "existing-project-id"
        },
        "reason": "The user asked to reschedule it."
      },
      {
        "operation": "set_status",
        "taskId": "existing-task-id",
        "status": "completed",
        "reason": "The user asked to mark it done."
      },
      {
        "operation": "delete",
        "taskId": "existing-task-id",
        "reason": "The user asked to delete it."
      }
    ]
  }
}

When the request is ambiguous, unsupported, has no effect, or refers to a missing/deleted task, return:
{
  "userMessage": "${language === "ru" ? "\u0423\u0442\u043e\u0447\u043d\u0438\u0442\u0435, \u043a\u0430\u043a\u0443\u044e \u0438\u043c\u0435\u043d\u043d\u043e \u0437\u0430\u0434\u0430\u0447\u0443 \u0432\u044b \u0438\u043c\u0435\u0435\u0442\u0435 \u0432 \u0432\u0438\u0434\u0443." : "Please clarify which exact task you mean."}",
  "action": null
}

Allowed update fields:
- title, description, scheduledAt, durationMinutes, reminderMinutes, projectId.
- scheduledAt may be null, "YYYY-MM-DD", or "YYYY-MM-DDTHH:mm".
- durationMinutes may be null or a positive integer.
- reminderMinutes may be null, 0, 5, 10, 30, or 60.
- projectId must be one of the existing project IDs below. Do not create, rename, or delete categories/projects.

Rules:
- Use only task IDs from Current tasks. Never invent IDs and never use a title in taskId.
- If multiple listed tasks could match the user's words, do not guess. Ask which task they mean and set action to null.
- If the task already has the requested value/status, explain briefly and set action to null.
- Delete is allowed only for an existing listed task and still requires app confirmation.
- Do not create tasks, plan a day, change settings, edit providers, edit API keys, change notifications, navigate the app, or alter onboarding/system behavior.
- Recurrence, subtasks, tags, deadlines, provider/model settings, and category architecture changes are not supported in this mode.
- If the user says tomorrow, Friday, or another relative date, resolve from current date ${getTodayISO()}.
- Do not claim anything was saved. The app applies changes only after user confirmation.

Existing projects:
${projectSummary || "No projects."}`;
}

function buildBreakdownPrompt(task: Task, language: UserSettings["language"]) {
  return `You are Aevum inside a desktop task app.
${languageInstruction(language)}
Return one valid JSON object only:
{
  "userMessage": "${copy(language).subtasksUserMessage}",
  "subtasks": ["First concrete step", "Second concrete step"]
}

Rules:
- Generate 3 to 7 concrete subtasks.
- Subtasks must be short action phrases.
- Use only information from the task. Do not invent external requirements.
- Do not claim subtasks were saved.

Task title: ${task.title}
Task description: ${task.description || "No description."}`;
}

function baseStructuredPrompt(taskContext: Task[], availabilityBlocks: AvailabilityBlock[], language: UserSettings["language"]) {
  const taskSummary = taskContext
    .slice(0, 50)
    .map((task) => `- id=${task.id} | title=${task.title} | description=${task.description ? task.description.slice(0, 120) : "none"} | status=${task.status} | projectId=${task.projectId} | scheduledAt=${task.scheduledAt ?? "none"} | duration=${task.durationMinutes ?? "none"} | reminder=${task.reminderMinutes ?? "default"} | repeat=${task.repeat.enabled ? "yes" : "no"} | eligible=${isEligibleForPlan(task, "plan_day") ? "yes" : "no"} | replanEligible=${isEligibleForPlan(task, "replan_tasks") ? "yes" : "no"}`)
    .join("\n");
  const availabilitySummary = availabilityBlocks
    .map((block) => `- ${block.label}: weekdays=${block.weekdays.join(",")} ${block.startTime}-${block.endTime}`)
    .join("\n");

  return `You are Aevum, a practical desktop productivity assistant.
Current date: ${getTodayISO()}.
${languageInstruction(language)}
Follow the selected mode strictly. Keep wording concise and useful. Ask for clarification only when the request cannot be completed safely.
Never return markdown fences. Never show raw JSON to the user. Never invent that app state changed.
Only return structured data for the internal action schema requested by the system.
Current tasks:
${taskSummary || "No tasks yet."}
Unavailable weekly blocks:
${availabilitySummary || "No unavailable blocks."}`;
}

async function fetchWithProviderErrors(endpoint: string, init: RequestInit, settings: UserSettings) {
  try {
    return await fetch(endpoint, init);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    const isLocalOllama = endpoint.startsWith("http://localhost") || endpoint.startsWith("http://127.0.0.1");
    const isCorsLike = !isLocalOllama && (message.toLowerCase().includes("cors") || message.toLowerCase().includes("failed to fetch"));
    const aiError = new AIProviderError(
      isCorsLike
        ? "Ollama blocked the request. Add this app origin to OLLAMA_ORIGINS and restart Ollama."
        : "Ollama is not running. Start Ollama and try again.",
      isCorsLike ? "cors_blocked" : "ollama_not_running",
      {
        provider: settings.aiProvider,
        baseUrl: settings.aiBaseUrl,
        model: settings.localModel,
        endpoint,
        error: message,
      },
    );
    logAIError(aiError);
    throw aiError;
  }
}

function validateCreateTasksAction(value: unknown): { userMessage: string; action: CreateTasksAction } | undefined {
  if (!isRecord(value)) return undefined;
  const userMessage = readUserMessage(value) || "Review these tasks before creating them.";
  if (!isTaskDraftTextSafe(userMessage)) return undefined;
  const action = isRecord(value.action) ? value.action : value;
  if (action.type !== "create_tasks" || !Array.isArray(action.tasks)) return undefined;
  const tasks = action.tasks.map(readTaskDraft).filter((task): task is AITaskDraft => Boolean(task));
  return tasks.length > 0 ? { userMessage, action: { type: "create_tasks", tasks } } : undefined;
}

function validatePlanDayResult(
  value: unknown,
  taskContext: Task[],
  availabilityBlocks: AvailabilityBlock[],
  mode: "plan_day" | "replan_tasks" = "plan_day",
  language: UserSettings["language"] = "en",
): PlanDayResult | undefined {
  if (!isRecord(value)) return undefined;
  const planSource = Array.isArray(value.plan) ? value.plan : Array.isArray(value.blocks) ? value.blocks : Array.isArray(value.schedule) ? value.schedule : undefined;
  if (!planSource) return undefined;
  const plan = planSource.map(readPlanBlock).filter((block): block is PlanBlock => Boolean(block)).slice(0, 8);
  if (plan.length === 0) return undefined;
  const userMessage = readUserMessage(value) || copy(language).planUserMessage;
  if (!isTextQualitySafe(userMessage, language)) return undefined;
  if (!plan.every((block) => isTextQualitySafe(block.title, language) && (!block.description || isTextQualitySafe(block.description, language)))) return undefined;
  const action = readScheduleAction(value.action, taskContext, availabilityBlocks, mode);
  return {
    userMessage,
    plan,
    action,
  };
}

function validateManageTasksResult(
  value: unknown,
  taskContext: Task[],
  projectContext: Project[],
  language: UserSettings["language"],
): ManageTasksResult | undefined {
  if (!isRecord(value)) return undefined;
  const userMessage = readUserMessage(value) || manageReviewMessage(language);
  if (!isTextQualitySafe(userMessage, language)) return undefined;

  if (value.action === null || value.action === undefined) {
    return { userMessage };
  }

  const actionSource = isRecord(value.action) ? value.action : value.type === "manage_tasks" ? value : undefined;
  if (!actionSource) return { userMessage };

  const action = readManageTasksAction(actionSource, taskContext, projectContext);
  if (!action) {
    return { userMessage: manageNoSafeChangeMessage(language) };
  }

  return { userMessage, action };
}

function validateSubtasksResult(value: unknown): SubtasksResult | undefined {
  if (!isRecord(value)) return undefined;
  const rawSubtasks = Array.isArray(value.subtasks) ? value.subtasks : Array.isArray(value.tasks) ? value.tasks : undefined;
  if (!rawSubtasks) return undefined;
  const subtasks = rawSubtasks
    .map(readSubtaskTitle)
    .filter(isTaskDraftTextSafe)
    .filter((title): title is string => Boolean(title))
    .slice(0, 7);
  const userMessage = readUserMessage(value) || "Here is a smaller checklist.";
  return subtasks.length >= 3 && isTaskDraftTextSafe(userMessage)
    ? { userMessage, subtasks }
    : undefined;
}

function readTaskDraft(value: unknown): AITaskDraft | undefined {
  if (!isRecord(value) || typeof value.title !== "string" || value.title.trim().length === 0) return undefined;
  if (!isTaskDraftTextSafe(value.title)) return undefined;
  if (typeof value.description === "string" && value.description.trim() && !isTaskDraftTextSafe(value.description)) return undefined;
  const scheduleValue = readScheduleValue(value);
  const scheduledAt = normalizeScheduledAt(scheduleValue);
  if (scheduledAt && !isReasonableScheduleDate(scheduledAt)) return undefined;

  let categoryTarget: AICategoryTarget | undefined;
  if (isRecord(value.categoryTarget)) {
    const kind = value.categoryTarget.kind;
    if (kind === "existing" && typeof value.categoryTarget.categoryId === "string") {
      categoryTarget = { kind: "existing", categoryId: value.categoryTarget.categoryId };
    } else if (kind === "new" && typeof value.categoryTarget.ref === "string") {
      categoryTarget = { kind: "new", ref: value.categoryTarget.ref };
    }
  }

  return {
    title: value.title.trim(),
    description: typeof value.description === "string" ? value.description.trim() : "",
    scheduledAt,
    durationMinutes: readDurationMinutes(value.durationMinutes),
    reminderMinutes: readReminderMinutes(value.reminderMinutes),
    repeat: isRecord(value.repeat) ? normalizeRepeat(value.repeat) : { ...defaultRepeat },
    projectName: typeof value.projectName === "string" && value.projectName.trim() ? value.projectName.trim() : undefined,
    categoryTarget,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean) : [],
  };
}

function readManageTasksAction(value: unknown, tasks: Task[], projects: Project[]): ManageTasksAction | undefined {
  if (!isRecord(value) || value.type !== "manage_tasks" || !Array.isArray(value.operations)) return undefined;
  const operations: ManageTaskOperation[] = [];
  const deletedTaskIds = new Set<string>();

  for (const rawOperation of value.operations.slice(0, 8)) {
    const operation = readManageTaskOperation(rawOperation, tasks, projects);
    if (!operation) continue;
    if (operation.operation === "delete") {
      deletedTaskIds.add(operation.taskId);
      for (let index = operations.length - 1; index >= 0; index -= 1) {
        if (operations[index].taskId === operation.taskId) operations.splice(index, 1);
      }
      operations.push(operation);
      continue;
    }
    if (deletedTaskIds.has(operation.taskId)) continue;
    operations.push(operation);
  }

  return operations.length ? { type: "manage_tasks", operations } : undefined;
}

function readManageTaskOperation(value: unknown, tasks: Task[], projects: Project[]): ManageTaskOperation | undefined {
  if (!isRecord(value) || typeof value.taskId !== "string") return undefined;
  const task = tasks.find((item) => item.id === value.taskId);
  if (!task) return undefined;
  const reason = typeof value.reason === "string" && isTaskDraftTextSafe(value.reason) ? value.reason.trim() : undefined;

  if (value.operation === "delete") {
    return { operation: "delete", taskId: task.id, reason };
  }

  if (value.operation === "set_status") {
    if (value.status !== "active" && value.status !== "completed") return undefined;
    if (task.status === value.status) return undefined;
    return { operation: "set_status", taskId: task.id, status: value.status, reason };
  }

  if (value.operation === "update") {
    const changes = readManageTaskChanges(value.changes, task, projects);
    if (!changes) return undefined;
    return { operation: "update", taskId: task.id, changes, reason };
  }

  return undefined;
}

function readManageTaskChanges(value: unknown, task: Task, projects: Project[]): ManageTaskChanges | undefined {
  if (!isRecord(value)) return undefined;
  const changes: ManageTaskChanges = {};

  if ("title" in value) {
    if (typeof value.title !== "string" || !isTaskDraftTextSafe(value.title)) return undefined;
    const title = value.title.trim();
    if (title && title !== task.title) changes.title = title;
  }

  if ("description" in value) {
    if (typeof value.description !== "string") return undefined;
    const description = value.description.trim();
    if (description !== task.description) changes.description = description;
  }

  if ("scheduledAt" in value) {
    if (typeof value.scheduledAt !== "string" && value.scheduledAt !== null) return undefined;
    const scheduledAt = normalizeScheduledAt(value.scheduledAt);
    if (scheduledAt && !isReasonableScheduleDate(scheduledAt)) return undefined;
    if (scheduledAt !== task.scheduledAt) changes.scheduledAt = scheduledAt;
  }

  if ("durationMinutes" in value) {
    if (value.durationMinutes !== null && typeof value.durationMinutes !== "number") return undefined;
    const durationMinutes = value.durationMinutes === null ? null : readDurationMinutes(value.durationMinutes);
    if (value.durationMinutes !== null && durationMinutes === null) return undefined;
    if (durationMinutes !== task.durationMinutes) changes.durationMinutes = durationMinutes;
  }

  if ("reminderMinutes" in value) {
    const reminderMinutes = value.reminderMinutes === null ? null : readReminderMinutes(value.reminderMinutes);
    if (value.reminderMinutes !== null && reminderMinutes === null) return undefined;
    if (reminderMinutes !== task.reminderMinutes) changes.reminderMinutes = reminderMinutes;
  }

  if ("projectId" in value) {
    if (typeof value.projectId !== "string") return undefined;
    const project = projects.find((item) => item.id === value.projectId);
    if (!project) return undefined;
    if (project.id !== task.projectId) changes.projectId = project.id;
  }

  return Object.keys(changes).length ? changes : undefined;
}

function readScheduleAction(value: unknown, tasks: Task[], availabilityBlocks: AvailabilityBlock[], mode: "plan_day" | "replan_tasks"): ScheduleTasksAction | undefined {
  if (!isRecord(value) || value.type !== "schedule_tasks" || !Array.isArray(value.changes)) return undefined;
  const changes = value.changes
    .map((change) => readScheduleChange(change, tasks, mode))
    .filter((change): change is ScheduleChangeDraft => Boolean(change));
  const validated = removeInvalidScheduleChanges(changes, tasks, availabilityBlocks);
  return validated.length ? { type: "schedule_tasks", mode, changes: validated } : undefined;
}

function readScheduleChange(value: unknown, tasks: Task[], mode: "plan_day" | "replan_tasks"): ScheduleChangeDraft | undefined {
  if (!isRecord(value) || typeof value.taskId !== "string") return undefined;
  const task = tasks.find((item) => item.id === value.taskId);
  if (!task || !isEligibleForPlan(task, mode)) return undefined;
  const scheduledAt = normalizeScheduledAt(typeof value.scheduledAt === "string" ? value.scheduledAt : null);
  if (!scheduledAt || !getScheduleTime(scheduledAt)) return undefined;
  if (!isReasonableScheduleDate(scheduledAt)) return undefined;
  return {
    taskId: task.id,
    scheduledAt,
    durationMinutes: readDurationMinutes(value.durationMinutes) ?? task.durationMinutes ?? 30,
    reason: typeof value.reason === "string" ? value.reason.trim() : "",
  };
}

function removeInvalidScheduleChanges(changes: ScheduleChangeDraft[], tasks: Task[], availabilityBlocks: AvailabilityBlock[]) {
  const accepted: ScheduleChangeDraft[] = [];
  for (const change of changes) {
    const task = tasks.find((item) => item.id === change.taskId);
    if (!task || task.status === "completed") continue;
    const duration = change.durationMinutes ?? task.durationMinutes ?? 30;
    if (duration <= 0) continue;
    const candidate = { ...change, durationMinutes: duration };
    if (isUnavailable(candidate, availabilityBlocks)) continue;
    if (accepted.some((existing) => rangesOverlap(existing.scheduledAt, existing.durationMinutes ?? 30, candidate.scheduledAt, duration))) continue;
    if (tasks.some((existing) => existing.id !== task.id && existing.status === "active" && getScheduleTime(existing.scheduledAt) && rangesOverlap(existing.scheduledAt, existing.durationMinutes ?? 30, candidate.scheduledAt, duration))) continue;
    accepted.push(candidate);
  }
  return accepted;
}

function isUnavailable(change: ScheduleChangeDraft, availabilityBlocks: AvailabilityBlock[]) {
  const start = new Date(`${getScheduleDate(change.scheduledAt)}T${getScheduleTime(change.scheduledAt)}:00`);
  const weekday = start.getDay();
  const startMinutes = toMinutes(getScheduleTime(change.scheduledAt));
  const endMinutes = startMinutes + (change.durationMinutes ?? 30);
  return availabilityBlocks.some((block) => block.weekdays.includes(weekday) && rangesOverlapMinutes(startMinutes, endMinutes, toMinutes(block.startTime), toMinutes(block.endTime)));
}

function rangesOverlap(aStart: string | null | undefined, aDuration: number, bStart: string, bDuration: number) {
  if (!aStart || getScheduleDate(aStart) !== getScheduleDate(bStart) || !getScheduleTime(aStart)) return false;
  const a = toMinutes(getScheduleTime(aStart));
  const b = toMinutes(getScheduleTime(bStart));
  return rangesOverlapMinutes(a, a + aDuration, b, b + bDuration);
}

function rangesOverlapMinutes(aStart: number, aEnd: number, bStart: number, bEnd: number) {
  return aStart < bEnd && bStart < aEnd;
}

function toMinutes(value: string) {
  const [hours, minutes] = value.split(":").map(Number);
  return (hours || 0) * 60 + (minutes || 0);
}

function readPlanBlock(value: unknown): PlanBlock | undefined {
  if (typeof value === "string" && value.trim()) return { title: value.trim() };
  if (!isRecord(value)) return undefined;
  const titleValue = value.title ?? value.task ?? value.label;
  if (typeof titleValue !== "string" || !titleValue.trim()) return undefined;
  return {
    time: typeof value.time === "string" && value.time.trim() ? value.time.trim() : undefined,
    title: titleValue.trim(),
    description: typeof value.description === "string" && value.description.trim() ? value.description.trim() : undefined,
  };
}

function readSubtaskTitle(value: unknown) {
  if (typeof value === "string") return value.trim() || undefined;
  if (!isRecord(value)) return undefined;
  const titleValue = value.title ?? value.task ?? value.name;
  return typeof titleValue === "string" && titleValue.trim() ? titleValue.trim() : undefined;
}

function readScheduleValue(value: Record<string, unknown>) {
  const direct = value.scheduledAt ?? value.dueAt ?? value.deadline;
  if (typeof direct === "string" || direct === null) return direct;

  const date = typeof value.date === "string" ? value.date : "";
  const time = typeof value.time === "string" ? value.time : "";
  if (!date) return null;
  return time ? `${date}T${time}` : date;
}

function renderPlanMessage(plan: PlanDayResult, language: UserSettings["language"]) {
  const items = plan.plan.map((item) => {
    const prefix = item.time ? `${item.time} ` : "";
    const description = item.description ? `: ${item.description}` : "";
    return `${prefix}${item.title}${description}`;
  });
  return [sanitizeAssistantText(plan.userMessage, copy(language).planUserMessage), ...items.map((item) => `- ${item}`)].join("\n");
}

function renderCreateTasksMessage(count: number, language: UserSettings["language"]) {
  if (language === "ru") {
    return count === 1
      ? "\u042f \u043d\u0430\u0448\u0435\u043b 1 \u0437\u0430\u0434\u0430\u0447\u0443. \u041f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u0435\u0435 \u043f\u0435\u0440\u0435\u0434 \u0441\u043e\u0437\u0434\u0430\u043d\u0438\u0435\u043c."
      : `\u042f \u043d\u0430\u0448\u0435\u043b ${count} \u0437\u0430\u0434\u0430\u0447. \u041f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u0438\u0445 \u043f\u0435\u0440\u0435\u0434 \u0441\u043e\u0437\u0434\u0430\u043d\u0438\u0435\u043c.`;
  }
  return count === 1 ? "I found 1 task. Review it before creating it." : `I found ${count} tasks. Review them before creating them.`;
}

function renderManageTasksMessage(result: ManageTasksResult, language: UserSettings["language"]) {
  if (!result.action) return sanitizeAssistantText(result.userMessage, manageNoSafeChangeMessage(language));
  return sanitizeAssistantText(result.userMessage, manageReviewMessage(language));
}

function manageReviewMessage(language: UserSettings["language"]) {
  return language === "ru"
    ? "\u041f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u044f \u043f\u0435\u0440\u0435\u0434 \u043f\u0440\u0438\u043c\u0435\u043d\u0435\u043d\u0438\u0435\u043c."
    : "Review these changes before applying them.";
}

function manageNoSafeChangeMessage(language: UserSettings["language"]) {
  return language === "ru"
    ? "\u042f \u043d\u0435 \u043d\u0430\u0448\u0435\u043b \u0431\u0435\u0437\u043e\u043f\u0430\u0441\u043d\u043e\u0435 \u0438 \u043e\u0434\u043d\u043e\u0437\u043d\u0430\u0447\u043d\u043e\u0435 \u0438\u0437\u043c\u0435\u043d\u0435\u043d\u0438\u0435. \u0423\u0442\u043e\u0447\u043d\u0438\u0442\u0435 \u0437\u0430\u0434\u0430\u0447\u0443 \u0438 \u043d\u0443\u0436\u043d\u043e\u0435 \u0434\u0435\u0439\u0441\u0442\u0432\u0438\u0435."
    : "I could not find a safe, unambiguous task change. Please clarify the task and the change you want.";
}

function sanitizeAssistantText(value: string, fallback: string) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.includes("{") || trimmed.includes("}") || trimmed.includes("[") || trimmed.includes("]")) return fallback;
  if (hasCjkCharacters(trimmed)) return fallback;
  return trimmed.length > taskDraftMaxLength ? `${trimmed.slice(0, taskDraftMaxLength - 3).trim()}...` : trimmed;
}

function sanitizeGuideText(value: string, fallback: string) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (hasCjkCharacters(trimmed)) return fallback;
  return trimmed.length > guideMaxLength ? `${trimmed.slice(0, guideMaxLength - 3).trim()}...` : trimmed;
}

function isGuideTextSafe(value: string, language: UserSettings["language"]) {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text || text.length > guideMaxLength + 200) return false;
  if (hasCjkCharacters(text)) return false;
  if (/[\uFFFD]/u.test(text)) return false;
  if (/(.)\1{9,}/u.test(text)) return false;
  if (/[!?.,:;]{7,}/u.test(text)) return false;
  const lower = text.toLowerCase();
  if (lower === "undefined" || lower === "null") return false;
  const cyrillic = (text.match(/[\u0410-\u044F\u0401\u0451]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const alphabetic = cyrillic + latin;
  if (alphabetic < 8) return true;
  if (language === "ru") return cyrillic >= latin || cyrillic / alphabetic >= 0.35;
  return latin >= cyrillic || latin / alphabetic >= 0.65;
}

function sanitizeModelArtifacts(raw: string): string {
  let text = raw;
  // Remove <think>...</think>, <thought>...</thought>, <analysis>...</analysis> blocks
  text = text.replace(/<(?:think|thought|analysis)>[\s\S]*?<\/(?:think|thought|analysis)>/gi, "");
  // Remove unclosed <think>, <thought>, <analysis> blocks (model stopped mid-reasoning)
  text = text.replace(/<(?:think|thought|analysis)>[\s\S]*/gi, "");
  // Remove control tokens from common model families
  text = text.replace(/<\|(?:im_start|im_end|endoftext|end|pad|begin_of_text|end_of_text|eot_id|start_header_id|end_header_id)[^>]*\|>/gi, "");
  // Remove markdown JSON code fences wrapping the entire response
  text = text.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "");
  return text.trim();
}

function guideFallback(language: UserSettings["language"]) {
  return language === "ru"
    ? "\u042f \u043c\u043e\u0433\u0443 \u043f\u043e\u043c\u043e\u0447\u044c \u0441 \u043d\u0430\u0432\u0438\u0433\u0430\u0446\u0438\u0435\u0439 \u043f\u043e Aevum \u0438 \u043e\u0431\u044a\u044f\u0441\u043d\u0438\u0442\u044c \u0444\u0443\u043d\u043a\u0446\u0438\u0438 \u043f\u0440\u0438\u043b\u043e\u0436\u0435\u043d\u0438\u044f."
    : "I can help with Aevum navigation and explain how the app works.";
}

function retryWithAnotherModelMessage(language: UserSettings["language"]) {
  return language === "ru"
    ? "\u041e\u0442\u0432\u0435\u0442 \u043c\u043e\u0434\u0435\u043b\u0438 \u0432\u044b\u0433\u043b\u044f\u0434\u0435\u043b \u043d\u0435\u043a\u043e\u0440\u0440\u0435\u043a\u0442\u043d\u043e. \u041f\u043e\u043f\u0440\u043e\u0431\u0443\u0439\u0442\u0435 \u0435\u0449\u0435 \u0440\u0430\u0437 \u0438\u043b\u0438 \u0432\u044b\u0431\u0435\u0440\u0438\u0442\u0435 \u0434\u0440\u0443\u0433\u0443\u044e AI-\u043c\u043e\u0434\u0435\u043b\u044c \u0432 \u043d\u0430\u0441\u0442\u0440\u043e\u0439\u043a\u0430\u0445."
    : "The model response looked unusable. Try again or choose another AI model in settings.";
}

function isTextQualitySafe(value: string, language: UserSettings["language"]) {
  if (!isTaskDraftTextSafe(value)) return false;
  const text = value.trim();
  const cyrillic = (text.match(/[А-Яа-яЁё]/g) ?? []).length;
  const latin = (text.match(/[A-Za-z]/g) ?? []).length;
  const alphabetic = cyrillic + latin;
  if (alphabetic < 8) return true;
  if (language === "ru") return cyrillic >= latin || cyrillic / alphabetic >= 0.35;
  return latin >= cyrillic || latin / alphabetic >= 0.65;
}

function isTaskDraftTextSafe(value: unknown): value is string {
  if (typeof value !== "string") return false;
  const text = value.trim();
  if (!text || text.length > taskDraftMaxLength) return false;
  if (/[{}\[\]]/.test(text)) return false;
  if (hasCjkCharacters(text)) return false;
  if (/[�]/u.test(text)) return false;
  if (/[\u00C2\u00D0\u00D1][\u0080-\u00BF]/u.test(text)) return false;
  if (/(.)\1{9,}/u.test(text)) return false;
  if (/[!?.,:;]{7,}/u.test(text)) return false;
  const lower = text.toLowerCase();
  if (lower === "undefined" || lower === "null") return false;
  const knownBadPatterns = [
    /понедеть/u,
    /заботиться\s+о\s+игре/u,
    /план\s+на\s+день\s+план\s+на\s+день\s+план/u,
  ];
  if (knownBadPatterns.some((pattern) => pattern.test(lower))) return false;
  const words = lower.match(/[a-zа-яё]{3,}/gu) ?? [];
  if (words.length >= 6) {
    const unique = new Set(words);
    if (unique.size <= Math.ceil(words.length / 4)) return false;
  }
  return true;
}

function isReasonableScheduleDate(value: string) {
  const scheduleDate = getScheduleDate(value);
  if (!scheduleDate) return false;
  const date = new Date(`${scheduleDate}T12:00:00`);
  if (Number.isNaN(date.getTime())) return false;
  const currentYear = new Date().getFullYear();
  const year = date.getFullYear();
  return year >= currentYear - 1 && year <= currentYear + 10;
}

function readDurationMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  const minutes = Math.floor(value);
  return minutes <= dayMinutes ? minutes : null;
}

function readReminderMinutes(value: unknown): ReminderOffsetMinutes | null {
  return value === 0 || value === 5 || value === 10 || value === 30 || value === 60 ? value : null;
}

function isEligibleForPlan(task: Task, mode: "plan_day" | "replan_tasks") {
  if (task.status === "completed") return false;
  const scheduledDate = getScheduleDate(task.scheduledAt);
  const hasTime = Boolean(getScheduleTime(task.scheduledAt));
  const today = getTodayISO();
  const missedToday = scheduledDate === today && hasTime && toMinutes(getScheduleTime(task.scheduledAt)) < getCurrentMinutes();
  if (mode === "replan_tasks") return Boolean((scheduledDate && scheduledDate < today) || missedToday);
  return !scheduledDate || !hasTime || scheduledDate < today || missedToday;
}

function getCurrentMinutes(date = new Date()) {
  return date.getHours() * 60 + date.getMinutes();
}

function readOllamaMessage(payload: unknown) {
  if (
    typeof payload === "object" &&
    payload !== null &&
    "message" in payload &&
    typeof payload.message === "object" &&
    payload.message !== null &&
    "content" in payload.message &&
    typeof payload.message.content === "string"
  ) {
    return payload.message.content.trim();
  }

  throw new AIProviderError("The AI provider returned an unexpected response.", "unexpected_response");
}

function readOllamaActualModel(payload: unknown) {
  return isRecord(payload) && typeof payload.model === "string" && payload.model.trim() ? payload.model.trim() : null;
}

function readOllamaModels(payload: unknown): AIModelInfo[] {
  if (isRecord(payload) && Array.isArray(payload.models)) {
    return payload.models
      .filter((model): model is { name: string; modified_at?: string } => {
        return isRecord(model) && typeof model.name === "string";
      })
      .map((model) => ({ name: model.name, modifiedAt: model.modified_at }));
  }

  throw new AIProviderError("The AI provider returned an unexpected response.", "unexpected_response");
}

function extractJsonCandidates(content: string) {
  const sanitized = sanitizeModelArtifacts(content);
  const trimmed = stripCodeFence(sanitized.trim());
  const candidates = new Set<string>();
  if (trimmed.startsWith("{") && trimmed.endsWith("}")) candidates.add(trimmed);

  const balanced = extractBalancedObjects(trimmed);
  balanced.forEach((candidate) => candidates.add(stripCodeFence(candidate)));
  return [...candidates];
}

function extractBalancedObjects(content: string) {
  const results: string[] = [];
  let start = -1;
  let depth = 0;
  let inString = false;
  let escaped = false;

  for (let index = 0; index < content.length; index += 1) {
    const char = content[index];
    if (escaped) {
      escaped = false;
      continue;
    }
    if (char === "\\") {
      escaped = true;
      continue;
    }
    if (char === "\"") {
      inString = !inString;
      continue;
    }
    if (inString) continue;
    if (char === "{") {
      if (depth === 0) start = index;
      depth += 1;
    }
    if (char === "}") {
      depth -= 1;
      if (depth === 0 && start >= 0) {
        results.push(content.slice(start, index + 1));
        start = -1;
      }
    }
  }

  return results;
}

function stripCodeFence(value: string) {
  return value.replace(/^```(?:json)?\s*/i, "").replace(/\s*```$/i, "").trim();
}

function readUserMessage(value: Record<string, unknown>) {
  if (typeof value.userMessage === "string" && value.userMessage.trim()) return value.userMessage.trim();
  if (typeof value.message === "string" && value.message.trim()) return value.message.trim();
  return "";
}

async function readResponseText(response: Response) {
  try {
    return await response.text();
  } catch {
    return "";
  }
}

function createAssistantMessage(content: string, metadata?: AssistantMessage["metadata"]): AssistantMessage {
  return {
    id: `message-${Date.now()}-assistant`,
    role: "assistant",
    content,
    createdAt: new Date().toISOString(),
    metadata,
  };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function normalizeBaseUrl(baseUrl: string) {
  return baseUrl.replace(/\/+$/, "");
}

function modelMatches(installedModel: string, selectedModel: string) {
  return installedModel === selectedModel || installedModel.replace(/:latest$/, "") === selectedModel || selectedModel.replace(/:latest$/, "") === installedModel;
}

function isLanguageSafeStructured(value: unknown, schema: StructuredSchema, _language: UserSettings["language"]) {
  if (hasCjkCharacters(JSON.stringify(value))) return false;
  if ((schema === "plan_day" || schema === "replan_tasks" || schema === "create_tasks" || schema === "manage_tasks") && isRecord(value)) {
    return typeof value.userMessage !== "string" || isTaskDraftTextSafe(value.userMessage);
  }
  return true;
}

function hasCjkCharacters(value: string) {
  return /[\u3040-\u30ff\u3400-\u9fff\uf900-\ufaff]/u.test(value);
}

function languageInstruction(language: UserSettings["language"]) {
  if (language === "ru") {
    return [
      "Response language: Russian only.",
      "All user-facing strings inside JSON must be Russian.",
      "Do not answer in English, Chinese, Japanese, or any other language unless the user explicitly asks to translate text.",
    ].join("\n");
  }

  return [
    "Response language: English only.",
    "All user-facing strings inside JSON must be English.",
    "Do not answer in Russian, Chinese, Japanese, or any other language unless the user explicitly asks to translate text.",
  ].join("\n");
}

function copy(language: UserSettings["language"]) {
  if (language === "ru") {
    return {
      planUserMessage: "\u0412\u043e\u0442 \u043f\u0440\u0430\u043a\u0442\u0438\u0447\u043d\u044b\u0439 \u043f\u043b\u0430\u043d \u043d\u0430 \u0434\u0435\u043d\u044c.",
      createTasksUserMessage: "\u042f \u043d\u0430\u0448\u0435\u043b \u0437\u0430\u0434\u0430\u0447\u0438. \u041f\u0440\u043e\u0432\u0435\u0440\u044c\u0442\u0435 \u0438\u0445 \u043f\u0435\u0440\u0435\u0434 \u0441\u043e\u0437\u0434\u0430\u043d\u0438\u0435\u043c.",
      subtasksUserMessage: "\u0412\u043e\u0442 \u043a\u043e\u0440\u043e\u0442\u043a\u0438\u0439 \u0441\u043f\u0438\u0441\u043e\u043a \u043f\u043e\u0434\u0437\u0430\u0434\u0430\u0447.",
    };
  }
  return {
    planUserMessage: "Here is a practical plan for your day.",
    createTasksUserMessage: "I found tasks. Review them before creating them.",
    subtasksUserMessage: "Here is a smaller checklist.",
  };
}

function logAIDebug(message: string, data: Record<string, string | number | boolean | undefined>) {
  if (import.meta.env.DEV) {
    console.info(`[Aevum] ${message}`, data);
  }
}

function logAIError(error: AIProviderError) {
  if (import.meta.env.DEV) {
    console.error("[Aevum] AI provider error", {
      code: error.code,
      message: error.message,
      ...error.debug,
    });
  }
}

function sanitizeForDevLog(value: string) {
  const sanitized = value
    .replace(/sk-or-v1-[A-Za-z0-9_-]+/g, "sk-or-v1-[redacted]")
    .replace(/\s+/g, " ")
    .trim();
  return sanitized.length > 800 ? `${sanitized.slice(0, 797)}...` : sanitized;
}

function logInvalidAIResponse(rawResponse: string, schema: StructuredSchema | "guide", phase: "initial" | "repair", settings: UserSettings) {
  if (import.meta.env.DEV) {
    console.error("[Aevum] Invalid AI response", {
      provider: settings.aiProvider,
      requestedModel: settings.aiProvider === "openrouter" ? settings.cloudModel : settings.localModel,
      schema,
      phase,
      sanitizedRawAssistantContent: sanitizeForDevLog(rawResponse),
    });
  }
}

function logSchemaValidationError(schema: StructuredSchema, validationError: string, rawAssistantContent: string, settings: UserSettings) {
  if (import.meta.env.DEV) {
    console.error("[Aevum] Schema validation error", {
      provider: settings.aiProvider,
      requestedModel: settings.aiProvider === "openrouter" ? settings.cloudModel : settings.localModel,
      schema,
      validationError,
      sanitizedRawAssistantContent: sanitizeForDevLog(rawAssistantContent),
    });
  }
}

function validateBatchAction(value: unknown, taskContext: Task[], projectContext: Project[]): BatchAction | undefined {
  if (!isRecord(value) || value.type !== "batch_action") return undefined;

  const categoriesToCreate: AICategoryDraft[] = [];
  if (Array.isArray(value.categoriesToCreate)) {
    for (const cat of value.categoriesToCreate) {
      if (!isRecord(cat) || typeof cat.ref !== "string" || typeof cat.name !== "string") return undefined;
      const ref = cat.ref.trim();
      const name = cat.name.trim();
      if (!ref || !name) return undefined;
      categoriesToCreate.push({ ref, name });
    }
  }

  const categoriesToRename: CategoryRenameDraft[] = [];
  if (Array.isArray(value.categoriesToRename)) {
    for (const rename of value.categoriesToRename) {
      if (!isRecord(rename) || typeof rename.categoryId !== "string" || typeof rename.newName !== "string") return undefined;
      const categoryId = rename.categoryId.trim();
      const newName = rename.newName.trim();
      if (!categoryId || !newName) return undefined;
      categoriesToRename.push({ categoryId, newName });
    }
  }

  const tasksToCreate: AITaskDraft[] = [];
  if (Array.isArray(value.tasksToCreate)) {
    for (const draft of value.tasksToCreate) {
      const parsed = readTaskDraft(draft);
      if (!parsed) return undefined;
      tasksToCreate.push(parsed);
    }
  }

  const scheduleChanges: ScheduleChangeDraft[] = [];
  if (Array.isArray(value.scheduleChanges)) {
    for (const change of value.scheduleChanges) {
      const parsed = readScheduleChange(change, taskContext, "plan_day");
      if (!parsed) return undefined;
      scheduleChanges.push(parsed);
    }
  }

  const manageOperations: ManageTaskOperation[] = [];
  if (Array.isArray(value.manageOperations)) {
    for (const op of value.manageOperations) {
      const parsed = readManageTaskOperation(op, taskContext, projectContext);
      if (!parsed) return undefined;
      manageOperations.push(parsed);
    }
  }

  if (
    categoriesToCreate.length === 0 &&
    categoriesToRename.length === 0 &&
    tasksToCreate.length === 0 &&
    scheduleChanges.length === 0 &&
    manageOperations.length === 0
  ) return undefined;

  return {
    type: "batch_action",
    categoriesToCreate: categoriesToCreate.length ? categoriesToCreate : undefined,
    categoriesToRename: categoriesToRename.length ? categoriesToRename : undefined,
    tasksToCreate: tasksToCreate.length ? tasksToCreate : undefined,
    scheduleChanges: scheduleChanges.length ? scheduleChanges : undefined,
    manageOperations: manageOperations.length ? manageOperations : undefined,
  };
}

export function validateFullAgentDecision(
  value: unknown,
  taskContext: Task[],
  projectContext: Project[],
  language: UserSettings["language"],
  availabilityBlocks: AvailabilityBlock[],
): FullAgentDecision | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind !== "answer" && kind !== "clarify" && kind !== "proposal") return undefined;

  const message = readUserMessage(value);
  if (!message || !isTextQualitySafe(message, language)) return undefined;

  if (kind === "answer" || kind === "clarify") {
    return { kind, message };
  }

  // kind === "proposal"
  const proposalSource = isRecord(value.proposal) ? value.proposal : undefined;
  if (!proposalSource) return undefined;

  const proposal = validateBatchAction(proposalSource, taskContext, projectContext);
  if (!proposal) return undefined;

  return {
    kind: "proposal",
    message,
    proposal,
  };
}

function validateAgentDecision(
  value: unknown,
  taskContext: Task[],
  projectContext: Project[],
  language: UserSettings["language"],
  availabilityBlocks: AvailabilityBlock[],
): AgentDecision | undefined {
  if (!isRecord(value)) return undefined;
  const kind = value.kind;
  if (kind !== "answer" && kind !== "clarify" && kind !== "proposal") return undefined;

  const message = readUserMessage(value);
  if (!message || !isTextQualitySafe(message, language)) return undefined;

  if (kind === "answer" || kind === "clarify") {
    return { kind, message };
  }

  // kind === "proposal"
  const actionSource = isRecord(value.action) ? value.action : undefined;
  if (!actionSource) return undefined;

  let action: AssistantAction | undefined;
  if (actionSource.type === "create_tasks") {
    const validated = validateCreateTasksAction(value);
    action = validated?.action;
  } else if (actionSource.type === "schedule_tasks") {
    const validated = validatePlanDayResult(value, taskContext, availabilityBlocks, actionSource.mode === "replan_tasks" ? "replan_tasks" : "plan_day", language);
    action = validated?.action;
  } else if (actionSource.type === "manage_tasks") {
    const validated = validateManageTasksResult(value, taskContext, projectContext, language);
    action = validated?.action;
  } else if (actionSource.type === "batch_action") {
    action = validateBatchAction(actionSource, taskContext, projectContext);
  }

  if (!action) return undefined;

  return {
    kind: "proposal",
    message,
    action,
  };
}

export function getCleanLocalizedErrorMessage(error: unknown, language: UserSettings["language"]): string {
  const isRu = language === "ru";
  if (error instanceof AIProviderError) {
    if (error.code === "openrouter_missing_key") {
      return isRu ? "Нужно настроить OpenRouter в настройках Aevum." : "OpenRouter setup is required in Aevum Settings.";
    }
    if (error.code === "ollama_not_running" || error.code === "wrong_base_url") {
      return isRu ? "Ollama недоступен. Запустите Ollama на этом компьютере и попробуйте снова." : "Ollama is unavailable. Start Ollama on this computer and try again.";
    }
    if (error.code === "model_missing") {
      return isRu ? "Выбранная модель Ollama не установлена." : "The selected Ollama model is not installed.";
    }
    if (error.code === "invalid_ai_response") {
      return isRu
        ? "Ответ модели выглядел некорректно. Попробуйте еще раз или выберите другую AI-модель в настройках."
        : "The model response looked unusable. Try again or choose another AI model in settings.";
    }
  }
  return isRu
    ? "Не удалось безопасно обработать запрос. Попробуйте еще раз."
    : "I could not handle that safely. Please try again.";
}

function buildAutoAgentPrompt(
  taskContext: Task[],
  projectContext: Project[],
  availabilityBlocks: AvailabilityBlock[],
  language: UserSettings["language"]
) {
  const projectSummary = projectContext
    .slice(0, 30)
    .map((project) => `- id=${project.id} | ${project.name}`)
    .join("\n");

  const taskSummary = taskContext
    .slice(0, 50)
    .map((task) => `- id=${task.id} | title=${task.title} | status=${task.status} | projectId=${task.projectId} | scheduledAt=${task.scheduledAt ?? "none"} | duration=${task.durationMinutes ?? "none"} | eligible=${isEligibleForPlan(task, "plan_day") ? "yes" : "no"}`)
    .join("\n");

  const availabilitySummary = availabilityBlocks
    .map((block) => `- ${block.label}: weekdays=${block.weekdays.join(",")} ${block.startTime}-${block.endTime}`)
    .join("\n");

  const today = getTodayISO();

  const langBlock = language === "ru"
    ? `Отвечай строго на русском языке. Все пользовательские строки внутри JSON должны быть на русском.`
    : `Respond strictly in English. All user-facing strings inside JSON must be in English.`;

  return `You are Aevum, a premium unified task-management autonomous agent.
Current date: ${today}.
${langBlock}

You must analyze the user's natural language request and decide on the best course of action. Return a JSON object matching this schema:
{
  "kind": "answer" | "clarify" | "proposal",
  "message": "A short, natural response to the user. For answer/clarify, this is the main response. For proposals, this is a short natural acknowledgment containing any assumptions made (e.g., date, time, duration).",
  "action": null | AssistantAction
}

Rules for deciding the "kind":
1. "answer": Use for read-only queries (e.g., "Что у меня сегодня?", "What tasks do I have today?", "What is Aevum?"), general greetings, or questions about features. Return a concise, useful answer directly in the "message" field. Set "action" to null.
2. "clarify": Use when the request is too ambiguous, missing critical information, unsafe, or cannot be planned. Ask for clarification in the "message" field. Set "action" to null.
3. "proposal": Use when the user requests mutating actions (create, plan, reschedule, edit, delete, etc.). Prepare a valid proposal in the "action" field and a short acknowledgement in "message".

Rules for "action" schemas:
- If creating new tasks (including compound planning where tasks are new):
  {
    "type": "create_tasks",
    "tasks": [
      {
        "title": "Gym",
        "scheduledAt": "YYYY-MM-DDTHH:mm" or "YYYY-MM-DD" or null,
        "durationMinutes": number or null,
        "projectName": "Personal" or similar (optional),
        "tags": []
      }
    ]
  }
  * For compound planning (e.g., "спланируй завтра сходить на тренировку, в кино"): create these as new tasks with realistic schedule times/durations. Make clear, reasonable assumptions for time/duration in your "message" (e.g. gym at 10:00 for 90 min, cinema at 14:00 for 120 min) and set scheduledAt and durationMinutes in the action. Ensure no overlaps with existing tasks or unavailable blocks.

- If planning/scheduling existing active tasks (only those listed as eligible):
  {
    "type": "schedule_tasks",
    "mode": "plan_day",
    "changes": [
      { "taskId": "existing-task-id", "scheduledAt": "YYYY-MM-DDTHH:mm", "durationMinutes": number }
    ]
  }

- If managing existing tasks (rename, edit, status complete/active, delete):
  {
    "type": "manage_tasks",
    "operations": [
      {
        "operation": "update" | "set_status" | "delete",
        "taskId": "existing-task-id",
        "changes": { ... } (only for update),
        "status": "completed" | "active" (only for set_status),
        "reason": "Brief reason"
      }
    ]
  }

- If compound/batch operations (e.g., mixed create + schedule/update/delete):
  {
    "type": "batch_action",
    "tasksToCreate": [ ...tasks to create schema above... ],
    "scheduleChanges": [ ...schedule changes schema above... ],
    "manageOperations": [ ...manage operations schema above... ]
  }
  Use this for mixed requests (e.g. "Create a cinema task and move my workout to 18:00", "Delete shopping and schedule a new visit").

Safety Boundary constraints:
- NEVER modify or propose changes to: API keys, Telegram tokens, model/provider settings, cache/history clearing, system settings, or onboarding state. If the user asks for these, choose "clarify" or "answer" stating that these settings cannot be changed by the agent.
- Do not invent task IDs. Use only task IDs listed below.
- Do not claim changes were saved. The app applies changes only after confirmation.

Current tasks:
${taskSummary || "No tasks yet."}

Existing projects/categories:
${projectSummary || "No projects yet."}

Unavailable blocks:
${availabilitySummary || "No unavailable blocks."}`;
}

function buildFullAgentPrompt(
  taskContext: Task[],
  projectContext: Project[],
  availabilityBlocks: AvailabilityBlock[],
  language: UserSettings["language"]
) {
  const projectSummary = projectContext
    .slice(0, 30)
    .map((project) => `- id=${project.id} | ${project.name}`)
    .join("\n");

  const activeTasks = taskContext.filter((t) => t.status === "active").slice(0, 50);
  const completedTasks = taskContext.filter((t) => t.status === "completed").slice(0, 20);

  const taskSummary = activeTasks
    .map((task) => `- id=${task.id} | title=${task.title} | status=active | projectId=${task.projectId} | scheduledAt=${task.scheduledAt ?? "none"} | duration=${task.durationMinutes ?? "none"} | reminder=${task.reminderMinutes ?? "none"}`)
    .join("\n");

  const completedSummary = completedTasks
    .map((task) => `- id=${task.id} | title=${task.title} | status=completed | projectId=${task.projectId}`)
    .join("\n");

  const availabilitySummary = availabilityBlocks
    .map((block) => `- ${block.label}: weekdays=${block.weekdays.join(",")} ${block.startTime}-${block.endTime}`)
    .join("\n");

  const today = getTodayISO();

  const langBlock = language === "ru"
    ? `Отвечай строго на русском языке. Все пользовательские строки внутри JSON должны быть на русском.`
    : `Respond strictly in English. All user-facing strings inside JSON must be in English.`;

  return `You are Aevum, a premium unified task-management autonomous agent.
Current date: ${today}.
${langBlock}

You must analyze the user's natural language request and decide on the best course of action. Return a JSON object matching this schema:
{
  "kind": "answer" | "clarify" | "proposal",
  "message": "A short, natural response to the user. For answer/clarify, this is the main response. For proposals, this is a short natural acknowledgment containing any assumptions made (e.g., date, time, duration, categories).",
  "proposal": null | BatchAction
}

Where BatchAction has the following schema:
{
  "type": "batch_action",
  "categoriesToCreate": [
    { "ref": "temp-ref-1", "name": "Category Name" }
  ],
  "categoriesToRename": [
    { "categoryId": "existing-category-id", "newName": "New Category Name" }
  ],
  "tasksToCreate": [
    {
      "title": "Gym",
      "scheduledAt": "YYYY-MM-DDTHH:mm" or "YYYY-MM-DD" or null,
      "durationMinutes": number or null,
      "reminderMinutes": 0 | 5 | 10 | 30 | 60 | null,
      "categoryTarget": { "kind": "new", "ref": "temp-ref-1" } or { "kind": "existing", "categoryId": "existing-category-id" }
    }
  ],
  "scheduleChanges": [
    { "taskId": "existing-task-id", "scheduledAt": "YYYY-MM-DDTHH:mm", "durationMinutes": number }
  ],
  "manageOperations": [
    {
      "operation": "update" | "set_status" | "delete",
      "taskId": "existing-task-id",
      "changes": {
        "title": "New Title",
        "description": "New Description",
        "projectId": "existing-category-id"
      },
      "status": "completed" | "active",
      "reason": "Brief reason"
    }
  ]
}

Rules for deciding the "kind":
1. "answer": Use for read-only queries (e.g. asking about tasks, workload, upcoming work, or general questions). Set "proposal" to null.
2. "clarify": Use when the request is too ambiguous, missing critical information, unsafe, or cannot be planned. Set "proposal" to null.
3. "proposal": Use when the user requests mutating actions. Prepare a valid BatchAction in the "proposal" field and a short acknowledgement in "message".

Rules and Capabilities:
- Every mutating proposal must normalize into a single batch_action proposal. Do not use other types. Even a simple task creation must use batch_action with tasksToCreate.
- Duplicates: Do not create duplicate categories. Check existing categories below. If the user asks to assign a task to a category, reuse the existing category ID or matching name case-insensitively.
- Link Category: If creating new tasks under a category created in the same proposal, use a temporary "ref" (e.g. "temp-ref-1") in categoriesToCreate and reference it with { "kind": "new", "ref": "temp-ref-1" } in tasksToCreate.categoryTarget.
- Rename Category: You may rename existing categories using categoriesToRename (specifying categoryId and newName). Never rename the category with ID "uncategorized" (this is the special Uncategorized fallback category).
- Defer deletion: We do not support category deletion. If requested, use "clarify" or "answer" stating category deletion is not supported.
- Recurrence and Subtasks: We do not support recurrence/repeat rules mutation or subtask creation/mutation in this mode. If requested, use "clarify" or "answer" stating they are not supported.
- Assumptions: If the user leaves out time or duration for a task, make reasonable assumptions (e.g. gym at 10:00 for 60 min, cinema for 120 min) and state these assumptions clearly in your "message" in the selected language. Propose these actions rather than pretending they were already performed.
- Forbid setting alterations: NEVER modify or propose changes to settings, API keys, Telegram bot tokens, app theme, appearance, or onboarding. If requested, refuse.

Current active tasks:
${taskSummary || "No active tasks."}

Recently completed tasks:
${completedSummary || "No completed tasks."}

Existing categories:
${projectSummary || "No categories yet."}

Unavailable blocks:
${availabilitySummary || "No unavailable blocks."}`;
}
