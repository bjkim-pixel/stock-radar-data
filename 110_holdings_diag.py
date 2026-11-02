import sys, os, importlib
sys.path.insert(0, os.path.dirname(os.path.abspath(__file__)))
G = importlib.import_module("21_collect_global")
for t in ["EWJ", "FEZ", "ASHR", "EEM", "EIDO"]:
    r = G.holdings_stockanalysis(t, diag=True)
    print(t, r, flush=True)
print("REPORT_LINES", len(G.REPORT))
print("\n".join(G.REPORT))
