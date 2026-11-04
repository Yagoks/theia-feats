# Theia Feats

Faster level-up choices for the Theia worlds (Foundry VTT 14, dnd5e 6). Needs libWrapper.

## Batched compendium loads

The level-up window asks for every option of a choice at once, but each request was its own round trip, answered one after another: about 130 ms per item in the 2186-item Class Features (Shared) pack. A monk's 129-feat choice took about 17 s to open. Requests for documents of the same pack made within a few milliseconds are joined into one query, so that choice opens in about 1.4 s (40 spells: 6.4 s before, 0.3 s after). It speeds up every choice of the level-up window: feats, spells, and the choices inside a feat (such as Silver Tongue's skill). Cached documents are returned as before.

## Feat picker

When dnd5e's Ability Score Improvement step browses for a feat, a quick picker opens instead of the compendium browser. It lists the feats of one compendium (setting **Feat compendium**, Class Features (Shared) by default) from its index, with search, category (Origin, General, Fighting Style, Epic Boon) and the character's prerequisites; unmet ones show why. A feat's description loads when it is selected. The Theia classes choose feats through their own "Feats" item choice instead, which the batched loads speed up.

## Prerequisites

Items can carry Theia prerequisites in `flags.theia.prereqs`: an array of `{ path, op, value, label }`, a dotted path on the actor compared with `value`, such as `{ "path": "system.abilities.cha.value", "op": ">=", "value": 13, "label": "Charisma 13" }`. An item whose prerequisites the actor doesn't meet can't be created on it (level-up grants included), and the feat picker shows them with dnd5e's own (level, required items, not repeatable). This replaces the Theia Prerequisites module; while that one is active, it does the blocking.
