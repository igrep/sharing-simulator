/**
 * Format the arguments of `console.log` into a single line, roughly like the
 * browser's console does. Accessor properties are skipped so that formatting
 * never runs user code.
 */
export function formatLogArgs(args: readonly unknown[]): string {
  return args
    .map((arg) => (typeof arg === "string" ? arg : inspect(arg, new Set())))
    .join(" ");
}

function inspect(value: unknown, seen: Set<object>): string {
  switch (typeof value) {
    case "string":
      return JSON.stringify(value);
    case "bigint":
      return `${value}n`;
    case "symbol":
      return value.toString();
    case "function":
      return `[Function${value.name ? ` ${value.name}` : ""}]`;
    case "object":
      break;
    default:
      return String(value);
  }
  if (value === null) return "null";
  if (value instanceof ArrayBuffer) {
    return value.detached
      ? "ArrayBuffer (detached)"
      : `ArrayBuffer(${value.byteLength})`;
  }
  if (seen.has(value)) return "[Circular]";
  seen.add(value);
  try {
    if (Array.isArray(value)) {
      return `[${dataEntries(value)
        .map(([, v]) => inspect(v, seen))
        .join(", ")}]`;
    }
    const entries = dataEntries(value).map(
      ([k, v]) => `${formatKey(k)}: ${inspect(v, seen)}`,
    );
    const proto: unknown = Object.getPrototypeOf(value);
    const name =
      proto === Object.prototype || proto === null
        ? ""
        : `${(proto as { constructor?: { name?: string } }).constructor?.name ?? "Object"} `;
    return entries.length === 0
      ? `${name}{}`
      : `${name}{ ${entries.join(", ")} }`;
  } finally {
    seen.delete(value);
  }
}

function dataEntries(obj: object): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc && "value" in desc) entries.push([key, desc.value]);
  }
  return entries;
}

function formatKey(key: string): string {
  return /^[A-Za-z_$][\w$]*$/.test(key) ? key : JSON.stringify(key);
}
