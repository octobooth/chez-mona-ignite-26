import test from "node:test";
import assert from "node:assert/strict";
import vm from "node:vm";
import { readFileSync } from "node:fs";
import { catalog } from "../server.mjs";

function renderer({ qrEnabled = false, media } = {}) {
    const elements = new Map();
    const get = (id) => {
        if (!elements.has(id)) elements.set(id, {
            hidden: false, textContent: "", innerHTML: "", attributes: {}, handlers: {},
            addEventListener(name, callback) { this.handlers[name] = callback; },
            setAttribute(name, value) { this.attributes[name] = value; },
            querySelectorAll: () => [], scrollIntoView() {}, play: async () => {},
        });
        return elements.get(id);
    };
    const requests = [];
    let menu = { dishes: catalog.dishes, qrEnabled, client: "test", order: null, event: "Test" };
    const context = vm.createContext({
        document: { getElementById: get, addEventListener() {}, hidden: false, createElement: () => ({ getContext: () => ({}) }) },
        window: { addEventListener() {} }, navigator: { mediaDevices: { getUserMedia: media || (() => { throw new Error("Unexpected camera request"); }) } },
        URL, URLSearchParams, location: { hash: "" }, history: { replaceState() {} },
        sessionStorage: { getItem() { return "test"; }, setItem() {} },
        setInterval() {}, setTimeout() {}, requestAnimationFrame() {},
        fetch: async (path, options) => {
            requests.push({ path, options });
            return { ok: true, json: async () => path === "/api/menu" ? menu : {
                id: "order", recipe: "sdk", path: "attendee", resources: [],
            } };
        },
    });
    vm.runInContext(readFileSync(new URL("../ui.js", import.meta.url), "utf8"), context);
    return { context, get, requests, setMenu: (value) => { menu = { ...menu, ...value }; }, eval: (code) => vm.runInContext(code, context) };
}

test("QR-disabled mode never requests a camera and direct selection reaches assignment", async () => {
    const ui = renderer();
    await ui.eval("refresh()");
    await ui.eval("startCamera()");
    assert.equal(ui.get("scan").hidden, true);
    await ui.eval("startDish('fried-chicken')");
    const starts = ui.requests.filter((r) => r.path === "/api/start");
    assert.equal(starts.length, 1);
    assert.equal(JSON.parse(starts[0].options.body).dish, "fried-chicken");
    assert.match(ui.get("order").innerHTML, /Microsoft Copilot SDK Fried Chicken/);
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
