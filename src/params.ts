import { EvaluationMode } from "./core.js";

export const modeOptions = [
  { value: "transfer", label: "Simulate Transferring `ArrayBuffer`" },
  {
    value: "share",
    label: "Simulate Sharing `ArrayBuffer` (Not transferring ownership)",
  },
  { value: "real", label: "Run real worker code (Not simulating)" },
] as const;

export type ModeName = (typeof modeOptions)[number]["value"];

export const modeToEvaluationMode: Record<ModeName, EvaluationMode> = {
  transfer: EvaluationMode.SIMULATE_TRANSFER,
  share: EvaluationMode.SIMULATE_SHARING,
  real: EvaluationMode.RUN_REAL_WORKER,
};

export interface Params {
  mode: ModeName;
  main: string;
  worker: string;
}

export const defaultParams: Params = {
  mode: "share",
  main: `let buf = new ArrayBuffer(8);
worker.postMessage({ buf: buf }, [buf]);
buf = null;
`,
  worker: `let received = null;
onmessage = (e) => {
  received = e.data;
};
`,
};

export function parseParams(search: string): Params {
  const q = new URLSearchParams(search);
  const mode = q.get("mode");
  return {
    mode: modeOptions.some((o) => o.value === mode)
      ? (mode as ModeName)
      : defaultParams.mode,
    main: q.get("main") ?? defaultParams.main,
    worker: q.get("worker") ?? defaultParams.worker,
  };
}

export function toSearch(params: Params): string {
  return `?${new URLSearchParams({ ...params })}`;
}

export const tabNames = ["graph", "errors", "console"] as const;

export type TabName = (typeof tabNames)[number];

/**
 * The `tab` query parameter of embedded.html: the tab shown on load. Not
 * included in `Params` because index.html doesn't set it.
 */
export function parseTab(search: string): TabName | null {
  const tab = new URLSearchParams(search).get("tab");
  return tabNames.find((t) => t === tab) ?? null;
}

export function defaultTabFor(mode: ModeName): TabName {
  return mode === "real" ? "console" : "graph";
}
