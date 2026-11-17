/*
 * 東石診股 - FinMind 資料存取（瀏覽器直接呼叫，不需要後端）
 *
 * 金鑰：不寫在程式碼裡。使用者在頁面右上角「金鑰」輸入，只存在自己的瀏覽器 localStorage。
 *       沒有金鑰也能用（匿名額度較低）。
 * 注意：FinMind 的 CORS 不接受 Authorization 標頭，所以金鑰用 ?token= 參數帶入。
 */
(function (root) {
  "use strict";

  const BASE = "https://api.finmindtrade.com/api/v4/data";
  const TOKEN_KEY = "eastone.finmindToken";
  const LIST_KEY = "eastone.stockList.v2";   // v2：排除已下市股票（換 key 讓舊快取失效）
  const LIST_TTL = 24 * 60 * 60 * 1000;   // 股票清單一天更新一次
  const RESULT_TTL = 30 * 60 * 1000;      // 同一檔 30 分鐘內不重抓

  const store = {
    get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, v); } catch (e) { /* 無痕模式或空間不足 */ } },
    del(k) { try { localStorage.removeItem(k); } catch (e) { /* ignore */ } },
  };

  const getToken = () => store.get(TOKEN_KEY) || "";
  const setToken = (t) => (t ? store.set(TOKEN_KEY, t.trim()) : store.del(TOKEN_KEY));

  function daysAgo(n) {
    const d = new Date(Date.now() - n * 86400000);
    return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0");
  }

  async function get(dataset, params) {
    const q = new URLSearchParams(Object.assign({ dataset }, params || {}));
    const token = getToken();
    if (token) q.set("token", token);

    let res;
    try { res = await fetch(BASE + "?" + q.toString()); }
    catch (e) { throw new Error("連不上 FinMind，請檢查網路連線"); }

    let body = null;
    try { body = await res.json(); } catch (e) { /* 非 JSON */ }
    const msg = (body && body.msg) || "";

    if (res.status === 402 || /upper limit/i.test(msg)) {
      throw new Error(token
        ? "FinMind 本小時查詢次數已用完，請稍後再試"
        : "FinMind 匿名查詢次數已用完。到右上角「金鑰」填入免費的 FinMind 金鑰可提高上限");
    }
    if (!res.ok || !body || (body.status && body.status !== 200)) {
      throw new Error("FinMind 回應錯誤：" + (msg || res.status) + (/token/i.test(msg) ? "（請檢查金鑰）" : ""));
    }
    return body.data || [];
  }

  // 一次診斷需要的 5 份資料，同時發出
  async function fetchBundle(id) {
    const p = (dataset, start) => get(dataset, { data_id: id, start_date: daysAgo(start) });
    // 美股：FinMind 免費版只有每日股價（美東收盤後、台灣早上 8 點更新），只抓 1 份
    if (root.Scoring.isUS(id)) {
      const [daily, info] = await Promise.all([p("USStockPrice", 800), usInfo(id)]);
      return { daily, income: [], balance: [], per: [], inst: [], usEtf: !!(info && info.etf) };
    }
    // ETF 只看投資面：不必抓財報、資產負債表、本益比與法人資料，省下 4 次查詢
    if (root.Scoring.isEtf(id)) return { daily: await p("TaiwanStockPrice", 800), income: [], balance: [], per: [], inst: [] };
    const [daily, income, balance, per, inst] = await Promise.all([
      p("TaiwanStockPrice", 800),                                   // MA240 + σ240 + 一年走勢圖
      p("TaiwanStockFinancialStatements", 365 * 3 + 120),           // 近四季與去年同期
      p("TaiwanStockBalanceSheet", 400),
      p("TaiwanStockPER", 30),
      p("TaiwanStockInstitutionalInvestorsBuySell", 120),           // 連續買超最多看約 80 個交易日
    ]);
    return { daily, income, balance, per, inst };
  }

  // ---- 股票清單（中文名稱搜尋）----
  let listPromise = null;

  function loadStockList() {
    if (listPromise) return listPromise;
    const cached = store.get(LIST_KEY);
    if (cached) {
      try {
        const c = JSON.parse(cached);
        if (Date.now() - c.t < LIST_TTL && c.rows.length) return (listPromise = Promise.resolve(c.rows));
      } catch (e) { /* 壞掉就重抓 */ }
    }
    listPromise = Promise.all([
      get("TaiwanStockInfo"),
      get("TaiwanStockDelisting").catch(() => []),   // 抓不到下市清單時就不過濾
    ]).then(([data, delisted]) => {
      // FinMind 的股票清單會殘留已下市的舊代號（例如 2311 日月光 → 已併入 3711 日月光投控），
      // 同名時會搶走搜尋第一名、選了卻查不到股價。
      // 排除規則：在下市清單裡，而且股票清單裡的資料日期不是最新一天（代表已沒在更新）。
      // 兩個條件都要成立，避免誤刪上櫃轉上市等代號沿用的股票。
      const latest = {};
      data.forEach((r) => {
        if (/^\d{4}-\d{2}-\d{2}$/.test(r.date) && !(latest[r.stock_id] > r.date)) latest[r.stock_id] = r.date;
      });
      const newest = Object.values(latest).sort().pop();
      const gone = new Set(delisted.map((r) => r.stock_id).filter((id) => latest[id] !== newest));

      const seen = new Set(), rows = [];
      data.forEach((r) => {
        if (seen.has(r.stock_id) || gone.has(r.stock_id)) return;
        seen.add(r.stock_id);
        rows.push([r.stock_id, r.stock_name, r.industry_category || ""]);
      });
      store.set(LIST_KEY, JSON.stringify({ t: Date.now(), rows }));
      return rows;
    }).catch((e) => {
      listPromise = null;
      if (cached) { try { return JSON.parse(cached).rows; } catch (x) { /* fallthrough */ } }
      throw e;
    });
    return listPromise;
  }

  // ---- 美股清單（英文代號、英文名稱，常見個股與 ETF 另附中文名）----
  const US_KEY = "eastone.usList.v1";
  // 中文俗名：搜尋「輝達」「蘋果」也找得到；顯示時優先用中文名
  const US_ZH = {
    AAPL: "蘋果", MSFT: "微軟", NVDA: "輝達", GOOGL: "谷歌 A", GOOG: "谷歌 C", AMZN: "亞馬遜", META: "Meta（臉書）",
    TSLA: "特斯拉", TSM: "台積電 ADR", AVGO: "博通", AMD: "超微", INTC: "英特爾", QCOM: "高通", MU: "美光",
    ASML: "艾司摩爾", ARM: "安謀", SMCI: "美超微", ORCL: "甲骨文", ADBE: "Adobe", CRM: "Salesforce",
    NFLX: "網飛", PLTR: "Palantir", COST: "好市多", WMT: "沃爾瑪", KO: "可口可樂", PEP: "百事", MCD: "麥當勞",
    SBUX: "星巴克", NKE: "耐吉", DIS: "迪士尼", JPM: "摩根大通", BAC: "美國銀行", GS: "高盛", V: "Visa", MA: "萬事達卡",
    "BRK-B": "波克夏 B", LLY: "禮來", NVO: "諾和諾德", UNH: "聯合健康", PFE: "輝瑞", JNJ: "嬌生", XOM: "埃克森美孚",
    BA: "波音", UBER: "Uber", ASX: "日月光 ADR", UMC: "聯電 ADR",
    SPY: "SPDR 標普500 ETF", VOO: "先鋒標普500 ETF", IVV: "iShares 標普500 ETF", QQQ: "那斯達克100 ETF",
    VTI: "先鋒全美股市 ETF", VT: "先鋒全球股市 ETF", DIA: "道瓊工業 ETF", SOXX: "費城半導體 ETF", SMH: "半導體 ETF",
    SCHD: "嘉信美國高股息 ETF", VYM: "先鋒高股息 ETF", TLT: "20年以上美債 ETF", IEF: "7-10年美債 ETF",
    BND: "先鋒總體債券 ETF", SHY: "1-3年美債 ETF", GLD: "黃金 ETF", VNQ: "先鋒房地產 ETF",
  };
  const US_ETF_EXTRA = ["SPY", "VOO", "IVV", "QQQ", "VTI", "VT", "DIA", "SOXX", "SMH", "SCHD", "VYM", "TLT", "IEF", "BND", "SHY", "GLD", "VNQ"];
  // 名稱去掉 Common Stock 等股別字樣，比較好讀
  const cleanName = (n) => String(n || "").replace(/\s+(Class [A-Z]\s+)?(Common Stock|Ordinary Shares|Common Shares|Capital Stock|Subordinate Voting Shares).*$/i, "")
    .replace(/\s+American Depositary Shares.*$/i, " ADR").trim();

  let usPromise = null;
  function loadUSList() {
    if (usPromise) return usPromise;
    const cached = store.get(US_KEY);
    if (cached) {
      try {
        const c = JSON.parse(cached);
        if (Date.now() - c.t < LIST_TTL && c.rows.length) return (usPromise = Promise.resolve(c.rows));
      } catch (e) { /* 壞掉就重抓 */ }
    }
    usPromise = get("USStockInfo").then((data) => {
      // 清單裡有不少多年沒更新的舊代號（已下市或改代號），只留最新一天出現的
      const newest = data.reduce((m, r) => (r.date > m ? r.date : m), "");
      const seen = new Set(), rows = [];
      data.forEach((r) => {
        if (r.date !== newest || seen.has(r.stock_id)) return;
        seen.add(r.stock_id);
        rows.push([r.stock_id, cleanName(r.stock_name), r.Subsector === "ETF" ? "ETF" : (r.Subsector === "n/a" ? "" : r.Subsector)]);
      });
      // 中文表裡有、清單卻沒有的（例如波克夏報價代號是 BRK-B）補進去
      Object.keys(US_ZH).forEach((id) => { if (!seen.has(id)) rows.push([id, "", US_ETF_EXTRA.includes(id) ? "ETF" : ""]); });
      store.set(US_KEY, JSON.stringify({ t: Date.now(), rows }));
      return rows;
    }).catch((e) => {
      usPromise = null;
      if (cached) { try { return JSON.parse(cached).rows; } catch (x) { /* fallthrough */ } }
      throw e;
    });
    return usPromise;
  }
  const usDisplay = (id, en) => US_ZH[id] || en || id;

  async function usInfo(id) {
    try {
      const hit = (await loadUSList()).find((r) => r[0] === id);
      if (!hit) return US_ZH[id] ? { name: US_ZH[id], etf: US_ETF_EXTRA.includes(id) } : null;
      return { name: usDisplay(id, hit[1]), en: hit[1], etf: hit[2] === "ETF" };
    } catch (e) { return null; }
  }

  function searchUS(rows, q, qu) {
    const ql = q.toLowerCase();
    const hits = [];
    rows.forEach(([id, en, sector]) => {
      const zh = US_ZH[id] || "";
      let rank = -1;
      if (id === qu || zh === q) rank = 0;                     // 完全相符
      else if (id.startsWith(qu)) rank = 1 + id.length / 100;  // 代號開頭相符，短的優先
      else if (zh && zh.includes(q)) rank = 2;                 // 中文俗名
      else if (q.length >= 2 && en.toLowerCase().includes(ql)) rank = 3;   // 英文名稱
      if (rank >= 0) hits.push([rank, id, en, zh, sector]);
    });
    hits.sort((a, b) => a[0] - b[0] || (a[1] < b[1] ? -1 : 1));
    return hits.map(([, id, en, zh, sector]) => ({
      id, name: zh ? zh + (en ? " · " + en : "") : en, industry: "美股" + (sector ? " · " + sector : ""), market: "US",
    }));
  }

  // market：tw 只找台股、us 只找美股，沒給就兩邊都找
  async function search(query, limit, market) {
    const q = (query || "").trim();
    if (!q) return [];
    const qu = q.toUpperCase();                       // 00679b 也找得到 00679B；aapl 也找得到 AAPL
    const n = limit || 12;
    const latin = /^[A-Za-z]/.test(q);                // 英文開頭：先找美股
    const hasZh = /[^\x00-\x7F]/.test(q);
    const wantUS = market !== "tw", wantTW = market !== "us";
    let us = [];
    if (wantUS && (market === "us" || latin || (hasZh && Object.keys(US_ZH).some((id) => US_ZH[id].includes(q))))) {
      try { us = searchUS(await loadUSList(), q, qu); } catch (e) { us = []; }
    }
    let tw = [];
    if (wantTW && (!latin || us.length < n || market === "tw")) {
      const rows = await loadStockList();
      const hits = rows.filter(([id, name]) => id.startsWith(qu) || name.includes(q));
      hits.sort((a, b) => {
        const ea = a[0] === qu || a[1] === q, eb = b[0] === qu || b[1] === q;
        if (ea !== eb) return ea ? -1 : 1;                 // 完全相符優先
        if (a[0].length !== b[0].length) return a[0].length - b[0].length;  // 普通股優先於權證
        return a[0] < b[0] ? -1 : 1;
      });
      tw = hits.map(([id, name, industry]) => ({ id, name, industry }));
    }
    return (latin ? us.concat(tw) : tw.concat(us)).slice(0, n);
  }

  async function stockName(id) {
    if (root.Scoring.isUS(id)) { const i = await usInfo(id); return i ? i.name : ""; }
    try { const hit = (await loadStockList()).find((r) => r[0] === id); return hit ? hit[1] : ""; }
    catch (e) { return ""; }
  }

  // ---- 診斷（含 30 分鐘快取）----
  const cache = new Map();

  function stamp() {
    const d = new Date();
    return daysAgo(0) + " " + String(d.getHours()).padStart(2, "0") + ":" + String(d.getMinutes()).padStart(2, "0");
  }

  async function diagnose(id, refresh) {
    const hit = cache.get(id);
    if (hit && !refresh && Date.now() - hit.t < RESULT_TTL) return Object.assign({}, hit.r, { cached: true });
    const [bundle, name] = await Promise.all([fetchBundle(id), stockName(id)]);
    const r = root.Scoring.diagnose(id, bundle, name);
    if (root.Scoring.isUS(id)) { const i = await usInfo(id); if (i && i.en && i.en !== r.stock.name) r.stock.en = i.en; }
    r.fetched_at = stamp();
    cache.set(id, { t: Date.now(), r });
    return Object.assign({}, r, { cached: false });
  }

  root.FinMind = { getToken, setToken, search, diagnose, loadStockList, loadUSList };
})(self);
