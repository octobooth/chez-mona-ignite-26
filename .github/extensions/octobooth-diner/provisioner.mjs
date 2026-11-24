import { spawn } from "node:child_process";
import { createHash } from "node:crypto";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve, sep } from "node:path";
import { fileURLToPath } from "node:url";

const root = resolve(dirname(fileURLToPath(import.meta.url)), "../../..");
const agents = new Set(["copilot", "copilot-swe-agent[bot]", "github-agentic-autofix[bot]"]);

export function command(binary, args, options = {}) {
    return new Promise((resolvePromise, reject) => {
        const child = spawn(binary, args, { cwd: options.cwd, env: options.env || process.env, shell: false, stdio: ["ignore", "pipe", "pipe"] });
        let output = "";
        let errors = "";
        let failure;
        const timer = setTimeout(() => {
            failure = new Error(`${binary} exceeded its deadline. Inspect the resource before retrying.`);
            child.kill();
        }, options.timeout || 60_000);
        child.stdout.on("data", (chunk) => {
            output += chunk;
            if (output.length > 8_000_000) {
                failure = new Error(`${binary} output exceeded its limit.`);
                child.kill();
            }
            try { options.onOutput?.(chunk.toString()); } catch (error) { failure = error; child.kill(); }
        });
        child.stderr.on("data", (chunk) => {
            errors = (errors + chunk).slice(-20_000);
            options.onLog?.(chunk.toString());
        });
        child.on("error", (error) => { clearTimeout(timer); reject(error); });
        child.on("close", (code) => {
            clearTimeout(timer);
            if (failure) reject(failure);
            else if (code !== 0) reject(new Error(`${binary} exited ${code}: ${errors.trim() || output.slice(-2000)}`));
            else resolvePromise(output.trim());
        });
    });
}

export function scriptCommand(snapshot, template, owner, platform = process.platform) {
    return platform === "win32"
        ? ["powershell.exe", ["-NoProfile", "-File", join(snapshot, "create-repo.ps1"), "-Template", template, "-Owner", owner, "-NoClone"]]
        : ["bash", [join(snapshot, "create-repo.sh"), "--template", template, "--owner", owner, "--no-clone"]];
}

function directoryDigest(folder) {
    const hash = createHash("sha256");
    function walk(path) {
        for (const entry of readdirSync(path, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
            const full = join(path, entry.name);
            hash.update(full.slice(folder.length));
            if (entry.isDirectory()) walk(full);
            else if (entry.isFile()) hash.update(readFileSync(full));
            else throw new Error("Unexpected link or special file in starter workspace.");
        }
    }
    walk(folder);
    return hash.digest("hex");
}

export class Provisioner {
    constructor(dir, recipes, run = command, guard = () => {}) {
        this.dir = resolve(dir);
        this.recipes = recipes;
        this.run = async (...args) => {
            guard();
            const result = await run(...args);
            guard();
            return result;
        };
    }
    async identity(settings) {
        const login = await this.run("gh", ["api", "user", "--jq", ".login"]);
        if (login.toLowerCase() !== settings.account.toLowerCase()) {
            throw new Error(`GitHub account mismatch. Authenticate as the configured booth account (${settings.account}); no fallback identity is used.`);
        }
    }
    async api(endpoint, extra = []) {
        return JSON.parse(await this.run("gh", ["api", endpoint, ...extra]));
    }
    async list(endpoint) {
        const pages = await this.api(endpoint, ["--paginate", "--slurp"]);
        return pages.flat();
    }
    async create(row, settings, save) {
        const recipe = this.recipes[row.recipe];
        const workspace = join(this.dir, "orders", row.id);
        mkdirSync(workspace, { recursive: true, mode: 0o700 });
        if (recipe.local) {
            const path = join(workspace, "starter");
            save([{ kind: "local", path }]);
            cpSync(join(root, "copilot-sdk"), path, {
                recursive: true,
                filter: (source) => ![".venv", ".git", "__pycache__", "uv.lock"].includes(source.split(sep).at(-1)),
            });
            save([{ kind: "local", path, digest: directoryDigest(path) }]);
            return;
        }
        await this.identity(settings);
        const checkout = resolve(settings.provisionerPath);
        const origin = await this.run("git", ["-C", checkout, "remote", "get-url", "origin"]);
        if (!/^(https:\/\/github\.com\/|git@github\.com:)octobooth\/repo-setup-scripts(?:\.git)?$/.test(origin)) {
            throw new Error("provisionerPath must be a checkout of octobooth/repo-setup-scripts, not the old launcher repository.");
        }
        const revision = await this.run("git", ["-C", checkout, "rev-parse", "HEAD"]);
        const snapshot = join(workspace, "provisioner");
        mkdirSync(snapshot);
        const archive = join(workspace, "provisioner.tar");
        await this.run("git", ["-C", checkout, "archive", "--format=tar", `--output=${archive}`, revision]);
        await this.run("tar", ["-xf", archive, "-C", snapshot]);
        rmSync(archive);
        const configPath = join(snapshot, "config.json");
        const config = JSON.parse(readFileSync(configPath, "utf8"));
        const resources = [];
        for (const template of recipe.templates) {
            const source = config.repos.find((entry) => entry.key === template);
            if (!source) throw new Error(`Provisioner revision ${revision} does not contain ${template}.`);
            // Change only a private run snapshot, never the source checkout or its config.
            const prefix = `diner-${settings.station}-${row.id.slice(0, 8)}-${template}`;
            const entry = { ...source, repo_base_name: prefix, serve: false };
            if (recipe.deliveryBasics) {
                entry.workflow = "repo_only";
                delete entry.stack;
            }
            config.repos = config.repos.map((item) => item.key === template ? entry : item);
            writeFileSync(configPath, JSON.stringify(config, null, 2));
            const logPath = join(workspace, `${template}.log`);
            const resource = { kind: "remote", key: template, prefix, revision, owner: settings.owner, account: settings.account, config: entry };
            resources.push(resource);
            save(resources);
            let lines = "";
            const log = (text) => appendFileSync(logPath, text, { mode: 0o600 });
            const [binary, args] = scriptCommand(snapshot, template, settings.owner);
            await this.run(binary, args, {
                cwd: snapshot, timeout: settings.readinessMinutes * 60_000,
                env: { ...process.env, DEMO_NO_BROWSER: "1", NO_COLOR: "1" },
                onLog: log,
                onOutput: (text) => {
                    log(text);
                    lines += text;
                    const match = lines.match(/Creating repository: ([\w.-]+\/[\w.-]+)/);
                    if (match && !resource.repo) {
                        const repo = match[1];
                        if (!repo.startsWith(`${settings.owner}/${prefix}-`)) throw new Error("Provisioner returned an unexpected repository identity.");
                        resource.repo = repo;
                        save(resources);
                    }
                },
            });
            if (!resource.repo) throw new Error("Provisioner completed without a repository identity. Inspect its log; do not retry automatically.");
            const metadata = await this.api(`repos/${resource.repo}`);
            resource.repositoryId = metadata.id;
            save(resources);
            if (template === "tailspin-toys") {
                const workflows = await this.api(`repos/${resource.repo}/actions/workflows?per_page=100`);
                const inherited = workflows.workflows.find((workflow) => workflow.path === ".github/workflows/weekly-workshop-triage.lock.yml");
                if (inherited) await this.run("gh", ["workflow", "disable", String(inherited.id), "--repo", resource.repo]);
            }
        }
    }
    async ready(row, settings) {
        const resources = structuredClone(row.resources);
        if (!resources.length) return { ready: false, reason: "No recorded resources." };
        if (resources.some((r) => r.kind === "remote")) await this.identity(settings);
        for (const resource of resources) {
            if (resource.kind === "local") {
                if (!existsSync(join(resource.path, "main.py")) || !existsSync(join(resource.path, "pyproject.toml"))) {
                    return { ready: false, reason: "SDK starter files are missing." };
                }
                resource.digest = directoryDigest(resource.path);
                continue;
            }
            if (!resource.repo || !resource.repositoryId) return { ready: false, reason: "Repository creation was not confirmed." };
            const repo = await this.api(`repos/${resource.repo}`);
            if (repo.id !== resource.repositoryId || repo.full_name.toLowerCase() !== resource.repo.toLowerCase() || repo.archived || repo.disabled) {
                throw new Error("Recorded repository identity or availability changed.");
            }
            const branch = await this.api(`repos/${resource.repo}/branches/${encodeURIComponent(repo.default_branch)}`);
            const pulls = await this.list(`repos/${resource.repo}/pulls?state=open&per_page=100`);
            const entry = resource.config;
            const expected = entry.workflow === "stacked_prs" ? entry.stack : entry.prs || [];
            for (const expectedPr of expected) {
                const pr = pulls.find((p) => p.head.ref === expectedPr.branch);
                if (!pr) return { ready: false, reason: `Missing PR: ${expectedPr.branch}` };
                if (entry.workflow === "code_review_prs" && expectedPr.request_review !== false) {
                    const reviews = await this.list(`repos/${resource.repo}/pulls/${pr.number}/reviews?per_page=100`);
                    if (!reviews.some((review) => review.user?.login === "copilot-pull-request-reviewer[bot]" && review.submitted_at && review.commit_id === pr.head.sha)) {
                        return { ready: false, reason: `Copilot review has not completed for PR ${pr.number}.` };
                    }
                }
            }
            if (["security_prs", "ai_security"].includes(entry.workflow)) {
                const alerts = await this.list(`repos/${resource.repo}/code-scanning/alerts?state=open&per_page=100`);
                const currentAlerts = alerts.filter((alert) => alert.most_recent_instance?.commit_sha === branch.commit.sha ||
                    pulls.some((pr) => pr.head.sha === alert.most_recent_instance?.commit_sha));
                if (!currentAlerts.some((alert) => alert.tool?.name === "CodeQL")) return { ready: false, reason: "No current CodeQL findings." };
                if (entry.ai_scan && !currentAlerts.some((alert) => /(^ai\b|ai code|ai scan)/i.test(alert.tool?.name || ""))) {
                    return { ready: false, reason: "AI scanning findings have not appeared on the prepared revision." };
                }
                if (entry.workflow === "security_prs") {
                    const alert = currentAlerts.find((a) => a.tool?.name === "CodeQL");
                    const autofix = await this.api(`repos/${resource.repo}/code-scanning/alerts/${alert.number}/autofix`);
                    if (autofix.status !== "success") return { ready: false, reason: "Autofix suggestion has not completed." };
                }
            }
            if (["issue_and_codespace", "ai_security"].includes(entry.workflow)) {
                const fixes = pulls.filter((pr) => agents.has(pr.user?.login?.toLowerCase()) && !pr.draft);
                if (!fixes.length) return { ready: false, reason: "Coding agent has not finished a non-draft PR." };
                for (const pr of fixes) {
                    const checks = await this.api(`repos/${resource.repo}/commits/${pr.head.sha}/check-runs?per_page=100`);
                    if (!checks.check_runs.length || checks.check_runs.some((check) => check.status !== "completed" || !["success", "neutral", "skipped"].includes(check.conclusion))) {
                        return { ready: false, reason: "Agent output checks have not passed." };
                    }
                }
            }
            if (entry.workflow === "issue_and_codespace") {
                const issues = await this.list(`repos/${resource.repo}/issues?state=open&per_page=100`);
                const issue = issues.find((item) => !item.pull_request && item.title === entry.issue.title);
                if (!issue) return { ready: false, reason: "Prepared issue is missing." };
                const timeline = await this.list(`repos/${resource.repo}/issues/${issue.number}/timeline?per_page=100`);
                if (!pulls.some((pr) => agents.has(pr.user?.login?.toLowerCase()) && !pr.draft &&
                    timeline.some((event) => event.event === "cross-referenced" && event.source?.issue?.html_url === pr.html_url))) {
                    return { ready: false, reason: "Completed agent PR is not linked to the prepared issue." };
                }
                await this.api(`repos/${resource.repo}/contents/.github/workflows/weekly-workshop-triage.md`);
                const workflows = await this.api(`repos/${resource.repo}/actions/workflows?per_page=100`);
                if (workflows.workflows.some((workflow) => workflow.path === ".github/workflows/weekly-workshop-triage.lock.yml" && workflow.state === "active")) {
                    return { ready: false, reason: "Inherited source-targeted workflow must remain disabled in this environment." };
                }
                const codespaces = await this.api(`repos/${resource.repo}/codespaces`);
                const available = codespaces.codespaces.filter((space) => space.state === "Available" && space.owner?.login.toLowerCase() === settings.account.toLowerCase());
                if (!available.length) return { ready: false, reason: "Codespace is not available for the booth account." };
                resource.codespaces = available.map((space) => space.name).sort();
            }
            if (entry.pages) {
                const pages = await this.api(`repos/${resource.repo}/pages`);
                const runs = await this.api(`repos/${resource.repo}/actions/workflows/pages.yml/runs?per_page=100`);
                if (!runs.workflow_runs.some((run) => run.head_sha === branch.commit.sha && run.conclusion === "success" && run.status === "completed")) {
                    return { ready: false, reason: "Pages deployment has not completed on the default revision." };
                }
                const url = new URL(pages.html_url);
                if (url.protocol !== "https:" || url.hostname !== `${settings.owner.toLowerCase()}.github.io`) throw new Error("Unexpected Pages destination.");
                const response = await fetch(url, { signal: AbortSignal.timeout(15_000), redirect: "error" });
                if (!response.ok) return { ready: false, reason: "Deployed Pages site is not responding successfully." };
                resource.pagesUrl = pages.html_url;
            }
            resource.head = branch.commit.sha;
            resource.pulls = pulls.map((pr) => ({ number: pr.number, sha: pr.head.sha, url: pr.html_url })).sort((a, b) => a.number - b.number);
        }
        return { ready: true, resources };
    }
    async remove(row, settings) {
        if (row.resources.some((r) => r.kind === "remote")) await this.identity(settings);
        for (const resource of row.resources) {
            if (resource.kind !== "remote") continue;
            if (!resource.repo || !resource.repositoryId) throw new Error("Unconfirmed remote ownership. Reconcile this exact order manually; broad cleanup is forbidden.");
            if (resource.account !== settings.account || resource.owner !== settings.owner ||
                !resource.repo.startsWith(`${resource.owner}/${resource.prefix}-`)) throw new Error("Resource ownership does not match this station.");
            const repo = await this.api(`repos/${resource.repo}`);
            if (repo.id !== resource.repositoryId) throw new Error("Repository identity changed; refusing teardown.");
            // Discover even partially prepared Codespaces, but only inside the recorded repository.
            if (resource.config.workflow === "issue_and_codespace") {
                const spaces = await this.api(`repos/${resource.repo}/codespaces`);
                for (const space of spaces.codespaces) {
                    if (space.repository?.id !== resource.repositoryId || space.owner?.login.toLowerCase() !== resource.account.toLowerCase()) {
                        throw new Error("Codespace ownership does not match the recorded environment.");
                    }
                    await this.run("gh", ["codespace", "delete", "--codespace", space.name, "--force"]);
                }
            }
            await this.run("gh", ["repo", "delete", resource.repo, "--yes"]);
        }
        const folder = join(this.dir, "orders", row.id);
        if (!/^[a-f0-9-]{36}$/.test(row.id) || !resolve(folder).startsWith(join(this.dir, "orders") + sep)) throw new Error("Invalid owned workspace.");
        if (existsSync(folder)) rmSync(folder, { recursive: true });
    }
}
