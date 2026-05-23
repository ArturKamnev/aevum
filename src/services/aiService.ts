import type { AIMode, AssistantMessage, AvailabilityBlock, ReminderOffsetMinutes, RepeatRule, Task, UserSettings } from "../types";
import { getScheduleDate, getScheduleTime, getTodayISO, normalizeScheduledAt } from "../utils/date";
import { defaultRepeat, normalizeRepeat } from "../utils/recurrence";

export type AIConnectionStatus = "idle" | "connected" | "not-connected" | "model-missing";
type StructuredSchema = "create_tasks" | "plan_day" | "replan_tasks" | "create_subtasks";

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

export async function chatWithAssistant(
  userMessage: string,
  taskContext: Task[],
  settings: UserSettings,
  mode: AIMode,
): Promise<AIChatResult> {
  if (mode === "plan_day") {
    const raw = await requestAIChat(settings, [
      { role: "system", content: buildPlanPrompt(taskContext, settings.availabilityBlocks, settings.language) },
      { role: "user", content: userMessage },
    ], { json: true });
    const plan = await parseOrRepairStructured(raw, "plan_day", settings, (value) => validatePlanDayResult(value, taskContext, settings.availabilityBlocks));
    return {
      message: createAssistantMessage(renderPlanMessage(plan, settings.language)),
      action: plan.action,
    };
  }

  if (mode === "replan_tasks") {
    const raw = await requestAIChat(settings, [
      { role: "system", content: buildReplanPrompt(taskContext, settings.availabilityBlocks, settings.language) },
      { role: "user", content: userMessage },
    ], { json: true });
    const plan = await parseOrRepairStructured(raw, "replan_tasks", settings, (value) => validatePlanDayResult(value, taskContext, settings.availabilityBlocks, "replan_tasks"));
    return {
      message: createAssistantMessage(renderPlanMessage(plan, settings.language)),
      action: plan.action,
    };
  }

  const raw = await requestAIChat(settings, [
    { role: "system", content: buildCreateTasksPrompt(taskContext, settings.language) },
    { role: "user", content: userMessage },
  ], { json: true });
  const action = await parseOrRepairStructured(raw, "create_tasks", settings, validateCreateTasksAction);

  return {
    message: createAssistantMessage(renderCreateTasksMessage(action.action.tasks.length, settings.language), { actionType: action.action.type }),
    action: action.action,
  };
}

export async function breakDownTaskWithAI(task: Task, settings: UserSettings): Promise<string[]> {
  const raw = await requestAIChat(settings, [
    { role: "system", content: buildBreakdownPrompt(task, settings.language) },
    { role: "user", content: `Break this task into practical subtasks: ${task.title}\n\n${task.description}` },
  ], { json: true });

  const result = await parseOrRepairStructured(raw, "create_subtasks", settings, validateSubtasksResult);
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
  options: { json?: boolean } = {},
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
  return readOllamaMessage(payload);
}

async function requestAIChat(
  settings: UserSettings,
  messages: Array<{ role: "system" | "user" | "assistant"; content: string }>,
  options: { json?: boolean } = {},
) {
  if (settings.aiProvider === "openrouter") {
    const result = await window.todoAI?.chatOpenRouter({ messages, model: settings.cloudModel, json: options.json });
    if (!result?.ok) throw openRouterError(result);
    if (!result.content) throw new AIProviderError("The AI provider returned an unexpected response.", "unexpected_response");
    logAIDebug("Received OpenRouter assistant content", {
      provider: "openrouter",
      model: result.model ?? settings.cloudModel,
      rawAssistantContent: result.content,
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

async function parseOrRepairStructured<T>(
  raw: string,
  schema: StructuredSchema,
  settings: UserSettings,
  validate: (value: unknown) => T | undefined,
): Promise<T> {
  const parsed = parseStructured(raw, validate, schema, settings);
  if (parsed) return parsed;

  logInvalidAIResponse(raw, schema, "initial");
  const repaired = await repairStructuredResponse(raw, schema, settings);
  const repairedParsed = parseStructured(repaired, validate, schema, settings);
  if (repairedParsed) return repairedParsed;

  logInvalidAIResponse(repaired, schema, "repair");
  throw new AIProviderError("I could not understand the AI response. Please try again.", "invalid_ai_response", {
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

async function repairStructuredResponse(raw: string, schema: StructuredSchema, settings: UserSettings) {
  return requestAIChat(settings, [
    { role: "system", content: buildRepairPrompt(schema, settings.language) },
    { role: "user", content: raw },
  ], { json: true });
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

function buildRepairPrompt(schema: StructuredSchema, language: UserSettings["language"]) {
  const shape =
    schema === "create_tasks"
      ? `{"userMessage":"${copy(language).createTasksUserMessage}","action":{"type":"create_tasks","tasks":[{"title":"Task title","description":"","scheduledAt":null,"durationMinutes":null,"reminderMinutes":null,"repeat":{"enabled":false,"type":"daily","interval":1,"unit":"day","weekdays":[],"excludedWeekdays":[]},"projectName":"Personal","tags":[]}]}}`
      : schema === "plan_day" || schema === "replan_tasks"
        ? `{"userMessage":"${copy(language).planUserMessage}","plan":[{"time":"09:00","title":"Plan item","description":"What to do."}],"action":{"type":"schedule_tasks","mode":"${schema}","changes":[{"taskId":"existing-task-id","scheduledAt":"2026-05-22T09:00","durationMinutes":30,"reason":"Fits available time."}]}}`
        : `{"userMessage":"${copy(language).subtasksUserMessage}","subtasks":["First step","Second step","Third step"]}`;

  return `Convert the user's content into valid JSON for Aevum.
${languageInstruction(language)}
Return only one JSON object. No markdown fences. No commentary.
Required schema:
${shape}`;
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
  const action = isRecord(value.action) ? value.action : value;
  if (action.type !== "create_tasks" || !Array.isArray(action.tasks)) return undefined;
  const tasks = action.tasks.map(readTaskDraft).filter((task): task is AITaskDraft => Boolean(task));
  return tasks.length > 0 ? { userMessage, action: { type: "create_tasks", tasks } } : undefined;
}

function validatePlanDayResult(value: unknown, taskContext: Task[], availabilityBlocks: AvailabilityBlock[], mode: "plan_day" | "replan_tasks" = "plan_day"): PlanDayResult | undefined {
  if (!isRecord(value)) return undefined;
  const planSource = Array.isArray(value.plan) ? value.plan : Array.isArray(value.blocks) ? value.blocks : Array.isArray(value.schedule) ? value.schedule : undefined;
  if (!planSource) return undefined;
  const plan = planSource.map(readPlanBlock).filter((block): block is PlanBlock => Boolean(block)).slice(0, 8);
  if (plan.length === 0) return undefined;
  const action = readScheduleAction(value.action, taskContext, availabilityBlocks, mode);
  return {
    userMessage: readUserMessage(value) || "Here is a practical plan for your day.",
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
    .filter((title): title is string => Boolean(title))
    .slice(0, 7);
  return subtasks.length >= 3
    ? { userMessage: readUserMessage(value) || "Here is a smaller checklist.", subtasks }
    : undefined;
}

function readTaskDraft(value: unknown): AITaskDraft | undefined {
  if (!isRecord(value) || typeof value.title !== "string" || value.title.trim().length === 0) return undefined;
  const scheduleValue = readScheduleValue(value);
  return {
    title: value.title.trim(),
    description: typeof value.description === "string" ? value.description.trim() : "",
    scheduledAt: normalizeScheduledAt(scheduleValue),
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

function readDurationMinutes(value: unknown) {
  if (typeof value !== "number" || !Number.isFinite(value) || value <= 0) return null;
  return Math.floor(value);
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
  if (schema === "plan_day" && isRecord(value)) {
    return typeof value.userMessage !== "string" || !hasCjkCharacters(value.userMessage);
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

function logInvalidAIResponse(rawResponse: string, schema: StructuredSchema, phase: "initial" | "repair") {
  if (import.meta.env.DEV) {
    console.error("[Aevum] Invalid AI response", { schema, phase, rawResponse });
  }
}

function logSchemaValidationError(schema: StructuredSchema, validationError: string, rawAssistantContent: string, settings: UserSettings) {
  if (import.meta.env.DEV) {
    console.error("[Aevum] Schema validation error", {
      provider: settings.aiProvider,
      model: settings.aiProvider === "openrouter" ? settings.cloudModel : settings.localModel,
      schema,
      validationError,
      rawAssistantContent,
    });
  }
}
