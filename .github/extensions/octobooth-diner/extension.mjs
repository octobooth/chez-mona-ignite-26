import { spawn } from "node:child_process";
import { existsSync, mkdirSync, openSync, closeSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { joinSession, createCanvas } from "@microsoft/copilot-sdk/extension";

const here = dirname(fileURLToPath(import.meta.url));
const instances = new Map();
const stationSchema = { type: "object", properties: { station: { type: "string", description: "Stable station identifier; defaults to preview (no provisioning)." } } };
const settingsSchema = {
    type: "object",
    properties: {
        event: { type: "string" }, station: { type: "string" },
        account: { type: "string", description: "Exact authenticated booth account. No account fallback." },
        owner: { type: "string", description: "Explicit owner for generated repositories." },
        provisionerPath: { type: "string", description: "Existing checkout of octobooth/repo-setup-scripts." },
        eventEnd: { type: "string", description: "ISO 8601 event end; resources retained for seven more days and explicit review." },
        qrEnabled: { type: "boolean" }, allowCodespaces: { type: "boolean" },
        maxResources: { type: "integer", description: "Hard ceiling including retained resources; dip uses two repositories." },
        readinessMinutes: { type: "integer" },
        reserve: {
            type: "object", description: "Explicit warm reserve per recipe. Choose based on arrival rate and provisioning time; no availability guarantee.",
            properties: Object.fromEntries(["fusion", "fusion-blank", "sdk", "soup", "dip", "dip-agent", "delivery", "delivery-stack"].map((key) => [key, { type: "integer", minimum: 0 }])),
            additionalProperties: false,
        },
    },
    required: ["event", "station", "eventEnd", "qrEnabled", "maxResources", "readinessMinutes", "reserve"],
    additionalProperties: false,
};

async function connect(station) {
    if (!/^[a-z0-9][a-z0-9-]{0,38}$/.test(station)) throw new Error("Invalid station name.");
    const dir = join(process.env.COPILOT_HOME || join(homedir(), ".copilot"), "octobooth-diner", station);
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    async function probe() {
        if (!existsSync(join(dir, "endpoint.json"))) return null;
        const endpoint = JSON.parse(readFileSync(join(dir, "endpoint.json"), "utf8"));
        try {
            const response = await fetch(`${endpoint.origin}/staff/status`, { headers: { Authorization: `Bearer ${endpoint.staffToken}` }, signal: AbortSignal.timeout(1000) });
            if (response.ok) return endpoint;
            throw new Error(`Station returned HTTP ${response.status}; inspect operator.log.`);
        } catch (error) {
            if (error.cause?.code === "ECONNREFUSED" || error.name === "TimeoutError") return null;
            throw error;
        }
    }
    const existing = await probe();
    if (existing) return existing;
    const log = openSync(join(dir, "worker.log"), "a", 0o600);
    // The host executable can be the bundled Copilot CLI, not a standalone Node binary.
    const child = spawn("node", [join(here, "server.mjs"), dir, station], {
        detached: true, stdio: ["ignore", log, log],
    });
    closeSync(log);
    let spawnError;
    child.on("error", (error) => { spawnError = error; });
    child.unref();
    for (let attempt = 0; attempt < 40; attempt++) {
        if (spawnError) throw spawnError;
        await new Promise((resolve) => setTimeout(resolve, 1000));
        const endpoint = await probe();
        if (endpoint) return endpoint;
    }
    throw new Error("Station worker did not start. Inspect worker.log; no provisioning was retried.");
}

async function staffAction(ctx, path, method = "POST") {
    const station = instances.get(ctx.instanceId);
    if (!station) throw new Error("Reopen the diner canvas before using a staff action.");
    const endpoint = await connect(station);
    const response = await fetch(`${endpoint.origin}/staff/${path}`, {
        method, headers: { Authorization: `Bearer ${endpoint.staffToken}`, "Content-Type": "application/json" },
        body: method === "POST" ? JSON.stringify(ctx.input || {}) : undefined,
    });
    const result = await response.json();
    if (!response.ok) throw new Error(result.error);
    return result;
}

await joinSession({
    canvases: { definitions: [createCanvas({
        id: "octobooth-diner",
        displayName: "Octobooth diner",
        description: "Five diner dishes for hands-on labs and staff-led demos. Station pools require explicit staff configuration and authorization.",
        inputSchema: stationSchema,
        actions: [
            { name: "configure_event", description: "Persist event/station settings; provisioning remains paused. Do not invent capacity, account, event dates, or cost approval.", inputSchema: settingsSchema, handler: (ctx) => staffAction(ctx, "configure") },
            { name: "set_qr_experience", description: "Staff-only event QR toggle. Disabled means direct dish selection, no camera or scan requirement.", inputSchema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] }, handler: (ctx) => staffAction(ctx, "qr") },
            { name: "set_kitchen_enabled", description: "Start or pause actual reserve provisioning. Enabling creates repositories and may incur costs; use only after explicit approval. Pausing does not cancel in-flight work.", inputSchema: { type: "object", properties: { enabled: { type: "boolean" } }, required: ["enabled"] }, handler: (ctx) => staffAction(ctx, "power") },
            { name: "operator_status", description: "Read internal ownership, readiness evidence and actionable errors. These are deliberately absent from the attendee diner UI.", handler: (ctx) => staffAction(ctx, "status", "GET") },
            { name: "retire_order", description: "Permanently remove this exact order from circulation. Never recycle attendee work.", inputSchema: { type: "object", properties: { id: { type: "string" } }, required: ["id"] }, handler: (ctx) => staffAction(ctx, "retire") },
            { name: "teardown_order", description: "Delete only this recorded retired order after retention and explicit review. Requires separate user authorization; never run broad cleanup.", inputSchema: { type: "object", properties: { id: { type: "string" }, reviewed: { type: "boolean" } }, required: ["id", "reviewed"] }, handler: (ctx) => staffAction(ctx, "teardown") },
        ],
        open: async (ctx) => {
            const station = ctx.input?.station || instances.get(ctx.instanceId) || "preview";
            const endpoint = await connect(station);
            instances.set(ctx.instanceId, station);
            return { title: "Octobooth diner", url: `${endpoint.origin}/#access=${endpoint.guestToken}` };
        },
        // Closing a panel must not cancel preparation or release an assigned environment.
        onClose: async (ctx) => { instances.delete(ctx.instanceId); },
    })] },
});
