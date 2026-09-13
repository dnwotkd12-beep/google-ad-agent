/**
 * Google Ads Performance & Anomaly Surveillance Intelligence Engine
 * Designed in Mastercard Aesthetic System
 */

(function () {
  'use strict';

  // =========================================================================
  // 1. State Management & Constants
  // =========================================================================
  const STATE = {
    allData: [],          // Raw rows parsed into objects
    filteredData: [],     // Rows after applying global filters
    campaignMap: new Map(), // campaignId -> anomaly diagnosis & statistics
    countryMap: new Map(),  // country -> anomaly diagnosis & statistics

    filters: {
      country: 'ALL',
      product: 'ALL',
      keywordType: 'ALL',
      campaign: 'ALL',
      anomalyStatus: 'ALL',
      search: '',
    },

    activeMetric: 'impr',       // 'cost' | 'impr' | 'clicks' | 'conversions' | 'ctr' | 'cpc' | 'cpm' | 'cpa'
    viewMode: 'single',         // 'single' | 'multi' (by product)
    rankingTab: 'country',      // 'country' | 'campaign'
    rankingSort: 'volume',      // 'volume' | 'shift'
    rankingDirection: 'all',    // 'all' | 'up' | 'down'
    threshold: 30,              // ±30% anomaly sensitivity threshold

    // Table pagination & sorting
    tablePage: 1,
    tablePageSize: 15,
    tableSortCol: 'date',
    tableSortAsc: false,

    theme: localStorage.getItem('mc_ads_theme') || 'light'
  };

  const METRIC_CONFIG = {
    cost: { label: '비용', unit: '$', format: (v) => '$' + v.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 }), color: '#F79E1B' },
    impr: { label: '노출수', unit: '회', format: (v) => Math.round(v).toLocaleString() + '회', color: '#3860BE' },
    clicks: { label: '클릭수', unit: '회', format: (v) => Math.round(v).toLocaleString() + '회', color: '#1E8E3E' },
    conversions: { label: '전환수', unit: '건', format: (v) => Math.round(v).toLocaleString() + '건', color: '#CF4500' },
    ctr: { label: 'CTR', unit: '%', format: (v) => v.toFixed(2) + '%', color: '#9333EA' },
    cpc: { label: 'CPC', unit: '$', format: (v) => '$' + v.toFixed(2), color: '#0D9488' },
    cpm: { label: 'CPM', unit: '$', format: (v) => '$' + v.toFixed(2), color: '#E11D48' },
    cpa: { label: 'CPA', unit: '$', format: (v) => '$' + v.toFixed(2), color: '#D97706' }
  };

  const COUNTRY_FLAGS = {
    '독일': '🇩🇪',
    '프랑스': '🇫🇷',
    '영국': '🇬🇧',
    '스페인': '🇪🇸',
    '호주': '🇦🇺',
    '일본': '🇯🇵',
    '대만': '🇹🇼',
    '멕시코': '멕시코 🇲🇽',
    '멕시코': '🇲🇽',
    '브라질': '🇧🇷',
    '인도네시아': '🇮🇩'
  };

  const PRODUCT_CODES = {
    '냉장고': 'REF',
    '세탁기': 'WM',
    '전자레인지': 'MWO',
    'TV': 'TV'
  };

  let chartInstance = null;

  // =========================================================================
  // 2. Initialization & Data Ingestion
  // =========================================================================
  document.addEventListener('DOMContentLoaded', () => {
    applyTheme(STATE.theme);
    initEvents();
    initCustomDropdowns();
    loadDataset();
  });

  function applyTheme(theme) {
    STATE.theme = theme;
    document.documentElement.setAttribute('data-theme', theme);
    localStorage.setItem('mc_ads_theme', theme);
    if (chartInstance) {
      renderChart();
    }
  }

  function loadDataset() {
    if (window.RAW_DATA && Array.isArray(window.RAW_DATA) && window.RAW_DATA.length > 0) {
      processRawRows(window.RAW_DATA);
    } else {
      fetch('google_search_ads_daily_trend.csv')
        .then(res => res.text())
        .then(csvText => parseCsvString(csvText))
        .catch(err => {
          console.error('Data load error:', err);
          showToast('데이터를 불러오는데 실패했습니다: ' + err.message);
        });
    }
  }

  function processRawRows(rows) {
    const list = [];
    for (let i = 0; i < rows.length; i++) {
      const r = rows[i];
      const product = String(r[0]).trim();
      const country = String(r[1]).trim();
      const kwType = String(r[2]).trim();
      const date = String(r[3]).trim();
      const cost = parseFloat(r[4]) || 0;
      const impr = parseInt(r[5], 10) || 0;
      const clicks = parseInt(r[6], 10) || 0;
      const conversions = parseInt(r[7], 10) || 0;
      
      const campaign = `${product}_${country}_${kwType}`;
      const ctr = impr > 0 ? (clicks / impr) * 100 : 0;
      const cpc = clicks > 0 ? (cost / clicks) : 0;
      const cpm = impr > 0 ? (cost / impr) * 1000 : 0;
      const cpa = conversions > 0 ? (cost / conversions) : 0;

      list.push({
        id: i + 1,
        product,
        country,
        keywordType: kwType,
        date,
        cost,
        impr,
        clicks,
        conversions,
        campaign,
        ctr,
        cpc,
        cpm,
        cpa,
        diagnosis: '정상',
        isAlert: false
      });
    }

    list.sort((a, b) => a.date.localeCompare(b.date));
    STATE.allData = list;

    // Compute anomaly detection & populate custom dropdowns
    computeAnomalyDiagnostics();
    populateCustomDropdowns();
    applyFiltersAndRender();
  }

  // =========================================================================
  // 3. Anomaly Detection Engine (7-Day Rolling Window)
  // =========================================================================
  function computeAnomalyDiagnostics() {
    if (STATE.allData.length === 0) return;

    const dateSet = new Set();
    STATE.allData.forEach(d => dateSet.add(d.date));
    const sortedDates = Array.from(dateSet).sort();
    const totalDays = sortedDates.length;

    const recent7 = new Set(sortedDates.slice(Math.max(0, totalDays - 7)));
    const prev7 = new Set(sortedDates.slice(Math.max(0, totalDays - 14), Math.max(0, totalDays - 7)));

    const campaignAgg = {};
    const countryAgg = {};

    STATE.allData.forEach(row => {
      if (!campaignAgg[row.campaign]) {
        campaignAgg[row.campaign] = {
          name: row.campaign,
          country: row.country,
          product: row.product,
          keywordType: row.keywordType,
          total: { cost: 0, impr: 0, clicks: 0, conversions: 0 },
          recent: { cost: 0, impr: 0, clicks: 0, conversions: 0, days: 0 },
          prev: { cost: 0, impr: 0, clicks: 0, conversions: 0, days: 0 }
        };
      }
      if (!countryAgg[row.country]) {
        countryAgg[row.country] = {
          name: row.country,
          total: { cost: 0, impr: 0, clicks: 0, conversions: 0 },
          recent: { cost: 0, impr: 0, clicks: 0, conversions: 0, days: 0 },
          prev: { cost: 0, impr: 0, clicks: 0, conversions: 0, days: 0 }
        };
      }

      const cItem = campaignAgg[row.campaign];
      cItem.total.cost += row.cost;
      cItem.total.impr += row.impr;
      cItem.total.clicks += row.clicks;
      cItem.total.conversions += row.conversions;

      const coItem = countryAgg[row.country];
      coItem.total.cost += row.cost;
      coItem.total.impr += row.impr;
      coItem.total.clicks += row.clicks;
      coItem.total.conversions += row.conversions;

      if (recent7.has(row.date)) {
        cItem.recent.cost += row.cost;
        cItem.recent.impr += row.impr;
        cItem.recent.clicks += row.clicks;
        cItem.recent.conversions += row.conversions;
        cItem.recent.days++;

        coItem.recent.cost += row.cost;
        coItem.recent.impr += row.impr;
        coItem.recent.clicks += row.clicks;
        coItem.recent.conversions += row.conversions;
        coItem.recent.days++;
      } else if (prev7.has(row.date)) {
        cItem.prev.cost += row.cost;
        cItem.prev.impr += row.impr;
        cItem.prev.clicks += row.clicks;
        cItem.prev.conversions += row.conversions;
        cItem.prev.days++;

        coItem.prev.cost += row.cost;
        coItem.prev.impr += row.impr;
        coItem.prev.clicks += row.clicks;
        coItem.prev.conversions += row.conversions;
        coItem.prev.days++;
      }
    });

    function evaluateEntity(entity) {
      const calcShifts = (metricKey) => {
        const rVal = entity.recent[metricKey] || 0;
        const pVal = entity.prev[metricKey] || 0;
        if (pVal === 0) return rVal > 0 ? 100 : 0;
        return ((rVal - pVal) / pVal) * 100;
      };

      const costShift = calcShifts('cost');
      const imprShift = calcShifts('impr');
      const clicksShift = calcShifts('clicks');
      const convShift = calcShifts('conversions');

      const rCtr = entity.recent.impr > 0 ? (entity.recent.clicks / entity.recent.impr) * 100 : 0;
      const pCtr = entity.prev.impr > 0 ? (entity.prev.clicks / entity.prev.impr) * 100 : 0;
      const ctrShift = pCtr > 0 ? ((rCtr - pCtr) / pCtr) * 100 : 0;

      const rCpc = entity.recent.clicks > 0 ? entity.recent.cost / entity.recent.clicks : 0;
      const pCpc = entity.prev.clicks > 0 ? entity.prev.cost / entity.prev.clicks : 0;
      const cpcShift = pCpc > 0 ? ((rCpc - pCpc) / pCpc) * 100 : 0;

      const rCpm = entity.recent.impr > 0 ? (entity.recent.cost / entity.recent.impr) * 1000 : 0;
      const pCpm = entity.prev.impr > 0 ? (entity.prev.cost / entity.prev.impr) * 1000 : 0;
      const cpmShift = pCpm > 0 ? ((rCpm - pCpm) / pCpm) * 100 : 0;

      const rCpa = entity.recent.conversions > 0 ? entity.recent.cost / entity.recent.conversions : 0;
      const pCpa = entity.prev.conversions > 0 ? entity.prev.cost / entity.prev.conversions : 0;
      const cpaShift = pCpa > 0 ? ((rCpa - pCpa) / pCpa) * 100 : 0;

      const shifts = {
        cost: costShift,
        impr: imprShift,
        clicks: clicksShift,
        conversions: convShift,
        ctr: ctrShift,
        cpc: cpcShift,
        cpm: cpmShift,
        cpa: cpaShift
      };

      const th = STATE.threshold;
      let diagnosis = '정상';
      let statusKey = 'normal';
      let isAlert = false;

      if (costShift > th) {
        diagnosis = '비용 급증';
        statusKey = 'cost_spike';
        isAlert = true;
      } else if (costShift < -th) {
        diagnosis = '비용 급감';
        statusKey = 'cost_drop';
        isAlert = true;
      } else if (imprShift < -th) {
        diagnosis = '노출 급감';
        statusKey = 'impr_drop';
        isAlert = true;
      } else if (clicksShift < -th) {
        diagnosis = '클릭 급감';
        statusKey = 'clicks_drop';
        isAlert = true;
      } else if (ctrShift < -th) {
        diagnosis = 'CTR 급감';
        statusKey = 'ctr_drop';
        isAlert = true;
      } else if (cpcShift > th) {
        diagnosis = 'CPC 급등';
        statusKey = 'cpc_spike';
        isAlert = true;
      } else if (cpmShift > th) {
        diagnosis = 'CPM 급등';
        statusKey = 'cpm_spike';
        isAlert = true;
      } else if (cpaShift > th) {
        diagnosis = 'CPA 급등';
        statusKey = 'cpa_spike';
        isAlert = true;
      } else if (convShift > th && costShift < th) {
        diagnosis = '반등/회복';
        statusKey = 'rebound';
        isAlert = false;
      }

      return {
        ...entity,
        shifts,
        diagnosis,
        statusKey,
        isAlert
      };
    }

    STATE.campaignMap = new Map();
    Object.keys(campaignAgg).forEach(k => {
      STATE.campaignMap.set(k, evaluateEntity(campaignAgg[k]));
    });

    STATE.countryMap = new Map();
    Object.keys(countryAgg).forEach(k => {
      STATE.countryMap.set(k, evaluateEntity(countryAgg[k]));
    });

    STATE.allData.forEach(row => {
      const campDiag = STATE.campaignMap.get(row.campaign);
      if (campDiag) {
        row.diagnosis = campDiag.diagnosis;
        row.statusKey = campDiag.statusKey;
        row.isAlert = campDiag.isAlert;
      }
    });

    updateAnomalyRibbonCounts();
  }

  function updateAnomalyRibbonCounts() {
    let costSpike = 0, costDrop = 0, imprDrop = 0, clicksDrop = 0;
    let ctrDrop = 0, cpcSpike = 0, cpmSpike = 0, cpaSpike = 0;
    let rebound = 0, normal = 0;

    // Count within current filtered scope
    const activeCampaigns = new Set(STATE.filteredData.map(d => d.campaign));

    STATE.campaignMap.forEach((item, camp) => {
      if (activeCampaigns.size > 0 && !activeCampaigns.has(camp)) return;

      switch (item.statusKey) {
        case 'cost_spike': costSpike++; break;
        case 'cost_drop': costDrop++; break;
        case 'impr_drop': imprDrop++; break;
        case 'clicks_drop': clicksDrop++; break;
        case 'ctr_drop': ctrDrop++; break;
        case 'cpc_spike': cpcSpike++; break;
        case 'cpm_spike': cpmSpike++; break;
        case 'cpa_spike': cpaSpike++; break;
        case 'rebound': rebound++; break;
        default: normal++; break;
      }
    });

    document.getElementById('cntCostSpike').textContent = `${costSpike}건`;
    document.getElementById('cntCostDrop').textContent = `${costDrop}건`;
    document.getElementById('cntImprDrop').textContent = `${imprDrop}건`;
    document.getElementById('cntClicksDrop').textContent = `${clicksDrop}건`;
    document.getElementById('cntCtrDrop').textContent = `${ctrDrop}건`;
    document.getElementById('cntCpcSpike').textContent = `${cpcSpike}건`;
    document.getElementById('cntCpmSpike').textContent = `${cpmSpike}건`;
    document.getElementById('cntCpaSpike').textContent = `${cpaSpike}건`;
    document.getElementById('cntRebound').textContent = `${rebound}건`;
    document.getElementById('cntNormal').textContent = `${normal}건`;
  }

  // =========================================================================
  // 4. Mastercard Custom Dropdown Architecture
  // =========================================================================
  function initCustomDropdowns() {
    const dropdownIds = ['dropdownCountry', 'dropdownProduct', 'dropdownKwType', 'dropdownCampaign'];

    dropdownIds.forEach(id => {
      const dd = document.getElementById(id);
      if (!dd) return;
      const trigger = dd.querySelector('.mc-dropdown-trigger');
      if (!trigger) return;

      // Prevent container click from bubbling to document
      dd.addEventListener('click', (e) => {
        e.stopPropagation();
      });

      // Toggle dropdown open/close on trigger click
      trigger.addEventListener('click', (e) => {
        e.preventDefault();
        e.stopPropagation();
        const wasOpen = dd.classList.contains('open');
        closeAllCustomDropdowns();
        if (!wasOpen) {
          dd.classList.add('open');
          trigger.setAttribute('aria-expanded', 'true');
          const searchInput = dd.querySelector('.mc-dropdown-search');
          if (searchInput) {
            setTimeout(() => searchInput.focus(), 60);
          }
        }
      });
    });

    // Close on outside click
    document.addEventListener('click', () => {
      closeAllCustomDropdowns();
    });

    // Close on ESC
    document.addEventListener('keydown', (e) => {
      if (e.key === 'Escape') {
        closeAllCustomDropdowns();
      }
    });

    // Keyword Type click handler
    setupKwTypeDropdown();

    // Campaign Search Input Filter
    const campSearch = document.getElementById('campaignSearchInput');
    if (campSearch) {
      campSearch.addEventListener('input', (e) => {
        const q = e.target.value.toLowerCase().trim();
        const items = document.querySelectorAll('#optionsCampaign .mc-dropdown-item');
        items.forEach(item => {
          const txt = item.getAttribute('data-val').toLowerCase();
          if (txt === 'all' || txt.includes(q)) {
            item.style.display = 'flex';
          } else {
            item.style.display = 'none';
          }
        });
      });
    }
  }

  function closeAllCustomDropdowns() {
    document.querySelectorAll('.mc-dropdown').forEach(dd => {
      dd.classList.remove('open');
      const trigger = dd.querySelector('.mc-dropdown-trigger');
      if (trigger) trigger.setAttribute('aria-expanded', 'false');
    });
  }

  function setupKwTypeDropdown() {
    const optionsKwType = document.getElementById('optionsKwType');
    if (!optionsKwType) return;

    optionsKwType.querySelectorAll('.mc-dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        const val = item.getAttribute('data-val');
        selectKwTypeFilter(val);
      });
    });

    const kwSelect = document.getElementById('kwTypeFilter');
    if (kwSelect) {
      kwSelect.addEventListener('change', (e) => {
        selectKwTypeFilter(e.target.value);
      });
    }
  }

  function selectKwTypeFilter(val) {
    STATE.filters.keywordType = val;

    const optionsKwType = document.getElementById('optionsKwType');
    if (optionsKwType) {
      optionsKwType.querySelectorAll('.mc-dropdown-item').forEach(i => {
        const match = i.getAttribute('data-val').toLowerCase() === val.toLowerCase();
        i.classList.toggle('selected', match);
        const check = i.querySelector('.item-check');
        if (check) check.textContent = match ? '✓' : '';
      });
    }

    const labelMap = {
      'ALL': '모든 키워드타입 (3)',
      'brand': 'BRAND',
      'generic': 'GENERIC',
      'competitor': 'COMPETITOR'
    };
    const display = labelMap[val] || (val === 'ALL' ? '모든 키워드타입 (3)' : val.toUpperCase());
    document.getElementById('selectedKwTypeText').textContent = display;
    document.getElementById('kwTypeFilter').value = val;

    closeAllCustomDropdowns();
    syncCascadingCampaigns();
    applyFiltersAndRender();
  }

  function populateCustomDropdowns() {
    const countries = [...new Set(STATE.allData.map(d => d.country))].sort();
    const products = [...new Set(STATE.allData.map(d => d.product))].sort();

    // 1. Country Dropdown
    const optCountry = document.getElementById('optionsCountry');
    let cHtml = `
      <div class="mc-dropdown-item ${STATE.filters.country === 'ALL' ? 'selected' : ''}" data-val="ALL">
        <span class="item-text">모든 국가 (${countries.length})</span>
        <span class="item-check">${STATE.filters.country === 'ALL' ? '✓' : ''}</span>
      </div>
    `;
    countries.forEach(c => {
      const flag = COUNTRY_FLAGS[c] || '🏳️';
      const isSel = STATE.filters.country === c;
      cHtml += `
        <div class="mc-dropdown-item ${isSel ? 'selected' : ''}" data-val="${c}">
          <span class="item-text">${flag} ${c}</span>
          <span class="item-check">${isSel ? '✓' : ''}</span>
        </div>
      `;
    });
    optCountry.innerHTML = cHtml;

    optCountry.querySelectorAll('.mc-dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        const val = item.getAttribute('data-val');
        selectCountryFilter(val);
      });
    });

    // 2. Product Dropdown
    const optProduct = document.getElementById('optionsProduct');
    let pHtml = `
      <div class="mc-dropdown-item ${STATE.filters.product === 'ALL' ? 'selected' : ''}" data-val="ALL">
        <span class="item-text">모든 제품 (${products.length})</span>
        <span class="item-check">${STATE.filters.product === 'ALL' ? '✓' : ''}</span>
      </div>
    `;
    products.forEach(p => {
      const isSel = STATE.filters.product === p;
      pHtml += `
        <div class="mc-dropdown-item ${isSel ? 'selected' : ''}" data-val="${p}">
          <span class="item-text">${p} (${PRODUCT_CODES[p] || p})</span>
          <span class="item-check">${isSel ? '✓' : ''}</span>
        </div>
      `;
    });
    optProduct.innerHTML = pHtml;

    optProduct.querySelectorAll('.mc-dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        const val = item.getAttribute('data-val');
        selectProductFilter(val);
      });
    });

    // 3. Campaign Dropdown (Cascading list)
    syncCascadingCampaigns();
  }

  function selectCountryFilter(val) {
    STATE.filters.country = val;

    const optCountry = document.getElementById('optionsCountry');
    optCountry.querySelectorAll('.mc-dropdown-item').forEach(i => {
      const match = i.getAttribute('data-val') === val;
      i.classList.toggle('selected', match);
      i.querySelector('.item-check').textContent = match ? '✓' : '';
    });

    const display = val === 'ALL' ? '모든 국가 (10)' : `${COUNTRY_FLAGS[val] || ''} ${val}`;
    document.getElementById('selectedCountryText').textContent = display;
    document.getElementById('countryFilter').value = val;

    closeAllCustomDropdowns();
    syncCascadingCampaigns();
    applyFiltersAndRender();
  }

  function selectProductFilter(val) {
    STATE.filters.product = val;

    const optProduct = document.getElementById('optionsProduct');
    optProduct.querySelectorAll('.mc-dropdown-item').forEach(i => {
      const match = i.getAttribute('data-val') === val;
      i.classList.toggle('selected', match);
      i.querySelector('.item-check').textContent = match ? '✓' : '';
    });

    const display = val === 'ALL' ? '모든 제품 (4)' : `${val} (${PRODUCT_CODES[val] || val})`;
    document.getElementById('selectedProductText').textContent = display;
    document.getElementById('productFilter').value = val;

    syncProductChips(val);
    closeAllCustomDropdowns();
    syncCascadingCampaigns();
    applyFiltersAndRender();
  }

  // Cascading Campaigns based on selected Country, Product, and KeywordType
  function syncCascadingCampaigns() {
    const { country, product, keywordType } = STATE.filters;

    const matchedCampaigns = [...new Set(
      STATE.allData
        .filter(d => {
          if (country !== 'ALL' && d.country !== country) return false;
          if (product !== 'ALL' && d.product !== product) return false;
          if (keywordType !== 'ALL' && d.keywordType.toLowerCase().trim() !== keywordType.toLowerCase().trim()) return false;
          return true;
        })
        .map(d => d.campaign)
    )].sort();

    // If active campaign is not in matched campaigns, reset campaign to ALL
    if (STATE.filters.campaign !== 'ALL' && !matchedCampaigns.includes(STATE.filters.campaign)) {
      STATE.filters.campaign = 'ALL';
    }

    const optCamp = document.getElementById('optionsCampaign');
    const isAll = STATE.filters.campaign === 'ALL';
    let campHtml = `
      <div class="mc-dropdown-item ${isAll ? 'selected' : ''}" data-val="ALL">
        <span class="item-text">모든 캠페인 (${matchedCampaigns.length})</span>
        <span class="item-check">${isAll ? '✓' : ''}</span>
      </div>
    `;

    matchedCampaigns.forEach(cmp => {
      const isSel = STATE.filters.campaign === cmp;
      campHtml += `
        <div class="mc-dropdown-item ${isSel ? 'selected' : ''}" data-val="${cmp}">
          <span class="item-text"><code>${cmp}</code></span>
          <span class="item-check">${isSel ? '✓' : ''}</span>
        </div>
      `;
    });
    optCamp.innerHTML = campHtml;

    // Update trigger text
    const curCamp = STATE.filters.campaign;
    document.getElementById('selectedCampaignText').textContent = curCamp === 'ALL'
      ? `모든 캠페인 (${matchedCampaigns.length})`
      : curCamp;
    document.getElementById('campaignFilter').value = curCamp;

    // Attach click events
    optCamp.querySelectorAll('.mc-dropdown-item').forEach(item => {
      item.addEventListener('click', () => {
        const val = item.getAttribute('data-val');
        STATE.filters.campaign = val;

        optCamp.querySelectorAll('.mc-dropdown-item').forEach(i => {
          const match = i.getAttribute('data-val') === val;
          i.classList.toggle('selected', match);
          i.querySelector('.item-check').textContent = match ? '✓' : '';
        });

        document.getElementById('selectedCampaignText').textContent = val === 'ALL'
          ? `모든 캠페인 (${matchedCampaigns.length})`
          : val;
        document.getElementById('campaignFilter').value = val;

        closeAllCustomDropdowns();
        applyFiltersAndRender();
      });
    });
  }

  // =========================================================================
  // 5. Filtering & Comprehensive Synchronized Rendering
  // =========================================================================
  function applyFiltersAndRender() {
    const { country, product, keywordType, campaign, anomalyStatus, search } = STATE.filters;

    // 1. Filter raw data
    STATE.filteredData = STATE.allData.filter(d => {
      if (country !== 'ALL' && d.country !== country) return false;
      if (product !== 'ALL' && d.product !== product) return false;
      if (keywordType !== 'ALL' && d.keywordType.toLowerCase().trim() !== keywordType.toLowerCase().trim()) return false;
      if (campaign !== 'ALL' && d.campaign !== campaign) return false;
      if (anomalyStatus !== 'ALL' && d.statusKey !== anomalyStatus) return false;

      if (search) {
        const query = search.toLowerCase();
        const match = d.country.toLowerCase().includes(query) ||
                      d.product.toLowerCase().includes(query) ||
                      d.campaign.toLowerCase().includes(query) ||
                      d.keywordType.toLowerCase().includes(query) ||
                      d.diagnosis.toLowerCase().includes(query) ||
                      d.date.includes(query);
        if (!match) return false;
      }
      return true;
    });

    // 2. Update Header KPIs & Active Filter Badges
    renderSummaryKpi();
    updateActiveFilterTags();

    // 3. Render Trend Chart with synchronized caption and filter tags
    renderChart();

    // 4. Render Country & Campaign Rankings
    renderRankingList();

    // 5. Update Ribbon Counts
    updateAnomalyRibbonCounts();

    // 6. Render Detailed Data Table Grid
    STATE.tablePage = 1;
    renderDataTable();
  }

  function updateActiveFilterTags() {
    const { country, product, keywordType, campaign } = STATE.filters;

    const tagCountry = document.getElementById('tagCountry');
    const tagProduct = document.getElementById('tagProduct');
    const tagKw = document.getElementById('tagKwType');
    const tagCamp = document.getElementById('tagCampaign');

    tagCountry.textContent = country === 'ALL' ? '모든 국가' : `${COUNTRY_FLAGS[country] || ''} ${country}`;
    tagCountry.style.color = country === 'ALL' ? 'inherit' : 'var(--mc-signal-orange)';

    tagProduct.textContent = product === 'ALL' ? '모든 제품' : `${product} (${PRODUCT_CODES[product] || product})`;
    tagProduct.style.color = product === 'ALL' ? 'inherit' : 'var(--mc-signal-orange)';

    tagKw.textContent = keywordType === 'ALL' ? '모든 키워드타입' : keywordType.toUpperCase();
    tagKw.style.color = keywordType === 'ALL' ? 'inherit' : 'var(--mc-signal-orange)';

    tagCamp.textContent = campaign === 'ALL' ? '모든 캠페인' : campaign;
    tagCamp.style.color = campaign === 'ALL' ? 'inherit' : 'var(--mc-signal-orange)';

    // Update Chart Toolbar Filter Badge
    const filterParts = [];
    if (country !== 'ALL') filterParts.push(country);
    if (product !== 'ALL') filterParts.push(product);
    if (keywordType !== 'ALL') filterParts.push(keywordType);
    if (campaign !== 'ALL') filterParts.push(campaign);

    const chartBadgeText = filterParts.length > 0 ? filterParts.join(' · ') : '전체 데이터';
    document.getElementById('chartActiveFilterBadge').textContent = chartBadgeText;

    // Update Table Filter Status Badge
    const count = STATE.filteredData.length;
    const tableBadgeText = filterParts.length > 0
      ? `${filterParts.join(' · ')} (${count.toLocaleString()}건)`
      : `전체 ${count.toLocaleString()}건`;
    document.getElementById('tableFilterStatusBadge').textContent = tableBadgeText;
  }

  function renderSummaryKpi() {
    const data = STATE.filteredData;
    const totalCount = STATE.allData.length;
    const filteredCount = data.length;

    document.getElementById('totalRowsCount').textContent = totalCount.toLocaleString();
    document.getElementById('filteredCount').textContent = filteredCount.toLocaleString();

    let costSum = 0, imprSum = 0, clicksSum = 0, convSum = 0;
    data.forEach(d => {
      costSum += d.cost;
      imprSum += d.impr;
      clicksSum += d.clicks;
      convSum += d.conversions;
    });

    const avgCtr = imprSum > 0 ? (clicksSum / imprSum) * 100 : 0;
    const avgCpc = clicksSum > 0 ? (costSum / clicksSum) : 0;

    document.getElementById('kpiTotalCost').textContent = '$' + costSum.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    document.getElementById('kpiTotalImpr').textContent = imprSum.toLocaleString();
    document.getElementById('kpiTotalClicks').textContent = clicksSum.toLocaleString();
    document.getElementById('kpiAvgCtr').textContent = avgCtr.toFixed(2) + '%';
    document.getElementById('kpiAvgCpc').textContent = '$' + avgCpc.toFixed(2);
    document.getElementById('kpiTotalConv').textContent = convSum.toLocaleString();

    const metricConf = METRIC_CONFIG[STATE.activeMetric];
    document.getElementById('arenaSubTag').textContent = `${data.length.toLocaleString()}건 분석 (${metricConf.label})`;
    document.getElementById('chartCaptionText').textContent = `일자별 ${metricConf.label} 트렌드 및 이상 징후 감시`;
    document.getElementById('currentLegendText').textContent = `${metricConf.label} (${metricConf.unit})`;
  }

  // =========================================================================
  // 6. Interactive Trend Chart (Chart.js)
  // =========================================================================
  function renderChart() {
    const canvas = document.getElementById('trendChart');
    if (!canvas) return;
    const ctx = canvas.getContext('2d');
    const metricKey = STATE.activeMetric;
    const metricConf = METRIC_CONFIG[metricKey];

    const allDates = [...new Set(STATE.allData.map(d => d.date))].sort();

    const dailyMap = {};
    allDates.forEach(date => {
      dailyMap[date] = { cost: 0, impr: 0, clicks: 0, conversions: 0, count: 0 };
    });

    const products = ['냉장고', '세탁기', '전자레인지', 'TV'];
    const productDailyMap = {};
    products.forEach(p => {
      productDailyMap[p] = {};
      allDates.forEach(date => {
        productDailyMap[p][date] = { cost: 0, impr: 0, clicks: 0, conversions: 0 };
      });
    });

    const countries = [...new Set(STATE.allData.map(d => d.country))].sort();
    const countryDailyMap = {};
    countries.forEach(c => {
      countryDailyMap[c] = {};
      allDates.forEach(date => {
        countryDailyMap[c][date] = { cost: 0, impr: 0, clicks: 0, conversions: 0 };
      });
    });

    STATE.filteredData.forEach(d => {
      if (dailyMap[d.date]) {
        dailyMap[d.date].cost += d.cost;
        dailyMap[d.date].impr += d.impr;
        dailyMap[d.date].clicks += d.clicks;
        dailyMap[d.date].conversions += d.conversions;
        dailyMap[d.date].count++;
      }
      if (productDailyMap[d.product] && productDailyMap[d.product][d.date]) {
        productDailyMap[d.product][d.date].cost += d.cost;
        productDailyMap[d.product][d.date].impr += d.impr;
        productDailyMap[d.product][d.date].clicks += d.clicks;
        productDailyMap[d.product][d.date].conversions += d.conversions;
      }
      if (countryDailyMap[d.country] && countryDailyMap[d.country][d.date]) {
        countryDailyMap[d.country][d.date].cost += d.cost;
        countryDailyMap[d.country][d.date].impr += d.impr;
        countryDailyMap[d.country][d.date].clicks += d.clicks;
        countryDailyMap[d.country][d.date].conversions += d.conversions;
      }
    });

    function getMetricVal(agg) {
      if (!agg) return 0;
      switch (metricKey) {
        case 'cost': return agg.cost;
        case 'impr': return agg.impr;
        case 'clicks': return agg.clicks;
        case 'conversions': return agg.conversions;
        case 'ctr': return agg.impr > 0 ? (agg.clicks / agg.impr) * 100 : 0;
        case 'cpc': return agg.clicks > 0 ? (agg.cost / agg.clicks) : 0;
        case 'cpm': return agg.impr > 0 ? (agg.cost / agg.impr) * 1000 : 0;
        case 'cpa': return agg.conversions > 0 ? (agg.cost / agg.conversions) : 0;
        default: return 0;
      }
    }

    const labels = allDates;
    const isDark = STATE.theme === 'dark';
    const gridColor = isDark ? 'rgba(255, 255, 255, 0.06)' : 'rgba(20, 20, 19, 0.05)';
    const textColor = isDark ? '#C7C3BD' : '#696969';

    let datasets = [];

    const legendStatus = document.querySelector('.chart-legend-status');
    if (legendStatus) {
      legendStatus.style.display = STATE.viewMode === 'single' ? 'flex' : 'none';
    }

    if (STATE.viewMode === 'single') {
      const values = labels.map(d => getMetricVal(dailyMap[d]));

      const pointBgColors = [];
      const pointBorderColors = [];
      const pointRadii = [];

      for (let i = 0; i < values.length; i++) {
        const val = values[i];
        let sum = 0, cnt = 0;
        for (let j = Math.max(0, i - 7); j < i; j++) {
          sum += values[j];
          cnt++;
        }
        const rollingAvg = cnt > 0 ? sum / cnt : val;
        const diffPercent = rollingAvg > 0 ? Math.abs((val - rollingAvg) / rollingAvg) * 100 : 0;

        if (diffPercent > STATE.threshold && val > 0 && i >= 7) {
          pointBgColors.push('#CF4500');
          pointBorderColors.push('#FFFFFF');
          pointRadii.push(5);
        } else {
          pointBgColors.push('#F37338');
          pointBorderColors.push('#F37338');
          pointRadii.push(0);
        }
      }

      const gradient = ctx.createLinearGradient(0, 0, 0, 350);
      gradient.addColorStop(0, 'rgba(243, 115, 56, 0.28)');
      gradient.addColorStop(1, 'rgba(243, 115, 56, 0.00)');

      datasets.push({
        label: metricConf.label,
        data: values,
        borderColor: '#F37338',
        borderWidth: 2.2,
        backgroundColor: gradient,
        fill: true,
        tension: 0.32,
        pointBackgroundColor: pointBgColors,
        pointBorderColor: pointBorderColors,
        pointBorderWidth: 1.5,
        pointRadius: pointRadii,
        pointHoverRadius: 6
      });

      const nonZeroVals = values.filter(v => v > 0);
      const avg = nonZeroVals.length > 0 ? nonZeroVals.reduce((a, b) => a + b, 0) / nonZeroVals.length : 0;
      const peak = values.length > 0 ? Math.max(...values) : 0;
      const trough = nonZeroVals.length > 0 ? Math.min(...nonZeroVals) : 0;

      const r7 = values.slice(Math.max(0, values.length - 7));
      const p7 = values.slice(Math.max(0, values.length - 14), Math.max(0, values.length - 7));
      const r7Avg = r7.length > 0 ? r7.reduce((a, b) => a + b, 0) / r7.length : 0;
      const p7Avg = p7.length > 0 ? p7.reduce((a, b) => a + b, 0) / p7.length : 0;
      const shiftPercent = p7Avg > 0 ? ((r7Avg - p7Avg) / p7Avg) * 100 : 0;

      document.getElementById('stripDailyAvg').textContent = metricConf.format(avg);
      document.getElementById('stripPeakVal').textContent = metricConf.format(peak);
      document.getElementById('stripTroughVal').textContent = metricConf.format(trough);
      
      const shiftElem = document.getElementById('stripRecentShift');
      const shiftSign = shiftPercent > 0 ? '+' : '';
      shiftElem.textContent = `${shiftSign}${shiftPercent.toFixed(1)}%`;
      shiftElem.style.color = shiftPercent >= 0 ? 'var(--mc-signal-orange)' : 'var(--mc-success-green)';

    } else if (STATE.viewMode === 'country') {
      // Country Top 5 Multi-Line View
      const countryTotals = countries.map(c => {
        let totCost = 0, totImpr = 0, totClicks = 0, totConv = 0;
        allDates.forEach(date => {
          const item = countryDailyMap[c][date];
          totCost += item.cost;
          totImpr += item.impr;
          totClicks += item.clicks;
          totConv += item.conversions;
        });
        const vol = getMetricFromTotals(metricKey, totCost, totImpr, totClicks, totConv);
        return { country: c, volume: vol };
      });

      // Sort countries by volume descending
      countryTotals.sort((a, b) => b.volume - a.volume);

      const top5List = countryTotals.filter(item => item.volume > 0).slice(0, 5);
      const targetCountries = STATE.filters.country !== 'ALL'
        ? countryTotals.filter(item => item.country === STATE.filters.country)
        : (top5List.length > 0 ? top5List : countryTotals.slice(0, 5));

      const countryColors = [
        '#CF4500', // 1위 (Mastercard Signal Orange)
        '#3860BE', // 2위 (Mastercard Link Blue)
        '#F79E1B', // 3위 (Mastercard Sun Yellow)
        '#1E8E3E', // 4위 (Emerald Green)
        '#9333EA'  // 5위 (Royal Purple)
      ];

      targetCountries.forEach((item, idx) => {
        const c = item.country;
        const cColor = countryColors[idx % countryColors.length];
        const values = labels.map(d => getMetricVal(countryDailyMap[c][d]));
        const flag = COUNTRY_FLAGS[c] || '🌐';

        datasets.push({
          label: `${flag} ${c} (TOP ${idx + 1} · ${metricConf.format(item.volume)})`,
          data: values,
          borderColor: cColor,
          backgroundColor: 'transparent',
          borderWidth: 2.2,
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5
        });
      });

      const top1 = targetCountries[0];
      const sumTop5 = targetCountries.reduce((acc, curr) => acc + curr.volume, 0);
      document.getElementById('stripDailyAvg').textContent = `국가별 TOP ${targetCountries.length} 비교 분석 중`;
      document.getElementById('stripPeakVal').textContent = top1 ? `1위: ${top1.country} (${metricConf.format(top1.volume)})` : '-';
      document.getElementById('stripTroughVal').textContent = `TOP ${targetCountries.length} 합계: ${metricConf.format(sumTop5)}`;
      document.getElementById('stripRecentShift').textContent = '국가별 비교 모드';
      document.getElementById('stripRecentShift').style.color = 'var(--mc-signal-orange)';

    } else {
      // Multi-Line View (4 Products)
      const colorPalette = {
        '냉장고': '#F37338',
        '세탁기': '#3860BE',
        '전자레인지': '#F79E1B',
        'TV': isDark ? '#E5E5E5' : '#141413'
      };

      // If user specifically filtered one product, emphasize that product
      const targetProducts = STATE.filters.product === 'ALL' ? products : [STATE.filters.product];

      targetProducts.forEach(p => {
        const values = labels.map(d => getMetricVal(productDailyMap[p][d]));
        datasets.push({
          label: `${p} (${PRODUCT_CODES[p] || p})`,
          data: values,
          borderColor: colorPalette[p] || '#F37338',
          borderWidth: 2,
          backgroundColor: 'transparent',
          fill: false,
          tension: 0.3,
          pointRadius: 0,
          pointHoverRadius: 5
        });
      });

      document.getElementById('stripDailyAvg').textContent = '제품별 비교 분석 중';
      document.getElementById('stripPeakVal').textContent = `${targetProducts.length}개 제품 활성화`;
      document.getElementById('stripTroughVal').textContent = '선택 지표: ' + metricConf.label;
      document.getElementById('stripRecentShift').textContent = '비교 모드';
      document.getElementById('stripRecentShift').style.color = 'inherit';
    }

    if (chartInstance) {
      chartInstance.destroy();
    }

    chartInstance = new Chart(ctx, {
      type: 'line',
      data: {
        labels: labels.map(d => d.slice(5)),
        datasets: datasets
      },
      options: {
        responsive: true,
        maintainAspectRatio: false,
        interaction: {
          mode: 'index',
          intersect: false
        },
        plugins: {
          legend: {
            display: STATE.viewMode === 'multi' || STATE.viewMode === 'country',
            position: 'top',
            labels: {
              boxWidth: 12,
              color: textColor,
              font: { family: 'Sofia Sans, Inter', size: 12, weight: '500' }
            }
          },
          tooltip: {
            backgroundColor: isDark ? '#232322' : '#FFFFFF',
            titleColor: isDark ? '#F3F0EE' : '#141413',
            bodyColor: isDark ? '#C7C3BD' : '#555555',
            borderColor: isDark ? 'rgba(255, 255, 255, 0.15)' : 'rgba(20, 20, 19, 0.1)',
            borderWidth: 1,
            padding: 12,
            boxPadding: 6,
            usePointStyle: true,
            titleFont: { family: 'Sofia Sans, Inter', weight: '700', size: 13 },
            bodyFont: { family: 'Sofia Sans, Inter', weight: '450', size: 12 },
            callbacks: {
              label: function (context) {
                const label = context.dataset.label || '';
                const val = context.parsed.y;
                return `${label}: ${metricConf.format(val)}`;
              }
            }
          }
        },
        scales: {
          x: {
            grid: { color: gridColor, drawBorder: false },
            ticks: {
              color: textColor,
              font: { family: 'Sofia Sans, Inter', size: 11 },
              maxTicksLimit: 14
            }
          },
          y: {
            grid: { color: gridColor, drawBorder: false },
            ticks: {
              color: textColor,
              font: { family: 'Sofia Sans, Inter', size: 11 },
              callback: function (value) {
                if (metricKey === 'cost' || metricKey === 'cpc' || metricKey === 'cpm' || metricKey === 'cpa') {
                  return '$' + value.toLocaleString();
                } else if (metricKey === 'ctr') {
                  return value.toFixed(1) + '%';
                }
                return value >= 1000 ? (value / 1000).toFixed(0) + 'k' : value;
              }
            }
          }
        }
      }
    });
  }

  // =========================================================================
  // 7. Right Panel: Country & Campaign Performance Ranking
  // =========================================================================
  function renderRankingList() {
    const container = document.getElementById('rankingListContainer');
    const isCountry = STATE.rankingTab === 'country';
    const metricKey = STATE.activeMetric;
    const metricConf = METRIC_CONFIG[metricKey];

    const dateSet = new Set();
    STATE.allData.forEach(d => dateSet.add(d.date));
    const sortedDates = Array.from(dateSet).sort();
    const totalDays = sortedDates.length;
    const recent7 = new Set(sortedDates.slice(Math.max(0, totalDays - 7)));
    const prev7 = new Set(sortedDates.slice(Math.max(0, totalDays - 14), Math.max(0, totalDays - 7)));

    let list = [];

    if (isCountry) {
      STATE.countryMap.forEach((item, country) => {
        const relevantRows = STATE.filteredData.filter(d => d.country === country);
        const count = relevantRows.length;
        if (count === 0) return;

        let cost = 0, impr = 0, clicks = 0, conv = 0;
        let rCost = 0, rImpr = 0, rClicks = 0, rConv = 0;
        let pCost = 0, pImpr = 0, pClicks = 0, pConv = 0;

        relevantRows.forEach(r => {
          cost += r.cost;
          impr += r.impr;
          clicks += r.clicks;
          conv += r.conversions;

          if (recent7.has(r.date)) {
            rCost += r.cost;
            rImpr += r.impr;
            rClicks += r.clicks;
            rConv += r.conversions;
          } else if (prev7.has(r.date)) {
            pCost += r.cost;
            pImpr += r.impr;
            pClicks += r.clicks;
            pConv += r.conversions;
          }
        });

        const volume = getMetricFromTotals(metricKey, cost, impr, clicks, conv);
        const rVal = getMetricFromTotals(metricKey, rCost, rImpr, rClicks, rConv);
        const pVal = getMetricFromTotals(metricKey, pCost, pImpr, pClicks, pConv);
        const shift = pVal === 0 ? (rVal > 0 ? 100 : 0) : ((rVal - pVal) / pVal) * 100;

        list.push({
          key: country,
          title: country,
          badgeLabel: `${count.toLocaleString()}개 데이터`,
          volume: volume,
          shift: shift,
          flag: COUNTRY_FLAGS[country] || '🌐',
          type: 'country'
        });
      });
    } else {
      STATE.campaignMap.forEach((item, camp) => {
        const relevantRows = STATE.filteredData.filter(d => d.campaign === camp);
        const count = relevantRows.length;
        if (count === 0) return;

        let cost = 0, impr = 0, clicks = 0, conv = 0;
        let rCost = 0, rImpr = 0, rClicks = 0, rConv = 0;
        let pCost = 0, pImpr = 0, pClicks = 0, pConv = 0;

        relevantRows.forEach(r => {
          cost += r.cost;
          impr += r.impr;
          clicks += r.clicks;
          conv += r.conversions;

          if (recent7.has(r.date)) {
            rCost += r.cost;
            rImpr += r.impr;
            rClicks += r.clicks;
            rConv += r.conversions;
          } else if (prev7.has(r.date)) {
            pCost += r.cost;
            pImpr += r.impr;
            pClicks += r.clicks;
            pConv += r.conversions;
          }
        });

        const volume = getMetricFromTotals(metricKey, cost, impr, clicks, conv);
        const rVal = getMetricFromTotals(metricKey, rCost, rImpr, rClicks, rConv);
        const pVal = getMetricFromTotals(metricKey, pCost, pImpr, pClicks, pConv);
        const shift = pVal === 0 ? (rVal > 0 ? 100 : 0) : ((rVal - pVal) / pVal) * 100;

        list.push({
          key: camp,
          title: camp,
          badgeLabel: `${item.product} · ${item.country}`,
          volume: volume,
          shift: shift,
          flag: COUNTRY_FLAGS[item.country] || '📍',
          type: 'campaign'
        });
      });
    }

    // Sorting strategy: up = highest shift first (top performers), down = lowest shift first (steepest drops), all = volume or abs(shift)
    if (STATE.rankingDirection === 'up') {
      list.sort((a, b) => b.shift - a.shift);
    } else if (STATE.rankingDirection === 'down') {
      list.sort((a, b) => a.shift - b.shift);
    } else {
      if (STATE.rankingSort === 'volume') {
        list.sort((a, b) => b.volume - a.volume);
      } else {
        list.sort((a, b) => Math.abs(b.shift) - Math.abs(a.shift));
      }
    }

    const maxVolume = list.length > 0 ? Math.max(...list.map(d => d.volume)) : 1;
    const totalVolume = list.reduce((sum, d) => sum + d.volume, 0);

    document.getElementById('rankItemCountBadge').textContent = `총 ${list.length}개 ${isCountry ? '국가' : '캠페인'}`;

    if (list.length === 0) {
      container.innerHTML = `
        <div style="text-align:center; padding: 32px 16px; color: var(--color-text-muted); font-size: 13px;">
          일치하는 항목이 없습니다.
        </div>
      `;
      return;
    }

    let html = '';
    list.forEach((item, idx) => {
      const share = totalVolume > 0 ? ((item.volume / totalVolume) * 100).toFixed(1) : '0.0';
      const pctWidth = maxVolume > 0 ? Math.min(100, Math.max(4, (item.volume / maxVolume) * 100)) : 4;
      
      const shiftSign = item.shift > 0 ? '+' : '';
      const shiftClass = item.shift > 15 ? 'badge-surge' : (item.shift < -15 ? 'badge-plunge' : 'badge-stable');

      html += `
        <div class="ranking-item-card" data-rank-type="${item.type}" data-rank-key="${item.key}" title="클릭하여 ${item.title} 필터 적용">
          <div class="rank-item-top">
            <div class="rank-item-name-group">
              <span class="rank-index-badge">${idx + 1}</span>
              <span class="rank-item-flag">${item.flag}</span>
              <span class="rank-item-title">${item.title}</span>
            </div>
            <span class="rank-item-badge ${shiftClass}">
              최신 변동 ${shiftSign}${item.shift.toFixed(1)}%
            </span>
          </div>

          <div class="rank-item-mid">
            <span class="rank-item-vol">${metricConf.format(item.volume)}</span>
            <span class="rank-item-share">비중 ${share}% (${item.badgeLabel})</span>
          </div>

          <div class="rank-progress-bar">
            <div class="rank-progress-fill" style="width: ${pctWidth}%;"></div>
          </div>
        </div>
      `;
    });

    container.innerHTML = html;

    container.querySelectorAll('.ranking-item-card').forEach(card => {
      card.addEventListener('click', () => {
        const type = card.getAttribute('data-rank-type');
        const key = card.getAttribute('data-rank-key');
        if (type === 'country') {
          selectCountryFilter(key);
        } else {
          STATE.filters.campaign = key;
          document.getElementById('selectedCampaignText').textContent = key;
          document.getElementById('campaignFilter').value = key;
          applyFiltersAndRender();
        }
        showToast(`${key} 필터가 적용되었습니다.`);
      });
    });
  }

  function getMetricFromTotals(metricKey, cost, impr, clicks, conv) {
    switch (metricKey) {
      case 'cost': return cost;
      case 'impr': return impr;
      case 'clicks': return clicks;
      case 'conversions': return conv;
      case 'ctr': return impr > 0 ? (clicks / impr) * 100 : 0;
      case 'cpc': return clicks > 0 ? (cost / clicks) : 0;
      case 'cpm': return impr > 0 ? (cost / impr) * 1000 : 0;
      case 'cpa': return conv > 0 ? (cost / conv) : 0;
      default: return 0;
    }
  }

  // =========================================================================
  // 8. Detailed Data Grid Table & Pagination
  // =========================================================================
  function renderDataTable() {
    const tbody = document.getElementById('tableBody');
    let rows = [...STATE.filteredData];

    const col = STATE.tableSortCol;
    const isAsc = STATE.tableSortAsc;

    rows.sort((a, b) => {
      let vA = a[col];
      let vB = b[col];

      if (typeof vA === 'string') {
        return isAsc ? vA.localeCompare(vB) : vB.localeCompare(vA);
      } else {
        return isAsc ? (vA - vB) : (vB - vA);
      }
    });

    const totalRows = rows.length;
    const pageSize = STATE.tablePageSize;
    const totalPages = Math.max(1, Math.ceil(totalRows / pageSize));

    if (STATE.tablePage > totalPages) STATE.tablePage = totalPages;
    const startIdx = (STATE.tablePage - 1) * pageSize;
    const endIdx = Math.min(totalRows, startIdx + pageSize);
    const pageRows = rows.slice(startIdx, endIdx);

    document.getElementById('paginationInfo').textContent = `${startIdx + 1} - ${endIdx} of ${totalRows.toLocaleString()} rows`;
    document.getElementById('currentPageDisplay').textContent = `${STATE.tablePage} / ${totalPages}`;
    document.getElementById('prevPageBtn').disabled = STATE.tablePage <= 1;
    document.getElementById('nextPageBtn').disabled = STATE.tablePage >= totalPages;

    if (pageRows.length === 0) {
      tbody.innerHTML = `
        <tr>
          <td colspan="15" style="text-align:center; padding: 40px; color: var(--color-text-muted);">
            데이터가 없습니다. 상단 필터 조건을 변경해 보세요.
          </td>
        </tr>
      `;
      return;
    }

    let html = '';
    pageRows.forEach(r => {
      const statusPill = r.isAlert
        ? `<span class="status-pill status-alert">● ALERT</span>`
        : `<span class="status-pill status-normal">● NORMAL</span>`;
      
      const flag = COUNTRY_FLAGS[r.country] || '';

      html += `
        <tr>
          <td>${statusPill}</td>
          <td>${flag} ${r.country}</td>
          <td><strong>${r.product}</strong></td>
          <td><span class="type-chip">${r.keywordType}</span></td>
          <td title="${r.campaign}"><code>${r.campaign}</code></td>
          <td>${r.date}</td>
          <td class="num-col">$${r.cost.toFixed(2)}</td>
          <td class="num-col">${r.impr.toLocaleString()}</td>
          <td class="num-col">${r.clicks.toLocaleString()}</td>
          <td class="num-col">${r.ctr.toFixed(2)}%</td>
          <td class="num-col">$${r.cpc.toFixed(2)}</td>
          <td class="num-col">$${r.cpm.toFixed(2)}</td>
          <td class="num-col">${r.conversions}</td>
          <td class="num-col">$${r.cpa.toFixed(2)}</td>
          <td><span class="status-pill ${r.isAlert ? 'status-alert' : 'status-normal'}">${r.diagnosis}</span></td>
        </tr>
      `;
    });

    tbody.innerHTML = html;
  }

  // =========================================================================
  // 9. Event Listeners & Interactive Handlers
  // =========================================================================
  function initEvents() {
    // Theme toggle (Warm Cream <-> Ink Dark)
    document.getElementById('themeToggleBtn').addEventListener('click', () => {
      const newTheme = STATE.theme === 'light' ? 'dark' : 'light';
      applyTheme(newTheme);
    });

    // Reset Filters Button
    document.getElementById('resetFiltersBtn').addEventListener('click', () => {
      resetFilters();
    });

    // Anomaly Threshold Slider
    const slider = document.getElementById('thresholdSlider');
    const thDisplay = document.getElementById('thresholdDisplay');
    slider.addEventListener('input', (e) => {
      const val = parseInt(e.target.value, 10);
      STATE.threshold = val;
      thDisplay.textContent = `±${val}%`;
      computeAnomalyDiagnostics();
      applyFiltersAndRender();
    });

    // Quick Product Chips
    const productChips = document.querySelectorAll('.product-chip-btn');
    productChips.forEach(btn => {
      btn.addEventListener('click', () => {
        const prod = btn.getAttribute('data-product');
        selectProductFilter(prod);
      });
    });

    // Metric Selector Buttons
    const metricBtns = document.querySelectorAll('.metric-pill-btn');
    metricBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        metricBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        STATE.activeMetric = btn.getAttribute('data-metric');
        renderSummaryKpi();
        renderChart();
        renderRankingList();
      });
    });

    // Chart View Mode (Single vs Multi vs Country)
    const btnSingle = document.getElementById('viewModeSingle');
    const btnMulti = document.getElementById('viewModeMulti');
    const btnCountry = document.getElementById('viewModeCountry');

    btnSingle.addEventListener('click', () => {
      btnSingle.classList.add('active');
      btnMulti.classList.remove('active');
      if (btnCountry) btnCountry.classList.remove('active');
      STATE.viewMode = 'single';
      renderChart();
    });

    btnMulti.addEventListener('click', () => {
      btnMulti.classList.add('active');
      btnSingle.classList.remove('active');
      if (btnCountry) btnCountry.classList.remove('active');
      STATE.viewMode = 'multi';
      renderChart();
    });

    if (btnCountry) {
      btnCountry.addEventListener('click', () => {
        btnCountry.classList.add('active');
        btnSingle.classList.remove('active');
        btnMulti.classList.remove('active');
        STATE.viewMode = 'country';
        renderChart();
      });
    }

    // Ranking Tabs (Country vs Campaign)
    document.getElementById('rankTabCountry').addEventListener('click', () => {
      document.getElementById('rankTabCountry').classList.add('active');
      document.getElementById('rankTabCampaign').classList.remove('active');
      STATE.rankingTab = 'country';
      renderRankingList();
    });

    document.getElementById('rankTabCampaign').addEventListener('click', () => {
      document.getElementById('rankTabCampaign').classList.add('active');
      document.getElementById('rankTabCountry').classList.remove('active');
      STATE.rankingTab = 'campaign';
      renderRankingList();
    });

    // Ranking Sort (Volume vs Shift)
    document.getElementById('sortVolumeBtn').addEventListener('click', () => {
      document.getElementById('sortVolumeBtn').classList.add('active');
      document.getElementById('sortShiftBtn').classList.remove('active');
      STATE.rankingSort = 'volume';
      STATE.rankingDirection = 'all';
      dirBtns.forEach(b => b.classList.toggle('active', b.getAttribute('data-dir') === 'all'));
      renderRankingList();
    });

    document.getElementById('sortShiftBtn').addEventListener('click', () => {
      document.getElementById('sortShiftBtn').classList.add('active');
      document.getElementById('sortVolumeBtn').classList.remove('active');
      STATE.rankingSort = 'shift';
      renderRankingList();
    });

    // Direction Filter (all, up, down)
    const dirBtns = document.querySelectorAll('.direction-btn');
    dirBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        dirBtns.forEach(b => b.classList.remove('active'));
        btn.classList.add('active');
        STATE.rankingDirection = btn.getAttribute('data-dir');
        renderRankingList();
      });
    });

    // Anomaly Ribbon Filter
    const ribbonBtns = document.querySelectorAll('.anomaly-badge-btn');
    ribbonBtns.forEach(btn => {
      btn.addEventListener('click', () => {
        ribbonBtns.forEach(b => b.classList.remove('active-status'));
        btn.classList.add('active-status');
        const st = btn.getAttribute('data-filter-status');
        STATE.filters.anomalyStatus = st;
        applyFiltersAndRender();
        showToast(st === 'ALL' ? '전체 상태가 표시됩니다.' : `'${st}' 상태 데이터가 필터링되었습니다.`);
      });
    });

    // Table Search
    document.getElementById('tableSearchInput').addEventListener('input', (e) => {
      STATE.filters.search = e.target.value.trim();
      STATE.tablePage = 1;
      applyFiltersAndRender();
    });

    // Table Header Sort
    const thList = document.querySelectorAll('.master-data-table th');
    thList.forEach(th => {
      th.addEventListener('click', () => {
        const col = th.getAttribute('data-sort-col');
        if (STATE.tableSortCol === col) {
          STATE.tableSortAsc = !STATE.tableSortAsc;
        } else {
          STATE.tableSortCol = col;
          STATE.tableSortAsc = false;
        }
        renderDataTable();
      });
    });

    // Table Pagination
    document.getElementById('pageSizeSelect').addEventListener('change', (e) => {
      STATE.tablePageSize = parseInt(e.target.value, 10);
      STATE.tablePage = 1;
      renderDataTable();
    });

    document.getElementById('prevPageBtn').addEventListener('click', () => {
      if (STATE.tablePage > 1) {
        STATE.tablePage--;
        renderDataTable();
      }
    });

    document.getElementById('nextPageBtn').addEventListener('click', () => {
      const totalPages = Math.ceil(STATE.filteredData.length / STATE.tablePageSize);
      if (STATE.tablePage < totalPages) {
        STATE.tablePage++;
        renderDataTable();
      }
    });

    // CSV Export
    document.getElementById('exportCsvBtn').addEventListener('click', exportFilteredCsv);

    // Modal Events
    setupModalEvents();
  }

  function syncProductChips(selectedProduct) {
    const chips = document.querySelectorAll('.product-chip-btn');
    chips.forEach(chip => {
      if (chip.getAttribute('data-product') === selectedProduct) {
        chip.classList.add('active');
      } else {
        chip.classList.remove('active');
      }
    });
  }

  function resetFilters() {
    STATE.filters = {
      country: 'ALL',
      product: 'ALL',
      keywordType: 'ALL',
      campaign: 'ALL',
      anomalyStatus: 'ALL',
      search: ''
    };

    document.getElementById('selectedCountryText').textContent = '모든 국가 (10)';
    document.getElementById('countryFilter').value = 'ALL';

    document.getElementById('selectedProductText').textContent = '모든 제품 (4)';
    document.getElementById('productFilter').value = 'ALL';

    document.getElementById('selectedKwTypeText').textContent = '모든 키워드타입 (3)';
    document.getElementById('kwTypeFilter').value = 'ALL';

    document.getElementById('tableSearchInput').value = '';

    // Reset dropdown items selected classes
    document.querySelectorAll('.mc-dropdown-options').forEach(optContainer => {
      optContainer.querySelectorAll('.mc-dropdown-item').forEach(i => {
        const isAll = i.getAttribute('data-val') === 'ALL';
        i.classList.toggle('selected', isAll);
        const check = i.querySelector('.item-check');
        if (check) check.textContent = isAll ? '✓' : '';
      });
    });

    syncProductChips('ALL');
    syncCascadingCampaigns();

    const ribbonBtns = document.querySelectorAll('.anomaly-badge-btn');
    ribbonBtns.forEach(b => b.classList.remove('active-status'));
    const allRibbon = document.querySelector('.anomaly-badge-btn[data-filter-status="ALL"]');
    if (allRibbon) allRibbon.classList.add('active-status');

    applyFiltersAndRender();
    showToast('모든 필터가 초기화되었습니다.');
  }

  // =========================================================================
  // 10. CSV Import & Modal Manager
  // =========================================================================
  function setupModalEvents() {
    const modal = document.getElementById('dataUpdateModal');
    const openBtn = document.getElementById('openDataModalBtn');
    const closeBtn = document.getElementById('closeDataModalBtn');
    const cancelBtn = document.getElementById('cancelModalBtn');
    const dropZone = document.getElementById('csvDropZone');
    const fileInput = document.getElementById('csvFileInput');
    const restoreBtn = document.getElementById('restoreDefaultBtn');
    const statusText = document.getElementById('uploadStatusText');

    openBtn.addEventListener('click', () => {
      modal.classList.add('active');
      statusText.textContent = '';
    });

    const closeModal = () => modal.classList.remove('active');
    closeBtn.addEventListener('click', closeModal);
    cancelBtn.addEventListener('click', closeModal);
    modal.addEventListener('click', (e) => {
      if (e.target === modal) closeModal();
    });

    dropZone.addEventListener('click', () => fileInput.click());

    dropZone.addEventListener('dragover', (e) => {
      e.preventDefault();
      dropZone.classList.add('drag-over');
    });

    dropZone.addEventListener('dragleave', () => dropZone.classList.remove('drag-over'));

    dropZone.addEventListener('drop', (e) => {
      e.preventDefault();
      dropZone.classList.remove('drag-over');
      if (e.dataTransfer.files.length > 0) {
        handleUploadedFile(e.dataTransfer.files[0]);
      }
    });

    fileInput.addEventListener('change', (e) => {
      if (e.target.files.length > 0) {
        handleUploadedFile(e.target.files[0]);
      }
    });

    restoreBtn.addEventListener('click', () => {
      if (window.RAW_DATA) {
        processRawRows(window.RAW_DATA);
        closeModal();
        showToast('기본 더미 데이터로 복원되었습니다.');
      }
    });

    function handleUploadedFile(file) {
      if (!file.name.endsWith('.csv')) {
        statusText.textContent = '❌ CSV 파일만 지원됩니다.';
        statusText.style.color = 'var(--mc-red)';
        return;
      }
      statusText.textContent = '⏳ 파일 파싱 중...';
      statusText.style.color = 'var(--mc-signal-orange)';

      const reader = new FileReader();
      reader.onload = (e) => {
        try {
          const content = e.target.result;
          parseCsvString(content);
          closeModal();
          showToast(`성공적으로 ${file.name} 데이터를 반영했습니다.`);
        } catch (err) {
          statusText.textContent = '❌ 파싱 에러: ' + err.message;
          statusText.style.color = 'var(--mc-red)';
        }
      };
      reader.readAsText(file, 'utf-8');
    }
  }

  function parseCsvString(csvText) {
    const lines = csvText.split(/\r?\n/).filter(line => line.trim() !== '');
    if (lines.length < 2) throw new Error('데이터가 비어 있습니다.');

    const headers = lines[0].split(',').map(h => h.trim().toLowerCase());
    const rawRows = [];

    for (let i = 1; i < lines.length; i++) {
      const parts = lines[i].split(',');
      if (parts.length >= 8) {
        rawRows.push([
          parts[0].trim(),
          parts[1].trim(),
          parts[2].trim(),
          parts[3].trim(),
          parseFloat(parts[4]) || 0,
          parseInt(parts[5], 10) || 0,
          parseInt(parts[6], 10) || 0,
          parseInt(parts[7], 10) || 0
        ]);
      }
    }

    processRawRows(rawRows);
  }

  // =========================================================================
  // 11. CSV Exporter & Toast Utility
  // =========================================================================
  function exportFilteredCsv() {
    const data = STATE.filteredData;
    if (data.length === 0) {
      showToast('내보낼 데이터가 없습니다.');
      return;
    }

    const headers = ['상태', '국가', '제품', '키워드타입', '캠페인명', '일자', '비용($)', '노출', '클릭', 'CTR(%)', 'CPC($)', 'CPM($)', '전환', 'CPA($)', '진단'];
    const csvRows = [headers.join(',')];

    data.forEach(r => {
      const row = [
        r.isAlert ? 'ALERT' : 'NORMAL',
        `"${r.country}"`,
        `"${r.product}"`,
        `"${r.keywordType}"`,
        `"${r.campaign}"`,
        r.date,
        r.cost.toFixed(2),
        r.impr,
        r.clicks,
        r.ctr.toFixed(2),
        r.cpc.toFixed(2),
        r.cpm.toFixed(2),
        r.conversions,
        r.cpa.toFixed(2),
        `"${r.diagnosis}"`
      ];
      csvRows.push(row.join(','));
    });

    const blob = new Blob(['\uFEFF' + csvRows.join('\r\n')], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const link = document.createElement('a');
    link.setAttribute('href', url);
    link.setAttribute('download', `google_ads_filtered_${new Date().toISOString().slice(0,10)}.csv`);
    document.body.appendChild(link);
    link.click();
    document.body.removeChild(link);
    showToast('CSV 파일이 다운로드되었습니다.');
  }

  function showToast(msg) {
    let toast = document.getElementById('appToast');
    if (!toast) {
      toast = document.createElement('div');
      toast.id = 'appToast';
      toast.style.cssText = `
        position: fixed;
        bottom: 24px;
        right: 24px;
        background-color: var(--mc-ink-black);
        color: var(--mc-canvas-cream);
        padding: 12px 24px;
        border-radius: var(--radius-pill);
        font-family: var(--font-family-base);
        font-size: 13px;
        font-weight: 500;
        box-shadow: 0 8px 24px rgba(0, 0, 0, 0.2);
        z-index: 9999;
        transition: opacity 0.3s ease, transform 0.3s ease;
        opacity: 0;
        transform: translateY(10px);
        pointer-events: none;
      `;
      document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.style.opacity = '1';
    toast.style.transform = 'translateY(0)';
    setTimeout(() => {
      toast.style.opacity = '0';
      toast.style.transform = 'translateY(10px)';
    }, 2800);
  }

})();
