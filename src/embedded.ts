import van from "vanjs-core";
import mermaid from "mermaid";
import {
  evaluate,
  findInvalidReferences,
  type InvalidReference,
  type RealResult,
  type ThreadError,
  type ThreadLog,
  type ThreadName,
} from "./core.js";
import { buildMermaid } from "./graph.js";
import {
  defaultTabFor,
  modeToEvaluationMode,
  parseParams,
  parseTab,
  tabNames,
  type ModeName,
  type TabName,
} from "./params.js";

const { button, h2, li, ol, ul, p, span } = van.tags;

mermaid.initialize({ startOnLoad: false });

const tabsBar = document.getElementById("tabs")!;
const panels: Record<TabName, HTMLElement> = {
  graph: document.getElementById("graph")!,
  errors: document.getElementById("errors")!,
  console: document.getElementById("console")!,
};
const graphPane = panels.graph;
const [mainLogPane, workerLogPane] = panels.console.querySelectorAll("section");

const errors = van.state<ThreadError[]>([]);
const invalidRefs = van.state<InvalidReference[]>([]);
const logs = van.state<ThreadLog[]>([]);

// ---------------------------------------------------------------------------
// Tabs

const initialParams = parseParams(location.search);
const activeTab = van.state<TabName>(
  parseTab(location.search) ?? defaultTabFor(initialParams.mode),
);
let previousMode: ModeName = initialParams.mode;

const tabLabels: Record<TabName, string> = {
  graph: "Graph",
  errors: "Errors",
  console: "Console",
};

const errorCount = van.derive(() => errors.val.length + invalidRefs.val.length);

function badge(count: () => number) {
  return () => (count() === 0 ? span() : span({ class: "badge" }, count()));
}

const tabBadges: Partial<Record<TabName, () => Node>> = {
  errors: badge(() => errorCount.val),
  console: badge(() => logs.val.length),
};

function selectTab(tab: TabName, focus = false): void {
  activeTab.val = tab;
  if (focus) document.getElementById(`tab-${tab}`)?.focus();
}

// Arrow keys move between tabs, as recommended for the ARIA tabs pattern.
function onTabKeyDown(e: KeyboardEvent): void {
  const i = tabNames.indexOf(activeTab.val);
  const next =
    e.key === "ArrowRight"
      ? tabNames[(i + 1) % tabNames.length]
      : e.key === "ArrowLeft"
        ? tabNames[(i - 1 + tabNames.length) % tabNames.length]
        : e.key === "Home"
          ? tabNames[0]
          : e.key === "End"
            ? tabNames[tabNames.length - 1]
            : null;
  if (next === null || next === undefined) return;
  e.preventDefault();
  selectTab(next, true);
}

van.add(
  tabsBar,
  tabNames.map((tab) =>
    button(
      {
        id: `tab-${tab}`,
        type: "button",
        role: "tab",
        "aria-controls": tab,
        "aria-selected": () => String(activeTab.val === tab),
        tabindex: () => (activeTab.val === tab ? "0" : "-1"),
        class: () =>
          tab === "errors" && errorCount.val > 0 ? "has-errors" : "",
        onclick: () => selectTab(tab),
        onkeydown: onTabKeyDown,
      },
      tabLabels[tab],
      tabBadges[tab] ?? null,
    ),
  ),
);

van.derive(() => {
  for (const tab of tabNames) panels[tab].hidden = activeTab.val !== tab;
});

/** Show the console by default for real workers since there's no graph. */
function updateTabForMode(mode: ModeName): void {
  if (mode === previousMode) return;
  if (mode === "real") {
    activeTab.val = "console";
  } else if (previousMode === "real" && activeTab.val === "console") {
    activeTab.val = defaultTabFor(mode);
  }
  previousMode = mode;
}

// ---------------------------------------------------------------------------
// Errors tab

van.add(
  panels.errors,
  () =>
    ul(
      errors.val.length === 0
        ? li({ class: "note" }, "No errors")
        : errors.val.map(({ thread, error }) =>
            li({ class: "err" }, `[${thread}] ${formatError(error)}`),
          ),
    ),
  () =>
    invalidRefs.val.length === 0
      ? ul()
      : ul(
          h2("Invalid references"),
          invalidRefs.val.map(({ thread, path }) =>
            li(
              { class: "err" },
              `[${thread}] '${path}' refers to an object freed by the ${
                thread === "main" ? "worker" : "main"
              } thread`,
            ),
          ),
        ),
);

function formatError(error: unknown): string {
  return error instanceof Error
    ? `${error.name}: ${error.message}`
    : String(error);
}

// ---------------------------------------------------------------------------
// Console tab

const logList = (thread: ThreadName) => () => {
  const lines = logs.val.filter((l) => l.thread === thread);
  return lines.length === 0
    ? p({ class: "note" }, "No output")
    : ol(
        { class: "logs" },
        lines.map(({ text }) => li(text)),
      );
};
van.add(mainLogPane!, logList("main"));
van.add(workerLogPane!, logList("worker"));

// ---------------------------------------------------------------------------
// Evaluation

let previousRealResult: RealResult | null = null;
let renderCount = 0;

async function run(): Promise<void> {
  const params = parseParams(location.search);
  updateTabForMode(params.mode);
  previousRealResult?.terminate();
  previousRealResult = null;

  const collectedErrors: ThreadError[] = [];
  const collectedLogs: ThreadLog[] = [];
  const count = ++renderCount;
  const isCurrent = (): boolean => count === renderCount;
  const result = evaluate(
    params.main,
    params.worker,
    modeToEvaluationMode[params.mode],
    {
      reportError: (e) => {
        if (!isCurrent()) return;
        collectedErrors.push(e);
        errors.val = [...collectedErrors];
      },
      reportLog: (log) => {
        if (!isCurrent()) return;
        collectedLogs.push(log);
        logs.val = [...collectedLogs];
      },
    },
  );
  errors.val = [...collectedErrors];
  logs.val = [...collectedLogs];

  if (result.kind === "real") {
    previousRealResult = result;
    invalidRefs.val = [];
    graphPane.replaceChildren(
      p(
        { class: "note" },
        "The graph is not available when running real worker code. See the Console tab for logs.",
      ),
    );
    return;
  }

  const invalid = findInvalidReferences(result);
  invalidRefs.val = invalid;
  const source = buildMermaid(result, invalid);
  try {
    const { svg } = await mermaid.render(`graph${count}`, source);
    if (isCurrent()) graphPane.innerHTML = svg;
  } catch (error) {
    console.error(source);
    if (isCurrent()) {
      graphPane.replaceChildren(p({ class: "err" }, formatError(error)));
    }
  }
}

// `popstate` for history navigation; `locationchange` is dispatched by the
// parent page after it `pushState`s new parameters.
addEventListener("popstate", run);
addEventListener("locationchange", run);
run();
