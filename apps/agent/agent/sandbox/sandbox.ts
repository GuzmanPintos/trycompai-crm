import { defineSandbox } from "eve/sandbox";
import { configuredSandboxBackend } from "./provider";

/**
 * The agent's shell, with the network taken away.
 *
 * Turning a sandbox on is what gives the model `bash`, `read_file`,
 * `write_file`, `glob` and `grep` — the difference between a tool-caller and
 * something that can keep a dossier on a person, diff this month's profile
 * against last month's, and grep a thread for a signature block.
 *
 * `deny-all` costs nothing, because of where the other tools run: `web_fetch`
 * executes in the app runtime and `web_search` at the model provider, so
 * retrieval is unaffected by the sandbox having no egress. What it removes is
 * the only path by which customer email bodies — which this agent reads in full
 * — could leave the building through a shell command.
 *
 * The other half of that rule is not here, because it is an absence: **the
 * sandbox is never given `DATABASE_URL`.** Backends take explicit `env`, so
 * nothing is inherited. CRM access is authored tools in the app runtime, never
 * `psql`. A shell with credentials and egress is exfiltration-shaped even in an
 * internal tool; a shell with neither is a text processor.
 *
 * The policy is set on the backend factory rather than in `onSession` so it
 * applies to every session by construction — a per-session call is a per-session
 * call somebody can forget. The default remains availability-aware — Vercel in
 * production and Docker or microsandbox locally — while an install can pin
 * Tenki through `SANDBOX_PROVIDER`. The factory is lazy because eve may load
 * this authored module before the root environment has been staged.
 */
export default defineSandbox({
	backend: configuredSandboxBackend,
});
