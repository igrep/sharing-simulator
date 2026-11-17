import {
  isTrackable,
  ownDataEntries,
  type InvalidReference,
  type SimulationResult,
  type ThreadName,
} from "./core.js";

const threadLabels: Record<ThreadName, string> = {
  main: "Main thread",
  worker: "Worker thread",
};

/** Build a mermaid flowchart of the object reference graph. */
export function buildMermaid(
  result: SimulationResult,
  invalidReferences: InvalidReference[],
): string {
  const objectIds = new Map<object, string>();
  const reachedBy = new Map<object, Set<ThreadName>>();
  const expanded = new Set<object>();
  const objectLines = new Map<object, string>();
  const varLines: Record<ThreadName, string[]> = { main: [], worker: [] };
  const edges: Array<{ line: string; to: object }> = [];
  const invalidObjects = new Set(invalidReferences.map((r) => r.object));

  const objectId = (obj: object): string => {
    let id = objectIds.get(obj);
    if (id === undefined) {
      id = `o${objectIds.size}`;
      objectIds.set(obj, id);
    }
    return id;
  };

  const addEdges = (
    fromId: string,
    value: unknown,
    thread: ThreadName,
    label: string | null,
  ): void => {
    const labelPart = label === null ? "" : `|"${escape(label)}"|`;
    if (isTrackable(value)) {
      edges.push({
        line: `${fromId} -->${labelPart} ${objectId(value)}`,
        to: value,
      });
      visit(value, thread);
    }
  };

  const describeObject = (obj: object): void => {
    if (objectLines.has(obj)) return;
    const head =
      obj instanceof ArrayBuffer
        ? obj.detached
          ? "ArrayBuffer (detached)"
          : `ArrayBuffer(${obj.byteLength})`
        : Array.isArray(obj)
          ? `Array(${obj.length})`
          : "Object";
    const props = ownDataEntries(obj)
      .filter(([, v]) => !isTrackable(v) && typeof v !== "function")
      .map(([k, v]) => escape(`${k}: ${repr(v)}`));
    objectLines.set(
      obj,
      `${objectId(obj)}["${[`<b>${escape(head)}</b>`, ...props].join("<br/>")}"]`,
    );
  };

  const visit = (obj: object, thread: ThreadName): void => {
    let threads = reachedBy.get(obj);
    if (threads === undefined) {
      threads = new Set();
      reachedBy.set(obj, threads);
    }
    if (threads.has(thread)) return;
    threads.add(thread);
    describeObject(obj);
    const shouldAddEdges = !expanded.has(obj);
    expanded.add(obj);
    for (const key of Object.keys(obj)) {
      const desc = Object.getOwnPropertyDescriptor(obj, key);
      const value: unknown = desc && "value" in desc ? desc.value : undefined;
      if (shouldAddEdges) {
        addEdges(objectId(obj), value, thread, key);
      } else if (isTrackable(value)) {
        visit(value, thread);
      }
    }
  };

  for (const thread of ["worker", "main"] as const) {
    const env = result[thread].env;
    const prefix = thread === "main" ? "vm" : "vw";
    Object.keys(env).forEach((name, i) => {
      const id = `${prefix}${i}`;
      const desc = Object.getOwnPropertyDescriptor(env, name);
      const value: unknown = desc && "value" in desc ? desc.value : undefined;
      if (typeof value === "function") return;
      const text = isTrackable(value) ? name : `${name} = ${repr(value)}`;
      varLines[thread].push(`${id}(["${escape(text)}"])`);
      addEdges(id, value, thread, null);
    });
  }

  // Not a reference: shows where the contents of a detached buffer went.
  const transferEdges: string[] = [];
  for (const [detached, received] of result.transfers) {
    if (objectIds.has(detached) && objectIds.has(received)) {
      transferEdges.push(
        `${objectId(detached)} -.->|"transferred to"| ${objectId(received)}`,
      );
    }
  }

  const lines = ["flowchart LR"];
  const objectsIn = (pred: (threads: Set<ThreadName>) => boolean): string[] =>
    [...objectLines]
      .filter(([obj]) => pred(reachedBy.get(obj) ?? new Set()))
      .map(([, line]) => line);
  for (const thread of ["worker", "main"] as const) {
    lines.push(`subgraph T_${thread}["${threadLabels[thread]}"]`);
    const inner = [
      ...varLines[thread],
      ...objectsIn((t) => t.size === 1 && t.has(thread)),
    ];
    lines.push(...(inner.length > 0 ? inner : [`E_${thread}[" "]`]));
    lines.push("end");
  }
  lines.push(...objectsIn((t) => t.size !== 1));
  lines.push(...edges.map((e) => e.line), ...transferEdges);

  lines.push(
    "classDef shared fill:#fff3bf,stroke:#e8a400",
    "classDef invalid fill:#ffe3e3,stroke:#e03131,color:#c92a2a",
    "classDef empty fill:none,stroke:none",
    "classDef detached fill:#f1f3f5,stroke:#adb5bd,color:#868e96,stroke-dasharray:4 2",
    // Fixed per thread so that the colors don't depend on the subgraph order
    "style T_main fill:#fdf4ff,stroke:#e879f9",
    "style T_worker fill:#f0fdfa,stroke:#2dd4bf",
  );
  for (const [obj, threads] of reachedBy) {
    if (invalidObjects.has(obj)) {
      lines.push(`class ${objectId(obj)} invalid`);
    } else if (obj instanceof ArrayBuffer && obj.detached) {
      lines.push(`class ${objectId(obj)} detached`);
    } else if (threads.size > 1) {
      lines.push(`class ${objectId(obj)} shared`);
    }
  }
  for (const thread of ["worker", "main"] as const) {
    if (!lines.includes(`E_${thread}[" "]`)) continue;
    lines.push(`class E_${thread} empty`);
  }
  edges.forEach((e, i) => {
    if (invalidObjects.has(e.to)) {
      lines.push(`linkStyle ${i} stroke:#e03131,stroke-width:2px`);
    }
  });
  return lines.join("\n");
}

function repr(value: unknown): string {
  if (typeof value === "string") {
    const s = JSON.stringify(value);
    return s.length > 24 ? `${s.slice(0, 22)}…"` : s;
  }
  if (typeof value === "bigint") return `${value}n`;
  return String(value);
}

function escape(text: string): string {
  return text
    .replaceAll("#", "#35;")
    .replaceAll('"', "#quot;")
    .replaceAll("<", "#lt;")
    .replaceAll(">", "#gt;");
}
