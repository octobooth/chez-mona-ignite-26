"use strict";
const element = (id) => document.getElementById(id);
const access = new URLSearchParams(location.hash.slice(1)).get("access") || sessionStorage.getItem("diner-access");
if (access) sessionStorage.setItem("diner-access", access);
if (location.hash) history.replaceState(null, "", "/");
let client;
const state = { dishes: [], path: "attendee", selection: null, order: null, environmentEnabled: false, sdkSource: "", qrEnabled: false, stream: null, generation: 0, starting: false };
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
    element("scan").hidden = !enabled || Boolean(state.selection) || state.path === "staff";
    if (!enabled || element("scan").hidden) stopCamera();
}
function renderMenu() {
    element("attendee").setAttribute("aria-pressed", String(state.path === "attendee"));
    element("staff").setAttribute("aria-pressed", String(state.path === "staff"));
    element("menu-section").hidden = Boolean(state.selection);
    element("order").hidden = !state.selection;
    element("active-order").hidden = !state.order || Boolean(state.selection);
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
        button.addEventListener("click", () => openDish(button.dataset.dish));
    });
}
function safeLink(url, text) {
    const parsed = new URL(url);
    if (parsed.protocol !== "https:" || !["github.com", "docs.github.com", "github.github.com"].includes(parsed.hostname) && !parsed.hostname.endsWith(".github.io")) throw new Error("Unexpected resource link.");
    return `<a href="${escape(url)}" target="_blank" rel="noopener noreferrer">${escape(text)}</a>`;
}
function renderGuide() {
    const dish = state.dishes.find((item) => item.id === state.selection?.dish);
    if (!dish) throw new Error("Choose a dish from the menu.");
    const order = state.order?.recipe === state.selection.recipe ? state.order : null;
    renderMenu();
    const steps = state.path === "staff" ? [...dish.attendee, ...dish.staff] : dish.attendee;
    const links = (order?.resources || []).map((resource) => {
        if (resource.kind === "local") return `<p>Your own starter folder: <code>${escape(resource.path)}</code></p>`;
        return safeLink(resource.url, resource.repo) +
            (resource.pagesUrl ? safeLink(resource.pagesUrl, "Open the deployed game") : "") +
            (resource.pulls || []).map((pr) => safeLink(pr.url, `Inspect PR #${pr.number}`)).join("");
    }).join("");
    const practice = dish.practice;
    const variant = dish.variants.find((item) => item.recipe === state.selection.recipe);
    element("order").innerHTML = `<button id="back-menu">Back to the menu</button>
        <p class="eyebrow">${order ? "YOUR ORDER" : "LAB GUIDE"}</p><h2>${escape(dish.name)}</h2>
        ${state.path === "staff" && variant ? `<p>Chef's variation: <strong>${escape(variant.label)}</strong></p>` : ""}
        ${order ? `<div class="resources">${links}</div>` : `<p>Explore the instructions below. No environment is attached to this guide.</p>`}
        ${practice ? `<section class="practice"><h3>Try it in Copilot</h3><p>${escape(practice.intro)}</p>
            ${practice.prompts.map((prompt, index) => `<label for="prompt-${index}">${escape(prompt.label)}</label>
                <textarea id="prompt-${index}" rows="6" readonly>${escape(prompt.text + (practice.includeSource ? `\n\nBundled main.py:\n\`\`\`python\n${state.sdkSource}\n\`\`\`` : ""))}</textarea>
                <button data-copy="${index}">Copy prompt</button>`).join("")}
            <p id="copy-status" role="status">Copy a prompt, paste it into Copilot, then send it. Copying does not run anything.</p></section>` : ""}
        <h3>${dish.recipe === "sdk" ? "Starter walkthrough" : "With a prepared environment"}</h3>
        <ol>${steps.map((text) => `<li>${escape(text)}</li>`).join("")}</ol>
        ${dish.recipe === "sdk" ? `<details><summary>Read the bundled starter (read-only)</summary><pre><code>${escape(state.sdkSource)}</code></pre></details>` : ""}
        <p>${safeLink(dish.learn, "Keep exploring")}</p>
        <div class="guide-actions">
          ${order ? '<button id="finish">Finish this order</button>' :
            state.order ? '<p>Finish your open order before starting another environment.</p>' :
            `<button id="use-environment" ${state.environmentEnabled ? "" : "disabled"}>Use a prepared environment</button>`}
        </div>
        ${!order && !state.order && !state.environmentEnabled ? "<p>Prepared environments need booth-host configuration. Reading the guide does not create any resources.</p>" : ""}
        ${order ? "<p>Your work stays with this order. Finishing never hands it to another guest or deletes it automatically.</p>" : ""}`;
    element("back-menu").addEventListener("click", () => {
        if (state.starting) return;
        state.selection = null;
        notify("");
        renderMenu();
    });
    element("use-environment")?.addEventListener("click", beginEnvironment);
    element("order").querySelectorAll("[data-copy]").forEach((button) => {
        button.addEventListener("click", () => copyPrompt(button.dataset.copy));
    });
    element("finish")?.addEventListener("click", async () => {
        const button = element("finish");
        button.disabled = true;
        try {
            await api("/api/finish", { id: order.id, client });
            state.order = null;
            state.selection = null;
            notify("");
            renderMenu();
        } catch (error) { notify(error.message); button.disabled = false; }
    });
}
async function copyPrompt(index) {
    const prompt = element(`prompt-${index}`);
    const status = element("copy-status");
    try {
        if (!navigator.clipboard?.writeText) throw new Error("Clipboard access is unavailable.");
        await navigator.clipboard.writeText(prompt.value);
        status.textContent = "Copied. Paste into the Copilot conversation beside the diner and send when ready.";
    } catch (error) {
        prompt.focus();
        prompt.select();
        status.textContent = `${error.message} The prompt is selected so you can copy it manually.`;
    }
}
function openDish(id, recipe) {
    if (state.starting) return;
    const dish = state.dishes.find((item) => item.id === id);
    if (!dish) throw new Error("Choose a dish from the menu.");
    state.selection = { dish: id, recipe: recipe || element(`recipe-${id}`)?.value || dish.recipe };
    stopCamera();
    notify("");
    renderGuide();
    element("order").scrollIntoView({ behavior: "smooth" });
}
function returnToOrder() {
    if (!state.order) return;
    const dish = state.dishes.find((item) => item.recipe === state.order.recipe || item.variants.some((variant) => variant.recipe === state.order.recipe));
    if (!dish) throw new Error("Order does not match the catalog.");
    state.path = state.order.path;
    openDish(dish.id, state.order.recipe);
}
async function beginEnvironment() {
    if (state.starting || state.order || !state.selection) return;
    state.starting = true;
    notify("");
    element("order").querySelectorAll("button").forEach((button) => { button.disabled = true; });
    try {
        state.order = await api("/api/start", { dish: state.selection.dish, path: state.path, recipe: state.selection.recipe, client });
    } catch (error) { notify(error.message); }
    finally {
        state.starting = false;
        renderGuide();
    }
}
// Existing Chez Mona tickets contain only the dish ID; use the bundled jsQR decoder.
function decodeTicket(raw) {
    const id = raw.trim().toLowerCase().replace(/[\s_]+/g, "-");
    return state.dishes.some((dish) => dish.id === id) ? id : null;
}
async function startCamera() {
    if (!state.qrEnabled || state.selection || state.path !== "attendee") return;
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
                    if (id) { openDish(id); return; }
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
    if (state.starting) return;
    if (state.order) { notify("Finish your current order before changing experiences."); return; }
    state.path = path;
    notify("");
    if (state.selection) {
        state.selection.recipe = state.dishes.find((dish) => dish.id === state.selection.dish).recipe;
        renderGuide();
    } else renderMenu();
});
element("return-to-order").addEventListener("click", returnToOrder);
element("camera").addEventListener("click", startCamera);
document.addEventListener("visibilitychange", () => { if (document.hidden) stopCamera(); });
window.addEventListener("pagehide", stopCamera);
async function refresh() {
    const data = await api("/api/menu");
    const first = !state.dishes.length;
    const orderChanged = state.order?.id !== data.order?.id;
    const availabilityChanged = state.environmentEnabled !== data.environmentEnabled;
    client = data.client;
    state.dishes = data.dishes;
    state.order = data.order;
    state.environmentEnabled = Boolean(data.environmentEnabled);
    state.sdkSource = data.sdkSource || "";
    element("event").textContent = data.event;
    setQr(data.qrEnabled);
    if (orderChanged && state.order) returnToOrder();
    else if (state.selection && (orderChanged || availabilityChanged)) renderGuide();
    else if (first || orderChanged) renderMenu();
}
refresh().catch((error) => notify(error.message));
setInterval(() => {
    if (!document.hidden && !state.starting) refresh().catch((error) => notify(error.message));
}, 5000);
