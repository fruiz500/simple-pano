"""Headless test: in the retouch window on a touch screen, one finger paints, two fingers move and zoom the view, and the
Brush slider shows the brush circle, the color picker previews the color under the finger and takes it on lifting, and the text on the screen talks about fingers, not mouse and keyboard.

Run from the Simple Pano folder:   python3 tests/retouch_touch_test.py
Needs:  pip install playwright pillow  and  playwright install chromium
Optional: CHROME=/path/to/chrome to use an installed Chrome.
"""
import asyncio, math, os, sys, tempfile
from PIL import Image
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

async def main():
    tmp = tempfile.mkdtemp(); pic = os.path.join(tmp, 'pano.png')
    im = Image.new('RGB', (2048, 1024)); px = im.load()
    for x in range(2048):
        for y in range(0, 1024, 1): px[x, y] = (x // 8, y // 4, 128)
    im.save(pic)
    fails = []
    def ok(c, what):
        print(('PASS ' if c else 'FAIL ') + what)
        if not c: fails.append(what)
    async with async_playwright() as pw:
        kw = {'args': ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files']}
        if os.environ.get('CHROME'): kw['executable_path'] = os.environ['CHROME']
        b = await pw.chromium.launch(**kw)
        ctx = await b.new_context(viewport={'width': 1000, 'height': 700}, has_touch=True, is_mobile=True)
        page = await ctx.new_page(); page.set_default_timeout(120000)
        errors = []; page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto('file://' + HERE + '/index.html'); await page.wait_for_timeout(2000)
        await page.set_input_files('#pano-upload', pic); await page.wait_for_timeout(2500)
        await page.evaluate("document.getElementById('ui-corner').click()"); await page.wait_for_timeout(400)
        if await page.evaluate("document.getElementById('properties-panel').classList.contains('hidden')"): await page.tap('#panel-btn')
        await page.wait_for_timeout(400)
        await page.evaluate("document.getElementById('rt-open-bg-btn').click()"); await page.wait_for_timeout(4000)
        cdp = await ctx.new_cdp_session(page)
        async def touch(kind, pts): await cdp.send('Input.dispatchTouchEvent', {'type': kind, 'touchPoints': [{'x': x, 'y': y, 'id': i} for i, (x, y) in enumerate(pts)]})
        box = await page.evaluate("(() => { const r = document.getElementById('pd-mask').getBoundingClientRect(); return [r.left, r.top, r.width, r.height]; })()")
        cx, cy = box[0] + box[2] / 2, box[1] + box[3] / 2
        painted = lambda: page.evaluate("(() => { const m = document.getElementById('pd-mask'); const d = m.getContext('2d').getImageData(0, 0, m.width, m.height).data; let n = 0; for (let i = 3; i < d.length; i += 4) if (d[i]) n++; return n; })()")
        tf = lambda: page.evaluate("document.getElementById('pd-mask').style.transform")
        ok(box[2] > 100, 'the retouch window is open (%d px wide)' % box[2])
        # two fingers: pinch out, drag, no paint
        await touch('touchStart', [(cx - 40, cy), (cx + 40, cy)]); await page.wait_for_timeout(30)
        for i in range(1, 9): await touch('touchMove', [(cx - 40 - i * 12, cy), (cx + 40 + i * 12, cy)]); await page.wait_for_timeout(20)
        t1 = await tf()
        await touch('touchEnd', []); await page.wait_for_timeout(100)
        ok('scale' in t1 and 'scale(1)' not in t1, 'two fingers moving apart zoom the view (%s)' % t1)
        ok(await painted() == 0, 'two fingers paint nothing')
        await page.wait_for_timeout(3000)
        # two fingers dragging together move the view
        await touch('touchStart', [(cx - 30, cy), (cx + 30, cy)]); await page.wait_for_timeout(30)
        for i in range(1, 9): await touch('touchMove', [(cx - 30 + i * 10, cy + i * 6), (cx + 30 + i * 10, cy + i * 6)]); await page.wait_for_timeout(20)
        t2 = await tf()
        await touch('touchEnd', []); await page.wait_for_timeout(100)
        ok(t2 != '' and 'translate' in t2, 'two fingers dragging move the view (%s)' % t2)
        ok(await painted() == 0, 'still no paint')
        await page.wait_for_timeout(3000)
        # one finger paints
        await touch('touchStart', [(cx, cy)]); await page.wait_for_timeout(200)
        for i in range(1, 8): await touch('touchMove', [(cx + i * 12, cy)]); await page.wait_for_timeout(20)
        n = await painted()
        ok(n > 200, 'one finger paints (%d pixels)' % n)
        await touch('touchEnd', [])
        await page.wait_for_timeout(500)
        # the Brush slider shows the brush circle (after the view was zoomed and moved)
        await page.evaluate("(() => { const r = document.getElementById('pd-brush'); r.value = 12; r.dispatchEvent(new Event('input', { bubbles: true })); })()")
        await page.wait_for_timeout(150)
        ring = await page.evaluate("(() => { const R = document.getElementById('pd-ring'); const b = R.getBoundingClientRect(); return [getComputedStyle(R).display, Math.round(b.width), Math.round(b.left + b.width / 2), Math.round(b.top + b.height / 2)]; })()")
        ok(ring[0] == 'block' and ring[1] > 6, 'the Brush slider shows the brush circle (%s)' % ring)
        if os.environ.get('SHOT'): await page.screenshot(path=os.environ['SHOT'] + '_brush_ring.png')
        await page.wait_for_timeout(1600)
        ok(await page.evaluate("getComputedStyle(document.getElementById('pd-ring')).display") == 'none', 'and it goes away again')
        # the color picker
        await page.evaluate("(() => { const o = document.getElementById('pd-op'); o.value = 'pick'; o.dispatchEvent(new Event('change', { bubbles: true })); })()")
        await page.wait_for_timeout(300)
        before = await page.evaluate("document.getElementById('pd-color').value")
        await touch('touchStart', [(cx - 150, cy - 100)]); await page.wait_for_timeout(250)
        await touch('touchMove', [(cx + 150, cy + 100)]); await page.wait_for_timeout(250)
        during = await page.evaluate("[document.getElementById('pd-color').value, document.getElementById('pd-status') ? document.getElementById('pd-status').textContent : '', getComputedStyle(document.getElementById('pd-ring')).display]")
        await touch('touchMove', [(cx + 160, cy + 100)]); await page.wait_for_timeout(100)
        await touch('touchEnd', []); await page.wait_for_timeout(300)
        after = await page.evaluate("document.getElementById('pd-color').value")
        ok(during[2] == 'block' and during[0] != before, 'while the finger is down the ring is shown and the Color box follows it (%s -> %s)' % (before, during[0]))
        ok(after != before and after != '', 'lifting takes the color (%s)' % after)
        await page.evaluate("document.getElementById('pd-color').value = '#123456'")
        await touch('touchStart', [(cx - 100, cy)]); await page.wait_for_timeout(250)
        await touch('touchMove', [(cx - 100, cy + 5)]); await page.wait_for_timeout(100)
        c1 = await page.evaluate("document.getElementById('pd-color').value")
        await touch('touchEnd', []); await page.wait_for_timeout(200)
        ok(c1 != '#123456', 'dragging changes the Color box before the finger is lifted (%s)' % c1)
        # the words on the screen suit a touch screen
        vis = await page.evaluate("""(() => { const out = []; document.querySelectorAll('#pd-modal *, #ui-head *').forEach(e => { if (e.children.length === 0 && e.offsetParent !== null && e.textContent.trim()) out.push(e.textContent.trim()); }); return out.join(' | '); })()""")
        bad = [w for w in ['Right or middle button', 'Left button', 'Hold X', 'Alt + wheel', 'Shift + wheel', 'Ctrl + Z', 'lift the mouse', 'Hold Shift'] if w in vis]
        ok(not bad, 'no mouse or keyboard words are shown (%s)' % bad)
        ok('One finger paints' in vis, 'the retouch help talks about fingers')
        await page.evaluate("(() => { const o = document.getElementById('pd-op'); o.value = 'clone'; o.dispatchEvent(new Event('change', { bubbles: true })); })()")
        await page.wait_for_timeout(300)
        ok(await page.evaluate("getComputedStyle(document.getElementById('pd-mark-src')).display") != 'none' and await page.evaluate("document.getElementById('pd-mark-src').offsetParent !== null"), 'the clone tool offers a button to mark the source')
        await touch('touchStart', [(cx, cy)]); await page.wait_for_timeout(250); await touch('touchEnd', []); await page.wait_for_timeout(300)
        st = await page.evaluate("document.getElementById('pd-status').textContent")
        ok('Source marked' in st, 'the first touch marks the clone source (%s)' % st[:60])
        ok(not errors, 'no page errors ' + str(errors))
        await b.close()
    print('ALL PASSED' if not fails else 'FAILED: ' + ', '.join(fails)); sys.exit(1 if fails else 0)

asyncio.run(main())
