import { createHash } from "node:crypto";

type JsonPrimitive = boolean | null | number | string;
export type JsonValue = JsonPrimitive | JsonValue[] | { [key: string]: JsonValue };

function serialize(value: unknown, stack: Set<object>): string | undefined {
  if (value === null || typeof value === "boolean" || typeof value === "string") {
    return JSON.stringify(value);
  }

  if (typeof value === "number") {
    if (!Number.isFinite(value)) {
      throw new TypeError("Canonical JSON cannot represent non-finite numbers");
    }
    return JSON.stringify(value);
  }

  if (typeof value === "bigint") {
    throw new TypeError("Canonical JSON cannot represent bigint values");
  }

  if (typeof value === "undefined" || typeof value === "function" || typeof value === "symbol") {
    return undefined;
  }

  if (typeof value !== "object") {
    throw new TypeError(`Unsupported canonical JSON value: ${typeof value}`);
  }

  const objectValue = value as object & { toJSON?: () => unknown };
  if (typeof objectValue.toJSON === "function") {
    return serialize(objectValue.toJSON(), stack);
  }
  if (stack.has(objectValue)) {
    throw new TypeError("Cannot canonicalize a circular structure");
  }

  stack.add(objectValue);
  try {
    if (Array.isArray(objectValue)) {
      return `[${objectValue
        .map((item) => serialize(item, stack) ?? "null")
        .join(",")}]`;
    }

    const record = objectValue as Record<string, unknown>;
    const entries = Object.keys(record)
      .sort()
      .flatMap((key) => {
        const serialized = serialize(record[key], stack);
        return serialized === undefined
          ? []
          : [`${JSON.stringify(key)}:${serialized}`];
      });
    return `{${entries.join(",")}}`;
  } finally {
    stack.delete(objectValue);
  }
}

export function canonicalStringify(value: unknown): string {
  const result = serialize(value, new Set());
  if (result === undefined) {
    throw new TypeError("The root value is not JSON serializable");
  }
  return result;
}

export function sha256Hex(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("hex");
}

export function sha256Base64Url(value: string | Uint8Array): string {
  return createHash("sha256").update(value).digest("base64url");
}

export function hashCanonicalPayload(value: unknown): string {
  return sha256Hex(canonicalStringify(value));
}
