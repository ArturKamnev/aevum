import type { AIMode, AssistantMessage, AvailabilityBlock, ReminderOffsetMinutes, RepeatRule, Task, UserSettings } from "../types";
import { getScheduleDate, getScheduleTime, getTodayISO, normalizeScheduledAt } from "../utils/date";
import { defaultRepeat, normalizeRepeat } from "../utils/recurrence";

export type AIConnectionStatus = "idle" | "connected" | "not-connected" | "model-missing";
type StructuredSchema = "create_tasks" | "plan_day" | "replan_tasks" | "create_subtasks";
const dayMinutes = 24 * 60;

export interface AIModelInfo {
  name: string;
  modifiedAt?: string;
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
  tags?: string[];
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

export type AssistantAction = CreateTasksAction | ScheduleTasksAction;

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

  const languagePrompt = language === "ru"
    ? "Отвечай только на русском языке. Ответ должен быть кратким и полезным. Объясняй функции приложения, если пользователь спрашивает о них."
    : "Respond in English only. Keep responses concise and helpful. Explain app features if the user asks.";

  return `You are Aevum, a desktop productivity assistant.
Current date: ${getTodayISO()}.
${languagePrompt}
You are currently in Guide Mode. Help the user with navigation, explaining features, or general guidance.
You cannot create, schedule, or modify tasks directly in this mode.
If the user asks you to create or plan tasks, politely decline and instruct them to select the appropriate tool (Create Tasks or Plan My Day) from the '+' tools menu.

User's tasks:
${taskSummary || "No tasks yet."}`;
}

function buildGuideRepairPrompt(taskContext: Task[], language: UserSettings["language"]) {
  return `${buildGuidePrompt(taskContext, language)}

The previous assistant answer was unusable, malformed, wrong-language, or low quality.
Rewrite it once. Return plain natural text only, in the UI language only.
Do not return JSON. Do not create, schedule, update, delete, or imply saved task changes.`;
}

function authorizeActionResult(
  result: AIChatResult,
  mode: AIMode | null,
  language: UserSettings["language"]
): AIChatResult {
  const action = result.action;
  if (!action) return result; // No action to authorize, always allowed

  // Guide Mode: reject all task or planning actions
  if (mode === null) {
    return {
      message: createAssistantMessage(
        language === "ru"
          ? "Чтобы создать или спланировать задачи, пожалуйста, выберите соответствующий инструмент в меню +."
          : "To create or plan tasks, please select the appropriate tool from the + menu."
      ),
      action: undefined,
    };
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
            : "Only task creation is allowed in this mode. Please select the Plan My Day tool."
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
            : "Only task scheduling is allowed in this mode. Please select the Create Tasks tool."
        ),
        action: undefined,
      };
    }
  }

  return result;
}

export async function chatWithAssistant(
  userMessage: string,
  taskContext: Task[],
  settings: UserSettings,
  mode: AIMode | null,
): Promise<AIChatResult> {
  const result = await chatWithAssistantInternal(userMessage, taskContext, settings, mode);
  return authorizeActionResult(result, mode, settings.language);
}

async function chatWithAssistantInternal(
  userMessage: string,
  taskContext: Task[],
  settings: UserSettings,
  mode: AIMode | null,
): Promise<AIChatResult> {
  if (mode === null) {
    const msg = userMessage.toLowerCase().trim();
    const isActionRequest =
      msg.startsWith("create ") || msg.startsWith("add ") || msg.startsWith("schedule ") || msg.startsWith("plan ") ||
      msg.startsWith("создай") || msg.startsWith("добавь") || msg.startsWith("запланируй") || msg.startsWith("спланируй") || msg.startsWith("распланируй") ||
      msg.includes("создай задачу") || msg.includes("создать задачу") || msg.includes("добавь задачу") || msg.includes("добавить задачу");

    if (isActionRequest) {
      return {
        message: createAssistantMessage(
          settings.language === "ru"
            ? "Чтобы создать или спланировать задачи, пожалуйста, выберите соответствующий инструмент в меню +."
            : "To create or plan tasks, please select the appropriate tool from the + menu."
        ),
        action: undefined,
      };
    }

    const raw = await requestGuideText(userMessage, taskContext, settings);
    return {
      message: createAssistantMessage(raw),
      action: undefined,
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
  messages: Array<{ role: "system" | "user"; content: string }>,
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

  const response = await fetchWithProviderErrors(endpoint, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      model: settings.localModel,
      messages,
      stream: false,
      ...(options.json ? { format: "json" } : {}),
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
  const content = readOllamaMessage(payload);
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
  return requestOllamaChat(settings, messages.filter((message) => message.role !== "assistant") as Array<{ role: "system" | "user"; content: string }>, options);
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

  if (isTextQualitySafe(raw, settings.language)) return sanitizeAssistantText(raw, guideFallback(settings.language));

  logInvalidAIResponse(raw, "guide", "initial", settings);
  const repaired = await requestAIChat(settings, [
    { role: "system", content: buildGuideRepairPrompt(taskContext, settings.language) },
    { role: "user", content: userMessage },
    { role: "assistant", content: raw },
    { role: "user", content: "Rewrite the previous answer so it is natural, concise, useful, and in the required UI language. Do not return JSON or task mutations." },
  ], { mode: "guide_repair" });

  if (isTextQualitySafe(repaired, settings.language)) return sanitizeAssistantText(repaired, guideFallback(settings.language));

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
    .slice(0, 20)
    .map((task) => `- id=${task.id} | ${task.title} | status=${task.status} | scheduledAt=${task.scheduledAt ?? "none"} | duration=${task.durationMinutes ?? "none"} | reminder=${task.reminderMinutes ?? "default"} | repeat=${task.repeat.enabled ? "yes" : "no"} | eligible=${isEligibleForPlan(task, "plan_day") ? "yes" : "no"} | replanEligible=${isEligibleForPlan(task, "replan_tasks") ? "yes" : "no"}`)
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
  return {
    title: value.title.trim(),
    description: typeof value.description === "string" ? value.description.trim() : "",
    scheduledAt,
    durationMinutes: readDurationMinutes(value.durationMinutes),
    reminderMinutes: readReminderMinutes(value.reminderMinutes),
    repeat: isRecord(value.repeat) ? normalizeRepeat(value.repeat) : { ...defaultRepeat },
    projectName: typeof value.projectName === "string" && value.projectName.trim() ? value.projectName.trim() : undefined,
    tags: Array.isArray(value.tags) ? value.tags.filter((tag): tag is string => typeof tag === "string").map((tag) => tag.trim()).filter(Boolean) : [],
  };
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

function sanitizeAssistantText(value: string, fallback: string) {
  const trimmed = value.trim();
  if (!trimmed) return fallback;
  if (trimmed.includes("{") || trimmed.includes("}") || trimmed.includes("[") || trimmed.includes("]")) return fallback;
  if (hasCjkCharacters(trimmed)) return fallback;
  return trimmed.length > 240 ? `${trimmed.slice(0, 237).trim()}...` : trimmed;
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
  if (!text || text.length > 800) return false;
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
  const trimmed = stripCodeFence(content.trim());
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
  if ((schema === "plan_day" || schema === "replan_tasks" || schema === "create_tasks") && isRecord(value)) {
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
