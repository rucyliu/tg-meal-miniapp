const tg = window.Telegram ? window.Telegram.WebApp : null;

// 全域應用狀態
const state = {
  today: '',
  hasOrderedToday: false,
  menus: [],
  orders: [],
  reviews: [],
  config: {
    user_name: '王小明',
    deadline_time: '10:30',
    output_template: '【{user_name}】{items_text}（共 ${total_price}）'
  },
  cart: [],
  activeReviewOrder: null,
  selectedRating: 5
};

document.addEventListener('DOMContentLoaded', () => {
  if (tg) {
    tg.ready();
    tg.expand();
  }
  bindEvents();
  initDashboard();
});

/**
 * 初始化畫面：先渲染本地快取，再背景同步最新 GAS 資料
 */
async function initDashboard(forceRefresh = false) {
  const cached = loadCachedDashboard();
  if (cached && !forceRefresh) {
    applyDashboardData(cached);
  }

  try {
    const freshData = await callGasApi('getDashboardData');
    saveCachedDashboard(freshData);
    applyDashboardData(freshData);
    if (forceRefresh) showToast('已同步最新菜單與評價');
  } catch (err) {
    console.error(err);
    showToast(`同步失敗：${err.message}`);
  }
}

function applyDashboardData(data) {
  state.today = data.today || '';
  state.hasOrderedToday = Boolean(data.hasOrderedToday);
  state.menus = data.menus || [];
  state.orders = data.orders || [];
  state.reviews = data.reviews || [];
  state.config = { ...state.config, ...(data.config || {}) };

  renderHeader();
  renderMenus();
  renderHistory();
  renderSettings();
}

/**
 * 計算店家歷史平均星等與標籤摘要
 */
function getStoreRatingStats(storeName) {
  const matched = state.reviews.filter(r => r.store_name === storeName);
  if (matched.length === 0) {
    return { count: 0, avg: null, tags: [] };
  }
  const sum = matched.reduce((acc, r) => acc + Number(r.rating || 0), 0);
  const avg = Number((sum / matched.length).toFixed(1));
  const tags = [...new Set(matched.flatMap(r => (r.tags || '').split(/\s+/)).filter(Boolean))].slice(0, 3);
  return { count: matched.length, avg, tags };
}

/**
 * 渲染頂部狀態列
 */
function renderHeader() {
  document.getElementById('today-date').textContent = state.today;
  const badge = document.getElementById('order-status-badge');
  if (state.hasOrderedToday) {
    badge.className = 'status-badge status-done';
    badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> 今日已點餐';
  } else {
    badge.className = 'status-badge status-pending';
    badge.innerHTML = '<i class="fa-regular fa-clock"></i> 尚未點餐';
  }

  const unrated = state.orders.filter(o => !o.is_rated).length;
  const dot = document.getElementById('unrated-count');
  if (unrated > 0) {
    dot.textContent = unrated;
    dot.classList.remove('hidden');
  } else {
    dot.classList.add('hidden');
  }
}

/**
 * 渲染今日店家與品項菜單（附歷史評價警示徽章）
 */
function renderMenus() {
  const container = document.getElementById('menu-container');
  if (state.menus.length === 0) {
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-regular fa-image fa-2x" style="margin-bottom:8px;"></i>
        <p>今日尚未匯入菜單圖片</p>
        <p style="font-size:12px;margin-top:4px;">請在 Telegram 將今日菜單圖片轉發給 Bot</p>
      </div>`;
    return;
  }

  // 依店家分組
  const storeMap = {};
  state.menus.forEach(item => {
    if (!storeMap[item.store_name]) storeMap[item.store_name] = [];
    storeMap[item.store_name].push(item);
  });

  const html = Object.keys(storeMap).map(storeName => {
    const items = storeMap[storeName];
    const stats = getStoreRatingStats(storeName);

    let ratingHtml = `<span class="rating-badge rating-new"><i class="fa-regular fa-star"></i> 尚無評價</span>`;
    if (stats.avg !== null) {
      if (stats.avg < 3.0) {
        ratingHtml = `<span class="rating-badge rating-bad"><i class="fa-solid fa-triangle-exclamation"></i> ${stats.avg} 星 ${stats.tags.join(' ')}</span>`;
      } else {
        ratingHtml = `<span class="rating-badge rating-good"><i class="fa-solid fa-star"></i> ${stats.avg} 星 ${stats.tags.join(' ')}</span>`;
      }
    }

    // 依分類分組
    const catOrder = ['主餐', '飲料', '單點/配菜', '加料'];
    const catGroups = {};
    items.forEach(it => {
      if (!catGroups[it.category]) catGroups[it.category] = [];
      catGroups[it.category].push(it);
    });

    const catsHtml = catOrder
      .filter(cat => catGroups[cat] && catGroups[cat].length > 0)
      .map(cat => {
        const rowsHtml = catGroups[cat].map(it => {
          const specText = it.spec ? ` (${it.spec})` : '';
          const noteText = it.note ? `<span class="item-meta"> · ${it.note}</span>` : '';
          return `
            <div class="menu-row">
              <div>
                <strong>${it.item_name}${specText}</strong>${noteText}
              </div>
              <div class="item-actions">
                <span class="item-price">$${it.price}</span>
                <button class="qty-btn" onclick="addToCart('${it.id}')" title="加入組合">
                  <i class="fa-solid fa-plus"></i>
                </button>
              </div>
            </div>`;
        }).join('');
        return `<div class="category-title">${cat}</div>${rowsHtml}`;
      }).join('');

    return `
      <section class="store-section">
        <div class="store-header">
          <span class="store-name"><i class="fa-solid fa-store"></i> ${storeName}</span>
          ${ratingHtml}
        </div>
        ${catsHtml}
      </section>`;
  }).join('');

  container.innerHTML = html;
}

/**
 * 【核心演算法】指定預算內「主餐＋飲料」智慧組合推薦
 */
function recommendCombos() {
  const budget = Number(document.getElementById('budget-input').value) || 150;
  const excludeBad = document.getElementById('exclude-low-rating').checked;
  const resultBox = document.getElementById('combo-results');

  if (state.menus.length === 0) {
    showToast('今日尚無菜單可進行推薦');
    return;
  }

  // 過濾可用店家
  const validItems = state.menus.filter(item => {
    if (item.price <= 0 || item.price > budget) return false;
    if (excludeBad) {
      const stats = getStoreRatingStats(item.store_name);
      if (stats.avg !== null && stats.avg < 3.0) return false;
    }
    return true;
  });

  const mains = validItems.filter(i => i.category === '主餐');
  const drinks = validItems.filter(i => i.category === '飲料');
  const candidates = [];

  // 1. 產生「1 主餐 + 1 飲料」組合
  if (mains.length > 0 && drinks.length > 0) {
    mains.forEach(m => {
      drinks.forEach(d => {
        const total = m.price + d.price;
        if (total <= budget) {
          const mRating = getStoreRatingStats(m.store_name).avg ?? 3.6;
          const dRating = getStoreRatingStats(d.store_name).avg ?? 3.6;
          const avgRating = (mRating + dRating) / 2;

          // 評分公式：預算貼合度 (45分) + 歷史評價分 (45分) + 隨機多樣性微調 (10分)
          const budgetScore = (total / budget) * 45;
          const ratingScore = (avgRating / 5) * 45;
          const jitter = Math.random() * 10;

          candidates.push({
            items: [m, d],
            total,
            avgRating,
            score: budgetScore + ratingScore + jitter,
            badge: avgRating >= 4.2 ? '高分口碑組合' : (budget - total <= 15 ? '預算完美匹配' : '主餐＋飲料推薦')
          });
        }
      });
    });
  }

  // 2. 若無飲料或預算僅夠單點主餐，補充「純主餐」高分選項
  if (candidates.length < 3 && mains.length > 0) {
    mains.forEach(m => {
      const mRating = getStoreRatingStats(m.store_name).avg ?? 3.6;
      candidates.push({
        items: [m],
        total: m.price,
        avgRating: mRating,
        score: (m.price / budget) * 35 + (mRating / 5) * 45 + Math.random() * 8,
        badge: '單點主餐推薦'
      });
    });
  }

  // 排序並挑選不重複主餐的前 3 組推薦
  candidates.sort((a, b) => b.score - a.score);
  const picked = [];
  const usedMainNames = new Set();

  for (const c of candidates) {
    const mainKey = c.items[0].item_name;
    if (!usedMainNames.has(mainKey)) {
      picked.push(c);
      usedMainNames.add(mainKey);
    }
    if (picked.length >= 3) break;
  }

  if (picked.length === 0) {
    resultBox.innerHTML = `<div class="combo-item">找不到 $${budget} 元內的合適組合，請調高預算或取消排除限制。</div>`;
    resultBox.classList.remove('hidden');
    return;
  }

  // 暫存推薦結果供一鍵套用
  window._lastRecommended = picked;
  resultBox.innerHTML = picked.map((c, idx) => {
    const names = c.items.map(i => `${i.item_name}${i.spec ? `(${i.spec})` : ''}`).join(' + ');
    return `
      <div class="combo-item">
        <div>
          <span class="combo-tag"><i class="fa-solid fa-sparkles"></i> ${c.badge} · 剩餘 $${budget - c.total}</span>
          <div><strong>${names}</strong></div>
          <div class="item-meta">總計 $${c.total}</div>
        </div>
        <button class="btn btn-primary" onclick="applyRecommendedCombo(${idx})">套用</button>
      </div>`;
  }).join('');

  resultBox.classList.remove('hidden');
}

window.applyRecommendedCombo = function(idx) {
  const combo = window._lastRecommended && window._lastRecommended[idx];
  if (!combo) return;
  state.cart = [...combo.items];
  renderCart();
  showToast('已套用推薦組合，可於下方確認複製');
};

/**
 * 購物車操作與格式化預覽
 */
window.addToCart = function(itemId) {
  const found = state.menus.find(m => m.id === itemId);
  if (!found) return;
  state.cart.push({ ...found });
  renderCart();
  if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
};

window.removeFromCart = function(index) {
  state.cart.splice(index, 1);
  renderCart();
};

function buildFormattedOrderText() {
  const note = document.getElementById('order-note-input').value.trim();
  const totalPrice = state.cart.reduce((sum, i) => sum + Number(i.price || 0), 0);

  const itemsText = state.cart.map(i => {
    const spec = i.spec ? `(${i.spec})` : '';
    return `${i.item_name}${spec} $${i.price}`;
  }).join(' + ');

  const noteSuffix = note ? ` [${note}]` : '';
  let output = state.config.output_template || '【{user_name}】{items_text}（共 ${total_price}）';

  output = output
    .replace('{user_name}', state.config.user_name || '我')
    .replace('{items_text}', itemsText + (output.includes('{note}') ? '' : noteSuffix))
    .replace('{total_price}', String(totalPrice))
    .replace('{note}', note);

  return { formattedText: output, totalPrice };
}

function renderCart() {
  const bar = document.getElementById('cart-bar');
  if (state.cart.length === 0) {
    bar.classList.add('hidden');
    return;
  }

  bar.classList.remove('hidden');
  const { formattedText, totalPrice } = buildFormattedOrderText();

  document.getElementById('cart-item-count').textContent = state.cart.length;
  document.getElementById('cart-total-price').textContent = totalPrice;
  document.getElementById('format-preview').textContent = formattedText;

  document.getElementById('cart-items-list').innerHTML = state.cart.map((item, idx) => `
    <span class="cart-chip">
      ${item.item_name}${item.spec ? `(${item.spec})` : ''} $${item.price}
      <i class="fa-solid fa-xmark" style="cursor:pointer;color:var(--danger);" onclick="removeFromCart(${idx})"></i>
    </span>
  `).join('');
}

/**
 * 一鍵複製格式化文字並寫入歷史點餐紀錄
 */
async function confirmAndCopyOrder() {
  if (state.cart.length === 0) return;

  const { formattedText, totalPrice } = buildFormattedOrderText();
  await copyTextToClipboard(formattedText);

  if (tg && tg.HapticFeedback) {
    tg.HapticFeedback.notificationOccurred('success');
  }
  showToast('已複製點餐內容！可直接貼到群組');

  const btn = document.getElementById('btn-confirm-copy');
  btn.disabled = true;
  btn.innerHTML = '<i class="fa-solid fa-spinner fa-spin"></i> 正在儲存紀錄...';

  try {
    await callGasApi('createOrder', {
      items: state.cart,
      total_price: totalPrice,
      formatted_text: formattedText
    });
    state.cart = [];
    document.getElementById('order-note-input').value = '';
    renderCart();
    await initDashboard(false);
  } catch (err) {
    showToast(`紀錄寫入失敗：${err.message}`);
  } finally {
    btn.disabled = false;
    btn.innerHTML = '<i class="fa-solid fa-copy"></i> 確認點餐並複製格式';
  }
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) {
      // 降級使用 execCommand
    }
  }
  const textarea = document.createElement('textarea');
  textarea.value = text;
  textarea.style.position = 'fixed';
  textarea.style.opacity = '0';
  document.body.appendChild(textarea);
  textarea.select();
  document.execCommand('copy');
  document.body.removeChild(textarea);
}

/**
 * 渲染歷史訂單與評價分頁
 */
function renderHistory() {
  const container = document.getElementById('history-container');
  if (state.orders.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>尚無點餐紀錄</p></div>';
    return;
  }

  container.innerHTML = state.orders.map((ord, idx) => {
    const rateBtn = ord.is_rated
      ? `<span class="status-badge status-done"><i class="fa-solid fa-check"></i> 已評價</span>`
      : `<button class="btn btn-primary" onclick="openRatingModal(${idx})"><i class="fa-solid fa-star"></i> 填寫評價</button>`;

    return `
      <div class="history-card">
        <div class="history-top">
          <span><i class="fa-regular fa-calendar"></i> ${ord.date}</span>
          <span>$${ord.total_price}</span>
        </div>
        <div class="history-text">${ord.formatted_text}</div>
        <div class="history-actions">
          ${rateBtn}
          <button class="btn" style="background:var(--bg-elevated);color:var(--text-main);" onclick="reCopyOrder(${idx})">
            <i class="fa-regular fa-copy"></i> 再次複製
          </button>
        </div>
      </div>`;
  }).join('');
}

window.reCopyOrder = async function(idx) {
  const ord = state.orders[idx];
  if (!ord) return;
  await copyTextToClipboard(ord.formatted_text);
  showToast('已重新複製該筆點餐內容');
};

/**
 * 評價彈窗控制
 */
window.openRatingModal = function(orderIdx) {
  const ord = state.orders[orderIdx];
  if (!ord) return;

  state.activeReviewOrder = ord;
  state.selectedRating = 5;

  document.getElementById('modal-order-title').textContent = `${ord.date} · ${ord.formatted_text}`;
  document.getElementById('review-comment').value = '';
  document.querySelectorAll('#quick-tags .tag-chip').forEach(el => el.classList.remove('selected'));
  updateStarUI(5);

  document.getElementById('rating-modal').classList.remove('hidden');
};

function closeRatingModal() {
  document.getElementById('rating-modal').classList.add('hidden');
  state.activeReviewOrder = null;
}

function updateStarUI(val) {
  state.selectedRating = val;
  document.querySelectorAll('#star-selector i').forEach(star => {
    const starVal = Number(star.dataset.val);
    star.classList.toggle('active', starVal <= val);
  });
}

async function submitReview() {
  const ord = state.activeReviewOrder;
  if (!ord) return;

  const selectedTags = [...document.querySelectorAll('#quick-tags .tag-chip.selected')]
    .map(el => el.dataset.tag)
    .join(' ');
  const comment = document.getElementById('review-comment').value.trim();

  // 從該筆訂單的第一個品項取得店家名稱（若無則取全部不重複店家）
  const stores = [...new Set((ord.items || []).map(i => i.store_name).filter(Boolean))];
  const itemNames = (ord.items || []).map(i => i.item_name).join('、');

  const btn = document.getElementById('btn-submit-review');
  btn.disabled = true;

  try {
    // 若同一餐跨兩家店（例如便當店+飲料店），分別寫入兩家店的評價
    const targetStores = stores.length > 0 ? stores : ['未指定店家'];
    for (const st of targetStores) {
      await callGasApi('submitReview', {
        order_id: ord.order_id,
        store_name: st,
        item_name: itemNames,
        rating: state.selectedRating,
        tags: selectedTags,
        comment: comment
      });
    }

    closeRatingModal();
    showToast('感謝評價！已納入未來避雷與推薦依據');
    await initDashboard(false);
  } catch (err) {
    showToast(`評價送出失敗：${err.message}`);
  } finally {
    btn.disabled = false;
  }
}

/**
 * 設定分頁渲染與儲存
 */
function renderSettings() {
  document.getElementById('cfg-user-name').value = state.config.user_name || '';
  document.getElementById('cfg-deadline').value = state.config.deadline_time || '10:30';
  document.getElementById('cfg-template').value = state.config.output_template || '';
}

async function saveSettings() {
  const payload = {
    user_name: document.getElementById('cfg-user-name').value.trim() || '王小明',
    deadline_time: document.getElementById('cfg-deadline').value || '10:30',
    output_template: document.getElementById('cfg-template').value.trim() || '【{user_name}】{items_text}（共 ${total_price}）'
  };

  try {
    await callGasApi('updateConfig', payload);
    state.config = { ...state.config, ...payload };
    renderCart();
    showToast('設定已儲存');
  } catch (err) {
    showToast(`儲存失敗：${err.message}`);
  }
}

/**
 * 綁定所有互動事件
 */
function bindEvents() {
  // 分頁切換
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => {
      document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
      document.querySelectorAll('.tab-content').forEach(c => c.classList.remove('active'));
      btn.classList.add('active');
      document.getElementById(btn.dataset.tab).classList.add('active');
    });
  });

  document.getElementById('btn-refresh').addEventListener('click', () => initDashboard(true));
  document.getElementById('btn-recommend').addEventListener('click', recommendCombos);
  document.getElementById('btn-clear-cart').addEventListener('click', () => {
    state.cart = [];
    renderCart();
  });
  document.getElementById('order-note-input').addEventListener('input', renderCart);
  document.getElementById('btn-confirm-copy').addEventListener('click', confirmAndCopyOrder);
  document.getElementById('btn-save-config').addEventListener('click', saveSettings);

  // 評價彈窗互動與 ESC 關閉
  document.getElementById('btn-close-modal').addEventListener('click', closeRatingModal);
  document.getElementById('btn-submit-review').addEventListener('click', submitReview);
  document.querySelectorAll('#star-selector i').forEach(star => {
    star.addEventListener('click', () => updateStarUI(Number(star.dataset.val)));
  });
  document.querySelectorAll('#quick-tags .tag-chip').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
  });
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeRatingModal();
  });
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}
