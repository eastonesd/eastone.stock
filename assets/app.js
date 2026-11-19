(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const LIGHT_NAME = { green: "綠燈", yellow: "黃燈", red: "紅燈", gray: "無資料" };
  const WATCH_KEY = "eastone.watchlist.v1";
  const QUICK = {
    tw: [["2330", "台積電"], ["2317", "鴻海"], ["2454", "聯發科"], ["2881", "富邦金"], ["0050", "元大台灣50"]],
    us: [["NVDA", "輝達"], ["AAPL", "蘋果"], ["TSM", "台積電 ADR"], ["VOO", "標普500"], ["QQQ", "那斯達克100"]],
  };
  const FUND_QUICK = [["F-AGIF-FVM", "安聯收益成長 AM 美元"], ["F-BLKTEPMA", "貝萊德世界科技 A2 美元"],
    ["F-JFPATT", "摩根太平洋科技 美元"], ["T-18480065", "安聯台灣科技"], ["T-92002244", "統一黑馬"]];
  const FUND_WATCH_KEY = "eastone.fundwatch.v1";
  const CUR_NAME = { TWD: "新台幣", USD: "美元", EUR: "歐元", JPY: "日圓", AUD: "澳幣", ZAR: "南非幣", CNY: "人民幣", RMB: "人民幣",
    CNH: "人民幣", GBP: "英鎊", HKD: "港幣", SGD: "新加坡幣", NZD: "紐幣", CAD: "加幣", CHF: "瑞士法郎", SEK: "瑞典克朗" };
  const MARKET_KEY = "eastone.market.v1";
  const MARKET_TEXT = {
    tw: { ph: "輸入台股代號或名稱，例如 2330、台積電、00878",
      title: "一眼看出一檔股票現在是什麼燈",
      text: "健康面看財報、估值與籌碼，投資面看量價與趨勢，各 5 項指標，<br>每一項都會告訴你落在哪個級距、離下一個燈號還差多少。" },
    us: { ph: "輸入美股代號或名稱，例如 NVDA、輝達、VOO",
      title: "美股也一眼看出現在是什麼燈",
      text: "依 FinMind 每日收盤價（台灣早上 8 點更新），看量價、趨勢與波動 5 項指標，<br>美股沒有財報與法人資料，健康面不計分。常見個股可用中文名搜尋。" },
    fund: { ph: "輸入基金名稱、投信或 ISIN，例如「安聯 收益成長」「貝萊德 科技 美元」" },
  };

  let current = null;     // 目前顯示的診斷結果
  let suggestItems = [];
  let suggestIndex = -1;
  let searchTimer = null;

  // ---------------- 自選股（存在瀏覽器） ----------------
  function loadWatch() {
    try { return JSON.parse(localStorage.getItem(WATCH_KEY)) || []; } catch (e) { return []; }
  }
  function saveWatch(list) {
    try { localStorage.setItem(WATCH_KEY, JSON.stringify(list)); } catch (e) { /* 無痕模式等 */ }
  }
  let watch = loadWatch();

  // 自選股記錄：v 是評分算法版本，舊版算的分數開啟時會自動重算
  function entryOf(r, fallbackName) {
    return { id: r.stock.id, name: r.stock.name || fallbackName || r.stock.id,
      score: r.overall.score, light: r.overall.light, v: Scoring.VERSION };
  }
  const isStale = (w) => w.v !== Scoring.VERSION;

  function upsertWatch(r) {
    const i = watch.findIndex((w) => w.id === r.stock.id);
    if (i < 0) return;
    watch[i] = entryOf(r, watch[i].name);
    saveWatch(watch);
  }

  function renderWatch() {
    if (typeof market !== "undefined" && market === "fund") return renderFundWatch();
    const box = $("chips");
    box.innerHTML = "";
    $("refreshAll").hidden = watch.length === 0;
    if (!watch.length) {
      box.innerHTML = '<span class="hint">診斷後按「加入自選」，下次一眼看完全部燈號</span>';
      return;
    }
    watch.forEach((w) => {
      const chip = document.createElement("span");
      chip.className = "chip" + (current && current.stock.id === w.id ? " active" : "") + (updating.has(w.id) ? " busy" : "");
      chip.title = updating.has(w.id) ? "用新算法重新診斷中…" : isStale(w) ? "舊算法的分數，等待自動更新" : "";
      chip.innerHTML =
        '<span class="dot ' + (w.light || "gray") + '"></span>' +
        "<span>" + esc(w.name || w.id) + "</span>" +
        '<span class="s">' + (updating.has(w.id) ? "…" : w.score != null ? Math.round(w.score) : "–") + "</span>" +
        '<button class="x" title="移除" type="button">×</button>';
      chip.addEventListener("click", (e) => {
        if (e.target.classList.contains("x")) {
          watch = watch.filter((x) => x.id !== w.id);
          saveWatch(watch); renderWatch(); updateWatchBtn();
        } else {
          diagnose(w.id);
        }
      });
      box.appendChild(chip);
    });
  }

  function updateWatchBtn() {
    if (!current) return;
    const inList = watch.some((w) => w.id === current.stock.id);
    $("watchBtn").textContent = inList ? "★ 已在自選" : "☆ 加入自選";
  }

  $("watchBtn").addEventListener("click", () => {
    if (!current) return;
    const id = current.stock.id;
    if (watch.some((w) => w.id === id)) watch = watch.filter((w) => w.id !== id);
    else watch.push(entryOf(current));
    saveWatch(watch); renderWatch(); updateWatchBtn();
  });

  // 依序重新診斷自選股（一次一檔，避免 FinMind 查詢次數一下子用完）
  const updating = new Set();
  let refreshing = false;
  async function refreshWatch(onlyStale) {
    if (refreshing) return;
    const ids = watch.filter((w) => !onlyStale || isStale(w)).map((w) => w.id);
    if (!ids.length) return;
    refreshing = true;
    const btn = $("refreshAll");
    btn.disabled = true;
    for (let i = 0; i < ids.length; i++) {
      if (!watch.some((w) => w.id === ids[i])) continue;      // 途中被移除
      btn.textContent = "更新中 " + (i + 1) + "/" + ids.length;
      updating.add(ids[i]); renderWatch();
      try {
        const r = await FinMind.diagnose(ids[i], !onlyStale);
        upsertWatch(r);
      } catch (e) {
        updating.delete(ids[i]); renderWatch();
        if (/次數已用完/.test(e.message)) break;                // 額度用完就停，下次開啟再繼續
        continue;
      }
      updating.delete(ids[i]); renderWatch();
    }
    updating.clear(); renderWatch();
    btn.textContent = "全部更新"; btn.disabled = false;
    refreshing = false;
  }
  $("refreshAll").addEventListener("click", () => (market === "fund" ? refreshFundWatch(false) : refreshWatch(false)));

  // ---------------- 搜尋與自動完成 ----------------
  const input = $("q");
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) return hideSuggest();
    searchTimer = setTimeout(async () => {
      try {
        const list = market === "fund"
          ? (await Funds.search(q, 12)).map((f) => ({ id: f.id, fund: true, label: f.kind + " " + f.currency,
            name: f.name, industry: f.company.replace(/證券投資信託股份有限公司|投信$/, "") }))
          : await FinMind.search(q, 12, market);
        if (input.value.trim() === q) showSuggest(list);
      } catch (e) { hideSuggest(); }
    }, 150);
  });
  input.addEventListener("keydown", (e) => {
    if (e.key === "ArrowDown" || e.key === "ArrowUp") {
      if (!suggestItems.length) return;
      e.preventDefault();
      suggestIndex = (suggestIndex + (e.key === "ArrowDown" ? 1 : -1) + suggestItems.length) % suggestItems.length;
      paintSuggest();
    } else if (e.key === "Enter") {
      e.preventDefault(); submit();
    } else if (e.key === "Escape") {
      hideSuggest();
    }
  });
  $("go").addEventListener("click", submit);
  document.addEventListener("click", (e) => { if (!e.target.closest(".search")) hideSuggest(); });

  function submit() {
    const q = input.value.trim();
    if (!q) return;
    if (suggestIndex >= 0 && suggestItems[suggestIndex]) return pick(suggestItems[suggestIndex]);
    if (market === "fund") { if (suggestItems.length) pick(suggestItems[0]); return; }
    if (/^[0-9A-Za-z]+([.-][A-Za-z])?$/.test(q)) return pick({ id: q.toUpperCase().replace(".", "-") });
    if (suggestItems.length) return pick(suggestItems[0]);
  }
  function pick(s) {
    hideSuggest();
    if (s.fund) { input.value = s.name; input.blur(); return openFund(s.id); }
    input.value = s.name ? s.id + " " + s.name : s.id;
    input.blur();
    diagnose(s.id);
  }
  function showSuggest(list) {
    suggestItems = Array.isArray(list) ? list : [];
    suggestIndex = -1;
    paintSuggest();
  }
  function paintSuggest() {
    const ul = $("suggest");
    if (!suggestItems.length) return hideSuggest();
    ul.innerHTML = suggestItems.map((s, i) =>
      '<li data-i="' + i + '" class="' + (i === suggestIndex ? "on" : "") + (s.fund ? " fund" : "") + '"><b>' + esc(s.label || s.id) +
      "</b><span>" + esc(s.name) + "</span><small>" + esc(s.industry || "") + "</small></li>").join("");
    ul.hidden = false;
    ul.querySelectorAll("li").forEach((li) =>
      li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(suggestItems[+li.dataset.i]); }));
  }
  function hideSuggest() { $("suggest").hidden = true; suggestItems = []; suggestIndex = -1; }

  // ---------------- 診斷 ----------------
  async function diagnose(id, refresh) {
    setMarket(Scoring.isUS(id) ? "us" : "tw", true);   // 從自選股或網址進來時，切換鍵跟著跳到對的市場
    show("loading");
    $("loadingText").textContent = refresh
      ? "重新向 FinMind 抓取 " + id + " …"
      : "診斷 " + id + " 中…正在向 FinMind 抓" + (Scoring.isUS(id) ? "美股股價" : Scoring.isEtf(id) ? " ETF 股價" : " 5 份資料");
    try {
      const r = await FinMind.diagnose(id, refresh);
      current = r;
      render(r);
      upsertWatch(r);
      renderWatch();
      history.replaceState(null, "", "#" + r.stock.id);
    } catch (e) {
      show("error");
      $("error").textContent = e.message;
    }
  }
  $("refreshBtn").addEventListener("click", () => current && diagnose(current.stock.id, true));

  function render(r) {
    show("result");
    const L = r.overall.light;
    setLamp($("heroLamp"), L);
    $("stockName").textContent = r.stock.name || r.stock.id;
    $("stockName").title = r.stock.en || "";
    // 美股英文名稱可能很長：字小一點、最多兩行
    $("stockName").classList.toggle("long", (r.stock.name || "").length > 14);
    $("stockCode").textContent = r.stock.id;
    const tag = $("etfTag"), t = r.etf_type;
    tag.hidden = !t;
    if (t) { tag.textContent = t.label; tag.className = "etf-tag f-" + t.family; }
    $("close").innerHTML = (r.market === "US" ? '<small class="cur">US$</small>' : "") + fmt(r.price.close);
    const chg = $("change");
    if (r.price.change != null) {
      const up = r.price.change > 0, down = r.price.change < 0;
      chg.className = "chg " + (up ? "up" : down ? "down" : "");
      chg.textContent = (up ? "▲ " : down ? "▼ " : "") + fmt(Math.abs(r.price.change)) +
        (r.price.change_pct != null ? "（" + (r.price.change_pct * 100).toFixed(2) + "%）" : "");
    } else chg.textContent = "";
    const v = $("verdict");
    v.className = "verdict " + L;
    v.textContent = LIGHT_NAME[L] + "｜" + r.overall.verdict;
    $("meta").textContent = "資料日 " + r.as_of + " · " +
      (r.cached ? "快取（" + r.fetched_at + " 抓取）" : "剛抓取 " + r.fetched_at) +
      (r.market === "US" ? " · 美股收盤價（台灣早上 8 點更新）：只看投資面"
        : r.etf ? " · ETF：只看投資面" : " · 健康 " + pct(r.weights.health) + " ＋ 投資 " + pct(r.weights.invest));

    // 分數環
    const ring = $("ring");
    ring.className = "score-ring " + L;
    $("overallScore").textContent = r.overall.score != null ? Math.round(r.overall.score) : "–";
    const C = 2 * Math.PI * 52;
    $("arc").style.strokeDashoffset = C * (1 - Math.max(0, Math.min(100, r.overall.score || 0)) / 100);

    $("dimMini").innerHTML = r.dimensions.map((d) =>
      '<span><i class="dot ' + d.light + '"></i>' + d.name + " <b>" +
      (d.excluded ? "不計分" : d.score != null ? Math.round(d.score) : "–") + "</b></span>").join("");

    // 左欄：兩個面向的燈號（電腦單一畫面版面使用）
    $("dimLamps").innerHTML = r.dimensions.map((d) =>
      '<div class="dim-lamp ' + d.light + '">' + lampHTML(d.light) +
      '<div class="dl-text"><b>' + d.name + "</b><small>" + d.sub + "</small></div>" +
      '<div class="dl-score">' + (d.excluded ? '<span class="na">不計分</span>' : (d.score != null ? Math.round(d.score) : "–") + "<small>分</small>") + "</div></div>").join("");

    // 兩個面向
    $("dims").innerHTML = r.dimensions.map(renderDim).join("");
    renderChart(r.chart);
    $("warnings").innerHTML = (r.warnings || []).map((w) => "<li>" + esc(w) + "</li>").join("");
    updateWatchBtn();
  }

  function renderDim(d) {
    return '<div class="card dim">' +
      '<div class="dim-head">' + lampHTML(d.light) +
      "<div><h3>" + d.name + "</h3><small>" + d.sub + "</small></div>" +
      '<div class="sc">' + (d.excluded ? '<span class="na">不計分</span>' : (d.score != null ? Math.round(d.score) : "–") + "<small>分</small>") + "</div></div>" +
      (d.excluded ? '<p class="dim-na">' + esc(d.note) + "</p>" : d.items.map(renderItem).join("")) + "</div>";
  }

  function renderItem(it) {
    const ladder = it.bands.map((b, i) =>
      '<div class="seg' + (i === it.active ? " on " + it.light : "") + '">' + esc(b.label) +
      "<i>" + b.score + "</i></div>").join("");
    const sub = [it.detail, it.note ? '<span class="note">' + esc(it.note) + "</span>" : ""]
      .filter(Boolean).map((s, i) => i === 0 && it.detail ? esc(s) : s).join(" · ");
    return '<div class="item">' +
      '<div class="item-top"><span class="dot ' + it.light + '"></span>' +
      '<span class="item-name">' + esc(it.name) + "</span>" +
      '<span class="item-val">' + esc(it.value_text) + "</span>" +
      '<span class="item-score ' + it.light + '">' + (it.score != null ? Math.round(it.score) : "–") + "</span></div>" +
      (sub ? '<div class="item-sub">' + sub + "</div>" : "") +
      '<div class="ladder">' + ladder + "</div></div>";
  }

  function lampHTML(light) {
    return '<div class="lamp-house lit-' + light + '"><i class="lamp red"></i><i class="lamp yellow"></i><i class="lamp green"></i></div>';
  }
  function setLamp(el, light) {
    el.className = "lamp-house big lit-" + light;
  }

  // ---------------- 走勢圖（純 SVG，不依賴外部函式庫） ----------------
  const FIT_QUERY = "(min-width: 1100px) and (min-height: 620px)";
  const SERIES = [
    ["close", "收盤", "--c-close", 2],
    ["MA20", "MA20", "--c-ma20", 1.4],
    ["MA60", "MA60", "--c-ma60", 1.4],
    ["MA240", "MA240", "--c-ma240", 1.4],
  ];

  // opts：box / legend 是元素 id，series 是要畫的線；基金頁共用同一支
  function renderChart(c, opts) {
    const o = Object.assign({ box: "chart", legend: "legend", series: SERIES, fit: true }, opts || {});
    const SERIES_ = o.series;
    const box = $(o.box);
    // 依實際寬度繪製（不縮放），手機上文字才不會被壓扁
    const W = Math.max(280, Math.round(box.clientWidth || 1000));
    // 電腦單一畫面版面：圖表高度跟著剩下的空間走；其他情況維持固定高度
    const fitH = o.fit && document.body.classList.contains("has-result") && matchMedia(FIT_QUERY).matches
      ? Math.max(80, Math.round(box.clientHeight)) : 0;
    const H = fitH || (W < 600 ? 220 : 300), padL = 4, padR = 52, padT = 12, padB = 26;
    const n = c.dates.length;
    if (n < 2) { box.innerHTML = ""; return; }
    let lo = Infinity, hi = -Infinity;
    SERIES_.forEach(([k]) => c[k].forEach((v) => { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
    const span = hi - lo || 1; lo -= span * 0.05; hi += span * 0.05;
    const x = (i) => padL + (i / (n - 1)) * (W - padL - padR);
    const y = (v) => padT + (1 - (v - lo) / (hi - lo)) * (H - padT - padB);

    let svg = '<svg viewBox="0 0 ' + W + " " + H + '" width="' + W + '" height="' + H + '">';
    for (let g = 0; g <= 4; g++) {
      const val = lo + (hi - lo) * (g / 4), yy = y(val);
      svg += '<line class="grid" x1="' + padL + '" x2="' + (W - padR) + '" y1="' + yy + '" y2="' + yy + '"/>' +
        '<text class="axis" x="' + (W - padR + 6) + '" y="' + (yy + 4) + '">' + fmt(val) + "</text>";
    }
    let lastMonth = "", monthCount = 0;
    const every = W < 600 ? 2 : 1;   // 手機上隔月標示
    // 期間超過兩年半（例如基金五年走勢）就只標年份，不然月份會擠成一團
    const spanD = c.dates.length > 1 ? (Date.parse(c.dates[c.dates.length - 1]) - Date.parse(c.dates[0])) / 864e5 : 0;
    const yearsOnly = spanD > 900;                       // 兩年半以上：只標年份
    const quarterly = !yearsOnly && spanD > 450;         // 一年多到兩年半：每季標一次（年份、4月、7月、10月）
    c.dates.forEach((d, i) => {
      const m = d.slice(0, 7);
      if (m !== lastMonth) {
        const show = yearsOnly ? m.endsWith("-01") : quarterly ? /-(01|04|07|10)$/.test(m) : (monthCount++ % every === 0);
        if (lastMonth && i < n - 8 && show) {
          svg += '<text class="axis" x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle">' +
            (m.endsWith("-01") ? m.slice(0, 4) : +m.slice(5) + "月") + "</text>";
        }
        lastMonth = m;
      }
    });
    SERIES_.slice().reverse().forEach(([k, , color, w]) => {
      let d = "", pen = false;
      c[k].forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1);
        pen = true;
      });
      svg += '<path d="' + d + '" fill="none" stroke="var(' + color + ')" stroke-width="' + w +
        '" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>';
    });
    svg += '<line class="cross" y1="' + padT + '" y2="' + (H - padB) + '" visibility="hidden" vector-effect="non-scaling-stroke"/>';
    svg += '<rect x="0" y="0" width="' + W + '" height="' + H + '" fill="transparent"/></svg>';
    box.innerHTML = svg + '<div class="tip" hidden></div>';

    $(o.legend).innerHTML = SERIES_.map(([, label, color]) =>
      '<span><i style="background:var(' + color + ')"></i>' + label + "</span>").join("");

    const svgEl = box.querySelector("svg"), cross = box.querySelector(".cross"), tip = box.querySelector(".tip");
    const move = (clientX) => {
      const rect = svgEl.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - padL) / (W - padL - padR)) * (n - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
      cross.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.innerHTML = "<b>" + c.dates[i] + "</b>" + SERIES_.map(([k, label]) =>
        "<span>" + label + "<em>" + (c[k][i] != null ? fmt(c[k][i]) : "–") + "</em></span>").join("");
      const left = (x(i) / W) * rect.width;
      tip.style.left = (left > rect.width / 2 ? left - tip.offsetWidth - 12 : left + 12) + "px";
    };
    const leave = () => { cross.setAttribute("visibility", "hidden"); tip.hidden = true; };
    svgEl.addEventListener("mousemove", (e) => move(e.clientX));
    svgEl.addEventListener("touchmove", (e) => move(e.touches[0].clientX), { passive: true });
    svgEl.addEventListener("mouseleave", leave);
    svgEl.addEventListener("touchend", leave);
  }

  let resizeTimer = null;
  window.addEventListener("resize", () => {
    clearTimeout(resizeTimer);
    resizeTimer = setTimeout(() => {
      if (current && !$("result").hidden) renderChart(current.chart);
      if (currentFund && !$("fundResult").hidden) renderFundChart(currentFund);
    }, 150);
  });

  // ---------------- 基金 ----------------
  let currentFund = null;
  let fundWatch = (() => { try { return JSON.parse(localStorage.getItem(FUND_WATCH_KEY)) || []; } catch (e) { return []; } })();
  const saveFundWatch = () => { try { localStorage.setItem(FUND_WATCH_KEY, JSON.stringify(fundWatch)); } catch (e) { /* ignore */ } };
  const fmtNav = (v) => (v == null || isNaN(v) ? "–" : v.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: v >= 1000 ? 2 : 4 }));
  const fmtPctS = (x, d) => (x > 0 ? "+" : "") + (x * 100).toFixed(d == null ? 2 : d) + "%";
  const curName = (c) => CUR_NAME[c] || c || "";
  const shortName = (n) => (n.length > 16 ? n.slice(0, 15) + "…" : n);

  async function openFund(id, refresh) {
    setMarket("fund", true);
    show("loading");
    $("loadingText").textContent = "讀取基金淨值…";
    try {
      const idx = await Funds.loadIndex(refresh);
      const f = idx.byId.get(id);
      if (!f) throw new Error("找不到這檔基金（" + id + "）：可能已清算、合併或改名");
      const [h, divs] = await Promise.all([Funds.history(id), Funds.dividends(id)]);
      if (!h.length) throw new Error("這檔基金還沒有淨值資料");
      currentFund = { f, h, divs, s: Funds.stats(h, divs), updated: idx.updated };
      renderFund(currentFund);
      upsertFundWatch(currentFund);
      renderWatch();
      history.replaceState(null, "", "#fund/" + id);
    } catch (e) {
      show("error");
      $("error").textContent = e.message;
    }
  }
  $("fRefreshBtn").addEventListener("click", () => currentFund && openFund(currentFund.f.id, true));

  function renderFund(cf) {
    const { f, s } = cf;
    show("fundResult");
    const kind = $("fKind");
    const acct = f.kind === "類全委";          // 保險公司類全委帳戶：用「撥回」不用「配息」
    const term = acct ? "撥回" : "配息";
    kind.textContent = acct ? "類全委帳戶" : f.kind + "基金";
    kind.className = "etf-tag " + (f.kind === "境外" ? "f-bond" : acct ? "f-acct" : "");
    $("fCur").textContent = curName(f.currency) + (f.currency && CUR_NAME[f.currency] ? " " + f.currency : "");
    $("fName").textContent = f.name;
    $("fName").classList.toggle("long", f.name.length > 18);
    $("fCo").textContent = [f.company, f.isin && "ISIN " + f.isin, f.ticker && (acct ? "帳戶代碼 " : "代號 ") + f.ticker,
      acct && "資料來源：" + f.org + "官網"].filter(Boolean).join(" · ");
    $("fNav").innerHTML = '<small class="cur">' + esc(f.currency) + "</small>" + fmtNav(s.nav);
    const chg = $("fChg");
    if (s.change != null) {
      const up = s.change > 0, down = s.change < 0;
      chg.className = "chg " + (up ? "up" : down ? "down" : "");
      chg.textContent = (up ? "▲ " : down ? "▼ " : "") + fmtNav(Math.abs(s.change)) + "（" + fmtPctS(s.change_pct) + "）";
    } else { chg.className = "chg"; chg.textContent = "前一日淨值累積中"; }
    const late = (Date.now() - Date.parse(s.date)) / 86400000 > 4;
    $("fMeta").textContent = "淨值日 " + s.date + " · 已收集 " + s.count + " 筆淨值（自 " + s.since + " 起）" +
      (late && f.kind === "境外" ? " · 境外基金淨值由總代理申報，約晚 2–5 天公布" : "");

    // 有配息紀錄：大字是含息報酬（配息再投入），小字是只看淨值的報酬
    const hasDiv = !!s.tr;
    $("fRetsNote").textContent = hasDiv ? "大字＝含" + term + "報酬（" + term + "再投入），小字＝淨值報酬" : "以淨值計算（未收到" + term + "紀錄）";
    $("fRets").innerHTML = s.periods.map((p) => {
      const v = hasDiv ? p.total : p.value;
      const cls = v == null ? "na" : v > 0 ? "up" : v < 0 ? "down" : "";
      const sub = hasDiv && p.value != null
        ? '<em class="' + (p.value > 0 ? "up" : p.value < 0 ? "down" : "") + '">淨值 ' + fmtPctS(p.value) + "</em>" : "";
      return '<div class="ret ' + cls + '"><small>' + p.label + (hasDiv && v != null ? (acct ? " 含撥回" : " 含息") : "") + "</small><b>" +
        (v == null ? "資料不足" : fmtPctS(v)) + "</b>" + sub + "</div>";
    }).join("") + '<div class="ret ' + (s.vol == null ? "na" : "") + '"><small>年化波動度</small><b>' +
      (s.vol == null ? "資料不足" : (s.vol * 100).toFixed(1) + "%") + "</b></div>";

    const dv = s.div;
    const firstNav = cf.h[0][0];
    $("fDiv").hidden = !dv;
    if (dv) {
      const gap = dv.since > firstNav && (Date.parse(dv.since) - Date.parse(firstNav)) / 864e5 > 45;
      const freq = acct && dv.count > 12 ? "每月" + (dv.count >= 20 ? "多次" : "") : dv.freq;
      $("fDiv").innerHTML = '<div class="fd-head"><b>' + (acct ? "資產撥回" : "配息") + "</b><span>" + freq + "</span></div>" +
        '<div class="fd-grid">' +
        "<div><small>近一年" + term + "</small><b>" + dv.count + " 次 · " + esc(f.currency) + " " + fmtNav(dv.sum) + "</b></div>" +
        "<div><small>年化" + term + "率</small><b>" + (dv.count ? (dv.yield * 100).toFixed(1) + "%" : "–") + "</b></div>" +
        "<div><small>最近一次</small><b>" + dv.last[0] + " · " + fmtNav(dv.last[1]) + "</b></div></div>" +
        "<p>年化" + term + "率＝近一年" + term + "合計 ÷ 最新淨值；" + term + "可能來自本金，" + term + "率高不等於賺得多，請搭配含" +
        (acct ? "撥回" : "息") + "報酬一起看。" +
        (gap ? "已收錄的" + term + "紀錄自 " + dv.since + " 起，在那之前的含" + (acct ? "撥回" : "息") + "報酬可能略為低估。" : "") + "</p>";
    }

    const pct = Math.min(100, Math.round((s.span / 365) * 100));
    const enough = s.span >= 365;
    $("fLamp").innerHTML = '<div class="fl-head"><b>燈號評分</b><span>' + (enough ? "評分規則訂定中" : "資料累積中") + "</span></div>" +
      '<div class="fl-bar"><i style="width:' + Math.max(2, pct) + '%"></i></div>' +
      "<p>" + (enough
        ? "已有 " + s.span + " 天（約 " + (s.span / 365).toFixed(1) + " 年）的淨值，資料已足夠。基金燈號的評分規則訂好後就會在這裡亮燈。"
        : "已累積 " + s.span + " 天的淨值。滿 3 個月可看近期報酬與波動，滿 1 年後再依走勢、報酬與波動給燈號。") + "</p>";

    renderFundChart(cf);
    updateFundWatchBtn();
  }

  const FUND_SERIES = [["close", "淨值", "--c-close", 2], ["MA20", "20日均", "--c-ma20", 1.4]];
  const TR_SERIES = ["tr", "含息走勢", "--c-ma60", 1.8];
  // 走勢圖期間：1 年／3 年／5 年，只列出資料夠長的選項；記住上次選擇
  const FUND_RANGES = [["1 年", 365], ["3 年", 1095], ["5 年", 1826]];
  let fundRange = (() => { try { return +localStorage.getItem("eastone.fundRange.v1") || 1826; } catch (e) { return 1826; } })();
  function renderFundChart(cf) {
    const h = cf.h, n = h.length;
    const navs = h.map((p) => p[1]);
    const ma = navs.map((_, i) => (i >= 19 ? navs.slice(i - 19, i + 1).reduce((a, b) => a + b, 0) / 20 : null));
    const spanDays = n > 1 ? (Date.parse(h[n - 1][0]) - Date.parse(h[0][0])) / 864e5 : 0;
    // 只顯示「資料比上一檔期間長」的按鈕，例如只有 2 年資料就顯示 1 年、3 年（＝全部）
    const opts = FUND_RANGES.filter(([, d], i) => i === 0 || spanDays > FUND_RANGES[i - 1][1] + 20);
    const days = opts.some(([, d]) => d === fundRange) ? fundRange : opts[opts.length - 1][1];
    $("fRange").innerHTML = opts.length > 1 ? opts.map(([label, d]) =>
      '<button type="button" class="' + (d === days ? "on" : "") + '" data-d="' + d + '">' +
      (d >= spanDays - 20 && d === opts[opts.length - 1][1] && spanDays < d - 20 ? "全部" : label) + "</button>").join("") : "";
    $("fRange").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      fundRange = +b.dataset.d;
      try { localStorage.setItem("eastone.fundRange.v1", fundRange); } catch (e) { /* ignore */ }
      renderFundChart(cf);
    }));
    const cut = Date.parse(h[n - 1][0]) - days * 864e5;
    let from = 0;
    while (from < n - 1 && Date.parse(h[from][0]) < cut) from++;
    const c = { dates: h.slice(from).map((p) => p[0]), close: navs.slice(from), MA20: ma.slice(from) };
    let series = n >= 20 ? FUND_SERIES : FUND_SERIES.slice(0, 1);
    // 含息走勢：從圖的起點跟淨值同一個位置出發，之後差距就是配息再投入累積出來的
    if (cf.s.tr) {
      const base = cf.s.tr[from], start = navs[from];
      c.tr = cf.s.tr.slice(from).map((v) => (v / base) * start);
      series = series.concat([TR_SERIES]);
    }
    if (n >= 2) renderChart(c, { box: "fChart", legend: "fLegend", series, fit: false });
    else { $("fChart").innerHTML = ""; $("fLegend").innerHTML = ""; }
    $("fChartNote").textContent = n < 20
      ? "目前有 " + n + " 筆淨值（" + h[0][0] + " ～ " + h[n - 1][0] + "），走勢圖會隨每天收集慢慢變完整。"
      : c.dates.length + " 筆淨值（" + c.dates[0] + " ～ " + c.dates[c.dates.length - 1] + "）";
  }

  // ---- 自選基金（和股票分開存）----
  function fundEntry(cf) {
    return { id: cf.f.id, name: cf.f.name, cur: cf.f.currency, nav: cf.s.nav, pct: cf.s.change_pct, date: cf.s.date };
  }
  function upsertFundWatch(cf) {
    const i = fundWatch.findIndex((w) => w.id === cf.f.id);
    if (i >= 0) { fundWatch[i] = fundEntry(cf); saveFundWatch(); }
  }
  function updateFundWatchBtn() {
    if (!currentFund) return;
    $("fWatchBtn").textContent = fundWatch.some((w) => w.id === currentFund.f.id) ? "★ 已在自選" : "☆ 加入自選";
  }
  $("fWatchBtn").addEventListener("click", () => {
    if (!currentFund) return;
    const id = currentFund.f.id;
    if (fundWatch.some((w) => w.id === id)) fundWatch = fundWatch.filter((w) => w.id !== id);
    else fundWatch.push(fundEntry(currentFund));
    saveFundWatch(); renderWatch(); updateFundWatchBtn();
  });

  function renderFundWatch() {
    const box = $("chips");
    box.innerHTML = "";
    $("refreshAll").hidden = fundWatch.length === 0;
    if (!fundWatch.length) {
      box.innerHTML = '<span class="hint">看基金時按「加入自選」，下次一眼看完全部淨值</span>';
      return;
    }
    fundWatch.forEach((w) => {
      const chip = document.createElement("span");
      chip.className = "chip fund-chip" + (currentFund && currentFund.f.id === w.id ? " active" : "");
      chip.title = w.name + (w.date ? "（淨值日 " + w.date + "）" : "");
      const cls = w.pct > 0 ? "up" : w.pct < 0 ? "down" : "";
      chip.innerHTML = "<span>" + esc(shortName(w.name)) + "</span>" +
        '<span class="s">' + fmtNav(w.nav) + "</span>" +
        (w.pct != null ? '<span class="chg ' + cls + '">' + fmtPctS(w.pct) + "</span>" : "") +
        '<button class="x" title="移除" type="button">×</button>';
      chip.addEventListener("click", (e) => {
        if (e.target.classList.contains("x")) {
          fundWatch = fundWatch.filter((x) => x.id !== w.id);
          saveFundWatch(); renderWatch(); updateFundWatchBtn();
        } else {
          input.value = w.name; openFund(w.id);
        }
      });
      box.appendChild(chip);
    });
  }

  // 進入基金頁時更新一次自選基金的最新淨值（onlyOnce：同一次開啟只做一次）
  let fundWatchRefreshed = false;
  async function refreshFundWatch(onlyOnce) {
    if (onlyOnce && fundWatchRefreshed) return;
    fundWatchRefreshed = true;
    if (!fundWatch.length) return;
    const btn = $("refreshAll");
    btn.disabled = true; btn.textContent = "更新中…";
    try {
      const idx = await Funds.loadIndex(!onlyOnce);
      await Promise.all(fundWatch.map(async (w, i) => {
        const f = idx.byId.get(w.id);
        if (!f) return;
        try { const h = await Funds.history(w.id); fundWatch[i] = fundEntry({ f, s: Funds.stats(h) }); } catch (e) { /* 單檔失敗不影響 */ }
      }));
      saveFundWatch();
    } catch (e) { /* 清單讀不到就下次再試 */ }
    btn.disabled = false; btn.textContent = "全部更新";
    if (market === "fund") renderWatch();
  }

  // ---------------- 工具 ----------------
  function show(which) {
    ["empty", "loading", "error", "result", "fund", "fundResult"].forEach((k) => { $(k).hidden = k !== which; });
    document.body.classList.toggle("has-result", which === "result");
  }
  function fmt(v) {
    if (v == null || isNaN(v)) return "–";
    return v >= 1000 ? v.toLocaleString("zh-TW", { maximumFractionDigits: 0 })
      : v.toLocaleString("zh-TW", { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  }
  function pct(w) { return Math.round(w * 100) + "%"; }
  function esc(s) {
    return String(s == null ? "" : s).replace(/[&<>"']/g, (ch) =>
      ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[ch]));
  }

  // ---------------- FinMind 金鑰 ----------------
  const dlg = $("tokenDlg");
  function paintTokenBtn() {
    const has = !!FinMind.getToken();
    $("tokenBtn").classList.toggle("set", has);
    $("tokenBtn").title = has ? "已設定 FinMind 金鑰" : "未設定金鑰（匿名查詢）";
  }
  $("tokenBtn").addEventListener("click", () => {
    $("tokenInput").value = FinMind.getToken();
    if (dlg.showModal) dlg.showModal(); else dlg.setAttribute("open", "");
  });
  dlg.addEventListener("close", () => {
    if (dlg.returnValue === "save") FinMind.setToken($("tokenInput").value);
    if (dlg.returnValue === "clear") FinMind.setToken("");
    paintTokenBtn();
  });
  paintTokenBtn();

  // ---------------- 安裝成 APP ----------------
  const standalone = window.matchMedia("(display-mode: standalone)").matches || navigator.standalone === true;
  const isIOS = /iPad|iPhone|iPod/.test(navigator.userAgent) ||
    (navigator.platform === "MacIntel" && navigator.maxTouchPoints > 1);   // iPadOS 偽裝成 Mac
  let installEvt = null;

  if (!standalone) {
    // Android / 桌面 Chrome、Edge：瀏覽器判定可安裝時才出現按鈕
    window.addEventListener("beforeinstallprompt", (e) => {
      e.preventDefault();
      installEvt = e;
      $("installBtn").hidden = false;
    });
    // iPhone / iPad：Safari 沒有安裝 API，改成教學步驟
    if (isIOS) $("installBtn").hidden = false;
  }
  $("installBtn").addEventListener("click", async () => {
    if (installEvt) {
      installEvt.prompt();
      const { outcome } = await installEvt.userChoice;
      if (outcome === "accepted") $("installBtn").hidden = true;
      installEvt = null;
    } else if (isIOS) {
      const d = $("iosDlg");
      if (d.showModal) d.showModal(); else d.setAttribute("open", "");
    }
  });
  window.addEventListener("appinstalled", () => { $("installBtn").hidden = true; });

  if ("serviceWorker" in navigator && (location.protocol === "https:" || /^(localhost|127\.0\.0\.1)$/.test(location.hostname))) {
    navigator.serviceWorker.register("sw.js").catch(() => { /* 沒有也能用 */ });
  }

  // ---------------- 台股／美股／基金切換 ----------------
  let market = "tw";
  try { market = localStorage.getItem(MARKET_KEY) || "tw"; } catch (e) { /* ignore */ }
  if (!QUICK[market] && market !== "fund") market = "tw";

  function paintQuick() {
    $("quick").innerHTML = (QUICK[market] || []).map(([id, name]) =>
      '<button class="ghost" type="button" data-id="' + id + '">' + id + " " + name + "</button>").join("");
    $("quick").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
      input.value = b.textContent; diagnose(b.dataset.id);
    }));
  }
  // quiet：診斷時自動跟著切，不改變目前畫面
  function setMarket(m, quiet) {
    const changed = m !== market;
    market = m;
    try { localStorage.setItem(MARKET_KEY, m); } catch (e) { /* ignore */ }
    $("marketTabs").querySelectorAll("button").forEach((b) => {
      b.classList.toggle("on", b.dataset.m === m);
      b.setAttribute("aria-pressed", b.dataset.m === m);
    });
    const t = MARKET_TEXT[m];
    if (t) {
      input.placeholder = t.ph;
      $("emptyTitle").textContent = t.title;
      $("emptyText").innerHTML = t.text;
      paintQuick();
    }
    if (m === "fund") input.placeholder = MARKET_TEXT.fund.ph;
    $("watchLabel").textContent = m === "fund" ? "自選基金" : "自選股";
    $("go").textContent = m === "fund" ? "查詢" : "診斷";
    renderWatch();
    if (quiet) return;
    hideSuggest();
    if (changed) { input.value = ""; }
    if (m === "fund") {
      if (currentFund) { show("fundResult"); history.replaceState(null, "", "#fund/" + currentFund.f.id); }
      else { show("fund"); if (location.hash) history.replaceState(null, "", location.pathname); }
      Funds.loadIndex().catch(() => { /* 搜尋時會再試 */ });
      refreshFundWatch(true);
      return;
    }
    // 目前顯示的股票屬於這個市場就留著，否則回到起始畫面
    if (current && (current.market === "US") === (m === "us")) { show("result"); history.replaceState(null, "", "#" + current.stock.id); }
    else { show("empty"); if (location.hash) history.replaceState(null, "", location.pathname); }
    if (m === "us") FinMind.loadUSList().catch(() => { /* 搜尋時會再試 */ });
  }
  $("marketTabs").querySelectorAll("button").forEach((b) =>
    b.addEventListener("click", () => setMarket(b.dataset.m)));

  // ---------------- 啟動 ----------------
  FinMind.loadStockList().catch(() => { /* 搜尋時會再試 */ });
  $("fundQuick").innerHTML = FUND_QUICK.map(([id, name]) =>
    '<button class="ghost" type="button" data-id="' + id + '">' + name + "</button>").join("");
  $("fundQuick").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    input.value = b.textContent; openFund(b.dataset.id);
  }));
  setMarket(market, true);
  if (market === "fund") { show("fund"); Funds.loadIndex().catch(() => {}); refreshFundWatch(true); }
  else if (market === "us") FinMind.loadUSList().catch(() => { /* 搜尋時會再試 */ });
  renderWatch();
  // 自選股裡用舊算法算的分數，開啟後自動在背景重算（不必一檔一檔點）
  setTimeout(() => refreshWatch(true), 1500);
  function fromHash() {
    const id = decodeURIComponent(location.hash.slice(1)).trim();
    if (/^fund\//.test(id)) {
      const fid = id.slice(5);
      if (!currentFund || currentFund.f.id !== fid) { setMarket("fund", true); openFund(fid); }
      return;
    }
    if (id && (!current || current.stock.id !== id)) { input.value = id; diagnose(id); }
  }
  window.addEventListener("hashchange", fromHash);
  fromHash();
})();
