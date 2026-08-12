# Stock-Buddy

A LangGraph-based financial AI agent in TypeScript. See [CLAUDE.md](./CLAUDE.md) for the
full architecture spec and capability definitions.

- `apps/server` — owns the LangGraph graph, the cached market-data tool layer, and the
  Fastify HTTP API.
- `apps/web` — React + Vite client. Pure consumer of the server's API; holds no API keys.

## Setup

```bash
nvm use                       # reads .nvmrc → Node 24.11.1
npm install                   # installs both workspaces
cp apps/server/.env.example apps/server/.env
# then fill in the keys documented in that file
```

```bash
npm run dev:server            # Fastify on :3001
npm run dev:web               # Vite on :5173 (proxies /api → :3001)
npm test                      # Vitest, both workspaces
npm run typecheck             # tsc --noEmit, both workspaces
npm run lint                  # ESLint, repo-wide
```

## Windows notes

### Node version is not optional

The project **requires Node ≥ 22** (`.nvmrc` pins 24.11.1). This is not a preference —
two dependencies declare `engines.node: ">=22"`:

| Package          | Requires    |
| ---------------- | ----------- |
| `better-sqlite3` | `>= 22`     |
| `yahoo-finance2` | `>= 22.0.0` |

`npm install` does **not** enforce `engines` by default. It emits an `EBADENGINE` warning
and carries on, so on Node 20 the install "succeeds" and then `better-sqlite3`
**segfaults at require time** (exit 139) because its prebuilt `win32-x64.node` binary was
built against a newer ABI. If you see a segfault instead of an error message, check your
Node version first:

```bash
node -p "process.version + ' ABI ' + process.versions.modules"
# want: v24.x ABI 137     (Node 20 is ABI 115 → segfault)
```

### `nvm use` can break your `node` command

**nvm4w cannot handle a space in its install path.** If `nvm root` reports a path
containing a space — e.g. `C:\Users\Firstname Lastname\AppData\Local\nvm` — then
`nvm use <version>` fails partway with:

```
activation error: exit status 1: 'C:\Users\Firstname' is not recognized as an
internal or external command
```

and it **deletes the `C:\nvm4w\nodejs` symlink on its way out**, leaving `node` and `npm`
unavailable on PATH entirely. `nvm list` will show no `*` marker.

To recover, recreate the link manually, pointing at the version you want. A **junction**
works and — unlike a symlink — does not require an elevated shell:

```powershell
New-Item -ItemType Junction -Path 'C:\nvm4w\nodejs' `
         -Target "$((nvm root) -replace '^Current Root: ','')\v24.11.1"

node -v   # v24.11.1
nvm list  # * 24.11.1 (Currently using 64-bit executable)
```

Substitute the version you actually want for `v24.11.1`. Because this replaces what nvm
itself manages, prefer this over re-running `nvm use` on an affected machine.

### If a native module still fails to install

`npm install --ignore-scripts` installs everything while skipping native builds; the
prebuilt binary can then be extracted manually into `node_modules/<pkg>`. Always smoke-test
the result before moving on:

```bash
node -e "const d=require('better-sqlite3')(':memory:'); d.exec('CREATE TABLE t(a)'); console.log('OK')"
```
