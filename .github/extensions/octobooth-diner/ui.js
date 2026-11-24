"use strict";
const element = (id) => document.getElementById(id);
const access = new URLSearchParams(location.hash.slice(1)).get("access") || sessionStorage.getItem("diner-access");
if (access) sessionStorage.setItem("diner-access", access);
if (location.hash) history.replaceState(null, "", "/");
let client;
const state = { dishes: [], path: "attendee", order: null, qrEnabled: false, stream: null, generation: 0, starting: false };
const escape = (text) => String(text).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const notify = (message) => { element("notice").textContent = message; element("notice").hidden = !message; };
async function api(path, body) {
    const response = await fetch(path, {
        method: body === undefined ? "GET" : "POST",
        headers: { Authorization: `Bearer ${access}`, "Content-Type": "application/json" },
        body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.error);
    return data;
}
function stopCamera() {
    state.generation++;
    state.stream?.getTracks().forEach((track) => track.stop());
    state.stream = null;
    element("video").srcObject = null;
    element("video").hidden = true;
}
function setQr(enabled) {
    state.qrEnabled = enabled;
    element("scan").hidden = !enabled || Boolean(state.order) || state.path === "staff";
    if (!enabled || element("scan").hidden) stopCamera();
}
function renderMenu() {
    element("attendee").setAttribute("aria-pressed", String(state.path === "attendee"));
    element("staff").setAttribute("aria-pressed", String(state.path === "staff"));
    element("menu-section").hidden = Boolean(state.order);
    element("order").hidden = !state.order;
    setQr(state.qrEnabled);
    element("menu").innerHTML = state.dishes.map((dish, index) => `
        <article class="dish">
          <span class="number" aria-hidden="true">0${index + 1}</span>
          <p class="tag">${escape(dish.tag)}</p>
          <h3>${escape(dish.name)}</h3><p>${escape(dish.description)}</p>
          ${state.path === "staff" && dish.variants.length ? `<label><span class="tag">Chef's variations</span><select id="recipe-${dish.id}" aria-label="${escape(dish.name)} variation">${dish.variants.map((v) => `<option value="${v.recipe}">${escape(v.label)}</option>`).join("")}</select></label>` : ""}
          <button data-dish="${dish.id}">${state.path === "staff" ? "Lead this demo" : "Try this dish"} <span aria-hidden="true">↗</span></button>
        </article>`).join("");
    element("menu").querySelectorAll("[data-dish]").forEach((button) => {
        button.addEventListener("click", () => startDish(button.dataset.dish));
    });
}
function safeLink(url, text) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["github.com", "docs.github.com", "github.github.com"].includes(parsed.hostname) && !parsed.hostname.endsWith(".github.io")) throw new Error("Unexpected resource link.");
    return `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(text)}</a>`;
}
function renderOrder() {
    const order = state.order;
    const dish = state.dishes.find((item) => item.recipe === order.recipe || item.variants.some((v) => v.recipe === order.recipe));
    if (!dish) throw new Error("Order does not match the catalog.");
    state.path = order.path;
    renderMenu();
    const steps = state.path === "staff" ? [...dish.attendee, ...dish.staff] : dish.attendee;
    const links = order.resources.map((resource) => {
        if (resource.kind === "local") return `<p>Your fresh starter: <code>${escape(resource.path)}</code>. Open this folder in VS Code.</p>`;
        return safeLink(resource.url, resource.repo) +
            (resource.pagesUrl ? safeLink(resource.pagesUrl, "Open the deployed game") : "") +
            (resource.pulls || []).map((pr) => safeLink(pr.url, `Inspect PR #${pr.number}`)).join("");
    }).join("");
    element("order").innerHTML = `<p class="eyebrow">YOUR ORDER</p><h2>${escape(dish.name)}</h2>
        <div class="resources">${links}</div><ol>${steps.map((text) => `<li>${escape(text)}</li>`).join("")}</ol>
        ${safeLink(dish.learn, "Keep exploring")}<br><button id="finish">Finish this order</button>
        <p>Your work stays with this order. The next guest gets a fresh environment.</p>`;
    element("finish").addEventListener("click", async () => {
        element("finish").disabled = true;
        try {
            await api("/api/finish", { id: order.id, client });
            state.order = null;
            notify("");
            renderMenu();
        } catch (error) { notify(error.message); element("finish").disabled = false; }
    });
}
async function startDish(id) {
    if (state.starting || state.order) return;
    state.starting = true;
    stopCamera();
    notify("");
    element("menu").querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
        state.order = await api("/api/start", { dish: id, path: state.path, recipe: element(`recipe-${id}`)?.value, client });
        renderOrder();
        element("order").scrollIntoView({ behavior: "smooth" });
    } catch (error) { notify(error.message); }
    finally {
        state.starting = false;
        element("menu").querySelectorAll("button").forEach((button) => { button.disabled = false; });
    }
}
// Existing Chez Mona tickets contain only the dish ID; use the bundled jsQR decoder.
function decodeTicket(raw) {
    const id = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
    return state.dishes.some((dish) => dish.id === id) ? id : null;
}
async function startCamera() {
    if (!state.qrEnabled || state.order || state.path !== "attendee") return;
    stopCamera();
    const generation = state.generation;
    let stream;
    try {
        stream = await navigator.mediaDevices.getUserMedia({ video: { facingMode: "environment" }, audio: false });
        if (generation !== state.generation || !state.qrEnabled) { stream.getTracks().forEach((track) => track.stop()); return; }
        state.stream = stream;
        const video = element("video");
        video.srcObject = stream;
        video.hidden = false;
        await video.play();
        const canvas = document.createElement("canvas");
        const context = canvas.getContext("2d", { willReadFrequently: true });
        const tick = () => {
            if (generation !== state.generation) return;
            if (video.readyState >= 2 && video.videoWidth) {
                const scale = Math.min(1, 960 / video.videoWidth);
                canvas.width = Math.round(video.videoWidth * scale);
                canvas.height = Math.round(video.videoHeight * scale);
                context.drawImage(video, 0, 0, canvas.width, canvas.height);
                const result = jsQR(context.getImageData(0, 0, canvas.width, canvas.height).data, canvas.width, canvas.height, { inversionAttempts: "attemptBoth" });
                if (result?.data) {
                    const id = decodeTicket(result.data);
                    if (id) { startDish(id); return; }
                    element("camera-notice").textContent = "That isn't a diner ticket. Try another ticket or select a dish below.";
                }
            }
            setTimeout(() => requestAnimationFrame(tick), 120);
        };
        tick();
    } catch (error) {
        if (generation !== state.generation) return;
        stopCamera();
        element("camera-notice").textContent = `Camera unavailable: ${error.message}. Select a dish below instead.`;
    }
}
for (const path of ["attendee", "staff"]) element(path).addEventListener("click", () => {
    if (state.order) { notify("Finish your current order before changing experiences."); return; }
    state.path = path;
    notify("");
    renderMenu();
});
element("camera").addEventListener("click", startCamera);
document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
window.addEventListener("pagehide", stopCamera);
async function refresh() {
    const data = await api("/api/menu");
    const changed = !state.dishes.length || state.order?.id !== data.order?.id;
    client = data.client;
    state.dishes = data.dishes;
    state.order = data.order;
    element("event").textContent = data.event;
    setQr(data.qrEnabled);
    if (changed) {
        if (state.order) renderOrder();
        else renderMenu();
    }
}
refresh().catch((error) => notify(error.message));
setInterval(() => {
    if (!document.hidden && !state.starting) refresh().catch((error) => notify(error.message));
}, 5000);
