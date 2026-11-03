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
  const LIST_KEY = "eastone.stockList.v1";
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
    listPromise = get("TaiwanStockInfo").then((data) => {
      const seen = new Set(), rows = [];
      data.forEach((r) => {
        if (seen.has(r.stock_id)) return;
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

  async function search(query, limit) {
    const q = (query || "").trim();
    if (!q) return [];
    const rows = await loadStockList();
    const hits = rows.filter(([id, name]) => id.startsWith(q) || name.includes(q));
    hits.sort((a, b) => {
      const ea = a[0] === q || a[1] === q, eb = b[0] === q || b[1] === q;
      if (ea !== eb) return ea ? -1 : 1;                 // 完全相符優先
      if (a[0].length !== b[0].length) return a[0].length - b[0].length;  // 普通股優先於權證
      return a[0] < b[0] ? -1 : 1;
    });
    return hits.slice(0, limit || 12).map(([id, name, industry]) => ({ id, name, industry }));
  }

  async function stockName(id) {
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
    r.fetched_at = stamp();
    cache.set(id, { t: Date.now(), r });
    return Object.assign({}, r, { cached: false });
  }

  root.FinMind = { getToken, setToken, search, diagnose, loadStockList };
})(self);
