import type { AIActionAuditEntry } from "./aiActions";
import { sanitizeAIActionAuditEntryForStorage } from "./aiActions";

const auditStorageKey = "aevum-ai-action-audit-v1";
const auditSchemaVersion = 1;
const defaultHistoryLimit = 100;

interface StoredAuditLog {
  schemaVersion: 1;
  entries: AIActionAuditEntry[];
}

export function loadAIActionAuditLog(): AIActionAuditEntry[] {
  const storage = getLocalStorage();
  if (!storage) return [];

  try {
    const stored = storage.getItem(auditStorageKey);
    if (!stored) return [];
    const parsed = JSON.parse(stored) as unknown;
    const entries = migrateAuditLog(parsed);
    if (!entries) return [];
    return entries.slice(0, defaultHistoryLimit);
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn("[Aevum] Failed to load AI action audit log", error);
    }
    return [];
  }
}

export function saveAIActionAuditLog(entries: AIActionAuditEntry[]) {
  const storage = getLocalStorage();
  if (!storage) return;

  try {
    const payload: StoredAuditLog = {
      schemaVersion: auditSchemaVersion,
      entries: entries.slice(0, defaultHistoryLimit).map(sanitizeAIActionAuditEntryForStorage),
    };
    storage.setItem(auditStorageKey, JSON.stringify(payload));
  } catch (error) {
    if (import.meta.env.DEV) {
      console.warn("[Aevum] Failed to save AI action audit log", error);
    }
  }
}

export function appendAIActionAuditEntry(
  entries: AIActionAuditEntry[],
  entry: AIActionAuditEntry,
  limit = defaultHistoryLimit,
) {
  return [sanitizeAIActionAuditEntryForStorage(entry), ...entries].slice(0, limit);
}

export function markAIActionAuditEntryUndone(entries: AIActionAuditEntry[], transactionId: string) {
  return entries.map((entry) =>
    entry.transactionId === transactionId
      ? { ...entry, status: "undone" as const, undoUnavailableReason: undefined }
      : entry,
  );
}

export function markAIActionAuditEntryConflicted(
  entries: AIActionAuditEntry[],
  transactionId: string,
  reason: AIActionAuditEntry["undoUnavailableReason"],
) {
  return entries.map((entry) =>
    entry.transactionId === transactionId
      ? { ...entry, status: "conflicted" as const, undoUnavailableReason: reason }
      : entry,
  );
}

function migrateAuditLog(value: unknown): AIActionAuditEntry[] | undefined {
  if (Array.isArray(value)) {
    return value.map(migrateAuditEntry).filter((entry): entry is AIActionAuditEntry => Boolean(entry));
  }

  if (!isRecord(value) || value.schemaVersion !== auditSchemaVersion || !Array.isArray(value.entries)) {
    return undefined;
  }

  return value.entries.map(migrateAuditEntry).filter((entry): entry is AIActionAuditEntry => Boolean(entry));
}

function migrateAuditEntry(value: unknown): AIActionAuditEntry | undefined {
  if (!isRecord(value)) return undefined;
  if (value.schemaVersion !== auditSchemaVersion) return undefined;
  if (typeof value.transactionId !== "string") return undefined;
  if (value.source !== "assistant" && value.source !== "telegram" && value.source !== "mcp") return undefined;
  if (!isActionKind(value.actionKind)) return undefined;
  if (typeof value.createdAt !== "string" || typeof value.confirmedAt !== "string" || typeof value.appliedAt !== "string") return undefined;
  if (!isAuditStatus(value.status)) return undefined;
  if (!Array.isArray(value.taskPatches) || !Array.isArray(value.projectPatches)) return undefined;
  if (!isRecord(value.summary)) return undefined;

  return sanitizeAIActionAuditEntryForStorage(value as unknown as AIActionAuditEntry);
}

function isActionKind(value: unknown) {
  return value === "create" || value === "schedule" || value === "replan" || value === "manage" || value === "undo";
}

function isAuditStatus(value: unknown) {
  return value === "applied" || value === "undone" || value === "conflicted" || value === "failed";
}

function getLocalStorage() {
  if (typeof window === "undefined") return null;
  try {
    return window.localStorage;
  } catch {
    return null;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}
