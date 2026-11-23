"""Headless test: the three-bar button shows and hides the other buttons; messages show without them.

Run from the Simple Pano folder:   python3 tests/ui_toggle_test.py
Needs:  pip install playwright  and  playwright install chromium
Optional: CHROME=/path/to/chrome to use an installed Chrome; SHOT=/some/prefix saves screenshots (ui_toggle_test).

"""
import asyncio, base64, os, sys, tempfile
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAV0lEQVR4Xu3RAQkAIQAEQTXXBzOiseRTLMJMgjt2nv2Nl62Xx/8cqClQU6CmQE2BmgI1BWoK1BSoKVBToKZATYGaAjUFagrUFKgpUFOgpkBNgZoCNQVqF6WIAdzFYK+7AAAAAElFTkSuQmCC')

async def main():
    tmp = tempfile.mkdtemp(); p = os.path.join(tmp, 'picture.png'); open(p, 'wb').write(PNG)
    fails = []
    def ok(c, what):
        print(('PASS ' if c else 'FAIL ') + what)
        if not c: fails.append(what)
    async with async_playwright() as pw:
        kw = {'args': ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files']}
        if os.environ.get('CHROME'): kw['executable_path'] = os.environ['CHROME']
        b = await pw.chromium.launch(**kw)
        ctx = await b.new_context(viewport={'width': 390, 'height': 780}, has_touch=True, is_mobile=True)   # a phone
        page = await ctx.new_page()
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto('file://' + HERE + '/index.html'); await page.wait_for_timeout(2500)
        off = lambda: page.evaluate("document.getElementById('ui-layer').classList.contains('ui-off')")
        corner_vis = lambda: page.evaluate("(() => { const r = document.getElementById('ui-corner').getBoundingClientRect(); const cs = getComputedStyle(document.getElementById('ui-corner')); return r.width > 20 && cs.opacity > 0.3 && cs.visibility !== 'hidden'; })()")
        ok(await off(), 'buttons start hidden'); ok(await corner_vis(), 'the three-bar button is visible')
        await page.tap('#ui-corner'); await page.wait_for_timeout(700)
        ok(not await off(), 'tapping it shows the buttons')
        await page.wait_for_timeout(6000)
        ok(not await off(), 'they stay (no timer)'); ok(await corner_vis(), 'the three-bar button is still visible')
        if os.environ.get('SHOT'): await page.screenshot(path=os.environ['SHOT'] + '_phone_buttons.png')
        await page.tap('#ui-corner'); await page.wait_for_timeout(800)
        ok(await off(), 'tapping it again hides them'); ok(await corner_vis(), 'the three-bar button is still visible')
        # a message shows without the buttons
        open(os.path.join(tmp, 'notes.txt'), 'w').write('not a picture')
        await page.set_input_files('#image-upload', os.path.join(tmp, 'notes.txt')); await page.wait_for_timeout(800)
        shown = await page.evaluate("(() => { const m = document.getElementById('message-box'); const r = m.getBoundingClientRect(); return !m.classList.contains('hidden') && r.width > 0 && getComputedStyle(m).visibility !== 'hidden'; })()")
        ok(shown, 'a message is visible while the buttons are hidden')
        await page.tap('#ui-corner'); await page.wait_for_timeout(700)
        ok(not await off(), 'buttons shown again')
        await page.set_input_files('#pano-upload', p); await page.wait_for_timeout(800)
        ok(await off(), 'loading a background picture hides the buttons')
        await page.tap('#ui-corner'); await page.wait_for_timeout(700)
        if await page.evaluate("document.getElementById('properties-panel').classList.contains('hidden')"): await page.tap('#panel-btn')
        await page.wait_for_timeout(500)
        if os.environ.get('SHOT'): await page.screenshot(path=os.environ['SHOT'] + '_phone_panel.png')
        await page.tap('#close-props-btn'); await page.wait_for_timeout(300)
        # full screen hides them (headless Chrome may refuse the request: send the event)
        await page.evaluate("document.getElementById('ui-layer').classList.remove('ui-off')")
        await page.evaluate("Object.defineProperty(document, 'fullscreenElement', { get: () => document.documentElement, configurable: true }); document.dispatchEvent(new Event('fullscreenchange'))")
        await page.wait_for_timeout(700)
        ok(await off(), 'full screen hides the buttons'); ok(await corner_vis(), 'the three-bar button is still visible in full screen')
        ok(not errors, 'no page errors ' + str(errors))
        await b.close()
    print('ALL PASSED' if not fails else 'FAILED: ' + ', '.join(fails)); sys.exit(1 if fails else 0)

asyncio.run(main())
