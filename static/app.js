/* Vanilla JS, same-origin API, no client framework or external runtime requests. */
"use strict";

const $ = (selector) => document.querySelector(selector);
const $$ = (selector) => [...document.querySelectorAll(selector)];
const STORAGE = {
  favorites: "val-instalock:favorites:v1",
  preferences: "val-instalock:preferences:v1",
};
const ROLE_ICONS = {
  Duelist: "duelist",
  Controller: "controller",
  Initiator: "initiator",
  Sentinel: "sentinel",
};
const TITLES = {
  idle: "Siap dimulai",
  connecting: "Menghubungkan…",
  waiting: "Menunggu agent select",
  locking: "Mengunci agent…",
  locked: "Agent berhasil di-lock",
  stopped: "Proses dihentikan",
  error: "Perlu perhatian",
};
const state = {
  agents: [],
  selected: null,
  role: "all",
  search: "",
  sort: "featured",
  favoritesOnly: false,
  favorites: new Set(),
  status: null,
  csrf: "",
  demo: false,
  online: false,
  actionPending: false,
  refreshPending: false,
  pollTimer: null,
  polling: false,
  failures: 0,
  lastStatusKey: "",
  toastTimer: null,
};

function readStorage(key, fallback) {
  try {
    return JSON.parse(localStorage.getItem(key)) ?? fallback;
  } catch {
    return fallback;
  }
}
function saveStorage(key, value) {
  try {
    localStorage.setItem(key, JSON.stringify(value));
  } catch {
    /* Private mode: keep working in memory. */
  }
}
function savePreferences() {
  saveStorage(STORAGE.preferences, {
    selected: state.selected,
    region: $("#region-select").value,
  });
}
function normalize(value) {
  const key = String(value)
    .normalize("NFKD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]/g, "");
  return key === "pheonix" ? "phoenix" : key;
}
function icon(name, className = "icon") {
  const svg = document.createElementNS("http://www.w3.org/2000/svg", "svg");
  svg.setAttribute("class", className);
  svg.setAttribute("aria-hidden", "true");
  const use = document.createElementNS("http://www.w3.org/2000/svg", "use");
  use.setAttribute("href", `#i-${name}`);
  svg.append(use);
  return svg;
}
function element(tag, className, text) {
  const node = document.createElement(tag);
  if (className) node.className = className;
  if (text !== undefined) node.textContent = text;
  return node;
}
function safeImage(source) {
  try {
    const url = new URL(source, location.origin);
    if (
      url.origin === location.origin &&
      url.pathname.startsWith("/assets/agents/")
    )
      return url.href;
    if (url.protocol === "https:" && url.hostname === "media.valorant-api.com")
      return url.href;
  } catch {
    /* Invalid URLs get an initials fallback. */
  }
  return "";
}
function attachImage(image, agent) {
  const source = safeImage(agent.image);
  image.alt = "";
  image.hidden = !source;
  image.onerror = () => {
    image.hidden = true;
  };
  if (source) image.src = source;
  else image.removeAttribute("src");
}
function isNew(agent) {
  return !agent.release_date || agent.release_date >= "2025-10-01";
}
function releaseKey(agent) {
  return agent.release_date || "9999-12-31";
}

async function api(path, body, timeout = 14000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeout);
  try {
    const response = await fetch(path, {
      method: body === undefined ? "GET" : "POST",
      credentials: "same-origin",
      cache: "no-store",
      signal: controller.signal,
      headers:
        body === undefined
          ? { Accept: "application/json" }
          : {
              Accept: "application/json",
              "Content-Type": "application/json",
              "X-CSRF-Token": state.csrf,
            },
      body: body === undefined ? undefined : JSON.stringify(body),
    });
    const data = await response.json();
    if (!response.ok)
      throw new Error(
        data.error || `Server mengembalikan HTTP ${response.status}.`,
      );
    return data;
  } catch (error) {
    if (error.name === "AbortError")
      throw new Error("Server terlalu lama merespons. Coba lagi sebentar.");
    if (error instanceof TypeError)
      throw new Error("Server lokal tidak dapat dihubungi.");
    throw error;
  } finally {
    clearTimeout(timer);
  }
}

function toast(message, error = false) {
  clearTimeout(state.toastTimer);
  const box = $("#toast");
  box.querySelector("span").textContent = message;
  box.querySelector("use").setAttribute("href", error ? "#i-info" : "#i-check");
  box.classList.toggle("error", error);
  box.hidden = false;
  state.toastTimer = setTimeout(
    () => {
      box.hidden = true;
    },
    error ? 6500 : 4000,
  );
}

function renderCounts() {
  $("#total-agents").textContent = state.agents.length;
  $$("[data-count]").forEach((node) => {
    const role = node.dataset.count;
    node.textContent =
      role === "all"
        ? state.agents.length
        : state.agents.filter((a) => a.role === role).length;
  });
  $("#favorites-count").textContent = state.agents.filter((a) =>
    state.favorites.has(a.id),
  ).length;
}
function visibleAgents() {
  const query = normalize(state.search);
  const filtered = state.agents.filter(
    (agent) =>
      (state.role === "all" || agent.role === state.role) &&
      (!state.favoritesOnly || state.favorites.has(agent.id)) &&
      (!query || normalize(agent.name).includes(query)),
  );
  if (state.sort === "name")
    filtered.sort((a, b) => a.name.localeCompare(b.name, "en"));
  if (state.sort === "newest")
    filtered.sort((a, b) => releaseKey(b).localeCompare(releaseKey(a)));
  return filtered;
}
function createCard(agent) {
  const selected = state.selected === agent.id;
  const card = element("article", `agent-card${selected ? " selected" : ""}`);
  card.style.setProperty("--agent-color", `#${agent.color}`);
  card.dataset.agent = agent.id;
  const button = element("button", "agent-select");
  button.type = "button";
  button.dataset.select = agent.id;
  button.setAttribute("aria-label", `Pilih ${agent.name}, ${agent.role}`);
  button.setAttribute("aria-pressed", String(selected));
  button.disabled = Boolean(state.status?.active);
  const art = element("div", "agent-art");
  art.append(element("span", "agent-initials", agent.name.slice(0, 2)));
  const image = element("img");
  image.width = 720;
  image.height = 655;
  image.loading = "lazy";
  image.decoding = "async";
  attachImage(image, agent);
  art.append(image);
  button.append(art);
  if (isNew(agent)) button.append(element("span", "new-badge", "BARU"));
  const role = element("span", "agent-card-role");
  role.append(icon(ROLE_ICONS[agent.role] || "grid"));
  button.append(role);
  const caption = element("span", "agent-card-caption");
  caption.append(
    element("span", "agent-card-name", agent.name),
    element("span", "agent-card-role-name", agent.role),
  );
  button.append(caption);
  if (selected) {
    const check = element("span", "selected-card-check");
    check.append(icon("check"));
    button.append(check);
  }
  button.addEventListener("click", () => selectAgent(agent.id));
  const favorite = element("button", "favorite-button");
  favorite.type = "button";
  favorite.dataset.favorite = agent.id;
  favorite.setAttribute(
    "aria-label",
    `${state.favorites.has(agent.id) ? "Hapus" : "Tambahkan"} ${agent.name} ${state.favorites.has(agent.id) ? "dari" : "ke"} favorit`,
  );
  favorite.setAttribute("aria-pressed", String(state.favorites.has(agent.id)));
  favorite.title = "Simpan sebagai favorit";
  favorite.append(icon("star"));
  favorite.addEventListener("click", () => toggleFavorite(agent.id));
  card.append(button, favorite);
  return card;
}
function renderGrid() {
  const agents = visibleAgents();
  const fragment = document.createDocumentFragment();
  agents.forEach((agent) => fragment.append(createCard(agent)));
  $("#agent-grid").replaceChildren(fragment);
  $("#agent-grid").setAttribute("aria-busy", "false");
  $("#empty-state").hidden = agents.length !== 0;
  const count = $("#results-count");
  count.replaceChildren(
    "Menampilkan ",
    element("strong", "", String(agents.length)),
    ` dari ${state.agents.length} agent`,
  );
  $$(".role-filter").forEach((button) => {
    const active = button.dataset.role === state.role;
    button.classList.toggle("selected", active);
    button.setAttribute("aria-pressed", String(active));
  });
  $("#favorites-filter").setAttribute(
    "aria-pressed",
    String(state.favoritesOnly),
  );
  renderCounts();
}
function renderSelection() {
  const agent = state.agents.find((a) => a.id === state.selected);
  if (!agent) return;
  $("#selected-name").textContent = agent.name;
  $("#mobile-picked-name").textContent = agent.name;
  $("#mobile-pick-bar").hidden = false;
  $("#selected-role").textContent = agent.role.toUpperCase();
  $("#selected-uuid").textContent =
    `${agent.uuid.slice(0, 8)}…${agent.uuid.slice(-6)}`;
  $("#selected-uuid").title = agent.uuid;
  $("#selected-portrait").style.setProperty("--agent-color", `#${agent.color}`);
  $("#selected-role-icon use").setAttribute(
    "href",
    `#i-${ROLE_ICONS[agent.role] || "grid"}`,
  );
  $("#selected-new-badge").hidden = !isNew(agent);
  attachImage($("#selected-image"), agent);
  const favorite = $("#selected-favorite");
  const saved = state.favorites.has(agent.id);
  favorite.setAttribute("aria-pressed", String(saved));
  favorite.setAttribute(
    "aria-label",
    `${saved ? "Hapus" : "Tambahkan"} ${agent.name} ${saved ? "dari" : "ke"} favorit`,
  );
  favorite.title = saved ? "Hapus dari favorit" : "Simpan sebagai favorit";
}
function selectAgent(id) {
  if (state.status?.active || !state.agents.some((a) => a.id === id)) return;
  state.selected = id;
  $$(".agent-card").forEach((card) => {
    const selected = card.dataset.agent === id;
    card.classList.toggle("selected", selected);
    card
      .querySelector(".agent-select")
      .setAttribute("aria-pressed", String(selected));
    card.querySelector(".selected-card-check")?.remove();
    if (selected) {
      const check = element("span", "selected-card-check");
      check.append(icon("check"));
      card.querySelector(".agent-select").append(check);
    }
  });
  renderSelection();
  savePreferences();
}
function toggleFavorite(id) {
  if (state.favorites.has(id)) state.favorites.delete(id);
  else state.favorites.add(id);
  saveStorage(STORAGE.favorites, [...state.favorites]);
  const focusedFavorite = document.activeElement?.dataset.favorite;
  renderGrid();
  renderSelection();
  if (focusedFavorite)
    $(`[data-favorite="${focusedFavorite}"]`)?.focus({ preventScroll: true });
}
function renderControls() {
  const active = Boolean(state.status?.active);
  const stopping = Boolean(state.status?.stopping);
  const unavailable = !state.online || !state.selected || state.actionPending;
  $("#start-button").disabled = unavailable || active || stopping;
  $("#start-button").hidden = active;
  $("#stop-button").hidden = !active;
  $("#stop-button").disabled = state.actionPending;
  $("#start-button span").textContent = state.demo
    ? state.status?.state === "locked"
      ? "Ulangi simulasi"
      : "Mulai simulasi"
    : state.status?.state === "locked"
      ? "Mulai lagi"
      : "Mulai instalock";
  $("#region-select").disabled =
    active || stopping || state.actionPending || !state.online;
  $("#refresh-button").disabled =
    active || stopping || state.refreshPending || !state.online;
  $$(".agent-select").forEach((button) => {
    button.disabled = active || stopping;
  });
}
function renderStatus(status) {
  state.status = status;
  const key = JSON.stringify(status);
  if (state.lastStatusKey === key) return;
  state.lastStatusKey = key;
  let title = TITLES[status.state] || "Status client";
  if (
    state.demo &&
    ["connecting", "locking", "locked"].includes(status.state)
  ) {
    title = {
      connecting: "Simulasi client…",
      locking: "Simulasi lock…",
      locked: "Simulasi selesai",
    }[status.state];
  }
  $("#status-title").textContent = title;
  $("#status-message").textContent = status.message;
  $("#status-box").dataset.state = status.state;
  $("#status-mode").textContent = state.demo ? "DEMO" : "LIVE";
  const step =
    { connecting: 0, waiting: 1, locking: 2, locked: 3 }[status.state] ?? -1;
  $$("[data-step]").forEach((node, index) => {
    node.classList.toggle("current", index === step);
    node.classList.toggle("complete", index < step);
  });
  const log = $("#activity-log");
  const entries = status.logs
    .slice(-8)
    .reverse()
    .map((entry) => {
      const item = element("li");
      item.dataset.level = entry.level;
      const date = new Date(entry.time);
      const time = element(
        "time",
        "",
        Number.isNaN(date.getTime())
          ? "—"
          : date.toLocaleTimeString("id-ID", {
              hour: "2-digit",
              minute: "2-digit",
            }),
      );
      if (!Number.isNaN(date.getTime())) {
        time.dateTime = entry.time;
        time.title = date.toLocaleString("id-ID");
      }
      item.append(time, element("span", "", entry.message));
      return item;
    });
  log.replaceChildren(...entries);
  $("#activity-count").textContent = state.demo ? "DEMO LOG" : "LIVE LOG";
  renderControls();
}
function setOnline(online) {
  state.online = online;
  $("#connection-banner").hidden = online;
  if (!online) {
    $("#mode-label").textContent = "TERPUTUS";
    $(".header-status").style.color = "var(--red)";
  } else {
    $("#mode-label").textContent = state.demo ? "DEMO MODE" : "LIVE MODE";
    $(".header-status").style.color = state.demo ? "#dfbd82" : "var(--green)";
  }
  renderControls();
}
function renderCatalog(catalog) {
  state.agents = catalog.agents;
  state.favorites = new Set(
    [...state.favorites].filter((id) => state.agents.some((a) => a.id === id)),
  );
  if (!state.agents.some((a) => a.id === state.selected))
    state.selected =
      state.agents.find((a) => a.id === "hush")?.id ||
      state.agents[0]?.id ||
      null;
  renderGrid();
  renderSelection();
  renderCounts();
  const date = new Date(`${catalog.updated_at}T00:00:00`);
  $("#catalog-date").textContent = Number.isNaN(date.getTime())
    ? "Katalog lokal"
    : `Diperbarui ${date.toLocaleDateString("id-ID", { day: "numeric", month: "short", year: "numeric" })}`;
  const newest = [...state.agents]
    .sort((a, b) => releaseKey(b).localeCompare(releaseKey(a)))
    .slice(0, 3);
  if (newest.length) {
    $(".update-copy>span:last-child").textContent =
      `${newest.map((a) => a.name).join(", ")} sudah masuk daftar.`;
    $(".update-agents").replaceChildren(
      ...newest.map((a) => element("span", "", a.name[0])),
    );
  }
}

async function bootstrap() {
  clearTimeout(state.pollTimer);
  $("#reconnect-button").disabled = true;
  try {
    const data = await api("/api/bootstrap", undefined, 6000);
    state.csrf = data.csrf;
    state.demo = data.demo;
    state.failures = 0;
    document.body.classList.toggle("demo-mode", state.demo);
    $("#status-mode").textContent = state.demo ? "DEMO" : "LIVE";
    $("#action-note span").textContent = state.demo
      ? "Mode demo · tidak ada lock ke akun sungguhan."
      : "Tanpa password. Semua lewat client lokal.";
    const validRegions = new Set(data.regions.map((r) => r.id));
    if (!validRegions.has($("#region-select").value))
      $("#region-select").value = "ap";
    if (data.status.agent_id) state.selected = data.status.agent_id;
    renderCatalog(data.catalog);
    setOnline(true);
    renderStatus(data.status);
    schedulePoll(100);
  } catch (error) {
    setOnline(false);
    $("#agent-grid").setAttribute("aria-busy", "false");
    $("#results-count").textContent =
      "Katalog belum tersedia. Sambungkan ulang server lokal.";
    $("#status-message").textContent = error.message;
  } finally {
    $("#reconnect-button").disabled = false;
  }
}
function schedulePoll(delay) {
  clearTimeout(state.pollTimer);
  state.pollTimer = setTimeout(
    poll,
    delay ?? (state.status?.active || state.status?.stopping ? 850 : 2500),
  );
}
async function poll() {
  if (state.polling || !state.online || document.hidden) return;
  state.polling = true;
  try {
    const status = await api("/api/status", undefined, 5000);
    state.failures = 0;
    renderStatus(status);
  } catch {
    state.failures += 1;
    if (state.failures >= 2) {
      setOnline(false);
      return;
    }
  } finally {
    state.polling = false;
    schedulePoll();
  }
}
async function runAction(action) {
  if (state.actionPending || !state.online) return;
  state.actionPending = true;
  renderControls();
  try {
    const status = await api(
      `/api/${action}`,
      action === "start"
        ? { agent_id: state.selected, region: $("#region-select").value }
        : {},
      6000,
    );
    renderStatus(status);
    if (action === "stop")
      toast(
        "Proses dihentikan. Lock yang sudah terkirim tidak dapat dibatalkan.",
      );
    schedulePoll(150);
  } catch (error) {
    toast(error.message, true);
    schedulePoll(100);
  } finally {
    state.actionPending = false;
    renderControls();
  }
}
async function refreshCatalog() {
  if (state.refreshPending || state.status?.active) return;
  state.refreshPending = true;
  $("#refresh-button").classList.add("loading");
  renderControls();
  try {
    const catalog = await api("/api/refresh", {}, 16000);
    renderCatalog(catalog);
    savePreferences();
    toast(catalog.message);
  } catch (error) {
    toast(error.message, true);
  } finally {
    state.refreshPending = false;
    $("#refresh-button").classList.remove("loading");
    renderControls();
  }
}
function resetFilters() {
  state.role = "all";
  state.search = "";
  state.favoritesOnly = false;
  $("#agent-search").value = "";
  renderGrid();
  renderControls();
}
function showGuide(tab = "live", credits = false) {
  selectGuideTab(tab);
  $("#credits-details").open = credits;
  if (!$("#guide-dialog").open) $("#guide-dialog").showModal();
  if (credits) $("#credits-details").scrollIntoView({ block: "nearest" });
}
function selectGuideTab(name) {
  $$("[data-guide]").forEach((button) => {
    const selected = button.dataset.guide === name;
    button.setAttribute("aria-selected", String(selected));
    button.tabIndex = selected ? 0 : -1;
  });
  $("#live-guide").hidden = name !== "live";
  $("#demo-guide").hidden = name !== "demo";
}

function initialize() {
  const saved = readStorage(STORAGE.favorites, []);
  if (Array.isArray(saved))
    state.favorites = new Set(
      saved.filter(
        (id) => typeof id === "string" && /^[a-z0-9-]{1,40}$/.test(id),
      ),
    );
  const preferences = readStorage(STORAGE.preferences, {});
  if (preferences && typeof preferences === "object") {
    if (typeof preferences.selected === "string")
      state.selected = preferences.selected;
    if (
      typeof preferences.region === "string" &&
      /^(ap|na|eu|kr|br|latam)$/.test(preferences.region)
    )
      $("#region-select").value = preferences.region;
  }
  $("#agent-search").addEventListener("input", (event) => {
    state.search = event.target.value;
    renderGrid();
    renderControls();
  });
  $("#agent-sort").addEventListener("change", (event) => {
    state.sort = event.target.value;
    renderGrid();
    renderControls();
  });
  $("#role-filters").addEventListener("click", (event) => {
    const button = event.target.closest("[data-role]");
    if (button) {
      state.role = button.dataset.role;
      renderGrid();
      renderControls();
    }
  });
  $("#favorites-filter").addEventListener("click", () => {
    state.favoritesOnly = !state.favoritesOnly;
    renderGrid();
    renderControls();
  });
  $("#selected-favorite").addEventListener("click", () => {
    if (state.selected) toggleFavorite(state.selected);
  });
  $("#reset-filters").addEventListener("click", resetFilters);
  $("#new-agents-button").addEventListener("click", () => {
    resetFilters();
    state.sort = "newest";
    $("#agent-sort").value = "newest";
    renderGrid();
    renderControls();
    $("#agents").scrollIntoView({
      behavior: matchMedia("(prefers-reduced-motion: reduce)").matches
        ? "instant"
        : "smooth",
      block: "start",
    });
  });
  $("#region-select").addEventListener("change", savePreferences);
  $("#start-button").addEventListener("click", () => runAction("start"));
  $("#stop-button").addEventListener("click", () => runAction("stop"));
  $("#refresh-button").addEventListener("click", refreshCatalog);
  $("#reconnect-button").addEventListener("click", bootstrap);
  $("#copy-uuid").addEventListener("click", async () => {
    const agent = state.agents.find((a) => a.id === state.selected);
    if (!agent) return;
    try {
      if (!navigator.clipboard?.writeText)
        throw new Error("clipboard unavailable");
      await navigator.clipboard.writeText(agent.uuid);
      toast(`UUID ${agent.name} disalin.`);
    } catch {
      const field = element("textarea");
      field.value = agent.uuid;
      field.setAttribute("readonly", "");
      field.style.cssText = "position:fixed;left:-9999px;top:0";
      document.body.append(field);
      field.select();
      let copied = false;
      try {
        copied = document.execCommand("copy");
      } catch {
        /* Manual prompt remains available. */
      }
      field.remove();
      if (copied) toast(`UUID ${agent.name} disalin.`);
      else
        window.prompt(
          "Clipboard dibatasi browser. Salin UUID lengkap ini:",
          agent.uuid,
        );
    }
  });
  $("#guide-button").addEventListener("click", () =>
    showGuide(state.demo ? "demo" : "live"),
  );
  $("#credits-button").addEventListener("click", () =>
    showGuide(state.demo ? "demo" : "live", true),
  );
  ["#close-guide", "#guide-done"].forEach((selector) =>
    $(selector).addEventListener("click", () => $("#guide-dialog").close()),
  );
  $("#guide-dialog").addEventListener("click", (event) => {
    if (event.target !== $("#guide-dialog")) return;
    const rect = event.target.getBoundingClientRect();
    if (
      event.clientX < rect.left ||
      event.clientX > rect.right ||
      event.clientY < rect.top ||
      event.clientY > rect.bottom
    )
      event.target.close();
  });
  $$("[data-guide]").forEach((button) => {
    button.addEventListener("click", () =>
      selectGuideTab(button.dataset.guide),
    );
    button.addEventListener("keydown", (event) => {
      if (["ArrowLeft", "ArrowRight", "Home", "End"].includes(event.key)) {
        event.preventDefault();
        const name =
          event.key === "Home"
            ? "live"
            : event.key === "End"
              ? "demo"
              : button.dataset.guide === "live"
                ? "demo"
                : "live";
        selectGuideTab(name);
        $(`[data-guide="${name}"]`).focus();
      }
    });
  });
  document.addEventListener("keydown", (event) => {
    if (
      $("#guide-dialog").open ||
      event.ctrlKey ||
      event.metaKey ||
      event.altKey
    )
      return;
    const editing = ["INPUT", "TEXTAREA", "SELECT"].includes(
      document.activeElement?.tagName,
    );
    if (event.key === "/" && !editing) {
      event.preventDefault();
      $("#agent-search").focus();
    }
    if (
      event.key === "Escape" &&
      document.activeElement === $("#agent-search")
    ) {
      state.search = "";
      $("#agent-search").value = "";
      renderGrid();
      renderControls();
    }
  });
  document.addEventListener("visibilitychange", () => {
    if (document.hidden) clearTimeout(state.pollTimer);
    else if (state.online) schedulePoll(50);
    else bootstrap();
  });
  window.addEventListener("online", () => {
    if (!state.online) bootstrap();
  });
  renderControls();
  bootstrap();
}

initialize();
