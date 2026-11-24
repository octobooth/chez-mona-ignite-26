import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { catalog } from "../server.mjs";

function renderer({ qrEnabled = false, media, startError, clipboard } = {}) {
    const elements = new Map();
    const get = (id) => {
        if (!elements.has(id)) elements.set(id, {
            hidden: false, textContent: "", innerHTML: "", attributes: {}, handlers: {},
            addEventListener(name, callback) { this.handlers[name] = callback; },
            setAttribute(name, value) { this.attributes[name] = value; },
            querySelectorAll: () => [], scrollIntoView() {}, play: async () => {},
            focus() { this.focused = true; }, select() { this.selected = true; },
        });
        return elements.get(id);
    };
    const requests = [];
    let menu = { dishes: catalog.dishes, qrEnabled, client: "test", order: null, event: "Test", environmentEnabled: false,
        sdkSource: readFileSync(new URL("../../../../copilot-sdk/main.py", import.meta.url), "utf8") };
    const context = vm.createContext({
        document: { getElementById: get, addEventListener() {}, hidden: false, createElement: () => ({ getContext: () => ({}) }) },
        window: { addEventListener() {} }, navigator: { clipboard, mediaDevices: { getUserMedia: media || (() => { throw new Error("Unexpected camera request"); }) } },
        URL, URLSearchParams, location: { hash: "" }, history: { replaceState() {} },
        sessionStorage: { getItem() { return "test"; }, setItem() {} },
        setInterval() {}, setTimeout() {}, requestAnimationFrame() {},
        fetch: async (path, options) => {
            requests.push({ path, options });
            if (startError && path.startsWith("/api/start")) return { ok: false, json: async () => ({ error: startError }) };
            return { ok: true, json: async () => path === "/api/menu" ? menu : {
                id: "order", recipe: "sdk", path: "attendee", resources: [],
            } };
        },
    });
    vm.runInContext(readFileSync(new URL("../ui.js", import.meta.url), "utf8"), context);
    return { context, get, requests, setMenu: (value) => { menu = { ...menu, ...value }; }, eval: (code) => vm.runInContext(code, context) };
}

test("QR-disabled mode never requests a camera and opens the guide without allocation", async () => {
    const ui = renderer();
    await ui.eval("refresh()");
    await ui.eval("startCamera()");
    assert.equal(ui.get("scan").hidden, true);
    ui.eval("openDish('fried-chicken')");
    assert.equal(ui.requests.filter((r) => r.path.startsWith("/api/start")).length, 0);
    assert.match(ui.get("order").innerHTML, /LAB GUIDE/);
    assert.match(ui.get("order").innerHTML, /No environment is attached/);
    assert.match(ui.get("order").innerHTML, /define_tool/);
    assert.match(ui.get("order").innerHTML, /Try it in Copilot/);
    assert.doesNotMatch(ui.get("order").innerHTML, /Open in VS Code|Create a local starter/);
    assert.match(ui.get("order").innerHTML, /id="use-environment" disabled/);
});

test("environment creation is a separate explicit action, with errors kept visible", async () => {
    const ui = renderer();
    ui.setMenu({ environmentEnabled: true });
    await ui.eval("refresh()");
    ui.eval("openDish('fried-chicken')");
    await ui.eval("beginEnvironment()");
    const starts = ui.requests.filter((r) => r.path === "/api/start");
    assert.equal(starts.length, 1);
    assert.equal(JSON.parse(starts[0].options.body).dish, "fried-chicken");
    assert.match(ui.get("order").innerHTML, /YOUR ORDER/);
    const blocked = renderer({ startError: "No prepared environment" });
    await blocked.eval("refresh()");
    blocked.eval("openDish('fried-chicken')");
    await blocked.eval("beginEnvironment()");
    assert.equal(blocked.get("notice").textContent, "No prepared environment");
    assert.match(blocked.get("order").innerHTML, /LAB GUIDE/);
    assert.equal(blocked.eval("state.order"), null);
});

test("all five guides and staff variations remain browsable while paused and survive polling", async () => {
    const ui = renderer();
    await ui.eval("refresh()");
    for (const path of ["attendee", "staff"]) {
        ui.eval(`state.path = '${path}'`);
        for (const dish of catalog.dishes) {
            ui.eval(`openDish('${dish.id}')`);
            assert.match(ui.get("order").innerHTML, /LAB GUIDE/);
            assert.ok(ui.get("order").innerHTML.includes(dish.name));
            const markup = ui.get("order").innerHTML;
            await ui.eval("refresh()");
            assert.equal(ui.get("order").innerHTML, markup);
            if (path === "staff") {
                for (const variant of dish.variants) {
                    ui.eval(`openDish('${dish.id}', '${variant.recipe}')`);
                    assert.ok(ui.get("order").innerHTML.includes(variant.label.replace("&", "&amp;")));
                }
            }
        }
    }
    assert.equal(ui.requests.filter((r) => r.options?.method === "POST").length, 0);
});

test("browsing another guide does not discard an active local order", async () => {
    const ui = renderer();
    ui.setMenu({ environmentEnabled: true });
    await ui.eval("refresh()");
    ui.eval("openDish('fried-chicken')");
    await ui.eval("beginEnvironment()");
    assert.equal(ui.requests.filter((r) => r.path === "/api/start").length, 1);
    ui.eval("openDish('fusilli')");
    assert.match(ui.get("order").innerHTML, /Finish your open order/);
    assert.equal(ui.eval("state.order.id"), "order");
    ui.eval("returnToOrder()");
    assert.match(ui.get("order").innerHTML, /YOUR ORDER/);
});

test("Copilot prompt copying is explicit, source-grounded, and reports clipboard denial", async () => {
    const copied = [];
    const ui = renderer({ clipboard: { writeText: async (text) => { copied.push(text); } } });
    await ui.eval("refresh()");
    ui.eval("openDish('fried-chicken')");
    assert.match(ui.get("order").innerHTML, /Bundled main.py:/);
    assert.match(ui.get("order").innerHTML, /class GetMenuParams/);
    ui.get("prompt-0").value = "A prompt selected by the guest";
    await ui.eval("copyPrompt(0)");
    assert.deepEqual(copied, ["A prompt selected by the guest"]);
    assert.match(ui.get("copy-status").textContent, /Paste into the Copilot conversation/);
    assert.equal(ui.requests.filter((r) => r.options?.method === "POST").length, 0);

    for (const clipboard of [undefined, { writeText: async () => { throw new Error("Clipboard permission denied"); } }]) {
        const blocked = renderer({ clipboard });
        await blocked.eval("refresh()");
        blocked.eval("openDish('fusilli')");
        await blocked.eval("copyPrompt(0)");
        assert.equal(blocked.get("prompt-0").selected, true);
        assert.equal(blocked.get("prompt-0").focused, true);
        assert.match(blocked.get("copy-status").textContent, /copy it manually/);
        assert.doesNotMatch(blocked.get("copy-status").textContent, /^Copied/);
    }
});

test("existing QR payload normalization supports all five dishes without URL execution", async () => {
    const ui = renderer({ qrEnabled: true });
    await ui.eval("refresh()");
    assert.equal(ui.get("scan").hidden, false);
    assert.equal(ui.eval("decodeTicket(' Fried_Chicken ')"), "fried-chicken");
    assert.equal(ui.eval("decodeTicket('sandwich')"), "sandwich");
    assert.equal(ui.eval("decodeTicket('https://example.com/fusilli')"), null);
    assert.equal(ui.eval("decodeTicket('unknown')"), null);
});

test("returning to the menu permits ticket scanning without releasing an active order", async () => {
    let requested = 0;
    let stopped = 0;
    const ui = renderer({ qrEnabled: true, media: async () => {
        requested++;
        return { getTracks: () => [{ stop: () => stopped++ }] };
    } });
    ui.setMenu({ order: { id: "owned", recipe: "sdk", path: "attendee", resources: [] } });
    await ui.eval("refresh()");
    await ui.eval("startCamera()");
    assert.equal(requested, 0);
    ui.get("back-menu").handlers.click();
    assert.equal(ui.get("scan").hidden, false);
    await ui.eval("startCamera()");
    assert.equal(requested, 1);
    assert.equal(ui.eval("state.order.id"), "owned");
    ui.eval("openDish('fusilli')");
    assert.equal(stopped, 1);
    assert.equal(ui.eval("state.order.id"), "owned");
    assert.equal(ui.requests.filter((r) => r.options?.method === "POST").length, 0);
});

test("disabling QR while camera permission is pending stops the returned stream", async () => {
    let resolveMedia;
    let stopped = 0;
    const ui = renderer({ qrEnabled: true, media: () => new Promise((resolve) => { resolveMedia = resolve; }) });
    await ui.eval("refresh()");
    const pending = ui.eval("startCamera()");
    ui.eval("setQr(false)");
    resolveMedia({ getTracks: () => [{ stop: () => stopped++ }] });
    await pending;
    assert.equal(stopped, 1);
    assert.equal(ui.get("scan").hidden, true);
});
