const LOCAL_KEY = 'nachsitzplan_iserv_draft_v1';
const TEACHER_KEY = 'nachsitzplan_teacher_name';
const AUTH_KEY = 'nachsitzplan_auth';
const AUTH_USER = 'Lehrkraft';
const AUTH_PASS = 'LernbüroWSS';
const DEFAULT_ROOM = 'BK-Saal';

let plan = emptyPlan();

function emptyPlan() {
  return {
    version: 1,
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
  el.innerHTML = message || '';
  el.classList.toggle('error-text', !!isError);
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

function saveDraft() {
  localStorage.setItem(
    LOCAL_KEY,
    JSON.stringify({
      plan,
      savedAt: new Date().toISOString(),
    })
  );
}

function loadDraft() {
  try {
    const raw = localStorage.getItem(LOCAL_KEY);
    if (!raw) return false;
    const data = JSON.parse(raw);
    plan = normalizePlan(data.plan);
    return true;
  } catch {
    return false;
  }
}

function normalizePlan(data) {
  if (!data || typeof data !== 'object') return emptyPlan();
  return {
    version: 1,
    updatedAt: data.updatedAt || null,
    updatedBy: data.updatedBy || null,
    entries: Array.isArray(data.entries) ? data.entries : [],
  };
}

function filteredEntries() {
  const date = $('f-date').value;
  const klass = $('f-class').value.trim().toLowerCase();
  const openOnly = $('f-open-only').checked;

  return [...plan.entries]
    .filter((entry) => {
      if (openOnly && entry.done) return false;
      if (date && entry.date !== date) return false;
      if (klass && String(entry.className || '').toLowerCase() !== klass) return false;
      return true;
    })
    .sort((a, b) => {
      const byDate = String(a.date || '').localeCompare(String(b.date || ''));
      if (byDate !== 0) return byDate;
      return String(a.time || '').localeCompare(String(b.time || ''));
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

function markDirty(message) {
  saveDraft();
  renderEntries();
  setStatus(message || 'Gespeichert.');
}

function nameKey(name) {
  return String(name || '').trim().replace(/\s+/g, ' ').toLocaleLowerCase('de');
}

function studentStats() {
  const groups = new Map();
  plan.entries.forEach((entry) => {
    if (entry.excludeFromStats) return;
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
  return [...groups.values()].sort((a, b) => b.count - a.count || a.name.localeCompare(b.name, 'de'));
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

function resetStats() {
  if (!confirm('Wollen Sie wirklich die Statistik zurücksetzen?')) return;
  plan.entries.forEach((entry) => {
    entry.excludeFromStats = true;
  });
  saveDraft();
  renderStats();
  setStatus('Statistik wurde zurückgesetzt.');
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
    createdAt: new Date().toISOString(),
    createdBy: name,
  });

  $('entry-form').reset();
  $('e-date').value = todayISO();
  $('e-time').value = '13:30';
  $('e-room').value = DEFAULT_ROOM;
  markDirty('Eintrag hinzugefügt.');
}

function onEntriesClick(event) {
  const row = event.target.closest('tr[data-id]');
  if (!row) return;
  const id = row.getAttribute('data-id');
  const entry = plan.entries.find((item) => item.id === id);
  if (!entry) return;

  const action = event.target.getAttribute('data-action');
  if (action === 'toggle') {
    entry.done = event.target.checked;
    markDirty('Status geändert.');
  }
  if (action === 'parents') {
    entry.parentsNotified = event.target.checked;
    markDirty('Hinweis zu den Eltern gespeichert.');
  }
  if (action === 'delete') {
    if (!confirm(`Eintrag zu „${entry.studentName}“ wirklich löschen?`)) return;
    plan.entries = plan.entries.filter((item) => item.id !== id);
    markDirty('Eintrag gelöscht.');
  }
}

function bind() {
  $('entry-form').addEventListener('submit', addEntry);
  $('btn-stats').addEventListener('click', openStats);
  $('btn-stats-close').addEventListener('click', closeStats);
  $('btn-stats-reset').addEventListener('click', resetStats);
  $('stats-dialog').addEventListener('click', (event) => {
    if (event.target === $('stats-dialog')) closeStats();
  });
  $('teacher-name').addEventListener('change', saveTeacherName);
  $('entries-body').addEventListener('click', onEntriesClick);
  $('entries-body').addEventListener('change', onEntriesClick);
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

function isAuthed() {
  return sessionStorage.getItem(AUTH_KEY) === '1';
}

function onLogin(event) {
  event.preventDefault();
  const user = $('login-user').value.trim();
  const pass = $('login-pass').value;
  if (user === AUTH_USER && pass === AUTH_PASS) {
    sessionStorage.setItem(AUTH_KEY, '1');
    $('login-error').hidden = true;
    openApp();
    return;
  }
  $('login-error').hidden = false;
  $('login-pass').value = '';
  $('login-pass').focus();
}

let appStarted = false;

function openApp() {
  $('login-gate').hidden = true;
  $('app').hidden = false;
  if (appStarted) return;
  appStarted = true;
  boot();
}

function boot() {
  bind();
  loadTeacherName();
  $('e-date').value = todayISO();
  $('e-room').value = DEFAULT_ROOM;

  if (loadDraft() && plan.entries.length) {
    setStatus('Gespeicherte Einträge wurden geladen.');
  }
  renderEntries();
}

$('login-form').addEventListener('submit', onLogin);

if (isAuthed()) {
  openApp();
}
