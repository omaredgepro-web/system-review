const SUPABASE_URL = 'https://gnpejzuxwqftxgfcsics.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImducGVqenV4d3FmdHhnZmNzaWNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MzU3ODYsImV4cCI6MjEwMjIxMTc4Nn0.4nrBcwRm4W51EX8_QtGvTrkwLFVjtiomPXyDU0N1mTQ';
const TABLE_NAME = 'system_review1';

// ⚠️ عدّل اسم الجدول ده لو مختلف عندك في Supabase (استنتجته من اسم ملف الـ CSV اللي بعتهولي)
const CERT_TABLE_NAME = 'layout';
const CERT_STATUSES = ['تم الطباعة', 'تم إعادة الطباعة', 'مرفوض', 'محجوز', 'خطأ جهة ولاية', 'خطأ عنوان', 'معلق'];
const CERT_REASON_REQUIRED_STATUSES = ['مرفوض', 'خطأ جهة ولاية', 'خطأ عنوان'];
      
// ⚠️ USERS_DB اتشالت بالكامل من هنا. اليوزرات والباسوردات بقت متخزنة في Supabase Auth،
// مش في كود الجافا سكريبت. القايمة دي بتتحمّل بعد تسجيل الدخول من جدول profiles.
let ALL_PROFILES = []; // [{ id, username, name, role }] - من غير باسورد أو إيميل خالص

function getUsernames() {
  return ALL_PROFILES.map(p => p.username);
}
function getRole(username) {
  const p = ALL_PROFILES.find(p => p.username === username);
  return p ? p.role : null;
}
async function fetchOwnProfile(userId) {
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('id, username, name, role')
    .eq('id', userId)
    .single();
  if (error) { console.error(error); return null; }
  return data;
}
async function fetchAllProfiles() {
  const { data, error } = await supabaseClient
    .from('profiles')
    .select('id, username, name, role');
  if (error) { console.error(error); return []; }
  return data;
}

// ============ الوضع الداكن / الفاتح ============
function applyThemeIcon() {
  const theme = document.documentElement.getAttribute('data-theme') || 'dark';
  document.querySelectorAll('.theme-toggle-icon').forEach(el => {
    el.innerText = theme === 'dark' ? '💡' : '🌙';
  });
  document.querySelectorAll('.theme-toggle-text').forEach(el => {
    el.innerText = theme === 'dark' ? 'وضع فاتح' : 'وضع داكن';
  });
}

function toggleTheme() {
  const html = document.documentElement;
  const current = html.getAttribute('data-theme') || 'dark';
  const next = current === 'dark' ? 'light' : 'dark';
  html.setAttribute('data-theme', next);
  localStorage.setItem('app_theme', next);
  applyThemeIcon();
}

let supabaseClient;
let currentUser = null;
let currentPage = 1;
const pageSize = 20;
let totalRecordsCount = 0;
let selectedOrder = null;
let parsedCsvData = [];
let parsedPrintOrderNumbers = [];
let printOrderAssignments = {}; // order_number -> اسم الأدمن المخصص ليه (من التوزيع التلقائي)
let printDistUserSelection = null;
let selectedOrderNumbers = new Set();

// ============ حالة تاب طباعة الشهادات ============
let certMasterData = [];
let certAllData = [];
let certCurrentPage = 1;
const certPageSize = 20;
let certTotalRecordsCount = 0;
let selectedCertOrder = null;
let certDataLoaded = false;
let selectedCertOrderNumbers = new Set();

window.addEventListener('DOMContentLoaded', async () => {
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  applyThemeIcon();

  // Supabase بيحتفظ بالجلسة (session) لوحده - مش محتاجين نخزن يوزر/باسورد في localStorage تاني
  const { data: { session } } = await supabaseClient.auth.getSession();
  if (session && session.user) {
    const profile = await fetchOwnProfile(session.user.id);
    if (profile) {
      await setupUserSession(profile);
    } else {
      // حساب معمول له تسجيل دخول في Supabase بس معندوش صف في profiles - حالة غير متوقعة، نطلعه بره
      await supabaseClient.auth.signOut();
    }
  }
});

function toggleSidebar() {
  const sidebar = document.getElementById('reviewer-sidebar');
  document.getElementById('company-sidebar').classList.remove('active');
  sidebar.classList.toggle('active');
}

function toggleCompanySidebar() {
  const sidebar = document.getElementById('company-sidebar');
  document.getElementById('reviewer-sidebar').classList.remove('active');
  sidebar.classList.toggle('active');
}

async function handleLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const errEl = document.getElementById('login-error');
  const loginBtn = document.querySelector('#login-screen .btn-primary');

  errEl.style.display = 'none';

  if (!username || !password) {
    errEl.innerText = 'يرجى كتابة اسم المستخدم وكلمة المرور';
    errEl.style.display = 'block';
    return;
  }

  if (loginBtn) { loginBtn.disabled = true; loginBtn.innerText = 'جاري الدخول...'; }

  try {
    // 1) نلاقي الإيميل المرتبط باسم المستخدم ده عن طريق دالة (RPC) في Supabase
    //    من غير ما نكشف أي أسماء يوزرات تانية أو نسمح بعمل enumeration
    const { data: email, error: lookupError } = await supabaseClient.rpc('get_login_email', { p_username: username });

    if (lookupError || !email) {
      errEl.innerText = 'اسم المستخدم أو كلمة المرور غير صحيحة';
      errEl.style.display = 'block';
      return;
    }

    // 2) تسجيل الدخول الفعلي - التحقق من الباسورد بيحصل جوه Supabase مش في المتصفح
    const { data: authData, error: authError } = await supabaseClient.auth.signInWithPassword({ email, password });

    if (authError || !authData.user) {
      errEl.innerText = 'اسم المستخدم أو كلمة المرور غير صحيحة';
      errEl.style.display = 'block';
      return;
    }

    // 3) هات بروفايل اليوزر (الاسم والرول) من جدول profiles
    const profile = await fetchOwnProfile(authData.user.id);
    if (!profile) {
      errEl.innerText = 'تم تسجيل الدخول لكن لا يوجد بروفايل مرتبط بهذا الحساب. راجع الأدمن';
      errEl.style.display = 'block';
      await supabaseClient.auth.signOut();
      return;
    }

    await setupUserSession(profile);
  } catch (e) {
    console.error(e);
    errEl.innerText = 'حصل خطأ غير متوقع أثناء تسجيل الدخول';
    errEl.style.display = 'block';
  } finally {
    if (loginBtn) { loginBtn.disabled = false; loginBtn.innerText = '🔐 تسجيل الدخول'; }
  }
}

async function setupUserSession(profile) {
  currentUser = profile; // { id, username, name, role }

  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-content').style.display = 'block';
  document.getElementById('user-welcome-text').innerText = `مرحباً بك: ${profile.name} (${profile.role === 'admin' ? 'أدمن' : 'مراجع'})`;

  const isAdmin = profile.role === 'admin';
  document.getElementById('admin-tab-btn').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('select-all-header').style.display = isAdmin ? 'table-cell' : 'none';
  document.getElementById('admin-action-header').style.display = isAdmin ? 'table-cell' : 'none';
  document.getElementById('admin-bulk-bar').style.display = isAdmin ? 'flex' : 'none';
  document.getElementById('admin-export-actions').style.display = isAdmin ? 'flex' : 'none';
  document.getElementById('certificates-tab-btn').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('print-distribute-tab-btn').style.display = isAdmin ? 'block' : 'none';

  // تغيير تاريخ الطلبات المعروضة متاح للأدمن بس؛ المراجع دايمًا شايف أحدث تاريخ متاح
  document.getElementById('date-filter-label').style.display = isAdmin ? 'inline' : 'none';
  document.getElementById('date-filter').style.display = isAdmin ? 'inline-block' : 'none';
  document.getElementById('reset-date-btn').style.display = isAdmin ? 'inline-flex' : 'none';

  ALL_PROFILES = await fetchAllProfiles();
  populateReviewerDropdowns();
  loadData();
}

function populateReviewerDropdowns() {
  const filterSelect = document.getElementById('reviewer-filter');
  const reassignSelect = document.getElementById('bulk-reassign-select');

  filterSelect.innerHTML = `<option value="ALL">كل المراجعين</option><option value="UNASSIGNED">⛔ غير موزّع</option>`;
  reassignSelect.innerHTML = `<option value="">تغيير المراجع إلى...</option>`;

  // بيشمل المراجعين والأدمن كمان، لإمكانية توزيع الطلبات على الأدمن برضو لو احتاج الأمر
  ALL_PROFILES.filter(p => p.role === 'reviewer').forEach(p => {
    filterSelect.innerHTML += `<option value="${p.username}">${p.name}</option>`;
    reassignSelect.innerHTML += `<option value="${p.username}">${p.name}</option>`;
  });
  ALL_PROFILES.filter(p => p.role === 'admin').forEach(p => {
    filterSelect.innerHTML += `<option value="${p.username}">${p.name} (أدمن)</option>`;
    reassignSelect.innerHTML += `<option value="${p.username}">${p.name} (أدمن)</option>`;
  });
}

async function handleLogout() {
  await supabaseClient.auth.signOut();
  location.reload();
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  document.getElementById('tab-dashboard').style.display = 'none';
  document.getElementById('tab-admin').style.display = 'none';
  document.getElementById('tab-certificates').style.display = 'none';
  document.getElementById('tab-print-distribute').style.display = 'none';

  if (tabName === 'dashboard') {
    document.getElementById('dashboard-tab-btn').classList.add('active');
    document.getElementById('tab-dashboard').style.display = 'block';
  } else if (tabName === 'admin') {
    document.getElementById('admin-tab-btn').classList.add('active');
    document.getElementById('tab-admin').style.display = 'block';
  } else if (tabName === 'certificates') {
    document.getElementById('certificates-tab-btn').classList.add('active');
    document.getElementById('tab-certificates').style.display = 'block';
    if (!certDataLoaded) loadCertificatesData();
  } else if (tabName === 'print-distribute') {
    document.getElementById('print-distribute-tab-btn').classList.add('active');
    document.getElementById('tab-print-distribute').style.display = 'block';
  }
}

function parseToIsoDate(dateStr) {
  if (!dateStr) return '';
  const strVal = String(dateStr).trim();

  if (strVal.includes('/')) {
    const parts = strVal.split(' ')[0].split('/');
    if (parts.length === 3) {
      let month = parseInt(parts[0], 10);
      let day = parseInt(parts[1], 10);
      let year = parseInt(parts[2], 10);
      if (year < 100) year += 2000;
      return `${year}-${String(month).padStart(2, '0')}-${String(day).padStart(2, '0')}`;
    }
  }

  const cleanStr = strVal.split(' ')[0];
  if (/^\d{4}-\d{2}-\d{2}$/.test(cleanStr)) return cleanStr;
  return '';
}

function extractDateString(item) {
  return parseToIsoDate(item.date || item.created_at || item['التاريخ'] || item['تاريخ الطلب'] || '');
}

async function loadData() {
  const tbody = document.getElementById('orders-tbody');
  tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;">جاري جلب البيانات من Supabase...</td></tr>`;

  try {
    let allFetched = [];
    let from = 0, step = 1000, hasMore = true;

    while (hasMore) {
      const { data, error } = await supabaseClient.from(TABLE_NAME).select('*').range(from, from + step - 1);
      if (error) throw error;

      if (data && data.length > 0) {
        allFetched = allFetched.concat(data);
        from += step;
        if (data.length < step) hasMore = false;
      } else { hasMore = false; }
    }

    if (allFetched.length === 0) {
      tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;">لا توجد بيانات متاحة</td></tr>`;
      return;
    }

    window.masterData = allFetched;
    applyDateFiltering();

  } catch (err) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center; color:#f87171;">خطأ: ${err.message}</td></tr>`;
  }
}

function applyDateFiltering() {
  if (!window.masterData || window.masterData.length === 0) return;

  const dateInput = document.getElementById('date-filter').value;
  let targetDate = dateInput;

  if (!targetDate) {
    const dates = window.masterData.map(extractDateString).filter(Boolean).sort().reverse();
    targetDate = dates[0] || '';
    if (targetDate) document.getElementById('date-filter').value = targetDate;
  }

  window.allData = window.masterData.filter(item => extractDateString(item) === targetDate);
  document.getElementById('active-date-label').innerText = `يعرض طلبات تاريخ: ${targetDate}`;

  totalRecordsCount = window.allData.length;
  updateKPIs(window.allData); // الحالة العامة (KPIs) دايمًا بتعكس كل الطلبات، حتى للمراجع

  // البيانات اللي فعليًا بتتعرض في الجدول والإحصائيات: المراجع (غير الأدمن) يشوف طلباته هو بس
  if (currentUser && currentUser.role !== 'admin') {
    window.visibleData = window.allData.filter(item => {
      const reviewerName = item.reviewer || item['المراجع'] || '';
      return reviewerName === currentUser.username || reviewerName === currentUser.name;
    });
  } else {
    window.visibleData = window.allData;
  }

  renderReviewersStats(window.visibleData);
  renderCompanyStats(window.allData);
  renderCurrentPage();
}

function onDateFilterChange() { currentPage = 1; selectedOrderNumbers.clear(); updateSelectedCount(); applyDateFiltering(); }
function resetDateToLatest() { document.getElementById('date-filter').value = ''; selectedOrderNumbers.clear(); updateSelectedCount(); applyDateFiltering(); }

function renderCurrentPage() {
  if (!window.visibleData) return;

  const searchValue = document.getElementById('search-input').value.trim().toLowerCase();
  const statusValue = document.getElementById('status-filter').value;
  const reviewerValue = document.getElementById('reviewer-filter').value;

  let filtered = window.visibleData.filter(item => {
    const orderNum = String(item.order_number || item.order_no || item['رقم الطلب'] || '').toLowerCase();
    const matchesSearch = !searchValue || orderNum.includes(searchValue);
    const reviewStatus = item.review_status || item['حالة المراجعة'] || 'لم يتم المراجعة';
    const matchesStatus = (statusValue === 'ALL') || (reviewStatus === statusValue);
    
    const reviewer = item.reviewer || item['المراجع'] || '';
    const matchesReviewer = (reviewerValue === 'ALL') || (reviewerValue === 'UNASSIGNED' ? !reviewer : (reviewer === reviewerValue));

    return matchesSearch && matchesStatus && matchesReviewer;
  });

  totalRecordsCount = filtered.length;
  const from = (currentPage - 1) * pageSize;
  const to = from + pageSize;

  window.currentFilteredData = filtered;
  renderTable(filtered.slice(from, to));
  updatePaginationControls(from + 1, Math.min(to, totalRecordsCount));
}

function renderTable(orders) {
  const tbody = document.getElementById('orders-tbody');
  tbody.innerHTML = '';

  if (orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="10" style="text-align:center;">لا توجد نتائج مطابقة</td></tr>`;
    return;
  }

  const isAdmin = currentUser && currentUser.role === 'admin';

  orders.forEach((order) => {
    const formattedDate = order.date || extractDateString(order) || '-';
    const orderNum = order.order_number || order.order_no || order['رقم الطلب'] || '-';
    const company = order.company || order['الشركة'] || '-';
    const reviewer = order.reviewer || order['المراجع'] || '-';
    const progressStatus = order.status || order['الحالة'] || '-';
    const reviewStatus = order.review_status || order['حالة المراجعة'] || 'لم يتم المراجعة';
    const rejectionReason = order.rejection_reason || order.reason || order['سبب الرفض'] || '-';

    let reviewBadge = 'badge-unreviewed';
    if (reviewStatus === 'مقبول') reviewBadge = 'badge-accepted';
    if (reviewStatus === 'مرفوض') reviewBadge = 'badge-rejected';
    if (reviewStatus === 'معلق') reviewBadge = 'badge-hold';

    const isChecked = selectedOrderNumbers.has(orderNum) ? 'checked' : '';
    const checkboxHtml = isAdmin ? `<td style="text-align:center;"><input type="checkbox" class="row-checkbox" data-ordernum="${orderNum}" ${isChecked} onchange="toggleRowSelect(this, '${orderNum}')"></td>` : '';
    const adminCellHtml = isAdmin ? `<td class="sticky-action-col"><button class="btn-delete-row" onclick="deleteSingleOrder('${orderNum}')">🗑️ مسح</button></td>` : '';

    tbody.innerHTML += `
      <tr>
        ${checkboxHtml}
        <td class="sticky-action-col"><button class="btn btn-open" onclick="openEditModal('${orderNum}')">مراجعة</button></td>
        ${adminCellHtml}
        <td class="order-no-cell">${orderNum}</td>
        <td>${company}</td>
        <td>${reviewer}</td>
        <td><span class="badge badge-pending">${progressStatus}</span></td>
        <td><span class="badge ${reviewBadge}">${reviewStatus}</span></td>
        <td>${formattedDate}</td>
        <td>${rejectionReason}</td>
      </tr>
    `;
  });

  const selectAllCb = document.getElementById('select-all-checkbox');
  if (selectAllCb) {
    const allCurrentChecked = orders.length > 0 && orders.every(o => selectedOrderNumbers.has(o.order_number || o.order_no || o['رقم الطلب']));
    selectAllCb.checked = allCurrentChecked;
  }
}

function toggleRowSelect(cb, orderNum) {
  if (cb.checked) { selectedOrderNumbers.add(orderNum); } 
  else { selectedOrderNumbers.delete(orderNum); }
  updateSelectedCount();
}

function toggleSelectAll(masterCb) {
  if (!window.currentFilteredData) return;
  window.currentFilteredData.forEach(o => {
    const orderNum = o.order_number || o.order_no || o['رقم الطلب'];
    if (masterCb.checked) { selectedOrderNumbers.add(orderNum); } 
    else { selectedOrderNumbers.delete(orderNum); }
  });
  document.querySelectorAll('.row-checkbox').forEach(cb => cb.checked = masterCb.checked);
  updateSelectedCount();
}

function updateSelectedCount() {
  const countEl = document.getElementById('selected-count');
  if (countEl) countEl.innerText = selectedOrderNumbers.size;
}

// تحديد N طلب "غير موزّع" (لسه معندوش مراجع) تلقائيًا بنفس نسبة كل شركة الموجودة فعليًا
// في الطلبات غير الموزّعة حاليًا ضمن الفلتر — النسب بتتحسب أوتوماتيك من البيانات نفسها في كل مرة
function selectNextOrderBatch() {
  const input = document.getElementById('bulk-count-input');
  const count = parseInt(input.value, 10);

  if (!count || count <= 0) { alert('برجاء إدخال عدد صحيح أكبر من صفر'); return; }
  if (!window.currentFilteredData || window.currentFilteredData.length === 0) { alert('لا توجد بيانات لتحديدها ضمن الفلتر الحالي'); return; }

  const getOrderNum = o => o.order_number || o.order_no || o['رقم الطلب'];
  const getCompany = o => o.company || o['الشركة'] || 'غير محدد';

  // تجميع الطلبات غير الموزّعة/غير المحددة حسب الشركة، مع الحفاظ على ترتيبها الأصلي
  const pools = {};
  const poolOrder = [];
  window.currentFilteredData.forEach(o => {
    const reviewer = o.reviewer || o['المراجع'] || '';
    if (reviewer || selectedOrderNumbers.has(getOrderNum(o))) return;
    const company = getCompany(o);
    if (!pools[company]) { pools[company] = []; poolOrder.push(company); }
    pools[company].push(o);
  });

  const totalAvailable = poolOrder.reduce((sum, c) => sum + pools[c].length, 0);
  if (totalAvailable === 0) { alert('لا توجد طلبات غير موزّعة متاحة للتحديد ضمن الفلتر الحالي'); return; }

  const targetTotal = Math.min(count, totalAvailable);

  // حساب نصيب كل شركة بنفس نسبتها الحالية في المخزون المتاح (Largest Remainder Method لدقة أعلى)
  let targets = poolOrder.map(company => {
    const raw = targetTotal * (pools[company].length / totalAvailable);
    return { company, count: Math.floor(raw), remainder: raw - Math.floor(raw) };
  });

  let allocated = targets.reduce((s, t) => s + t.count, 0);
  let remainderNeeded = targetTotal - allocated;

  targets.sort((a, b) => b.remainder - a.remainder);
  for (let i = 0; i < targets.length && remainderNeeded > 0; i++) {
    const t = targets[i];
    if (t.count < pools[t.company].length) { t.count++; remainderNeeded--; }
  }

  // سحب الطلبات الفعلية من كل شركة حسب نصيبها
  const selectedNow = [];
  const breakdown = {};
  targets.forEach(t => {
    const takeCount = Math.min(t.count, pools[t.company].length);
    if (takeCount > 0) {
      const taken = pools[t.company].splice(0, takeCount);
      taken.forEach(o => selectedNow.push(o));
      breakdown[t.company] = takeCount;
    }
  });

  // أي عجز بسيط بسبب التقريب بيتكمل من أي شركة لسه فيها طلبات متاحة
  let totalSelected = selectedNow.length;
  if (totalSelected < targetTotal) {
    for (const c of poolOrder) {
      if (totalSelected >= targetTotal) break;
      while (pools[c].length > 0 && totalSelected < targetTotal) {
        const o = pools[c].shift();
        selectedNow.push(o);
        breakdown[c] = (breakdown[c] || 0) + 1;
        totalSelected++;
      }
    }
  }

  selectedNow.forEach(o => selectedOrderNumbers.add(getOrderNum(o)));
  updateSelectedCount();
  renderCurrentPage();
  input.value = '';

  const summaryLines = Object.entries(breakdown).map(([c, n]) => `• ${c}: ${n}`).join('\n');
  let msg = `تم تحديد ${totalSelected} طلب تلقائيًا بنفس نسب الشركات الحالية في البيانات غير الموزّعة:\n${summaryLines}`;
  if (totalSelected < count) msg += `\n\n(العدد المطلوب كان ${count}، لكن الطلبات المتاحة غير الموزّعة أقل من كده ضمن الفلتر الحالي)`;
  alert(msg);
}

function clearOrderSelection() {
  selectedOrderNumbers.clear();
  updateSelectedCount();
  renderCurrentPage();
}

// تقسيم أي مصفوفة كبيرة لدفعات أصغر
function chunkArray(arr, size) {
  const chunks = [];
  for (let i = 0; i < arr.length; i += size) chunks.push(arr.slice(i, i + size));
  return chunks;
}

// بينفذ حذف/تعديل جماعي على Supabase على دفعات (بدل ما يبعت آلاف الـ IDs في رابط واحد ويترفض بـ "Bad Request").
// action: 'delete' أو 'update'. updateData مطلوبة بس لما action = 'update'.
async function runBatchedSupabaseAction(tableName, matchColumn, matchValues, action, updateData) {
  const BATCH_SIZE = 150;
  const batches = chunkArray(matchValues, BATCH_SIZE);

  for (const batch of batches) {
    const query = action === 'delete'
      ? supabaseClient.from(tableName).delete().in(matchColumn, batch)
      : supabaseClient.from(tableName).update(updateData).in(matchColumn, batch);

    const { error } = await query;
    if (error) return error; // نوقف على أول خطأ ونرجّعه
  }

  return null; // كل الدفعات نجحت
}

// بيرفع (upsert) كمية كبيرة من الصفوف لـ Supabase على دفعات، بدل ما يبعتهم كلهم في طلب واحد
// (ممكن يفشل مع آلاف الصفوف بسبب حجم الطلب الكبير).
async function runBatchedUpsert(tableName, rows, batchSize = 500) {
  const batches = chunkArray(rows, batchSize);
  for (const batch of batches) {
    const { error } = await supabaseClient.from(tableName).upsert(batch);
    if (error) return error;
  }
  return null;
}

async function executeBulkDateUpdate() {
  const newDate = document.getElementById('bulk-date-input').value;
  if (!newDate) { alert('برجاء اختيار التاريخ أولاً'); return; }
  if (selectedOrderNumbers.size === 0) { alert('برجاء تحديد طلب واحد على الأقل'); return; }

  const confirmChange = confirm(`هل أنت تأكد من تحديث تاريخ (${selectedOrderNumbers.size}) طلب إلى "${newDate}"؟`);
  if (!confirmChange) return;

  const targetOrders = window.allData.filter(o => selectedOrderNumbers.has(o.order_number || o.order_no || o['رقم الطلب']));
  if (targetOrders.length === 0) return;
  const matchColumn = targetOrders[0].id !== undefined ? 'id' : (targetOrders[0]['رقم الطلب'] !== undefined ? 'رقم الطلب' : 'order_number');
  const matchValues = targetOrders.map(o => o[matchColumn]);

  try {
    const error = await runBatchedSupabaseAction(TABLE_NAME, matchColumn, matchValues, 'update', { date: newDate });
    if (error) { alert('حدث خطأ أثناء تحديث التاريخ: ' + error.message); }
    else {
      alert(`تم تحديث تاريخ ${selectedOrderNumbers.size} طلب بنجاح إلى "${newDate}"!`);
      targetOrders.forEach(o => { o.date = newDate; });
      selectedOrderNumbers.clear();
      updateSelectedCount();
      await loadData();
    }
  } catch (err) { alert('خطأ: ' + err.message); }
}

async function executeBulkDelete() {
  if (selectedOrderNumbers.size === 0) { alert('برجاء تحديد طلب واحد على الأقل للحذف'); return; }
  const confirmDelete = confirm(`هل أنت تأكد من رغبتك في حذف (${selectedOrderNumbers.size}) طلب محدد نهائياً؟`);
  if (!confirmDelete) return;

  const targetOrders = window.allData.filter(o => selectedOrderNumbers.has(o.order_number || o.order_no || o['رقم الطلب']));
  const matchColumn = targetOrders[0].id !== undefined ? 'id' : (targetOrders[0]['رقم الطلب'] !== undefined ? 'رقم الطلب' : 'order_number');
  const matchValues = targetOrders.map(o => o[matchColumn]);

  try {
    const error = await runBatchedSupabaseAction(TABLE_NAME, matchColumn, matchValues, 'delete');
    if (error) { alert('حدث خطأ أثناء الحذف الجماعي: ' + error.message); } 
    else {
      alert(`تم حذف ${selectedOrderNumbers.size} طلب بنجاح!`);
      window.masterData = window.masterData.filter(o => !selectedOrderNumbers.has(o.order_number || o.order_no || o['رقم الطلب']));
      selectedOrderNumbers.clear();
      updateSelectedCount();
      applyDateFiltering();
    }
  } catch (err) { alert('خطأ: ' + err.message); }
}

async function executeBulkReassign() {
  const newReviewer = document.getElementById('bulk-reassign-select').value;
  if (!newReviewer) { alert('برجاء اختيار المراجع الجديد من القائمة'); return; }
  if (selectedOrderNumbers.size === 0) { alert('برجاء تحديد طلب واحد على الأقل لنقله للمراجع'); return; }

  const confirmChange = confirm(`هل أنت تأكد من نقل (${selectedOrderNumbers.size}) طلب إلى المراجع "${newReviewer}"؟`);
  if (!confirmChange) return;

  const targetOrders = window.allData.filter(o => selectedOrderNumbers.has(o.order_number || o.order_no || o['رقم الطلب']));
  const matchColumn = targetOrders[0].id !== undefined ? 'id' : (targetOrders[0]['رقم الطلب'] !== undefined ? 'رقم الطلب' : 'order_number');
  const matchValues = targetOrders.map(o => o[matchColumn]);

  const reviewerColKey = ('reviewer' in targetOrders[0]) ? 'reviewer' : 'المراجع';
  const updateData = {};
  updateData[reviewerColKey] = newReviewer;

  try {
    const error = await runBatchedSupabaseAction(TABLE_NAME, matchColumn, matchValues, 'update', updateData);
    if (error) { alert('حدث خطأ أثناء نقل الطلبات: ' + error.message); } 
    else {
      alert(`تم تغيير المراجع لـ ${selectedOrderNumbers.size} طلب بنجاح إلى "${newReviewer}"!`);
      targetOrders.forEach(o => o[reviewerColKey] = newReviewer);
      selectedOrderNumbers.clear();
      updateSelectedCount();
      renderReviewersStats(window.allData);
      renderCurrentPage();
    }
  } catch (err) { alert('خطأ: ' + err.message); }
}

async function deleteSingleOrder(orderNum) {
  if (!currentUser || currentUser.role !== 'admin') { alert('هذا الإجراء متاح للأدمن فقط'); return; }
  const confirmDelete = confirm(`هل أنت تأكد من رغبتك في حذف الطلب رقم (${orderNum}) نهائياً؟`);
  if (!confirmDelete) return;

  const targetOrder = window.allData.find(o => String(o.order_number || o.order_no || o['رقم الطلب']) === String(orderNum));
  if (!targetOrder) return;

  let matchColumn = targetOrder.id !== undefined ? 'id' : (targetOrder['رقم الطلب'] !== undefined ? 'رقم الطلب' : 'order_number');
  let matchValue = targetOrder[matchColumn];

  try {
    const { error } = await supabaseClient.from(TABLE_NAME).delete().eq(matchColumn, matchValue);
    if (error) { alert('حدث خطأ أثناء الحذف: ' + error.message); } 
    else {
      alert('تم حذف الطلب بنجاح!');
      window.masterData = window.masterData.filter(o => String(o.order_number || o.order_no || o['رقم الطلب']) !== String(orderNum));
      selectedOrderNumbers.delete(orderNum);
      updateSelectedCount();
      applyDateFiltering();
    }
  } catch (err) { alert('خطأ: ' + err.message); }
}

function handleFileSelect(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;
  handleMultipleFiles(files);
  event.target.value = ''; // نفضّي الـ input عشان لو اختار نفس الملف تاني يشتغل الـ onchange تاني
}

// بيتعامل مع أكتر من ملف مرفوع مرة واحدة (أو أكتر من مرة ورا بعض) — كل ملف جديد بيتضاف على اللي قبله
// بدل ما يمسحه، وكل شيت جوه ملف الإكسيل (لو فيه أكتر من شيت/تبويب) بيتقرأ ويتضاف كمان.
async function handleMultipleFiles(fileList) {
  const files = Array.from(fileList).filter(f => {
    const name = f.name.toLowerCase();
    return name.endsWith('.csv') || name.endsWith('.xlsx') || name.endsWith('.xls');
  });

  if (files.length === 0) {
    alert('برجاء اختيار ملفات CSV أو Excel (xlsx/xls) بس');
    return;
  }

  const namesLabel = files.map(f => f.name).join('، ');
  document.getElementById('file-name-display').innerText = `جاري قراءة: ${namesLabel} ...`;

  try {
    let allNewRows = [];
    for (const file of files) {
      const rawRows = await parseFileToRows(file);
      allNewRows = allNewRows.concat(normalizeUploadedRows(rawRows));
    }

    // أي طلب معندوش تاريخ في الملف، بياخد تاريخ النهاردة تلقائي عشان يظهر فورًا كـ "أحدث تاريخ" أول ما التطبيق يفتح
    const todayIso = new Date().toISOString().split('T')[0];
    allNewRows.forEach(row => {
      if (!row.date) row.date = todayIso;
    });

    parsedCsvData = parsedCsvData.concat(allNewRows); // إضافة على اللي موجود بالفعل، مش استبدال
    document.getElementById('file-name-display').innerText = `تم إضافة: ${namesLabel} (الإجمالي الآن ${parsedCsvData.length} طلب)`;
    renderCsvPreview(parsedCsvData);

    // تنبيه منبثق فوري لو فيه طلبات من الملف اللي اترفع بس دلوقتي متسجلة بالفعل بتاريخ النهاردة
    // (ده أخطر من التكرار العادي لأنه معناه إن الطلب ممكن يتراجع مرتين في نفس اليوم غلط)
    const todayDupInNewRows = getTodayDuplicateOrderNumbers(allNewRows);
    if (todayDupInNewRows.length > 0) {
      alert(`🚨 تنبيه: ${todayDupInNewRows.length} رقم طلب من الملف اللي رفعته دلوقتي مسجل بالفعل بتاريخ النهاردة في قاعدة البيانات.\n\nممكن يكون الطلب ده اتراجع مرتين غلط. راجع قسم "🔁 فحص أرقام الطلبات المكررة" تحت قبل ما تكمل.`);
    }
  } catch (err) {
    alert('تعذّر قراءة أحد الملفات: ' + err.message);
  }
}

// بيقرأ ملف واحد (CSV أو Excel) ويرجّع كل الصفوف الخام فيه كـ Promise.
// لو الملف Excel وفيه أكتر من شيت/تبويب، بيقرأهم كلهم ويجمعهم مع بعض.
function parseFileToRows(file) {
  return new Promise((resolve, reject) => {
    const fileName = file.name.toLowerCase();
    const isExcel = fileName.endsWith('.xlsx') || fileName.endsWith('.xls');

    if (isExcel) {
      const reader = new FileReader();
      reader.onload = function(e) {
        try {
          const data = new Uint8Array(e.target.result);
          const workbook = XLSX.read(data, { type: 'array' });

          let combinedRows = [];
          workbook.SheetNames.forEach(sheetName => {
            const worksheet = workbook.Sheets[sheetName];
            const rows = XLSX.utils.sheet_to_json(worksheet, { defval: '', raw: false });
            combinedRows = combinedRows.concat(rows);
          });

          resolve(combinedRows);
        } catch (err) { reject(err); }
      };
      reader.onerror = () => reject(new Error(`تعذّر قراءة الملف ${file.name}`));
      reader.readAsArrayBuffer(file);
    } else {
      Papa.parse(file, {
        header: true,
        skipEmptyLines: true,
        complete: results => resolve(results.data),
        error: err => reject(err)
      });
    }
  });
}

// بيمسح كل البيانات المرفوعة حاليًا عشان تبدأ رفع من جديد من الأول
function resetCsvUploadData() {
  if (parsedCsvData.length > 0 && !confirm('هل تريد مسح كل الملفات/البيانات المرفوعة حاليًا والبدء من جديد؟')) return;
  parsedCsvData = [];
  csvDistUserSelection = null; // يرجع الاختيار الافتراضي (الكل متحدد) في المرة الجاية
  document.getElementById('file-name-display').innerText = '';
  document.getElementById('csv-preview-area').style.display = 'none';
  document.getElementById('csv-total-banner').style.display = 'none';
}

// بيوحّد أسماء الأعمدة المهمة بغض النظر عن الاسم بالظبط اللي مكتوب بيه العمود في الملف
// (عربي أو إنجليزي، بمسافات زيادة أو حروف كبيرة/صغيرة مختلفة)، وبيسيب باقي الأعمدة زي ما هي.
function normalizeUploadedRows(rows) {
  if (!rows || rows.length === 0) return [];

  const headerAliases = {
    order_number: ['رقم الطلب', 'order_number', 'order number', 'order no', 'order_no'],
    company: ['الشركة', 'company'],
    reviewer: ['المراجع', 'reviewer'],
    date: ['التاريخ', 'تاريخ الطلب', 'date'],
    status: ['حالة المراجعة', 'الحالة', 'status'],
    review_status: ['المراجعة', 'حالة الطلب', 'review_status', 'review status'],
    rejection_reason: ['سبب الرفض', 'rejection_reason', 'reason']
  };

  const originalKeys = Object.keys(rows[0]);
  const keyMap = {}; // originalKey -> canonicalKey (لو اتلاقى تطابق)

  originalKeys.forEach(origKey => {
    const normalized = origKey.trim().toLowerCase();
    for (const canonical in headerAliases) {
      if (headerAliases[canonical].some(alias => alias.toLowerCase() === normalized)) {
        keyMap[origKey] = canonical;
        break;
      }
    }
  });

  return rows.map(row => {
    const newRow = { ...row };
    Object.keys(keyMap).forEach(origKey => {
      const canonical = keyMap[origKey];
      // بيضيف مفتاح موحّد (زي order_number) لو مش موجود بالفعل، من غير ما يمسح العمود الأصلي
      if (!(canonical in newRow) || newRow[canonical] === '' || newRow[canonical] === undefined) {
        newRow[canonical] = row[origKey];
      }
    });
    return newRow;
  });
}

// ============ سحب وإفلات الملف (Drag & Drop) على منطقة الرفع ============
function handleDragOver(event) {
  event.preventDefault();
  event.stopPropagation();
  document.getElementById('upload-box').classList.add('drag-over');
}

function handleDragLeave(event) {
  event.preventDefault();
  event.stopPropagation();
  document.getElementById('upload-box').classList.remove('drag-over');
}

function handleFileDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  document.getElementById('upload-box').classList.remove('drag-over');

  const files = event.dataTransfer && event.dataTransfer.files;
  if (!files || files.length === 0) return;

  handleMultipleFiles(files);
}

// ============ توزيع طلبات الطباعة: رفع أرقام طلبات جديدة لجدول الطباعة (Layout) ============
// بيقرا العمود اللي فيه رقم الطلب بس، بغض النظر عن اسمه بالظبط في الملف
// (رقم الطلب / order_number / requestnumber / request number ...إلخ) وبيتجاهل كل الأعمدة التانية.
function normalizeHeaderKey(key) {
  return key.toString().trim().toLowerCase().replace(/[\s_\-]+/g, '');
}

const ORDER_NUMBER_ALIASES = [
  'رقم الطلب', 'order_number', 'order number', 'order no', 'order_no',
  'requestnumber', 'request_number', 'request number', 'requestno', 'request no'
].map(normalizeHeaderKey);

function extractOrderNumbersFromRows(rows) {
  if (!rows || rows.length === 0) return [];

  const firstRowKeys = Object.keys(rows[0]);
  let matchedKey = null;
  for (const key of firstRowKeys) {
    if (ORDER_NUMBER_ALIASES.includes(normalizeHeaderKey(key))) { matchedKey = key; break; }
  }
  if (!matchedKey) return [];

  return rows
    .map(row => String(row[matchedKey] || '').trim())
    .filter(v => v !== '');
}

function handlePrintFileSelect(event) {
  const files = event.target.files;
  if (!files || files.length === 0) return;
  handleMultiplePrintFiles(files);
  event.target.value = '';
}

async function handleMultiplePrintFiles(fileList) {
  const files = Array.from(fileList).filter(f => {
    const name = f.name.toLowerCase();
    return name.endsWith('.csv') || name.endsWith('.xlsx') || name.endsWith('.xls');
  });

  if (files.length === 0) {
    alert('برجاء اختيار ملفات CSV أو Excel (xlsx/xls) بس');
    return;
  }

  const namesLabel = files.map(f => f.name).join('، ');
  document.getElementById('print-file-name-display').innerText = `جاري قراءة: ${namesLabel} ...`;

  try {
    let allNewNumbers = [];
    for (const file of files) {
      const rawRows = await parseFileToRows(file);
      const extracted = extractOrderNumbersFromRows(rawRows);
      if (extracted.length === 0 && rawRows.length > 0) {
        alert(`معرفتش ألاقي عمود رقم الطلب في الملف "${file.name}". تأكد إن اسم العمود واحد من: رقم الطلب / order_number / requestnumber.`);
        continue;
      }
      allNewNumbers = allNewNumbers.concat(extracted);
    }

    parsedPrintOrderNumbers = [...new Set(parsedPrintOrderNumbers.concat(allNewNumbers))];
    document.getElementById('print-file-name-display').innerText = `تم إضافة: ${namesLabel} (الإجمالي الآن ${parsedPrintOrderNumbers.length} رقم طلب)`;
    renderPrintPreview();
  } catch (err) {
    alert('تعذّر قراءة أحد الملفات: ' + err.message);
  }
}

function renderPrintPreview() {
  const hasData = parsedPrintOrderNumbers.length > 0;
  document.getElementById('print-preview-area').style.display = hasData ? 'block' : 'none';
  document.getElementById('print-total-banner').style.display = hasData ? 'block' : 'none';
  document.getElementById('print-dist-panel').style.display = hasData ? 'block' : 'none';
  document.getElementById('print-total-banner-count').innerText = parsedPrintOrderNumbers.length;
  document.getElementById('print-count').innerText = parsedPrintOrderNumbers.length;

  if (hasData) populatePrintDistUsersList();

  const tbody = document.getElementById('print-preview-tbody');
  const PREVIEW_LIMIT = 500;
  tbody.innerHTML = parsedPrintOrderNumbers.slice(0, PREVIEW_LIMIT).map(num => `
    <tr>
      <td class="order-no-cell">${num}</td>
      <td>${printOrderAssignments[num] || '-'}</td>
    </tr>
  `).join('');
  if (parsedPrintOrderNumbers.length > PREVIEW_LIMIT) {
    tbody.innerHTML += `<tr><td colspan="2" style="text-align:center; color: var(--text-muted);">... و ${parsedPrintOrderNumbers.length - PREVIEW_LIMIT} رقم إضافي (معروضين جزئيًا هنا بس هيترفعوا كلهم)</td></tr>`;
  }
}

function populatePrintDistUsersList() {
  const container = document.getElementById('print-dist-users-list');
  const adminKeys = ALL_PROFILES.filter(p => p.role === 'admin').map(p => p.username);

  if (!printDistUserSelection) {
    printDistUserSelection = new Set(adminKeys); // أول مرة بس: كل الأدمن متحدد افتراضيًا
  }

  container.innerHTML = '';
  adminKeys.forEach(key => {
    const isChecked = printDistUserSelection.has(key) ? 'checked' : '';
    container.innerHTML += `
      <label style="display: flex; align-items: center; gap: 6px; font-size: 13px; background: var(--bg-dark); border: 1px solid var(--card-border); padding: 6px 10px; border-radius: 6px; cursor: pointer;">
        <input type="checkbox" class="print-dist-user-checkbox" value="${key}" ${isChecked} onchange="onPrintDistUserToggle(this)">
        ${key}
      </label>
    `;
  });
}

function onPrintDistUserToggle(checkbox) {
  const adminKeys = ALL_PROFILES.filter(p => p.role === 'admin').map(p => p.username);
  if (!printDistUserSelection) printDistUserSelection = new Set(adminKeys);
  if (checkbox.checked) printDistUserSelection.add(checkbox.value);
  else printDistUserSelection.delete(checkbox.value);
}

function selectAllPrintDistUsers(checked) {
  const adminKeys = ALL_PROFILES.filter(p => p.role === 'admin').map(p => p.username);
  document.querySelectorAll('.print-dist-user-checkbox').forEach(cb => { cb.checked = checked; });
  printDistUserSelection = new Set(checked ? adminKeys : []);
}

// توزيع تلقائي متساوي (Round-robin) على الأدمن المختارين، مع وقف عند التارجت لو محدد
function runPrintBalancedDistribution() {
  if (parsedPrintOrderNumbers.length === 0) {
    alert('برجاء رفع ملف أولاً.');
    return;
  }

  const selectedAdmins = Array.from(document.querySelectorAll('.print-dist-user-checkbox:checked')).map(cb => cb.value);
  if (selectedAdmins.length === 0) {
    alert('برجاء اختيار أدمن واحد على الأقل للتوزيع.');
    return;
  }

  const targetPerPerson = parseInt(document.getElementById('print-dist-target-input').value, 10) || 0; // 0 = بدون تارجت

  printOrderAssignments = {};
  const counts = {};
  selectedAdmins.forEach(a => counts[a] = 0);

  let userIndex = 0;
  let assignedCount = 0;

  for (const num of parsedPrintOrderNumbers) {
    if (targetPerPerson > 0 && selectedAdmins.every(a => counts[a] >= targetPerPerson)) break;

    let attempts = 0;
    while (targetPerPerson > 0 && counts[selectedAdmins[userIndex]] >= targetPerPerson && attempts < selectedAdmins.length) {
      userIndex = (userIndex + 1) % selectedAdmins.length;
      attempts++;
    }
    if (targetPerPerson > 0 && attempts >= selectedAdmins.length) break;

    const admin = selectedAdmins[userIndex];
    printOrderAssignments[num] = admin;
    counts[admin]++;
    assignedCount++;
    userIndex = (userIndex + 1) % selectedAdmins.length;
  }

  renderPrintPreview();
  renderPrintDistSummary(counts, parsedPrintOrderNumbers.length - assignedCount);
}

function renderPrintDistSummary(counts, leftoverCount) {
  const container = document.getElementById('print-dist-summary');
  const rows = Object.keys(counts).map(name => `
    <div class="reviewer-stat">
      <div class="reviewer-info"><div class="name">${name}</div></div>
      <div class="reviewer-counts"><div class="count-accepted">${counts[name]} طلب</div></div>
    </div>
  `).join('');

  const leftoverHtml = leftoverCount > 0
    ? `<p style="font-size: 12px; color: var(--badge-hold-text); margin-top: 10px;">⚠️ ${leftoverCount} طلب لم يتم توزيعه، لأن كل الأدمن المختارين وصلوا للعدد المستهدف. زوّد التارجت أو اختار أدمن إضافيين.</p>`
    : '';

  container.innerHTML = `
    <h4 style="font-size: 13px; margin-bottom: 8px; color: var(--text-muted);">ملخص التوزيع:</h4>
    ${rows}
    ${leftoverHtml}
  `;
}

function resetPrintUploadData() {
  if (parsedPrintOrderNumbers.length > 0 && !confirm('هل تريد مسح كل الأرقام المرفوعة حاليًا والبدء من جديد؟')) return;
  parsedPrintOrderNumbers = [];
  printOrderAssignments = {};
  printDistUserSelection = null;
  document.getElementById('print-file-name-display').innerText = '';
  document.getElementById('print-preview-area').style.display = 'none';
  document.getElementById('print-total-banner').style.display = 'none';
  document.getElementById('print-dist-panel').style.display = 'none';
  document.getElementById('print-dist-summary').innerHTML = '';
}

function handlePrintDragOver(event) {
  event.preventDefault();
  event.stopPropagation();
  document.getElementById('print-upload-box').classList.add('drag-over');
}

function handlePrintDragLeave(event) {
  event.preventDefault();
  event.stopPropagation();
  document.getElementById('print-upload-box').classList.remove('drag-over');
}

function handlePrintFileDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  document.getElementById('print-upload-box').classList.remove('drag-over');

  const files = event.dataTransfer && event.dataTransfer.files;
  if (!files || files.length === 0) return;

  handleMultiplePrintFiles(files);
}

async function uploadPrintOrdersToSupabase() {
  if (parsedPrintOrderNumbers.length === 0) return;
  const btn = document.getElementById('btn-upload-print');
  btn.innerText = 'جاري الرفع...';
  btn.disabled = true;

  try {
    // استبعاد أي رقم طلب موجود بالفعل في جدول الطباعة عشان نتفادى التكرار
    if (!certDataLoaded) await loadCertificatesData();
    const existingNumbers = new Set((certMasterData || []).map(o => String(o.order_number)));
    const newRows = parsedPrintOrderNumbers
      .filter(num => !existingNumbers.has(String(num)))
      .map(num => {
        const row = { order_number: num };
        if (printOrderAssignments[num]) row.Layout = printOrderAssignments[num];
        return row;
      });
    const skippedCount = parsedPrintOrderNumbers.length - newRows.length;

    if (newRows.length === 0) {
      alert('كل أرقام الطلبات دي موجودة بالفعل في جدول الطباعة، مفيش جديد يتضاف.');
      btn.innerText = 'تأكيد ورفع الطلبات لجدول الطباعة';
      btn.disabled = false;
      return;
    }

    const batches = chunkArray(newRows, 150);
    let insertedCount = 0;
    let firstError = null;

    for (const batch of batches) {
      const { error } = await supabaseClient.from(CERT_TABLE_NAME).insert(batch);
      if (error) { firstError = error; break; }
      insertedCount += batch.length;
    }

    if (firstError) {
      alert(`تم رفع ${insertedCount} رقم طلب بنجاح قبل ما يحصل خطأ: ${firstError.message}\nجرب تاني للأرقام الباقية.`);
    } else {
      const skippedNote = skippedCount > 0 ? ` (${skippedCount} كانوا مكررين واتجاهلوا)` : '';
      alert(`تم رفع ${insertedCount} رقم طلب جديد بنجاح!${skippedNote}`);
      resetPrintUploadData();
    }

    certDataLoaded = false;
    await loadCertificatesData();
    switchTab('certificates');
  } catch (err) {
    alert('خطأ: ' + err.message);
  } finally {
    btn.innerText = 'تأكيد ورفع الطلبات لجدول الطباعة';
    btn.disabled = false;
  }
}

function renderCsvPreview(data) {
  const tbody = document.getElementById('csv-preview-tbody');
  tbody.innerHTML = '';
  document.getElementById('csv-count').innerText = data.length;
  document.getElementById('csv-preview-area').style.display = data.length > 0 ? 'block' : 'none';

  document.getElementById('csv-total-banner-count').innerText = data.length.toLocaleString('ar-EG');
  document.getElementById('csv-total-banner').style.display = data.length > 0 ? 'block' : 'none';

  data.slice(0, 10).forEach(row => {
    tbody.innerHTML += `
      <tr>
        <td>${row.order_number || row['رقم الطلب'] || '-'}</td>
        <td>${row.company || row['الشركة'] || '-'}</td>
        <td>${row.reviewer || row['المراجع'] || '-'}</td>
        <td>${row.date || row['التاريخ'] || '-'}</td>
      </tr>
    `;
  });

  renderCsvCompaniesPanel(data);
  renderCsvDuplicatesPanel(data);
  populateCsvDistUsersList();
  populateCustomDistSelects();
  populateCustomDistCompanySelect(data);
  document.getElementById('csv-dist-summary').innerHTML = '';
}

// اسم الشركة لأي صف مرفوع، بغض النظر عن اسم العمود بالظبط (عربي أو إنجليزي)
// اسم الشركة لأي صف مرفوع، بغض النظر عن اسم العمود بالظبط (عربي أو إنجليزي)، مع إزالة أي مسافات زيادة
// في البداية/النهاية عشان "شركة X" و"شركة X " (بمسافة زيادة) ميتحسبوش شركتين مختلفتين بالغلط.
function getCsvRowCompany(row) {
  const raw = row.company || row['الشركة'] || 'غير محدد';
  return String(raw).trim();
}

// لوحة الشركات الموجودة في الملف المرفوع، مع عدد طلبات كل شركة وزرار حذف لشيلها بالكامل من الملف
function renderCsvCompaniesPanel(data) {
  const container = document.getElementById('csv-companies-list');
  container.innerHTML = '';

  if (!data || data.length === 0) {
    container.innerHTML = `<p style="font-size: 13px; color: var(--text-muted);">لا توجد بيانات.</p>`;
    return;
  }

  const counts = {};
  const order = [];
  data.forEach(row => {
    const company = getCsvRowCompany(row);
    if (!(company in counts)) { counts[company] = 0; order.push(company); }
    counts[company]++;
  });

  order.forEach(company => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; align-items:center; justify-content:space-between; gap: 10px; background: var(--card-bg); border: 1px solid var(--card-border); padding: 8px 12px; border-radius: 8px; flex-wrap: wrap;';

    const label = document.createElement('span');
    label.style.cssText = 'font-size: 13px; font-weight: 600;';
    label.textContent = `${company} (${counts[company]} طلب)`;

    const controls = document.createElement('div');
    controls.style.cssText = 'display: flex; align-items: center; gap: 8px;';

    // خانة تحديد عدد معين من الشركة دي بس، والباقي يتشال من الملف
    const limitInput = document.createElement('input');
    limitInput.type = 'number';
    limitInput.min = '1';
    limitInput.max = String(counts[company]);
    limitInput.placeholder = 'كام طلب؟';
    limitInput.className = 'filter-select';
    limitInput.style.cssText = 'width: 90px; padding: 4px 8px; font-size: 12px;';

    const applyBtn = document.createElement('button');
    applyBtn.type = 'button';
    applyBtn.className = 'btn btn-secondary';
    applyBtn.style.cssText = 'padding: 4px 10px; font-size: 12px;';
    applyBtn.innerText = 'تطبيق';
    applyBtn.addEventListener('click', () => {
      const limitValue = parseInt(limitInput.value, 10);
      if (!limitValue || limitValue < 1) { alert('اكتب رقم صحيح أكبر من صفر.'); return; }
      applyCsvCompanyLimit(company, limitValue);
    });

    // بنستخدم addEventListener بدل onclick="..." هنا عشان أسماء بعض الشركات ممكن تحتوي على علامات تنصيص
    // أو رموز خاصة كانت بتكسر الـ HTML attribute وتمنع الزرار من الشغل خالص.
    const deleteBtn = document.createElement('button');
    deleteBtn.type = 'button';
    deleteBtn.className = 'btn-delete-row';
    deleteBtn.innerText = '🗑️ حذف';
    deleteBtn.addEventListener('click', () => deleteCompanyFromCsv(company));

    controls.appendChild(limitInput);
    controls.appendChild(applyBtn);
    controls.appendChild(deleteBtn);

    row.appendChild(label);
    row.appendChild(controls);
    container.appendChild(row);
  });
}

// بيسيب بس أول N طلب من شركة معينة في الملف، ويشيل الباقي قبل الرفع/التوزيع
function applyCsvCompanyLimit(company, limitValue) {
  let kept = 0;
  const before = parsedCsvData.filter(row => getCsvRowCompany(row) === company).length;

  if (limitValue >= before) {
    alert(`العدد اللي كتبته (${limitValue}) أكبر من أو يساوي عدد طلبات الشركة الموجودة (${before})، فمفيش حاجة هتتشال.`);
    return;
  }

  const confirmLimit = confirm(`هيتم الإبقاء على أول ${limitValue} طلب بس من شركة "${company}" (من أصل ${before})، والباقي (${before - limitValue}) هيتشال من الملف. تأكيد؟`);
  if (!confirmLimit) return;

  parsedCsvData = parsedCsvData.filter(row => {
    if (getCsvRowCompany(row) !== company) return true;
    kept++;
    return kept <= limitValue;
  });

  renderCsvPreview(parsedCsvData);
}

// فحص الأرقام المكررة: داخل نفس الملف المرفوع، وكمان اللي موجودة بالفعل في قاعدة البيانات
function getCsvRowOrderNumber(row) {
  return String(row.order_number || row['رقم الطلب'] || '').trim();
}

function renderCsvDuplicatesPanel(data) {
  const container = document.getElementById('csv-duplicates-panel');
  if (!container) return;

  if (!data || data.length === 0) { container.innerHTML = ''; return; }

  const seenCounts = {};
  data.forEach(row => {
    const num = getCsvRowOrderNumber(row);
    if (!num) return;
    seenCounts[num] = (seenCounts[num] || 0) + 1;
  });

  const dupWithinFile = Object.keys(seenCounts).filter(num => seenCounts[num] > 1);

  const existingSet = new Set((window.masterData || []).map(o => String(o.order_number || o.order_no || o['رقم الطلب'])));
  const dupExisting = [...new Set(data.map(getCsvRowOrderNumber))].filter(num => num && existingSet.has(num));

  // فحص إضافي: هل نفس رقم الطلب موجود بالفعل في قاعدة البيانات بتاريخ اليوم بالظبط؟
  // ده أخطر من التكرار العادي لأنه معناه إن الطلب ده اتراجع/اتسجل مرتين في نفس اليوم بالغلط.
  const dupToday = getTodayDuplicateOrderNumbers(data);

  if (dupWithinFile.length === 0 && dupExisting.length === 0) {
    container.innerHTML = `<p style="color: var(--badge-accept-text);">✅ مفيش أي رقم طلب مكرر — لا داخل الملف ولا في قاعدة البيانات.</p>`;
    return;
  }

  let html = '';

  if (dupToday.length > 0) {
    html += `<p style="color: var(--badge-reject-text); font-weight:800; margin-bottom:6px;">🚨 ${dupToday.length} رقم طلب مسجل بالفعل بتاريخ النهاردة — يبقى ممكن الطلب ده يتراجع مرتين في نفس اليوم غلط!</p>`;
    html += `<div style="max-height:130px; overflow-y:auto; font-size:12px; color: var(--text-muted); background: var(--card-bg); border: 1px solid var(--badge-reject-text); border-radius: 6px; padding: 8px; margin-bottom:14px;">`;
    html += dupToday.join('، ');
    html += `</div>`;
  }

  if (dupWithinFile.length > 0) {
    html += `<p style="color: var(--badge-reject-text); font-weight:700; margin-bottom:6px;">⚠️ ${dupWithinFile.length} رقم طلب مكرر داخل نفس الملف (ظهر أكتر من مرة):</p>`;
    html += `<div style="max-height:130px; overflow-y:auto; font-size:12px; color: var(--text-muted); background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 8px; margin-bottom:14px;">`;
    html += dupWithinFile.map(num => `${num} <span style="color: var(--badge-reject-text);">(×${seenCounts[num]})</span>`).join('، ');
    html += `</div>`;
  }

  if (dupExisting.length > 0) {
    html += `<p style="color: var(--badge-hold-text); font-weight:700; margin-bottom:6px;">⚠️ ${dupExisting.length} رقم طلب موجود بالفعل في قاعدة البيانات:</p>`;
    html += `<p style="font-size:11px; color: var(--text-muted); margin-bottom:6px;">تنبيه: الرفع هيتم بدون معرف (id) مطابق، يعني لو رفعتهم هيتسجلوا كصفوف جديدة مكررة، مش هيستبدلوا القديمة.</p>`;
    html += `<div style="max-height:130px; overflow-y:auto; font-size:12px; color: var(--text-muted); background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 8px;">`;
    html += dupExisting.join('، ');
    html += `</div>`;
  }

  container.innerHTML = html;
}

// بيرجّع أرقام الطلبات (من data) اللي موجودة بالفعل في قاعدة البيانات بتاريخ اليوم بالظبط
function getTodayDuplicateOrderNumbers(data) {
  const todayIso = new Date().toISOString().split('T')[0];
  const todaySet = new Set(
    (window.masterData || [])
      .filter(o => extractDateString(o) === todayIso)
      .map(o => String(o.order_number || o.order_no || o['رقم الطلب']))
  );
  return [...new Set(data.map(getCsvRowOrderNumber))].filter(num => num && todaySet.has(num));
}

// بيشيل كل طلبات شركة معينة من الملف المرفوع قبل التوزيع/الرفع لـ Supabase
function deleteCompanyFromCsv(company) {
  const count = parsedCsvData.filter(row => getCsvRowCompany(row) === company).length;
  const confirmDelete = confirm(`هل أنت متأكد من حذف كل طلبات شركة "${company}" (${count} طلب) من الملف؟`);
  if (!confirmDelete) return;

  parsedCsvData = parsedCsvData.filter(row => getCsvRowCompany(row) !== company);
  renderCsvPreview(parsedCsvData);
}

// ============ التوزيع المخصص: تحديد يدوي (مراجع + شركة + عدد) ============
let customDistRules = [];

function populateCustomDistSelects() {
  const reviewerSelect = document.getElementById('custom-dist-reviewer-select');
  if (reviewerSelect && reviewerSelect.options.length <= 1) {
    reviewerSelect.innerHTML = `<option value="">اختر المراجع...</option>` +
      ALL_PROFILES.map(p => `<option value="${p.username}">${p.name}${p.role === 'admin' ? ' (أدمن)' : ''}</option>`).join('');
  }
}

function populateCustomDistCompanySelect(data) {
  const select = document.getElementById('custom-dist-company-select');
  if (!select) return;

  const currentValue = select.value;
  const companies = new Set();
  (data || []).forEach(row => companies.add(getCsvRowCompany(row)));
  const sorted = Array.from(companies).sort((a, b) => a.localeCompare(b, 'ar'));

  select.innerHTML = `<option value="">اختر الشركة...</option>` + sorted.map(c => `<option value="${c}">${c}</option>`).join('');
  if (sorted.includes(currentValue)) select.value = currentValue;
}

function addCustomDistRule() {
  const reviewer = document.getElementById('custom-dist-reviewer-select').value;
  const company = document.getElementById('custom-dist-company-select').value;
  const count = parseInt(document.getElementById('custom-dist-count-input').value, 10);

  if (!reviewer) { alert('اختار المراجع أولاً'); return; }
  if (!company) { alert('اختار الشركة أولاً'); return; }
  if (!count || count <= 0) { alert('اكتب عدد صحيح أكبر من صفر'); return; }

  customDistRules.push({ reviewer, company, count });
  renderCustomDistRulesList();
  document.getElementById('custom-dist-count-input').value = '';
}

function removeCustomDistRule(index) {
  customDistRules.splice(index, 1);
  renderCustomDistRulesList();
}

function renderCustomDistRulesList() {
  const container = document.getElementById('custom-dist-rules-list');
  if (customDistRules.length === 0) {
    container.innerHTML = `<p style="font-size: 12px; color: var(--text-muted);">لسه معملتش أي قاعدة.</p>`;
    return;
  }

  container.innerHTML = '';
  customDistRules.forEach((rule, idx) => {
    const row = document.createElement('div');
    row.style.cssText = 'display:flex; justify-content:space-between; align-items:center; background: var(--card-bg); border:1px solid var(--card-border); padding:6px 10px; border-radius:6px; margin-bottom:6px; font-size:13px;';

    const label = document.createElement('span');
    label.textContent = `${rule.reviewer} ← ${rule.company}: ${rule.count} طلب`;

    const removeBtn = document.createElement('button');
    removeBtn.type = 'button';
    removeBtn.className = 'btn-delete-row';
    removeBtn.innerText = '✕';
    removeBtn.addEventListener('click', () => removeCustomDistRule(idx));

    row.appendChild(label);
    row.appendChild(removeBtn);
    container.appendChild(row);
  });
}

// بيطبّق كل القواعد اللي أضفتها بالترتيب: كل قاعدة بتاخد أول N طلب من الشركة المحددة اللي لسه مالهاش مراجع
function applyCustomDistRules() {
  if (!customDistRules || customDistRules.length === 0) {
    alert('لسه معملتش أي قاعدة توزيع مخصص. ضيف قاعدة الأول من فوق.');
    return;
  }
  if (!parsedCsvData || parsedCsvData.length === 0) {
    alert('برجاء رفع ملف أولاً.');
    return;
  }

  const reviewerColKey = (parsedCsvData[0] && 'المراجع' in parsedCsvData[0]) ? 'المراجع' : 'reviewer';
  const summary = [];

  customDistRules.forEach(rule => {
    const candidates = parsedCsvData.filter(row =>
      getCsvRowCompany(row) === rule.company && !row.reviewer && !row[reviewerColKey]
    );
    const toAssign = candidates.slice(0, rule.count);
    toAssign.forEach(row => {
      row[reviewerColKey] = rule.reviewer;
      row.reviewer = rule.reviewer;
    });
    summary.push({ ...rule, assigned: toAssign.length });
  });

  renderCsvPreview(parsedCsvData);
  renderCustomDistSummary(summary);
}

function renderCustomDistSummary(summary) {
  const container = document.getElementById('custom-dist-summary');
  const rows = summary.map(s => {
    const shortfall = s.count - s.assigned;
    const warning = shortfall > 0
      ? `<span style="color: var(--badge-hold-text);"> (${shortfall} ناقص — مكانش متاح عدد كفاية من هذه الشركة غير موزّع)</span>`
      : '';
    return `<div class="reviewer-stat">
      <div class="reviewer-info"><div class="name">${s.reviewer} ← ${s.company}</div></div>
      <div class="reviewer-counts"><div class="count-accepted">${s.assigned} / ${s.count} طلب</div></div>
    </div>${warning ? `<p style="font-size: 11px; margin: 2px 0 8px;">${warning}</p>` : ''}`;
  }).join('');

  container.innerHTML = `
    <h4 style="font-size: 13px; margin-bottom: 8px; color: var(--text-muted);">ملخص التوزيع المخصص:</h4>
    ${rows}
  `;
}

// قائمة كل المستخدمين (مراجعين + أدمن) بمربعات اختيار للمشاركة في التوزيع المتوازن
// بيحافظ على اختيار المراجعين اللي حددهم المستخدم بنفسه بدل ما يترجع "الكل متحدد" تلقائي في كل مرة
// (كان بيحصل قبل كده كل ما يترفع ملف جديد أو تتحذف شركة، فالاختيار اليدوي كان بيضيع).
let csvDistUserSelection = null;

function populateCsvDistUsersList() {
  const container = document.getElementById('csv-dist-users-list');

  if (!csvDistUserSelection) {
    csvDistUserSelection = new Set(getUsernames()); // أول مرة بس: الكل متحدد افتراضيًا
  }

  container.innerHTML = '';

  ALL_PROFILES.forEach(p => {
    const roleLabel = p.role === 'admin' ? ' (أدمن)' : '';
    const isChecked = csvDistUserSelection.has(p.username) ? 'checked' : '';
    container.innerHTML += `
      <label style="display: flex; align-items: center; gap: 6px; font-size: 13px; background: var(--bg-dark); border: 1px solid var(--card-border); padding: 6px 10px; border-radius: 6px; cursor: pointer;">
        <input type="checkbox" class="csv-dist-user-checkbox" value="${p.username}" ${isChecked} onchange="onCsvDistUserToggle(this)">
        ${p.name}${roleLabel}
      </label>
    `;
  });
}

function onCsvDistUserToggle(checkbox) {
  if (!csvDistUserSelection) csvDistUserSelection = new Set(getUsernames());
  if (checkbox.checked) csvDistUserSelection.add(checkbox.value);
  else csvDistUserSelection.delete(checkbox.value);
}

function selectAllCsvDistUsers(checked) {
  document.querySelectorAll('.csv-dist-user-checkbox').forEach(cb => { cb.checked = checked; });
  csvDistUserSelection = new Set(checked ? getUsernames() : []);
}

// توزيع متوازن: كل الطلبات بيتم خلطها بالتبادل بين الشركات أولاً (عشان كل مراجع ياخد خليط من كل الشركات)،
// بعدين بتتوزع بالتساوي (Round-robin) على المراجعين المختارين، مع وقف عند التارجت لو محدد.
function runBalancedCsvDistribution() {
  if (!parsedCsvData || parsedCsvData.length === 0) {
    alert('برجاء رفع ملف CSV أولاً.');
    return;
  }

  const selectedUsers = Array.from(document.querySelectorAll('.csv-dist-user-checkbox:checked')).map(cb => cb.value);
  if (selectedUsers.length === 0) {
    alert('برجاء اختيار مراجع واحد على الأقل للتوزيع.');
    return;
  }

  const targetInput = document.getElementById('csv-dist-target-input');
  const targetPerPerson = parseInt(targetInput.value, 10) || 0; // 0 = بدون تارجت، توزيع متساوي بس

  const getCompany = getCsvRowCompany;
  const pools = {};
  const poolOrder = [];
  parsedCsvData.forEach(row => {
    const company = getCompany(row);
    if (!pools[company]) { pools[company] = []; poolOrder.push(company); }
    pools[company].push(row);
  });

  // تشبيك الطلبات بالتبادل بين الشركات (Round-robin)، وبرضو بين حالات المراجعة المختلفة
  // (زي "تم المراجعة" و"جاري المراجعة") لو موجود أكتر من حالة جوه نفس الشركة، عشان كل مراجع
  // ياخد خليط متوازن مش بس من الشركات لكن من الحالات كمان.
  const companyStatusPools = {};
  parsedCsvData.forEach(row => {
    const company = getCompany(row);
    const statusKey = row.status || row['الحالة'] || row['حالة المراجعة'] || 'غير محدد';
    if (!companyStatusPools[company]) companyStatusPools[company] = {};
    if (!companyStatusPools[company][statusKey]) companyStatusPools[company][statusKey] = [];
    companyStatusPools[company][statusKey].push(row);
  });

  const interleaved = [];
  let stillHasMore = true;
  while (stillHasMore) {
    stillHasMore = false;
    for (const company of poolOrder) {
      const statusKeys = Object.keys(companyStatusPools[company] || {});
      for (const statusKey of statusKeys) {
        const statusPool = companyStatusPools[company][statusKey];
        if (statusPool.length > 0) {
          interleaved.push(statusPool.shift());
          stillHasMore = true;
        }
      }
    }
  }

  const reviewerColKey = (interleaved[0] && 'المراجع' in interleaved[0]) ? 'المراجع' : 'reviewer';
  const counts = {};
  selectedUsers.forEach(u => counts[u] = 0);

  let userIndex = 0;
  let assignedCount = 0;

  for (const row of interleaved) {
    if (targetPerPerson > 0 && selectedUsers.every(u => counts[u] >= targetPerPerson)) break;

    let attempts = 0;
    while (targetPerPerson > 0 && counts[selectedUsers[userIndex]] >= targetPerPerson && attempts < selectedUsers.length) {
      userIndex = (userIndex + 1) % selectedUsers.length;
      attempts++;
    }
    if (targetPerPerson > 0 && attempts >= selectedUsers.length) break;

    const user = selectedUsers[userIndex];
    row[reviewerColKey] = user;
    row.reviewer = user; // نتأكد إن العمود القياسي "reviewer" اتحدّث دايمًا (هو اللي بيتبعت فعليًا لـ Supabase)
    counts[user]++;
    assignedCount++;
    userIndex = (userIndex + 1) % selectedUsers.length;
  }

  renderCsvPreview(parsedCsvData);
  renderCsvDistSummary(counts, parsedCsvData.length - assignedCount);
}

function renderCsvDistSummary(counts, leftoverCount) {
  const container = document.getElementById('csv-dist-summary');
  const rows = Object.keys(counts).map(name => `
    <div class="reviewer-stat">
      <div class="reviewer-info"><div class="name">${name}</div></div>
      <div class="reviewer-counts"><div class="count-accepted">${counts[name]} طلب</div></div>
    </div>
  `).join('');

  const leftoverHtml = leftoverCount > 0
    ? `<p style="font-size: 12px; color: var(--badge-hold-text); margin-top: 10px;">⚠️ ${leftoverCount} طلب لم يتم توزيعه، لأن كل المراجعين المختارين وصلوا للعدد المستهدف. زوّد التارجت أو اختار مراجعين إضافيين.</p>`
    : '';

  container.innerHTML = `
    <h4 style="font-size: 13px; margin-bottom: 8px; color: var(--text-muted);">ملخص التوزيع:</h4>
    ${rows}
    ${leftoverHtml}
  `;
}

// الأعمدة الفعلية الموجودة في جدول system_review1 على Supabase.
// أي عمود تاني (زي أسماء الأعمدة العربية الأصلية من ملف الإكسيل "الشركة"، "رقم الطلب"...)
// بيتشال قبل الرفع عشان محتترفضش العملية بسبب "column not found in schema cache".
const ALLOWED_ORDER_COLUMNS = ['id', 'order_number', 'company', 'reviewer', 'date', 'status', 'review_status', 'rejection_reason'];

async function uploadCsvToSupabase() {
  if (parsedCsvData.length === 0) return;

  const assignedOnly = document.getElementById('csv-upload-assigned-only-checkbox').checked;
  const dataToUpload = assignedOnly
    ? parsedCsvData.filter(row => row.reviewer || row['المراجع'])
    : parsedCsvData;

  if (dataToUpload.length === 0) {
    alert('لا توجد أي طلبات تم توزيعها على مراجع لرفعها. لو عايز ترفع كل الطلبات (حتى الغير موزّعة)، شيل علامة الصح من "رفع الطلبات الموزّعة فقط".');
    return;
  }

  const btn = document.getElementById('btn-upload-supabase');
  btn.innerText = 'جاري الرفع...'; btn.disabled = true;

  try {
    const cleanData = dataToUpload.map(row => {
      const newRow = {};
      ALLOWED_ORDER_COLUMNS.forEach(key => {
        if (row[key] !== undefined && row[key] !== '') newRow[key] = row[key];
      });
      if (newRow.id === "" || newRow.id === undefined || newRow.id === null) delete newRow.id;
      return newRow;
    });

    const error = await runBatchedUpsert(TABLE_NAME, cleanData);
    if (error) { alert('خطأ أثناء الرفع: ' + error.message); } 
    else {
      const skippedCount = parsedCsvData.length - dataToUpload.length;
      const skippedMsg = skippedCount > 0 ? `\n(${skippedCount} طلب اتشال لأنه لسه من غير مراجع ومترفعش)` : '';
      alert(`تم رفع وتوزيع ${dataToUpload.length} طلب بنجاح!${skippedMsg}`);
      await loadData();
      switchTab('dashboard');
    }
  } catch (err) { alert('خطأ: ' + err.message); } 
  finally { btn.innerText = 'تأكيد وتوزيع الطلبات لـ Supabase'; btn.disabled = false; }
}

function openEditModal(orderNum) {
  selectedOrder = window.allData.find(o => String(o.order_number || o.order_no || o['رقم الطلب']) === String(orderNum));
  if (!selectedOrder) return;

  // تقييد الصلاحيات: المراجع (غير الأدمن) يقدر ياخد إجراء بس على طلباته هو
  if (currentUser && currentUser.role !== 'admin') {
    const reviewerName = selectedOrder.reviewer || selectedOrder['المراجع'] || '';
    const isOwnOrder = (reviewerName === currentUser.username || reviewerName === currentUser.name);
    if (!isOwnOrder) {
      alert('غير مسموح لك بمراجعة هذا الطلب، لأنه غير مخصص لك.');
      selectedOrder = null;
      return;
    }
  }

  document.getElementById('modal-order-no').value = orderNum;
  const currentStatus = selectedOrder.review_status || selectedOrder['حالة المراجعة'] || 'مقبول';
  document.getElementById('modal-review-status').value = ['مقبول', 'مرفوض', 'معلق'].includes(currentStatus) ? currentStatus : 'مقبول';
  document.getElementById('modal-rejection-reason').value = selectedOrder.rejection_reason || selectedOrder.reason || selectedOrder['سبب الرفض'] || '';

  document.getElementById('edit-modal').style.display = 'flex';
  toggleRejectionField();
}

function closeModal() { document.getElementById('edit-modal').style.display = 'none'; selectedOrder = null; }
function toggleRejectionField() {
  const status = document.getElementById('modal-review-status').value;
  document.getElementById('rejection-reason-group').style.display = (status === 'مرفوض') ? 'block' : 'none';
}

async function saveOrderUpdate() {
  if (!selectedOrder) return;

  // تقييد الصلاحيات: تأكيد إضافي إن المراجع مش بيحفظ قرار على طلب مش بتاعه
  if (currentUser && currentUser.role !== 'admin') {
    const reviewerName = selectedOrder.reviewer || selectedOrder['المراجع'] || '';
    const isOwnOrder = (reviewerName === currentUser.username || reviewerName === currentUser.name);
    if (!isOwnOrder) {
      alert('غير مسموح لك بحفظ قرار على هذا الطلب، لأنه غير مخصص لك.');
      closeModal();
      return;
    }
  }

  const newReviewStatus = document.getElementById('modal-review-status').value;
  const newRejectionReason = document.getElementById('modal-rejection-reason').value.trim();

  if (newReviewStatus === 'مرفوض' && !newRejectionReason) {
    alert('يرجى كتابة سبب الرفض');
    return;
  }

  const saveBtn = document.getElementById('btn-save-modal');
  saveBtn.innerText = 'جاري الحفظ...'; saveBtn.disabled = true;

  let matchColumn = selectedOrder.id !== undefined ? 'id' : (selectedOrder['رقم الطلب'] !== undefined ? 'رقم الطلب' : 'order_number');
  let matchValue = selectedOrder[matchColumn];

  const updateData = {};
  const finalReason = (newReviewStatus === 'مرفوض') ? newRejectionReason : '-';

  if ('review_status' in selectedOrder) updateData.review_status = newReviewStatus;
  if ('حالة المراجعة' in selectedOrder) updateData['حالة المراجعة'] = newReviewStatus;
  if ('rejection_reason' in selectedOrder) updateData.rejection_reason = finalReason;
  if ('سبب الرفض' in selectedOrder) updateData['سبب الرفض'] = finalReason;

  try {
    const { error } = await supabaseClient.from(TABLE_NAME).update(updateData).eq(matchColumn, matchValue);
    if (error) alert('فشل التحديث: ' + error.message);
    else {
      Object.assign(selectedOrder, updateData);
      updateKPIs(window.allData);
      renderReviewersStats(window.visibleData);
      renderCurrentPage();
      closeModal();
    }
  } catch (err) { alert('خطأ: ' + err.message); }
  finally { saveBtn.innerText = 'حفظ القرار'; saveBtn.disabled = false; }
}

function updateKPIs(data) {
  document.getElementById('stat-total').innerText = data.length.toLocaleString('ar-EG');
  const accepted = data.filter(o => (o.review_status || o['حالة المراجعة']) === 'مقبول').length;
  const rejected = data.filter(o => (o.review_status || o['حالة المراجعة']) === 'مرفوض').length;
  // "لم يتم المراجعة" = كل حاجة مش مقبول ومش مرفوض (يشمل "معلق" والفاضي)، عشان الإجمالي يفضل دايمًا
  // بيساوي بالظبط "تم المراجعة" + "لم يتم المراجعة" من غير ما تضيع أي طلبات في المنتصف.
  const pending = data.length - accepted - rejected;

  document.getElementById('stat-accepted').innerText = accepted.toLocaleString('ar-EG');
  document.getElementById('stat-rejected').innerText = rejected.toLocaleString('ar-EG');
  document.getElementById('stat-reviewed').innerText = (accepted + rejected).toLocaleString('ar-EG');
  document.getElementById('stat-pending').innerText = pending.toLocaleString('ar-EG');
}

function renderReviewersStats(data) {
  const stats = {};
  data.forEach(o => {
    const name = o.reviewer || o['المراجع'];
    if (!name) return;
    const revStatus = o.review_status || o['حالة المراجعة'];
    if (!stats[name]) stats[name] = { total: 0, accepted: 0, rejected: 0 };
    stats[name].total++;
    if (revStatus === 'مقبول') stats[name].accepted++;
    if (revStatus === 'مرفوض') stats[name].rejected++;
  });

  const container = document.getElementById('reviewers-list');
  container.innerHTML = '';
  const keys = Object.keys(stats);
  if (keys.length === 0) {
    container.innerHTML = '<p style="font-size:12px; color:var(--text-muted);">لا يوجد مراجعين</p>';
    return;
  }

  keys.forEach(name => {
    const item = stats[name];
    container.innerHTML += `
      <div class="reviewer-stat">
        <div class="reviewer-info">
          <div class="name">${name}</div>
          <div class="total">${item.total} طلب</div>
        </div>
        <div class="reviewer-counts">
          <div class="count-accepted">مقبول: ${item.accepted}</div>
          <div class="count-rejected">مرفوض: ${item.rejected}</div>
        </div>
      </div>
    `;
  });
}

function renderCompanyStats(data) {
  const stats = {};
  data.forEach(o => {
    const name = o.company || o['الشركة'];
    if (!name) return;
    const revStatus = o.review_status || o['حالة المراجعة'];
    if (!stats[name]) stats[name] = { total: 0, accepted: 0, rejected: 0 };
    stats[name].total++;
    if (revStatus === 'مقبول') stats[name].accepted++;
    if (revStatus === 'مرفوض') stats[name].rejected++;
  });

  const container = document.getElementById('companies-list');
  container.innerHTML = '';
  const keys = Object.keys(stats).sort((a, b) => stats[b].total - stats[a].total);
  if (keys.length === 0) {
    container.innerHTML = '<p style="font-size:12px; color:var(--text-muted);">لا يوجد شركات</p>';
    return;
  }

  keys.forEach(name => {
    const item = stats[name];
    container.innerHTML += `
      <div class="reviewer-stat">
        <div class="reviewer-info">
          <div class="name">${name}</div>
          <div class="total">${item.total} طلب</div>
        </div>
        <div class="reviewer-counts">
          <div class="count-accepted">مقبول: ${item.accepted}</div>
          <div class="count-rejected">مرفوض: ${item.rejected}</div>
        </div>
      </div>
    `;
  });
}

// ============ تصدير Excel (للأدمن فقط) ============
function exportTodayOrdersToExcel() {
  if (!window.allData || window.allData.length === 0) {
    alert('لا يوجد طلبات لتصديرها في التاريخ المحدد حاليًا.');
    return;
  }

  const dateLabel = document.getElementById('date-filter').value || 'غير محدد';

  const rows = window.allData.map(order => {
    const orderNum = order.order_number || order.order_no || order['رقم الطلب'] || '-';
    const company = order.company || order['الشركة'] || '-';
    const reviewer = order.reviewer || order['المراجع'] || '-';
    const progressStatus = order.status || order['الحالة'] || '-';
    const reviewStatus = order.review_status || order['حالة المراجعة'] || 'لم يتم المراجعة';
    const date = order.date || extractDateString(order) || '-';
    const rejectionReason = order.rejection_reason || order.reason || order['سبب الرفض'] || '-';

    return {
      'رقم الطلب': orderNum,
      'الشركة': company,
      'المراجع': reviewer,
      'حالة المراجعة': progressStatus,
      'المراجعة': reviewStatus,
      'التاريخ': date,
      'سبب الرفض': rejectionReason
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [
    { wch: 24 }, { wch: 22 }, { wch: 16 }, { wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 30 }
  ];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'طلبات اليوم');
  XLSX.writeFile(workbook, `طلبات_${dateLabel}.xlsx`);
}

function exportReviewerStatsToExcel() {
  if (!window.allData || window.allData.length === 0) {
    alert('لا يوجد بيانات لتصدير إحصائيات المراجعين منها.');
    return;
  }

  const dateLabel = document.getElementById('date-filter').value || 'غير محدد';

  const stats = {};
  window.allData.forEach(o => {
    const name = o.reviewer || o['المراجع'];
    if (!name) return;
    const revStatus = o.review_status || o['حالة المراجعة'];
    if (!stats[name]) stats[name] = { total: 0, accepted: 0, rejected: 0, pending: 0 };
    stats[name].total++;
    if (revStatus === 'مقبول') stats[name].accepted++;
    else if (revStatus === 'مرفوض') stats[name].rejected++;
    else stats[name].pending++;
  });

  const rows = Object.keys(stats).map(name => ({
    'المراجع': name,
    'إجمالي الطلبات': stats[name].total,
    'مقبول': stats[name].accepted,
    'مرفوض': stats[name].rejected,
    'لم يتم المراجعة': stats[name].pending
  }));

  if (rows.length === 0) {
    alert('لا يوجد مراجعين لتصدير إحصائياتهم.');
    return;
  }

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 16 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'إحصائيات المراجعين');
  XLSX.writeFile(workbook, `إحصائيات_المراجعين_${dateLabel}.xlsx`);
}

function exportCompanyStatsToExcel() {
  if (!window.allData || window.allData.length === 0) {
    alert('لا يوجد بيانات لتصدير إحصائيات الشركات منها.');
    return;
  }

  const dateLabel = document.getElementById('date-filter').value || 'غير محدد';

  const stats = {};
  window.allData.forEach(o => {
    const name = o.company || o['الشركة'];
    if (!name) return;
    const revStatus = o.review_status || o['حالة المراجعة'];
    if (!stats[name]) stats[name] = { total: 0, accepted: 0, rejected: 0, pending: 0 };
    stats[name].total++;
    if (revStatus === 'مقبول') stats[name].accepted++;
    else if (revStatus === 'مرفوض') stats[name].rejected++;
    else stats[name].pending++;
  });

  const rows = Object.keys(stats)
    .sort((a, b) => stats[b].total - stats[a].total)
    .map(name => ({
      'الشركة': name,
      'إجمالي الطلبات': stats[name].total,
      'مقبول': stats[name].accepted,
      'مرفوض': stats[name].rejected,
      'لم يتم المراجعة': stats[name].pending
    }));

  if (rows.length === 0) {
    alert('لا يوجد شركات لتصدير إحصائياتها.');
    return;
  }

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 26 }, { wch: 16 }, { wch: 12 }, { wch: 12 }, { wch: 16 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'إحصائيات الشركات');
  XLSX.writeFile(workbook, `إحصائيات_الشركات_${dateLabel}.xlsx`);
}

function updatePaginationControls(from, to) {
  document.getElementById('page-num').innerText = `صفحة ${currentPage}`;
  if (totalRecordsCount === 0) {
    document.getElementById('pagination-info').innerText = '0 من 0';
    document.getElementById('btn-prev').disabled = true;
    document.getElementById('btn-next').disabled = true;
    return;
  }
  document.getElementById('pagination-info').innerText = `عرض ${from} إلى ${to} من أصل ${totalRecordsCount.toLocaleString('ar-EG')}`;
  document.getElementById('btn-prev').disabled = (currentPage === 1);
  document.getElementById('btn-next').disabled = (to >= totalRecordsCount);
}

function changePage(direction) { currentPage += direction; renderCurrentPage(); }

// ============ تاب طباعة الشهادات (أدمن فقط) ============
async function loadCertificatesData() {
  document.getElementById('cert-tbody').innerHTML = `<tr><td colspan="8" style="text-align: center;">جاري الاتصال بـ Supabase...</td></tr>`;
  try {
    let allFetched = [];
    let from = 0, step = 1000, hasMore = true;

    while (hasMore) {
      const { data, error } = await supabaseClient.from(CERT_TABLE_NAME).select('*').range(from, from + step - 1);
      if (error) throw error;

      if (data && data.length > 0) {
        allFetched = allFetched.concat(data);
        from += step;
        if (data.length < step) hasMore = false;
      } else { hasMore = false; }
    }

    certMasterData = allFetched;
    certDataLoaded = true;
    populateCertLayoutFilter();
    applyCertDateFiltering();
  } catch (err) {
    document.getElementById('cert-tbody').innerHTML = `<tr><td colspan="8" style="text-align: center; color: #f87171;">فشل تحميل البيانات: ${err.message}</td></tr>`;
  }
}

function populateCertLayoutFilter() {
  const filterSelect = document.getElementById('cert-layout-filter');
  const modalSelect = document.getElementById('cert-modal-layout');
  const bulkReassignSelect = document.getElementById('cert-bulk-reassign-select');

  filterSelect.innerHTML = `<option value="ALL">كل المسؤولين</option><option value="UNASSIGNED">⛔ غير موزّع</option>`;
  modalSelect.innerHTML = '';
  bulkReassignSelect.innerHTML = `<option value="">توزيع على المسؤول...</option>`;

  ALL_PROFILES.filter(p => p.role === 'admin').forEach(p => {
    filterSelect.innerHTML += `<option value="${p.username}">${p.name}</option>`;
    modalSelect.innerHTML += `<option value="${p.username}">${p.name}</option>`;
    bulkReassignSelect.innerHTML += `<option value="${p.username}">${p.name}</option>`;
  });
}

function applyCertDateFiltering() {
  if (!certMasterData || certMasterData.length === 0) {
    certAllData = [];
    renderCertKpis([]);
    renderCertPage();
    document.getElementById('cert-active-date-label').innerText = 'لا يوجد بيانات';
    return;
  }

  const dateInput = document.getElementById('cert-date-filter').value;
  let targetDate = dateInput;

  if (!targetDate) {
    const dates = certMasterData.map(extractDateString).filter(Boolean).sort().reverse();
    targetDate = dates[0] || '';
    if (targetDate) document.getElementById('cert-date-filter').value = targetDate;
  }

  certAllData = certMasterData.filter(item => {
    const d = extractDateString(item);
    return d === targetDate || !d;
  });
  document.getElementById('cert-active-date-label').innerText = `يعرض شهادات تاريخ: ${targetDate} (+ الطلبات بدون تاريخ)`;

  certTotalRecordsCount = certAllData.length;
  renderCertKpis(certAllData);
  renderCertPage();
}

function onCertDateFilterChange() { certCurrentPage = 1; selectedCertOrderNumbers.clear(); updateCertSelectedCount(); applyCertDateFiltering(); }
function resetCertDateToLatest() { document.getElementById('cert-date-filter').value = ''; selectedCertOrderNumbers.clear(); updateCertSelectedCount(); applyCertDateFiltering(); }

function renderCertKpis(data) {
  const total = data.length;
  const printed = data.filter(o => (o.status || '') === 'تم الطباعة').length;
  const rejected = data.filter(o => (o.status || '') === 'مرفوض').length;
  const pending = data.filter(o => (o.status || '') === 'معلق').length;

  document.getElementById('cert-stat-total').innerText = total;
  document.getElementById('cert-stat-printed').innerText = printed;
  document.getElementById('cert-stat-rejected').innerText = rejected;
  document.getElementById('cert-stat-pending').innerText = pending;
}

function renderCertPage() {
  if (!certAllData) return;

  const searchValue = document.getElementById('cert-search-input').value.trim().toLowerCase();
  const statusValue = document.getElementById('cert-status-filter').value;
  const layoutValue = document.getElementById('cert-layout-filter').value;

  let filtered = certAllData.filter(item => {
    const orderNum = String(item.order_number || '').toLowerCase();
    const matchesSearch = !searchValue || orderNum.includes(searchValue);
    const status = item.status || '';
    const matchesStatus = (statusValue === 'ALL') || (statusValue === 'UNPRINTED' ? !status : (status === statusValue));
    const layout = item.Layout || item.layout || '';
    const matchesLayout = (layoutValue === 'ALL') || (layoutValue === 'UNASSIGNED' ? !layout : (layout === layoutValue));
    return matchesSearch && matchesStatus && matchesLayout;
  });

  certTotalRecordsCount = filtered.length;
  const from = (certCurrentPage - 1) * certPageSize;
  const to = from + certPageSize;

  window.certFilteredData = filtered;
  renderCertTable(filtered.slice(from, to));
  updateCertPaginationControls(from + 1, Math.min(to, certTotalRecordsCount));
}

function renderCertTable(orders) {
  const tbody = document.getElementById('cert-tbody');
  tbody.innerHTML = '';

  if (orders.length === 0) {
    tbody.innerHTML = `<tr><td colspan="8" style="text-align:center;">لا توجد نتائج مطابقة</td></tr>`;
    return;
  }

  orders.forEach(order => {
    const orderNum = order.order_number || '-';
    const rawLayout = order.Layout || order.layout || '';
    const layout = rawLayout || 'غير موزعة';
    const rawStatus = order.status || '';
    const status = rawStatus || 'لم يتم الطباعة';
    const rawDate = order.date || extractDateString(order) || '';
    const date = rawDate || 'غير محدد';
    const reason = order.reason || '-';

    let badgeClass = 'badge-unreviewed';
    if (status === 'تم الطباعة') badgeClass = 'badge-accepted';
    else if (status === 'تم إعادة الطباعة') badgeClass = 'badge-reprint';
    else if (status === 'مرفوض') badgeClass = 'badge-rejected';
    else if (status === 'محجوز') badgeClass = 'badge-hold';
    else if (status === 'خطأ جهة ولاية' || status === 'خطأ عنوان') badgeClass = 'badge-error';

    const layoutClass = rawLayout ? '' : 'style="color: var(--text-muted);"';
    const dateClass = rawDate ? '' : 'style="color: var(--text-muted);"';

    const isChecked = selectedCertOrderNumbers.has(orderNum) ? 'checked' : '';

    tbody.innerHTML += `
      <tr>
        <td style="text-align:center;"><input type="checkbox" class="cert-row-checkbox" data-ordernum="${orderNum}" ${isChecked} onchange="toggleCertRowSelect(this, '${orderNum}')"></td>
        <td class="sticky-action-col"><button class="btn btn-open" onclick="openCertEditModal('${orderNum}')">تحديث</button></td>
        <td class="sticky-action-col"><button class="btn-delete-row" onclick="deleteSingleCertOrder('${orderNum}')">🗑️ مسح</button></td>
        <td class="order-no-cell">${orderNum}</td>
        <td ${layoutClass}>${layout}</td>
        <td><span class="badge ${badgeClass}">${status}</span></td>
        <td ${dateClass}>${date}</td>
        <td>${reason}</td>
      </tr>`;
  });

  const selectAllCb = document.getElementById('cert-select-all-checkbox');
  if (selectAllCb) {
    const allCurrentChecked = orders.length > 0 && orders.every(o => selectedCertOrderNumbers.has(o.order_number));
    selectAllCb.checked = allCurrentChecked;
  }
}

function updateCertPaginationControls(from, to) {
  if (certTotalRecordsCount === 0) {
    document.getElementById('cert-pagination-info').innerText = 'لا توجد نتائج';
    document.getElementById('cert-btn-prev').disabled = true;
    document.getElementById('cert-btn-next').disabled = true;
    return;
  }
  document.getElementById('cert-pagination-info').innerText = `عرض ${from} إلى ${to} من أصل ${certTotalRecordsCount.toLocaleString('ar-EG')}`;
  document.getElementById('cert-page-num').innerText = `صفحة ${certCurrentPage}`;
  document.getElementById('cert-btn-prev').disabled = (certCurrentPage === 1);
  document.getElementById('cert-btn-next').disabled = (to >= certTotalRecordsCount);
}

function changeCertPage(direction) { certCurrentPage += direction; renderCertPage(); }

// ============ التحديد الجماعي وتوزيع/حذف طلبات الشهادات ============
function toggleCertRowSelect(cb, orderNum) {
  if (cb.checked) { selectedCertOrderNumbers.add(orderNum); }
  else { selectedCertOrderNumbers.delete(orderNum); }
  updateCertSelectedCount();
}

function toggleCertSelectAll(masterCb) {
  if (!window.certFilteredData) return;
  window.certFilteredData.forEach(o => {
    const orderNum = o.order_number;
    if (masterCb.checked) { selectedCertOrderNumbers.add(orderNum); }
    else { selectedCertOrderNumbers.delete(orderNum); }
  });
  document.querySelectorAll('.cert-row-checkbox').forEach(cb => cb.checked = masterCb.checked);
  updateCertSelectedCount();
}

function updateCertSelectedCount() {
  const countEl = document.getElementById('cert-selected-count');
  if (countEl) countEl.innerText = selectedCertOrderNumbers.size;
}

// تحديد أول N طلب "غير موزّع" (لسه معندوش مسؤول) ضمن الفلتر الحالي، بدون التكرار على المحدد بالفعل
function selectNextCertBatch() {
  const input = document.getElementById('cert-bulk-count-input');
  const count = parseInt(input.value, 10);

  if (!count || count <= 0) { alert('برجاء إدخال عدد صحيح أكبر من صفر'); return; }
  if (!window.certFilteredData || window.certFilteredData.length === 0) { alert('لا توجد بيانات لتحديدها ضمن الفلتر الحالي'); return; }

  const unassigned = window.certFilteredData.filter(o => {
    const layout = o.Layout || o.layout || '';
    return !layout && !selectedCertOrderNumbers.has(o.order_number);
  });

  if (unassigned.length === 0) { alert('لا توجد طلبات غير موزّعة متاحة للتحديد ضمن الفلتر الحالي'); return; }

  const batch = unassigned.slice(0, count);
  batch.forEach(o => selectedCertOrderNumbers.add(o.order_number));

  updateCertSelectedCount();
  renderCertPage();
  input.value = '';

  if (batch.length < count) {
    alert(`تم تحديد ${batch.length} طلب فقط (هذا كل المتاح غير الموزّع ضمن الفلتر الحالي)`);
  }
}

function clearCertSelection() {
  selectedCertOrderNumbers.clear();
  updateCertSelectedCount();
  renderCertPage();
}

// تحديد أول N طلب من نتائج الفلتر الحالي (بغض النظر عن كونه موزّع أو لا) — مفيد لو أنت
// فلترت بالفعل على اسمك في "المسؤول" وعايز تصدّر أرقام طلباتك على دفعات (مثلاً 100 في كل مرة)
function selectNextCertFromFiltered() {
  const input = document.getElementById('cert-export-count-input');
  const count = parseInt(input.value, 10);

  if (!count || count <= 0) { alert('برجاء إدخال عدد صحيح أكبر من صفر'); return; }
  if (!window.certFilteredData || window.certFilteredData.length === 0) { alert('لا توجد بيانات لتحديدها ضمن الفلتر الحالي'); return; }

  const unselected = window.certFilteredData.filter(o => !selectedCertOrderNumbers.has(o.order_number));

  if (unselected.length === 0) { alert('كل الطلبات المطابقة للفلتر الحالي متحددة بالفعل'); return; }

  const batch = unselected.slice(0, count);
  batch.forEach(o => selectedCertOrderNumbers.add(o.order_number));

  updateCertSelectedCount();
  renderCertPage();
  input.value = '';

  if (batch.length < count) {
    alert(`تم تحديد ${batch.length} طلب فقط (هذا كل المتاح ضمن الفلتر الحالي)`);
  }
}

// تصدير أرقام الطلبات المحددة فقط (بدون باقي الأعمدة) لملف Excel
function exportSelectedCertOrderNumbers() {
  if (selectedCertOrderNumbers.size === 0) { alert('برجاء تحديد طلب واحد على الأقل للتصدير'); return; }

  const orderNumbers = Array.from(selectedCertOrderNumbers);
  const rows = orderNumbers.map(num => ({ 'رقم الطلب': num }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 28 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'أرقام الطلبات');

  const layoutFilterValue = document.getElementById('cert-layout-filter').value;
  const nameLabel = (layoutFilterValue && layoutFilterValue !== 'ALL' && layoutFilterValue !== 'UNASSIGNED') ? `_${layoutFilterValue}` : '';
  const dateLabel = document.getElementById('cert-date-filter').value || 'غير محدد';

  XLSX.writeFile(workbook, `ارقام_الطلبات${nameLabel}_${dateLabel}.xlsx`);
}

async function executeCertBulkReassign() {
  const newLayout = document.getElementById('cert-bulk-reassign-select').value;
  if (!newLayout) { alert('برجاء اختيار المسؤول من القائمة'); return; }
  if (selectedCertOrderNumbers.size === 0) { alert('برجاء تحديد طلب واحد على الأقل للتوزيع'); return; }

  const confirmChange = confirm(`هل أنت تأكد من توزيع (${selectedCertOrderNumbers.size}) طلب على المسؤول "${newLayout}"؟`);
  if (!confirmChange) return;

  const targetOrders = certAllData.filter(o => selectedCertOrderNumbers.has(o.order_number));
  if (targetOrders.length === 0) return;
  const matchValues = targetOrders.map(o => o.id);

  try {
    const error = await runBatchedSupabaseAction(CERT_TABLE_NAME, 'id', matchValues, 'update', { Layout: newLayout });
    if (error) { alert('حدث خطأ أثناء توزيع الطلبات: ' + error.message); }
    else {
      alert(`تم توزيع ${selectedCertOrderNumbers.size} طلب بنجاح على "${newLayout}"!`);
      targetOrders.forEach(o => { o.Layout = newLayout; o.layout = newLayout; });
      selectedCertOrderNumbers.clear();
      updateCertSelectedCount();
      applyCertDateFiltering();
    }
  } catch (err) { alert('خطأ: ' + err.message); }
}

async function executeCertBulkDateUpdate() {
  const newDate = document.getElementById('cert-bulk-date-input').value;
  if (!newDate) { alert('برجاء اختيار التاريخ أولاً'); return; }
  if (selectedCertOrderNumbers.size === 0) { alert('برجاء تحديد طلب واحد على الأقل'); return; }

  const confirmChange = confirm(`هل أنت تأكد من تحديث تاريخ (${selectedCertOrderNumbers.size}) طلب إلى "${newDate}"؟`);
  if (!confirmChange) return;

  const targetOrders = certAllData.filter(o => selectedCertOrderNumbers.has(o.order_number));
  if (targetOrders.length === 0) return;
  const matchValues = targetOrders.map(o => o.id);

  try {
    const error = await runBatchedSupabaseAction(CERT_TABLE_NAME, 'id', matchValues, 'update', { date: newDate });
    if (error) { alert('حدث خطأ أثناء تحديث التاريخ: ' + error.message); }
    else {
      alert(`تم تحديث تاريخ ${selectedCertOrderNumbers.size} طلب بنجاح إلى "${newDate}"!`);
      targetOrders.forEach(o => { o.date = newDate; });
      selectedCertOrderNumbers.clear();
      updateCertSelectedCount();
      applyCertDateFiltering();
    }
  } catch (err) { alert('خطأ: ' + err.message); }
}

async function executeCertBulkStatusUpdate() {
  const newStatus = document.getElementById('cert-bulk-status-select').value;
  if (!newStatus) { alert('برجاء اختيار الحالة من القائمة'); return; }
  if (selectedCertOrderNumbers.size === 0) { alert('برجاء تحديد طلب واحد على الأقل لتغيير حالته'); return; }

  let reason = '-';
  if (CERT_REASON_REQUIRED_STATUSES.includes(newStatus)) {
    const enteredReason = prompt(`اكتب السبب اللي هيتسجل مع كل الـ (${selectedCertOrderNumbers.size}) طلب المحدد لحالة "${newStatus}":`);
    if (enteredReason === null) return; // ألغى المستخدم العملية
    if (!enteredReason.trim()) { alert('السبب مطلوب لهذه الحالة'); return; }
    reason = enteredReason.trim();
  }

  const confirmChange = confirm(`هل أنت متأكد من تغيير حالة (${selectedCertOrderNumbers.size}) طلب إلى "${newStatus}"؟`);
  if (!confirmChange) return;

  const targetOrders = certAllData.filter(o => selectedCertOrderNumbers.has(o.order_number));
  if (targetOrders.length === 0) return;
  const matchValues = targetOrders.map(o => o.id);

  const updateData = { status: newStatus, reason: reason };

  try {
    const error = await runBatchedSupabaseAction(CERT_TABLE_NAME, 'id', matchValues, 'update', updateData);
    if (error) { alert('حدث خطأ أثناء تغيير الحالة: ' + error.message); }
    else {
      alert(`تم تغيير حالة ${selectedCertOrderNumbers.size} طلب بنجاح إلى "${newStatus}"!`);
      targetOrders.forEach(o => { o.status = newStatus; o.reason = reason; });
      selectedCertOrderNumbers.clear();
      updateCertSelectedCount();
      applyCertDateFiltering();
    }
  } catch (err) { alert('خطأ: ' + err.message); }
}

async function executeCertBulkDelete() {
  if (selectedCertOrderNumbers.size === 0) { alert('برجاء تحديد طلب واحد على الأقل للحذف'); return; }
  const confirmDelete = confirm(`هل أنت تأكد من رغبتك في حذف (${selectedCertOrderNumbers.size}) طلب محدد نهائياً؟`);
  if (!confirmDelete) return;

  const targetOrders = certAllData.filter(o => selectedCertOrderNumbers.has(o.order_number));
  if (targetOrders.length === 0) return;
  const matchValues = targetOrders.map(o => o.id);

  try {
    const error = await runBatchedSupabaseAction(CERT_TABLE_NAME, 'id', matchValues, 'delete');
    if (error) { alert('حدث خطأ أثناء الحذف الجماعي: ' + error.message); }
    else {
      alert(`تم حذف ${selectedCertOrderNumbers.size} طلب بنجاح!`);
      certMasterData = certMasterData.filter(o => !selectedCertOrderNumbers.has(o.order_number));
      selectedCertOrderNumbers.clear();
      updateCertSelectedCount();
      applyCertDateFiltering();
    }
  } catch (err) { alert('خطأ: ' + err.message); }
}

async function deleteSingleCertOrder(orderNum) {
  if (!currentUser || currentUser.role !== 'admin') { alert('هذا الإجراء متاح للأدمن فقط'); return; }
  const confirmDelete = confirm(`هل أنت تأكد من رغبتك في حذف الطلب رقم (${orderNum}) نهائياً؟`);
  if (!confirmDelete) return;

  const targetOrder = certAllData.find(o => String(o.order_number) === String(orderNum));
  if (!targetOrder) return;

  try {
    const { error } = await supabaseClient.from(CERT_TABLE_NAME).delete().eq('id', targetOrder.id);
    if (error) { alert('حدث خطأ أثناء الحذف: ' + error.message); }
    else {
      alert('تم حذف الطلب بنجاح!');
      certMasterData = certMasterData.filter(o => String(o.order_number) !== String(orderNum));
      selectedCertOrderNumbers.delete(orderNum);
      updateCertSelectedCount();
      applyCertDateFiltering();
    }
  } catch (err) { alert('خطأ: ' + err.message); }
}

function openCertEditModal(orderNum) {
  selectedCertOrder = certAllData.find(o => String(o.order_number) === String(orderNum));
  if (!selectedCertOrder) return;

  document.getElementById('cert-modal-order-no').value = orderNum;
  document.getElementById('cert-modal-date').value = extractDateString(selectedCertOrder) || '';
  document.getElementById('cert-modal-status').value = CERT_STATUSES.includes(selectedCertOrder.status) ? selectedCertOrder.status : 'معلق';
  document.getElementById('cert-modal-layout').value = selectedCertOrder.Layout || selectedCertOrder.layout || '';
  document.getElementById('cert-modal-reason').value = selectedCertOrder.reason && selectedCertOrder.reason !== '-' ? selectedCertOrder.reason : '';
  toggleCertReasonField();
  document.getElementById('cert-edit-modal').style.display = 'flex';
}

function closeCertModal() {
  document.getElementById('cert-edit-modal').style.display = 'none';
  selectedCertOrder = null;
}

function toggleCertReasonField() {
  const status = document.getElementById('cert-modal-status').value;
  document.getElementById('cert-reason-group').style.display = CERT_REASON_REQUIRED_STATUSES.includes(status) ? 'block' : 'none';
}

async function saveCertUpdate() {
  if (!selectedCertOrder) return;

  const newStatus = document.getElementById('cert-modal-status').value;
  const newLayout = document.getElementById('cert-modal-layout').value;
  const newReason = document.getElementById('cert-modal-reason').value.trim();
  const newDate = document.getElementById('cert-modal-date').value;

  if (CERT_REASON_REQUIRED_STATUSES.includes(newStatus) && !newReason) {
    alert('برجاء كتابة السبب.');
    return;
  }

  const saveBtn = document.getElementById('cert-btn-save-modal');
  saveBtn.innerText = 'جاري الحفظ...';
  saveBtn.disabled = true;

  const updateData = {
    status: newStatus,
    Layout: newLayout,
    reason: CERT_REASON_REQUIRED_STATUSES.includes(newStatus) ? newReason : '-',
    date: newDate || null
  };

  try {
    const { error } = await supabaseClient.from(CERT_TABLE_NAME).update(updateData).eq('id', selectedCertOrder.id);
    if (error) {
      alert('فشل التحديث: ' + error.message);
    } else {
      Object.assign(selectedCertOrder, updateData);
      applyCertDateFiltering();
      closeCertModal();
    }
  } catch (err) {
    alert('خطأ: ' + err.message);
  }

  saveBtn.innerText = 'حفظ';
  saveBtn.disabled = false;
}

// تنزيل أرقام الطلبات الغير موزعة (Layout فاضي) في التاريخ المحدد حاليًا - عمود واحد بس
function exportUnassignedCertOrders() {
  if (!certAllData || certAllData.length === 0) {
    alert('لا يوجد بيانات لتصديرها في التاريخ المحدد حاليًا.');
    return;
  }

  const unassigned = certAllData.filter(o => !(o.Layout || o.layout));

  if (unassigned.length === 0) {
    alert('لا توجد طلبات غير موزّعة في التاريخ المحدد حاليًا.');
    return;
  }

  const rows = unassigned.map(o => ({ 'رقم الطلب': o.order_number || '-' }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 28 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'غير موزع');

  const dateLabel = document.getElementById('cert-date-filter').value || 'غير محدد';
  XLSX.writeFile(workbook, `طلبات_غير_موزعة_${dateLabel}.xlsx`);
}

document.getElementById('cert-search-input').addEventListener('input', () => { certCurrentPage = 1; renderCertPage(); });
document.getElementById('cert-status-filter').addEventListener('change', () => { certCurrentPage = 1; renderCertPage(); });
document.getElementById('cert-layout-filter').addEventListener('change', () => { certCurrentPage = 1; renderCertPage(); });

document.getElementById('search-input').addEventListener('input', () => { currentPage = 1; renderCurrentPage(); });
document.getElementById('status-filter').addEventListener('change', () => { currentPage = 1; renderCurrentPage(); });
document.getElementById('reviewer-filter').addEventListener('change', () => { currentPage = 1; renderCurrentPage(); });
