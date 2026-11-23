"""Headless test: a background picture that is not 2:1 is shown as a cylinder or flat, not wrapped on the sphere.

Run from the Simple Pano folder:   python3 tests/flat_background_test.py
Needs:  pip install playwright  and  playwright install chromium
Optional: CHROME=/path/to/chrome to use an installed Chrome; SHOT=/some/prefix saves screenshots (ui_toggle_test).

"""
import asyncio, base64, math, os, sys, tempfile
from PIL import Image
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAV0lEQVR4Xu3RAQkAIQAEQTXXBzOiseRTLMJMgjt2nv2Nl62Xx/8cqClQU6CmQE2BmgI1BWoK1BSoKVBToKZATYGaAjUFagrUFKgpUFOgpkBNgZoCNQVqF6WIAdzFYK+7AAAAAElFTkSuQmCC')

def make(path, w, h, periodic=False, seamless=False):
    im = Image.new('RGB', (w, h)); px = im.load()
    for x in range(w):
        t = x / (w - 1)
        if periodic: c = (int(127 + 127 * math.cos(2 * math.pi * x / w)), int(127 + 127 * math.sin(2 * math.pi * x / w)), 90)
        else: c = (int(255 * (1 - t)), 40, int(255 * t))          # red on the left, blue on the right
        for y in range(h): px[x, y] = c
    im.save(path)

async def main():
    tmp = tempfile.mkdtemp(); fails = []
    cases = [('equirect.png', 2048, 1024, False, 'Background Panorama Loaded'),
             ('wide.png', 3000, 1000, False, 'cylindrical panorama (a vertical'),
             ('around.png', 3000, 750, True, 'full cylindrical panorama'),
             ('photo.png', 800, 600, False, 'shown flat'),
             ('tall.png', 600, 900, False, 'shown flat')]
    paths = {}
    for n, w, h, per, _ in cases:
        paths[n] = os.path.join(tmp, n); make(paths[n], w, h, per)
    async with async_playwright() as pw:
        kw = {'args': ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files']}
        if os.environ.get('CHROME'): kw['executable_path'] = os.environ['CHROME']
        b = await pw.chromium.launch(**kw)
        page = await b.new_page(viewport={'width': 1100, 'height': 700})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto('file://' + HERE + '/index.html'); await page.wait_for_timeout(2500)
        def ok(c, what):
            print(('PASS ' if c else 'FAIL ') + what)
            if not c: fails.append(what)
        for n, w, h, per, want in cases:
            await page.set_input_files('#pano-upload', paths[n]); await page.wait_for_timeout(2500)
            m = await page.evaluate("document.getElementById('message-box').textContent")
            ok(want in m, n + ' -> ' + m[:70])
            if n in ('wide.png', 'photo.png', 'tall.png'):
                await page.wait_for_timeout(5500)       # buttons gone
                shot = await page.screenshot()
                from io import BytesIO
                im = Image.open(BytesIO(shot)).convert('RGB'); W, H = im.size
                l = im.getpixel((int(W * .44), H // 2)); r = im.getpixel((int(W * .56), H // 2))
                ok(l[0] > l[2] and r[2] > r[0], n + ' reads left to right (left reddish %s, right bluish %s)' % (l, r))
        await page.click('#ui-corner'); await page.wait_for_timeout(600)
        await page.click('#bg-clear'); await page.wait_for_timeout(800)
        ok(not errors, 'no page errors ' + str(errors))
        await b.close()
    print('ALL PASSED' if not fails else 'FAILED: ' + ', '.join(fails)); sys.exit(1 if fails else 0)

asyncio.run(main())
