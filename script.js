// ==================== 1. تهيئة SUPABASE ====================
const SUPABASE_URL = "https://gnpejzuxwqftxgfcsics.supabase.co"; // استبدل برابط مشروعك
const SUPABASE_ANON_KEY = "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6ImducGVqenV4d3FmdHhnZmNzaWNzIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODY2MzU3ODYsImV4cCI6MjEwMjIxMTc4Nn0.4nrBcwRm4W51EX8_QtGvTrkwLFVjtiomPXyDU0N1mTQ";         // استبدل بـ Anon Key

const supabase = window.supabase.createClient(SUPABASE_URL, SUPABASE_ANON_KEY);

// متغيرات النظام الحالية
let currentUser = null;
let allOrdersData = [];

// ==================== 2. عند تحميل الصفحة ====================
document.addEventListener("DOMContentLoaded", () => {
  const savedUser = localStorage.getItem("system_user");
  if (savedUser) {
    currentUser = savedUser;
    showMainApp();
  }
});

// ==================== 3. وظائف تسجيل الدخول والخروج ====================
async function handleLogin(event) {
  event.preventDefault();
  
  const usernameInput = document.getElementById("login-username").value.trim();
  const passwordInput = document.getElementById("login-password").value.trim();
  const errorElement = document.getElementById("login-error");

  errorElement.style.display = "none";

  if (!usernameInput || !passwordInput) {
    showLoginError("يرجى إدخال اسم المستخدم وكلمة المرور.");
    return;
  }

  try {
    // الاستعلام من جدول المستخدمين users في Supabase
    const { data, error } = await supabase
      .from("users")
      .select("*")
      .eq("username", usernameInput)
      .eq("password", passwordInput)
      .single();

    if (error || !data) {
      showLoginError("اسم المستخدم أو كلمة المرور غير صحيحة!");
      return;
    }

    // تسجيل الدخول بنجاح
    currentUser = data.username;
    
    // حفظ الجلسة إذا تم اختيار "تذكرني"
    if (document.getElementById("remember-me").checked) {
      localStorage.setItem("system_user", currentUser);
    }

    showMainApp();

  } catch (err) {
    console.error("Login Error:", err);
    showLoginError("حدث خطأ أثناء الاتصال بالقاعدة.");
  }
}

function showLoginError(msg) {
  const errorElement = document.getElementById("login-error");
  errorElement.textContent = msg;
  errorElement.style.display = "block";
}

function handleLogout() {
  localStorage.removeItem("system_user");
  currentUser = null;
  document.getElementById("main-app").classList.add("hidden");
  document.getElementById("login-screen").classList.remove("hidden");
}

function showMainApp() {
  document.getElementById("login-screen").classList.add("hidden");
  document.getElementById("main-app").classList.remove("hidden");
  document.getElementById("current-user-display").textContent = `المراجع: ${currentUser}`;
  fetchOrders();
}

// ==================== 4. إدراج وحفظ الطلبات ====================
async function submitOrder(event) {
  event.preventDefault();

  const orderId = document.getElementById("order-id").value.trim();
  const orderStatus = document.getElementById("order-status").value;
  const msgElement = document.getElementById("order-msg");

  if (!orderId || !orderStatus) return;

  msgElement.textContent = "جاري الحفظ...";
  msgElement.style.color = "#94a3b8";

  try {
    const { data, error } = await supabase
      .from("orders")
      .insert([
        {
          order_id: orderId,
          status: orderStatus,
          reviewer: currentUser,
          created_at: new Date()
        }
      ]);

    if (error) throw error;

    msgElement.textContent = "✅ تم حفظ الطلب بنجاح!";
    msgElement.style.color = "#34d399";
    document.getElementById("order-form").reset();
    
    // إعادة جلب البيانات لتحديث الجدول
    fetchOrders();

  } catch (err) {
    console.error("Insert Error:", err);
    msgElement.textContent = "❌ حدث خطأ، قد يكون رقم الطلب مسجلاً من قبل.";
    msgElement.style.color = "#f87171";
  }
}

// ==================== 5. جلب وعرض البيانات في الجدول ====================
async function fetchOrders() {
  const tbody = document.getElementById("orders-table-body");

  try {
    const { data, error } = await supabase
      .from("orders")
      .select("*")
      .order("created_at", { ascending: false });

    if (error) throw error;

    allOrdersData = data || [];
    renderTable(allOrdersData);

  } catch (err) {
    console.error("Fetch Error:", err);
    tbody.innerHTML = `<tr><td colspan="5" class="text-center" style="color: #f87171;">حدث خطأ أثناء تحميل البيانات.</td></tr>`;
  }
}

function renderTable(data) {
  const tbody = document.getElementById("orders-table-body");
  
  if (data.length === 0) {
    tbody.innerHTML = `<tr><td colspan="5" class="text-center">لا توجد طلبات مسجلة حتى الآن.</td></tr>`;
    return;
  }

  tbody.innerHTML = data.map((item, index) => {
    const statusClass = item.status === "مقبول" ? "badge-accepted" : "badge-rejected";
    const formattedDate = new Date(item.created_at).toLocaleString("ar-EG");

    return `
      <tr>
        <td>${index + 1}</td>
        <td><strong>${item.order_id}</strong></td>
        <td><span class="${statusClass}">${item.status}</span></td>
        <td>${item.reviewer}</td>
        <td>${formattedDate}</td>
      </tr>
    `;
  }).join("");
}

// ==================== 6. التصفية والبحث في الجدول ====================
function filterOrders() {
  const query = document.getElementById("search-input").value.toLowerCase().trim();
  
  const filtered = allOrdersData.filter(order => 
    order.order_id.toString().toLowerCase().includes(query) ||
    order.reviewer.toLowerCase().includes(query)
  );

  renderTable(filtered);
}