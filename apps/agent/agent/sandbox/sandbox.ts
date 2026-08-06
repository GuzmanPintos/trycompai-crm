import { defaultBackend, defineSandbox } from "eve/sandbox";
import { tenkiBackend } from "./tenki/backend"; // [tenki]

// [tenki] Off Vercel, eve's defaultBackend() falls through Vercel → Docker →
// microsandbox → just-bash, and in a Kubernetes pod that means just-bash: a
// pure-JS interpreter with no real binaries. Use the in-cluster Tenki
// sandbox-engine when it is configured, and keep upstream's behaviour otherwise
// (local dev, CI, `eve build`) so the fork stays cheap to rebase.
//
// Egress stays deny-all in both paths — see tenki/backend.ts for why that
// matters here specifically.
// All three are required together: a tk_ service credential carries no implied
// workspace, so the engine rejects list/create without an explicit id. Gate on
// the full set so a partial config degrades to upstream's backend instead of
// throwing at import time.
const useTenki = [
	process.env.TENKI_BASE_URL,
	process.env.TENKI_AUTH_TOKEN,
	process.env.TENKI_WORKSPACE_ID,
].every((value) => value !== undefined && value !== "");

export default defineSandbox({
	backend: useTenki
		? tenkiBackend()
		: defaultBackend({
				vercel: { networkPolicy: "deny-all" },
				docker: { networkPolicy: "deny-all" },
				microsandbox: { networkPolicy: "deny-all" },
			}),
});
