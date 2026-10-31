from pathlib import Path
tsx = Path(r"F:\work\HanShuWebUI\src\workspaces\gameplay\ShopEditor.tsx").read_text(encoding="utf-8")
shop = Path(r"F:\work\HanShuWebUI\src\workspaces\gameplay\shop.ts").read_text(encoding="utf-8")
lines = tsx.splitlines()
print("tsx", len(lines))
for i, line in enumerate(lines, 1):
    if any(k in line for k in ["copyEntry", "cloneShopEntry", "NodeContextMenu", "menu", "addEntry", "onSheetMenu", "toolbar-hint"]):
        print(f"{i}: {line[:220]}")
print("--- clone ---")
idx = shop.find("export function cloneShopEntry")
print(shop[idx:idx+1200])
