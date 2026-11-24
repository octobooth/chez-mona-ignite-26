import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Provisioner, scriptCommand } from "../provisioner.mjs";
import { catalog } from "../server.mjs";

for (const recipe of ["delivery", "soup"]) test(`${recipe} uses a committed adapter snapshot and scoped resource operations`, async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "diner-adapter-"));
    t.after(() => rmSync(dir, { recursive: true }));
    const calls = [];
    let recorded = [];
    const row = { id: "01234567-aaaa-bbbb-cccc-123456789012", recipe };
    const settings = { account: "booth-1", owner: "octobooth", station: "booth-1", provisionerPath: "/source", readinessMinutes: 30 };
    const template = recipe === "delivery" ? "booth-bingo" : "tailspin-toys";
    const workflow = recipe === "delivery" ? "stacked_prs" : "issue_and_codespace";
    const sourceConfig = { org: "octobooth", repos: [{ key: template, workflow, stack: [{}], pages: true, template }] };
    const snapshot = join(dir, "orders", row.id, "provisioner");
    const run = async (binary, args, options) => {
        calls.push({ binary, args, options });
        if (binary === "gh" && args[1] === "user") return "booth-1";
        if (binary === "git" && args.includes("get-url")) return "https://github.com/octobooth/repo-setup-scripts.git";
        if (binary === "git" && args.includes("rev-parse")) return "a".repeat(40);
        if (binary === "git" && args.includes("archive")) {
            writeFileSync(args.find((a) => a.startsWith("--output=")).slice(9), "");
            return "";
        }
        if (binary === "tar") { writeFileSync(join(snapshot, "config.json"), JSON.stringify(sourceConfig)); return ""; }
        if (binary === "bash" || binary === "powershell.exe") {
            const config = JSON.parse(readFileSync(join(snapshot, "config.json")));
            const entry = config.repos[0];
            assert.equal(entry.workflow, recipe === "delivery" ? "repo_only" : workflow);
            assert.equal(entry.pages, true);
            if (recipe === "delivery") assert.equal(entry.stack, undefined);
            assert.equal(options.env.DEMO_NO_BROWSER, "1");
            options.onOutput(`Creating repository: octobooth/${entry.repo_base_name}-abcd\n`);
            assert.equal(recorded[0].repo, `octobooth/${entry.repo_base_name}-abcd`);
            assert.equal(recorded[0].repositoryId, undefined);
            return "";
        }
        if (binary === "gh" && args[0] === "workflow") {
            assert.deepEqual(args.slice(0, 3), ["workflow", "disable", "456"]);
            assert.equal(args.at(-1), recorded[0].repo);
            return "";
        }
        if (binary === "gh" && args[1].includes("/actions/workflows")) return JSON.stringify({
            workflows: [{ id: 456, path: ".github/workflows/weekly-workshop-triage.lock.yml" }],
        });
        if (binary === "gh" && args[1].startsWith("repos/")) return JSON.stringify({ id: 123 });
        throw new Error(`Unexpected command ${binary} ${args}`);
    };
    await new Provisioner(dir, catalog.recipes, run).create(row, settings, (resources) => { recorded = structuredClone(resources); });
    assert.equal(recorded[0].repositoryId, 123);
    assert.equal(recorded[0].revision, "a".repeat(40));
    assert.ok(calls.some((call) => call.args.includes("--no-clone") || call.args.includes("-NoClone")));
    assert.ok(!calls.some((call) => call.args.includes("--cleanup") || call.args.includes("-Cleanup")));
    assert.equal(sourceConfig.repos[0].workflow, workflow);
    if (recipe === "soup") assert.equal(calls.filter((call) => call.args[0] === "workflow" && call.args[1] === "disable").length, 1);
});

test("PowerShell uses literal argument vectors and no clone", () => {
    const [binary, args] = scriptCommand("C:\\Diner files", "octocart", "booth-1", "win32");
    assert.equal(binary, "powershell.exe");
    assert.deepEqual(args.slice(-5), ["-Template", "octocart", "-Owner", "booth-1", "-NoClone"]);
});

test("wrong account blocks any provisioning commands", async (t) => {
    const dir = mkdtempSync(join(tmpdir(), "diner-identity-"));
    t.after(() => rmSync(dir, { recursive: true }));
    let count = 0;
    const adapter = new Provisioner(dir, catalog.recipes, async () => { count++; return "someone-else"; });
    await assert.rejects(adapter.create({ id: "test", recipe: "fusion" }, { account: "booth" }, () => {}), /account mismatch/);
    assert.equal(count, 1);
});

function remote(key, config) {
    return { kind: "remote", repo: "booth/example", repositoryId: 7, key, config };
}
const base = {
    "repos/booth/example": { id: 7, full_name: "booth/example", default_branch: "main" },
    "repos/booth/example/branches/main": { commit: { sha: "main-head" } },
};
function fakeApi(responses) {
    return async (binary, args) => {
        assert.equal(binary, "gh");
        if (args[1] === "user") return "booth";
        if (!(args[1] in responses)) throw new Error(`Unexpected API ${args[1]}`);
        const value = responses[args[1]];
        return JSON.stringify(args.includes("--slurp") ? [value] : value);
    };
}

test("Copilot review must be submitted on the current PR head", async () => {
    const resource = remote("octocart", { workflow: "code_review_prs", prs: [{ branch: "feature" }] });
    const responses = { ...base,
        "repos/booth/example/pulls?state=open&per_page=100": [{ number: 1, head: { ref: "feature", sha: "pr-head" }, html_url: "https://github.com/booth/example/pull/1" }],
        "repos/booth/example/pulls/1/reviews?per_page=100": [],
    };
    const adapter = new Provisioner("/unused", catalog.recipes, fakeApi(responses));
    const row = { resources: [resource] };
    assert.equal((await adapter.ready(row, { account: "booth" })).ready, false);
    responses["repos/booth/example/pulls/1/reviews?per_page=100"] = [{ user: { login: "copilot-pull-request-reviewer[bot]" }, submitted_at: "now", commit_id: "old-head" }];
    assert.equal((await adapter.ready(row, { account: "booth" })).ready, false);
    responses["repos/booth/example/pulls/1/reviews?per_page=100"][0].commit_id = "pr-head";
    assert.equal((await adapter.ready(row, { account: "booth" })).ready, true);
});

test("security readiness requires current CodeQL, AI findings, and successful Autofix", async () => {
    const responses = { ...base,
        "repos/booth/example/pulls?state=open&per_page=100": [],
        "repos/booth/example/code-scanning/alerts?state=open&per_page=100": [],
        "repos/booth/example/code-scanning/alerts/1/autofix": { status: "pending" },
    };
    const adapter = new Provisioner("/unused", catalog.recipes, fakeApi(responses));
    const row = { resources: [remote("security", { workflow: "security_prs", ai_scan: true })] };
    assert.match((await adapter.ready(row, { account: "booth" })).reason, /CodeQL/);
    responses["repos/booth/example/code-scanning/alerts?state=open&per_page=100"] = [{ number: 1, tool: { name: "CodeQL" }, most_recent_instance: { commit_sha: "main-head" } }];
    assert.match((await adapter.ready(row, { account: "booth" })).reason, /AI scanning/);
    responses["repos/booth/example/code-scanning/alerts?state=open&per_page=100"].push({ number: 2, tool: { name: "AI" }, most_recent_instance: { commit_sha: "old-head" } });
    assert.equal((await adapter.ready(row, { account: "booth" })).ready, false);
    responses["repos/booth/example/code-scanning/alerts?state=open&per_page=100"][1].most_recent_instance.commit_sha = "main-head";
    assert.match((await adapter.ready(row, { account: "booth" })).reason, /Autofix/);
    responses["repos/booth/example/code-scanning/alerts/1/autofix"].status = "success";
    assert.equal((await adapter.ready(row, { account: "booth" })).ready, true);
});

test("teardown refuses a repository whose immutable identity changed", async () => {
    const resource = { ...remote("fusion", {}), repositoryId: 99, prefix: "example", repo: "booth/example-abcd", owner: "booth", account: "booth" };
    const adapter = new Provisioner("/unused", catalog.recipes, fakeApi({ "repos/booth/example-abcd": { id: 100 } }));
    await assert.rejects(adapter.remove({ id: "a".repeat(36), resources: [resource] }, { account: "booth", owner: "booth" }), /identity changed/);
});

test("Soup requires completed linked agent work, passing checks, and an available Codespace", async () => {
    const pr = { number: 2, draft: true, user: { login: "copilot-swe-agent[bot]" },
        head: { ref: "copilot/fix", sha: "agent-head" }, html_url: "https://github.com/booth/example/pull/2" };
    const responses = { ...base,
        "repos/booth/example/pulls?state=open&per_page=100": [pr],
        "repos/booth/example/commits/agent-head/check-runs?per_page=100": { check_runs: [{ status: "completed", conclusion: "failure" }] },
        "repos/booth/example/issues?state=open&per_page=100": [{ number: 1, title: "Prepared task" }],
        "repos/booth/example/issues/1/timeline?per_page=100": [],
        "repos/booth/example/contents/.github/workflows/weekly-workshop-triage.md": { type: "file" },
        "repos/booth/example/actions/workflows?per_page=100": { workflows: [{ path: ".github/workflows/weekly-workshop-triage.lock.yml", state: "disabled_manually" }] },
        "repos/booth/example/codespaces": { codespaces: [{ name: "test-space", state: "Starting", owner: { login: "booth" } }] },
    };
    const adapter = new Provisioner("/unused", catalog.recipes, fakeApi(responses));
    const row = { resources: [remote("tailspin-toys", { workflow: "issue_and_codespace", issue: { title: "Prepared task" } })] };
    const check = () => adapter.ready(row, { account: "booth" });
    assert.match((await check()).reason, /non-draft/);
    pr.draft = false;
    assert.match((await check()).reason, /checks/);
    responses["repos/booth/example/commits/agent-head/check-runs?per_page=100"].check_runs[0].conclusion = "success";
    assert.match((await check()).reason, /linked/);
    responses["repos/booth/example/issues/1/timeline?per_page=100"] = [{ event: "cross-referenced", source: { issue: { html_url: pr.html_url } } }];
    assert.match((await check()).reason, /Codespace/);
    responses["repos/booth/example/codespaces"].codespaces[0].state = "Available";
    assert.equal((await check()).ready, true);
    responses["repos/booth/example/actions/workflows?per_page=100"].workflows[0].state = "active";
    assert.match((await check()).reason, /remain disabled/);
});

test("Pages readiness requires a successful deployment of the current revision and HTTP success", async (t) => {
    let status = 503;
    t.mock.method(globalThis, "fetch", async () => ({ ok: status === 200 }));
    const responses = { ...base,
        "repos/booth/example/pulls?state=open&per_page=100": [],
        "repos/booth/example/pages": { html_url: "https://booth.github.io/example/" },
        "repos/booth/example/actions/workflows/pages.yml/runs?per_page=100": {
            workflow_runs: [{ head_sha: "old-head", conclusion: "success", status: "completed" }],
        },
    };
    const adapter = new Provisioner("/unused", catalog.recipes, fakeApi(responses));
    const row = { resources: [remote("booth-bingo", { workflow: "repo_only", pages: true })] };
    const check = () => adapter.ready(row, { account: "booth", owner: "booth" });
    assert.match((await check()).reason, /default revision/);
    responses["repos/booth/example/actions/workflows/pages.yml/runs?per_page=100"].workflow_runs[0].head_sha = "main-head";
    assert.match((await check()).reason, /not responding/);
    status = 200;
    assert.equal((await check()).ready, true);
});
