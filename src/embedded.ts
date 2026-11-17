import van from "vanjs-core";
import mermaid from "mermaid";
import {
  evaluate,
  findInvalidReferences,
  type InvalidReference,
  type RealResult,
  type ThreadError,
} from "./core.js";
import { buildMermaid } from "./graph.js";
import { modeToEvaluationMode, parseParams } from "./params.js";

const { h2, li, ul, p } = van.tags;

mermaid.initialize({ startOnLoad: false });

const graphPane = document.getElementById("graph")!;
const errorsPane = document.getElementById("errors")!;

const errors = van.state<ThreadError[]>([]);
const invalidRefs = van.state<InvalidReference[]>([]);

van.add(
  errorsPane,
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

let previousRealResult: RealResult | null = null;
let renderCount = 0;

async function run(): Promise<void> {
  const params = parseParams(location.search);
  previousRealResult?.worker.terminate();
  previousRealResult = null;

  const collected: ThreadError[] = [];
  const count = ++renderCount;
  const isCurrent = (): boolean => count === renderCount;
  const result = evaluate(
    params.main,
    params.worker,
    modeToEvaluationMode[params.mode],
    (e) => {
      if (!isCurrent()) return;
      collected.push(e);
      errors.val = [...collected];
    },
  );
  errors.val = [...collected];

  if (result.kind === "real") {
    previousRealResult = result;
    invalidRefs.val = [];
    graphPane.replaceChildren(
      p(
        { class: "note" },
        "The graph is not available when running real worker code. See the console for logs.",
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
