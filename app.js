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
  // \begin{equation} y \begin{equation*}
  safe = safe.replace(/\\begin\{equation\*?\}[\s\S]+?\\end\{equation\*?\}/g, m => { mathBlocks.push(m); return `\x00MATH${mathBlocks.length - 1}\x00`; });

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

  // ── PASO 2.5: Soporte experimental para listas LaTeX (enumerate/item) ──
  safe = safe.replace(/\\begin\{enumerate\}(?:\[.*?\])?/g, '<ol class="list-decimal ml-6 mb-4 space-y-1">');
  safe = safe.replace(/\\end\{enumerate\}/g, '</ol>');
  safe = safe.replace(/\\item\s+/g, '<li>');

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
      if (error) {
        // Si ya existe en Auth pero no en profiles (fue eliminado a medias), recrear el profile
        if (error.message.includes('already registered') || error.message.includes('User already registered')) {
          const { data: loginData, error: loginErr } = await supabaseClient.auth.signInWithPassword(
            { email: body.email, password: body.password });
          if (loginErr) throw new Error('El correo ya está registrado. Usa otro correo o contacta al administrador.');
          // Reinsertar profile (puede que ya exista, usar upsert)
          await supabaseClient.from('profiles').upsert(
            { email: body.email.toLowerCase(), name: body.name, role: 'student', section: '', allowed_exams: [] },
            { onConflict: 'email' });
          return { token: loginData.session.access_token, user: { email: body.email.toLowerCase(), name: body.name, role: 'student', allowedExams: [] } };
        }
        throw new Error(error.message);
      }
      await supabaseClient.from('profiles').insert({ email: body.email.toLowerCase(), name: body.name, role: 'student', section: '', allowed_exams: [] });
      return { token: data.session?.access_token, user: { email: body.email.toLowerCase(), name: body.name, role: 'student', allowedExams: [] } };
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
      // 1. Borrar de las tablas de la app
      await supabaseClient.from('profiles').delete().eq('email', targetEmail);
      await supabaseClient.from('logs').delete().eq('student_email', targetEmail);
      // 2. Borrar de Supabase Auth mediante función SQL con SECURITY DEFINER
      //    (La anon key no puede usar auth.admin directamente)
      try {
        await supabaseClient.rpc('delete_auth_user_by_email', { target_email: targetEmail });
      } catch (authErr) {
        console.warn('delete_auth_user_by_email RPC:', authErr.message);
      }
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
  document.querySelectorAll('.view').forEach(v => {
    v.classList.remove('active');
    v.classList.add('hidden');
  });
  const el = document.getElementById('view-' + id);
  if (el) {
    el.classList.remove('hidden');
    el.classList.add('active');
  }
}

function goView(id) {
  if (id.startsWith('view-')) id = id.replace('view-', '');
  showView(id);
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
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
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
    localStorage.setItem('currentUser', JSON.stringify(currentUser));
    toast('¡Cuenta creada! Bienvenido/a, ' + name + '.', 'success');
    routeUser();
  } catch (e) {
    showError('reg-error', e.message);
  }
}

async function logout() {
  stopMessagePolling();
  currentUser = null;
  currentToken = null;
  activeExam = null;
  examState = {};
  cachedStudents = [];
  cachedExams = [];
  sessionStorage.removeItem('examapp_token');
  localStorage.removeItem('currentUser');
  try { await supabaseClient.auth.signOut(); } catch (e) { console.error(e); }
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
  document.getElementById('student-display-section').innerHTML = u.section ? '<i data-lucide="map-pin" class="w-3.5 h-3.5 text-brand-400 inline mr-1"></i> ' + u.section : 'Sin sección asignada';

  const grid = document.getElementById('exams-grid');
  grid.innerHTML = '<div class="no-exams"><div class="no-exams-icon animate-spin"><i data-lucide="loader-2" class="w-12 h-12"></i></div><p>Cargando exámenes...</p></div>';

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
      grid.innerHTML = '<div class="no-exams"><div class="no-exams-icon"><i data-lucide="inbox" class="w-12 h-12"></i></div><p>No hay exámenes disponibles aún.</p></div>';
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
    grid.innerHTML = html;
    if (window.updateIcons) window.updateIcons();
    updateGlobalScore(logs);
    if (window.lucide) window.lucide.createIcons();
  } catch (e) {
    grid.innerHTML = `<div class="no-exams"><div class="no-exams-icon"><i data-lucide="alert-triangle" class="icon-xl"></i></div><p>${e.message}</p></div>`;
  }
}

/** Calcula el puntaje global del alumno y actualiza la tarjeta de gamification */
function updateGlobalScore(logs) {
  const el   = document.getElementById('student-global-score');
  const bar  = document.getElementById('student-global-progress');
  const txt  = document.getElementById('student-global-level-text');
  if (!el || !bar || !txt) return;

  // Suma de pct de cada MEJOR intento por examen
  const best = {};
  (logs || []).forEach(l => {
    if (best[l.exam_id] === undefined || l.pct > best[l.exam_id]) best[l.exam_id] = l.pct;
  });
  const total = Object.values(best).reduce((sum, p) => sum + p, 0);

  // Niveles: Bronce 0-299, Plata 300-599, Oro 600-999, Diamante 1000+
  const levels = [
    { name: 'Nivel Bronce <i data-lucide="medal" class="w-4 h-4 inline text-yellow-700"></i>', min: 0,    max: 300,  color: 'from-yellow-700 to-yellow-500' },
    { name: 'Nivel Plata <i data-lucide="medal" class="w-4 h-4 inline text-gray-400"></i>',  min: 300,  max: 600,  color: 'from-gray-300 to-gray-500' },
    { name: 'Nivel Oro <i data-lucide="award" class="w-4 h-4 inline text-yellow-500"></i>',   min: 600,  max: 1000, color: 'from-yellow-300 to-yellow-600' },
    { name: 'Diamante <i data-lucide="gem" class="w-4 h-4 inline text-sky-400"></i>',    min: 1000, max: 2000, color: 'from-sky-300 to-blue-500' },
  ];
  const lvl = levels.findLast(l => total >= l.min) || levels[0];
  const pct = Math.min(100, Math.round(((total - lvl.min) / (lvl.max - lvl.min)) * 100));
  const remaining = Math.max(0, lvl.max - total);

  el.textContent = total.toLocaleString('es-MX');
  // Update gradient class
  el.className = el.className.replace(/from-\S+ to-\S+/, lvl.color);
  bar.style.width = pct + '%';
  txt.innerHTML = remaining > 0 ? `¡A ${remaining} pts del siguiente nivel!` : `¡<i data-lucide="party-popper" class="w-4 h-4 inline text-brand-400"></i> Máximo nivel alcanzado!`;
}

function lockedMsg() {
  toast('Este examen está bloqueado. Solicita permiso a tu profesor.', 'error');
}

function scoreTag(pct) {
  const base = "px-2.5 py-1 rounded-lg text-[10px] font-black tracking-wider uppercase border flex items-center gap-1.5 shadow-sm whitespace-nowrap";
  if (pct === 100) return `<span class="${base} bg-gradient-to-r from-blue-500/30 to-blue-600/20 text-blue-300 border-blue-500/30 shadow-[0_0_15px_rgba(59,130,246,0.2)]"><i data-lucide="star" class="w-3.5 h-3.5 fill-blue-400"></i> 100%</span>`;
  if (pct >= 70) return `<span class="${base} bg-gradient-to-r from-emerald-500/20 to-emerald-600/20 text-emerald-300 border-emerald-500/20"><i data-lucide="check-circle" class="w-3.5 h-3.5"></i> ${pct}%</span>`;
  if (pct >= 40) return `<span class="${base} bg-gradient-to-r from-yellow-500/20 to-yellow-600/20 text-yellow-300 border-yellow-500/20"><i data-lucide="alert-triangle" class="w-3.5 h-3.5"></i> ${pct}%</span>`;
  return `<span class="${base} bg-gradient-to-r from-red-500/20 to-red-600/20 text-red-300 border-red-500/20"><i data-lucide="x-circle" class="w-3.5 h-3.5"></i> ${pct}%</span>`;
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
  const pct = lastLog ? lastLog.pct : null;
  const isNew = pct === null;

  // Badge de estado
  let badge = '';
  if (!exam.allowed) {
    badge = `<span class="px-2.5 py-1 rounded-lg bg-red-500/10 border border-red-500/20 text-red-400 text-xs font-bold uppercase tracking-wider flex items-center gap-1">
               <i data-lucide="lock" class="w-3 h-3"></i> Bloqueado
             </span>`;
  } else if (isNew) {
    badge = `<span class="px-2.5 py-1 rounded-lg bg-emerald-500/10 border border-emerald-500/20 text-emerald-400 text-xs font-bold uppercase tracking-wider flex items-center gap-1">
               <span class="w-1.5 h-1.5 rounded-full bg-emerald-400 animate-pulse"></span> Nuevo
             </span>`;
  } else if (pct >= 100) {
    badge = `<span class="px-2.5 py-1 rounded-lg bg-blue-500/10 border border-blue-500/20 text-blue-400 text-xs font-bold uppercase tracking-wider flex items-center gap-1">
               <i data-lucide="star" class="w-3 h-3 fill-blue-400"></i> ${pct}%
             </span>`;
  } else if (pct >= 70) {
    badge = `<span class="px-2.5 py-1 rounded-lg bg-yellow-500/10 border border-yellow-500/20 text-yellow-400 text-xs font-bold uppercase tracking-wider">
               Reintentar · ${pct}%
             </span>`;
  } else {
    badge = `<span class="px-2.5 py-1 rounded-lg bg-orange-500/10 border border-orange-500/20 text-orange-400 text-xs font-bold uppercase tracking-wider">
               Mejorar · ${pct}%
             </span>`;
  }

  const examIcon = (exam.icon && exam.icon.length < 4) ? `<i data-lucide="file-text" class="w-6 h-6 text-brand-300"></i>` : (exam.icon || `<i data-lucide="file-text" class="w-6 h-6 text-brand-300"></i>`);
  const iconBg = !exam.allowed ? 'bg-gray-500/20 border-gray-500/20' : 'bg-brand-400/20 border-brand-500/20';
  const actionIcon = exam.allowed
    ? (isNew ? 'arrow-right' : 'refresh-cw')
    : 'lock';
  const hoverBorderColor = !exam.allowed ? 'hover:border-red-400/30' : (pct !== null ? 'hover:border-accent-pink/50' : 'hover:border-brand-400/50');
  const hoverGlow = !exam.allowed ? '' : (pct !== null ? 'from-accent-pink/5' : 'from-brand-400/5');

  const progressRow = pct !== null && exam.allowed ? `
    <div class="flex flex-col gap-1 w-full mr-4">
      <div class="flex justify-between text-xs font-medium text-gray-400">
        <span>Último intento</span>
        <span class="text-white">${pct}%</span>
      </div>
      <div class="w-full bg-white/5 rounded-full h-1.5 overflow-hidden">
        <div class="bg-gradient-to-r from-accent-pink to-brand-400 h-1.5 rounded-full" style="width: ${pct}%"></div>
      </div>
    </div>` : `
    <div class="flex items-center gap-3 text-xs text-gray-400">
      ${exam.time_limit > 0 ? `<span class="flex items-center gap-1"><i data-lucide="clock" class="w-3.5 h-3.5"></i> ${exam.time_limit}&nbsp;min</span>` : ''}
      <span class="flex items-center gap-1"><i data-lucide="help-circle" class="w-3.5 h-3.5"></i> ${exam.questions.length}&nbsp;Preg.</span>
    </div>`;

  return `
    <div class="group relative glass-card rounded-3xl p-6 border border-white/10 ${hoverBorderColor} transition-all duration-300 ${exam.allowed ? 'hover:-translate-y-2 cursor-pointer' : 'opacity-80 grayscale-[0.3] cursor-not-allowed'} isolate" onclick="${exam.allowed ? `startExam('${exam.id}')` : 'lockedMsg()'}">
      <div class="absolute inset-0 bg-gradient-to-br ${hoverGlow} to-transparent opacity-0 ${exam.allowed ? 'group-hover:opacity-100' : ''} transition-opacity rounded-3xl -z-10"></div>

      <div class="flex justify-between items-start mb-4">
        <div class="w-12 h-12 rounded-2xl ${iconBg} text-brand-400 flex items-center justify-center border transition-transform group-hover:scale-110">
          ${examIcon}
        </div>
        ${badge}
      </div>
      
      <h3 class="font-outfit text-xl font-bold text-white mb-2 group-hover:text-brand-300 transition-colors">${exam.title}</h3>
      <p class="text-gray-400 text-sm mb-6 line-clamp-2">${exam.description || ''}</p>
      
      <div class="flex items-center justify-between pt-4 border-t border-white/5">
        ${progressRow}
        <div class="w-8 h-8 flex-shrink-0 rounded-full bg-white/5 ${exam.allowed ? 'group-hover:bg-brand-400' : ''} flex items-center justify-center transition-colors">
          <i data-lucide="${actionIcon}" class="w-4 h-4 text-white"></i>
        </div>
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
    const scoreHtml = lastLog ? scoreTag(lastLog.pct) : '<span class="px-2 py-1 rounded-lg text-[9px] font-bold tracking-wider uppercase bg-white/5 text-gray-500 border border-white/5">Sin intentar</span>';
    return `
      <div class="flex items-center justify-between p-3 border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors cursor-pointer group/unit rounded-xl ${!exam.allowed ? 'opacity-60' : ''}" onclick="${exam.allowed ? `startExam('${exam.id}')` : 'lockedMsg()'}">
        <div class="flex items-center gap-3 overflow-hidden">
          <div class="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center shrink-0 border border-white/10 group-hover/unit:bg-white/10 transition-colors">
            ${!exam.allowed ? '<i data-lucide="lock" class="w-3.5 h-3.5 text-gray-500"></i>' : '<i data-lucide="file-text" class="w-3.5 h-3.5 text-brand-400"></i>'}
          </div>
          <div class="flex flex-col truncate">
            <span class="text-sm font-bold text-gray-200 group-hover/unit:text-white transition-colors truncate">${unit}</span>
            ${!exam.allowed ? '<span class="text-[0.7rem] text-red-400/80 font-medium">Bloqueado</span>' : `<span class="text-[0.7rem] text-gray-500">${exam.questions.length} preguntas</span>`}
          </div>
        </div>
        <div class="shrink-0 pl-2 ml-auto">${scoreHtml}</div>
      </div>`;
  }).join('');

  return `
    <div class="glass-card rounded-3xl flex flex-col relative overflow-hidden transition-all duration-300 border border-white/5">
      <div class="p-5 flex items-center gap-4 cursor-pointer hover:bg-white/5 transition-colors z-10" onclick="toggleExamGroup(${gIdx})">
        <div class="w-12 h-12 rounded-2xl bg-gradient-to-br from-brand-500/30 to-brand-400/10 flex items-center justify-center text-2xl shadow-inner border border-brand-500/20 shrink-0">
          <i data-lucide="book-open" class="w-6 h-6 text-brand-300"></i>
        </div>
        <div class="flex flex-col flex-1">
          <h3 class="text-lg font-black text-white leading-tight font-outfit mt-0.5">${title}</h3>
          <p class="text-[0.8rem] text-gray-400 font-medium mt-0.5">${exams.length} unidades <span class="mx-1">•</span> ${anyAllowed ? '<span class="text-brand-400">Disponible</span>' : '<span class="text-red-400">Bloqueado</span>'}</p>
        </div>
        <div class="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center shrink-0 border border-white/10 text-gray-400 transition-transform duration-300" id="group-arrow-${gIdx}">
          <i data-lucide="chevron-down" class="w-4 h-4"></i>
        </div>
      </div>
      <div class="hidden flex-col gap-1 px-3 pb-3 pt-1 border-t border-white/5 bg-black/20" id="group-body-${gIdx}">
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
  timerEl.innerHTML = `<i data-lucide="clock" class="w-4 h-4 inline mr-1"></i> ${String(min).padStart(2, '0')}:${String(sec).padStart(2, '0')}`;
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
    <button class="option-btn w-full text-left p-4 rounded-2xl glass-panel relative overflow-hidden transition-all group hover:-translate-y-1 hover:shadow-lg focus:outline-none focus:ring-2 focus:ring-brand-500/50 border border-white/5 flex items-center gap-4 cursor-pointer" id="opt-${i}" onclick="selectOption(${i})">
      <div class="w-10 h-10 rounded-xl bg-white/5 text-gray-400 flex items-center justify-center font-black text-lg border border-white/10 group-hover:bg-white/10 transition-colors shrink-0 shadow-inner option-letter-box">
        ${letters[i]}
      </div>
      <div class="text-[0.95rem] text-gray-300 group-hover:text-white transition-colors flex-1 option-text-box latex-container pointer-events-none">${formatLatexText(opt)}</div>
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
    ? `<div class="feedback-justification"><i data-lucide="lightbulb" class="w-4 h-4 inline text-yellow-500 mr-1"></i> <strong>Justificación:</strong> ${lqProcessText(q.justification)}</div>`
    : '';

  if (isOk) {
    fb.innerHTML = `<span class="feedback-icon"><i data-lucide="check-circle" class="w-8 h-8 text-emerald-400"></i></span><div><span>¡Correcto! Bien hecho.</span>${justHTML}</div>`;
  } else {
    fb.innerHTML = `
      <span class="feedback-icon"><i data-lucide="x-circle" class="w-8 h-8 text-red-400"></i></span>
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
    emoji = '<i data-lucide="trophy" class="w-16 h-16 text-yellow-500"></i>'; title = '¡Perfecto!'; subtitle = 'Obtuviste el máximo puntaje. ¡Excelente trabajo!';
  } else if (pct >= 70) {
    color = '#7be0c5'; cssClass = 'results-excellent';
    emoji = '<i data-lucide="party-popper" class="w-16 h-16 text-emerald-400"></i>'; title = '¡Bien hecho!'; subtitle = 'Superaste el 70%. ¡Sigue así!';
  } else if (pct >= 40) {
    color = 'var(--warning)'; cssClass = 'results-good';
    emoji = '<i data-lucide="meh" class="w-16 h-16 text-yellow-400"></i>'; title = 'Puedes mejorar'; subtitle = 'Estás en camino. ¡Repasa y vuelve a intentarlo!';
  } else {
    color = 'var(--danger)'; cssClass = 'results-bad';
    emoji = '<i data-lucide="book-open" class="w-16 h-16 text-red-400"></i>'; title = 'Sigue practicando'; subtitle = 'No te desanimes. Repasa el material e inténtalo de nuevo.';
  }

  document.getElementById('results-emoji').innerHTML = emoji;
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
    const avatarIcon = isSuperAdmin ? '<i data-lucide="crown" class="w-5 h-5"></i>' : '<i data-lucide="book-open" class="w-5 h-5"></i>';
    const el = document.getElementById('admin-role-label');
    const nm = document.getElementById('admin-name-label');
    const av = document.getElementById('admin-avatar');
    if (el) el.textContent = roleLabel;
    if (nm) nm.textContent = currentUser.name || currentUser.email;
    if (av) av.innerHTML = avatarIcon;
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
    populateSectionFilter(students);
    applyStudentFilters();
    renderExamsTable(exams);
    renderRecentActivity(logs, students, exams);
    renderAnalytics();
    
    // Inicializar selectores personalizados
    initCustomSelect('analytics-exam-filter');
    initCustomSelect('filter-section');
    initCustomSelect('filter-role');
  } catch (e) {
    toast('Error cargando datos: ' + e.message, 'error');
  }
  startMessagePolling();
}

function showPanel(name) {
  document.querySelectorAll('.admin-panel').forEach(p => {
    p.classList.remove('active');
    p.classList.add('hidden');
  });
  const panel = document.getElementById('panel-' + name);
  if (panel) {
    panel.classList.add('active');
    panel.classList.remove('hidden');
  }
  
  document.querySelectorAll('.sidebar-item').forEach(b => b.classList.remove('active'));
  const navItem = document.getElementById('nav-' + name);
  if (navItem) navItem.classList.add('active');
  
  // Cargar datos del panel activo
  if (name === 'material') renderMaterialPanel();
  if (name === 'announcements') renderAnnouncementsPanel();
  if (name === 'overview') renderAnalytics();
  if (name === 'live') initLivePanel();
}

function toggleDropdown(id) {
  const dropdown = document.getElementById(id);
  const icon = document.getElementById('icon-' + id);
  if (!dropdown) return;
  
  document.querySelectorAll('[id^="drop-"]').forEach(el => {
    if (el.id !== id && !el.classList.contains('hidden')) {
      el.classList.add('hidden');
      const otherIcon = document.getElementById('icon-' + el.id);
      if (otherIcon) otherIcon.classList.remove('rotate-180');
    }
  });

  dropdown.classList.toggle('hidden');
  if (icon) icon.classList.toggle('rotate-180');
}

// Close dropdowns if clicking outside
document.addEventListener('click', (e) => {
  if (!e.target.closest('.group')) {
    document.querySelectorAll('[id^="drop-"]').forEach(el => {
      if (!el.classList.contains('hidden')) {
        el.classList.add('hidden');
        const icon = document.getElementById('icon-' + el.id);
        if (icon) icon.classList.remove('rotate-180');
      }
    });
  }
});

// ============================================================
//  CUSTOM SELECT COMPONENT (UI Modernization)
// ============================================================
function initCustomSelect(selectId) {
  const select = document.getElementById(selectId);
  const container = document.getElementById('container-' + selectId);
  if (!select || !container) return;
  
  // Trigger
  let trigger = document.getElementById(selectId + '-trigger');
  if (!trigger) {
    trigger = document.createElement('div');
    trigger.className = 'custom-select-trigger w-full bg-black/40 border border-white/10 rounded-xl px-4 py-2.5 text-white text-sm';
    trigger.id = selectId + '-trigger';
    container.appendChild(trigger);
  }
  
  trigger.innerHTML = `<span id="${selectId}-label" class="pointer-events-none text-xs sm:text-sm truncate mr-2">${select.options[select.selectedIndex]?.text || ''}</span> <i data-lucide="chevron-down" class="w-4 h-4 text-gray-400 transition-transform shrink-0" id="${selectId}-arrow"></i>`;
  
  // Options list
  let optionsDiv = document.getElementById(selectId + '-options');
  if (!optionsDiv) {
    optionsDiv = document.createElement('div');
    optionsDiv.className = 'custom-select-options glass-card rounded-xl border border-white/10 overflow-hidden shadow-2xl';
    optionsDiv.id = selectId + '-options';
    container.appendChild(optionsDiv);
  }
  
  // Sync function
  window['sync' + selectId.replace(/-/g, '')] = () => {
    const s = document.getElementById(selectId);
    const opts = document.getElementById(selectId + '-options');
    const lbl = document.getElementById(selectId + '-label');
    if (!s || !opts || !lbl) return;
    
    opts.innerHTML = Array.from(s.options).map((opt, i) => `
      <div class="custom-select-option text-xs sm:text-sm ${s.selectedIndex === i ? 'selected' : ''}" onclick="pickCustomOption('${selectId}', ${i})">
        ${opt.text}
      </div>
    `).join('');
    lbl.textContent = s.options[s.selectedIndex]?.text || '';
    if (window.lucide) window.lucide.createIcons();
  };
  
  // Toggle
  trigger.onclick = (e) => {
    e.stopPropagation();
    const isActive = optionsDiv.classList.contains('active');
    
    // Close other dropdowns
    document.querySelectorAll('.custom-select-options').forEach(el => el.classList.remove('active'));
    document.querySelectorAll('.custom-select-trigger i').forEach(el => el.classList.remove('rotate-180'));
    document.querySelectorAll('.custom-select-container').forEach(el => el.style.zIndex = '40');
    
    if (!isActive) {
      optionsDiv.classList.add('active');
      container.style.zIndex = '100'; // Bring to front
      if (trigger.querySelector('i')) trigger.querySelector('i').classList.add('rotate-180');
    }
  };
  
  window['sync' + selectId.replace(/-/g, '')]();
}

function pickCustomOption(selectId, index) {
  const select = document.getElementById(selectId);
  if (!select) return;
  select.selectedIndex = index;
  select.dispatchEvent(new Event('change'));
  const opts = document.getElementById(selectId + '-options');
  if (opts) opts.classList.remove('active');
  const arrow = document.getElementById(selectId + '-arrow');
  if (arrow) arrow.classList.remove('rotate-180');
  
  const container = document.getElementById('container-' + selectId);
  if (container) container.style.zIndex = '40';

  const syncFn = window['sync' + selectId.replace(/-/g, '')];
  if (syncFn) syncFn();
}

// Close custom selects on outside click
document.addEventListener('click', () => {
  document.querySelectorAll('.custom-select-options').forEach(el => el.classList.remove('active'));
  document.querySelectorAll('.custom-select-trigger i').forEach(el => el.classList.remove('rotate-180'));
  document.querySelectorAll('.custom-select-container').forEach(el => el.style.zIndex = '40');
});

function toggleSidebarGroup(groupId) {
  // Mantenido vacío por compatibilidad si es llamado desde html antiguo
}

function renderAdminStats(students, exams, logs) {
  const studentCount = students.filter(u => u.role === 'student').length;
  const avgPct = logs.length ? Math.round(logs.reduce((a, l) => a + l.pct, 0) / logs.length) : 0;
  const examsCount = exams.length;

  document.getElementById('admin-stats').innerHTML = `
    <div class="glass-card p-6 rounded-3xl border border-white/5 hover:border-white/10 transition-all hover:-translate-y-1">
      <div class="flex justify-between items-start mb-4">
        <div class="p-3 rounded-xl bg-blue-500/20 text-blue-400">
          <i data-lucide="users" class="w-6 h-6"></i>
        </div>
        <span class="flex items-center text-xs font-semibold text-emerald-400 bg-emerald-400/10 px-2 py-1 rounded-lg">
          <i data-lucide="trending-up" class="w-3 h-3 mr-1"></i> +12%
        </span>
      </div>
      <div class="text-gray-400 text-sm font-medium mb-1">Total Alumnos</div>
      <div class="text-4xl font-outfit font-bold">${studentCount}</div>
    </div>

    <div class="glass-card p-6 rounded-3xl border border-white/5 hover:border-white/10 transition-all hover:-translate-y-1">
      <div class="flex justify-between items-start mb-4">
        <div class="p-3 rounded-xl bg-emerald-500/20 text-emerald-400">
          <i data-lucide="check-circle" class="w-6 h-6"></i>
        </div>
      </div>
      <div class="text-gray-400 text-sm font-medium mb-1">Promedio General</div>
      <div class="text-4xl font-outfit font-bold">${avgPct}<span class="text-xl text-gray-500">%</span></div>
    </div>

    <div class="glass-card p-6 rounded-3xl border border-white/5 hover:border-white/10 transition-all hover:-translate-y-1">
      <div class="flex justify-between items-start mb-4">
        <div class="p-3 rounded-xl bg-purple-500/20 text-purple-400">
          <i data-lucide="file-text" class="w-6 h-6"></i>
        </div>
        <div class="px-2 py-1 text-xs font-bold bg-white/10 rounded-lg text-white tracking-widest uppercase">Activos</div>
      </div>
      <div class="text-gray-400 text-sm font-medium mb-1">Exámenes Creados</div>
      <div class="text-4xl font-outfit font-bold">${examsCount}</div>
    </div>
  `;
  setTimeout(() => { if (window.lucide) window.lucide.createIcons(); }, 10);
}

// ===== FILTROS =====
function populateSectionFilter(students) {
  const sections = [...new Set(students.map(s => s.section).filter(Boolean))].sort();
  const sel = document.getElementById('filter-section');
  sel.innerHTML = '<option value="">Todas las secciones</option>' +
    sections.map(s => `<option value="${s}">${s}</option>`).join('');
  
  if (window.syncfiltersection) window.syncfiltersection();
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

  // Ordenar alumnos por nombre
  students.sort((a, b) => naturalSort(a.name || '', b.name || ''));

  tbody.innerHTML = students.map(s => {
    const roleBadge = s.role === 'admin'
      ? '<span class="px-2 py-1 rounded-md text-[10px] font-bold tracking-wider uppercase bg-gradient-to-r from-yellow-500/20 to-yellow-600/20 text-yellow-300 border border-yellow-500/20 shadow-sm flex items-center gap-1"><i data-lucide="graduation-cap" class="w-3 h-3"></i> Profesor</span>'
      : '<span class="px-2 py-1 rounded-md text-[10px] font-bold tracking-wider uppercase bg-gradient-to-r from-emerald-500/20 to-emerald-600/20 text-emerald-300 border border-emerald-500/20 shadow-sm flex items-center gap-1"><i data-lucide="user" class="w-3 h-3"></i> Alumno</span>';

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
      ? '<span class="text-xs text-gray-500 italic">Sin exámenes</span>'
      : moduleOrder.map(title => {
        const group = moduleMap[title];
        const allIds = group.map(e => e.id);
        const allOn = allIds.every(id => allowedSet.has(id));
        const someOn = !allOn && allIds.some(id => allowedSet.has(id));
        const moduleBtnLabel = allOn ? '<i data-lucide="lock" class="w-3 h-3 inline"></i> Quitar' : '<i data-lucide="check" class="w-3 h-3 inline"></i> Todo';
        const moduleBtnClass = allOn 
          ? 'px-2 py-1 rounded-lg text-[10px] font-bold transition-all bg-yellow-500/20 hover:bg-yellow-500 text-yellow-500 hover:text-black flex items-center gap-1' 
          : 'px-2 py-1 rounded-lg text-[10px] font-bold transition-all bg-brand-500/20 hover:bg-brand-500 text-brand-400 hover:text-white flex items-center gap-1';
        const partialBadge = someOn
          ? `<span class="text-[0.65rem] text-yellow-400 ml-1 bg-yellow-400/10 px-1 rounded">parcial</span>`
          : '';
        return `<div class="flex items-center justify-between py-1.5 border-b border-white/5 last:border-0 gap-3">
          <span class="text-xs font-medium text-gray-300 truncate max-w-[120px]" title="${title}">${title}${partialBadge}</span>
          <button class="${moduleBtnClass}" onclick="toggleModulePerm('${sEmail}', ${JSON.stringify(allIds).replace(/"/g, '&quot;')}, ${!allOn})">${moduleBtnLabel}</button>
        </div>`;
      }).join('');


    const roleBtn = isSuperAdmin
      ? (s.role === 'admin'
        ? `<button class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all bg-yellow-500/20 hover:bg-yellow-500 text-yellow-500 hover:text-black flex items-center gap-1.5 shadow-sm" onclick="changeRole('${s.email}','student')"><i data-lucide="arrow-down" class="w-3.5 h-3.5"></i> Quitar admin</button>`
        : `<button class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all bg-brand-500/20 hover:bg-brand-500 text-brand-400 hover:text-white flex items-center gap-1.5 shadow-sm" onclick="changeRole('${s.email}','admin')"><i data-lucide="arrow-up" class="w-3.5 h-3.5"></i> Hacer admin</button>`)
      : '';

    return `<tr class="border-b border-white/5 hover:bg-white/5 transition-colors group">
      <td class="p-4">
        <div class="font-bold text-white text-sm mb-0.5">${s.name}</div>
        <div class="text-[0.7rem] text-gray-400 truncate max-w-[160px]" title="${s.email}">${s.email}</div>
      </td>
      <td class="p-4">${roleBadge}</td>
      <td class="p-4"><span class="px-2 py-1 rounded-md border border-blue-500/20 text-[10px] font-mono font-bold bg-blue-500/10 text-blue-300 whitespace-nowrap uppercase tracking-wider">${s.section || '—'}</span></td>
      <td class="p-4"><div class="max-h-[120px] overflow-y-auto custom-scrollbar pr-2 min-w-[200px]">${permToggles}</div></td>
      <td class="p-4 whitespace-nowrap">
        <div class="flex items-center justify-end gap-2">
          <button class="px-2 py-1.5 rounded-xl text-xs font-bold transition-all text-gray-400 hover:bg-white/10 hover:text-white flex items-center shadow-sm" onclick="openEditStudent('${s.email}')"><i data-lucide="edit-2" class="w-4 h-4"></i></button>
          ${roleBtn}
          ${s.role !== 'admin' ? `<button class="px-2 py-1.5 rounded-xl text-xs font-bold transition-all bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white flex items-center shadow-sm" onclick="deleteStudent('${s.email}')"><i data-lucide="trash-2" class="w-4 h-4"></i></button>` : ''}
        </div>
      </td>
    </tr>`;
  }).join('');
  setTimeout(() => { if (window.lucide) window.lucide.createIcons(); }, 10);
}

function renderExamsTable(exams) {
  const tbody = document.getElementById('exams-tbody');

  if (!exams || exams.length === 0) {
    tbody.innerHTML = '<tr><td colspan="4" style="text-align:center;color:var(--text-muted);padding:2rem;">No hay exámenes. Crea uno con el botón de arriba.</td></tr>';
    return;
  }

  // Ordenar exámenes por título
  exams.sort((a, b) => naturalSort(a.title || '', b.title || ''));

  tbody.innerHTML = exams.map(e => `
    <tr class="border-b border-white/5 hover:bg-white/5 transition-colors group">
      <td class="p-4"><strong class="flex items-center gap-2 text-white text-sm whitespace-nowrap"><span class="w-8 h-8 rounded-lg bg-brand-500/10 flex items-center justify-center text-brand-400 border border-brand-500/10"><i data-lucide="${e.icon && e.icon.length < 4 ? 'file-text' : (e.icon || 'file-text')}" class="w-4 h-4"></i></span> ${e.title}</strong></td>
      <td class="p-4 text-[0.85rem] text-gray-400 max-w-[200px] truncate" title="${e.description || ''}">${e.description || '—'}</td>
      <td class="p-4 text-center"><span class="text-emerald-300 bg-emerald-500/10 px-2.5 py-1 rounded-lg text-xs font-bold ring-1 ring-emerald-500/20">${e.questions.length}</span></td>
      <td class="p-4 pr-6">
        <div class="flex justify-end gap-2 opacity-60 group-hover:opacity-100 transition-opacity">
          <button class="px-3 py-2 rounded-xl text-[11px] font-bold transition-all relative overflow-hidden group/btn bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white flex items-center gap-1.5 shadow-sm" onclick="openEditExamModal('${e.id}')">
            <i data-lucide="edit-2" class="w-3.5 h-3.5"></i> Editar
          </button>
          <button class="px-3 py-2 rounded-xl text-[11px] font-bold transition-all bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white flex items-center shadow-sm relative overflow-hidden group/btn2" onclick="deleteExam('${e.id}')">
            <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
          </button>
        </div>
      </td>
    </tr>`).join('');
  setTimeout(() => { if (window.lucide) window.lucide.createIcons(); }, 10);
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
    const isExcellent = l.pct >= 90;
    const colorClass = l.pct >= 70 ? 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20' : l.pct >= 40 ? 'text-yellow-400 bg-yellow-500/10 ring-yellow-500/20' : 'text-red-400 bg-red-500/10 ring-red-500/20';
    return `<div class="flex items-center justify-between p-3 border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors rounded-xl group/log mb-1">
      <div class="flex items-center gap-3">
        <div class="w-10 h-10 rounded-full bg-gradient-to-br from-brand-600/30 to-brand-400/20 text-brand-300 flex items-center justify-center text-xs font-bold shrink-0 border border-brand-500/20 shadow-inner overflow-hidden">
          ${user?.name ? initials(user.name) : '<i data-lucide="user" class="w-5 h-5 opacity-50"></i>'}
        </div>
        <div class="flex flex-col">
          <span class="text-[0.85rem] text-gray-200"><strong>${user ? user.name : l.student_email}</strong> <span class="opacity-70 text-gray-400">tomó</span> <em class="not-italic text-brand-300 font-medium">${exam ? exam.title : 'Examen ' + l.exam_id}</em></span>
          <span class="text-[0.7rem] text-gray-500 mt-0.5 flex items-center gap-1"><i data-lucide="clock" class="w-3 h-3"></i> ${date}</span>
        </div>
      </div>
      <div class="flex items-center gap-2">
        ${isExcellent ? '<i data-lucide="star" class="w-4 h-4 text-emerald-400 mr-1 animate-pulse" title="¡Excelente!"></i>' : ''}
        <div class="px-3 py-1.5 rounded-xl font-black text-[13px] shadow-sm tracking-wide lowercase ring-1 ${colorClass}">
          ${l.pct}%
        </div>
      </div>
    </div>`;
  }).join('');
  setTimeout(() => { if (window.lucide) window.lucide.createIcons(); }, 10);
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
    
    if (window.syncanalyticsexamfilter) window.syncanalyticsexamfilter();
    // ── Pre-calculate colors for theme sync ──
    const isLight = document.documentElement.getAttribute('data-theme') === 'light';
    const gridColor = isLight ? 'rgba(0,0,0,0.1)' : 'rgba(255,255,255,0.06)';
    const tickColor = isLight ? 'rgba(0,0,0,0.6)' : 'rgba(255,255,255,0.5)';
    const labelColor = isLight ? 'rgba(0,0,0,0.7)' : 'rgba(255,255,255,0.7)';

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
          x: { max: 100, grid: { color: gridColor }, ticks: { color: tickColor } },
          y: { grid: { display: false }, ticks: { color: labelColor, font: { size: 11 } } }
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
            labels: { color: labelColor, padding: 12, font: { size: 11 } }
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
            grid: { color: gridColor },
            ticks: { color: tickColor, maxRotation: 45, font: { size: 10 } }
          },
          y: {
            beginAtZero: true,
            grid: { color: gridColor },
            ticks: { color: tickColor, stepSize: 1 }
          }
        }
      }
    });

    // ── 4. Tabla: Preguntas más difíciles ──
    const tableEl = document.getElementById('hardest-questions-table');
    if (!data.hardestQuestions.length) {
      tableEl.innerHTML = '<div class="flex flex-col items-center justify-center py-10 opacity-50"><i data-lucide="inbox" class="w-12 h-12 mb-3"></i><p class="text-sm font-medium">Se necesitan más intentos para generar datos.</p></div>';
      if (window.lucide) window.lucide.createIcons();
    } else {
      tableEl.innerHTML = `
        <div class="w-full">
          <table class="w-full text-left border-collapse">
            <thead>
              <tr class="text-[10px] uppercase tracking-widest text-gray-500 border-b border-white/10">
                <th class="pb-3 px-4 font-bold text-center w-12">#</th>
                <th class="pb-3 font-bold">Examen</th>
                <th class="pb-3 font-bold">Pregunta</th>
                <th class="pb-3 font-bold text-center">Promedio</th>
                <th class="pb-3 px-4 font-bold text-center">Intentos</th>
              </tr>
            </thead>
            <tbody>
              ${data.hardestQuestions.map((q, i) => {
        const colorClass = q.examAvg >= 70 ? 'text-emerald-400 bg-emerald-500/10 ring-emerald-500/20' : q.examAvg >= 40 ? 'text-yellow-400 bg-yellow-500/10 ring-yellow-500/20' : 'text-red-400 bg-red-500/10 ring-red-500/20';
        return `<tr class="border-b border-white/5 hover:bg-white/5 transition-colors">
                  <td class="p-4 text-center text-gray-500 font-mono text-xs">${i + 1}</td>
                  <td class="p-4 text-sm font-bold text-gray-300">${q.examTitle}</td>
                  <td class="p-4 text-sm text-gray-300 latex-container min-w-[250px]">${formatLatexText(q.questionText)}</td>
                  <td class="p-4 text-center">
                    <span class="px-2.5 py-1 rounded-lg font-black text-xs ring-1 shadow-sm ${colorClass}">${q.examAvg}%</span>
                  </td>
                  <td class="p-4 text-center text-gray-400 text-sm">${q.attempts}</td>
                </tr>`;
      }).join('')}
            </tbody>
          </table>
        </div>`;
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
    toast(value ? 'Permiso otorgado' : 'Permiso revocado', value ? 'success' : 'info');
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
    // Refrescar la tabla aplicando los filtros actuales
    applyStudentFilters();
    toast(grant ? `Módulo completo desbloqueado` : `Módulo completo bloqueado`, grant ? 'success' : 'info');
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
    const iHtml = e.icon === '📋' ? '<i data-lucide="file-text" class="icon-sm"></i>' : e.icon;
    return `<div class="perm-exam-row">
      <label class="toggle-switch">
        <input type="checkbox" id="mperm-${e.id}" ${on ? 'checked' : ''}/>
        <span class="toggle-slider"></span>
      </label>
      <span>${iHtml || '<i data-lucide="file-text" class="icon-sm"></i>'} ${label}</span>
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
  if (!rawText) return [];
  // 0. Limpiar comentarios y normalizar saltos de línea
  let text = rawText.replace(/\r\n/g, '\n').replace(/(?<!\\)%[^\n]*/g, '');
  
  // 1. Encontrar posiciones de \item, \begin, \end a nivel de pregunta
  const tokens = [];
  const tokenRe = /\\(item|begin|end)\b/gi;
  let match;
  while ((match = tokenRe.exec(text)) !== null) {
    tokens.push({ type: match[1].toLowerCase(), index: match.index, length: match[0].length });
  }

  const questionChunks = [];
  let depth = 0;
  let lastIdx = -1;

  tokens.forEach(t => {
    if (t.type === 'begin') {
      depth++;
    } else if (t.type === 'end') {
      if (depth === 1 && lastIdx !== -1) {
        // Es el fin de un entorno global. Cerramos la última pregunta aquí.
        questionChunks.push(text.substring(lastIdx, t.index));
        lastIdx = -1;
      }
      depth--;
    } else if (t.type === 'item') {
      if (depth <= 1) {
        if (lastIdx !== -1) {
          questionChunks.push(text.substring(lastIdx, t.index));
        }
        lastIdx = t.index;
      }
    }
  });
  // Si quedó algo pendiente (ej: no hubo \end global)
  if (lastIdx !== -1) {
    questionChunks.push(text.substring(lastIdx));
  }

  const questions = [];
  questionChunks.forEach(chunk => {
    // Buscar el ÚLTIMO entorno de lista para extraer las opciones
    const beginTagRe = /\\begin\{(enumerate|itemize|tasks|description)\}/gi;
    let lastBeginMatch = null;
    let bm;
    while ((bm = beginTagRe.exec(chunk)) !== null) {
      lastBeginMatch = bm;
    }

    if (lastBeginMatch) {
      const lastBeginIdx = lastBeginMatch.index;
      const envName = lastBeginMatch[1];
      const endTagStr = `\\end{${envName}}`;
      const lastEndIdx = chunk.toLowerCase().lastIndexOf(endTagStr.toLowerCase());

      if (lastEndIdx !== -1 && lastEndIdx > lastBeginIdx) {
        // qText: desde después del \item hasta el inicio del bloque de opciones
        let qText = chunk.substring(0, lastBeginIdx).trim();
        qText = qText.replace(/^\\item\b/i, '').trim();

        const optsRaw = chunk.substring(lastBeginIdx + lastBeginMatch[0].length, lastEndIdx).trim();
        const options = [];
        const optRe = /\\item\b\s*([\s\S]*?)(?=\\item\b|$)/gi;
        let om;
        while ((om = optRe.exec(optsRaw)) !== null) {
          const opt = om[1].trim();
          if (opt) options.push(opt);
        }
        
        if (qText && options.length >= 2) {
          questions.push({ text: qText, options, correct: 0 });
        }
      }
    }
  });

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
        <button class="btn btn-danger btn-sm" onclick="removeQuestion(${idx})"><i data-lucide="trash-2" class="icon-sm"></i></button>
      </div>
      <div class="form-group">
        <input class="form-input" type="text" id="q-text-${idx}" placeholder="Escribe la pregunta aquí..." value="${data ? escapeAttr(data.text) : ''}" oninput="updateManualQPreview(${idx})"/>
        <div id="q-preview-${idx}" class="latex-container mt-2 p-3 bg-black/20 rounded-xl text-sm border border-white/5 hidden"></div>
      </div>
      <div class="form-group" style="margin-top:0.3rem;">
        <label class="form-label" style="font-size:0.78rem;color:var(--primary);"><i data-lucide="image" class="icon-sm"></i> Imagen (URL, opcional)</label>
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
        <p style="font-size:0.75rem;color:var(--text-muted);margin-top:0.5rem;"><i data-lucide="check-circle" class="icon-sm" style="color:var(--secondary)"></i> Selecciona el radio de la respuesta correcta. Puedes usar LaTeX ($...$).</p>
      </div>
      <div class="form-group" style="margin-top:0.6rem;">
        <label class="form-label" style="font-size:0.78rem;color:var(--secondary);"><i data-lucide="lightbulb" class="icon-sm"></i> Justificación (por qué es correcta)</label>
        <textarea class="form-input" id="q-just-${idx}" rows="2"
          style="resize:vertical;font-size:0.83rem;"
          placeholder="Explica brevemente por qué la respuesta marcada es la correcta..." oninput="updateManualQPreview(${idx})">${escapeAttr(just)}</textarea>
        <div id="j-preview-${idx}" class="latex-container mt-2 p-3 bg-black/20 rounded-xl text-[0.8rem] border border-white/5 hidden"></div>
      </div>
    </div>`);
  // Inicializar preview si hay datos
  if (data) setTimeout(() => updateManualQPreview(idx), 100);
}

/** Actualiza la previsualización de LaTeX en un bloque manual */
function updateManualQPreview(idx) {
  const text = document.getElementById(`q-text-${idx}`)?.value || '';
  const just = document.getElementById(`q-just-${idx}`)?.value || '';
  const qPre = document.getElementById(`q-preview-${idx}`);
  const jPre = document.getElementById(`j-preview-${idx}`);

  if (qPre) {
    if (text.includes('$') || text.includes('\\')) {
      qPre.innerHTML = `<strong>Vista previa:</strong><br>${formatLatexText(text)}`;
      qPre.classList.remove('hidden');
      if (typeof renderMathInElement === 'function') {
        renderMathInElement(qPre, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true }
          ]
        });
      }
    } else {
      qPre.classList.add('hidden');
    }
  }

  if (jPre) {
    if (just.includes('$') || just.includes('\\')) {
      jPre.innerHTML = `<strong>Vista previa:</strong><br>${formatLatexText(just)}`;
      jPre.classList.remove('hidden');
      if (typeof renderMathInElement === 'function') {
        renderMathInElement(jPre, {
          delimiters: [
            { left: '$$', right: '$$', display: true },
            { left: '$', right: '$', display: false },
            { left: '\\(', right: '\\)', display: false },
            { left: '\\[', right: '\\]', display: true }
          ]
        });
      }
    } else {
      jPre.classList.add('hidden');
    }
  }
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
  const icons = { 
    success: '<i data-lucide="check-circle" class="icon-md" style="color:var(--secondary)"></i>', 
    error: '<i data-lucide="x-circle" class="icon-md" style="color:var(--danger)"></i>', 
    info: '<i data-lucide="info" class="icon-md" style="color:var(--primary)"></i>', 
    warning: '<i data-lucide="alert-triangle" class="icon-md" style="color:#eab308"></i>' 
  };
  const el = document.createElement('div');
  el.className = `toast toast-${type}`;
  el.innerHTML = `<span>${icons[type] || icons.info}</span><span>${msg}</span>`;
  container.appendChild(el);
  if (window.lucide) window.lucide.createIcons({ root: el });
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
  document.querySelectorAll('.theme-toggle-icon').forEach(el => {
    el.setAttribute('data-lucide', isLight ? 'moon' : 'sun');
  });
  if (window.lucide) window.lucide.createIcons();
}

function toggleTheme() {
  const html = document.documentElement;
  const isNowLight = html.getAttribute('data-theme') !== 'light';
  html.setAttribute('data-theme', isNowLight ? 'light' : 'dark');
  // Tailwind darkMode:'class' needs the 'dark' class on <html>
  if (isNowLight) {
    html.classList.remove('dark');
  } else {
    html.classList.add('dark');
  }
  localStorage.setItem('examapp_theme', isNowLight ? 'light' : 'dark');
  syncThemeIcons();

  // Re-render analytics if active to update chart colors
  if (typeof renderAnalytics === 'function' && !document.getElementById('view-admin').classList.contains('hidden')) {
    renderAnalytics();
  }
}

function syncThemeIcons() {
  const isLight = document.documentElement.getAttribute('data-theme') === 'light';
  document.querySelectorAll('.theme-toggle-icon').forEach(el => {
    el.setAttribute('data-lucide', isLight ? 'moon' : 'sun');
  });
  if (window.lucide) lucide.createIcons();
}

(function applyTheme() {
  const saved = localStorage.getItem('examapp_theme') || 'dark';
  const html = document.documentElement;
  html.setAttribute('data-theme', saved);
  if (saved === 'light') {
    html.classList.remove('dark');
  } else {
    html.classList.add('dark');
  }
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
      ? `<div class="review-justification"><i data-lucide="lightbulb" class="icon-sm" style="color:var(--secondary)"></i> <strong>Justificación:</strong> ${lqProcessText(r.justification)}</div>`
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
      const medal = i === 0 ? '<i data-lucide="trophy" class="w-5 h-5 text-yellow-500"></i>' : i === 1 ? '<i data-lucide="award" class="w-5 h-5 text-gray-400"></i>' : i === 2 ? '<i data-lucide="award" class="w-5 h-5 text-yellow-700"></i>' : `<span class="text-gray-500 text-xs font-bold font-mono">#${i + 1}</span>`;
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

    let html = '<h2 class="text-xl font-black text-white mb-4 flex items-center gap-2 font-outfit px-1"><i data-lucide="megaphone" class="w-5 h-5 text-brand-400"></i> Avisos Importantes</h2>';

    // Banners de imagen (carrusel horizontal)
    if (banners.length) {
      html += `<div class="flex overflow-x-auto gap-4 pb-4 custom-scrollbar snap-x">${banners.map(a => `
        <div class="relative w-72 h-40 rounded-3xl overflow-hidden shrink-0 snap-center group cursor-pointer border border-white/10 shadow-lg" onclick="openLightbox('${a.image_url}')">
          <img src="${a.image_url}" alt="${a.title}" class="w-full h-full object-cover group-hover:scale-110 transition-transform duration-700"/>
          <div class="absolute inset-0 bg-gradient-to-t from-black/90 via-black/20 to-transparent flex flex-col justify-end p-4">
            <span class="text-[0.9rem] font-bold text-white leading-tight drop-shadow-md">${a.title}</span>
            <span class="text-[10px] font-bold text-white/70 uppercase tracking-widest mt-1 opacity-0 group-hover:opacity-100 transition-opacity flex items-center gap-1"><i data-lucide="zoom-in" class="w-3 h-3"></i> Ampliar</span>
          </div>
        </div>`).join('')}</div>`;
    }

    // Anuncios de texto
    if (texts.length) {
      html += `<div class="grid grid-cols-1 md:grid-cols-2 gap-4">` + texts.map(a => {
        const date = new Date(a.created_at).toLocaleDateString('es-MX', { day: '2-digit', month: 'long', year: 'numeric' });
        const linkBtn = a.link_url
          ? `<a href="${a.link_url}" target="_blank" rel="noopener" class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all bg-white/5 hover:bg-brand-500/20 text-gray-300 hover:text-brand-300 flex items-center gap-1.5 shadow-sm border border-white/5"><i data-lucide="external-link" class="w-3.5 h-3.5"></i> Enlace</a>`
          : '';
        return `
          <div class="glass-card p-5 rounded-3xl flex flex-col border border-white/5 hover:bg-white/5 transition-colors group relative overflow-hidden">
            <div class="absolute top-0 right-0 w-24 h-24 bg-brand-500/10 rounded-bl-full -mr-8 -mt-8 opacity-50 group-hover:scale-125 transition-transform duration-500"></div>
            <div class="text-base font-black text-white font-outfit leading-tight mb-2 pr-6">${a.title}</div>
            ${a.content ? `<div class="text-[0.85rem] text-gray-400 mb-4 line-clamp-3 leading-relaxed relative z-10">${a.content}</div>` : ''}
            <div class="flex items-center justify-between mt-auto pt-4 border-t border-white/5 relative z-10">
              <span class="text-[10px] font-bold text-gray-500 tracking-wider uppercase flex items-center gap-1.5"><i data-lucide="calendar" class="w-3.5 h-3.5"></i> ${date}</span>
              ${linkBtn}
            </div>
          </div>`;
      }).join('') + `</div>`;
    }

    html += '<div style="margin-bottom:1rem;"></div>';
    section.innerHTML = html;
    setTimeout(() => { if (window.lucide) window.lucide.createIcons(); }, 10);
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
      tbody.innerHTML = '<tr><td colspan="4" class="text-center p-8 text-gray-500 font-medium">Sin anuncios. Crea uno con el botón de arriba.</td></tr>';
      return;
    }
    tbody.innerHTML = cachedAnnouncements.map(a => `
      <tr class="border-b border-white/5 hover:bg-white/5 transition-colors group">
        <td class="p-4">
          <strong class="text-white flex items-center gap-2">${a.title}
          ${a.image_url ? '<i data-lucide="image" class="w-3.5 h-3.5 text-blue-400" title="Tiene imagen"></i>' : ''}
          ${a.link_url ? '<i data-lucide="link" class="w-3.5 h-3.5 text-brand-400" title="Tiene link"></i>' : ''}
          </strong>
        </td>
        <td class="p-4 text-[0.85rem] text-gray-400 max-w-[220px] truncate" title="${a.content || ''}">${a.content || '—'}</td>
        <td class="p-4"><span class="px-2 py-1 rounded-md text-[10px] font-bold tracking-wider uppercase border shadow-sm ${a.active ? 'bg-gradient-to-r from-emerald-500/20 to-emerald-600/20 text-emerald-300 border-emerald-500/20' : 'bg-gradient-to-r from-gray-500/20 to-gray-600/20 text-gray-400 border-gray-500/20'}">${a.active ? '✅ Visible' : '🔒 Oculto'}</span></td>
        <td class="p-4 pr-6">
          <div class="flex justify-end gap-2 opacity-60 group-hover:opacity-100 transition-opacity">
            <button class="px-3 py-2 rounded-xl text-[11px] font-bold transition-all relative overflow-hidden bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white flex items-center shadow-sm" onclick="openEditAnnouncementModal('${a.id}')">
              <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
            </button>
            <button class="px-3 py-2 rounded-xl text-[11px] font-bold transition-all bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white flex items-center shadow-sm" onclick="deleteAnnouncement('${a.id}')">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </td>
      </tr>`).join('');
    setTimeout(() => { if (window.lucide) window.lucide.createIcons(); }, 10);
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
function startup() {
  if (typeof AOS !== 'undefined') {
    AOS.init({ once: true, duration: 800 });
  }
  if (!document.querySelector('.view.active')) {
    init();
  }
}

if (document.readyState === 'loading') {
  document.addEventListener('DOMContentLoaded', startup);
} else {
  startup();
}


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
      tbody.innerHTML = '<tr><td colspan="4" class="text-center p-8 text-gray-500 font-medium">No hay material agregado aún. Haz clic en "+ Agregar material".</td></tr>';
      return;
    }

    // Ordenar material por título
    cachedMaterial.sort((a, b) => naturalSort(a.title || '', b.title || ''));

    tbody.innerHTML = cachedMaterial.map(m => {
      const shortLink = m.link.length > 45 ? m.link.slice(0, 45) + '…' : m.link;
      return `<tr class="border-b border-white/5 hover:bg-white/5 transition-colors group">
        <td class="p-4"><strong class="flex items-center gap-2 text-white"><i data-lucide="${m.icon || 'file-text'}" class="w-5 h-5 text-brand-400"></i> ${m.title}</strong></td>
        <td class="p-4 text-sm text-gray-300">${m.file_name}</td>
        <td class="p-4"><a href="${m.link}" target="_blank" class="text-[0.82rem] text-brand-400 hover:text-brand-300 transition-colors break-all flex items-center gap-1.5"><i data-lucide="external-link" class="w-3.5 h-3.5"></i> ${shortLink}</a></td>
        <td class="p-4 pr-6">
          <div class="flex justify-end gap-2 opacity-60 group-hover:opacity-100 transition-opacity">
            <button class="px-3 py-2 rounded-xl text-[11px] font-bold transition-all bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white flex items-center shadow-sm" onclick="openEditMaterialModal('${m.id}')">
              <i data-lucide="edit-2" class="w-3.5 h-3.5"></i>
            </button>
            <button class="px-3 py-2 rounded-xl text-[11px] font-bold transition-all bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white flex items-center shadow-sm" onclick="deleteMaterial('${m.id}')">
              <i data-lucide="trash-2" class="w-3.5 h-3.5"></i>
            </button>
          </div>
        </td>
      </tr>`;
    }).join('');
    setTimeout(() => { if (window.lucide) window.lucide.createIcons(); }, 10);
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
        <a class="flex items-center justify-between p-3 border-b border-white/5 last:border-0 hover:bg-white/5 transition-colors cursor-pointer group/file rounded-xl" href="${m.link}" target="_blank" rel="noopener noreferrer">
          <div class="flex items-center gap-3 overflow-hidden">
            <div class="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center shrink-0 border border-white/10 group-hover/file:bg-white/10 transition-colors">
              <i data-lucide="${m.icon || 'file-text'}" class="w-4 h-4 text-brand-300"></i>
            </div>
            <span class="text-sm font-bold text-gray-200 group-hover/file:text-white transition-colors truncate">${m.file_name}</span>
          </div>
          <span class="text-[10px] uppercase tracking-wider font-bold text-brand-400 opacity-0 group-hover/file:opacity-100 transition-opacity whitespace-nowrap pl-2 flex items-center gap-1.5"><i data-lucide="external-link" class="w-3.5 h-3.5 inline"></i> Abrir</span>
        </a>`).join('');

      return `
        <div class="glass-card rounded-3xl flex flex-col relative overflow-hidden transition-all duration-300 border border-white/5 mb-4">
          <div class="p-4 flex items-center gap-4 cursor-pointer hover:bg-white/5 transition-colors z-10" onclick="toggleMaterialGroup(${i})">
            <div class="w-10 h-10 rounded-2xl bg-gradient-to-br from-blue-500/30 to-blue-400/10 flex items-center justify-center text-xl shadow-inner border border-blue-500/20 shrink-0">
              <i data-lucide="folder" class="w-5 h-5 text-blue-300"></i>
            </div>
            <div class="flex flex-col flex-1">
              <h4 class="text-base font-black text-white leading-tight font-outfit mt-0.5">${title}</h4>
              <span class="text-[0.75rem] text-gray-400 font-medium mt-0.5">${files.length} archivo${files.length !== 1 ? 's' : ''}</span>
            </div>
            <div class="w-8 h-8 rounded-full bg-white/5 flex items-center justify-center shrink-0 border border-white/10 text-gray-400 transition-transform duration-300" id="mat-arrow-${i}">
              <i data-lucide="chevron-down" class="w-4 h-4"></i>
            </div>
          </div>
          <div class="hidden flex-col gap-1 px-3 pb-3 pt-1 border-t border-white/5 bg-black/20" id="mat-body-${i}">
            ${fileRows}
          </div>
        </div>`;
    }).join('');

    section.style.display = '';
    setTimeout(() => { if (window.lucide) window.lucide.createIcons(); }, 10);
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
  document.getElementById('mat-icon').value = 'file-text';
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
  document.getElementById('mat-icon').value = m?.icon || 'file-text';
  document.getElementById('mat-order').value = m?.sort_order || 0;
  document.getElementById('modal-material-title').textContent = 'Editar material';
  openModal('modal-material');
}

async function saveMaterial() {
  const id = document.getElementById('mat-edit-id').value;
  const title = document.getElementById('mat-title').value.trim();
  const file_name = document.getElementById('mat-filename').value.trim();
  const link = document.getElementById('mat-link').value.trim();
  const icon = document.getElementById('mat-icon').value.trim() || 'file-text';
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
    <div class="flex items-center gap-2 mb-4">
      <button class="px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2.5 transition-all ${inboxView === 'inbox' ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/30 ring-1 ring-brand-400' : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'}" id="inbox-tab-inbox" onclick="setInboxView('inbox')"><i data-lucide="inbox" class="w-4 h-4"></i> Recibidos</button>
      <button class="px-4 py-2 rounded-xl text-sm font-bold flex items-center gap-2.5 transition-all ${inboxView === 'archived' ? 'bg-brand-500 text-white shadow-lg shadow-brand-500/30 ring-1 ring-brand-400' : 'bg-white/5 text-gray-400 hover:bg-white/10 hover:text-white'}" id="inbox-tab-arch" onclick="setInboxView('archived')"><i data-lucide="archive" class="w-4 h-4"></i> Archivados</button>
    </div>
    <div id="inbox-toolbar" class="hidden items-center gap-3 p-3 bg-white/5 rounded-2xl border border-white/5 mb-4 shadow-sm"></div>
    <div id="inbox-messages" class="flex flex-col gap-2"><div class="flex flex-col items-center justify-center py-10 opacity-50"><i data-lucide="loader" class="w-8 h-8 animate-spin mb-3"></i><p class="text-sm font-medium">Cargando...</p></div></div>`;

  try {
    const allMsgs = await api('GET', '/api/messages/inbox');
    const msgs = allMsgs.filter(m => inboxView === 'archived' ? (m.archived === true || m.archived === 1) : (!m.archived));
    const msgDiv = document.getElementById('inbox-messages');
    const toolbar = document.getElementById('inbox-toolbar');

    if (!msgs.length) {
      msgDiv.innerHTML = `<div class="flex flex-col items-center justify-center py-16 opacity-50"><i data-lucide="${inboxView === 'archived' ? 'archive' : 'mail-open'}" class="w-12 h-12 mb-4 text-gray-400"></i><p class="text-sm font-medium text-gray-300">${inboxView === 'archived' ? 'No hay mensajes archivados.' : 'No tienes mensajes nuevos.'}</p></div>`;
      if (window.lucide) window.lucide.createIcons({ root: msgDiv });
      return;
    }

    // Toolbar with select-all + actions
    toolbar.classList.remove('hidden');
    toolbar.classList.add('flex');
    toolbar.innerHTML = `
      <label class="flex items-center cursor-pointer select-none gap-2 hover:bg-white/5 px-2 py-1 rounded-lg transition-colors group">
        <div class="relative flex items-center justify-center">
          <input type="checkbox" id="inbox-select-all" class="peer appearance-none w-4 h-4 border border-gray-500 rounded bg-transparent checked:border-brand-500 checked:bg-brand-500 transition-all cursor-pointer" onchange="toggleSelectAll(this.checked)" />
          <i data-lucide="check" class="absolute w-2.5 h-2.5 text-white opacity-0 peer-checked:opacity-100 pointer-events-none"></i>
        </div>
        <span class="text-[0.83rem] text-gray-400 group-hover:text-gray-300 font-medium tracking-wide">Seleccionar todo</span>
      </label>
      <div class="flex items-center gap-2 border-l border-white/10 pl-3" id="inbox-bulk-actions" style="display:none;">
        ${inboxView === 'inbox'
        ? `<button class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white flex items-center gap-1.5 shadow-sm" onclick="archiveSelectedMessages()"><i data-lucide="archive" class="w-3.5 h-3.5"></i> Archivar</button>`
        : `<button class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white flex items-center gap-1.5 shadow-sm" onclick="archiveSelectedMessages(false)"><i data-lucide="inbox" class="w-3.5 h-3.5"></i> Mover a recibidos</button>`}
        <button class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all bg-red-500/10 hover:bg-red-500 text-red-500 hover:text-white flex items-center gap-1.5 shadow-sm" onclick="deleteSelectedMessages()"><i data-lucide="trash-2" class="w-3.5 h-3.5"></i> Eliminar</button>
      </div>
      <button class="px-3 py-1.5 rounded-xl text-xs font-bold transition-all text-gray-400 hover:bg-red-500/10 hover:text-red-400 flex items-center gap-1.5 shadow-sm ml-auto" onclick="emptyInbox()">
        <i data-lucide="trash-2" class="w-3.5 h-3.5"></i> ${inboxView === 'archived' ? 'Vaciar archivo' : 'Vaciar bandeja'}
      </button>`;

    // Message cards
    msgDiv.innerHTML = msgs.map(m => {
      const date = new Date(m.created_at).toLocaleDateString('es-MX', { day: '2-digit', month: 'short', year: 'numeric', hour: '2-digit', minute: '2-digit' });
      const badge = m.type === 'suggestion'
        ? '<span class="px-2 py-0.5 rounded-md text-[9px] font-bold tracking-wider uppercase bg-yellow-500/20 text-yellow-300 border border-yellow-500/20 flex items-center gap-1 shadow-sm"><i data-lucide="lightbulb" class="w-3 h-3"></i> Sugerencia</span>'
        : '<span class="px-2 py-0.5 rounded-md text-[9px] font-bold tracking-wider uppercase bg-brand-500/20 text-brand-300 border border-brand-500/20 flex items-center gap-1 shadow-sm"><i data-lucide="message-circle" class="w-3 h-3"></i> Mensaje</span>';
      
      const isUnread = (!m.is_read && !m.archived);
      
      const archBtn = inboxView === 'inbox'
        ? `<button class="px-2 py-2 rounded-xl text-xs font-bold transition-all bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white flex items-center justify-center shadow-sm" title="Archivar" onclick="event.stopPropagation();archiveMessage(${m.id})"><i data-lucide="archive" class="w-4 h-4"></i></button>`
        : `<button class="px-2 py-2 rounded-xl text-xs font-bold transition-all bg-white/5 hover:bg-white/10 text-gray-300 hover:text-white flex items-center justify-center shadow-sm" title="Mover a recibidos" onclick="event.stopPropagation();archiveMessage(${m.id}, false)"><i data-lucide="inbox" class="w-4 h-4"></i></button>`;
      
      return `
        <div class="glass-panel p-4 rounded-2xl flex gap-3 group border hover:-translate-y-0.5 hover:shadow-lg transition-all cursor-pointer ${m.is_read ? 'opacity-80 border-white/5 hover:bg-white/5' : 'bg-gradient-to-r from-brand-500/10 to-transparent border-brand-500/20'}" id="msg-card-${m.id}" onclick="viewMessage(${m.id},'${escapeAttr(m.from_name || m.from_email)}','${escapeAttr(m.from_section || '')}','${escapeAttr(m.subject || '(sin asunto)')}','${escapeAttr(m.body)}','${date}')">
          <label class="flex shrink-0 pt-1" onclick="event.stopPropagation()">
            <div class="relative flex items-center justify-center">
              <input type="checkbox" class="inbox-msg-check peer appearance-none w-4 h-4 border border-gray-500 rounded bg-transparent checked:border-brand-500 checked:bg-brand-500 transition-all cursor-pointer" value="${m.id}" onchange="onMsgCheckChange()" />
              <i data-lucide="check" class="absolute w-2.5 h-2.5 text-white opacity-0 peer-checked:opacity-100 pointer-events-none"></i>
            </div>
          </label>
          <div class="flex-1 flex flex-col overflow-hidden">
            <div class="flex items-center justify-between mb-1">
              <div class="flex items-center gap-2">
                ${isUnread ? '<div class="w-2 h-2 rounded-full bg-brand-400 shadow-[0_0_8px_rgba(108,99,255,0.8)] animate-pulse shrink-0"></div>' : ''}
                <span class="text-white font-bold text-sm flex items-center gap-2 truncate">${m.from_name || m.from_email} ${m.from_section ? `<span class="bg-blue-500/20 text-blue-300 px-1.5 py-0.5 rounded text-[9px] font-mono tracking-wider">${m.from_section}</span>` : ''}</span>
              </div>
              <div class="flex items-center gap-3 shrink-0">
                ${badge}
                <span class="text-[0.7rem] text-gray-500 font-medium">${date}</span>
              </div>
            </div>
            <div class="text-[0.9rem] font-medium ${m.is_read ? 'text-gray-300' : 'text-white drop-shadow-sm'} mb-1 leading-tight truncate px-1">${m.subject || '(sin asunto)'}</div>
            <div class="text-[0.8rem] text-gray-400 line-clamp-1 leading-relaxed px-1">${m.body}</div>
          </div>
          <div class="flex flex-col gap-2 opacity-0 group-hover:opacity-100 transition-opacity pl-2 shrink-0">
            ${archBtn}
            <button class="px-2 py-2 rounded-xl text-xs font-bold transition-all bg-red-500/10 hover:bg-red-500 text-red-400 hover:text-white flex items-center justify-center shadow-sm" title="Eliminar" onclick="event.stopPropagation();deleteMessage(${m.id})"><i data-lucide="trash-2" class="w-4 h-4"></i></button>
          </div>
        </div>`;
    }).join('');

    if (window.lucide) {
      window.lucide.createIcons({ root: container });
    }

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
let slqLastQuestionIdx = -1;
let slqCurrentOptions  = []; // opciones de la pregunta actual (para mostrar respuesta correcta)


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
  ['slq-join','slq-waiting','slq-countdown','slq-question','slq-answered','slq-scoreboard','slq-final'].forEach(id => {
    const el = document.getElementById(id);
    if (el) el.classList.add('hidden');
  });
  const t = document.getElementById(phase);
  if (t) t.classList.remove('hidden');
}

// ── Motor de sonidos (Web Audio API) ────────────────────────────
function lqSound(type) {
  try {
    const ctx = new (window.AudioContext || window.webkitAudioContext)();
    const g   = ctx.createGain();
    g.connect(ctx.destination);
    const play = (freq, type2, start, dur, vol = 0.3) => {
      const o = ctx.createOscillator();
      o.type = type2;
      o.frequency.setValueAtTime(freq, ctx.currentTime + start);
      o.connect(g);
      g.gain.setValueAtTime(vol, ctx.currentTime + start);
      g.gain.exponentialRampToValueAtTime(0.001, ctx.currentTime + start + dur);
      o.start(ctx.currentTime + start);
      o.stop(ctx.currentTime + start + dur);
    };
    if (type === 'tick')      { play(900, 'sine', 0, 0.08, 0.15); }
    if (type === 'tick-last') { play(1100, 'sine', 0, 0.12, 0.25); }
    if (type === 'correct') {
      play(523, 'sine', 0,    0.15);
      play(659, 'sine', 0.13, 0.15);
      play(784, 'sine', 0.26, 0.3);
    }
    if (type === 'wrong') {
      play(300, 'sawtooth', 0,    0.15, 0.25);
      play(220, 'sawtooth', 0.15, 0.25, 0.2);
    }
    if (type === 'timeout')  { play(440, 'triangle', 0, 0.5, 0.2); }
    if (type === 'countdown') { play(660, 'sine', 0, 0.12, 0.3); }
    if (type === 'go')       {
      play(523, 'sine', 0,    0.1);
      play(784, 'sine', 0.12, 0.25);
    }
    if (type === 'final') {
      [0, 0.15, 0.3, 0.45, 0.6].forEach((s, i) =>
        play([523, 659, 784, 1047, 1318][i], 'sine', s, 0.2));
    }
  } catch(e) { /* AudioContext no disponible */ }
}

function lqRenderPodium(containerId, scores) {
  const sorted = [...scores].sort((a,b) => b.score - a.score);
  const container = document.getElementById(containerId);
  if (!container) return;
  
  const heights = ['h-40 md:h-48', 'h-52 md:h-60', 'h-32 md:h-40'];
  const colors = ['bg-slate-400 text-slate-900', 'bg-yellow-400 text-yellow-900', 'bg-amber-700 text-amber-100'];
  const pData = [sorted[1], sorted[0], sorted[2]]; // Posiciones 2, 1, 3 en el podio

  container.innerHTML = pData.map((p, i) => {
    if (!p) return `<div class="flex-1 max-w-[120px]"></div>`;
    const rank = (i === 0 ? 2 : i === 1 ? 1 : 3);
    return `
      <div class="flex-1 max-w-[160px] flex flex-col items-center justify-end" data-aos="fade-up" data-aos-delay="${i*150}">
        <div class="text-sm md:text-base font-bold text-white mb-1 truncate w-full text-center px-1">${p.name}</div>
        <div class="text-xs font-medium text-brand-300 mb-3">${p.score} pts</div>
        <div class="w-full ${heights[i]} ${colors[i]} rounded-t-2xl border border-white/20 shadow-[0_0_20px_rgba(255,255,255,0.1)] flex items-start justify-center pt-4 transition-all hover:scale-105">
          <span class="font-black text-4xl opacity-40">${rank}</span>
        </div>
      </div>
    `;
  }).join('');
  if (window.lucide) window.lucide.createIcons();
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
  if (!el) return;

  el.innerHTML = `
    <div class="flex items-center gap-2 mb-6 p-3 bg-brand-400/5 border-l-4 border-brand-400 rounded-r-xl" data-aos="fade-right">
      <i data-lucide="check-square" class="w-5 h-5 text-brand-400"></i>
      <span class="text-sm font-bold text-gray-200">${qs.length} pregunta(s) detectadas</span>
      <span class="text-[0.7rem] text-gray-500 ml-auto uppercase tracking-widest font-bold">Resumen de contenido</span>
    </div>
    <div class="space-y-4 max-h-[500px] overflow-y-auto pr-2 custom-scrollbar">
      ${qs.map((q, i) => `
        <div class="glass-panel p-5 rounded-[1.5rem] border border-white/5 hover:border-brand-400/30 transition-all duration-300 group" data-aos="fade-up" data-aos-delay="${i*50}">
          <div class="flex gap-4">
            <div class="flex-shrink-0 w-8 h-8 rounded-xl bg-gradient-to-br from-brand-600 to-brand-400 flex items-center justify-center text-xs font-black text-white shadow-lg shadow-brand-400/10 group-hover:scale-110 transition-transform">
              ${i+1}
            </div>
            <div class="flex-1 pt-1">
              <div class="text-[0.95rem] text-gray-100 leading-relaxed font-medium mb-4">${lqProcessText(q.text)}</div>
              
              ${q.options && q.options.length ? `
                <div class="grid grid-cols-1 sm:grid-cols-2 gap-3 pt-3 border-t border-white/5">
                  ${q.options.map((opt, oi) => {
                    const isCorrect = q.correct === oi;
                    return `
                      <div class="flex items-center gap-2 p-2.5 rounded-xl bg-white/5 border ${isCorrect ? 'border-emerald-500/30 bg-emerald-500/5' : 'border-white/5'} transition-colors">
                        <span class="text-[0.7rem] font-bold ${isCorrect ? 'text-emerald-400' : 'text-brand-400'} w-5 h-5 rounded-lg bg-black/20 flex items-center justify-center">${String.fromCharCode(65+oi)}</span>
                        <div class="text-[0.8rem] text-gray-400 truncate">${lqProcessText(opt)}</div>
                        ${isCorrect ? '<i data-lucide="check" class="w-3.5 h-3.5 text-emerald-400 ml-auto"></i>' : ''}
                      </div>
                    `;
                  }).join('')}
                </div>
              ` : ''}
            </div>
          </div>
        </div>
      `).join('')}
    </div>
  `;
  
  if (window.updateIcons) window.updateIcons();
  if (typeof AOS !== 'undefined') AOS.refresh();
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
  if (lqChannel) {
    lqChannel.track({ type: 'host', phase: 'cancelled' });
    lqChannel.send({ type: 'broadcast', event: 'cancelled', payload: {} });
  }
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

  // ── Publicar PRIMERO en Presence (garantiza que estudiantes lo reciban) ──
  lqChannel.track({
    type: 'host', phase: 'question',
    questionIdx: lqCurrentQ,
    text: q.text,
    options: q.options || [],
    total: lqQuestions.length,
    timeSec: lqTimeSec,
    startTime: Date.now()
  });
  // ── Tambien por Broadcast como respaldo inmediato ──
  lqChannel.send({
    type: 'broadcast', event: 'question',
    payload: {
      questionIdx: lqCurrentQ,
      text: q.text,
      options: q.options || [],
      total: lqQuestions.length,
      timeSec: lqTimeSec,
      startTime: Date.now()
    }
  });

  // ── Después actualizar UI del profesor ──
  const qCounter = document.getElementById('lq-q-counter');
  const qText    = document.getElementById('lq-host-question');
  const qOpts    = document.getElementById('lq-host-opts');
  const qAns     = document.getElementById('lq-answered-count');
  const scoreMid = document.getElementById('lq-scoreboard-mid');
  const nextBtn  = document.getElementById('lq-next-btn');

  if (qCounter) qCounter.textContent = ` ${lqCurrentQ+1} / ${lqQuestions.length}`;
  if (qText)    { try { qText.innerHTML = lqProcessText(q.text); } catch(e) { qText.textContent = q.text; } }
  if (qAns)     qAns.textContent  = ' 0';
  if (scoreMid) scoreMid.classList.add('hidden');
  if (nextBtn)  nextBtn.textContent = 'Ver respuestas →';

  const letters = ['A','B','C','D'];
  const colors  = ['lq-opt-red','lq-opt-blue','lq-opt-yellow','lq-opt-green'];
  if (qOpts) qOpts.innerHTML = (q.options||[]).map((o,i) => {
    try { return `<div class="lq-host-opt ${colors[i]}">${letters[i]}) ${lqProcessText(o)}</div>`; }
    catch(e) { return `<div class="lq-host-opt ${colors[i]}">${letters[i]}) ${o}</div>`; }
  }).join('');

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
  // Respaldo por Broadcast
  lqChannel.send({ type: 'broadcast', event: 'scores',
    payload: { scores, correctIdx: lqQuestions[lqCurrentQ]?.correct ?? -1 } });

  // Mostrar marcador en panel host
  const rowsEl  = document.getElementById('lq-scoreboard-rows');
  const midEl   = document.getElementById('lq-scoreboard-mid');
  const nextBtn = document.getElementById('lq-next-btn');
  if (rowsEl)  lqRenderScoreRows('lq-scoreboard-rows', scores);
  if (midEl)   midEl.classList.remove('hidden');
  if (nextBtn) nextBtn.innerHTML =
    lqCurrentQ + 1 < lqQuestions.length ? 'Siguiente pregunta →' : '<i data-lucide="trophy" class="icon-sm"></i> Ver ganador';
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
  // Respaldo por Broadcast
  lqChannel.send({ type: 'broadcast', event: 'final', payload: { scores } });
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
      const qIdx = h.questionIdx ?? 0;
      if (qIdx !== slqLastQuestionIdx) {
        slqAnswered = false;
        slqLastQuestionIdx = qIdx;
      }
      if (!slqAnswered) {
        try {
          const elapsed = Math.round((Date.now() - (h.startTime || Date.now())) / 1000);
          slqStartCountdown(h, elapsed);
        } catch(e) { console.error('slqStartCountdown (presence):', e); }
      }
    } else if (h.phase === 'scores') {
      clearInterval(slqTimerInterval);
      slqRevealCorrectAnswer(h.correctIdx ?? -1);
      setTimeout(() => { slqShow('slq-scoreboard'); lqRenderScoreRows('slq-score-rows', h.scores || []); }, 2200);
    } else if (h.phase === 'final') {
      clearInterval(slqTimerInterval);
      lqSound('final');
      slqShow('slq-final');
      lqRenderPodium('slq-final-podium', h.scores || []);
    } else if (h.phase === 'cancelled') {
      toast('El profesor canceló el quiz.', 'info');
      slqExit();
    }
  });

  // ── Broadcast: el host envía una pregunta (respaldo inmediato) ──────────
  slqChannel.on('broadcast', { event: 'question' }, ({ payload: h }) => {
    if (!h) return;
    const qIdx = h.questionIdx ?? 0;
    if (qIdx !== slqLastQuestionIdx) {
      slqAnswered = false;
      slqLastQuestionIdx = qIdx;
    }
    if (!slqAnswered) {
      try {
        const elapsed = Math.round((Date.now() - (h.startTime || Date.now())) / 1000);
        slqStartCountdown(h, elapsed);
      } catch(e) { console.error('slqStartCountdown (broadcast):', e); }
    }
  });

  slqChannel.on('broadcast', { event: 'scores' }, ({ payload: d }) => {
    if (!d) return;
    clearInterval(slqTimerInterval);
    slqRevealCorrectAnswer(d.correctIdx ?? -1);
    setTimeout(() => { slqShow('slq-scoreboard'); lqRenderScoreRows('slq-score-rows', d.scores || []); }, 2200);
  });

  slqChannel.on('broadcast', { event: 'final' }, ({ payload: d }) => {
    if (!d) return;
    clearInterval(slqTimerInterval);
    lqSound('final');
    slqShow('slq-final');
    lqRenderPodium('slq-final-podium', d.scores || []);
  });

  slqChannel.on('broadcast', { event: 'cancelled' }, () => {
    toast('El profesor canceló el quiz.', 'info');
    slqExit();
  });

  // ── Resultado de respuesta individual ───────────────────────────────────
  slqChannel.on('broadcast', { event: 'answer_result' }, ({ payload }) => {
    if (payload.email !== slqMyEmail) return;
    clearInterval(slqTimerInterval);
    if (payload.correct) lqSound('correct'); else lqSound('wrong');
    slqShow('slq-answered');
    
    document.getElementById('slq-result-icon').innerHTML = payload.correct 
      ? '<i data-lucide="check-circle" class="w-20 h-20 text-emerald-400" style="filter:drop-shadow(0 0 10px rgba(52,211,153,0.5))"></i>' 
      : '<i data-lucide="x-octagon" class="w-20 h-20 text-red-400" style="filter:drop-shadow(0 0 10px rgba(248,113,113,0.5))"></i>';
    
    if (window.lucide) window.lucide.createIcons({ root: document.getElementById('slq-result-icon') });
    document.getElementById('slq-result-text').textContent = payload.correct ? '¡Correcto!' : 'Incorrecto';
    document.getElementById('slq-points-gained').textContent = payload.correct ? `+${payload.pts} puntos` : '+0 puntos';
    
    // Revelar respuesta correcta inmediatamente
    if (payload.correctIdx !== undefined) {
      const letters = ['A','B','C','D'];
      const correctText = (slqCurrentOptions && slqCurrentOptions[payload.correctIdx]) 
        ? `${letters[payload.correctIdx]}) ${slqCurrentOptions[payload.correctIdx]}` 
        : 'Cargando...';
      
      const rev = document.getElementById('slq-correct-reveal');
      const text = document.getElementById('slq-correct-text');
      if (rev && text) {
        text.innerHTML = lqProcessText(correctText);
        rev.classList.remove('hidden');
      }
    }
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

  // Strategy: protect math blocks from HTML escaping by replacing them with
  // placeholders first, then escape HTML on remaining text, then restore math
  // rendered with KaTeX.

  const mathBlocks = [];
  const placeholder = (i) => `\x00MATH${i}\x00`;

  function renderKatex(math, display) {
    try {
      return typeof katex !== 'undefined'
        ? katex.renderToString(math.trim(), { displayMode: display, throwOnError: false })
        : (display ? `\\[${math}\\]` : `$${math}$`);
    } catch(e) { return display ? `[${math}]` : `$${math}$`; }
  }

  let t = raw;

  // 1. Extract and replace math blocks with placeholders (in priority order)
  // \begin{equation(*)}
  t = t.replace(/\\begin\{equation\*?\}([\s\S]+?)\\end\{equation\*?\}/gi, (_, math) => {
    const idx = mathBlocks.length; mathBlocks.push(renderKatex(math, true)); return placeholder(idx);
  });
  // \[ ... \]  display math
  t = t.replace(/\\\[([\s\S]+?)\\\]/g, (_, math) => {
    const idx = mathBlocks.length; mathBlocks.push(renderKatex(math, true)); return placeholder(idx);
  });
  // $$ ... $$ display
  t = t.replace(/\$\$([\s\S]+?)\$\$/g, (_, math) => {
    const idx = mathBlocks.length; mathBlocks.push(renderKatex(math, true)); return placeholder(idx);
  });
  // \( ... \)  inline math
  t = t.replace(/\\\(([\s\S]+?)\\\)/g, (_, math) => {
    const idx = mathBlocks.length; mathBlocks.push(renderKatex(math, false)); return placeholder(idx);
  });
  // $ ... $   inline math (single dollar, skip newlines)
  t = t.replace(/\$([^$\n]+?)\$/g, (_, math) => {
    const idx = mathBlocks.length; mathBlocks.push(renderKatex(math, false)); return placeholder(idx);
  });

  // 2. Escape HTML on remaining text
  t = t.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');

  // 3. LaTeX text commands
  t = t.replace(/\\textbf\{([^}]*)\}/g,   '<strong>$1</strong>');
  t = t.replace(/\\textit\{([^}]*)\}/g,   '<em>$1</em>');
  t = t.replace(/\\emph\{([^}]*)\}/g,     '<em>$1</em>');
  t = t.replace(/\\underline\{([^}]*)\}/g,'<u>$1</u>');
  t = t.replace(/\\texttt\{([^}]*)\}/g,   '<code>$1</code>');
  t = t.replace(/\\textsc\{([^}]*)\}/g,   '<span style="font-variant:small-caps">$1</span>');
  t = t.replace(/\\textsuperscript\{([^}]*)\}/g, '<sup>$1</sup>');
  t = t.replace(/\\textsubscript\{([^}]*)\}/g,   '<sub>$1</sub>');
  t = t.replace(/\\text\{([^}]*)\}/g, '$1');

  // 4. Line breaks
  t = t.replace(/\\\\/g, '<br>');
  t = t.replace(/\\newline/g, '<br>');
  t = t.replace(/\\linebreak/g, '<br>');
  t = t.replace(/\\par\b/g, '</p><p>');
  t = t.replace(/\\noindent\b/g, '');

  // 5. Lists
  t = t.replace(/\\begin\{enumerate\}(?:\[.*?\])?/g, '<ol class="list-decimal ml-6 mb-4 space-y-1">');
  t = t.replace(/\\end\{enumerate\}/g, '</ol>');
  t = t.replace(/\\begin\{itemize\}/g, '<ul class="list-disc ml-6 mb-4 space-y-1">');
  t = t.replace(/\\end\{itemize\}/g, '</ul>');
  t = t.replace(/\\item\s+/g, '<li>');

  // 6. Spacing
  t = t.replace(/\\qquad/g, '&emsp;&emsp;');
  t = t.replace(/\\quad/g,  '&emsp;');
  t = t.replace(/\\[,;:]/g, '&thinsp;');
  t = t.replace(/\\hspace\{[^}]*\}/g, '&emsp;');
  t = t.replace(/\\vspace\{[^}]*\}/g, '<br>');
  t = t.replace(/\\ldots|\\dots|\\cdots/g, '…');
  t = t.replace(/\\%/g, '%');
  t = t.replace(/\\#/g, '#');
  t = t.replace(/\\rule\{[^}]*\}\{[^}]*\}/g, '<span class="lq-blank">______</span>');

  // 7. Restore math placeholders
  t = t.replace(/\x00MATH(\d+)\x00/g, (_, i) => mathBlocks[+i] || '');

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

  if (numEl)  numEl.textContent = `Pregunta ${(h.questionIdx||0)+1} de ${h.total||'?'}`;
  // Render LaTeX in question text
  if (textEl) textEl.innerHTML = lqProcessText(h.text || '');

  // Store current options for correct-answer reveal
  slqCurrentOptions = h.options || [];

  // Render options with LaTeX
  const colors  = ['lq-opt-red','lq-opt-blue','lq-opt-yellow','lq-opt-green'];
  const letters = ['A','B','C','D'];
  if (optsEl) optsEl.innerHTML = slqCurrentOptions.map((o, i) => `
    <button class="lq-student-btn ${colors[i]}" onclick="slqAnswer(${i})" id="slq-btn-${i}">
      <span class="lq-btn-letter">${letters[i]}</span>
      <span class="lq-btn-text">${lqProcessText(o)}</span>
    </button>`).join('');

  // Temporizador
  if (timerEl) { timerEl.textContent = remaining; timerEl.style.color = ''; }
  if (slqTimerInterval) clearInterval(slqTimerInterval);
  let t = remaining;
  slqTimerInterval = setInterval(() => {
    t--;
    if (timerEl) { timerEl.textContent = t; if (t <= 3) timerEl.style.color = 'var(--danger)'; }
    if (t <= 0) { clearInterval(slqTimerInterval); slqTimeOut(); }
  }, 1000);
}

// ── ALUMNO: Tiempo agotado ────────────────────────────────────
function slqTimeOut() {
  if (slqAnswered) return;
  slqAnswered = true;
  lqSound('timeout');
  if (slqChannel) slqChannel.send({
    type: 'broadcast', event: 'answer',
    payload: { email: slqMyEmail, answerIdx: -1 }
  });
  slqShow('slq-answered');
  document.getElementById('slq-result-icon').innerHTML = '<i data-lucide="clock" class="icon-hero" style="color:#eab308"></i>';
  if (window.lucide) window.lucide.createIcons({ root: document.getElementById('slq-result-icon') });
  document.getElementById('slq-result-text').textContent = '¡Tiempo agotado!';
  document.getElementById('slq-points-gained').textContent = '+0 puntos';
  const rev = document.getElementById('slq-correct-reveal');
  if (rev) rev.classList.add('hidden');
}

// ── ALUMNO: Revelar respuesta correcta (llega con marcador) ────────────
function slqRevealCorrectAnswer(correctIdx) {
  if (correctIdx < 0 || !slqCurrentOptions[correctIdx]) return;
  const letters = ['A','B','C','D'];
  const answer  = `${letters[correctIdx]}) ${slqCurrentOptions[correctIdx]}`;
  const rev  = document.getElementById('slq-correct-reveal');
  const text = document.getElementById('slq-correct-text');
  if (!rev || !text) return;
  // Mostrar solo si el alumno está en la pantalla 'slq-answered'
  const answeredPanel = document.getElementById('slq-answered');
  if (answeredPanel && !answeredPanel.classList.contains('hidden')) {
    text.innerHTML = lqProcessText(answer);
    rev.classList.remove('hidden');
  }
}

// ── ALUMNO: Cuenta regresiva 3-2-1 antes de la pregunta ────────────
function slqStartCountdown(h, elapsedSec) {
  // Si ya lleva más de 3 segundos transcurridos, mostrar directo
  if (elapsedSec >= 3) { slqRenderQuestion(h, elapsedSec); return; }

  slqShow('slq-countdown');
  const numEl = document.getElementById('slq-countdown-num');
  const qEl   = document.getElementById('slq-countdown-q');
  if (qEl) qEl.textContent = `Pregunta ${(h.questionIdx||0)+1} de ${h.total||'?'}`;

  let count = 3;
  if (numEl) numEl.textContent = count;
  lqSound('countdown');

  const iv = setInterval(() => {
    count--;
    if (count <= 0) {
      clearInterval(iv);
      lqSound('go');
      slqRenderQuestion(h, elapsedSec + 3);
    } else {
      if (numEl) {
        numEl.style.transform = 'scale(1.4)';
        numEl.textContent = count;
        setTimeout(() => { numEl.style.transform = 'scale(1)'; }, 150);
      }
      lqSound('countdown');
    }
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
  document.getElementById('slq-result-icon').innerHTML  = '<i data-lucide="hourglass" class="icon-hero" style="color:var(--primary-light)"></i>';
  if (window.lucide) window.lucide.createIcons({ root: document.getElementById('slq-result-icon') });
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

function showStudentLiveSection() {
  const overlay = document.getElementById('slq-modal-overlay');
  const drawer  = document.getElementById('slq-modal-drawer');
  if (!overlay) return;
  overlay.classList.remove('hidden');
  // Animate in
  setTimeout(() => {
    overlay.classList.remove('opacity-0');
    overlay.classList.add('opacity-100');
    if (drawer) {
      drawer.classList.remove('scale-95');
      drawer.classList.add('scale-100');
    }
  }, 10);
  slqShow('slq-join');
  const input = document.getElementById('slq-code-input');
  if (input) {
    input.value = '';
    setTimeout(() => input.focus(), 200);
  }
}

function slqCloseModal() {
  const overlay = document.getElementById('slq-modal-overlay');
  const drawer  = document.getElementById('slq-modal-drawer');
  if (!overlay) return;
  overlay.classList.remove('opacity-100');
  overlay.classList.add('opacity-0');
  if (drawer) {
    drawer.classList.remove('scale-100');
    drawer.classList.add('scale-95');
  }
  setTimeout(() => overlay.classList.add('hidden'), 300);
}

// ── Variables globales para Quiz en Vivo (Segunda declaración para asegurar retrocompatibilidad) ──
// ── (Usamos lqSessionCode como principal) ───────────────────────────
// (Espacio reservado para la inicialización)

// ── Inicialización global ───────────────────────────────────
window.updateIcons = () => {
  if (typeof lucide !== 'undefined') lucide.createIcons();
};

document.addEventListener('DOMContentLoaded', () => {
  window.updateIcons();
  const savedTheme = localStorage.getItem('theme');
  if (savedTheme === 'light') toggleTheme();
  currentUser = JSON.parse(localStorage.getItem('currentUser'));
  if (currentUser) {
    routeUser();
  }
});
