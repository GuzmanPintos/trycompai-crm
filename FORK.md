# Luxor Tenki fork of CRM

Private Luxor fork of [`trycompai/crm`](https://github.com/trycompai/crm) that
tracks upstream closely while carrying the changes needed to run it on the
**tenki-agents** Kubernetes cluster instead of Vercel.

> **TL;DR** — `base/main` is pristine upstream `main`. `tenki` is `base/main` +
> a short series of `[tenki]`-tagged patch commits, rebased onto upstream `main`
> on each sync. All fork logic lives in fork-owned files; edits to upstream files
> are minimal, marked hooks. Modeled on the sibling `eddiewang/lobehub` fork.

## Why a fork at all

Upstream is Vercel-first and ships **no Dockerfiles and no images**. Four things
have to change to run it on Kubernetes:

1. **Container images.** Upstream deploys three Vercel projects. We need three
   images (`web`, `api`, `agent`) built from one monorepo.
2. **The sandbox.** The agent's sandbox backend resolves at runtime to Vercel →
   Docker → microsandbox → **just-bash**. In a plain container none of the first
   three exist, so it silently lands on `just-bash`: a pure-JS interpreter with a
   virtual filesystem and *no real binaries*. The agent's `bash`/`grep`/`glob`
   tools would be a toy. We add a backend that uses a scoped workspace and API key
   in Tenki's production sandbox environment.
3. **The model gateway.** Upstream reaches models by passing model-ID strings to
   eve, which resolves them through the Vercel AI Gateway. Production uses live
   direct-provider objects for the external OpenAI-compatible Bifrost endpoint
   at `https://llm.eddiewang.me/openai` instead.
4. **Production policy and tooling.** Production model requests keep Eve's
   provider-neutral reasoning level at `high`, and repeatable Tenki template and
   acceptance tools build and verify the sandbox without storing credentials.

## Branch model

```
upstream/main ──(pristine mirror)──► base/main
                                        │
                                        ├─ [tenki] container images for web/api/agent
                                        ├─ [tenki] Tenki sandbox backend for eve
                                        ├─ [tenki] Bifrost model provider
                                        └─ [tenki] production policy + Tenki tooling
                                                      └──► tenki   (built + deployed)
```

| Branch      | Contents                                                       | Mutation                                    |
| ----------- | -------------------------------------------------------------- | ------------------------------------------- |
| `base/main` | Exactly upstream `main`. Never edited.                         | Fast-forwarded to upstream `main` each sync. |
| `tenki`     | `base/main` + the `[tenki]` commits. **This is what we build.** | Rebased `--onto` upstream `main` (force-push). |

## Remotes

```
origin     git@github.com:LuxorLabs/crm.git      (this private fork)
reference  git@github.com:eddiewang/crm.git       (original Tenki patches)
upstream   https://github.com/trycompai/crm.git   (read-only; push disabled)
```

`upstream`'s push URL is the sentinel `DISABLE` so a stray `git push upstream` can
never reach the public repo.

## The maintainability contract

Rebasing onto new upstream `main` should rarely conflict. That holds only if:

1. **Fork code lives in fork-owned paths upstream never touches:**
   - `docker/` — Dockerfiles and entrypoints
   - `apps/agent/agent/sandbox/tenki/` — the Tenki sandbox backend for eve
   - `apps/agent/agent/lib/bifrost.ts` — the model provider
   - `apps/agent/tenki/` — production template and acceptance tooling
   - `FORK.md` — this file

2. **Edits to existing upstream files are minimized and marked** with a `[tenki]`
   comment, with the heavy logic in a fork-owned file:

   ```ts
   // [tenki] in-cluster sandbox engine instead of eve's built-in backends
   export default defineSandbox({ backend: tenkiBackend() });
   ```

Current upstream-file touchpoints (keep this list short):

| File | Why |
| --- | --- |
| `apps/agent/agent/sandbox/sandbox.ts` | swap the backend (one line) |
| `apps/agent/agent/agent.ts` | model resolution via Bifrost |
| `apps/agent/agent/channels/eve.ts` | remove `localDev()` authentication in production |
| `apps/app/next.config.ts` | `output: "standalone"` for a slim image |

## Production agent policy and Tenki tooling

The root agent, `agent_builder`, and `agent_runner` set `reasoning: "high"` and
resolve every model call through Bifrost on `step.started`. Their compiled
fallbacks are also direct Bifrost models with a 400,000-token context window, so
a resolver failure cannot select Vercel AI Gateway. Compaction has no separate
model and reuses the active Bifrost model. This is an explicit production
policy. Keep it through upstream rebases, and do not lower it without a
production policy review.

Production Bifrost is external at `https://llm.eddiewang.me/openai` and uses
`openai/gpt-5.6-sol`. `BIFROST_API_KEY` is injected only at runtime. It must
never be passed to `eve build`, a Docker build argument, or an image layer. A
non-secret placeholder exists only so the secret-free image build classifies
the compiled fallback as an external `bifrost` provider. The live AI SDK model
identifies its chat-completions transport as `bifrost.chat`.

`apps/agent/tenki/` is the production tooling path. From the agent workspace,
`bun run tenki:build-template` reconciles and builds the private `crm-agent`
template, and `bun run tenki:validate-production` runs the fail-closed temporary
acceptance session. The tools read Tenki credentials from the process
environment, redact the token from output, and do not store secret values in the
repository. The acceptance tool requires the immutable private image digest
returned by `tenki:build-template`; production session creation does not accept
the template-only `sandbox` base image. The validator always measures real
outbound HTTPS. It fails by default when egress works; only the literal
`TENKI_ACCEPT_KNOWN_OUTBOUND_BUG=true` records and accepts the explicitly
approved Tenki enforcement bug. That exception must never be described as
deny-all networking.

## Deploying

The GitOps side lives in `LuxorLabs/fluxor-tenki-agents`. Images publish only
through the manually dispatched `Publish images` workflow. The workflow builds all
three `linux/amd64` images before it authenticates to GAR, then publishes immutable
`sha-<commit>` tags under `us-docker.pkg.dev/analog-stage-198105/mcp/crm-*`.
GitOps records all three digests together and never follows a mutable tag.
