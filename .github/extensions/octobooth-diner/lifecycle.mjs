export class Kitchen {
    constructor(store, adapter, recipes, guard = () => {}) {
        this.store = store;
        this.adapter = adapter;
        this.recipes = recipes;
        this.busy = false;
        this.guard = guard;
    }
    report(message) {
        this.store.fault(message);
        console.error(`[Octobooth diner] ${message}`);
    }
    recover() {
        for (const row of this.store.list()) {
            if (["creating", "checking", "deleting"].includes(row.state)) {
                this.store.update(row.id, { state: "quarantined", error: "Interrupted operation; inspect owned resources before explicit retirement. No automatic replay." });
                this.report(`Interrupted ${row.id}; resources quarantined, not reissued.`);
            }
        }
    }
    replenish() {
        this.guard();
        const settings = this.store.get("event");
        if (!settings?.enabled || Date.now() > Date.parse(settings.eventEnd)) return;
        this.store.transaction(() => {
            const rows = this.store.list();
            let cost = rows.filter((r) => r.state !== "deleted")
                .reduce((sum, r) => sum + (this.recipes[r.recipe].templates?.length || 1), 0);
            for (const [recipe, target] of Object.entries(settings.reserve)) {
                const available = rows.filter((r) => r.event === settings.event && r.recipe === recipe &&
                    !r.assigned && ["queued", "creating", "validating", "ready", "checking", "quarantined"].includes(r.state)).length;
                for (let count = available; count < target; count++) {
                    const units = this.recipes[recipe].templates?.length || 1;
                    if (cost + units > settings.maxResources) {
                        const message = "Station resource budget reached. Review retained environments or explicitly raise the budget; no additional resources were created.";
                        if (this.store.get("capacityWarning") !== message) {
                            this.report(message);
                            this.store.set("capacityWarning", message);
                        }
                        return;
                    }
                    this.store.add(settings.event, recipe, Date.parse(settings.eventEnd) + 7 * 86400_000);
                    cost += units;
                }
            }
            this.store.set("capacityWarning", null);
        });
    }
    async tick() {
        const event = this.store.get("event");
        if (this.busy || !event?.enabled || Date.now() > Date.parse(event.eventEnd)) return;
        this.busy = true;
        try {
            this.replenish();
            const settings = this.store.get("event");
            const row = this.store.list().filter((r) => r.event === settings.event && ["queued", "validating"].includes(r.state))
                .sort((a, b) => (a.checked || 0) - (b.checked || 0))[0];
            if (!row) return;
            try {
                if (row.state === "queued") {
                    this.store.update(row.id, { state: "creating" });
                    await this.adapter.create(row, settings, (resources) => {
                        this.guard();
                        this.store.update(row.id, { resources });
                    });
                    this.guard();
                    this.store.update(row.id, { state: "validating" });
                }
                const current = this.store.find(row.id);
                this.store.update(row.id, { state: "checking" });
                const result = await this.adapter.ready(current, settings);
                this.guard();
                if (result.ready) {
                    this.store.update(row.id, { state: "ready", resources: result.resources, checked: Date.now(), error: null });
                } else if (Date.now() - row.created > settings.readinessMinutes * 60_000) {
                    throw new Error(`Readiness deadline exceeded: ${result.reason}`);
                } else {
                    this.store.update(row.id, { state: "validating", error: result.reason, checked: Date.now() });
                }
            } catch (error) {
                this.guard();
                this.store.update(row.id, { state: "quarantined", error: error.message });
                this.report(`${row.id}: ${error.message}`);
            }
        } finally {
            this.busy = false;
        }
    }
    async assign({ dish, recipe, path, client }, catalog) {
        this.guard();
        const item = catalog.find((d) => d.id === dish);
        if (!item || !["attendee", "staff"].includes(path) || !/^[a-zA-Z0-9-]{1,80}$/.test(client || "")) {
            throw new Error("Choose a valid dish, path, and station session.");
        }
        const selected = recipe || item.recipe;
        if (selected !== item.recipe && (path !== "staff" || !item.variants.some((v) => v.recipe === selected))) {
            throw new Error("That recipe is not part of this dish and path.");
        }
        const settings = this.store.get("event");
        if (!settings?.enabled || Date.now() > Date.parse(settings.eventEnd)) throw new Error("Ask the booth host to open this station before starting a lab.");
        const row = this.store.transaction(() => {
            const rows = this.store.list();
            if (rows.some((r) => r.client === client && ["assigned", "checking"].includes(r.state))) {
                throw new Error("Finish the current order before starting another.");
            }
            const found = rows.find((r) => r.event === settings.event && r.recipe === selected && r.state === "ready" && !r.assigned);
            if (!found) throw new Error("This dish cannot be served yet. Ask the booth host for help or choose another dish.");
            this.store.update(found.id, { state: "checking", client });
            return found;
        });
        try {
            const result = await this.adapter.ready(row, settings);
            this.guard();
            if (!result.ready) throw new Error(`Environment is not usable: ${result.reason}`);
            if (JSON.stringify(result.resources) !== JSON.stringify(row.resources)) {
                throw new Error("The reserved environment changed after preparation; it has been withheld.");
            }
            this.store.update(row.id, { state: "assigned", assigned: new Date().toISOString(), path, checked: Date.now() });
            this.replenish();
            return this.store.find(row.id);
        } catch (error) {
            this.guard();
            this.store.update(row.id, { state: "quarantined", error: error.message, client: null });
            this.report(`${row.id}: ${error.message}`);
            throw new Error("The kitchen needs the booth host's attention. This environment was not handed out.");
        }
    }
    retire(id, client = null) {
        this.guard();
        const row = this.store.find(id);
        if (!row || (client && row.client !== client)) throw new Error("Order not found for this session.");
        if (row.state === "retired") return row;
        if (!["assigned", "ready", "quarantined", "queued", "validating"].includes(row.state)) throw new Error("This operation is still running; do not retire it yet.");
        this.store.update(id, { state: "retired" });
        this.replenish();
        return this.store.find(id);
    }
    async teardown(id, reviewed) {
        this.guard();
        const row = this.store.find(id);
        if (!row || row.state !== "retired" || reviewed !== true) throw new Error("Teardown requires an exact retired order and explicit review.");
        if (Date.now() < row.retainUntil) throw new Error("Retention lasts until seven days after the event. Retirement never implies immediate deletion.");
        this.store.update(id, { state: "deleting" });
        try {
            await this.adapter.remove(row, this.store.get("event"));
            this.guard();
            this.store.update(id, { state: "deleted" });
        } catch (error) {
            this.guard();
            this.store.update(id, { state: "quarantined", error: error.message });
            this.report(`Teardown ${id}: ${error.message}`);
            throw error;
        }
    }
}
