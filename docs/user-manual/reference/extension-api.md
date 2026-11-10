# Extension API

Applies to OKF Wiki 0.7.0, API version 1. Other Obsidian plugins can read the wiki and follow its
changes through this API; they cannot write to it. There is no generated API reference; the types
are in [`src/api.ts`](https://github.com/ysasiwat/obsidian-okf-wiki/blob/main/src/api.ts).

```ts
const api = (this.app as any).plugins.plugins["okf-wiki"]?.api;
```

The object is `undefined` while OKF Wiki is not enabled.

## Main entry points

| Member | Use it to |
| ------ | --------- |
| [`apiVersion`](#apiversion) | Check that your plugin and OKF Wiki agree on the API. |
| [`bundles()`](#bundles) | List the enabled bundles with their counts. |
| [`search(args)`](#searchargs) | Search like the `okf_search` tool. |
| [`read(args)`](#readargs) | Read a concept like the `okf_read` tool. |
| [`onCommit(listener)`](#oncommitlistener) | Run code after every change is on disk. |

### `apiVersion`

```ts
readonly apiVersion: number
```

Is `1` in this version. It is raised when a member changes incompatibly; check it before you use
the API.

### `bundles()`

```ts
bundles(): { ready: boolean; bundles: { name: string; concepts: number; ... }[] }
```

Returns what the `okf_bundles` tool returns, for every enabled bundle.

### `search(args)`

```ts
search(args): { hits: { concept_id: string; ... }[]; ... }
```

Takes the same arguments as the `okf_search` tool, for example
`{ bundle: "Knowledge", query: "remote sensing" }`.

### `read(args)`

```ts
read(args): { concept_id: string; etag: string; ... }
```

Takes the same arguments as the `okf_read` tool, for example
`{ bundle: "Knowledge", concept_id: "concepts/ndvi" }`.

### `onCommit(listener)`

```ts
onCommit(listener: (event: CommitEvent) => void): () => void
```

Calls `listener` after every commit is on disk: agent writes, your approvals and edits, and reverts.
Returns a function that removes the listener.

```ts
const off = api.onCommit((e) => {
  // e: { commitId, at, bundle, actor, tool, conceptId, reason?, reverts?,
  //      changes: [{ path, change: "created" | "modified" | "deleted" }] }
});
this.register(off);
```

A revert lists the files it restored. Listeners run after the write and cannot slow or break it; an
error in one listener does not stop the others.

## Behaviour

- Every result and event is a copy. Changing it does not change a bundle.
- The API reads as a token with the read scope and access to every enabled bundle.
- When OKF Wiki is disabled or reloaded, listeners are dropped and every member of the old `api`
  object throws:

  ```text
  OKF Wiki has unloaded; get app.plugins.plugins['okf-wiki'].api again once it is enabled
  ```

  Get the object again once OKF Wiki is enabled.

## Errors

| Error | Raised when |
| ----- | ----------- |
| `OKF Wiki has unloaded; …` | You call a member of an `api` object from before a disable or reload. |
| A service error with a code | The arguments are wrong or the concept does not exist; the codes are in [MCP tools](mcp-tools.md#errors). |
