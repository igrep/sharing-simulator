# Test inputs

Inputs used to manually test the app in the browser, with the observed results.

## 1. Default example (Sharing mode)

Mode: Simulate Sharing `ArrayBuffer` (Not transferring ownership)

Main thread:

```js
let buf = new ArrayBuffer(8);
worker.postMessage({ buf: buf }, [buf]);
buf = null;
```

Worker thread:

```js
let received = null;
onmessage = (e) => {
  received = e.data;
};
```

Result: The graph shows `buf = null` in the main thread and
`received → Object → ArrayBuffer(8)` in the worker thread. The `ArrayBuffer`
is highlighted red. The errors pane lists the invalid reference
`[worker] 'received.buf' refers to an object freed by the main thread`.

## 2. Accessing a transferred buffer (Transfer mode)

Mode: Simulate Transferring `ArrayBuffer`

Main thread:

```js
let buf = new ArrayBuffer(8);
const meta = { name: "data", buf: buf, list: [1, buf] };
worker.postMessage(meta, [buf]);
console.log(meta.buf.byteLength, buf.detached);
```

Worker thread: same as case 1.

Result: Like the real `postMessage`, transferring detaches the original buffer
instead of making it inaccessible. No errors occur, and the console logs
`0 true`. In the main thread, `buf`, `meta.buf` and `meta.list[1]` still point
to the same buffer, which is now grey and labelled `ArrayBuffer (detached)`.
A dashed `transferred to` edge goes from it to the new `ArrayBuffer(8)` in
the worker thread, which `received.buf` and `received.list[1]` point to.

## 2b. Transferring a detached buffer (Transfer mode and Real mode)

Mode: Simulate Transferring `ArrayBuffer`, then Run real worker code (Not simulating)

Main thread:

```js
let buf = new ArrayBuffer(8);
worker.postMessage({ buf: buf }, [buf]);
console.log(buf.byteLength, buf.detached);
worker.postMessage({ buf: buf }, [buf]);
```

Worker thread:

```js
onmessage = (e) => {};
```

Result: Both modes report the same error from the second `postMessage`:

- Transfer mode: `[main] DataCloneError: Failed to execute 'structuredClone' on 'Window': ArrayBuffer at index 0 is already detached.`
- Real mode: `[main] DataCloneError: Failed to execute 'postMessage' on 'Worker': ArrayBuffer at index 0 is already detached.`

## 3. Shared buffer still referenced by both threads (Sharing mode)

Mode: Simulate Sharing `ArrayBuffer` (Not transferring ownership)

Main thread and worker thread: same as case 2.

Result: Both threads reach `ArrayBuffer(8)`, so it is placed outside the
thread boxes and highlighted yellow. No invalid references.

## 4. Real worker with an error (Real mode)

Mode: Run real worker code (Not simulating)

Main thread:

```js
const buf = new ArrayBuffer(8);
worker.postMessage({ buf }, [buf]);
console.log("main byteLength", buf.byteLength);
```

Worker thread:

```js
onmessage = (e) => {
  console.log("worker got", e.data.buf.byteLength);
  undefinedFn();
};
```

Result: The graph pane says the graph is not available in this mode. The
errors pane shows
`[worker] Error: Uncaught ReferenceError: undefinedFn is not defined (line 1)`.

## 5. Syntax error (Sharing mode)

Mode: Simulate Sharing `ArrayBuffer` (Not transferring ownership)

Main thread:

```js
foo(
```

Worker thread: same as case 4.

Result: The errors pane shows two errors:

- `[worker] UnsupportedSyntaxError: Unsupported syntax: Function call other than `worker.postMessage(...)` (main thread only) or `console.*(...)` at line 1, column 71`
  (`undefinedFn()` is not allowed in simulation modes)
- `[main] SyntaxError: Unexpected token (1:4)`

## 6. Undefined variable (Sharing mode)

Mode: Simulate Sharing `ArrayBuffer` (Not transferring ownership)

Main thread:

```js
x = y;
```

Worker thread: same as case 4.

Result: The errors pane shows the same worker error as case 5, plus
`[main] ReferenceError: y is not defined`.

## 7. History navigation

After case 6, going back in the browser history refilled the main thread input
with `foo(` (case 5) and the mode stayed "Sharing".
