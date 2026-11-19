"""
東石診股 - 基金歷史淨值回補（只補指定清單）
=============================================
每日收集的官方開放資料只給最近幾天，所以這支程式到集保結算所「基金資訊觀測站」
（https://www.fundclear.com.tw/）查詢歷史淨值，補進 data/funds/nav/<id>.csv。

為了不造成觀測站負擔：
  * 只補 data/funds/backfill.txt 裡列出的基金（不是全部近萬檔）
  * 每次查詢間隔 2 秒，一檔基金約 1～4 次查詢，跟一般人手動查詢差不多
  * 補過的會記在 data/funds/backfill_done.json，不會重複查

backfill.txt 格式：一行一檔基金 ID（東石診股網址 #fund/ 後面那段），後面可加年數（沒寫就是 2 年），# 後面可寫備註
  F-AGIF-FVM       # 安聯收益成長 AM 美元（補 2 年）
  F-GLIACU     5   # 摩根多重收益 A股穩定月配（補 5 年）
年數比上次補的多，就會再補一次。
境外基金會一併補上同期間的配息紀錄（data/funds/div/<id>.csv），用來算含息報酬。
"""
import http.cookiejar, json, os, re, sys, time, urllib.request
from datetime import date, datetime, timedelta, timezone

ROOT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")
FUNDS = os.path.join(ROOT, "data", "funds")
NAV_DIR = os.path.join(FUNDS, "nav")
DIV_DIR = os.path.join(FUNDS, "div")
LIST = os.path.join(FUNDS, "backfill.txt")
DONE = os.path.join(FUNDS, "backfill_done.json")
SITE = "https://www.fundclear.com.tw"
YEARS = 2          # 沒寫年數時的預設值
PAUSE = 2.0
TW = timezone(timedelta(hours=8))

jar = http.cookiejar.CookieJar()
opener = urllib.request.build_opener(urllib.request.HTTPCookieProcessor(jar))
HEAD = {"User-Agent": "Mozilla/5.0 (eastone-stock fund backfill; +https://eastonesd.github.io/eastone.stock/)",
        "Accept": "application/json", "Content-Type": "application/json",
        "Origin": SITE, "Referer": SITE + "/"}
calls = 0


def post(path, body):
    global calls
    time.sleep(PAUSE)
    calls += 1
    req = urllib.request.Request(SITE + path, data=json.dumps(body).encode(), headers=HEAD, method="POST")
    for i in range(3):
        try:
            with opener.open(req, timeout=60) as r:
                return json.loads(r.read().decode("utf-8"))
        except urllib.error.HTTPError as e:
            if e.code in (400, 404):
                return None
            err = e
        except Exception as e:  # 網路不穩
            err = e
        time.sleep(10 * (i + 1))
    raise RuntimeError(f"{path} 失敗：{err}")


def norm(s):
    return re.sub(r"[\s　]+", " ", str(s or "")).strip().upper()


def key(s):
    """比對機構名稱用：去掉空白、標點與重音符號（S.À R.L. 和 S.A.R.L. 視為相同）"""
    import unicodedata
    s = str(s or "")
    if not re.search(r"[一-鿿]", s):
        s = unicodedata.normalize("NFKD", s).encode("ascii", "ignore").decode()
    return re.sub(r"[^0-9A-Za-z一-鿿]", "", s).upper()


def load_index():
    with open(os.path.join(FUNDS, "index.json"), encoding="utf-8") as f:
        d = json.load(f)
    cols = d["columns"]
    return {row[0]: dict(zip(cols, row)) for row in d["funds"]}


_orgs = None
_names = {}


def offshore_codes(f):
    """境外：用「境外基金機構」名稱找機構代碼，再用基金名稱找 fundCode，最後確認級別代碼"""
    global _orgs
    if _orgs is None:
        _orgs = post("/api/offshore/common-select/org-selection", {"all": False}) or []
    # 集保開放資料的機構名稱常是「中文/英文」並列，觀測站選單只有其中一種寫法，所以拆開逐一比對
    parts = [key(p) for p in re.split(r"[/／]", f.get("issuer") or "") if key(p)]
    org = None
    for o in _orgs:
        k = key(o["name"])
        if k and any(p == k for p in parts):
            org = o["value"]; break
    if not org:
        for o in _orgs:
            k = key(o["name"])
            if k and any(len(p) > 5 and (p in k or k in p) for p in parts):
                org = o["value"]; break
    if not org:
        print(f"  （找不到機構代碼：{f.get('issuer')}）")
        return None
    if org not in _names:
        _names[org] = post("/api/offshore/common-select/fund-name-selection", {"organizeCode": org, "all": False}) or []
    class_code = f["id"][2:]
    # 級別名稱通常以基金名稱開頭（「安聯收益成長基金-AM穩定月收類股(美元)」），名稱最長、相符的先試
    # 比對時忽略空白與標點（「摩根投資基金 - 多重收益基金 - …」對「摩根投資基金-多重收益基金」）
    cname = key(f["name"])
    cands = sorted([n for n in _names[org] if key(n["name"]) and cname.startswith(key(n["name"]))], key=lambda n: -len(n["name"]))
    cands += [n for n in _names[org] if n not in cands]
    for n in cands[:6]:
        cls = post("/api/offshore/common-select/fund-class-selection",
                   {"organizeCode": org, "fundCode": n["value"], "all": False}) or []
        if any(c.get("value") == class_code for c in cls):
            return {"organizeCode": org, "fundCode": n["value"], "fundClassCode": class_code}
    return None


_codes = {}


def offshore_dividends(f, start, end):
    """境外基金的歷年配息（觀測站「配息資訊」），回傳 {除息日: 每單位配息}"""
    codes = _codes.get(f["id"]) or offshore_codes(f)
    if not codes:
        return None
    out, page = {}, 1
    while True:
        res = post("/api/offshore/fund-info/info-dividend/query", {
            "_pageNum": page, "_pageSize": 100, "queryType": "2", "searchName": "", **codes, "frequency": [],
            "baseBeginDate": start.strftime("%Y/%m"), "baseEndDate": end.strftime("%Y/%m")})
        rows = (res or {}).get("list") or []
        for r in rows:
            d = re.sub(r"\D", "", str(r.get("asiEnterDate") or ""))      # asiEnterDate＝除息日
            try:
                amt = float(str(r.get("asiAmt", "")).replace(",", ""))
            except ValueError:
                continue
            if len(d) == 8 and amt > 0:
                out[f"{d[:4]}-{d[4:6]}-{d[6:]}"] = f"{amt:.6f}".rstrip("0").rstrip(".")
        total = int((res or {}).get("total") or 0)
        if not rows or page * 100 >= total:
            return out
        page += 1


def save_div(fid, divs):
    os.makedirs(DIV_DIR, exist_ok=True)
    path = os.path.join(DIV_DIR, fid + ".csv")
    cur = {}
    if os.path.exists(path):
        for line in open(path, encoding="utf-8").read().splitlines()[1:]:
            d, _, v = line.partition(",")
            if d and v:
                cur[d] = v
    merged = {**divs, **cur}
    with open(path, "w", encoding="utf-8", newline="\n") as fh:
        fh.write("exdate,amount\n" + "".join(f"{d},{merged[d]}\n" for d in sorted(merged)))
    return len(merged) - len(cur)


def history(f, start, end):
    rng = {"startDate": start.strftime("%Y/%m/%d"), "endDate": end.strftime("%Y/%m/%d")}
    if f["kind"] == "境內":
        code = f["id"][2:]
        body = {"orgId": f.get("org") or "", "fundNo": re.sub(r"[A-Z]+$", "", code), "fundClassCode": code, **rng}
        res = post("/api/onshore/nav-profit/query-history", body)
    else:
        codes = offshore_codes(f)
        if not codes:
            return None, "觀測站找不到這檔境外基金的機構或級別代碼"
        _codes[f["id"]] = codes
        res = post("/api/offshore/nav-profit/query-history", {**codes, **rng})
    if not res or not res.get("tableList"):
        return None, "觀測站查無歷史淨值"
    out = {}
    for r in res["tableList"]:
        d = re.sub(r"\D", "", str(r.get("navTxnDate", "")))
        try:
            v = float(str(r.get("navValue", "")).replace(",", ""))
        except ValueError:
            continue
        if len(d) == 8 and v > 0:
            out[f"{d[:4]}-{d[4:6]}-{d[6:]}"] = f"{v:.6f}".rstrip("0").rstrip(".")
    return out, None


def main():
    if not os.path.exists(LIST):
        sys.exit("沒有 backfill.txt")
    want = {}
    with open(LIST, encoding="utf-8") as f:
        for line in f:
            parts = line.split("#", 1)[0].split()
            if not parts:
                continue
            years = int(parts[1]) if len(parts) > 1 and parts[1].isdigit() else YEARS
            want[parts[0]] = max(years, want.get(parts[0], 0))
    ids = list(want)
    done = json.load(open(DONE, encoding="utf-8")) if os.path.exists(DONE) else {}
    # 沒補過、上次失敗、或這次要補的年數比上次多，才查
    # 境外基金另外要有配息紀錄（div），舊的回補紀錄沒有就補一次
    todo = [i for i in ids if "--force" in sys.argv or i not in done or not done[i].get("ok")
            or want[i] > done[i].get("years", 2) or (i.startswith("F-") and "div" not in done[i])]
    print(f"清單 {len(ids)} 檔，這次要補 {len(todo)} 檔")
    if not todo:
        return
    index = load_index()
    opener.open(urllib.request.Request(SITE + "/", headers={"User-Agent": HEAD["User-Agent"]}), timeout=60).read()  # 先拿 cookie
    end = date.today()
    for fid in todo:
        start = end.replace(year=end.year - want[fid])
        f = index.get(fid)
        if not f:
            print(f"！{fid}：基金清單裡沒有這個 ID")
            continue
        try:
            hist, why = history(f, start, end)
        except Exception as e:
            print(f"！{fid} {f['name']}：{e}")
            continue
        if not hist:
            print(f"！{fid} {f['name']}：{why}")
            done[fid] = {"ok": False, "why": why, "at": datetime.now(TW).strftime("%Y-%m-%d %H:%M")}
            continue
        path = os.path.join(NAV_DIR, fid + ".csv")
        cur = {}
        if os.path.exists(path):
            for line in open(path, encoding="utf-8").read().splitlines()[1:]:
                d, _, v = line.partition(",")
                if d and v:
                    cur[d] = v
        added = sum(1 for d in hist if d not in cur)
        merged = {**hist, **cur}            # 同一天以每日收集的官方資料為準
        with open(path, "w", encoding="utf-8", newline="\n") as fh:
            fh.write("date,nav\n" + "".join(f"{d},{merged[d]}\n" for d in sorted(merged)))
        days = sorted(hist)
        done[fid] = {"ok": True, "years": want[fid], "from": days[0], "to": days[-1], "n": len(hist),
                     "at": datetime.now(TW).strftime("%Y-%m-%d %H:%M")}
        print(f"✓ {fid} {f['name']}（{want[fid]} 年）：{days[0]} ～ {days[-1]}，{len(hist)} 筆（新增 {added}）")
        if f["kind"] == "境外":
            try:
                divs = offshore_dividends(f, start, end)
            except Exception as e:
                divs = None
                print(f"  ！配息查詢失敗：{e}")
            if divs is not None:
                done[fid]["div"] = len(divs)
                if divs:
                    save_div(fid, divs)
                print(f"  配息 {len(divs)} 筆" + (f"（{min(divs)} ～ {max(divs)}）" if divs else "（這段期間沒有配息，或為累積型）"))
    with open(DONE, "w", encoding="utf-8", newline="\n") as fh:
        json.dump(done, fh, ensure_ascii=False, indent=1, sort_keys=True)
    print(f"共查詢觀測站 {calls} 次")


if __name__ == "__main__":
    main()
