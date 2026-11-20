import {
  parse,
  type Expression,
  type Node,
  type Pattern,
  type Program,
  type SourceLocation,
  type Statement,
  type ModuleDeclaration,
  type Property,
  type SpreadElement,
  type PrivateIdentifier,
  type Super,
  type BlockStatement,
  type FunctionExpression,
  type ArrowFunctionExpression,
} from "acorn";
import { generate } from "astring";
import { formatLogArgs } from "./format.js";

export type Environment = Record<string, any>;

export type ThreadName = "main" | "worker";

export interface SimulatedWorker {
  postMessage(
    message: any,
    transferOrOptions?: unknown,
    transfer?: unknown,
  ): void;
}

const envArgName = "$ENV" as const;
const trackerArgName = "$TRACKER" as const;
const consoleArgName = "$CONSOLE" as const;
export const threadIds: Record<ThreadName, symbol> = {
  main: Symbol("main"),
  worker: Symbol("worker"),
};

export const EvaluationMode = {
  SIMULATE_TRANSFER: 1,
  SIMULATE_SHARING: 2,
  RUN_REAL_WORKER: 3,
} as const;

export type EvaluationMode =
  (typeof EvaluationMode)[keyof typeof EvaluationMode];

export interface ThreadError {
  thread: ThreadName;
  error: unknown;
}

export interface ThreadLog {
  thread: ThreadName;
  /** The arguments of `console.log`, formatted when it was called */
  text: string;
}

export interface Reporters {
  reportError: (error: ThreadError) => void;
  reportLog: (log: ThreadLog) => void;
}

export interface ThreadState {
  env: Environment;
  tracker: Tracker;
}

export interface SimulationResult {
  kind: "simulation";
  main: ThreadState;
  worker: ThreadState;
  /** Transferred (now detached) buffers → the new buffers the receiver got */
  transfers: Map<ArrayBuffer, ArrayBuffer>;
}

export interface RealResult {
  kind: "real";
  /** Stop the worker and its `console.log` forwarding */
  terminate: () => void;
}

/**
 * Evaluate the given code. Errors and `console.log` outputs (including the
 * ones produced asynchronously by a real worker) are reported through
 * `reporters`.
 */
export function evaluate(
  mainCode: string,
  workerCode: string,
  mode: EvaluationMode,
  reporters: Reporters,
): SimulationResult | RealResult {
  const { reportError } = reporters;
  if (mode === EvaluationMode.RUN_REAL_WORKER) {
    return runRealWorker(mainCode, workerCode, reporters);
  }

  const worker: ThreadState = {
    env: {},
    tracker: new Tracker(threadIds.worker),
  };
  const main: ThreadState = {
    env: {},
    tracker: new Tracker(threadIds.main),
  };
  const transfers = new Map<ArrayBuffer, ArrayBuffer>();
  Object.defineProperty(main.env, "worker", {
    value: createSimulatedWorker(
      worker,
      mode === EvaluationMode.SIMULATE_TRANSFER ? transfers : null,
      reportError,
    ),
    enumerable: false, // Not shown in the graph
  });

  runSimulatedThread("worker", workerCode, worker, reporters);
  runSimulatedThread("main", mainCode, main, reporters);

  collectAndMarkUnused(main.env, main.tracker);
  collectAndMarkUnused(worker.env, worker.tracker);
  return { kind: "simulation", main, worker, transfers };
}

function runSimulatedThread(
  thread: ThreadName,
  code: string,
  state: ThreadState,
  { reportError, reportLog }: Reporters,
): void {
  try {
    const src = transformWithDebug(thread, code);
    const fn = new Function(
      envArgName,
      trackerArgName,
      consoleArgName,
      `"use strict";${src}`,
    );
    fn(
      createEnvProxy(state.env),
      state.tracker,
      createConsole(thread, reportLog),
    );
  } catch (error) {
    reportError({ thread, error });
  }
}

function createConsole(
  thread: ThreadName,
  reportLog: (log: ThreadLog) => void,
): { log: (...args: unknown[]) => void } {
  return {
    log: (...args) => reportLog({ thread, text: formatLogArgs(args) }),
  };
}

/** Make reading an undefined variable a ReferenceError, like real JS. */
function createEnvProxy(env: Environment): Environment {
  return new Proxy(env, {
    get(target, key, receiver) {
      if (typeof key === "string" && !(key in target)) {
        throw new ReferenceError(`${key} is not defined`);
      }
      return Reflect.get(target, key, receiver);
    },
  });
}

/**
 * Prepended to the real worker code to forward `console.log` to the main
 * thread through a dedicated `MessagePort`, which is the first message the
 * worker receives. Kept in a single line not to shift the line numbers in
 * error messages.
 */
const realWorkerPrelude = `(() => {
  const clone = (a) => { try { return structuredClone(a); } catch { try { return String(a); } catch { return Object.prototype.toString.call(a); } } };
  let port = null;
  const queue = [];
  self.console = { log: (...args) => { const cloned = args.map(clone); if (port) port.postMessage(cloned); else queue.push(cloned); } };
  self.addEventListener("message", function receivePort(e) {
    e.stopImmediatePropagation();
    self.removeEventListener("message", receivePort);
    port = e.ports[0];
    for (const args of queue.splice(0)) port.postMessage(args);
  });
})();`.replace(/\n\s*/g, " ");

function runRealWorker(
  mainCode: string,
  workerCode: string,
  { reportError, reportLog }: Reporters,
): RealResult {
  try {
    checkConsoleUsage(workerCode);
  } catch (error) {
    reportError({ thread: "worker", error });
    workerCode = "";
  }
  const url = URL.createObjectURL(
    new Blob([realWorkerPrelude, workerCode], {
      type: "application/javascript",
    }),
  );
  const worker = new Worker(url);
  URL.revokeObjectURL(url);
  const channel = new MessageChannel();
  channel.port1.onmessage = (event: MessageEvent<unknown[]>) => {
    reportLog({ thread: "worker", text: formatLogArgs(event.data) });
  };
  worker.postMessage(null, [channel.port2]);
  worker.addEventListener("error", (event) => {
    event.preventDefault();
    reportError({
      thread: "worker",
      error: new Error(`${event.message} (line ${event.lineno})`),
    });
  });
  worker.addEventListener("messageerror", () => {
    reportError({
      thread: "main",
      error: new Error("Received a message that cannot be deserialized"),
    });
  });
  try {
    checkConsoleUsage(mainCode);
    new Function("worker", "console", `"use strict";${mainCode}`)(
      worker,
      createConsole("main", reportLog),
    );
  } catch (error) {
    reportError({ thread: "main", error });
  }
  return {
    kind: "real",
    terminate: () => {
      worker.terminate();
      channel.port1.close();
    },
  };
}

/**
 * The real worker code isn't transformed, so check statically that only
 * `console.log` is used. Unparsable code is left to the JS engine to report.
 */
function checkConsoleUsage(code: string): void {
  let program: Program;
  try {
    program = parse(code, { ecmaVersion: "latest", locations: true });
  } catch {
    return;
  }
  const walk = (node: unknown): void => {
    if (Array.isArray(node)) {
      node.forEach(walk);
      return;
    }
    if (!isTrackable(node) || !("type" in node)) return;
    const n = node as Node;
    if (n.type === "MemberExpression") {
      const { object, property, computed } = n as unknown as {
        object: Node;
        property: Node;
        computed: boolean;
      };
      if (
        object.type === "Identifier" &&
        (object as unknown as { name: string }).name === "console"
      ) {
        assertConsoleLog(property, computed, n.loc);
      }
    }
    for (const [key, value] of Object.entries(node)) {
      if (key !== "loc") walk(value);
    }
  };
  walk(program);
}

function assertConsoleLog(
  property: Node,
  computed: boolean,
  loc: SourceLocation | null | undefined,
): void {
  const name =
    !computed && property.type === "Identifier"
      ? (property as unknown as { name: string }).name
      : null;
  if (name !== "log") {
    throw new UnsupportedSyntaxError(
      `console.${name ?? "[...]"} (only console.log is supported)`,
      loc,
    );
  }
}

// ---------------------------------------------------------------------------
// Tracker

export type ObjectId = number;

export function isTrackable(value: unknown): value is object {
  return typeof value === "object" && value !== null;
}

/**
 * Own enumerable string-keyed *data* properties. Accessor properties are
 * skipped so that inspecting objects never runs user code.
 */
export function ownDataEntries(obj: object): Array<[string, unknown]> {
  const entries: Array<[string, unknown]> = [];
  for (const key of Object.keys(obj)) {
    const desc = Object.getOwnPropertyDescriptor(obj, key);
    if (desc && "value" in desc) {
      entries.push([key, desc.value]);
    }
  }
  return entries;
}

export class Tracker {
  #objectIdCounter = 0;

  #trackedObjects = new Set<ObjectId>();
  #unusedObjects = new Set<ObjectId>();

  // We may not need to track strings.
  #trackedValues = new Set<string>();
  #unusedValues = new Set<string>();
  threadId: symbol;

  constructor(threadId: symbol) {
    this.threadId = threadId;
  }

  idOf(value: object): ObjectId | undefined {
    return (value as Record<symbol, ObjectId>)[this.threadId];
  }

  track<T>(value: T): T {
    if (isTrackable(value)) {
      if (this.idOf(value) === undefined) {
        const objectId = this.#objectIdCounter++;
        (value as Record<symbol, ObjectId>)[this.threadId] = objectId;
        this.#trackedObjects.add(objectId);
        for (const [, childValue] of ownDataEntries(value)) {
          this.track(childValue);
        }
      }
    } else if (typeof value === "string") {
      this.#trackedValues.add(value);
    }
    return value;
  }

  replace(
    newTrackedObjects: Set<ObjectId>,
    newTrackedValues: Set<string>,
  ): void {
    this.#unusedObjects = this.#unusedObjects.union(
      this.#trackedObjects.difference(newTrackedObjects),
    );
    this.#trackedObjects = newTrackedObjects;

    this.#unusedValues = this.#trackedValues.difference(newTrackedValues);
    this.#trackedValues = newTrackedValues;
  }

  hasMarkedUnused(objectIdOrValue: ObjectId | string): boolean {
    if (typeof objectIdOrValue === "number") {
      return this.#unusedObjects.has(objectIdOrValue);
    } else if (typeof objectIdOrValue === "string") {
      return this.#unusedValues.has(objectIdOrValue);
    }
    return false;
  }
}

export function collectAndMarkUnused(
  environment: Environment,
  tracker: Tracker,
): void {
  const reachableObjects = new Set<ObjectId>();
  const reachableValues = new Set<string>();
  const visited = new Set<object>();
  function go(subEnv: object): void {
    for (const [, value] of ownDataEntries(subEnv)) {
      if (isTrackable(value)) {
        if (visited.has(value)) continue;
        visited.add(value);
        reachableObjects.add(tracker.idOf(tracker.track(value))!);
        go(value);
      } else if (typeof value === "string") {
        reachableValues.add(value);
      }
    }
  }
  go(environment);
  tracker.replace(reachableObjects, reachableValues);
}

export interface InvalidReference {
  /** The thread holding the reference */
  thread: ThreadName;
  /** Path from the thread's variables, e.g. `received.buf` */
  path: string;
  object: object;
}

/**
 * Find objects reachable from one thread that the counterpart thread has
 * marked unused (i.e. it would have been freed there).
 */
export function findInvalidReferences(
  result: SimulationResult,
): InvalidReference[] {
  const found: InvalidReference[] = [];
  const check = (thread: ThreadName, counterpart: ThreadState): void => {
    const visited = new Set<object>();
    const go = (obj: object, path: string): void => {
      for (const [key, value] of ownDataEntries(obj)) {
        if (!isTrackable(value) || visited.has(value)) continue;
        visited.add(value);
        const childPath = path === "" ? key : `${path}.${key}`;
        const id = counterpart.tracker.idOf(value);
        if (id !== undefined && counterpart.tracker.hasMarkedUnused(id)) {
          found.push({ thread, path: childPath, object: value });
        }
        go(value, childPath);
      }
    };
    go(result[thread].env, "");
  };
  check("main", result.worker);
  check("worker", result.main);
  return found;
}

// ---------------------------------------------------------------------------
// Simulated worker

/**
 * @param transfers When non-null, simulate transferring: transferred buffers
 *   are detached exactly like the real `postMessage` does, and the pairs of
 *   (detached buffer, buffer received by the worker) are recorded in it.
 *   When null, simulate sharing: the worker receives the very same buffers.
 */
function createSimulatedWorker(
  worker: ThreadState,
  transfers: Map<ArrayBuffer, ArrayBuffer> | null,
  reportError: (error: ThreadError) => void,
): SimulatedWorker {
  const deliver = (data: unknown): void => {
    try {
      worker.env.onmessage?.({ data: worker.tracker.track(data) });
    } catch (error) {
      reportError({ thread: "worker", error });
    }
  };
  return {
    postMessage(message: any, transferOrOptions?: unknown, transfer?: unknown) {
      // Accept both `Worker#postMessage(message, transfer | { transfer })` and
      // `Window#postMessage(message, targetOrigin, transfer)` style.
      const transferList = normalizeTransferList(transferOrOptions, transfer);

      if (transfers !== null) {
        // Use the real structured clone algorithm. Cloning the transfer list
        // together tells which new buffer corresponds to which original one.
        const { data, list } = structuredClone(
          { data: message, list: transferList },
          { transfer: transferList as Transferable[] },
        );
        transferList.forEach((original, i) => {
          transfers.set(original as ArrayBuffer, list[i] as ArrayBuffer);
        });
        deliver(data);
        return;
      }

      for (const value of transferList) {
        if (!(value instanceof ArrayBuffer)) {
          throw new TypeError(
            `Only ArrayBuffer can be transferred, but got ${describeType(value)}`,
          );
        }
      }

      const clones = new Map<object, unknown>();
      const cloneMessage = (value: unknown): unknown => {
        if (typeof value === "function") {
          throw new DOMException(
            "A function could not be cloned",
            "DataCloneError",
          );
        }
        if (!isTrackable(value)) return value;
        if (clones.has(value)) return clones.get(value);
        if (value instanceof ArrayBuffer) {
          // Shared buffers keep their identity.
          const copied = transferList.includes(value) ? value : value.slice(0);
          clones.set(value, copied);
          return copied;
        }
        if (Array.isArray(value)) {
          const cloned: unknown[] = [];
          clones.set(value, cloned);
          for (const v of value) cloned.push(cloneMessage(v));
          return cloned;
        }
        const cloned: Record<string, unknown> = {};
        clones.set(value, cloned);
        for (const [key, v] of Object.entries(value)) {
          cloned[key] = cloneMessage(v);
        }
        return cloned;
      };
      deliver(cloneMessage(message));
    },
  };
}

function normalizeTransferList(
  transferOrOptions: unknown,
  transfer: unknown,
): object[] {
  const list = Array.isArray(transferOrOptions)
    ? transferOrOptions
    : isTrackable(transferOrOptions) && "transfer" in transferOrOptions
      ? transferOrOptions.transfer
      : transfer;
  if (list == null) return [];
  if (!Array.isArray(list)) {
    throw new TypeError("The transfer list must be an array");
  }
  return list;
}

function describeType(value: unknown): string {
  if (isTrackable(value)) return value.constructor?.name ?? "Object";
  return typeof value;
}

// ---------------------------------------------------------------------------
// Transformation
//
// Only a small subset of JavaScript is supported:
// - Statements: variable declarations and expression statements.
// - Expressions: literals, variable references, member access, array and
//   object literals, assignments (`=` only), unary/binary/logical operators,
//   `new ArrayBuffer(...)`, `worker.postMessage(...)`, `console.log(...)`, and
//   a function assigned to `onmessage`.
// Every top-level variable `x` is turned into `$ENV.x`, and every assigned
// value is wrapped with `$TRACKER.track(...)`, and `console.log(...)` is turned
// into `$CONSOLE.log(...)`.

const globalNames = new Set(["undefined", "ArrayBuffer"]);

interface Scope {
  thread: ThreadName;
  /** Local variable names (only inside the `onmessage` handler) */
  locals: Set<string> | null;
}

export function transformWithDebug(name: ThreadName, code: string): string {
  const transformed = transform(
    parse(code, { ecmaVersion: 2022, sourceType: "script", locations: true }),
    name,
  );
  console.debug(`AFTER transform ${name}:\n${generate(transformed)}`);
  return generate(transformed);
}

export function transform(program: Program, thread: ThreadName): Program {
  const scope: Scope = { thread, locals: null };
  return {
    ...program,
    body: program.body.flatMap((s) => transformStatement(s, scope)),
  };
}

function transformStatement(
  statement: Statement | ModuleDeclaration,
  scope: Scope,
): Statement[] {
  switch (statement.type) {
    case "EmptyStatement":
      return [];
    case "ExpressionStatement":
      return [
        {
          ...statement,
          expression: transformExpression(statement.expression, scope),
        },
      ];
    case "VariableDeclaration":
      if (scope.locals !== null) {
        // Local variables in the handler: keep them local.
        return [
          {
            ...statement,
            declarations: statement.declarations.map((declarator) => {
              const name = identifierName(declarator.id);
              const init = declarator.init
                ? transformExpression(declarator.init, scope)
                : null;
              scope.locals!.add(name);
              return { ...declarator, init };
            }),
          },
        ];
      }
      return statement.declarations.map((declarator): Statement => {
        const name = identifierName(declarator.id);
        const init: Expression = declarator.init
          ? transformExpression(declarator.init, scope)
          : identifier("undefined", declarator);
        return {
          type: "ExpressionStatement",
          start: declarator.start,
          end: declarator.end,
          expression: {
            type: "AssignmentExpression",
            start: declarator.start,
            end: declarator.end,
            operator: "=",
            left: envMember(name, declarator.id),
            right: wrapWithTrackerCall(init),
          },
        };
      });
    default:
      throw new UnsupportedSyntaxError(statement.type, statement.loc);
  }
}

function identifierName(pattern: Pattern): string {
  if (pattern.type !== "Identifier") {
    throw new UnsupportedSyntaxError(
      `${pattern.type} in variable declaration`,
      pattern.loc,
    );
  }
  return pattern.name;
}

function transformExpression(expression: Expression, scope: Scope): Expression {
  const recur = (e: Expression): Expression => transformExpression(e, scope);
  switch (expression.type) {
    case "Literal":
      if ("regex" in expression || "bigint" in expression) {
        throw new UnsupportedSyntaxError(
          "RegExp or BigInt literal",
          expression.loc,
        );
      }
      return expression;
    case "Identifier":
      if (
        scope.locals?.has(expression.name) ||
        globalNames.has(expression.name)
      ) {
        return expression;
      }
      if (expression.name === "console") {
        throw new UnsupportedSyntaxError(
          "Referring to `console` other than calling `console.log(...)`",
          expression.loc,
        );
      }
      return envMember(expression.name, expression);
    case "MemberExpression":
      if (expression.object.type === "Super") {
        throw new UnsupportedSyntaxError("super", expression.loc);
      }
      return {
        ...expression,
        object: recur(expression.object),
        property: expression.computed
          ? recur(asExpression(expression.property))
          : expression.property,
      };
    case "AssignmentExpression": {
      if (expression.operator !== "=") {
        throw new UnsupportedSyntaxError(
          `Assignment operator '${expression.operator}'`,
          expression.loc,
        );
      }
      const { left, right } = expression;
      if (left.type === "Identifier" && left.name === "onmessage") {
        if (scope.thread !== "worker" || scope.locals !== null) {
          throw new UnsupportedSyntaxError(
            "Assigning 'onmessage' outside the top level of the worker code",
            expression.loc,
          );
        }
        if (
          right.type !== "ArrowFunctionExpression" &&
          right.type !== "FunctionExpression"
        ) {
          throw new UnsupportedSyntaxError(
            `'onmessage' must be assigned a function, but got ${right.type}`,
            right.loc,
          );
        }
        return {
          ...expression,
          left: envMember("onmessage", left),
          right: transformHandler(right, scope),
        };
      }
      if (left.type !== "Identifier" && left.type !== "MemberExpression") {
        throw new UnsupportedSyntaxError(
          `${left.type} as the left operand of assignment`,
          left.loc,
        );
      }
      const newLeft = recur(left) as typeof left;
      const isLocal = left.type === "Identifier" && newLeft === left;
      return {
        ...expression,
        left: newLeft,
        right: isLocal ? recur(right) : wrapWithTrackerCall(recur(right)),
      };
    }
    case "ArrayExpression":
      return {
        ...expression,
        elements: expression.elements.map((element) => {
          if (element == null || element.type === "SpreadElement") {
            throw new UnsupportedSyntaxError(
              element ? "Spread element" : "Array hole",
              element?.loc ?? expression.loc,
            );
          }
          return recur(element);
        }),
      };
    case "ObjectExpression":
      return {
        ...expression,
        properties: expression.properties.map((property): Property => {
          if (
            property.type !== "Property" ||
            property.kind !== "init" ||
            property.method
          ) {
            throw new UnsupportedSyntaxError(
              "Object literal property other than `key: value`",
              property.loc,
            );
          }
          return {
            ...property,
            shorthand: false,
            key: property.computed
              ? recur(asExpression(property.key))
              : property.key,
            value: recur(property.value as Expression),
          };
        }),
      };
    case "UnaryExpression":
      if (expression.operator === "delete") {
        throw new UnsupportedSyntaxError("delete", expression.loc);
      }
      return { ...expression, argument: recur(expression.argument) };
    case "BinaryExpression":
      return {
        ...expression,
        left: recur(asExpression(expression.left)),
        right: recur(expression.right),
      };
    case "LogicalExpression":
      return {
        ...expression,
        left: recur(expression.left),
        right: recur(expression.right),
      };
    case "ConditionalExpression":
      return {
        ...expression,
        test: recur(expression.test),
        consequent: recur(expression.consequent),
        alternate: recur(expression.alternate),
      };
    case "CallExpression": {
      const { callee } = expression;
      if (
        callee.type === "MemberExpression" &&
        callee.object.type === "Identifier" &&
        callee.object.name === "console" &&
        !scope.locals?.has("console")
      ) {
        assertConsoleLog(callee.property, callee.computed, callee.loc);
        return {
          ...expression,
          callee: {
            ...callee,
            object: identifier(consoleArgName, callee.object),
          },
          arguments: expression.arguments.map((arg) => recur(notSpread(arg))),
        };
      }
      const isAllowed =
        callee.type === "MemberExpression" &&
        !callee.computed &&
        callee.object.type === "Identifier" &&
        callee.property.type === "Identifier" &&
        scope.thread === "main" &&
        callee.object.name === "worker" &&
        callee.property.name === "postMessage";
      if (!isAllowed) {
        throw new UnsupportedSyntaxError(
          "Function call other than `worker.postMessage(...)` (main thread only) or `console.log(...)`",
          expression.loc,
        );
      }
      return {
        ...expression,
        callee: recur(callee as Expression),
        arguments: expression.arguments.map((arg) => recur(notSpread(arg))),
      };
    }
    case "NewExpression":
      if (
        expression.callee.type !== "Identifier" ||
        expression.callee.name !== "ArrayBuffer"
      ) {
        throw new UnsupportedSyntaxError(
          "`new` other than `new ArrayBuffer(...)`",
          expression.loc,
        );
      }
      return {
        ...expression,
        arguments: expression.arguments.map((arg) => recur(notSpread(arg))),
      };
    default:
      throw new UnsupportedSyntaxError(expression.type, expression.loc);
  }
}

function transformHandler(
  fn: ArrowFunctionExpression | FunctionExpression,
  scope: Scope,
): ArrowFunctionExpression | FunctionExpression {
  const locals = new Set(fn.params.map(identifierName));
  const innerScope: Scope = { thread: scope.thread, locals };
  if (fn.body.type !== "BlockStatement") {
    return {
      ...fn,
      body: transformExpression(fn.body, innerScope),
    } as ArrowFunctionExpression;
  }
  const body: BlockStatement = {
    ...fn.body,
    body: fn.body.body.flatMap((s) => transformStatement(s, innerScope)),
  };
  return { ...fn, body } as typeof fn;
}

function asExpression(
  node: Expression | PrivateIdentifier | Super,
): Expression {
  if (node.type === "PrivateIdentifier" || node.type === "Super") {
    throw new UnsupportedSyntaxError(node.type, node.loc);
  }
  return node;
}

function notSpread(node: Expression | SpreadElement): Expression {
  if (node.type === "SpreadElement") {
    throw new UnsupportedSyntaxError("Spread element", node.loc);
  }
  return node;
}

function identifier(name: string, at: Node): Expression {
  return { type: "Identifier", name, start: at.start, end: at.end };
}

function envMember(name: string, at: Node): Expression & Pattern {
  return {
    type: "MemberExpression",
    start: at.start,
    end: at.end,
    object: {
      type: "Identifier",
      name: envArgName,
      start: at.start,
      end: at.end,
    },
    property: { type: "Identifier", name, start: at.start, end: at.end },
    computed: false,
    optional: false,
  };
}

export function wrapWithTrackerCall(expression: Expression): Expression {
  const at = { start: expression.start, end: expression.end };
  return {
    type: "CallExpression",
    ...at,
    callee: {
      type: "MemberExpression",
      ...at,
      object: { type: "Identifier", name: trackerArgName, ...at },
      property: { type: "Identifier", name: "track", ...at },
      computed: false,
      optional: false,
    },
    arguments: [expression],
    optional: false,
  };
}

export class UnsupportedSyntaxError extends Error {
  constructor(nodeInfo: string, loc: SourceLocation | null | undefined) {
    const line = loc?.start.line ?? "unknown";
    const column = loc?.start.column ?? "unknown";
    super(`Unsupported syntax: ${nodeInfo} at line ${line}, column ${column}`);
    this.name = "UnsupportedSyntaxError";
  }
}
