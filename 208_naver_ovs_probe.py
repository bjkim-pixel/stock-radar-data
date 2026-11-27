# -*- coding: utf-8 -*-
import requests
H = {"User-Agent": "Mozilla/5.0", "Referer": "https://m.stock.naver.com/"}; L = []
def log(m=""): print(m, flush=True); L.append(str(m))
for b in ["JPM", "XOM", "KO", "ABBV", "TSM", "BRK.B", "BRKb", "BRK-B", "V", "DIS"]:
    for suf in ["", ".N", ".K", ".A", ".O", ".P", ".Z"]:
        r = requests.get(f"https://api.stock.naver.com/stock/{b}{suf}/overview", headers=H, timeout=20)
        if r.status_code == 200: log(f"{b}{suf} → 200 {r.json().get('companyName')}")
        elif suf == ".N": log(f"{b}{suf} → {r.status_code}")
    log("")
open("naver_ovs_probe.md", "w", encoding="utf-8").write("\n".join(L))
