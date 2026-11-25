// 【必填】請替換為你部署 Google Apps Script 取得的 Web App 網址
const GAS_WEB_APP_URL = 'https://script.google.com/macros/s/AKfycbyzYbseQGIapnyMBsACtyNSEoI9nMdVje098hObTa62RsG4-WERjpo0gQQ-XHMfGsYi0g/exec';
const CACHE_KEY = 'tg_meal_dashboard_v2';

function getTelegramInitData() {
  if (window.Telegram && window.Telegram.WebApp) {
    return window.Telegram.WebApp.initData || '';
  }
  return '';
}

async function callGasApi(action, payload = {}) {
  const response = await fetch(GAS_WEB_APP_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'text/plain;charset=utf-8'
    },
    body: JSON.stringify({
      action: action,
      initData: getTelegramInitData(),
      payload: payload
    })
  });

  if (!response.ok) {
    throw new Error(`HTTP 錯誤: ${response.status}`);
  }

  const result = await response.json();
  if (!result.ok) {
    throw new Error(result.error || '後端回傳未知錯誤');
  }
  return result.data;
}

function loadCachedDashboard() {
  try {
    const raw = localStorage.getItem(CACHE_KEY);
    return raw ? JSON.parse(raw) : null;
  } catch (e) {
    return null;
  }
}

function saveCachedDashboard(data) {
  try {
    localStorage.setItem(CACHE_KEY, JSON.stringify(data));
  } catch (e) {
    console.warn('localStorage 寫入失敗', e);
  }
}
