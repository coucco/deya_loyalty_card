import sys, pathlib
from playwright.sync_api import sync_playwright
d = pathlib.Path(sys.argv[1])
def svg(side, w):
    s = (d / f'card_{side}.svg').read_text().split('?>', 1)[1]
    return s.replace('width="89.6mm" height="57.98mm"', f'width="{w}mm" height="{w*57.98/89.6:.2f}mm"')
html = f'''<html><head><meta charset="utf-8"><style>
@page {{ size: A4 landscape; margin: 10mm }}
body {{ font-family: Inter, Arial, sans-serif; color:#1a1a1a; margin:0 }}
h1 {{ font-size: 16pt; margin: 0 0 2mm }} p {{ font-size: 9pt; margin: 1mm 0; color:#444 }}
.row {{ display:flex; gap:8mm; margin-top:4mm }} .cap {{ font-size:9pt; font-weight:600; margin-bottom:1mm }}
.legend span {{ display:inline-block; width:10mm; border-top:1.5px dashed; margin:0 2mm 0.8mm 4mm; vertical-align:middle }}
</style></head><body>
<h1>Бонусная карта ДЕЯ - макет (номер-образец 999100000000001)</h1>
<p class="legend">Масштаб 1,3:1. <span style="border-color:#00A0FF"></span>линия реза 85,60 × 53,98 мм, R 3,18 <span style="border-color:#FF00C8"></span>безопасная зона 3 мм. За линией реза - вылеты 2 мм. Рамки в печать не идут.</p>
<div class="row"><div><div class="cap">Лицевая сторона</div>{svg("front", 116.5)}</div><div><div class="cap">Оборот</div>{svg("back", 116.5)}</div></div>
<p style="margin-top:4mm">Лицо без номера, одинаковое на всех картах; номер - на обороте под штрихкодом. Тираж 1000 шт.: 999100000000001 - 999100000001000. Полоса HiCo, дорожка 2: ;999100000000001?. Штрихкод Code 128 (X 0,25 мм) и QR (https://loyalty.tc-deya.ru) проверены на считывание. Фон и логотип - по брендбуку (векторный исходник дизайнера). Полное ТЗ - CARD_PRINT_SPEC.</p>
<p style="margin-top:3mm" class="cap">Натуральная величина (100 %)</p>
<div class="row" style="margin-top:1mm">{svg("front", 89.6)}{svg("back", 89.6)}</div>
</body></html>'''
with sync_playwright() as p:
    b = p.chromium.launch(executable_path='/opt/pw-browsers/chromium-1194/chrome-linux/chrome')
    pg = b.new_page(); pg.set_content(html); pg.wait_for_timeout(300)
    pg.pdf(path=str(d / 'card_mockup.pdf'), format='A4', landscape=True, print_background=True, margin={'top':'10mm','bottom':'10mm','left':'10mm','right':'10mm'})
    b.close()
