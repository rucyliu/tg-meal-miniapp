const tg = window.Telegram ? window.Telegram.WebApp : null;

const SUGAR_OPTIONS = ['無糖', '1分糖', '微糖', '半糖', '少糖'];
const ICE_OPTIONS = ['去冰', '微冰', '少冰', '常溫', '熱飲'];
const FOOD_QUICK_NOTES = ['少飯', '加辣'];

const state = {
  today: '',
  hasOrderedToday: false,
  menus: [],
  savedStores: [],
  orders: [],
  reviews: [],
  cart: [],
  cartExpanded: true,
  reviewFilter: 'all',
  reviewSearch: '',
  activeReviewTarget: null,
  selectedRating: 5,
  storeOrderList: [],
  expandedStores: new Set(),
  hasInitializedExpand: false,
  menuMaxPrice: null,
  menuSortBy: 'default',
  lastRecommended: [],
  pendingToppingItem: null,
  appendThanks: true,
  draftSelectedStores: new Set(),
  storeLibSearch: '',
  pendingActions: new Set(),
  dailyStatuses: {},
  parsedImportOrders: []
};

document.addEventListener('DOMContentLoaded', () => {
  if (tg) {
    tg.ready();
    tg.expand();
  }
  bindEvents();
  initDashboard();
});

function escapeHtml(str) {
  return String(str ?? '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function normText(str) {
  return String(str || '').replace(/[\s ]+/g, '').toLowerCase();
}

/**
 * 統一確認彈窗封裝（支援 Telegram 原生確認框與一般瀏覽器降級）
 */
function askConfirm(message) {
  return new Promise(resolve => {
    if (tg && typeof tg.showConfirm === 'function') {
      try {
        tg.showConfirm(message, ok => resolve(Boolean(ok)));
        return;
      } catch (e) {}
    }
    resolve(window.confirm(message));
  });
}

/**
 * 通用防連點執行器：鎖定 actionKey 與指定按鈕，結束後還原
 */
async function runWithLock(actionKey, buttons, asyncFn, loadingHtml = null) {
  if (state.pendingActions.has(actionKey)) return;
  state.pendingActions.add(actionKey);

  const btnList = (Array.isArray(buttons) ? buttons : [buttons]).filter(Boolean);
  const originalStates = btnList.map(btn => ({
    btn,
    disabled: btn.disabled,
    html: btn.innerHTML
  }));

  btnList.forEach((btn, idx) => {
    btn.disabled = true;
    if (idx === 0 && loadingHtml) {
      btn.innerHTML = loadingHtml;
    }
  });

  try {
    await asyncFn();
  } finally {
    state.pendingActions.delete(actionKey);
    originalStates.forEach(item => {
      if (document.body.contains(item.btn)) {
        item.btn.disabled = item.disabled;
        item.btn.innerHTML = item.html;
      }
    });
  }
}

/**
 * 將目前記憶體中的 state 回寫至 localStorage（避免刪除或修改後被舊快取蓋回）
 */
function persistCurrentStateToCache() {
  saveCachedDashboard({
    today: state.today,
    hasOrderedToday: state.hasOrderedToday,
    menus: state.menus,
    savedStores: state.savedStores,
    orders: state.orders,
    reviews: state.reviews,
    dailyStatuses: state.dailyStatuses
  });
}

/**
 * 僅向後端拉取最新資料並刷新畫面（不渲染舊快取，專供異動後同步使用）
 */
async function syncDashboardFromServer(showSuccessToast = false) {
  const freshData = await callGasApi('getDashboardData');
  saveCachedDashboard(freshData);
  applyDashboardData(freshData);
  if (showSuccessToast) showToast('已同步最新菜單與評價');
}

/**
 * 初次啟動初始化：先秒開本地快取，再背景同步最新資料
 */
async function initDashboard(forceRefresh = false) {
  const cached = loadCachedDashboard();
  if (cached && !forceRefresh) {
    applyDashboardData(cached);
  }

  try {
    await syncDashboardFromServer(forceRefresh);
  } catch (err) {
    console.error(err);
    showToast(`同步失敗：${err.message}`);
  }
}

function applyDashboardData(data) {
  state.today = data.today || '';
  state.hasOrderedToday = Boolean(data.hasOrderedToday);
  state.menus = data.menus || [];
  state.savedStores = data.savedStores || [];
  state.orders = data.orders || [];
  state.reviews = data.reviews || [];
  state.dailyStatuses = data.dailyStatuses || {};

  const uniqueTodayStores = [...new Set(state.menus.map(m => m.store_name).filter(Boolean))];
  if (!state.hasInitializedExpand && uniqueTodayStores.length > 0) {
    state.expandedStores.clear();
    if (uniqueTodayStores.length === 1) {
      state.expandedStores.add(uniqueTodayStores[0]);
    }
    state.hasInitializedExpand = true;
  }

  const libBadge = document.getElementById('library-count-badge');
  if (libBadge) {
    libBadge.textContent = state.savedStores.length > 0 ? `(${state.savedStores.length})` : '';
  }

  renderHeader();
  renderMenus();
  renderHistory();
  renderReviewsTab();
}

/* ==================== 評價與點餐次數統計輔助函式 ==================== */

function getStoreRatingStats(storeName) {
  const target = normText(storeName);
  const matched = state.reviews.filter(r => normText(r.store_name) === target);
  if (matched.length === 0) return { count: 0, avg: null, tags: [] };

  const sum = matched.reduce((acc, r) => acc + Number(r.rating || 0), 0);
  const avg = Number((sum / matched.length).toFixed(1));
  const tags = [...new Set(matched.flatMap(r => (r.tags || '').split(/\s+/)).filter(Boolean))].slice(0, 2);
  return { count: matched.length, avg, tags };
}

function getItemRatingStats(storeName, itemName) {
  const targetStore = normText(storeName);
  const targetItem = normText(itemName);
  const matched = state.reviews.filter(
    r => normText(r.store_name) === targetStore && normText(r.item_name) === targetItem
  );
  if (matched.length === 0) return { count: 0, avg: null, tags: [], latestComment: '' };

  const sum = matched.reduce((acc, r) => acc + Number(r.rating || 0), 0);
  const avg = Number((sum / matched.length).toFixed(1));
  const tags = [...new Set(matched.flatMap(r => (r.tags || '').split(/\s+/)).filter(Boolean))].slice(0, 2);
  return { count: matched.length, avg, tags, latestComment: matched[0].comment || '' };
}

function getItemOrderCount(storeName, itemName) {
  const targetStore = normText(storeName);
  const targetItem = normText(itemName);
  let count = 0;

  state.orders.forEach(ord => {
    const items = Array.isArray(ord.items) ? ord.items : [];
    items.forEach(it => {
      if (it && normText(it.store_name) === targetStore && normText(it.item_name) === targetItem) {
        count++;
      }
    });
  });

  return count;
}

function findReviewForOrderItem(orderId, storeName, itemName) {
  const targetStore = normText(storeName);
  const targetItem = normText(itemName);
  return state.reviews.find(
    r => String(r.order_id) === String(orderId) &&
         normText(r.store_name) === targetStore &&
         normText(r.item_name) === targetItem
  );
}

function getRatingColorClass(avg) {
  if (avg === null) return 'rating-new';
  if (avg >= 4.0) return 'rating-good';
  if (avg >= 3.0) return 'rating-mid';
  return 'rating-bad';
}

/* ==================== 頂部與今日菜單 ==================== */

function renderHeader() {
  document.getElementById('today-date').textContent = state.today;
  const badge = document.getElementById('order-status-badge');
  if (state.hasOrderedToday) {
    badge.className = 'status-badge status-done';
    badge.innerHTML = '<i class="fa-solid fa-circle-check"></i> 今日已點餐';
  } else {
    badge.className = 'status-badge status-pending';
    badge.innerHTML = '<i class="fa-regular fa-clock"></i> 今日未點餐';
  }
}

function sortMenuItems(items) {
  const arr = [...items];
  switch (state.menuSortBy) {
    case 'price_asc':
      return arr.sort((a, b) => (a.price || 0) - (b.price || 0));
    case 'price_desc':
      return arr.sort((a, b) => (b.price || 0) - (a.price || 0));
    case 'rating_desc':
      return arr.sort((a, b) => {
        const ra = getItemRatingStats(a.store_name, a.item_name).avg ?? -1;
        const rb = getItemRatingStats(b.store_name, b.item_name).avg ?? -1;
        return rb - ra;
      });
    case 'count_desc':
      return arr.sort((a, b) => {
        const ca = getItemOrderCount(a.store_name, a.item_name);
        const cb = getItemOrderCount(b.store_name, b.item_name);
        return cb - ca;
      });
    default:
      return arr;
  }
}

function updateToggleAllStoresBtn() {
  const btn = document.getElementById('btn-toggle-all-stores');
  if (!btn) return;
  const allExpanded = state.storeOrderList.length > 0 &&
    state.storeOrderList.every(name => state.expandedStores.has(name));

  btn.innerHTML = allExpanded
    ? '<i class="fa-solid fa-angles-up"></i> 全部收合'
    : '<i class="fa-solid fa-angles-down"></i> 全部展開';
}

function renderMenus() {
  const container = document.getElementById('menu-container');
  if (state.menus.length === 0) {
    state.storeOrderList = [];
    updateToggleAllStoresBtn();
    const pickOldBtn = state.savedStores.length > 0
      ? `<button class="btn btn-primary" style="margin-top:12px;" onclick="openStoreLibraryModal()">
           <i class="fa-solid fa-book-open"></i> 從菜單庫挑選今日店家（已存 ${state.savedStores.length} 家）
         </button>`
      : '';
    container.innerHTML = `
      <div class="empty-state">
        <i class="fa-regular fa-image fa-2x" style="margin-bottom:8px;"></i>
        <p>今日尚未啟用店家菜單</p>
        <p style="font-size:12px;margin-top:4px;">可轉發新菜單圖片給 Bot，或直接從菜單庫勾選舊店</p>
        ${pickOldBtn}
      </div>`;
    return;
  }

  const storeMap = {};
  state.menus.forEach(item => {
    if (!storeMap[item.store_name]) storeMap[item.store_name] = [];
    storeMap[item.store_name].push(item);
  });

  state.storeOrderList = Object.keys(storeMap);
  const maxPrice = state.menuMaxPrice;

  const html = state.storeOrderList.map((storeName, sIdx) => {
    const allStoreRows = storeMap[storeName];
    const storeNotes = allStoreRows.filter(i => i.category === '店家備註');
    const allMenuItems = allStoreRows.filter(i => i.category !== '店家備註');

    const filteredItems = maxPrice !== null
      ? allMenuItems.filter(it => Number(it.price) <= maxPrice)
      : allMenuItems;

    const isExpanded = state.expandedStores.has(storeName);
    const chevronClass = isExpanded ? 'fa-chevron-down' : 'fa-chevron-right';
    const countLabel = maxPrice !== null
      ? `符合 ${filteredItems.length}/${allMenuItems.length} 項`
      : `${allMenuItems.length} 項`;

    const storeStats = getStoreRatingStats(storeName);
    let storeRatingHtml = `<span class="rating-badge rating-new"><i class="fa-regular fa-star"></i> 無評價</span>`;
    if (storeStats.avg !== null) {
      const cls = getRatingColorClass(storeStats.avg);
      storeRatingHtml = `
        <span class="rating-badge ${cls} clickable"
          onclick="event.stopPropagation(); jumpToStoreReviews(${sIdx})"
          title="點擊查看此店家歷史評價">
          <i class="fa-solid fa-star"></i> 店均 ${storeStats.avg}
        </span>`;
    }

    let storeNotesHtml = '';
    if (storeNotes.length > 0) {
      const noteLines = storeNotes.map(sn => {
        const priceBadge = sn.price > 0 ? ` (+$${sn.price})` : '';
        return `
          <div class="store-note-row">
            <span>• ${escapeHtml(sn.item_name)}${priceBadge}</span>
            <button class="icon-btn-plain" onclick="openEditMenuModalById('${escapeHtml(sn.id)}')" title="編輯備註">
              <i class="fa-solid fa-pen"></i>
            </button>
          </div>`;
      }).join('');

      storeNotesHtml = `
        <div class="store-notes-box">
          <div class="store-notes-title"><i class="fa-solid fa-thumbtack"></i> 店家備註</div>
          ${noteLines}
        </div>`;
    }

    const catOrder = ['主餐', '飲料', '單點/配菜', '加料'];
    const catGroups = {};
    filteredItems.forEach(it => {
      const cat = catOrder.includes(it.category) ? it.category : '主餐';
      if (!catGroups[cat]) catGroups[cat] = [];
      catGroups[cat].push(it);
    });

    let catsHtml = '';
    if (filteredItems.length === 0) {
      catsHtml = `<div class="item-meta" style="padding:10px 4px;text-align:center;">此店目前沒有 $${maxPrice} 元以下的品項</div>`;
    } else {
      catsHtml = catOrder
        .filter(cat => catGroups[cat] && catGroups[cat].length > 0)
        .map(cat => {
          const sortedCatItems = sortMenuItems(catGroups[cat]);
          const rowsHtml = sortedCatItems.map(it => {
            const specText = it.spec ? ` (${escapeHtml(it.spec)})` : '';
            const noteText = it.note ? `<div class="item-meta">${escapeHtml(it.note)}</div>` : '';

            const itemStats = getItemRatingStats(it.store_name, it.item_name);
            let itemReviewPill = '';
            if (itemStats.avg !== null) {
              const cls = getRatingColorClass(itemStats.avg);
              const icon = itemStats.avg < 3 ? 'fa-triangle-exclamation' : 'fa-star';
              const tagStr = itemStats.tags.length > 0 ? ` ${escapeHtml(itemStats.tags[0])}` : '';
              itemReviewPill = `
                <span class="item-rating-pill ${cls}" onclick="jumpToReviewSearch('${escapeHtml(it.id)}')" title="查看此品項歷史評價">
                  <i class="fa-solid ${icon}"></i> ${itemStats.avg}${tagStr}
                </span>`;
            }

            const orderCount = getItemOrderCount(it.store_name, it.item_name);
            const countPill = orderCount > 0
              ? `<span class="item-count-pill" title="歷史點過次數"><i class="fa-solid fa-bag-shopping"></i> 點過 ${orderCount} 次</span>`
              : '';

            const pillsRow = (itemReviewPill || countPill)
              ? `<div class="item-meta-pills">${itemReviewPill}${countPill}</div>`
              : '';

            const addBtnTitle = cat === '加料' ? '加料至已選飲料' : '加入點餐';
            const pricePrefix = cat === '加料' ? '+$' : '$';

            return `
              <div class="menu-row">
                <div class="menu-item-info">
                  <div><strong>${escapeHtml(it.item_name)}${specText}</strong></div>
                  ${pillsRow}
                  ${noteText}
                </div>
                <div class="item-actions">
                  <span class="item-price">${pricePrefix}${it.price}</span>
                  <button class="icon-btn-sm" onclick="openEditMenuModalById('${escapeHtml(it.id)}')" title="編輯品項或金額">
                    <i class="fa-solid fa-pen"></i>
                  </button>
                  <button class="qty-btn" onclick="addToCart('${escapeHtml(it.id)}')" title="${addBtnTitle}">
                    <i class="fa-solid fa-plus"></i>
                  </button>
                </div>
              </div>`;
          }).join('');
          return `<div class="category-title">${cat}</div>${rowsHtml}`;
        }).join('');
    }

    return `
      <section class="store-section ${isExpanded ? 'expanded' : ''}">
        <div class="store-header" onclick="toggleStoreAccordion(${sIdx})">
          <div class="store-title-wrap">
            <i class="fa-solid ${chevronClass} store-chevron"></i>
            <span class="store-name"><i class="fa-solid fa-store"></i> ${escapeHtml(storeName)}</span>
            <span class="store-count-pill">${countLabel}</span>
            <button class="icon-btn-sm" onclick="event.stopPropagation(); openRenameStoreModal(${sIdx})" title="修改店家名稱">
              <i class="fa-solid fa-pen"></i>
            </button>
          </div>
          ${storeRatingHtml}
        </div>
        <div class="store-body ${isExpanded ? '' : 'hidden'}">
          ${storeNotesHtml}
          ${catsHtml}
          <div class="store-footer">
            <button class="btn btn-outline-sm" onclick="openAddMenuModalForStore(${sIdx})">
              <i class="fa-solid fa-plus"></i> 新增品項 / 店家備註
            </button>
          </div>
        </div>
      </section>`;
  }).join('');

  container.innerHTML = html;
  updateToggleAllStoresBtn();
}

window.toggleStoreAccordion = function(storeIdx) {
  const storeName = state.storeOrderList[storeIdx];
  if (!storeName) return;
  if (state.expandedStores.has(storeName)) {
    state.expandedStores.delete(storeName);
  } else {
    state.expandedStores.add(storeName);
  }
  renderMenus();
};

function navigateToReviewsWithKeyword(keyword) {
  switchTab('tab-reviews');
  state.reviewSearch = keyword;
  state.reviewFilter = 'all';
  document.getElementById('review-search-input').value = keyword;
  document.getElementById('btn-clear-search').classList.toggle('hidden', !keyword);
  document.querySelectorAll('#review-rating-filters .filter-chip').forEach(c => {
    c.classList.toggle('active', c.dataset.filter === 'all');
  });
  renderReviewsTab();
  window.scrollTo({ top: 0, behavior: 'smooth' });
}

window.jumpToStoreReviews = function(storeIdx) {
  const storeName = state.storeOrderList[storeIdx];
  if (!storeName) return;
  navigateToReviewsWithKeyword(storeName);
};

window.jumpToReviewSearch = function(menuId) {
  const item = state.menus.find(m => m.id === menuId);
  if (!item) return;
  navigateToReviewsWithKeyword(item.item_name);
};

window.jumpToComboItemReview = function(comboIdx, itemIdx) {
  const combo = state.lastRecommended[comboIdx];
  if (!combo || !combo.items || !combo.items[itemIdx]) return;
  navigateToReviewsWithKeyword(combo.items[itemIdx].item_name);
};

/* ==================== 預算智慧湊單與一鍵隱藏 ==================== */

function clearRecommendedCombos() {
  state.lastRecommended = [];
  const resultBox = document.getElementById('combo-results');
  resultBox.innerHTML = '';
  resultBox.classList.add('hidden');
  document.getElementById('btn-clear-recommend').disabled = true;
}

function recommendCombos() {
  const budget = Number(document.getElementById('budget-input').value) || 150;
  const resultBox = document.getElementById('combo-results');
  const clearBtn = document.getElementById('btn-clear-recommend');

  const validItems = state.menus.filter(
    item => item.category !== '店家備註' && item.category !== '加料' && item.price > 0 && item.price <= budget
  );

  if (validItems.length === 0) {
    resultBox.innerHTML = `<div class="combo-item">找不到 $${budget} 元內的品項，請調高預算。</div>`;
    resultBox.classList.remove('hidden');
    clearBtn.disabled = false;
    return;
  }

  const mains = validItems.filter(i => i.category === '主餐');
  const drinks = validItems.filter(i => i.category === '飲料');
  const candidates = [];

  const getScoreRating = (item) => {
    const iStat = getItemRatingStats(item.store_name, item.item_name);
    if (iStat.avg !== null) return iStat.avg;
    const sStat = getStoreRatingStats(item.store_name);
    if (sStat.avg !== null) return sStat.avg;
    return 3.5;
  };

  if (mains.length > 0 && drinks.length > 0) {
    mains.forEach(m => {
      drinks.forEach(d => {
        const total = m.price + d.price;
        if (total <= budget) {
          const avgRating = (getScoreRating(m) + getScoreRating(d)) / 2;
          const score = (total / budget) * 45 + (avgRating / 5) * 45 + Math.random() * 10;
          candidates.push({
            items: [m, d],
            total,
            score,
            badge: avgRating >= 4.2 ? '高分口碑組合' : (budget - total <= 15 ? '預算完美匹配' : '主餐＋飲料推薦')
          });
        }
      });
    });
  }

  if (candidates.length < 3 && mains.length > 0) {
    mains.forEach(m => {
      const r = getScoreRating(m);
      candidates.push({
        items: [m],
        total: m.price,
        score: (m.price / budget) * 35 + (r / 5) * 45 + Math.random() * 8,
        badge: '單點主餐推薦'
      });
    });
  }

  candidates.sort((a, b) => b.score - a.score);
  const picked = [];
  const usedMains = new Set();
  for (const c of candidates) {
    const key = c.items[0].item_name;
    if (!usedMains.has(key)) {
      picked.push(c);
      usedMains.add(key);
    }
    if (picked.length >= 3) break;
  }

  if (picked.length === 0) {
    resultBox.innerHTML = `<div class="combo-item">找不到 $${budget} 元內的合適組合，請嘗試調整預算金額。</div>`;
    resultBox.classList.remove('hidden');
    clearBtn.disabled = false;
    return;
  }

  state.lastRecommended = picked;
  resultBox.innerHTML = picked.map((c, cIdx) => {
    const detailRowsHtml = c.items.map((it, itemIdx) => {
      const iStats = getItemRatingStats(it.store_name, it.item_name);
      const sStats = getStoreRatingStats(it.store_name);
      const orderCount = getItemOrderCount(it.store_name, it.item_name);

      let ratingPill = '';
      if (iStats.avg !== null) {
        const cls = getRatingColorClass(iStats.avg);
        const icon = iStats.avg < 3 ? 'fa-triangle-exclamation' : 'fa-star';
        const tagStr = iStats.tags.length > 0 ? ` ${escapeHtml(iStats.tags[0])}` : '';
        ratingPill = `
          <span class="item-rating-pill ${cls}" onclick="jumpToComboItemReview(${cIdx}, ${itemIdx})" title="查看歷史評價">
            <i class="fa-solid ${icon}"></i> 品評 ${iStats.avg}${tagStr}
          </span>`;
      } else if (sStats.avg !== null) {
        const cls = getRatingColorClass(sStats.avg);
        ratingPill = `<span class="item-rating-pill ${cls}" onclick="navigateToReviewsWithKeyword(state.lastRecommended[${cIdx}].items[${itemIdx}].store_name)"><i class="fa-solid fa-store"></i> 店均 ${sStats.avg}</span>`;
      } else {
        ratingPill = `<span class="item-count-zero">尚無評價</span>`;
      }

      const countPill = orderCount > 0
        ? `<span class="item-count-pill"><i class="fa-solid fa-bag-shopping"></i> 點過 ${orderCount} 次</span>`
        : `<span class="item-count-zero">未點過</span>`;

      const specStr = it.spec ? ` (${escapeHtml(it.spec)})` : '';
      return `
        <div class="combo-detail-row">
          <div class="combo-detail-left">
            <div>
              <span class="cart-store-tag">${escapeHtml(it.store_name)}</span>
              <strong>${escapeHtml(it.item_name)}${specStr}</strong>
            </div>
            <div class="combo-detail-badges">
              ${ratingPill}
              ${countPill}
            </div>
          </div>
          <span class="combo-detail-price">$${it.price}</span>
        </div>`;
    }).join('');

    return `
      <div class="combo-item">
        <div class="combo-item-header">
          <div>
            <span class="combo-tag">${escapeHtml(c.badge)} · 剩餘 $${budget - c.total}</span>
            <span class="combo-total-label" style="margin-left:6px;">總計 $${c.total}</span>
          </div>
          <button class="btn btn-primary btn-sm" onclick="applyRecommendedCombo(${cIdx})">套用此組合</button>
        </div>
        <div class="combo-detail-list">${detailRowsHtml}</div>
      </div>`;
  }).join('');

  resultBox.classList.remove('hidden');
  clearBtn.disabled = false;
}

window.applyRecommendedCombo = function(idx) {
  const combo = state.lastRecommended[idx];
  if (!combo) return;
  state.cart = combo.items.map(createCartEntry);
  state.cartExpanded = true;
  renderCart();
  showToast('已套用組合，可在下方選擇加料與甜度冰塊');
};

/* ==================== 購物車、剩餘預算帶入篩選與一鍵清空欄位 ==================== */

function createCartEntry(menuItem) {
  return {
    menu_id: menuItem.id,
    store_name: menuItem.store_name,
    category: menuItem.category,
    item_name: menuItem.item_name,
    base_price: Number(menuItem.price) || 0,
    extra_price: 0,
    spec: menuItem.spec || '',
    sugar: '',
    ice: '',
    custom_note: '',
    toppings: []
  };
}

function getCartEntryTotal(entry) {
  const toppingsTotal = (entry.toppings || []).reduce((sum, t) => sum + (Number(t.price) || 0), 0);
  return (Number(entry.base_price) || 0) + (Number(entry.extra_price) || 0) + toppingsTotal;
}

function getCartEntryDisplayName(entry) {
  const toppings = entry.toppings || [];
  if (toppings.length === 0) return entry.item_name;
  return `${entry.item_name}+${toppings.map(t => t.item_name).join('+')}`;
}

window.addToCart = function(menuId) {
  const found = state.menus.find(m => m.id === menuId);
  if (!found) return;

  if (found.category === '加料') {
    handleAddToppingFromMenu(found);
    return;
  }

  state.cart.push(createCartEntry(found));
  state.cartExpanded = true;
  renderCart();
  if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
};

function handleAddToppingFromMenu(toppingItem) {
  const targetStoreNorm = normText(toppingItem.store_name);
  const sameStoreDrinks = [];
  const allDrinks = [];

  state.cart.forEach((entry, idx) => {
    if (entry.category === '飲料') {
      allDrinks.push({ idx, entry });
      if (normText(entry.store_name) === targetStoreNorm) {
        sameStoreDrinks.push({ idx, entry });
      }
    }
  });

  if (sameStoreDrinks.length === 1) {
    attachToppingToDrink(sameStoreDrinks[0].idx, toppingItem, false);
    return;
  }

  openToppingTargetModal(toppingItem, sameStoreDrinks.length > 0 ? sameStoreDrinks : allDrinks, sameStoreDrinks.length === 0);
}

function openToppingTargetModal(toppingItem, candidateDrinks, noSameStoreDrink) {
  state.pendingToppingItem = toppingItem;

  const infoBox = document.getElementById('topping-modal-info');
  infoBox.innerHTML = `
    <span class="cart-store-tag">${escapeHtml(toppingItem.store_name)}</span>
    <strong>+${escapeHtml(toppingItem.item_name)}</strong>
    <span class="item-meta">（+$${toppingItem.price}）</span>
    ${noSameStoreDrink ? '<div class="item-meta" style="color:var(--warning);margin-top:4px;">購物車內尚無該店家的飲料，建議先點選飲料再加料。</div>' : ''}`;

  const listEl = document.getElementById('topping-target-list');
  if (candidateDrinks.length === 0) {
    listEl.innerHTML = `<div class="item-meta" style="text-align:center;padding:8px 0;">目前購物車內沒有任何飲料可供掛載</div>`;
  } else {
    listEl.innerHTML = candidateDrinks.map(({ idx, entry }) => {
      const displayName = getCartEntryDisplayName(entry);
      const specHint = entry.spec ? ` (${escapeHtml(entry.spec)})` : '';
      const total = getCartEntryTotal(entry);
      return `
        <button type="button" class="topping-target-btn" onclick="selectToppingTargetDrink(${idx})">
          <div>
            <span class="cart-store-tag">${escapeHtml(entry.store_name)}</span>
            <strong>${escapeHtml(displayName)}${specHint}</strong>
          </div>
          <span class="item-meta">目前 $${total}</span>
        </button>`;
    }).join('');
  }

  document.getElementById('topping-target-modal').classList.remove('hidden');
}

window.selectToppingTargetDrink = function(cartIdx) {
  if (!state.pendingToppingItem) return;
  attachToppingToDrink(cartIdx, state.pendingToppingItem, false);
  state.pendingToppingItem = null;
  closeModal('topping-target-modal');
};

function attachToppingToDrink(cartIdx, toppingItem, allowToggleOff) {
  const entry = state.cart[cartIdx];
  if (!entry) return;
  if (!Array.isArray(entry.toppings)) entry.toppings = [];

  const existsIdx = entry.toppings.findIndex(
    t => t.menu_id === toppingItem.id || normText(t.item_name) === normText(toppingItem.item_name)
  );

  if (existsIdx > -1) {
    if (allowToggleOff) {
      entry.toppings.splice(existsIdx, 1);
      renderCart();
      if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
    } else {
      showToast(`「${entry.item_name}」已加過「${toppingItem.item_name}」`);
    }
    return;
  }

  entry.toppings.push({
    menu_id: toppingItem.id,
    item_name: toppingItem.item_name,
    price: Number(toppingItem.price) || 0
  });

  state.cartExpanded = true;
  renderCart();
  if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
  if (!allowToggleOff) {
    showToast(`已加料「${toppingItem.item_name}」至「${entry.item_name}」`);
  }
}

window.toggleToppingInCartCard = function(cartIdx, toppingMenuId) {
  const toppingItem = state.menus.find(m => m.id === toppingMenuId);
  if (!toppingItem) return;
  attachToppingToDrink(cartIdx, toppingItem, true);
};

window.removeToppingFromCartCard = function(cartIdx, toppingIdx) {
  const entry = state.cart[cartIdx];
  if (!entry || !Array.isArray(entry.toppings)) return;
  entry.toppings.splice(toppingIdx, 1);
  renderCart();
};

window.removeFromCart = function(idx) {
  state.cart.splice(idx, 1);
  renderCart();
};

window.toggleCartDrinkOption = function(idx, field, val) {
  const entry = state.cart[idx];
  if (!entry) return;
  entry[field] = entry[field] === val ? '' : val;
  renderCart();
};

window.toggleCartQuickNote = function(idx, noteText, extraPrice = 0) {
  const entry = state.cart[idx];
  if (!entry) return;
  const parts = entry.custom_note ? entry.custom_note.split('/').map(s => s.trim()).filter(Boolean) : [];
  const existsIdx = parts.indexOf(noteText);
  if (existsIdx > -1) {
    parts.splice(existsIdx, 1);
    if (extraPrice > 0) entry.extra_price = Math.max(0, entry.extra_price - extraPrice);
  } else {
    parts.push(noteText);
    if (extraPrice > 0) entry.extra_price += extraPrice;
  }
  entry.custom_note = parts.join('/');
  renderCart();
};

window.updateCartCustomNote = function(idx, inputEl) {
  if (!state.cart[idx]) return;
  state.cart[idx].custom_note = inputEl.value;
  const clearBtn = inputEl.parentElement.querySelector('.clear-field-btn');
  if (clearBtn) clearBtn.classList.toggle('hidden', !inputEl.value);
  updateFormattedPreview();
};

window.clearCartCustomNote = function(idx) {
  if (!state.cart[idx]) return;
  state.cart[idx].custom_note = '';
  renderCart();
};

window.updateCartExtraPrice = function(idx, inputEl) {
  if (!state.cart[idx]) return;
  const numVal = Math.max(0, Number(inputEl.value) || 0);
  state.cart[idx].extra_price = numVal;
  const clearBtn = inputEl.parentElement.querySelector('.clear-field-btn');
  if (clearBtn) clearBtn.classList.toggle('hidden', numVal <= 0 && !inputEl.value);
  const priceLabel = document.getElementById(`cart-entry-price-${idx}`);
  if (priceLabel) priceLabel.textContent = ` $${getCartEntryTotal(state.cart[idx])}`;
  updateCartTotalsAndPreview();
};

window.clearCartExtraPrice = function(idx) {
  if (!state.cart[idx]) return;
  state.cart[idx].extra_price = 0;
  renderCart();
};

function buildFormattedOrderText() {
  const storeGroups = new Map();
  let grandTotal = 0;

  state.cart.forEach(entry => {
    const itemTotal = getCartEntryTotal(entry);
    grandTotal += itemTotal;

    const noteParts = [];
    if (entry.spec) noteParts.push(entry.spec);
    if (entry.category === '飲料') {
      if (entry.sugar) noteParts.push(entry.sugar);
      if (entry.ice) noteParts.push(entry.ice);
    }
    if (entry.custom_note && entry.custom_note.trim()) {
      noteParts.push(entry.custom_note.trim());
    }

    const baseAndToppings = getCartEntryDisplayName(entry);
    let noteStr = '';
    if (noteParts.length > 0) {
      noteStr = entry.category === '飲料'
        ? ` (${noteParts.join('/')})`
        : `(${noteParts.join('/')})`;
    }

    const displayItem = `${baseAndToppings}${noteStr}`;

    if (!storeGroups.has(entry.store_name)) {
      storeGroups.set(entry.store_name, { items: [], subtotal: 0 });
    }
    const group = storeGroups.get(entry.store_name);
    group.items.push(displayItem);
    group.subtotal += itemTotal;
  });

  const lines = [];
  storeGroups.forEach((group, storeName) => {
    lines.push(`${storeName} - ${group.items.join(' + ')} $${group.subtotal}`);
  });
  const thanksSuffix = state.appendThanks ? ' 謝謝' : '';
  lines.push(`共$${grandTotal}${thanksSuffix}`);

  return { formattedText: lines.join('\n'), totalPrice: grandTotal };
}

function updateFormattedPreview() {
  const { formattedText } = buildFormattedOrderText();
  const previewEl = document.getElementById('format-preview');
  previewEl.value = formattedText;
  previewEl.rows = Math.max(2, formattedText.split('\n').length);
}

/**
 * 依據目前預算上限與購物車總額，即時更新「剩餘預算帶入篩選」按鈕
 */
function updateRemainingBudgetBtn(cartTotalPrice) {
  const btn = document.getElementById('btn-apply-remaining-budget');
  if (!btn) return;

  const budget = Number(document.getElementById('budget-input').value) || 150;
  const remaining = budget - cartTotalPrice;

  if (remaining > 0) {
    btn.disabled = false;
    btn.classList.remove('over-budget');
    btn.innerHTML = `<i class="fa-solid fa-filter"></i> 剩$${remaining} 篩選`;
    btn.dataset.remaining = String(remaining);
  } else if (remaining === 0) {
    btn.disabled = true;
    btn.classList.remove('over-budget');
    btn.innerHTML = '<i class="fa-solid fa-check"></i> 已滿預算';
    btn.dataset.remaining = '0';
  } else {
    btn.disabled = true;
    btn.classList.add('over-budget');
    btn.innerHTML = `<i class="fa-solid fa-triangle-exclamation"></i> 超支$${Math.abs(remaining)}`;
    btn.dataset.remaining = '0';
  }
}

function applyRemainingBudgetToFilter() {
  const btn = document.getElementById('btn-apply-remaining-budget');
  const remaining = Number(btn.dataset.remaining || 0);
  if (remaining <= 0) return;

  state.menuMaxPrice = remaining;
  const priceInput = document.getElementById('menu-max-price');
  priceInput.value = remaining;
  document.getElementById('btn-clear-price-filter').classList.remove('hidden');

  switchTab('tab-order');
  state.cartExpanded = false;
  renderCart();
  renderMenus();

  const filterBar = document.getElementById('menu-filter-bar');
  if (filterBar) {
    filterBar.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }
  showToast(`已將剩餘預算 $${remaining} 帶入價格篩選`);
}

function updateCartTotalsAndPreview() {
  const { formattedText, totalPrice } = buildFormattedOrderText();
  document.getElementById('cart-item-count').textContent = state.cart.length;
  document.getElementById('cart-total-price').textContent = totalPrice;
  updateRemainingBudgetBtn(totalPrice);

  const previewEl = document.getElementById('format-preview');
  previewEl.value = formattedText;
  previewEl.rows = Math.max(2, formattedText.split('\n').length);
}

function renderCart() {
  const bar = document.getElementById('cart-bar');
  const body = document.getElementById('cart-body');
  const chevron = document.getElementById('cart-chevron');

  if (state.cart.length === 0) {
    bar.classList.add('hidden');
    document.body.classList.remove('cart-expanded');
    return;
  }

  bar.classList.remove('hidden');
  body.classList.toggle('hidden', !state.cartExpanded);
  document.body.classList.toggle('cart-expanded', state.cartExpanded);
  chevron.className = state.cartExpanded ? 'fa-solid fa-chevron-down' : 'fa-solid fa-chevron-up';

  const listEl = document.getElementById('cart-items-list');
  listEl.innerHTML = state.cart.map((entry, idx) => {
    const itemTotal = getCartEntryTotal(entry);
    const displayName = getCartEntryDisplayName(entry);
    const isDrink = entry.category === '飲料';
    const entryStoreNorm = normText(entry.store_name);

    const storeNoteItems = state.menus.filter(
      m => normText(m.store_name) === entryStoreNorm && m.category === '店家備註'
    );

    let optionsHtml = '';
    if (isDrink) {
      const storeToppings = state.menus.filter(
        m => normText(m.store_name) === entryStoreNorm && m.category === '加料'
      );
      if (storeToppings.length > 0) {
        const toppingPills = storeToppings.map(tp => {
          const isAttached = (entry.toppings || []).some(
            t => t.menu_id === tp.id || normText(t.item_name) === normText(tp.item_name)
          );
          const priceTag = tp.price > 0 ? `+$${tp.price}` : '免費';
          return `
            <button type="button" class="opt-pill ${isAttached ? 'active' : ''}"
              onclick="toggleToppingInCartCard(${idx}, '${escapeHtml(tp.id)}')">
              ${escapeHtml(tp.item_name)} ${priceTag}
            </button>`;
        }).join('');
        optionsHtml += `<div class="opt-row"><span class="opt-label">加料</span>${toppingPills}</div>`;
      }

      const extraAttached = (entry.toppings || [])
        .map((t, tIdx) => ({ t, tIdx }))
        .filter(({ t }) => !storeToppings.some(st => st.id === t.menu_id || normText(st.item_name) === normText(t.item_name)));

      if (extraAttached.length > 0) {
        const extraPills = extraAttached.map(({ t, tIdx }) => `
          <button type="button" class="opt-pill active" onclick="removeToppingFromCartCard(${idx}, ${tIdx})">
            +${escapeHtml(t.item_name)} $${t.price} <i class="fa-solid fa-xmark"></i>
          </button>`).join('');
        optionsHtml += `<div class="opt-row"><span class="opt-label">已加</span>${extraPills}</div>`;
      }

      const sugarPills = SUGAR_OPTIONS.map(s => `
        <button type="button" class="opt-pill ${entry.sugar === s ? 'active' : ''}"
          onclick="toggleCartDrinkOption(${idx}, 'sugar', '${s}')">${s}</button>
      `).join('');
      const icePills = ICE_OPTIONS.map(ic => `
        <button type="button" class="opt-pill ${entry.ice === ic ? 'active' : ''}"
          onclick="toggleCartDrinkOption(${idx}, 'ice', '${ic}')">${ic}</button>
      `).join('');

      optionsHtml += `
        <div class="opt-row"><span class="opt-label">甜度</span>${sugarPills}</div>
        <div class="opt-row"><span class="opt-label">冰量</span>${icePills}</div>`;
    } else {
      const activeNotes = entry.custom_note ? entry.custom_note.split('/').map(s => s.trim()) : [];
      const foodPills = FOOD_QUICK_NOTES.map(fn => `
        <button type="button" class="opt-pill ${activeNotes.includes(fn) ? 'active' : ''}"
          onclick="toggleCartQuickNote(${idx}, '${fn}', 0)">${fn}</button>
      `).join('');
      optionsHtml = `<div class="opt-row"><span class="opt-label">快捷</span>${foodPills}</div>`;
    }

    if (storeNoteItems.length > 0) {
      const activeNotes = entry.custom_note ? entry.custom_note.split('/').map(s => s.trim()) : [];
      const snPills = storeNoteItems.map(sn => {
        const label = sn.price > 0 ? `${sn.item_name} (+$${sn.price})` : sn.item_name;
        const isOn = activeNotes.includes(sn.item_name);
        return `
          <button type="button" class="opt-pill ${isOn ? 'active' : ''}"
            onclick="applyStoreNoteToCart(${idx}, '${escapeHtml(sn.id)}')">${escapeHtml(label)}</button>`;
      }).join('');
      optionsHtml += `<div class="opt-row"><span class="opt-label">店註</span>${snPills}</div>`;
    }

    const hasNote = Boolean(entry.custom_note);
    const hasExtra = Number(entry.extra_price) > 0;

    return `
      <div class="cart-item-card">
        <div class="cart-item-top">
          <div>
            <span class="cart-store-tag">${escapeHtml(entry.store_name)}</span>
            <strong>${escapeHtml(displayName)}${entry.spec ? ` (${escapeHtml(entry.spec)})` : ''}</strong>
            <span class="item-meta" id="cart-entry-price-${idx}"> $${itemTotal}</span>
          </div>
          <button type="button" class="icon-btn-plain" style="color:var(--danger);" onclick="removeFromCart(${idx})">
            <i class="fa-solid fa-trash-can"></i>
          </button>
        </div>
        ${optionsHtml}
        <div class="cart-note-row">
          <div class="cart-input-wrap">
            <input type="text" value="${escapeHtml(entry.custom_note)}"
              placeholder="${isDrink ? '其他備註（選填）' : '餐點備註（如：少飯、沙茶/牛肉）'}"
              oninput="updateCartCustomNote(${idx}, this)" />
            <button type="button" class="clear-field-btn ${hasNote ? '' : 'hidden'}"
              onclick="clearCartCustomNote(${idx})" title="清空備註">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
          <div class="cart-price-wrap">
            <input type="number" min="0" step="5" value="${hasExtra ? entry.extra_price : ''}" placeholder="+加價"
              title="額外加價金額" oninput="updateCartExtraPrice(${idx}, this)" />
            <button type="button" class="clear-field-btn ${hasExtra ? '' : 'hidden'}"
              onclick="clearCartExtraPrice(${idx})" title="清空加價">
              <i class="fa-solid fa-xmark"></i>
            </button>
          </div>
        </div>
      </div>`;
  }).join('');

  updateCartTotalsAndPreview();
}

window.applyStoreNoteToCart = function(cartIdx, storeNoteMenuId) {
  const sn = state.menus.find(m => m.id === storeNoteMenuId);
  if (!sn) return;
  toggleCartQuickNote(cartIdx, sn.item_name, Number(sn.price) || 0);
};

/**
 * 確認點餐並複製格式（含飲料未選糖度／冰量防呆再確認）
 */
async function confirmAndCopyOrder() {
  if (state.cart.length === 0 || state.pendingActions.has('createOrder')) return;

  // 檢查購物車內的飲料是否皆已選擇糖度與冰量
  const incompleteDrinks = state.cart.filter(
    e => e.category === '飲料' && (!e.sugar || !e.ice)
  );
  if (incompleteDrinks.length > 0) {
    const details = incompleteDrinks.map(e => {
      const missing = [];
      if (!e.sugar) missing.push('甜度');
      if (!e.ice) missing.push('冰量');
      return `• ${getCartEntryDisplayName(e)}（未選${missing.join('、')}）`;
    }).join('\n');

    const proceed = await askConfirm(`以下飲料尚未選擇甜度或冰量：\n${details}\n\n確定要直接送出並複製嗎？`);
    if (!proceed) return;
  }

  const btnMain = document.getElementById('btn-confirm-copy');
  await runWithLock('createOrder', btnMain, async () => {
    const { totalPrice } = buildFormattedOrderText();
    const finalFormattedText = document.getElementById('format-preview').value.trim();

    await copyTextToClipboard(finalFormattedText);
    if (tg && tg.HapticFeedback) tg.HapticFeedback.notificationOccurred('success');
    showToast('已複製點餐內容！可直接貼到群組');

    const orderItemsPayload = state.cart.map(e => ({
      store_name: e.store_name,
      category: e.category,
      item_name: e.item_name,
      toppings: e.toppings || [],
      spec: e.spec,
      price: getCartEntryTotal(e),
      note: [e.sugar, e.ice, e.custom_note].filter(Boolean).join('/')
    }));

    try {
      await callGasApi('createOrder', {
        items: orderItemsPayload,
        total_price: totalPrice,
        formatted_text: finalFormattedText
      });
      state.cart = [];
      renderCart();
      await syncDashboardFromServer(false);
    } catch (err) {
      showToast(`紀錄寫入失敗：${err.message}`);
    }
  }, '<i class="fa-solid fa-spinner fa-spin"></i> 正在儲存點餐紀錄...');
}

async function copyTextToClipboard(text) {
  if (navigator.clipboard && navigator.clipboard.writeText) {
    try {
      await navigator.clipboard.writeText(text);
      return;
    } catch (e) {}
  }
  const ta = document.createElement('textarea');
  ta.value = text;
  ta.style.position = 'fixed';
  ta.style.opacity = '0';
  document.body.appendChild(ta);
  ta.select();
  document.execCommand('copy');
  document.body.removeChild(ta);
}

/* ==================== 分頁 2：點餐紀錄（鎖定整卡＋立即移除防重複操作） ==================== */

function renderHistory() {
  renderWeeklyAllowanceCard();

  const countHint = document.getElementById('history-count-hint');
  if (countHint) {
    countHint.textContent = `點餐紀錄（共 ${state.orders.length} 筆）`;
  }

  const container = document.getElementById('history-container');
  if (state.orders.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>尚無點餐紀錄</p></div>';
    return;
  }

  container.innerHTML = state.orders.map((ord, oIdx) => {
    const items = Array.isArray(ord.items) ? ord.items : [];
    const itemsHtml = items.map((it, iIdx) => {
      const existingRev = findReviewForOrderItem(ord.order_id, it.store_name, it.item_name);
      const rateBtnHtml = existingRev
        ? `<button class="btn btn-sm rating-good" onclick="openItemRatingModal(${oIdx}, ${iIdx})">
             <i class="fa-solid fa-star"></i> 已評 ${existingRev.rating}★
           </button>`
        : `<button class="btn btn-primary btn-sm" onclick="openItemRatingModal(${oIdx}, ${iIdx})">
             <i class="fa-regular fa-star"></i> 評價此餐
           </button>`;

      const toppingSuffix = Array.isArray(it.toppings) && it.toppings.length > 0
        ? `<span class="topping-badge">+${escapeHtml(it.toppings.map(t => t.item_name).join('+'))}</span>`
        : '';

      return `
        <div class="history-item-row">
          <div style="min-width:0;">
            <span class="cart-store-tag">${escapeHtml(it.store_name || '未標示')}</span>
            <strong>${escapeHtml(it.item_name || '')}</strong>${toppingSuffix}
            <span class="item-meta"> $${it.price || 0}</span>
          </div>
          ${rateBtnHtml}
        </div>`;
    }).join('');

    return `
      <div class="history-card">
        <div class="history-top">
          <span><i class="fa-regular fa-calendar"></i> ${escapeHtml(ord.date)}</span>
          <strong>總計 $${ord.total_price}</strong>
        </div>
        <div class="history-formatted">${escapeHtml(ord.formatted_text)}</div>
        ${itemsHtml ? `<div class="history-items-box">${itemsHtml}</div>` : ''}
        <div class="history-actions">
          <button class="btn btn-ghost btn-sm" onclick="reCopyOrder(${oIdx})">
            <i class="fa-regular fa-copy"></i> 再次複製
          </button>
          <button class="btn btn-danger btn-sm" onclick="confirmDeleteOrder(${oIdx}, this)">
            <i class="fa-solid fa-trash-can"></i> 刪除紀錄
          </button>
        </div>
      </div>`;
  }).join('');
}

window.reCopyOrder = async function(oIdx) {
  const ord = state.orders[oIdx];
  if (!ord) return;
  await copyTextToClipboard(ord.formatted_text);
  showToast('已複製該筆點餐內容');
};

window.confirmDeleteOrder = async function(oIdx, btnEl) {
  const ord = state.orders[oIdx];
  if (!ord) return;
  const lockKey = `del_order_${ord.order_id}`;
  if (state.pendingActions.has(lockKey)) return;

  const confirmed = await askConfirm(`確定要刪除 ${ord.date} 的這筆點餐紀錄嗎？`);
  if (!confirmed) return;

  const cardEl = btnEl ? btnEl.closest('.history-card') : null;
  if (cardEl) cardEl.classList.add('is-deleting');

  await runWithLock(lockKey, btnEl, async () => {
    try {
      await callGasApi('deleteOrder', { order_id: ord.order_id });

      // 後端刪除成功立即從畫面與本地快取移除，杜絕刷新前再次點擊舊卡片
      state.orders = state.orders.filter(o => o.order_id !== ord.order_id);
      state.hasOrderedToday = state.orders.some(o => o.date === state.today);
      persistCurrentStateToCache();
      renderHeader();
      renderMenus();
      renderHistory();
      showToast('已刪除該筆點餐紀錄');

      // 背景靜默與伺服器對齊（不套用舊快取）
      syncDashboardFromServer(false).catch(err => console.warn('背景同步失敗', err));
    } catch (err) {
      if (cardEl && document.body.contains(cardEl)) cardEl.classList.remove('is-deleting');
      showToast(`刪除失敗：${err.message}`);
    }
  }, '<i class="fa-solid fa-spinner fa-spin"></i> 刪除中...');
};

/* ==================== 本週餐費請領統計與請假切換 ==================== */

function getCurrentWeekdaysList() {
  const baseStr = /^\d{4}-\d{2}-\d{2}$/.test(state.today)
    ? state.today
    : new Date().toISOString().slice(0, 10);
  const [y, m, d] = baseStr.split('-').map(Number);
  const baseUtc = new Date(Date.UTC(y, m - 1, d));
  const dow = baseUtc.getUTCDay();
  const diffToMon = dow === 0 ? -6 : 1 - dow;
  const labels = ['一', '二', '三', '四', '五'];

  return labels.map((label, i) => {
    const dt = new Date(baseUtc.getTime() + (diffToMon + i) * 86400000);
    const yy = dt.getUTCFullYear();
    const mm = String(dt.getUTCMonth() + 1).padStart(2, '0');
    const dd = String(dt.getUTCDate()).padStart(2, '0');
    return { date: `${yy}-${mm}-${dd}`, shortDate: `${mm}/${dd}`, label };
  });
}

function renderWeeklyAllowanceCard() {
  const card = document.getElementById('weekly-allowance-card');
  if (!card) return;

  const today = state.today;
  const weekdays = getCurrentWeekdaysList();
  const orderedDates = new Set(state.orders.map(o => o.date));

  let claimableCount = 0;
  let leaveCount = 0;

  const daysHtml = weekdays.map(d => {
    const isToday = d.date === today;
    const isFuture = today && d.date > today;
    const hasOrder = orderedDates.has(d.date);
    const isLeave = state.dailyStatuses[d.date] === 'leave';

    let stClass = 'st-future';
    let stText = '未到';
    let clickable = true;
    let tip = '點擊預排為請假';

    if (hasOrder) {
      stClass = 'st-ordered';
      stText = '公司訂';
      clickable = false;
      tip = '當日已有公司訂餐紀錄';
    } else if (isLeave) {
      stClass = 'st-leave';
      stText = '請假';
      leaveCount++;
      tip = '已標記請假（不請領），點擊可取消';
    } else if (!isFuture) {
      stClass = 'st-claimable';
      stText = '自訂可領';
      claimableCount++;
      tip = '未向公司訂餐（計入可請領），點擊可改為請假';
    }

    const clickAttr = clickable ? `onclick="toggleWeekdayLeaveStatus('${d.date}', this)"` : '';
    return `
      <div class="allowance-day ${stClass} ${clickable ? 'clickable' : ''} ${isToday ? 'is-today' : ''}"
        ${clickAttr} title="${tip}">
        <span class="day-label">週${d.label}</span>
        <span class="day-date">${d.shortDate}</span>
        <span class="day-state">${stText}</span>
      </div>`;
  }).join('');

  const summaryBadge = claimableCount > 0
    ? `<span class="status-badge status-pending"><i class="fa-solid fa-coins"></i> 本週需請領 ${claimableCount} 天</span>`
    : `<span class="status-badge status-done"><i class="fa-solid fa-check"></i> 本週不需請領</span>`;

  card.innerHTML = `
    <div class="allowance-header">
      <span class="allowance-title"><i class="fa-solid fa-calendar-week"></i> 本週餐費請領</span>
      ${summaryBadge}
    </div>
    <div class="allowance-grid">${daysHtml}</div>
    <div class="allowance-hint">
      <i class="fa-regular fa-hand-pointer"></i> 點擊非公司訂餐日期可切換「自訂可領 / 請假（不可領）」${leaveCount > 0 ? ` · 本週請假 ${leaveCount} 天` : ''}
    </div>`;
}

window.toggleWeekdayLeaveStatus = async function(dateStr, el) {
  const lockKey = `status_${dateStr}`;
  if (state.pendingActions.has(lockKey)) return;

  const isCurrentlyLeave = state.dailyStatuses[dateStr] === 'leave';
  const nextStatus = isCurrentlyLeave ? '' : 'leave';
  if (el) el.classList.add('is-deleting');

  await runWithLock(lockKey, [], async () => {
    try {
      // 樂觀更新畫面並寫入後端
      if (nextStatus === 'leave') {
        state.dailyStatuses[dateStr] = 'leave';
      } else {
        delete state.dailyStatuses[dateStr];
      }
      persistCurrentStateToCache();
      renderWeeklyAllowanceCard();

      const freshData = await callGasApi('setDailyStatus', { date: dateStr, status: nextStatus });
      saveCachedDashboard(freshData);
      applyDashboardData(freshData);
      showToast(nextStatus === 'leave' ? `已標記 ${dateStr} 為請假（不請領）` : `已取消 ${dateStr} 請假標記`);
    } catch (err) {
      showToast(`更新失敗：${err.message}`);
      await syncDashboardFromServer(false).catch(() => {});
    }
  });
};

/* ==================== 手動批次匯入歷史點餐紀錄 ==================== */

function openImportHistoryModal() {
  state.parsedImportOrders = [];
  document.getElementById('import-raw-text').value = '';
  const previewEl = document.getElementById('import-preview-list');
  previewEl.innerHTML = '';
  previewEl.classList.add('hidden');
  document.getElementById('btn-confirm-import').classList.add('hidden');
  document.getElementById('import-history-modal').classList.remove('hidden');
}

/**
 * 解析各種日常群組點餐文字格式（支援空行分段、Telegram 日期標頭、共$150 / 共150$、單行與無價品項）
 */
function parseHistoryTextBlocks(rawText) {
  // 若使用者直接複製多則 Telegram 訊息未留空行，自動於 [YYYY/MM/DD ...] 標頭前插入空行分段
  const normalized = String(rawText || '')
    .replace(/\r\n/g, '\n')
    .replace(/(?<!\n\n)\n(?=\[\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2})/g, '\n\n')
    .trim();

  if (!normalized) return [];

  const blocks = normalized.split(/\n\s*\n+/).map(b => b.trim()).filter(Boolean);
  const currentYear = /^\d{4}/.test(state.today) ? state.today.slice(0, 4) : String(new Date().getFullYear());
  const parsedOrders = [];

  blocks.forEach(block => {
    const lines = block.split('\n').map(l => l.trim()).filter(Boolean);
    let orderDate = '歷史匯入';
    let explicitTotal = null;
    const items = [];
    const keptTextLines = [];

    lines.forEach(line => {
      // 1. 偵測日期列（支援 [2026/11/20 ...] 或 2026-11-20 或 11/20）
      const fullDateMatch = line.match(/^\[?(\d{4})[\/\-](\d{1,2})[\/\-](\d{1,2})/);
      if (fullDateMatch && (line.startsWith('[') || /^\d{4}[\/\-]\d{1,2}[\/\-]\d{1,2}$/.test(line))) {
        orderDate = `${fullDateMatch[1]}-${fullDateMatch[2].padStart(2, '0')}-${fullDateMatch[3].padStart(2, '0')}`;
        return;
      }
      const shortDateMatch = line.match(/^(\d{1,2})[\/\-](\d{1,2})$/);
      if (shortDateMatch) {
        orderDate = `${currentYear}-${shortDateMatch[1].padStart(2, '0')}-${shortDateMatch[2].padStart(2, '0')}`;
        return;
      }

      keptTextLines.push(line);

      // 2. 偵測總計列（支援 共 $150 謝謝 / 共150$ 謝謝 / 共$140）
      const totalMatch = line.match(/^共\s*\$?\s*(\d+)\s*\$?/);
      if (totalMatch) {
        explicitTotal = Number(totalMatch[1]);
        return;
      }

      // 3. 解析單一品項列
      let clean = line.replace(/\s*(謝謝|感謝)[!！~。.\s]*$/g, '').trim();
      if (!clean) return;

      let price = 0;
      const priceMatch = clean.match(/(?:\$\s*(\d+)|(\d+)\s*\$)\s*$/);
      if (priceMatch) {
        price = Number(priceMatch[1] || priceMatch[2]) || 0;
        clean = clean.slice(0, priceMatch.index).trim();
      }

      let storeName = '未標示店家';
      let rawItem = clean;
      const dashIdx = clean.search(/[-－]/);
      if (dashIdx > 0) {
        storeName = clean.slice(0, dashIdx).trim();
        rawItem = clean.slice(dashIdx + 1).trim();
      }

      // 萃取小括號備註並清理品項名稱（方便與菜單及評價比對）
      const notes = [];
      const itemName = rawItem
        .replace(/[（(]([^）)]+)[）)]/g, (_, inner) => {
          notes.push(inner.trim());
          return ' ';
        })
        .replace(/\s+/g, ' ')
        .trim();

      if (itemName) {
        items.push({
          store_name: storeName,
          category: '主餐',
          item_name: itemName,
          toppings: [],
          spec: '',
          price: price,
          note: notes.join('/')
        });
      }
    });

    if (items.length > 0) {
      const summed = items.reduce((acc, it) => acc + (Number(it.price) || 0), 0);
      parsedOrders.push({
        date: orderDate,
        items: items,
        total_price: explicitTotal !== null ? explicitTotal : summed,
        formatted_text: keptTextLines.join('\n')
      });
    }
  });

  return parsedOrders;
}

function previewHistoryImport() {
  const rawText = document.getElementById('import-raw-text').value;
  const parsed = parseHistoryTextBlocks(rawText);
  state.parsedImportOrders = parsed;

  const previewEl = document.getElementById('import-preview-list');
  const confirmBtn = document.getElementById('btn-confirm-import');

  if (parsed.length === 0) {
    previewEl.innerHTML = '<div class="empty-state" style="padding:14px;">無法解析任何紀錄，請確認格式（店家 - 品項 $金額）</div>';
    previewEl.classList.remove('hidden');
    confirmBtn.classList.add('hidden');
    return;
  }

  previewEl.innerHTML = parsed.map((ord, idx) => {
    const itemLines = ord.items.map(it => {
      const noteStr = it.note ? ` (${escapeHtml(it.note)})` : '';
      const priceStr = it.price > 0 ? `$${it.price}` : '無標價';
      return `<div class="import-preview-line">• <strong>${escapeHtml(it.store_name)}</strong> - ${escapeHtml(it.item_name)}${noteStr} <span class="item-meta">${priceStr}</span></div>`;
    }).join('');

    return `
      <div class="import-preview-card">
        <div class="import-preview-head">
          <span>#${idx + 1} · ${escapeHtml(ord.date)}</span>
          <span>總計 $${ord.total_price}</span>
        </div>
        ${itemLines}
      </div>`;
  }).join('');

  previewEl.classList.remove('hidden');
  confirmBtn.innerHTML = `<i class="fa-solid fa-cloud-arrow-up"></i> 確認匯入 ${parsed.length} 筆紀錄`;
  confirmBtn.classList.remove('hidden');
}

async function submitBatchImportOrders() {
  if (state.parsedImportOrders.length === 0) return;

  const btn = document.getElementById('btn-confirm-import');
  await runWithLock('batchImportOrders', btn, async () => {
    try {
      const res = await callGasApi('batchImportOrders', { orders: state.parsedImportOrders });
      closeModal('import-history-modal');
      showToast(`成功匯入 ${res.imported} 筆歷史點餐紀錄！`);
      await syncDashboardFromServer(false);
    } catch (err) {
      showToast(`匯入失敗：${err.message}`);
    }
  }, '<i class="fa-solid fa-spinner fa-spin"></i> 正在寫入試算表...');
}

/* ==================== 單一品項獨立評價彈窗 ==================== */

window.openItemRatingModal = function(oIdx, iIdx) {
  const ord = state.orders[oIdx];
  if (!ord || !ord.items || !ord.items[iIdx]) return;
  const item = ord.items[iIdx];

  state.activeReviewTarget = {
    order_id: ord.order_id,
    store_name: item.store_name || '未標示店家',
    item_name: item.item_name || ''
  };
  state.selectedRating = 5;

  document.getElementById('modal-review-target').innerHTML = `
    <span class="cart-store-tag">${escapeHtml(state.activeReviewTarget.store_name)}</span>
    <strong>${escapeHtml(state.activeReviewTarget.item_name)}</strong>
    <span class="item-meta">（${escapeHtml(ord.date)}）</span>`;
  document.getElementById('review-comment').value = '';
  document.querySelectorAll('#quick-tags .tag-chip').forEach(el => el.classList.remove('selected'));
  updateStarUI(5);

  document.getElementById('rating-modal').classList.remove('hidden');
};

function updateStarUI(val) {
  state.selectedRating = val;
  document.querySelectorAll('#star-selector i').forEach(star => {
    star.classList.toggle('active', Number(star.dataset.val) <= val);
  });
}

async function submitReview() {
  const target = state.activeReviewTarget;
  if (!target) return;

  const btn = document.getElementById('btn-submit-review');
  await runWithLock('submitReview', btn, async () => {
    const selectedTags = [...document.querySelectorAll('#quick-tags .tag-chip.selected')]
      .map(el => el.dataset.tag)
      .join(' ');
    const comment = document.getElementById('review-comment').value.trim();

    try {
      await callGasApi('submitReview', {
        order_id: target.order_id,
        store_name: target.store_name,
        item_name: target.item_name,
        rating: state.selectedRating,
        tags: selectedTags,
        comment: comment
      });
      closeModal('rating-modal');
      showToast(`已送出「${target.item_name}」的評價！`);
      await syncDashboardFromServer(false);
    } catch (err) {
      showToast(`評價失敗：${err.message}`);
    }
  }, '<i class="fa-solid fa-spinner fa-spin"></i> 送出中...');
}

/* ==================== 分頁 3：歷史評價查詢（鎖定整卡＋立即移除） ==================== */

function renderReviewsTab() {
  const container = document.getElementById('reviews-container');
  const kw = state.reviewSearch.trim().toLowerCase();

  const filtered = state.reviews.filter(r => {
    if (state.reviewFilter === 'good' && r.rating < 4) return false;
    if (state.reviewFilter === 'mid' && r.rating !== 3) return false;
    if (state.reviewFilter === 'bad' && r.rating > 2) return false;

    if (kw) {
      const hay = `${r.store_name} ${r.item_name} ${r.tags} ${r.comment}`.toLowerCase();
      if (!hay.includes(kw)) return false;
    }
    return true;
  });

  if (filtered.length === 0) {
    container.innerHTML = '<div class="empty-state"><p>找不到符合條件的歷史評價</p></div>';
    return;
  }

  container.innerHTML = filtered.map(r => {
    const starsHtml = '<i class="fa-solid fa-star"></i>'.repeat(Math.max(1, Math.min(5, r.rating)));
    const cls = getRatingColorClass(r.rating);
    return `
      <div class="review-card">
        <div class="review-card-top">
          <div>
            <span class="cart-store-tag">${escapeHtml(r.store_name)}</span>
            <strong>${escapeHtml(r.item_name || '（整店評價）')}</strong>
          </div>
          <div style="display:flex;align-items:center;gap:6px;">
            <span class="rating-badge ${cls}">${r.rating}★</span>
            <button class="icon-btn-plain" style="color:var(--danger);" onclick="confirmDeleteReview('${escapeHtml(r.review_id)}', this)" title="刪除此評價">
              <i class="fa-solid fa-trash-can"></i>
            </button>
          </div>
        </div>
        <div class="item-meta">
          <span class="review-stars">${starsHtml}</span> · ${escapeHtml(r.date)}
        </div>
        ${r.tags ? `<div class="review-tags">${escapeHtml(r.tags)}</div>` : ''}
        ${r.comment ? `<div class="review-comment">${escapeHtml(r.comment)}</div>` : ''}
      </div>`;
  }).join('');
}

window.confirmDeleteReview = async function(reviewId, btnEl) {
  const lockKey = `del_rev_${reviewId}`;
  if (state.pendingActions.has(lockKey)) return;

  const confirmed = await askConfirm('確定要刪除這筆評價嗎？');
  if (!confirmed) return;

  const cardEl = btnEl ? btnEl.closest('.review-card') : null;
  if (cardEl) cardEl.classList.add('is-deleting');

  await runWithLock(lockKey, btnEl, async () => {
    try {
      await callGasApi('deleteReview', { review_id: reviewId });

      // 立即從畫面與本地快取移除，避免刷新前可再次點擊
      state.reviews = state.reviews.filter(r => r.review_id !== reviewId);
      persistCurrentStateToCache();
      renderReviewsTab();
      renderMenus();
      renderHistory();
      showToast('已刪除該筆評價');

      syncDashboardFromServer(false).catch(err => console.warn('背景同步失敗', err));
    } catch (err) {
      if (cardEl && document.body.contains(cardEl)) cardEl.classList.remove('is-deleting');
      showToast(`刪除失敗：${err.message}`);
    }
  }, '<i class="fa-solid fa-spinner fa-spin"></i>');
};

/* ==================== 菜單庫挑選與批次切換今日店家 ==================== */

window.openStoreLibraryModal = function() {
  state.storeLibSearch = '';
  document.getElementById('store-lib-search').value = '';
  state.draftSelectedStores = new Set(
    state.savedStores.filter(s => s.is_today).map(s => s.store_name)
  );
  renderStoreLibraryList();
  document.getElementById('store-library-modal').classList.remove('hidden');
};

function renderStoreLibraryList() {
  const listEl = document.getElementById('store-library-list');
  const hintEl = document.getElementById('store-lib-selected-hint');
  hintEl.textContent = `已勾選 ${state.draftSelectedStores.size} 家（共 ${state.savedStores.length} 家）`;

  if (state.savedStores.length === 0) {
    listEl.innerHTML = '<div class="empty-state" style="padding:20px 8px;">菜單庫目前為空，請先轉發一張菜單圖片給 Bot</div>';
    return;
  }

  const kw = state.storeLibSearch.trim().toLowerCase();
  const rows = state.savedStores
    .map((st, idx) => ({ st, idx }))
    .filter(({ st }) => !kw || st.store_name.toLowerCase().includes(kw));

  if (rows.length === 0) {
    listEl.innerHTML = '<div class="empty-state" style="padding:20px 8px;">找不到符合關鍵字的店家</div>';
    return;
  }

  listEl.innerHTML = rows.map(({ st, idx }) => {
    const isSelected = state.draftSelectedStores.has(st.store_name);
    const checkIcon = isSelected ? 'fa-solid fa-square-check' : 'fa-regular fa-square';
    const lastUsedText = st.last_date ? `上次：${escapeHtml(st.last_date)}` : '尚未啟用';
    const ratingStats = getStoreRatingStats(st.store_name);
    const ratingStr = ratingStats.avg !== null ? ` · ★${ratingStats.avg}` : '';

    return `
      <div class="store-lib-row ${isSelected ? 'selected' : ''}" onclick="toggleDraftStore(${idx})">
        <div class="store-lib-left">
          <i class="${checkIcon} store-lib-check"></i>
          <div style="min-width:0;">
            <div class="store-lib-name">${escapeHtml(st.store_name)}</div>
            <div class="item-meta">${st.item_count} 品項 · ${lastUsedText}${ratingStr}</div>
          </div>
        </div>
        <button type="button" class="icon-btn-plain" style="color:var(--danger);"
          onclick="event.stopPropagation(); confirmDeleteSavedStore(${idx}, this)" title="從菜單庫永久刪除">
          <i class="fa-solid fa-trash-can"></i>
        </button>
      </div>`;
  }).join('');
}

window.toggleDraftStore = function(storeIdx) {
  const st = state.savedStores[storeIdx];
  if (!st) return;
  if (state.draftSelectedStores.has(st.store_name)) {
    state.draftSelectedStores.delete(st.store_name);
  } else {
    state.draftSelectedStores.add(st.store_name);
  }
  if (tg && tg.HapticFeedback) tg.HapticFeedback.impactOccurred('light');
  renderStoreLibraryList();
};

async function applyStoreLibrarySelection() {
  const btn = document.getElementById('btn-apply-store-library');
  await runWithLock('applyStoreLibrary', btn, async () => {
    try {
      const activeStores = Array.from(state.draftSelectedStores);
      const freshData = await callGasApi('setTodayStores', { active_stores: activeStores });
      state.expandedStores.clear();
      if (activeStores.length === 1) {
        state.expandedStores.add(activeStores[0]);
      }
      saveCachedDashboard(freshData);
      applyDashboardData(freshData);
      closeModal('store-library-modal');
      showToast(activeStores.length > 0 ? `已啟用 ${activeStores.length} 家今日菜單` : '已清空今日啟用清單');
    } catch (err) {
      showToast(`套用失敗：${err.message}`);
    }
  }, '<i class="fa-solid fa-spinner fa-spin"></i> 套用中...');
}

window.confirmDeleteSavedStore = async function(storeIdx, btnEl) {
  const st = state.savedStores[storeIdx];
  if (!st) return;
  const lockKey = `del_store_${st.store_name}`;
  if (state.pendingActions.has(lockKey)) return;

  const confirmed = await askConfirm(`確定要從菜單庫永久刪除「${st.store_name}」嗎？（不會影響歷史點餐紀錄與評價）`);
  if (!confirmed) return;

  const rowEl = btnEl ? btnEl.closest('.store-lib-row') : null;
  if (rowEl) rowEl.classList.add('is-deleting');

  await runWithLock(lockKey, btnEl, async () => {
    try {
      const freshData = await callGasApi('deleteSavedStore', { store_name: st.store_name });
      state.draftSelectedStores.delete(st.store_name);
      saveCachedDashboard(freshData);
      applyDashboardData(freshData);
      renderStoreLibraryList();
      showToast(`已從菜單庫永久刪除「${st.store_name}」`);
    } catch (err) {
      if (rowEl && document.body.contains(rowEl)) rowEl.classList.remove('is-deleting');
      showToast(`刪除失敗：${err.message}`);
    }
  }, '<i class="fa-solid fa-spinner fa-spin"></i>');
};

/* ==================== 手動編輯店名、品項與金額 ==================== */

function populateStoreDropdown(presetStoreName) {
  const selectEl = document.getElementById('edit-store-select');
  const inputEl = document.getElementById('edit-store-name');

  const nameSet = new Set();
  state.storeOrderList.forEach(n => nameSet.add(n));
  state.savedStores.forEach(s => { if (s.store_name) nameSet.add(s.store_name); });
  const allNames = Array.from(nameSet);

  const optionsHtml = [
    '<option value="__CUSTOM__">＋ 手動輸入新店家...</option>',
    ...allNames.map(n => `<option value="${escapeHtml(n)}">${escapeHtml(n)}</option>`)
  ].join('');

  selectEl.innerHTML = optionsHtml;

  if (presetStoreName && allNames.includes(presetStoreName)) {
    selectEl.value = presetStoreName;
    inputEl.value = presetStoreName;
  } else {
    selectEl.value = '__CUSTOM__';
    inputEl.value = presetStoreName || '';
  }
}

window.openRenameStoreModal = function(storeIdx) {
  const oldName = state.storeOrderList[storeIdx];
  if (!oldName) return;
  document.getElementById('rename-old-store').value = oldName;
  document.getElementById('rename-new-store').value = oldName;
  document.getElementById('store-rename-modal').classList.remove('hidden');
};

async function saveStoreRename() {
  const oldName = document.getElementById('rename-old-store').value;
  const newName = document.getElementById('rename-new-store').value.trim();
  if (!newName) {
    showToast('請輸入店家名稱');
    return;
  }

  const btn = document.getElementById('btn-save-store-rename');
  await runWithLock('renameStore', btn, async () => {
    try {
      await callGasApi('renameTodayStore', { old_store_name: oldName, new_store_name: newName });
      if (state.expandedStores.has(oldName)) {
        state.expandedStores.delete(oldName);
        state.expandedStores.add(newName);
      }
      state.cart.forEach(c => { if (c.store_name === oldName) c.store_name = newName; });
      renderCart();
      closeModal('store-rename-modal');
      showToast('已更新店家名稱並同步歷史關聯');
      await syncDashboardFromServer(false);
    } catch (err) {
      showToast(`修改失敗：${err.message}`);
    }
  }, '<i class="fa-solid fa-spinner fa-spin"></i> 更新中...');
}

window.openAddMenuModalForStore = function(storeIdx) {
  const storeName = storeIdx >= 0 ? (state.storeOrderList[storeIdx] || '') : '';
  document.getElementById('menu-modal-title').innerHTML = '<i class="fa-solid fa-plus"></i> 手動新增品項 / 店家備註';
  document.getElementById('edit-menu-id').value = '';
  populateStoreDropdown(storeName);
  document.getElementById('edit-category').value = '主餐';
  document.getElementById('edit-item-name').value = '';
  document.getElementById('edit-price').value = 0;
  document.getElementById('edit-spec').value = '';
  document.getElementById('edit-note').value = '';
  document.getElementById('btn-delete-menu-item').classList.add('hidden');
  document.getElementById('menu-edit-modal').classList.remove('hidden');
};

window.openEditMenuModalById = function(menuId) {
  const item = state.menus.find(m => m.id === menuId);
  if (!item) return;

  document.getElementById('menu-modal-title').innerHTML = '<i class="fa-solid fa-pen-to-square"></i> 編輯品項與金額';
  document.getElementById('edit-menu-id').value = item.id;
  populateStoreDropdown(item.store_name);
  document.getElementById('edit-category').value = item.category;
  document.getElementById('edit-item-name').value = item.item_name;
  document.getElementById('edit-price').value = item.price;
  document.getElementById('edit-spec').value = item.spec || '';
  document.getElementById('edit-note').value = item.note || '';
  document.getElementById('btn-delete-menu-item').classList.remove('hidden');
  document.getElementById('menu-edit-modal').classList.remove('hidden');
};

async function saveMenuItemEdit() {
  const menuId = document.getElementById('edit-menu-id').value;
  const payload = {
    menu_id: menuId,
    store_name: document.getElementById('edit-store-name').value.trim(),
    category: document.getElementById('edit-category').value,
    item_name: document.getElementById('edit-item-name').value.trim(),
    price: Number(document.getElementById('edit-price').value) || 0,
    spec: document.getElementById('edit-spec').value.trim(),
    note: document.getElementById('edit-note').value.trim()
  };

  if (!payload.store_name || !payload.item_name) {
    showToast('店家名稱與品項名稱不可為空');
    return;
  }

  const saveBtn = document.getElementById('btn-save-menu-item');
  const delBtn = document.getElementById('btn-delete-menu-item');

  await runWithLock('menuItemMutation', [saveBtn, delBtn], async () => {
    try {
      const action = menuId ? 'updateMenuItem' : 'addMenuItem';
      await callGasApi(action, payload);
      state.expandedStores.add(payload.store_name);
      closeModal('menu-edit-modal');
      showToast(menuId ? '已更新品項資料' : '已新增品項至今日菜單');
      await syncDashboardFromServer(false);
    } catch (err) {
      showToast(`儲存失敗：${err.message}`);
    }
  }, '<i class="fa-solid fa-spinner fa-spin"></i> 儲存中...');
}

async function deleteEditingMenuItem() {
  const menuId = document.getElementById('edit-menu-id').value;
  if (!menuId || state.pendingActions.has('menuItemMutation')) return;

  const confirmed = await askConfirm('確定要從今日菜單刪除此品項嗎？');
  if (!confirmed) return;

  const delBtn = document.getElementById('btn-delete-menu-item');
  const saveBtn = document.getElementById('btn-save-menu-item');

  await runWithLock('menuItemMutation', [delBtn, saveBtn], async () => {
    try {
      await callGasApi('deleteMenuItem', { menu_id: menuId });
      state.menus = state.menus.filter(m => m.id !== menuId);
      persistCurrentStateToCache();
      renderMenus();
      closeModal('menu-edit-modal');
      showToast('已刪除此品項');
      syncDashboardFromServer(false).catch(err => console.warn('背景同步失敗', err));
    } catch (err) {
      showToast(`刪除失敗：${err.message}`);
    }
  }, '<i class="fa-solid fa-spinner fa-spin"></i> 刪除中...');
}

/* ==================== 共用控制與事件綁定 ==================== */

function switchTab(tabId) {
  document.querySelectorAll('.tab-btn').forEach(b => b.classList.toggle('active', b.dataset.tab === tabId));
  document.querySelectorAll('.tab-content').forEach(c => c.classList.toggle('active', c.id === tabId));
}

function closeModal(modalId) {
  document.getElementById(modalId).classList.add('hidden');
}

function bindEvents() {
  document.querySelectorAll('.tab-btn').forEach(btn => {
    btn.addEventListener('click', () => switchTab(btn.dataset.tab));
  });

  document.getElementById('btn-refresh').addEventListener('click', () => {
    const btn = document.getElementById('btn-refresh');
    runWithLock('refreshDashboard', btn, () => initDashboard(true), '<i class="fa-solid fa-rotate fa-spin"></i>');
  });

  // 預算輸入變動時同步更新購物車剩餘預算按鈕
  document.getElementById('budget-input').addEventListener('input', () => {
    if (state.cart.length > 0) {
      const total = state.cart.reduce((sum, e) => sum + getCartEntryTotal(e), 0);
      updateRemainingBudgetBtn(total);
    }
  });

  document.getElementById('btn-recommend').addEventListener('click', recommendCombos);
  document.getElementById('btn-clear-recommend').addEventListener('click', clearRecommendedCombos);
  document.getElementById('btn-add-custom-item').addEventListener('click', () => openAddMenuModalForStore(-1));

  // 菜單價格篩選、排序與一鍵全部展開/收合
  const priceFilterInput = document.getElementById('menu-max-price');
  const clearPriceBtn = document.getElementById('btn-clear-price-filter');
  priceFilterInput.addEventListener('input', () => {
    const val = Number(priceFilterInput.value);
    state.menuMaxPrice = val > 0 ? val : null;
    clearPriceBtn.classList.toggle('hidden', state.menuMaxPrice === null);
    renderMenus();
  });
  clearPriceBtn.addEventListener('click', () => {
    priceFilterInput.value = '';
    state.menuMaxPrice = null;
    clearPriceBtn.classList.add('hidden');
    renderMenus();
  });
  document.getElementById('menu-sort-select').addEventListener('change', (e) => {
    state.menuSortBy = e.target.value;
    renderMenus();
  });
  document.getElementById('btn-toggle-all-stores').addEventListener('click', () => {
    const allExpanded = state.storeOrderList.length > 0 &&
      state.storeOrderList.every(name => state.expandedStores.has(name));
    if (allExpanded) {
      state.expandedStores.clear();
    } else {
      state.storeOrderList.forEach(name => state.expandedStores.add(name));
    }
    renderMenus();
  });

  // 編輯品項彈窗：店家下拉選單與輸入框雙向同步
  const storeSelect = document.getElementById('edit-store-select');
  const storeInput = document.getElementById('edit-store-name');
  storeSelect.addEventListener('change', () => {
    if (storeSelect.value === '__CUSTOM__') {
      storeInput.value = '';
      storeInput.focus();
    } else {
      storeInput.value = storeSelect.value;
    }
  });
  storeInput.addEventListener('input', () => {
    const typed = storeInput.value.trim();
    const matchedOpt = [...storeSelect.options].find(o => o.value === typed);
    storeSelect.value = matchedOpt ? matchedOpt.value : '__CUSTOM__';
  });

  // 回到頂部按鈕
  const backToTopBtn = document.getElementById('btn-back-to-top');
  window.addEventListener('scroll', () => {
    backToTopBtn.classList.toggle('hidden', window.scrollY < 240);
  }, { passive: true });
  backToTopBtn.addEventListener('click', () => {
    window.scrollTo({ top: 0, behavior: 'smooth' });
  });

  // 購物車展開／收合、剩餘預算篩選與送出
  document.getElementById('cart-toggle-bar').addEventListener('click', (e) => {
    if (e.target.closest('button') && !e.target.closest('#btn-toggle-cart')) return;
    state.cartExpanded = !state.cartExpanded;
    renderCart();
  });
  document.getElementById('btn-apply-remaining-budget').addEventListener('click', (e) => {
    e.stopPropagation();
    applyRemainingBudgetToFilter();
  });
  document.getElementById('btn-clear-cart').addEventListener('click', () => {
    state.cart = [];
    renderCart();
  });
  document.getElementById('btn-confirm-copy').addEventListener('click', confirmAndCopyOrder);

  // 句尾加謝謝開關
  const thanksToggle = document.getElementById('toggle-append-thanks');
  const savedThanks = localStorage.getItem('tg_meal_append_thanks');
  if (savedThanks !== null) {
    state.appendThanks = savedThanks === '1';
  }
  thanksToggle.checked = state.appendThanks;
  thanksToggle.addEventListener('change', () => {
    state.appendThanks = thanksToggle.checked;
    localStorage.setItem('tg_meal_append_thanks', state.appendThanks ? '1' : '0');
    updateFormattedPreview();
  });

  // 加料彈窗：獨立加入
  document.getElementById('btn-add-topping-standalone').addEventListener('click', () => {
    if (!state.pendingToppingItem) return;
    state.cart.push(createCartEntry(state.pendingToppingItem));
    state.pendingToppingItem = null;
    state.cartExpanded = true;
    closeModal('topping-target-modal');
    renderCart();
  });

  // 菜單庫彈窗事件
  document.getElementById('btn-open-store-library').addEventListener('click', openStoreLibraryModal);
  document.getElementById('store-lib-search').addEventListener('input', (e) => {
    state.storeLibSearch = e.target.value;
    renderStoreLibraryList();
  });
  document.getElementById('btn-uncheck-all-stores').addEventListener('click', () => {
    state.draftSelectedStores.clear();
    renderStoreLibraryList();
  });
  document.getElementById('btn-apply-store-library').addEventListener('click', applyStoreLibrarySelection);

  // 歷史評價查詢與篩選
  const searchInput = document.getElementById('review-search-input');
  const clearBtn = document.getElementById('btn-clear-search');
  searchInput.addEventListener('input', () => {
    state.reviewSearch = searchInput.value;
    clearBtn.classList.toggle('hidden', !searchInput.value);
    renderReviewsTab();
  });
  clearBtn.addEventListener('click', () => {
    searchInput.value = '';
    state.reviewSearch = '';
    clearBtn.classList.add('hidden');
    renderReviewsTab();
  });
  document.querySelectorAll('#review-rating-filters .filter-chip').forEach(chip => {
    chip.addEventListener('click', () => {
      document.querySelectorAll('#review-rating-filters .filter-chip').forEach(c => c.classList.remove('active'));
      chip.classList.add('active');
      state.reviewFilter = chip.dataset.filter;
      renderReviewsTab();
    });
  });

  // 彈窗操作與 ESC 鍵關閉
  document.querySelectorAll('[data-close-modal]').forEach(btn => {
    btn.addEventListener('click', () => closeModal(btn.dataset.closeModal));
  });
  document.querySelectorAll('#star-selector i').forEach(star => {
    star.addEventListener('click', () => updateStarUI(Number(star.dataset.val)));
  });
  document.querySelectorAll('#quick-tags .tag-chip').forEach(chip => {
    chip.addEventListener('click', () => chip.classList.toggle('selected'));
  });
  document.getElementById('btn-submit-review').addEventListener('click', submitReview);
  document.getElementById('btn-save-store-rename').addEventListener('click', saveStoreRename);
  document.getElementById('btn-save-menu-item').addEventListener('click', saveMenuItemEdit);
  document.getElementById('btn-delete-menu-item').addEventListener('click', deleteEditingMenuItem);
  // 批次匯入歷史紀錄彈窗事件
  document.getElementById('btn-open-import-history').addEventListener('click', openImportHistoryModal);
  document.getElementById('btn-parse-import').addEventListener('click', previewHistoryImport);
  document.getElementById('btn-confirm-import').addEventListener('click', submitBatchImportOrders);

  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') {
      closeModal('rating-modal');
      closeModal('menu-edit-modal');
      closeModal('store-rename-modal');
      closeModal('topping-target-modal');
      closeModal('store-library-modal');
      closeModal('import-history-modal');
    }
  });
}

function showToast(msg) {
  const toast = document.getElementById('toast');
  toast.textContent = msg;
  toast.classList.remove('hidden');
  clearTimeout(window._toastTimer);
  window._toastTimer = setTimeout(() => toast.classList.add('hidden'), 2600);
}
