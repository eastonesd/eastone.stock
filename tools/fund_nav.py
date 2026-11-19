"""
東石診股 - 基金淨值每日收集
================================
資料來源（皆為政府資料開放授權、免費）：
  境內基金：投信投顧公會「證券投資信託基金每日淨值」  https://data.gov.tw/dataset/11109
  境外基金：集保結算所「境外基金淨值」（OpenAPI 3-4）  https://data.gov.tw/dataset/11641

兩個來源都只提供最近幾天的淨值、沒有歷史，所以由 GitHub Actions 每天跑這支程式，
把新的淨值「累積」進 data/funds/nav/<基金ID>.csv，歷史就從開始收集的那天一天天長出來。

保險公司類全委帳戶（不是公開基金，淨值只在保險公司官網公布）：
  清單在 tools/insurer_accounts.json，每次整段重抓淨值與資產撥回紀錄

配息（算含息報酬用，同樣每天累積）：
  境外：集保「境外基金配息資訊」（OpenAPI 3-5，最近約半年）
  境內：投信投顧公會「境內基金配息資料」 https://data.gov.tw/dataset/160547

輸出：
  data/funds/index.json      全部基金清單＋最新淨值（網頁搜尋用）
  data/funds/nav/<id>.csv    每檔基金的淨值歷史：date,nav（日期 YYYY-MM-DD）
  data/funds/div/<id>.csv    每檔基金的配息紀錄：exdate,amount（除息日、每單位配息）
基金 ID：境內 T-<基金統編>（例 T-18480065），境外 F-<基金代碼>（例 F-AGIF-FV1）
只用 Python 標準函式庫，不需要安裝任何套件。
"""
import csv, io, json, os, re, sys, time, urllib.request
from datetime import datetime, timezone, timedelta

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "data", "funds")
NAV_DIR = os.path.join(OUT, "nav")
DIV_DIR = os.path.join(OUT, "div")
SITCA_URL = "https://www.sitca.org.tw/MemberK0000/F/03/nav.csv"
TDCC_URL = "https://openapi.tdcc.com.tw/v1/opendata/3-4"
SITCA_DIV_URL = "https://www.sitca.org.tw/MemberK0000/F/03/160547%E6%8A%95%E4%BF%A1%E6%8A%95%E9%A1%A7%E5%85%AC%E6%9C%83%E5%A2%83%E5%85%A7%E5%9F%BA%E9%87%91%E9%85%8D%E6%81%AF%E8%B3%87%E6%96%99.csv"
TDCC_DIV_URL = "https://openapi.tdcc.com.tw/v1/opendata/3-5"
TW = timezone(timedelta(hours=8))


def fetch(url, tries=4):
    last = None
    for i in range(tries):
        try:
            req = urllib.request.Request(url, headers={"User-Agent": "eastone-stock-fund-nav/1.0 (+https://eastonesd.github.io/eastone.stock/)"})
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read()
        except Exception as e:  # 網路不穩就重試
            last = e
            time.sleep(5 * (i + 1))
    raise RuntimeError(f"抓取失敗 {url}: {last}")


def iso(d):
    d = re.sub(r"\D", "", str(d))
    return f"{d[:4]}-{d[4:6]}-{d[6:8]}" if len(d) == 8 else None


def num(x):
    try:
        v = float(str(x).replace(",", "").strip())
        return v if v > 0 else None
    except ValueError:
        return None


def safe_id(prefix, code):
    return prefix + "-" + re.sub(r"[^A-Za-z0-9_-]", "_", code.strip())


def onshore():
    raw = fetch(SITCA_URL)
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("big5", errors="replace")
    rows = []
    for r in csv.DictReader(io.StringIO(text)):
        # 「基金代號」各家投信會重複（例如 DDO04 有好幾家在用），「基金統編」才是每檔、每個級別唯一的編號
        code, d, nav = (r.get("基金統編") or "").strip(), iso(r.get("日期")), num(r.get("基金淨值"))
        if not code or not d or nav is None:
            continue
        rows.append({
            "id": safe_id("T", code), "name": (r.get("基金名稱") or "").strip(), "company": (r.get("公司名稱") or "").strip(),
            "currency": (r.get("幣別") or "TWD").strip() or "TWD", "kind": "境內", "isin": "",
            "type": (r.get("類型代號") or "").strip(), "ticker": (r.get("受益憑證代號") or "").strip(),
            "org": (r.get("會員代號") or "").strip(), "issuer": "",
            "date": d, "nav": nav,
        })
    return rows


def offshore():
    data = json.loads(fetch(TDCC_URL).decode("utf-8-sig"))
    rows = []
    for r in data:
        r = {k.lstrip("﻿").strip(): v for k, v in r.items()}   # 欄位名稱前面有 BOM
        code, d, nav = (r.get("基金代碼") or "").strip(), iso(r.get("日期")), num(r.get("基金淨值(金額)"))
        if not code or not d or nav is None:
            continue
        rows.append({
            "id": safe_id("F", code), "name": (r.get("基金名稱") or "").strip(), "company": (r.get("總代理機構") or "").strip(),
            "currency": (r.get("計價幣別") or "").strip(), "kind": "境外", "isin": (r.get("ISINCODE") or "").strip(),
            "type": "", "ticker": "", "org": "", "issuer": (r.get("境外基金機構") or "").strip(),
            "date": d, "nav": nav,
        })
    return rows


INSURER_LIST = os.path.join(os.path.dirname(os.path.abspath(__file__)), "insurer_accounts.json")


def roc_or_ad(d):
    """115/11/09（民國）或 2026/11/09 都轉成 2026-11-09"""
    p = re.split(r"[/\-.]", str(d).strip())
    if len(p) != 3 or not all(x.isdigit() for x in p):
        return None
    y = int(p[0]) + (1911 if int(p[0]) < 1000 else 0)
    return f"{y:04d}-{int(p[1]):02d}-{int(p[2]):02d}"


def insurer_accounts():
    """回傳 (淨值 rows, 撥回 [(id, 除息日, 金額)])；嘉實資訊（MoneyDJ）架的保險公司投資標的網站"""
    if not os.path.exists(INSURER_LIST):
        return [], []
    accts = json.load(open(INSURER_LIST, encoding="utf-8"))
    rows, divs = [], []
    today = datetime.now(TW).strftime("%Y/%m/%d")
    for a in accts:
        base = a["site"].rstrip("/")
        # 淨值：第一段是日期、第二段是淨值，各以逗號分隔
        raw = fetch(f"{base}/w/bcd/taBCDNavList.djbcd?a={a['dj']}&b={a['code']}&c=0&d={a.get('since', '')}&e={today}")
        text = raw.decode("big5", errors="replace").strip()
        parts = [p for p in re.split(r"\s+", text) if p]
        if len(parts) < 2:
            raise RuntimeError(f"{a['name']}：淨值格式看不懂")
        dates, navs = parts[0].split(","), parts[1].split(",")
        n = 0
        for d, v in zip(dates, navs):
            d, v = iso(d), num(v)
            if d and v:
                n += 1
                rows.append({"id": a["id"], "name": a["name"], "company": f"{a['insurer']}（委託{a['manager']}）",
                             "currency": a["currency"], "kind": "類全委", "isin": "", "type": "", "ticker": a["code"],
                             "org": a["insurer"], "issuer": a["manager"], "date": d, "nav": v})
        # 資產撥回：表格「日期 | 狀態 | 配息金額 | 幣別」，日期是民國年
        page = fetch(f"{base}/w/wta/ta105.djhtm?a={a['dj']}&b={a['code']}").decode("big5", errors="replace")
        k = 0
        for tr in re.findall(r"<tr[^>]*>(.*?)</tr>", page, flags=re.S | re.I):
            cells = [re.sub(r"<[^>]+>|&nbsp;", " ", c).strip() for c in re.findall(r"<t[dh][^>]*>(.*?)</t[dh]>", tr, flags=re.S | re.I)]
            if len(cells) >= 3:
                d, amt = roc_or_ad(cells[0]), num(cells[2])
                if d and amt:
                    divs.append((a["id"], d, amt)); k += 1
        print(f"類全委 {a['insurer']} {a['code']}：淨值 {n} 筆、撥回 {k} 筆")
    return rows, divs


def onshore_div():
    raw = fetch(SITCA_DIV_URL)
    try:
        text = raw.decode("utf-8-sig")
    except UnicodeDecodeError:
        text = raw.decode("big5", errors="replace")
    out = []
    for r in csv.DictReader(io.StringIO(text)):
        code, d, amt = (r.get("基金統編") or "").strip(), iso(r.get("除息日")), num(r.get("每單位分派金額"))
        if code and d and amt:
            out.append((safe_id("T", code), d, amt))
    return out


def offshore_div():
    out = []
    for r in json.loads(fetch(TDCC_DIV_URL).decode("utf-8-sig")):
        r = {k.lstrip("﻿").strip(): v for k, v in r.items()}
        code, d, amt = (r.get("基金代碼") or "").strip(), iso(r.get("除息日")), num(r.get("單位數"))
        if code and d and amt:
            out.append((safe_id("F", code), d, amt))
    return out


def merge_div(fid, items):
    """配息紀錄寫入 data/funds/div/<id>.csv（同一個除息日以新的為準），回傳新增筆數"""
    os.makedirs(DIV_DIR, exist_ok=True)
    path = os.path.join(DIV_DIR, fid + ".csv")
    cur = {}
    if os.path.exists(path):
        with open(path, encoding="utf-8") as f:
            for line in f.read().splitlines()[1:]:
                d, _, v = line.partition(",")
                if d and v:
                    cur[d] = v
    before = dict(cur)
    for d, amt in items:
        cur[d] = f"{amt:.6f}".rstrip("0").rstrip(".")
    if cur != before:
        with open(path, "w", encoding="utf-8", newline="\n") as f:
            f.write("exdate,amount\n" + "".join(f"{d},{cur[d]}\n" for d in sorted(cur)))
    return len(cur) - len(before)


def collect_dividends(errors, extra=()):
    by = {}
    for fid, d, amt in extra:
        by.setdefault(fid, []).append((d, amt))
    for name, fn in (("境內配息（投信投顧公會）", onshore_div), ("境外配息（集保）", offshore_div)):
        try:
            got = fn()
            print(f"{name}：{len(got)} 筆")
            for fid, d, amt in got:
                by.setdefault(fid, []).append((d, amt))
        except Exception as e:      # 配息抓不到不影響淨值
            errors.append(f"{name}：{e}")
            print(f"！{name} 失敗：{e}", file=sys.stderr)
    added = sum(merge_div(fid, items) for fid, items in by.items())
    print(f"配息：{len(by)} 檔基金，新增 {added} 筆")


def main():
    os.makedirs(NAV_DIR, exist_ok=True)
    rows, errors = [], []
    for name, fn in (("境內（投信投顧公會）", onshore), ("境外（集保）", offshore)):
        try:
            got = fn()
            print(f"{name}：{len(got)} 筆")
            rows += got
        except Exception as e:
            errors.append(f"{name}：{e}")
            print(f"！{name} 失敗：{e}", file=sys.stderr)
    if not rows:
        sys.exit("兩個來源都失敗，這次不更新")
    ins_divs = []
    try:
        ins_rows, ins_divs = insurer_accounts()
        rows += ins_rows
    except Exception as e:      # 保險公司網站抓不到不影響其他基金
        errors.append(f"類全委帳戶：{e}")
        print(f"！類全委帳戶 失敗：{e}", file=sys.stderr)
    collect_dividends(errors, ins_divs)

    # 依基金分組，寫入（累積）各自的淨值歷史
    by_id = {}
    for r in rows:
        by_id.setdefault(r["id"], []).append(r)
    added = 0
    for fid, items in by_id.items():
        path = os.path.join(NAV_DIR, fid + ".csv")
        hist = {}
        if os.path.exists(path):
            with open(path, encoding="utf-8") as f:
                for line in f.read().splitlines()[1:]:
                    d, _, v = line.partition(",")
                    if d and v:
                        hist[d] = v
        before = len(hist)
        for r in items:
            hist[r["date"]] = f"{r['nav']:.6f}".rstrip("0").rstrip(".")   # 同一天重複申報時以最新一次為準
        if len(hist) != before or not os.path.exists(path):
            added += len(hist) - before
            with open(path, "w", encoding="utf-8", newline="\n") as f:
                f.write("date,nav\n" + "".join(f"{d},{hist[d]}\n" for d in sorted(hist)))

    # 全部基金清單（含這次沒出現、但以前收過的基金）
    index_path = os.path.join(OUT, "index.json")
    old = {}
    if os.path.exists(index_path):
        with open(index_path, encoding="utf-8") as f:
            for row in json.load(f).get("funds", []):
                old[row[0]] = row
    for fid, items in by_id.items():
        r = max(items, key=lambda x: x["date"])
        prev = old.get(fid)
        if prev and prev[7] > r["date"]:
            continue
        old[fid] = [fid, r["name"], r["company"], r["currency"], r["kind"], r["isin"], r["type"], r["date"], r["nav"], r["ticker"],
                    r["org"], r["issuer"]]
    funds = sorted(old.values(), key=lambda x: (x[4] != "境內", x[2], x[1]))
    with open(index_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump({
            "updated": datetime.now(TW).strftime("%Y-%m-%d %H:%M"),
            "columns": ["id", "name", "company", "currency", "kind", "isin", "type", "date", "nav", "ticker", "org", "issuer"],
            "sources": {"境內": SITCA_URL, "境外": TDCC_URL},
            "errors": errors,
            "funds": funds,
        }, f, ensure_ascii=False, separators=(",", ":"))
    print(f"基金 {len(funds)} 檔，新增淨值 {added} 筆")


if __name__ == "__main__":
    main()
