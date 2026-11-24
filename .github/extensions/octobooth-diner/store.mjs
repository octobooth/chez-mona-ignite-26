import { DatabaseSync } from "node:sqlite";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import { randomUUID } from "node:crypto";

export class Store {
    constructor(dir) {
        mkdirSync(dir, { recursive: true, mode: 0o700 });
        this.db = new DatabaseSync(join(dir, "station.sqlite"));
        this.db.exec(`
            PRAGMA journal_mode=WAL;
            PRAGMA busy_timeout=5000;
            CREATE TABLE IF NOT EXISTS settings (key TEXT PRIMARY KEY, value TEXT NOT NULL);
            CREATE TABLE IF NOT EXISTS environments (
                id TEXT PRIMARY KEY, event TEXT NOT NULL, recipe TEXT NOT NULL,
                state TEXT NOT NULL, resources TEXT NOT NULL DEFAULT '[]',
                assigned TEXT, client TEXT, path TEXT, error TEXT,
                created INTEGER NOT NULL, checked INTEGER, retainUntil INTEGER NOT NULL
            );
            CREATE UNIQUE INDEX IF NOT EXISTS active_client ON environments(client) WHERE state='assigned';
            CREATE TABLE IF NOT EXISTS faults (
                id INTEGER PRIMARY KEY, at INTEGER NOT NULL, message TEXT NOT NULL
            );
        `);
    }
    transaction(fn) {
        this.db.exec("BEGIN IMMEDIATE");
        try {
            const result = fn();
            this.db.exec("COMMIT");
            return result;
        } catch (error) {
            this.db.exec("ROLLBACK");
            throw error;
        }
    }
    get(key, fallback = null) {
        const row = this.db.prepare("SELECT value FROM settings WHERE key=?").get(key);
        return row ? JSON.parse(row.value) : fallback;
    }
    set(key, value) {
        this.db.prepare("INSERT OR REPLACE INTO settings VALUES (?,?)").run(key, JSON.stringify(value));
    }
    list() {
        return this.db.prepare("SELECT * FROM environments ORDER BY created, id").all()
            .map((row) => ({ ...row, resources: JSON.parse(row.resources) }));
    }
    find(id) {
        return this.list().find((row) => row.id === id);
    }
    update(id, values) {
        const allowed = new Set(["state", "resources", "assigned", "client", "path", "error", "checked"]);
        for (const [key, value] of Object.entries(values)) {
            if (!allowed.has(key)) throw new Error(`Unknown environment field: ${key}`);
            this.db.prepare(`UPDATE environments SET ${key}=? WHERE id=?`)
                .run(key === "resources" ? JSON.stringify(value) : value, id);
        }
    }
    add(event, recipe, retainUntil) {
        const id = randomUUID();
        this.db.prepare("INSERT INTO environments (id,event,recipe,state,created,retainUntil) VALUES (?,?,?,'queued',?,?)")
            .run(id, event, recipe, Date.now(), retainUntil);
        return this.find(id);
    }
    fault(message) {
        this.db.prepare("INSERT INTO faults(at,message) VALUES (?,?)").run(Date.now(), message);
    }
    faults() {
        return this.db.prepare("SELECT * FROM faults ORDER BY id DESC LIMIT 50").all();
    }
    close() { this.db.close(); }
}

export function validateSettings(input, recipes) {
    const slug = /^[a-z0-9][a-z0-9-]{0,38}$/;
    if (!input || !slug.test(input.event) || !slug.test(input.station)) {
        throw new Error("Event and station must be lowercase names containing letters, digits, or hyphens.");
    }
    if (typeof input.qrEnabled !== "boolean") throw new Error("qrEnabled must be a boolean.");
    if (!Number.isInteger(input.maxResources) || input.maxResources < 1) throw new Error("Choose an explicit positive resource budget.");
    if (!Number.isInteger(input.readinessMinutes) || input.readinessMinutes < 1) throw new Error("Choose an explicit readiness deadline in minutes.");
    if (!Number.isFinite(Date.parse(input.eventEnd))) throw new Error("Set the event end date (ISO 8601).");
    if (!input.reserve || typeof input.reserve !== "object" || Array.isArray(input.reserve)) throw new Error("Set per-recipe reserve targets.");
    let required = 0;
    for (const [key, target] of Object.entries(input.reserve)) {
        if (!recipes[key] || !Number.isInteger(target) || target < 0) throw new Error(`Invalid reserve target: ${key}`);
        required += target * (recipes[key].templates?.length || 1);
    }
    if (required > input.maxResources) throw new Error("Reserve targets exceed the resource budget.");
    if (Object.entries(input.reserve).some(([key, count]) => count > 0 && !recipes[key].local)) {
        if (!/^[\w-]+$/.test(input.account || "") || !/^[\w-]+$/.test(input.owner || "") || !input.provisionerPath) {
            throw new Error("Remote recipes require the exact booth account, target owner, and provisioner checkout path.");
        }
    }
    if ((input.reserve.soup || 0) > 0 && input.allowCodespaces !== true) throw new Error("Soup creates a paid Codespace; explicitly approve allowCodespaces.");
    return { ...input, enabled: false };
}
