"""Headless test: auto-crop finds the largest rectangle without empty edges.

Run from the Simple Pano folder:   python3 tests/crop_test.py
Optional: CHROME=/path/to/chrome
"""
import asyncio, os, sys
from playwright.async_api import async_playwright
HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

async def main():
    fails = []
    def ok(c, what):
        print(('PASS ' if c else 'FAIL ') + what)
        if not c: fails.append(what)
    async with async_playwright() as pw:
        kw = {'args': ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files']}
        if os.environ.get('CHROME'): kw['executable_path'] = os.environ['CHROME']
        b = await pw.chromium.launch(**kw); page = await b.new_page()
        errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto('file://' + HERE + '/index.html'); await page.wait_for_timeout(2500)
        r = await page.evaluate("""() => {
            const mk = (fn) => { const c = document.createElement('canvas'); c.width = 2048; c.height = 1024; const g = c.getContext('2d'); g.fillStyle = '#000'; g.fillRect(0, 0, 2048, 1024); fn(g); return c; };
            const fill = (g, x, y, w, h) => { g.fillStyle = '#6a8'; g.fillRect(x, y, w, h); };
            const out = {};
            // a band with uneven top and bottom edges, all the way around
            out.band = __pano.findCrop(mk(g => { for (let x = 0; x < 2048; x += 16) { const t = 300 + 40 * Math.sin(x / 150), bt = 760 + 30 * Math.cos(x / 90); fill(g, x, t, 16, bt - t); } }));
            // a partial panorama with ragged edges on all four sides
            out.part = __pano.findCrop(mk(g => { for (let x = 400; x < 1500; x += 16) { const t = 200 + 50 * Math.sin(x / 100), bt = 800 - 40 * Math.cos(x / 70), l = 0; fill(g, x, t, 16, bt - t); } }));
            out.full = __pano.findCrop(mk(g => fill(g, 0, 0, 2048, 1024)));
            out.empty = __pano.findCrop(mk(g => { }));
            return out;
        }""")
        print(r)
        b_ = r['band']; ok(b_ and b_['x'] == 0 and b_['w'] >= 2040 and 330 <= b_['y'] <= 360 and b_['y'] + b_['h'] <= 730 and b_['h'] > 330, 'band: full width, rows trimmed to the common area')
        p_ = r['part']; ok(p_ and 380 <= p_['x'] + 0 and p_['x'] >= 400 - 20 and p_['x'] <= 440 and p_['w'] > 1000 and p_['y'] >= 250 and p_['y'] + p_['h'] <= 760, 'partial: all four sides trimmed')
        ok(r['full'] is None, 'a full picture needs no crop'); ok(r['empty'] is None, 'an empty picture gives no crop')
        ok(not errors, 'no page errors ' + str(errors)); await b.close()
    print('ALL PASSED' if not fails else 'FAILED: ' + ', '.join(fails)); sys.exit(1 if fails else 0)
asyncio.run(main())
