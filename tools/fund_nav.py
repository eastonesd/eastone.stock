"""
東石診股 - 基金淨值每日收集
================================
資料來源（皆為政府資料開放授權、免費）：
  境內基金：投信投顧公會「證券投資信託基金每日淨值」  https://data.gov.tw/dataset/11109
  境外基金：集保結算所「境外基金淨值」（OpenAPI 3-4）  https://data.gov.tw/dataset/11641

兩個來源都只提供最近幾天的淨值、沒有歷史，所以由 GitHub Actions 每天跑這支程式，
把新的淨值「累積」進 data/funds/nav/<基金ID>.csv，歷史就從開始收集的那天一天天長出來。

輸出：
  data/funds/index.json      全部基金清單＋最新淨值（網頁搜尋用）
  data/funds/nav/<id>.csv    每檔基金的淨值歷史：date,nav（日期 YYYY-MM-DD）
基金 ID：境內 T-<基金統編>（例 T-18480065），境外 F-<基金代碼>（例 F-AGIF-FV1）
只用 Python 標準函式庫，不需要安裝任何套件。
"""
import csv, io, json, os, re, sys, time, urllib.request
from datetime import datetime, timezone, timedelta

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
OUT = os.path.join(ROOT, "data", "funds")
NAV_DIR = os.path.join(OUT, "nav")
SITCA_URL = "https://www.sitca.org.tw/MemberK0000/F/03/nav.csv"
TDCC_URL = "https://openapi.tdcc.com.tw/v1/opendata/3-4"
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
            "type": "", "ticker": "", "date": d, "nav": nav,
        })
    return rows


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
        old[fid] = [fid, r["name"], r["company"], r["currency"], r["kind"], r["isin"], r["type"], r["date"], r["nav"], r["ticker"]]
    funds = sorted(old.values(), key=lambda x: (x[4] != "境內", x[2], x[1]))
    with open(index_path, "w", encoding="utf-8", newline="\n") as f:
        json.dump({
            "updated": datetime.now(TW).strftime("%Y-%m-%d %H:%M"),
            "columns": ["id", "name", "company", "currency", "kind", "isin", "type", "date", "nav", "ticker"],
            "sources": {"境內": SITCA_URL, "境外": TDCC_URL},
            "errors": errors,
            "funds": funds,
        }, f, ensure_ascii=False, separators=(",", ":"))
    print(f"基金 {len(funds)} 檔，新增淨值 {added} 筆")


if __name__ == "__main__":
    main()
