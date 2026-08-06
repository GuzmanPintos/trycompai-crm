# tenki fork of CRM

Private fork of [`trycompai/crm`](https://github.com/trycompai/crm) that tracks
upstream closely while carrying the changes needed to run it on the homelab
**tenki** Kubernetes cluster instead of Vercel.

> **TL;DR** — `base/main` is pristine upstream `main`. `tenki` is `base/main` +
> a short series of `[tenki]`-tagged patch commits, rebased onto upstream `main`
> on each sync. All fork logic lives in fork-owned files; edits to upstream files
> are minimal, marked hooks. Modeled on the sibling `eddiewang/lobehub` fork.

## Why a fork at all

Upstream is Vercel-first and ships **no Dockerfiles and no images**. Three things
have to change to run it on Kubernetes:

1. **Container images.** Upstream deploys three Vercel projects. We need three
   images (`web`, `api`, `agent`) built from one monorepo.
2. **The sandbox.** The agent's sandbox backend resolves at runtime to Vercel →
   Docker → microsandbox → **just-bash**. In a plain container none of the first
   three exist, so it silently lands on `just-bash`: a pure-JS interpreter with a
   virtual filesystem and *no real binaries*. The agent's `bash`/`grep`/`glob`
   tools would be a toy. We add a backend that talks to the in-cluster Tenki
   sandbox-engine.
3. **The model gateway.** Upstream reaches models by passing model-ID strings to
   eve, which resolves them through the Vercel AI Gateway. We point that at the
   in-cluster Bifrost gateway.

## Branch model

```
upstream/main ──(pristine mirror)──► base/main
                                        │
                                        ├─ [tenki] container images for web/api/agent
                                        ├─ [tenki] Tenki sandbox backend for eve
                                        └─ [tenki] Bifrost model provider
                                                      └──► tenki   (built + deployed)
```

| Branch      | Contents                                                       | Mutation                                    |
| ----------- | -------------------------------------------------------------- | ------------------------------------------- |
| `base/main` | Exactly upstream `main`. Never edited.                         | Fast-forwarded to upstream `main` each sync. |
| `tenki`     | `base/main` + the `[tenki]` commits. **This is what we build.** | Rebased `--onto` upstream `main` (force-push). |

## Remotes

```
origin    git@github.com:eddiewang/crm.git      (this private fork)
upstream  https://github.com/trycompai/crm.git  (read-only; push disabled)
```

`upstream`'s push URL is the sentinel `DISABLE` so a stray `git push upstream` can
never reach the public repo.

## The maintainability contract

Rebasing onto new upstream `main` should rarely conflict. That holds only if:

1. **Fork code lives in fork-owned paths upstream never touches:**
   - `docker/` — Dockerfiles and entrypoints
   - `apps/agent/agent/sandbox/tenki/` — the Tenki sandbox backend for eve
   - `apps/agent/agent/lib/bifrost.ts` — the model provider
   - `tenki/` — this tooling dir
   - `FORK.md` — this file

2. **Edits to existing upstream files are minimized and marked** with a `[tenki]`
   comment, with the heavy logic in a fork-owned file:

   ```ts
   // [tenki] in-cluster sandbox engine instead of eve's built-in backends
   export default defineSandbox({ backend: tenkiBackend() });
   ```

Current upstream-file touchpoints (keep this list short — run `tenki/touchpoints.sh`):

| File | Why |
| --- | --- |
| `apps/agent/agent/sandbox/sandbox.ts` | swap the backend (one line) |
| `apps/agent/agent/agent.ts` | model resolution via Bifrost |
| `apps/app/next.config.ts` | `output: "standalone"` for a slim image |

## Deploying

The GitOps side lives in `eddiewang/terramate-proxmox`:
`kubernetes/modules/crm/` + `clusters/tenki/apps/crm-*.yaml`. Images are built on
the amd64 devbox and pushed to the in-cluster Zot registry
`registry.tenki.io.eddiewang.me/crm/{web,api,agent}`, then pinned by hand.
See that repo's `memory/plan-2026-12-08-crm-tenki-deploy.md`.
