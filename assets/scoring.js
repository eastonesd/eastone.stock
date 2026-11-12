/*
 * 東石診股 - 評分引擎（JavaScript 版）
 * ======================================
 * 由 健康系統v2.py（財報＋籌碼）與 投資系統v2.py（技術面）改寫。
 * 每個指標的級距只定義一次：同一份資料拿來算分數，也拿來畫網頁上的級距階梯。
 *
 * 相對原版 Python 的修正：
 *   1. 趨勢：總分改用 20~100 的趨勢等級（原版誤用 -100~100 的原始分）
 *   2. ROE：改用近四季淨利（原版用單季，對照的卻是年化門檻）
 *   3. 市場情緒：價格偏離改用 % 計（原版用「元」，高價股永遠滿分）
 *   4. 波動性：改用日報酬率標準差（原版用股價標準差，被趨勢撐大）
 *   5. MA20 斜率：統一用 20 日回歸斜率（原版算到一半被 diff() 覆寫）
 *   6. EPS 成長率：去年同期為負時分母取絕對值
 *   7. ETF 沒有本益比時不計分
 *
 * 輸入的 bundle 就是 FinMind v4 API 回傳的 data 陣列，欄位名稱不變。
 */
(function (root) {
  "use strict";

  const DEFAULTS = { healthWeight: 0.5, investWeight: 0.5, greenAt: 70, yellowAt: 50 };

  // ---------------------------------------------------------------------------
  // 共用工具
  // ---------------------------------------------------------------------------
  const isNum = (x) => typeof x === "number" && isFinite(x);
  const band = (label, score, test) => ({ label, score, test });

  function ladderScore(value, bands) {
    if (!isNum(value)) return [null, null];
    for (let i = 0; i < bands.length; i++) if (bands[i].test(value)) return [bands[i].score, i];
    return [null, null];
  }

  function makeLight(cfg) {
    return (score) => !isNum(score) ? "gray" : score >= cfg.greenAt ? "green" : score >= cfg.yellowAt ? "yellow" : "red";
  }

  const round = (x, d) => (isNum(x) ? Math.round(x * 10 ** d) / 10 ** d : null);
  const mean = (arr) => { const v = arr.filter(isNum); return v.length ? v.reduce((a, b) => a + b, 0) / v.length : null; };

  // ---- 數列運算（對應 pandas rolling）----
  function rolling(arr, n, fn) {
    const out = new Array(arr.length).fill(null);
    for (let i = n - 1; i < arr.length; i++) {
      const w = arr.slice(i - n + 1, i + 1);
      out[i] = w.every(isNum) ? fn(w) : null;
    }
    return out;
  }
  const sum = (w) => w.reduce((a, b) => a + b, 0);
  const avg = (w) => sum(w) / w.length;
  const std = (w) => { const m = avg(w); return Math.sqrt(w.reduce((a, b) => a + (b - m) ** 2, 0) / (w.length - 1)); };
  const mad = (w) => { const m = avg(w); return avg(w.map((x) => Math.abs(x - m))); };
  const slope = (w) => {               // 最小平方法斜率（= np.polyfit(x, y, 1)[0]）
    const n = w.length, mx = (n - 1) / 2, my = avg(w);
    let num = 0, den = 0;
    for (let i = 0; i < n; i++) { num += (i - mx) * (w[i] - my); den += (i - mx) ** 2; }
    return num / den;
  };
  const last = (arr) => arr[arr.length - 1];

  const fmtPct = (x, d = 1, sign = false) => (sign && x > 0 ? "+" : "") + (x * 100).toFixed(d) + "%";
  const fmtInt = (x) => Math.round(x).toLocaleString("en-US");
  const quarterLabel = (d) => d.slice(0, 4) + "Q" + (Math.floor((+d.slice(5, 7) - 1) / 3) + 1);
  const daysBetween = (a, b) => (Date.parse(b) - Date.parse(a)) / 86400000;

  // ---------------------------------------------------------------------------
  // 級距定義（與原始系統相同的門檻；一律由高分排到低分）
  // ---------------------------------------------------------------------------
  const BANDS = {
    roe: [
      band("≥ 20%", 100, (x) => x >= 0.20), band("15–20%", 80, (x) => x >= 0.15),
      band("10–15%", 60, (x) => x >= 0.10), band("5–10%", 40, (x) => x >= 0.05), band("< 5%", 20, () => true),
    ],
    epsGrowth: [
      band("≥ 30%", 100, (x) => x >= 0.30), band("15–30%", 80, (x) => x >= 0.15),
      band("5–15%", 60, (x) => x >= 0.05), band("0–5%", 40, (x) => x >= 0), band("< 0", 20, () => true),
    ],
    per: [
      band("8–15", 100, (x) => x > 8 && x <= 15), band("15–20", 80, (x) => x > 15 && x <= 20),
      band("20–25", 60, (x) => x > 20 && x <= 25), band("25–35", 40, (x) => x > 25 && x <= 35),
      band("≤8 或 >35", 20, () => true),
    ],
    dbr: [
      band("< 20%", 100, (x) => x < 0.20), band("20–35%", 80, (x) => x <= 0.35),
      band("35–50%", 60, (x) => x <= 0.50), band("50–65%", 40, (x) => x <= 0.65), band("> 65%", 20, () => true),
    ],
    inst: [
      band("≥ 20 天", 100, (x) => x >= 20), band("10–19", 80, (x) => x >= 10),
      band("5–9", 60, (x) => x >= 5), band("1–4", 40, (x) => x >= 1), band("0 天", 20, () => true),
    ],
    supply: [
      band("≥ 2.0", 100, (x) => x >= 2.0), band("1.2–2", 80, (x) => x >= 1.2),
      band("0.8–1.2", 60, (x) => x >= 0.8), band("0.5–0.8", 40, (x) => x >= 0.5), band("< 0.5", 20, () => true),
    ],
    trend: [
      band("≥ 70", 100, (x) => x >= 70), band("30–69", 80, (x) => x >= 30),
      band("-29–29", 60, (x) => x > -30), band("-69– -30", 40, (x) => x > -70), band("≤ -70", 20, () => true),
    ],
    volatility: [
      band("≥ 1.6", 100, (x) => x >= 1.6), band("1.2–1.6", 80, (x) => x >= 1.2),
      band("0.9–1.2", 60, (x) => x >= 0.9), band("0.7–0.9", 40, (x) => x >= 0.7), band("< 0.7", 20, () => true),
    ],
    liquidity: [
      band("≥ 2", 100, (x) => x >= 2), band("1–2", 75, (x) => x >= 1),
      band("0.5–1", 50, (x) => x >= 0.5), band("< 0.5", 25, () => true),
    ],
    emotion: [
      band("≥ 2.5", 100, (x) => x >= 2.5), band("1.5–2.5", 80, (x) => x >= 1.5),
      band("0.5–1.5", 60, (x) => x >= 0.5), band("0–0.5", 40, (x) => x >= 0), band("< 0", 20, () => true),
    ],
  };

  // ---------------------------------------------------------------------------
  // 健康面（財報 + 籌碼）
  // ---------------------------------------------------------------------------
  // FinMind 財報是 long format：{date, type, value} → 轉成 {type: [[date, value], ...]}，依日期排序
  function pivot(rows) {
    const map = {};
    (rows || []).forEach((r) => {
      const v = Number(r.value);
      if (!isFinite(v)) return;
      (map[r.type] = map[r.type] || {});
      if (!(r.date in map[r.type])) map[r.type][r.date] = v;
    });
    const out = {};
    Object.keys(map).forEach((t) => {
      out[t] = Object.keys(map[t]).sort().map((d) => [d, map[t][d]]);
    });
    return out;
  }
  const pick = (p, ...names) => { for (const n of names) if (p[n] && p[n].length) return p[n]; return []; };

  function healthItems(bundle, warnings, item) {
    const income = pivot(bundle.income), balance = pivot(bundle.balance);
    const hasIncome = (bundle.income || []).length > 0;
    const items = [];

    // ROE（近四季淨利 / 最新權益）
    let roe = null, roeDetail = "";
    const ni = pick(income, "IncomeAfterTaxes", "IncomeAfterTax", "IncomeFromContinuingOperations", "ProfitLoss", "NetIncomeLoss");
    const equity = pick(balance, "Equity", "EquityAttributableToOwnersOfParent", "StockholdersEquity");
    if (ni.length >= 4 && equity.length) {
      const last4 = ni.slice(-4), span = daysBetween(last4[0][0], last4[3][0]);
      if (span >= 240 && span <= 300) {
        roe = sum(last4.map((x) => x[1])) / last(equity)[1];
        roeDetail = "近四季淨利 / " + last(equity)[0].slice(0, 7) + " 股東權益";
      } else {
        warnings.push("ROE：財報季度不連續，無法計算近四季淨利");
      }
    }
    items.push(item("roe", "ROE 股東權益報酬率", roe, isNum(roe) ? fmtPct(roe) : "", BANDS.roe, roeDetail));

    // EPS 成長率（最新一季 vs 去年同季）
    let growth = null, gDetail = "";
    const eps = pick(income, "EPS", "BasicEarningsPerShare");
    if (eps.length) {
      const [lastDate, cur] = last(eps);
      const prevDate = (+lastDate.slice(0, 4) - 1) + lastDate.slice(4);
      const prev = eps.find((x) => x[0] === prevDate);
      if (prev) {
        if (prev[1] !== 0) growth = (cur - prev[1]) / Math.abs(prev[1]);
        gDetail = quarterLabel(lastDate) + " EPS " + cur.toFixed(2) + "，去年同期 " + prev[1].toFixed(2);
      }
    }
    items.push(item("eps_growth", "EPS 成長率", growth, isNum(growth) ? fmtPct(growth, 1, true) : "", BANDS.epsGrowth, gDetail));

    // PER（最新交易日）
    let per = null, perNote = "";
    const perRows = (bundle.per || []).slice().sort((a, b) => (a.date < b.date ? -1 : 1))
      .map((r) => Number(r.PER)).filter(isFinite);
    if (perRows.length) per = last(perRows);
    if (per === 0) {
      if (!hasIncome) per = null;          // ETF：本益比不適用
      else perNote = "本益比為 0：近四季虧損";
    }
    items.push(item("per", "PER 本益比", per, isNum(per) ? per.toFixed(1) + " 倍" : "", BANDS.per, "", 1, perNote));

    // 負債比
    let dbr = null, dbrDetail = "";
    const liab = pick(balance, "TotalLiabilities", "Liabilities");
    const assets = pick(balance, "TotalAssets");
    if (liab.length && assets.length) {
      dbr = last(liab)[1] / last(assets)[1];
      dbrDetail = quarterLabel(last(liab)[0]) + " 資產負債表";
    }
    items.push(item("dbr", "負債比", dbr, isNum(dbr) ? fmtPct(dbr) : "", BANDS.dbr, dbrDetail));

    // 三大法人連續買超天數
    let days = null, instDetail = "";
    if ((bundle.inst || []).length) {
      const byDate = {};
      bundle.inst.forEach((r) => { byDate[r.date] = (byDate[r.date] || 0) + Number(r.buy) - Number(r.sell); });
      const net = Object.keys(byDate).sort().map((d) => byDate[d]);
      days = 0;
      for (let i = net.length - 1; i >= 0 && net[i] > 0; i--) days++;
      const n = last(net) / 1000;
      instDetail = "最新一日三大法人合計 " + (n > 0 ? "+" : "") + fmtInt(n) + " 張";
    }
    items.push(item("inst_days", "三大法人連續買超", days, isNum(days) ? days + " 天" : "", BANDS.inst, instDetail));

    if (!hasIncome) warnings.push("查無財報資料（ETF 或新上市股票），健康面只計籌碼與本益比");
    return items;
  }

  // ---------------------------------------------------------------------------
  // 投資面（技術面）
  // ---------------------------------------------------------------------------
  function preparePrice(daily) {
    const rows = daily.slice().sort((a, b) => (a.date < b.date ? -1 : 1));
    const p = {
      date: rows.map((r) => r.date),
      close: rows.map((r) => Number(r.close)),
      volume: rows.map((r) => Number(r.Trading_Volume)),
      spread: rows.map((r) => (r.spread == null ? null : Number(r.spread))),
    };
    [5, 20, 60, 120, 240].forEach((n) => { p["MA" + n] = rolling(p.close, n, avg); });
    return p;
  }

  function investItems(p, warnings, item) {
    const n = p.close.length, L = n - 1, c = p.close, v = p.volume;
    if (n < 260) warnings.push("上市未滿一年，部分技術指標（MA240、波動比）資料不足");

    const ma20Trend = rolling(p.MA20, 20, slope)[L];
    let mult = 1, multNote = "";
    if (isNum(ma20Trend) && ma20Trend < 0) { mult = 0.5; multNote = "MA20 下彎，分數 ×0.5"; }

    const items = [];

    // 1. 供需：今日量 / 20 日均量
    const volRatio20 = v[L] / rolling(v, 20, avg)[L];
    items.push(item("supply", "供需（量 / 20日均量）", volRatio20, volRatio20.toFixed(2) + " 倍", BANDS.supply,
      "今日成交 " + fmtInt(v[L] / 1000) + " 張", mult, multNote));

    // 2. 趨勢：均線排列 + 均線方向
    const MAS = ["MA5", "MA20", "MA60", "MA120", "MA240"];
    const now = (k) => (k === "close" ? c[L] : p[k][L]);
    const pairs = [["close", "MA5"], ["MA5", "MA20"], ["MA20", "MA60"], ["MA60", "MA120"], ["MA120", "MA240"]]
      .map(([a, b]) => [now(a), now(b)]);
    let trend = null, tDetail = "";
    if (L >= 1 && pairs.every(([a, b]) => isNum(a) && isNum(b))) {
      const cmp = (a, b) => (a > b ? 10 : a < b ? -10 : 0);
      const align = sum(pairs.map(([a, b]) => cmp(a, b)));
      const dir = sum(MAS.map((m) => cmp(p[m][L], p[m][L - 1])));
      trend = align + dir;
      tDetail = "均線排列 " + (align >= 0 ? "+" : "") + align + "、均線方向 " + (dir >= 0 ? "+" : "") + dir;
    }
    items.push(item("trend", "趨勢（排列 + 方向）", trend, isNum(trend) ? (trend > 0 ? "+" : "") + trend : "", BANDS.trend, tDetail));

    // 3. 波動性：20 日報酬率標準差 / 240 日報酬率標準差
    const ret = c.map((x, i) => (i === 0 ? null : x / c[i - 1] - 1));
    const sd20 = rolling(ret, 20, std)[L], sd240 = rolling(ret, 240, std)[L];
    const volRatio = isNum(sd20) && isNum(sd240) && sd240 ? sd20 / sd240 : null;
    items.push(item("volatility", "波動性（σ20 / σ240）", volRatio, isNum(volRatio) ? volRatio.toFixed(2) : "",
      BANDS.volatility, isNum(volRatio) ? "日波動 " + (sd20 * 100).toFixed(2) + "%，一年平均 " + (sd240 * 100).toFixed(2) + "%" : ""));

    // 4. 流動性：今日量 / 60 日均量
    const liq = v[L] / rolling(v, 60, avg)[L];
    items.push(item("liquidity", "流動性（量 / 60日均量）", liq, isNum(liq) ? liq.toFixed(2) + " 倍" : "", BANDS.liquidity));

    // 5. 市場情緒：0.6 × 價格偏離% + 0.4 × 量能比
    const devPct = rolling(c, 20, mad)[L] / p.MA20[L] * 100;
    const emotion = 0.6 * devPct + 0.4 * volRatio20;
    items.push(item("emotion", "市場情緒", emotion, isNum(emotion) ? emotion.toFixed(2) : "", BANDS.emotion,
      isNum(emotion) ? "價格偏離 " + devPct.toFixed(2) + "% · 量能 " + volRatio20.toFixed(2) + " 倍" : "", mult, multNote));
    return items;
  }

  // ---------------------------------------------------------------------------
  // 總入口
  // ---------------------------------------------------------------------------
  const VERDICT = {
    green: "體質與走勢條件良好",
    yellow: "部分條件轉弱，宜觀察",
    red: "多項條件不佳，暫時避開",
    gray: "資料不足，無法判斷",
  };

  function diagnose(stockId, bundle, name, options) {
    const cfg = Object.assign({}, DEFAULTS, options || {});
    const light = makeLight(cfg);
    if (!bundle.daily || !bundle.daily.length) {
      const err = new Error("找不到 " + stockId + " 的股價資料：代號有誤，或這檔已經下市");
      err.notFound = true;
      throw err;
    }

    const item = (key, label, value, valueText, bands, detail, multiplier, note) => {
      const [base, idx] = ladderScore(value, bands);
      const score = base === null ? null : base * (multiplier || 1);
      return {
        key, name: label, value: round(value, 4),
        value_text: base === null ? "資料不足" : valueText,
        detail: detail || "", note: note || "",
        base_score: base, score: round(score, 1), light: light(score),
        bands: bands.map((b) => ({ label: b.label, score: b.score, light: light(b.score) })),
        active: idx,
      };
    };

    const warnings = [];
    const price = preparePrice(bundle.daily);
    // 00 開頭是台灣 ETF：沒有單一公司的財報與估值，健康面不適用，綜合分只看投資面
    const etf = isEtf(stockId);
    const health = etf ? [] : healthItems(bundle, warnings, item);
    const invest = investItems(price, warnings, item);
    const weights = etf ? { health: 0, invest: 1 } : { health: cfg.healthWeight, invest: cfg.investWeight };

    const hScore = etf ? null : mean(health.map((i) => i.score));
    const iScore = mean(invest.map((i) => i.score));
    const parts = [[hScore, weights.health], [iScore, weights.invest]].filter(([s, w]) => isNum(s) && w > 0);
    const overall = parts.length ? sum(parts.map(([s, w]) => s * w)) / sum(parts.map(([, w]) => w)) : null;

    const L = price.close.length - 1;
    const close = price.close[L], spread = price.spread[L];
    const prevClose = isNum(spread) ? close - spread : null;
    const from = Math.max(0, L - 249);
    const tail = (arr) => arr.slice(from).map((x) => round(x, 2));
    const overallLight = light(overall);

    return {
      stock: { id: stockId, name: name || "" },
      as_of: price.date[L],
      price: {
        close: round(close, 2),
        change: round(spread, 2),
        change_pct: prevClose ? round(spread / prevClose, 4) : null,
      },
      overall: { score: round(overall, 1), light: overallLight, verdict: VERDICT[overallLight] },
      weights,
      etf,
      etf_type: etfType(stockId),
      thresholds: { green: cfg.greenAt, yellow: cfg.yellowAt },
      dimensions: [
        { key: "health", name: "健康面", sub: etf ? "ETF 不適用" : "財報 · 估值 · 籌碼", score: round(hScore, 1),
          light: light(hScore), items: health, excluded: etf,
          note: etf ? "ETF 是一籃子股票，沒有單一公司的財報、本益比與法人連買可評，因此不計入綜合分。" : "" },
        { key: "invest", name: "投資面", sub: "量價 · 趨勢 · 波動", score: round(iScore, 1), light: light(iScore), items: invest },
      ],
      chart: {
        dates: price.date.slice(from),
        close: tail(price.close), MA20: tail(price.MA20), MA60: tail(price.MA60), MA240: tail(price.MA240),
      },
      warnings,
    };
  }

  // 台灣 ETF 代號一律 00 開頭（例如 0050、00878）
  function isEtf(stockId) { return /^00/.test(String(stockId || "")); }

  // ETF 代號結尾的英文字母代表類別，例如 00679B、00631L、00632R、00635U、00980A
  // family 只用來決定標籤顏色：bond 債券、lev 槓桿、inv 反向、fut 期貨、active 主動、mix 平衡、stock 股票
  const ETF_SUFFIX = {
    // 台幣計價
    B: { label: "債券型", family: "bond" },
    L: { label: "槓桿型", family: "lev" },
    R: { label: "反向型", family: "inv" },
    U: { label: "期貨型", family: "fut" },
    A: { label: "主動式", family: "active" },
    D: { label: "主動式債券型", family: "bond" },
    T: { label: "被動式平衡型", family: "mix" },
    // 外幣計價
    K: { label: "股票型", family: "stock", foreign: true },
    C: { label: "債券型", family: "bond", foreign: true },
    M: { label: "槓桿型", family: "lev", foreign: true },
    S: { label: "反向型", family: "inv", foreign: true },
    V: { label: "期貨型", family: "fut", foreign: true },
  };
  function etfType(stockId) {
    if (!isEtf(stockId)) return null;
    const m = /([A-Za-z])$/.exec(String(stockId));
    if (!m) return { code: "", label: "ETF", family: "stock", foreign: false };
    const code = m[1].toUpperCase(), t = ETF_SUFFIX[code];
    if (!t) return { code, label: "ETF（" + code + " 類）", family: "other", foreign: false };
    return { code, label: (t.foreign ? "外幣計價 · " : "") + t.label + " ETF", family: t.family, foreign: !!t.foreign };
  }

  // 評分算法版本：改了評分規則就把數字加 1，自選股裡用舊算法算的分數會在開啟時自動重算
  // 2：00 開頭 ETF 只看投資面（2026-11-09）
  const VERSION = 2;

  const api = { diagnose, BANDS, DEFAULTS, isEtf, etfType, VERSION };
  if (typeof module !== "undefined" && module.exports) module.exports = api;
  else root.Scoring = api;
})(typeof self !== "undefined" ? self : this);
