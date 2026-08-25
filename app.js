/* ============================================================================
   HRS Server — Application logic
   Sections: CONFIG, SUPABASE, STATE, DOM, UTILITIES, THEME, AUTH, SESSION,
   SECURITY, DATABASE, FILES, SEARCH, USERS, PERMISSIONS, ADMIN, ACTIVITY,
   DIALOGS, KEYBOARD, ERROR HANDLING, INIT.
   Only the Supabase URL and publishable/anon key belong here — never a
   service-role key, database password, or any other secret.
   ========================================================================= */

/* ---------------------------------------------------------------------- */
/* CONFIG                                                                   */
/* ---------------------------------------------------------------------- */
const CONFIG = {
  SUPABASE_URL: "https://trgjjtvikddcczkdlzww.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_UCr9X8sIda-cGLqzKOqpiA_2l4pEf1H",
  ADMIN_USERS_FUNCTION: "admin-users",
  SEARCH_DEBOUNCE_MS: 250,
  PAGE_SIZE: 20,
  INACTIVITY_LIMIT_MS: 10 * 60 * 1000,
  INACTIVITY_WARNING_MS: 60 * 1000, // warn 60s before logout
  ONLINE_THRESHOLD_MS: 5 * 60 * 1000,
  HEARTBEAT_INTERVAL_MS: 2 * 60 * 1000,
  ALLOWED_LINK_HOSTS: [
    "drive.google.com", "docs.google.com", "mediafire.com", "www.mediafire.com",
    "wetransfer.com", "www.wetransfer.com", "t.me", "telegram.me",
  ],
};

/* ---------------------------------------------------------------------- */
/* SUPABASE                                                                 */
/* ---------------------------------------------------------------------- */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

/* ---------------------------------------------------------------------- */
/* STATE                                                                    */
/* ---------------------------------------------------------------------- */
const state = {
  profile: null,
  categories: [],
  files: [],
  users: [],
  searchTerm: "",
  categoryId: "all",
  page: 0,
  totalFiles: 0,
  editingFileId: null,
  editingUserId: null,
  inactivityTimer: null,
  warningTimer: null,
  heartbeatTimer: null,
};

/* ---------------------------------------------------------------------- */
/* DOM shortcuts                                                            */
/* ---------------------------------------------------------------------- */
const $ = (s, r = document) => r.querySelector(s);
const $$ = (s, r = document) => Array.from(r.querySelectorAll(s));

const el = {};
function cacheDom() {
  [
    "view-login", "view-app", "login-form", "reset-form", "login-error", "login-submit",
    "f-email", "f-password", "r-email", "reset-message", "btn-forgot", "btn-back-to-login",
    "lockout-banner", "topbar", "sidebar", "btn-sidebar-toggle", "search-input",
    "btn-theme", "theme-icon", "btn-user-menu", "user-dropdown", "topbar-avatar",
    "topbar-name", "topbar-role", "btn-change-password", "btn-logout",
    "screen-dashboard", "screen-files", "screen-categories", "screen-users",
    "screen-permissions", "screen-activity", "screen-security",
    "welcome-title", "stat-grid", "recent-files-grid",
    "category-filter", "btn-new-file", "files-state", "files-grid", "files-pagination",
    "category-form", "new-category-name", "categories-list",
    "btn-new-user", "users-state", "users-grid",
    "bulk-access-form", "bulk-category", "bulk-user", "permissions-file-list",
    "activity-list", "security-list",
    "modal-file", "file-form", "ff-id", "ff-name", "ff-category", "ff-source", "ff-type",
    "ff-size", "ff-description", "ff-url", "ff-active", "ff-permissions", "ff-delete",
    "file-form-error", "modal-file-title",
    "modal-user", "user-form", "uf-id", "uf-username", "uf-display-name", "uf-email",
    "uf-role", "uf-manager", "uf-active", "uf-reset-password", "user-form-error", "modal-user-title",
    "modal-confirm", "confirm-title", "confirm-body", "confirm-ok",
    "inactivity-warning", "offline-banner", "toast",
  ].forEach((id) => { el[toCamel(id)] = document.getElementById(id); });
}
function toCamel(id) { return id.replace(/-([a-z])/g, (_, c) => c.toUpperCase()); }

/* ---------------------------------------------------------------------- */
/* UTILITIES                                                                */
/* ---------------------------------------------------------------------- */
function debounce(fn, ms) { let t; return (...a) => { clearTimeout(t); t = setTimeout(() => fn(...a), ms); }; }
function throttle(fn, ms) { let last = 0; return (...a) => { const now = Date.now(); if (now - last > ms) { last = now; fn(...a); } }; }

function escapeHtml(str) { const d = document.createElement("div"); d.textContent = String(str ?? ""); return d.innerHTML; }

function isSafeUrl(value, enforceAllowlist = false) {
  try {
    const u = new URL(value);
    if (u.protocol !== "https:") return false;
    if (enforceAllowlist) {
      return CONFIG.ALLOWED_LINK_HOSTS.some((h) => u.hostname === h || u.hostname.endsWith(`.${h}`));
    }
    return true;
  } catch { return false; }
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
  const diff = Date.now() - new Date(iso).getTime();
  const mins = Math.floor(diff / 60000);
  if (mins < 1) return "just now";
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.floor(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  return `${Math.floor(hrs / 24)}d ago`;
}

function sourceLabel(src) {
  return { google_drive: "Google Drive", mediafire: "MediaFire", wetransfer: "WeTransfer", telegram: "Telegram", other: "Other" }[src] || src;
}

async function logActivity(eventType, severity = "info", metadata = null) {
  try { await supabase.rpc("log_activity", { p_event_type: eventType, p_severity: severity, p_metadata: metadata }); }
  catch { /* logging must never block the primary action */ }
}

/* ---------------------------------------------------------------------- */
/* THEME                                                                    */
/* ---------------------------------------------------------------------- */
function initTheme() {
  const saved = localStorage.getItem("hrs-theme");
  const preferred = saved || (window.matchMedia("(prefers-color-scheme: light)").matches ? "light" : "dark");
  document.documentElement.setAttribute("data-theme", preferred);
}
function toggleTheme() {
  const current = document.documentElement.getAttribute("data-theme");
  const next = current === "light" ? "dark" : "light";
  document.documentElement.setAttribute("data-theme", next);
  localStorage.setItem("hrs-theme", next);
}

/* ---------------------------------------------------------------------- */
/* AUTH                                                                     */
/* ---------------------------------------------------------------------- */
async function handleLoginSubmit(e) {
  e.preventDefault();
  el.loginError.hidden = true;
  el.lockoutBanner.hidden = true;
  const email = el.fEmail.value.trim();
  const password = el.fPassword.value;

  const { data: locked } = await supabase.rpc("is_locked_out", { p_email: email });
  if (locked) {
    el.lockoutBanner.hidden = false;
    return;
  }

  setLoginBusy(true);
  try {
    const { error } = await supabase.auth.signInWithPassword({ email, password });
    await supabase.rpc("record_login_attempt", { p_email: email, p_success: !error });

    if (error) {
      el.loginError.textContent = "Invalid email or password.";
      el.loginError.hidden = false;
      return;
    }
    await loadProfileAndEnterApp();
  } catch {
    el.loginError.textContent = "Something went wrong. Please try again.";
    el.loginError.hidden = false;
  } finally {
    setLoginBusy(false);
  }
}

function setLoginBusy(busy) {
  el.loginSubmit.disabled = busy;
  el.loginSubmit.querySelector(".btn-label").textContent = busy ? "Logging in…" : "Log in";
  el.loginSubmit.querySelector(".btn-spinner").hidden = !busy;
}

async function loadProfileAndEnterApp() {
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) return showLogin();

  const { data: profile, error: profErr } = await supabase
    .from("profiles").select("*").eq("id", user.id).single();

  if (profErr || !profile || !profile.is_active) {
    await supabase.auth.signOut();
    el.loginError.textContent = profile && !profile.is_active
      ? "This account has been disabled." : "No profile found for this account.";
    el.loginError.hidden = false;
    return showLogin();
  }

  state.profile = profile;
  await supabase.from("profiles").update({ last_login_at: new Date().toISOString(), last_seen_at: new Date().toISOString() }).eq("id", user.id);
  showApp();
}

async function handleLogout() {
  await logActivity("logout");
  stopInactivityWatch();
  clearInterval(state.heartbeatTimer);
  await supabase.auth.signOut();
  state.profile = null;
  showLogin();
}

function showLogin() {
  el.viewApp.hidden = true;
  el.viewLogin.hidden = false;
  el.loginForm.hidden = false;
  el.resetForm.hidden = true;
}

function showApp() {
  el.viewLogin.hidden = true;
  el.viewApp.hidden = false;

  const isAdmin = state.profile.role === "admin";
  $$(".admin-only").forEach((n) => { n.hidden = !isAdmin; });

  el.topbarName.textContent = state.profile.display_name;
  el.topbarRole.textContent = state.profile.role;
  el.topbarAvatar.textContent = state.profile.display_name.slice(0, 1).toUpperCase();
  if (state.profile.profile_photo_url) el.topbarAvatar.innerHTML = `<img src="${escapeHtml(state.profile.profile_photo_url)}" alt="" />`;
  el.welcomeTitle.textContent = `Welcome, ${state.profile.display_name}`;

  switchView("dashboard");
  refreshCategories();
  startInactivityWatch();
  startHeartbeat();
}

/* ---------------------------------------------------------------------- */
/* PASSWORD RESET                                                          */
/* ---------------------------------------------------------------------- */
async function handleResetSubmit(e) {
  e.preventDefault();
  const email = el.rEmail.value.trim();
  el.resetMessage.hidden = false;
  el.resetMessage.textContent = "If that account exists, a reset link has been sent.";
  try { await supabase.auth.resetPasswordForEmail(email); } catch { /* generic message regardless */ }
}

/* ---------------------------------------------------------------------- */
/* SESSION / INACTIVITY                                                    */
/* ---------------------------------------------------------------------- */
function startInactivityWatch() {
  resetInactivityTimer();
  ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach((evt) =>
    document.addEventListener(evt, throttledReset));
}
function stopInactivityWatch() {
  clearTimeout(state.inactivityTimer);
  clearTimeout(state.warningTimer);
  ["mousemove", "keydown", "click", "scroll", "touchstart"].forEach((evt) =>
    document.removeEventListener(evt, throttledReset));
}
const throttledReset = throttle(resetInactivityTimer, 1000);

function resetInactivityTimer() {
  el.inactivityWarning.hidden = true;
  clearTimeout(state.inactivityTimer);
  clearTimeout(state.warningTimer);
  state.warningTimer = setTimeout(() => { el.inactivityWarning.hidden = false; },
    CONFIG.INACTIVITY_LIMIT_MS - CONFIG.INACTIVITY_WARNING_MS);
  state.inactivityTimer = setTimeout(async () => {
    await logActivity("session_timeout", "warning");
    handleLogout();
    showToast("You were logged out due to inactivity.");
  }, CONFIG.INACTIVITY_LIMIT_MS);
}

function startHeartbeat() {
  clearInterval(state.heartbeatTimer);
  supabase.rpc("touch_last_seen").catch(() => {});
  state.heartbeatTimer = setInterval(() => supabase.rpc("touch_last_seen").catch(() => {}), CONFIG.HEARTBEAT_INTERVAL_MS);
}

// Best-effort cleanup on tab close. Real security relies on session
// expiration + RLS, not this — browsers do not guarantee async work here.
window.addEventListener("pagehide", () => { supabase.auth.signOut().catch(() => {}); });

/* ---------------------------------------------------------------------- */
/* NAV / VIEWS                                                              */
/* ---------------------------------------------------------------------- */
const SCREENS = ["dashboard", "files", "categories", "users", "permissions", "activity", "security"];
function switchView(name) {
  SCREENS.forEach((s) => { el[`screen${cap(s)}`].hidden = s !== name; });
  $$(".side-link").forEach((b) => b.classList.toggle("is-active", b.dataset.view === name));
  el.sidebar.classList.remove("is-open");

  if (name === "dashboard") refreshDashboard();
  if (name === "files") refreshFiles();
  if (name === "categories") refreshCategoriesScreen();
  if (name === "users" && state.profile.role === "admin") refreshUsers();
  if (name === "permissions" && state.profile.role === "admin") refreshPermissionsScreen();
  if (name === "activity" && state.profile.role === "admin") refreshActivity("info,warning,critical", "activityList");
  if (name === "security" && state.profile.role === "admin") refreshActivity("warning,critical", "securityList");
}
function cap(s) { return s.charAt(0).toUpperCase() + s.slice(1); }

/* ---------------------------------------------------------------------- */
/* DASHBOARD                                                                */
/* ---------------------------------------------------------------------- */
async function refreshDashboard() {
  const [{ count: fileCount }, { count: userCount }, { data: recent }] = await Promise.all([
    supabase.from("files").select("id", { count: "exact", head: true }).eq("is_active", true),
    state.profile.role === "admin"
      ? supabase.from("profiles").select("id", { count: "exact", head: true })
      : Promise.resolve({ count: null }),
    supabase.from("files").select("id, file_name, description, source_platform, category_id, categories(name)")
      .eq("is_active", true).order("created_at", { ascending: false }).limit(6),
  ]);

  const onlineCount = state.profile.role === "admin"
    ? (await supabase.from("profiles").select("last_seen_at")).data
        ?.filter((p) => p.last_seen_at && Date.now() - new Date(p.last_seen_at).getTime() < CONFIG.ONLINE_THRESHOLD_MS).length ?? 0
    : null;

  const cards = [{ label: "Accessible files", value: fileCount ?? 0 }];
  if (state.profile.role === "admin") {
    cards.push({ label: "Total users", value: userCount ?? 0 }, { label: "Online now", value: onlineCount ?? 0 });
  }
  el.statGrid.innerHTML = cards.map((c) => `
    <div class="stat-card"><div class="stat-value">${c.value}</div><div class="stat-label">${escapeHtml(c.label)}</div></div>
  `).join("");

  el.recentFilesGrid.innerHTML = (recent || []).length
    ? recent.map(fileCardHtml).join("")
    : `<div class="state-block"><strong>No files yet</strong><span>Files you can access will appear here.</span></div>`;
  attachRevealObserver(el.recentFilesGrid);
}

/* ---------------------------------------------------------------------- */
/* DATABASE — categories                                                    */
/* ---------------------------------------------------------------------- */
async function refreshCategories() {
  const { data, error } = await supabase.from("categories").select("id, name").eq("is_active", true).order("name");
  if (error) return;
  state.categories = data || [];
  el.categoryFilter.innerHTML = `<option value="all">All categories</option>` +
    state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  el.ffCategory.innerHTML = state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
  el.bulkCategory.innerHTML = state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
}

async function refreshCategoriesScreen() {
  el.categoryForm.hidden = state.profile.role !== "admin";
  el.categoriesList.innerHTML = state.categories.map((c) => `
    <li class="admin-row"><div class="admin-row-main"><div class="admin-row-name">${escapeHtml(c.name)}</div></div></li>
  `).join("") || `<li class="admin-row-meta">No categories yet.</li>`;
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

/* ---------------------------------------------------------------------- */
/* FILES                                                                    */
/* ---------------------------------------------------------------------- */
function fileCardHtml(f) {
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
        <button class="btn-secondary btn-small" data-open-file="${f.id}" type="button">Open</button>
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

async function refreshFiles() {
  clearStateBlock(el.filesState);
  setStateBlock(el.filesState, "Loading…", "Fetching your files.");
  el.btnNewFile.hidden = state.profile.role !== "admin";

  const from = state.page * CONFIG.PAGE_SIZE;
  const to = from + CONFIG.PAGE_SIZE - 1;

  let query = supabase
    .from("files")
    .select("id, file_name, description, file_link, file_type, file_size, source_platform, is_active, category_id, categories(name)", { count: "exact" })
    .eq("is_active", true)
    .order("file_name")
    .range(from, to);

  if (state.categoryId !== "all") query = query.eq("category_id", state.categoryId);
  if (state.searchTerm) query = query.ilike("file_name", `%${state.searchTerm}%`);

  const { data, error, count } = await query;
  if (error) return setStateBlock(el.filesState, "Something went wrong", "Could not load files. Please try again.");

  state.files = data || [];
  state.totalFiles = count || 0;
  renderFiles();
  renderPagination();
}

function renderFiles() {
  if (state.files.length === 0) {
    setStateBlock(el.filesState, "No files found", "Try another search or category.");
    el.filesGrid.innerHTML = "";
    return;
  }
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

function handleOpenFile(fileId) {
  const file = state.files.find((f) => f.id === fileId);
  if (!file || !isSafeUrl(file.file_link)) return showToast("This link looks invalid and was blocked.", true);
  logActivity("file_opened", "info", { file_id: file.id });
  window.open(file.file_link, "_blank", "noopener,noreferrer");
}

/* ---------------------------------------------------------------------- */
/* ADMIN — file dialog                                                      */
/* ---------------------------------------------------------------------- */
async function openFileModal(fileId = null) {
  state.editingFileId = fileId;
  el.fileFormError.hidden = true;
  el.modalFileTitle.textContent = fileId ? "Edit file" : "Add file";
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
      el.ffCategory.value = file.category_id || "";
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

  el.ffPermissions.innerHTML = (profiles || []).map((p) => `
    <label><input type="checkbox" value="${p.id}" ${granted.has(p.id) ? "checked" : ""} /> ${escapeHtml(p.display_name)} <span class="admin-row-meta">(${escapeHtml(p.role)})</span></label>
  `).join("");

  openModal("modalFile");
  el.ffName.focus();
}

async function handleFileFormSubmit(e) {
  e.preventDefault();
  el.fileFormError.hidden = true;
  const url = el.ffUrl.value.trim();
  if (!isSafeUrl(url)) {
    el.fileFormError.textContent = "Please enter a valid https:// URL.";
    el.fileFormError.hidden = false;
    return;
  }

  const payload = {
    file_name: el.ffName.value.trim(),
    category_id: el.ffCategory.value || null,
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

  if (error) {
    el.fileFormError.textContent = "Could not save file. Check the fields and try again.";
    el.fileFormError.hidden = false;
    return;
  }
  const savedId = data.id;
  const selectedUserIds = $$('#ff-permissions input[type="checkbox"]:checked').map((i) => i.value);
  await supabase.from("file_access").delete().eq("file_id", savedId);
  if (selectedUserIds.length > 0) {
    await supabase.from("file_access").insert(selectedUserIds.map((uid) => ({ file_id: savedId, user_id: uid, granted_by: state.profile.id })));
  }
  await logActivity(fileId ? "file_updated" : "file_created", "info", { file_id: savedId });
  showToast("File saved.");
  closeModal("modalFile");
  refreshFiles();
}

function handleFileDelete() {
  const fileId = el.ffId.value;
  if (!fileId) return;
  confirmAction("Delete file?", "This cannot be undone.", async () => {
    const { error } = await supabase.from("files").delete().eq("id", fileId);
    if (error) return showToast("Could not delete file.", true);
    await logActivity("file_deleted", "warning", { file_id: fileId });
    showToast("File deleted.");
    closeModal("modalFile");
    refreshFiles();
  });
}

/* ---------------------------------------------------------------------- */
/* USERS (admin)                                                            */
/* ---------------------------------------------------------------------- */
async function refreshUsers() {
  setStateBlock(el.usersState, "Loading…", "Fetching users.");
  const { data, error } = await supabase.from("profiles").select("*").order("role");
  if (error) return setStateBlock(el.usersState, "Something went wrong", "Could not load users.");
  clearStateBlock(el.usersState);
  state.users = data || [];

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
          <div class="profile-card-actions">
            <button class="btn-ghost btn-small" data-edit-user="${u.id}" type="button">Edit</button>
          </div>
        </div>
      </div>`;
  }).join("") || `<div class="state-block"><strong>No users yet</strong><span>Add your first user.</span></div>`;
}

async function openUserModal(userId = null) {
  state.editingUserId = userId;
  el.userFormError.hidden = true;
  el.modalUserTitle.textContent = userId ? "Edit user" : "Add user";
  el.ufResetPassword.hidden = !userId;

  el.ufManager.innerHTML = `<option value="">None</option>` +
    state.users.filter((u) => u.id !== userId).map((u) => `<option value="${u.id}">${escapeHtml(u.display_name)}</option>`).join("");

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
  openModal("modalUser");
  el.ufUsername.focus();
}

async function handleUserFormSubmit(e) {
  e.preventDefault();
  el.userFormError.hidden = true;
  const userId = el.ufId.value || null;

  try {
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
      if (!res.ok) throw new Error();
    } else {
      const { error } = await supabase.from("profiles").update({
        username: el.ufUsername.value.trim(), display_name: el.ufDisplayName.value.trim(),
        role: el.ufRole.value, manager_id: el.ufManager.value || null, is_active: el.ufActive.checked,
      }).eq("id", userId);
      if (error) throw error;
      await logActivity("user_updated", "info", { target_user_id: userId });
    }
    showToast("User saved.");
    closeModal("modalUser");
    refreshUsers();
  } catch {
    el.userFormError.textContent = "Could not save user. Check the fields and try again.";
    el.userFormError.hidden = false;
  }
}

async function handleUserResetPassword() {
  const userId = el.ufId.value;
  if (!userId) return;
  const { data: { session } } = await supabase.auth.getSession();
  const fnUrl = `${CONFIG.SUPABASE_URL}/functions/v1/${CONFIG.ADMIN_USERS_FUNCTION}`;
  try {
    const res = await fetch(fnUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json", Authorization: `Bearer ${session.access_token}` },
      body: JSON.stringify({ action: "reset_password", user_id: userId }),
    });
    if (!res.ok) throw new Error();
    showToast("Password reset email sent.");
  } catch { showToast("Could not send password reset.", true); }
}

/* ---------------------------------------------------------------------- */
/* PERMISSIONS (admin)                                                      */
/* ---------------------------------------------------------------------- */
async function refreshPermissionsScreen() {
  el.bulkUser.innerHTML = state.users.length
    ? state.users.map((u) => `<option value="${u.id}">${escapeHtml(u.display_name)}</option>`).join("")
    : (await supabase.from("profiles").select("id, display_name")).data
        ?.map((u) => `<option value="${u.id}">${escapeHtml(u.display_name)}</option>`).join("") || "";

  const { data: files } = await supabase.from("files").select("id, file_name, categories(name)").order("file_name");
  el.permissionsFileList.innerHTML = (files || []).map((f) => `
    <div class="admin-row">
      <div class="admin-row-main">
        <div class="admin-row-name">${escapeHtml(f.file_name)}</div>
        <div class="admin-row-meta">${escapeHtml(f.categories?.name || "Uncategorized")}</div>
      </div>
      <button class="btn-ghost btn-small" data-edit-file="${f.id}" type="button">Manage access</button>
    </div>
  `).join("") || `<div class="admin-row-meta">No files yet.</div>`;
}

async function handleBulkAccessSubmit(e) {
  e.preventDefault();
  const mode = e.submitter?.dataset.mode || "grant";
  const categoryId = el.bulkCategory.value;
  const userId = el.bulkUser.value;
  const fn = mode === "grant" ? "admin_grant_category_access" : "admin_revoke_category_access";
  const { error } = await supabase.rpc(fn, { p_category_id: categoryId, p_user_id: userId });
  if (error) return showToast("Could not update access.", true);
  showToast(mode === "grant" ? "Access granted." : "Access revoked.");
}

/* ---------------------------------------------------------------------- */
/* ACTIVITY / SECURITY (admin)                                              */
/* ---------------------------------------------------------------------- */
async function refreshActivity(severities, targetElKey) {
  const list = severities.split(",");
  const { data, error } = await supabase.from("activity_log").select("*")
    .in("severity", list).order("created_at", { ascending: false }).limit(50);
  const target = el[targetElKey];
  if (error) { target.innerHTML = `<li class="admin-row-meta">Could not load.</li>`; return; }
  target.innerHTML = (data || []).map((a) => `
    <li class="admin-row">
      <span class="status-dot ${a.severity === "critical" ? "is-active" : ""}"></span>
      <div class="admin-row-main">
        <div class="admin-row-name">${escapeHtml(a.event_type.replace(/_/g, " "))}</div>
        <div class="admin-row-meta">${timeAgo(a.created_at)}${a.metadata ? " · " + escapeHtml(JSON.stringify(a.metadata)) : ""}</div>
      </div>
    </li>
  `).join("") || `<li class="admin-row-meta">No events.</li>`;
}

/* ---------------------------------------------------------------------- */
/* DIALOGS (generic)                                                        */
/* ---------------------------------------------------------------------- */
function openModal(key) { el[key].hidden = false; }
function closeModal(key) { el[key].hidden = true; }
let confirmCallback = null;
function confirmAction(title, body, onConfirm) {
  el.confirmTitle.textContent = title;
  el.confirmBody.textContent = body;
  confirmCallback = onConfirm;
  openModal("modalConfirm");
}

/* ---------------------------------------------------------------------- */
/* KEYBOARD SHORTCUT                                                        */
/* Browsers cannot reliably intercept OS-level Win+Alt+H, so Ctrl+Alt+H is  */
/* the practical, guaranteed-to-work fallback; both are wired here.        */
/* ---------------------------------------------------------------------- */
function initKeyboardShortcut() {
  document.addEventListener("keydown", (e) => {
    if (e.altKey && e.key.toLowerCase() === "h" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      window.open("https://hxrish-14.github.io/Harish-Portfolio/", "_blank", "noopener,noreferrer");
    }
  });
}

/* ---------------------------------------------------------------------- */
/* ERROR HANDLING                                                           */
/* ---------------------------------------------------------------------- */
window.addEventListener("unhandledrejection", () => showToast("Something went wrong.", true));
window.addEventListener("online", () => { el.offlineBanner.hidden = true; });
window.addEventListener("offline", () => { el.offlineBanner.hidden = false; });

/* ---------------------------------------------------------------------- */
/* EVENTS                                                                   */
/* ---------------------------------------------------------------------- */
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
  el.btnSidebarToggle.addEventListener("click", () => el.sidebar.classList.toggle("is-open"));
  el.btnUserMenu.addEventListener("click", () => { el.userDropdown.hidden = !el.userDropdown.hidden; });
  document.addEventListener("click", (e) => {
    if (!el.userDropdown.hidden && !e.target.closest(".user-menu")) el.userDropdown.hidden = true;
  });
  el.btnLogout.addEventListener("click", handleLogout);
  el.btnChangePassword.addEventListener("click", async () => {
    await supabase.auth.resetPasswordForEmail(state.profile.email);
    showToast("Password reset email sent.");
  });

  $$(".side-link").forEach((btn) => btn.addEventListener("click", () => switchView(btn.dataset.view)));

  el.searchInput.addEventListener("input", debounce((e) => {
    state.searchTerm = e.target.value.trim();
    state.page = 0;
    refreshFiles();
  }, CONFIG.SEARCH_DEBOUNCE_MS));

  el.categoryFilter.addEventListener("change", (e) => { state.categoryId = e.target.value; state.page = 0; refreshFiles(); });
  el.filesPagination.addEventListener("click", (e) => {
    const btn = e.target.closest("button[data-page]");
    if (!btn || btn.disabled) return;
    state.page = Number(btn.dataset.page);
    refreshFiles();
  });
  [el.filesGrid, el.recentFilesGrid].forEach((grid) => grid.addEventListener("click", (e) => {
    const openBtn = e.target.closest("[data-open-file]");
    const editBtn = e.target.closest("[data-edit-file]");
    if (openBtn) handleOpenFile(openBtn.dataset.openFile);
    if (editBtn) openFileModal(editBtn.dataset.editFile);
  }));

  el.btnNewFile.addEventListener("click", () => openFileModal());
  el.fileForm.addEventListener("submit", handleFileFormSubmit);
  el.ffDelete.addEventListener("click", handleFileDelete);
  el.categoryForm.addEventListener("submit", handleCategoryFormSubmit);

  el.btnNewUser.addEventListener("click", () => openUserModal());
  el.usersGrid.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-edit-user]");
    if (btn) openUserModal(btn.dataset.editUser);
  });
  el.userForm.addEventListener("submit", handleUserFormSubmit);
  el.ufResetPassword.addEventListener("click", handleUserResetPassword);

  el.bulkAccessForm.addEventListener("submit", handleBulkAccessSubmit);
  el.permissionsFileList.addEventListener("click", (e) => {
    const btn = e.target.closest("[data-edit-file]");
    if (btn) openFileModal(btn.dataset.editFile);
  });

  $$("[data-close]").forEach((btn) => btn.addEventListener("click", () => closeModal(btn.dataset.close)));
  $$(".modal-backdrop").forEach((backdrop) => backdrop.addEventListener("click", (e) => {
    if (e.target === backdrop) backdrop.hidden = true;
  }));
  document.addEventListener("keydown", (e) => {
    if (e.key !== "Escape") return;
    $$(".modal-backdrop").forEach((m) => { if (!m.hidden) m.hidden = true; });
  });
  el.confirmOk.addEventListener("click", () => { const cb = confirmCallback; closeModal("modalConfirm"); cb?.(); });
}

/* ---------------------------------------------------------------------- */
/* INIT                                                                     */
/* ---------------------------------------------------------------------- */
(async function init() {
  cacheDom();
  initTheme();
  wireEvents();
  initKeyboardShortcut();

  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) await loadProfileAndEnterApp(); else showLogin();
  } catch { showLogin(); }
})();
