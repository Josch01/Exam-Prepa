// ============================================================
//  ExamApp — app.js  (v2: API + JWT + Filtros + Multi-admin)
// ============================================================

// ===== ESTADO GLOBAL =====
let currentUser = null;
let currentToken = null;
let activeExam = null;   // examen en curso (con respuestas correctas)
let examState = {};
let editingExamId = null;
let questionCount = 0;

// Cache para el panel admin (evita múltiples fetches al filtrar)
let cachedStudents = [];
let cachedExams = [];

// Timer del examen
let examTimerInterval = null;
let examTimeRemaining = 0;

// ===== HELPER LATEX & TEXTO =====
/**
 * Escapa HTML, convierte `\\` o `\n` en `<br>`, y `\rule{...}{...}` en líneas de relleno.
 * Luego permite que KaTeX (renderMathInElement) procese la salida final.
 */
function formatLatexText(text) {
  if (!text) return '';

  // ── PASO 1: Extraer y proteger todos los bloques de matemáticas ──
  // Los guardamos en un arreglo y los reemplazamos con placeholders
  // para que NINGUNA transformación de texto los toque.
  const mathBlocks = [];
  let safe = text;

  // $$...$$ (display math con dólares) — primero para no confundir con $
  safe = safe.replace(/\$\$[\s\S]+?\$\$/g, m => { mathBlocks.push(m); return `\x00MATH${mathBlocks.length - 1}\x00`; });
  // \[...\] (display math con corchetes)
  safe = safe.replace(/\\\[[\s\S]+?\\\]/g, m => { mathBlocks.push(m); return `\x00MATH${mathBlocks.length - 1}\x00`; });
  // $...$ (inline math con dólares)
  safe = safe.replace(/\$[^\$]+?\$/g, m => { mathBlocks.push(m); return `\x00MATH${mathBlocks.length - 1}\x00`; });
  // \(...\) (inline math con paréntesis)
  safe = safe.replace(/\\\([\s\S]+?\\\)/g, m => { mathBlocks.push(m); return `\x00MATH${mathBlocks.length - 1}\x00`; });

  // ── PASO 2: Procesar texto NO-matemático de forma segura ──
  // Escapar HTML básico para seguridad (XSS)
  safe = safe.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // \rule{...}{...} → línea de relleno visual
  safe = safe.replace(/\\rule\{[^}]+\}\{[^}]+\}/g,
    '<span style="display:inline-block;border-bottom:1px solid currentColor;min-width:3rem;margin:0 4px;"></span>');

  // \textbf, \textit, \underline → HTML (usando función para no dañar $ en el texto)
  safe = safe.replace(/\\textbf\{([^}]+)\}/g, (m, p1) => `<strong>${p1}</strong>`);
  safe = safe.replace(/\\textit\{([^}]+)\}/g, (m, p1) => `<em>${p1}</em>`);
  safe = safe.replace(/\\underline\{([^}]+)\}/g, (m, p1) => `<u>${p1}</u>`);

  // \\ (doble barra = salto de línea LaTeX) o \n real → <br>
  safe = safe.replace(/\\\\/g, '<br>').replace(/\n/g, '<br>');

  // ── PASO 3: Restaurar bloques de matemáticas intactos ──
  safe = safe.replace(/\x00MATH(\d+)\x00/g, (m, idx) => mathBlocks[parseInt(idx)]);

  return safe;
}

// ===== ORDENAMIENTO NATURAL =====
/** Compara dos strings tratando los números embebidos como valores numéricos.
 *  Ej: "Módulo 5" < "Módulo 10" < "Módulo 11" (en lugar de 10 < 11 < 5). */
function naturalSort(a, b) {
  const re = /(\d+)/g;
  const aParts = String(a).split(re);
  const bParts = String(b).split(re);
  for (let i = 0; i < Math.max(aParts.length, bParts.length); i++) {
    const ax = aParts[i] || '', bx = bParts[i] || '';
    // Si ambas partes son números, comparar numéricamente
    if (/^\d+$/.test(ax) && /^\d+$/.test(bx)) {
      const diff = parseInt(ax) - parseInt(bx);
      if (diff !== 0) return diff;
    } else {
      const cmp = ax.localeCompare(bx, 'es', { sensitivity: 'base' });
      if (cmp !== 0) return cmp;
    }
  }
  return 0;
}

// ===== SUPABASE CLIENT & API MAPPER =====
const supabaseUrl = 'https://mbqtdmioromvsovqzxck.supabase.co';
const supabaseKey = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Im1icXRkbWlvcm9tdnNvdnF6eGNrIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NzI4Mzc1NjEsImV4cCI6MjA4ODQxMzU2MX0.eGcA-Q1MPovQAm73OxY6a4k_TFmiCZpSGCFhVfd9yQk';
const supabaseClient = window.supabase.createClient(supabaseUrl, supabaseKey);

async function api(method, endpoint, body) {
  try {
    const isStudent = currentUser?.role === 'student';
    const email = currentUser?.email;

    // === AUTH ===
    if (endpoint === '/api/auth/login') {
      const { data, error } = await supabaseClient.auth.signInWithPassword({ email: body.email, password: body.password });
      if (error) throw new Error('Correo o contraseña incorrectos');
      const { data: p } = await supabaseClient.from('profiles').select('*').eq('email', body.email.toLowerCase()).single();
      return { token: data.session.access_token, user: { ...p, allowedExams: p.allowed_exams || [] } };
    }
    if (endpoint === '/api/auth/register') {
      const { data, error } = await supabaseClient.auth.signUp({ email: body.email, password: body.password });
      if (error) throw new Error(error.message);
      await supabaseClient.from('profiles').insert({ email: body.email.toLowerCase(), name: body.name, role: 'student', section: '', allowed_exams: [] });
      return { token: data.session.access_token, user: { email: body.email.toLowerCase(), name: body.name, role: 'student', allowedExams: [] } };
    }
    if (endpoint === '/api/auth/me') {
      const { data: { user } } = await supabaseClient.auth.getUser();
      if (!user) throw new Error('Sesión expirada');
      const { data: p } = await supabaseClient.from('profiles').select('*').eq('email', user.email).single();
      return { ...p, allowedExams: p.allowed_exams || [] };
    }
    if (endpoint === '/api/auth/password') {
      const { error } = await supabaseClient.auth.updateUser({ password: body.newPass });
      if (error) throw new Error(error.message);
      return { ok: true };
    }

    // === USERS ===
    if (endpoint === '/api/users' && method === 'GET') {
      let q = supabaseClient.from('profiles').select('*');
      if (currentUser?.role !== 'superadmin') q = q.eq('role', 'student');
      else q = q.neq('role', 'superadmin');
      const { data, error } = await q;
      if (error) throw error;
      return data.map(u => ({ ...u, allowedExams: u.allowed_exams || [] }));
    }
    if (endpoint.startsWith('/api/users/') && method === 'PUT') {
      const split = endpoint.split('/');
      const targetEmail = decodeURIComponent(split[3]);
      const action = split[4];
      let err = null;
      if (action === 'role') {
        const { error } = await supabaseClient.from('profiles').update({ role: body.role }).eq('email', targetEmail);
        err = error;
      }
      if (action === 'section') {
        const { error } = await supabaseClient.from('profiles').update({ section: body.section }).eq('email', targetEmail);
        err = error;
      }
      if (action === 'permissions') {
        const { error } = await supabaseClient.from('profiles').update({ allowed_exams: body.allowedExams }).eq('email', targetEmail);
        err = error;
      }
      if (err) throw err;
      return { ok: true };
    }
    if (endpoint.startsWith('/api/users/') && method === 'DELETE') {
      const targetEmail = decodeURIComponent(endpoint.split('/')[3]);
      await supabaseClient.from('profiles').delete().eq('email', targetEmail);
      await supabaseClient.from('logs').delete().eq('student_email', targetEmail);
      return { ok: true };
    }

    // === EXAMS ===
    if (endpoint === '/api/exams' && method === 'GET') {
      const { data: exams, error } = await supabaseClient.from('exams').select('*').order('created_at', { ascending: false });
      if (error) throw error;
      if (isStudent) {
        // Always re-fetch allowed_exams from DB to reflect any admin changes
        const { data: profile } = await supabaseClient.from('profiles').select('allowed_exams').eq('email', email).single();
        const freshAllowed = profile?.allowed_exams || [];
        const { data: logs } = await supabaseClient.from('logs').select('exam_id').eq('student_email', email);
        return exams.map(e => {
          e.allowed = freshAllowed.includes(e.id);
          e.attempts_used = logs.filter(l => l.exam_id === e.id).length;
          return e;
        });
      }
      return exams;
    }
    if (endpoint.match(/^\/api\/exams\/([^/]+)$/) && method === 'GET') {
      const id = endpoint.split('/')[3];
      const { data: exam, error } = await supabaseClient.from('exams').select('*').eq('id', id).single();
      if (error) throw error;
      if (isStudent) {
        // Always re-fetch allowed_exams from DB
        const { data: profile } = await supabaseClient.from('profiles').select('allowed_exams').eq('email', email).single();
        const freshAllowed = profile?.allowed_exams || [];
        const { count } = await supabaseClient.from('logs').select('*', { count: 'exact', head: true }).eq('student_email', email).eq('exam_id', id);
        exam.attempts_used = count || 0;
        exam.allowed = freshAllowed.includes(id);
      }
      return exam;
    }
    if (endpoint === '/api/exams' && method === 'POST') {
      const id = 'exam-' + Date.now();
      await supabaseClient.from('exams').insert({ id, ...body });
      return { id };
    }
    if (endpoint.match(/^\/api\/exams\/([^/]+)$/) && method === 'PUT') {
      const id = endpoint.split('/')[3];
      await supabaseClient.from('exams').update(body).eq('id', id);
      return { ok: true };
    }
    if (endpoint.match(/^\/api\/exams\/([^/]+)$/) && method === 'DELETE') {
      const id = endpoint.split('/')[3];
      await supabaseClient.from('exams').delete().eq('id', id);
      await supabaseClient.from('logs').delete().eq('exam_id', id);
      return { ok: true };
    }

    // === LOGS ===
    if (endpoint === '/api/logs' && method === 'POST') {
      await supabaseClient.from('logs').insert({ student_email: email, exam_id: body.examId, score: body.score, pct: body.pct });
      return { ok: true };
    }
    if (endpoint === '/api/logs' && method === 'GET') {
      let q = supabaseClient.from('logs').select('*').order('date', { ascending: false });
      if (isStudent) q = q.eq('student_email', email);
      const { data, error } = await q;
      if (error) throw error;
      return data;
    }

    // === MATERIAL ===
    if (endpoint === '/api/material' && method === 'GET') {
      const { data } = await supabaseClient.from('material').select('*').order('sort_order', { ascending: true });
      if (!isStudent) return data;
      const allowed = currentUser.allowedExams || [];
      const { data: exams } = await supabaseClient.from('exams').select('id, title');
      const allowedTitles = new Set(
        (exams || []).filter(e => allowed.includes(e.id)).map(e => e.title)
      );
      return data.filter(m => allowedTitles.has(m.title));
    }
    if (endpoint === '/api/material' && method === 'POST') {
      const id = 'mat-' + Date.now();
      await supabaseClient.from('material').insert({ id, ...body });
      return { id };
    }
    if (endpoint.startsWith('/api/material/') && method === 'PUT') {
      const id = endpoint.split('/')[3];
      await supabaseClient.from('material').update(body).eq('id', id);
      return { ok: true };
    }
    if (endpoint.startsWith('/api/material/') && method === 'DELETE') {
      const id = endpoint.split('/')[3];
      await supabaseClient.from('material').delete().eq('id', id);
      return { ok: true };
    }

    // === ANNOUNCEMENTS ===
    if (endpoint === '/api/announcements' && method === 'GET') {
      let q = supabaseClient.from('announcements').select('*').order('created_at', { ascending: false });
      if (isStudent) q = q.eq('active', true);
      const { data } = await q;
      return data;
    }
    if (endpoint === '/api/announcements' && method === 'POST') {
      const id = 'ann-' + Date.now();
      await supabaseClient.from('announcements').insert({ id, ...body, created_by: email });
      return { id };
    }
    if (endpoint.startsWith('/api/announcements/') && method === 'PUT') {
      const id = endpoint.split('/')[3];
      await supabaseClient.from('announcements').update(body).eq('id', id);
      return { ok: true };
    }
    if (endpoint.startsWith('/api/announcements/') && method === 'DELETE') {
      const id = endpoint.split('/')[3];
      await supabaseClient.from('announcements').delete().eq('id', id);
      return { ok: true };
    }

    // === MESSAGES / TEACHERS ===
    if (endpoint === '/api/teachers' && method === 'GET') {
      const { data } = await supabaseClient.from('profiles').select('name, email, role').in('role', ['admin', 'superadmin']).order('name');
      return data;
    }
    if (endpoint.startsWith('/api/messages/') && method === 'GET') {
      const type = endpoint.split('/')[3];
      if (type === 'inbox') {
        const { data: msgs } = await supabaseClient.from('messages').select('*').eq('to_email', email).order('created_at', { ascending: false });
        if (!msgs || msgs.length === 0) return [];
        // Enrich with sender profile info
        const senderEmails = [...new Set(msgs.map(m => m.from_email))];
        const { data: profiles } = await supabaseClient.from('profiles').select('name, section, email').in('email', senderEmails);
        const profileMap = {};
        (profiles || []).forEach(p => { profileMap[p.email] = p; });
        return msgs.map(m => ({ ...m, from_name: profileMap[m.from_email]?.name || m.from_email, from_section: profileMap[m.from_email]?.section || '' }));
      }
      if (type === 'unread') {
        const { count } = await supabaseClient.from('messages').select('*', { count: 'exact', head: true }).eq('to_email', email).eq('is_read', false).eq('archived', false);
        return { count: count || 0 };
      }
    }
    if (endpoint === '/api/messages' && method === 'POST') {
      await supabaseClient.from('messages').insert({ ...body, from_email: email });
      return { ok: true };
    }
    if (endpoint.startsWith('/api/messages/') && method === 'PUT') {
      const split = endpoint.split('/');
      const id = split[3];
      const action = split[4];
      if (action === 'read') {
        await supabaseClient.from('messages').update({ is_read: true }).eq('id', id);
      }
      if (action === 'archive') {
        // body.archived can be true (archive) or false (unarchive/move back to inbox)
        const archiveValue = body?.archived !== undefined ? body.archived : true;
        await supabaseClient.from('messages').update({ archived: archiveValue }).eq('id', id);
      }
      return { ok: true };
    }
    if (endpoint === '/api/messages/bulk' && method === 'DELETE') {
      const { ids, all, archived } = body || {};
      let q = supabaseClient.from('messages').delete().eq('to_email', email);
      if (all) {
        if (archived !== undefined) q = q.eq('archived', archived);
      } else if (Array.isArray(ids) && ids.length) {
        q = q.in('id', ids);
      }
      await q;
      return { ok: true };
    }
    if (endpoint.startsWith('/api/messages/') && method === 'DELETE') {
      const id = endpoint.split('/')[3];
      await supabaseClient.from('messages').delete().eq('id', id).eq('to_email', email);
      return { ok: true };
    }

    // === ANALYTICS & LEADERBOARD ===
    if (endpoint === '/api/leaderboard' && method === 'GET') {
      const { data: logs } = await supabaseClient.from('logs').select('*');
      const { data: users } = await supabaseClient.from('profiles').select('*').eq('role', 'student');
      const stats = {};
      users.forEach(u => { stats[u.email] = { name: u.name, email: u.email, section: u.section, attempts: 0, sum: 0, best_pct: 0 }; });
      logs.forEach(l => {
        const st = stats[l.student_email];
        if (st) {
          st.attempts++; st.sum += l.pct;
          if (l.pct > st.best_pct) st.best_pct = l.pct;
        }
      });
      return Object.values(stats)
        .filter(s => s.attempts > 0)
        .map(s => ({ ...s, avg_pct: Math.round((s.sum / s.attempts) * 10) / 10 }))
        .sort((a, b) => b.avg_pct - a.avg_pct)
        .slice(0, 50);
    }
    if (endpoint === '/api/analytics' && method === 'GET') {
      const { data: exams } = await supabaseClient.from('exams').select('*');
      const { data: logs } = await supabaseClient.from('logs').select('*').order('date', { ascending: false });

      const avgByExam = exams.map(e => {
        const examLogs = logs.filter(l => l.exam_id === e.id);
        const avg = examLogs.length ? Math.round(examLogs.reduce((a, l) => a + l.pct, 0) / examLogs.length) : 0;
        return { title: e.title, description: e.description || '', avg, attempts: examLogs.length, id: e.id };
      }).filter(e => e.attempts > 0);

      const dist = { excellent: 0, good: 0, needsWork: 0, failing: 0 };
      logs.forEach(l => {
        if (l.pct >= 90) dist.excellent++;
        else if (l.pct >= 70) dist.good++;
        else if (l.pct >= 40) dist.needsWork++;
        else dist.failing++;
      });

      const dailyMap = {};
      const now = new Date();
      for (let i = 29; i >= 0; i--) dailyMap[new Date(now.getTime() - i * 86400000).toISOString().slice(0, 10)] = 0;
      logs.forEach(l => {
        const day = l.date.slice(0, 10);
        if (dailyMap[day] !== undefined) dailyMap[day]++;
      });
      const timeline = Object.entries(dailyMap).map(([date, count]) => ({ date, count }));

      const hardest = [];
      exams.forEach(e => {
        const qs = e.questions || [];
        const examLogs = logs.filter(l => l.exam_id === e.id);
        if (examLogs.length < 2) return;
        qs.forEach((q, idx) => {
          hardest.push({
            examTitle: e.title, questionNum: idx + 1, questionText: q.text,
            examAvg: Math.round(examLogs.reduce((a, l) => a + l.pct, 0) / examLogs.length),
            attempts: examLogs.length
          });
        });
      });
      hardest.sort((a, b) => a.examAvg - b.examAvg);

      return {
        avgByExam, distribution: dist, timeline, hardestQuestions: hardest.slice(0, 10),
        totalLogs: logs.length, totalExams: exams.length
      };
    }

    throw new Error('Endpoint no implementado en Supabase: ' + method + ' ' + endpoint);
  } catch (err) {
    throw new Error(err.message || String(err));
  }
}

// ===== ROUTER =====
function showView(id) {
  document.querySelectorAll('.view').forEach(v => v.classList.remove('active'));
  const el = document.getElementById('view-' + id);
  if (el) el.classList.add('active');
}

// ===== AUTH =====
function switchAuthTab(tab) {
  document.getElementById('tab-login').classList.toggle('active', tab === 'login');
  document.getElementById('tab-register').classList.toggle('active', tab === 'register');
  document.getElementById('form-login').classList.toggle('hidden', tab !== 'login');
  document.getElementById('form-register').classList.toggle('hidden', tab !== 'register');
  clearErrors();
}

function clearErrors() {
  ['login-error', 'reg-error'].forEach(id => {
    const el = document.getElementById(id);
    if (el) { el.classList.add('hidden'); el.textContent = ''; }
  });
}

function showError(id, msg) {
  const el = document.getElementById(id);
  if (el) { el.textContent = msg; el.classList.remove('hidden'); }
}

async function handleLogin() {
  const email = document.getElementById('login-email').value.trim().toLowerCase();
  const password = document.getElementById('login-password').value;
  clearErrors();

  if (!email || !password) return showError('login-error', 'Por favor llena todos los campos.');

  try {
    const data = await api('POST', '/api/auth/login', { email, password });
    currentToken = data.token;
    currentUser = data.user;
    sessionStorage.setItem('examapp_token', currentToken);
    toast('¡Bienvenido/a, ' + currentUser.name + '!', 'success');
    routeUser();
  } catch (e) {
    showError('login-error', e.message);
  }
}

async function handleRegister() {
  const name = document.getElementById('reg-name').value.trim();
  const email = document.getElementById('reg-email').value.trim().toLowerCase();
  const password = document.getElementById('reg-password').value;
  clearErrors();

  if (!name || !email || !password) return showError('reg-error', 'Por favor llena todos los campos.');

  try {
    const data = await api('POST', '/api/auth/register', { name, email, password });
    currentToken = data.token;
    currentUser = data.user;
    sessionStorage.setItem('examapp_token', currentToken);
    toast('¡Cuenta creada! Bienvenido/a, ' + name + '.', 'success');
    routeUser();
  } catch (e) {
    showError('reg-error', e.message);
  }
}

function logout() {
  stopMessagePolling();
  currentUser = null;
  currentToken = null;
  activeExam = null;
  examState = {};
  cachedStudents = [];
  cachedExams = [];
  sessionStorage.removeItem('examapp_token');
  ['login-email', 'login-password', 'reg-name', 'reg-email', 'reg-password'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.value = '';
  });
  clearErrors();
  showView('auth');
  toast('Sesión cerrada.', 'info');
}

function routeUser() {
  if (!currentUser) { showView('auth'); return; }
  if (currentUser.role === 'student') {
    renderStudent();
    showView('student');
  } else {
    renderAdmin();
    showView('admin');
  }
}

function goHome() {
  stopExamTimer();
  if (!currentUser) { showView('auth'); return; }
  routeUser();
}

// ===== AVATAR =====
function initials(name) {
  return String(name || '?').split(' ').slice(0, 2).map(w => w[0]).join('').toUpperCase();
}

// ===== VISTA ALUMNO =====
async function renderStudent() {
  const u = currentUser;
  document.getElementById('student-avatar-sm').textContent = initials(u.name);
  document.getElementById('student-name-sm').textContent = u.name.split(' ')[0];
  document.getElementById('student-avatar-big').textContent = initials(u.name);
  document.getElementById('student-display-name').textContent = u.name;
  document.getElementById('student-display-email').textContent = u.email;
  document.getElementById('student-display-section').textContent = u.section ? '📌 ' + u.section : 'Sin sección asignada';

  const grid = document.getElementById('exams-grid');
  grid.innerHTML = '<div class="no-exams"><div class="no-exams-icon">⏳</div><p>Cargando exámenes...</p></div>';

  // Cargar material y anuncios en paralelo (no bloqueante)
  renderStudyMaterial();
  renderAnnouncements();
  syncThemeIcons();

  try {
    const [exams, logs] = await Promise.all([
      api('GET', '/api/exams'),
      api('GET', '/api/logs')
    ]);

    if (exams.length === 0) {
      grid.innerHTML = '<div class="no-exams"><div class="no-exams-icon">📭</div><p>No hay exámenes disponibles aún.</p></div>';
      return;
    }

    // Agrupar exámenes por título (módulo)
    const groups = {};
    const groupOrder = [];
    exams.forEach(exam => {
      if (!groups[exam.title]) { groups[exam.title] = []; groupOrder.push(exam.title); }
      groups[exam.title].push(exam);
    });

    // Ordenar módulos de forma natural (Módulo 5 → 10 → 11)
    groupOrder.sort(naturalSort);
    // Ordenar sub-items dentro de cada grupo por descripción
    Object.values(groups).forEach(g => g.sort((a, b) => naturalSort(a.description || '', b.description || '')));

    let html = '';
    groupOrder.forEach((title, gIdx) => {
      const g = groups[title];
      html += g.length === 1
        ? renderSingleExamCard(g[0], logs)
        : renderExamGroupCard(title, g, logs, gIdx);
    });
    grid.innerHTML = html || '<div class="no-exams"><div class="no-exams-icon">📫</div><p>No hay exámenes disponibles aún.</p></div>';
  } catch (e) {
    grid.innerHTML = `<div class="no-exams"><div class="no-exams-icon">⚠️</div><p>${e.message}</p></div>`;
  }
}

function lockedMsg() {
  toast('Este examen está bloqueado. Solicita permiso a tu profesor.', 'error');
}

function scoreTag(pct) {
  if (pct === 100) return `<span class="exam-score-badge score-perfect">⭐ 100%</span>`;
  if (pct >= 70) return `<span class="exam-score-badge score-high">✅ ${pct}%</span>`;
  if (pct >= 40) return `<span class="exam-score-badge score-mid">⚠️ ${pct}%</span>`;
  return `<span class="exam-score-badge score-low">❌ ${pct}%</span>`;
}

// ===== HELPERS DE AGRUPACIÓN =====
/** Extrae la etiqueta de unidad de la descripción ("Unidad 1: ...", "Unidad 2: ...") */
function extractUnit(description) {
  if (!description) return null;
  const m = description.match(/^(Unidad\s+\d+)/i);
  return m ? m[1] : null;
}

/** Tarjeta simple para exámenes únicos (sin agrupación) */
function renderSingleExamCard(exam, logs) {
  const myLogs = logs.filter(l => l.exam_id === exam.id);
  const lastLog = myLogs.length ? myLogs[0] : null;
  const scoreHtml = lastLog ? scoreTag(lastLog.pct) : '<span class="exam-score-badge score-none">Sin intentos</span>';
  return `
    <div class="exam-card ${!exam.allowed ? 'exam-locked' : ''}" onclick="${exam.allowed ? `startExam('${exam.id}')` : 'lockedMsg()'}">
      ${!exam.allowed ? '<span class="locked-badge">🔒 Bloqueado</span>' : ''}
      <div class="exam-card-icon">${exam.icon || '📋'}</div>
      <h3>${exam.title}</h3>
      <p>${exam.description || ''}</p>
      <div class="exam-card-footer">
        ${scoreHtml}
        <span style="font-size:0.8rem;color:var(--text-muted);">${exam.questions.length} preguntas</span>
      </div>
    </div>`;
}

/** Tarjeta colapsable para módulos con varias unidades */
function renderExamGroupCard(title, exams, logs, gIdx) {
  const icon = exams[0]?.icon || '📚';
  const anyAllowed = exams.some(e => e.allowed);

  const unitRows = exams.map(exam => {
    const unit = extractUnit(exam.description) || exam.description || '';
    const myLogs = logs.filter(l => l.exam_id === exam.id);
    const lastLog = myLogs.length ? myLogs[0] : null;
    const scoreHtml = lastLog ? scoreTag(lastLog.pct) : '<span class="exam-score-badge score-none">Sin intentos</span>';
    return `
      <div class="exam-unit-row ${!exam.allowed ? 'exam-locked' : ''}" onclick="${exam.allowed ? `startExam('${exam.id}')` : 'lockedMsg()'}">
        <div class="exam-unit-left">
          <span class="exam-unit-icon">${!exam.allowed ? '🔒' : '📝'}</span>
          <div>
            <div class="exam-unit-name">${unit}</div>
            ${!exam.allowed ? '<div class="exam-unit-status">Bloqueado</div>' : `<div class="exam-unit-questions">${exam.questions.length} preguntas</div>`}
          </div>
        </div>
        <div class="exam-unit-right">${scoreHtml}</div>
      </div>`;
  }).join('');

  return `
    <div class="exam-group-card">
      <div class="exam-group-header" onclick="toggleExamGroup(${gIdx})">
        <div class="exam-card-icon" style="margin-bottom:0;flex-shrink:0;">${icon}</div>
        <div class="exam-group-info">
          <h3>${title}</h3>
          <p>${exams.length} unidades · ${anyAllowed ? 'Alguna disponible' : 'Todas bloqueadas'}</p>
        </div>
        <span class="exam-group-arrow" id="group-arrow-${gIdx}">▼</span>
      </div>
      <div class="exam-group-body hidden" id="group-body-${gIdx}">
        ${unitRows}
      </div>
    </div>`;
}

/** Alterna expandir/colapsar un módulo */
function toggleExamGroup(gIdx) {
  const body = document.getElementById('group-body-' + gIdx);
  const arrow = document.getElementById('group-arrow-' + gIdx);
  if (!body) return;
  body.classList.toggle('hidden');
  if (arrow) arrow.style.transform = body.classList.contains('hidden') ? '' : 'rotate(180deg)';
}


// ===== EXAMEN =====
async function startExam(examId) {
  try {
    activeExam = await api('GET', `/api/exams/${examId}`);
  } catch (e) {
    toast(e.message, 'error'); return;
  }

  // Verificar límite de intentos
  if (activeExam.max_attempts > 0 && activeExam.attempts_used >= activeExam.max_attempts) {
    toast(`Alcanzaste el límite de ${activeExam.max_attempts} intento${activeExam.max_attempts !== 1 ? 's' : ''} para este examen.`, 'error');
    return;
  }

  // Mezclar preguntas si el examen tiene esa opción activa
  if (activeExam.shuffle) {
    for (let i = activeExam.questions.length - 1; i > 0; i--) {
      const j = Math.floor(Math.random() * (i + 1));
      [activeExam.questions[i], activeExam.questions[j]] = [activeExam.questions[j], activeExam.questions[i]];
    }
  }

  examState = {
    currentQ: 0, correct: 0, wrong: 0, answered: false, selectedIdx: null,
    questionResults: [],
    flagged: new Set(),      // índices de preguntas saltadas/flaggeadas
    answeredSet: new Set()   // índices de preguntas ya contestadas
  };

  document.getElementById('exam-nav-title').textContent = activeExam.title;
  document.getElementById('exam-question-view').classList.remove('hidden');
  document.getElementById('exam-results-view').classList.add('hidden');

  // ── Iniciar temporizador si el examen tiene límite de tiempo ──
  stopExamTimer();
  const timerEl = document.getElementById('exam-timer');
  if (activeExam.time_limit > 0) {
    examTimeRemaining = activeExam.time_limit * 60; // convertir a segundos
    timerEl.classList.remove('hidden');
    updateTimerDisplay();
    examTimerInterval = setInterval(updateExamTimer, 1000);
  } else {
    timerEl.classList.add('hidden');
  }

  renderQuestion();
  showView('exam');
}

/** Actualiza la cuenta regresiva del examen cada segundo */
function updateExamTimer() {
  examTimeRemaining--;
  if (examTimeRemaining <= 0) {
    examTimeRemaining = 0;
    stopExamTimer();
    toast('⏱️ ¡Tiempo agotado! El examen se envió automáticamente.', 'error');
    // Auto-responder preguntas sin contestar como incorrectas
    for (let i = 0; i < activeExam.questions.length; i++) {
      if (!examState.answeredSet.has(i)) {
        examState.wrong++;
        examState.questionResults.push({
          text: activeExam.questions[i].text,
          options: activeExam.questions[i].options,
          correct: activeExam.questions[i].correct,
          chosen: -1,
          isRight: false,
          justification: activeExam.questions[i].justification || '',
          image: activeExam.questions[i].image || ''
        });
        examState.answeredSet.add(i);
      }
    }
    examState.flagged.clear();
    showResults();
    return;
  }
  updateTimerDisplay();
}

/** Formatea y muestra el tiempo restante */
function updateTimerDisplay() {
  const min = Math.floor(examTimeRemaining / 60);
  const sec = examTimeRemaining % 60;
  const timerEl = document.getElementById('exam-timer');
  timerEl.textContent = `⏱️ ${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
  // Alerta visual cuando queda poco tiempo (≤60 segundos)
  if (examTimeRemaining <= 60) {
    timerEl.classList.add('timer-danger');
  } else if (examTimeRemaining <= 120) {
    timerEl.classList.add('timer-warning');
    timerEl.classList.remove('timer-danger');
  } else {
    timerEl.classList.remove('timer-warning', 'timer-danger');
  }
}

/** Detiene el temporizador del examen */
function stopExamTimer() {
  if (examTimerInterval) {
    clearInterval(examTimerInterval);
    examTimerInterval = null;
  }
}

function renderQuestion() {
  // Resetear estado ANTES de renderizar (evita botones disabled)
  examState.answered = false;
  examState.selectedIdx = null;

  const q = activeExam.questions[examState.currentQ];
  const tot = activeExam.questions.length;
  const cur = examState.currentQ + 1;

  document.getElementById('exam-progress-bar').style.width = `${((cur - 1) / tot) * 100}%`;
  document.getElementById('exam-counter').textContent = `Pregunta ${cur} de ${tot}`;
  document.getElementById('exam-score-live').textContent = `✅ ${examState.correct} / ❌ ${examState.wrong}`;
  document.getElementById('question-num-label').textContent = `Pregunta ${cur}`;
  document.getElementById('question-text').innerHTML = formatLatexText(q.text)
    + (q.image ? `<img src="${q.image}" alt="Imagen de la pregunta" class="question-image" />` : '');

  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  document.getElementById('options-list').innerHTML = q.options.map((opt, i) => `
    <button class="option-btn" id="opt-${i}" onclick="selectOption(${i})">
      <span class="option-letter">${letters[i]}</span>
      <span>${formatLatexText(opt)}</span>
    </button>`).join('');

  // Renderizar matemáticas de forma automática (KaTeX)
  if (typeof renderMathInElement === 'function') {
    const delimiters = [
      { left: '$$', right: '$$', display: true },
      { left: '\\[', right: '\\]', display: true },
      { left: '$', right: '$', display: false },
      { left: '\\(', right: '\\)', display: false }
    ];
    renderMathInElement(document.getElementById('question-text'), { delimiters });
    document.querySelectorAll('#options-list .option-btn span:last-child').forEach(el => {
      renderMathInElement(el, { delimiters });
    });
  }

  const fb = document.getElementById('feedback-box');
  fb.className = 'hidden';
  fb.innerHTML = '';

  // Mostrar/ocultar botón de saltar (solo si no está contestada aún)
  const btnSkip = document.getElementById('btn-skip');
  if (btnSkip) {
    btnSkip.style.display = examState.answeredSet.has(examState.currentQ) ? 'none' : '';
  }

  // Actualizar badge de preguntas marcadas
  updateFlaggedBadge();

  const btnNext = document.getElementById('btn-next');
  btnNext.textContent = 'Confirmar respuesta';
  btnNext.onclick = confirmAnswer;
  btnNext.disabled = true;
  btnNext.style.opacity = '0.5';
}

function selectOption(idx) {
  if (examState.answered) return;
  examState.selectedIdx = idx;

  document.querySelectorAll('.option-btn').forEach((btn, i) => {
    btn.classList.toggle('selected', i === idx);
  });

  const btnNext = document.getElementById('btn-next');
  btnNext.disabled = false;
  btnNext.style.opacity = '1';
}

function confirmAnswer() {
  if (examState.selectedIdx === null) return;
  examState.answered = true;

  const q = activeExam.questions[examState.currentQ];
  const chosen = examState.selectedIdx;
  const isOk = chosen === q.correct;

  if (isOk) examState.correct++;
  else examState.wrong++;

  // Guardar resultado para la revisión post-examen
  examState.questionResults.push({
    text: q.text, options: q.options, chosen, correct: q.correct, isRight: isOk, justification: q.justification || '', image: q.image || ''
  });

  document.querySelectorAll('.option-btn').forEach((btn, i) => {
    btn.disabled = true;
    if (i === q.correct) btn.classList.add('correct');
    else if (i === chosen && !isOk) btn.classList.add('wrong');
  });

  const fb = document.getElementById('feedback-box');
  fb.className = 'feedback-box ' + (isOk ? 'feedback-correct' : 'feedback-wrong');

  const correctText = q.options[q.correct];
  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  const justHTML = q.justification
    ? `<div class="feedback-justification">💡 <strong>Justificación:</strong> ${lqProcessText(q.justification)}</div>`
    : '';

  if (isOk) {
    fb.innerHTML = `<span class="feedback-icon">✅</span><div><span>¡Correcto! Bien hecho.</span>${justHTML}</div>`;
  } else {
    fb.innerHTML = `
      <span class="feedback-icon">❌</span>
      <div>
        <span>Incorrecto. La respuesta correcta era: <strong>${letters[q.correct]}. ${correctText}</strong></span>
        ${justHTML}
      </div>`;
  }
  document.getElementById('exam-score-live').textContent = `✅ ${examState.correct} / ❌ ${examState.wrong}`;

  // Marcar como contestada y quitar de flagged
  examState.answeredSet.add(examState.currentQ);
  examState.flagged.delete(examState.currentQ);
  updateFlaggedBadge();

  // Ocultar botón de saltar ya que ya contestó
  const btnSkip = document.getElementById('btn-skip');
  if (btnSkip) btnSkip.style.display = 'none';

  const btnNext = document.getElementById('btn-next');
  const allAnswered = examState.answeredSet.size >= activeExam.questions.length;
  const isLast = examState.currentQ >= activeExam.questions.length - 1 && examState.flagged.size === 0;
  btnNext.textContent = (allAnswered || isLast) ? 'Ver resultados →' : 'Siguiente pregunta →';
  btnNext.onclick = (allAnswered || isLast) ? showResults : advanceToNext;
}

function nextQuestion() {
  examState.currentQ++;
  renderQuestion();
}

/** Salta la pregunta actual marcándola para contestar después */
function skipQuestion() {
  examState.flagged.add(examState.currentQ);
  toast('🔖 Pregunta marcada. Podrás contestarla después.', 'info');
  advanceToNext();
}

/** Avanza a la siguiente pregunta sin contestar (o flaggeada) */
function advanceToNext() {
  const total = activeExam.questions.length;

  // Buscar la siguiente pregunta sin contestar hacia adelante
  for (let i = examState.currentQ + 1; i < total; i++) {
    if (!examState.answeredSet.has(i)) {
      examState.currentQ = i;
      renderQuestion();
      return;
    }
  }

  // Si no hay más hacia adelante, buscar flaggeadas desde el inicio
  if (examState.flagged.size > 0) {
    const nextFlagged = Math.min(...examState.flagged);
    examState.currentQ = nextFlagged;
    toast(`🔖 Regresando a pregunta ${nextFlagged + 1} (marcada).`, 'info');
    renderQuestion();
    return;
  }

  // Si todo está contestado, mostrar resultados
  showResults();
}

/** Actualiza el badge con la cantidad de preguntas marcadas */
function updateFlaggedBadge() {
  const el = document.getElementById('exam-flagged-count');
  if (!el) return;
  if (examState.flagged.size > 0) {
    el.textContent = `🔖 ${examState.flagged.size} pendiente${examState.flagged.size !== 1 ? 's' : ''}`;
    el.classList.remove('hidden');
  } else {
    el.classList.add('hidden');
  }
}

async function showResults() {
  stopExamTimer();
  const tot = activeExam.questions.length;
  const corr = examState.correct;
  const pct = Math.round((corr / tot) * 100);

  // Guardar resultado en el servidor
  try {
    await api('POST', '/api/logs', { examId: activeExam.id, score: corr, pct });
  } catch { /* no bloquear UI si falla */ }

  document.getElementById('exam-question-view').classList.add('hidden');
  document.getElementById('exam-results-view').classList.remove('hidden');

  let color, cssClass, emoji, title, subtitle;
  if (pct === 100) {
    color = 'var(--secondary)'; cssClass = 'results-excellent';
    emoji = '🏆'; title = '¡Perfecto!'; subtitle = 'Obtuviste el máximo puntaje. ¡Excelente trabajo!';
  } else if (pct >= 70) {
    color = '#7be0c5'; cssClass = 'results-excellent';
    emoji = '🎉'; title = '¡Bien hecho!'; subtitle = 'Superaste el 70%. ¡Sigue así!';
  } else if (pct >= 40) {
    color = 'var(--warning)'; cssClass = 'results-good';
    emoji = '😅'; title = 'Puedes mejorar'; subtitle = 'Estás en camino. ¡Repasa y vuelve a intentarlo!';
  } else {
    color = 'var(--danger)'; cssClass = 'results-bad';
    emoji = '😓'; title = 'Sigue practicando'; subtitle = 'No te desanimes. Repasa el material e inténtalo de nuevo.';
  }

  document.getElementById('results-emoji').textContent = emoji;
  document.getElementById('results-title').textContent = title;
  document.getElementById('results-subtitle').textContent = subtitle;
  document.getElementById('result-pct').textContent = pct + '%';
  document.getElementById('result-pct').style.color = color;
  document.getElementById('res-correct').textContent = corr;
  document.getElementById('res-wrong').textContent = examState.wrong;
  document.getElementById('res-total').textContent = tot;
  document.getElementById('results-card').className = 'results-card ' + cssClass;

  const circumference = 427.26;
  const fill = document.getElementById('circular-fill');
  fill.style.stroke = color;
  fill.style.strokeDashoffset = circumference;
  setTimeout(() => {
    fill.style.strokeDashoffset = circumference - (pct / 100) * circumference;
  }, 100);
}

function retakeExam() { startExam(activeExam.id); }

// ===== ADMIN =====
async function renderAdmin() {
  syncThemeIcons();

  // Actualizar navbar con rol y nombre reales del usuario
  if (currentUser) {
    const isSuperAdmin = currentUser.role === 'superadmin';
    const roleLabel = isSuperAdmin ? 'Superadmin' : 'Profesor / Admin';
    const avatar = isSuperAdmin ? '👑' : '📚';
    const el = document.getElementById('admin-role-label');
    const nm = document.getElementById('admin-name-label');
    const av = document.getElementById('admin-avatar');
    if (el) el.textContent = roleLabel;
    if (nm) nm.textContent = currentUser.name || currentUser.email;
    if (av) av.textContent = avatar;
  }

  try {
    const [students, exams, logs] = await Promise.all([
      api('GET', '/api/users'),
      api('GET', '/api/exams'),
      api('GET', '/api/logs')
    ]);
    cachedStudents = students;
    cachedExams = exams;
    renderAdminStats(students, exams, logs);
    renderStudentsTable(students, exams);
    renderExamsTable(exams);
    renderRecentActivity(logs, students, exams);
    populateSectionFilter(students);
  } catch (e) {
    toast('Error cargando datos: ' + e.message, 'error');
  }
  startMessagePolling();
}

function showPanel(name) {
  document.querySelectorAll('.admin-panel').forEach(p => p.classList.remove('active'));
  document.getElementById('panel-' + name).classList.add('active');
  document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
  document.getElementById('nav-' + name).classList.add('active');
  // Cargar datos del panel activo
  if (name === 'material') renderMaterialPanel();
  if (name === 'announcements') renderAnnouncementsPanel();
  if (name === 'analytics') renderAnalytics();
  if (name === 'live') initLivePanel();
}

function renderAdminStats(students, exams, logs) {
  const studentCount = students.filter(u => u.role === 'student').length;
  const adminCount = students.filter(u => u.role === 'admin').length;
  const avgPct = logs.length ? Math.round(logs.reduce((a, l) => a + l.pct, 0) / logs.length) : 0;

  document.getElementById('admin-stats').innerHTML = `
    <div class="stat-card"><span class="stat-icon">👥</span><div class="stat-info"><div class="stat-num">${studentCount}</div><div class="stat-name">Alumnos</div></div></div>
    <div class="stat-card"><span class="stat-icon">👨‍🏫</span><div class="stat-info"><div class="stat-num">${adminCount}</div><div class="stat-name">Profesores</div></div></div>
    <div class="stat-card"><span class="stat-icon">📝</span><div class="stat-info"><div class="stat-num">${exams.length}</div><div class="stat-name">Exámenes</div></div></div>
    <div class="stat-card"><span class="stat-icon">🏁</span><div class="stat-info"><div class="stat-num">${logs.length}</div><div class="stat-name">Intentos</div></div></div>
    <div class="stat-card"><span class="stat-icon">📈</span><div class="stat-info"><div class="stat-num">${avgPct}%</div><div class="stat-name">Promedio general</div></div></div>`;
}

// ===== FILTROS =====
function populateSectionFilter(students) {
  const sections = [...new Set(students.map(s => s.section).filter(Boolean))].sort();
  const sel = document.getElementById('filter-section');
  sel.innerHTML = '<option value="">Todas las secciones</option>' +
    sections.map(s => `<option value="${s}">${s}</option>`).join('');
}

function applyStudentFilters() {
  const search = document.getElementById('filter-search').value.trim().toLowerCase();
  const section = document.getElementById('filter-section').value;
  const role = document.getElementById('filter-role').value;

  const filtered = cachedStudents.filter(s => {
    const matchSearch = !search || s.name.toLowerCase().includes(search) || s.email.toLowerCase().includes(search);
    const matchSection = !section || s.section === section;
    const matchRole = !role || s.role === role;
    return matchSearch && matchSection && matchRole;
  });

  renderStudentsTable(filtered, cachedExams);
}

function renderStudentsTable(students, exams) {
  const tbody = document.getElementById('students-tbody');
  const isSuperAdmin = currentUser?.role === 'superadmin';

  if (!students || students.length === 0) {
    tbody.innerHTML = '<tr><td colspan="6" style="text-align:center;color:var(--text-muted);padding:2rem;">No se encontraron alumnos.</td></tr>';
    return;
  }

  tbody.innerHTML = students.map(s => {
    const roleBadge = s.role === 'admin'
      ? '<span class="role-badge role-admin">👨‍🏫 Profesor</span>'
      : '<span class="role-badge role-student">👤 Alumno</span>';

    // Agrupar exámenes por módulo (título)
    const moduleMap = {};
    const moduleOrder = [];
    exams.forEach(e => {
      if (!moduleMap[e.title]) { moduleMap[e.title] = []; moduleOrder.push(e.title); }
      moduleMap[e.title].push(e);
    });

    const allowedSet = new Set(s.allowedExams || []);
    const sEmail = s.email;

    const permToggles = moduleOrder.length === 0
      ? '<span style="color:var(--text-muted);font-size:0.8rem;">Sin exámenes</span>'
      : moduleOrder.map(title => {
        const group = moduleMap[title];
        const allIds = group.map(e => e.id);
        const allOn = allIds.every(id => allowedSet.has(id));
        const someOn = !allOn && allIds.some(id => allowedSet.has(id));
        const moduleBtnLabel = allOn ? '🔒 Quitar' : '✅ Todo';
        const moduleBtnClass = allOn ? 'btn-warning' : 'btn-secondary';
        const partialBadge = someOn
          ? `<span style="font-size:0.65rem;color:var(--warning);margin-left:2px;">parcial</span>`
          : '';
        return `<div class="perm-module-row">
          <span class="perm-module-title">${title}${partialBadge}</span>
          <button class="btn ${moduleBtnClass} btn-xs" onclick="toggleModulePerm('${sEmail}', ${JSON.stringify(allIds)}, ${!allOn})">${moduleBtnLabel}</button>
        </div>`;
      }).join('');


    const roleBtn = isSuperAdmin
      ? (s.role === 'admin'
        ? `<button class="btn btn-warning btn-sm" onclick="changeRole('${s.email}','student')">⬇️ Quitar admin</button>`
        : `<button class="btn btn-secondary btn-sm" onclick="changeRole('${s.email}','admin')">⬆️ Hacer admin</button>`)
      : '';

    return `<tr>
      <td><strong>${s.name}</strong><br/><span style="font-size:0.78rem;color:var(--text-muted);">${s.email}</span></td>
      <td>${roleBadge}</td>
      <td><span class="section-pill">${s.section || '—'}</span></td>
      <td><div class="permission-cell">${permToggles}</div></td>
      <td style="white-space:nowrap;">
        <button class="btn btn-ghost btn-sm" onclick="openEditStudent('${s.email}')">✏️ Editar</button>
        ${roleBtn}
        ${s.role !== 'admin' ? `<button class="btn btn-danger btn-sm" onclick="deleteStudent('${s.email}')">🗑️</button>` : ''}
      </td>
    </tr>`;
  }).join('');
}

function renderExamsTable(exams) {
  const tbody = document.getElementById('exams-tbody');

  if (!exams || exams.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:2rem;">No hay exámenes. Crea uno con el botón de arriba.</td></tr>';
    return;
  }

  tbody.innerHTML = exams.map(e => `
    <tr>
      <td><strong>${e.icon || '📋'} ${e.title}</strong></td>
      <td style="color:var(--text-muted)">${e.description || '—'}</td>
      <td style="text-align:center"><strong>${e.questions.length}</strong></td>
      <td>
        <button class="btn btn-ghost btn-sm" onclick="openEditExamModal('${e.id}')">✏️ Editar</button>
        <button class="btn btn-danger btn-sm" onclick="deleteExam('${e.id}')">🗑️</button>
      </td>
    </tr>`).join('');
}

function renderRecentActivity(logs, students, exams) {
  const recent = logs.slice(0, 8);
  const el = document.getElementById('recent-activity');

  if (!recent.length) {
    el.innerHTML = '<p style="text-align:center;padding:1rem;color:var(--text-muted);">Sin actividad reciente.</p>';
    return;
  }

  el.innerHTML = recent.map(l => {
    const user = students.find(u => u.email === l.student_email);
    const exam = exams.find(e => e.id === l.exam_id);
    const date = new Date(l.date).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', hour: '2-digit', minute: '2-digit' });
    const color = l.pct >= 70 ? 'var(--secondary)' : l.pct >= 40 ? 'var(--warning)' : 'var(--danger)';
    return `<div style="display:flex;align-items:center;justify-content:space-between;padding:0.6rem 0;border-bottom:1px solid var(--card-border);">
      <span>👤 <strong>${user ? user.name : l.student_email}</strong> tomó <em>${exam ? exam.title : l.exam_id}</em></span>
      <span style="display:flex;gap:1rem;align-items:center;">
        <span style="color:${color};font-weight:700;">${l.pct}%</span>
        <span style="color:var(--text-muted);font-size:0.78rem;">${date}</span>
      </span>
    </div>`;
  }).join('');
}

// ============================================================
//  ANALYTICS DASHBOARD
// ============================================================
let chartAvgExam = null;
let chartDistribution = null;
let chartTimeline = null;

async function renderAnalytics() {
  try {
    const data = await api('GET', '/api/analytics');

    // Poblar filtro de exámenes (solo la primera vez o si cambió)
    const filterEl = document.getElementById('analytics-exam-filter');
    const currentVal = filterEl.value;
    if (filterEl.options.length <= 1) {
      data.avgByExam.forEach(e => {
        const opt = document.createElement('option');
        opt.value = e.id;
        opt.textContent = e.title + (e.description ? ' — ' + e.description : '');
        filterEl.appendChild(opt);
      });
      filterEl.value = currentVal;
    }

    // Filtrar datos si se seleccionó un examen
    const filterId = filterEl.value;
    const avgData = filterId ? data.avgByExam.filter(e => e.id === filterId) : data.avgByExam;

    // ── 1. Gráfica: Promedio por examen (barras) ──
    if (chartAvgExam) chartAvgExam.destroy();
    const ctxBar = document.getElementById('chart-avg-exam').getContext('2d');
    chartAvgExam = new Chart(ctxBar, {
      type: 'bar',
      data: {
        labels: avgData.map(e => e.title + (e.description ? '\n' + e.description : '')),
        datasets: [{
          label: 'Promedio %',
          data: avgData.map(e => e.avg),
          backgroundColor: avgData.map(e =>
            e.avg >= 70 ? 'rgba(0, 200, 151, 0.7)' :
              e.avg >= 40 ? 'rgba(255, 193, 7, 0.7)' : 'rgba(239, 68, 68, 0.7)'
          ),
          borderRadius: 6,
          borderSkipped: false
        }]
      },
      options: {
        indexAxis: 'y',
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false },
          tooltip: {
            callbacks: {
              afterLabel: (ctx) => {
                const e = avgData[ctx.dataIndex];
                return `${e.attempts} intento${e.attempts !== 1 ? 's' : ''}`;
              }
            }
          }
        },
        scales: {
          x: { max: 100, grid: { color: 'rgba(255,255,255,0.06)' }, ticks: { color: 'rgba(255,255,255,0.5)' } },
          y: { grid: { display: false }, ticks: { color: 'rgba(255,255,255,0.7)', font: { size: 11 } } }
        }
      }
    });

    // ── 2. Gráfica: Distribución de rendimiento (dona) ──
    if (chartDistribution) chartDistribution.destroy();
    const ctxDonut = document.getElementById('chart-distribution').getContext('2d');
    const dist = data.distribution;
    chartDistribution = new Chart(ctxDonut, {
      type: 'doughnut',
      data: {
        labels: ['Excelente (≥90%)', 'Bien (70-89%)', 'Regular (40-69%)', 'Reprobado (<40%)'],
        datasets: [{
          data: [dist.excellent, dist.good, dist.needsWork, dist.failing],
          backgroundColor: [
            'rgba(0, 200, 151, 0.8)',
            'rgba(99, 102, 241, 0.8)',
            'rgba(255, 193, 7, 0.8)',
            'rgba(239, 68, 68, 0.8)'
          ],
          borderWidth: 0,
          hoverOffset: 8
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        cutout: '60%',
        plugins: {
          legend: {
            position: 'bottom',
            labels: { color: 'rgba(255,255,255,0.7)', padding: 12, font: { size: 11 } }
          }
        }
      }
    });

    // ── 3. Gráfica: Intentos por día (línea) ──
    if (chartTimeline) chartTimeline.destroy();
    const ctxLine = document.getElementById('chart-timeline').getContext('2d');
    chartTimeline = new Chart(ctxLine, {
      type: 'line',
      data: {
        labels: data.timeline.map(t => {
          const d = new Date(t.date + 'T12:00:00');
          return d.toLocaleDateString('es-MX', { day: '2-digit', month: 'short' });
        }),
        datasets: [{
          label: 'Intentos',
          data: data.timeline.map(t => t.count),
          borderColor: 'rgba(99, 102, 241, 0.9)',
          backgroundColor: 'rgba(99, 102, 241, 0.1)',
          fill: true,
          tension: 0.4,
          pointRadius: 3,
          pointBackgroundColor: 'rgba(99, 102, 241, 1)',
          pointHoverRadius: 6
        }]
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        plugins: {
          legend: { display: false }
        },
        scales: {
          x: {
            grid: { color: 'rgba(255,255,255,0.04)' },
            ticks: { color: 'rgba(255,255,255,0.5)', maxRotation: 45, font: { size: 10 } }
          },
          y: {
            beginAtZero: true,
            grid: { color: 'rgba(255,255,255,0.06)' },
            ticks: { color: 'rgba(255,255,255,0.5)', stepSize: 1 }
          }
        }
      }
    });

    // ── 4. Tabla: Preguntas más difíciles ──
    const tableEl = document.getElementById('hardest-questions-table');
    if (!data.hardestQuestions.length) {
      tableEl.innerHTML = '<p style="color:var(--text-muted);font-size:0.85rem;text-align:center;padding:1rem;">Se necesitan más intentos para generar datos.</p>';
    } else {
      tableEl.innerHTML = `
        <table class="hardest-table">
          <thead><tr><th>#</th><th>Examen</th><th>Pregunta</th><th>Promedio</th><th>Intentos</th></tr></thead>
          <tbody>
            ${data.hardestQuestions.map((q, i) => {
        const color = q.examAvg >= 70 ? 'var(--secondary)' : q.examAvg >= 40 ? 'var(--warning)' : 'var(--danger)';
        return `<tr>
                <td>${i + 1}</td>
                <td><strong>${q.examTitle}</strong></td>
                <td>${formatLatexText(q.questionText)}</td>
                <td style="color:${color};font-weight:700;">${q.examAvg}%</td>
                <td>${q.attempts}</td>
              </tr>`;
      }).join('')}
          </tbody>
        </table>`;
    }

  } catch (e) {
    toast('Error cargando analíticas: ' + e.message, 'error');
  }
}

// ===== PERMISOS RÁPIDOS (toggle en tabla) =====
/**
 * Lee el estado actual de cachedStudents — evita que toggles rápidos
 * usen una lista desactualizada del HTML y sobreescriban permisos anteriores.
 */
async function quickTogglePerm(email, examId, value) {
  const student = cachedStudents.find(u => u.email === email);
  if (!student) return;

  // Clonar lista actual del caché (no la del HTML, que puede ser stale)
  let perms = [...(student.allowedExams || [])];
  if (value && !perms.includes(examId)) perms.push(examId);
  if (!value) perms = perms.filter(id => id !== examId);

  try {
    await api('PUT', `/api/users/${encodeURIComponent(email)}/permissions`, { allowedExams: perms });
    student.allowedExams = perms; // actualizar caché local
    toast(value ? '✅ Permiso otorgado' : '🔒 Permiso revocado', value ? 'success' : 'info');
  } catch (e) {
    toast(e.message, 'error');
    renderAdmin();
  }
}

/** Otorga o revoca todos los exámenes de un módulo de un solo clic */
async function toggleModulePerm(email, examIds, grant) {
  const student = cachedStudents.find(u => u.email === email);
  if (!student) return;

  let perms = [...(student.allowedExams || [])];
  if (grant) {
    examIds.forEach(id => { if (!perms.includes(id)) perms.push(id); });
  } else {
    perms = perms.filter(id => !examIds.includes(id));
  }

  try {
    await api('PUT', `/api/users/${encodeURIComponent(email)}/permissions`, { allowedExams: perms });
    student.allowedExams = perms;
    student.allowed_exams = perms;
    // Refrescar la tabla para actualizar los toggles individuales
    renderStudentsTable(cachedStudents, cachedExams);
    toast(grant ? `✅ Módulo completo desbloqueado` : `🔒 Módulo completo bloqueado`, grant ? 'success' : 'info');
  } catch (e) {
    toast(e.message, 'error');
    renderAdmin();
  }
}

async function changeRole(email, role) {
  const label = role === 'admin' ? 'profesor (admin)' : 'alumno';
  if (!confirm(`¿Cambiar el rol de este usuario a ${label}?`)) return;
  try {
    await api('PUT', `/api/users/${encodeURIComponent(email)}/role`, { role });
    toast(`Rol cambiado a ${label}.`, 'success');
    renderAdmin();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteStudent(email) {
  if (!confirm('¿Eliminar este alumno? Esta acción no se puede deshacer.')) return;
  try {
    await api('DELETE', `/api/users/${encodeURIComponent(email)}`);
    toast('Alumno eliminado.', 'info');
    renderAdmin();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteExam(examId) {
  if (!confirm('¿Eliminar este examen y todos sus registros?')) return;
  try {
    await api('DELETE', `/api/exams/${examId}`);
    toast('Examen eliminado.', 'info');
    renderAdmin();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ===== MODAL: EDITAR ALUMNO =====
async function openEditStudent(email) {
  const user = cachedStudents.find(u => u.email === email);
  if (!user) return;

  document.getElementById('edit-student-email').value = email;
  document.getElementById('edit-student-name').value = user.name;
  document.getElementById('edit-student-section').value = user.section || '';

  const list = document.getElementById('edit-perms-list');
  const titleCount = {};
  cachedExams.forEach(e => { titleCount[e.title] = (titleCount[e.title] || 0) + 1; });

  list.innerHTML = cachedExams.map(e => {
    const on = (user.allowedExams || []).includes(e.id);
    const unit = titleCount[e.title] > 1 ? extractUnit(e.description) : null;
    const label = unit ? `${e.title} <span class="perm-unit-tag">${unit}</span>` : e.title;
    return `<div class="perm-exam-row">
      <label class="toggle-switch">
        <input type="checkbox" id="mperm-${e.id}" ${on ? 'checked' : ''}/>
        <span class="toggle-slider"></span>
      </label>
      <span>${e.icon || '📋'} ${label}</span>
    </div>`;
  }).join('') || '<span style="color:var(--text-muted);font-size:0.85rem;">No hay exámenes creados.</span>';

  openModal('modal-student');
}

async function saveStudentEdit() {
  const email = document.getElementById('edit-student-email').value;
  const section = document.getElementById('edit-student-section').value.trim();
  const perms = cachedExams
    .filter(e => document.getElementById('mperm-' + e.id)?.checked)
    .map(e => e.id);

  try {
    const student = cachedStudents.find(u => u.email === email);
    await Promise.all([
      api('PUT', `/api/users/${encodeURIComponent(email)}/section`, { section }),
      api('PUT', `/api/users/${encodeURIComponent(email)}/permissions`, { allowedExams: perms })
    ]);
    if (student) {
      student.section = section;
      student.allowedExams = perms;
      student.allowed_exams = perms;
    }
    closeModal('modal-student');
    toast('Cambios guardados.', 'success');
    renderAdmin();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ===== MODAL: CREAR/EDITAR EXAMEN =====
function openCreateExamModal(preloadedQuestions = []) {
  editingExamId = null;
  questionCount = 0;
  document.getElementById('modal-exam-title').textContent = 'Nuevo examen';
  document.getElementById('exam-title-input').value = '';
  document.getElementById('exam-desc-input').value = '';
  document.getElementById('exam-icon-input').value = '📋';
  document.getElementById('exam-max-attempts').value = '0';
  document.getElementById('exam-time-limit').value = '0';
  document.getElementById('exam-shuffle').checked = false;
  document.getElementById('questions-builder').innerHTML = '';

  if (preloadedQuestions.length > 0) {
    preloadedQuestions.forEach(q => addQuestionBlock(q));
  } else {
    addQuestionBlock();
  }
  openModal('modal-exam');
}

// ===== IMPORTAR LATEX =====
function openLatexModal() {
  document.getElementById('latex-questions').value = '';
  document.getElementById('latex-answers').value = '';
  document.getElementById('latex-preview-info').innerHTML = '';
  openModal('modal-latex');
}

/** Contador en vivo mientras el usuario escribe en el textarea */
function updateLatexPreview() {
  const raw = document.getElementById('latex-questions').value;
  const el = document.getElementById('latex-preview-info');
  if (!raw.trim()) { el.innerHTML = ''; return; }

  const qs = parseLatexQuestions(raw);
  if (qs.length === 0) {
    el.innerHTML = '<div class="latex-preview-err">⚠️ No se detectaron preguntas válidas. Revisa el formato.</div>';
  } else {
    const ansRaw = document.getElementById('latex-answers').value;
    let ansMsg = '';
    if (ansRaw.trim()) {
      const ans = parseLatexAnswers(ansRaw);
      const found = Object.keys(ans).length;
      ansMsg = ` · <strong>${found}</strong> respuesta${found !== 1 ? 's' : ''} detectada${found !== 1 ? 's' : ''}`;
    }
    el.innerHTML = `<div class="latex-preview-ok" style="margin-bottom:1rem;">✅ <strong>${qs.length}</strong> pregunta${qs.length !== 1 ? 's' : ''} detectada${qs.length !== 1 ? 's' : ''}${ansMsg}. Haz clic en <em>Importar y editar</em> para continuar.</div>
    <div style="font-size:0.85rem;color:var(--text);background:var(--bg3);padding:1rem;border-radius:var(--radius-sm);max-height:200px;overflow-y:auto;">
      <strong>Vista previa (Pregunta 1):</strong><br>
      <div class="latex-container">${formatLatexText(qs[0].text)}</div>
      <ul style="margin-top:0.5rem;padding-left:1.5rem;color:var(--text-muted);">
        ${qs[0].options.map(o => `<li class="latex-container">${formatLatexText(o)}</li>`).join('')}
      </ul>
    </div>`;

    if (typeof renderMathInElement === 'function') {
      renderMathInElement(el, {
        delimiters: [
          { left: '$$', right: '$$', display: true },
          { left: '\\[', right: '\\]', display: true },
          { left: '$', right: '$', display: false },
          { left: '\\(', right: '\\)', display: false }
        ]
      });
    }
  }
}

/**
 * Parsea preguntas LaTeX en formato:
 *   \item Texto de la pregunta
 *   \begin{enumerate}[label=\Alph*)]
 *       \item Opción A
 *       \item Opción B
 *       \item Opción C
 *       \item Opción D
 *   \end{enumerate}
 */
function parseLatexQuestions(rawText) {
  let text = rawText.replace(/\r\n/g, '\n').replace(/(?<!\\)%[^\n]*/g, '');

  const questions = [];
  // Cada bloque: \item <pregunta>\n\begin{enumerate}...\end{enumerate}
  const blockRe = /\\item\s+([\s\S]*?)\n[ \t]*\\begin\{enumerate\}([\s\S]*?)\\end\{enumerate\}/g;
  let match;

  while ((match = blockRe.exec(text)) !== null) {
    const qText = match[1].trim().replace(/\s+/g, ' ');
    const optsBlock = match[2];
    const options = [];
    const optRe = /\\item\s+(.+)/g;
    let om;
    while ((om = optRe.exec(optsBlock)) !== null) {
      const opt = om[1].trim();
      if (opt) options.push(opt);
    }
    if (qText && options.length >= 2) {
      questions.push({ text: qText, options, correct: 0 });
    }
  }
  return questions;
}

/**
 * Parsea respuestas en formato:
 *   \item 1. C    →  { 1: 2 }   (A=0, B=1, C=2, D=3, E=4)
 *   \item 2. B    →  { 2: 1 }
 * También acepta variantes sin \item: "1. C" o "1) C"
 */
function parseLatexAnswers(rawText) {
  let text = rawText.replace(/\r\n/g, '\n').replace(/(?<!\\)%[^\n]*/g, '');
  const map = {};
  const re = /(?:\\item\s+)?(\d+)[.)]\s*([A-Ea-e])/g;
  let m;
  while ((m = re.exec(text)) !== null) {
    const num = parseInt(m[1]);
    const idx = 'ABCDE'.indexOf(m[2].toUpperCase());
    if (idx >= 0) map[num] = idx;
  }
  return map;
}

/**
 * Parsea justificaciones numeradas en formato:
 *   1. La respuesta es C porque...
 *   2. Se aplica la ley de...
 * Cada entrada puede ser multilínea hasta el siguiente número.
 */
function parseLatexJustifications(rawText) {
  const text = rawText
    .replace(/\r\n/g, '\n')
    .replace(/(?<!\\)%[^\n]*/g, '')           // quitar comentarios LaTeX
    .replace(/\\begin\{[^}]+\}/g, '')  // quitar \begin{...}
    .replace(/\\end\{[^}]+\}/g, '')    // quitar \end{...}
    .trim();

  const map = {};

  // Formato 1: UN solo bloque de \item (como las respuestas)
  // \item justificación 1  \item justificación 2 ...
  // Cada \item se asigna secuencialmente a la pregunta 1, 2, 3...
  if (/\\item/.test(text) && !/^\d+[.)]/.test(text.trimStart())) {
    const parts = text.split(/\\item\s+/).filter(s => s.trim());
    parts.forEach((part, i) => {
      map[i + 1] = part.replace(/\s+/g, ' ').trim();
    });
    return map;
  }

  // Formato 2: Numerado  →  1. texto  2. texto ...
  // (también puede tener \item internos, se convierten en bullets •)
  const lines = text.split('\n');
  let current = null;
  let buffer = [];

  function flush() {
    if (current !== null && buffer.length) {
      map[current] = buffer.join(' ')
        .replace(/\\item\s+/g, '• ')
        .replace(/\s+/g, ' ')
        .trim();
    }
  }

  lines.forEach(line => {
    const m = line.match(/^(\d+)[.)]\s+(.+)/);
    if (m) {
      flush();
      current = parseInt(m[1]);
      buffer = [m[2].trim()];
    } else if (current !== null && line.trim()) {
      buffer.push(line.trim());
    }
  });
  flush();
  return map;
}

/** Orquesta el import: parsea, aplica respuestas y justificaciones, y abre el modal pre-llenado */
function importLatex() {
  const qRaw = document.getElementById('latex-questions').value;
  const aRaw = document.getElementById('latex-answers').value;
  const jRaw = document.getElementById('latex-justifications').value;

  if (!qRaw.trim()) {
    toast('Pega las preguntas en el primer recuadro.', 'error');
    return;
  }

  const questions = parseLatexQuestions(qRaw);
  if (questions.length === 0) {
    toast('No se detectaron preguntas válidas. Revisa el formato LaTeX.', 'error');
    return;
  }

  // Aplicar respuestas si las hay
  if (aRaw.trim()) {
    const answers = parseLatexAnswers(aRaw);
    questions.forEach((q, i) => {
      const key = i + 1;
      if (answers[key] !== undefined && answers[key] < q.options.length) {
        q.correct = answers[key];
      }
    });
  }

  // Aplicar justificaciones si las hay
  if (jRaw.trim()) {
    const justifications = parseLatexJustifications(jRaw);
    questions.forEach((q, i) => {
      const key = i + 1;
      if (justifications[key]) q.justification = justifications[key];
    });
  }

  closeModal('modal-latex');
  const n = questions.length;
  toast(`✅ ${n} pregunta${n !== 1 ? 's' : ''} importada${n !== 1 ? 's' : ''}. Completa título y guarda.`, 'success');
  openCreateExamModal(questions);
}

async function openEditExamModal(examId) {
  const exam = cachedExams.find(e => e.id === examId);
  if (!exam) return;
  editingExamId = examId;
  questionCount = 0;

  document.getElementById('modal-exam-title').textContent = 'Editar examen';
  document.getElementById('exam-title-input').value = exam.title;
  document.getElementById('exam-desc-input').value = exam.description || '';
  document.getElementById('exam-icon-input').value = exam.icon || '📋';
  document.getElementById('exam-max-attempts').value = exam.max_attempts || 0;
  document.getElementById('exam-time-limit').value = exam.time_limit || 0;
  document.getElementById('exam-shuffle').checked = !!exam.shuffle;
  document.getElementById('questions-builder').innerHTML = '';

  exam.questions.forEach(q => addQuestionBlock(q));
  openModal('modal-exam');
}

function addQuestionBlock(data) {
  questionCount++;
  const idx = questionCount;
  const letters = ['A', 'B', 'C', 'D'];
  const opts = data ? data.options : ['', '', '', ''];
  const corr = data ? data.correct : 0;
  const just = data ? (data.justification || '') : '';
  const img = data ? (data.image || '') : '';

  document.getElementById('questions-builder').insertAdjacentHTML('beforeend', `
    <div class="question-block" id="qblock-${idx}">
      <div class="question-block-header">
        <span class="question-block-num">Pregunta ${idx}</span>
        <button class="btn btn-danger btn-sm" onclick="removeQuestion(${idx})">&#x2715;</button>
      </div>
      <div class="form-group">
        <input class="form-input" type="text" id="q-text-${idx}" placeholder="Escribe la pregunta aquí..." value="${data ? escapeAttr(data.text) : ''}"/>
      </div>
      <div class="form-group" style="margin-top:0.3rem;">
        <label class="form-label" style="font-size:0.78rem;color:var(--primary);">📸 Imagen (URL, opcional)</label>
        <div style="display:flex;gap:0.5rem;align-items:center;">
          <input class="form-input" type="url" id="q-img-${idx}" placeholder="https://... (pega la URL de la imagen)"
            value="${escapeAttr(img)}" style="flex:1;font-size:0.82rem;"
            oninput="var u=fixDriveUrl(this.value);if(u!==this.value)this.value=u;document.getElementById('q-img-preview-${idx}').src=u;document.getElementById('q-img-preview-${idx}').style.display=u?'block':'none'" />
        </div>
        <img id="q-img-preview-${idx}" src="${escapeAttr(img)}" alt="Preview"
          style="max-width:200px;max-height:120px;border-radius:8px;margin-top:0.5rem;border:1px solid var(--card-border);display:${img ? 'block' : 'none'}" />
      </div>
      <div class="options-builder">
        ${opts.map((opt, i) => `
          <div class="option-row" style="align-items:flex-start;">
            <input type="radio" class="option-radio" name="correct-${idx}" id="radio-${idx}-${i}" value="${i}" ${corr === i ? 'checked' : ''} style="margin-top:0.4rem;"/>
            <label for="radio-${idx}-${i}" style="font-weight:700;font-size:0.85rem;color:var(--secondary);min-width:1.5rem;margin-top:0.4rem;">${letters[i]}</label>
            <textarea class="form-input option-input" id="q-opt-${idx}-${i}" placeholder="Opción ${letters[i]}" rows="1" style="resize:vertical;min-height:38px;">${escapeAttr(opt)}</textarea>
          </div>`).join('')}
        <p style="font-size:0.75rem;color:var(--text-muted);margin-top:0.5rem;">&#x1F7E2; Selecciona el radio de la respuesta correcta. Puedes usar LaTeX ($...$).</p>
      </div>
      <div class="form-group" style="margin-top:0.6rem;">
        <label class="form-label" style="font-size:0.78rem;color:var(--secondary);">&#x1F4A1; Justificación (por qué es correcta)</label>
        <textarea class="form-input" id="q-just-${idx}" rows="2"
          style="resize:vertical;font-size:0.83rem;"
          placeholder="Explica brevemente por qué la respuesta marcada es la correcta...">${escapeAttr(just)}</textarea>
      </div>
    </div>`);
}

function removeQuestion(idx) {
  const block = document.getElementById('qblock-' + idx);
  if (block) block.remove();
}

function escapeAttr(str) {
  return String(str || '').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

/** Convierte links de Google Drive a URLs directas de imagen */
function fixDriveUrl(url) {
  if (!url) return url;
  // drive.google.com/file/d/ID/view... → lh3.googleusercontent.com/d/ID
  const m = url.match(/drive\.google\.com\/file\/d\/([^/]+)/);
  if (m) return 'https://lh3.googleusercontent.com/d/' + m[1];
  return url;
}

async function saveExam() {
  const title = document.getElementById('exam-title-input').value.trim();
  const desc = document.getElementById('exam-desc-input').value.trim();
  const icon = document.getElementById('exam-icon-input').value.trim() || '📋';

  if (!title) { toast('El título es obligatorio.', 'error'); return; }

  const blocks = document.querySelectorAll('.question-block');
  if (blocks.length === 0) { toast('Agrega al menos una pregunta.', 'error'); return; }

  const questions = [];
  const missing = [];

  blocks.forEach((block, index) => {
    const id = block.id.replace('qblock-', '');
    const text = document.getElementById('q-text-' + id)?.value.trim() || '';
    const opts = [0, 1, 2, 3].map(i => document.getElementById(`q-opt-${id}-${i}`)?.value.trim() || '');
    const corrEl = document.querySelector(`input[name="correct-${id}"]:checked`);
    const corr = corrEl ? parseInt(corrEl.value) : 0;
    const just = document.getElementById('q-just-' + id)?.value.trim() || '';
    const image = fixDriveUrl(document.getElementById('q-img-' + id)?.value.trim() || '');

    if (!text || opts.some(o => !o)) { missing.push(index + 1); return; }
    questions.push({ text, options: opts, correct: corr, justification: just, image });
  });

  if (missing.length > 0) {
    toast(`Completa las siguientes preguntas: ${missing.join(', ')}.`, 'error');
    return;
  }

  const max_attempts = parseInt(document.getElementById('exam-max-attempts').value) || 0;
  const time_limit = parseInt(document.getElementById('exam-time-limit').value) || 0;
  const shuffle = document.getElementById('exam-shuffle').checked;

  try {
    if (editingExamId) {
      await api('PUT', `/api/exams/${editingExamId}`, { title, description: desc, icon, questions, max_attempts, shuffle, time_limit });
      toast('Examen actualizado.', 'success');
    } else {
      await api('POST', '/api/exams', { title, description: desc, icon, questions, max_attempts, shuffle, time_limit });
      toast('Examen creado.', 'success');
    }
    closeModal('modal-exam');
    renderAdmin();
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ===== MODALES =====
function openModal(id) {
  document.getElementById(id).classList.remove('hidden');
  document.body.style.overflow = 'hidden';
}
function closeModal(id) {
  document.getElementById(id).classList.add('hidden');
  document.body.style.overflow = '';
}

document.addEventListener('click', e => {
  if (e.target.classList.contains('modal-overlay')) {
    e.target.classList.add('hidden');
    document.body.style.overflow = '';
  }
});

// ===== TOAST =====
function toast(msg, type = 'info') {
  const container = document.getElementById('toast-container');
  const icons = { success: '✅', error: '❌', info: 'ℹ️', warning: '⚠️' };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${icons[type] || 'ℹ️'}</span><span>${msg}</span>`;
  container.appendChild(el);
  setTimeout(() => {
    el.style.opacity = '0';
    el.style.transform = 'translateX(120%)';
    el.style.transition = 'all 0.4s ease';
    setTimeout(() => el.remove(), 400);
  }, 3000);
}

// ===== ENTER KEY =====
document.addEventListener('keydown', e => {
  if (e.key !== 'Enter') return;
  if (!document.getElementById('form-login').classList.contains('hidden')) handleLogin();
  else if (!document.getElementById('form-register').classList.contains('hidden')) handleRegister();
});

// ============================================================
//  DARK / LIGHT MODE  (uses data-theme on <html>)
// ============================================================
function syncThemeIcons() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  document.querySelectorAll('.theme-toggle-btn').forEach(b => {
    b.textContent = isLight ? '🌙' : '☀️';
  });
}

function toggleTheme() {
  const isNowLight = document.documentElement.getAttribute('data-theme') !== 'light';
  document.documentElement.setAttribute('data-theme', isNowLight ? 'light' : 'dark');
  localStorage.setItem('examapp_theme', isNowLight ? 'light' : 'dark');
  syncThemeIcons();
}

(function applyTheme() {
  const saved = localStorage.getItem('examapp_theme') || 'dark';
  document.documentElement.setAttribute('data-theme', saved);
  // Icons updated after first render via syncThemeIcons()
})();

// ============================================================
//  POST-EXAM REVIEW
// ============================================================
function toggleReview() {
  const section = document.getElementById('review-section');
  if (!section.classList.contains('hidden')) { section.classList.add('hidden'); return; }

  const letters = ['A', 'B', 'C', 'D', 'E', 'F'];
  section.innerHTML = examState.questionResults.map((r, i) => {
    const justHTML = r.justification
      ? `<div class="review-justification">💡 <strong>Justificación:</strong> ${lqProcessText(r.justification)}</div>`
      : '';
    return `
    <div class="review-item ${r.isRight ? 'review-correct' : 'review-wrong'}">
      <div class="review-q-header">
        <span class="review-badge">${r.isRight ? '✅' : '❌'}</span>
        <span class="review-q-num">Pregunta ${i + 1}</span>
      </div>
      <p class="review-q-text latex-container">${formatLatexText(r.text)}</p>
      <div class="review-options">
        ${r.options.map((opt, idx) => {
      let cls = 'review-opt';
      if (idx === r.correct) cls += ' review-opt-correct';
      else if (idx === r.chosen && !r.isRight) cls += ' review-opt-wrong';
      return `<div class="${cls}"><span class="review-opt-letter">${letters[idx]}</span> <span class="latex-container">${formatLatexText(opt)}</span></div>`;
    }).join('')}
      </div>
      ${justHTML}
    </div>`;
  }).join('');
  section.classList.remove('hidden');

  // Aplicar KaTeX al contenedor de revisión
  if (typeof renderMathInElement === 'function') {
    renderMathInElement(section, {
      delimiters: [
        { left: '$$', right: '$$', display: true },
        { left: '\\[', right: '\\]', display: true },
        { left: '$', right: '$', display: false },
        { left: '\\(', right: '\\)', display: false }
      ]
    });
  }
}

// ============================================================
//  HISTORIAL DE INTENTOS (alumno)
// ============================================================
async function openHistoryModal() {
  const el = document.getElementById('history-modal-body');
  el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:1rem;">Cargando...</p>';
  openModal('modal-history');

  try {
    const [logs, exams] = await Promise.all([
      api('GET', '/api/logs'),
      api('GET', '/api/exams')
    ]);
    const examMap = {};
    exams.forEach(e => { examMap[e.id] = e.title; });

    if (!logs.length) {
      el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:1.5rem;">Aún no tienes intentos registrados.</p>';
      return;
    }
    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.87rem;">
        <thead style="background:rgba(108,99,255,0.1);">
          <tr>
            <th style="padding:0.7rem 1rem;text-align:left;color:var(--text-muted);">Examen</th>
            <th style="padding:0.7rem;text-align:center;color:var(--text-muted);">Puntaje</th>
            <th style="padding:0.7rem;text-align:center;color:var(--text-muted);">%</th>
            <th style="padding:0.7rem 1rem;text-align:left;color:var(--text-muted);">Fecha</th>
          </tr>
        </thead>
        <tbody>
          ${logs.map(l => {
      const isPass = l.pct >= 70;
      const date = new Date(l.date).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric' });
      return `<tr style="border-top:1px solid var(--card-border);">
              <td style="padding:0.7rem 1rem;font-weight:600;">${examMap[l.exam_id] || 'Desconocido'}</td>
              <td style="padding:0.7rem;text-align:center;">${l.score}</td>
              <td style="padding:0.7rem;text-align:center;">
                <span style="background:${isPass ? 'rgba(0,200,151,0.15)' : 'rgba(255,92,114,0.15)'};color:${isPass ? 'var(--secondary)' : 'var(--danger)'};padding:0.15rem 0.5rem;border-radius:20px;font-size:0.8rem;font-weight:700;">
                  ${l.pct}%
                </span>
              </td>
              <td style="padding:0.7rem 1rem;color:var(--text-muted);font-size:0.82rem;">${date}</td>
            </tr>`;
    }).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    el.innerHTML = `<p style="color:var(--danger);padding:1rem;">${e.message}</p>`;
  }
}

// ============================================================
//  LEADERBOARD
// ============================================================
async function openLeaderboardModal() {
  const el = document.getElementById('leaderboard-modal-body');
  el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:1rem;">Cargando...</p>';
  openModal('modal-leaderboard');

  try {
    const rows = await api('GET', '/api/leaderboard');
    if (!rows.length) {
      el.innerHTML = '<p style="color:var(--text-muted);text-align:center;padding:1.5rem;">Aún no hay datos para el ranking.</p>';
      return;
    }
    el.innerHTML = `
      <table style="width:100%;border-collapse:collapse;font-size:0.87rem;">
        <thead style="background:rgba(108,99,255,0.1);">
          <tr>
            <th style="padding:0.7rem;text-align:center;">#</th>
            <th style="padding:0.7rem 1rem;text-align:left;color:var(--text-muted);">Alumno</th>
            <th style="padding:0.7rem;text-align:center;color:var(--text-muted);">Promedio</th>
            <th style="padding:0.7rem;text-align:center;color:var(--text-muted);">Mejor</th>
            <th style="padding:0.7rem;text-align:center;color:var(--text-muted);">Intentos</th>
          </tr>
        </thead>
        <tbody>
          ${rows.map((r, i) => {
      const isMe = r.email === currentUser?.email;
      const medal = i === 0 ? '🥇' : i === 1 ? '🥈' : i === 2 ? '🥉' : `${i + 1}`;
      return `<tr style="border-top:1px solid var(--card-border);${isMe ? 'background:rgba(108,99,255,0.08);' : ''}">
              <td style="padding:0.7rem;text-align:center;font-size:1rem;">${medal}</td>
              <td style="padding:0.7rem 1rem;">
                <strong>${r.name}${isMe ? ' <span style="color:var(--primary-light);font-size:0.75rem;">(tú)</span>' : ''}</strong>
                <br><span style="font-size:0.77rem;color:var(--text-muted);">${r.section || ''}</span>
              </td>
              <td style="padding:0.7rem;text-align:center;"><strong style="color:var(--secondary);">${r.avg_pct}%</strong></td>
              <td style="padding:0.7rem;text-align:center;">${r.best_pct}%</td>
              <td style="padding:0.7rem;text-align:center;color:var(--text-muted);">${r.attempts}</td>
            </tr>`;
    }).join('')}
        </tbody>
      </table>`;
  } catch (e) {
    el.innerHTML = `<p style="color:var(--danger);padding:1rem;">${e.message}</p>`;
  }
}

// ============================================================
//  CAMBIAR CONTRASEÑA
// ============================================================
function openChangePasswordModal() {
  document.getElementById('pw-current').value = '';
  document.getElementById('pw-new').value = '';
  document.getElementById('pw-confirm').value = '';
  openModal('modal-change-pw');
}

async function changePassword() {
  const current = document.getElementById('pw-current').value;
  const newPass = document.getElementById('pw-new').value;
  const confirm = document.getElementById('pw-confirm').value;

  if (!current || !newPass || !confirm) { toast('Completa todos los campos.', 'error'); return; }
  if (newPass !== confirm) { toast('Las contraseñas nuevas no coinciden.', 'error'); return; }
  if (newPass.length < 6) { toast('La nueva contraseña debe tener al menos 6 caracteres.', 'error'); return; }

  try {
    await api('PUT', '/api/auth/password', { current, newPass });
    toast('✅ Contraseña cambiada exitosamente.', 'success');
    closeModal('modal-change-pw');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ============================================================
//  EXPORTAR CSV (admin)
// ============================================================
async function exportCSV() {
  try {
    const [logs, students, exams] = await Promise.all([
      api('GET', '/api/logs'),
      api('GET', '/api/users'),
      api('GET', '/api/exams')
    ]);

    const studentMap = {};
    students.forEach(s => { studentMap[s.email] = s; });
    const examMap = {};
    exams.forEach(e => { examMap[e.id] = e; });

    const header = ['Nombre', 'Email', 'Sección', 'Examen', 'Preguntas', 'Correctas', 'Porcentaje', 'Estado', 'Fecha'];
    const rows = logs.map(l => {
      const s = studentMap[l.student_email] || {};
      const e = examMap[l.exam_id] || {};
      const pass = l.pct >= 70 ? 'Aprobado' : 'Reprobado';
      const date = new Date(l.date).toLocaleString('es-MX');
      return [s.name || '', l.student_email, s.section || '', e.title || '', e.questions?.length || '', l.score, l.pct + '%', pass, date];
    });

    const csv = [header, ...rows].map(r => r.map(c => `"${String(c).replace(/"/g, '""')}"`).join(',')).join('\n');
    const blob = new Blob(['\uFEFF' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = `calificaciones_${new Date().toISOString().slice(0, 10)}.csv`;
    a.click();
    URL.revokeObjectURL(url);
    toast('✅ CSV descargado correctamente.', 'success');
  } catch (e) {
    toast('Error al exportar: ' + e.message, 'error');
  }
}

// ============================================================
//  ANUNCIOS
// ============================================================
let cachedAnnouncements = [];

function openLightbox(url) {
  document.getElementById('lightbox-img').src = url;
  openModal('modal-lightbox');
}

/** Alumno: muestra sección de anuncios activos */
async function renderAnnouncements() {
  const section = document.getElementById('announcements-section');
  try {
    const items = await api('GET', '/api/announcements');
    if (!items.length) { section.innerHTML = ''; return; }

    const banners = items.filter(a => a.image_url);
    const texts = items.filter(a => !a.image_url);

    let html = '<h2 class="section-title" style="margin-bottom:0.8rem;">\uD83D\uDCE2 Anuncios</h2>';

    // Banners de imagen (carrusel horizontal)
    if (banners.length) {
      html += `<div class="ann-banners-strip">${banners.map(a => `
        <div class="ann-banner-card" onclick="openLightbox('${a.image_url}')">
          <img src="${a.image_url}" alt="${a.title}" class="ann-banner-img"/>
          <div class="ann-banner-overlay">
            <span class="ann-banner-label">${a.title}</span>
            <span class="ann-banner-zoom">\uD83D\uDD0D Ampliar</span>
          </div>
        </div>`).join('')}</div>`;
    }

    // Anuncios de texto
    if (texts.length) {
      html += texts.map(a => {
        const date = new Date(a.created_at).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
        const linkBtn = a.link_url
          ? `<a href="${a.link_url}" target="_blank" rel="noopener" class="ann-link-btn">\uD83D\uDD17 Abrir enlace</a>`
          : '';
        return `
          <div class="announcement-card">
            <div class="ann-title">${a.title}</div>
            ${a.content ? `<div class="ann-content">${a.content}</div>` : ''}
            <div class="ann-footer-row">
              <span class="ann-date">${date}</span>
              ${linkBtn}
            </div>
          </div>`;
      }).join('');
    }

    html += '<div style="margin-bottom:1rem;"></div>';
    section.innerHTML = html;
  } catch {
    section.innerHTML = '';
  }
}

/** Admin: carga y renderiza la tabla de anuncios */
async function renderAnnouncementsPanel() {
  try {
    cachedAnnouncements = await api('GET', '/api/announcements');
    const tbody = document.getElementById('announcements-tbody');
    if (!cachedAnnouncements.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--text-muted);">Sin anuncios. Crea uno con el bot\u00F3n de arriba.</td></tr>';
      return;
    }
    tbody.innerHTML = cachedAnnouncements.map(a => `
      <tr>
        <td>
          <strong>${a.title}</strong>
          ${a.image_url ? '<span title="Tiene imagen" style="margin-left:0.4rem;">\uD83D\uDDBCufe0f</span>' : ''}
          ${a.link_url ? '<span title="Tiene link"   style="margin-left:0.4rem;">\uD83D\uDD17</span>' : ''}
        </td>
        <td style="color:var(--text-muted);font-size:0.84rem;max-width:220px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;">${a.content || '\u2014'}</td>
        <td><span class="role-badge ${a.active ? 'role-admin' : 'role-student'}">${a.active ? '\u2705 Visible' : '\uD83D\uDD12 Oculto'}</span></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" onclick="openEditAnnouncementModal('${a.id}')">\u270F\uFE0F</button>
          <button class="btn btn-danger btn-sm" onclick="deleteAnnouncement('${a.id}')">\uD83D\uDDD1\uFE0F</button>
        </td>
      </tr>`).join('');
  } catch (e) {
    toast('Error: ' + e.message, 'error');
  }
}

function openAddAnnouncementModal() {
  document.getElementById('ann-edit-id').value = '';
  document.getElementById('ann-title').value = '';
  document.getElementById('ann-content').value = '';
  document.getElementById('ann-link').value = '';
  document.getElementById('ann-image').value = '';
  document.getElementById('ann-active').checked = true;
  document.getElementById('modal-ann-title').textContent = 'Nuevo anuncio';
  openModal('modal-announcement');
}

function openEditAnnouncementModal(id) {
  const a = cachedAnnouncements.find(x => x.id === id);
  if (!a) return;
  document.getElementById('ann-edit-id').value = a.id;
  document.getElementById('ann-title').value = a.title;
  document.getElementById('ann-content').value = a.content || '';
  document.getElementById('ann-link').value = a.link_url || '';
  document.getElementById('ann-image').value = a.image_url || '';
  document.getElementById('ann-active').checked = !!a.active;
  document.getElementById('modal-ann-title').textContent = 'Editar anuncio';
  openModal('modal-announcement');
}

async function saveAnnouncement() {
  const id = document.getElementById('ann-edit-id').value;
  const title = document.getElementById('ann-title').value.trim();
  const content = document.getElementById('ann-content').value.trim();
  const link_url = document.getElementById('ann-link').value.trim();
  const image_url = document.getElementById('ann-image').value.trim();
  const active = document.getElementById('ann-active').checked;

  if (!title) { toast('El t\u00EDtulo es obligatorio.', 'error'); return; }

  try {
    if (id) {
      await api('PUT', `/api/announcements/${id}`, { title, content, active, link_url, image_url });
      toast('Anuncio actualizado.', 'success');

    } else {
      await api('POST', '/api/announcements', { title, content, active, link_url, image_url });
      toast('Anuncio publicado.', 'success');
    }
    closeModal('modal-announcement');
    renderAnnouncementsPanel();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteAnnouncement(id) {
  if (!confirm('¿Eliminar este anuncio?')) return;
  try {
    await api('DELETE', `/api/announcements/${id}`);
    toast('Anuncio eliminado.', 'info');
    renderAnnouncementsPanel();
  } catch (e) {
    toast(e.message, 'error');
  }
}


// ===== INIT =====
async function init() {
  try {
    const { data: { session } } = await supabaseClient.auth.getSession();
    if (session) {
      currentToken = session.access_token;
      sessionStorage.setItem('examapp_token', currentToken);
      currentUser = await api('GET', '/api/auth/me');
      routeUser();
      return;
    }
  } catch {
    currentToken = null;
    sessionStorage.removeItem('examapp_token');
  }
  showView('auth');
}

// Ensure init is called on load if not called elsewhere
document.addEventListener('DOMContentLoaded', () => {
  // If not already in auth or student/admin view, init
  if (!document.querySelector('.view.active')) {
    init();
  }
});

// ============================================================
//  MATERIAL DE ESTUDIO
// ============================================================
let cachedMaterial = [];

/** Admin: carga y muestra la tabla de material */
async function renderMaterialPanel() {
  try {
    cachedMaterial = await api('GET', '/api/material');
    const tbody = document.getElementById('material-tbody');
    if (!cachedMaterial.length) {
      tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;padding:2rem;color:var(--text-muted);">No hay material agregado aún. Haz clic en "+ Agregar material".</td></tr>';
      return;
    }
    tbody.innerHTML = cachedMaterial.map(m => {
      const shortLink = m.link.length > 45 ? m.link.slice(0, 45) + '…' : m.link;
      return `<tr>
        <td><strong>${m.icon || '📄'} ${m.title}</strong></td>
        <td>${m.file_name}</td>
        <td><a href="${m.link}" target="_blank" style="color:var(--primary-light);font-size:0.82rem;word-break:break-all;">${shortLink}</a></td>
        <td style="white-space:nowrap;">
          <button class="btn btn-ghost btn-sm" onclick="openEditMaterialModal('${m.id}')">✏️</button>
          <button class="btn btn-danger btn-sm" onclick="deleteMaterial('${m.id}')">🗑️</button>
        </td>
      </tr>`;
    }).join('');
  } catch (e) {
    toast('Error cargando material: ' + e.message, 'error');
  }
}

/** Alumno: muestra sección de material de estudio encima de los exámenes */
async function renderStudyMaterial() {
  const section = document.getElementById('material-section');
  const grid = document.getElementById('material-grid');
  try {
    const items = await api('GET', '/api/material');
    if (!items.length) { section.style.display = 'none'; return; }

    // Agrupar por título (módulo)
    const groups = {};
    const order = [];
    items.forEach(m => {
      if (!groups[m.title]) { groups[m.title] = []; order.push(m.title); }
      groups[m.title].push(m);
    });

    // Ordenar módulos de forma natural (Módulo 5 → 10 → 11)
    order.sort(naturalSort);
    // Ordenar archivos dentro de cada grupo por nombre
    Object.values(groups).forEach(g => g.sort((a, b) => naturalSort(a.file_name || '', b.file_name || '')));

    grid.innerHTML = order.map((title, i) => {
      const files = groups[title];
      const fileRows = files.map(m => `
        <a class="material-file-row" href="${m.link}" target="_blank" rel="noopener noreferrer">
          <span class="material-file-icon">${m.icon || '📄'}</span>
          <span class="material-file-name">${m.file_name}</span>
          <span class="material-file-open">Abrir en Drive →</span>
        </a>`).join('');

      return `
        <div class="material-module-card">
          <div class="material-module-header" onclick="toggleMaterialGroup(${i})">
            <span class="material-module-icon">📚</span>
            <div class="material-module-info">
              <h4>${title}</h4>
              <span>${files.length} archivo${files.length !== 1 ? 's' : ''}</span>
            </div>
            <span class="exam-group-arrow" id="mat-arrow-${i}">▼</span>
          </div>
          <div class="material-module-body hidden" id="mat-body-${i}">
            ${fileRows}
          </div>
        </div>`;
    }).join('');

    section.style.display = '';
  } catch {
    section.style.display = 'none';
  }
}

function toggleMaterialGroup(i) {
  const body = document.getElementById('mat-body-' + i);
  const arrow = document.getElementById('mat-arrow-' + i);
  if (!body) return;
  body.classList.toggle('hidden');
  if (arrow) arrow.style.transform = body.classList.contains('hidden') ? '' : 'rotate(180deg)';
}

function openAddMaterialModal() {
  document.getElementById('mat-edit-id').value = '';
  document.getElementById('mat-title').value = '';
  document.getElementById('mat-filename').value = '';
  document.getElementById('mat-link').value = '';
  document.getElementById('mat-icon').value = '📄';
  document.getElementById('mat-order').value = '0';
  document.getElementById('modal-material-title').textContent = 'Agregar material';
  openModal('modal-material');
}

function openEditMaterialModal(id) {
  const m = cachedMaterial.find(x => x.id === id);
  if (!m) return;
  document.getElementById('mat-edit-id').value = m.id;
  document.getElementById('mat-title').value = m.title;
  document.getElementById('mat-filename').value = m.file_name;
  document.getElementById('mat-link').value = m.link;
  document.getElementById('mat-icon').value = m.icon || '📄';
  document.getElementById('mat-order').value = m.sort_order || 0;
  document.getElementById('modal-material-title').textContent = 'Editar material';
  openModal('modal-material');
}

async function saveMaterial() {
  const id = document.getElementById('mat-edit-id').value;
  const title = document.getElementById('mat-title').value.trim();
  const file_name = document.getElementById('mat-filename').value.trim();
  const link = document.getElementById('mat-link').value.trim();
  const icon = document.getElementById('mat-icon').value.trim() || '📄';
  const sort_order = parseInt(document.getElementById('mat-order').value) || 0;

  if (!title || !file_name || !link) {
    toast('Título, nombre de archivo y link son obligatorios.', 'error'); return;
  }

  try {
    if (id) {
      await api('PUT', `/api/material/${id}`, { title, file_name, link, icon, sort_order });
      toast('Material actualizado.', 'success');
    } else {
      await api('POST', '/api/material', { title, file_name, link, icon, sort_order });
      toast('Material agregado.', 'success');
    }
    closeModal('modal-material');
    renderMaterialPanel();
  } catch (e) {
    toast(e.message, 'error');
  }
}

async function deleteMaterial(id) {
  if (!confirm('¿Eliminar este archivo de material?')) return;
  try {
    await api('DELETE', `/api/material/${id}`);
    toast('Material eliminado.', 'info');
    renderMaterialPanel();
  } catch (e) {
    toast(e.message, 'error');
  }
}

init();

// ============================================================
//  SISTEMA DE MENSAJES
// ============================================================
let composeMode = 'message'; // 'message' | 'suggestion'
let msgPollInterval = null;
let cachedTeachers = []; // pre-loaded teacher list for the compose modal

/** Alumno: abre modal de composición y carga la lista de profesores */
async function openComposeModal() {
  // 1. Bloquear si el alumno no tiene sección asignada
  if (currentUser && currentUser.role === 'student' && !currentUser.section) {
    toast('⚠️ Necesitas tener una sección asignada para enviar mensajes. Habla con tu profesor.', 'error');
    return;
  }

  // 2. Cargar profesores desde el endpoint seguro /api/teachers
  try {
    cachedTeachers = await api('GET', '/api/teachers');
  } catch {
    cachedTeachers = [];
  }

  const sel = document.getElementById('compose-to');
  if (cachedTeachers.length) {
    sel.innerHTML = cachedTeachers.map(t =>
      `<option value="${t.email}">${t.name} — ${t.role === 'superadmin' ? 'Administrador' : 'Profesor'}</option>`
    ).join('');
  } else {
    sel.innerHTML = '<option value="">No hay profesores registrados</option>';
  }

  document.getElementById('compose-subject').value = '';
  document.getElementById('compose-body').value = '';
  setComposeMode('message');
  openModal('modal-compose');
}

/** Cambia entre tab "Mensaje" y "Sugerencia" */
function setComposeMode(mode) {
  composeMode = mode;
  const isMsg = mode === 'message';
  document.getElementById('tab-msg').classList.toggle('active', isMsg);
  document.getElementById('tab-sug').classList.toggle('active', !isMsg);
  document.getElementById('compose-recipient-group').style.display = isMsg ? '' : 'none';

  if (!isMsg) {
    // Sugerencia → apuntar directamente al superadmin de la lista ya cargada
    const sa = cachedTeachers.find(t => t.role === 'superadmin');
    if (sa) {
      document.getElementById('compose-to').value = sa.email;
    } else {
      // fallback: si el select no tiene su email todavía, seleccionar el primero disponible
      const firstOption = document.querySelector('#compose-to option');
      if (firstOption) document.getElementById('compose-to').value = firstOption.value;
    }
  }

  document.getElementById('compose-title').textContent =
    isMsg ? '💬 Enviar mensaje a profesor' : '💡 Enviar sugerencia al administrador';
}

/** Envía el mensaje */
async function sendMessage() {
  const to_email = document.getElementById('compose-to').value;
  const subject = document.getElementById('compose-subject').value.trim();
  const body = document.getElementById('compose-body').value.trim();

  if (!to_email) { toast('Selecciona un destinatario.', 'error'); return; }
  if (!body) { toast('El mensaje no puede estar vacío.', 'error'); return; }

  try {
    await api('POST', '/api/messages', { to_email, subject, body, type: composeMode });
    closeModal('modal-compose');
    toast('✅ Mensaje enviado correctamente.', 'success');
  } catch (e) {
    toast(e.message, 'error');
  }
}

// ---- Admin: bandeja de entrada ----
let inboxView = 'inbox'; // 'inbox' | 'archived'

/** Cambia la pestaña de la bandeja */
function setInboxView(view) {
  inboxView = view;
  document.getElementById('inbox-tab-inbox').classList.toggle('active', view === 'inbox');
  document.getElementById('inbox-tab-arch').classList.toggle('active', view === 'archived');
  loadInbox();
}

/** Carga y renderiza la bandeja de entrada del admin/profesor */
async function loadInbox() {
  const container = document.getElementById('inbox-list');

  // Render tabs + toolbar skeleton first
  container.innerHTML = `
    <div class="inbox-tabs">
      <button class="inbox-tab active" id="inbox-tab-inbox" onclick="setInboxView('inbox')">📥 Recibidos</button>
      <button class="inbox-tab" id="inbox-tab-arch" onclick="setInboxView('archived')">📦 Archivados</button>
    </div>
    <div id="inbox-toolbar" class="inbox-toolbar hidden"></div>
    <div id="inbox-messages"><p style="color:var(--text-muted);text-align:center;padding:2rem;">Cargando...</p></div>`;

  // Restore active tab state
  document.getElementById('inbox-tab-inbox').classList.toggle('active', inboxView === 'inbox');
  document.getElementById('inbox-tab-arch').classList.toggle('active', inboxView === 'archived');

  try {
    const allMsgs = await api('GET', '/api/messages/inbox');
    const msgs = allMsgs.filter(m => inboxView === 'archived' ? (m.archived === true || m.archived === 1) : (!m.archived));
    const msgDiv = document.getElementById('inbox-messages');
    const toolbar = document.getElementById('inbox-toolbar');

    if (!msgs.length) {
      msgDiv.innerHTML = `<p style="color:var(--text-muted);text-align:center;padding:3rem;">${inboxView === 'archived' ? '📦 No hay mensajes archivados.' : '📭 No tienes mensajes nuevos.'}</p>`;
      return;
    }

    // Toolbar with select-all + actions
    toolbar.classList.remove('hidden');
    toolbar.innerHTML = `
      <label class="inbox-check-label" style="gap:0.5rem;">
        <input type="checkbox" id="inbox-select-all" onchange="toggleSelectAll(this.checked)" />
        <span style="font-size:0.83rem;color:var(--text-muted);">Seleccionar todo</span>
      </label>
      <div class="inbox-actions" id="inbox-bulk-actions" style="display:none;">
        ${inboxView === 'inbox'
        ? `<button class="btn btn-ghost btn-sm" onclick="archiveSelectedMessages()">📦 Archivar</button>`
        : `<button class="btn btn-ghost btn-sm" onclick="archiveSelectedMessages(false)">📥 Mover a recibidos</button>`}
        <button class="btn btn-danger btn-sm" onclick="deleteSelectedMessages()">🗑️ Eliminar</button>
      </div>
      <button class="btn btn-ghost btn-sm" style="margin-left:auto;" onclick="emptyInbox()">
        ${inboxView === 'archived' ? '🗑️ Vaciar archivo' : '🗑️ Vaciar bandeja'}
      </button>`;

    // Message cards
    msgDiv.innerHTML = msgs.map(m => {
      const date = new Date(m.created_at).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const badge = m.type === 'suggestion'
        ? '<span class="msg-type-badge suggestion">💡 Sugerencia</span>'
        : '<span class="msg-type-badge message">💬 Mensaje</span>';
      const unreadDot = (!m.is_read && !m.archived) ? '<span class="msg-unread-dot"></span>' : '';
      const archBtn = inboxView === 'inbox'
        ? `<button class="btn btn-ghost btn-sm inbox-action-btn" title="Archivar" onclick="event.stopPropagation();archiveMessage(${m.id})">📦</button>`
        : `<button class="btn btn-ghost btn-sm inbox-action-btn" title="Mover a recibidos" onclick="event.stopPropagation();archiveMessage(${m.id}, false)">📥</button>`;
      return `
        <div class="inbox-card ${m.is_read ? '' : 'inbox-unread'}" id="msg-card-${m.id}">
          <div class="inbox-card-inner">
            <label class="inbox-check-label" onclick="event.stopPropagation()">
              <input type="checkbox" class="inbox-msg-check" value="${m.id}"
                onchange="onMsgCheckChange()" />
            </label>
            <div class="inbox-card-body" onclick="viewMessage(${m.id},'${escapeAttr(m.from_name || m.from_email)}','${escapeAttr(m.from_section || '')}','${escapeAttr(m.subject || '(sin asunto)')}','${escapeAttr(m.body)}','${date}')">
              <div class="inbox-top">
                ${unreadDot}
                <span class="inbox-from"><strong>${m.from_name || m.from_email}</strong>${m.from_section ? ' · ' + m.from_section : ''}</span>
                ${badge}
                <span class="inbox-date">${date}</span>
              </div>
              <div class="inbox-subject">${m.subject || '(sin asunto)'}</div>
              <div class="inbox-preview">${m.body.slice(0, 110)}${m.body.length > 110 ? '…' : ''}</div>
            </div>
            <div class="inbox-card-btns">
              ${archBtn}
              <button class="btn btn-danger btn-sm inbox-action-btn" title="Eliminar" onclick="event.stopPropagation();deleteMessage(${m.id})">🗑️</button>
            </div>
          </div>
        </div>`;
    }).join('');

    // Mark unread as read after delay
    msgs.filter(m => !m.is_read && inboxView === 'inbox').forEach(m => {
      setTimeout(() => api('PUT', `/api/messages/${m.id}/read`).catch(() => { }), 1500);
    });
    if (inboxView === 'inbox') updateUnreadBadge(0);
  } catch (e) {
    document.getElementById('inbox-messages').innerHTML = `<p style="color:var(--danger);padding:1rem;">${e.message}</p>`;
  }
}

/** Checkbox: mostrar/ocultar barra de acciones */
function onMsgCheckChange() {
  const anyChecked = document.querySelectorAll('.inbox-msg-check:checked').length > 0;
  const bulk = document.getElementById('inbox-bulk-actions');
  if (bulk) bulk.style.display = anyChecked ? 'flex' : 'none';
}

/** Seleccionar/deseleccionar todos */
function toggleSelectAll(checked) {
  document.querySelectorAll('.inbox-msg-check').forEach(cb => { cb.checked = checked; });
  onMsgCheckChange();
}

/** IDs de mensajes seleccionados */
function getSelectedIds() {
  return Array.from(document.querySelectorAll('.inbox-msg-check:checked')).map(cb => Number(cb.value));
}

/** Eliminar mensajes seleccionados */
async function deleteSelectedMessages() {
  const ids = getSelectedIds();
  if (!ids.length) return;
  if (!confirm(`¿Eliminar ${ids.length} mensaje(s)?`)) return;
  try {
    await api('DELETE', '/api/messages/bulk', { ids });
    toast('Mensajes eliminados.', 'info');
    loadInbox();
  } catch (e) { toast(e.message, 'error'); }
}

/** Archivar mensajes seleccionados */
async function archiveSelectedMessages(archive = true) {
  const ids = getSelectedIds();
  if (!ids.length) return;
  try {
    await Promise.all(ids.map(id => api('PUT', `/api/messages/${id}/archive`, { archived: archive })));
    toast(archive ? 'Mensajes archivados.' : 'Mensajes movidos a recibidos.', 'success');
    loadInbox();
  } catch (e) { toast(e.message, 'error'); }
}

/** Eliminar un solo mensaje */
async function deleteMessage(id) {
  if (!confirm('¿Eliminar este mensaje?')) return;
  try {
    await api('DELETE', `/api/messages/${id}`);
    toast('Mensaje eliminado.', 'info');
    loadInbox();
  } catch (e) { toast(e.message, 'error'); }
}

/** Archivar / mover un mensaje */
async function archiveMessage(id, archive = true) {
  try {
    await api('PUT', `/api/messages/${id}/archive`, { archived: archive });
    toast(archive ? 'Archivado.' : 'Movido a recibidos.', 'success');
    loadInbox();
  } catch (e) { toast(e.message, 'error'); }
}

/** Vaciar bandeja o archivo */
async function emptyInbox() {
  const label = inboxView === 'archived' ? 'el archivo' : 'la bandeja';
  if (!confirm(`¿Eliminar TODOS los mensajes de ${label}? Esta acción no se puede deshacer.`)) return;
  try {
    const archived = inboxView === 'archived' ? true : false;
    await api('DELETE', '/api/messages/bulk', { all: true, archived });
    toast('Bandeja vaciada.', 'info');
    loadInbox();
  } catch (e) { toast(e.message, 'error'); }
}

/** Abre modal con el mensaje completo */
function viewMessage(id, fromName, fromSection, subject, body, date) {
  document.getElementById('msg-detail-subject').textContent = subject;
  document.getElementById('msg-detail-meta').innerHTML =
    `<strong>De:</strong> ${fromName}${fromSection ? ' · ' + fromSection : ''} &nbsp;|&nbsp; <strong>Fecha:</strong> ${date}`;
  document.getElementById('msg-detail-body').textContent = body;
  openModal('modal-msg-detail');
}

/** Actualiza el badge de mensajes no leídos en la sidebar */
function updateUnreadBadge(count) {
  const badge = document.getElementById('msg-badge');
  if (!badge) return;
  if (count > 0) {
    badge.textContent = count > 99 ? '99+' : count;
    badge.classList.remove('hidden');
  } else {
    badge.classList.add('hidden');
  }
}

/** Polling de mensajes no leídos (cada 30 s) */
async function pollUnreadCount() {
  try {
    const { count } = await api('GET', '/api/messages/unread');
    updateUnreadBadge(count);
  } catch { /* silencioso */ }
}

function startMessagePolling() {
  pollUnreadCount();
  if (msgPollInterval) clearInterval(msgPollInterval);
  msgPollInterval = setInterval(pollUnreadCount, 30000);
}
function stopMessagePolling() {
  if (msgPollInterval) clearInterval(msgPollInterval);
  msgPollInterval = null;
}

// ============================================================
//  ⚡ QUIZ EN VIVO  (Supabase Realtime Presence + Broadcast)
//  Presence = estado compartido garantizado (pregunta, marcador)
//  Broadcast = mensajes punto a punto (respuesta, resultado)
// ============================================================

// ── Estado del quiz ──────────────────────────────────────────
let lqChannel   = null;   // canal del HOST
let slqChannel  = null;   // canal del ALUMNO (separado)
let lqSessionCode = '';
let lqQuestions   = [];
let lqCurrentQ    = 0;
let lqTimeSec     = 20;
let lqTimerInterval = null;
let lqPlayers     = {};   // { email → { name, score } }
let lqAnswersThisRound = {};
let lqQuestionStart = 0;
let lqIsHost = false;
let lqPhase  = 'idle';

let slqMyEmail   = '';
let slqMyName    = '';
let slqTimerInterval = null;
let slqAnswered  = false;
let slqLastQuestionIdx = -1; // para detectar nueva pregunta y resetear slqAnswered

// ── Helpers ──────────────────────────────────────────────────
function lqGenCode() {
  return Math.random().toString(36).substring(2, 8).toUpperCase();
}

function lqShow(phase) {
  ['live-setup','live-lobby','live-question-ctrl','live-final'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const t = document.getElementById(phase);
  if (t) t.classList.remove('hidden');
}

function slqShow(phase) {
  ['slq-join','slq-waiting','slq-question','slq-answered','slq-scoreboard','slq-final'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const t = document.getElementById(phase);
  if (t) t.classList.remove('hidden');
}

function lqRenderPodium(containerId, scores) {
  const sorted = [...scores].sort((a,b) => b.score - a.score).slice(0,3);
  const medals = ['🥇','🥈','🥉'];
  const colors = ['#FFD700','#C0C0C0','#CD7F32'];
  document.getElementById(containerId).innerHTML = sorted.map((p,i) => `
    <div class="lq-podium-card" style="border-color:${colors[i]||'var(--card-border)'}">
      <div style="font-size:2.5rem;">${medals[i]||''}</div>
      <div style="font-weight:700;font-size:1.1rem;">${p.name}</div>
      <div style="color:var(--secondary);font-size:1.3rem;font-weight:900;">${p.score} pts</div>
    </div>`).join('');
}

function lqRenderScoreRows(containerId, scores) {
  const sorted = [...scores].sort((a,b) => b.score - a.score);
  const medals = ['🥇','🥈','🥉'];
  document.getElementById(containerId).innerHTML = sorted.map((p,i) => `
    <div class="lq-score-row ${i===0?'lq-first':''} ${p.name===slqMyName?'lq-me':''}">
      <span class="lq-rank">${medals[i]||(i+1)}</span>
      <span class="lq-player-name">${p.name}${p.name===slqMyName?' (tú)':''}</span>
      <span class="lq-player-score">${p.score} pts</span>
    </div>`).join('');
}

// ── INICIALIZAR ───────────────────────────────────────────────
function initLivePanel() { lqReset(); }

// ── ADMIN: Previsualizar preguntas ───────────────────────────
function lqPreviewQuestions() {
  const qRaw = document.getElementById('lq-latex-q').value;
  const aRaw = document.getElementById('lq-latex-a').value;
  if (!qRaw.trim()) { toast('Escribe las preguntas primero.', 'error'); return; }
  const qs = lqParseQuestions(qRaw, aRaw);
  if (!qs.length) { toast('No se detectaron preguntas. Revisa el formato.', 'error'); return; }
  const el = document.getElementById('lq-preview');
  el.innerHTML = `<p style="color:var(--text-muted);font-size:0.85rem;margin-bottom:0.5rem;">${qs.length} pregunta(s) detectadas:</p>` +
    qs.map((q,i) => `<p style="margin:0.3rem 0;font-size:0.88rem;">📝 <strong>${i+1}.</strong> ${q.text.slice(0,80)}${q.text.length>80?'…':''}</p>`).join('');
}

// ── ADMIN: Crear sala ────────────────────────────────────────
async function lqStartSession() {
  const qRaw = document.getElementById('lq-latex-q').value;
  const aRaw = document.getElementById('lq-latex-a').value;
  if (!qRaw.trim()) { toast('Escribe las preguntas primero.', 'error'); return; }
  lqQuestions = lqParseQuestions(qRaw, aRaw);
  if (!lqQuestions.length) { toast('No se detectaron preguntas válidas.', 'error'); return; }
  lqTimeSec     = parseInt(document.getElementById('lq-time').value) || 20;
  lqSessionCode = lqGenCode();
  lqIsHost = true;
  lqPlayers = {};
  lqCurrentQ = 0;
  lqPhase = 'lobby';

  lqChannel = supabaseClient.channel(`quiz-${lqSessionCode}`, {
    config: {
      broadcast: { self: false },
      presence:  { key: 'host' }
    }
  });

  // Presence sync → actualiza lista de jugadores
  lqChannel.on('presence', { event: 'sync' }, () => {
    const state = lqChannel.presenceState();
    Object.values(state).flat().forEach(p => {
      if (p.type === 'player' && !lqPlayers[p.email]) {
        lqPlayers[p.email] = { name: p.name, score: 0 };
      }
    });
    lqUpdateLobby();
  });

  // Respuestas de alumnos (broadcast punto a punto)
  lqChannel.on('broadcast', { event: 'answer' }, ({ payload }) => {
    if (lqPhase !== 'question') return;
    if (lqAnswersThisRound[payload.email] !== undefined) return;
    lqAnswersThisRound[payload.email] = payload.answerIdx;

    const elapsed = (Date.now() - lqQuestionStart) / 1000;
    const q = lqQuestions[lqCurrentQ];
    const correct = payload.answerIdx === q.correct;
    let pts = 0;
    if (correct) pts = Math.max(100, Math.round(1000 - elapsed * 40));
    if (lqPlayers[payload.email]) lqPlayers[payload.email].score += pts;

    const answered = Object.keys(lqAnswersThisRound).length;
    const el = document.getElementById('lq-answered-count');
    if (el) el.textContent = ' ' + answered;

    // Resultado individual al alumno
    lqChannel.send({
      type: 'broadcast', event: 'answer_result',
      payload: { email: payload.email, correct, pts, correctIdx: q.correct }
    });
  });

  await lqChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      // Publicar estado inicial: sala de espera
      await lqChannel.track({ type: 'host', phase: 'lobby', code: lqSessionCode });
    }
  });

  document.getElementById('lq-code-display').textContent = lqSessionCode;
  lqShow('live-lobby');
}

function lqUpdateLobby() {
  const players = Object.values(lqPlayers);
  const countEl = document.getElementById('lq-player-count');
  const listEl  = document.getElementById('lq-players-list');
  const btn     = document.getElementById('lq-start-btn');
  if (countEl) countEl.textContent = players.length;
  if (listEl)  listEl.innerHTML = players.map(p => `<span class="lq-player-chip">${p.name}</span>`).join('');
  if (btn) btn.disabled = players.length === 0;
}

function lqCancelSession() {
  if (lqChannel) lqChannel.track({ type: 'host', phase: 'cancelled' });
  setTimeout(() => lqReset(), 500);
}

// ── ADMIN: Iniciar quiz ──────────────────────────────────────
async function lqBeginQuiz() {
  lqCurrentQ = 0;
  lqPhase = 'question';
  lqShow('live-question-ctrl');
  lqShowHostQuestion();
}

function lqShowHostQuestion() {
  const q = lqQuestions[lqCurrentQ];
  lqAnswersThisRound = {};
  lqQuestionStart = Date.now();

  const qCounter = document.getElementById('lq-q-counter');
  const qText    = document.getElementById('lq-host-question');
  const qOpts    = document.getElementById('lq-host-opts');
  const qAns     = document.getElementById('lq-answered-count');
  const scoreMid = document.getElementById('lq-scoreboard-mid');
  const nextBtn  = document.getElementById('lq-next-btn');

  if (qCounter) qCounter.textContent = ` ${lqCurrentQ+1} / ${lqQuestions.length}`;
  if (qText)    qText.textContent = q.text;
  if (qAns)     qAns.textContent  = ' 0';
  if (scoreMid) scoreMid.classList.add('hidden');
  if (nextBtn)  nextBtn.textContent = 'Ver respuestas →';

  const letters = ['A','B','C','D'];
  const colors  = ['lq-opt-red','lq-opt-blue','lq-opt-yellow','lq-opt-green'];
  if (qOpts) qOpts.innerHTML = (q.options||[]).map((o,i) =>
    `<div class="lq-host-opt ${colors[i]}">${letters[i]}) ${o}</div>`).join('');

  // Publicar estado de pregunta en Presence (garantizado a todos)
  lqChannel.track({
    type: 'host', phase: 'question',
    questionIdx: lqCurrentQ,
    text: q.text,
    options: q.options || [],
    total: lqQuestions.length,
    timeSec: lqTimeSec,
    startTime: Date.now()
  });

  // Temporizador del host
  let t = lqTimeSec;
  const timerEl = document.getElementById('lq-host-timer');
  if (timerEl) timerEl.textContent = t;
  if (lqTimerInterval) clearInterval(lqTimerInterval);
  lqTimerInterval = setInterval(() => {
    t--;
    if (timerEl) timerEl.textContent = t;
    if (t <= 0) { clearInterval(lqTimerInterval); lqTimeUp(); }
  }, 1000);
}

function lqTimeUp() {
  lqPhase = 'scores';
  const scores = Object.values(lqPlayers).map(p => ({ name: p.name, score: p.score }));

  // Publicar marcador en Presence
  lqChannel.track({ type: 'host', phase: 'scores', scores, correctIdx: lqQuestions[lqCurrentQ]?.correct ?? -1 });

  // Mostrar marcador en panel host
  const rowsEl  = document.getElementById('lq-scoreboard-rows');
  const midEl   = document.getElementById('lq-scoreboard-mid');
  const nextBtn = document.getElementById('lq-next-btn');
  if (rowsEl)  lqRenderScoreRows('lq-scoreboard-rows', scores);
  if (midEl)   midEl.classList.remove('hidden');
  if (nextBtn) nextBtn.textContent =
    lqCurrentQ + 1 < lqQuestions.length ? 'Siguiente pregunta →' : '🏆 Ver ganador';
}

function lqNextQuestion() {
  if (lqPhase === 'question') { clearInterval(lqTimerInterval); lqTimeUp(); return; }
  lqCurrentQ++;
  if (lqCurrentQ >= lqQuestions.length) { lqEndQuiz(); return; }
  lqPhase = 'question';
  const midEl = document.getElementById('lq-scoreboard-mid');
  if (midEl) midEl.classList.add('hidden');
  lqShowHostQuestion();
}

function lqEndQuiz() {
  lqPhase = 'final';
  const scores = Object.values(lqPlayers).map(p => ({ name: p.name, score: p.score }));
  lqChannel.track({ type: 'host', phase: 'final', scores });
  lqShow('live-final');
  lqRenderPodium('lq-final-podium', scores);
}

function lqAbortQuiz() {
  if (!confirm('¿Terminar el quiz antes de que termine?')) return;
  clearInterval(lqTimerInterval);
  lqEndQuiz();
}

function lqReset() {
  clearInterval(lqTimerInterval);
  if (lqChannel) { supabaseClient.removeChannel(lqChannel); lqChannel = null; }
  lqPhase = 'idle'; lqPlayers = {}; lqCurrentQ = 0; lqIsHost = false;
  lqShow('live-setup');
  const preview = document.getElementById('lq-preview');
  if (preview) preview.innerHTML = '';
}

// ── ALUMNO: Modal ────────────────────────────────────────────
function showStudentLiveSection() {
  const modal = document.getElementById('slq-modal-overlay');
  if (!modal) return;
  modal.classList.remove('hidden');
  slqShow('slq-join');
  const inp = document.getElementById('slq-code-input');
  if (inp) { inp.value = ''; setTimeout(() => inp.focus(), 200); }
}

function slqCloseModal() {
  const modal = document.getElementById('slq-modal-overlay');
  if (modal) modal.classList.add('hidden');
}

// ── ALUMNO: Unirse ───────────────────────────────────────────
async function slqJoin() {
  const code = document.getElementById('slq-code-input').value.trim().toUpperCase();
  if (code.length < 4) { toast('Ingresa el código de la sala.', 'error'); return; }

  slqMyEmail = currentUser?.email || 'anon';
  slqMyName  = currentUser?.name  || currentUser?.email || 'Alumno';

  if (slqChannel) { supabaseClient.removeChannel(slqChannel); slqChannel = null; }

  slqChannel = supabaseClient.channel(`quiz-${code}`, {
    config: {
      broadcast: { self: false },
      presence:  { key: slqMyEmail }
    }
  });

  // ── Presencia: el host actualiza su estado (pregunta, marcador, final) ──
  slqChannel.on('presence', { event: 'sync' }, () => {
    const state = slqChannel.presenceState();
    const hostArr = state['host'];
    if (!hostArr || hostArr.length === 0) return;
    const h = hostArr[0];

    if (h.phase === 'question') {
      // ¡KEY FIX! Resetear slqAnswered cuando llega una NUEVA pregunta
      const qIdx = h.questionIdx ?? 0;
      if (qIdx !== slqLastQuestionIdx) {
        slqAnswered = false;
        slqLastQuestionIdx = qIdx;
      }
      if (!slqAnswered) {
        const elapsed = Math.round((Date.now() - (h.startTime || Date.now())) / 1000);
        slqRenderQuestion(h, elapsed);
      }
    } else if (h.phase === 'scores') {
      clearInterval(slqTimerInterval);
      slqShow('slq-scoreboard');
      lqRenderScoreRows('slq-score-rows', h.scores || []);
    } else if (h.phase === 'final') {
      clearInterval(slqTimerInterval);
      slqShow('slq-final');
      lqRenderPodium('slq-final-podium', h.scores || []);
    } else if (h.phase === 'cancelled') {
      toast('El profesor canceló el quiz.', 'info');
      slqExit();
    }
  });


  // ── Resultado de respuesta individual ────────────────────────
  slqChannel.on('broadcast', { event: 'answer_result' }, ({ payload }) => {
    if (payload.email !== slqMyEmail) return;
    clearInterval(slqTimerInterval);
    slqShow('slq-answered');
    document.getElementById('slq-result-icon').textContent = payload.correct ? '✅' : '❌';
    document.getElementById('slq-result-text').textContent = payload.correct ? '¡Correcto!' : 'Incorrecto';
    document.getElementById('slq-points-gained').textContent = payload.correct ? `+${payload.pts} puntos` : '';
  });

  await slqChannel.subscribe(async (status) => {
    if (status === 'SUBSCRIBED') {
      // Registrar presencia del alumno → host lo ve en el lobby
      await slqChannel.track({ type: 'player', email: slqMyEmail, name: slqMyName });
    }
  });

  document.getElementById('slq-room-display').textContent = code;
  slqShow('slq-waiting');
}

// ── Renderizar texto con LaTeX para el quiz ──────────────────
/**
 * Procesa texto con LaTeX para mostrar en HTML.
 * Maneja: \textbf, \textit, \underline, \emph, \text, \rule,
 *          $...$, $$...$$, \(...\), \[...\]
 */
function lqProcessText(raw) {
  if (!raw) return '';
  // 1. Escape HTML (seguridad)
  let t = raw
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  // 2. Comandos de texto LaTeX más comunes
  // Un solo nivel de llaves (no anidadas)
  t = t.replace(/\\textbf\{([^}]*)\}/g,   '<strong>$1</strong>');
  t = t.replace(/\\textit\{([^}]*)\}/g,   '<em>$1</em>');
  t = t.replace(/\\emph\{([^}]*)\}/g,     '<em>$1</em>');
  t = t.replace(/\\underline\{([^}]*)\}/g,'<u>$1</u>');
  t = t.replace(/\\texttt\{([^}]*)\}/g,   '<code>$1</code>');
  t = t.replace(/\\textsc\{([^}]*)\}/g,   '<span style="font-variant:small-caps">$1</span>');
  t = t.replace(/\\textsuperscript\{([^}]*)\}/g, '<sup>$1</sup>');
  t = t.replace(/\\textsubscript\{([^}]*)\}/g,   '<sub>$1</sub>');
  // \text{} dentro de modo matemático (fuera): tratar como texto plano
  t = t.replace(/\\text\{([^}]*)\}/g, '$1');
  // Saltos de línea LaTeX
  t = t.replace(/\\\\/g, '<br>');
  t = t.replace(/\\newline/g, '<br>');
  t = t.replace(/\\par\b/g, '</p><p>');

  // 3. \rule{w}{h}  →  línea en blanco visual _____
  t = t.replace(/\\rule\{[^}]*\}\{[^}]*\}/g,
    '<span class="lq-blank">______</span>');

  // 4. $$...$$ matemática en bloque
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    try { return typeof katex !== 'undefined'
      ? katex.renderToString(math.trim(), { displayMode: true,  throwOnError: false })
      : `[${math}]`; } catch(e) { return `[${math}]`; }
  });
  // 5. $...$ matemática en línea
  t = t.replace(/\$([^$\n]+?)\$/g, (_, math) => {
    try { return typeof katex !== 'undefined'
      ? katex.renderToString(math.trim(), { displayMode: false, throwOnError: false })
      : `[${math}]`; } catch(e) { return `[${math}]`; }
  });
  // 6. \(... \) y \[... \]
  t = t.replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => {
    try { return typeof katex !== 'undefined'
      ? katex.renderToString(math.trim(), { displayMode: false, throwOnError: false })
      : `[${math}]`; } catch(e) { return `[${math}]`; }
  });
  t = t.replace(/\\\[([\s\S]+?)\\\]/g, (_, math) => {
    try { return typeof katex !== 'undefined'
      ? katex.renderToString(math.trim(), { displayMode: true,  throwOnError: false })
      : `[${math}]`; } catch(e) { return `[${math}]`; }
  });
  return t;
}

// ── ALUMNO: Renderizar pregunta ──────────────────────────────
function slqRenderQuestion(h, elapsedSec) {
  const remaining = Math.max(2, (h.timeSec || 20) - elapsedSec);
  slqAnswered = false;
  slqShow('slq-question');

  const numEl  = document.getElementById('slq-q-num');
  const textEl = document.getElementById('slq-q-text');
  const optsEl = document.getElementById('slq-options');
  const timerEl = document.getElementById('slq-timer');

  if (numEl)  numEl.textContent  = `Pregunta ${(h.questionIdx||0)+1} de ${h.total||'?'}`;
  if (textEl) textEl.textContent = h.text || '';

  // Renderizar opciones con KaTeX si está disponible
  const colors  = ['lq-opt-red','lq-opt-blue','lq-opt-yellow','lq-opt-green'];
  const letters = ['A','B','C','D'];
  if (optsEl) optsEl.innerHTML = (h.options||[]).map((o, i) => `
    <button class="lq-student-btn ${colors[i]}" onclick="slqAnswer(${i})" id="slq-btn-${i}">
      <span class="lq-btn-letter">${letters[i]}</span>
      <span class="lq-btn-text">${o}</span>
    </button>`).join('');

  // Renderizar LaTeX en la pregunta y opciones si KaTeX está disponible
  if (typeof renderMathInElement === 'function') {
    try {
      const container = document.getElementById('slq-question');
      if (container) renderMathInElement(container, { delimiters:[
        {left:'$$',right:'$$',display:true},{left:'$',right:'$',display:false},
        {left:'\\(',right:'\\)',display:false},{left:'\\[',right:'\\]',display:true}
      ], throwOnError: false });
    } catch(e) {}
  }

  // Temporizador
  if (timerEl) { timerEl.textContent = remaining; timerEl.style.color = ''; }
  if (slqTimerInterval) clearInterval(slqTimerInterval);
  let t = remaining;
  slqTimerInterval = setInterval(() => {
    t--;
    if (timerEl) { timerEl.textContent = t; if (t <= 3) timerEl.style.color = 'var(--danger)'; }
    if (t <= 0) clearInterval(slqTimerInterval);
  }, 1000);
}

// ── ALUMNO: Enviar respuesta ─────────────────────────────────
function slqAnswer(idx) {
  if (slqAnswered) return;
  slqAnswered = true;
  clearInterval(slqTimerInterval);

  document.querySelectorAll('.lq-student-btn').forEach(b => b.disabled = true);
  const sel = document.getElementById(`slq-btn-${idx}`);
  if (sel) sel.classList.add('lq-selected');

  slqChannel.send({
    type: 'broadcast', event: 'answer',
    payload: { email: slqMyEmail, answerIdx: idx }
  });

  slqShow('slq-answered');
  document.getElementById('slq-result-icon').textContent  = '⏳';
  document.getElementById('slq-result-text').textContent  = 'Respuesta enviada';
  document.getElementById('slq-points-gained').textContent = 'Esperando resultado...';
}

// ── ALUMNO: Salir ────────────────────────────────────────────
function slqExit() {
  clearInterval(slqTimerInterval);
  if (slqChannel) { supabaseClient.removeChannel(slqChannel); slqChannel = null; }
  slqAnswered  = false;
  slqMyEmail   = '';
  slqMyName    = '';
  slqCloseModal();
}

// ── Parser de preguntas ──────────────────────────────────────
function lqParseQuestions(qRaw, aRaw) {
  const qs = typeof parseLatexQuestions === 'function' ? parseLatexQuestions(qRaw) : [];
  if (qs.length && aRaw && aRaw.trim()) {
    const answers = typeof parseLatexAnswers === 'function' ? parseLatexAnswers(aRaw) : {};
    qs.forEach((q, i) => {
      const key = i + 1;
      if (answers[key] !== undefined && answers[key] < (q.options||[]).length) q.correct = answers[key];
    });
  }
  return qs;
}
