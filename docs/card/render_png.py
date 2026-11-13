import sys, pathlib
from playwright.sync_api import sync_playwright
d = pathlib.Path(sys.argv[1])
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
    pg = b.new_page(device_scale_factor=1)
    for side in ['front', 'back']:
        svg = (d / f'card_{side}.svg').read_text()
        # 600 dpi превью: 89.6 мм → 2117 px
        pg.set_viewport_size({'width': 2117, 'height': 1370})
        pg.set_content(f'<html><body style="margin:0">{svg.split("?>",1)[1].replace("width=\"89.6mm\" height=\"57.98mm\"", "width=\"2117\" height=\"1370\"")}</body></html>')
        pg.locator('svg').screenshot(path=str(d / f'card_{side}.png'))
    b.close()
