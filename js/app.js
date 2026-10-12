const LOCAL_KEY = 'nachsitzplan_iserv_draft_v1';
const TEACHER_KEY = 'nachsitzplan_teacher_name';
const AUTH_KEY = 'nachsitzplan_auth';
const PASS_KEY = 'nachsitzplan_gate';
const MIGRATED_KEY = 'nachsitzplan_remote_migrated_v1';
const AUTH_USER = 'Lehrkraft';
const PASS_ITERATIONS = 100000;
const PASS_SALT_B64 = 'GEzzmJaCD8WYQJSay6azQQ==';
const PASS_HASH_B64 = 'oaZrvILOitZ9pvC8uf2EqK3hRQOD808UOF6L9YkV/cw=';
const DEFAULT_ROOM = 'BK-Saal';

let plan = emptyPlan();
let remoteEtag = null;
let planVersion = 0;
let started = false;
let workspaceReady = false;
let pollStarted = false;
let inPush = false;
let pendingSaves = 0;
let saveQueue = Promise.resolve();
let activeSalt = null;
let keyCache = { salt: '', pass: '', promise: null };
let preloaded = { ready: false, plan: null };

function emptyPlan() {
  return {
    version: 1,
    passwordReady: false,
    updatedAt: null,
    updatedBy: null,
    entries: [],
  };
}

function $(id) {
  return document.getElementById(id);
}

function uid() {
  if (crypto.randomUUID) return crypto.randomUUID();
  return `e_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
}

function todayISO() {
  return new Date().toISOString().slice(0, 10);
}

function escapeHtml(str) {
  return String(str)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

function setStatus(message, isError = false) {
  const el = $('status');
  el.textContent = message || '';
  el.classList.toggle('error-text', !!isError);
}

function updateSyncNote() {
  const time = new Date().toLocaleTimeString('de-DE', { hour: '2-digit', minute: '2-digit' });
  $('sync-note').textContent = `Einträge sind verschlüsselt in der Nextcloud gespeichert und auf allen Geräten sichtbar. Zuletzt abgeglichen: ${time} Uhr.`;
}

function teacherName() {
  return $('teacher-name').value.trim();
}

function saveTeacherName() {
  localStorage.setItem(TEACHER_KEY, teacherName());
}

function loadTeacherName() {
  $('teacher-name').value = localStorage.getItem(TEACHER_KEY) || '';
}

function sessionPassword() {
  return sessionStorage.getItem(PASS_KEY) || '';
}

function bytesToB64(bytes) {
  let binary = '';
  const chunk = 0x8000;
  for (let index = 0; index < bytes.length; index += chunk) {
    binary += String.fromCharCode(...bytes.subarray(index, index + chunk));
  }
  return btoa(binary);
}

function b64ToBytes(b64) {
  const binary = atob(String(b64).replace(/\s/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index += 1) bytes[index] = binary.charCodeAt(index);
  return bytes;
}

function bytesEqual(left, right) {
  if (left.length !== right.length) return false;
  let diff = 0;
  for (let index = 0; index < left.length; index += 1) diff |= left[index] ^ right[index];
  return diff === 0;
}

function resetKeyCache() {
  keyCache = { salt: '', pass: '', promise: null };
}

async function deriveAesKey(password, saltBytes) {
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveKey']
  );
  return crypto.subtle.deriveKey(
    { name: 'PBKDF2', salt: saltBytes, iterations: PASS_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    { name: 'AES-GCM', length: 256 },
    false,
    ['encrypt', 'decrypt']
  );
}

async function keyForSalt(saltBytes, saltB64) {
  const pass = sessionPassword();
  if (keyCache.promise && keyCache.salt === saltB64 && keyCache.pass === pass) return keyCache.promise;
  const promise = deriveAesKey(pass, saltBytes);
  keyCache = { salt: saltB64, pass, promise };
  return promise;
}

async function passwordMatches(password) {
  const salt = b64ToBytes(PASS_SALT_B64);
  const expected = b64ToBytes(PASS_HASH_B64);
  const baseKey = await crypto.subtle.importKey(
    'raw',
    new TextEncoder().encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', salt, iterations: PASS_ITERATIONS, hash: 'SHA-256' },
    baseKey,
    256
  );
  return bytesEqual(new Uint8Array(bits), expected);
}

async function encryptPlan(planObj) {
  const salt = activeSalt || crypto.getRandomValues(new Uint8Array(16));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const saltB64 = bytesToB64(salt);
  const key = await keyForSalt(salt, saltB64);
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(JSON.stringify(planObj))
  );
  activeSalt = salt;
  return {
    v: 1,
    salt: saltB64,
    iv: bytesToB64(iv),
    ct: bytesToB64(new Uint8Array(cipher)),
  };
}

async function decryptEnvelope(envelope) {
  if (!envelope || envelope.v !== 1 || !envelope.salt || !envelope.iv || !envelope.ct) {
    const error = new Error('decrypt');
    throw error;
  }
  const salt = b64ToBytes(envelope.salt);
  const iv = b64ToBytes(envelope.iv);
  const cipher = b64ToBytes(envelope.ct);
  try {
    const key = await keyForSalt(salt, envelope.salt);
    const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, cipher);
    activeSalt = salt;
    return normalizePlan(JSON.parse(new TextDecoder().decode(plain)));
  } catch (error) {
    resetKeyCache();
    if (error && error.message === 'decrypt') throw error;
    const decryptError = new Error('decrypt');
    throw decryptError;
  }
}

function cloudConfig() {
  const file = window.NACHSITZ_CONFIG || {};
  return {
    baseUrl: String(file.baseUrl || '').replace(/\/$/, ''),
    username: String(file.username || '').trim(),
    password: String(file.password || ''),
    folder: String(file.folder || 'Nachsitzplan').trim() || 'Nachsitzplan',
    file: String(file.file || 'plan.json').trim() || 'plan.json',
  };
}

function isConfigured() {
  const cfg = cloudConfig();
  return !!(cfg.baseUrl && cfg.username && cfg.password);
}

function cloudUrl(relativePath) {
  const cfg = cloudConfig();
  const parts = [cfg.folder];
  if (relativePath) parts.push(...String(relativePath).split('/').filter(Boolean));
  else parts.push(cfg.file);
  return `${cfg.baseUrl}/remote.php/dav/files/${encodeURIComponent(cfg.username)}/${parts.map(encodeURIComponent).join('/')}`;
}

async function davRequest(method, extraHeaders, body, relativePath) {
  const cfg = cloudConfig();
  try {
    return await fetch(cloudUrl(relativePath), {
      method,
      headers: {
        Authorization: `Basic ${bytesToB64(new TextEncoder().encode(`${cfg.username}:${cfg.password}`))}`,
        ...(extraHeaders || {}),
      },
      body,
      cache: 'no-store',
    });
  } catch {
    const error = new Error('network');
    throw error;
  }
}

function cloudError(response) {
  const error = new Error('cloud');
  error.status = response.status;
  return error;
}

function explainError(error) {
  if (!error || error.message === 'network') {
    return 'Nextcloud ist gerade nicht erreichbar. Der Eintrag bleibt auf diesem Gerät und wird erneut versucht.';
  }
  if (error.status === 401) return 'Nextcloud hat die Anmeldung abgelehnt.';
  if (error.status === 403) return 'Nextcloud hat das Speichern abgelehnt.';
  if (error.message === 'conflict') return 'Jemand anders hat gerade gespeichert. Bitte noch einmal versuchen.';
  return 'Speichern ist fehlgeschlagen.';
}

let loadedChangeNames = [];

async function fetchRemote(updateEtag = true) {
  const response = await davRequest('GET');
  if (response.status === 404) {
    if (updateEtag) remoteEtag = null;
    return null;
  }
  if (!response.ok) throw cloudError(response);
  if (updateEtag) remoteEtag = response.headers.get('ETag');
  return decryptEnvelope(await response.json());
}

function changeNamesFromXml(xml) {
  const names = [];
  const pattern = /<(?:[^:>]+:)?href>([^<]+)<\/(?:[^:>]+:)?href>/gi;
  let match = pattern.exec(xml);
  while (match) {
    const href = decodeURIComponent(match[1]);
    const name = href.split('/').filter(Boolean).pop();
    if (name && name.endsWith('.json')) names.push(name);
    match = pattern.exec(xml);
  }
  return names;
}

async function listChanges() {
  const response = await davRequest('PROPFIND', { Depth: '1' }, null, 'changes');
  if (response.status === 404) return [];
  if (!response.ok) throw cloudError(response);
  return changeNamesFromXml(await response.text());
}

async function readChange(name) {
  const response = await davRequest('GET', null, null, `changes/${name}`);
  if (response.status === 404) return null;
  if (!response.ok) throw cloudError(response);
  return decryptEnvelope(await response.json());
}

async function loadMerged() {
  const names = await listChanges();
  loadedChangeNames = names;
  let merged = null;
  let readable = 0;
  let locked = 0;
  try {
    merged = await fetchRemote(true);
    if (merged) readable += 1;
  } catch (error) {
    if (error.message !== 'decrypt') throw error;
    locked += 1;
  }
  const parts = await Promise.all(names.map(async (name) => {
    try {
      return await readChange(name);
    } catch (error) {
      if (error.message !== 'decrypt') throw error;
      locked += 1;
      return null;
    }
  }));
  parts.filter(Boolean).forEach((part) => {
    readable += 1;
    merged = mergePlans(merged || emptyPlan(), part);
  });
  if (!readable && locked) {
    const error = new Error('decrypt');
    throw error;
  }
  return merged;
}

async function ensureChangesFolder() {
  const response = await davRequest('MKCOL', null, null, 'changes');
  if (response.status === 201 || response.status === 405 || response.status === 301) return;
  if (!response.ok && response.status !== 409) throw cloudError(response);
}

async function appendSnapshot(planObj) {
  await ensureChangesFolder();
  const name = `${Date.now()}-${uid()}.json`;
  const envelope = await encryptPlan(planObj);
  const response = await davRequest(
    'PUT',
    { 'Content-Type': 'application/json' },
    JSON.stringify(envelope),
    `changes/${name}`
  );
  if (!response.ok) throw cloudError(response);
}

async function deleteChange(name) {
  const response = await davRequest('DELETE', null, null, `changes/${name}`);
  if (response.status === 404 || response.status === 204 || response.ok) return;
  throw cloudError(response);
}

async function refreshEtag() {
  const response = await davRequest('GET');
  if (response.status === 404) {
    remoteEtag = null;
    return;
  }
  if (response.ok) remoteEtag = response.headers.get('ETag');
}

async function writeRemote(planObj) {
  const envelope = await encryptPlan(planObj);
  const headers = { 'Content-Type': 'application/json' };
  if (remoteEtag) headers['If-Match'] = remoteEtag;
  const response = await davRequest('PUT', headers, JSON.stringify(envelope));
  if (response.status === 412 || response.status === 409) {
    const error = new Error('conflict');
    throw error;
  }
  if (!response.ok) throw cloudError(response);
  remoteEtag = response.headers.get('ETag') || remoteEtag;
  plan = planObj;
  await saveDraft();
}

function wait(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

async function saveShared(message, options = {}) {
  let lastError = null;
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      if (!options.replace) {
        const remote = await loadMerged();
        if (remote) plan = mergePlans(remote, plan);
        const previousNames = loadedChangeNames.slice();
        plan.updatedAt = new Date().toISOString();
        plan.updatedBy = teacherName() || plan.updatedBy || null;
        plan.passwordReady = true;
        await appendSnapshot(plan);
        if (previousNames.length >= 8) {
          try {
            await writeRemote(plan);
            for (const name of previousNames) await deleteChange(name);
          } catch (error) {
            if (error.message !== 'conflict') throw error;
          }
        }
      } else {
        if (attempt > 0) await refreshEtag();
        plan.updatedAt = new Date().toISOString();
        plan.updatedBy = teacherName() || plan.updatedBy || null;
        plan.passwordReady = true;
        await writeRemote(plan);
        for (const name of loadedChangeNames) await deleteChange(name);
        loadedChangeNames = [];
      }
      renderEntries();
      if (!$('stats-dialog').hidden) renderStats();
      updateSyncNote();
      setStatus(message || 'Für alle Geräte gespeichert.');
      return;
    } catch (error) {
      lastError = error;
      if (error.message !== 'conflict') break;
      await wait(200 * (attempt + 1));
    }
  }
  await saveDraft();
  throw lastError || new Error('network');
}

function queueSave(message, options) {
  planVersion += 1;
  inPush = true;
  pendingSaves += 1;
  renderEntries();
  setStatus('Wird gespeichert …');
  saveQueue = saveQueue
    .then(() => saveShared(message, options))
    .catch((error) => {
      setStatus(explainError(error), true);
    })
    .finally(() => {
      pendingSaves -= 1;
      if (pendingSaves === 0) inPush = false;
    });
}

async function saveDraft() {
  try {
    const envelope = await encryptPlan(plan);
    localStorage.setItem(LOCAL_KEY, JSON.stringify({
      envelope,
      savedAt: new Date().toISOString(),
    }));
  } catch {
    /* Der lokale Entwurf ist nur ein Zwischenspeicher. */
  }
}

function readStoredRaw() {
  try {
    return JSON.parse(localStorage.getItem(LOCAL_KEY) || 'null');
  } catch {
    return null;
  }
}

function readLegacyPlan() {
  const data = readStoredRaw();
  if (data && data.plan) return normalizePlan(data.plan);
  return null;
}

async function readEncryptedDraft() {
  const data = readStoredRaw();
  if (!data || !data.envelope) return null;
  const previousSalt = activeSalt;
  try {
    return await decryptEnvelope(data.envelope);
  } catch {
    activeSalt = previousSalt;
    resetKeyCache();
    return null;
  }
}

function normalizeEntry(entry) {
  return {
    id: entry.id || uid(),
    date: entry.date || '',
    time: entry.time || '',
    className: entry.className || '',
    studentName: entry.studentName || '',
    reason: entry.reason || '',
    workMaterial: entry.workMaterial || '',
    room: entry.room || '',
    parentsNotified: !!entry.parentsNotified,
    done: !!entry.done,
    createdAt: entry.createdAt || null,
    createdBy: entry.createdBy || '',
    updatedAt: entry.updatedAt || entry.createdAt || null,
    deleted: !!entry.deleted,
    excludeFromStats: !!entry.excludeFromStats,
  };
}

function normalizePlan(data) {
  if (!data || typeof data !== 'object') return emptyPlan();
  return {
    version: 1,
    passwordReady: !!data.passwordReady,
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || null,
    entries: Array.isArray(data.entries) ? data.entries.map(normalizeEntry) : [],
  };
}

function stamp(entry) {
  return entry.updatedAt || entry.createdAt || '';
}

function mergePlans(base, incoming) {
  const map = new Map();
  [...(base.entries || []), ...(incoming.entries || [])].forEach((entry) => {
    const current = map.get(entry.id);
    if (!current || stamp(entry) >= stamp(current)) map.set(entry.id, { ...entry });
  });
  const times = [base.updatedAt, incoming.updatedAt].filter(Boolean).sort();
  const newer = (incoming.updatedAt || '') >= (base.updatedAt || '') ? incoming : base;
  return {
    version: 1,
    passwordReady: !!(base.passwordReady || incoming.passwordReady),
    updatedAt: times.length ? times[times.length - 1] : null,
    updatedBy: newer.updatedBy || null,
    entries: [...map.values()],
  };
}

function entriesSignature(source) {
  return JSON.stringify(
    [...source.entries]
      .map((entry) => ({
        id: entry.id,
        updatedAt: entry.updatedAt || entry.createdAt || '',
        deleted: !!entry.deleted,
      }))
      .sort((left, right) => String(left.id).localeCompare(String(right.id)))
  );
}

function visibleEntries(source) {
  return source.entries.filter((entry) => !entry.deleted);
}

function filteredEntries() {
  const date = $('f-date').value;
  const klass = $('f-class').value.trim().toLowerCase();
  const openOnly = $('f-open-only').checked;
  return visibleEntries(plan)
    .filter((entry) => {
      if (openOnly && entry.done) return false;
      if (date && entry.date !== date) return false;
      if (klass && String(entry.className || '').toLowerCase() !== klass) return false;
      return true;
    })
    .sort((left, right) => {
      const byDate = String(left.date || '').localeCompare(String(right.date || ''));
      if (byDate !== 0) return byDate;
      return String(left.time || '').localeCompare(String(right.time || ''));
    });
}

function renderEntries() {
  const rows = filteredEntries();
  $('empty-hint').hidden = rows.length > 0;
  $('entries-body').innerHTML = rows
    .map((entry) => {
      const dateLabel = entry.date
        ? new Date(`${entry.date}T00:00:00`).toLocaleDateString('de-DE')
        : '';
      return `
        <tr class="${entry.done ? 'done' : ''}" data-id="${escapeHtml(entry.id)}">
          <td><input type="checkbox" data-action="toggle" ${entry.done ? 'checked' : ''} aria-label="Erledigt"></td>
          <td>${escapeHtml(dateLabel)}</td>
          <td>${escapeHtml(entry.time || '')}</td>
          <td>${escapeHtml(entry.className || '')}</td>
          <td>${escapeHtml(entry.studentName || '')}</td>
          <td>${escapeHtml(entry.reason || '')}</td>
          <td>${escapeHtml(entry.workMaterial || '')}</td>
          <td>${escapeHtml(entry.room || '')}</td>
          <td><input type="checkbox" data-action="parents" ${entry.parentsNotified ? 'checked' : ''} aria-label="Eltern sind verständigt"></td>
          <td>${escapeHtml(entry.createdBy || '')}</td>
          <td><button type="button" class="btn" data-action="delete">Löschen</button></td>
        </tr>`;
    })
    .join('');
}

function nameKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');
}

function studentStats() {
  const groups = new Map();
  plan.entries.forEach((entry) => {
    if (entry.deleted || entry.excludeFromStats) return;
    const raw = String(entry.studentName || '').trim().replace(/\s+/g, ' ');
    const key = nameKey(raw);
    if (!key) return;
    let group = groups.get(key);
    if (!group) {
      group = { name: raw, classes: new Set(), count: 0 };
      groups.set(key, group);
    }
    group.count += 1;
    if (entry.className) group.classes.add(String(entry.className).trim());
  });
  return [...groups.values()].sort((left, right) => right.count - left.count || left.name.localeCompare(right.name, 'de'));
}

function renderStats() {
  const rows = studentStats();
  $('stats-empty').hidden = rows.length > 0;
  $('stats-body').innerHTML = rows
    .map((row) => `
      <tr>
        <td>${escapeHtml(row.name)}</td>
        <td>${escapeHtml([...row.classes].join(', '))}</td>
        <td class="count">${row.count}</td>
      </tr>`)
    .join('');
}

function openStats() {
  renderStats();
  $('stats-dialog').hidden = false;
}

function closeStats() {
  $('stats-dialog').hidden = true;
}

function touch(entry) {
  const now = new Date().toISOString();
  entry.updatedAt = now;
  plan.updatedAt = now;
  plan.updatedBy = teacherName() || plan.updatedBy;
}

function rememberLegacy() {
  const legacy = readLegacyPlan();
  if (!legacy || !legacy.entries.length || localStorage.getItem(MIGRATED_KEY)) return;
  plan = mergePlans(plan, legacy);
  plan.passwordReady = true;
  localStorage.setItem(MIGRATED_KEY, '1');
}

function showLogin(message) {
  workspaceReady = false;
  lockAdmin();
  $('admin-panel').hidden = true;
  $('app').hidden = true;
  $('login-gate').hidden = false;
  if (message) {
    $('login-error').textContent = message;
    $('login-error').hidden = false;
  }
}

async function routeAfterLogin() {
  setStatus('Wird verbunden …');
  if (!isConfigured()) {
    showLogin('Die Verbindung zur Nextcloud ist nicht eingerichtet.');
    return;
  }
  try {
    if (!preloaded.ready) {
      preloaded = { ready: true, plan: await loadMerged() };
    }
    if (!preloaded.plan || !preloaded.plan.passwordReady) {
      plan = preloaded.plan || emptyPlan();
      setStatus('');
      showNewPassword();
      return;
    }
    plan = preloaded.plan;
    const legacy = readLegacyPlan();
    if (legacy && legacy.entries.length && !localStorage.getItem(MIGRATED_KEY)) {
      rememberLegacy();
      await saveShared('Bisherige Einträge dieses Geräts wurden für alle übernommen.');
      await showWorkspace();
      return;
    }
    await showWorkspace(visibleEntries(plan).length ? 'Gemeinsame Einträge wurden geladen.' : '');
  } catch (error) {
    if (error.message === 'decrypt') {
      clearSession();
      showLogin('Das Passwort gilt für die gespeicherten Einträge nicht. Bitte das gemeinsame Passwort verwenden.');
      return;
    }
    const local = readLegacyPlan() || await readEncryptedDraft();
    if (local && local.passwordReady) {
      plan = local;
      await showWorkspace();
      setStatus('Nextcloud ist gerade nicht erreichbar. Gezeigt werden die zuletzt auf diesem Gerät bekannten Einträge.', true);
      return;
    }
    showLogin(explainError(error));
  }
}
function showNewPassword() {
  workspaceReady = false;
  lockAdmin();
  $('admin-panel').hidden = true;
  $('workspace').hidden = true;
  $('extra-actions').hidden = true;
  $('setup-panel').hidden = false;
  $('new-password-form').hidden = false;
  $('setup-title').textContent = 'Neues gemeinsames Passwort';
}

function lockAdmin() {
  const tools = $('admin-tools');
  const gate = $('admin-gate-form');
  const errorEl = $('admin-error');
  const field = $('admin-pass');
  if (tools) tools.hidden = true;
  if (gate) gate.hidden = false;
  if (errorEl) errorEl.hidden = true;
  if (field) field.value = '';
}

function openAdmin() {
  lockAdmin();
  $('workspace').hidden = true;
  $('admin-panel').hidden = false;
  $('admin-pass').focus();
}

function closeAdmin() {
  $('admin-panel').hidden = true;
  lockAdmin();
  if ($('setup-panel').hidden) $('workspace').hidden = false;
}

function onAdminUnlock(event) {
  event.preventDefault();
  const typed = new TextEncoder().encode($('admin-pass').value);
  const current = new TextEncoder().encode(sessionPassword());
  $('admin-pass').value = '';
  const errorEl = $('admin-error');
  if (!current.length || !bytesEqual(typed, current)) {
    errorEl.textContent = 'Das Passwort ist nicht korrekt.';
    errorEl.hidden = false;
    return;
  }
  $('admin-gate-form').hidden = true;
  $('admin-tools').hidden = false;
}

async function showWorkspace(message) {
  $('setup-panel').hidden = true;
  $('admin-panel').hidden = true;
  lockAdmin();
  $('workspace').hidden = false;
  $('extra-actions').hidden = false;
  workspaceReady = true;
  renderEntries();
  if (message) setStatus(message);
  updateSyncNote();
  startSync();
  await saveDraft();
}

function clearSession() {
  sessionStorage.removeItem(AUTH_KEY);
  sessionStorage.removeItem(PASS_KEY);
  resetKeyCache();
  preloaded = { ready: false, plan: null };
}

async function onSetPassword(event) {
  event.preventDefault();
  const first = $('new-pass').value;
  const second = $('new-pass-2').value;
  const errorEl = $('new-pass-error');
  errorEl.hidden = true;
  if (first.length < 8) {
    errorEl.textContent = 'Das Passwort braucht mindestens 8 Zeichen.';
    errorEl.hidden = false;
    return;
  }
  if (first !== second) {
    errorEl.textContent = 'Die beiden Passwörter stimmen nicht überein.';
    errorEl.hidden = false;
    return;
  }
  if (await passwordMatches(first) || first === sessionPassword()) {
    errorEl.textContent = 'Bitte ein anderes Passwort als das bisherige wählen.';
    errorEl.hidden = false;
    return;
  }
  const button = event.submitter;
  button.disabled = true;
  setStatus('Einträge werden abgeglichen …');
  try {
    const remote = await loadMerged();
    if (remote) plan = mergePlans(remote, plan || emptyPlan());
  } catch (error) {
    button.disabled = false;
    errorEl.textContent = explainError(error);
    errorEl.hidden = false;
    return;
  }
  const previousPassword = sessionPassword();
  const previousSalt = activeSalt;
  sessionStorage.setItem(PASS_KEY, first);
  resetKeyCache();
  activeSalt = crypto.getRandomValues(new Uint8Array(16));
  plan.passwordReady = true;
  rememberLegacy();
  setStatus('Passwort wird gespeichert …');
  try {
    await saveShared('Das neue Passwort gilt jetzt auf allen Geräten. Bitte nur an Lehrkräfte weitergeben.', { replace: true });
    $('new-pass').value = '';
    $('new-pass-2').value = '';
    preloaded = { ready: true, plan };
    await showWorkspace();
  } catch (error) {
    sessionStorage.setItem(PASS_KEY, previousPassword);
    activeSalt = previousSalt;
    resetKeyCache();
    setStatus(explainError(error), true);
  } finally {
    button.disabled = false;
  }
}

function openPasswordDialog() {
  $('pw-error').hidden = true;
  $('pw-1').value = '';
  $('pw-2').value = '';
  $('password-dialog').hidden = false;
  $('pw-1').focus();
}

function closePasswordDialog() {
  $('password-dialog').hidden = true;
}

async function onChangePassword(event) {
  event.preventDefault();
  const first = $('pw-1').value;
  const second = $('pw-2').value;
  const errorEl = $('pw-error');
  errorEl.hidden = true;
  if (first.length < 8) {
    errorEl.textContent = 'Das Passwort braucht mindestens 8 Zeichen.';
    errorEl.hidden = false;
    return;
  }
  if (first !== second) {
    errorEl.textContent = 'Die beiden Passwörter stimmen nicht überein.';
    errorEl.hidden = false;
    return;
  }
  if (first === sessionPassword() || await passwordMatches(first)) {
    errorEl.textContent = 'Bitte ein neues Passwort wählen.';
    errorEl.hidden = false;
    return;
  }
  if (!confirm('Neues Passwort jetzt für alle Geräte speichern? Die anderen Lehrkräfte brauchen danach dieses Passwort.')) return;
  const button = event.submitter;
  button.disabled = true;
  try {
    const remote = await loadMerged();
    if (remote) plan = mergePlans(remote, plan || emptyPlan());
  } catch (error) {
    button.disabled = false;
    errorEl.textContent = explainError(error);
    errorEl.hidden = false;
    return;
  }
  const previousPassword = sessionPassword();
  const previousSalt = activeSalt;
  sessionStorage.setItem(PASS_KEY, first);
  resetKeyCache();
  activeSalt = crypto.getRandomValues(new Uint8Array(16));
  plan.passwordReady = true;
  try {
    await saveShared('Das gemeinsame Passwort wurde geändert. Bitte die anderen Lehrkräfte informieren.', { replace: true });
    closePasswordDialog();
  } catch (error) {
    sessionStorage.setItem(PASS_KEY, previousPassword);
    activeSalt = previousSalt;
    resetKeyCache();
    errorEl.textContent = explainError(error);
    errorEl.hidden = false;
  } finally {
    button.disabled = false;
  }
}

function addEntry(event) {
  event.preventDefault();
  const name = teacherName();
  if (!name) {
    setStatus('Bitte zuerst deinen Namen angeben.', true);
    $('teacher-name').focus();
    return;
  }
  saveTeacherName();
  const now = new Date().toISOString();
  plan.entries.push({
    id: uid(),
    date: $('e-date').value,
    time: $('e-time').value || '',
    className: $('e-class').value.trim(),
    studentName: $('e-student').value.trim(),
    reason: $('e-reason').value.trim(),
    workMaterial: $('e-material').value.trim(),
    room: $('e-room').value.trim(),
    parentsNotified: $('e-parents').checked,
    done: false,
    createdAt: now,
    createdBy: name,
    updatedAt: now,
    deleted: false,
    excludeFromStats: false,
  });
  plan.updatedAt = now;
  plan.updatedBy = name;
  plan.passwordReady = true;
  $('entry-form').reset();
  $('e-date').value = todayISO();
  $('e-time').value = '13:30';
  $('e-room').value = DEFAULT_ROOM;
  queueSave('Eintrag hinzugefügt.');
}

function onEntriesClick(event) {
  const action = event.target.getAttribute('data-action');
  if (action !== 'delete') return;
  const row = event.target.closest('tr[data-id]');
  if (!row) return;
  const id = row.getAttribute('data-id');
  const entry = plan.entries.find((item) => item.id === id);
  if (!entry) return;
  if (!confirm(`Eintrag zu „${entry.studentName}“ wirklich löschen?`)) return;
  entry.deleted = true;
  touch(entry);
  queueSave('Eintrag gelöscht.');
}

function onEntriesChange(event) {
  const action = event.target.getAttribute('data-action');
  if (action !== 'toggle' && action !== 'parents') return;
  const row = event.target.closest('tr[data-id]');
  if (!row) return;
  const entry = plan.entries.find((item) => item.id === row.getAttribute('data-id'));
  if (!entry) return;
  if (action === 'toggle') {
    entry.done = event.target.checked;
    touch(entry);
    queueSave('Status geändert.');
  }
  if (action === 'parents') {
    entry.parentsNotified = event.target.checked;
    touch(entry);
    queueSave('Hinweis zu den Eltern gespeichert.');
  }
}

function resetStats() {
  if (!confirm('Wollen Sie wirklich die Statistik zurücksetzen?')) return;
  const now = new Date().toISOString();
  plan.entries.forEach((entry) => {
    if (entry.deleted || entry.excludeFromStats) return;
    entry.excludeFromStats = true;
    entry.updatedAt = now;
  });
  plan.updatedAt = now;
  plan.updatedBy = teacherName() || plan.updatedBy;
  queueSave('Statistik wurde zurückgesetzt.');
  renderStats();
}

function downloadBackup() {
  const blob = new Blob([JSON.stringify(plan, null, 2)], { type: 'application/json' });
  const link = document.createElement('a');
  link.href = URL.createObjectURL(blob);
  link.download = 'nachsitzplan-sicherung.json';
  link.click();
  URL.revokeObjectURL(link.href);
}

async function onRestore(event) {
  const file = event.target.files && event.target.files[0];
  event.target.value = '';
  if (!file) return;
  if (!confirm('Diese Sicherung ersetzt die Liste für alle Geräte. Fortfahren?')) return;
  try {
    const data = JSON.parse(await file.text());
    const loaded = normalizePlan(data.plan || data);
    loaded.passwordReady = true;
    loaded.updatedAt = new Date().toISOString();
    loaded.updatedBy = teacherName() || loaded.updatedBy;
    plan = loaded;
    queueSave('Die Sicherung wurde für alle Geräte übernommen.', { replace: true });
  } catch {
    setStatus('Die Sicherung konnte nicht gelesen werden.', true);
  }
}

let pollSeq = 0;

async function poll() {
  if (!workspaceReady || inPush || pendingSaves || document.hidden) return;
  const seq = ++pollSeq;
  const seen = planVersion;
  try {
    const remote = await loadMerged();
    if (seq !== pollSeq || !remote || pendingSaves || inPush) return;
    const merged = mergePlans(remote, plan);
    const changedLocally = seen !== planVersion;
    const changed = entriesSignature(merged) !== entriesSignature(plan);
    if (!changed) {
      updateSyncNote();
      return;
    }
    plan = merged;
    if (!changedLocally) planVersion += 1;
    await saveDraft();
    renderEntries();
    if (!$('stats-dialog').hidden) renderStats();
    const needsPush = entriesSignature(merged) !== entriesSignature(remote);
    if (needsPush && !pendingSaves && !inPush) {
      queueSave('Änderungen von beiden Geräten wurden zusammengeführt.');
      return;
    }
    setStatus(changedLocally
      ? 'Änderungen von beiden Geräten wurden zusammengeführt.'
      : 'Neue Änderungen von anderen Geräten wurden geladen.');
    updateSyncNote();
  } catch (error) {
    if (error.message === 'decrypt') {
      clearSession();
      showLogin('Das Passwort wurde geändert. Bitte mit dem neuen gemeinsamen Passwort anmelden.');
    }
  }
}

function startSync() {
  if (pollStarted) return;
  pollStarted = true;
  setInterval(() => { poll(); }, 15000);
  document.addEventListener('visibilitychange', () => {
    if (!document.hidden) poll();
  });
}

function bind() {
  $('entry-form').addEventListener('submit', addEntry);
  $('new-password-form').addEventListener('submit', onSetPassword);
  $('password-form').addEventListener('submit', onChangePassword);
  $('btn-admin').addEventListener('click', openAdmin);
  $('btn-admin-back').addEventListener('click', closeAdmin);
  $('admin-gate-form').addEventListener('submit', onAdminUnlock);
  $('btn-password').addEventListener('click', openPasswordDialog);
  $('pw-cancel').addEventListener('click', closePasswordDialog);
  $('password-dialog').addEventListener('click', (event) => {
    if (event.target === $('password-dialog')) closePasswordDialog();
  });
  $('btn-stats').addEventListener('click', openStats);
  $('btn-stats-close').addEventListener('click', closeStats);
  $('btn-stats-reset').addEventListener('click', resetStats);
  $('stats-dialog').addEventListener('click', (event) => {
    if (event.target === $('stats-dialog')) closeStats();
  });
  $('btn-backup').addEventListener('click', downloadBackup);
  $('backup-file').addEventListener('change', onRestore);
  $('teacher-name').addEventListener('change', saveTeacherName);
  $('entries-body').addEventListener('click', onEntriesClick);
  $('entries-body').addEventListener('change', onEntriesChange);
  $('f-date').addEventListener('change', renderEntries);
  $('f-class').addEventListener('input', renderEntries);
  $('f-open-only').addEventListener('change', renderEntries);
  $('btn-clear-filters').addEventListener('click', () => {
    $('f-date').value = '';
    $('f-class').value = '';
    $('f-open-only').checked = true;
    renderEntries();
  });
}

function openShell() {
  $('login-gate').hidden = true;
  $('app').hidden = false;
  if (started) return;
  started = true;
  bind();
  loadTeacherName();
  $('e-date').value = todayISO();
  $('e-room').value = DEFAULT_ROOM;
}

async function onLogin(event) {
  event.preventDefault();
  const user = $('login-user').value.trim();
  const pass = $('login-pass').value;
  const button = $('login-submit');
  $('login-error').hidden = true;
  if (user !== AUTH_USER || !pass) {
    $('login-error').textContent = 'Benutzername oder Passwort ist nicht korrekt.';
    $('login-error').hidden = false;
    return;
  }
  button.disabled = true;
  button.textContent = 'Wird geprüft …';
  try {
    if (!isConfigured()) {
      if (!(await passwordMatches(pass))) {
        $('login-error').textContent = 'Benutzername oder Passwort ist nicht korrekt.';
        $('login-error').hidden = false;
        $('login-pass').value = '';
        return;
      }
      sessionStorage.setItem(PASS_KEY, pass);
      sessionStorage.setItem(AUTH_KEY, '1');
      $('login-pass').value = '';
      preloaded = { ready: false, plan: null };
      openShell();
      await routeAfterLogin();
      return;
    }

    sessionStorage.setItem(PASS_KEY, pass);
    resetKeyCache();
    activeSalt = null;
    try {
      const remote = await loadMerged();
      if (!remote && !(await passwordMatches(pass))) {
        clearSession();
        $('login-error').textContent = 'Benutzername oder Passwort ist nicht korrekt.';
        $('login-error').hidden = false;
        $('login-pass').value = '';
        return;
      }
      sessionStorage.setItem(AUTH_KEY, '1');
      $('login-pass').value = '';
      preloaded = { ready: true, plan: remote };
      openShell();
      await routeAfterLogin();
    } catch (error) {
      if (error.message === 'decrypt') {
        const oldPassword = await passwordMatches(pass);
        clearSession();
        $('login-error').textContent = oldPassword
          ? 'Das bisherige Passwort gilt nicht mehr. Bitte das neue gemeinsame Passwort verwenden.'
          : 'Benutzername oder Passwort ist nicht korrekt.';
        $('login-error').hidden = false;
        $('login-pass').value = '';
        return;
      }
      clearSession();
      $('login-error').textContent = explainError(error);
      $('login-error').hidden = false;
    }
  } finally {
    button.disabled = false;
    button.textContent = 'Anmelden';
  }
}

$('login-form').addEventListener('submit', onLogin);

if (sessionStorage.getItem(AUTH_KEY) === '1' && sessionPassword()) {
  openShell();
  routeAfterLogin();
}
