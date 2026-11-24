import { createServer } from "node:http";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFileSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { Store, validateSettings } from "./store.mjs";
import { Kitchen } from "./lifecycle.mjs";
import { Provisioner } from "./provisioner.mjs";

const here = dirname(fileURLToPath(import.meta.url));
const root = resolve(here, "../../..");
export const catalog = JSON.parse(readFileSync(join(here, "catalog.json"), "utf8"));
const assets = new Map([
    ["/", [join(here, "ui.html"), "text/html; charset=utf-8"]],
    ["/ui.js", [join(here, "ui.js"), "text/javascript; charset=utf-8"]],
    ["/ui.css", [join(here, "ui.css"), "text/css; charset=utf-8"]],
    ["/jsQR.js", [join(root, "launcher/static/vendor/jsQR.js"), "text/javascript; charset=utf-8"]],
    ["/mona.svg", [join(root, "launcher/static/mona-chef.svg"), "image/svg+xml"]],
    ["/MonaSans.woff2", [join(root, "launcher/static/fonts/MonaSansVF.woff2"), "font/woff2"]],
]);

export async function startStation(dir, station, { adapter, polling = true } = {}) {
    const store = new Store(dir);
    const workerId = randomUUID();
    const acquired = store.transaction(() => {
        const lease = store.get("worker");
        if (lease && lease.expires > Date.now()) return false;
        store.set("worker", { id: workerId, expires: Date.now() + 30_000 });
        return true;
    });
    if (!acquired) {
        store.close();
        throw Object.assign(new Error("A worker already owns this station."), { code: "STATION_OWNED" });
    }
    const active = () => {
        const lease = store.get("worker");
        if (lease?.id !== workerId || lease.expires <= Date.now()) throw new Error("Station ownership expired; reopen the canvas.");
    };
    const kitchen = new Kitchen(store, adapter || new Provisioner(dir, catalog.recipes, undefined, active), catalog.recipes, active);
    kitchen.recover();
    const stationClient = store.get("client") || randomUUID();
    store.set("client", stationClient);
    const guestToken = randomBytes(32).toString("hex");
    const staffToken = randomBytes(32).toString("hex");
    let origin;
    const send = (res, code, data) => {
        res.writeHead(code, { "Content-Type": "application/json" });
        res.end(JSON.stringify(data));
    };
    const publicOrder = (row) => row ? {
        id: row.id, recipe: row.recipe, path: row.path,
        resources: row.resources.map((resource) => resource.kind === "local"
            ? { kind: "local", path: resource.path }
            : { kind: "remote", repo: resource.repo, url: `https://github.com/${resource.repo}`, pagesUrl: resource.pagesUrl, pulls: resource.pulls }),
    } : null;
    const server = createServer(async (req, res) => {
        res.setHeader("Cache-Control", "no-store");
        res.setHeader("X-Content-Type-Options", "nosniff");
        res.setHeader("Referrer-Policy", "no-referrer");
        res.setHeader("Content-Security-Policy", "default-src 'self'; script-src 'self'; style-src 'self'; img-src 'self' data:; font-src 'self'; connect-src 'self'; media-src 'self' blob:; base-uri 'none'; form-action 'self'");
        try {
            if (req.headers.host !== new URL(origin).host) return send(res, 403, { error: "Unexpected host." });
            active();
            const url = new URL(req.url, origin);
            if (req.method === "GET" && assets.has(url.pathname)) {
                const [file, type] = assets.get(url.pathname);
                res.writeHead(200, { "Content-Type": type });
                return res.end(readFileSync(file));
            }
            const staff = req.headers.authorization === `Bearer ${staffToken}`;
            const guest = req.headers.authorization === `Bearer ${guestToken}`;
            if (!staff && !guest) return send(res, 401, { error: "Open the diner from its native canvas." });
            if (req.method === "GET" && url.pathname === "/api/menu") {
                const settings = store.get("event");
                const order = store.list().find((row) => row.client === stationClient && row.state === "assigned");
                return send(res, 200, {
                    dishes: catalog.dishes, event: settings?.event || "Welcome to Octobooth",
                    qrEnabled: settings?.qrEnabled ?? false, configured: Boolean(settings),
                    environmentEnabled: Boolean(settings?.enabled && Date.now() <= Date.parse(settings.eventEnd)),
                    sdkSource: readFileSync(join(root, "copilot-sdk/main.py"), "utf8"),
                    client: stationClient, order: publicOrder(order),
                });
            }
            if (req.method === "GET" && url.pathname === "/staff/status" && staff) {
                return send(res, 200, { settings: store.get("event"), environments: store.list(), faults: store.faults() });
            }
            if (req.method !== "POST") return send(res, 404, { error: "Not found." });
            if (!staff && req.headers.origin !== origin) return send(res, 403, { error: "Same-origin requests only." });
            if (req.headers["content-type"] !== "application/json") return send(res, 415, { error: "JSON required." });
            let raw = "";
            for await (const chunk of req) {
                raw += chunk;
                if (raw.length > 32_768) return send(res, 413, { error: "Request too large." });
            }
            const body = JSON.parse(raw);
            if (url.pathname === "/api/start") {
                return send(res, 200, publicOrder(await kitchen.assign({ ...body, client: stationClient }, catalog.dishes)));
            }
            if (url.pathname === "/api/finish") {
                kitchen.retire(body.id, stationClient);
                return send(res, 200, { finished: true });
            }
            if (!staff) return send(res, 403, { error: "Staff action required." });
            if (url.pathname === "/staff/configure") {
                if (kitchen.busy) throw new Error("Pause the kitchen and wait for its current operation before reconfiguring.");
                if (store.list().some((row) => !["retired", "deleted"].includes(row.state))) throw new Error("Retire existing orders before changing event settings.");
                const settings = validateSettings(body, catalog.recipes);
                if (settings.station !== station) throw new Error("Settings must match this station.");
                const previous = store.get("event");
                if (previous && store.list().some((row) => row.state !== "deleted") &&
                    (previous.account !== settings.account || previous.owner !== settings.owner)) throw new Error("Keep the owning account and owner until retained resources have been reviewed and deleted.");
                store.set("event", settings);
                return send(res, 200, { configured: true, provisioning: "paused" });
            }
            if (url.pathname === "/staff/qr") {
                if (typeof body.enabled !== "boolean") throw new Error("enabled must be a boolean.");
                const settings = store.get("event");
                if (!settings) throw new Error("Configure the event first.");
                store.set("event", { ...settings, qrEnabled: body.enabled });
                return send(res, 200, { qrEnabled: body.enabled });
            }
            if (url.pathname === "/staff/power") {
                const settings = store.get("event");
                if (!settings || typeof body.enabled !== "boolean") throw new Error("Configure the event and choose enabled true or false.");
                if (body.enabled && Date.now() > Date.parse(settings.eventEnd)) throw new Error("The event has ended.");
                store.set("event", { ...settings, enabled: body.enabled });
                return send(res, 200, { enabled: body.enabled });
            }
            if (url.pathname === "/staff/retire") {
                kitchen.retire(body.id);
                return send(res, 200, { retired: body.id });
            }
            if (url.pathname === "/staff/teardown") {
                await kitchen.teardown(body.id, body.reviewed);
                return send(res, 200, { deleted: body.id });
            }
            return send(res, 404, { error: "Not found." });
        } catch (error) {
            appendFileSync(join(dir, "operator.log"), `${new Date().toISOString()} ${error.message}\n`, { mode: 0o600 });
            send(res, 400, { error: error.message });
        }
    });
    await new Promise((resolveListen, reject) => {
        server.once("error", reject);
        server.listen(0, "127.0.0.1", resolveListen);
    });
    origin = `http://127.0.0.1:${server.address().port}`;
    const endpoint = { origin, guestToken, staffToken, pid: process.pid, workerId };
    writeFileSync(join(dir, "endpoint.json"), JSON.stringify(endpoint), { mode: 0o600 });
    const timer = setInterval(() => {
        try {
            active();
            store.set("worker", { id: workerId, expires: Date.now() + 30_000 });
            if (polling) kitchen.tick().catch((error) => kitchen.report(error.message));
        } catch (error) {
            console.error(error.message);
            clearInterval(timer);
            server.close();
        }
    }, 5000);
    return {
        endpoint, store, kitchen,
        close: async () => {
            clearInterval(timer);
            await new Promise((resolveClose) => server.close(resolveClose));
            store.transaction(() => {
                if (store.get("worker")?.id === workerId) store.set("worker", null);
            });
            store.close();
        },
    };
}

if (process.argv[1] && resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
    const [dir, station] = process.argv.slice(2);
    if (!dir || !/^[a-z0-9][a-z0-9-]{0,38}$/.test(station || "")) throw new Error("Usage: node server.mjs STATE_DIRECTORY STATION");
    for (let attempt = 0; ; attempt++) {
        try {
            await startStation(dir, station);
            break;
        } catch (error) {
            if (error.code !== "STATION_OWNED" || attempt >= 16) throw error;
            await new Promise((resolveWait) => setTimeout(resolveWait, 2000));
        }
    }
}
