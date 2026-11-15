import {
  parse,
  type ArrowFunctionExpression,
  type Expression,
  type Identifier,
  type ModuleDeclaration,
  type Node,
  type PrivateIdentifier,
  type Program,
  type SourceLocation,
  type Statement,
  type Super,
  type VariableDeclarator,
} from "acorn";
import { generate } from "astring";

type Environment = Record<string, any>;

export interface MainEnvironment extends Environment {
  worker: SimulatedWorker;
}

export interface SimulatedWorker {
  postMessage(message: any, _targetOrigin_ignored: null, transfer: any[]): void;
}

const envArgName = "$ENV" as const;
const workerThreadId = Symbol("worker");
const mainThreadId = Symbol("main");
const trackerArgName = "$TRACKER" as const;

export async function evaluate(
  mainCode: string,
  workerCode: string,
): Promise<void> {
  const minifiedSourceWorker = transformWithDebug("worker", workerCode);
  const modWorker = await importModuleFromJsSrc(
    `export default function(${envArgName}, ${trackerArgName}) { ${minifiedSourceWorker} }`,
  );
  const workerEnvironment = {};
  const workerTracker = new Tracker(workerThreadId);
  modWorker.default(workerEnvironment, workerTracker);

  const minifiedSourceMain = transformWithDebug("main", mainCode);
  const modMain = await importModuleFromJsSrc(
    `export default function(${envArgName}, ${trackerArgName}) { ${minifiedSourceMain} }`,
  );
  const mainTracker = new Tracker(mainThreadId);
  modMain.default(
    createMainEnvironment(workerEnvironment, workerTracker, mainTracker),
    workerTracker,
  );
}

export type ObjectId = number;

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

  track<T>(value: T): T {
    if (typeof value === "object" && value !== null) {
      const objectId = this.#objectIdCounter++;
      if ((value as Record<symbol, ObjectId>)[this.threadId] !== undefined) {
        (value as Record<symbol, ObjectId>)[this.threadId] = objectId;
        this.#trackedObjects.add(objectId);
        for (const childValue of Object.values(value)) {
          this.track(childValue);
        }
      }
    } else if (typeof value === "string") {
      this.#trackedValues.add(value);
    }
    return value;
  }

  transfer(values: any[], from: Environment, to: Tracker): void {
    // For each value, the matching value in the `from` environment with
    // TRANSDFERRED object, and `to` tracker will track the value.
    // To replace the value with `TRANSFERRED` object, we can use
    // `Object.defineProperty` to define a property with a getter that throws an
    // error when accessed. This way, we can simulate the behavior of
    // transferring ownership of the object to another thread.
    const this_ = this;
    function go(subEnv: Environment): void {
      for (const [key, value] of Object.entries(subEnv)) {
        if (values.includes(value)) {
          Object.defineProperty(subEnv, key, {
            get() {
              throw new Error(
                `Accessing transferred object '${key}' from thread ${this.threadId.toString()}`,
              );
            },
            configurable: true,
            enumerable: true,
            writable: true,
          });
          to.track(value);
        }
        if (typeof value === "object" && value !== null) {
          const objectId = (value as Record<symbol, ObjectId>)[this_.threadId];
          assertObjectIdAvailable(objectId, key, this_.threadId);
          this_.#trackedObjects.delete(objectId);
          this_.#unusedObjects.add(objectId);
          go(value);
        } else if (typeof value === "string") {
          this_.#trackedValues.delete(value);
          this_.#unusedValues.add(value);
        }
      }
    }
    go(from);
  }

  replace(
    newTrackedObjects: Set<ObjectId>,
    newTrackedValues: Set<string>,
  ): void {
    this.#unusedObjects = this.#trackedObjects.difference(newTrackedObjects);
    this.#trackedObjects = newTrackedObjects;

    this.#unusedValues = this.#trackedValues.difference(newTrackedValues);
    this.#trackedValues = newTrackedValues;
  }
}

export function createMainEnvironment(
  workerEnvironment: Environment,
  workerTracker: Tracker,
  mainTracker: Tracker,
): MainEnvironment {
  const this_: MainEnvironment = {
    worker: {
      postMessage(message: any, _targetOrigin_ignored: null, transfer: any[]) {
        // Simulate the worker's postMessage behavior
        console.log("Simulated worker received message:", message);
        mainTracker.transfer(transfer, this_, workerTracker);
        workerEnvironment.onmessage?.({ data: message });
      },
    },
  };
  return this_;
}

// https://astexplorer.net/
// https://docs.esprima.org/en/latest/syntactic-analysis.html
// https://github.com/acornjs/acorn/tree/master/acorn/
// - Prohibit statements other than variable declarations and expression
//   statements.
// - Prohibit expressions other than literal (object, number, string, and
//   array), assignment, member, and variable reference expressions.
//   Exception 1: arrow function expression in `onmessage` assignment is allowed.
// - Track objects and arrays that are assigned to variables.
//   - Q. How to track?
//     - Set object (and array) ID using symbol for each thread.
//     - For value objects, store in a Set for each thread (or just ignore).
//     - Q. Track only expressions that are assigned to variables or including
//          others?
// - Transform assignments to variables into `$ENV.<varName> = value` form.
export interface ProgramForSimulration extends Node {
  type: "Program";
  body: StatementForSimulation[];
  sourceType: "script";
}
export type StatementForSimulation = ExpressionStatementForSimulation;
// NOTE: But this is converted to AssignmentExpressionForSimulation in the transformed code.
export interface VariableDeclarationForSimulation extends Node {
  type: "VariableDeclaration";
  declarations: VariableDeclarator[];
  kind: "var" | "let" | "const";
}
export interface ExpressionStatementForSimulation extends Node {
  type: "ExpressionStatement";
  expression: ExpressionForSimulation;
}
export type ExpressionForSimulation =
  | LiteralForSimulation
  | AssignmentExpressionForSimulation
  | AssignmentOnmessageExpressionForSimulation
  | MemberExpressionForSimulation
  | ArrayExpressionForSimulation
  | ObjectExpressionForSimulation
  | CallExpressionForSimulation;
export interface LiteralForSimulation extends Node {
  type: "Literal";
  value?: string | number | boolean | null;
}
export interface AssignmentExpressionForSimulation extends Node {
  type: "AssignmentExpression";
  operator: "=";
  left: MemberExpressionForSimulation;
  right: ExpressionForSimulation;
}
export interface AssignmentOnmessageExpressionForSimulation extends Node {
  type: "AssignmentExpression";
  operator: "=";
  left: OnmessageIdentifierForSimulation;
  right: ArrowFunctionExpression;
}
export interface MemberExpressionForSimulation extends Node {
  type: "MemberExpression";
  object: IdentifierForSimulation;
  property: ExpressionForProperty;
  computed: boolean;
  optional: boolean;
}
export type ExpressionForProperty =
  Identifier | LiteralForSimulation | MemberExpressionForProperty;
export interface MemberExpressionForProperty extends Node {
  type: "MemberExpression";
  object: ExpressionForProperty;
  property: ExpressionForProperty;
  computed: boolean;
  optional: boolean;
}
export interface IdentifierForSimulation extends Node {
  name: typeof envArgName | typeof trackerArgName;
}
export interface OnmessageIdentifierForSimulation extends Node {
  type: "Identifier";
  name: "onmessage";
}
export interface BlockStatementForSimulation extends Node {
  type: "BlockStatement";
  body: StatementForSimulation[];
}
export interface ArrayExpressionForSimulation extends Node {
  type: "ArrayExpression";
  elements: ExpressionForSimulation[];
}
export interface ObjectExpressionForSimulation extends Node {
  type: "ObjectExpression";
  properties: PropertyForSimulation[];
}
export interface PropertyForSimulation extends Node {
  type: "Property";
  key: ExpressionForProperty;
  value: ExpressionForSimulation;
  kind: "init" | "get" | "set";
  method: boolean;
  shorthand: boolean;
  computed: boolean;
}
export interface CallExpressionForSimulation extends Node {
  type: "CallExpression";
  callee: MemberExpressionForWorkerOrTracker;
  arguments: ExpressionForSimulation[];
}
export interface MemberExpressionForWorkerOrTracker extends Node {
  type: "MemberExpression";
  object: MemberExpressionForWorker | IdentifierForTracker;
  property: Identifier;
}
export interface MemberExpressionForWorker extends Node {
  type: "MemberExpression";
  object: typeof envArgName;
  property: IdentifierForWorker;
}
export interface IdentifierForTracker extends Node {
  type: "Identifier";
  name: typeof trackerArgName;
}
export interface IdentifierForWorker extends Node {
  type: "Identifier";
  name: "worker";
}

export function transformWithDebug(name: string, code: string): string {
  console.debug(`BEFORE transform ${name}:`, code);
  const transformed = transform(
    parse(code, { ecmaVersion: 2020, sourceType: "script" }),
  );
  const debugSource = generate(transformed);
  console.debug(`AFTER transform ${name}:`, debugSource);

  return generate(transformed, {
    comments: false,
    indent: "",
    lineEnd: "",
  });
}

export function transform(program: Program): ProgramForSimulration {
  return {
    ...program,
    type: "Program",
    sourceType: "script",
    body: transformStatements(program.body),
  };
}

export function transformStatements(
  statements: Array<Statement | ModuleDeclaration>,
): StatementForSimulation[] {
  return statements.flatMap(
    (statement: Statement | ModuleDeclaration): StatementForSimulation[] => {
      switch (statement.type) {
        case "VariableDeclaration":
          if (
            statement.kind !== "var" &&
            statement.kind !== "let" &&
            statement.kind !== "const"
          ) {
            throw UnsupportedSyntaxError(`${statement.type}`, statement.loc);
          }
          return statement.declarations.map(
            (
              declarator: VariableDeclarator,
            ): ExpressionStatementForSimulation => {
              if (declarator.init == null) {
                throw UnsupportedSyntaxError(
                  `${statement.type} without initializer`,
                  statement.loc,
                );
              }
              if (
                declarator.id.type !== "Identifier" &&
                declarator.id.type !== "MemberExpression"
              ) {
                throw UnsupportedSyntaxError(
                  `The left operand of assignment must be an Identifier or a MemberExpression, but ${declarator.id.type}`,
                  declarator.loc,
                );
              }
              return {
                ...statement,
                type: "ExpressionStatement",
                expression: {
                  ...declarator,
                  type: "AssignmentExpression",
                  operator: "=",
                  left: {
                    ...declarator.id,
                    type: "MemberExpression",
                    object: {
                      ...declarator.id,
                      type: "Identifier",
                      name: envArgName,
                    },
                    property: validateProperty(declarator.id),
                    computed: false,
                    optional: false,
                  },
                  right: wrapWithTrackerCall(
                    transformExpression(declarator.init),
                  ),
                },
              };
            },
          );
        case "ExpressionStatement":
          return [
            {
              ...statement,
              type: "ExpressionStatement",
              expression: transformExpression(statement.expression),
            },
          ];
        default: {
          throw UnsupportedSyntaxError(statement.type, statement.loc);
        }
      }
    },
  );
}

export function transformExpression(
  expression: Expression,
): ExpressionForSimulation {
  switch (expression.type) {
    case "Literal":
      if (
        typeof expression.value === "string" ||
        typeof expression.value === "number" ||
        typeof expression.value === "boolean" ||
        expression.value == null
      ) {
        return expression as LiteralForSimulation;
      }
      throw UnsupportedSyntaxError(
        `Literal value must be string, number, boolean, or null, but got ${typeof expression.value}`,
        expression.loc,
      );
    case "AssignmentExpression":
      if (
        expression.left.type !== "Identifier" &&
        expression.left.type !== "MemberExpression"
      ) {
        throw UnsupportedSyntaxError(
          `The left operand of assignment must be an Identifier or a MemberExpression, but ${expression.left.type}`,
          expression.loc,
        );
      }
      if (
        expression.left.type === "Identifier" &&
        expression.left.name === "onmessage"
      ) {
        if (expression.right.type !== "ArrowFunctionExpression") {
          throw UnsupportedSyntaxError(
            `The right operand of assignment to 'onmessage' must be an ArrowFunctionExpression, but ${expression.right.type}`,
            expression.loc,
          );
        }
        return {
          ...expression,
          type: "AssignmentExpression",
          operator: "=",
          left: {
            ...expression.left,
            type: "Identifier",
            name: "onmessage",
          },
          right: expression.right,
        };
      }
      return {
        ...expression,
        type: "AssignmentExpression",
        operator: "=",
        left: {
          ...expression.left,
          type: "MemberExpression",
          object: {
            ...expression.left,
            type: "Identifier",
            name: envArgName,
          },
          property: validateProperty(expression.left),
          computed: false,
          optional: false,
        },
        right: wrapWithTrackerCall(transformExpression(expression.right)),
      };
    case "MemberExpression":
      return {
        ...expression,
        type: "MemberExpression",
        object: {
          ...expression.object,
          type: "Identifier",
          name: envArgName,
        },
        property: validateProperty(expression.property),
        computed: expression.computed,
        optional: expression.optional,
      };
    default:
      throw UnsupportedSyntaxError(
        `Unsupported expression type ${expression.type}`,
        expression.loc,
      );
  }
}

export function wrapWithTrackerCall(
  expression: ExpressionForSimulation,
): CallExpressionForSimulation {
  return {
    ...expression,
    type: "CallExpression",
    callee: {
      ...expression,
      type: "MemberExpression",
      object: {
        ...expression,
        type: "Identifier",
        name: trackerArgName,
      },
      property: {
        ...expression,
        type: "Identifier",
        name: "track",
      },
    },
    arguments: [expression],
  };
}

export function validateProperty(
  root: Expression | PrivateIdentifier,
): ExpressionForProperty {
  function error(node: Node): never {
    const rootSrc = generate(root);
    throw UnsupportedSyntaxError(
      `MemberExpression \`${rootSrc}\` must consist of only Identifier or MemberExpression, but contains ${node.type}`,
      node.loc,
    );
  }
  function validatePropertyComponent(
    component: Expression | Super | PrivateIdentifier,
  ): ExpressionForProperty {
    switch (component.type) {
      case "Identifier":
        return component;
      case "Literal":
        if (
          typeof component.value === "string" ||
          typeof component.value === "number" ||
          typeof component.value === "boolean" ||
          component.value == null
        ) {
          return component as LiteralForSimulation;
        }
        error(component);
      case "MemberExpression":
        return {
          ...component,
          type: "MemberExpression",
          object: validatePropertyComponent(component.object),
          property: validatePropertyComponent(component.property),
          computed: component.computed,
          optional: component.optional,
        };
      default:
        error(component);
    }
  }
  switch (root.type) {
    case "Identifier":
      return root;
    case "MemberExpression":
      return {
        ...root,
        type: "MemberExpression",
        object: validatePropertyComponent(root.object),
        property: validatePropertyComponent(root.property),
      };
    default:
      error(root);
  }
}

function assertObjectIdAvailable(
  objectId: ObjectId | undefined,
  key: string,
  threadId: symbol,
): asserts objectId is ObjectId {
  if (objectId === undefined) {
    const errorMessage = `Assertion failure: Object '${key}' does not have an ID for thread ${String(threadId)}`;
    throw new Error(errorMessage);
  }
}

export function collectAndMarkUnused(
  environment: Environment,
  tracker: Tracker,
): void {
  const reachableObjects = new Set<ObjectId>();
  const reachableValues = new Set<string>();
  function go(subEnv: Environment): void {
    for (const [key, value] of Object.entries(subEnv)) {
      if (typeof value === "object" && value !== null) {
        const objectId = (value as Record<symbol, ObjectId>)[tracker.threadId];
        assertObjectIdAvailable(objectId, key, tracker.threadId);
        reachableObjects.add(objectId);
        go(value);
      } else if (typeof value === "string") {
        reachableValues.add(value);
      }
    }
  }
  go(environment);
  tracker.replace(reachableObjects, reachableValues);
}

function UnsupportedSyntaxError(
  nodeInfo: string,
  loc: SourceLocation | null | undefined,
): Error {
  const line = loc?.start.line ?? "unknown";
  const column = loc?.start.column ?? "unknown";
  return new Error(
    `Unsupported syntax: ${nodeInfo} at line ${line}, column ${column}`,
  );
}

async function importModuleFromJsSrc(
  src: string,
): Promise<{ [key: string]: any }> {
  //console.log(src);
  return await import(`data:application/javascript,${encodeURIComponent(src)}`);
}
