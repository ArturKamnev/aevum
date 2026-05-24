export function createId(prefix: string) {
  return `${prefix}-${getRandomId()}`;
}

export function createTaskId() {
  return createId("task");
}

export function createProjectId() {
  return createId("project");
}

export function createSubtaskId() {
  return createId("subtask");
}

export function createAvailabilityId() {
  return createId("availability");
}

function getRandomId() {
  if (typeof crypto !== "undefined" && typeof crypto.randomUUID === "function") {
    return crypto.randomUUID();
  }
  return `${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}
