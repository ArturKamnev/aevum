export type MainViewId =
  | "dashboard"
  | "today"
  | "upcoming"
  | "projects"
  | "calendar"
  | "visualization"
  | "assistant"
  | "settings";

export type CategoryViewId = `category:${string}`;
export type ViewId = MainViewId | CategoryViewId;

export type TaskStatus = "active" | "completed";
export type CategoryDateFilter = "today" | "tomorrow" | "week" | "all";
export type RepeatType = "daily" | "weekly" | "monthly" | "custom";
export type RepeatUnit = "day" | "week" | "month";
export type SortMode = "deadline" | "status";
export type ThemeMode = "dark" | "light" | "system";
export type TimeFormat = "24h" | "12h";
export type AIProvider = "ollama" | "openrouter";
export type Language = "en" | "ru";
export type AIMode = "plan_day" | "create_tasks" | "replan_tasks" | "manage_tasks" | "full_agent";
export type ReminderOffsetMinutes = 0 | 5 | 10 | 30 | 60;
export type OverdueAutoCleanupMode = "off" | "archive" | "delete";
export type McpAccessMode = "read-only" | "proposals" | "full-access";
export type McpAuthenticationMode = "bearer" | "oauth";
export type McpTunnelMode = "temporary" | "persistent";
export type McpConnectionMode = "aevum-connect" | "quick-tunnel";

export interface Subtask {
  id: string;
  title: string;
  completed: boolean;
}

export interface Project {
  id: string;
  name: string;
  color: string;
  description: string;
}

export interface RepeatRule {
  enabled: boolean;
  type: RepeatType;
  interval: number;
  unit: RepeatUnit;
  weekdays: number[];
  excludedWeekdays: number[];
}

export interface Task {
  id: string;
  title: string;
  description: string;
  status: TaskStatus;
  scheduledAt: string | null;
  deadline?: string;
  projectId: string;
  durationMinutes: number | null;
  reminderMinutes: ReminderOffsetMinutes | null;
  repeat: RepeatRule;
  nextRepeatAt: string | null;
  recurringParentId?: string;
  tags: string[];
  subtasks: Subtask[];
  createdAt: string;
  updatedAt: string;
}

export interface TaskDraft {
  title: string;
  description: string;
  status: TaskStatus;
  scheduledAt: string | null;
  projectId: string;
  durationMinutes: number | null;
  reminderMinutes: ReminderOffsetMinutes | null;
  repeat: RepeatRule;
  nextRepeatAt: string | null;
  tags: string[];
  subtasks: Subtask[];
}

export interface AvailabilityBlock {
  id: string;
  label: string;
  weekdays: number[];
  startTime: string;
  endTime: string;
}

export interface AssistantMessage {
  id: string;
  role: "user" | "assistant" | "system" | "action" | "error";
  content: string;
  createdAt: string;
  metadata?: {
    actionType?: string;
    errorCode?: string;
    retryPrompt?: string;
  };
}

export interface UserSettings {
  theme: ThemeMode;
  timeFormat: TimeFormat;
  language: Language;
  aiProvider: AIProvider;
  aiBaseUrl: string;
  localModel: string;
  cloudModel: string;
  notifications: boolean;
  defaultReminderMinutes: ReminderOffsetMinutes;
  availabilityBlocks: AvailabilityBlock[];
  onboardingCompleted: boolean;
  startupBehavior: "dashboard" | "today" | "last-view";
  autoPlanDay: boolean;
  overdueAutoCleanupMode: OverdueAutoCleanupMode;
  mcpEnabled: boolean;
  mcpAccessMode: McpAccessMode;
  mcpPort: number;
  mcpAuthenticationMode: McpAuthenticationMode;
  mcpRemoteUrl: string;
  mcpTunnelMode: McpTunnelMode;
  mcpConnectionMode: McpConnectionMode;
  mcpRelayOrigin: string;
  telegramAssistantEnabled: boolean;
  telegramUseDefaultAI: boolean;
  telegramAIProvider: AIProvider;
  telegramLocalModel: string;
  telegramCloudModel: string;
}
