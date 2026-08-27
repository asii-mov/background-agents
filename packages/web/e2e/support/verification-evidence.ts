const SENSITIVE_VALUE_KEYS =
  /(?:^|_)(?:api_key|authorization|client_secret|cookie|password|private_key|refresh_token|secret|token)(?:$|_)/;
const SENSITIVE_CONTAINERS = new Set(["credentials", "env", "headers"]);

function normalizeKey(key: string): string {
  return key
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[-\s]+/g, "_")
    .toLowerCase();
}

function redactValue(value: unknown, redactScalars: boolean): unknown {
  if (value === null || typeof value !== "object") {
    return redactScalars ? "[REDACTED]" : value;
  }
  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, redactScalars));
  }
  return Object.fromEntries(
    Object.entries(value).map(([key, item]) => {
      const normalizedKey = normalizeKey(key);
      return [
        key,
        redactValue(
          item,
          redactScalars ||
            SENSITIVE_CONTAINERS.has(normalizedKey) ||
            SENSITIVE_VALUE_KEYS.test(normalizedKey)
        ),
      ];
    })
  );
}

export function redactVerificationEvidence(value: unknown): unknown {
  return redactValue(value, false);
}
