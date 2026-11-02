import re, time, requests, json
s = open("docs/index.html", encoding="utf-8").read()
url = re.search(r'url\s*:\s*"(https://[^"]+)"', s).group(1); key = re.search(r'key\s*:\s*"([^"]+)"', s).group(1)
H = {"apikey": key, "Authorization": "Bearer " + key}
d = requests.get(f"{url}/rest/v1/daily_flow?select=trade_date&order=trade_date.desc&limit=1", headers=H, timeout=30).json()[0]["trade_date"]
print("date", d)
for name, q in [("v_flow_rank_today", f"select=*&trade_date=eq.{d}"), ("v_screener", f"select=code,foreign_net&trade_date=eq.{d}&limit=3")]:
    t = time.time()
    r = requests.get(f"{url}/rest/v1/{name}?{q}", headers=H, timeout=60)
    body = r.text
    print(name, r.status_code, "%.2fs" % (time.time() - t), len(body), body[:300].replace("\n", " "))
