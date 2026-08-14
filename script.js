const SUPABASE_URL = 'https://gnpejzuxwqftxgfcsics.supabase.co';
const SUPABASE_ANON_KEY = 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImducGVqenV4d3FmdHhnZmNzaWNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MzU3ODYsImV4cCI6MjEwMjIxMTc4Nn0.4nrBcwRm4W51EX8_QtGvTrkwLFVjtiomPXyDU0N1mTQ';
const TABLE_NAME = 'system_review1';
  
const USERS_DB = {
  "عمر": { password: "123", role: "admin", name: "عمر" },
  "موندي": { password: "123", role: "admin", name: "موندي" },
  "مؤمن": { password: "123", role: "admin", name: "مؤمن" },
  "ابو هيبة": { password: "123", role: "admin", name: "ابو هيبة" },
  "دينا": { password: "123", role: "admin", name: "دينا" },
  "سرحان": { password: "123", role: "admin", name: "سرحان" },
  "روان": { password: "123", role: "admin", name: "روان" },
   
  "ادهم": { password: "123", role: "reviewer", name: "ادهم" },
  "يوسف": { password: "123", role: "reviewer", name: "يوسف" },
  "عمر جابر": { password: "123", role: "reviewer", name: "عمر جابر" },
  "نيره": { password: "123", role: "reviewer", name: "نيره" },
  "مريم": { password: "123", role: "reviewer", name: "مريم" },
  "ايمان": { password: "123", role: "reviewer", name: "ايمان" },
  "ايه": { password: "123", role: "reviewer", name: "ايه" },
  "رحمه": { password: "123", role: "reviewer", name: "رحمه" },
  "زبادي": { password: "123", role: "reviewer", name: "زبادي" },
  "عمرو": { password: "123", role: "reviewer", name: "عمرو" },
  "كريم": { password: "123", role: "reviewer", name: "كريم" },
  "علي": { password: "123", role: "reviewer", name: "علي" }
};

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
let selectedOrderNumbers = new Set();

window.addEventListener('DOMContentLoaded', () => {
  supabaseClient = supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);
  applyThemeIcon();

  const savedUser = localStorage.getItem('system_user');
  if (savedUser) {
    const userObj = JSON.parse(savedUser);
    setupUserSession(userObj.username, userObj);
  }
});

function toggleSidebar() {
  const sidebar = document.getElementById('reviewer-sidebar');
  sidebar.classList.toggle('active');
}

function handleLogin() {
  const username = document.getElementById('login-username').value.trim();
  const password = document.getElementById('login-password').value.trim();
  const errEl = document.getElementById('login-error');

  errEl.style.display = 'none';

  if (!username || !password) {
    errEl.innerText = 'يرجى كتابة اسم المستخدم وكلمة المرور';
    errEl.style.display = 'block';
    return;
  }

  const user = USERS_DB[username];

  if (user && user.password === password) {
    localStorage.setItem('system_user', JSON.stringify({ username, ...user }));
    setupUserSession(username, user);
  } else {
    errEl.innerText = 'اسم المستخدم أو كلمة المرور غير صحيحة';
    errEl.style.display = 'block';
  }
}

function setupUserSession(username, userInfo) {
  currentUser = { username, ...userInfo };
  
  document.getElementById('login-screen').style.display = 'none';
  document.getElementById('app-content').style.display = 'block';
  document.getElementById('user-welcome-text').innerText = `مرحباً بك: ${userInfo.name} (${userInfo.role === 'admin' ? 'أدمن' : 'مراجع'})`;

  const isAdmin = userInfo.role === 'admin';
  document.getElementById('admin-tab-btn').style.display = isAdmin ? 'block' : 'none';
  document.getElementById('select-all-header').style.display = isAdmin ? 'table-cell' : 'none';
  document.getElementById('admin-action-header').style.display = isAdmin ? 'table-cell' : 'none';
  document.getElementById('admin-bulk-bar').style.display = isAdmin ? 'flex' : 'none';

  populateReviewerDropdowns();
  loadData();
}

function populateReviewerDropdowns() {
  const filterSelect = document.getElementById('reviewer-filter');
  const reassignSelect = document.getElementById('bulk-reassign-select');

  filterSelect.innerHTML = `<option value="ALL">كل المراجعين</option>`;
  reassignSelect.innerHTML = `<option value="">تغيير المراجع إلى...</option>`;

  Object.keys(USERS_DB).forEach(key => {
    if (USERS_DB[key].role === 'reviewer') {
      filterSelect.innerHTML += `<option value="${key}">${key}</option>`;
      reassignSelect.innerHTML += `<option value="${key}">${key}</option>`;
    }
  });
}

function handleLogout() {
  localStorage.removeItem('system_user');
  location.reload();
}

function switchTab(tabName) {
  document.querySelectorAll('.tab-btn').forEach(btn => btn.classList.remove('active'));
  if (tabName === 'dashboard') {
    document.querySelectorAll('.tab-btn')[0].classList.add('active');
    document.getElementById('tab-dashboard').style.display = 'block';
    document.getElementById('tab-admin').style.display = 'none';
  } else {
    document.querySelectorAll('.tab-btn')[1].classList.add('active');
    document.getElementById('tab-dashboard').style.display = 'none';
    document.getElementById('tab-admin').style.display = 'block';
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
    const isAdminUser = currentUser && currentUser.role === 'admin';
    const sourceForDates = isAdminUser
      ? window.masterData
      : window.masterData.filter(item => {
          const reviewerName = item.reviewer || item['المراجع'] || '';
          return reviewerName === currentUser.username || reviewerName === currentUser.name;
        });
    const dates = sourceForDates.map(extractDateString).filter(Boolean).sort().reverse();
    targetDate = dates[0] || '';
    if (targetDate) document.getElementById('date-filter').value = targetDate;
  }

  window.allData = window.masterData.filter(item => extractDateString(item) === targetDate);

  // تقييد الصلاحيات: المراجع (غير الأدمن) يشوف طلباته هو فقط
  if (currentUser && currentUser.role !== 'admin') {
    window.allData = window.allData.filter(item => {
      const reviewerName = item.reviewer || item['المراجع'] || '';
      return reviewerName === currentUser.username || reviewerName === currentUser.name;
    });
  }

  document.getElementById('active-date-label').innerText = `يعرض طلبات تاريخ: ${targetDate}`;

  totalRecordsCount = window.allData.length;
  updateKPIs(window.allData);
  renderReviewersStats(window.allData);
  renderCurrentPage();
}

function onDateFilterChange() { currentPage = 1; selectedOrderNumbers.clear(); updateSelectedCount(); applyDateFiltering(); }
function resetDateToLatest() { document.getElementById('date-filter').value = ''; selectedOrderNumbers.clear(); updateSelectedCount(); applyDateFiltering(); }

function renderCurrentPage() {
  if (!window.allData) return;

  const searchValue = document.getElementById('search-input').value.trim().toLowerCase();
  const statusValue = document.getElementById('status-filter').value;
  const reviewerValue = document.getElementById('reviewer-filter').value;

  let filtered = window.allData.filter(item => {
    const orderNum = String(item.order_number || item.order_no || item['رقم الطلب'] || '').toLowerCase();
    const matchesSearch = !searchValue || orderNum.includes(searchValue);
    const reviewStatus = item.review_status || item['حالة المراجعة'] || '';
    const matchesStatus = (statusValue === 'ALL') || (reviewStatus === statusValue);
    
    const reviewer = item.reviewer || item['المراجع'] || '';
    const matchesReviewer = (reviewerValue === 'ALL') || (reviewer === reviewerValue);

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
    const status = order.status || order['الحالة'] || '-';
    const reviewStatus = order.review_status || order['حالة المراجعة'] || 'جاري المراجعة';
    const rejectionReason = order.rejection_reason || order.reason || order['سبب الرفض'] || '-';

    let reviewBadge = 'badge-pending';
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
        <td><span class="badge badge-pending">${status}</span></td>
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

async function executeBulkDelete() {
  if (selectedOrderNumbers.size === 0) { alert('برجاء تحديد طلب واحد على الأقل للحذف'); return; }
  const confirmDelete = confirm(`هل أنت تأكد من رغبتك في حذف (${selectedOrderNumbers.size}) طلب محدد نهائياً؟`);
  if (!confirmDelete) return;

  const targetOrders = window.allData.filter(o => selectedOrderNumbers.has(o.order_number || o.order_no || o['رقم الطلب']));
  const matchColumn = targetOrders[0].id !== undefined ? 'id' : (targetOrders[0]['رقم الطلب'] !== undefined ? 'رقم الطلب' : 'order_number');
  const matchValues = targetOrders.map(o => o[matchColumn]);

  try {
    const { error } = await supabaseClient.from(TABLE_NAME).delete().in(matchColumn, matchValues);
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
    const { error } = await supabaseClient.from(TABLE_NAME).update(updateData).in(matchColumn, matchValues);
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
  const file = event.target.files[0];
  if (!file) return;

  document.getElementById('file-name-display').innerText = `تم اختيار الملف: ${file.name}`;
  Papa.parse(file, {
    header: true,
    skipEmptyLines: true,
    complete: function(results) {
      parsedCsvData = results.data;
      renderCsvPreview(parsedCsvData);
    }
  });
}

function renderCsvPreview(data) {
  const tbody = document.getElementById('csv-preview-tbody');
  tbody.innerHTML = '';
  document.getElementById('csv-count').innerText = data.length;
  document.getElementById('csv-preview-area').style.display = 'block';

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
}

async function uploadCsvToSupabase() {
  if (parsedCsvData.length === 0) return;
  const btn = document.getElementById('btn-upload-supabase');
  btn.innerText = 'جاري الرفع...'; btn.disabled = true;

  try {
    const cleanData = parsedCsvData.map(row => {
      const newRow = { ...row };
      if (newRow.id === "" || newRow.id === undefined || newRow.id === null) delete newRow.id;
      Object.keys(newRow).forEach(key => { if (newRow[key] === "") delete newRow[key]; });
      return newRow;
    });

    const { error } = await supabaseClient.from(TABLE_NAME).upsert(cleanData);
    if (error) { alert('خطأ أثناء الرفع: ' + error.message); } 
    else {
      alert('تم الرفع وتوزيع الطلبات بنجاح!');
      await loadData();
      switchTab('dashboard');
    }
  } catch (err) { alert('خطأ: ' + err.message); } 
  finally { btn.innerText = 'تأكيد وتوزيع الطلبات لـ Supabase'; btn.disabled = false; }
}

function openEditModal(orderNum) {
  selectedOrder = window.allData.find(o => String(o.order_number || o.order_no || o['رقم الطلب']) === String(orderNum));
  if (!selectedOrder) return;

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
      renderReviewersStats(window.allData);
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
  document.getElementById('stat-accepted').innerText = accepted.toLocaleString('ar-EG');
  document.getElementById('stat-rejected').innerText = rejected.toLocaleString('ar-EG');
  document.getElementById('stat-pending').innerText = (data.length - (accepted + rejected)).toLocaleString('ar-EG');
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

document.getElementById('search-input').addEventListener('input', () => { currentPage = 1; renderCurrentPage(); });
document.getElementById('status-filter').addEventListener('change', () => { currentPage = 1; renderCurrentPage(); });
document.getElementById('reviewer-filter').addEventListener('change', () => { currentPage = 1; renderCurrentPage(); });
