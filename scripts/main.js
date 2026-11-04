// Theia Feats — faster level-up choices for the Theia worlds (Foundry 14, dnd5e 6).
const MODULE_ID = "theia-feats";

/* -------------------------------------------- */
/*  Batched compendium loads                    */
/* -------------------------------------------- */

/**
 * The level-up window asks for every option of a choice at once (Promise.all of fromUuid), but each request is a
 * separate round trip that the server answers one after another: about 130 ms each in the 2186-item Class Features
 * pack, so 40 feats took 5 s. Requests for documents of the same pack made within a few milliseconds of each other
 * are joined into one getDocuments({ _id__in }) query (40 feats: about 0.2 s). Cached documents are returned as before.
 */
const BATCH_WINDOW = 15; // ms
const pending = new Map(); // pack collection id -> { pack, waiting: Map<id, callbacks[]>, timer }

function queueDocument(pack, id) {
  return new Promise((resolve, reject) => {
    let batch = pending.get(pack.collection);
    if (!batch) {
      batch = { pack, waiting: new Map(), timer: setTimeout(() => flushBatch(pack.collection), BATCH_WINDOW) };
      pending.set(pack.collection, batch);
    }
    if (!batch.waiting.has(id)) batch.waiting.set(id, []);
    batch.waiting.get(id).push({ resolve, reject });
  });
}

async function flushBatch(collection) {
  const { pack, waiting } = pending.get(collection);
  pending.delete(collection);
  const ids = [...waiting.keys()];
  try {
    const documents = await pack.getDocuments(ids.length === 1 ? { _id: ids[0] } : { _id__in: ids });
    const byId = new Map(documents.map(d => [d.id, d]));
    for (const [id, callbacks] of waiting) for (const { resolve } of callbacks) resolve(byId.get(id) ?? null);
  } catch (err) {
    for (const callbacks of waiting.values()) for (const { reject } of callbacks) reject(err);
  }
}

/* -------------------------------------------- */
/*  Prerequisites                               */
/* -------------------------------------------- */

/**
 * Theia prerequisites (from Theia Prerequisites): flags.theia.prereqs is an array of { path, op, value, label }, a
 * dotted path on the actor compared with value, such as { path: "system.abilities.cha.value", op: ">=", value: 13 }.
 * They're checked with dnd5e's own feat prerequisites (level, required items, not repeatable).
 */
const OPERATORS = {
  ">=": (a, b) => a >= b, ">": (a, b) => a > b, "<=": (a, b) => a <= b, "<": (a, b) => a < b,
  "==": (a, b) => a == b, "===": (a, b) => a === b, "!=": (a, b) => a != b, "!==": (a, b) => a !== b
};
const ruleLabel = rule => rule?.label ?? `${rule?.path ?? "?"} ${rule?.op ?? "?"} ${rule?.value ?? "?"}`;

/** The failed Theia prerequisites of an item (data or index entry) for an actor, as labels. */
function failedTheiaPrereqs(actor, itemData) {
  const rules = foundry.utils.getProperty(itemData, "flags.theia.prereqs");
  if (!Array.isArray(rules) || !rules.length) return [];
  return rules.filter(rule => {
    const test = OPERATORS[rule?.op];
    if (!rule?.path || !test) return true;
    const actual = foundry.utils.getProperty(actor, rule.path);
    if (actual === undefined || actual === null) return true;
    return !test(typeof rule.value === "number" ? Number(actual) : actual, rule.value);
  }).map(ruleLabel);
}

/** Every unmet prerequisite of a feat index entry for an actor at a level, as labels (empty when it can be taken). */
function unmetPrerequisites(actor, entry, level) {
  const unmet = [];
  const prereqs = entry.system?.prerequisites ?? {};
  if (Number.isFinite(prereqs.level) && (level < prereqs.level)) unmet.push(`Level ${prereqs.level}`);
  const items = [...(prereqs.items ?? [])];
  if (items.length && !items.some(i => actor.identifiedItems?.get(i)?.size)) {
    unmet.push(items.map(i => dnd5e.registry.items.get(i)?.name ?? i).join(" or "));
  }
  if (!prereqs.repeatable && actor.sourcedItems?.get(entry.uuid)?.size) unmet.push("Already taken");
  unmet.push(...failedTheiaPrereqs(actor, entry));
  return unmet;
}

// Block an item from being created on an actor that doesn't meet its Theia prerequisites (level-up grants included).
Hooks.on("preCreateItem", (item, data) => {
  const actor = item.parent;
  if (!(actor instanceof Actor) || game.modules.get("theia-prereqs")?.active) return;
  const failed = failedTheiaPrereqs(actor, data?.flags ? data : item);
  if (!failed.length) return;
  ui.notifications.warn(`${actor.name} does not meet the prerequisites for ${data?.name ?? item.name}: ${failed.join(", ")}`);
  return false;
});

/* -------------------------------------------- */
/*  Feat picker                                 */
/* -------------------------------------------- */

/**
 * dnd5e's Ability Score Improvement step opens the compendium browser over every Item pack to choose a feat. This
 * picker lists only the feats of the configured pack (Class Features (Shared) by default) from its index, with search,
 * category, and the actor's prerequisites; a feat's description loads when it is selected.
 */
const DEFAULT_PACK = "forge-vtt-shared-compendiums-theia.item-3-class-features";
const INDEX_FIELDS = ["system.type", "system.prerequisites", "system.requirements", "system.source", "flags.theia.prereqs"];

class FeatPicker extends foundry.applications.api.ApplicationV2 {
  constructor({ actor, level, resolve, ...options } = {}) {
    super(options);
    this.actor = actor;
    this.level = level ?? actor?.system.details?.level ?? 0;
    this.resolve = resolve;
    this.view = { search: "", category: "", eligibleOnly: true, selected: null };
  }

  static DEFAULT_OPTIONS = {
    id: "theia-feat-picker",
    classes: ["theia-feat-picker"],
    window: { title: "Choose a Feat", icon: "fa-solid fa-star", resizable: true },
    position: { width: 760, height: 620 }
  };

  /** Feat index entries of the pack, loaded once per session. */
  static async entries() {
    if (this._entries) return this._entries;
    const pack = game.packs.get(game.settings.get(MODULE_ID, "pack")) ?? game.packs.get(DEFAULT_PACK);
    if (!pack) return (this._entries = []);
    const index = await pack.getIndex({ fields: INDEX_FIELDS });
    // The pack's "Ability Score Improvement (Nth level)" class items are feats too, but not ones to choose.
    this._entries = [...index.values()]
      .filter(e => (e.type === "feat") && (e.system?.type?.value === "feat") && !/^Ability Score Improvement/i.test(e.name))
      .sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang));
    return this._entries;
  }

  get categories() {
    return CONFIG.DND5E.featureTypes.feat?.subtypes ?? {};
  }

  async _renderHTML() {
    const entries = await FeatPicker.entries();
    const { search, category, eligibleOnly, selected } = this.view;
    const term = search.trim().toLowerCase();
    const rows = entries.map(e => ({ entry: e, unmet: this.actor ? unmetPrerequisites(this.actor, e, this.level) : [] }))
      .filter(({ entry, unmet }) => (!term || entry.name.toLowerCase().includes(term))
        && (!category || entry.system?.type?.subtype === category)
        && (!eligibleOnly || !unmet.length));
    const esc = foundry.utils.escapeHTML;
    const options = Object.entries(this.categories).map(([k, label]) =>
      `<option value="${k}" ${k === category ? "selected" : ""}>${esc(game.i18n.localize(label))}</option>`).join("");
    const list = rows.map(({ entry, unmet }) => `
      <li class="theia-feat ${unmet.length ? "unmet" : ""} ${entry.uuid === selected?.uuid ? "active" : ""}" data-uuid="${entry.uuid}">
        <img src="${entry.img}" alt=""><span class="name">${esc(entry.name)}</span>
        <span class="tag">${esc(game.i18n.localize(this.categories[entry.system?.type?.subtype] ?? ""))}</span>
        ${unmet.length ? `<span class="unmet-reason">${esc(unmet.join(" · "))}</span>` : ""}
      </li>`).join("") || `<li class="empty">No feats match.</li>`;
    const detail = selected
      ? `<h3>${esc(selected.name)}</h3>${selected.requirements ? `<p class="req">${esc(selected.requirements)}</p>` : ""}
         <div class="desc">${selected.description}</div>
         <button type="button" class="choose" data-action="choose" ${selected.unmet?.length ? "disabled" : ""}>
           <i class="fa-solid fa-check"></i> Take ${esc(selected.name)}</button>`
      : `<p class="hint">Select a feat to read it.</p>`;
    const root = document.createElement("div");
    root.className = "theia-feat-body";
    root.innerHTML = `
      <div class="filters">
        <input type="search" name="search" placeholder="Search feats" value="${esc(search)}">
        <select name="category"><option value="">All categories</option>${options}</select>
        <label><input type="checkbox" name="eligibleOnly" ${eligibleOnly ? "checked" : ""}> Only feats ${esc(this.actor?.name ?? "")} can take</label>
      </div>
      <div class="columns"><ul class="list">${list}</ul><section class="detail">${detail}</section></div>`;
    return root;
  }

  _replaceHTML(result, content) {
    const focused = document.activeElement?.name;
    content.replaceChildren(result);
    if (focused === "search") {
      const input = content.querySelector("input[name=search]");
      input.focus();
      input.setSelectionRange(input.value.length, input.value.length);
    }
  }

  _onRender() {
    const el = this.element;
    el.querySelector("input[name=search]").addEventListener("input", ev => { this.view.search = ev.target.value; this.render(); });
    el.querySelector("select[name=category]").addEventListener("change", ev => { this.view.category = ev.target.value; this.render(); });
    el.querySelector("input[name=eligibleOnly]").addEventListener("change", ev => { this.view.eligibleOnly = ev.target.checked; this.render(); });
    for (const li of el.querySelectorAll("li.theia-feat")) li.addEventListener("click", () => this.select(li.dataset.uuid));
    el.querySelector("button[data-action=choose]")?.addEventListener("click", () => this.choose());
  }

  async select(uuid) {
    const entry = (await FeatPicker.entries()).find(e => e.uuid === uuid);
    const item = await fromUuid(uuid);
    if (!entry || !item) return;
    const description = await foundry.applications.ux.TextEditor.implementation.enrichHTML(item.system.description?.value ?? "", { relativeTo: item });
    this.view.selected = { uuid, name: item.name, requirements: item.system.requirements, description,
      unmet: this.actor ? unmetPrerequisites(this.actor, entry, this.level) : [] };
    this.render();
  }

  choose() {
    const uuid = this.view.selected?.uuid;
    if (!uuid) return;
    this.resolve?.(uuid);
    this.resolve = null;
    this.close();
  }

  async close(options) {
    this.resolve?.(null);
    this.resolve = null;
    return super.close(options);
  }

  /** Open the picker and resolve with the chosen feat's UUID (null when closed). */
  static choose(options) {
    return new Promise(resolve => new FeatPicker({ ...options, resolve }).render({ force: true }));
  }
}

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "pack", {
    name: "Feat compendium",
    hint: "The Item compendium whose feats the feat picker lists.",
    scope: "world", config: true, type: String, default: DEFAULT_PACK
  });
  game.modules.get(MODULE_ID).api = { FeatPicker, unmetPrerequisites };
});

Hooks.once("setup", () => {
  if (!globalThis.libWrapper) return console.warn(`${MODULE_ID} | libWrapper is needed`);
  libWrapper.register(MODULE_ID, "foundry.documents.collections.CompendiumCollection.prototype.getDocument", function (wrapped, id) {
    if (!id || (this.get(id) instanceof foundry.abstract.Document)) return wrapped(id);
    return queueDocument(this, id);
  }, "MIXED");
  // The ASI step asks the compendium browser for one feat (types feat, category feat): open the feat picker instead.
  libWrapper.register(MODULE_ID, "dnd5e.applications.CompendiumBrowser.selectOne", function (wrapped, options = {}, ...rest) {
    const locked = options.filters?.locked;
    const wantsFeat = locked?.types?.has?.("feat") && (locked.additional?.category?.feat === 1);
    if (!wantsFeat) return wrapped(options, ...rest);
    const manager = Object.values(ui.windows).concat([...foundry.applications.instances.values()])
      .find(a => a instanceof dnd5e.applications.advancement.AdvancementManager);
    const actor = manager?.clone ?? manager?.actor ?? null;
    return FeatPicker.choose({ actor, level: actor?.system.details?.level });
  }, "MIXED");
});
