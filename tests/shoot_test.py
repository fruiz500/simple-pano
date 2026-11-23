"""Headless test: Shoot from the camera (simulated camera and gyro).

Run from the Simple Pano folder:   python3 tests/shoot_test.py
Needs:  pip install playwright  and  playwright install chromium
Optional: CHROME=/path/to/chrome to use an installed Chrome; SHOT=/some/prefix saves screenshots.
"""
import asyncio, math, os, sys
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

FAKE = """
(() => {
  const cv = document.createElement('canvas'); cv.width = 480; cv.height = 640;     // a phone held upright
  const g = cv.getContext('2d'); let n = 0;
  setInterval(() => { n++; g.fillStyle = '#345'; g.fillRect(0, 0, 480, 640);
    for (let i = 0; i < 60; i++) { g.fillStyle = 'hsl(' + (i * 37) + ',60%,55%)'; g.fillRect((i * 97) % 440, (i * 211) % 600, 40, 40); }
    g.fillStyle = '#fff'; g.font = '30px sans-serif'; g.fillText('frame ' + n, 20, 40); }, 100);
  const stream = cv.captureStream(10);
  navigator.mediaDevices.getUserMedia = async () => stream;
  delete window.ImageCapture;                                                   // forces the frame-grab path
  let cur = [0, 0];
  window.__orient = (yaw, pitch) => { cur = [yaw, pitch]; };                    // phone held upright, looking at this heading and pitch
  setInterval(() => window.dispatchEvent(new DeviceOrientationEvent('deviceorientation', { alpha: ((-90 - cur[0]) % 360 + 360) % 360, beta: 90 + cur[1], gamma: 0, absolute: false })), 30);   // like the real sensor
})();
"""

async def main():
    fails = []
    def ok(c, what):
        print(('PASS ' if c else 'FAIL ') + what)
        if not c: fails.append(what)
    async with async_playwright() as pw:
        kw = {'args': ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files', '--use-fake-ui-for-media-stream']}
        if os.environ.get('CHROME'): kw['executable_path'] = os.environ['CHROME']
        b = await pw.chromium.launch(**kw)
        ctx = await b.new_context(viewport={'width': 390, 'height': 780}, has_touch=True, is_mobile=True, accept_downloads=True)
        await ctx.add_init_script(FAKE)
        page = await ctx.new_page()
        errors = []; downloads = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        page.on('download', lambda d: downloads.append(d.suggested_filename))
        await page.goto('file://' + HERE + '/index.html'); await page.wait_for_timeout(2500)
        ok(await page.evaluate("document.getElementById('shoot-btn').style.display") == 'flex', 'the Shoot button shows on a touch device')
        await page.evaluate("window.__orient(30, 0)"); await page.wait_for_timeout(200)
        await page.evaluate("document.getElementById('shoot-btn').click()"); await page.wait_for_timeout(400)
        txt = await page.inner_text('#cnt-sphere'); ok('pictures' in txt, 'menu shows picture counts: ' + txt)
        await page.evaluate("document.querySelector('[data-mode=band]').click()"); await page.wait_for_timeout(2500)
        count = await page.inner_text('#shoot-count'); N = int(count.split('/')[1])
        ok(N >= 6 and N <= 14, f'360 band plans a sensible number of pictures ({N})')
        ok((await page.inner_text('#shoot-level')) == 'Level', 'the level badge says Level for an upright phone')
        ok('Sound' in await page.inner_text('#shoot-sound-btn'), 'a Sound switch is there')
        if os.environ.get('SHOT'): await page.screenshot(path=os.environ['SHOT'] + '_shoot_start.png')
        # Take them all by pointing at each dot and holding still
        for k in range(N):
            await page.evaluate(f"window.__orient({30 + k * 360 / N}, 0)")
            for _ in range(40):
                await page.wait_for_timeout(250)
                if (await page.inner_text('#shoot-count')).startswith(f'{k + 1} /'): break
            ok((await page.inner_text('#shoot-count')).startswith(f'{k + 1} /'), f'picture {k + 1} was shot by itself')
            if k == N // 2 and os.environ.get('SHOT'): await page.screenshot(path=os.environ['SHOT'] + '_shoot_mid.png')
        ok('Tap Done' in await page.inner_text('#shoot-hint'), 'it says everything is done')
        # Undo gives the dot back
        await page.click('#shoot-undo'); await page.wait_for_timeout(300)
        ok((await page.inner_text('#shoot-count')).startswith(f'{N - 1} /'), 'Undo removes the last picture')
        await page.evaluate("window.__orient(30 + (%d) * 360 / %d + 40, 0)" % (N - 1, N)); await page.wait_for_timeout(600)
        await page.evaluate(f"window.__orient({30 + (N - 1) * 360 / N}, 0)")
        for _ in range(40):
            await page.wait_for_timeout(250)
            if (await page.inner_text('#shoot-count')).startswith(f'{N} /'): break
        ok((await page.inner_text('#shoot-count')).startswith(f'{N} /'), 'the last dot can be shot again')
        # Done: pictures are saved to Downloads and handed to the app
        await page.click('#shoot-done'); await page.wait_for_timeout(N * 450 + 2500)
        ok(len(downloads) == N, f'every picture was saved to Downloads ({len(downloads)} of {N})')
        ok(all(d.startswith('pano_') and d.endswith('.jpg') for d in downloads), 'file names look right: ' + (downloads[0] if downloads else ''))
        ok(await page.evaluate("!document.getElementById('shoot')"), 'the camera screen is gone')
        res = await page.evaluate("""(() => { const P = window.__pano; return P.images.map(i => ({ yaw: i.yaw, pitch: i.pitch, roll: i.roll, f: P.camBasis(i).f.toArray() })); })()""")
        ok(len(res) == N, f'{N} pictures reached the app')
        yaws = [r['yaw'] for r in res]
        step = 360 / N
        okc = all(abs(((yaws[k + 1] - yaws[k] - step + 540) % 360) - 180) < 1.0 for k in range(N - 1))
        ok(okc, 'yaw steps match the dots: ' + ', '.join('%.0f' % y for y in yaws))
        ok(abs(abs(yaws[0]) - 180) < 1 and all(abs(r['pitch']) < 1 and abs(r['roll']) < 1 for r in res), 'first picture at yaw 180, level, no roll')
        ok(all(abs(math.atan2(r['f'][2], r['f'][0]) * 180 / math.pi - r['yaw']) < 1 or abs(abs(math.atan2(r['f'][2], r['f'][0]) * 180 / math.pi - r['yaw']) - 360) < 1 for r in res), 'viewer shows each picture where its pose says')
        ok(await page.evaluate("window.__pano.lens.fovLong") > 20, 'lens field of view set')
        # Flat panorama: the grid starts where the first picture is taken and grows next to the pictures
        async def wait_count(n):
            for _ in range(40):
                await page.wait_for_timeout(250)
                if (await page.inner_text('#shoot-count')) == str(n): return True
            return False
        await page.evaluate("window.__orient(100, 10)"); await page.wait_for_timeout(300)
        await page.evaluate("document.getElementById('shoot-btn').click()"); await page.wait_for_timeout(300)
        await page.evaluate("document.querySelector('[data-mode=flat]').click()"); await page.wait_for_timeout(2500)
        ok(await wait_count(1), 'flat: first picture shot where the view rests')
        Fh, Fv = await page.evaluate("[PanoShoot._state.Fh, PanoShoot._state.Fv]")
        ok(await page.evaluate("PanoShoot._state.targets.filter(t => !t.done).length") == 4, 'flat: four dots appear around the first picture')
        await page.evaluate(f"window.__orient({100 + Fh * 0.68}, 10)")
        ok(await wait_count(2), 'flat: a picture to the side is shot')
        await page.evaluate(f"window.__orient({100 + Fh * 0.68}, {10 + Fv * 0.68})")
        ok(await wait_count(3), 'flat: a picture above is shot')
        await page.evaluate("window.__orient(100 - 100, 10)"); await page.wait_for_timeout(1500)       # far from any dot: nothing is shot
        ok(await page.inner_text('#shoot-count') == '3', 'flat: nothing is shot when no dot is near')
        await page.click('#shoot-done'); await page.wait_for_timeout(3 * 450 + 2500)
        r2 = await page.evaluate("window.__pano.images.slice(-3).map(i => [i.yaw, i.pitch])")
        ok(abs(r2[0][1] - 10) < 1 and abs(r2[2][1] - (10 + Fv * 0.68)) < 1 and abs(((r2[1][0] - r2[0][0] + 540) % 360) - 180 - Fh * 0.68) < 1, 'flat: poses match where the phone pointed ' + str([[round(a, 1), round(b, 1)] for a, b in r2]))
        # Full sphere: the pole is reachable (a fresh page, so the alignment above is not still running)
        await page.close(); page = await ctx.new_page()
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto('file://' + HERE + '/index.html'); await page.wait_for_timeout(2500)
        await page.evaluate("window.__orient(0, 0)"); await page.wait_for_timeout(300)
        await page.evaluate("document.getElementById('shoot-btn').click()"); await page.wait_for_timeout(300)
        await page.evaluate("document.querySelector('[data-mode=sphere]').click()"); await page.wait_for_timeout(2500)
        for _ in range(60):
            await page.wait_for_timeout(250)
            if (await page.inner_text('#shoot-count')).startswith('1 /'): break
        ok((await page.inner_text('#shoot-count')).startswith('1 /'), 'sphere: first picture shot')
        await page.evaluate("window.__orient(0, 90)")
        for _ in range(60):
            await page.wait_for_timeout(250)
            if (await page.inner_text('#shoot-count')).startswith('2 /'): break
        ok((await page.inner_text('#shoot-count')).startswith('2 /'), 'sphere: the picture straight up is shot')
        await page.evaluate("window.__orient(0, 0)"); await page.wait_for_timeout(300)
        await page.click('#shoot-x'); await page.wait_for_timeout(300); await page.click('#shoot-ask-yes'); await page.wait_for_timeout(300)
        ok(await page.evaluate("!document.getElementById('shoot')"), 'cancel throws the pictures away and closes')
        plan = await page.evaluate("PanoShoot.plan('sphere', 52, 69).length"); ok(20 <= plan <= 40, f'sphere plan size {plan}')
        ok(not errors, 'no page errors ' + str(errors))
        await b.close()
    print('ALL PASSED' if not fails else 'FAILED: ' + ', '.join(fails)); sys.exit(1 if fails else 0)

asyncio.run(main())
