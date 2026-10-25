/** Forbidden object keys. Secret strings are supplied by the caller. */
export const FORBIDDEN_PAYLOAD_KEYS = [
  "rootCause",
  "oracle",
  "leakSentinel",
  "confirmingTestId",
  "hiddenRootCause",
  "hidden",
] as const;

export function collectKeys(value: unknown, found: Set<string> = new Set()): Set<string> {
  if (!value || typeof value !== "object") return found;
  if (Array.isArray(value)) {
    for (const item of value) collectKeys(item, found);
    return found;
  }
  for (const [key, child] of Object.entries(value)) {
    found.add(key);
    collectKeys(child, found);
  }
  return found;
}

/**
 * Throws when a payload destined for the model contains a hidden-fixture
 * string or a forbidden key. The error text never echoes the secret.
 */
export function assertModelSafe(label: string, payload: unknown, secrets: readonly string[]): void {
  const serialized = JSON.stringify(payload) ?? "";
  for (const secret of secrets) {
    if (secret && serialized.includes(secret)) {
      throw new Error(`Red line: ${label} would expose a hidden incident string`);
    }
  }
  for (const key of collectKeys(payload)) {
    if ((FORBIDDEN_PAYLOAD_KEYS as readonly string[]).includes(key)) {
      throw new Error(`Red line: ${label} would expose forbidden key ${key}`);
    }
  }
}
