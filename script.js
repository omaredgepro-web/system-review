const SUPABASE_URL = 'https://gnpejzuxwqftxgfcsics.supabase.co';
const SUPABASE_ANON_KEY = 'sb_publishable_RZz9pDGfJXNtZYc7wADlHg_uMffms_6';
const TABLE_NAME = 'system_review1';

// ⚠️ عدّل اسم الجدول ده لو مختلف عندك في Supabase (استنتجته من اسم ملف الـ CSV اللي بعتهولي)
const CERT_TABLE_NAME = 'layout';
const CERT_STATUSES = ['تم الطباعة', 'تم إعادة الطباعة', 'مرفوض', 'محجوز', 'خطأ جهة ولاية', 'خطأ عنوان', 'معلق'];
const CERT_REASON_REQUIRED_STATUSES = ['مرفوض', 'خطأ جهة ولاية', 'خطأ عنوان'];
const CERT_REVIEWER_REQUIRED_STATUSES = ['مرفوض'];
       
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

// بيحوّل اليوزرنيم المخزّن (زي "adham") للاسم العربي المعروض (زي "ادهم") في أي مكان بيتعرض للمستخدم.
// لو القيمة مش يوزرنيم معروف في ALL_PROFILES (بيانات قديمة كانت متخزنة بالاسم مباشرة، أو "غير موزّع"، أو فاضية)،
// بيرجّع نفس القيمة زي ما هي من غير تغيير.
function getDisplayName(value) {
  if (!value) return value;
  const profile = ALL_PROFILES.find(p => p.username === value);
  return profile ? profile.name : value;
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

// أسماء المستخدمين المسموح لهم بالحذف فقط (باقي الأدمنز يقدروا يضيفوا/يعدلوا بس مش يحذفوا)
const DELETE_ALLOWED_USERNAMES = ['umar', 'mondy'];
function canDelete() {
  return !!(currentUser && currentUser.role === 'admin' && DELETE_ALLOWED_USERNAMES.includes(currentUser.username));
}
let currentPage = 1;
const pageSize = 100;
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
const certPageSize = 100;
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
  // تابات التوزيع (رفع/توزيع طلبات المراجعة، وتوزيع طلبات الطباعة) بقت محصورة على عمر وموندي بس -
  // باقي الأدمنز يقدروا يشوفوا كل حاجة تانية لكن مش يوزعوا طلبات جديدة.
  document.getElementById('admin-tab-btn').style.display = canDelete() ? 'block' : 'none';
  document.getElementById('select-all-header').style.display = isAdmin ? 'table-cell' : 'none';
  document.getElementById('admin-action-header').style.display = isAdmin ? 'table-cell' : 'none';
  document.getElementById('admin-bulk-bar').style.display = isAdmin ? 'flex' : 'none';
  const bulkDeleteBtn = document.getElementById('bulk-delete-btn');
  if (bulkDeleteBtn) bulkDeleteBtn.style.display = canDelete() ? 'inline-flex' : 'none';
  const certBulkDeleteBtn = document.getElementById('cert-bulk-delete-btn');
  if (certBulkDeleteBtn) certBulkDeleteBtn.style.display = canDelete() ? 'inline-flex' : 'none';
  const certReassignControls = document.getElementById('cert-reassign-controls');
  if (certReassignControls) certReassignControls.style.display = canDelete() ? 'flex' : 'none';
  document.getElementById('admin-export-actions').style.display = isAdmin ? 'flex' : 'none';
  document.getElementById('certificates-tab-btn').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('print-distribute-tab-btn').style.display = canDelete() ? 'block' : 'none';

  // تغيير تاريخ الطلبات المعروضة متاح للأدمن بس؛ المراجع دايمًا شايف أحدث تاريخ متاح
  document.getElementById('date-filter-label').style.display = isAdmin ? 'inline' : 'none';
  document.getElementById('date-filter').style.display = isAdmin ? 'inline-block' : 'none';
  document.getElementById('reset-date-btn').style.display = isAdmin ? 'inline-flex' : 'none';

  ALL_PROFILES = await fetchAllProfiles();
  populateReviewerDropdowns();
  loadData();
  subscribeToLiveUpdates();
}

// اشتراك Realtime: أي إضافة/تعديل/حذف يحصل في الجداول دي (من أي حد، من أي مكان)
// هيوصل هنا لحظيًا. بدل ما نعيد تحميل الجدول كله من الصفر في كل مرة (بطيء ومزعج)،
// بناخد التغيير من رسالة الـ Realtime نفسها ونحدث بس الصف المتأثر في الذاكرة - تحديث فوري.
function patchMasterDataRow(masterArray, eventType, newRow, oldRow) {
  if (eventType === 'DELETE') {
    const deletedId = oldRow && oldRow.id;
    return masterArray.filter(row => row.id !== deletedId);
  }

  const incomingId = newRow && newRow.id;
  const idx = masterArray.findIndex(row => row.id === incomingId);

  if (eventType === 'INSERT') {
    if (idx !== -1) return masterArray; // موجود بالفعل (تكرار رسالة)، تجاهل
    return [...masterArray, newRow];
  }

  // UPDATE
  if (idx === -1) return [...masterArray, newRow]; // مش موجود عندنا لأي سبب، ضيفه
  const updated = masterArray.slice();
  updated[idx] = newRow;
  return updated;
}

// تحديث البيانات نفسها بيحصل فورًا مع كل رسالة توصل (عشان الدقة)، لكن تحديث الشاشة (إعادة الرسم)
// بيتأجل شوية (250ms) عشان لو وصلت كذا رسالة قريبة من بعض (زي حذف/توزيع جماعي لعشرات الصفوف
// دفعة واحدة)، الشاشة تتحدث مرة واحدة بس في الآخر، بدل ما تومض/تتحدث مع كل صف لوحده.
let liveReviewRenderTimer = null;
function scheduleLiveReviewRender() {
  clearTimeout(liveReviewRenderTimer);
  liveReviewRenderTimer = setTimeout(() => applyDateFiltering(), 250);
}

let liveCertRenderTimer = null;
function scheduleLiveCertRender() {
  clearTimeout(liveCertRenderTimer);
  liveCertRenderTimer = setTimeout(() => applyCertDateFiltering(), 250);
}

function handleLiveChange(tableName, payload) {
  const { eventType, new: newRow, old: oldRow } = payload;

  if (tableName === TABLE_NAME) {
    window.masterData = patchMasterDataRow(window.masterData || [], eventType, newRow, oldRow);
    scheduleLiveReviewRender();
  } else if (tableName === CERT_TABLE_NAME) {
    certMasterData = patchMasterDataRow(certMasterData || [], eventType, newRow, oldRow);
    if (typeof certDataLoaded !== 'undefined' && certDataLoaded) {
      scheduleLiveCertRender();
    }
  }
}

let liveUpdatesChannel = null;
function subscribeToLiveUpdates() {
  if (liveUpdatesChannel) return; // تجنب الاشتراك أكتر من مرة لو الفانكشن اتنادت تاني

  liveUpdatesChannel = supabaseClient
    .channel('live-orders-updates')
    .on('postgres_changes', { event: '*', schema: 'public', table: TABLE_NAME }, (payload) => {
      handleLiveChange(TABLE_NAME, payload);
    })
    .on('postgres_changes', { event: '*', schema: 'public', table: CERT_TABLE_NAME }, (payload) => {
      handleLiveChange(CERT_TABLE_NAME, payload);
    })
    .subscribe((status) => {
      const indicator = document.getElementById('live-status-indicator');
      if (!indicator) return;
      if (status === 'SUBSCRIBED') {
        indicator.innerText = '🟢 مباشر';
        indicator.title = 'التحديثات وصلاك لحظيًا الآن';
      } else if (status === 'CHANNEL_ERROR' || status === 'TIMED_OUT') {
        indicator.innerText = '🟡 غير متصل';
        indicator.title = 'التحديث اللحظي مش شغال دلوقتي، استخدم زرار التحديث اليدوي';
      }
    });
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

// بيبني قايمة الشركات في فلتر الداشبورد من طلبات التاريخ المحدد حاليًا بس (مش كل الطلبات اللي اترفعت قبل كده)،
// عشان القايمة تعكس بالظبط الشركات الموجودة فعليًا في التاريخ ده. بيتم استدعاؤها في كل مرة يتغير فيها التاريخ.
function populateCompanyFilter() {
  const filterSelect = document.getElementById('company-filter');
  if (!filterSelect || !window.allData) return;

  const currentValue = filterSelect.value || 'ALL';

  // .normalize('NFC') بيوحّد أشكال الحروف العربية المتطابقة بصريًا لكن المخزّنة بترميز يونيكود مختلف شوية
  // (سبب شائع لظهور نفس اسم الشركة مرتين في القايمة رغم إنه شكله واحد بالظبط).
  const companies = [...new Set(
    window.allData
      .map(o => (o.company || o['الشركة'] || '').normalize('NFC').trim())
      .filter(Boolean)
  )].sort((a, b) => a.localeCompare(b, 'ar'));

  filterSelect.innerHTML = `<option value="ALL">كل الشركات</option>`;
  companies.forEach(company => {
    filterSelect.innerHTML += `<option value="${company}">${company}</option>`;
  });

  // نحافظ على الاختيار الحالي لو لسه موجود في القايمة الجديدة
  if ([...filterSelect.options].some(opt => opt.value === currentValue)) {
    filterSelect.value = currentValue;
  } else {
    filterSelect.value = 'ALL';
  }
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
  document.getElementById('tab-rejections').style.display = 'none';

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
  } else if (tabName === 'rejections') {
    document.getElementById('rejections-tab-btn').classList.add('active');
    document.getElementById('tab-rejections').style.display = 'block';
    if (!certDataLoaded) { loadCertificatesData().then(applyRejectionsDateFiltering); }
    else { applyRejectionsDateFiltering(); }
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
      const { data, error } = await supabaseClient.from(TABLE_NAME).select('*').order('id', { ascending: true }).range(from, from + step - 1);
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
  populateCompanyFilter();

  totalRecordsCount = window.allData.length;

  // البيانات اللي فعليًا بتتعرض في الجدول والكروت فوق: المراجع (غير الأدمن) يشوف طلباته هو بس، من فوق لتحت
  if (currentUser && currentUser.role !== 'admin') {
    window.visibleData = window.allData.filter(item => {
      const reviewerName = item.reviewer || item['المراجع'] || '';
      return reviewerName === currentUser.username || reviewerName === currentUser.name;
    });
  } else {
    window.visibleData = window.allData;
  }

  updateKPIs(window.visibleData); // الكروت فوق (KPIs) بتعكس بيانات المراجع نفسه بس، مش الحالة العامة لكل الطلبات

  renderReviewersStats(window.visibleData);
  renderCompanyStats(window.allData);
  renderCurrentPage();
}

function onDateFilterChange() { currentPage = 1; selectedOrderNumbers.clear(); updateSelectedCount(); applyDateFiltering(); }
function resetDateToLatest() { document.getElementById('date-filter').value = ''; selectedOrderNumbers.clear(); updateSelectedCount(); applyDateFiltering(); }

// تحديث بيانات لوحة المراجعة والإحصائيات من Supabase من غير عمل ريفرش لكل الصفحة
async function refreshDashboardData() {
  const btn = document.getElementById('refresh-dashboard-btn');
  const originalText = btn ? btn.innerText : '';
  if (btn) { btn.disabled = true; btn.innerText = '⏳ جاري التحديث...'; }

  try {
    await loadData();
  } catch (err) {
    alert('حصل خطأ أثناء تحديث البيانات: ' + err.message);
  } finally {
    if (btn) { btn.disabled = false; btn.innerText = originalText; }
  }
}

function renderCurrentPage() {
  if (!window.visibleData) return;

  const searchValue = document.getElementById('search-input').value.trim().toLowerCase();
  const statusValue = document.getElementById('status-filter').value;
  const reviewerValue = document.getElementById('reviewer-filter').value;
  const companyValue = document.getElementById('company-filter').value;

  // لو المستخدم بيدور برقم الطلب، البحث لازم يشمل كل التواريخ (كل الداتا) مش بس تاريخ اليوم المحدد فوق.
  // من غير بحث، بنرجع للسلوك العادي: بيانات اليوم/التاريخ المحدد فقط.
  let baseData;
  if (searchValue) {
    if (currentUser && currentUser.role !== 'admin') {
      baseData = (window.masterData || []).filter(item => {
        const reviewerName = item.reviewer || item['المراجع'] || '';
        return reviewerName === currentUser.username || reviewerName === currentUser.name;
      });
    } else {
      baseData = window.masterData || [];
    }
  } else {
    baseData = window.visibleData;
  }

  let filtered = baseData.filter(item => {
    const orderNum = String(item.order_number || item.order_no || item['رقم الطلب'] || '').toLowerCase();
    const matchesSearch = !searchValue || orderNum.includes(searchValue);
    const reviewStatus = item.review_status || item['حالة المراجعة'] || 'لم يتم المراجعة';
    const matchesStatus = (statusValue === 'ALL') || (reviewStatus === statusValue);
    
    const reviewer = item.reviewer || item['المراجع'] || '';
    const matchesReviewer = (reviewerValue === 'ALL')
      || (reviewerValue === 'UNASSIGNED' ? !reviewer
        : (reviewer === reviewerValue || getDisplayName(reviewer) === getDisplayName(reviewerValue)));

    const company = (item.company || item['الشركة'] || '').normalize('NFC').trim();
    const matchesCompany = (companyValue === 'ALL') || (company === companyValue);

    return matchesSearch && matchesStatus && matchesReviewer && matchesCompany;
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
    const reviewer = getDisplayName(order.reviewer || order['المراجع'] || '-');
    const progressStatus = order.status || order['الحالة'] || '-';
    const reviewStatus = order.review_status || order['حالة المراجعة'] || 'لم يتم المراجعة';
    const rejectionReason = order.rejection_reason || order.reason || order['سبب الرفض'] || '-';

    let reviewBadge = 'badge-unreviewed';
    if (reviewStatus === 'مقبول') reviewBadge = 'badge-accepted';
    if (reviewStatus === 'مرفوض') reviewBadge = 'badge-rejected';
    if (reviewStatus === 'معلق') reviewBadge = 'badge-hold';
    if (reviewStatus === 'Qc') reviewBadge = 'badge-qc';

    const isChecked = selectedOrderNumbers.has(orderNum) ? 'checked' : '';
    const checkboxHtml = isAdmin ? `<td style="text-align:center;"><input type="checkbox" class="row-checkbox" data-ordernum="${orderNum}" ${isChecked} onchange="toggleRowSelect(this, '${orderNum}')"></td>` : '';
    const adminCellHtml = isAdmin ? `<td class="sticky-action-col">${canDelete() ? `<button class="btn-delete-row" onclick="deleteSingleOrder('${orderNum}')">🗑️ مسح</button>` : ''}</td>` : '';

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

// ============ التاريخ الإجباري لدفعة الرفع (لوحة الأدمن CSV) ============
function useCsvUploadTodayDate() {
  const dateInput = document.getElementById('csv-upload-date-input');
  dateInput.value = new Date().toISOString().split('T')[0];
  applyCsvUploadDateToAllRows();
}

// بيطبّق التاريخ المختار على كل الصفوف المرفوعة حاليًا (يستبدل أي تاريخ كان موجود بالملف الأصلي)،
// ويحدّث حالة الخانة عشان يبقى واضح إن التاريخ اتأكد فعليًا.
function applyCsvUploadDateToAllRows() {
  const dateInput = document.getElementById('csv-upload-date-input');
  const statusEl = document.getElementById('csv-upload-date-status');

  if (!dateInput.value) {
    statusEl.innerText = '⚠️ لسه معملتش اختيار';
    statusEl.style.color = 'var(--badge-hold-text)';
    return;
  }

  if (parsedCsvData && parsedCsvData.length > 0) {
    parsedCsvData.forEach(row => { row.date = dateInput.value; });

    const cleanupResult = autoCleanCsvDuplicates();
    renderCsvPreview(parsedCsvData);

    const report = buildDuplicateCleanupReport(cleanupResult);
    if (report) alert(report);
  }

  statusEl.innerText = `✅ الطلبات هتتسجل بتاريخ: ${dateInput.value}`;
  statusEl.style.color = 'var(--badge-accept-text)';
}

// بيتأكد إن التاريخ اتحدد قبل السماح بأي توزيع أو رفع لـ Supabase — لو لأ، بيوقف العملية وينبّه المستخدم
function ensureCsvUploadDateSelected() {
  const dateInput = document.getElementById('csv-upload-date-input');
  if (!dateInput.value) {
    alert('برجاء اختيار التاريخ اللي هتتسجل بيه الطلبات دي الأول (أو اضغط "استخدام تاريخ النهاردة") قبل التوزيع أو الرفع.');
    dateInput.focus();
    return false;
  }
  return true;
}

// تحديد أول N طلب من نتائج الفلتر الحالي (بغض النظر عن كونه موزّع على مراجع أو لأ) — مفيد لو
// فلترت بالفعل (بالمراجع أو الشركة أو الحالة) وعايز تحدد أول دفعة من اللي ظاهر عندك بالضبط
function selectNextOrderFromFiltered() {
  const input = document.getElementById('order-select-first-count-input');
  const count = parseInt(input.value, 10);

  if (!count || count <= 0) { alert('برجاء إدخال عدد صحيح أكبر من صفر'); return; }
  if (!window.currentFilteredData || window.currentFilteredData.length === 0) { alert('لا توجد بيانات لتحديدها ضمن الفلتر الحالي'); return; }

  const getOrderNum = o => o.order_number || o.order_no || o['رقم الطلب'];
  const unselected = window.currentFilteredData.filter(o => !selectedOrderNumbers.has(getOrderNum(o)));

  if (unselected.length === 0) { alert('كل الطلبات المطابقة للفلتر الحالي متحددة بالفعل'); return; }

  const batch = unselected.slice(0, count);
  batch.forEach(o => selectedOrderNumbers.add(getOrderNum(o)));

  updateSelectedCount();
  renderCurrentPage();
  input.value = '';

  if (batch.length < count) {
    alert(`تم تحديد ${batch.length} طلب فقط (هذا كل المتاح ضمن الفلتر الحالي)`);
  }
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
  if (!canDelete()) { alert('هذا الإجراء متاح لعمر وموندي فقط'); return; }
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
  if (!canDelete()) { alert('هذا الإجراء متاح لعمر وموندي فقط'); return; }
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

    // ============ منع تكرار الطلب في نفس اليوم تلقائيًا (بدون الحاجة لأي زرار يدوي) ============
    const cleanupResult = autoCleanCsvDuplicates();

    document.getElementById('file-name-display').innerText = `تم إضافة: ${namesLabel} (الإجمالي الآن ${parsedCsvData.length} طلب)`;
    renderCsvPreview(parsedCsvData);

    const report = buildDuplicateCleanupReport(cleanupResult);
    if (report) alert(report);
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
  document.getElementById('csv-upload-date-input').value = '';
  const statusEl = document.getElementById('csv-upload-date-status');
  statusEl.innerText = '⚠️ لسه معملتش اختيار';
  statusEl.style.color = 'var(--badge-hold-text)';
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

    // لو عمود المراجع في الملف مكتوب بالاسم العربي (زي "يوسف") بدل اليوزرنيم الإنجليزي المخزّن في profiles،
    // بنحوله هنا لليوزرنيم قبل الرفع، عشان فلتر المراجع والتوزيع يفضلوا شغالين صح على الداتا الجديدة.
    if (newRow.reviewer) {
      const matchByName = ALL_PROFILES.find(p => p.name === newRow.reviewer);
      if (matchByName) newRow.reviewer = matchByName.username;
    }

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
// ============ منع تكرار الطلب في نفس يوم الرفع (تلقائي) ============
// النطاق: "نفس اليوم" = نفس التاريخ المحدد فوق لهذه الدفعة (أو تاريخ النهاردة لو لسه المستخدم مختارش تاريخ).
function getCsvUploadTargetDateIso() {
  const dateInput = document.getElementById('csv-upload-date-input');
  return (dateInput && dateInput.value) ? dateInput.value : new Date().toISOString().split('T')[0];
}

// بيرجّع الطلب المسجل بالفعل في قاعدة البيانات بنفس رقم الطلب ونفس التاريخ بالظبط (مش أي تاريخ تاني)
function getMasterOrderByNumberAndDate(orderNum, dateIso) {
  return (window.masterData || []).find(o =>
    String(o.order_number || o.order_no || o['رقم الطلب']) === String(orderNum) &&
    extractDateString(o) === dateIso
  );
}

// بيشيل أي رقم طلب اتكرر أكتر من مرة داخل نفس الدفعة اللي بتترفع دلوقتي (نفس الملف أو أكتر من ملف مع بعض)،
// ومسيب أول ظهور بس لكل رقم.
function removeWithinBatchDuplicates(rows) {
  const seen = new Set();
  let removedCount = 0;
  const kept = rows.filter(row => {
    const num = getCsvRowOrderNumber(row);
    if (!num) return true;
    if (seen.has(num)) { removedCount++; return false; }
    seen.add(num);
    return true;
  });
  return { kept, removedCount };
}

// القاعدة الرسمية لمنع تكرار الطلب في نفس اليوم (بتتطبق على أي رقم طلب موجود بالفعل في قاعدة البيانات
// بنفس تاريخ الدفعة الحالية):
// - لو الطلب الموجود حالته "مقبول"  → الصف الجديد يتشال، ويفضل المقبول القديم زي ما هو من غير أي تغيير.
// - لو الطلب الموجود حالته "مرفوض":
//     • ولو الصف الجديد جاي من الملف معلّم بعمود "الحالة"/"حالة المراجعة" = "تم إعادة المراجعة"
//       → يتسجل عادي (تكرار مقصود لإعادة المراجعة)، وياخد نفس المراجع اللي راجعه قبل كده.
//     • غير كده (مفيش علامة إعادة مراجعة) → يتشال (يعتبر تكرار غير مبرر).
// - أي حالة تانية للطلب الموجود (معلق/Qc/لسه ماخدش قرار) → الصف الجديد يتشال برضو، عشان منسمحش
//   بنفس الطلب يبقى موجود مرتين وهو أصلاً لسه مقرّرش فيه حاجة.
function applyDuplicateRuleToRows(rows) {
  const targetDate = getCsvUploadTargetDateIso();
  const log = { accepted: 0, rejectedNotFlagged: 0, stillPending: 0, allowedReReview: 0 };

  const kept = rows.filter(row => {
    const num = getCsvRowOrderNumber(row);
    if (!num) return true;

    const master = getMasterOrderByNumberAndDate(num, targetDate);
    if (!master) return true; // مش موجود بنفس اليوم ده، مش تكرار أصلاً

    const existingStatus = master.review_status || master['حالة المراجعة'];

    if (existingStatus === 'مقبول') {
      log.accepted++;
      return false;
    }

    if (existingStatus === 'مرفوض') {
      const incomingStatus = (row.status || row['الحالة'] || '').toString().trim();
      if (incomingStatus === 'تم إعادة المراجعة') {
        const prevReviewer = master.reviewer || master['المراجع'];
        if (prevReviewer) { row.reviewer = prevReviewer; row['المراجع'] = prevReviewer; }
        log.allowedReReview++;
        return true;
      }
      log.rejectedNotFlagged++;
      return false;
    }

    log.stillPending++;
    return false;
  });

  return { kept, log, targetDate };
}

// بيشغّل قاعدة منع التكرار كاملة (تكرار داخل الدفعة + تكرار مع قاعدة البيانات بنفس اليوم) على parsedCsvData
// الحالية، ويرجّع تقرير بكل حاجة اتشالت وليه، عشان يتعرض للمستخدم.
function autoCleanCsvDuplicates() {
  const beforeCount = parsedCsvData.length;

  const batchResult = removeWithinBatchDuplicates(parsedCsvData);
  parsedCsvData = batchResult.kept;

  const dupResult = applyDuplicateRuleToRows(parsedCsvData);
  parsedCsvData = dupResult.kept;

  return {
    totalRemoved: beforeCount - parsedCsvData.length,
    withinBatchRemoved: batchResult.removedCount,
    log: dupResult.log,
    targetDate: dupResult.targetDate
  };
}

function buildDuplicateCleanupReport(result) {
  if (result.totalRemoved === 0) return null;
  const log = result.log;
  let msg = `🚫 تم منع تكرار الطلب في نفس اليوم (${result.targetDate}) تلقائيًا:\n\n`;
  if (result.withinBatchRemoved > 0) msg += `• ${result.withinBatchRemoved} نسخة مكررة داخل الملف/الملفات نفسها.\n`;
  if (log.accepted > 0) msg += `• ${log.accepted} طلب كان "مقبول" من قبل بنفس اليوم — اتشال، والمقبول القديم فاضل زي ما هو.\n`;
  if (log.rejectedNotFlagged > 0) msg += `• ${log.rejectedNotFlagged} طلب كان "مرفوض" من قبل بنفس اليوم، بدون علامة "تم إعادة المراجعة" — اتشال كتكرار غير مبرر.\n`;
  if (log.stillPending > 0) msg += `• ${log.stillPending} طلب موجود بالفعل بنفس اليوم ولسه معلّق/تحت المراجعة — اتشال.\n`;
  if (log.allowedReReview > 0) msg += `\n✅ اتسمح بمرور ${log.allowedReReview} طلب "إعادة مراجعة" فعلي (كان مرفوض ومعلّم بإعادة المراجعة)، وهياخد نفس المراجع اللي راجعه قبل كده.\n`;
  msg += `\nالإجمالي بعد التنظيف: ${parsedCsvData.length} طلب.`;
  return msg;
}

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
        ${getDisplayName(key)}
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
  if (!canDelete()) { alert('التوزيع متاح لعمر وموندي فقط'); return; }
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
        <td>${getDisplayName(row.reviewer || row['المراجع']) || '-'}</td>
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

// بيرجّع بيانات الطلب (الشركة + المراجع + حالة المراجعة) من قاعدة البيانات لأي رقم طلب،
// عشان نقدر نصدّرهم في شيت الإكسيل بتاع الأرقام المكررة.
function getMasterOrderByNumber(orderNum) {
  return (window.masterData || []).find(o => String(o.order_number || o.order_no || o['رقم الطلب']) === String(orderNum));
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
    html += `<div style="display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap;">`;
    html += `<button type="button" class="btn btn-secondary" style="padding:6px 12px; font-size:12px;" onclick="downloadWithinFileDuplicatesExcel()">⬇️ تحميل شيت إكسيل بالمكرر (${dupWithinFile.length})</button>`;
    html += `<button type="button" class="btn-delete-row" style="padding:6px 12px; font-size:12px;" onclick="removeWithinFileDuplicatesFromCsv()">🗑️ إزالة النسخ الزيادة (الإبقاء على نسخة واحدة)</button>`;
    html += `</div>`;
    html += `<div style="max-height:130px; overflow-y:auto; font-size:12px; color: var(--text-muted); background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 8px; margin-bottom:14px;">`;
    html += dupWithinFile.map(num => `${num} <span style="color: var(--badge-reject-text);">(×${seenCounts[num]})</span>`).join('، ');
    html += `</div>`;
  }

  if (dupExisting.length > 0) {
    html += `<p style="color: var(--badge-hold-text); font-weight:700; margin-bottom:6px;">ℹ️ ${dupExisting.length} رقم طلب سبق وجوده في قاعدة البيانات (بأي تاريخ، مش بالضرورة نفس تاريخ الدفعة دي):</p>`;
    html += `<p style="font-size:11px; color: var(--text-muted); margin-bottom:6px;">ملحوظة: التكرار في نفس تاريخ الدفعة الحالية بيتم التعامل معاه تلقائيًا أول ما ترفع الملف (يتشال، إلا لو "مرفوض" ومعلّم "تم إعادة المراجعة"). اللستة دي بتوريك أي رقم اتشاف قبل كده في تاريخ تاني برضو، للمراجعة فقط.</p>`;
    html += `<div style="display:flex; gap:8px; margin-bottom:10px; flex-wrap:wrap;">`;
    html += `<button type="button" class="btn btn-secondary" style="padding:6px 12px; font-size:12px;" onclick="downloadDuplicateOrdersExcel()">⬇️ تحميل شيت إكسيل بالمكررة</button>`;
    html += `<button type="button" class="btn-delete-row" style="padding:6px 12px; font-size:12px;" onclick="resolveExistingDuplicatesBySmartRule()">🤖 إعادة تطبيق قاعدة منع التكرار الآن</button>`;
    html += `</div>`;
    html += `<div style="max-height:130px; overflow-y:auto; font-size:12px; color: var(--text-muted); background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 8px;">`;
    html += dupExisting.join('، ');
    html += `</div>`;
  }

  // بنخزن آخر لستة أرقام مكررة (بنوعيها) عشان زراير التحميل/المعالجة فوق تقدر تستخدمها
  // من غير ما نعيد حساب الفلترة كلها تاني.
  window.lastCsvDupExisting = dupExisting;
  window.lastCsvDupWithinFile = dupWithinFile;
  window.lastCsvDupWithinFileCounts = seenCounts;

  container.innerHTML = html;
}

// بيحمّل شيت إكسيل بالأرقام المكررة داخل نفس الملف المرفوع (مش الموجودة في قاعدة البيانات)
function downloadWithinFileDuplicatesExcel() {
  const dupNums = window.lastCsvDupWithinFile || [];
  const counts = window.lastCsvDupWithinFileCounts || {};
  if (dupNums.length === 0) { alert('لا توجد أرقام مكررة داخل الملف لتحميلها.'); return; }

  const exportRows = dupNums.map(num => ({
    'رقم الطلب': num,
    'عدد مرات التكرار داخل الملف': counts[num] || 2
  }));

  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  worksheet['!cols'] = [{ wch: 28 }, { wch: 26 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'مكرر داخل الملف');

  const dateLabel = new Date().toISOString().split('T')[0];
  XLSX.writeFile(workbook, `مكرر_داخل_الملف_${dateLabel}.xlsx`);
}

// بيسيب نسخة واحدة بس من كل رقم طلب مكرر داخل نفس الملف، ويشيل النسخ الزيادة
function removeWithinFileDuplicatesFromCsv() {
  const dupNums = window.lastCsvDupWithinFile || [];
  if (dupNums.length === 0) { alert('لا توجد نسخ مكررة داخل الملف لإزالتها.'); return; }

  const confirmRemove = confirm(`هيتم الإبقاء على نسخة واحدة بس من كل رقم من الـ ${dupNums.length} رقم مكرر داخل الملف، والباقي هيتشال. تأكيد؟`);
  if (!confirmRemove) return;

  const dupSet = new Set(dupNums.map(String));
  const seen = new Set();
  const before = parsedCsvData.length;

  parsedCsvData = parsedCsvData.filter(row => {
    const num = getCsvRowOrderNumber(row);
    if (!dupSet.has(num)) return true; // مش من المكررين، سيبه زي ما هو
    if (seen.has(num)) return false; // ده نسخة زيادة من رقم اتشاف قبل كده، شيله
    seen.add(num);
    return true; // أول ظهور للرقم ده، سيبه
  });

  renderCsvPreview(parsedCsvData);
  alert(`تم إزالة ${before - parsedCsvData.length} نسخة زيادة. باقي ${parsedCsvData.length} صف.`);
}

// بيحمّل شيت إكسيل بالطلبات المكررة (الموجودة بالفعل في قاعدة البيانات) مع اسم الشركة
// والمراجع وحالة المراجعة (مقبول/مرفوض) بتاعتها زي ما هي مسجلة حاليًا.
function downloadDuplicateOrdersExcel() {
  const dupExisting = window.lastCsvDupExisting || [];
  if (dupExisting.length === 0) { alert('لا توجد أرقام مكررة لتحميلها.'); return; }

  const exportRows = dupExisting.map(num => {
    const master = getMasterOrderByNumber(num);
    return {
      'رقم الطلب': num,
      'اسم الشركة': master ? (master.company || master['الشركة'] || '-') : '-',
      'المراجع': master ? (getDisplayName(master.reviewer || master['المراجع']) || '-') : '-',
      'حالة المراجعة': master ? (master.review_status || master['حالة المراجعة'] || '-') : '-'
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  worksheet['!cols'] = [{ wch: 28 }, { wch: 24 }, { wch: 20 }, { wch: 16 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'الطلبات المكررة');

  const dateLabel = new Date().toISOString().split('T')[0];
  XLSX.writeFile(workbook, `الطلبات_المكررة_${dateLabel}.xlsx`);
}

// زرار يدوي (للمراجعة/الطمأنينة بعد أي تعديل يدوي على الصفوف) — بيطبّق بالظبط نفس القاعدة اللي
// بتتشغل تلقائيًا أول ما ترفع ملف أو تغيّر تاريخ الدفعة (applyDuplicateRuleToRows فوق).
function resolveExistingDuplicatesBySmartRule() {
  const targetDate = getCsvUploadTargetDateIso();
  const preview = applyDuplicateRuleToRows(parsedCsvData);

  if (preview.kept.length === parsedCsvData.length) {
    alert(`لا توجد طلبات مكررة بنفس تاريخ الدفعة (${targetDate}) لمعالجتها.`);
    return;
  }

  const log = preview.log;
  const confirmProcess = confirm(
    `هيتم فحص الطلبات اللي موجودة بالفعل بنفس تاريخ الدفعة (${targetDate}):\n` +
    `- اللي حالته "مقبول" هيتشال من الملف تمامًا (${log.accepted} طلب).\n` +
    `- اللي حالته "مرفوض" ومعلّم "تم إعادة المراجعة" هيفضل، وهيتحط عليه نفس المراجع السابق (${log.allowedReReview} طلب).\n` +
    `- اللي حالته "مرفوض" من غير علامة إعادة مراجعة هيتشال (${log.rejectedNotFlagged} طلب).\n` +
    `- اللي لسه معلّق/تحت المراجعة هيتشال برضو (${log.stillPending} طلب).\n\nتأكيد؟`
  );
  if (!confirmProcess) return;

  const removedNow = parsedCsvData.length - preview.kept.length;
  parsedCsvData = preview.kept;
  renderCsvPreview(parsedCsvData);
  alert(buildDuplicateCleanupReport({ totalRemoved: removedNow, withinBatchRemoved: 0, log, targetDate }) || 'تم التنظيف.');
}

// بيرجّع أرقام الطلبات (من data) اللي موجودة بالفعل في قاعدة البيانات بنفس تاريخ الدفعة الحالية بالظبط
function getTodayDuplicateOrderNumbers(data) {
  const targetDate = getCsvUploadTargetDateIso();
  const targetSet = new Set(
    (window.masterData || [])
      .filter(o => extractDateString(o) === targetDate)
      .map(o => String(o.order_number || o.order_no || o['رقم الطلب']))
  );
  return [...new Set(data.map(getCsvRowOrderNumber))].filter(num => num && targetSet.has(num));
}

// بيشيل كل طلبات شركة معينة من الملف المرفوع قبل التوزيع/الرفع لـ Supabase
function deleteCompanyFromCsv(company) {
  const count = parsedCsvData.filter(row => getCsvRowCompany(row) === company).length;
  const confirmDelete = confirm(`هل أنت متأكد من حذف كل طلبات شركة "${company}" (${count} طلب) من الملف؟`);
  if (!confirmDelete) return;

  parsedCsvData = parsedCsvData.filter(row => getCsvRowCompany(row) !== company);
  renderCsvPreview(parsedCsvData);
}

// ============ التوزيع المخصص: تحديد يدوي (مراجع + مجموعة شركات + عدد إجمالي يتقسم نسبيًا) ============
let customDistRules = [];

function populateCustomDistSelects() {
  const reviewerSelect = document.getElementById('custom-dist-reviewer-select');
  if (reviewerSelect && reviewerSelect.options.length <= 1) {
    reviewerSelect.innerHTML = `<option value="">اختر المراجع...</option>` +
      ALL_PROFILES.map(p => `<option value="${p.username}">${p.name}${p.role === 'admin' ? ' (أدمن)' : ''}</option>`).join('');
  }
}

// بيحسب عدد الطلبات "غير الموزّعة" (معندهاش مراجع) لكل شركة، مفيد لعرض العدد المتاح وللتقسيم النسبي
function getUnassignedCountsByCompany(data) {
  const counts = {};
  (data || []).forEach(row => {
    if (row.reviewer || row['المراجع']) return;
    const c = getCsvRowCompany(row);
    counts[c] = (counts[c] || 0) + 1;
  });
  return counts;
}

function populateCustomDistCompanySelect(data) {
  const container = document.getElementById('custom-dist-companies-checklist');
  if (!container) return;

  const previouslyChecked = new Set(
    Array.from(container.querySelectorAll('.custom-dist-company-checkbox:checked')).map(cb => cb.value)
  );

  const counts = getUnassignedCountsByCompany(data);
  const sorted = Object.keys(counts).sort((a, b) => a.localeCompare(b, 'ar'));

  container.innerHTML = '';
  if (sorted.length === 0) {
    container.innerHTML = `<p style="font-size: 12px; color: var(--text-muted);">لا توجد شركات متاحة (كل الطلبات موزّعة بالفعل أو مفيش ملف مرفوع).</p>`;
  }

  sorted.forEach(company => {
    const label = document.createElement('label');
    label.style.cssText = 'display:flex; align-items:center; gap:6px; font-size:13px; background: var(--bg-dark); border:1px solid var(--card-border); padding:6px 10px; border-radius:6px; cursor:pointer;';
    const isChecked = previouslyChecked.has(company) ? 'checked' : '';
    label.innerHTML = `<input type="checkbox" class="custom-dist-company-checkbox" value="${company}" ${isChecked}> ${company} (${counts[company]} متاح)`;
    label.querySelector('input').addEventListener('change', updateCustomDistCompaniesTotal);
    container.appendChild(label);
  });

  updateCustomDistCompaniesTotal();
}

function getSelectedCustomDistCompanies() {
  return Array.from(document.querySelectorAll('.custom-dist-company-checkbox:checked')).map(cb => cb.value);
}

function updateCustomDistCompaniesTotal() {
  const counts = getUnassignedCountsByCompany(parsedCsvData);
  const selected = getSelectedCustomDistCompanies();
  const total = selected.reduce((sum, c) => sum + (counts[c] || 0), 0);
  const totalEl = document.getElementById('custom-dist-companies-total');
  if (totalEl) totalEl.innerText = total;
}

function addCustomDistRule() {
  const reviewer = document.getElementById('custom-dist-reviewer-select').value;
  const companies = getSelectedCustomDistCompanies();
  const count = parseInt(document.getElementById('custom-dist-count-input').value, 10);

  if (!reviewer) { alert('اختار المراجع أولاً'); return; }
  if (companies.length === 0) { alert('اختار شركة واحدة على الأقل من القائمة'); return; }
  if (!count || count <= 0) { alert('اكتب عدد صحيح أكبر من صفر'); return; }

  customDistRules.push({ reviewer, companies, count });
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
    label.textContent = `${rule.reviewer} ← (${rule.companies.join(' + ')}): ${rule.count} طلب إجمالي`;

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

// بيطبّق كل القواعد بالترتيب: كل قاعدة بتاخد العدد الإجمالي المطلوب وتقسّمه نسبيًا بين الشركات
// بياخد عدد "count" من صفوف الـ pool، بس بالتساوي بين حالات المراجعة المختلفة الموجودة
// جوه الـ pool ده (زي "جاري مراجعة" و"تم إعادة المراجعة") - مش بنفس نسبتهم الأصلية.
// مثال: لو الشركة فيها 70 "جاري مراجعة" و30 "تم إعادة المراجعة"، ومطلوب ناخد 50،
// هياخد 25 من كل حالة (مش 35/15 حسب النسبة الأصلية).
function pickBalancedByStatus(pool, count) {
  const groups = {};
  const order = [];
  pool.forEach(row => {
    const statusKey = row.status || row['الحالة'] || row['حالة المراجعة'] || 'غير محدد';
    if (!groups[statusKey]) { groups[statusKey] = []; order.push(statusKey); }
    groups[statusKey].push(row);
  });
  order.sort(); // ترتيب ثابت عشان التوزيع يكون متسق كل مرة

  const picked = [];
  let i = 0;
  let emptyStreak = 0;
  while (picked.length < count && emptyStreak < order.length) {
    const key = order[i % order.length];
    if (groups[key].length > 0) {
      picked.push(groups[key].shift());
      emptyStreak = 0;
    } else {
      emptyStreak++;
    }
    i++;
  }
  return picked;
}

// المختارة حسب نصيب كل شركة الفعلي من الطلبات غير الموزّعة بينهم (Largest Remainder Method لدقة أعلى)
function applyCustomDistRules() {
  if (!canDelete()) { alert('التوزيع متاح لعمر وموندي فقط'); return; }
  if (!ensureCsvUploadDateSelected()) return;
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
    // تجميع الطلبات غير الموزّعة لكل شركة من شركات القاعدة دي، بترتيبها الأصلي
    const companyPools = {};
    rule.companies.forEach(c => { companyPools[c] = []; });
    parsedCsvData.forEach(row => {
      const c = getCsvRowCompany(row);
      if (rule.companies.includes(c) && !row.reviewer && !row[reviewerColKey]) {
        companyPools[c].push(row);
      }
    });

    const totalAvailable = rule.companies.reduce((sum, c) => sum + companyPools[c].length, 0);
    const targetTotal = Math.min(rule.count, totalAvailable);
    const companyBreakdown = {};

    if (targetTotal > 0) {
      // حساب نصيب كل شركة بنفس نسبتها الحالية في المتاح، مع تقريب دقيق (Largest Remainder Method)
      let targets = rule.companies.map(c => {
        const raw = targetTotal * (companyPools[c].length / totalAvailable);
        return { company: c, count: Math.floor(raw), remainder: raw - Math.floor(raw) };
      });

      let allocated = targets.reduce((s, t) => s + t.count, 0);
      let remainderNeeded = targetTotal - allocated;

      targets.sort((a, b) => b.remainder - a.remainder);
      for (let i = 0; i < targets.length && remainderNeeded > 0; i++) {
        if (targets[i].count < companyPools[targets[i].company].length) { targets[i].count++; remainderNeeded--; }
      }

      targets.forEach(t => {
        const wanted = Math.min(t.count, companyPools[t.company].length);
        const taken = pickBalancedByStatus(companyPools[t.company], wanted);
        taken.forEach(row => { row[reviewerColKey] = rule.reviewer; row.reviewer = rule.reviewer; });
        if (taken.length > 0) companyBreakdown[t.company] = taken.length;
      });
    }

    const actuallyAssigned = Object.values(companyBreakdown).reduce((a, b) => a + b, 0);
    summary.push({ reviewer: rule.reviewer, companies: rule.companies, count: rule.count, assigned: actuallyAssigned, companyBreakdown });
  });

  sortParsedCsvDataByReviewer(customDistRules.map(r => r.reviewer));
  renderCsvPreview(parsedCsvData);
  renderCustomDistSummary(summary);
}

function renderCustomDistSummary(summary) {
  const container = document.getElementById('custom-dist-summary');
  const rows = summary.map(s => {
    const shortfall = s.count - s.assigned;
    const warning = shortfall > 0
      ? `<span style="color: var(--badge-hold-text);"> (${shortfall} ناقص — مكانش متاح عدد كفاية من الشركات دي غير موزّع)</span>`
      : '';
    const breakdownLine = Object.entries(s.companyBreakdown).map(([c, n]) => `${c}: ${n}`).join('، ');

    return `<div class="reviewer-stat">
      <div class="reviewer-info"><div class="name">${s.reviewer} ← (${s.companies.join(' + ')})</div><div class="total">${breakdownLine || '—'}</div></div>
      <div class="reviewer-counts"><div class="count-accepted">${s.assigned} / ${s.count} طلب</div></div>
    </div>${warning ? `<p style="font-size: 11px; margin: 2px 0 8px;">${warning}</p>` : ''}
    ${buildReviewerBreakdownHtml(s.reviewer)}`;
  }).join('');

  container.innerHTML = `
    <h4 style="font-size: 13px; margin-bottom: 8px; color: var(--text-muted);">ملخص التوزيع المخصص:</h4>
    ${rows}
  `;
}

// بيحسب توزيع طلبات مراجع معين (من الملف المرفوع حاليًا) حسب الشركة (بالنسبة%) وحسب حالة المراجعة
// (زي "تم اعادة المراجعة" و"جاري المراجعة" لو موجودين) — بيتستخدم في ملخصات كل أنواع التوزيع
function buildReviewerBreakdownHtml(reviewerUsername) {
  const rows = parsedCsvData.filter(r => (r.reviewer || r['المراجع']) === reviewerUsername);
  if (rows.length === 0) return '';

  const byCompany = {};
  const byStatus = {};
  rows.forEach(r => {
    const c = getCsvRowCompany(r);
    byCompany[c] = (byCompany[c] || 0) + 1;
    const s = r.status || r['الحالة'] || r['حالة المراجعة'] || '';
    if (s) byStatus[s] = (byStatus[s] || 0) + 1;
  });

  const companyParts = Object.entries(byCompany)
    .sort((a, b) => b[1] - a[1])
    .map(([c, n]) => `${c}: ${n} (${Math.round((n / rows.length) * 100)}%)`)
    .join('، ');

  const statusParts = Object.entries(byStatus).map(([s, n]) => `${s}: ${n}`).join('، ');

  return `<div style="font-size: 11px; color: var(--text-muted); margin: 2px 0 12px; padding-right: 4px;">
    <div>📊 توزيع الشركات (إجمالي ${reviewerUsername} الآن ${rows.length}): ${companyParts}</div>
    ${Object.keys(byStatus).length > 0 ? `<div>📋 حالات المراجعة: ${statusParts}</div>` : ''}
  </div>`;
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
  if (!canDelete()) { alert('التوزيع متاح لعمر وموندي فقط'); return; }
  if (!ensureCsvUploadDateSelected()) return;
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
  // الصفوف اللي معاها مراجع متعيّن بالفعل (زي الطلبات اللي كانت مرفوضة قبل كده واتنقل لها
  // نفس المراجع السابق تلقائيًا) بنسيبها زي ما هي، ومش بندخلها في التوزيع الجديد خالص.
  const distributableRows = parsedCsvData.filter(row => !row.reviewer && !(row['المراجع']));
  const alreadyAssignedCount = parsedCsvData.length - distributableRows.length;

  const pools = {};
  const poolOrder = [];
  distributableRows.forEach(row => {
    const company = getCompany(row);
    if (!pools[company]) { pools[company] = []; poolOrder.push(company); }
    pools[company].push(row);
  });

  // تشبيك الطلبات بالتبادل بين الشركات (Round-robin)، وبرضو بين حالات المراجعة المختلفة
  // (زي "تم المراجعة" و"جاري المراجعة") لو موجود أكتر من حالة جوه نفس الشركة، عشان كل مراجع
  // ياخد خليط متوازن مش بس من الشركات لكن من الحالات كمان.
  const companyStatusPools = {};
  distributableRows.forEach(row => {
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

  sortParsedCsvDataByReviewer(selectedUsers);
  renderCsvPreview(parsedCsvData);
  renderCsvDistSummary(counts, distributableRows.length - assignedCount + alreadyAssignedCount);
}

function renderCsvDistSummary(counts, leftoverCount) {
  const container = document.getElementById('csv-dist-summary');
  const rows = Object.keys(counts).map(name => `
    <div class="reviewer-stat">
      <div class="reviewer-info"><div class="name">${name}</div></div>
      <div class="reviewer-counts"><div class="count-accepted">${counts[name]} طلب</div></div>
    </div>
    ${buildReviewerBreakdownHtml(name)}
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
// 'id' اتشالت من هنا عن قصد: أي رفع CSV جديد لازم يبقى دايمًا إضافة (insert) لطلبات جديدة،
// مش تعديل صف موجود بالغلط لو حد رفع ملف فيه عمود id قديم (زي ملف مُصدَّر من النظام قبل كده).
const ALLOWED_ORDER_COLUMNS = ['order_number', 'company', 'reviewer', 'date', 'status', 'review_status', 'rejection_reason'];

async function uploadCsvToSupabase() {
  if (!canDelete()) { alert('رفع/توزيع الطلبات متاح لعمر وموندي فقط'); return; }
  if (parsedCsvData.length === 0) return;
  if (!ensureCsvUploadDateSelected()) return;

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
  document.getElementById('modal-review-status').value = ['مقبول', 'مرفوض', 'معلق', 'Qc'].includes(currentStatus) ? currentStatus : 'مقبول';
  document.getElementById('modal-rejection-reason').value = selectedOrder.rejection_reason || selectedOrder.reason || selectedOrder['سبب الرفض'] || '';

  document.getElementById('edit-modal').style.display = 'flex';
  toggleRejectionField();
}

function closeModal() { document.getElementById('edit-modal').style.display = 'none'; selectedOrder = null; }
function toggleRejectionField() {
  const status = document.getElementById('modal-review-status').value;
  const needsReason = (status === 'مرفوض' || status === 'معلق');
  document.getElementById('rejection-reason-group').style.display = needsReason ? 'block' : 'none';

  const label = document.getElementById('rejection-reason-label');
  const textarea = document.getElementById('modal-rejection-reason');
  if (status === 'معلق') {
    label.innerHTML = 'سبب التعليق <span style="color: #f87171;">*</span>';
    textarea.placeholder = 'اكتب سبب التعليق هنا...';
  } else {
    label.innerHTML = 'سبب الرفض <span style="color: #f87171;">*</span>';
    textarea.placeholder = 'اكتب سبب الرفض هنا...';
  }
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

  if ((newReviewStatus === 'مرفوض' || newReviewStatus === 'معلق') && !newRejectionReason) {
    alert(newReviewStatus === 'معلق' ? 'يرجى كتابة سبب التعليق' : 'يرجى كتابة سبب الرفض');
    return;
  }

  const saveBtn = document.getElementById('btn-save-modal');
  saveBtn.innerText = 'جاري الحفظ...'; saveBtn.disabled = true;

  let matchColumn = selectedOrder.id !== undefined ? 'id' : (selectedOrder['رقم الطلب'] !== undefined ? 'رقم الطلب' : 'order_number');
  let matchValue = selectedOrder[matchColumn];

  const updateData = {};
  const finalReason = (newReviewStatus === 'مرفوض' || newReviewStatus === 'معلق') ? newRejectionReason : '-';

  if ('review_status' in selectedOrder) updateData.review_status = newReviewStatus;
  if ('حالة المراجعة' in selectedOrder) updateData['حالة المراجعة'] = newReviewStatus;
  if ('rejection_reason' in selectedOrder) updateData.rejection_reason = finalReason;
  if ('سبب الرفض' in selectedOrder) updateData['سبب الرفض'] = finalReason;

  try {
    const { data: updatedRows, error } = await supabaseClient
      .from(TABLE_NAME)
      .update(updateData)
      .eq(matchColumn, matchValue)
      .select();

    if (error) {
      alert('فشل التحديث: ' + error.message);
    } else if (!updatedRows || updatedRows.length === 0) {
      // الطلب رجع "نجاح" بدون error لكن مفيش أي صف اتعدل فعليًا -
      // غالبًا صلاحيات (RLS) مانعة، أو الطلب ده مش موجود / اتغيّر بالفعل من حد تاني
      alert('لم يتم حفظ التعديل. غالبًا الطلب ده مش متاح لك للتعديل (يمكن اتنقل لمراجع تاني، أو انت مش صاحب الصلاحية عليه). حدّث الصفحة وحاول تاني.');
    } else {
      Object.assign(selectedOrder, updateData);
      updateKPIs(window.visibleData);
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
    const rawName = o.reviewer || o['المراجع'];
    if (!rawName) return;
    const name = getDisplayName(rawName);
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
    const reviewed = item.accepted + item.rejected;
    container.innerHTML += `
      <div class="reviewer-stat">
        <div class="reviewer-info">
          <div class="name">${name}</div>
          <div class="total">${item.total} طلب</div>
        </div>
        <div class="reviewer-counts">
          <div class="count-accepted">مقبول: ${item.accepted}</div>
          <div class="count-rejected">مرفوض: ${item.rejected}</div>
          <div style="color: var(--text-muted); margin-top: 4px;">تم المراجعة: ${reviewed}</div>
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

// ============ الرسوم البيانية (Overview / Companies / Reviewers) ============
let chartsInstance = null;
let currentChartView = 'overview';

// بعض الشبكات أو إضافات المتصفح (Ad-blockers) بتمنع تحميل ملفات باسم "chart.js" من مصادر معينة (زي cdnjs).
// عشان كده بنجرب أكتر من مصدر (CDN) واحد ورا التاني، وبنحمّل المكتبة بس وقت ما المستخدم يفتح شاشة الرسوم فعليًا (مش من أول ما الصفحة تفتح).
const CHARTJS_SOURCES = [
  'https://cdn.jsdelivr.net/npm/chart.js@4.4.4/dist/chart.umd.min.js',
  'https://unpkg.com/chart.js@4.4.4/dist/chart.umd.min.js',
  'https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.4/chart.umd.min.js'
];

let chartJsLoadPromise = null;

function loadScriptOnce(src) {
  return new Promise((resolve, reject) => {
    const script = document.createElement('script');
    script.src = src;
    script.async = true;
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      script.remove();
      reject(new Error('انتهت المهلة أثناء تحميل: ' + src));
    }, 8000);
    script.onload = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve();
    };
    script.onerror = () => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      script.remove();
      reject(new Error('فشل تحميل: ' + src));
    };
    document.head.appendChild(script);
  });
}

function loadChartJsLibrary() {
  if (typeof Chart !== 'undefined') return Promise.resolve();
  if (chartJsLoadPromise) return chartJsLoadPromise;

  chartJsLoadPromise = (async () => {
    for (const src of CHARTJS_SOURCES) {
      try {
        await loadScriptOnce(src);
        if (typeof Chart !== 'undefined') return;
      } catch (e) { /* نجرب المصدر اللي بعده */ }
    }
    chartJsLoadPromise = null; // نسمح بإعادة المحاولة تاني لو المستخدم دوس "إعادة المحاولة"
    throw new Error('تعذر تحميل مكتبة الرسوم البيانية من كل المصادر المتاحة.');
  })();

  return chartJsLoadPromise;
}

const CHART_COLORS = {
  'مقبول': '#34d399',
  'مرفوض': '#f87171',
  'معلق': '#fbbf24',
  'Qc': '#c084fc',
  'لم يتم المراجعة': '#60a5fa'
};

function getCssVar(name) {
  return getComputedStyle(document.documentElement).getPropertyValue(name).trim();
}

// بيانات الرسوم البيانية: للأدمن كل بيانات التاريخ المحدد، للمراجع العادي بياناته هو بس (نفس منطق الـ KPIs)
function getChartsDataScope() {
  if (currentUser && currentUser.role === 'admin') return window.allData || [];
  return window.visibleData || [];
}

async function openChartsModal() {
  document.getElementById('charts-modal').style.display = 'flex';
  document.getElementById('charts-title').innerText = 'الرسوم البيانية';
  document.getElementById('charts-subtitle').innerText = '';

  const wrap = document.getElementById('charts-canvas-wrap');
  wrap.innerHTML = '<div style="display:flex; align-items:center; justify-content:center; height:100%; color:var(--text-muted); font-size:13px;">⏳ جاري تحميل مكتبة الرسوم البيانية...</div>';

  try {
    await loadChartJsLibrary();
  } catch (err) {
    wrap.innerHTML = `
      <div style="display:flex; flex-direction:column; align-items:center; justify-content:center; height:100%; gap:12px; color:var(--text-muted); font-size:13px; text-align:center; padding: 0 20px;">
        <span>تعذر تحميل مكتبة الرسوم البيانية. تأكد من اتصال الإنترنت، أو جرّب توقف أي إضافة حظر إعلانات (Ad-blocker) لهذا الموقع، وحاول تاني.</span>
        <button class="btn btn-secondary" style="width:auto; padding:6px 16px;" onclick="openChartsModal()">🔄 إعادة المحاولة</button>
      </div>`;
    return;
  }

  wrap.innerHTML = '<canvas id="charts-canvas"></canvas>';
  showChartView('overview');
}

function closeChartsModal() {
  document.getElementById('charts-modal').style.display = 'none';
  if (chartsInstance) { chartsInstance.destroy(); chartsInstance = null; }
}

function setActiveChartButton(view) {
  ['overview', 'companies', 'reviewers'].forEach(v => {
    const btn = document.getElementById('chart-view-btn-' + v);
    if (!btn) return;
    btn.classList.remove('btn-primary', 'btn-secondary');
    btn.classList.add(v === view ? 'btn-primary' : 'btn-secondary');
  });
}

function showChartView(view) {
  currentChartView = view;
  setActiveChartButton(view);

  if (chartsInstance) { chartsInstance.destroy(); chartsInstance = null; }

  const canvas = document.getElementById('charts-canvas');
  const ctx = canvas.getContext('2d');
  const data = getChartsDataScope();

  if (view === 'overview') renderOverviewChart(ctx, data);
  else if (view === 'companies') renderGroupedChart(ctx, data, o => (o.company || o['الشركة'] || '').toString().trim(), 'توزيع الطلبات حسب الشركات');
  else if (view === 'reviewers') renderGroupedChart(ctx, data, o => getDisplayName(o.reviewer || o['المراجع'] || ''), 'توزيع الطلبات حسب المراجعين');
}

function getStatusCounts(data) {
  const counts = { 'مقبول': 0, 'مرفوض': 0, 'معلق': 0, 'Qc': 0, 'لم يتم المراجعة': 0 };
  data.forEach(o => {
    const s = o.review_status || o['حالة المراجعة'] || 'لم يتم المراجعة';
    if (counts[s] !== undefined) counts[s]++;
    else counts['لم يتم المراجعة']++;
  });
  return counts;
}

function renderOverviewChart(ctx, data) {
  const textColor = getCssVar('--text-main');
  const counts = getStatusCounts(data);
  const labels = Object.keys(counts);

  document.getElementById('charts-title').innerText = '📊 نظرة عامة على الطلبات';
  document.getElementById('charts-subtitle').innerText = `إجمالي الطلبات المعروضة: ${data.length.toLocaleString('ar-EG')}`;

  chartsInstance = new Chart(ctx, {
    type: 'doughnut',
    data: {
      labels,
      datasets: [{
        data: labels.map(l => counts[l]),
        backgroundColor: labels.map(l => CHART_COLORS[l]),
        borderColor: getCssVar('--card-bg'),
        borderWidth: 2
      }]
    },
    options: {
      responsive: true,
      maintainAspectRatio: false,
      plugins: {
        legend: { position: 'bottom', labels: { color: textColor, font: { family: 'Cairo' } } },
        tooltip: { rtl: true, bodyFont: { family: 'Cairo' }, titleFont: { family: 'Cairo' } }
      }
    }
  });
}

function buildGroupStats(data, keyFn) {
  const stats = {};
  data.forEach(o => {
    const key = keyFn(o);
    if (!key) return;
    const revStatus = o.review_status || o['حالة المراجعة'] || 'لم يتم المراجعة';
    if (!stats[key]) stats[key] = { 'مقبول': 0, 'مرفوض': 0, 'معلق': 0, 'Qc': 0, 'لم يتم المراجعة': 0, total: 0 };
    stats[key].total++;
    if (stats[key][revStatus] !== undefined) stats[key][revStatus]++;
    else stats[key]['لم يتم المراجعة']++;
  });
  return stats;
}

function renderGroupedChart(ctx, data, keyFn, titleText) {
  const textColor = getCssVar('--text-main');
  const gridColor = getCssVar('--card-border');

  const stats = buildGroupStats(data, keyFn);
  const keys = Object.keys(stats).sort((a, b) => stats[b].total - stats[a].total).slice(0, 20);

  document.getElementById('charts-title').innerText = titleText.includes('الشركات') ? '🏢 ' + titleText : '👤 ' + titleText;
  document.getElementById('charts-subtitle').innerText = keys.length ? `أعلى ${keys.length} عنصر حسب عدد الطلبات` : 'لا توجد بيانات كافية لعرضها';

  const statusLabels = ['مقبول', 'مرفوض', 'معلق', 'Qc', 'لم يتم المراجعة'];

  chartsInstance = new Chart(ctx, {
    type: 'bar',
    data: {
      labels: keys,
      datasets: statusLabels.map(status => ({
        label: status,
        data: keys.map(k => stats[k][status]),
        backgroundColor: CHART_COLORS[status]
      }))
    },
    options: {
      indexAxis: 'y',
      responsive: true,
      maintainAspectRatio: false,
      scales: {
        x: { stacked: true, ticks: { color: textColor, font: { family: 'Cairo' } }, grid: { color: gridColor } },
        y: { stacked: true, ticks: { color: textColor, font: { family: 'Cairo' } }, grid: { display: false } }
      },
      plugins: {
        legend: { position: 'bottom', labels: { color: textColor, font: { family: 'Cairo' } } },
        tooltip: { rtl: true, bodyFont: { family: 'Cairo' }, titleFont: { family: 'Cairo' } }
      }
    }
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
    const reviewer = getDisplayName(order.reviewer || order['المراجع'] || '-');
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
    const rawName = o.reviewer || o['المراجع'];
    if (!rawName) return;
    const name = getDisplayName(rawName);
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
    'تم المراجعة': stats[name].accepted + stats[name].rejected,
    'مقبول': stats[name].accepted,
    'مرفوض': stats[name].rejected,
    'لم يتم المراجعة': stats[name].pending
  }));

  if (rows.length === 0) {
    alert('لا يوجد مراجعين لتصدير إحصائياتهم.');
    return;
  }

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 20 }, { wch: 16 }, { wch: 14 }, { wch: 12 }, { wch: 12 }, { wch: 16 }];

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
      const { data, error } = await supabaseClient.from(CERT_TABLE_NAME).select('*').order('id', { ascending: true }).range(from, from + step - 1);
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

  const reviewerSelect = document.getElementById('cert-modal-reviewer');
  if (reviewerSelect) {
    reviewerSelect.innerHTML = `<option value="">اختر المراجع...</option>` +
      ALL_PROFILES.map(p => `<option value="${p.username}">${p.name}${p.role === 'admin' ? ' (أدمن)' : ''}</option>`).join('');
  }

  const rejectionsReviewerFilter = document.getElementById('rejections-reviewer-filter');
  if (rejectionsReviewerFilter) {
    rejectionsReviewerFilter.innerHTML = `<option value="ALL">كل المراجعين</option>` +
      ALL_PROFILES.map(p => `<option value="${p.username}">${p.name}${p.role === 'admin' ? ' (أدمن)' : ''}</option>`).join('');
  }
}

// ============ تاب مرفوضات (يظهر للكل - مراجع وأدمن) ============
let rejectionsAllData = [];

function toggleRejectionsStatsSidebar() {
  document.getElementById('rejections-stats-sidebar').classList.toggle('active');
}

function getRejectedCertRows() {
  return (certMasterData || []).filter(o => o.status === 'مرفوض');
}

function applyRejectionsDateFiltering() {
  const rejected = getRejectedCertRows();

  if (rejected.length === 0) {
    rejectionsAllData = [];
    document.getElementById('rejections-active-date-label').innerText = 'لا يوجد طلبات مرفوضة';
    renderRejectionsTab();
    return;
  }

  const dateInput = document.getElementById('rejections-date-filter').value;
  let targetDate = dateInput;

  if (!targetDate) {
    const dates = rejected.map(extractDateString).filter(Boolean).sort().reverse();
    targetDate = dates[0] || '';
    if (targetDate) document.getElementById('rejections-date-filter').value = targetDate;
  }

  rejectionsAllData = rejected.filter(item => {
    const d = extractDateString(item);
    return d === targetDate || !d;
  });
  document.getElementById('rejections-active-date-label').innerText = targetDate
    ? `يعرض مرفوضات تاريخ: ${targetDate} (+ الطلبات بدون تاريخ)`
    : 'يعرض كل الطلبات المرفوضة (بدون تاريخ)';

  renderRejectionsTab();
}

function onRejectionsDateFilterChange() { applyRejectionsDateFiltering(); }
function resetRejectionsDateToLatest() { document.getElementById('rejections-date-filter').value = ''; applyRejectionsDateFiltering(); }

function getFilteredRejectionsRows() {
  const searchValue = (document.getElementById('rejections-search-input').value || '').trim().toLowerCase();
  const reviewerValue = document.getElementById('rejections-reviewer-filter').value;
  const substatusValue = document.getElementById('rejections-substatus-filter').value;

  let rows = rejectionsAllData || [];

  if (reviewerValue && reviewerValue !== 'ALL') {
    rows = rows.filter(o => o.reviewer === reviewerValue || getDisplayName(o.reviewer) === getDisplayName(reviewerValue));
  }
  if (substatusValue === 'PENDING') {
    rows = rows.filter(o => !o.reviewer_action);
  } else if (substatusValue && substatusValue !== 'ALL') {
    rows = rows.filter(o => o.reviewer_action === substatusValue);
  }
  if (searchValue) {
    rows = rows.filter(o => String(o.order_number || '').toLowerCase().includes(searchValue));
  }
  return rows;
}

function renderRejectionsTab() {
  const tbody = document.getElementById('rejections-tbody');
  if (!tbody) return;

  const rows = getFilteredRejectionsRows();
  const isAdmin = currentUser && currentUser.role === 'admin';

  document.getElementById('rejections-stat-total').innerText = rows.length;

  if (rows.length === 0) {
    tbody.innerHTML = `<tr><td colspan="7" style="text-align:center;">لا توجد طلبات مرفوضة مطابقة</td></tr>`;
  } else {
    tbody.innerHTML = rows.map(o => {
      const orderNum = o.order_number || '-';
      const layout = getDisplayName(o.Layout || o.layout) || '-';
      const reviewerProfile = ALL_PROFILES.find(p => p.username === o.reviewer);
      const reviewerName = reviewerProfile ? reviewerProfile.name : (o.reviewer || '-');
      const reason = o.reason && o.reason !== '-' ? o.reason : '-';
      const date = o.date || extractDateString(o) || '-';

      let substatusBadge = `<span class="badge badge-hold">بانتظار المراجع</span>`;
      if (o.reviewer_action === 'تم التعديل') substatusBadge = `<span class="badge badge-accepted">تم التعديل</span>`;
      else if (o.reviewer_action === 'تم الرفض للشركة') substatusBadge = `<span class="badge badge-rejected">تم الرفض للشركة</span>`;

      const isOwnReviewer = currentUser && (o.reviewer === currentUser.username);
      let actionsHtml = '';

      if (isOwnReviewer || isAdmin) {
        actionsHtml += `
          <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 11px;" onclick="setRejectionReviewerAction('${orderNum}', 'تم التعديل')">✅ تم التعديل</button>
          <button class="btn btn-danger" style="padding: 4px 8px; font-size: 11px;" onclick="setRejectionReviewerAction('${orderNum}', 'تم الرفض للشركة')">🚫 رفض نهائي</button>`;
      }
      if (isAdmin) {
        actionsHtml += `
          <button class="btn btn-open" style="padding: 4px 8px; font-size: 11px;" onclick="setRejectionPrinted('${orderNum}')">🖨️ تم الطباعة</button>
          <button class="btn btn-secondary" style="padding: 4px 8px; font-size: 11px;" onclick="openCertEditModal('${orderNum}')">✏️ رفض تاني / تعديل</button>`;
      }
      if (!actionsHtml) actionsHtml = '-';

      return `
        <tr>
          <td class="order-no-cell">${orderNum}</td>
          <td>${layout}</td>
          <td>${reviewerName}</td>
          <td>${reason}</td>
          <td>${date}</td>
          <td>${substatusBadge}</td>
          <td style="display:flex; gap:6px; flex-wrap:wrap;">${actionsHtml}</td>
        </tr>`;
    }).join('');
  }

  renderRejectionsReviewerStats();
}

async function setRejectionReviewerAction(orderNum, action) {
  const row = (certMasterData || []).find(o => String(o.order_number) === String(orderNum));
  if (!row) return;
  try {
    const { error } = await supabaseClient.from(CERT_TABLE_NAME).update({ reviewer_action: action }).eq('id', row.id);
    if (error) { alert('فشل التحديث: ' + error.message); return; }
    row.reviewer_action = action;
    renderRejectionsTab();
  } catch (err) {
    alert('خطأ: ' + err.message);
  }
}

async function setRejectionPrinted(orderNum) {
  const row = (certMasterData || []).find(o => String(o.order_number) === String(orderNum));
  if (!row) return;
  if (!confirm(`تأكيد تحويل حالة الطلب ${orderNum} إلى "تم الطباعة"؟`)) return;
  try {
    const updateData = { status: 'تم الطباعة', reason: '-', reviewer_action: null };
    const { error } = await supabaseClient.from(CERT_TABLE_NAME).update(updateData).eq('id', row.id);
    if (error) { alert('فشل التحديث: ' + error.message); return; }
    Object.assign(row, updateData);
    applyCertDateFiltering();
    applyRejectionsDateFiltering();
  } catch (err) {
    alert('خطأ: ' + err.message);
  }
}

function exportRejectionsOrderNumbers() {
  const rows = getFilteredRejectionsRows();
  if (rows.length === 0) { alert('لا توجد طلبات مطابقة للتصدير'); return; }

  const exportRows = rows.map(o => ({ 'رقم الطلب': o.order_number || '-' }));
  const worksheet = XLSX.utils.json_to_sheet(exportRows);
  worksheet['!cols'] = [{ wch: 28 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'أرقام الطلبات المرفوضة');

  const substatusValue = document.getElementById('rejections-substatus-filter').value;
  const substatusLabel = (substatusValue && substatusValue !== 'ALL') ? `_${substatusValue === 'PENDING' ? 'بانتظار_المراجع' : substatusValue}` : '';
  const dateLabel = document.getElementById('rejections-date-filter').value || 'غير محدد';

  XLSX.writeFile(workbook, `مرفوضات${substatusLabel}_${dateLabel}.xlsx`);
}

function renderRejectionsReviewerStats() {
  const container = document.getElementById('rejections-reviewer-stats');
  if (!container) return;

  const counts = {};
  (rejectionsAllData || []).forEach(o => {
    const reviewerProfile = ALL_PROFILES.find(p => p.username === o.reviewer);
    const reviewerName = reviewerProfile ? reviewerProfile.name : (o.reviewer || 'غير محدد');
    counts[reviewerName] = (counts[reviewerName] || 0) + 1;
  });

  const names = Object.keys(counts).sort((a, b) => counts[b] - counts[a]);
  if (names.length === 0) {
    container.innerHTML = '<p style="font-size:12px; color:var(--text-muted);">لا يوجد رفض مسجل لهذا التاريخ</p>';
    return;
  }

  container.innerHTML = names.map(name => `
    <div class="reviewer-stat">
      <div class="reviewer-info"><div class="name">${name}</div></div>
      <div class="reviewer-counts"><div class="count-rejected">${counts[name]} طلب</div></div>
    </div>
  `).join('');
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

// ============ تحديد متعدد عن طريق لصق أرقام طلبات أو رفع ملف (تاب الشهادات) ============
let certMultiSelectFileRows = [];

function toggleCertMultiSelectPanel() {
  const panel = document.getElementById('cert-multiselect-panel');
  panel.style.display = (panel.style.display === 'none' || !panel.style.display) ? 'block' : 'none';
}

function clearCertMultiSelectInput() {
  document.getElementById('cert-multiselect-textarea').value = '';
  document.getElementById('cert-multiselect-file-name').innerText = '';
  document.getElementById('cert-multiselect-results').innerHTML = '';
  certMultiSelectFileRows = [];
}

function handleCertMultiSelectDragOver(event) {
  event.preventDefault();
  event.stopPropagation();
  document.getElementById('cert-multiselect-dropzone').classList.add('drag-over');
}

function handleCertMultiSelectDragLeave(event) {
  event.preventDefault();
  event.stopPropagation();
  document.getElementById('cert-multiselect-dropzone').classList.remove('drag-over');
}

function handleCertMultiSelectDrop(event) {
  event.preventDefault();
  event.stopPropagation();
  document.getElementById('cert-multiselect-dropzone').classList.remove('drag-over');
  const files = event.dataTransfer && event.dataTransfer.files;
  if (files && files.length > 0) processCertMultiSelectFile(files[0]);
}

function handleCertMultiSelectFileSelect(event) {
  const file = event.target.files && event.target.files[0];
  if (file) processCertMultiSelectFile(file);
  event.target.value = '';
}

async function processCertMultiSelectFile(file) {
  const name = file.name.toLowerCase();
  if (!name.endsWith('.csv') && !name.endsWith('.xlsx') && !name.endsWith('.xls')) {
    alert('برجاء رفع ملف CSV أو Excel بس');
    return;
  }

  document.getElementById('cert-multiselect-file-name').innerText = `جاري قراءة: ${file.name} ...`;

  try {
    const rawRows = await parseFileToRows(file);
    const extracted = extractOrderNumbersFromRows(rawRows);
    if (extracted.length === 0) {
      alert('معرفتش ألاقي عمود رقم الطلب في الملف ده. تأكد إن اسم العمود واحد من: رقم الطلب / order_number / requestnumber.');
      document.getElementById('cert-multiselect-file-name').innerText = '';
      return;
    }
    certMultiSelectFileRows = extracted;
    document.getElementById('cert-multiselect-file-name').innerText = `تم رفع: ${file.name} (${extracted.length} رقم)`;
  } catch (err) {
    alert('تعذّر قراءة الملف: ' + err.message);
  }
}

// بيدور على أرقام الطلبات (من المربع + الملف) داخل التاريخ المعروض حاليًا بس، ويحددهم تلقائيًا (checkboxes)
// من غير ما يعمل أي Sort أو تغيير في ترتيب الجدول نفسه.
function verifyAndSelectCertOrders() {
  const textValue = document.getElementById('cert-multiselect-textarea').value;
  const fromText = textValue.split(/[\n,،]+/).map(s => s.trim()).filter(Boolean);
  const combined = [...new Set([...fromText, ...certMultiSelectFileRows])];

  if (combined.length === 0) {
    alert('برجاء إدخال أرقام طلبات أو رفع ملف أولاً.');
    return;
  }

  if (!certAllData || certAllData.length === 0) {
    alert('لا يوجد بيانات محمّلة حاليًا للتاريخ المحدد.');
    return;
  }

  const availableNumbers = new Set(certAllData.map(o => String(o.order_number)));
  const found = [];
  const notFound = [];

  combined.forEach(num => {
    if (availableNumbers.has(num)) {
      found.push(num);
      selectedCertOrderNumbers.add(num);
    } else {
      notFound.push(num);
    }
  });

  updateCertSelectedCount();
  renderCertPage(); // بيعيد رسم نفس البيانات بنفس الترتيب، بس الـ checkboxes بتتظبط تلقائيًا حسب التحديد

  const resultsEl = document.getElementById('cert-multiselect-results');
  let html = `<p style="color: var(--badge-accept-text); font-weight:700;">✅ تم تحديد ${found.length} طلب بنجاح (من أصل ${combined.length} رقم مُدخل).</p>`;
  if (notFound.length > 0) {
    html += `<p style="color: var(--badge-reject-text); font-weight:700; margin-top:8px;">⚠️ ${notFound.length} رقم مش موجود في التاريخ المعروض حاليًا:</p>`;
    html += `<div style="max-height:100px; overflow-y:auto; font-size:12px; color: var(--text-muted); background: var(--card-bg); border: 1px solid var(--card-border); border-radius: 6px; padding: 8px; margin-top:6px;">${notFound.join('، ')}</div>`;
  }
  resultsEl.innerHTML = html;
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
    const matchesLayout = (layoutValue === 'ALL')
      || (layoutValue === 'UNASSIGNED' ? !layout
        : (layout === layoutValue || getDisplayName(layout) === getDisplayName(layoutValue)));
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
    const layout = rawLayout ? getDisplayName(rawLayout) : 'غير موزعة';
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
        <td class="sticky-action-col">${canDelete() ? `<button class="btn-delete-row" onclick="deleteSingleCertOrder('${orderNum}')">🗑️ مسح</button>` : ''}</td>
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

// تصدير أرقام الطلبات المحددة فقط (بدون باقي الأعمدة) - Excel أو TXT
function getSelectedCertExportFileLabel() {
  const layoutFilterValue = document.getElementById('cert-layout-filter').value;
  const nameLabel = (layoutFilterValue && layoutFilterValue !== 'ALL' && layoutFilterValue !== 'UNASSIGNED') ? `_${layoutFilterValue}` : '';
  const dateLabel = document.getElementById('cert-date-filter').value || 'غير محدد';
  return `ارقام_الطلبات${nameLabel}_${dateLabel}`;
}

function exportSelectedCertOrderNumbers() {
  if (selectedCertOrderNumbers.size === 0) { alert('برجاء تحديد طلب واحد على الأقل للتصدير'); return; }

  const orderNumbers = Array.from(selectedCertOrderNumbers);
  const rows = orderNumbers.map(num => ({ 'رقم الطلب': num }));

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 28 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'أرقام الطلبات');

  XLSX.writeFile(workbook, `${getSelectedCertExportFileLabel()}.xlsx`);
}

// نفس التصدير بس كملف TXT، رقم طلب في كل سطر (من غير عناوين أو أي تنسيق إضافي)
function exportSelectedCertOrderNumbersTxt() {
  if (selectedCertOrderNumbers.size === 0) { alert('برجاء تحديد طلب واحد على الأقل للتصدير'); return; }

  const orderNumbers = Array.from(selectedCertOrderNumbers);
  const content = orderNumbers.join('\r\n');

  // \uFEFF: BOM عشان الأحرف العربية والأرقام تظهر صح لو الملف اتفتح في Notepad على ويندوز
  const blob = new Blob(['\uFEFF' + content], { type: 'text/plain;charset=utf-8' });
  const url = URL.createObjectURL(blob);

  const link = document.createElement('a');
  link.href = url;
  link.download = `${getSelectedCertExportFileLabel()}.txt`;
  document.body.appendChild(link);
  link.click();
  document.body.removeChild(link);
  URL.revokeObjectURL(url);
}


async function executeCertBulkReassign() {
  if (!canDelete()) { alert('التوزيع متاح لعمر وموندي فقط'); return; }
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
  if (!canDelete()) { alert('هذا الإجراء متاح لعمر وموندي فقط'); return; }
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
  if (!canDelete()) { alert('هذا الإجراء متاح لعمر وموندي فقط'); return; }
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
  document.getElementById('cert-modal-reviewer').value = selectedCertOrder.reviewer || '';
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
  document.getElementById('cert-reviewer-group').style.display = CERT_REVIEWER_REQUIRED_STATUSES.includes(status) ? 'block' : 'none';
}

async function saveCertUpdate() {
  if (!selectedCertOrder) return;

  const newStatus = document.getElementById('cert-modal-status').value;
  const newLayout = document.getElementById('cert-modal-layout').value;
  const newReason = document.getElementById('cert-modal-reason').value.trim();
  const newReviewer = document.getElementById('cert-modal-reviewer').value;
  const newDate = document.getElementById('cert-modal-date').value;

  if (CERT_REASON_REQUIRED_STATUSES.includes(newStatus) && !newReason) {
    alert('برجاء كتابة السبب.');
    return;
  }

  if (CERT_REVIEWER_REQUIRED_STATUSES.includes(newStatus) && !newReviewer) {
    alert('برجاء اختيار المراجع.');
    return;
  }

  const saveBtn = document.getElementById('cert-btn-save-modal');
  saveBtn.innerText = 'جاري الحفظ...';
  saveBtn.disabled = true;

  const updateData = {
    status: newStatus,
    Layout: newLayout,
    reason: CERT_REASON_REQUIRED_STATUSES.includes(newStatus) ? newReason : '-',
    reviewer: CERT_REVIEWER_REQUIRED_STATUSES.includes(newStatus) ? newReviewer : null,
    reviewer_action: null,
    date: newDate || null
  };

  try {
    const { error } = await supabaseClient.from(CERT_TABLE_NAME).update(updateData).eq('id', selectedCertOrder.id);
    if (error) {
      alert('فشل التحديث: ' + error.message);
    } else {
      Object.assign(selectedCertOrder, updateData);
      applyCertDateFiltering();
      applyRejectionsDateFiltering();
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
document.getElementById('company-filter').addEventListener('change', () => { currentPage = 1; renderCurrentPage(); });

// ============================================================
// ترتيب الطلبات بعد أي توزيع (متوازن أو مخصص) بحيث طلبات كل مراجع
// تبقى مجمّعة ورا بعض، مش متفرقة في الملف. الترتيب بين المراجعين نفسهم
// بيتبع preferredOrder (نفس ترتيب اختيارهم في الواجهة)، والطلبات اللي
// لسه من غير مراجع بتتحط في الآخر.
// ============================================================
function sortParsedCsvDataByReviewer(preferredOrder) {
  if (!parsedCsvData || parsedCsvData.length === 0) return;

  const reviewerColKey = (parsedCsvData[0] && 'المراجع' in parsedCsvData[0]) ? 'المراجع' : 'reviewer';
  const orderIndex = {};
  (preferredOrder || []).forEach((u, i) => { if (!(u in orderIndex)) orderIndex[u] = i; });

  const rankOf = (row) => {
    const val = row.reviewer || row[reviewerColKey];
    if (!val) return Infinity; // غير الموزّع في آخر الملف دايمًا
    return (val in orderIndex) ? orderIndex[val] : Object.keys(orderIndex).length;
  };

  parsedCsvData = parsedCsvData
    .map((row, i) => ({ row, i }))
    .sort((a, b) => (rankOf(a.row) - rankOf(b.row)) || (a.i - b.i))
    .map(x => x.row);
}

// ============================================================
// تصدير معاينة التوزيع كملف Excel - قبل أي رفع فعلي لـ Supabase.
// بيصدّر الملف بالحالة الحالية بالظبط (بعد أي توزيع متوازن/مخصص/يدوي عملته)،
// عشان تراجعه أو تبعته لحد تاني قبل ما تأكد الرفع.
// ============================================================
function exportCsvPreviewToExcel() {
  if (!parsedCsvData || parsedCsvData.length === 0) {
    alert('لا يوجد بيانات لتصديرها. ارفع ملف أولاً.');
    return;
  }

  const reviewerColKey = (parsedCsvData[0] && 'المراجع' in parsedCsvData[0]) ? 'المراجع' : 'reviewer';

  const rows = parsedCsvData.map(row => {
    const orderNum = row.order_number || row['رقم الطلب'] || '-';
    const company = getCsvRowCompany(row);
    const reviewerRaw = row.reviewer || row[reviewerColKey];
    const reviewer = reviewerRaw ? getDisplayName(reviewerRaw) : 'غير موزّع';
    const date = row.date || row['التاريخ'] || '-';
    const status = row.status || row['الحالة'] || row['حالة المراجعة'] || '-';

    return {
      'رقم الطلب': orderNum,
      'الشركة': company,
      'المراجع': reviewer,
      'حالة المراجعة': status,
      'التاريخ': date
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 24 }, { wch: 22 }, { wch: 16 }, { wch: 18 }, { wch: 12 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'معاينة التوزيع');

  const now = new Date();
  const stamp = `${now.getFullYear()}-${String(now.getMonth() + 1).padStart(2, '0')}-${String(now.getDate()).padStart(2, '0')}`;
  XLSX.writeFile(workbook, `معاينة_التوزيع_${stamp}.xlsx`);
}

// ============================================================
// تحميل طلبات المراجع الحالي بس (باسم الحالة، تاريخ المراجعة، وسبب الرفض)
// متاحة لأي حد مسجل دخول - مراجع أو أدمن - وبتاخد بس طلباته هو، حتى لو أدمن.
// ============================================================
function exportMyOrdersToExcel() {
  if (!currentUser) {
    alert('لازم تكون مسجل دخول الأول.');
    return;
  }
  if (!window.allData || window.allData.length === 0) {
    alert('لا يوجد طلبات محمّلة حاليًا في التاريخ المحدد.');
    return;
  }

  const myOrders = window.allData.filter(order => {
    const reviewerName = order.reviewer || order['المراجع'];
    return reviewerName === currentUser.username || reviewerName === currentUser.name;
  });

  if (myOrders.length === 0) {
    alert('لا يوجد طلبات موزّعة عليك في التاريخ المحدد حاليًا.');
    return;
  }

  const dateLabel = document.getElementById('date-filter').value || 'غير محدد';

  const rows = myOrders.map(order => {
    const orderNum = order.order_number || order.order_no || order['رقم الطلب'] || '-';
    const company = order.company || order['الشركة'] || '-';
    const progressStatus = order.status || order['الحالة'] || '-';
    const reviewStatus = order.review_status || order['حالة المراجعة'] || 'لم يتم المراجعة';
    const date = order.date || extractDateString(order) || '-';
    const rejectionReason = order.rejection_reason || order.reason || order['سبب الرفض'] || '-';

    return {
      'رقم الطلب': orderNum,
      'الشركة': company,
      'حالة المراجعة': progressStatus,
      'المراجعة': reviewStatus,
      'التاريخ': date,
      'سبب الرفض': rejectionReason
    };
  });

  const worksheet = XLSX.utils.json_to_sheet(rows);
  worksheet['!cols'] = [{ wch: 24 }, { wch: 22 }, { wch: 18 }, { wch: 16 }, { wch: 12 }, { wch: 30 }];

  const workbook = XLSX.utils.book_new();
  XLSX.utils.book_append_sheet(workbook, worksheet, 'طلباتي');
  XLSX.writeFile(workbook, `طلبات_${currentUser.name}_${dateLabel}.xlsx`);
}
