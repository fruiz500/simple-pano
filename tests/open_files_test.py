"""Headless test: Simple Pano opens pictures from any file, and refuses non-pictures with a message.

Run from the Simple Pano folder:   python3 tests/open_files_test.py
Needs:  pip install playwright  and  playwright install chromium
Optional: CHROME=/path/to/chrome to use an installed Chrome; SHOT=/some/prefix saves screenshots (ui_toggle_test).

For each of the three open buttons (photos, background panorama, logo) it chooses:
  1. a valid PNG named picture.png        -> must open
  2. the same PNG with no extension        -> must open
  3. the same PNG named picture.txt        -> must open (photos button)
  4. a text file named notes.txt           -> must show "could not be opened as a picture", no page error
"""
import asyncio, base64, os, sys, tempfile
from playwright.async_api import async_playwright

HERE = os.path.dirname(os.path.dirname(os.path.abspath(__file__)))
PNG = base64.b64decode('iVBORw0KGgoAAAANSUhEUgAAAEAAAAAwCAIAAAAuKetIAAAAV0lEQVR4Xu3RAQkAIQAEQTXXBzOiseRTLMJMgjt2nv2Nl62Xx/8cqClQU6CmQE2BmgI1BWoK1BSoKVBToKZATYGaAjUFagrUFKgpUFOgpkBNgZoCNQVqF6WIAdzFYK+7AAAAAElFTkSuQmCC')

async def main():
    tmp = tempfile.mkdtemp()
    files = {}
    for name, data in [('picture.png', PNG), ('picture', PNG), ('picture.txt', PNG), ('notes.txt', b'hello, this is not a picture')]:
        p = os.path.join(tmp, name); open(p, 'wb').write(data); files[name] = p
    fails = []
    def check(ok, what):
        print(('PASS ' if ok else 'FAIL ') + what)
        if not ok: fails.append(what)
    async with async_playwright() as pw:
        kw = {'args': ['--use-gl=angle', '--use-angle=swiftshader', '--enable-unsafe-swiftshader', '--allow-file-access-from-files']}
        if os.environ.get('CHROME'): kw['executable_path'] = os.environ['CHROME']
        b = await pw.chromium.launch(**kw)
        page = await b.new_page(viewport={'width': 1100, 'height': 700})
        errors = []
        page.on('pageerror', lambda e: errors.append(str(e)))
        await page.goto('file://' + HERE + '/index.html'); await page.wait_for_timeout(2500)
        msg = lambda: page.evaluate("document.getElementById('message-box').textContent")

        # accept attributes are gone (Android then shows its full Files picker)
        acc = await page.evaluate("[...document.querySelectorAll('input[type=file]')].filter(i => i.id !== 'poses-file' && i.hasAttribute('accept')).map(i => i.id)")
        check(acc == [], 'no accept attribute on the picture inputs')

        # photos
        for name, should in [('picture.png', True), ('picture', True), ('picture.txt', True), ('notes.txt', False)]:
            await page.set_input_files('#image-upload', files[name]); await page.wait_for_timeout(1500)
            m = await msg()
            if should: check(m.startswith('Added 1 image'), f'photos: {name} opens ({m!r})')
            else: check('could not be opened as a picture' in m, f'photos: {name} refused with a message ({m!r})')
            value = await page.evaluate("document.getElementById('image-upload').value")
            check(value == '', f'photos: the input is cleared after {name}')
        # photos: a mix of good and bad in one choice
        await page.set_input_files('#image-upload', [files['picture.png'], files['notes.txt']]); await page.wait_for_timeout(1500)
        m = await msg(); check(m.startswith('Added 1 image') and 'notes.txt' in m, f'photos: mixed choice names the bad file ({m!r})')

        # background panorama
        for name, should in [('picture', True), ('notes.txt', False)]:
            await page.set_input_files('#pano-upload', files[name]); await page.wait_for_timeout(1500)
            m = await msg()
            if should: check('Loaded' in m or 'This picture is not 2:1' in m, f'background: {name} opens ({m!r})')
            else: check('could not be opened as a picture' in m, f'background: {name} refused with a message ({m!r})')

        # logo
        for name, should in [('picture.txt', True), ('notes.txt', False)]:
            await page.evaluate("document.getElementById('message-box').textContent = ''")
            await page.set_input_files('#logo-file', files[name]); await page.wait_for_timeout(800)
            name_shown = await page.evaluate("document.getElementById('logo-name').textContent")
            m = await msg()
            if should: check(name_shown.startswith(name), f'logo: {name} opens ({name_shown!r})')
            else: check('could not be opened as a picture' in m, f'logo: {name} refused with a message ({m!r})')

        check(not errors, 'no page errors' + (': ' + '; '.join(errors) if errors else ''))
        await b.close()
    print('ALL PASSED' if not fails else f'{len(fails)} FAILED')
    sys.exit(1 if fails else 0)

asyncio.run(main())
