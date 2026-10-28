/* ============================================================
   Wisata Gunung - Logika dashboard admin (CRUD + auth guard)
   Catatan keamanan: pengecekan login di sisi browser hanya untuk UX.
   Perlindungan data yang sebenarnya dijalankan oleh Row Level Security
   di Supabase (lihat schema.sql): hanya user terautentikasi yang bisa
   menulis data.
   ============================================================ */
const $ = (s) => document.querySelector(s);
const $$ = (s) => [...document.querySelectorAll(s)];
const esc = (v) =>
  String(v ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const safeUrl = (u) => (/^(https?:\/\/|\/|assets\/)/i.test(u || "") ? u : "");
const rupiah = (n) => "Rp " + Number(n || 0).toLocaleString("id-ID");
const isVideo = (u) => /\.(mp4|webm|ogg)(\?.*)?$/i.test(u || "");

/* ---------- Definisi entitas CRUD ---------- */
const ENTITIES = {
  packages: {
    label: "Paket",
    fields: [
      { key: "title", label: "Judul Paket", type: "text", required: true },
      { key: "price", label: "Harga (Rp)", type: "number", required: true, min: 0 },
      { key: "description", label: "Deskripsi / Fasilitas", type: "textarea" },
      { key: "image_url", label: "Foto Paket", type: "file", accept: "image/*", folder: "packages" },
    ],
    row: (r) => `
      <td>${thumb(r.image_url)}</td>
      <td><strong>${esc(r.title)}</strong></td>
      <td>${rupiah(r.price)}</td>
      <td>${esc((r.description || "").slice(0, 70))}${(r.description || "").length > 70 ? "…" : ""}</td>`,
  },
  gallery: {
    label: "Item Galeri",
    fields: [
      { key: "image_url", label: "File Foto / Video", type: "file", accept: "image/*,video/mp4,video/webm", folder: "gallery", required: true },
      { key: "caption", label: "Keterangan", type: "text" },
    ],
    row: (r) => `<td>${thumb(r.image_url)}</td><td>${esc(r.caption)}</td><td>${esc(r.category)}</td>`,
  },
  team: {
    label: "Anggota Tim",
    fields: [
      { key: "name", label: "Nama", type: "text", required: true },
      { key: "role", label: "Jabatan", type: "text", required: true },
      { key: "photo_url", label: "Foto Anggota", type: "file", accept: "image/*", folder: "team" },
    ],
    row: (r) => `<td>${thumb(r.photo_url)}</td><td><strong>${esc(r.name)}</strong></td><td>${esc(r.role)}</td>`,
  },
};

/* ---------- Upload file ke Supabase Storage ---------- */
const BUCKET = "media";
const MAX_IMAGE_MB = 8;
const MAX_VIDEO_MB = 50;
const IMAGE_TYPES = ["image/jpeg", "image/png", "image/webp", "image/gif"];
const VIDEO_TYPES = ["video/mp4", "video/webm"];

function checkFile(file, accept) {
  const isVid = VIDEO_TYPES.includes(file.type);
  const isImg = IMAGE_TYPES.includes(file.type);
  const allowVideo = /video/.test(accept);
  if (!isImg && !(isVid && allowVideo)) {
    return allowVideo ? "Format harus JPG, PNG, WebP, GIF, MP4, atau WebM." : "Format foto harus JPG, PNG, WebP, atau GIF.";
  }
  const limit = isVid ? MAX_VIDEO_MB : MAX_IMAGE_MB;
  if (file.size > limit * 1024 * 1024) return `Ukuran file maksimal ${limit} MB (file ini ${(file.size / 1048576).toFixed(1)} MB).`;
  return "";
}

async function uploadFile(file, folder) {
  const ext = (file.name.split(".").pop() || "bin").toLowerCase().replace(/[^a-z0-9]/g, "");
  const path = `${folder}/${Date.now()}-${Math.random().toString(36).slice(2, 8)}.${ext}`;
  const { error } = await sb.storage.from(BUCKET).upload(path, file, { cacheControl: "31536000", contentType: file.type });
  if (error) throw error;
  return sb.storage.from(BUCKET).getPublicUrl(path).data.publicUrl;
}

// Hapus file lama dari bucket (hanya jika URL berasal dari bucket kita). Gagal = diabaikan.
async function removeStored(url) {
  const marker = `/storage/v1/object/public/${BUCKET}/`;
  const i = (url || "").indexOf(marker);
  if (i < 0) return;
  const path = decodeURIComponent(url.slice(i + marker.length).split("?")[0]);
  try { await sb.storage.from(BUCKET).remove([path]); } catch (_) {}
}

function thumb(url) {
  const u = safeUrl(url);
  if (!u) return '<div class="thumb"></div>';
  return isVideo(u) ? `<video class="thumb" src="${esc(u)}" muted></video>` : `<img class="thumb" src="${esc(u)}" alt="" />`;
}

const state = { packages: [], gallery: [], team: [], bookings: [], settings: null };
let editing = null; // { entity, id|null }

/* ---------- Notifikasi ---------- */
function flash(msg, type = "ok", target = "#globalAlert") {
  const el = $(target);
  el.innerHTML = `<div class="alert ${type}" role="alert">${esc(msg)}</div>`;
  if (type === "ok") setTimeout(() => { el.innerHTML = ""; }, 3000);
}

/* ---------- Auth guard ---------- */
async function guard() {
  if (!window.sb) { location.replace("admin-login.html"); return false; }
  const { data } = await sb.auth.getSession();
  if (!data.session) { location.replace("admin-login.html"); return false; }
  $("#userEmail").textContent = data.session.user.email;
  sb.auth.onAuthStateChange((event, session) => {
    if (!session) location.replace("admin-login.html");
  });
  return true;
}

/* ---------- Pemuatan data ---------- */
async function loadEntity(name) {
  const order = name === "gallery" ? { column: "id", ascending: false } : { column: "id", ascending: true };
  const { data, error } = await sb.from(name).select("*").order(order.column, { ascending: order.ascending });
  if (error) { flash("Gagal memuat " + name + ": " + error.message, "error"); return; }
  state[name] = data || [];
  renderTable(name);
  updateStats();
}

function renderTable(name) {
  const ent = ENTITIES[name];
  const body = $("#tbody-" + name);
  const cols = body.closest("table").querySelectorAll("th").length;
  if (!state[name].length) { body.innerHTML = `<tr><td colspan="${cols}" style="text-align:center;color:#5d6b62">Belum ada data.</td></tr>`; return; }
  body.innerHTML = state[name].map((r) => `
    <tr>${ent.row(r)}
      <td><div class="actions">
        <button class="btn btn-sm btn-light" data-edit="${name}" data-id="${esc(r.id)}">Edit</button>
        <button class="btn btn-sm btn-danger" data-del="${name}" data-id="${esc(r.id)}">Hapus</button>
      </div></td>
    </tr>`).join("");
}

async function loadBookings() {
  const { data, error } = await sb.from("bookings").select("*").order("created_at", { ascending: false }).limit(300);
  if (error) { flash("Gagal memuat log booking: " + error.message, "error"); return; }
  state.bookings = data || [];
  const body = $("#tbody-bookings");
  if (!state.bookings.length) { body.innerHTML = '<tr><td colspan="6" style="text-align:center;color:#5d6b62">Belum ada booking.</td></tr>'; }
  else {
    body.innerHTML = state.bookings.map((b) => `
      <tr>
        <td>${esc(new Date(b.created_at).toLocaleString("id-ID"))}</td>
        <td>${esc(b.name)}</td><td>${esc(b.package_title)}</td>
        <td>${esc(b.booking_date)}</td><td>${esc(b.people)}</td>
        <td><button class="btn btn-sm btn-danger" data-del="bookings" data-id="${esc(b.id)}">Hapus</button></td>
      </tr>`).join("");
  }
  updateStats();
}

async function loadSettings() {
  const { data, error } = await sb.from("settings").select("*").order("id").limit(1).maybeSingle();
  if (error) { flash("Gagal memuat pengaturan: " + error.message, "error"); return; }
  state.settings = data;
  const keys = ["whatsapp_number", "vision", "mission", "address", "phone", "email", "instagram", "facebook", "maps_embed"];
  keys.forEach((k) => { $("#s_" + k).value = (data && data[k]) || ""; });
  renderHeroVideo();
}

/* ---------- Video beranda ---------- */
function renderHeroVideo() {
  const url = safeUrl(state.settings && state.settings.hero_video_url);
  $("#heroCurrent").innerHTML = url
    ? `<video src="${esc(url)}" muted controls playsinline></video>`
    : '<div class="hint">Belum ada video unggahan — beranda memakai video bawaan / gambar latar.</div>';
  $("#heroRemove").style.display = url ? "" : "none";
}

async function saveHeroVideo(patchUrl, oldUrl) {
  const q = state.settings
    ? sb.from("settings").update({ hero_video_url: patchUrl }).eq("id", state.settings.id)
    : sb.from("settings").insert({ whatsapp_number: "6281234567890", hero_video_url: patchUrl });
  const { error } = await q;
  if (error) throw error;
  if (oldUrl) removeStored(oldUrl);
}

async function uploadHeroVideo() {
  const file = $("#heroFile").files[0];
  if (!file) { flash("Pilih file video terlebih dahulu.", "error", "#heroAlert"); return; }
  if (!VIDEO_TYPES.includes(file.type)) { flash("Format video harus MP4 atau WebM.", "error", "#heroAlert"); return; }
  if (file.size > MAX_VIDEO_MB * 1048576) { flash(`Ukuran video maksimal ${MAX_VIDEO_MB} MB (file ini ${(file.size / 1048576).toFixed(1)} MB).`, "error", "#heroAlert"); return; }
  const btn = $("#heroUpload");
  btn.disabled = true; btn.textContent = "Mengunggah…";
  try {
    const url = await uploadFile(file, "hero");
    await saveHeroVideo(url, state.settings && state.settings.hero_video_url);
    $("#heroFile").value = "";
    $("#heroPreview").innerHTML = "";
    flash("Video beranda diperbarui. Website langsung terbarui.", "ok", "#heroAlert");
    await loadSettings();
  } catch (err) {
    flash("Gagal mengunggah: " + (err.message || err), "error", "#heroAlert");
  }
  btn.disabled = false; btn.textContent = "Unggah & Pakai Video";
}

async function removeHeroVideo() {
  if (!confirm("Hapus video beranda? Beranda akan kembali memakai video bawaan / gambar latar.")) return;
  try {
    await saveHeroVideo(null, state.settings && state.settings.hero_video_url);
    flash("Video beranda dihapus.", "ok", "#heroAlert");
    await loadSettings();
  } catch (err) {
    flash("Gagal menghapus: " + (err.message || err), "error", "#heroAlert");
  }
}

function updateStats() {
  $("#statPackages").textContent = state.packages.length;
  $("#statGallery").textContent = state.gallery.length;
  $("#statTeam").textContent = state.team.length;
  $("#statBookings").textContent = state.bookings.length;
}

/* ---------- Modal CRUD ---------- */
function openModal(entity, id = null) {
  const ent = ENTITIES[entity];
  const row = id != null ? state[entity].find((r) => String(r.id) === String(id)) : null;
  editing = { entity, id: row ? row.id : null };
  $("#crudTitle").textContent = (row ? "Edit " : "Tambah ") + ent.label;
  $("#crudAlert").innerHTML = "";
  $("#crudFields").innerHTML = ent.fields.map((f) => {
    const val = row ? row[f.key] ?? "" : f.type === "select" ? f.options[0] : "";
    let input;
    if (f.type === "textarea") input = `<textarea id="f_${f.key}" rows="4">${esc(val)}</textarea>`;
    else if (f.type === "select") input = `<select id="f_${f.key}">${f.options.map((o) => `<option ${o === val ? "selected" : ""}>${esc(o)}</option>`).join("")}</select>`;
    else if (f.type === "file") input = fileInputHtml(f, val);
    else input = `<input id="f_${f.key}" type="${f.type}" value="${esc(val)}" ${f.required ? "required" : ""} ${f.min != null ? `min="${f.min}"` : ""} />`;
    return `<div class="form-group"><label for="f_${f.key}">${esc(f.label)}</label>${input}</div>`;
  }).join("");
  $("#crudModal").classList.add("open");
}
function fileInputHtml(f, val) {
  const cur = safeUrl(val);
  const preview = cur
    ? (isVideo(cur) ? `<video src="${esc(cur)}" muted controls></video>` : `<img src="${esc(cur)}" alt="" />`)
    : "";
  return `<input id="f_${f.key}" type="file" accept="${esc(f.accept)}" data-file />
    <div class="file-preview" id="pv_${f.key}">${preview}</div>
    <div class="hint">${cur ? "Kosongkan untuk tetap memakai file saat ini. " : ""}Foto maks. ${MAX_IMAGE_MB} MB${/video/.test(f.accept) ? `, video maks. ${MAX_VIDEO_MB} MB` : ""}.</div>`;
}

// Pratinjau instan saat file dipilih
document.addEventListener("change", (e) => {
  const inp = e.target.closest("input[data-file]");
  if (!inp) return;
  const box = document.getElementById("pv_" + inp.id.slice(2));
  const file = inp.files[0];
  if (!box) return;
  if (!file) { box.innerHTML = ""; return; }
  const u = URL.createObjectURL(file);
  box.innerHTML = file.type.startsWith("video/") ? `<video src="${u}" muted controls></video>` : `<img src="${u}" alt="" />`;
});

const closeModal = () => { $("#crudModal").classList.remove("open"); editing = null; };

async function saveModal(e) {
  e.preventDefault();
  if (!editing) return;
  const ent = ENTITIES[editing.entity];
  const old = editing.id != null ? state[editing.entity].find((r) => String(r.id) === String(editing.id)) : null;
  const payload = {};
  const files = {};
  for (const f of ent.fields) {
    const el = $("#f_" + f.key);
    if (f.type === "file") {
      const file = el.files[0];
      if (file) {
        const msg = checkFile(file, f.accept);
        if (msg) { flash(msg, "error", "#crudAlert"); return; }
        files[f.key] = file;
      } else if (f.required && !(old && old[f.key])) {
        flash(`${f.label} wajib dipilih.`, "error", "#crudAlert");
        return;
      }
      continue;
    }
    let v = el.value.trim();
    if (f.type === "number") v = Number(v) || 0;
    payload[f.key] = v;
  }
  const btn = $("#crudSave");
  btn.disabled = true;
  const oldUrls = [];
  try {
    for (const f of ent.fields.filter((x) => files[x.key])) {
      btn.textContent = "Mengunggah…";
      payload[f.key] = await uploadFile(files[f.key], f.folder || editing.entity);
      if (old && old[f.key]) oldUrls.push(old[f.key]);
      if (editing.entity === "gallery") payload.category = VIDEO_TYPES.includes(files[f.key].type) ? "video" : "foto";
    }
    btn.textContent = "Menyimpan…";
    const { error } = editing.id == null
      ? await sb.from(editing.entity).insert(payload)
      : await sb.from(editing.entity).update(payload).eq("id", editing.id);
    if (error) throw error;
  } catch (err) {
    btn.disabled = false; btn.textContent = "Simpan";
    flash("Gagal menyimpan: " + (err.message || err), "error", "#crudAlert");
    return;
  }
  btn.disabled = false; btn.textContent = "Simpan";
  oldUrls.forEach(removeStored);
  const name = editing.entity;
  closeModal();
  flash("Data berhasil disimpan.");
  loadEntity(name);
}

async function deleteRow(table, id) {
  if (!confirm("Hapus data ini? Tindakan tidak dapat dibatalkan.")) return;
  const row = state[table] && state[table].find((r) => String(r.id) === String(id));
  const { error } = await sb.from(table).delete().eq("id", id);
  if (error) { flash("Gagal menghapus: " + error.message, "error"); return; }
  if (row) ["image_url", "photo_url"].forEach((k) => removeStored(row[k]));
  flash("Data dihapus.");
  table === "bookings" ? loadBookings() : loadEntity(table);
}

/* ---------- Pengaturan ---------- */
async function saveSettings(e) {
  e.preventDefault();
  const keys = ["whatsapp_number", "vision", "mission", "address", "phone", "email", "instagram", "facebook", "maps_embed"];
  const payload = {};
  keys.forEach((k) => { payload[k] = $("#s_" + k).value.trim(); });
  payload.whatsapp_number = payload.whatsapp_number.replace(/\D/g, "");
  if (!payload.whatsapp_number) { flash("Nomor WhatsApp wajib diisi.", "error"); return; }
  for (const k of ["instagram", "facebook", "maps_embed"]) {
    if (payload[k] && !safeUrl(payload[k])) { flash("Link " + k + " harus diawali http:// atau https://", "error"); return; }
  }
  const q = state.settings
    ? sb.from("settings").update(payload).eq("id", state.settings.id)
    : sb.from("settings").insert(payload);
  const { error } = await q;
  if (error) { flash("Gagal menyimpan: " + error.message, "error"); return; }
  flash("Pengaturan disimpan. Website langsung terbarui.");
  loadSettings();
}

/* ---------- Tab & event ---------- */
function showTab(tab) {
  $$(".tab-btn[data-tab]").forEach((b) => b.classList.toggle("active", b.dataset.tab === tab));
  $$(".panel").forEach((p) => p.classList.toggle("active", p.id === "panel-" + tab));
  $("#sidebar").classList.remove("open");
}

document.addEventListener("DOMContentLoaded", async () => {
  if (!(await guard())) return;

  $$(".tab-btn[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));
  $("#menuBtn").addEventListener("click", () => $("#sidebar").classList.toggle("open"));
  $("#logoutBtn").addEventListener("click", async () => { await sb.auth.signOut(); location.replace("admin-login.html"); });
  $("#crudForm").addEventListener("submit", saveModal);
  $("#crudCancel").addEventListener("click", closeModal);
  $("#crudModal").addEventListener("click", (e) => { if (e.target.id === "crudModal") closeModal(); });
  $("#settingsForm").addEventListener("submit", saveSettings);
  $("#heroUpload").addEventListener("click", uploadHeroVideo);
  $("#heroRemove").addEventListener("click", removeHeroVideo);
  $("#heroFile").addEventListener("change", (e) => {
    const f = e.target.files[0];
    $("#heroPreview").innerHTML = f ? `<video src="${URL.createObjectURL(f)}" muted controls playsinline></video>` : "";
  });
  $("#refreshBookings").addEventListener("click", loadBookings);

  // Delegasi klik: tambah / edit / hapus
  document.addEventListener("click", (e) => {
    const add = e.target.closest("[data-add]");
    const edit = e.target.closest("[data-edit]");
    const del = e.target.closest("[data-del]");
    if (add) openModal(add.dataset.add);
    else if (edit) openModal(edit.dataset.edit, edit.dataset.id);
    else if (del) deleteRow(del.dataset.del, del.dataset.id);
  });

  await Promise.all([loadEntity("packages"), loadEntity("gallery"), loadEntity("team"), loadBookings(), loadSettings()]);
});
