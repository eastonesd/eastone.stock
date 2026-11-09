(function () {
  "use strict";

  const $ = (id) => document.getElementById(id);
  const LIGHT_NAME = { green: "綠燈", yellow: "黃燈", red: "紅燈", gray: "無資料" };
  const WATCH_KEY = "eastone.watchlist.v1";
  const QUICK = [["2330", "台積電"], ["2317", "鴻海"], ["2454", "聯發科"], ["2881", "富邦金"], ["0050", "元大台灣50"]];

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

  function upsertWatch(r) {
    const i = watch.findIndex((w) => w.id === r.stock.id);
    if (i < 0) return;
    watch[i] = { id: r.stock.id, name: r.stock.name || watch[i].name, score: r.overall.score, light: r.overall.light };
    saveWatch(watch);
  }

  function renderWatch() {
    const box = $("chips");
    box.innerHTML = "";
    $("refreshAll").hidden = watch.length === 0;
    if (!watch.length) {
      box.innerHTML = '<span class="hint">診斷後按「加入自選」，下次一眼看完全部燈號</span>';
      return;
    }
    watch.forEach((w) => {
      const chip = document.createElement("span");
      chip.className = "chip" + (current && current.stock.id === w.id ? " active" : "");
      chip.innerHTML =
        '<span class="dot ' + (w.light || "gray") + '"></span>' +
        "<span>" + esc(w.name || w.id) + "</span>" +
        '<span class="s">' + (w.score != null ? Math.round(w.score) : "–") + "</span>" +
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
    else watch.push({ id, name: current.stock.name, score: current.overall.score, light: current.overall.light });
    saveWatch(watch); renderWatch(); updateWatchBtn();
  });

  $("refreshAll").addEventListener("click", async () => {
    const btn = $("refreshAll");
    btn.disabled = true;
    for (let i = 0; i < watch.length; i++) {
      btn.textContent = "更新中 " + (i + 1) + "/" + watch.length;
      try {
        const r = await FinMind.diagnose(watch[i].id);
        upsertWatch(r); renderWatch();
      } catch (e) { /* 單檔失敗不影響其他 */ }
    }
    btn.textContent = "全部更新"; btn.disabled = false;
  });

  // ---------------- 搜尋與自動完成 ----------------
  const input = $("q");
  input.addEventListener("input", () => {
    clearTimeout(searchTimer);
    const q = input.value.trim();
    if (!q) return hideSuggest();
    searchTimer = setTimeout(async () => {
      try {
        const list = await FinMind.search(q);
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
    if (/^[0-9A-Za-z]+$/.test(q)) return pick({ id: q.toUpperCase() });
    if (suggestItems.length) return pick(suggestItems[0]);
  }
  function pick(s) {
    hideSuggest();
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
      '<li data-i="' + i + '" class="' + (i === suggestIndex ? "on" : "") + '"><b>' + esc(s.id) +
      "</b><span>" + esc(s.name) + "</span><small>" + esc(s.industry || "") + "</small></li>").join("");
    ul.hidden = false;
    ul.querySelectorAll("li").forEach((li) =>
      li.addEventListener("mousedown", (e) => { e.preventDefault(); pick(suggestItems[+li.dataset.i]); }));
  }
  function hideSuggest() { $("suggest").hidden = true; suggestItems = []; suggestIndex = -1; }

  // ---------------- 診斷 ----------------
  async function diagnose(id, refresh) {
    show("loading");
    $("loadingText").textContent = refresh
      ? "重新向 FinMind 抓取 " + id + " …"
      : "診斷 " + id + " 中…正在向 FinMind 抓 5 份資料";
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
    $("stockCode").textContent = r.stock.id;
    $("close").textContent = fmt(r.price.close);
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
      (r.etf ? " · ETF：只看投資面" : " · 健康 " + pct(r.weights.health) + " ＋ 投資 " + pct(r.weights.invest));

    // 分數環
    const ring = $("ring");
    ring.className = "score-ring " + L;
    $("overallScore").textContent = r.overall.score != null ? Math.round(r.overall.score) : "–";
    const C = 2 * Math.PI * 52;
    $("arc").style.strokeDashoffset = C * (1 - Math.max(0, Math.min(100, r.overall.score || 0)) / 100);

    $("dimMini").innerHTML = r.dimensions.map((d) =>
      '<span><i class="dot ' + d.light + '"></i>' + d.name + " <b>" +
      (d.score != null ? Math.round(d.score) : "–") + "</b></span>").join("");

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

  function renderChart(c) {
    const box = $("chart");
    // 依實際寬度繪製（不縮放），手機上文字才不會被壓扁
    const W = Math.max(280, Math.round(box.clientWidth || 1000));
    // 電腦單一畫面版面：圖表高度跟著剩下的空間走；其他情況維持固定高度
    const fitH = document.body.classList.contains("has-result") && matchMedia(FIT_QUERY).matches
      ? Math.max(80, Math.round(box.clientHeight)) : 0;
    const H = fitH || (W < 600 ? 220 : 300), padL = 4, padR = 52, padT = 12, padB = 26;
    const n = c.dates.length;
    if (n < 2) { box.innerHTML = ""; return; }
    let lo = Infinity, hi = -Infinity;
    SERIES.forEach(([k]) => c[k].forEach((v) => { if (v != null) { lo = Math.min(lo, v); hi = Math.max(hi, v); } }));
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
    c.dates.forEach((d, i) => {
      const m = d.slice(0, 7);
      if (m !== lastMonth) {
        if (lastMonth && i < n - 8 && (monthCount++ % every === 0)) {
          svg += '<text class="axis" x="' + x(i) + '" y="' + (H - 6) + '" text-anchor="middle">' +
            (m.endsWith("-01") ? m.slice(0, 4) : +m.slice(5) + "月") + "</text>";
        }
        lastMonth = m;
      }
    });
    SERIES.slice().reverse().forEach(([k, , color, w]) => {
      let d = "", pen = false;
      c[k].forEach((v, i) => {
        if (v == null) { pen = false; return; }
        d += (pen ? "L" : "M") + x(i).toFixed(1) + " " + y(v).toFixed(1);
        pen = true;
      });
      svg += '<path d="' + d + '" fill="none" stroke="var(' + color + ')" stroke-width="' + w +
        '" vector-effect="non-scaling-stroke" stroke-linejoin="round"/>';
    });
    svg += '<line class="cross" id="cross" y1="' + padT + '" y2="' + (H - padB) + '" visibility="hidden" vector-effect="non-scaling-stroke"/>';
    svg += '<rect id="hit" x="0" y="0" width="' + W + '" height="' + H + '" fill="transparent"/></svg>';
    box.innerHTML = svg + '<div class="tip" id="tip" hidden></div>';

    $("legend").innerHTML = SERIES.map(([, label, color]) =>
      '<span><i style="background:var(' + color + ')"></i>' + label + "</span>").join("");

    const svgEl = box.querySelector("svg"), cross = $("cross"), tip = $("tip");
    const move = (clientX) => {
      const rect = svgEl.getBoundingClientRect();
      const px = ((clientX - rect.left) / rect.width) * W;
      const i = Math.max(0, Math.min(n - 1, Math.round(((px - padL) / (W - padL - padR)) * (n - 1))));
      cross.setAttribute("x1", x(i)); cross.setAttribute("x2", x(i));
      cross.setAttribute("visibility", "visible");
      tip.hidden = false;
      tip.innerHTML = "<b>" + c.dates[i] + "</b>" + SERIES.map(([k, label]) =>
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
    resizeTimer = setTimeout(() => { if (current && !$("result").hidden) renderChart(current.chart); }, 150);
  });

  // ---------------- 工具 ----------------
  function show(which) {
    ["empty", "loading", "error", "result"].forEach((k) => { $(k).hidden = k !== which; });
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

  // ---------------- 啟動 ----------------
  FinMind.loadStockList().catch(() => { /* 搜尋時會再試 */ });
  $("quick").innerHTML = QUICK.map(([id, name]) =>
    '<button class="ghost" type="button" data-id="' + id + '">' + id + " " + name + "</button>").join("");
  $("quick").querySelectorAll("button").forEach((b) => b.addEventListener("click", () => {
    input.value = b.textContent; diagnose(b.dataset.id);
  }));
  renderWatch();
  function fromHash() {
    const id = decodeURIComponent(location.hash.slice(1)).trim();
    if (id && (!current || current.stock.id !== id)) { input.value = id; diagnose(id); }
  }
  window.addEventListener("hashchange", fromHash);
  fromHash();
})();
