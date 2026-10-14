// Stonetop Werkzeuge (pbta)
// 1. Ausrüstungs-Insert im Equipment-Reiter des Charakterbogens, gespeichert am Actor.
// 2. Kästchen und Notizfelder in Move-/Item-Beschreibungen speichern (z. B. Potential for Greatness).
// 3. Checkboxen in Journal-Textseiten dauerhaft speichern (Nachfolger von „Journal Checkbox Persist“).

const MODULE_ID = "stonetop-werkzeuge";
const FLAG_OUTFIT = "outfit";

let queue = Promise.resolve();
function enqueue(task) {
  queue = queue.then(task).catch((err) => {
    console.error(`${MODULE_ID} |`, err);
    ui.notifications.error("Stonetop Werkzeuge: Speichern fehlgeschlagen (siehe Konsole).");
  });
  return queue;
}

/* ---------------------------------------------------------------- Hilfen */

// Setzt in einem HTML-String das n-te <input> (checkbox oder text) auf den Zustand aus dem DOM.
function writeInputIntoHtml(html, index, input) {
  const doc = new DOMParser().parseFromString(html ?? "", "text/html");
  const inputs = doc.body.querySelectorAll("input[type=checkbox], input[type=text]");
  const target = inputs[index];
  if (!target || target.type !== input.type) return null;
  if (input.type === "checkbox") {
    if (input.checked) target.setAttribute("checked", "");
    else target.removeAttribute("checked");
  } else {
    target.setAttribute("value", input.value);
  }
  return doc.body.innerHTML;
}

function fieldInputs(container) {
  return [...container.querySelectorAll("input[type=checkbox], input[type=text]")];
}

/* ------------------------------------------------- 1. Ausrüstungs-Insert */

function outfitTemplateHtml() {
  const name = game.settings.get(MODULE_ID, "outfitTemplate");
  const entry = game.journal.getName(name);
  const page = entry?.pages.find((p) => p.type === "text");
  return page?.text.content ?? null;
}

function countMarked(state) {
  return state.filter(Boolean).length;
}

async function renderOutfit(sheet, root) {
  const actor = sheet.actor;
  if (actor?.type !== "character") return;
  const tab = root.querySelector(".tab.equipment[data-tab='equipment'], .tab[data-tab='equipment']");
  if (!tab || tab.querySelector(".stw-outfit")) return;
  const template = outfitTemplateHtml();
  if (!template) return;

  const state = actor.getFlag(MODULE_ID, FLAG_OUTFIT) ?? [];
  const section = document.createElement("section");
  section.className = "stw-outfit";
  const collapsed = game.user.getFlag(MODULE_ID, `collapsed.${actor.id}`);
  if (collapsed) section.classList.add("collapsed");
  section.innerHTML = `<header><span>Ausrüstung (Inventory Insert)</span><span class="stw-load"></span></header><div class="stw-outfit-body">${template}</div>`;

  const boxes = fieldInputs(section.querySelector(".stw-outfit-body")).filter((i) => i.type === "checkbox");
  boxes.forEach((box, i) => {
    box.removeAttribute("checked");
    box.checked = !!state[i];
    box.disabled = !actor.isOwner;
    box.dataset.stwIndex = String(i);
  });
  const loadLabel = section.querySelector(".stw-load");
  const updateLoad = () => (loadLabel.textContent = `${countMarked(boxes.map((b) => b.checked))} markiert`);
  updateLoad();

  section.querySelector("header").addEventListener("click", () => {
    section.classList.toggle("collapsed");
    game.user.setFlag(MODULE_ID, `collapsed.${actor.id}`, section.classList.contains("collapsed"));
  });
  section.addEventListener("change", (ev) => {
    const box = ev.target;
    if (!(box instanceof HTMLInputElement) || box.dataset.stwIndex === undefined) return;
    ev.stopPropagation();
    const index = Number(box.dataset.stwIndex);
    const checked = box.checked;
    updateLoad();
    enqueue(async () => {
      const current = [...(actor.getFlag(MODULE_ID, FLAG_OUTFIT) ?? [])];
      current[index] = checked;
      for (let i = 0; i < current.length; i++) current[i] = !!current[i];
      await actor.setFlag(MODULE_ID, FLAG_OUTFIT, current);
    });
  });
  tab.prepend(section);
}

/* ------------------------------------- 2. Felder in Item-Beschreibungen */

// Felder der Beschreibung selbst, ohne die eingeblendete Arcana-Rückseite.
function descriptionInputs(desc) {
  return fieldInputs(desc).filter((i) => !i.closest(".stw-arcana-back"));
}

function bindItemDescriptions(sheet, root) {
  const actor = sheet.actor;
  if (!actor) return;
  for (const desc of root.querySelectorAll("li.item[data-item-id] .item-description")) {
    if (desc.dataset.stwBound) continue;
    desc.dataset.stwBound = "1";
    const itemId = desc.closest("li.item[data-item-id]").dataset.itemId;
    const inputs = descriptionInputs(desc);
    inputs.forEach((input) => (input.disabled = !actor.isOwner));
    const arcana = actor.items.get(itemId);
    if (arcana?.getFlag(MODULE_ID, "backSource")) renderArcanaBack(actor, arcana, desc);
    desc.addEventListener("change", (ev) => {
      const input = ev.target;
      if (!(input instanceof HTMLInputElement) || !["checkbox", "text"].includes(input.type)) return;
      if (input.closest(".stw-arcana-back")) return;
      ev.stopPropagation();
      const item = actor.items.get(itemId);
      if (!item) return;
      const index = descriptionInputs(desc).indexOf(input);
      enqueue(async () => {
        const html = writeInputIntoHtml(item.system.description, index, input);
        if (html === null) {
          ui.notifications.warn(`„${item.name}“: Beschreibung passt nicht, nicht gespeichert.`);
          return;
        }
        await item.update({ "system.description": html }, { render: false });
      });
    });
    // Klicks in Feldern und Knöpfen sollen die Beschreibung nicht zuklappen.
    desc.addEventListener("click", (ev) => {
      if (ev.target instanceof HTMLInputElement || ev.target.closest?.("button")) ev.stopPropagation();
    });
  }
}

/* ------------------------------------------ 2b. Arcana-Rückseite (GM-Freigabe) */
// Flags am Arcana-Item: backSource (UUID einer Journal-Seite oder eines Items mit dem Rückseitentext),
// revealed (für Spieler freigegeben), backHtml (Kopie der Rückseite mit gespeicherten Kästchen).
// Solange nicht freigegeben, liegt der Rückseitentext nur in der GM-Quelle, nicht im Item.

function sourceHtml(doc) {
  if (!doc) return null;
  if (doc.documentName === "JournalEntryPage") return doc.text?.content ?? null;
  if (doc.documentName === "Item") return doc.system?.description ?? null;
  return null;
}

async function setArcanaRevealed(item, reveal) {
  const update = { [`flags.${MODULE_ID}.revealed`]: reveal };
  if (reveal && !item.getFlag(MODULE_ID, "backHtml")) {
    const html = sourceHtml(await fromUuid(item.getFlag(MODULE_ID, "backSource")));
    if (!html) {
      ui.notifications.warn(`„${item.name}“: Rückseite nicht gefunden.`);
      return;
    }
    update[`flags.${MODULE_ID}.backHtml`] = html;
  }
  await item.update(update);
}

function renderArcanaBack(actor, item, desc) {
  const revealed = !!item.getFlag(MODULE_ID, "revealed");
  if (!revealed && !game.user.isGM) return;
  const box = document.createElement("div");
  box.className = "stw-arcana-back" + (revealed ? "" : " stw-hidden");
  const head = document.createElement("div");
  head.className = "stw-arcana-back-head";
  head.innerHTML = `<strong>Rückseite</strong>${revealed ? "" : " <em>(für Spieler verborgen)</em>"}`;
  if (game.user.isGM) {
    const button = document.createElement("button");
    button.type = "button";
    button.textContent = revealed ? "Wieder verbergen" : "Für Spieler freigeben";
    button.addEventListener("click", (ev) => {
      ev.preventDefault();
      ev.stopPropagation();
      setArcanaRevealed(item, !revealed);
    });
    head.append(button);
  }
  const body = document.createElement("div");
  body.className = "stw-arcana-back-body";
  box.append(head, body);
  desc.append(box);

  if (revealed) {
    body.innerHTML = item.getFlag(MODULE_ID, "backHtml") ?? "";
    const inputs = fieldInputs(body);
    inputs.forEach((input) => (input.disabled = !actor.isOwner));
    body.addEventListener("change", (ev) => {
      const input = ev.target;
      if (!(input instanceof HTMLInputElement)) return;
      ev.stopPropagation();
      const index = fieldInputs(body).indexOf(input);
      enqueue(async () => {
        const html = writeInputIntoHtml(item.getFlag(MODULE_ID, "backHtml"), index, input);
        if (html !== null) await item.setFlag(MODULE_ID, "backHtml", html);
      });
    });
  } else {
    // GM-Vorschau aus der Quelle, nicht anklickbar
    fromUuid(item.getFlag(MODULE_ID, "backSource")).then((doc) => {
      body.innerHTML = sourceHtml(doc) ?? "<em>Quelle nicht gefunden.</em>";
      fieldInputs(body).forEach((input) => (input.disabled = true));
    });
  }
}

/* ------------------------------------------------- 3. Journal-Checkboxen */

function journalPrefixes() {
  return (game.settings.get(MODULE_ID, "journalPrefixes") ?? "")
    .split(",").map((p) => p.trim()).filter(Boolean);
}

function onJournalChange(ev) {
  const box = ev.target;
  if (!(box instanceof HTMLInputElement) || box.type !== "checkbox") return;
  const article = box.closest("article.journal-entry-page[data-page-id]");
  if (!article) return;
  const app = [...foundry.applications.instances.values()].find(
    (a) => a.document?.documentName === "JournalEntry" && a.element?.contains(box)
  );
  const entry = app?.document;
  if (!entry || !journalPrefixes().some((p) => entry.name.startsWith(p))) return;
  // Seiten-IDs können sich zwischen Journalen wiederholen, deshalb über das offene Sheet auflösen.
  const page = entry.pages.get(article.dataset.pageId);
  if (!page || page.type !== "text") return;
  if (!page.canUserModify(game.user, "update")) {
    ui.notifications.warn(`Keine Schreibrechte auf „${entry.name}“, der Haken wird nicht gespeichert.`);
    return;
  }
  const boxes = [...article.querySelectorAll("input[type=checkbox]")];
  const index = boxes.indexOf(box);
  enqueue(async () => {
    const doc = new DOMParser().parseFromString(page.text.content ?? "", "text/html");
    const src = doc.body.querySelectorAll("input[type=checkbox]");
    if (src.length !== boxes.length || index < 0) {
      ui.notifications.warn(`„${entry.name}“ passt nicht zur gespeicherten Fassung, nicht gespeichert.`);
      return;
    }
    if (box.checked) src[index].setAttribute("checked", "");
    else src[index].removeAttribute("checked");
    const top = app.element?.querySelector(".journal-entry-pages")?.scrollTop ?? 0;
    await page.update({ "text.content": doc.body.innerHTML });
    for (const delay of [0, 100, 300]) {
      setTimeout(() => {
        const s = app.element?.querySelector(".journal-entry-pages");
        if (s && Math.abs(s.scrollTop - top) > 2) s.scrollTop = top;
      }, delay);
    }
  });
}

/* ------------------------------------------------------------ Einbindung */

Hooks.once("init", () => {
  game.settings.register(MODULE_ID, "outfitTemplate", {
    name: "Vorlage für das Ausrüstungs-Insert",
    hint: "Name des Journals, dessen erste Textseite als Insert im Equipment-Reiter erscheint. Die Kästchen werden der Reihe nach je Charakter gespeichert; wer die Vorlage umbaut, verschiebt gespeicherte Haken.",
    scope: "world",
    config: true,
    type: String,
    default: "Inventory Insert – Vorlage"
  });
  game.settings.register(MODULE_ID, "journalPrefixes", {
    name: "Journale mit dauerhaften Checkboxen",
    hint: "Kommagetrennt. Checkboxen in Journalen, deren Name mit einem dieser Texte beginnt, werden gespeichert.",
    scope: "world",
    config: true,
    type: String,
    default: "Inventory Insert, Potential for Greatness, Arcana"
  });
});

Hooks.on("renderActorSheet", (sheet, html) => {
  const root = html instanceof HTMLElement ? html : html?.[0];
  if (!root) return;
  renderOutfit(sheet, root);
  bindItemDescriptions(sheet, root);
});

Hooks.once("ready", () => {
  // Das Makro „Mein Inventar“ prüft dieses Flag und registriert dann keinen zweiten Listener.
  window.__invInsertPersist = { v: MODULE_ID, queue };
  document.addEventListener("change", onJournalChange, true);
  console.log(`${MODULE_ID} | bereit`);
});
