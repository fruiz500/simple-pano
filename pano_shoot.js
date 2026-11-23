/* Simple Pano: shoot the pictures with the phone's camera (touch devices only).
 *
 * The camera view shows a translucent copy of every picture taken so far, held in place by the gyro, plus
 * dots where pictures are still missing. Point at a dot, hold still, and the phone shoots by itself.
 *
 * window.PanoShoot.start({ fovLong, onDone(shots, info) })
 *   fovLong  guess for the camera's field of view along the long side of a picture, in degrees
 *   shots    [{ blob, name, yaw, pitch, roll }]  poses in the viewer's convention (first picture at yaw 180)
 *   info     { fovLong }  field of view measured from the live view, for the lens settings
 * Free software, GPL-3.0-or-later, like the rest of Simple Pano.
 */
(function () {
    'use strict';
    const DEG = Math.PI / 180;
    let T = null;                         // THREE, looked up when needed (this file loads before the viewer's own script)
    const OVERLAP_STEP = 0.68;            // distance between neighbor pictures, as a fraction of the field of view (about 30% overlap)
    const AIM_TOL = 0.12;                 // how close to a dot the view must be, as a fraction of the field of view
    const STILL_DPS = 9, STILL_MS = 350, COOLDOWN_MS = 900;

    const wrap180 = a => { a = ((a + 180) % 360 + 360) % 360 - 180; return a === -180 ? 180 : a; };
    const dirOf = (yawDeg, pitchDeg) => new T.Vector3(Math.cos(yawDeg * DEG) * Math.cos(pitchDeg * DEG), Math.sin(pitchDeg * DEG), Math.sin(yawDeg * DEG) * Math.cos(pitchDeg * DEG));
    const yawOf = v => Math.atan2(v.z, v.x) / DEG;
    const pitchOf = v => Math.asin(Math.max(-1, Math.min(1, v.y))) / DEG;
    const sleep = ms => new Promise(r => setTimeout(r, ms));

    function supported() {
        T = window.THREE;
        return !!(navigator.mediaDevices && navigator.mediaDevices.getUserMedia && T && T.DeviceOrientationControls && 'DeviceOrientationEvent' in window);
    }

    // Where the pictures should go. Returns [{yaw, pitch}] relative to the starting direction (yaw) and absolute pitch.
    function plan(mode, Fh, Fv, startPitch) {
        const sh = Fh * OVERLAP_STEP, sv = Fv * OVERLAP_STEP, out = [];
        if (mode === 'band') {
            const n = Math.max(3, Math.ceil(360 / sh));
            for (let k = 0; k < n; k++) out.push({ yaw: k * 360 / n, pitch: 0 });
        } else if (mode === 'sphere') {
            const rows = Math.max(2, Math.ceil(180 / sv));
            const order = [];
            for (let j = 0; j <= rows; j++) order.push(-90 + j * 180 / rows);
            order.sort((a, b) => Math.abs(a) - Math.abs(b) || b - a);            // horizon first, then up and down
            for (const p of order) {
                const n = Math.abs(p) > 89.5 ? 1 : Math.max(3, Math.ceil(360 * Math.cos(p * DEG) / sh));
                for (let k = 0; k < n; k++) out.push({ yaw: k * 360 / n, pitch: p });
            }
        }
        return out;
    }

    function start(opts) {
        if (document.getElementById('shoot')) return;
        T = window.THREE;
        const root = document.createElement('div');
        root.id = 'shoot';
        root.innerHTML = `
            <div id="shoot-menu" class="shoot-screen">
                <h2>Shoot a panorama</h2>
                <p>Keep the camera over one spot and turn your feet, not just your arms, so the lens stays put. Hold the phone upright.</p>
                <button data-mode="sphere"><b>Full sphere</b><span id="cnt-sphere">Everything around you, up and down</span></button>
                <button data-mode="band"><b>360° band</b><span id="cnt-band">One turn around, at eye level</span></button>
                <button data-mode="flat"><b>Flat panorama</b><span>Sweep in any direction; the pictures overlap</span></button>
                <label class="shoot-chk"><input type="checkbox" id="shoot-auto" checked> Shoot by itself when I hold still on a dot</label>
                <button id="shoot-cancel0" class="shoot-plain">Cancel</button>
            </div>
            <div id="shoot-cam" style="display:none">
                <video id="shoot-video" playsinline muted autoplay></video>
                <canvas id="shoot-gl"></canvas>
                <div id="shoot-cross"></div>
                <div id="shoot-arrow" style="display:none"></div>
                <div id="shoot-top"><button id="shoot-x" aria-label="Cancel">&#10005;</button><span id="shoot-count">0</span><span id="shoot-level"></span><button id="shoot-sound-btn" class="shoot-chip">Sound</button><button id="shoot-auto-btn" class="shoot-chip">Auto</button></div>
                <div id="shoot-hint"></div>
                <div id="shoot-bottom">
                    <button id="shoot-undo" class="shoot-side" aria-label="Delete the last picture">Undo</button>
                    <button id="shoot-shutter" aria-label="Take a picture"></button>
                    <button id="shoot-done" class="shoot-side">Done</button>
                </div>
                <div id="shoot-ask" style="display:none"><div><p id="shoot-ask-t"></p><button id="shoot-ask-yes"></button><button id="shoot-ask-no">Keep shooting</button></div></div>
            </div>`;
        document.body.appendChild(root);
        const $ = id => root.querySelector('#' + id);
        const S = { mode: null, auto: true, stream: null, track: null, ctl: null, cam: null, rend: null, scene: null, raf: 0,
            sound: true, shots: [], targets: [], yaw0: 0, Fh: 60, Fv: 45, busy: false, still: 0, lastT: 0, lastShot: 0, prevQ: new T.Quaternion(), speed: 99, base: 0, wake: null, pendingDone: false };
        const fovLong = opts.fovLong || 69;
        let ac = null, nextBeep = 0;
        try { ac = new (window.AudioContext || window.webkitAudioContext)(); if (ac.resume) ac.resume(); } catch (e) { ac = null; }       // made here, while the tap is fresh
        function beep(freq, ms, vol) {
            if (!ac || !S.sound) return;
            try {
                const o = ac.createOscillator(), g = ac.createGain(), t = ac.currentTime;
                o.frequency.value = freq; o.type = 'sine'; o.connect(g); g.connect(ac.destination);
                g.gain.setValueAtTime(0.0001, t); g.gain.exponentialRampToValueAtTime(vol || 0.25, t + 0.01); g.gain.exponentialRampToValueAtTime(0.0001, t + ms / 1000);
                o.start(t); o.stop(t + ms / 1000 + 0.02);
            } catch (e) { }
        }
        window.PanoShoot._state = S;                 // for the tests

        // approximate counts on the menu (portrait hold, 4:3 pictures)
        const gv = 2 * Math.atan(Math.tan(fovLong * DEG / 2) * 0.75) / DEG;     // portrait hold: the short side goes across
        const gHalf = fovLong;
        $('cnt-sphere').textContent = `Everything around you, up and down (about ${plan('sphere', gv, gHalf).length} pictures)`;
        $('cnt-band').textContent = `One turn around, at eye level (about ${plan('band', gv, gHalf).length} pictures)`;

        function close() {
            cancelAnimationFrame(S.raf);
            if (S.ctl) S.ctl.dispose();
            if (S.stream) S.stream.getTracks().forEach(t => t.stop());
            if (S.rend) S.rend.dispose();
            S.shots.forEach(s => s.tex && s.tex.dispose());
            if (S.wake) { try { S.wake.release(); } catch (e) { } }
            if (ac) { try { ac.close(); } catch (e) { } }
            root.remove();
        }
        $('shoot-cancel0').onclick = close;
        root.querySelectorAll('[data-mode]').forEach(b => b.onclick = () => begin(b.dataset.mode));

        async function begin(mode) {
            S.mode = mode; S.auto = $('shoot-auto').checked;
            try {
                if (typeof DeviceOrientationEvent.requestPermission === 'function') {             // iPhone and iPad ask first
                    if ((await DeviceOrientationEvent.requestPermission()) !== 'granted') throw new Error('Motion sensors are blocked. Allow motion and orientation access for this site, then try again.');
                }
                S.stream = await navigator.mediaDevices.getUserMedia({ audio: false, video: { facingMode: { ideal: 'environment' }, width: { ideal: 4032 }, height: { ideal: 3024 } } });
            } catch (e) {
                $('shoot-menu').querySelector('p').textContent = (e && e.name === 'NotAllowedError') ? 'The camera is blocked. Allow camera access for this site, then try again.' : (e.message || 'The camera could not be opened.');
                return;
            }
            S.track = S.stream.getVideoTracks()[0];
            const v = $('shoot-video');
            v.srcObject = S.stream;
            await v.play().catch(() => { });
            for (let i = 0; i < 50 && !v.videoWidth; i++) await sleep(100);
            if (!v.videoWidth) { S.stream.getTracks().forEach(t => t.stop()); $('shoot-menu').querySelector('p').textContent = 'The camera gave no picture.'; return; }
            try { S.wake = await navigator.wakeLock.request('screen'); } catch (e) { }
            $('shoot-menu').style.display = 'none';
            $('shoot-cam').style.display = 'block';
            if (!(await setupScene())) {
                S.stream.getTracks().forEach(t => t.stop());
                $('shoot-cam').style.display = 'none'; $('shoot-menu').style.display = 'flex';
                $('shoot-menu').querySelector('p').textContent = 'No motion sensor answered. Shooting needs a phone or tablet, and motion access allowed for this site.';
                return;
            }
            setAuto(S.auto);
            S.lastShot = performance.now() + 1200;               // a moment to settle before the first automatic picture
            S.raf = requestAnimationFrame(loop);
        }

        // ---- geometry of the live view
        function frameFov() {                    // field of view of the whole camera frame, across and up, in degrees
            const v = $('shoot-video'), fpx = Math.max(v.videoWidth, v.videoHeight) / 2 / Math.tan(fovLong * DEG / 2);
            return { Fh: 2 * Math.atan(v.videoWidth / 2 / fpx) / DEG, Fv: 2 * Math.atan(v.videoHeight / 2 / fpx) / DEG, fpx };
        }
        async function setupScene() {
            const v = $('shoot-video'), c = $('shoot-gl');
            S.cam = new T.PerspectiveCamera(60, 1, 0.05, 10);
            S.ctl = new T.DeviceOrientationControls(S.cam);
            S.rend = new T.WebGLRenderer({ canvas: c, alpha: true, antialias: true });
            S.rend.setClearColor(0x000000, 0);
            S.scene = new T.Scene();
            S.group = new T.Group(); S.scene.add(S.group);
            const hz = []; for (let k = 0; k <= 180; k++) hz.push(dirOf(k * 2, 0));                 // the horizon, held level by the gravity sensor
            const hl = new T.Line(new T.BufferGeometry().setFromPoints(hz), new T.LineBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.55, depthTest: false }));
            hl.renderOrder = 5; S.scene.add(hl);
            resize(); window.addEventListener('resize', resize);
            for (let i = 0; i < 40 && !(S.ctl.deviceOrientation && S.ctl.deviceOrientation.alpha != null); i++) await sleep(75);     // wait for the first sensor reading
            if (!(S.ctl.deviceOrientation && S.ctl.deviceOrientation.alpha != null)) { S.ctl.dispose(); S.rend.dispose(); S.ctl = null; S.rend = null; return false; }
            S.ctl.update();
            const f = new T.Vector3(0, 0, -1).applyQuaternion(S.cam.quaternion);
            S.yaw0 = yawOf(f);
            const fr = frameFov(); S.Fh = fr.Fh; S.Fv = fr.Fv;
            if (S.mode === 'flat') { S.base = Math.max(-60, Math.min(60, pitchOf(f))); S.cells = new Map(); addCell(0, 0); }
            else {
                S.targets = plan(S.mode, S.Fh, S.Fv).map(t => ({ yaw: S.yaw0 + t.yaw, pitch: t.pitch, done: false }));
                S.targets.forEach(addMarker);
            }
            hint();
            return true;
        }
        function resize() {
            const w = window.innerWidth, h = window.innerHeight, v = $('shoot-video');
            if (!S.rend) return;
            S.rend.setPixelRatio(Math.min(2, window.devicePixelRatio || 1));
            S.rend.setSize(w, h, false);
            const fr = frameFov(), cover = Math.max(w / v.videoWidth, h / v.videoHeight);
            S.cam.aspect = w / h;
            S.cam.fov = 2 * Math.atan(h / 2 / (fr.fpx * cover)) / DEG;     // matches what object-fit: cover shows
            S.cam.updateProjectionMatrix();
        }

        // ---- targets
        function addMarker(t) {
            const g = new T.RingGeometry(0.035, 0.05, 32);
            const m = new T.Mesh(g, new T.MeshBasicMaterial({ color: 0xffffff, transparent: true, opacity: 0.9, depthTest: false, side: T.DoubleSide }));
            m.position.copy(dirOf(t.yaw, t.pitch)); m.lookAt(0, 0, 0); m.renderOrder = 10;
            S.group.add(m); t.mesh = m;
        }
        function addCell(i, j) {                // flat mode: grid cell (i across, j up) next to the pictures already taken
            const key = i + ',' + j;
            if (S.cells.has(key)) return;
            const t = { i, j, yaw: S.yaw0 + i * S.Fh * OVERLAP_STEP, pitch: Math.max(-85, Math.min(85, S.base + j * S.Fv * OVERLAP_STEP)), done: false };
            S.cells.set(key, t); S.targets.push(t); addMarker(t);
        }
        function markCovered(q) {               // a picture taken with orientation q covers the dots near its center
            const inv = q.clone().invert(), tx = Math.tan(S.Fh * DEG / 2), ty = Math.tan(S.Fv * DEG / 2);
            for (const t of S.targets) {
                const l = dirOf(t.yaw, t.pitch).applyQuaternion(inv);
                if (l.z < -0.01 && Math.abs(l.x / -l.z) < tx * 0.5 && Math.abs(l.y / -l.z) < ty * 0.5) t.done = true;
            }
        }
        function rebuildTargets() {
            S.targets.forEach(t => { if (t.mesh) S.group.remove(t.mesh); });
            if (S.mode === 'flat') {
                S.targets = []; S.cells = new Map(); addCell(0, 0); settleFlat();
            } else {
                S.targets = plan(S.mode, S.Fh, S.Fv).map(t => ({ yaw: S.yaw0 + t.yaw, pitch: t.pitch, done: false }));
                S.targets.forEach(addMarker);
                S.shots.forEach(s => markCovered(s.q));
            }
        }
        function settleFlat() {                 // flat mode: dots appear next to the pictures taken
            for (let k = 0; k < 60; k++) {
                S.shots.forEach(s => markCovered(s.q));
                const n = S.targets.length;
                for (const t of S.targets.slice()) if (t.done) addNeighbors(t);
                if (S.targets.length === n) break;
            }
        }
        function addNeighbors(t) { addCell(t.i + 1, t.j); addCell(t.i - 1, t.j); addCell(t.i, t.j + 1); addCell(t.i, t.j - 1); }

        // ---- frame loop: orientation, markers, auto shutter
        function loop(now) {
            S.raf = requestAnimationFrame(loop);
            S.ctl.update();
            const q = S.cam.quaternion, dt = Math.max(1, now - (S.lastT || now - 16)) / 1000;
            S.speed = 0.6 * S.speed + 0.4 * (S.prevQ.angleTo(q) / DEG / dt);
            S.prevQ.copy(q); S.lastT = now;
            if (S.speed < STILL_DPS) S.still += dt * 1000; else S.still = 0;
            const f = new T.Vector3(0, 0, -1).applyQuaternion(q);
            let best = null, bestA = 1e9;
            for (const t of S.targets) {
                if (t.done) { if (t.mesh) t.mesh.visible = false; continue; }
                const a = f.angleTo(dirOf(t.yaw, t.pitch)) / DEG;
                if (a < bestA) { bestA = a; best = t; }
            }
            S.best = best; S.bestA = bestA;
            if (best !== S.lastBest) { S.lastBest = best; hint(); }
            const aimed = best && bestA < Math.max(2.5, S.Fh * AIM_TOL) || (S.mode === 'flat' && !S.shots.length);
            for (const t of S.targets) if (t.mesh && !t.done) { t.mesh.visible = true; t.mesh.material.color.setHex(t === best && aimed ? 0x22ff88 : 0xffffff); t.mesh.material.opacity = t === best ? 1 : 0.6; }
            $('shoot-cross').className = aimed ? 'on' : '';
            {   // how far the phone is tilted sideways
                const right = new T.Vector3(1, 0, 0).applyQuaternion(q), tilt = Math.asin(Math.max(-1, Math.min(1, right.y))) / DEG, el = $('shoot-level');
                if (Math.abs(f.y) > 0.96) { el.textContent = ''; }
                else { const lv = Math.abs(tilt) < 1.5; el.textContent = lv ? 'Level' : `Tilted ${Math.abs(tilt).toFixed(0)}° ${tilt > 0 ? 'left' : 'right'}`; el.className = lv ? 'ok' : (Math.abs(tilt) > 5 ? 'bad' : ''); }
            }
            if (best && Math.abs(best.pitch) > 80 && now > nextBeep) {           // straight up or down: the screen may not be visible, so guide by ear
                nextBeep = now + (aimed ? 90 : 150 + Math.min(90, bestA) * 8);
                beep(aimed ? 1300 : 400 + (90 - Math.min(90, bestA)) * 8, aimed ? 50 : 80);
            }
            arrow(best, aimed);
            if (S.auto && aimed && !S.busy && S.still > STILL_MS && now - S.lastShot > COOLDOWN_MS) snap();
            S.rend.render(S.scene, S.cam);
        }
        function arrow(t, aimed) {              // points toward the nearest missing picture when its dot is off the screen
            const a = $('shoot-arrow');
            if (!t || aimed) { a.style.display = 'none'; return; }
            const p = dirOf(t.yaw, t.pitch).project(S.cam), behind = dirOf(t.yaw, t.pitch).applyQuaternion(S.cam.quaternion.clone().invert()).z > 0;
            if (!behind && Math.abs(p.x) < 0.9 && Math.abs(p.y) < 0.9) { a.style.display = 'none'; return; }
            let x = p.x, y = p.y; if (behind) { x = -x; y = -y; }
            const ang = Math.atan2(-y, x);
            a.style.display = 'block'; a.style.transform = `translate(-50%,-50%) rotate(${ang}rad)`;
            const m = Math.max(Math.abs(x), Math.abs(y)) || 1, r = Math.min(1, 0.82 / m);
            a.style.left = (50 + 50 * x * r) + '%'; a.style.top = (50 - 50 * y * r) + '%';
        }

        // ---- shooting
        async function snap() {
            if (S.busy) return;
            S.busy = true; S.lastShot = performance.now();
            const q = S.cam.quaternion.clone();
            try {
                let blob = null;
                if (window.ImageCapture) {
                    try { const ic = new ImageCapture(S.track); const caps = await ic.getPhotoCapabilities().catch(() => null); blob = await ic.takePhoto(caps && caps.imageWidth ? { imageWidth: caps.imageWidth.max } : undefined); } catch (e) { blob = null; }
                }
                if (!blob) {                           // no still-photo support: use a frame of the live view
                    const v = $('shoot-video'), c = document.createElement('canvas');
                    c.width = v.videoWidth; c.height = v.videoHeight; c.getContext('2d').drawImage(v, 0, 0);
                    blob = await new Promise(r => c.toBlob(r, 'image/jpeg', 0.95));
                }
                const bmp = await createImageBitmap(blob);
                const v = $('shoot-video');
                const sideways = (bmp.width > bmp.height) !== (v.videoWidth > v.videoHeight);
                const tc = document.createElement('canvas'), k = 384 / Math.max(bmp.width, bmp.height);
                tc.width = Math.round(bmp.width * k); tc.height = Math.round(bmp.height * k);
                tc.getContext('2d').drawImage(bmp, 0, 0, tc.width, tc.height);
                if (bmp.close) bmp.close();
                const aspect = sideways ? tc.height / tc.width : tc.width / tc.height;     // across / up as the user sees it
                const tex = new T.CanvasTexture(tc);
                const wdt = 2 * Math.tan((sideways ? S.Fv : S.Fh) * DEG / 2), hgt = wdt / (tc.width / tc.height);
                const mesh = new T.Mesh(new T.PlaneGeometry(wdt, hgt), new T.MeshBasicMaterial({ map: tex, transparent: true, opacity: 0.45, depthTest: false, side: T.DoubleSide }));
                mesh.quaternion.copy(q); mesh.translateZ(-1); mesh.rotateZ(sideways ? Math.PI / 2 : 0); mesh.renderOrder = S.shots.length;
                S.group.add(mesh);
                S.shots.push({ blob, q, tex, mesh, sideways, aspect });
                if (S.mode === 'flat' && S.shots.length === 1) {       // the first picture is where the grid starts
                    const f0 = new T.Vector3(0, 0, -1).applyQuaternion(q);
                    S.yaw0 = yawOf(f0); S.base = Math.max(-60, Math.min(60, pitchOf(f0)));
                    S.targets.forEach(t => t.mesh && S.group.remove(t.mesh));
                    S.targets = []; S.cells = new Map(); addCell(0, 0);
                }
                if (S.mode === 'flat') settleFlat(); else markCovered(q);
                if (navigator.vibrate) navigator.vibrate(30);
                beep(1000, 60, 0.3);
                flash();
            } catch (e) { console.warn(e); hint('The picture could not be taken. ' + (e.message || '')); }
            S.busy = false; S.still = 0; hint();
        }
        function flash() { const c = $('shoot-cam'); c.classList.add('flash'); setTimeout(() => c.classList.remove('flash'), 120); }
        function undo() {
            const s = S.shots.pop(); if (!s) return;
            S.group.remove(s.mesh); s.tex.dispose();
            rebuildTargets(); hint();
        }
        function hint(msg) {
            const left = S.targets.filter(t => !t.done).length, n = S.shots.length;
            $('shoot-count').textContent = S.mode === 'flat' ? String(n) : `${n} / ${S.targets.length}`;
            $('shoot-done').classList.toggle('ready', n >= 2 && (S.mode === 'flat' || left === 0));
            if (msg) { $('shoot-hint').textContent = msg; return; }
            let t;
            if (S.mode === 'flat') t = n ? 'Turn toward a dot to add more. Tap Done when the picture is wide enough.' : 'Aim at the start of the scene and tap the button.';
            else t = left === 0 ? 'All pictures taken. Tap Done.' : (S.auto ? 'Aim at a dot and hold still. The round button shoots anywhere.' : 'Aim at a dot and tap the button.');
            if (S.best && Math.abs(S.best.pitch) > 80) t = 'Straight ' + (S.best.pitch > 0 ? 'up' : 'down') + ': listen. Faster beeps mean closer; a trill means hold still.';
            $('shoot-hint').textContent = t;
        }
        function setAuto(on) { S.auto = on; $('shoot-auto-btn').classList.toggle('on', on); $('shoot-auto-btn').textContent = on ? 'Auto: on' : 'Auto: off'; hint(); }

        $('shoot-shutter').onclick = async () => {                 // the round button shoots anywhere; a dot close to the view counts as taken
            const t = S.best, near = t && S.bestA < S.Fh * OVERLAP_STEP * 0.6;
            await snap();
            if (near && S.mode !== 'flat') { t.done = true; if (t.mesh) t.mesh.visible = false; hint(); }
        };
        $('shoot-undo').onclick = undo;
        $('shoot-auto-btn').onclick = () => setAuto(!S.auto);
        $('shoot-sound-btn').onclick = () => { S.sound = !S.sound; $('shoot-sound-btn').classList.toggle('on', S.sound); $('shoot-sound-btn').textContent = S.sound ? 'Sound: on' : 'Sound: off'; };
        $('shoot-sound-btn').classList.add('on'); $('shoot-sound-btn').textContent = 'Sound: on';
        const ask = (text, yes, fn) => { $('shoot-ask-t').textContent = text; $('shoot-ask-yes').textContent = yes; $('shoot-ask').style.display = 'flex'; $('shoot-ask-yes').onclick = () => { $('shoot-ask').style.display = 'none'; fn(); }; };
        $('shoot-ask-no').onclick = () => { $('shoot-ask').style.display = 'none'; };
        $('shoot-x').onclick = () => S.shots.length ? ask(`Throw away the ${S.shots.length} pictures taken?`, 'Throw away', close) : close();
        $('shoot-done').onclick = () => {
            if (S.shots.length < 2) { hint('Take at least two pictures first.'); return; }
            const left = S.targets.filter(t => !t.done).length;
            if (S.mode !== 'flat' && left) ask(`${left} dots are still missing. Finish anyway?`, 'Finish', finish); else finish();
        };

        async function finish() {
            if (S.pendingDone) return; S.pendingDone = true;
            const stamp = new Date(), p2 = n => String(n).padStart(2, '0');
            const base = `pano_${stamp.getFullYear()}${p2(stamp.getMonth() + 1)}${p2(stamp.getDate())}_${p2(stamp.getHours())}${p2(stamp.getMinutes())}${p2(stamp.getSeconds())}`;
            const shots = S.shots.map((s, k) => {
                const right = new T.Vector3(1, 0, 0).applyQuaternion(s.q), up = new T.Vector3(0, 1, 0).applyQuaternion(s.q), f = new T.Vector3(0, 0, -1).applyQuaternion(s.q);
                // viewer pose: same axes (x, y up, z); roll is the tilt of the picture's right edge from the horizontal
                const pitch = pitchOf(f), yaw = yawOf(f);
                const r0 = new T.Vector3(-Math.sin(yaw * DEG), 0, Math.cos(yaw * DEG)), u0 = new T.Vector3().crossVectors(r0, f);
                let roll = Math.cos(pitch * DEG) > 0.005 ? Math.atan2(-right.dot(u0), right.dot(r0)) / DEG : 0;
                if (s.sideways) roll += (window.screen && screen.orientation && screen.orientation.angle === 90 ? -90 : 90);
                return { blob: s.blob, name: `${base}_${p2(k + 1)}.jpg`, yaw: wrap180(180 + yaw - S.yaw0), pitch, roll: wrap180(roll) };
            });
            $('shoot-hint').textContent = 'Saving the pictures to Downloads...';
            for (const s of shots) {                    // each picture is kept as a file before stitching; they also show up in Google Photos
                const a = document.createElement('a');
                a.href = URL.createObjectURL(s.blob); a.download = s.name; document.body.appendChild(a); a.click(); a.remove();
                setTimeout(() => URL.revokeObjectURL(a.href), 60000);
                await sleep(350);
            }
            const info = { fovLong: Math.max(S.Fh, S.Fv) };
            close();
            opts.onDone(shots, info);
        }
    }

    window.PanoShoot = { start, supported, plan, _dirOf: dirOf };
})();
