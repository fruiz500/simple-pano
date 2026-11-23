"""Headless test: the app installs (manifest and service worker), runs without Internet, and picks up updates.

Run from the Simple Pano folder:   python3 tests/offline_test.py
Optional: CHROME=/path/to/chrome
"""
import asyncio, functools, http.server, os, shutil, socketserver, sys, tempfile, threading
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))

async def main():
    fails = []
    def ok(c, what):
        print(('PASS ' if c else 'FAIL ') + what)
        if not c: fails.append(what)
    site = tempfile.mkdtemp()
    for f in os.listdir(HERE):
        src = os.path.join(HERE, f)
        if f in ('tests', '.git'): continue
        (shutil.copytree if os.path.isdir(src) else shutil.copy)(src, os.path.join(site, f))
    class Q(http.server.SimpleHTTPRequestHandler):
        def log_message(self, *a): pass
    class S(socketserver.ThreadingTCPServer): allow_reuse_address = True; daemon_threads = True
    srv = S(('127.0.0.1', 0), functools.partial(Q, directory=site)); srv.daemon_threads = True
    threading.Thread(target=srv.serve_forever, daemon=True).start()
    port = srv.server_address[1]; url = f'http://localhost:{port}/index.html'
    async with async_playwright() as pw:
        kw = {'args': ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader']}
        if os.environ.get('CHROME'): kw['executable_path'] = os.environ['CHROME']
        b = await pw.chromium.launch(**kw)
        ctx = await b.new_context(viewport={'width': 390, 'height': 780}, has_touch=True, is_mobile=True)
        page = await ctx.new_page(); errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto(url); await page.wait_for_timeout(2500)
        await page.evaluate("navigator.serviceWorker.ready.then(() => 1)"); await page.wait_for_timeout(1500)
        ok(await page.evaluate("!!navigator.serviceWorker.controller || navigator.serviceWorker.ready.then(r => !!r.active)"), 'the service worker is active')
        keys = await page.evaluate("caches.open('simple-pano').then(c => c.keys()).then(k => k.map(r => new URL(r.url).pathname))")
        need = ['/index.html', '/pano_app.js', '/pano.css', '/vendor/three.min.js', '/vendor/exifr.lite.umd.js', '/pano_align.js', '/pano_features.js', '/pano_seams.js', '/icons/icon-512.png']
        ok(all(n in keys for n in need), f'every file is kept on the device ({len(keys)} files)' + str([n for n in need if n not in keys]))
        cdp = await ctx.new_cdp_session(page)
        inst = await cdp.send('Page.getInstallabilityErrors')
        ok(not [e for e in inst.get('installabilityErrors', []) if e['errorId'] != 'in-incognito'], 'the browser finds no reason against installing: ' + str(inst.get('installabilityErrors')))
        man = await cdp.send('Page.getAppManifest')
        ok(not man.get('errors') and 'Simple Pano' in man.get('data', ''), 'the manifest reads fine ' + str(man.get('errors')))
        # No Internet: the server is gone and the app still starts
        await page.reload(); await page.wait_for_timeout(1500)       # let the new copy be kept first
        await ctx.set_offline(True); srv.shutdown(); srv.server_close()
        page2 = await ctx.new_page(); page2.on('pageerror', lambda e: errors.append(str(e)))
        await page2.goto(url + '?x=1'); await page2.wait_for_timeout(3500)
        ok(await page2.title() == 'Simple Pano', 'offline: the page opens')
        ok(await page2.evaluate("!!window.__pano && window.__pano.THREE.REVISION > 0"), 'offline: the app starts (scripts, three.js, styles)')
        ok(await page2.evaluate("getComputedStyle(document.getElementById('ui-corner')).position") == 'fixed', 'offline: styling is in place')
        await page2.close()
        ok(not errors, 'no page errors ' + str(errors))
        # An update on the server shows up on the next visit
        await ctx.set_offline(False)
        open(os.path.join(site, 'index.html'), 'a').write('\n<!-- NEWER COPY -->\n')
        srv2 = S(('127.0.0.1', port), functools.partial(Q, directory=site))
        threading.Thread(target=srv2.serve_forever, daemon=True).start()
        page3 = await ctx.new_page(); await page3.goto(url); await page3.wait_for_timeout(2500)
        txt3 = await page3.evaluate("fetch('index.html').then(r => r.text())"); ok('NEWER COPY' in txt3, 'online: the newer copy from the server is used')
        srv2.shutdown()
        await ctx.set_offline(True)
        page4 = await ctx.new_page(); await page4.goto(url); await page4.wait_for_timeout(2500)
        ok('NEWER COPY' in await page4.evaluate("fetch('index.html').then(r => r.text())"), 'offline afterwards: the newer copy was kept')
        await b.close()
    print('ALL PASSED' if not fails else 'FAILED: ' + ', '.join(fails)); sys.exit(1 if fails else 0)
asyncio.run(main())
