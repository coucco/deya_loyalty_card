#!/usr/bin/env python3
"""Markdown → PDF для документов проекта: python3 scripts/md2pdf.py <in.md> <out.pdf> [заголовок].
Нужны: pip install markdown; Node.js с пакетом playwright (Chromium).
"""
import json, os, pathlib, subprocess, sys, tempfile
import markdown

src, out = pathlib.Path(sys.argv[1]), pathlib.Path(sys.argv[2])
title = sys.argv[3] if len(sys.argv) > 3 else src.stem
body = markdown.markdown(src.read_text(encoding='utf-8'), extensions=['tables', 'fenced_code', 'sane_lists'])
css = """
@page { size: A4; margin: 14mm 13mm }
body { font-family: Inter, 'Segoe UI', Arial, sans-serif; font-size: 10pt; line-height: 1.45; color: #1a1a1a }
h1 { font-size: 17pt; margin: 0 0 8pt; color: #C25A0C } h2 { font-size: 13pt; margin: 14pt 0 5pt; border-bottom: 1.5px solid #EE741C; padding-bottom: 2pt }
h3 { font-size: 11pt; margin: 10pt 0 4pt } p, li { margin: 3pt 0 } ul, ol { padding-left: 16pt; margin: 3pt 0 }
table { border-collapse: collapse; width: 100%; margin: 5pt 0; font-size: 9pt; page-break-inside: auto } tr { page-break-inside: avoid }
th, td { border: 1px solid #d9cfc0; padding: 3pt 5pt; vertical-align: top; text-align: left } th { background: #F6EFE4 }
code { font-family: 'DejaVu Sans Mono', monospace; font-size: 8.6pt; background: #f4f1ec; padding: 0 2pt; border-radius: 2px }
pre { background: #f4f1ec; padding: 6pt; border-radius: 4px; white-space: pre-wrap } pre code { background: none; padding: 0 }
blockquote { border-left: 3px solid #EE741C; margin: 5pt 0; padding: 2pt 8pt; color: #444 }
"""
html = f'<!doctype html><html lang="ru"><head><meta charset="utf-8"><title>{title}</title><style>{css}</style></head><body>{body}</body></html>'
with tempfile.TemporaryDirectory() as d:
    hp = pathlib.Path(d, 'doc.html'); hp.write_text(html, encoding='utf-8')
    js = pathlib.Path(d, 'print.cjs')
    js.write_text("""const { chromium } = require('playwright');
(async () => { const [h, o] = process.argv.slice(2); const b = await chromium.launch(); const p = await b.newPage();
  await p.goto('file://' + h); await p.pdf({ path: o, format: 'A4', printBackground: true, margin: { top: '14mm', bottom: '14mm', left: '13mm', right: '13mm' } });
  await b.close(); })().catch((e) => { console.error(e); process.exit(1); });""")
    env = dict(os.environ, NODE_PATH=subprocess.run(['npm', 'root', '-g'], capture_output=True, text=True).stdout.strip())
    subprocess.run(['node', str(js), str(hp), str(out.resolve())], check=True, env=env)
print('ok', out)
