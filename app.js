/* ============================================================================
   Secure Personal File Vault — Frontend logic
   Structure: CONFIG (secrets-safe settings) → STATE → DATA layer (Supabase)
   → RENDER → EVENTS → INIT. Only the anon/publishable key lives here — never
   the service role key.
   ========================================================================= */

/* ---------------------------------------------------------------------- */
/* CONFIG — the only values you should need to edit for deployment         */
/* ---------------------------------------------------------------------- */
const CONFIG = {
  // Supabase project settings → API. Safe for the browser: this is the
  // public anon/publishable key, not the service role key.
  SUPABASE_URL: "https://trgjjtvikddcczkdlzww.supabase.co",
  SUPABASE_ANON_KEY: "sb_publishable_UCr9X8sIda-cGLqzKOqpiA_2l4pEf1H",

  // Name of the deployed Edge Function that performs two-factor login.
  TIME_LOGIN_FUNCTION: "time-login",

  SEARCH_DEBOUNCE_MS: 300,
};

/* ---------------------------------------------------------------------- */
/* Supabase client (loaded via CDN script in index.html is avoided —      */
/* we use the ESM CDN build directly as a module import here).            */
/* ---------------------------------------------------------------------- */
import { createClient } from "https://cdn.jsdelivr.net/npm/@supabase/supabase-js@2/+esm";
const supabase = createClient(CONFIG.SUPABASE_URL, CONFIG.SUPABASE_ANON_KEY);

/* ---------------------------------------------------------------------- */
/* STATE                                                                   */
/* ---------------------------------------------------------------------- */
const state = {
  profile: null,       // { id, username, display_name, role }
  categories: [],
  files: [],
  searchTerm: "",
  categoryId: "all",
  editingFileId: null,
};

/* ---------------------------------------------------------------------- */
/* DOM shortcuts                                                           */
/* ---------------------------------------------------------------------- */
const $ = (sel, root = document) => root.querySelector(sel);
const $$ = (sel, root = document) => Array.from(root.querySelectorAll(sel));

const el = {
  viewLogin: $("#view-login"),
  viewApp: $("#view-app"),
  loginForm: $("#login-form"),
  loginError: $("#login-error"),
  loginSubmit: $("#login-submit"),
  header: $("#app-header"),
  navFiles: $('.nav-link[data-view="files"]'),
  navAdmin: $("#nav-admin"),
  navIndicator: $(".nav-indicator"),
  screenFiles: $("#screen-files"),
  screenAdmin: $("#screen-admin"),
  userName: $("#user-name"),
  userRole: $("#user-role"),
  btnLogout: $("#btn-logout"),
  searchInput: $("#search-input"),
  categoryFilter: $("#category-filter"),
  filesGrid: $("#files-grid"),
  filesState: $("#files-state"),
  adminFilesList: $("#admin-files-list"),
  adminFilesState: $("#admin-files-state"),
  adminCategoriesList: $("#admin-categories-list"),
  categoryForm: $("#category-form"),
  newCategoryName: $("#new-category-name"),
  btnNewFile: $("#btn-new-file"),
  modalFile: $("#modal-file"),
  fileForm: $("#file-form"),
  fileFormError: $("#file-form-error"),
  ffId: $("#ff-id"),
  ffName: $("#ff-name"),
  ffCategory: $("#ff-category"),
  ffSource: $("#ff-source"),
  ffDescription: $("#ff-description"),
  ffUrl: $("#ff-url"),
  ffActive: $("#ff-active"),
  ffPermissions: $("#ff-permissions"),
  ffDelete: $("#ff-delete"),
  toast: $("#toast"),
};

/* ---------------------------------------------------------------------- */
/* Utilities                                                               */
/* ---------------------------------------------------------------------- */
function debounce(fn, ms) {
  let t;
  return (...args) => { clearTimeout(t); t = setTimeout(() => fn(...args), ms); };
}

function showToast(message, isError = false) {
  el.toast.textContent = message;
  el.toast.classList.toggle("is-error", isError);
  el.toast.hidden = false;
  clearTimeout(showToast._t);
  showToast._t = setTimeout(() => { el.toast.hidden = true; }, 3200);
}

function setState(container, { title, body }) {
  container.hidden = false;
  container.innerHTML = `<strong>${escapeHtml(title)}</strong><span>${escapeHtml(body)}</span>`;
}
function clearState(container) { container.hidden = true; container.innerHTML = ""; }

// Always escape untrusted DB/user content before it ever touches innerHTML.
function escapeHtml(str) {
  const d = document.createElement("div");
  d.textContent = String(str ?? "");
  return d.innerHTML;
}

function isSafeExternalUrl(value) {
  try {
    const u = new URL(value);
    return u.protocol === "https:";
  } catch { return false; }
}

/* ---------------------------------------------------------------------- */
/* AUTH                                                                     */
/* ---------------------------------------------------------------------- */
async function handleLoginSubmit(e) {
  e.preventDefault();
  el.loginError.hidden = true;
  const submitBtn = el.loginSubmit;
  submitBtn.disabled = true;
  submitBtn.querySelector(".btn-label").textContent = "Logging in…";
  submitBtn.querySelector(".btn-spinner").hidden = false;

  const formData = new FormData(el.loginForm);
  const email = formData.get("email").trim();
  const password = formData.get("password");
  const timeCode = formData.get("timeCode").trim();

  try {
    const fnUrl = `${CONFIG.SUPABASE_URL}/functions/v1/${CONFIG.TIME_LOGIN_FUNCTION}`;
    const res = await fetch(fnUrl, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        apikey: CONFIG.SUPABASE_ANON_KEY,
        Authorization: `Bearer ${CONFIG.SUPABASE_ANON_KEY}`,
      },
      body: JSON.stringify({ email, password, timeCode }),
    });

    if (!res.ok) {
      // Generic message regardless of which factor failed.
      throw new Error("Invalid credentials or current-time password.");
    }
    const { access_token, refresh_token } = await res.json();
    const { error } = await supabase.auth.setSession({ access_token, refresh_token });
    if (error) throw new Error("Could not establish a session.");

    await loadProfileAndEnterApp();
  } catch (err) {
    el.loginError.textContent = err.message || "Login failed. Please try again.";
    el.loginError.hidden = false;
  } finally {
    submitBtn.disabled = false;
    submitBtn.querySelector(".btn-label").textContent = "Log in";
    submitBtn.querySelector(".btn-spinner").hidden = true;
  }
}

async function loadProfileAndEnterApp() {
  const { data: { user }, error: userErr } = await supabase.auth.getUser();
  if (userErr || !user) return showLogin();

  const { data: profile, error: profErr } = await supabase
    .from("profiles").select("id, username, display_name, role").eq("id", user.id).single();

  if (profErr || !profile) {
    await supabase.auth.signOut();
    el.loginError.textContent = "No profile found for this account.";
    el.loginError.hidden = false;
    return showLogin();
  }

  state.profile = profile;
  showApp();
}

async function handleLogout() {
  await supabase.auth.signOut();
  state.profile = null;
  showLogin();
}

function showLogin() {
  el.viewApp.hidden = true;
  el.viewLogin.hidden = false;
}

function showApp() {
  el.viewLogin.hidden = true;
  el.viewApp.hidden = false;
  el.userName.textContent = state.profile.display_name;
  el.userRole.textContent = state.profile.role;
  el.navAdmin.hidden = state.profile.role !== "admin";
  switchScreen("files");
  refreshCategories();
  refreshFiles();
}

/* ---------------------------------------------------------------------- */
/* NAV / SCREENS                                                           */
/* ---------------------------------------------------------------------- */
function switchScreen(name) {
  const isAdmin = name === "admin";
  el.screenFiles.hidden = isAdmin;
  el.screenAdmin.hidden = !isAdmin;
  $$(".nav-link").forEach((btn) => btn.classList.toggle("is-active", btn.dataset.view === name));
  positionNavIndicator();
  if (isAdmin) { refreshAdminFiles(); refreshAdminCategories(); }
}

function positionNavIndicator() {
  const active = $(".nav-link.is-active");
  if (!active) return;
  el.navIndicator.style.width = `${active.offsetWidth}px`;
  el.navIndicator.style.transform = `translateX(${active.offsetLeft - 4}px)`;
}

/* ---------------------------------------------------------------------- */
/* DATA — categories                                                       */
/* ---------------------------------------------------------------------- */
async function refreshCategories() {
  const { data, error } = await supabase.from("categories").select("id, name").order("name");
  if (error) return showToast("Could not load categories.", true);
  state.categories = data || [];

  el.categoryFilter.innerHTML =
    `<option value="all">All categories</option>` +
    state.categories.map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");

  el.ffCategory.innerHTML = state.categories
    .map((c) => `<option value="${c.id}">${escapeHtml(c.name)}</option>`).join("");
}

async function refreshAdminCategories() {
  el.adminCategoriesList.innerHTML = state.categories
    .map((c) => `<li class="admin-row"><div class="admin-row-main"><div class="admin-row-name">${escapeHtml(c.name)}</div></div></li>`)
    .join("") || `<li class="admin-row-meta">No categories yet.</li>`;
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
  refreshAdminCategories();
}

/* ---------------------------------------------------------------------- */
/* DATA — files (authorized view, driven by RLS)                          */
/* ---------------------------------------------------------------------- */
async function refreshFiles() {
  clearState(el.filesState);
  el.filesGrid.innerHTML = "";
  setState(el.filesState, { title: "Loading…", body: "Fetching your files." });

  let query = supabase
    .from("files")
    .select("id, file_name, description, external_url, source, is_active, category_id, categories(name)")
    .eq("is_active", true)
    .order("file_name");

  if (state.categoryId !== "all") query = query.eq("category_id", state.categoryId);
  if (state.searchTerm) query = query.ilike("file_name", `%${state.searchTerm}%`);

  const { data, error } = await query;

  if (error) {
    setState(el.filesState, { title: "Something went wrong", body: "Could not load files. Please try again." });
    return;
  }
  state.files = data || [];
  renderFiles();
}

function renderFiles() {
  if (state.files.length === 0) {
    setState(el.filesState, { title: "No files found", body: "Try another search or category." });
    el.filesGrid.innerHTML = "";
    return;
  }
  clearState(el.filesState);
  el.filesGrid.innerHTML = state.files.map((f) => `
    <article class="file-card" data-reveal>
      <div class="file-card-top">
        <div>
          <div class="file-name">${escapeHtml(f.file_name)}</div>
          ${f.categories ? `<div class="category-tag">${escapeHtml(f.categories.name)}</div>` : ""}
        </div>
        <span class="source-badge">${escapeHtml(f.source)}</span>
      </div>
      ${f.description ? `<p class="file-desc">${escapeHtml(f.description)}</p>` : ""}
      <div class="file-card-actions">
        <button class="btn-secondary btn-small" data-download="${f.id}" type="button">Download</button>
      </div>
    </article>
  `).join("");

  requestAnimationFrame(() => {
    const io = new IntersectionObserver((entries) => {
      entries.forEach((e) => { if (e.isIntersecting) { e.target.classList.add("is-visible"); io.unobserve(e.target); } });
    }, { threshold: 0.1 });
    $$("[data-reveal]", el.filesGrid).forEach((n) => io.observe(n));
  });
}

async function handleDownloadClick(fileId) {
  const file = state.files.find((f) => f.id === fileId);
  if (!file || !isSafeExternalUrl(file.external_url)) {
    return showToast("This link looks invalid and was blocked.", true);
  }
  try {
    await supabase.from("download_logs").insert({
      file_id: file.id, user_id: state.profile.id, source: file.source,
    });
  } catch {
    // Logging failure must never block a legitimate, authorized download.
  }
  window.open(file.external_url, "_blank", "noopener,noreferrer");
}

/* ---------------------------------------------------------------------- */
/* ADMIN — file management                                                 */
/* ---------------------------------------------------------------------- */
async function refreshAdminFiles() {
  setState(el.adminFilesState, { title: "Loading…", body: "Fetching all files." });
  const { data, error } = await supabase
    .from("files")
    .select("id, file_name, description, external_url, source, is_active, category_id, categories(name)")
    .order("file_name");

  if (error) {
    setState(el.adminFilesState, { title: "Something went wrong", body: "Could not load files." });
    return;
  }
  clearState(el.adminFilesState);
  if (!data || data.length === 0) {
    setState(el.adminFilesState, { title: "No files yet", body: "Add your first file to get started." });
    return;
  }
  el.adminFilesList.innerHTML = data.map((f) => `
    <li class="admin-row">
      <span class="status-dot ${f.is_active ? "is-active" : ""}" title="${f.is_active ? "Active" : "Inactive"}"></span>
      <div class="admin-row-main">
        <div class="admin-row-name">${escapeHtml(f.file_name)}</div>
        <div class="admin-row-meta">${escapeHtml(f.categories?.name || "Uncategorized")} · ${escapeHtml(f.source)}</div>
      </div>
      <button class="btn-ghost btn-small" data-edit-file="${f.id}" type="button">Edit</button>
    </li>
  `).join("");
}

async function openFileModal(fileId = null) {
  state.editingFileId = fileId;
  el.fileFormError.hidden = true;
  $("#modal-file-title").textContent = fileId ? "Edit file" : "Add file";
  el.ffDelete.hidden = !fileId;

  // Build permission checkboxes from all profiles.
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
      el.ffSource.value = file.source;
      el.ffDescription.value = file.description || "";
      el.ffUrl.value = file.external_url;
      el.ffActive.checked = file.is_active;
    }
    granted = new Set((access || []).map((a) => a.user_id));
  } else {
    el.fileForm.reset();
    el.ffId.value = "";
    el.ffActive.checked = true;
  }

  el.ffPermissions.innerHTML = (profiles || []).map((p) => `
    <label>
      <input type="checkbox" value="${p.id}" ${granted.has(p.id) ? "checked" : ""} />
      ${escapeHtml(p.display_name)} <span class="admin-row-meta">(${escapeHtml(p.role)})</span>
    </label>
  `).join("");

  el.modalFile.hidden = false;
  el.ffName.focus();
}

function closeFileModal() { el.modalFile.hidden = true; state.editingFileId = null; }

async function handleFileFormSubmit(e) {
  e.preventDefault();
  el.fileFormError.hidden = true;

  const url = el.ffUrl.value.trim();
  if (!isSafeExternalUrl(url)) {
    el.fileFormError.textContent = "Please enter a valid https:// URL.";
    el.fileFormError.hidden = false;
    return;
  }

  const payload = {
    file_name: el.ffName.value.trim(),
    category_id: el.ffCategory.value || null,
    source: el.ffSource.value,
    description: el.ffDescription.value.trim() || null,
    external_url: url,
    is_active: el.ffActive.checked,
  };

  const fileId = el.ffId.value || null;
  let savedId = fileId;

  const { data, error } = fileId
    ? await supabase.from("files").update(payload).eq("id", fileId).select("id").single()
    : await supabase.from("files").insert(payload).select("id").single();

  if (error) {
    el.fileFormError.textContent = "Could not save file. Check the fields and try again.";
    el.fileFormError.hidden = false;
    return;
  }
  savedId = data.id;

  // Sync permissions: replace-all approach, simplest correct behavior.
  const selectedUserIds = $$('#ff-permissions input[type="checkbox"]:checked').map((i) => i.value);
  await supabase.from("file_access").delete().eq("file_id", savedId);
  if (selectedUserIds.length > 0) {
    await supabase.from("file_access").insert(selectedUserIds.map((uid) => ({ file_id: savedId, user_id: uid })));
  }

  await supabase.from("audit_logs").insert({
    user_id: state.profile.id,
    action: fileId ? "file.update" : "file.create",
    target_type: "file",
    target_id: savedId,
  });

  showToast("File saved.");
  closeFileModal();
  refreshAdminFiles();
}

async function handleFileDelete() {
  const fileId = el.ffId.value;
  if (!fileId) return;
  if (!confirm("Delete this file? This cannot be undone.")) return;

  const { error } = await supabase.from("files").delete().eq("id", fileId);
  if (error) return showToast("Could not delete file.", true);

  await supabase.from("audit_logs").insert({
    user_id: state.profile.id, action: "file.delete", target_type: "file", target_id: fileId,
  });
  showToast("File deleted.");
  closeFileModal();
  refreshAdminFiles();
}

/* ---------------------------------------------------------------------- */
/* EVENTS                                                                   */
/* ---------------------------------------------------------------------- */
el.loginForm.addEventListener("submit", handleLoginSubmit);
el.btnLogout.addEventListener("click", handleLogout);

$$(".toggle-visibility").forEach((btn) => {
  btn.addEventListener("click", () => {
    const input = btn.previousElementSibling;
    const isText = input.type === "text";
    input.type = isText ? "password" : "text";
    btn.setAttribute("aria-pressed", String(!isText));
  });
});

$$(".nav-link").forEach((btn) => btn.addEventListener("click", () => switchScreen(btn.dataset.view)));
window.addEventListener("resize", debounce(positionNavIndicator, 150));

el.searchInput.addEventListener("input", debounce((e) => {
  state.searchTerm = e.target.value.trim();
  refreshFiles();
}, CONFIG.SEARCH_DEBOUNCE_MS));

el.categoryFilter.addEventListener("change", (e) => {
  state.categoryId = e.target.value;
  refreshFiles();
});

el.filesGrid.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-download]");
  if (btn) handleDownloadClick(btn.dataset.download);
});

el.btnNewFile.addEventListener("click", () => openFileModal());
el.adminFilesList.addEventListener("click", (e) => {
  const btn = e.target.closest("[data-edit-file]");
  if (btn) openFileModal(btn.dataset.editFile);
});
$("#modal-file-close").addEventListener("click", closeFileModal);
$("#ff-cancel").addEventListener("click", closeFileModal);
el.modalFile.addEventListener("click", (e) => { if (e.target === el.modalFile) closeFileModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape" && !el.modalFile.hidden) closeFileModal(); });
el.fileForm.addEventListener("submit", handleFileFormSubmit);
el.ffDelete.addEventListener("click", handleFileDelete);
el.categoryForm.addEventListener("submit", handleCategoryFormSubmit);

window.addEventListener("scroll", debounce(() => {
  el.header.classList.toggle("is-scrolled", window.scrollY > 8);
}, 20), { passive: true });

window.addEventListener("online", () => showToast("Back online."));
window.addEventListener("offline", () => showToast("You're offline. Some actions may fail.", true));

/* ---------------------------------------------------------------------- */
/* INIT                                                                     */
/* ---------------------------------------------------------------------- */
(async function init() {
  try {
    const { data: { session } } = await supabase.auth.getSession();
    if (session) {
      await loadProfileAndEnterApp();
    } else {
      showLogin();
    }
  } catch {
    showLogin();
  }
})();
