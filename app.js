/* ============================================================================
   HRS Server — Application logic
   ========================================================================= */

// ============================================================
// CONFIGURATION
// ============================================================
const CFG = window.HRS_CONFIG || {};
const CONFIG = {
  SUPABASE_URL: CFG.SUPABASE_URL,
  SUPABASE_ANON_KEY: CFG.SUPABASE_ANON_KEY,
  ADMIN_USERS_FUNCTION: CFG.ADMIN_USERS_FUNCTION || "admin-users",
  SEARCH_DEBOUNCE_MS: 250,
  PAGE_SIZE: 12,
  INACTIVITY_LIMIT_MS: 10 * 60 * 1000,
  INACTIVITY_WARNING_MS: 60 * 1000,
  ONLINE_THRESHOLD_MS: 5 * 60 * 1000,
  HEARTBEAT_INTERVAL_MS: 2 * 60 * 1000,
  REQUEST_TIMEOUT_MS: 15000,
  ALLOWED_LINK_HOSTS: [
    "drive.google.com", "docs.google.com", "mediafire.com", "www.mediafire.com",
    "wetransfer.com", "www.wetransfer.com", "t.me", "telegram.me",
  ],
};

// ============================================================
// SUPABASE INITIALIZATION
// ============================================================
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

// Wraps any promise so a hung network call can never freeze the UI forever.
function withTimeout(promise, ms = CONFIG.REQUEST_TIMEOUT_MS) {
  return Promise.race([
    promise,
    new Promise((_, reject) => setTimeout(() => reject(new Error("Request timed out")), ms)),
  ]);
}

// ============================================================
// STATE
// ============================================================
const state = {
  profile: null,
  categories: [],
  files: [],
  users: [],
  searchTerm: "",
  categoryId: "all",
  page: 0,
  totalFiles: 0,
  inactivityTimer: null,
  warningTimer: null,
  heartbeatTimer: null,
};

// ============================================================
// DOM
// ============================================================
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));
const el = {};
function toCamel(id) { return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }
function cacheDom() {
  [
    "view-checking", "view-login", "view-app",
    "login-form", "reset-form", "login-error", "login-submit",
    "f-email", "f-password", "r-email", "reset-message", "btn-forgot", "btn-back-to-login", "lockout-banner",
    "topbar", "sidebar", "btn-sidebar-toggle", "search-input", "btn-add-file-header",
    "btn-theme", "btn-user-menu", "user-dropdown", "topbar-avatar", "topbar-name", "topbar-role",
    "btn-change-password", "btn-logout",
    "screen-home", "screen-files", "screen-categories", "screen-users", "screen-permissions", "screen-activity", "screen-security",
    "welcome-title", "stat-grid", "recent-files-grid",
    "category-filter", "files-state", "files-grid", "files-pagination",
    "category-form", "new-category-name", "categories-list",
    "btn-new-user", "users-state", "users-grid",
    "bulk-access-form", "bulk-category", "bulk-user", "permissions-file-list",
    "activity-list", "security-list", "verify-username", "btn-generate-code", "verify-code-display",
    "modal-file", "file-form", "ff-id", "ff-name", "ff-category", "ff-source", "ff-type", "ff-size",
    "ff-description", "ff-url", "ff-active", "ff-permissions", "ff-delete", "ff-save", "file-form-error", "modal-file-title",
    "modal-user", "user-form", "uf-id", "uf-username", "uf-display-name", "uf-email", "uf-role", "uf-manager",
    "uf-active", "uf-reset-password", "uf-save", "user-form-error", "modal-user-title",
    "modal-confirm", "confirm-title", "confirm-body", "confirm-error", "confirm-ok",
    "inactivity-warning", "offline-banner", "toast",
  ].forEach((id) => { el[toCamel(id)] = document.getElementById(id); });
}

// ============================================================
// UTILITIES
// ============================================================
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function throttle(fn, ms) { let last = 0; return (...a) => { const now = Date.now(); if (now - last > ms) { last = now; fn(...a); } }; }
function escapeHtml(str) { const d = document.createElement("div"); d.textContent = String(str ?? ""); return d.innerHTML; }
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

function isSafeUrl(value) {
  try { const u = new URL(value); return u.protocol === "https:"; } catch { return false; }
}

function showToast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle("is-error", isError);
  el.toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

function setStateBlock(container, title, body) {
  container.hidden = false;
  container.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span>`;
}
function clearStateBlock(container) { container.hidden = true; container.innerHTML = ""; }

function timeAgo(iso) {
  if (!iso) return "never";
  const mins = Math.floor((Date.now() - new Date(iso).getTime()) / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}
function sourceLabel(src) {
  return { google_drive: "Google Drive", mediafire: "MediaFire", wetransfer: "WeTransfer", telegram: "Telegram", other: "Other" }[src] || src;
}

async function logActivity(eventType, metadata = null) {
  try { await supabase.rpc("log_activity", { p_event_type: eventType, p_metadata: metadata }); } catch { /* never block on logging */ }
}

// ============================================================
// MODALS — a small, centralized manager. No modal may permanently
// freeze the app: Escape and the backdrop always close it, even mid
// request; failed/timed-out requests always restore the button state.
// ============================================================
const ModalManager = (() => {
  // Keyed by raw element id ("modal-file", not "modalFile") so both the
  // camelCase `el` cache and plain `data-close="modal-file"` attributes
  // can resolve to the same node without a casing bug.
  let openStack = [];
  function node(id) { return document.getElementById(id); }

  function open(id) {
    const n = node(id);
    if (!n) return;
    n.hidden = false;
    document.body.style.overflow = "hidden";
    openStack.push(id);
  }

  function close(id) {
    const n = node(id);
    if (!n) return;
    n.hidden = true;
    openStack = openStack.filter((k) => k !== id);
    if (openStack.length === 0) {
      document.body.style.overflow = "";
      document.body.style.pointerEvents = "";
    }
  }

  function closeAll() { [...openStack].forEach(close); }

  function setBusy(buttonEl, busy) {
    buttonEl.disabled = busy;
    const label = buttonEl.querySelector(".btn-label");
    const spinner = buttonEl.querySelector(".btn-spinner");
    if (spinner) spinner.hidden = !busy;
    if (label) label.dataset.prevText ??= label.textContent;
  }

  // Runs an async action behind a button; guarantees the button/spinner
  // is restored and the modal unlocks even on error or timeout.
  async function runGuarded(buttonEl, errorEl, action, onSuccess) {
    if (errorEl) errorEl.hidden = true;
    setBusy(buttonEl, true);
    try {
      await withTimeout(action());
      onSuccess?.();
    } catch (err) {
      if (errorEl) {
        errorEl.textContent = err?.message === "Request timed out"
          ? "The request took too long. Please try again."
          : "Something went wrong. Please try again.";
        errorEl.hidden = false;
      } else {
        showToast("Something went wrong. Please try again.", true);
      }
    } finally {
      setBusy(buttonEl, false);
    }
  }

  document.addEventListener("keydown", (e) => { if (e.key === "Escape" && openStack.length) close(openStack[openStack.length - 1]); });
  document.addEventListener("click", (e) => {
    const backdrop = e.target.closest(".modal-backdrop");
    if (backdrop && e.target === backdrop) close(backdrop.id);
  });

  return { open, close, closeAll, runGuarded };
})();

let confirmCallback = null;
function confirmAction(title, body, onConfirm) {
  el.confirmTitle.textContent = title;
  el.confirmBody.textContent = body;
  el.confirmError.hidden = true;
  confirmCallback = onConfirm;
  ModalManager.open("modal-confirm");
}

// ============================================================
// THEME
// ============================================================
function initTheme() {
  const saved = localStorage.getItem("hrs-theme");
  const preferred = saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", preferred);
}
function toggleTheme() {
  const next = document.documentElement.getAttribute("data-theme") === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("hrs-theme", next);
}

// ============================================================
// AUTHENTICATION
// ============================================================
function setLoginBusy(busy) {
  el.loginSubmit.disabled = busy;
  el.loginSubmit.querySelector(".btn-label").textContent = busy ? "Logging in…" : "Log in";
  el.loginSubmit.querySelector(".btn-spinner").hidden = !busy;
}

async function handleLoginSubmit(e) {
  e.preventDefault();
  el.loginError.hidden = true;
  el.lockoutBanner.hidden = true;
  const email = el.fEmail.value.trim();
  const password = el.fPassword.value;

  setLoginBusy(true);
  try {
    const { data: locked } = await withTimeout(supabase.rpc("is_locked_out", { p_email: email }));
    if (locked) { el.lockoutBanner.hidden = false; return; }

    const { error } = await withTimeout(supabase.auth.signInWithPassword({ email, password }));
    await supabase.rpc("record_login_attempt", { p_email: email, p_success: !error }).catch(() => {});

    if (error) {
      el.loginError.textContent = "Invalid email or password.";
      el.loginError.hidden = false;
      return;
    }
    await loadProfile();
  } catch (err) {
    el.loginError.textContent = err?.message === "Request timed out"
      ? "The server took too long to respond. Please try again."
      : "Something went wrong. Please try again.";
    el.loginError.hidden = false;
  } finally {
    setLoginBusy(false);
  }
}

async function loadProfile() {
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) return showLogin();

  const { data: profile, error: profErr } = await supabase.from("profiles").select("*").eq("id", user.id).single();

  if (profErr || !profile || !profile.is_active) {
    await supabase.auth.signOut();
    el.loginError.textContent = profile && !profile.is_active ? "This account has been disabled." : "No profile found for this account.";
    el.loginError.hidden = false;
    return showLogin();
  }

  state.profile = profile;
  supabase.from("profiles").update({ last_login_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }).eq("id", user.id).then(() => {});
  loadDashboard();
}

async function handleLogout() {
  await logActivity("logout");
  stopInactivityWatch();
  clearInterval(state.heartbeatTimer);
  await supabase.auth.signOut();
  state.profile = null;
  ModalManager.closeAll();
  showLogin();
}

async function handleResetSubmit(e) {
  e.preventDefault();
  const email = el.rEmail.value.trim();
  el.resetMessage.hidden = false;
  el.resetMessage.textContent = "If that account exists, a reset link has been sent.";
  try { await withTimeout(supabase.auth.resetPasswordForEmail(email)); } catch { /* generic message either way */ }
}

// ============================================================
// SESSION MANAGEMENT
// ============================================================
function showChecking() { el.viewChecking.hidden = false; el.viewLogin.hidden = true; el.viewApp.hidden = true; }
function showLogin() {
  el.viewChecking.hidden = true; el.viewApp.hidden = true; el.viewLogin.hidden = false;
  el.loginForm.hidden = false; el.resetForm.hidden = true;
}
function showApp() {
  el.viewChecking.hidden = true; el.viewLogin.hidden = true; el.viewApp.hidden = false;
}

function loadDashboard() {
  const isAdmin = state.profile.role === "admin";
  $$(".admin-only").forEach((n) => { n.hidden = !isAdmin; });

  el.topbarName.textContent = state.profile.display_name;
  el.topbarRole.textContent = state.profile.role;
  el.topbarAvatar.textContent = state.profile.display_name.slice(0, 1).toUpperCase();
  if (state.profile.profile_photo_url) el.topbarAvatar.innerHTML = `<img src="${escapeHtml(state.profile.profile_photo_url)}" alt="" />`;
  el.welcomeTitle.textContent = `Welcome back, ${state.profile.display_name}`;

  showApp();
  switchView("home");
  refreshCategories();
  startInactivityWatch();
  startHeartbeat();
}

const throttledReset = throttle(() => resetInactivityTimer(), 1000);
function startInactivityWatch() {
  resetInactivityTimer();
  ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach((evt) => document.addEventListener(evt, throttledReset));
}
function stopInactivityWatch() {
  clearTimeout(state.inactivityTimer);
  clearTimeout(state.warningTimer);
  ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach((evt) => document.removeEventListener(evt, throttledReset));
}
function resetInactivityTimer() {
  el.inactivityWarning.hidden = true;
  clearTimeout(state.inactivityTimer);
  clearTimeout(state.warningTimer);
  state.warningTimer = setTimeout(() => { el.inactivityWarning.hidden = false; }, CONFIG.INACTIVITY_LIMIT_MS - CONFIG.INACTIVITY_WARNING_MS);
  state.inactivityTimer = setTimeout(async () => {
    await logActivity("session_timeout");
    await handleLogout();
    showToast("You were logged out due to inactivity.");
  }, CONFIG.INACTIVITY_LIMIT_MS);
}
function startHeartbeat() {
  clearInterval(state.heartbeatTimer);
  supabase.rpc("touch_last_seen").catch(() => {});
  state.heartbeatTimer = setInterval(() => supabase.rpc("touch_last_seen").catch(() => {}), CONFIG.HEARTBEAT_INTERVAL_MS);
}
// Best-effort only — real protection is session expiry + inactivity + RLS.
window.addEventListener("pagehide", () => { supabase.auth.signOut().catch(() => {}); });

// ============================================================
// NAV / VIEWS
// ============================================================
const SCREENS = ["home", "files", "categories", "users", "permissions", "activity", "security"];
function switchView(name) {
  SCREENS.forEach((s) => { el[`screen${cap(s)}`].hidden = s !== name; });
  $$(".side-link").forEach((b) => b.classList.toggle("is-active", b.dataset.view === name));
  el.sidebar.classList.remove("is-open");

  if (name === "home") refreshDashboard();
  if (name === "files") { state.page = 0; loadFiles(); }
  if (name === "categories") refreshCategoriesScreen();
  if (name === "users" && state.profile.role === "admin") loadUsers();
  if (name === "permissions" && state.profile.role === "admin") loadPermissionsScreen();
  if (name === "activity" && state.profile.role === "admin") loadActivity();
  if (name === "security" && state.profile.role === "admin") loadSecurity();
}

// ============================================================
// DASHBOARD (Home)
// ============================================================
function fileCardHtml(f) {
  // The file's own link travels with the card via data attributes, so
  // "Open" works the same way whether the card came from the paginated
  // Files screen or the dashboard's separately-fetched Recent files list
  // — no shared-state lookup required, and nothing goes stale between them.
  const safeLink = isSafeUrl(f.file_link) ? f.file_link : "";
  return `
    <article class="file-card" data-reveal>
      <div class="file-card-top">
        <div>
          <div class="file-name">${escapeHtml(f.file_name)}</div>
          ${f.categories ? `<div class="category-tag">${escapeHtml(f.categories.name)}</div>` : ""}
        </div>
        <span class="source-badge">${escapeHtml(sourceLabel(f.source_platform))}</span>
      </div>
      ${f.description ? `<p class="file-desc">${escapeHtml(f.description)}</p>` : ""}
      <div class="file-meta">${f.file_type ? escapeHtml(f.file_type) + " · " : ""}${f.file_size ? escapeHtml(f.file_size) : ""}</div>
      <div class="file-card-actions">
        ${state.profile.role === "admin" ? `<button class="btn-ghost btn-small" data-edit-file="${f.id}" type="button">Edit</button>` : ""}
        <button class="btn-secondary btn-small" data-open-file data-file-link="${escapeHtml(safeLink)}" data-file-id="${f.id}" type="button">Open</button>
      </div>
    </article>`;
}
function attachRevealObserver(container) {
  requestAnimationFrame(() => {
    const io = new IntersectionObserver((entries) => entries.forEach((e) => {
      if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); }
    }), { threshold: 0.1 });
    $$("[data-reveal]", container).forEach((n) => io.observe(n));
  });
}

async function refreshDashboard() {
  try {
    const [{ count: fileCount }, { data: recent }] = await Promise.all([
      supabase.from("files").select("id", { count: "exact", head: true }).eq("is_active", true),
      supabase.from("files").select("id, file_name, description, file_type, file_size, source_platform, categories(name)")
        .eq("is_active", true).order("created_at", { ascending: false }).limit(12),
    ]);

    const cards = [{ label: "Accessible files", value: fileCount ?? 0 }];
    if (state.profile.role === "admin") {
      const [{ count: userCount }, { data: seenRows }] = await Promise.all([
        supabase.from("profiles").select("id", { count: "exact", head: true }),
        supabase.from("profiles").select("last_seen_at"),
      ]);
      const online = (seenRows || []).filter((p) => p.last_seen_at && Date.now() - new Date(p.last_seen_at).getTime() < CONFIG.ONLINE_THRESHOLD_MS).length;
      cards.push({ label: "Total users", value: userCount ?? 0 }, { label: "Online now", value: online });
    }
    el.statGrid.innerHTML = cards.map((c) => `<div class="stat-card"><div class="stat-value">${c.value}</div><div class="stat-label">${escapeHtml(c.label)}</div></div>`).join("");

    el.recentFilesGrid.innerHTML = (recent || []).length ? recent.map(fileCardHtml).join("")
      : `<div class="state-block"><strong>No files yet</strong><span>Files you can access will appear here.</span></div>`;
    attachRevealObserver(el.recentFilesGrid);
  } catch {
    setStateBlock(el.filesState, "Connection problem", "Please check your internet connection.");
  }
}

// ============================================================
// CATEGORIES
// ============================================================
async function refreshCategories() {
  const { data, error } = await supabase.from("categories").select("id, name").eq("is_active", true).order("name");
  if (error) return;
  state.categories = data || [];
  el.categoryFilter.innerHTML = `<option value="all">All categories</option>` + state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  el.ffCategory.innerHTML = state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  el.bulkCategory.innerHTML = state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
}
function refreshCategoriesScreen() {
  el.categoryForm.hidden = state.profile.role !== "admin";
  el.categoriesList.innerHTML = state.categories.map((c) => `<li class="admin-row"><div class="admin-row-main"><div class="admin-row-name">${escapeHtml(c.name)}</div></div></li>`).join("") || `<li class="admin-row-meta">No categories yet.</li>`;
}
async function handleCategoryFormSubmit(e) {
  e.preventDefault();
  const name = el.newCategoryName.value.trim();
  if (!name) return;
  const { error } = await supabase.from("categories").insert({ name });
  if (error) return showToast(error.code === "23505" ? "That category already exists." : "Could not add category.", true);
  el.newCategoryName.value = "";
  showToast("Category added.");
  await refreshCategories();
  refreshCategoriesScreen();
}

// ============================================================
// FILES / SEARCH
// ============================================================
async function loadFiles() {
  clearStateBlock(el.filesState);
  setStateBlock(el.filesState, "Loading…", "Fetching your files.");

  const from = state.page * CONFIG.PAGE_SIZE;
  const to = from + CONFIG.PAGE_SIZE - 1;

  let query = supabase.from("files")
    .select("id, file_name, description, file_link, file_type, file_size, source_platform, is_active, file_category_id, categories:file_category_id(name)", { count: "exact" })
    .eq("is_active", true).order("file_name").range(from, to);

  if (state.categoryId !== "all") query = query.eq("file_category_id", state.categoryId);
  if (state.searchTerm) query = query.ilike("file_name", `%${state.searchTerm}%`);

  try {
    const { data, error, count } = await withTimeout(query);
    if (error) throw error;
    state.files = data || [];
    state.totalFiles = count || 0;
    renderFiles();
    renderPagination();
  } catch {
    setStateBlock(el.filesState, "Something went wrong", "Could not load files. Please try again.");
  }
}
function searchFiles(term) { state.searchTerm = term.trim(); state.page = 0; loadFiles(); }

function renderFiles() {
  if (state.files.length === 0) { setStateBlock(el.filesState, "No files found", "Try another search or category."); el.filesGrid.innerHTML = ""; return; }
  clearStateBlock(el.filesState);
  el.filesGrid.innerHTML = state.files.map(fileCardHtml).join("");
  attachRevealObserver(el.filesGrid);
}
function renderPagination() {
  const totalPages = Math.max(1, Math.ceil(state.totalFiles / CONFIG.PAGE_SIZE));
  if (totalPages <= 1) { el.filesPagination.innerHTML = ""; return; }
  let html = `<button ${state.page === 0 ? "disabled" : ""} data-page="${state.page - 1}">Prev</button>`;
  for (let i = 0; i < totalPages; i++) html += `<button class="${i === state.page ? "is-active" : ""}" data-page="${i}">${i + 1}</button>`;
  html += `<button ${state.page >= totalPages - 1 ? "disabled" : ""} data-page="${state.page + 1}">Next</button>`;
  el.filesPagination.innerHTML = html;
}
function handleOpenFile(link, fileId) {
  if (!link || !isSafeUrl(link)) return showToast("This link looks invalid and was blocked.", true);
  logActivity("file_opened", { file_id: fileId });
  window.open(link, "_blank", "noopener,noreferrer");
}

// Header "+ Add file" is gated: unauthenticated / non-admin users get a
// message instead of a silent no-op or a hidden write path.
function handleAddFileHeaderClick() {
  if (!state.profile) { showToast("Please sign in to continue."); return showLogin(); }
  if (state.profile.role !== "admin") return showToast("You do not have permission to add files.", true);
  openAddFileDialog();
}

// ============================================================
// ADMIN — file dialog
// ============================================================
function openAddFileDialog() { openFileModal(null); }
async function openFileModal(fileId) {
  el.fileFormError.hidden = true;
  el.modalFileTitle.textContent = fileId ? "Edit file link" : "Add file link";
  el.ffDelete.hidden = !fileId;

  const { data: profiles } = await supabase.from("profiles").select("id, display_name, role").order("role");
  let granted = new Set();

  if (fileId) {
    const [{ data: file }, { data: access }] = await Promise.all([
      supabase.from("files").select("*").eq("id", fileId).single(),
      supabase.from("file_access").select("user_id").eq("file_id", fileId),
    ]);
    if (file) {
      el.ffId.value = file.id;
      el.ffName.value = file.file_name;
      el.ffCategory.value = file.file_category_id || "";
      el.ffSource.value = file.source_platform;
      el.ffType.value = file.file_type || "";
      el.ffSize.value = file.file_size || "";
      el.ffDescription.value = file.description || "";
      el.ffUrl.value = file.file_link;
      el.ffActive.checked = file.is_active;
    }
    granted = new Set((access || []).map((a) => a.user_id));
  } else {
    el.fileForm.reset();
    el.ffId.value = "";
    el.ffActive.checked = true;
  }

  el.ffPermissions.innerHTML = (profiles || []).map((p) => `<label><input type="checkbox" value="${p.id}" ${granted.has(p.id) ? "checked" : ""} /> ${escapeHtml(p.display_name)} <span class="admin-row-meta">(${escapeHtml(p.role)})</span></label>`).join("");

  ModalManager.open("modal-file");
  el.ffName.focus();
}

function handleFileFormSubmit(e) {
  e.preventDefault();
  const url = el.ffUrl.value.trim();
  if (!isSafeUrl(url)) {
    el.fileFormError.textContent = "Please enter a valid https:// URL.";
    el.fileFormError.hidden = false;
    return;
  }
  ModalManager.runGuarded(el.ffSave, el.fileFormError, () => saveFile(url), () => {
    showToast("File saved.");
    ModalManager.close("modal-file");
    loadFiles();
  });
}

async function saveFile(url) {
  const payload = {
    file_name: el.ffName.value.trim(),
    file_category_id: el.ffCategory.value || null,
    source_platform: el.ffSource.value,
    file_type: el.ffType.value.trim() || null,
    file_size: el.ffSize.value.trim() || null,
    description: el.ffDescription.value.trim() || null,
    file_link: url,
    is_active: el.ffActive.checked,
  };
  const fileId = el.ffId.value || null;

  const { data, error } = fileId
    ? await supabase.from("files").update(payload).eq("id", fileId).select("id").single()
    : await supabase.from("files").insert({ ...payload, created_by: state.profile.id }).select("id").single();
  if (error) throw new Error("Could not save the file.");

  const savedId = data.id;
  const selectedUserIds = $$('#ff-permissions input[type="checkbox"]:checked').map((i) => i.value);
  await supabase.from("file_access").delete().eq("file_id", savedId);
  if (selectedUserIds.length > 0) {
    await supabase.from("file_access").insert(selectedUserIds.map((uid) => ({ file_id: savedId, user_id: uid, granted_by: state.profile.id })));
  }
  await logActivity(fileId ? "file_updated" : "file_created", { file_id: savedId });
}

function handleFileDeleteClick() {
  const fileId = el.ffId.value;
  if (!fileId) return;
  confirmAction("Delete file?", "This cannot be undone.", () =>
    ModalManager.runGuarded(el.confirmOk, el.confirmError, () => deleteFile(fileId), () => {
      showToast("File deleted.");
      ModalManager.close("modal-confirm");
      ModalManager.close("modal-file");
      loadFiles();
    }));
}
async function deleteFile(fileId) {
  const { error } = await supabase.from("files").delete().eq("id", fileId);
  if (error) throw new Error("Could not delete file.");
  await logActivity("file_deleted", { file_id: fileId });
}

// ============================================================
// USERS (admin)
// ============================================================
async function loadUsers() {
  setStateBlock(el.usersState, "Loading…", "Fetching users.");
  try {
    const { data, error } = await withTimeout(supabase.from("profiles").select("*").order("role"));
    if (error) throw error;
    clearStateBlock(el.usersState);
    state.users = data || [];
    renderUsers();
  } catch {
    setStateBlock(el.usersState, "Something went wrong", "Could not load users.");
  }
}
function renderUsers() {
  el.usersGrid.innerHTML = state.users.map((u) => {
    const isOnline = u.last_seen_at && Date.now() - new Date(u.last_seen_at).getTime() < CONFIG.ONLINE_THRESHOLD_MS;
    return `
      <div class="profile-card">
        <span class="avatar avatar-lg">${u.profile_photo_url ? `<img src="${escapeHtml(u.profile_photo_url)}" alt="" />` : escapeHtml(u.display_name.slice(0, 1).toUpperCase())}</span>
        <div class="profile-card-main">
          <div class="profile-card-name">${escapeHtml(u.display_name)}</div>
          <div class="profile-card-username">@${escapeHtml(u.username)} · ${escapeHtml(u.role)}</div>
          <div class="profile-card-meta">
            <span><span class="online-dot ${isOnline ? "is-online" : ""}"></span>${isOnline ? "Online" : `Last seen ${timeAgo(u.last_seen_at)}`}</span>
            <span class="status-dot ${u.is_active ? "is-active" : ""}" title="${u.is_active ? "Active" : "Disabled"}"></span>
          </div>
          <div class="profile-card-actions"><button class="btn-ghost btn-small" data-edit-user="${u.id}" type="button">Edit</button></div>
        </div>
      </div>`;
  }).join("") || `<div class="state-block"><strong>No users yet</strong><span>Add your first user.</span></div>`;
}

function openUserModal(userId) {
  el.userFormError.hidden = true;
  el.modalUserTitle.textContent = userId ? "Edit user" : "Add user";
  el.ufResetPassword.hidden = !userId;

  el.ufManager.innerHTML = `<option value="">None</option>` + state.users.filter((u) => u.id !== userId).map((u) => `<option value="${u.id}">${escapeHtml(u.display_name)}</option>`).join("");

  if (userId) {
    const u = state.users.find((x) => x.id === userId);
    el.ufId.value = u.id;
    el.ufUsername.value = u.username;
    el.ufDisplayName.value = u.display_name;
    el.ufEmail.value = u.email;
    el.ufEmail.disabled = true;
    el.ufRole.value = u.role;
    el.ufManager.value = u.manager_id || "";
    el.ufActive.checked = u.is_active;
  } else {
    el.userForm.reset();
    el.ufId.value = "";
    el.ufEmail.disabled = false;
    el.ufActive.checked = true;
  }
  ModalManager.open("modal-user");
  el.ufUsername.focus();
}

function handleUserFormSubmit(e) {
  e.preventDefault();
  ModalManager.runGuarded(el.ufSave, el.userFormError, saveUser, () => {
    showToast("User saved.");
    ModalManager.close("modal-user");
    loadUsers();
  });
}
async function saveUser() {
  const userId = el.ufId.value || null;
  const { data: { session } } = await supabase.auth.getSession();
  const fnUrl = `${CONFIG.SUPABASE_URL}/functions/v1/${CONFIG.ADMIN_USERS_FUNCTION}`;
  const authHeaders = { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` };

  if (!userId) {
    const res = await fetch(fnUrl, {
      method: "POST", headers: authHeaders,
      body: JSON.stringify({
        action: "create", email: el.ufEmail.value.trim(), username: el.ufUsername.value.trim(),
        display_name: el.ufDisplayName.value.trim(), role: el.ufRole.value, manager_id: el.ufManager.value || null,
      }),
    });
    if (!res.ok) throw new Error("Could not create user.");
  } else {
    const { error } = await supabase.from("profiles").update({
      username: el.ufUsername.value.trim(), display_name: el.ufDisplayName.value.trim(),
      role: el.ufRole.value, manager_id: el.ufManager.value || null, is_active: el.ufActive.checked,
    }).eq("id", userId);
    if (error) throw new Error("Could not update user.");
    await logActivity("user_updated", { target_user_id: userId });
  }
}
async function handleUserResetPassword() {
  const userId = el.ufId.value;
  if (!userId) return;
  try {
    const { data: { session } } = await supabase.auth.getSession();
    const fnUrl = `${CONFIG.SUPABASE_URL}/functions/v1/${CONFIG.ADMIN_USERS_FUNCTION}`;
    const res = await withTimeout(fetch(fnUrl, {
      method: "POST", headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action: "reset_password", user_id: userId }),
    }));
    if (!res.ok) throw new Error();
    showToast("Password reset email sent.");
  } catch { showToast("Could not send password reset.", true); }
}

// ============================================================
// PERMISSIONS (admin)
// ============================================================
async function loadPermissionsScreen() {
  el.bulkUser.innerHTML = (state.users.length ? state.users : (await supabase.from("profiles").select("id, display_name")).data || [])
    .map((u) => `<option value="${u.id}">${escapeHtml(u.display_name)}</option>`).join("");

  const { data: files } = await supabase.from("files").select("id, file_name, categories:file_category_id(name)").order("file_name");
  el.permissionsFileList.innerHTML = (files || []).map((f) => `
    <div class="admin-row">
      <div class="admin-row-main"><div class="admin-row-name">${escapeHtml(f.file_name)}</div><div class="admin-row-meta">${escapeHtml(f.categories?.name || "Uncategorized")}</div></div>
      <button class="btn-ghost btn-small" data-edit-file="${f.id}" type="button">Manage access</button>
    </div>`).join("") || `<div class="admin-row-meta">No files yet.</div>`;
}
async function handleBulkAccessSubmit(e) {
  e.preventDefault();
  const mode = e.submitter?.dataset.mode || "grant";
  await updatePermissions(mode, el.bulkCategory.value, el.bulkUser.value);
}
async function updatePermissions(mode, categoryId, userId) {
  const fn = mode === "grant" ? "admin_grant_category_access" : "admin_revoke_category_access";
  const { error } = await supabase.rpc(fn, { p_category_id: categoryId, p_user_id: userId });
  if (error) return showToast("Could not update access.", true);
  showToast(mode === "grant" ? "Access granted." : "Access revoked.");
}

// ============================================================
// ACTIVITY / SECURITY (admin)
// ============================================================
async function loadActivity() {
  const { data, error } = await supabase.from("activity_log").select("*").order("created_at", { ascending: false }).limit(50);
  el.activityList.innerHTML = error ? `<li class="admin-row-meta">Could not load.</li>`
    : (data || []).map((a) => `<li class="admin-row"><div class="admin-row-main"><div class="admin-row-name">${escapeHtml(a.event_type.replace(/_/g, " "))}</div><div class="admin-row-meta">${timeAgo(a.created_at)}</div></div></li>`).join("") || `<li class="admin-row-meta">No activity yet.</li>`;
}
async function loadSecurity() {
  populateVerifyUsernames();
  const { data, error } = await supabase.from("security_events").select("*").order("created_at", { ascending: false }).limit(50);
  el.securityList.innerHTML = error ? `<li class="admin-row-meta">Could not load.</li>`
    : (data || []).map((s) => `<li class="admin-row"><span class="status-dot ${s.severity === "critical" ? "is-active" : ""}"></span><div class="admin-row-main"><div class="admin-row-name">${escapeHtml(s.event_type.replace(/_/g, " "))}</div><div class="admin-row-meta">${timeAgo(s.created_at)}${s.message ? " · " + escapeHtml(s.message) : ""}</div></div></li>`).join("") || `<li class="admin-row-meta">No security events.</li>`;
}

// ---- Identity verification code (bootstrap-only, never used for login) ----
// Format: <username>@<12-hour zero-padded hour><zero-padded minute>, using
// the admin's own browser timezone/clock. Midnight and noon both read "12".
// Purely a client-side, out-of-band confirmation aid with a short mental
// validity window (treat it as stale after a few minutes) — it is never
// transmitted, stored, or accepted anywhere as a credential.
function computeVerificationCode(username) {
  const now = new Date();
  let hour = now.getHours() % 12;
  if (hour === 0) hour = 12;
  const hh = String(hour).padStart(2, "0");
  const mm = String(now.getMinutes()).padStart(2, "0");
  return `${username}@${hh}${mm}`;
}
function populateVerifyUsernames() {
  el.verifyUsername.innerHTML = state.users.length
    ? state.users.map((u) => `<option value="${escapeHtml(u.username)}">${escapeHtml(u.display_name)}</option>`).join("")
    : `<option value="${escapeHtml(state.profile.username)}">${escapeHtml(state.profile.display_name)}</option>`;
}
function handleGenerateCode() {
  const username = el.verifyUsername.value || state.profile.username;
  const code = computeVerificationCode(username);
  el.verifyCodeDisplay.hidden = false;
  el.verifyCodeDisplay.innerHTML = `<span>${escapeHtml(code)}</span><small>valid for a few minutes, local clock only</small>`;
}

// ============================================================
// KEYBOARD SHORTCUT
// Browsers cannot reliably intercept the OS-level Win+Alt+H, so
// Ctrl+Alt+H is wired as the guaranteed-to-work fallback.
// ============================================================
function initKeyboardShortcut() {
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "h" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      window.open("https://hxrish-14.github.io/Harish-Portfolio/", "_blank", "noopener,noreferrer");
    }
  });
}

// ============================================================
// ERROR HANDLING
// ============================================================
window.addEventListener("unhandledrejection", () => showToast("Something went wrong.", true));
window.addEventListener("online", () => { el.offlineBanner.hidden = true; });
window.addEventListener("offline", () => { el.offlineBanner.hidden = false; });

// ============================================================
// RESPONSIVE UI (small helpers)
// ============================================================
function toggleSidebar() { el.sidebar.classList.toggle("is-open"); }

// ============================================================
// EVENTS
// ============================================================
function wireEvents() {
  el.loginForm.addEventListener("submit", handleLoginSubmit);
  el.resetForm.addEventListener("submit", handleResetSubmit);
  el.btnForgot.addEventListener("click", () => { el.loginForm.hidden = true; el.resetForm.hidden = false; });
  el.btnBackToLogin.addEventListener("click", () => { el.resetForm.hidden = true; el.loginForm.hidden = false; });
  $$(".toggle-visibility").forEach((btn) => btn.addEventListener("click", () => {
    const input = btn.previousElementSibling;
    const isText = input.type === "text";
    input.type = isText ? "password" : "text";
    btn.setAttribute("aria-pressed", String(!isText));
  }));

  el.btnTheme.addEventListener("click", toggleTheme);
  el.btnSidebarToggle.addEventListener("click", toggleSidebar);
  el.btnUserMenu.addEventListener("click", () => { el.userDropdown.hidden = !el.userDropdown.hidden; });
  document.addEventListener("click", (e) => { if (!el.userDropdown.hidden && !e.target.closest(".user-menu")) el.userDropdown.hidden = true; });
  el.btnLogout.addEventListener("click", handleLogout);
  el.btnChangePassword.addEventListener("click", async () => {
    try { await withTimeout(supabase.auth.resetPasswordForEmail(state.profile.email)); showToast("Password reset email sent."); }
    catch { showToast("Could not send reset email.", true); }
  });
  el.btnAddFileHeader.addEventListener("click", handleAddFileHeaderClick);

  $$(".side-link").forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));

  el.searchInput.addEventListener("input", debounce((e) => { switchView("files"); searchFiles(e.target.value); }, CONFIG.SEARCH_DEBOUNCE_MS));
  el.categoryFilter.addEventListener("change", (e) => { state.categoryId = e.target.value; state.page = 0; loadFiles(); });
  el.filesPagination.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-page]");
    if (!btn || btn.disabled) return;
    state.page = Number(btn.dataset.page);
    loadFiles();
  });
  [el.filesGrid, el.recentFilesGrid].forEach((grid) => grid.addEventListener("click", (e) => {
    const openBtn = e.target.closest("[data-open-file]");
    const editBtn = e.target.closest("[data-edit-file]");
    if (openBtn) handleOpenFile(openBtn.dataset.fileLink, openBtn.dataset.fileId);
    if (editBtn) openFileModal(editBtn.dataset.editFile);
  }));

  el.fileForm.addEventListener("submit", handleFileFormSubmit);
  el.ffDelete.addEventListener("click", handleFileDeleteClick);
  el.categoryForm.addEventListener("submit", handleCategoryFormSubmit);

  el.btnNewUser.addEventListener("click", () => openUserModal(null));
  el.usersGrid.addEventListener("click", (e) => { const btn = e.target.closest("[data-edit-user]"); if (btn) openUserModal(btn.dataset.editUser); });
  el.userForm.addEventListener("submit", handleUserFormSubmit);
  el.ufResetPassword.addEventListener("click", handleUserResetPassword);

  el.bulkAccessForm.addEventListener("submit", handleBulkAccessSubmit);
  el.permissionsFileList.addEventListener("click", (e) => { const btn = e.target.closest("[data-edit-file]"); if (btn) openFileModal(btn.dataset.editFile); });
  el.btnGenerateCode.addEventListener("click", handleGenerateCode);

  $$("[data-close]").forEach((btn) => btn.addEventListener("click", () => ModalManager.close(btn.dataset.close)));
  el.confirmOk.addEventListener("click", () => { confirmCallback?.(); });
}

// ============================================================
// INIT
// ============================================================
async function initializeApp() {
  cacheDom();
  initTheme();
  wireEvents();
  initKeyboardShortcut();
  showChecking();
  await initializeAuth();
}
async function initializeAuth() {
  try {
    const { data: { session } } = await withTimeout(supabase.auth.getSession(), 10000);
    if (session) await loadProfile(); else showLogin();
  } catch {
    showLogin();
  }
}

initializeApp();
