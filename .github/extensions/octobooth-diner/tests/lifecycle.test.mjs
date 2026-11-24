import test from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Store, validateSettings } from "../store.mjs";
import { Kitchen } from "../lifecycle.mjs";
import { Provisioner } from "../provisioner.mjs";
import { catalog } from "../server.mjs";

function fixture(t, adapter = {
    create: async (row, settings, save) => save([{ kind: "test", revision: "clean" }]),
    ready: async (row) => ({ ready: true, resources: row.resources }),
    remove: async () => {},
}) {
    const dir = mkdtempSync(join(tmpdir(), "diner-test-"));
    const store = new Store(dir);
    const settings = { event: "test-event", station: "test", eventEnd: new Date(Date.now() + 86400_000).toISOString(),
        qrEnabled: false, maxResources: 4, reserve: { sdk: 1 }, readinessMinutes: 10, enabled: true };
    store.set("event", settings);
    const kitchen = new Kitchen(store, adapter, catalog.recipes);
    t.after(() => { store.close(); rmSync(dir, { recursive: true }); });
    return { dir, store, kitchen, settings };
}
const order = (client = "guest") => ({ dish: "fried-chicken", path: "attendee", client });

test("one station assignment wins concurrently; retirement replenishes without reusing work", async (t) => {
    const { store, kitchen } = fixture(t);
    await kitchen.tick();
    const first = store.list()[0];
    const results = await Promise.allSettled([kitchen.assign(order(), catalog.dishes), kitchen.assign(order(), catalog.dishes)]);
    assert.equal(results.filter((r) => r.status === "fulfilled").length, 1);
    assert.equal(store.find(first.id).state, "assigned");
    kitchen.retire(first.id, "guest");
    await kitchen.tick();
    const second = await kitchen.assign(order(), catalog.dishes);
    assert.notEqual(first.id, second.id);
    assert.equal(store.find(first.id).state, "retired");
    assert.ok(store.find(first.id).assigned);
});

test("budget counts retained work, and quarantined preparation does not trigger infinite retries", async (t) => {
    let attempts = 0;
    const { store, kitchen, settings } = fixture(t, {
        create: async () => { attempts++; throw new Error("Missing entitlement"); },
    });
    store.set("event", { ...settings, maxResources: 1 });
    await kitchen.tick();
    await kitchen.tick();
    assert.equal(attempts, 1);
    assert.equal(store.list().length, 1);
    kitchen.retire(store.list()[0].id);
    await kitchen.tick();
    assert.equal(store.list().length, 1);
    assert.match(store.faults()[0].message, /budget/);
});

test("readiness gates and changed resources block handout; no success fallback", async (t) => {
    let ready = false;
    let changed = false;
    const { store, kitchen } = fixture(t, {
        create: async (row, settings, save) => save([{ revision: "clean" }]),
        ready: async (row) => ({ ready, reason: "Waiting for review", resources: changed ? [{ revision: "edited" }] : row.resources }),
    });
    await kitchen.tick();
    assert.equal(store.list()[0].state, "validating");
    await assert.rejects(kitchen.assign(order(), catalog.dishes), /cannot be served/);
    ready = true;
    await kitchen.tick();
    changed = true;
    await assert.rejects(kitchen.assign(order(), catalog.dishes), /not handed out/);
    assert.equal(store.list()[0].state, "quarantined");
});

test("slow validation does not starve other recipes", async (t) => {
    const { store, kitchen, settings } = fixture(t, {
        create: async (row, settings, save) => save([{ recipe: row.recipe }]),
        ready: async (row) => ({ ready: row.recipe === "sdk", resources: row.resources, reason: "Waiting" }),
    });
    store.set("event", { ...settings, reserve: { fusion: 1, sdk: 1 } });
    await kitchen.tick();
    await kitchen.tick();
    assert.equal(store.list().find((r) => r.recipe === "sdk").state, "ready");
});

test("restart quarantines uncertain operations but preserves assigned ownership", async (t) => {
    const { store, kitchen, settings } = fixture(t);
    for (const state of ["creating", "checking", "deleting", "assigned", "retired"]) {
        const row = store.add(settings.event, "sdk", 0);
        store.update(row.id, { state, assigned: state === "assigned" ? "earlier" : null });
    }
    kitchen.recover();
    assert.deepEqual(store.list().map((r) => r.state).sort(), ["assigned", "quarantined", "quarantined", "quarantined", "retired"]);
});

test("teardown requires retirement, retention expiry and review, and names one order", async (t) => {
    const removed = [];
    const { store, kitchen, settings } = fixture(t, { remove: async (row) => removed.push(row.id) });
    const row = store.add(settings.event, "sdk", Date.now() + 86400_000);
    await assert.rejects(kitchen.teardown(row.id, true), /retired/);
    kitchen.retire(row.id);
    await assert.rejects(kitchen.teardown(row.id, false), /review/);
    await assert.rejects(kitchen.teardown(row.id, true), /seven days/);
    const expired = store.add(settings.event, "sdk", 0);
    kitchen.retire(expired.id);
    await kitchen.teardown(expired.id, true);
    assert.deepEqual(removed, [expired.id]);
    assert.equal(store.find(row.id).state, "retired");
});

test("SDK preparation creates fresh real copies and detects modifications", async (t) => {
    const { dir, store, settings } = fixture(t);
    const adapter = new Provisioner(dir, catalog.recipes);
    const row = store.add(settings.event, "sdk", 0);
    await adapter.create(row, settings, (resources) => store.update(row.id, { resources }));
    const before = await adapter.ready(store.find(row.id), settings);
    assert.equal(before.ready, true);
    const path = before.resources[0].path;
    writeFileSync(join(path, "main.py"), "# attendee work\n");
    const after = await adapter.ready(store.find(row.id), settings);
    assert.notEqual(before.resources[0].digest, after.resources[0].digest);
    const next = store.add(settings.event, "sdk", 0);
    await adapter.create(next, settings, (resources) => store.update(next.id, { resources }));
    assert.notEqual(store.find(next.id).resources[0].path, path);
    assert.equal((await adapter.ready(store.find(next.id), settings)).resources[0].digest, before.resources[0].digest);
});

test("event config requires capacity and explicit Codespace approval", () => {
    const config = { event: "event", station: "station", qrEnabled: false, eventEnd: "2026-12-01T18:00:00Z",
        reserve: { soup: 1 }, maxResources: 2, readinessMinutes: 30, account: "booth", owner: "octobooth", provisionerPath: "/checkout" };
    assert.throws(() => validateSettings(config, catalog.recipes), /paid Codespace/);
    assert.equal(validateSettings({ ...config, allowCodespaces: true }, catalog.recipes).enabled, false);
    assert.throws(() => validateSettings({ ...config, reserve: { dip: 2 } }, catalog.recipes), /exceed/);
});

test("lost worker ownership cannot publish a result or resurrect retired work", async (t) => {
    let finish;
    let owns = true;
    const { store, kitchen } = fixture(t, {
        create: async (row, settings, save) => save([{ kind: "test" }]),
        ready: async () => new Promise((resolve) => { finish = resolve; }),
    });
    kitchen.guard = () => { if (!owns) throw new Error("Lease lost"); };
    const pending = kitchen.tick();
    await new Promise((resolve) => setImmediate(resolve));
    const row = store.list()[0];
    assert.throws(() => kitchen.retire(row.id), /still running/);
    owns = false;
    store.update(row.id, { state: "quarantined" });
    finish({ ready: true, resources: row.resources });
    await assert.rejects(pending, /Lease lost/);
    assert.equal(store.find(row.id).state, "quarantined");
});
