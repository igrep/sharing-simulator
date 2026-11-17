import van from "vanjs-core";
import {
  modeOptions,
  parseParams,
  toSearch,
  type ModeName,
  type Params,
} from "./params.js";

const { form, select, option, label, textarea, iframe } = van.tags;

const initial = parseParams(location.search);
const mode = van.state<ModeName>(initial.mode);
const mainCode = van.state(initial.main);
const workerCode = van.state(initial.worker);

const frame = iframe({
  src: `embedded.html${toSearch(initial)}`,
  title: "Simulation result",
}) as HTMLIFrameElement;

function currentParams(): Params {
  return { mode: mode.val, main: mainCode.val, worker: workerCode.val };
}

function push(): void {
  const search = toSearch(currentParams());
  history.replaceState(null, "", search); // Keep this page's URL shareable
  const win = frame.contentWindow;
  if (win === null) return;
  win.history.pushState(null, "", `embedded.html${search}`);
  win.dispatchEvent(new Event("locationchange"));
}

// Throttle: run at most once per `ms`, always including the last call.
function throttle(fn: () => void, ms: number): () => void {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pending = false;
  return () => {
    if (timer !== null) {
      pending = true;
      return;
    }
    fn();
    timer = setTimeout(function tick() {
      if (pending) {
        pending = false;
        fn();
        timer = setTimeout(tick, ms);
      } else {
        timer = null;
      }
    }, ms);
  };
}
const update = throttle(push, 200);

// Keep the form in sync when the user navigates the iframe's history.
frame.addEventListener("load", () => {
  frame.contentWindow?.addEventListener("popstate", () => {
    const params = parseParams(frame.contentWindow!.location.search);
    mode.val = params.mode;
    mainCode.val = params.main;
    workerCode.val = params.worker;
    history.replaceState(null, "", toSearch(params));
  });
});

const codeArea = (title: string, state: typeof mainCode) =>
  label(
    title,
    textarea({
      spellcheck: false,
      value: state,
      oninput: (e: Event) => {
        state.val = (e.target as HTMLTextAreaElement).value;
        update();
      },
    }),
  );

van.add(
  document.body,
  form(
    { onsubmit: (e: Event) => e.preventDefault() },
    select(
      {
        "aria-label": "Evaluation mode",
        onchange: (e: Event) => {
          mode.val = (e.target as HTMLSelectElement).value as ModeName;
          update();
        },
      },
      modeOptions.map((o) =>
        option(
          { value: o.value, selected: () => mode.val === o.value },
          o.label,
        ),
      ),
    ),
    codeArea("Main thread", mainCode),
    codeArea("Worker thread", workerCode),
  ),
  frame,
);
