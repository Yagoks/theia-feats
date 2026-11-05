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

/*
 * The Theia feats keep most prerequisites as text in "system.requirements", such as "6th-level, Charisma 15+" or
 * "4th-Level + Cel'eros or Kitsune". Each part after the level is read as one kind (ability score, spellcasting,
 * proficiency, fighting style, class, feat, lineage) and checked against the actor.
 */
const ABILITY_WORDS = { strength: "str", strenght: "str", dexterity: "dex", constitution: "con", intelligence: "int", wisdom: "wis", charisma: "cha" };
const norm = s => String(s ?? "").toLowerCase().normalize("NFD").replace(/[^a-z]/g, "");
const alternatives = s => s.split(/,\s*(?:or\s+)?|\s+or\s+/i).map(t => t.trim()).filter(Boolean);
const PREREQ_KINDS = { level: "Level", ability: "Ability score", lineage: "Lineage", feat: "Feat or feature", proficiency: "Proficiency", spellcasting: "Spellcasting", class: "Class" };

/** The parts of a requirements text after its level, each as { kind, label, test(actor) } (cached per text). */
const partsCache = new Map();
function requirementParts(text) {
  if (partsCache.has(text)) return partsCache.get(text);
  const rest = String(text ?? "").replace(/\d+(st|nd|rd|th)-level/ig, "");
  const parts = [];
  for (let raw of rest.split("+")) {
    raw = raw.trim().replace(/^[,\s]+|[,\s]+$/g, "");
    if (!raw || /^none$/i.test(raw)) continue;
    for (const piece of /^feat,\s*/i.test(raw) ? [raw.replace(/^feat,\s*/i, "")] : [raw]) parts.push(readPart(piece));
  }
  return parts;
}

function readPart(label) {
  const words = alternatives(label.replace(/\d+$/, ""));
  const score = Number(label.match(/(\d+)\s*$/)?.[1]);
  if (score && words.every(w => ABILITY_WORDS[w.toLowerCase()])) {
    const keys = words.map(w => ABILITY_WORDS[w.toLowerCase()]);
    return { kind: "ability", label: `${label}+`, test: a => keys.some(k => (a.system.abilities?.[k]?.value ?? 0) >= score) };
  }
  if (/spellcasting|pact magic/i.test(label)) {
    return { kind: "spellcasting", label, test: a => Object.keys(a.spellcastingClasses ?? {}).length > 0 || (a.system.spells?.pact?.max ?? 0) > 0 };
  }
  if (/fighting style/i.test(label)) {
    return { kind: "feat", label, test: a => a.items.some(i => i.type === "feat" && i.system.type?.subtype === "fightingStyle") };
  }
  if (/martial/i.test(label)) return { kind: "proficiency", label, test: a => a.system.traits?.weaponProf?.value?.has("mar") };
  if (/shield/i.test(label)) return { kind: "proficiency", label, test: a => a.system.traits?.armorProf?.value?.has("shl") };
  const armor = label.match(/(light|medium|heavy) armor/i)?.[1]?.toLowerCase();
  if (armor) return { kind: "proficiency", label, test: a => a.system.traits?.armorProf?.value?.has({ light: "lgt", medium: "med", heavy: "hvy" }[armor]) };
  const skill = label.match(/proficiency with (.+)/i)?.[1];
  const skillKey = skill && Object.entries(CONFIG.DND5E.skills).find(([, s]) => norm(s.label) === norm(skill))?.[0];
  if (skillKey) return { kind: "proficiency", label, test: a => (a.system.skills?.[skillKey]?.value ?? 0) >= 1 };
  const inParens = label.match(/^\((.+)\)$/)?.[1];
  if (inParens) {
    const classes = alternatives(inParens).map(norm);
    return { kind: "class", label: inParens, test: a => Object.values(a.classes ?? {}).some(c => classes.includes(norm(c.name))) };
  }
  const featNames = new Set((FeatPicker._entries ?? []).map(e => norm(e.name)));
  const options = alternatives(label);
  if (options.some(o => featNames.has(norm(o)) || /^strike of the giants/i.test(o))) {
    return { kind: "feat", label, test: a => options.some(o => a.items.some(i => norm(i.name) === norm(o))) };
  }
  // Anything else is a list of lineages: "Bugbear, Goblin or Hobgoblin", "Drac'nyr (Chromatic)".
  const lineages = options.map(o => norm(o.replace(/\(.*?\)?$/, "")));
  return { kind: "lineage", label, test: a => {
    const race = norm(a.items.find(i => i.type === "race")?.name ?? a.system.details?.race?.name ?? a.system.details?.race);
    return !!race && lineages.some(l => l && (race.includes(l) || l.includes(race)));
  } };
}

/** The prerequisite kinds of a feat index entry (for the picker's filter). */
/** The text parts that a feat's required items stand for (checked through the items instead). */
function coveredParts(entry, parts) {
  if (!entry.system?.prerequisites?.items?.length) return [];
  return parts.filter(p => ["lineage", "feat", "spellcasting", "class"].includes(p.kind) && !/fighting style/i.test(p.label));
}

function prerequisiteKinds(entry) {
  const parts = requirementParts(entry.system?.requirements);
  const kinds = new Set(parts.map(p => p.kind));
  if (entry.system?.prerequisites?.items?.length && !coveredParts(entry, parts).length) kinds.add("feat");
  if ((entry.system?.prerequisites?.level ?? 0) > 1) kinds.add("level");
  return kinds;
}

/** The level a feat needs (1 when none). */
const featLevel = entry => Math.max(1, Number(entry.system?.prerequisites?.level) || 1);

/** Every unmet prerequisite of a feat index entry for an actor at a level, as labels (empty when it can be taken). */
function unmetPrerequisites(actor, entry, level) {
  const unmet = [];
  const prereqs = entry.system?.prerequisites ?? {};
  if (Number.isFinite(prereqs.level) && (level < prereqs.level)) unmet.push(`Level ${prereqs.level}`);
  const items = [...(prereqs.items ?? [])];
  const parts = requirementParts(entry.system?.requirements);
  const covered = coveredParts(entry, parts);
  // The required items (a lineage, a feat, a feature) are named again in the text, which reads better than their ids.
  // When the item isn't there, the text still counts (e.g. "Spellcasting or Pact Magic Feature" met by Pact Magic).
  const textMet = covered.length && covered.every(p => p.test(actor));
  if (items.length && !items.some(i => actor.identifiedItems?.get(i)?.size) && !textMet) {
    unmet.push(covered.length ? covered.map(p => p.label).join(" · ") : items.map(i => dnd5e.registry.items.get(i)?.name ?? i).join(" or "));
  }
  if (!prereqs.repeatable && actor.sourcedItems?.get(entry.uuid)?.size) unmet.push("Already taken");
  for (const part of parts) if (!covered.includes(part) && !part.test(actor)) unmet.push(part.label);
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
 * picker lists only the feats of the configured pack (Feats (Shared) by default) from its index, with search,
 * category, and the actor's prerequisites; a feat's description loads when it is selected.
 */
const DEFAULT_PACK = "forge-vtt-shared-compendiums-theia.item-6-feats";
const INDEX_FIELDS = ["system.type", "system.prerequisites", "system.requirements", "system.source", "flags.theia.prereqs"];

class FeatPicker extends foundry.applications.api.ApplicationV2 {
  constructor({ actor, level, pool, resolve, ...options } = {}) {
    super(options);
    this.actor = actor;
    this.pool = pool ? new Set(pool) : null;
    this.level = level ?? actor?.system.details?.level ?? 0;
    this.resolve = resolve;
    this.view = { search: "", category: "", level: "", prereq: "", selected: null };
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

  /** The feats to list: an item choice's pool when given, else every feat of the pack. */
  async list() {
    const all = await FeatPicker.entries(); // also the feat names the requirements text is read against
    // Fighting Style feats are chosen only through a Fighting Style feature (which passes them as its pool).
    if (!this.pool) return all.filter(e => !/^Fighting Style:/i.test(e.name));
    if (this._list) return this._list;
    const byPack = new Map();
    for (const uuid of this.pool) {
      const { collection } = foundry.utils.parseUuid(uuid);
      if (collection instanceof foundry.documents.collections.CompendiumCollection) byPack.set(collection, true);
    }
    const entries = [];
    for (const pack of byPack.keys()) {
      const index = await pack.getIndex({ fields: INDEX_FIELDS });
      for (const e of index.values()) if (this.pool.has(e.uuid) && !/^Ability Score Improvement/i.test(e.name)) entries.push(e);
    }
    return (this._list = entries.sort((a, b) => a.name.localeCompare(b.name, game.i18n.lang)));
  }

  /** Labels of the feat categories (feats) or class feature subtypes (maneuvers, invocations...) of the listed entries. */
  categoryLabel(entry) {
    const type = entry.system?.type ?? {};
    const label = CONFIG.DND5E.featureTypes[type.value]?.subtypes?.[type.subtype];
    return label ? game.i18n.localize(label) : "";
  }

  async _renderHTML() {
    const entries = await this.list();
    const { search, category, level, prereq, selected } = this.view;
    const term = search.trim().toLowerCase();
    const rows = entries.map(e => ({ entry: e, unmet: this.actor ? unmetPrerequisites(this.actor, e, this.level) : [] }))
      .filter(({ entry }) => (!term || entry.name.toLowerCase().includes(term))
        && (!category || entry.system?.type?.subtype === category)
        && (!level || featLevel(entry) === Number(level))
        && (!prereq || (prereq === "none" ? !prerequisiteKinds(entry).size : prerequisiteKinds(entry).has(prereq))));
    const esc = foundry.utils.escapeHTML;
    const sel = (value, current) => (String(value) === String(current) ? "selected" : "");
    const categories = [...new Set(entries.map(e => e.system?.type?.subtype).filter(Boolean))]
      .map(k => [k, this.categoryLabel(entries.find(e => e.system?.type?.subtype === k))]).sort((a, b) => a[1].localeCompare(b[1]));
    const levels = [...new Set(entries.map(featLevel))].sort((a, b) => a - b);
    const kinds = Object.entries(PREREQ_KINDS).filter(([k]) => entries.some(e => prerequisiteKinds(e).has(k)));
    const item = ({ entry, unmet }) => `
      <li class="theia-feat ${unmet.length ? "unmet" : ""} ${entry.uuid === selected?.uuid ? "active" : ""}" data-uuid="${entry.uuid}">
        <img src="${entry.img}" alt=""><span class="name">${esc(entry.name)}</span>
        <span class="tag">${featLevel(entry) > 1 ? `Lv ${featLevel(entry)} · ` : ""}${esc(this.categoryLabel(entry))}</span>
        ${unmet.length ? `<span class="unmet-reason">${esc(unmet.join(" · "))}</span>` : ""}
      </li>`;
    const available = rows.filter(r => !r.unmet.length), unavailable = rows.filter(r => r.unmet.length);
    let list = available.map(item).join("") || `<li class="empty">No feats ${esc(this.actor?.name ?? "")} can take match.</li>`;
    if (unavailable.length) {
      list += `<li class="group-header">Not available (${unavailable.length})</li>` + unavailable.map(item).join("");
    }
    if (this.actor && available.length) list = `<li class="group-header">Available (${available.length})</li>` + list;
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
        <select name="category" title="Type"><option value="">All types</option>
          ${categories.map(([k, l]) => `<option value="${k}" ${sel(k, category)}>${esc(l || k)}</option>`).join("")}</select>
        <select name="level" title="Level the feat needs"><option value="">Any level</option>
          ${levels.map(l => `<option value="${l}" ${sel(l, level)}>Level ${l}</option>`).join("")}</select>
        <select name="prereq" title="Prerequisite"><option value="">Any prerequisite</option>
          <option value="none" ${sel("none", prereq)}>No prerequisite</option>
          ${kinds.map(([k, l]) => `<option value="${k}" ${sel(k, prereq)}>${esc(l)}</option>`).join("")}</select>
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
    for (const name of ["category", "level", "prereq"]) {
      el.querySelector(`select[name=${name}]`).addEventListener("change", ev => { this.view[name] = ev.target.value; this.render(); });
    }
    // One click shows the spell and chooses it (or takes it back); the detail button does the same.
    for (const li of el.querySelectorAll("li.theia-feat")) li.addEventListener("click", async () => { await this.select(li.dataset.uuid, false); this.toggle(); });
    el.querySelector("button[data-action=choose]")?.addEventListener("click", () => this.choose());
  }

  async select(uuid) {
    const entry = (await this.list()).find(e => e.uuid === uuid);
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

/**
 * The Theia classes choose feats (and invocations, maneuvers...) through an item choice whose pool lists every option as
 * a checkbox. For a pool of 9 or more, the checkbox list is hidden and the feat picker is shown in its place, inside the
 * level-up window: search, filters, the options the character can take first and the others greyed out below. Taking an
 * option ticks dnd5e's own (hidden) checkbox, so the advancement works as before.
 */
const INLINE_POOL_MIN = 9;
Hooks.on("renderItemChoiceFlow", async (flow, element) => {
  const config = flow.advancement?.configuration;
  if ((config?.type !== "feat") || !(config.pool?.length >= INLINE_POOL_MIN) || element.querySelector(".theia-feat-inline")) return;
  const section = element.querySelector(".item-list.current-level")?.closest(".items-section");
  if (!section) return;
  section.style.display = "none";
  const host = document.createElement("div");
  host.className = "theia-feat-picker theia-feat-inline";
  section.before(host);
  // Give the level-up window room for the picker.
  const app = foundry.applications.instances.get(element.closest(".application")?.id);
  if (app && (app.position?.width ?? 0) < 620) app.setPosition({ width: 620 });

  const actor = flow.advancement.actor;
  const picker = new FeatPicker({ actor, level: flow.featureLevel ?? actor?.system.details?.level, pool: config.pool.map(p => p.uuid) });
  // The flow re-renders when a box changes: keep the search and filters on the flow.
  flow.theiaView ??= picker.view;
  picker.view = flow.theiaView;
  const esc = foundry.utils.escapeHTML;
  const boxes = () => [...section.querySelectorAll(".item-list.current-level dnd5e-checkbox")];
  // Keep the picker's typing and clicks away from the advancement form, which would re-render the whole step.
  for (const type of ["input", "change", "keydown", "submit"]) host.addEventListener(type, ev => {
    if ((type === "keydown") && (ev.key === "Enter")) ev.preventDefault();
    ev.stopPropagation();
  });
  // A full draw builds the filters too; a list draw only replaces the list and details, so the search keeps its focus.
  const draw = async (listOnly = false) => {
    const root = await picker._renderHTML();
    for (const el of root.querySelectorAll("[name]")) { el.dataset.field = el.getAttribute("name"); el.removeAttribute("name"); }
    const chosen = boxes().filter(b => b.checked);
    const names = await Promise.all(chosen.map(b => fromUuid(b.name).then(d => d?.name ?? b.name)));
    const head = document.createElement("div");
    head.className = "inline-chosen";
    head.innerHTML = chosen.length
      ? `<strong>Chosen:</strong> ${names.map(esc).join(", ")} <a data-action="clear"><i class="fa-solid fa-xmark"></i> clear</a>`
      : `<em>Choose ${esc(flow.advancement.title ?? "an option")} below, then take it.</em>`;
    const oldColumns = host.querySelector(".columns");
    if (listOnly && oldColumns) {
      host.querySelector(".inline-chosen")?.replaceWith(head);
      oldColumns.replaceWith(root.querySelector(".columns"));
      bindList();
    } else {
      host.replaceChildren(head, root);
      bindFilters();
      bindList();
    }
  };
  picker.render = () => draw(true); // select() re-renders through this
  let searchTimer = null;
  const tick = (uuid, checked) => {
    const box = boxes().find(b => b.name === uuid);
    if (!box) return ui.notifications.warn("That option can't be selected in this step.");
    if (checked && box.disabled) return ui.notifications.warn("No more options can be selected in this step: clear one first.");
    box.checked = checked;
    box.dispatchEvent(new Event("change", { bubbles: true }));
  };
  const bindFilters = () => {
    host.querySelector("[data-field=search]")?.addEventListener("input", ev => {
      picker.view.search = ev.target.value;
      clearTimeout(searchTimer);
      searchTimer = setTimeout(() => draw(true), 150);
    });
    for (const name of ["category", "level", "prereq"]) {
      host.querySelector(`[data-field=${name}]`)?.addEventListener("change", ev => { picker.view[name] = ev.target.value; draw(true); });
    }
  };
  const bindList = () => {
    for (const li of host.querySelectorAll("li.theia-feat")) li.addEventListener("click", () => picker.select(li.dataset.uuid));
    host.querySelector("button[data-action=choose]")?.addEventListener("click", ev => { ev.preventDefault(); if (picker.view.selected) tick(picker.view.selected.uuid, true); });
    host.querySelector("[data-action=clear]")?.addEventListener("click", () => { for (const b of boxes().filter(x => x.checked)) tick(b.name, false); });
  };
  await draw();
});

/**
 * Level-up and spells: the Theia classes choose their spells in Spell Book. The level-up window says how many cantrips
 * and prepared spells the new level adds, and when it finishes, Spell Book opens for the character to choose them.
 */
const SPELL_SCALES = { "cantrips-known": "cantrip", "prepared-spells": "prepared spell" };
Hooks.on("renderScaleValueFlow", (flow, element) => {
  const advancement = flow.advancement;
  const kind = SPELL_SCALES[advancement?.configuration?.identifier];
  if (!kind || element.querySelector(".theia-spell-note")) return;
  const level = flow.level;
  const now = Number(advancement.valueForLevel(level)?.value ?? 0);
  const before = Number(advancement.valueForLevel(level - 1)?.value ?? 0);
  const gain = now - before;
  const note = document.createElement("p");
  note.className = "theia-spell-note notes";
  note.innerHTML = gain > 0
    ? `<i class="fa-solid fa-book-sparkles"></i> <strong>+${gain} ${kind}${gain > 1 ? "s" : ""}</strong> (${before} → ${now}). The Spell Book opens again when this level-up finishes, with the new limit.`
    : `<i class="fa-solid fa-book"></i> ${now} ${kind}s at this level.`;
  element.append(note);
  if (gain > 0) {
    const manager = foundry.applications.instances.get(element.closest(".application")?.id);
    if (manager) manager.theiaSpellsGrow = true;
  }
});
Hooks.on("dnd5e.advancementManagerComplete", manager => {
  const actor = manager.actor;
  const api = game.modules.get("spell-book")?.api;
  if (!actor || !api?.openSpellBookForActor || !manager.theiaSpellsGrow) return;
  ui.notifications.info(`${actor.name}: choose the new spells in the Spell Book.`);
  setTimeout(() => api.openSpellBookForActor(actor), 500);
});

/* -------------------------------------------- */
/*  Spell choices outside the level-up window   */
/* -------------------------------------------- */

/**
 * The Theia items don't choose spells in the level-up window (it was slow and duplicated Spell Book). A feat, species,
 * class or feature that lets the character pick spells keeps that choice in "flags.theia.spellChoices", an array of
 * { key, title, count, level, pool: [uuids], spell: { ability: [], method, prepared, uses: { max, per } } }.
 * "level" is the class level the choice opens at (0: when the item is gained). After a level-up, or when such an item is
 * added, the Spell Choice window lists the pool (search, level, school) and creates the chosen spells. What was chosen
 * is remembered in "flags.theia.spellChoicesDone" on the item.
 */
class SpellChoicePicker extends foundry.applications.api.ApplicationV2 {
  constructor({ actor, item, choice, resolve, ...options } = {}) {
    super(options);
    Object.assign(this, { actor, item, choice, resolve });
    this.view = { search: "", level: "", school: "", chosen: new Set(), selected: null, ability: choice.spell?.ability?.[0] ?? "" };
  }

  static DEFAULT_OPTIONS = {
    classes: ["theia-feat-picker", "theia-spell-choice"],
    window: { title: "Choose Spells", icon: "fa-solid fa-book-sparkles", resizable: true },
    position: { width: 760, height: 620 }
  };

  get title() { return `${this.item.name}: ${this.choice.title}`; }

  async entries() {
    if (this._entries) return this._entries;
    const pool = this.choice.pool ?? [];
    const byPack = new Set();
    for (const uuid of pool) { const { collection } = foundry.utils.parseUuid(uuid); if (collection?.getIndex) byPack.add(collection); }
    // The restriction (spell level, school) applies to the pool; with no pool, to every spell of the shared spell compendium.
    const L = String(this.choice.restriction?.level ?? "");
    const schools = this.choice.restriction?.school ?? [];
    const maxSlot = Math.max(0, ...Object.values(this.actor.system.spells ?? {}).filter(s => s.max > 0).map(s => s.level ?? 0));
    const allowed = e => ((L === "") || (L === "available" ? (e.system.level >= 1 && e.system.level <= maxSlot) : e.system.level === Number(L)))
      && (!schools.length || schools.includes(e.system.school));
    let fits = e => pool.includes(e.uuid) && allowed(e);
    if (!pool.length) {
      const spells = game.packs.get("forge-vtt-shared-compendiums-theia.item-1-spells") ?? game.packs.find(p => p.metadata.label === "Spells (Shared)");
      if (spells) byPack.add(spells);
      fits = e => (e.type === "spell") && allowed(e);
    }
    const out = [];
    const owned = new Set(this.actor.items.filter(i => i.type === "spell").map(i => i._stats?.compendiumSource));
    for (const pack of byPack) {
      const index = await pack.getIndex({ fields: ["type", "system.level", "system.school"] });
      for (const e of index.values()) if (fits(e)) out.push({ ...e, owned: owned.has(e.uuid) });
    }
    return (this._entries = out.sort((a, b) => (a.system.level - b.system.level) || a.name.localeCompare(b.name, game.i18n.lang)));
  }

  async _renderHTML() {
    const { search, level, school, chosen, selected, ability } = this.view;
    const esc = foundry.utils.escapeHTML;
    const all = await this.entries();
    const term = search.trim().toLowerCase();
    const rows = all.filter(e => (!term || e.name.toLowerCase().includes(term)) && (level === "" || e.system.level === Number(level)) && (!school || e.system.school === school));
    const levels = [...new Set(all.map(e => e.system.level))].sort((a, b) => a - b);
    const schools = [...new Set(all.map(e => e.system.school).filter(Boolean))];
    const label = l => (l === 0 ? "Cantrip" : `Level ${l}`);
    const abilities = this.choice.spell?.ability ?? [];
    const root = document.createElement("div");
    root.className = "theia-feat-body";
    root.innerHTML = `
      <div class="filters">
        <input type="search" data-field="search" placeholder="Search spells" value="${esc(search)}">
        <select data-field="level"><option value="">Any level</option>${levels.map(l => `<option value="${l}" ${String(l) === level ? "selected" : ""}>${label(l)}</option>`).join("")}</select>
        <select data-field="school"><option value="">Any school</option>${schools.map(s => `<option value="${s}" ${s === school ? "selected" : ""}>${esc(CONFIG.DND5E.spellSchools[s]?.label ?? s)}</option>`).join("")}</select>
        ${abilities.length > 1 ? `<select data-field="ability" title="Spellcasting ability">${abilities.map(a => `<option value="${a}" ${a === ability ? "selected" : ""}>${esc(CONFIG.DND5E.abilities[a]?.label ?? a)}</option>`).join("")}</select>` : ""}
      </div>
      <div class="inline-chosen"><strong>Chosen ${chosen.size} of ${this.choice.count}:</strong> ${[...chosen].map(u => esc(all.find(e => e.uuid === u)?.name ?? u)).join(", ") || "—"}</div>
      <div class="columns">
        <ul class="list">${rows.map(e => `
          <li class="theia-feat ${e.owned ? "unmet" : ""} ${chosen.has(e.uuid) ? "active" : ""} ${e.uuid === selected?.uuid ? "selected" : ""}" data-uuid="${e.uuid}">
            <img src="${e.img}" alt=""><span class="name">${esc(e.name)}</span>
            <span class="tag">${label(e.system.level)} · ${esc(CONFIG.DND5E.spellSchools[e.system.school]?.label ?? "")}</span>
            ${e.owned ? `<span class="unmet-reason">Already known</span>` : ""}
          </li>`).join("") || `<li class="empty">No spells match.</li>`}</ul>
        <section class="detail">${selected ? `<h3>${esc(selected.name)}</h3><div class="desc">${selected.description}</div>
          <button type="button" data-action="toggle">${chosen.has(selected.uuid) ? '<i class="fa-solid fa-xmark"></i> Remove' : '<i class="fa-solid fa-plus"></i> Choose'} ${esc(selected.name)}</button>` : `<p class="hint">Select a spell to read it.</p>`}</section>
      </div>
      <button type="button" class="choose" data-action="confirm" ${chosen.size === this.choice.count ? "" : "disabled"}><i class="fa-solid fa-check"></i> Learn ${chosen.size} spell${chosen.size === 1 ? "" : "s"}</button>`;
    return root;
  }

  _replaceHTML(result, content) {
    const focused = document.activeElement?.dataset?.field;
    content.replaceChildren(result);
    if (focused === "search") { const i = content.querySelector("[data-field=search]"); i.focus(); i.setSelectionRange(i.value.length, i.value.length); }
  }

  _onRender() {
    const el = this.element;
    let timer = null;
    el.querySelector("[data-field=search]").addEventListener("input", ev => { this.view.search = ev.target.value; clearTimeout(timer); timer = setTimeout(() => this.render(), 150); });
    for (const f of ["level", "school", "ability"]) el.querySelector(`[data-field=${f}]`)?.addEventListener("change", ev => { this.view[f] = ev.target.value; this.render(); });
    // One click shows the spell and chooses it (or takes it back); the detail button does the same.
    for (const li of el.querySelectorAll("li.theia-feat")) li.addEventListener("click", async () => { await this.select(li.dataset.uuid, false); this.toggle(); });
    el.querySelector("[data-action=toggle]")?.addEventListener("click", () => this.toggle());
    el.querySelector("[data-action=confirm]")?.addEventListener("click", () => this.confirm());
  }

  async select(uuid, render) {
    if (this.view.selected?.uuid === uuid) return;
    const item = await fromUuid(uuid);
    if (!item) return;
    const description = await foundry.applications.ux.TextEditor.implementation.enrichHTML(item.system.description?.value ?? "", { relativeTo: item });
    this.view.selected = { uuid, name: item.name, description };
    if (render !== false) this.render();
  }

  toggle() {
    const uuid = this.view.selected?.uuid;
    if (!uuid) return;
    const { chosen } = this.view;
    if (chosen.has(uuid)) chosen.delete(uuid);
    else if (this._entries?.find(e => e.uuid === uuid)?.owned) return ui.notifications.warn(`${this.view.selected.name} is already known.`);
    else if (chosen.size < this.choice.count) chosen.add(uuid);
    else return ui.notifications.warn(`Only ${this.choice.count} can be chosen here: remove one first.`);
    this.render();
  }

  async confirm() {
    const { chosen, ability } = this.view;
    // Wizard spell book choices (school savants): the spells are written in the character's Spell Book spellbook.
    if (this.choice.target === "spellbook" && await this.writeInSpellbook([...chosen])) return this.finish();
    const cfg = this.choice.spell ?? {};
    const data = [];
    for (const uuid of chosen) {
      const spell = (await fromUuid(uuid))?.toObject();
      if (!spell) continue;
      delete spell._id;
      const sys = spell.system;
      if (ability) sys.ability = ability;
      if (cfg.method) { sys.method = cfg.method; sys.prepared = cfg.prepared ?? 0; }
      sys.sourceItem = `${this.item.type}:${this.item.system.identifier || this.item.name.slugify()}`;
      if (cfg.uses?.max && cfg.uses?.per) {
        sys.uses = { spent: 0, max: String(cfg.uses.max), recovery: [{ period: cfg.uses.per, type: "recoverAll" }] };
        for (const a of Object.values(sys.activities ?? {})) {
          if (!a.consumption?.spellSlot) continue;
          const id = foundry.utils.randomID();
          sys.activities[id] = { _id: id, type: "forward", name: `${a.name || "Cast"} (free casting)`, sort: (a.sort ?? 0) + 1, activity: { id: a._id },
            consumption: { targets: [{ type: "itemUses", target: "", value: "1" }] } };
        }
      }
      spell._stats = { compendiumSource: uuid };
      spell.flags = { ...spell.flags, core: { ...(spell.flags?.core ?? {}), sourceId: uuid }, theia: { ...(spell.flags?.theia ?? {}), fromChoice: `${this.item.id}.${this.choice.key}` } };
      data.push(spell);
    }
    await this.actor.createEmbeddedDocuments("Item", data);
    return this.finish();
  }

  /** Adds spells to the actor's wizard spellbook page of Spell Book; false when there's none. */
  async writeInSpellbook(uuids) {
    const pack = game.packs.get("spell-book.custom-spell-lists");
    if (!pack) return false;
    const classId = Object.keys(this.actor.classes ?? {}).find(c => /wizard/.test(c)) ?? "";
    for (const journal of await pack.getDocuments()) {
      const page = journal.pages.find(p => p.flags?.["spell-book"]?.isActorSpellbook && (p.flags["spell-book"].actorId === this.actor.id) && (!classId || p.flags["spell-book"].classIdentifier === classId));
      if (!page) continue;
      const spells = new Set(page.system.spells ?? []);
      for (const u of uuids) spells.add(u);
      await page.update({ "system.spells": [...spells] });
      ui.notifications.info(`${this.actor.name}: ${uuids.length} spell(s) written in the spellbook. Prepare them in the Spell Book.`);
      return true;
    }
    return false;
  }

  async finish() {
    const done = [...(this.item.flags?.theia?.spellChoicesDone ?? []), this.choice.key];
    await this.item.update({ "flags.theia.spellChoicesDone": done });
    this.resolve?.(true); this.resolve = null;
    this.close();
  }

  async close(options) { this.resolve?.(false); this.resolve = null; return super.close(options); }

  static open(options) { return new Promise(resolve => new SpellChoicePicker({ ...options, resolve }).render({ force: true })); }
}

/** The spell choices of an actor's items that are open now and not yet made. */
function pendingSpellChoices(actor) {
  const out = [];
  for (const item of actor.items) {
    const choices = item.flags?.theia?.spellChoices;
    if (!Array.isArray(choices) || !choices.length) continue;
    const done = new Set(item.flags?.theia?.spellChoicesDone ?? []);
    // Class choices open at a class level; the others when the item is gained.
    let owner = item;
    const origin = item.flags?.dnd5e?.advancementOrigin?.split(".")[0];
    if (!["class", "subclass"].includes(item.type) && origin) owner = actor.items.get(origin) ?? item;
    const cls = owner.type === "class" ? owner : (owner.type === "subclass" ? actor.classes?.[owner.system.classIdentifier] : null);
    // Species choices open at a character level; feats when they're gained.
    const level = cls ? cls.system.levels : (item.type === "race" ? (actor.system.details?.level ?? 0) : Infinity);
    for (const choice of choices) if (!done.has(choice.key) && ((choice.level ?? 0) <= level)) out.push({ item, choice });
  }
  return out;
}
const spellChoiceQueue = new Set();
async function offerSpellChoices(actor) {
  if (!actor?.isOwner || spellChoiceQueue.has(actor.id)) return;
  spellChoiceQueue.add(actor.id);
  try {
    for (const { item, choice } of pendingSpellChoices(actor)) {
      const made = await SpellChoicePicker.open({ actor, item, choice });
      if (!made) break; // closed: ask again on the next level-up or from the item
    }
  } finally { spellChoiceQueue.delete(actor.id); }
}
// A closed window can be opened again from the character sheet's menu while a choice is pending.
Hooks.on("getHeaderControlsActorSheetV2", (sheet, controls) => {
  const actor = sheet.document;
  if (!(actor?.isOwner) || !pendingSpellChoices(actor).length) return;
  controls.unshift({ icon: "fa-solid fa-book-sparkles", label: "Choose Pending Spells", action: "theiaSpellChoices", onClick: () => offerSpellChoices(actor) });
});
// After a level-up (classes and the items it added), and when an item with spell choices is added outside one.
Hooks.on("dnd5e.advancementManagerComplete", manager => setTimeout(() => offerSpellChoices(manager.actor), 300));
Hooks.on("createItem", (item, options, userId) => {
  if ((userId !== game.user.id) || !(item.parent instanceof Actor) || !item.flags?.theia?.spellChoices?.length) return;
  if (foundry.applications.instances.values().some?.(a => a instanceof dnd5e.applications.advancement.AdvancementManager)) return; // the level-up hook does it
  setTimeout(() => offerSpellChoices(item.parent), 300);
});

/* -------------------------------------------- */
/*  Armor-dependent feat effects                */
/* -------------------------------------------- */

/**
 * A transfer effect with the flag "flags.theia-feats.requires" is turned on and off with the armor its actor wears:
 * "noHeavyArmor" (Speedster), "mediumArmor" (Medium Armor Master) or "noArmor".
 */
const ARMOR_RULES = {
  noHeavyArmor: armor => armor?.system.type?.value !== "heavy",
  mediumArmor: armor => armor?.system.type?.value === "medium",
  noArmor: armor => !armor
};
const ARMOR_TYPES = ["light", "medium", "heavy"];
const equippedArmor = actor => actor.items.find(i => (i.type === "equipment") && i.system.equipped
  && ARMOR_TYPES.includes(i.system.type?.value));

async function syncArmorEffects(actor) {
  const armor = equippedArmor(actor);
  for (const effect of actor.allApplicableEffects()) {
    const rule = ARMOR_RULES[effect.getFlag(MODULE_ID, "requires")];
    if (!rule) continue;
    const disabled = !rule(armor);
    if (effect.disabled !== disabled) await effect.update({ disabled });
  }
}
const armorSyncs = new Map();
function queueArmorSync(item) {
  const actor = item?.parent;
  if (!(actor instanceof Actor) || (game.users.activeGM !== game.user)) return;
  if (!armorSyncs.has(actor.uuid)) armorSyncs.set(actor.uuid, foundry.utils.debounce(() => syncArmorEffects(actor), 100));
  armorSyncs.get(actor.uuid)();
}
for (const hook of ["createItem", "updateItem", "deleteItem"]) Hooks.on(hook, queueArmorSync);

/* -------------------------------------------- */
/*  Elemental Adept damage type                 */
/* -------------------------------------------- */

/**
 * Elemental Adept is chosen per damage type, and the Theia_Elemental_Adept macro reads the type from the feat's name,
 * "Elemental Adept (Fire)". When the feat is added under its bare name, its owner chooses the type.
 */
const ELEMENTAL_TYPES = ["acid", "cold", "fire", "lightning", "thunder"];
Hooks.on("createItem", async (item, options, userId) => {
  if ((userId !== game.user.id) || !(item.parent instanceof Actor) || (item.system.identifier !== "elemental-adept")) return;
  if (/\(\w+\)$/.test(item.name)) return;
  const taken = item.parent.items.map(i => i.name.match(/^Elemental Adept \((\w+)\)$/i)?.[1]?.toLowerCase()).filter(Boolean);
  const types = ELEMENTAL_TYPES.filter(t => !taken.includes(t));
  if (!types.length) return;
  const label = t => CONFIG.DND5E.damageTypes[t]?.label ?? t;
  const type = await foundry.applications.api.DialogV2.wait({
    window: { title: "Elemental Adept" },
    content: "<p>Choose the damage type. Your spells ignore resistance to it, and a 1 on its damage dice counts as a 2.</p>",
    buttons: types.map((t, i) => ({ action: t, label: label(t), default: i === 0 })),
    rejectClose: false
  });
  if (type) await item.update({ name: `Elemental Adept (${label(type)})` });
});

/* -------------------------------------------- */
/*  Reactions around saving throws              */
/* -------------------------------------------- */

const ownerOf = actor => globalThis.cat?.utils?.queryUtils?.firstOwner?.(actor, true) ?? game.user.id;
const askOwner = (actor, title, content) => globalThis.cat?.utils?.dialogUtils?.confirm?.(title, content, { userId: ownerOf(actor) })
  ?? foundry.applications.api.DialogV2.confirm({ window: { title }, content });
const featNamed = (actor, name) => actor?.items.find(i => (i.type === "feat") && (i.name === name));
const sayAs = (actor, text) => ChatMessage.create({ speaker: ChatMessage.getSpeaker({ actor }), content: `<p>${text}</p>` });

/**
 * After Midi checks the saving throws, on the client running the workflow:
 *  - Interpose Shield: a target that succeeds on a Dexterity save against half damage, wielding a shield, may use its
 *    reaction to take no damage (Midi's semi-super saver).
 *  - Forceful Soul: the caster may use its reaction to give a target that succeeded a −1d6 penalty, possibly failing it
 *    (once per short rest; spells, class features, racial traits and feats).
 */
Hooks.on("midi-qol.postCheckSaves", async wf => {
  const activity = wf.saveActivity ?? wf.activity;
  if (!activity?.save || !wf.saves?.size) return;
  const dc = activity.save.dc?.value ?? wf.saveDC;
  const rollFor = t => (wf.saveRolls ?? []).find(r => r.options?.["midi-qol"]?.targetUuid === (t.document ?? t).uuid);
  const halfOnSave = activity.damage?.onSave === "half";

  for (const target of [...wf.saves]) {
    const tActor = target.actor;
    const shield = tActor?.items.some(i => (i.type === "equipment") && (i.system.type?.value === "shield") && i.system.equipped);
    if (!halfOnSave || !activity.save.ability?.has?.("dex") || !shield) continue;
    if (!featNamed(tActor, "Interpose Shield") || MidiQOL.hasUsedReaction(tActor) || wf.semiSuperSavers?.has(target)) continue;
    if (!await askOwner(tActor, "Interpose Shield", `<p>${target.name} succeeded on the Dexterity save against ${wf.item?.name}. Use your reaction to take no damage?</p>`)) continue;
    await MidiQOL.setReactionUsed(tActor);
    wf.semiSuperSavers = wf.semiSuperSavers.add(target);
    await sayAs(tActor, `<strong>Interpose Shield</strong>: ${target.name} takes no damage from ${wf.item?.name}.`);
  }

  const caster = wf.actor;
  const soul = featNamed(caster, "Forceful Soul");
  const sourceOk = ["spell", "feat"].includes(wf.item?.type);
  if (!soul || !sourceOk || MidiQOL.hasUsedReaction(caster) || !((soul.system.uses?.value ?? 0) > 0)) return;
  for (const target of [...wf.saves]) {
    const roll = rollFor(target);
    if (!roll || !Number.isFinite(dc) || (roll.total - 6 >= dc)) continue; // even a 6 wouldn't make it fail
    if (!await askOwner(caster, "Forceful Soul", `<p>${target.name} succeeded (${roll.total} vs DC ${dc}). Use your reaction to impose −1d6?</p>`)) continue;
    await MidiQOL.setReactionUsed(caster);
    await soul.update({ "system.uses.spent": (soul.system.uses.spent ?? 0) + 1 });
    const penalty = await new Roll("1d6").evaluate();
    await penalty.toMessage({ speaker: ChatMessage.getSpeaker({ actor: caster }), flavor: "Forceful Soul penalty" });
    const fails = roll.total - penalty.total < dc;
    if (fails) {
      wf.saves.delete(target); wf.saves = wf.saves;
      wf.failedSaves = wf.failedSaves.add(target);
      wf.semiSuperSavers?.delete(target); wf.superSavers?.delete(target);
    }
    await sayAs(caster, `<strong>Forceful Soul</strong>: ${target.name}'s save is ${roll.total - penalty.total} vs DC ${dc}, ${fails ? "a failure" : "still a success"}.`);
    break;
  }
});

/**
 * Bulwark: when a creature with the feat is knocked Prone, its player may use the reaction to stay standing.
 * Run by the active GM; being moved against your will is left to the table.
 */
Hooks.on("createActiveEffect", async effect => {
  const actor = effect.parent;
  if (!(actor instanceof Actor) || (game.users.activeGM !== game.user) || !effect.statuses?.has("prone")) return;
  if (!featNamed(actor, "Bulwark") || globalThis.MidiQOL?.hasUsedReaction(actor)) return;
  if (!await askOwner(actor, "Bulwark", `<p>${actor.name} is knocked Prone. Use your reaction to steady yourself and stay standing?</p>`)) return;
  await MidiQOL.setReactionUsed(actor);
  await effect.delete();
  await sayAs(actor, `<strong>Bulwark</strong>: ${actor.name} steadies and stays standing.`);
});

/* -------------------------------------------- */
/*  Hit point thresholds                        */
/* -------------------------------------------- */

/**
 * Run by the active GM when a creature's hit points change:
 *  - Unbroken Body: dropped to 0 but not killed outright, its player may drop to 1 instead (1 per long rest).
 *  - Anthropomorphic Constitution: reduced to 20 HP or less (and not 0), for 1 minute all damage it takes is reduced by
 *    half its level (rounded down) + its Constitution modifier, minimum 1 (1 per long rest).
 */
Hooks.on("updateActor", async (actor, changes) => {
  if (game.users.activeGM !== game.user) return;
  const hp = foundry.utils.getProperty(changes, "system.attributes.hp.value");
  if (hp === undefined) return;
  const usesLeft = i => (i?.system.uses?.value ?? 0) > 0;
  const spend = i => i.update({ "system.uses.spent": (i.system.uses.spent ?? 0) + 1 });

  const unbroken = featNamed(actor, "Unbroken Body");
  if ((hp === 0) && usesLeft(unbroken) && !actor.statuses.has("dead")) {
    if (!await askOwner(actor, "Unbroken Body", `<p>${actor.name} drops to 0 hit points. Drop to 1 instead?</p>`)) return;
    await spend(unbroken);
    await actor.update({ "system.attributes.hp.value": 1 });
    const down = actor.effects.filter(e => e.statuses.has("unconscious") || e.statuses.has("dead")).map(e => e.id);
    if (down.length) await actor.deleteEmbeddedDocuments("ActiveEffect", down);
    return sayAs(actor, `<strong>Unbroken Body</strong>: ${actor.name} stays on their feet with 1 hit point.`);
  }

  const anthro = featNamed(actor, "Anthropomorphic Constitution");
  if ((hp > 0) && (hp <= 20) && usesLeft(anthro) && !actor.effects.some(e => e.name === "Anthropomorphic Constitution")) {
    await spend(anthro);
    await actor.createEmbeddedDocuments("ActiveEffect", [{
      name: "Anthropomorphic Constitution", img: anthro.img, origin: anthro.uuid, transfer: false, duration: { seconds: 60, rounds: 10 },
      description: "<p>All damage taken is reduced by half your level (rounded down) + your Constitution modifier (minimum 1).</p>",
      system: { changes: [{ key: "system.traits.dm.midi.all", type: "add",
        value: "-max(1, floor(@details.level / 2) + @abilities.con.mod)", priority: 20, phase: "initial" }] }
    }]);
    return sayAs(actor, `<strong>Anthropomorphic Constitution</strong>: ${actor.name} hardens; damage is reduced for 1 minute.`);
  }
});

/* -------------------------------------------- */
/*  Theia class spell lists (Spell Book)        */
/* -------------------------------------------- */

/**
 * Spell Book only links the stock classes (bard, wizard...) to their lists by itself. The Theia classes have their own
 * identifiers (wizard-theia, shaman, magus...), and their lists live in Spell Book's Custom Spell Lists pack, flagged
 * "flags.theia.source". When a character has a Theia class with no list assigned, the active GM assigns it.
 */
const LIST_PACK = "spell-book.custom-spell-lists";
let theiaLists = null;
async function theiaListFor(identifier) {
  if (!theiaLists) {
    theiaLists = new Map();
    const pack = game.packs.get(LIST_PACK);
    for (const journal of (await pack?.getDocuments()) ?? []) for (const page of journal.pages) {
      if ((page.type === "spells") && page.flags?.theia?.source && (page.system.type === "class")) theiaLists.set(page.system.identifier, page.uuid);
    }
  }
  return theiaLists.get(identifier) ?? null;
}
async function linkTheiaSpellLists(actor) {
  const api = game.modules.get("spell-book")?.api;
  if (!api?.setClassSpellLists || (actor?.type !== "character")) return;
  for (const cls of actor.items.filter(i => i.type === "class")) {
    const progression = cls.system.spellcasting?.progression;
    if (!progression || (progression === "none")) continue;
    const id = cls.system.identifier;
    const rules = actor.getFlag("spell-book", "classRules")?.[id];
    if (rules?.customSpellList?.length) continue;
    const uuid = await theiaListFor(id);
    if (uuid) await api.setClassSpellLists(actor, id, [uuid]);
  }
}
Hooks.on("createItem", item => {
  if ((item.type === "class") && (item.parent instanceof Actor) && (game.users.activeGM === game.user)) linkTheiaSpellLists(item.parent);
});
Hooks.once("ready", async () => {
  if (game.users.activeGM !== game.user) return;
  // Spell Book registers its API late in its own ready; wait for it (up to 15 s).
  for (let i = 0; (i < 30) && !game.modules.get("spell-book")?.api?.setClassSpellLists; i++) await new Promise(r => setTimeout(r, 500));
  for (const actor of game.actors.filter(a => a.type === "character")) {
    try { await linkTheiaSpellLists(actor); } catch (error) { console.warn(`${MODULE_ID} | spell list for ${actor.name}`, error); }
  }
});

/* -------------------------------------------- */
/*  Setup                                       */
/* -------------------------------------------- */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "pack", {
    name: "Feat compendium",
    hint: "The Item compendium whose feats the feat picker lists.",
    scope: "world", config: true, type: String, default: DEFAULT_PACK
  });
  game.modules.get(MODULE_ID).api = { FeatPicker, unmetPrerequisites, SpellChoicePicker, offerSpellChoices, pendingSpellChoices };
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
