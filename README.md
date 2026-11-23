# Simple Pano

Turn photos into a 360° panorama, or a wide partial one, in your browser. Shoot the pictures with your phone's camera or add photos you already have; Simple Pano aligns and blends them, lets you fix what went wrong, and saves a JPEG that panorama viewers show as 360°.

- **App:** https://pano.simple-apps.org/
- **Documentation:** https://pano.simple-apps.org/help.html
- **Learn more:** https://simple-apps.org/pano/

Everything runs in your browser. There are no accounts, and your photos are not uploaded anywhere unless you choose to send a retouching spot to an online AI provider.

## What it does

- **Shoot from the app** (phones and tablets): full sphere, 360° band or flat panorama. The gyro holds the pictures you already took in place as a translucent layer, dots show what is missing, and the phone shoots by itself when you hold still on a dot. Each picture is saved to Downloads before stitching.
- **Auto-align:** matches details between photos, then solves for each photo's direction, the lens's field of view and distortion, and exposure differences.
- **Blend and fix:** adjustable blending, priority per photo, brushing out ghosts and people so overlapping photos show through, a retouch window (local fill, clone, focus, light, color and more), a logo or round picture over the tripod, front and horizon controls.
- **Bake:** a whole sphere up to 16384 pixels wide as a JPEG with panorama (GPano) metadata, with empty edges cropped away if you wish; or a rectilinear or cylindrical window for partial panoramas.
- **View and retouch** any existing panorama, steering with the mouse, touch or the device's motion.
- **Installs to the Home Screen and works offline**, picking up new versions when it is online.

### AI is optional

AI is used for one job: filling a spot you painted in the retouch window. The local fill needs no AI. AI is off until you add a key. Providers: OpenAI, Google Gemini and OpenRouter (your own key, kept in your browser), or Stable Diffusion (AUTOMATIC1111 or Forge) and Ollama running on your own computer. When you send a spot to an online provider, the view, the painted area and your instruction go to that provider.

## Running it

It is a static site: no build step is needed to run it. Serve the folder with any web server and open `index.html`:

```
python3 -m http.server 8000
```

then browse to http://localhost:8000/. The camera, the motion sensors and the Home Screen install need a secure context, which means `https://` or `localhost`. Most of the app also works when `index.html` is opened from disk.

To publish it, upload the folder to any static host. Keep `sw.js` and `index.html` from being cached by the server (`Cache-Control: no-cache`), so that updates reach the devices that installed the app.

## Files

| File | What it is |
| --- | --- |
| `index.html` | The page and its layout |
| `pano_app.js` | The viewer, stitcher, retouch window and baking |
| `pano_shoot.js`, `pano_shoot.css` | Shooting from the camera |
| `pano_features.js`, `pano_align.js` | Feature matching and alignment (also run in a worker) |
| `pano_seams.js` | Local fill (also in a worker) |
| `stitch_ai.js` | AI providers for the fill |
| `pano.css` | Styles, built with Tailwind CSS 3 |
| `sw.js`, `manifest.webmanifest`, `icons/` | Home Screen install and offline use |
| `help.html` | The documentation |
| `vendor/` | Libraries kept with the app, so it makes no outside calls for them |
| `tests/` | Headless browser tests |

### Rebuilding the styles

`pano.css` is built from the classes used in the page and the scripts. After adding or changing classes (needs Node):

```
npm install tailwindcss@3
npx tailwindcss -c tailwind.config.js -i tailwind.input.css -o pano.css --minify
```

### Tests

The tests drive a real Chrome with Playwright, using a simulated camera and motion sensor where needed:

```
pip install playwright
playwright install chromium
python3 tests/shoot_test.py
```

Set `CHROME=/path/to/chrome` to use an installed browser. The other scripts in `tests/` cover opening files, flat backgrounds, the button toggle, touch retouching, cropping and offline use.

## Third-party software

Included in `vendor/`, each under the MIT license (the license texts are alongside):

- [three.js](https://threejs.org/) r128, including `DeviceOrientationControls`
- [exifr](https://github.com/MikeKovarik/exifr) 7.1.3 (lite build)

Styles are built with [Tailwind CSS](https://tailwindcss.com/) (MIT).

## License

Copyright © 2026 Francisco Ruiz

Simple Pano is free software: you can redistribute it and/or modify it under the terms of the GNU General Public License as published by the Free Software Foundation, either version 3 of the License, or (at your option) any later version.

It is distributed in the hope that it will be useful, but WITHOUT ANY WARRANTY; without even the implied warranty of MERCHANTABILITY or FITNESS FOR A PARTICULAR PURPOSE. See the [LICENSE](LICENSE) file for the full text, or <https://www.gnu.org/licenses/>.
