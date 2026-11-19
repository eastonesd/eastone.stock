/*
 * 東石診股 - 基金淨值（資料由 GitHub Actions 每天收集，放在同一個網站的 data/funds/）
 *   data/funds/index.json   全部基金清單＋最新淨值
 *   data/funds/nav/<id>.csv 每檔基金累積的淨值歷史（date,nav）
 * 來源：投信投顧公會（境內）、集保結算所（境外），皆為政府開放資料。
 * 兩個來源都只給最近幾天，歷史是從 2026-11-18 開始一天天累積的。
 */
(function (root) {
  "use strict";

  const BASE = "data/funds/";
  let indexPromise = null;

  function loadIndex(refresh) {
    if (indexPromise && !refresh) return indexPromise;
    indexPromise = fetch(BASE + "index.json", { cache: "no-cache" })
      .then((r) => { if (!r.ok) throw new Error("讀不到基金清單（" + r.status + "）"); return r.json(); })
      .then((d) => {
        const col = {}; d.columns.forEach((c, i) => { col[c] = i; });
        const funds = d.funds.map((x) => ({
          id: x[col.id], name: x[col.name], company: x[col.company], currency: x[col.currency] || "",
          kind: x[col.kind], isin: x[col.isin] || "", type: x[col.type] || "", date: x[col.date], nav: x[col.nav],
          ticker: x[col.ticker] || "", org: (col.org != null && x[col.org]) || "", issuer: (col.issuer != null && x[col.issuer]) || "",
        }));
        const byId = new Map(funds.map((f) => [f.id, f]));
        return { updated: d.updated, funds, byId };
      })
      .catch((e) => { indexPromise = null; throw e; });
    return indexPromise;
  }

  // 多個關鍵字用空白隔開，全部都要符合（例如「安聯 收益 美元」）
  async function search(query, limit) {
    const q = (query || "").trim();
    if (!q) return [];
    const { funds } = await loadIndex();
    const words = q.toUpperCase().split(/\s+/).filter(Boolean);
    const qu = q.toUpperCase();
    const hits = [];
    funds.forEach((f) => {
      const hay = (f.name + " " + f.company + " " + f.isin + " " + f.ticker).toUpperCase();
      if (!words.every((w) => hay.includes(w))) return;
      let rank = 3;
      if (f.isin === qu || f.ticker === qu) rank = 0;
      else if (f.name.toUpperCase().startsWith(words[0])) rank = 1;
      else if (words.every((w) => f.name.toUpperCase().includes(w))) rank = 2;
      hits.push([rank, f.name.length, f]);
    });
    hits.sort((a, b) => a[0] - b[0] || a[1] - b[1]);
    return hits.slice(0, limit || 12).map(([, , f]) => f);
  }

  async function history(id) {
    const r = await fetch(BASE + "nav/" + encodeURIComponent(id) + ".csv", { cache: "no-cache" });
    if (!r.ok) throw new Error("找不到這檔基金的淨值資料");
    return (await r.text()).trim().split("\n").slice(1).map((l) => {
      const [d, v] = l.split(","); return [d, Number(v)];
    }).filter(([d, v]) => d && isFinite(v) && v > 0);
  }

  // 配息紀錄：data/funds/div/<id>.csv（exdate,amount），沒有檔案代表沒收到配息（多半是累積型）
  async function dividends(id) {
    try {
      const r = await fetch(BASE + "div/" + encodeURIComponent(id) + ".csv", { cache: "no-cache" });
      if (!r.ok) return [];
      return (await r.text()).trim().split("\n").slice(1).map((l) => {
        const [d, v] = l.split(","); return [d, Number(v)];
      }).filter(([d, v]) => d && isFinite(v) && v > 0).sort((a, b) => (a[0] < b[0] ? -1 : 1));
    } catch (e) { return []; }
  }

  // 含息淨值：假設每次配息都在除息日用當天淨值再買回，持有單位數逐次增加；值＝淨值 × 累積單位數
  function totalReturnIndex(h, divs) {
    let units = 1, j = 0;
    const out = [];
    for (let i = 0; i < h.length; i++) {
      const [d, nav] = h[i];
      while (j < divs.length && divs[j][0] <= d) {
        if (i > 0 || divs[j][0] === d) units *= 1 + divs[j][1] / nav;   // 淨值資料開始前的配息不算
        j++;
      }
      out.push(nav * units);
    }
    return out;
  }

  const DAY = 86400000;
  // 期間報酬：找「期初那天或之前」最近一筆；資料還沒累積到那麼久就回傳 null。vals 預設用淨值
  function periodReturn(h, days, vals) {
    if (h.length < 2) return null;
    const v = vals || h.map((p) => p[1]);
    const lastT = Date.parse(h[h.length - 1][0]), target = lastT - days * DAY;
    if (Date.parse(h[0][0]) > target + 3 * DAY) return null;      // 容許 3 天（遇到假日）
    let b = 0;
    for (let i = 0; i < h.length; i++) { if (Date.parse(h[i][0]) <= target) b = i; else break; }
    return v[v.length - 1] / v[b] - 1;
  }

  function divSummary(h, divs) {
    if (!divs.length || !h.length) return null;
    const lastT = Date.parse(h[h.length - 1][0]);
    const year = divs.filter(([d]) => Date.parse(d) > lastT - 365 * DAY && Date.parse(d) <= lastT + 31 * DAY);
    const n = year.length;
    const freq = n >= 10 ? "每月" : n >= 3 ? "每季" : n === 2 ? "每半年" : n === 1 ? "每年" : "近一年未配息";
    const sum = year.reduce((a, [, v]) => a + v, 0);
    const last = divs[divs.length - 1];
    return { count: n, freq, sum, yield: n ? sum / h[h.length - 1][1] : 0, last, since: divs[0][0], total: divs.length };
  }

  function stats(h, divs) {
    divs = divs || [];
    const tr = divs.length ? totalReturnIndex(h, divs) : null;
    const n = h.length, last = h[n - 1], prev = n > 1 ? h[n - 2] : null;
    const rets = [];
    for (let i = 1; i < n; i++) rets.push(h[i][1] / h[i - 1][1] - 1);
    let vol = null;
    if (rets.length >= 20) {                                          // 年化波動度（至少 20 筆）
      const r = rets.slice(-250), m = r.reduce((a, b) => a + b, 0) / r.length;
      vol = Math.sqrt(r.reduce((a, b) => a + (b - m) ** 2, 0) / (r.length - 1)) * Math.sqrt(250);
    }
    const span = n ? Math.round((Date.parse(last[0]) - Date.parse(h[0][0])) / DAY) : 0;
    return {
      nav: last ? last[1] : null, date: last ? last[0] : null,
      change: prev ? last[1] - prev[1] : null, change_pct: prev ? last[1] / prev[1] - 1 : null,
      periods: [["1 週", 7], ["1 個月", 30], ["3 個月", 91], ["6 個月", 182], ["1 年", 365], ["3 年", 1095], ["5 年", 1826]]
        .map(([label, d]) => ({ label, days: d, value: periodReturn(h, d), total: tr ? periodReturn(h, d, tr) : null })),
      vol, count: n, since: n ? h[0][0] : null, span,
      tr, div: divSummary(h, divs),
    };
  }

  root.Funds = { loadIndex, search, history, dividends, stats, totalReturnIndex };
})(self);
