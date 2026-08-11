import { TemplateSpec } from "@tenkicloud/sandbox";

export const CRM_TEMPLATE_NAME = "crm-agent";
export const CRM_TEMPLATE_CONTEXT_REPOSITORY =
	"https://github.com/octocat/Hello-World.git";
export const CRM_TEMPLATE_CONTEXT_REVISION =
	"7fd1a60b01f91b314f59955a4e4d4e80d8edf11d";
export const CRM_TEMPLATE_CONTEXT_DIRECTORY = "/tmp/crm-agent-template-context";
export const CRM_TEMPLATE_WORKDIR = "/home/tenki";
export const CRM_TEMPLATE_RESOURCES = {
	cpuCores: 2,
	diskSizeGb: 20,
	memoryMb: 4096,
} as const;

export const CRM_APT_PACKAGES = [
	"bash",
	"ca-certificates",
	"coreutils",
	"curl",
	"file",
	"findutils",
	"git",
	"grep",
	"jq",
	"procps",
	"python3",
	"ripgrep",
	"sed",
] as const;

const CLEAN_APT_CACHES_COMMAND = `set -eu
sudo rm -rf /var/lib/apt/lists/* /var/cache/apt/archives/*.deb /var/cache/apt/archives/partial`;

export const CRM_SANDBOX_SMOKE_COMMAND = String.raw`set -eu
test "$(pwd)" = "/home/tenki"
for tool in bash cat curl file find git grep jq mkdir ps python3 rg rm sed sha256sum; do
  command -v "$tool" >/dev/null
done
smoke_dir=".crm-template-smoke-$$"
trap 'rm -rf "$smoke_dir"' EXIT
mkdir "$smoke_dir"
printf '%s\n' 'crm-smoke' > "$smoke_dir/input.txt"
test "$(cat "$smoke_dir/input.txt")" = "crm-smoke"
find "$smoke_dir" -type f -name input.txt | grep -q 'input.txt$'
rg -q '^crm-smoke$' "$smoke_dir/input.txt"
test "$(sed 's/crm/template/' "$smoke_dir/input.txt")" = "template-smoke"
test "$(jq -nr '{ready:true} | .ready')" = "true"
SMOKE_FILE="$smoke_dir/input.txt" python3 -c 'import os; from pathlib import Path; assert Path(os.environ["SMOKE_FILE"]).read_text() == "crm-smoke\n"'
file "$smoke_dir/input.txt" >/dev/null
git --version >/dev/null
curl --version >/dev/null
ps -p $$ >/dev/null
sha256sum "$smoke_dir/input.txt" >/dev/null
rm "$smoke_dir/input.txt"
test ! -e "$smoke_dir/input.txt"
rmdir "$smoke_dir"
trap - EXIT`;

export const crmTemplateSpec = new TemplateSpec()
	.fromImage("sandbox")
	.withGitContext({
		checkout: { dest: CRM_TEMPLATE_CONTEXT_DIRECTORY, mode: "contents" },
		ref: CRM_TEMPLATE_CONTEXT_REVISION,
		repo: CRM_TEMPLATE_CONTEXT_REPOSITORY,
	})
	.workdir(CRM_TEMPLATE_WORKDIR)
	.remove(CRM_TEMPLATE_CONTEXT_DIRECTORY, {
		name: "Remove disposable template context",
		recursive: true,
	})
	.apt([...CRM_APT_PACKAGES], { name: "Install CRM agent shell toolchain" })
	.run(CLEAN_APT_CACHES_COMMAND, { name: "Clean apt caches" })
	.run(CRM_SANDBOX_SMOKE_COMMAND, {
		name: "Verify CRM agent toolchain",
		timeoutSeconds: 60,
	})
	.resources(CRM_TEMPLATE_RESOURCES);
