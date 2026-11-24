import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startStation } from "../server.mjs";

test("QR setting persists, station orders rehydrate, and staff operations are not guest APIs", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diner-http-"));
    const adapter = {
        create: async (row, settings, save) => save([{ kind: "local", path: "/test/starter" }]),
        ready: async (row) => ({ ready: true, resources: row.resources }),
    };
    let station = await startStation(dir, "test", { adapter, polling: false });
    const request = async (path, body, staff = false, foreign = false) => {
        const { origin, guestToken, staffToken } = station.endpoint;
        const response = await fetch(origin + path, {
            method: body === undefined ? "GET" : "POST",
            headers: { "Content-Type": "application/json", Origin: foreign ? "https://example.com" : origin,
                Authorization: `Bearer ${staff ? staffToken : guestToken}` },
            body: body === undefined ? undefined : JSON.stringify(body),
        });
        return { status: response.status, data: await response.json() };
    };
    try {
        const config = { event: "test-event", station: "test", eventEnd: new Date(Date.now() + 86400_000).toISOString(),
            qrEnabled: true, maxResources: 4, reserve: { sdk: 1 }, readinessMinutes: 10 };
        assert.equal((await request("/staff/configure", config)).status, 403);
        assert.equal((await request("/staff/configure", config, true)).status, 200);
        assert.equal((await request("/api/menu")).data.qrEnabled, true);
        assert.equal((await request("/staff/qr", { enabled: false }, true)).status, 200);
        assert.equal((await request("/api/menu")).data.qrEnabled, false);
        assert.equal((await request("/api/start", {}, false, true)).status, 403);
        await request("/staff/power", { enabled: true }, true);
        await station.kitchen.tick();
        const start = await request("/api/start", { dish: "fried-chicken", path: "attendee" });
        assert.equal(start.status, 200);
        const before = (await request("/api/menu")).data;
        assert.equal(before.dishes.length, 5);
        assert.ok(!("environments" in before));
        assert.ok(!("faults" in before));
        await station.close();
        station = await startStation(dir, "test", { adapter, polling: false });
        const after = (await request("/api/menu")).data;
        assert.equal(after.qrEnabled, false);
        assert.equal(after.client, before.client);
        assert.equal(after.order.id, start.data.id);
        assert.equal((await request("/api/finish", { id: start.data.id })).status, 200);
        assert.equal((await request("/api/menu")).data.order, null);
    } finally {
        await station.close();
        rmSync(dir, { recursive: true });
    }
});

test("only one worker can own a station", async () => {
    const dir = mkdtempSync(join(tmpdir(), "diner-lease-"));
    const station = await startStation(dir, "test", { polling: false });
    try {
        await assert.rejects(startStation(dir, "test", { polling: false }), /already owns/);
    } finally {
        await station.close();
        rmSync(dir, { recursive: true });
    }
});
