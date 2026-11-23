// Simple Pano: the panorama viewer, stitcher and retouch window.
// Loaded as a classic script (not a module) so that it also works when index.html is opened from disk. three.js and exifr come from the vendor folder.
// Copyright (C) 2026 Francisco Ruiz
// SPDX-License-Identifier: GPL-3.0-or-later
'use strict';
(async () => {
    if (!window.THREE || !window.THREE.DeviceOrientationControls) throw new Error('three.js did not load. The vendor folder (three.min.js, DeviceOrientationControls.js, exifr.lite.umd.js) must be on the server next to index.html');
    const THREE = window.THREE;
    const TOUCH = !!(window.matchMedia && window.matchMedia('(hover: none)').matches);      // a touch screen: no mouse, no keyboard
    document.documentElement.classList.toggle('touch', TOUCH);
    const kb = (withKeys, touch) => TOUCH ? touch : withKeys;      // wording for a mouse and keyboard, and for touch
    const DeviceOrientationControls = THREE.DeviceOrientationControls;

    let camera, scene, renderer, sphereMesh, stitchSphere, outlineGroup;

    // Panning & Math
    let isUserInteracting = false;
    let onPointerDownMouseX = 0, onPointerDownMouseY = 0;
    let lon = 180, onPointerDownLon = 0;
    let lat = 0, onPointerDownLat = 0;
    let targetLon = 180, targetLat = 0;
    let phi = 0, theta = 0;

    // Workspace State
    let isDragMode = false;
    let raycaster = new THREE.Raycaster();
    let mouse = new THREE.Vector2();

    // Devices & Zoom
    let deviceControls = null;
    let isGyroEnabled = false;
    const minFov = 20, maxFov = 100;
    let initialPinchDistance = null, initialFov = null;
    let uiShow = () => { };   // uiShow(true) shows the buttons, uiShow(false) hides them (the three-bar button does the same)

    // =====================================================================
    //  STITCH MODEL
    //  Each image is a camera: pose (yaw, pitch, roll in degrees) + shared lens.
    //  World: y up. Yaw 0 looks along +x, yaw increases turning right (+z).
    //  Camera frame columns: right r, up u, forward f.
    //  R = Ry(-yaw) * Rz(pitch) * Rx(roll) applied to base r=(0,0,1), u=(0,1,0), f=(1,0,0).
    //  Lens: rectilinear, F_px = (longSide/2) / tan(fovLong/2), Panotools a,b,c radial
    //  polynomial (radius normalized by half the short side).
    // =====================================================================
    const DEG = Math.PI / 180;
    const lens = { fovLong: 69.4, a: 0, b: 0, c: 0, source: 'default' };
    let bgFlat = null;                                          // a background that is not a 360 x 180 panorama: { mesh, kind }, for looking at only
    let defaultBgTex = null, bgCustom = false, showStitch = true, bgTop = false, bgSeq = 0;
    let bgSrc = null, bgGen = 0, bgEdits = [], bgEdited = false, bgName = '';   // the editable full-size copy of the background panorama, see "Retouching the background panorama"
    let patches = [];         // Retouch patches: { id, name, basis, fov, w, h, canvas, alphaCanvas, tex, alphaTex, enabled }
    let patchSeq = 0, blackTex = null, pasteMat = null;
    const maskBrush = { on: false, stroke: null };   // declared early: the preview loop reads it during start-up
    let nativePano = 0;        // width of the full sphere at the photos' own resolution
    let renderBusy = 0;        // > 0 while a long render (bake, retouch view, fill) owns the GPU passes: the live preview waits
    // uniforms shared by the project and paste shaders (rectilinear crop mode)
    const rectU = { rectMode: { value: 0 }, cr: { value: new THREE.Vector3(1, 0, 0) }, cu: { value: new THREE.Vector3(0, 1, 0) }, cf: { value: new THREE.Vector3(0, 0, 1) }, cropF: { value: 1 }, cropSize: { value: new THREE.Vector2(1, 1) } };
    let images = [];          // { id, name, file, srcCanvas, w, h, yaw, pitch, roll, enabled, gain, tex, outline, truth, time }
    let selectedImg = null;
    let hoverImg = null;      // image under the mouse in Drag mode
    let hoverFill = null;     // translucent tint mesh drawn over the hovered image
    const dragPointer = { x: 0, y: 0 };   // last pointer position during a drag
    let activeDrag = null;    // { img, lon0, lat0, yaw0, pitch0 }
    let nextId = 1;
    let compositeDirty = true, interacting = false, interactTimer = null;
    let brushRect = null, lastCompW = 0;   // part of the preview to redraw after brushing, and the width of the last redraw
    let PREVIEW_HI = 4096; const PREVIEW_LO = 1024;
    // Preview width while photos are being moved: full quality unless the box under Display is unticked
    const previewMoving = () => { const c = document.getElementById('move-hq'); return c && !c.checked ? Math.min(PREVIEW_HI, 2048) : PREVIEW_HI; };
    const previewRTs = {};
    let passScene, passCam, passQuad, projectMat, normMat;

    const BASE_R = new THREE.Vector3(0, 0, 1), BASE_U = new THREE.Vector3(0, 1, 0), BASE_F = new THREE.Vector3(1, 0, 0);

    function camBasis(p) {
        if (p.basis) return p.basis;
        const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(p.roll * DEG, -p.yaw * DEG, p.pitch * DEG, 'YZX'));
        return { r: BASE_R.clone().applyQuaternion(q), u: BASE_U.clone().applyQuaternion(q), f: BASE_F.clone().applyQuaternion(q) };
    }
    function focalPx(img) { return Math.max(img.w, img.h) / 2 / Math.tan((img.fov || lens.fovLong) * DEG / 2); }
    // xn, yn in [-1, 1] across the image, yn up. Ignores lens distortion.
    function rayFromNorm(img, B, xn, yn) {
        const F = focalPx(img);
        return new THREE.Vector3().addScaledVector(B.r, xn * img.w / 2 / F).addScaledVector(B.u, yn * img.h / 2 / F).add(B.f).normalize();
    }
    function dirToNorm(img, B, d) {
        const cz = d.dot(B.f);
        if (cz <= 1e-6) return null;
        const F = focalPx(img);
        return { xn: d.dot(B.r) / cz * F / (img.w / 2), yn: d.dot(B.u) / cz * F / (img.h / 2), cz };
    }
    function lonLat(d) { return { lon: Math.atan2(d.z, d.x), lat: Math.asin(Math.max(-1, Math.min(1, d.y))) }; }
    function wrap180(a) { a = ((a + 180) % 360 + 360) % 360 - 180; return a === -180 ? 180 : a; }

    // ---------------- Shaders ----------------
    const QUAD_VS = `
        varying vec2 vUv;
        void main() { vUv = uv; gl_Position = vec4(position.xy, 0.0, 1.0); }
    `;
    // One pass per source image: for each equirect texel, find the source pixel and
    // accumulate (color * w, w) with a feathered weight (additive blending).
    // Direction of the equirect texel (default) or of a pixel of a rectilinear crop view (rectMode, used by Retouch).
    const DIR_GLSL = `
        varying vec2 vUv;
        uniform vec4 region;
        uniform float rectMode;
        uniform vec3 cr; uniform vec3 cu; uniform vec3 cf;   // crop camera right, up, forward
        uniform float cropF; uniform vec2 cropSize;
        vec3 viewDir() {
            if (rectMode > 0.5) {
                vec2 q = (region.xy + vUv * region.zw - 0.5) * cropSize;       // pixels from the middle of the whole view
                if (rectMode > 1.5) { float a = q.x / cropF; return normalize(cr * sin(a) + cf * cos(a) + cu * (q.y / cropF)); }   // cylindrical
                q /= cropF; return normalize(cr * q.x + cu * q.y + cf);       // rectilinear
            }
            vec2 st = region.xy + vUv * region.zw;
            float lonA = 2.0 * 3.14159265358979 * st.x;
            float pol = 3.14159265358979 * (1.0 - st.y);
            return vec3(cos(lonA) * sin(pol), cos(pol), sin(lonA) * sin(pol));
        }
    `;
    const PROJECT_FS = `
        uniform sampler2D map;
        uniform mat3 Rt;        // rows: right, up, forward (world -> camera)
        uniform float F;        // focal length in source pixels
        uniform vec2 size;      // source width, height in pixels
        uniform vec3 abc;       // Panotools a, b, c
        uniform float gain;
        uniform float boost;    // > 1 makes this image dominate the blend (used to show the selected image solid)
        uniform float band;     // 0 = low band (blurred color, broad feather), 1 = high band (detail, sharply peaked weights)
        uniform float lodBias;  // extra mip level used for the blur of the low band
        uniform float sharp;    // exponent of the high band weights (1 = plain feathering)
        uniform float prio;     // blend priority of this image (1 = normal, > 1 wins more of the overlap)
        uniform sampler2D maskMap;   // white = this image must not be used here (painted exclusion), black elsewhere
        #define PI 3.14159265358979
        ${DIR_GLSL}
        void main() {
            vec3 d = viewDir();
            vec3 c = Rt * d;
            if (c.z <= 1e-6) discard;
            vec2 p = c.xy / c.z * F;
            float rn = length(p) / (0.5 * min(size.x, size.y));
            float sc = ((abc.x * rn + abc.y) * rn + abc.z) * rn + (1.0 - abc.x - abc.y - abc.z);
            p *= sc;
            vec2 uv = vec2(0.5 + p.x / size.x, 0.5 + p.y / size.y);
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
            float f = min(uv.x, 1.0 - uv.x) * min(uv.y, 1.0 - uv.y) * 4.0;     // 0 at the image edge .. 1 in the middle
            float mk = texture2D(maskMap, uv).r;
            f *= mix(1.0, 0.002, mk);
            float bst = mix(boost, 1.0, mk);       // a brushed-out part loses the solid boost: its removal is visible at once
            if (band < 0.5) {
                float w = f * bst * prio + 1e-4;
                vec3 col = texture2D(map, uv, lodBias).rgb * gain;
                gl_FragColor = vec4(col * w, w);
            } else {
                float w = max(pow(f, sharp), 1e-3) * bst * prio;
                vec3 detail = (texture2D(map, uv).rgb - texture2D(map, uv, lodBias).rgb) * gain;
                gl_FragColor = vec4(detail * w, w);
            }
        }
    `;
    // Retouch patches: drawn over the blended result with normal alpha blending.
    const PASTE_FS = `
        uniform sampler2D pmap;    // patch color
        uniform sampler2D pal;     // patch opacity (red channel)
        uniform mat3 Rt;
        uniform float F;
        uniform vec2 size;
        ${DIR_GLSL}
        void main() {
            vec3 c = Rt * viewDir();
            if (c.z <= 1e-6) discard;
            vec2 p = c.xy / c.z * F;
            vec2 uv = vec2(0.5 + p.x / size.x, 0.5 + p.y / size.y);
            if (uv.x < 0.0 || uv.x > 1.0 || uv.y < 0.0 || uv.y > 1.0) discard;
            float a = texture2D(pal, uv).r;
            if (a < 0.002) discard;
            gl_FragColor = vec4(texture2D(pmap, uv).rgb, a);
        }
    `;
    const NORM_FS = `
        uniform sampler2D acc;
        uniform sampler2D acc2;   // high band accumulator (only used when useHigh = 1)
        uniform float useHigh;
        uniform float bake;
        varying vec2 vUv;
        void main() {
            vec4 s = texture2D(acc, vUv);
            if (s.a < 1e-6) { gl_FragColor = vec4(0.0, 0.0, 0.0, bake); return; }
            vec3 c = s.rgb / s.a;
            if (useHigh > 0.5) { vec4 h = texture2D(acc2, vUv); if (h.a > 1e-6) c += h.rgb / h.a; }
            gl_FragColor = vec4(c, 1.0);
        }
    `;

    // Equirect layers (background and stitch) are drawn by working out the longitude and latitude of every screen pixel in the
    // fragment shader. Interpolating the mesh UVs instead smears the texture into radial streaks in the polar caps.
    const EQ_VS = `
        varying vec3 vDir;
        void main() { vDir = position; gl_Position = projectionMatrix * modelViewMatrix * vec4(position, 1.0); }
    `;
    // The equirect texture seen along direction d (shared by the viewer and by the background retouch view).
    const EQ_SAMPLE = `
        vec4 eqSample(sampler2D map, vec3 d) {
            float a = atan(d.z, d.x) * 0.15915494309;            // longitude / 2π, jumps where it passes ±0.5
            float b = fract(a);                                  // same, jumps where it passes 0
            float v = asin(clamp(d.y, -1.0, 1.0)) * 0.31830988618 + 0.5;
        #if __VERSION__ >= 300
            // a and b differ by a whole number, so their screen derivatives agree except across the jump of one of them: take the
            // smaller. (Choosing between a and b first and then differentiating mixes them between neighboring pixels: noise.)
            float ax = dFdx(a), bx = dFdx(b), ay = dFdy(a), by = dFdy(b);
            vec2 gx = vec2(abs(ax) < abs(bx) ? ax : bx, dFdx(v)), gy = vec2(abs(ay) < abs(by) ? ay : by, dFdy(v));
            return textureGrad(map, vec2(b, v), gx, gy);
        #else
            return texture2D(map, vec2(b, v));
        #endif
        }
    `;
    const EQ_FS = `
        uniform sampler2D map;
        uniform float alpha;
        varying vec3 vDir;
        ${EQ_SAMPLE}
        void main() {
            vec4 c = eqSample(map, normalize(vDir));
            gl_FragColor = vec4(c.rgb, c.a * alpha);
        }
    `;
    // A material that behaves like MeshBasicMaterial({ map, opacity }) for the callers (.map, .opacity), drawn with EQ_FS.
    function makeEquirectMaterial(tex, transparent) {
        const m = new THREE.ShaderMaterial({ uniforms: { map: { value: tex }, alpha: { value: 1 } }, vertexShader: EQ_VS, fragmentShader: EQ_FS, transparent: !!transparent, depthWrite: !transparent });
        Object.defineProperty(m, 'map', { get() { return this.uniforms.map.value; }, set(v) { this.uniforms.map.value = v; }, configurable: true });
        Object.defineProperty(m, 'opacity', { get() { return this.uniforms.alpha.value; }, set(v) { this.uniforms.alpha.value = v; }, configurable: true });
        return m;
    }
    // Sharp at the poles and across the seam: anisotropic filtering, and wrap-around in longitude (needs WebGL2). Call before first use.
    function prepEquirectTexture(t) {
        if (!t || !renderer) return t;
        t.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
        if (renderer.capabilities.isWebGL2) t.wrapS = THREE.RepeatWrapping;
        return t;
    }

    init();
    pdInit();
    animate();

    function init() {
        const container = document.getElementById('canvas-container');

        // Setup Scene & Camera
        camera = new THREE.PerspectiveCamera(75, window.innerWidth / window.innerHeight, 1, 2000);
        scene = new THREE.Scene();

        // Master Background Sphere
        const geometry = new THREE.SphereGeometry(500, 120, 80);
        geometry.scale(-1, 1, 1);
        const material = makeEquirectMaterial(generateProceduralEquirectangularTexture(), false);
        defaultBgTex = material.map;
        sphereMesh = new THREE.Mesh(geometry, material);
        scene.add(sphereMesh);

        // Stitch layer: equirect composite shown on a slightly smaller sphere
        const sg = new THREE.SphereGeometry(490, 180, 90);
        sg.scale(-1, 1, 1);
        stitchSphere = new THREE.Mesh(sg, makeEquirectMaterial(null, true));
        stitchSphere.visible = false;
        scene.add(stitchSphere);

        outlineGroup = new THREE.Group();
        outlineGroup.renderOrder = 10;
        scene.add(outlineGroup);

        // Renderer
        renderer = new THREE.WebGLRenderer({ antialias: true, preserveDrawingBuffer: true });
        renderer.setPixelRatio(window.devicePixelRatio);
        renderer.setSize(window.innerWidth, window.innerHeight);
        container.appendChild(renderer.domElement);
        if (renderer.capabilities.maxTextureSize < 8192) PREVIEW_HI = 2048;
        prepEquirectTexture(defaultBgTex);
        if (!renderer.capabilities.isWebGL2 && !renderer.extensions.get('OES_texture_half_float')) {
            showMessage('Warning: this browser lacks float render targets; stitching may fail.');
        }

        // Offscreen passes for compositing / baking
        passScene = new THREE.Scene();
        passCam = new THREE.OrthographicCamera(-1, 1, 1, -1, 0, 1);
        blackTex = new THREE.DataTexture(new Uint8Array([0, 0, 0, 255]), 1, 1, THREE.RGBAFormat);
        blackTex.needsUpdate = true;
        projectMat = new THREE.ShaderMaterial({
            uniforms: Object.assign({
                map: { value: null }, maskMap: { value: blackTex }, Rt: { value: new THREE.Matrix3() }, F: { value: 1 },
                size: { value: new THREE.Vector2(1, 1) }, abc: { value: new THREE.Vector3() },
                gain: { value: 1 }, boost: { value: 1 }, band: { value: 0 }, lodBias: { value: 0 }, sharp: { value: 1 }, prio: { value: 1 }, region: { value: new THREE.Vector4(0, 0, 1, 1) }
            }, rectU),
            vertexShader: QUAD_VS, fragmentShader: PROJECT_FS,
            blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
            blendSrc: THREE.OneFactor, blendDst: THREE.OneFactor,
            blendSrcAlpha: THREE.OneFactor, blendDstAlpha: THREE.OneFactor,
            depthTest: false, depthWrite: false
        });
        pasteMat = new THREE.ShaderMaterial({
            uniforms: Object.assign({
                pmap: { value: null }, pal: { value: null }, Rt: { value: new THREE.Matrix3() }, F: { value: 1 },
                size: { value: new THREE.Vector2(1, 1) }, region: projectMat.uniforms.region
            }, rectU),
            vertexShader: QUAD_VS, fragmentShader: PASTE_FS,
            blending: THREE.CustomBlending, blendEquation: THREE.AddEquation,
            blendSrc: THREE.SrcAlphaFactor, blendDst: THREE.OneMinusSrcAlphaFactor,
            blendSrcAlpha: THREE.ZeroFactor, blendDstAlpha: THREE.OneFactor,
            depthTest: false, depthWrite: false
        });
        normMat = new THREE.ShaderMaterial({
            uniforms: { acc: { value: null }, acc2: { value: null }, useHigh: { value: 0 }, bake: { value: 0 } },
            vertexShader: QUAD_VS, fragmentShader: NORM_FS,
            blending: THREE.NoBlending, depthTest: false, depthWrite: false
        });
        passQuad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), projectMat);
        passQuad.frustumCulled = false;
        passScene.add(passQuad);

        // Events
        renderer.domElement.addEventListener('pointerdown', onPointerDown);
        renderer.domElement.addEventListener('pointermove', onCanvasHover);
        renderer.domElement.addEventListener('pointerleave', () => {
            if (activeDrag) return;
            setHover(null);
            document.getElementById('hover-label').style.display = 'none';
        });
        makeHoverFill();
        renderer.domElement.addEventListener('contextmenu', e => e.preventDefault());
        renderer.domElement.addEventListener('wheel', onMouseWheel, { passive: false });
        renderer.domElement.addEventListener('touchstart', onTouchStart, { passive: false });
        renderer.domElement.addEventListener('touchmove', onTouchMove, { passive: false });
        window.addEventListener('resize', onWindowResize);
        window.addEventListener('keydown', onKeyDown);

        // UI Buttons
        document.getElementById('gyro-btn').addEventListener('click', toggleGyro);
        const shootBtn = document.getElementById('shoot-btn');
        if (TOUCH && window.PanoShoot && PanoShoot.supported()) {          // only on phones and tablets with a camera and motion sensors
            shootBtn.style.display = 'flex';
            shootBtn.addEventListener('click', () => {
                let fov = NaN; try { fov = parseFloat(localStorage.getItem('pano.shootFov')); } catch (e) { }
                PanoShoot.start({
                    fovLong: fov > 20 && fov < 140 ? fov : 69,
                    onDone: async (shots, info) => {
                        const files = shots.map(sh => { const f = new File([sh.blob], sh.name, { type: sh.blob.type || 'image/jpeg' }); f.shotPose = { yaw: sh.yaw, pitch: sh.pitch, roll: sh.roll }; return f; });
                        if (lens.source !== 'user') { lens.fovLong = info.fovLong; lens.source = 'camera preview (estimate)'; document.getElementById('lens-fov').value = lens.fovLong.toFixed(1); }
                        await addFiles(files);
                        showMessage(`${files.length} pictures saved in Downloads. Aligning them...`);
                        await runAutoAlign();
                    }
                });
            });
        }
        document.getElementById('fullscreen-btn').addEventListener('click', toggleFullscreen);
        document.addEventListener('fullscreenchange', () => {
            document.getElementById('fullscreen-btn').classList.toggle('tog-on', !!document.fullscreenElement);
            if (document.fullscreenElement) { setPanel(false); uiShow(false); }      // full screen is for looking: the panel and the buttons go; the three-bar button brings them back
        });
        document.getElementById('panel-btn').classList.toggle('tog-on', !document.getElementById('properties-panel').classList.contains('hidden'));

        document.getElementById('pano-upload').addEventListener('change', handlePanoUpload);
        document.getElementById('bg-clear').addEventListener('click', () => {
            if (bgEdited && !confirm('The background panorama has retouching that is not saved. Remove it anyway?')) return;
            clearBackground(); showMessage('Background panorama removed');
        });
        document.getElementById('bg-save').addEventListener('click', saveBgPano);
        document.getElementById('bg-save-top').addEventListener('click', saveBgPano);
        document.getElementById('bg-undo').addEventListener('click', bgUndoLast);
        document.getElementById('rt-open-bg-btn').addEventListener('click', openBgRetouch);
        document.getElementById('front-btn').addEventListener('click', setFrontToView);
        document.getElementById('logo-choose').addEventListener('click', () => document.getElementById('logo-file').click());
        document.getElementById('logo-file').addEventListener('change', e => { const f = e.target.files[0]; e.target.value = ''; if (f) logoChoose(f); });
        document.getElementById('logo-place').addEventListener('click', logoPlace);
        document.getElementById('logo-remove').addEventListener('click', logoRemove);
        document.getElementById('bg-top').addEventListener('change', e => setBgTop(e.target.checked));
        document.getElementById('stitch-show').addEventListener('change', e => { showStitch = e.target.checked; compositeDirty = true; updateOutlines(); stitchSphere.visible = showStitch && images.some(i => i.enabled && i.tex); });
        document.getElementById('remove-all-btn').addEventListener('click', removeAllPhotos);
        document.getElementById('image-upload').addEventListener('change', handleImageUpload);
        document.getElementById('outline-chk').addEventListener('change', updateOutlines);
        document.getElementById('nudge-yaw').addEventListener('input', handleNudgeChange);
        document.getElementById('nudge-pitch').addEventListener('input', handleNudgeChange);
        document.getElementById('nudge-roll').addEventListener('input', handleNudgeChange);
        document.getElementById('sel-enabled').addEventListener('change', e => {
            if (selectedImg) { selectedImg.enabled = e.target.checked; touch(); }
        });
        document.getElementById('lens-fov').addEventListener('input', e => {
            const v = parseFloat(e.target.value);
            if (v > 1 && v < 179) { lens.fovLong = v; lens.source = 'user'; updateLensInfo(); touch(); }
        });
        document.getElementById('swap-poles-btn').addEventListener('click', flipPoles);
        document.getElementById('align-all-btn').addEventListener('click', () => runAutoAlign());
        document.getElementById('sel-prio').addEventListener('input', e => {
            if (!selectedImg) return;
            selectedImg.prio = Math.pow(2, parseFloat(e.target.value));
            updateSelectionUI(); touch();
        });
        document.getElementById('snap-btn').addEventListener('click', snapSelected);
        document.getElementById('blend-slider').addEventListener('input', e => {
            document.getElementById('blend-val').textContent = e.target.value;
            compositeDirty = true;
        });
        document.getElementById('poses-save-btn').addEventListener('click', savePoses);
        document.getElementById('poses-load-btn').addEventListener('click', () => document.getElementById('poses-file').click());
        document.getElementById('poses-file').addEventListener('change', e => { if (e.target.files[0]) loadPoses(e.target.files[0]); e.target.value = ''; });

        document.getElementById('remove-img-btn').addEventListener('click', handleRemoveImage);
        document.getElementById('close-props-btn').addEventListener('click', () => setPanel(false));
        document.getElementById('panel-btn').addEventListener('click', () => setPanel(document.getElementById('properties-panel').classList.contains('hidden')));

        const modeBtn = document.getElementById('mode-btn');
        modeBtn.addEventListener('click', () => setDragMode(!isDragMode));
        if (window.matchMedia && window.matchMedia('(pointer: coarse)').matches) modeBtn.style.display = '';   // touch only

        document.getElementById('bake-btn').addEventListener('click', bakeEquirectangular);
        for (const id of ['bake-proj', 'bake-hfov', 'bake-vfov']) document.getElementById(id).addEventListener('input', () => { if (id === 'bake-proj') winUI(); updateWinSize(); });
        document.getElementById('level-btn').addEventListener('click', () => horizonStart());
        document.getElementById('level-undo').addEventListener('click', horizonUndo);
        winUI();

        setupIdleFader();
        updateSelectionUI();

        // Debug/test handle
        window.__pano = { THREE, findCrop, images, lens, camBasis, makeTestSet, checkVsTruth, bakeEquirectangular, applyLayout, renderer, get selected() { return selectedImg; }, get bgImage() { return sphereMesh.material.map.image; }, setOpacity: v => { stitchSphere.material.opacity = v; } };
    }

    function setDragMode(on) {
        isDragMode = on;
        if (!on) {
            setHover(null);
            document.getElementById('hover-label').style.display = 'none';
        }
        const modeBtn = document.getElementById('mode-btn');
        modeBtn.querySelector('span').textContent = isDragMode ? 'Mode: Move photos' : 'Mode: Look';
        modeBtn.className = isDragMode
            ? 'bg-amber-600 hover:bg-amber-500 border border-amber-400 text-white font-semibold py-2 px-5 rounded-xl shadow-lg transition-all duration-300 flex items-center gap-2'
            : 'bg-indigo-600 hover:bg-indigo-500 border border-indigo-400 text-white font-semibold py-2 px-5 rounded-xl shadow-lg transition-all duration-300 flex items-center gap-2';
    }

    function setPanel(open) {
        document.getElementById('properties-panel').classList.toggle('hidden', !open);
        document.body.classList.toggle('panel-open', !!open);      // small screens: the title and button rows give way to the panel
        uiShow(true);
        const pb = document.getElementById('panel-btn'); if (pb) pb.classList.toggle('tog-on', !!open);
    }

    // Mark the composite as changed: fast low-res preview now, full-res shortly after.
    function touch() {
        interacting = true;
        refreshImageList();
        compositeDirty = true;
        updateOutlines();
        updateFitBadge();
        clearTimeout(interactTimer);
        interactTimer = setTimeout(() => { interacting = false; compositeDirty = true; }, 300);
    }

    // ---------------- Loading ----------------

    function handlePanoUpload(event) {
        const file = event.target.files[0];
        event.target.value = '';
        if (!file) return;
        if (bgEdited && !confirm('The background panorama has retouching that is not saved. Replace it anyway?')) return;
        const imgURL = URL.createObjectURL(file);
        const seq = ++bgSeq;
        new THREE.TextureLoader().load(imgURL, (texture) => {
            URL.revokeObjectURL(imgURL);
            if (seq !== bgSeq) { texture.dispose(); return; }
            const shape = classifyPicture(texture.image);
            if (shape.kind !== 'equirect') {
                installFlatBackground(texture, shape, file.name);
                showMessage(shape.note);
                uiShow(false);
                return;
            }
            installBackground(prepEquirectTexture(texture), null, file.name);
            showMessage("Background Panorama Loaded");
            uiShow(false);                                      // the picture is what the person came to see
        }, undefined, () => { URL.revokeObjectURL(imgURL); if (seq === bgSeq) showMessage('That file could not be opened as a picture: ' + file.name); });
    }
    // Make tex the background panorama (the one before it is freed). full = its full-size canvas when we have one (a bake).
    function installBackground(tex, full, name) {
        dropFlatBackground();
        if (bgCustom && sphereMesh.material.map) sphereMesh.material.map.dispose();
        if (bgSrc) { if (bgSrc.disp !== bgSrc.canvas) bgSrc.disp.width = bgSrc.disp.height = 0; bgSrc.canvas.width = bgSrc.canvas.height = 0; }
        bgSrc = full ? { canvas: full, disp: tex.image } : null;
        bgGen++; bgEdits = []; bgEdited = false; bgName = name || '';
        sphereMesh.material.map = tex;
        sphereMesh.material.needsUpdate = true;
        bgCustom = true; document.getElementById('bg-clear').style.display = '';
        setBgTop(bgTop);                                        // keeps the tick box in step (it is enabled only with a background)
        bgUI();
    }
    function clearBackground() {
        bgSeq++; bgGen++;                                       // a panorama that is still loading is dropped
        dropFlatBackground();
        if (bgCustom && sphereMesh.material.map) sphereMesh.material.map.dispose();
        if (bgSrc) { if (bgSrc.disp !== bgSrc.canvas) bgSrc.disp.width = bgSrc.disp.height = 0; bgSrc.canvas.width = bgSrc.canvas.height = 0; }
        bgSrc = null; bgEdits = []; bgEdited = false; bgName = '';
        sphereMesh.material.map = defaultBgTex; sphereMesh.material.needsUpdate = true;
        bgCustom = false; document.getElementById('bg-clear').style.display = 'none';
        setBgTop(false);
        bgUI();
    }
    // ---------------- A background that is not a 360 x 180 panorama ----------------
    // A picture that is not 2:1 is not equirectangular: stretched over the sphere it would be badly deformed. A picture whose
    // left and right edges continue into each other is a full turn around (a cylinder); a wide one is part of a turn (phone
    // panoramas); anything else is an ordinary photo (flat). These are shown for looking at: the editing tools need a sphere.
    function edgesMatch(img) {
        const w = Math.min(img.width, 512), h = Math.min(Math.max(32, Math.round(w * img.height / img.width)), 128);
        const c = document.createElement('canvas'); c.width = w; c.height = h;
        const g = c.getContext('2d', { willReadFrequently: true }); g.drawImage(img, 0, 0, w, h);
        const d = g.getImageData(0, 0, w, h).data;
        const col = x => { const o = []; for (let y = 0; y < h; y++) { const i = (y * w + x) * 4; o.push(d[i], d[i + 1], d[i + 2]); } return o; };
        const diff = (a, b) => { let t = 0; for (let i = 0; i < a.length; i++) t += Math.abs(a[i] - b[i]); return t / a.length; };
        let inside = 0, n = 0;
        for (let x = 0; x < w - 1; x++) { inside += diff(col(x), col(x + 1)); n++; }
        inside /= n;
        const seam = diff(col(w - 1), col(0));
        c.width = c.height = 0;
        return seam <= Math.max(2 * inside, 4) && seam < 14;       // the seam is about as smooth as the rest of the picture
    }
    function classifyPicture(img) {
        const w = img.naturalWidth || img.width, h = img.naturalHeight || img.height, a = w / h;
        if (Math.abs(a - 2) <= 0.2) return { kind: 'equirect', a };
        let seam = false;
        try { seam = edgesMatch(img); } catch (e) { seam = false; }
        if (seam && a >= 1.7 && a <= 2.3) return { kind: 'equirect', a };
        if (seam && a > 2.3) return { kind: 'cylinder360', a, note: 'This picture is not 2:1, but its left and right edges continue into each other, so it is shown as a full cylindrical panorama. The editing tools need a 2:1 equirectangular panorama.' };
        if (a > 2.3) return { kind: 'cylinder', a, note: 'This picture is not 2:1, so it is shown as a cylindrical panorama (a vertical field of view of about 60° is assumed). The editing tools need a 2:1 equirectangular panorama.' };
        return { kind: 'flat', a, note: 'This picture is not 2:1, so it is shown flat, like a photo in front of you. The editing tools need a 2:1 equirectangular panorama.' };
    }
    function dropFlatBackground() {
        if (!bgFlat) return;
        scene.remove(bgFlat.mesh);
        bgFlat.mesh.geometry.dispose();
        if (bgFlat.mesh.material.map) bgFlat.mesh.material.map.dispose();
        bgFlat.mesh.material.dispose();
        bgFlat = null; sphereMesh.visible = true;
    }
    function installFlatBackground(texture, shape, name) {
        const img = texture.image, R = 500, vf = 2 * Math.tan(30 * Math.PI / 180) * R;      // a height that is seen under 60°
        const full = document.createElement('canvas'); full.width = img.naturalWidth || img.width; full.height = img.naturalHeight || img.height;
        full.getContext('2d').drawImage(img, 0, 0);
        texture.dispose();
        const disp = bgDisplayCanvas(full);
        if (disp !== full) full.width = full.height = 0;
        const tex = new THREE.CanvasTexture(disp);
        tex.anisotropy = Math.min(16, renderer.capabilities.getMaxAnisotropy());
        let geo;
        if (shape.kind === 'flat') {
            geo = new THREE.PlaneGeometry(vf * shape.a, vf);
            geo.translate(0, 0, R);
        } else {
            const full360 = shape.kind === 'cylinder360' || shape.a * vf / R >= 2 * Math.PI;
            const th = full360 ? 2 * Math.PI : shape.a * vf / R, hh = full360 ? 2 * Math.PI * R / shape.a : vf;
            geo = new THREE.CylinderGeometry(R, R, hh, 180, 1, true, -th / 2, th);
        }
        geo.scale(-1, 1, 1);                                    // seen from inside, and not mirrored
        dropFlatBackground();
        if (bgCustom) clearBackground();
        const mesh = new THREE.Mesh(geo, new THREE.MeshBasicMaterial({ map: tex, side: THREE.FrontSide }));
        const d = THREE.MathUtils.degToRad(targetLon);          // the middle of the picture is where the person is looking
        mesh.rotation.y = Math.atan2(Math.cos(d), Math.sin(d)); targetLat = 0;
        scene.add(mesh);
        bgFlat = { mesh, kind: shape.kind, name };
        sphereMesh.visible = false;
        document.getElementById('bg-clear').style.display = '';
        bgName = name || '';
        setBgTop(bgTop);
        bgUI();
    }
    // The background panorama in front of the stitched photos (to inspect a baked result) or behind them (normal).
    function setBgTop(on) {
        bgTop = !!on && (bgCustom || !!bgFlat);
        const c = document.getElementById('bg-top');
        if (c) { c.checked = bgTop; c.disabled = !(bgCustom || bgFlat); }
        sphereMesh.scale.setScalar(bgTop ? 0.97 : 1);           // radius 485, in front of the stitch sphere (490)
        if (bgFlat) bgFlat.mesh.scale.setScalar(bgTop ? 0.97 : 1);
        if (bgTop && maskBrush.on) setMaskBrush(false);          // the brush works on the photos, which are now hidden
        if (bgTop) setHover(null);
        updateOutlines();
    }
    // Buttons that need a background panorama, an edit to undo, or an unsaved edit.
    function bgUI() {
        $('rt-open-bg-btn').disabled = !bgCustom;
        $('bg-save').disabled = !bgCustom;
        $('bg-undo').disabled = !bgEdits.length;
        pdRefreshEdits();
        $('bg-save-top').style.display = bgCustom && bgEdited ? '' : 'none';
        $('ui-corner').classList.toggle('dirty', !!(bgCustom && bgEdited));      // an amber dot: there is retouching to save
    }
    // The picture the texture shows: the full canvas, or a copy of at most 8192 across (a 16k panorama would need over 1 GB of video memory).
    function bgDisplayCanvas(full) {
        const cap = Math.min(8192, renderer.capabilities.maxTextureSize);
        if (full.width <= cap) return full;
        const d = document.createElement('canvas'); d.width = cap; d.height = Math.round(cap * full.height / full.width);
        d.getContext('2d').drawImage(full, 0, 0, d.width, d.height);
        return d;
    }
    // After a bake: show the picture that was just made, on top of the photos, without loading it from disk. The canvas is kept
    // (the retouching below edits it and Save writes it out).
    async function showBakedResult(canvas) {
        if (bgEdited && !confirm('The background panorama has retouching that is not saved. Replace it with the new bake?')) { canvas.width = canvas.height = 0; return; }
        bgSeq++;
        bgTop = true;
        installBackground(prepEquirectTexture(new THREE.CanvasTexture(bgDisplayCanvas(canvas))), canvas, 'simple_pano');
    }

    // ---------------- Retouching the background panorama ----------------
    // The retouch window works on a rectilinear view of the panorama; an accepted result is painted back into the panorama itself.
    // A loaded picture gets its editable full-size canvas the first time it is needed.
    function ensureBgCanvas() {
        if (!bgCustom) return null;
        if (bgSrc) return bgSrc;
        const im = sphereMesh.material.map.image;
        const full = document.createElement('canvas'); full.width = im.naturalWidth || im.width; full.height = im.naturalHeight || im.height;
        full.getContext('2d').drawImage(im, 0, 0);
        const disp = bgDisplayCanvas(full), old = sphereMesh.material.map;
        sphereMesh.material.map = prepEquirectTexture(new THREE.CanvasTexture(disp)); sphereMesh.material.needsUpdate = true;
        old.dispose();
        bgSrc = { canvas: full, disp };
        return bgSrc;
    }
    function bgRefreshDisplay() {
        if (!bgSrc) return;
        if (bgSrc.disp !== bgSrc.canvas) bgSrc.disp.getContext('2d').drawImage(bgSrc.canvas, 0, 0, bgSrc.disp.width, bgSrc.disp.height);
        sphereMesh.material.map.needsUpdate = true;
    }
    let bgViewScene = null, bgViewMat = null;
    // A rectilinear window onto the background panorama, S x S, as a canvas (the same kind of picture renderView gives for the photos).
    async function renderBgView(basis, fov, S) {
        if (!bgViewMat) {
            bgViewMat = new THREE.ShaderMaterial({
                uniforms: { map: { value: null }, cr: { value: new THREE.Vector3() }, cu: { value: new THREE.Vector3() }, cf: { value: new THREE.Vector3() }, cropF: { value: 1 }, cropSize: { value: new THREE.Vector2(1, 1) } },
                vertexShader: QUAD_VS,
                fragmentShader: `
                    uniform sampler2D map; uniform vec3 cr; uniform vec3 cu; uniform vec3 cf; uniform float cropF; uniform vec2 cropSize;
                    varying vec2 vUv;
                    ${EQ_SAMPLE}
                    void main() { vec2 q = (vUv - 0.5) * cropSize / cropF; gl_FragColor = vec4(eqSample(map, normalize(cr * q.x + cu * q.y + cf)).rgb, 1.0); }
                `
            });
            bgViewScene = new THREE.Scene();
            const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgViewMat); quad.frustumCulled = false; bgViewScene.add(quad);
        }
        const v = { w: S, h: S, basis, fov }, u = bgViewMat.uniforms;
        u.map.value = sphereMesh.material.map;
        u.cr.value.copy(basis.r); u.cu.value.copy(basis.u); u.cf.value.copy(basis.f); u.cropF.value = focalPx(v); u.cropSize.value.set(S, S);
        const rt = makeOutRT(S, S), buf = new Uint8Array(S * S * 4);
        try {
            renderer.setRenderTarget(rt); renderer.render(bgViewScene, passCam); renderer.readRenderTargetPixels(rt, 0, 0, S, S, buf);
        } finally { renderer.setRenderTarget(null); rt.dispose(); }
        const cv = document.createElement('canvas'); cv.width = cv.height = S;
        const ctx = cv.getContext('2d'), id = ctx.createImageData(S, S);
        for (let r = 0; r < S; r++) id.data.set(buf.subarray(r * S * 4, (r + 1) * S * 4), (S - 1 - r) * S * 4);
        ctx.putImageData(id, 0, 0);
        cv.coverage = new Uint8Array(S * S).fill(1);
        return cv;
    }
    async function openBgRetouch() {
        if (!bgCustom) { showMessage('Load a background panorama first, or bake one.'); return; }
        const fov = Math.max(20, Math.min(120, parseFloat($('rt-fov').value) || 70));
        const basis = viewBasis($('rt-view').value);
        try {
            const base = await renderBgView(basis, fov, 1024);
            setBgTop(true);                                     // so the edit can be seen in the main view
            $('message-box').classList.add('hidden');
            pdOpen({ mode: 'retouch', target: 'bg', title: 'Retouch the background panorama', base, basis, fov, coverage: base.coverage });
        } catch (e) { showMessage('Could not render the view: ' + (e.message || e)); }
    }
    // Edits are applied one at a time (several queued spots can finish together).
    // Every edit is kept as a record: its patch (color and opacity, seen from its view) and the pixels it replaced. That lets each one be
    // taken out or put back later: the edits after it are undone, and the ones still kept are painted again in their order.
    const BG_EDITS_MAX = 16;
    let bgApplyChain = Promise.resolve();
    function bgQueueOp(fn) { const p = bgApplyChain.then(fn); bgApplyChain = p.catch(() => { }); return p; }
    function applyPatchToBg(basis, fov, S, H, color, alpha, label, fx, tb) {
        const id = ++patchSeq;
        const e = { id, name: label || ((tb ? (tb === 'all' ? 'Restore' : 'Take back') : fx ? FX_NAME[fx.op] : 'Edit') + ' ' + id), basis: { r: basis.r.clone(), u: basis.u.clone(), f: basis.f.clone() }, fov, w: S, h: H, canvas: fx || tb ? null : color, alphaCanvas: alpha, fx: fx ? Object.assign({}, fx) : null, tb: tb || null, enabled: true, applied: false, before: [], gen: bgGen };
        return bgQueueOp(async () => {
            if (e.gen !== bgGen) throw new Error('the background panorama was replaced');
            await bgPaintEdit(e);
            if (e.tb && !e.changed) { bgRestoreEdit(e); throw new Error('Nothing to take back there: none of the edits in the list touched those pixels.'); }
            bgEdits.push(e);
            if (bgEdits.length > BG_EDITS_MAX) { const o = bgEdits.shift(); o.before = []; }          // the oldest stays in the panorama for good
            bgEdited = true;
            bgRefreshDisplay(); setBgTop(true); bgUI();
            return e;
        });
    }
    // What a take-back edit needs to know about an earlier edit: where it acted (its opacity, seen from its own view) and the pixels it replaced.
    function bgEdCtx(o) {
        if (!o._a8) {
            const d = o.alphaCanvas.getContext('2d').getImageData(0, 0, o.w, o.h).data, a8 = new Uint8Array(o.w * o.h);
            for (let i = 0; i < a8.length; i++) a8[i] = d[i * 4];
            o._a8 = a8;
        }
        return { e: o, a8: o._a8, S: o.w, H: o.h, F: focalPx({ basis: o.basis, fov: o.fov, w: o.w, h: o.h }), r: o.basis.r, u: o.basis.u, f: o.basis.f };
    }
    // Paint an edit into the panorama's own pixels, remembering what was there.
    async function bgPaintEdit(e) {
        const sr = ensureBgCanvas();
        if (!sr) throw new Error('There is no background panorama to edit.');
        const W = sr.canvas.width, HH = sr.canvas.height, ctx = sr.canvas.getContext('2d'), S = e.w, H = e.h, basis = e.basis, fov = e.fov;
        const pp = { basis, fov, w: S, h: H }, F = focalPx(pp), fp = footprint(pp), r = basis.r, u = basis.u, f = basis.f;
        const y0 = Math.max(0, Math.floor((0.5 - fp.lat1 / Math.PI) * HH) - 1), y1 = Math.min(HH - 1, Math.ceil((0.5 - fp.lat0 / Math.PI) * HH) + 1);
        let xs;                                                  // column ranges [from, to) of the panorama that the patch can touch
        if (!isFinite(fp.lon0)) xs = [[0, W]];
        else {
            const xa = Math.floor(fp.lon0 / (2 * Math.PI) * W) - 1, n = Math.min(W, Math.ceil(fp.lon1 / (2 * Math.PI) * W) + 2 - xa), st = ((xa % W) + W) % W;
            xs = st + n <= W ? [[st, st + n]] : [[st, W], [0, st + n - W]];
        }
        const efx = e.fx, tb = e.tb, cd = efx || tb ? null : e.canvas.getContext('2d').getImageData(0, 0, S, H).data, ad = e.alphaCanvas.getContext('2d').getImageData(0, 0, S, H).data;
        // A take-back edit: each pixel goes back to what it was before the newest earlier edit that acted there ('all': before the oldest one).
        let tbc = null;
        if (tb) {
            const t = bgEdits.indexOf(e), top = t < 0 ? bgEdits.length : t; tbc = []; e.changed = false;
            for (let q = top - 1; q >= 0; q--) { const o = bgEdits[q]; if (o.tb || o.enabled === false || !o.applied || !o.before.length) continue; tbc.push(bgEdCtx(o)); }     // newest first
        }
        // Clone: the source pixels are read from a copy of the panorama as it is now (before this edit changes it)
        let cloneSample = null;
        if (efx && efx.op === 'clone' && efx.off) {
            const hh = y1 - y0 + 1, chunks = xs.map(([xa, xb]) => ({ x: xa, w: xb - xa, d: ctx.getImageData(xa, y0, xb - xa, hh).data }));
            const px = (X, Y, i, out) => {          // one texel into out (weight i of the four), false when it is not in the copy
                X = ((X % W) + W) % W; Y = Math.max(y0, Math.min(y1, Y));
                for (const c of chunks) if (X >= c.x && X < c.x + c.w) { const q = ((Y - y0) * c.w + X - c.x) * 4; out[0] += c.d[q] * i; out[1] += c.d[q + 1] * i; out[2] += c.d[q + 2] * i; return true; }
                return false;
            };
            cloneSample = (Xf, Yf, out) => {
                const ix = Math.floor(Xf), iy = Math.floor(Yf), tx = Xf - ix, ty = Yf - iy;
                out[0] = out[1] = out[2] = 0;
                return px(ix, iy, (1 - tx) * (1 - ty), out) && px(ix + 1, iy, tx * (1 - ty), out) && px(ix, iy + 1, (1 - tx) * ty, out) && px(ix + 1, iy + 1, tx * ty, out);
            };
        }
        const cs = [0, 0, 0];
        const prog = Progress.start('Painting into the panorama');
        e.before = [];
        try {
            const total = xs.reduce((a, [x0, x1]) => a + (x1 - x0), 0) * (y1 - y0 + 1); let done = 0;
            for (const [xa, xb] of xs) {
                const w = xb - xa, h = y1 - y0 + 1, id = ctx.getImageData(xa, y0, w, h), o = id.data;
                e.before.push({ x: xa, y: y0, img: new ImageData(new Uint8ClampedArray(o), w, h) });
                const ref = efx && fxBlurs(efx.op) ? blurRGBA(o, w, h, efx.radius) : null;
                const cl = new Float64Array(w), sl = new Float64Array(w);
                for (let i = 0; i < w; i++) { const lon = (xa + i + 0.5) / W * 2 * Math.PI; cl[i] = Math.cos(lon); sl[i] = Math.sin(lon); }
                for (let j = 0; j < h; j++) {
                    const lat = (0.5 - (y0 + j + 0.5) / HH) * Math.PI, cy = Math.cos(lat), dy = Math.sin(lat);
                    for (let i = 0; i < w; i++) {
                        const dx = cy * cl[i], dz = cy * sl[i];
                        const zc = dx * f.x + dy * f.y + dz * f.z; if (zc <= 1e-6) continue;
                        const ux = 0.5 + (dx * r.x + dy * r.y + dz * r.z) / zc * F / S, uy = 0.5 + (dx * u.x + dy * u.y + dz * u.z) / zc * F / H;
                        if (ux < 0 || ux > 1 || uy < 0 || uy > 1) continue;
                        const fx = Math.min(S - 1.001, Math.max(0, ux * S - 0.5)), fy = Math.min(H - 1.001, Math.max(0, (1 - uy) * H - 0.5));
                        const ix = fx | 0, iy = fy | 0, tx = fx - ix, ty = fy - iy, q = (iy * S + ix) * 4, q2 = q + S * 4;
                        const w00 = (1 - tx) * (1 - ty), w10 = tx * (1 - ty), w01 = (1 - tx) * ty, w11 = tx * ty;
                        const a = (ad[q] * w00 + ad[q + 4] * w10 + ad[q2] * w01 + ad[q2 + 4] * w11) / 255;
                        if (a < 0.004) continue;
                        const k = (j * w + i) * 4;
                        if (tb) {
                            const X = xa + i, Y = y0 + j; let sv = null, si = 0;
                            for (const c of tbc) {
                                const z2 = dx * c.f.x + dy * c.f.y + dz * c.f.z; if (z2 <= 1e-6) continue;
                                const vx = 0.5 + (dx * c.r.x + dy * c.r.y + dz * c.r.z) / z2 * c.F / c.S, vy = 0.5 + (dx * c.u.x + dy * c.u.y + dz * c.u.z) / z2 * c.F / c.H;
                                if (vx < 0 || vx > 1 || vy < 0 || vy > 1) continue;
                                if (c.a8[Math.min(c.H - 1, ((1 - vy) * c.H) | 0) * c.S + Math.min(c.S - 1, (vx * c.S) | 0)] < 2) continue;     // that edit did not act here
                                for (const pc of c.e.before) if (X >= pc.x && X < pc.x + pc.img.width && Y >= pc.y && Y < pc.y + pc.img.height) { sv = pc.img.data; si = ((Y - pc.y) * pc.img.width + X - pc.x) * 4; break; }
                                if (sv && tb === 'last') break;
                            }
                            if (sv) { for (let c = 0; c < 3; c++) o[k + c] = o[k + c] * (1 - a) + sv[si + c] * a; e.changed = true; }
                            continue;
                        }
                        if (efx && efx.op === 'clone') {
                            if (!cloneSample) continue;
                            const spx = ux * S + efx.off.x, spy = (1 - uy) * H + efx.off.y;          // where the copy comes from, in the view
                            if (spx < 0 || spx > S || spy < 0 || spy > H) continue;
                            const sx = (spx / S - 0.5) * S / F, sy = ((1 - spy / H) - 0.5) * H / F, ex = r.x * sx + u.x * sy + f.x, ey = r.y * sx + u.y * sy + f.y, ez = r.z * sx + u.z * sy + f.z;
                            const el = Math.hypot(ex, ey, ez); let lo = Math.atan2(ez, ex); if (lo < 0) lo += 2 * Math.PI;
                            const Xf = lo / (2 * Math.PI) * W - 0.5, Yf = (0.5 - Math.asin(Math.max(-1, Math.min(1, ey / el))) / Math.PI) * HH - 0.5;
                            if (!cloneSample(Xf, Yf, cs)) continue;
                            const g = efx.amount * a;
                            for (let c = 0; c < 3; c++) o[k + c] += (cs[c] - o[k + c]) * g;
                            continue;
                        }
                        if (efx) { fxPix(efx, o, k, a, ref); continue; }
                        for (let c = 0; c < 3; c++) o[k + c] = o[k + c] * (1 - a) + (cd[q + c] * w00 + cd[q + 4 + c] * w10 + cd[q2 + c] * w01 + cd[q2 + 4 + c] * w11) * a;
                    }
                    if ((j & 63) === 63) { done += 64 * w; Progress.update(prog, 'Painting into the panorama', Math.min(1, done / total)); await new Promise(res => setTimeout(res, 0)); }
                }
                ctx.putImageData(id, xa, y0);
            }
            e.applied = true;
        } finally { Progress.end(prog); }
    }
    function bgRestoreEdit(e) {
        const ctx = bgSrc.canvas.getContext('2d');
        for (const pc of e.before) ctx.putImageData(pc.img, pc.x, pc.y);
        e.applied = false;
    }
    // Take an edit out (on = false) or put it back (on = true): the edits from it on are undone, then the kept ones painted again.
    function bgSetEnabled(e, on) {
        return bgQueueOp(async () => {
            const i = bgEdits.indexOf(e);
            if (i < 0 || !bgSrc) return;
            e.busy = true;
            try {
                for (let k = bgEdits.length - 1; k >= i; k--) if (bgEdits[k].applied) bgRestoreEdit(bgEdits[k]);
                e.enabled = on;
                for (let k = i; k < bgEdits.length; k++) if (bgEdits[k].enabled !== false) await bgPaintEdit(bgEdits[k]);
            } finally { e.busy = false; }
            bgEdited = true;
            bgRefreshDisplay(); bgUI();
        });
    }
    async function bgDeleteEdit(e) {
        await bgSetEnabled(e, false);
        const i = bgEdits.indexOf(e); if (i >= 0) bgEdits.splice(i, 1);
        e.before = []; bgUI();
    }
    function bgUndoLast() {
        const e = bgEdits[bgEdits.length - 1];
        if (!e) { bgUI(); return Promise.resolve(); }
        return bgDeleteEdit(e).then(() => showMessage('Took back ' + e.name + (bgEdits.length ? '' : ' (no more edits to undo)')));
    }
    // Save the retouched panorama. Where the browser can (Chrome, Edge), a save dialog lets you pick the folder and the name;
    // elsewhere the name is asked for and the browser saves it to its download folder.
    async function saveBgPano() {
        const sr = ensureBgCanvas();
        if (!sr) { showMessage('There is no background panorama to save.'); return; }
        let name = (bgName || 'simple_pano').replace(/\.[^.]+$/, '').replace(/_retouched$/, '') + '_retouched.jpg', handle = null;
        if (window.showSaveFilePicker) {                       // must be called straight from the click
            try { handle = await showSaveFilePicker({ suggestedName: name, types: [{ description: 'JPEG picture', accept: { 'image/jpeg': ['.jpg', '.jpeg'] } }] }); }
            catch (e) { if (e && e.name === 'AbortError') return; handle = null; }
            if (handle) name = handle.name;
        } else {
            const typed = prompt('File name to save (the browser saves it in its download folder):', name);
            if (typed === null) return;
            name = /\.jpe?g$/i.test(typed.trim()) ? typed.trim() : typed.trim() + '.jpg';
        }
        const prog = Progress.start('Saving the panorama');
        try {
            Progress.update(prog, 'Encoding the JPEG...', null);
            await new Promise(res => setTimeout(res, 30));
            const W = sr.canvas.width, HH = sr.canvas.height;
            const blob = await new Promise(res => sr.canvas.toBlob(res, 'image/jpeg', 0.95));
            if (!blob) { showMessage('JPEG encoding failed (image too large for this browser).'); return; }
            const final = Math.abs(W / HH - 2) < 0.01 ? await addGPanoXMP(blob, W, HH) : blob;      // panorama metadata only for a 2:1 picture
            if (handle) {
                const w = await handle.createWritable(); await w.write(final); await w.close();
            } else {
                const link = document.createElement('a');
                link.download = name;
                link.href = URL.createObjectURL(final);
                link.click();
                setTimeout(() => URL.revokeObjectURL(link.href), 10000);
            }
            bgEdited = false; bgUI();
            showMessage(`Saved ${name}: ${W} × ${HH}`);
        } finally { Progress.end(prog); }
    }

    function loadImageElement(file) {
        return new Promise((resolve, reject) => {
            const url = URL.createObjectURL(file);
            const im = new Image();
            im.onload = () => resolve(im);
            im.onerror = () => { URL.revokeObjectURL(url); reject(new Error('Cannot decode ' + file.name)); };
            im.src = url;
        });
    }

    // Returns a canvas of the (EXIF-oriented) image, scaled so its long side <= maxDim.
    async function sourceCanvas(img, maxDim) {
        let src, sw, sh;
        if (img.srcCanvas) { src = img.srcCanvas; sw = src.width; sh = src.height; }
        else { src = await loadImageElement(img.file); sw = src.naturalWidth; sh = src.naturalHeight; }
        const s = Math.min(1, maxDim / Math.max(sw, sh));
        if (s === 1 && img.srcCanvas) return { canvas: src, sw, sh };
        const cv = document.createElement('canvas');
        cv.width = Math.max(1, Math.round(sw * s)); cv.height = Math.max(1, Math.round(sh * s));
        const ctx = cv.getContext('2d');
        ctx.imageSmoothingQuality = 'high';
        ctx.drawImage(src, 0, 0, cv.width, cv.height);
        if (!img.srcCanvas) URL.revokeObjectURL(src.src);
        return { canvas: cv, sw, sh };
    }

    function makeTexture(canvas) {
        const t = new THREE.CanvasTexture(canvas);
        t.generateMipmaps = true;
        t.minFilter = THREE.LinearMipmapLinearFilter;
        t.magFilter = THREE.LinearFilter;
        t.anisotropy = renderer.capabilities.getMaxAnisotropy();
        return t;
    }

    let exifrModule = null;
    async function readExif(file) {
        try {
            if (!exifrModule) exifrModule = window.exifr;
            const parse = exifrModule.parse;
            // (the lite build cannot take a tag-name list; default options read IFD0 + EXIF + GPS)
            return await parse(file);
        } catch (e) {
            console.warn('EXIF read failed:', e);
            return null;
        }
    }

    function handleImageUpload(event) {
        const files = Array.from(event.target.files);
        event.target.value = '';
        return addFiles(files);
    }

    async function addFiles(files) {
        if (!files.length) return;

        const startIndex = images.length;
        const added = [], failed = [];
        let done = 0;
        for (const file of files) {
            showMessage(`Loading ${++done}/${files.length}: ${file.name}`);
            try {
                const exif = await readExif(file);
                const img = { id: nextId++, name: file.name, file, yaw: 0, pitch: 0, roll: 0, enabled: true, gain: 1, exif, shot: file.shotPose || null };
                const { canvas, sw, sh } = await sourceCanvas(img, 2048);
                img.w = sw; img.h = sh;
                img.tex = makeTexture(canvas);
                let t = exif && exif.DateTimeOriginal instanceof Date ? exif.DateTimeOriginal.getTime() : NaN;
                if (!isNaN(t) && exif.SubSecTimeOriginal) t += parseFloat('0.' + String(exif.SubSecTimeOriginal)) * 1000;
                img.time = t;
                added.push(img);
            } catch (e) {
                console.warn(e);
                failed.push(file.name);
            }
        }
        added.sort((a, b) => {
            const ta = isNaN(a.time) ? Infinity : a.time, tb = isNaN(b.time) ? Infinity : b.time;
            if (ta !== tb) return ta - tb;
            return a.name.localeCompare(b.name, undefined, { numeric: true });
        });

        // Lens from EXIF (first image that has a 35 mm equivalent focal length)
        if (lens.source !== 'user') {
            const withF = added.find(i => i.exif && i.exif.FocalLengthIn35mmFormat);
            if (withF) {
                const f35 = withF.exif.FocalLengthIn35mmFormat;
                const Fpx = f35 * Math.hypot(withF.w, withF.h) / 43.2666;   // 35 mm diagonal
                lens.fovLong = 2 * Math.atan(Math.max(withF.w, withF.h) / 2 / Fpx) / DEG;
                lens.source = `EXIF ${f35} mm equiv.` + (withF.exif.Model ? ` (${withF.exif.Model})` : '');
            } else if (lens.source === 'default') {
                lens.source = 'default (no EXIF focal length found)';
            }
            document.getElementById('lens-fov').value = lens.fovLong.toFixed(1);
        }

        const bad = failed.length ? ` ${failed.length === 1 ? 'This file' : 'These files'} could not be opened as a picture: ${failed.slice(0, 5).join(', ')}${failed.length > 5 ? ' and ' + (failed.length - 5) + ' more' : ''}.` : '';
        if (!added.length) { showMessage((failed.length > 1 ? 'None of those files could be opened as a picture.' : 'That file could not be opened as a picture.') + (failed.length ? ' (' + failed.slice(0, 5).join(', ') + ')' : '')); return; }
        images.push(...added);
        applyLayout(images.slice(startIndex), startIndex);
        images.slice(startIndex).forEach(im => { if (im.shot) Object.assign(im, im.shot); });     // pictures shot with the camera: where the gyro says they point
        updateLensInfo();
        setPanel(true);
        showMessage(`Added ${added.length} image(s); ${images.length} total.` + bad);
    }

    // ---------------- Layout ----------------

    function layoutSlots() {
        const slots = [];
        for (const part of '0:8, 45:8, -45:8, 90:1, -90:1'.split(',')) {   // rings in shooting order, pitch:count
            const m = part.trim().match(/^(-?\d+(?:\.\d+)?)\s*:\s*(\d+)$/);
            if (!m) continue;
            const pitch = parseFloat(m[1]), n = parseInt(m[2]);
            for (let k = 0; k < n; k++) slots.push({ pitch, k, n });
        }
        return slots;
    }

    function layoutPose(index, slots) {
        const yaw0 = 180, dir = 1;                       // first photo looks at yaw 180, turning right
        if (index < slots.length) {
            const s = slots[index];
            return { yaw: wrap180(yaw0 + dir * s.k * 360 / s.n), pitch: s.pitch, roll: 0 };
        }
        return { yaw: wrap180(yaw0 + dir * 22.5 * (index - slots.length)), pitch: 0, roll: 0 };
    }

    function applyLayout(list, startIndex = 0) {
        const slots = layoutSlots();
        list.forEach((img, i) => Object.assign(img, layoutPose(startIndex + i, slots)));
        updateSelectionUI();
        touch();
    }

    function updateLensInfo() {
        let txt = `Source: ${lens.source}`;
        document.getElementById('lens-info').textContent = txt;
        const real = images.find(i => i.file);
        if (real) {
            const nativeW = Math.round(2 * Math.PI * focalPx(real)); nativePano = nativeW; updateWinSize();
            document.getElementById('bake-info').textContent = `Native resolution ≈ ${nativeW} × ${Math.round(nativeW / 2)}. Phones/iPad: use 4096.`;
        }
    }

    // ---------------- Selection & editing ----------------

    function selectImage(img) {
        selectedImg = img;
        compositeDirty = true;
        updateFitBadge();
        if (img) setPanel(true);
        refreshImageList();
        updateSelectionUI();
        updateOutlines();
    }

    function updateSelectionUI() {
        const img = selectedImg;
        document.getElementById('sel-name').textContent = img ? `${img.name}  (${img.w}×${img.h})` : 'None (Drag mode: click an image)';
        for (const id of ['nudge-yaw', 'nudge-pitch', 'nudge-roll', 'sel-enabled', 'sel-prio', 'remove-img-btn']) document.getElementById(id).disabled = !img;
        if (!img) { ['nudge-yaw', 'nudge-pitch', 'nudge-roll'].forEach(id => document.getElementById(id).value = ''); return; }
        const set = (id, v) => { const el = document.getElementById(id); if (document.activeElement !== el) el.value = v.toFixed(2); };
        set('nudge-yaw', img.yaw); set('nudge-pitch', img.pitch); set('nudge-roll', img.roll);
        document.getElementById('sel-enabled').checked = img.enabled;
        document.getElementById('sel-prio').value = Math.log2(img.prio || 1);
        document.getElementById('sel-prio-val').textContent = '×' + (img.prio || 1).toFixed(2);
    }

    function handleNudgeChange() {
        if (!selectedImg) return;
        const yaw = parseFloat(document.getElementById('nudge-yaw').value);
        const pitch = parseFloat(document.getElementById('nudge-pitch').value);
        const roll = parseFloat(document.getElementById('nudge-roll').value);
        if (!isNaN(yaw)) selectedImg.yaw = yaw;
        if (!isNaN(pitch)) selectedImg.pitch = Math.max(-90, Math.min(90, pitch));
        if (!isNaN(roll)) selectedImg.roll = roll;
        touch();
    }

    // [ and ] make the brush smaller / larger (as in Photoshop) while a brush is in use
    function brushSizeKey(dir) {
        if (pd && $('pd-modal').style.display !== 'none') {
            const s = $('pd-brush'), v = parseFloat(s.value);
            s.value = Math.max(parseFloat(s.min), Math.min(parseFloat(s.max), dir > 0 ? Math.max(v + 1, Math.round(v * 1.15)) : Math.min(v - 1, Math.round(v / 1.15))));
            if (pd.lastE) { pdLoupe(pd.lastE); pdRing(pd.lastE); }
        } else {
            const s = $('mb-size'), v = parseFloat(s.value);
            s.value = Math.max(parseFloat(s.min), Math.min(parseFloat(s.max), dir > 0 ? Math.max(v + 0.5, Math.round(v * 1.2 * 2) / 2) : Math.min(v - 0.5, Math.round(v / 1.2 * 2) / 2)));
            $('mb-size-val').textContent = s.value + '°';
            if (maskBrush.lastE) moveBrushCursor(maskBrush.lastE);
        }
    }
    window.addEventListener('keyup', e => { if (e.key.toLowerCase() === 'x') pdHidePaint(false); });
    function onKeyDown(e) {
        const ae = document.activeElement, tag = ae && ae.tagName;
        const typing = tag === 'TEXTAREA' || (tag === 'INPUT' && /^(text|password|number|search|email|url)$/i.test(ae.type));   // sliders and boxes keep the keys free
        if ((e.key === '[' || e.key === ']') && (maskBrush.on || (pd && $('pd-modal').style.display !== 'none')) && !typing) {
            brushSizeKey(e.key === ']' ? 1 : -1); e.preventDefault(); return;
        }
        if (pd && pd.mode === 'retouch' && $('pd-modal').style.display !== 'none' && !typing && !e.ctrlKey && !e.metaKey && !e.altKey) {
            const k = e.key.toLowerCase();
            if (k === 'x') { if (!e.repeat) pdHidePaint(true); e.preventDefault(); return; }
            if (k === 'e') { if (!e.repeat) pdCycleMode(); e.preventDefault(); return; }
        }
        if (e.key === 'F1') { e.preventDefault(); window.open('help.html', '_blank', 'noopener'); return; }
        if (!selectedImg) return;
        if (tag === 'INPUT' || tag === 'SELECT' || tag === 'TEXTAREA') return;
        if (e.key === 'Escape') { selectImage(null); return; }
        const step = e.shiftKey ? 1 : 0.1;
        let used = true;
        switch (e.key) {
            case 'ArrowLeft': selectedImg.yaw = wrap180(selectedImg.yaw - step); break;
            case 'ArrowRight': selectedImg.yaw = wrap180(selectedImg.yaw + step); break;
            case 'ArrowUp': selectedImg.pitch = Math.min(90, selectedImg.pitch + step); break;
            case 'ArrowDown': selectedImg.pitch = Math.max(-90, selectedImg.pitch - step); break;
            case '+': case '=': adjustPriority(selectedImg, -1); break;
            case '-': case '_': adjustPriority(selectedImg, 1); break;
            case '[': case '{': selectedImg.roll -= step; break;
            case ']': case '}': selectedImg.roll += step; break;
            default: used = false;
        }
        if (used) { e.preventDefault(); updateSelectionUI(); touch(); }
    }

    let removeAllArmed = 0;
    function removeAllPhotos() {
        const b = document.getElementById('remove-all-btn');
        if (!images.length) { showMessage('No photos to remove.'); return; }
        if (alignBusy) { showMessage('The photos are being analyzed; wait for that to finish first.'); return; }
        if (!removeAllArmed) {
            removeAllArmed = setTimeout(() => { removeAllArmed = 0; b.textContent = 'Remove all photos'; }, 4000);
            b.textContent = 'Click again to remove all ' + images.length + ' photos'; return;
        }
        clearTimeout(removeAllArmed); removeAllArmed = 0; b.textContent = 'Remove all photos';
        for (const img of images) {
            if (img.tex) img.tex.dispose();
            if (img.maskTex) img.maskTex.dispose();
            if (img.outline) { outlineGroup.remove(img.outline); img.outline.geometry.dispose(); img.outline.material.dispose(); }
        }
        for (const p of patches) { p.tex.dispose(); p.alphaTex.dispose(); }
        patches.length = 0; rtQueue.length = 0; refreshPatchList(); refreshQueue();
        images.length = 0; hoverImg = null; alignAn = null; alignIds = [];
        selectImage(null); touch(); stitchSphere.visible = false; compositeDirty = true;
        showMessage('All photos removed');
    }
    function handleRemoveImage() {
        if (!selectedImg) return;
        const img = selectedImg;
        if (img.tex) img.tex.dispose();
        if (img.maskTex) img.maskTex.dispose();
        if (img.outline) { outlineGroup.remove(img.outline); img.outline.geometry.dispose(); img.outline.material.dispose(); }
        if (hoverImg === img) hoverImg = null;
        images.splice(images.indexOf(img), 1);
        selectImage(null);
        touch();
        showMessage("Image Removed");
    }

    function hitTest(dir) {
        let best = null, bestZ = -1;
        for (const img of images) {
            const n = dirToNorm(img, camBasis(img), dir);
            if (n && Math.abs(n.xn) <= 1 && Math.abs(n.yn) <= 1 && n.cz > bestZ) { best = img; bestZ = n.cz; }
        }
        return best;
    }

    // ---------------- Hover highlight ----------------

    function makeHoverFill() {
        const N = 12;
        const g = new THREE.BufferGeometry();
        g.setAttribute('position', new THREE.BufferAttribute(new Float32Array((N + 1) * (N + 1) * 3), 3));
        const idx = [];
        for (let j = 0; j < N; j++) {
            for (let i = 0; i < N; i++) {
                const a = j * (N + 1) + i, b = a + 1, c = a + N + 1, d = c + 1;
                idx.push(a, b, c, b, d, c);
            }
        }
        g.setIndex(idx);
        const m = new THREE.MeshBasicMaterial({ color: 0x35e0ff, transparent: true, opacity: 0.22, depthTest: false, depthWrite: false, side: THREE.DoubleSide });
        hoverFill = new THREE.Mesh(g, m);
        hoverFill.userData.N = N;
        hoverFill.frustumCulled = false;
        hoverFill.renderOrder = 9;
        hoverFill.visible = false;
        scene.add(hoverFill);
    }

    function updateHoverFill() {
        if (!hoverFill) return;
        hoverFill.visible = !!hoverImg && !bgTop;
        if (!hoverImg) return;
        const N = hoverFill.userData.N, B = camBasis(hoverImg), pos = hoverFill.geometry.attributes.position;
        let k = 0;
        for (let j = 0; j <= N; j++) {
            for (let i = 0; i <= N; i++) {
                const v = rayFromNorm(hoverImg, B, -1 + 2 * i / N, 1 - 2 * j / N).multiplyScalar(478);
                pos.setXYZ(k++, v.x, v.y, v.z);
            }
        }
        pos.needsUpdate = true;
    }

    function setHover(img) {
        if (img === hoverImg) return;
        hoverImg = img;
        updateOutlines();
    }

    function onCanvasHover(event) {
        const label = document.getElementById('hover-label');
        if (maskBrush.on || isGyroEnabled || isUserInteracting || bgTop) {
            setHover(null);
            label.style.display = 'none';
            return;
        }
        if (!activeDrag) setHover(hitTest(pointerDir(event)));
        if (hoverImg) {
            label.textContent = hoverText(hoverImg) + (activeDrag || TOUCH ? '' : '   (right-drag: move)');
            label.style.left = (event.clientX + 14) + 'px';
            label.style.top = (event.clientY + 14) + 'px';
            label.style.display = 'block';
            renderer.domElement.style.cursor = activeDrag ? 'grabbing' : '';
        } else {
            label.style.display = 'none';
            renderer.domElement.style.cursor = '';
        }
    }

    // ---------------- Image list & pole tools ----------------

    let listSelShown = null;
    function refreshImageList() {
        const box = document.getElementById('img-list');
        if (!box) return;
        const keepScroll = box.scrollTop;
        box.textContent = '';
        let selRow = null;
        images.forEach((img, i) => {
            const sel = img === selectedImg;
            const row = document.createElement('div');
            row.style.cssText = 'display:flex; justify-content:space-between; gap:8px; padding:1px 4px; cursor:pointer; border-radius:4px;' +
                (sel ? ' background:#4b5563; color:#ffd400;' : ' color:#d1d5db;') + (img.enabled ? '' : ' opacity:0.45;');
            const a = document.createElement('span'), b = document.createElement('span');
            a.textContent = `${i + 1}  ${img.name}` + ((img.prio || 1) > 1.2 ? ' ▲' : (img.prio || 1) < 0.8 ? ' ▼' : '');
            a.style.cssText = 'overflow:hidden; text-overflow:ellipsis; white-space:nowrap;';
            if (img.orphan && !sel) a.style.color = '#f87171';
            b.textContent = `${img.yaw.toFixed(0)}° / ${img.pitch.toFixed(0)}°`;
            b.style.whiteSpace = 'nowrap';
            row.append(a, b);
            row.addEventListener('click', e => {
                if (e.shiftKey && selectedImg && selectedImg !== img) { swapPoses(selectedImg, img); return; }
                selectImage(img);
                lookAtImage(img);
            });
            box.appendChild(row);
            if (sel) selRow = row;
        });
        box.scrollTop = keepScroll;
        if (selRow && listSelShown !== selectedImg) selRow.scrollIntoView({ block: 'nearest' });
        listSelShown = selectedImg;
    }

    // ---------------- A logo at the nadir ----------------
    // The logo is drawn as it would look lying on the floor under the camera, seen from the camera (a view straight down), and then goes in
    // like any other retouch result: into the background panorama if there is one (an edit in its list), otherwise a patch over the photos.
    let logoImg = null, logoPlaced = null;          // the chosen picture; the edit or patch that holds the placed logo
    function logoUI() {
        $('logo-place').disabled = !logoImg;
        $('logo-remove').disabled = !logoPlaced || !(bgEdits.includes(logoPlaced) || patches.includes(logoPlaced));
    }
    async function logoChoose(file) {
        try {
            const url = URL.createObjectURL(file), im = new Image();
            await new Promise((res, rej) => { im.onload = res; im.onerror = () => rej(new Error('That file could not be opened as a picture: ' + file.name)); im.src = url; });
            URL.revokeObjectURL(url);
            logoImg = im; $('logo-name').textContent = file.name + ' (' + im.naturalWidth + ' × ' + im.naturalHeight + ')'; $('logo-name').title = file.name;
            logoUI();
        } catch (e) { showMessage(e.message || String(e)); }
    }
    // The color and opacity pictures of the logo, S x S, seen along the nadir
    function logoPieces(img, sizeDeg, turnDeg, opacity, round, S, fov) {
        const F = S / (2 * Math.tan(fov * DEG / 2)), side = 2 * F * Math.tan(sizeDeg * DEG / 2);       // width of the logo in the view, in pixels
        const w = img.naturalWidth, h = img.naturalHeight, k = round ? Math.max(side / w, side / h) : Math.min(side / w, side / h);     // round: fill the circle; otherwise fit whole
        const c = document.createElement('canvas'); c.width = c.height = S;
        const x = c.getContext('2d'); x.imageSmoothingQuality = 'high';
        x.translate(S / 2, S / 2); x.rotate(turnDeg * DEG); x.drawImage(img, -w * k / 2, -h * k / 2, w * k, h * k); x.setTransform(1, 0, 0, 1, 0, 0);
        const id = x.getImageData(0, 0, S, S), d = id.data, R = side / 2;
        let sr = 0, sg = 0, sb = 0, sa = 0;
        for (let i = 0; i < d.length; i += 4) { const a = d[i + 3]; sr += d[i] * a; sg += d[i + 1] * a; sb += d[i + 2] * a; sa += a; }
        const mr = sa ? sr / sa : 128, mg = sa ? sg / sa : 128, mb = sa ? sb / sa : 128;          // the color given to the empty pixels, so that the edge does not darken
        const col = new ImageData(S, S), al = new ImageData(S, S);
        for (let j = 0, i = 0; j < S; j++) for (let q = 0; q < S; q++, i += 4) {
            let a = d[i + 3] / 255;
            if (round) { const rr = Math.hypot(q + 0.5 - S / 2, j + 0.5 - S / 2) / R, t = Math.max(0, Math.min(1, (1 - rr) / 0.12)); a *= t * t * (3 - 2 * t); }
            if (d[i + 3] > 0) { col.data[i] = d[i]; col.data[i + 1] = d[i + 1]; col.data[i + 2] = d[i + 2]; } else { col.data[i] = mr; col.data[i + 1] = mg; col.data[i + 2] = mb; }
            col.data[i + 3] = 255;
            al.data[i] = al.data[i + 1] = al.data[i + 2] = Math.round(a * opacity * 255); al.data[i + 3] = 255;
        }
        const cc = document.createElement('canvas'), ac = document.createElement('canvas'); cc.width = cc.height = ac.width = ac.height = S;
        cc.getContext('2d').putImageData(col, 0, 0); ac.getContext('2d').putImageData(al, 0, 0);
        return { color: cc, alpha: ac };
    }
    async function logoPlace() {
        if (!logoImg) { showMessage('Choose a logo first.'); return; }
        if (pd) { showMessage('Close the retouch window first.'); return; }
        const useBg = bgCustom;
        if (!useBg && !images.some(i => i.enabled)) { showMessage('Load and align photos first, or load or bake a background panorama.'); return; }
        const size = Math.max(5, Math.min(100, parseFloat($('logo-size').value) || 40)), turn = parseFloat($('logo-rot').value) || 0;
        const opac = Math.max(0.05, Math.min(1, (parseFloat($('logo-op').value) || 100) / 100)), round = $('logo-round').checked;
        const fov = Math.min(120, size * 1.15 + 4);
        const ppd = useBg ? bgPanoWidth() / 360 : 24;          // pixels per degree to keep
        const S = Math.max(512, Math.min(3072, Math.ceil(2 * Math.tan(fov * DEG / 2) * ppd * 180 / Math.PI / 64) * 64));
        const basis = basisLook(new THREE.Vector3(0, -1, 0), new THREE.Vector3(-1, 0, 0));          // straight down; the top of the logo points to the middle of the panorama
        $('logo-place').disabled = true;
        try {
            await logoRemove(true);
            const o = logoPieces(logoImg, size, turn, opac, round, S, fov);
            if (useBg) {
                const e = await applyPatchToBg(basis, fov, S, S, o.color, o.alpha, 'Logo');
                logoPlaced = e;
                showMessage('The logo is in the background panorama (it is the edit called Logo in the retouch list). Save the panorama to keep it.');
            } else {
                logoPlaced = addPatch(basis, fov, S, S, o.color, o.alpha, 'Logo');
                showMessage('The logo is laid over the stitched photos and is included when you bake.');
            }
        } catch (e) { showMessage('Could not place the logo: ' + (e.message || e)); }
        finally { logoUI(); }
    }
    async function logoRemove(quiet) {
        const e = logoPlaced; logoPlaced = null;
        if (e) {
            if (bgEdits.includes(e)) await bgDeleteEdit(e);
            else if (patches.includes(e)) { e.tex.dispose(); e.alphaTex.dispose(); patches.splice(patches.indexOf(e), 1); compositeDirty = true; refreshPatchList(); }
        }
        logoUI();
        if (quiet !== true) showMessage(e ? 'The logo was taken away.' : 'There is no logo to take away.');
    }

    // ---------------- The front of the panorama ----------------
    // The front is the middle column of the baked image (heading 180 here), where most viewers start looking. Setting it turns everything
    // around the vertical axis by the same angle: the photos, the patches and queued spots, and the background panorama (its columns shift).
    function rotateBasisY(b, deg) {
        const q = new THREE.Quaternion().setFromAxisAngle(new THREE.Vector3(0, 1, 0), -deg * DEG);
        b.r.applyQuaternion(q); b.u.applyQuaternion(q); b.f.applyQuaternion(q);
    }
    function setFrontToView() {
        if (pd) { showMessage('Close the retouch window first.'); return; }
        if (!images.length && !bgCustom) { showMessage('Load photos or a background panorama first.'); return; }
        if (isGyroEnabled) { showMessage('Turn the gyroscope off first, then look at what should be the front.'); return; }
        if (Math.abs(lat) > 60) { showMessage('Look toward the horizon first: the direction is that of the view, and straight up or down has none.'); return; }
        const d = wrap180(180 - lon);
        if (Math.abs(d) < 0.05) { showMessage('That direction is already the front.'); return; }
        if (bgEdits.length && !confirm('The background panorama has ' + bgEdits.length + ' retouching edit' + (bgEdits.length > 1 ? 's' : '') + '. Turning it keeps them in the picture, but they can no longer be taken out one by one, and spots still waiting in the queue are dropped. Turn anyway?')) return;
        for (const im of images) im.yaw = wrap180(im.yaw + d);
        for (const p of patches) rotateBasisY(p.basis, d);
        for (const j of rtQueue) rotateBasisY(j.basis, d);
        if (bgCustom) {
            const sr = ensureBgCanvas();
            if (sr) {
                const c = sr.canvas, W = c.width, sh = Math.round(((d / 360) * W % W + W) % W);
                if (sh) {
                    const t = document.createElement('canvas'); t.width = c.width; t.height = c.height;
                    const tc = t.getContext('2d'); tc.drawImage(c, 0, 0);
                    const cc = c.getContext('2d'); cc.clearRect(0, 0, W, c.height); cc.drawImage(t, sh, 0); cc.drawImage(t, sh - W, 0);
                    t.width = t.height = 0;
                }
                for (const e of bgEdits) e.before = [];
                bgEdits = []; bgGen++; bgEdited = true;
                bgRefreshDisplay(); bgUI();
            }
        }
        lon += d; targetLon += d;            // the view keeps looking at the same picture content
        updateSelectionUI(); touch(); updateOutlines(); refreshQueue();
        showMessage('The front is now where you were looking: the middle of the baked image. ' + (images.length ? 'The photos were turned by ' + d.toFixed(1) + '°. ' : '') + (bgCustom ? 'Save the background panorama to keep the turn. ' : ''));
    }

    function lookAtImage(img) {
        if (isGyroEnabled) return;
        targetLon = img.yaw + 360 * Math.round((lon - img.yaw) / 360);
        targetLat = Math.max(-85, Math.min(85, img.pitch));
    }

    function swapPoses(a, b) {
        for (const k of ['yaw', 'pitch', 'roll']) { const t = a[k]; a[k] = b[k]; b[k] = t; }
        updateSelectionUI();
        touch();
        showMessage(`Swapped poses of ${a.name} and ${b.name}`);
    }

    // Top cap <-> bottom cap: negate the pitch of every image within 10 degrees of a pole.
    function flipPoles() {
        const poles = images.filter(im => Math.abs(im.pitch) >= 80);
        if (!poles.length) { showMessage('No images near +90 or -90 degrees.'); return; }
        poles.forEach(im => { im.pitch = -im.pitch; });
        updateSelectionUI();
        touch();
        showMessage(`Flipped ${poles.length} pole image(s) top/bottom`);
    }

    // ---------------- Auto-align (uses pano_align.js and pano_features.js, both loaded on first use) ----------------

    let alignAn = null;          // result of PanoAlign.analyze
    let alignIds = [];           // image ids, in the order used by alignAn
    let alignBusy = false;
    const ALIGN_MAX = 960;       // long side of the grayscale copies used for feature detection

    let alignTask = 0;
    function setAlignStatus(t) { document.getElementById('align-status').textContent = t; if (alignTask) Progress.update(alignTask, String(t).split('\n')[0].slice(0, 90)); }
    function setAlignBusy(b) {
        alignBusy = b;
        if (b && !alignTask) alignTask = Progress.start('Aligning the photos');
        if (!b && alignTask) { Progress.end(alignTask); alignTask = 0; }
        for (const id of ['align-all-btn', 'snap-btn']) document.getElementById(id).disabled = b;
    }
    function loadScriptOnce(src) {
        return new Promise((resolve, reject) => {
            const s = document.createElement('script');
            s.src = src + '?v=' + (window.PANO_BUILD || ''); s.onload = resolve;
            s.onerror = () => reject(new Error('Could not load ' + src + ' (it must sit in the same folder as this page)'));
            document.head.appendChild(s);
        });
    }
    async function ensureEngine() {
        if (!window.PanoFeatures) await loadScriptOnce('pano_features.js');
        if (!window.PanoAlign) await loadScriptOnce('pano_align.js');
    }

    // The heavy work (feature matching, bundle adjustment) runs in a Web Worker so the page never freezes.
    // The worker is built from the engine's own source, so it also works when the page is opened from file://.
    function alignWorkerMain() {
        const PA = factory(self);                       // 'factory' is defined by the prefix added in getWorker()
        let an = null, cvP = null;
        const post = (id, o) => self.postMessage(Object.assign({ id }, o));
        self.onmessage = async e => {
            const m = e.data;
            try {
                if (m.type === 'analyze') {
                    if (!cvP) cvP = PA.loadFeatures();
                    const cv = await cvP;
                    const imgs = m.imgs.map(g => ({ gray: new Uint8Array(g.buf), w: g.w, h: g.h }));
                    an = await PA.analyze(cv, imgs, {}, (t, f) => post(m.id, { type: 'progress', text: t, frac: f }));
                    post(m.id, { type: 'done', an: { N: an.N, size: an.size, pairs: an.pairs, fnH: an.fnH, opts: an.opts, nCandidates: an.nCandidates } });
                } else if (m.type === 'align') {
                    const res = PA.align(an, m.fn, m.lens, m.opts, t => post(m.id, { type: 'progress', text: t }));
                    post(m.id, { type: 'done', res, gains: res.ok ? PA.gains(an, res.placed) : null, pairs: an.pairs });
                }
            } catch (err) { post(m.id, { type: 'error', error: String((err && err.message) || err) }); }
        };
    }
    let alignWorker = null, alignJobs = new Map(), alignJobId = 0;
    function getWorker() {
        if (alignWorker) return alignWorker;
        const src = 'self.PanoFeatures = (' + window.PanoFeatures.factorySource + ')(self);\nconst factory = ' + window.PanoAlign.factorySource + ';\n(' + alignWorkerMain.toString() + ')();';
        alignWorker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
        alignWorker.onmessage = e => {
            const m = e.data, job = alignJobs.get(m.id);
            if (!job) return;
            if (m.type === 'progress') { if (job.onProgress) job.onProgress(m.text, m.frac); return; }
            alignJobs.delete(m.id);
            if (m.type === 'error') job.reject(new Error(m.error)); else job.resolve(m);
        };
        alignWorker.onerror = e => {
            const err = new Error('Worker failed: ' + (e.message || 'unknown error'));
            alignJobs.forEach(j => j.reject(err)); alignJobs.clear();
            alignWorker.terminate(); alignWorker = null;
        };
        return alignWorker;
    }
    function callWorker(msg, transfer, onProgress) {
        return new Promise((resolve, reject) => {
            const id = ++alignJobId;
            let last = Date.now();
            const dog = setInterval(() => {            // watchdog: a worker that goes silent is stopped instead of hanging forever
                if (Date.now() - last < 150000) return;
                clearInterval(dog); alignJobs.delete(id);
                if (alignWorker) { alignWorker.terminate(); alignWorker = null; }
                reject(new Error('The matcher went silent for 2.5 minutes. Reload the page and try again.'));
            }, 5000);
            const done = f => v => { clearInterval(dog); f(v); };
            alignJobs.set(id, { resolve: done(resolve), reject: done(reject), onProgress: (t, f) => { last = Date.now(); if (onProgress) onProgress(t, f); } });
            getWorker().postMessage(Object.assign({ id }, msg), transfer || []);
        });
    }
    const alignProgress = (t, f) => { setAlignStatus(t + (f != null ? `  (${Math.round(f * 100)}%)` : '')); if (alignTask) Progress.update(alignTask, t, f == null ? null : f); };
    async function grayOf(img) {
        const { canvas } = await sourceCanvas(img, ALIGN_MAX);
        const d = canvas.getContext('2d').getImageData(0, 0, canvas.width, canvas.height).data;
        const g = new Uint8Array(canvas.width * canvas.height);
        for (let i = 0, k = 0; i < g.length; i++, k += 4) g[i] = (d[k] * 77 + d[k + 1] * 150 + d[k + 2] * 29) >> 8;
        return { gray: g, w: canvas.width, h: canvas.height };
    }
    const nextFrame = () => new Promise(r => requestAnimationFrame(r));
    const lensFn = () => 1 / Math.tan(lens.fovLong * DEG / 2);
    const lensABC = () => ({ a: lens.a, b: lens.b, c: lens.c });
    const rotOf = im => window.PanoAlign.RfromPose(im.yaw, im.pitch, im.roll);
    const imgById = id => images.find(i => i.id === id);
    const currentRotations = () => alignIds.map(id => { const im = imgById(id); return im ? rotOf(im) : null; });
    const enabledIds = () => images.filter(i => i.enabled).map(i => i.id);

    async function runAnalyze() {
        if (alignBusy) return false;
        const list = images.filter(i => i.enabled && (i.tex || i.file || i.srcCanvas));
        if (list.length < 2) { setAlignStatus('Need at least two enabled images.'); return false; }
        setAlignBusy(true);
        try {
            await ensureEngine();
            const grays = [];
            for (let k = 0; k < list.length; k++) {
                alignProgress(`Preparing image ${k + 1} of ${list.length}`, 0.05 * (k + 1) / list.length);
                grays.push(await grayOf(list[k]));
                await nextFrame();
            }
            const t0 = performance.now();
            setAlignStatus('Starting the matcher...');
            const m = await callWorker({ type: 'analyze', imgs: grays.map(g => ({ buf: g.gray.buffer, w: g.w, h: g.h })) }, grays.map(g => g.gray.buffer), alignProgress);
            const an = m.an; an.adj = window.PanoAlign.buildAdj(an);
            alignAn = an; alignIds = list.map(i => i.id);
            let good = 0; an.pairs.forEach(p => { if (!p.dead) good++; });
            const lonely = alignIds.map((id, k) => [id, k]).filter(([, k]) => window.PanoAlign.neighbours(an, k).length === 0).map(([id]) => imgById(id).name);
            setAlignStatus(`Found ${good} overlapping pairs in ${((performance.now() - t0) / 1000).toFixed(0)} s.` +
                (lonely.length ? `\nNo matches at all (blank sky or too little texture?): ${lonely.join(', ')}` : ''));
            updateFitBadge();
            return true;
        } catch (e) {
            console.error(e);
            setAlignStatus('Analysis failed: ' + (e && e.message ? e.message : e));
            return false;
        } finally { setAlignBusy(false); }
    }

    async function runAutoAlign() {
        if (alignBusy) return;
        if (!alignAn || alignIds.join() !== enabledIds().join()) { if (!(await runAnalyze())) return; }
        setAlignBusy(true);
        try {
            await nextFrame();
            const PA = window.PanoAlign;
            setAlignStatus('Optimizing camera rotations...');
            const m = await callWorker({ type: 'align', fn: lensFn(), lens: lensABC(), opts: { optimizeDistortion: true } }, null, alignProgress);
            const res = m.res;
            alignAn.pairs = m.pairs; alignAn.adj = PA.buildAdj(alignAn);     // the aligner may have discarded false pairs
            if (!res.ok) { setAlignStatus(res.reason || 'Alignment failed.'); return; }
            const list = alignIds.map(imgById);
            let keep = selectedImg ? alignIds.indexOf(selectedImg.id) : -1;
            if (keep < 0 || !res.placed[keep]) keep = res.placed.findIndex(Boolean);
            const Rl = PA.level(res.R, res.placed, keep, list[keep].yaw);
            list.forEach((im, k) => {
                im.orphan = !res.placed[k];
                if (!res.placed[k]) return;
                const p = PA.poseFromR(Rl[k]);
                im.yaw = wrap180(p.yaw); im.pitch = Math.max(-90, Math.min(90, p.pitch)); im.roll = p.roll;
            });
            const oldFov = lens.fovLong;
            lens.fovLong = 2 * Math.atan(1 / res.fn) / DEG; lens.b = res.b || 0; lens.source = 'auto-aligned';
            if (list.some(im => im.shot)) { try { localStorage.setItem('pano.shootFov', lens.fovLong.toFixed(2)); } catch (e) { } }     // the next shoot starts with this phone's real field of view
            document.getElementById('lens-fov').value = lens.fovLong.toFixed(1);
            updateLensInfo();
            list.forEach((im, k) => { if (res.placed[k]) im.gain = m.gains[k]; });
            // Images whose matches agree best with the solution get the highest blend priority (ghost control).
            const rmsAll = Object.values(res.rmsPerImage).filter(v => v > 0).sort((a, b) => a - b), rmsMed = rmsAll[rmsAll.length >> 1] || 1;
            list.forEach((im, k) => {
                if (!res.placed[k]) return;
                const r = res.rmsPerImage[k] || rmsMed;
                im.prio = Math.max(0.25, Math.min(4, Math.pow(rmsMed / r, 2)));
            });
            const bad = list.filter(im => im.orphan).map(im => im.name);
            const worst = Object.entries(res.rmsPerImage).sort((a, b) => b[1] - a[1]).slice(0, 3).map(([k, v]) => `${imgIndexLabel(list[k])} ${v.toFixed(1)}px`);
            setAlignStatus(`Placed ${res.placed.filter(Boolean).length} of ${list.length} images using ${res.usedPairs} pairs. RMS error ${res.rms.toFixed(2)} px.\n` +
                `Field of view ${oldFov.toFixed(1)}° → ${lens.fovLong.toFixed(1)}°` + (res.b ? `, distortion b = ${res.b.toFixed(4)}` : '') + `.\nLeast consistent: ${worst.join(', ')}.` +
                (bad.length ? `\nNot placed (shown red in the list, drag them near their place and Snap): ${bad.join(', ')}` : ''));
            if (selectedImg) updateSelectionUI();
            touch();
            showMessage(bad.length ? `Aligned; ${bad.length} image(s) could not be placed` : 'Aligned all images');
        } catch (e) {
            console.error(e);
            setAlignStatus('Alignment failed: ' + (e && e.message ? e.message : e));
        } finally { setAlignBusy(false); }
    }
    const imgIndexLabel = im => '#' + (images.indexOf(im) + 1);

    // Snap one image onto its matches with the other images (using their current poses). Returns null if there is no good solution.
    function snapImage(img, maxMoveDeg, quiet) {
        if (!alignAn) { if (!quiet) showMessage('Run Analyze first.'); return null; }
        const PA = window.PanoAlign, i = alignIds.indexOf(img.id);
        if (i < 0) { if (!quiet) showMessage('This image was not part of the analysis (re-run Analyze).'); return null; }
        const Rall = currentRotations();
        const s = PA.snap(alignAn, i, Rall, lensFn(), lensABC(), null);
        if (!s || s.used < 20 || s.medianDeg > 1.5) { if (!quiet) showMessage('Not enough reliable matches with other images to snap this one.'); return null; }
        const mv = PA.M.angleBetween(s.R, Rall[i]) / DEG;
        if (maxMoveDeg && mv > maxMoveDeg) { if (!quiet) showMessage(`Best match is ${mv.toFixed(0)}° away; drag it closer first.`); return null; }
        const p = PA.poseFromR(s.R);
        img.yaw = wrap180(p.yaw); img.pitch = Math.max(-90, Math.min(90, p.pitch)); img.roll = p.roll; img.orphan = false;
        updateSelectionUI(); touch();
        showMessage(`Snapped ${img.name}: moved ${mv.toFixed(1)}°, ${s.used} matched points`);
        return { mv, s };
    }
    // Snapping needs the matches between photos. If they were not found yet (poses loaded, no Auto-Align), find them now, once.
    async function ensureAnalyzed() {
        if (alignAn && alignIds.join() === enabledIds().join()) return true;
        if (alignBusy) { showMessage('Still analyzing the photos; try again in a moment.'); return false; }
        showMessage('Analyzing the photos once so snapping can use their matches...');
        return !!(await runAnalyze()) && !!alignAn;
    }
    async function snapSelected() {
        if (!selectedImg) { showMessage('Select an image first.'); return; }
        if (!(await ensureAnalyzed())) return;
        snapImage(selectedImg, 0, false);
    }

    // Live feedback: how well the selected (or dragged) image agrees with the images it overlaps, at its current pose.
    // The Version line shows when index.html was last changed on the server (the browser knows it), so there is nothing to keep up to date by hand.
    (() => {
        const v = document.getElementById('build-version'), d = new Date(document.lastModified);
        if (v && !isNaN(d)) v.textContent = 'Version ' + d.toLocaleString([], { dateStyle: 'medium', timeStyle: 'short' });
    })();
    let fitBadgeTimer = 0;
    function updateFitBadge() {
        const badge = document.getElementById('fit-badge'), info = document.getElementById('fit-info');
        if (!badge || !info) return;
        const img = activeDrag ? activeDrag.img : selectedImg;
        const i = img && alignAn ? alignIds.indexOf(img.id) : -1;
        if (!img || i < 0) {
            badge.style.display = 'none';
            info.textContent = alignAn ? '' : 'Run Analyze to get live match feedback while you move an image.';
            return;
        }
        const PA = window.PanoAlign, Rall = currentRotations();
        const r = PA.fitFor(alignAn, i, Rall[i], Rall, lensFn(), lensABC(), 2);
        if (!r.n) {
            badge.style.display = 'block'; badge.style.background = '#4b5563';
            clearTimeout(fitBadgeTimer); if (!activeDrag) fitBadgeTimer = setTimeout(() => { badge.style.display = 'none'; }, 3000);
            badge.textContent = `${img.name}: no matches with other images`;
            info.textContent = '';
            return;
        }
        const pct = Math.round(100 * r.frac);
        badge.style.display = 'block';
        clearTimeout(fitBadgeTimer);                            // while dragging it stays; otherwise it goes after a few seconds
        if (!activeDrag) fitBadgeTimer = setTimeout(() => { badge.style.display = 'none'; }, 3000);
        badge.style.background = pct >= 70 ? '#15803d' : pct >= 25 ? '#b45309' : '#b91c1c';
        badge.textContent = `Match ${pct}%  (mean error ${r.meanDeg.toFixed(1)}°)`;
        const rows = r.per.slice().sort((a, b) => b.n - a.n).slice(0, 5).map(e => {
            const im = imgById(alignIds[e.j]);
            return im ? `${imgIndexLabel(im)} ${Math.round(100 * e.within / e.n)}%` : null;
        }).filter(Boolean);
        info.textContent = `Overlaps with (image, % agreeing): ${rows.join(', ')}`;
    }

    // ---------------- Save / load poses ----------------

    function savePoses() {
        const data = {
            version: 1,
            lens: { fovLong: lens.fovLong, a: lens.a, b: lens.b, c: lens.c },
            images: images.map(i => ({ name: i.name, yaw: i.yaw, pitch: i.pitch, roll: i.roll, gain: i.gain || 1, prio: i.prio || 1, enabled: i.enabled, mask: i.maskCanvas ? i.maskCanvas.toDataURL('image/png') : undefined }))
        };
        const a = document.createElement('a');
        a.href = URL.createObjectURL(new Blob([JSON.stringify(data, null, 1)], { type: 'application/json' }));
        a.download = 'pano_poses.json';
        a.click();
        setTimeout(() => URL.revokeObjectURL(a.href), 2000);
    }
    async function loadPoses(file) {
        try {
            const d = JSON.parse(await file.text());
            const used = new Set(); let n = 0;
            for (const r of d.images || []) {
                const im = images.find(x => x.name === r.name && !used.has(x));
                if (!im) continue;
                used.add(im); n++;
                im.yaw = r.yaw; im.pitch = r.pitch; im.roll = r.roll; im.gain = r.gain || 1; im.prio = r.prio || 1; im.enabled = r.enabled !== false; im.orphan = false;
                if (r.mask) {
                    const mi = await new Promise(ok => { const t = new Image(); t.onload = () => ok(t); t.onerror = () => ok(null); t.src = r.mask; });
                    if (mi) { const g = document.createElement('canvas'); g.width = mi.width; g.height = mi.height; g.getContext('2d').drawImage(mi, 0, 0); setImageMask(im, g); }
                }
            }
            if (d.lens) {
                Object.assign(lens, { fovLong: d.lens.fovLong, a: d.lens.a || 0, b: d.lens.b || 0, c: d.lens.c || 0, source: 'loaded poses' });
                document.getElementById('lens-fov').value = lens.fovLong.toFixed(1);
                updateLensInfo();
            }
            updateSelectionUI(); touch();
            showMessage(`Loaded poses for ${n} of ${images.length} images`);
        } catch (e) { showMessage('Could not read that poses file.'); }
    }

    // ---------------- Outlines ----------------

    function updateOutlines() {
        updateHoverFill();
        const show = document.getElementById('outline-chk').checked;
        outlineGroup.visible = showStitch && !bgTop;
        const N = 16;
        const HALO = [-0.005, 0.005, -0.01, 0.01];   // offsets of the extra loops of the selected photo (WebGL lines are always 1 pixel)
        for (const img of images) {
            if (img !== selectedImg && img.halo) for (const l of img.halo) l.visible = false;
            if (!show && img !== selectedImg) { if (img.outline) img.outline.visible = false; continue; }   // the selected photo always keeps its outline
            if (!img.outline) {
                const g = new THREE.BufferGeometry();
                g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * N * 3), 3));
                const m = new THREE.LineBasicMaterial({ transparent: true, depthTest: false, depthWrite: false });
                img.outline = new THREE.LineLoop(g, m);
                img.outline.frustumCulled = false;
                img.outline.renderOrder = 10;
                outlineGroup.add(img.outline);
            }
            const B = camBasis(img);
            const pos = img.outline.geometry.attributes.position;
            let k = 0;
            const put = (xn, yn) => { const v = rayFromNorm(img, B, xn, yn).multiplyScalar(480); pos.setXYZ(k++, v.x, v.y, v.z); };
            for (let i = 0; i < N; i++) put(-1 + 2 * i / N, 1);
            for (let i = 0; i < N; i++) put(1, 1 - 2 * i / N);
            for (let i = 0; i < N; i++) put(1 - 2 * i / N, -1);
            for (let i = 0; i < N; i++) put(-1, -1 + 2 * i / N);
            pos.needsUpdate = true;
            const sel = img === selectedImg, hov = img === hoverImg;
            img.outline.visible = true;
            img.outline.material.color.set(sel ? 0xffd400 : hov ? 0x35e0ff : (img.enabled ? 0xffffff : 0xff4040));
            img.outline.material.opacity = (sel || hov) ? 1.0 : (hoverImg ? 0.15 : 0.35);
            img.outline.renderOrder = (sel || hov) ? 11 : 10;
            if (sel) {
                if (!img.halo) img.halo = HALO.map(() => {
                    const g = new THREE.BufferGeometry(); g.setAttribute('position', new THREE.BufferAttribute(new Float32Array(4 * N * 3), 3));
                    const l = new THREE.LineLoop(g, new THREE.LineBasicMaterial({ color: 0xffd400, transparent: true, depthTest: false, depthWrite: false }));
                    l.frustumCulled = false; l.renderOrder = 11; outlineGroup.add(l); return l;
                });
                HALO.forEach((e, h) => {
                    const L = img.halo[h], hp = L.geometry.attributes.position; let q = 0;
                    const hput = (xn, yn) => { const v = rayFromNorm(img, B, xn * (1 + e), yn * (1 + e)).multiplyScalar(480); hp.setXYZ(q++, v.x, v.y, v.z); };
                    for (let i = 0; i < N; i++) hput(-1 + 2 * i / N, 1);
                    for (let i = 0; i < N; i++) hput(1, 1 - 2 * i / N);
                    for (let i = 0; i < N; i++) hput(1 - 2 * i / N, -1);
                    for (let i = 0; i < N; i++) hput(-1, -1 + 2 * i / N);
                    hp.needsUpdate = true; L.visible = true;
                });
            }
        }
    }

    // ---------------- Compositing (GPU inverse mapping) ----------------

    function makeAccRT(w, h) {
        return new THREE.WebGLRenderTarget(w, h, {
            type: THREE.HalfFloatType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
            minFilter: THREE.NearestFilter, magFilter: THREE.NearestFilter, generateMipmaps: false
        });
    }
    // mips: the live preview is looked at on a sphere, where the poles need mip levels to stay clean; the bake's tiles do not.
    function makeOutRT(w, h, mips) {
        return new THREE.WebGLRenderTarget(w, h, {
            type: THREE.UnsignedByteType, format: THREE.RGBAFormat, depthBuffer: false, stencilBuffer: false,
            minFilter: mips ? THREE.LinearMipmapLinearFilter : THREE.LinearFilter, magFilter: THREE.LinearFilter, generateMipmaps: !!mips
        });
    }
    function clearRT(rt) {
        const oldColor = renderer.getClearColor(new THREE.Color()), oldAlpha = renderer.getClearAlpha();
        renderer.setRenderTarget(rt);
        renderer.setClearColor(0x000000, 0);
        renderer.clear(true, false, false);
        renderer.setClearColor(oldColor, oldAlpha);
        renderer.setRenderTarget(null);   // never leave an offscreen target bound between frames
    }
    // The image shown solid in previews: the one being dragged, else the selected one.
    function solidTarget() { return activeDrag ? activeDrag.img : (maskBrush.on ? selectedImg : null); }
    function setProjUniforms(img, tex, solid) {
        const B = camBasis(img), u = projectMat.uniforms;
        u.map.value = tex;
        u.maskMap.value = img.maskTex || blackTex;
        u.Rt.value.set(B.r.x, B.r.y, B.r.z, B.u.x, B.u.y, B.u.z, B.f.x, B.f.y, B.f.z);
        u.F.value = focalPx(img);
        u.size.value.set(img.w, img.h);
        u.abc.value.set(lens.a, lens.b, lens.c);
        u.gain.value = img.gain || 1;
        u.prio.value = img.prio || 1;
        const s = 0.5 * (activeDrag ? 1 : maskBrush.on ? 0.2 : 0.35);
        u.boost.value = (solid && img === solidTarget()) ? 1 + 49 * s : 1;
    }
    const blendSharp = () => parseFloat(document.getElementById('blend-slider').value) || 1;
    // Draw one image into the accumulation target(s). Two-band blend: the low band (color blurred by a mip level) is feathered
    // broadly so exposure changes fade smoothly; the high band (fine detail) uses sharply peaked weights, so each detail comes
    // mostly from one image and slightly misaligned images (parallax) no longer average into ghost edges.
    function projectInto(img, tex, region, rt, rt2, solid) {
        const u = projectMat.uniforms, Pw = rt2 ? blendSharp() : 1, two = !!rt2 && Pw > 1;
        passQuad.material = projectMat;
        u.region.value.set(...region);
        setProjUniforms(img, tex, solid);
        let bias = 0;
        if (two) {
            const tw = tex.image.width, Ftex = focalPx(img) * tw / img.w;
            const perPx = u.rectMode.value > 0.5 ? Ftex / u.cropF.value : Ftex * 2 * Math.PI * region[2] / rt.width;   // source texels per output pixel
            bias = Math.max(0, Math.log2(Math.max(1, tw / 40)) - Math.log2(Math.max(1, perPx)));
        }
        u.lodBias.value = bias; u.sharp.value = Pw;
        u.band.value = 0;
        renderer.setRenderTarget(rt);
        renderer.render(passScene, passCam);
        if (two) {
            u.band.value = 1;
            renderer.setRenderTarget(rt2);
            renderer.render(passScene, passCam);
        }
    }
    // Accumulate the given images into rt over the equirect sub-region (s0, t0, ds, dt).
    function accumulate(rt, list, region, texOf, solid, rt2) {
        clearRT(rt);
        if (rt2) clearRT(rt2);
        renderer.autoClear = false;
        for (const img of list) projectInto(img, texOf(img), region, rt, rt2, solid);
        renderer.autoClear = true;
    }
    function normalize(accRT, outRT, bake, acc2RT) {
        renderer.autoClear = false;
        passQuad.material = normMat;
        normMat.uniforms.acc.value = accRT.texture;
        normMat.uniforms.acc2.value = (acc2RT || accRT).texture;
        normMat.uniforms.useHigh.value = acc2RT ? 1 : 0;
        normMat.uniforms.bake.value = bake ? 1 : 0;
        renderer.setRenderTarget(outRT);
        renderer.render(passScene, passCam);
        renderer.autoClear = true;
        renderer.setRenderTarget(null);
    }

    // Redraw the live preview at width w. With rect ({u0, v0, u1, v1}, 0..1, v from the south pole) only that part of it is
    // redrawn, which is exact as long as nothing else changed since the last full redraw at the same width (used while brushing).
    function composite(w, rect) {
        const list = images.filter(i => i.enabled && i.tex);
        stitchSphere.visible = list.length > 0 && showStitch;
        if (!list.length) return;
        if (!previewRTs[w]) { const o = makeOutRT(w, w / 2, true); prepEquirectTexture(o.texture); previewRTs[w] = { acc: makeAccRT(w, w / 2), out: o }; }
        const slot = previewRTs[w], { acc, out } = slot;
        const two = blendSharp() > 1;
        if (two && !slot.acc2) slot.acc2 = makeAccRT(w, w / 2);
        const rts = [acc, out, two ? slot.acc2 : null];
        if (rect) for (const rt of rts) if (rt) {
            const x0 = Math.max(0, Math.floor(rect.u0 * rt.width) - 1), x1 = Math.min(rt.width, Math.ceil(rect.u1 * rt.width) + 1);
            const y0 = Math.max(0, Math.floor(rect.v0 * rt.height) - 1), y1 = Math.min(rt.height, Math.ceil(rect.v1 * rt.height) + 1);
            rt.scissor.set(x0, y0, Math.max(1, x1 - x0), Math.max(1, y1 - y0)); rt.scissorTest = true;
        }
        try {
            accumulate(acc, list, [0, 0, 1, 1], img => img.tex, true, two ? slot.acc2 : null);
            normalize(acc, out, false, two ? slot.acc2 : null);
            const pl = patches.filter(p => p.enabled && p.tex);
            if (pl.length) pasteInto(out, pl, [0, 0, 1, 1]);
        } finally { for (const rt of rts) if (rt) rt.scissorTest = false; }
        lastCompW = w;
        if (stitchSphere.material.map !== out.texture) {
            stitchSphere.material.map = out.texture;
            stitchSphere.material.needsUpdate = true;
        }
    }
    // The part of the preview that a brush dab at direction d (angular radius radRad) can change.
    function dabRect(d, radRad) {
        const ll = lonLat(d), lat0 = ll.lat - radRad, lat1 = ll.lat + radRad, worst = Math.max(Math.abs(lat0), Math.abs(lat1));
        const r = { u0: 0, u1: 1, v0: Math.max(0, lat0 / Math.PI + 0.5), v1: Math.min(1, lat1 / Math.PI + 0.5) };
        if (worst < 80 * DEG) {                                        // wider in longitude towards the poles; whole width beyond 80°
            const half = radRad / Math.cos(worst) / (2 * Math.PI), uc = ((ll.lon / (2 * Math.PI)) % 1 + 1) % 1;
            if (uc - half >= 0 && uc + half <= 1) { r.u0 = uc - half; r.u1 = uc + half; }   // across the seam: whole width, also fine
        }
        return r;
    }
    function addBrushRect(r) {
        brushRect = brushRect ? { u0: Math.min(brushRect.u0, r.u0), u1: Math.max(brushRect.u1, r.u1), v0: Math.min(brushRect.v0, r.v0), v1: Math.max(brushRect.v1, r.v1) } : r;
    }



    async function loadSeams() { if (!window.PanoSeams) await loadScriptOnce('pano_seams.js'); return window.PanoSeams; }   // the local-fill worker lives in pano_seams.js


    // ---------------- Progress bar (jobs that take more than a second) ----------------
    const Progress = (() => {
        const tasks = new Map(); let seq = 0, timer = null;
        const el = id => document.getElementById(id);
        const fmt = s => s >= 60 ? Math.floor(s / 60) + ':' + String(Math.round(s % 60)).padStart(2, '0') : Math.round(s) + ' s';
        function render() {
            const arr = [...tasks.values()];
            if (!arr.length) { el('progress').style.display = 'none'; clearInterval(timer); timer = null; return; }
            const t = arr[arr.length - 1], now = performance.now();
            if (now - t.t0 < 800) return;                       // quick jobs never show the bar
            el('progress').style.display = 'block';
            el('progress-text').textContent = t.text;
            const bar = el('progress-bar');
            if (t.frac == null) { bar.className = 'indet'; bar.style.width = '35%'; }
            else { bar.className = ''; bar.style.width = Math.round(Math.max(0, Math.min(1, t.frac)) * 100) + '%'; }
            const el_s = (now - t.t0) / 1000;
            let sub = 'elapsed ' + fmt(el_s);
            if (t.frac != null && t.frac > 0.04 && t.frac < 1) sub += ', about ' + fmt(el_s * (1 - t.frac) / t.frac) + ' left';
            el('progress-sub').textContent = sub;
        }
        return {
            start(text) { const id = ++seq; tasks.set(id, { text, frac: null, t0: performance.now() }); if (!timer) timer = setInterval(render, 250); return id; },
            update(id, text, frac) { const t = tasks.get(id); if (!t) return; if (text) t.text = text; if (frac !== undefined) t.frac = frac; render(); },
            end(id) { tasks.delete(id); render(); }
        };
    })();

    // ---------------- Mask brush on the panorama ----------------
    // r = the part of the preview a brush dab changed ({u0, v0, u1, v1}): only that is redrawn, at full quality, which keeps
    // brushing fast. Without r (a mask was cleared or replaced) everything is redrawn.
    function maskTouched(r) {
        if (r) addBrushRect(r); else compositeDirty = true;
    }
    function setMaskBrush(on) {
        maskBrush.on = on;
        $('mb-btn').classList.toggle('tog-on', on);
        $('mb-btn').textContent = on ? kb('Brush ON (Esc stops)', 'Brush ON (tap to stop)') : 'Brush out here';
        $('mb-opts').style.display = on ? '' : 'none';
        renderer.domElement.style.cursor = on ? 'none' : '';
        if (!on) $('mb-cursor').style.display = 'none';
        compositeDirty = true;
        if (on) {
            if (bgTop) setBgTop(false);                      // the brush works on the photos: bring them back in front
            setHover(null);
            showMessage(selectedImg ? 'Mask brush: the selected photo is shown solid. Paint what to remove from it.' + kb(' Right-drag turns the view.', '') : 'Mask brush: select a photo first (click it in the list), then paint what to remove from it.');
        }
    }
    function moveBrushCursor(e) {
        if (!maskBrush.on) return;
        maskBrush.lastE = e;
        const c = $('mb-cursor'), r = parseFloat($('mb-size').value) * DEG;
        const px = Math.max(4, 2 * Math.tan(r) / Math.tan(camera.fov * DEG / 2) * window.innerHeight / 2);
        c.style.display = 'block'; c.style.width = c.style.height = px + 'px';
        c.style.left = e.clientX + 'px'; c.style.top = e.clientY + 'px';
        c.style.borderColor = ($('mb-erase').checked !== e.altKey) ? '#38bdf8' : '#f59e0b';
    }
    function ensureMask(img) {
        if (img.maskCanvas) return;
        const k = Math.min(1, 512 / Math.max(img.w, img.h)), g = document.createElement('canvas');
        g.width = Math.max(2, Math.round(img.w * k)); g.height = Math.max(2, Math.round(img.h * k));
        const c = g.getContext('2d'); c.fillStyle = '#000'; c.fillRect(0, 0, g.width, g.height);
        setImageMask(img, g);
    }
    // One round dab of the brush at direction d on photo img (white = not used there, black = erase)
    function dab(img, d, erase, radRad) {
        const n = dirToNorm(img, camBasis(img), d);
        if (!n || Math.abs(n.xn) > 1.3 || Math.abs(n.yn) > 1.3) return;
        if (erase && !img.maskCanvas) return;
        ensureMask(img);
        const g = img.maskCanvas, half = 0.5 * Math.min(img.w, img.h);
        let px = n.xn * img.w / 2, py = n.yn * img.h / 2;
        const rn = Math.hypot(px, py) / half, sc = ((lens.a * rn + lens.b) * rn + lens.c) * rn + (1 - lens.a - lens.b - lens.c);
        px *= sc; py *= sc;
        const x = (0.5 + px / img.w) * g.width, y = (0.5 - py / img.h) * g.height;
        const r = Math.max(1, focalPx(img) * Math.tan(radRad) / (n.cz * n.cz) * g.width / img.w);
        const c = g.getContext('2d');
        c.fillStyle = erase ? '#000' : '#fff';
        c.beginPath(); c.arc(x, y, r, 0, 2 * Math.PI); c.fill();
        img.maskTex.needsUpdate = true;
        return dabRect(d, radRad / Math.max(0.3, n.cz) * 1.3 + 2 * DEG);     // photos are stretched off-axis; plus the mask's own softness
    }
    function brushAt(d) {
        const s = maskBrush.stroke, rad = parseFloat($('mb-size').value) * DEG;
        const r = dab(s.img, d, s.erase, rad);
        if (r) maskTouched(r);
    }
    function mbDown(e) {
        const d = pointerDir(e), erase = $('mb-erase').checked !== e.altKey, img = selectedImg;
        if (!img || !img.enabled) { showMessage('Select a photo first (click it in the list); the brush paints on the selected photo.'); return; }
        const nn = dirToNorm(img, camBasis(img), d);
        if (!nn || Math.abs(nn.xn) > 1.3 || Math.abs(nn.yn) > 1.3) showMessage('The selected photo (' + img.name + ') does not reach this spot; paint where it is shown solid.');
        maskBrush.stroke = { img, erase, last: d.clone() };
        brushAt(d);
        document.addEventListener('pointermove', mbMove);
        document.addEventListener('pointerup', mbUp);
        e.preventDefault();
    }
    function mbMove(e) {
        const s = maskBrush.stroke; if (!s || !e.isPrimary) return;
        const d = pointerDir(e), ang = Math.acos(Math.max(-1, Math.min(1, s.last.dot(d)))) / DEG;
        const step = Math.max(0.15, parseFloat($('mb-size').value) * 0.35), n = Math.max(1, Math.ceil(ang / step));
        for (let i = 1; i <= n; i++) brushAt(s.last.clone().lerp(d, i / n).normalize());
        s.last.copy(d);
        moveBrushCursor(e);
    }
    function mbUp() {
        maskBrush.stroke = null;
        document.removeEventListener('pointermove', mbMove);
        document.removeEventListener('pointerup', mbUp);
        compositeDirty = true;
    }

    // ---------------- Masks, retouch dialog and patches ----------------
    function $(id) { return document.getElementById(id); }
    // Switch the project and paste shaders between equirect mode and a rectilinear crop view v.
    function setRect(on, v) {
        rectU.rectMode.value = on ? 1 : 0;
        if (!on) return;
        const B = camBasis(v);
        rectU.cr.value.copy(B.r); rectU.cu.value.copy(B.u); rectU.cf.value.copy(B.f);
        rectU.cropF.value = focalPx(v); rectU.cropSize.value.set(v.w, v.h);
    }
    // Same, from a basis, a focal length in pixels and the size in pixels of the whole view; mode 1 = rectilinear, 2 = cylindrical.
    function setRectRaw(mode, B, F, W, H) {
        rectU.rectMode.value = mode;
        if (!mode) return;
        rectU.cr.value.copy(B.r); rectU.cu.value.copy(B.u); rectU.cf.value.copy(B.f);
        rectU.cropF.value = F; rectU.cropSize.value.set(W, H);
    }
    // Paste patches over the (already normalized) result in outRT.
    function pasteInto(outRT, list, region) {
        const pu = pasteMat.uniforms;
        passQuad.material = pasteMat;
        pu.region.value.set(...region);
        renderer.autoClear = false;
        for (const p of list) {
            const B = camBasis(p);
            pu.pmap.value = p.tex; pu.pal.value = p.alphaTex;
            pu.Rt.value.set(B.r.x, B.r.y, B.r.z, B.u.x, B.u.y, B.u.z, B.f.x, B.f.y, B.f.z);
            pu.F.value = focalPx(p); pu.size.value.set(p.w, p.h);
            renderer.setRenderTarget(outRT);
            renderer.render(passScene, passCam);
        }
        renderer.autoClear = true;
        renderer.setRenderTarget(null);
    }
    // Does the photo see any part of the view v?
    function seesView(img, v) {
        const Bv = camBasis(v), Bi = camBasis(img);
        for (let i = 0; i <= 8; i++) for (let j = 0; j <= 8; j++) {
            const d = rayFromNorm(v, Bv, -1 + i / 4, -1 + j / 4);
            const n = dirToNorm(img, Bi, d);
            if (n && Math.abs(n.xn) <= 1.05 && Math.abs(n.yn) <= 1.05) return true;
        }
        return false;
    }
    // A rectilinear window onto the stitched panorama (same blend as the bake, from the full photos), as a canvas.
    async function renderView(basis, fov, S, withPatches) {
        const v = { w: S, h: S, basis, fov };
        const list = images.filter(i => i.enabled && seesView(i, v));
        const gl = renderer.getContext();
        const maxSz = Math.min(renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE), 4096);
        const acc = makeAccRT(S, S), out = makeOutRT(S, S), acc2 = blendSharp() > 1 ? makeAccRT(S, S) : null;
        const buf = new Uint8Array(S * S * 4);
        const rprog = Progress.start('Rendering the view');
        renderBusy++;
        try {
            setRect(true, v);
            clearRT(acc); if (acc2) clearRT(acc2);
            let k = 0;
            for (const img of list) {
                Progress.update(rprog, `Rendering the view: photo ${++k} of ${list.length}`, (k - 1) / list.length);
                await new Promise(r => requestAnimationFrame(r));
                const { canvas: src } = await sourceCanvas(img, maxSz);
                const tex = makeTexture(src);
                renderer.autoClear = false;
                projectInto(img, tex, [0, 0, 1, 1], acc, acc2, false);
                renderer.autoClear = true;
                renderer.setRenderTarget(null);
                tex.dispose();
                if (src !== img.srcCanvas) src.width = src.height = 0;
            }
            normalize(acc, out, false, acc2);
            const pl = withPatches ? patches.filter(p => p.enabled && p.tex) : [];
            if (pl.length) pasteInto(out, pl, [0, 0, 1, 1]);
            renderer.readRenderTargetPixels(out, 0, 0, S, S, buf);
        } finally {
            setRect(false); renderBusy--; Progress.end(rprog);
            acc.dispose(); out.dispose(); if (acc2) acc2.dispose();
            renderer.autoClear = true; renderer.setRenderTarget(null);
            compositeDirty = true;
        }
        const cv = document.createElement('canvas'); cv.width = cv.height = S;
        const ctx = cv.getContext('2d'), id = ctx.createImageData(S, S);
        for (let r = 0; r < S; r++) id.data.set(buf.subarray(r * S * 4, (r + 1) * S * 4), (S - 1 - r) * S * 4);
        const cov = new Uint8Array(S * S);
        for (let i = 0; i < S * S; i++) { cov[i] = id.data[i * 4 + 3] > 0 ? 1 : 0; id.data[i * 4 + 3] = 255; }
        cv.coverage = cov;
        ctx.putImageData(id, 0, 0);
        return cv;
    }
    function basisLook(f, upHint) {
        f = f.clone().normalize();
        const u = upHint.clone().addScaledVector(f, -upHint.dot(f));
        if (u.lengthSq() < 1e-8) u.set(1, 0, 0).addScaledVector(f, -f.x);
        u.normalize();
        return { r: new THREE.Vector3().crossVectors(f, u), u, f };
    }
    function viewBasis(kind) {
        camera.updateMatrixWorld();
        const e = camera.matrixWorld.elements;
        const cam = { r: new THREE.Vector3(e[0], e[1], e[2]), u: new THREE.Vector3(e[4], e[5], e[6]), f: new THREE.Vector3(-e[8], -e[9], -e[10]) };
        if (kind === 'cam') return cam;
        const h = new THREE.Vector3(cam.f.x, 0, cam.f.z);
        if (h.lengthSq() < 1e-6) h.set(cam.u.x, 0, cam.u.z);
        if (h.lengthSq() < 1e-6) h.set(1, 0, 0);
        return basisLook(new THREE.Vector3(0, kind === 'down' ? -1 : 1, 0), h.normalize());
    }


    // ---- brush out of a photo / mark uncovered ----
    // Which enabled photo shows at direction d: the one that sees d nearest its center (mask-aware).
    function photoAt(d) {
        let best = null, bw = -1;
        for (const img of images) {
            if (!img.enabled || !img.tex) continue;
            const n = dirToNorm(img, camBasis(img), d);
            if (!n || Math.abs(n.xn) > 1 || Math.abs(n.yn) > 1) continue;
            const u = (n.xn + 1) / 2, v = (n.yn + 1) / 2;
            const w = Math.min(u, 1 - u) * Math.min(v, 1 - v) * 4 * (img.prio || 1) * (img.maskCanvas ? 0.01 : 1);
            if (w > bw) { bw = w; best = img; }
        }
        return best;
    }
    function setImageMask(img, g) {
        if (img.maskTex) img.maskTex.dispose();
        img.maskCanvas = g;
        const t = new THREE.CanvasTexture(g);
        t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
        img.maskTex = t;
    }
    // Carry what was painted in the retouch view back into each photo's own exclusion mask.
    function applyCuts() {
        const S = pd.S, H = pd.H, v = { w: S, h: S, basis: pd.basis, fov: pd.fov }, Bv = pd.basis;
        let n = 0;
        for (const [id, cv] of pd.cuts) {
            const img = images.find(i => i.id === id);
            if (!img || !cutHas(cv)) continue;
            const pix = cv.getContext('2d').getImageData(0, 0, S, H).data;
            const k = Math.min(1, 512 / Math.max(img.w, img.h)), mw = Math.max(2, Math.round(img.w * k)), mh = Math.max(2, Math.round(img.h * k));
            const g = document.createElement('canvas'); g.width = mw; g.height = mh;
            const gc = g.getContext('2d');
            gc.fillStyle = '#000'; gc.fillRect(0, 0, mw, mh);
            if (img.maskCanvas) gc.drawImage(img.maskCanvas, 0, 0, mw, mh);
            const gd = gc.getImageData(0, 0, mw, mh), B = camBasis(img), F = focalPx(img), half = 0.5 * Math.min(img.w, img.h);
            const d = new THREE.Vector3();
            for (let my = 0; my < mh; my++) for (let mx = 0; mx < mw; mx++) {
                const p1x = ((mx + 0.5) / mw - 0.5) * img.w, p1y = (0.5 - (my + 0.5) / mh) * img.h;
                let px = p1x, py = p1y;                         // undo the lens distortion by iteration
                for (let it = 0; it < 6; it++) {
                    const rn = Math.hypot(px, py) / half, sc = ((lens.a * rn + lens.b) * rn + lens.c) * rn + (1 - lens.a - lens.b - lens.c);
                    px = p1x / sc; py = p1y / sc;
                }
                d.set(0, 0, 0).addScaledVector(B.r, px).addScaledVector(B.u, py).addScaledVector(B.f, F).normalize();
                const q = dirToNorm(v, Bv, d);
                if (!q || Math.abs(q.xn) > 1 || Math.abs(q.yn) > 1) continue;
                const vx = Math.min(S - 1, Math.floor((q.xn + 1) / 2 * S)), vy = Math.min(H - 1, Math.floor((1 - q.yn) / 2 * H));
                if (pix[(vy * S + vx) * 4 + 3] > 20) { const o = (my * mw + mx) * 4; gd.data[o] = gd.data[o + 1] = gd.data[o + 2] = 255; }
            }
            gc.putImageData(gd, 0, 0);
            setImageMask(img, g); n++;
        }
        return n;
    }
    function cutHas(c) {
        const t = document.createElement('canvas'); t.width = 96; t.height = Math.max(1, Math.round(96 * c.height / c.width));
        const x = t.getContext('2d'); x.drawImage(c, 0, 0, t.width, t.height);
        const d = x.getImageData(0, 0, t.width, t.height).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 20) return true;
        return false;
    }
    function pdKindUI() {
        if (!pd || pd.mode !== 'retouch') return;
        const cut = $('pd-kind-cut').checked;
        pd.kind = cut ? 'cut' : 'fill';
        $('pd-ai').style.display = cut ? 'none' : 'flex';
        $('pd-cuthelp').style.display = cut ? '' : 'none';
        $('pd-uncov').style.display = cut ? 'none' : '';
        $('pd-viewrow').style.display = (!cut && pd.result) ? '' : 'none';
        $('pd-cuthelp').textContent = 'Paint over the ghost, person or smear. Each stroke removes that part from the photo that is showing there, so the other photos show through. Brush each photo that shows it. Where no other photo covers the place, nothing replaces it: use Fill for that.';
        if (cut) { $('pd-ok').textContent = 'Apply'; $('pd-ok').disabled = false; $('pd-ok').className = 'sbtn border bg-emerald-600 hover:bg-emerald-500 border-emerald-400'; } else pdOkState();
        $('pd-cut').style.display = cut || pd.cuts.size ? '' : 'none';
        pdMaskShade();
        pdSetStatus('');
        if (!cut) pdSyncAI();
    }
    function pdMarkUncovered() {
        if (!pd || !pd.coverage) return;
        const S = pd.S, H = pd.H, cov = pd.coverage;
        let m = new Uint8Array(S * H), n = 0;
        for (let i = 0; i < S * H; i++) if (!cov[i]) { m[i] = 1; n++; }
        if (!n) { pdSetStatus('Every spot in this view is covered by a photo.'); return; }
        const r = 5;                                              // grow a little so the fill overlaps real picture
        const tmp = new Uint8Array(S * H);
        for (let y = 0; y < H; y++) { let run = 0; for (let x = 0; x < S + r; x++) { if (x < S && m[y * S + x]) run = r + 1; else if (run) run--; if (x - r >= 0 && x - r < S) { } if (x < S && run) tmp[y * S + x] = 1; } for (let x = S - 1, run2 = 0; x >= 0; x--) { if (m[y * S + x]) run2 = r + 1; else if (run2) run2--; if (run2) tmp[y * S + x] = 1; } }
        const out = new Uint8Array(S * H);
        for (let x = 0; x < S; x++) { let run = 0; for (let y = 0; y < H; y++) { if (tmp[y * S + x]) run = r + 1; else if (run) run--; if (run) out[y * S + x] = 1; } for (let y = H - 1, run2 = 0; y >= 0; y--) { if (tmp[y * S + x]) run2 = r + 1; else if (run2) run2--; if (run2) out[y * S + x] = 1; } }
        const mc = $('pd-mask'), c = mc.getContext('2d'), id = c.getImageData(0, 0, S, H);
        for (let i = 0; i < S * H; i++) if (out[i]) { id.data[i * 4] = 255; id.data[i * 4 + 1] = 0; id.data[i * 4 + 2] = 80; id.data[i * 4 + 3] = 255; }
        c.putImageData(id, 0, 0);
        pdResultInvalid();
        pdSetStatus(`Marked ${(100 * n / (S * H)).toFixed(1)}% of the view as uncovered. Press Run to fill it.`);
    }

    // ---- paint dialog ----
    let pd = null, stitchAI = null;
    const pdBrushPx = () => parseFloat($('pd-brush').value) / 100 * $('pd-mask').width;
    const pdHasMask = () => {
        const m = $('pd-mask'), t = document.createElement('canvas'); t.width = 96; t.height = Math.max(1, Math.round(96 * m.height / m.width));
        const c = t.getContext('2d'); c.drawImage(m, 0, 0, t.width, t.height);
        const d = c.getImageData(0, 0, t.width, t.height).data;
        for (let i = 3; i < d.length; i += 4) if (d[i] > 20) return true;
        return false;
    };
    // white where the painted mask is, black elsewhere (w x h)
    function whiteMask(mask, w, h) {
        const t = document.createElement('canvas'); t.width = w; t.height = h;
        const c = t.getContext('2d');
        c.drawImage(mask, 0, 0, w, h);
        c.globalCompositeOperation = 'source-in'; c.fillStyle = '#fff'; c.fillRect(0, 0, w, h);
        const o = document.createElement('canvas'); o.width = w; o.height = h;
        const oc = o.getContext('2d'); oc.fillStyle = '#000'; oc.fillRect(0, 0, w, h); oc.drawImage(t, 0, 0);
        return o;
    }
    // flash: the message is lit up for a moment, so that a result of a button press is noticed
    function pdSetStatus(s, flash) {
        const el = $('pd-status'); el.textContent = s || '';
        if (flash) { el.style.transition = 'none'; el.style.background = '#047857'; setTimeout(() => { el.style.transition = 'background 1.5s'; el.style.background = 'transparent'; }, 60); }
    }
    // The main button: Accept while a result is waiting to be kept; otherwise Done, which closes the window with a summary
    function pdOkState() {
        if (!pd || pd.mode !== 'retouch' || pd.kind === 'cut') return;
        const pending = !!pd.result;
        $('pd-ok').textContent = pending ? 'Accept' : 'Done'; $('pd-ok').disabled = false;
        $('pd-ok').className = 'sbtn border ' + (pending ? 'bg-emerald-600 hover:bg-emerald-500 border-emerald-400' : 'bg-gray-700 hover:bg-gray-600 border-gray-500');
        $('pd-discard').disabled = !pending;
        $('pd-ok').title = pending ? 'Keep this result' : 'Close this window, keeping the results that are ticked in the list';
    }
    function pdDone() {
        if (!pd) return;
        if (pdAiPaint()) pdQueue();
        if (pdHasMask()) { pdSetStatus('Paint that has not been made is still on the picture: Accept it, or Clear it. Then press Done.', true); return; }
        const bg = pd.target === 'bg', all = pdEditList(), n = all.filter(e => e.enabled !== false).length, off = all.length - n;
        const waiting = rtQueue.filter(j => (j.state === 'waiting' || j.state === 'failed') && j.target === (bg ? 'bg' : 'photos')).length;
        pdClose();
        showMessage((n ? `${n} ${bg ? 'edit' : 'patch'}${n === 1 ? '' : (bg ? 's' : 'es')} kept` : 'No edits kept') + (off ? `, ${off} taken out` : '') + '. ' +
            (bg ? (bgEdited ? 'Press Save modified pano to write the file.' : '') : 'They are included when you bake.') + (waiting ? ` ${waiting} spot${waiting === 1 ? '' : 's'} still waiting in the queue.` : ''));
    }
    function pdOpen(o) {
        const S = o.base.width, H = o.base.height;
        const bc = $('pd-base'), mc = $('pd-mask');
        bc.width = mc.width = S; bc.height = mc.height = H;
        bc.getContext('2d').drawImage(o.base, 0, 0);
        const mctx = mc.getContext('2d'); mctx.clearRect(0, 0, S, H);
        if (o.maskInit) mctx.drawImage(o.maskInit, 0, 0, S, H);
        const wrap = $('pd-wrap');
        pdAspect = H / S;
        const cc = $('pd-cut'); cc.width = S; cc.height = H; cc.getContext('2d').clearRect(0, 0, S, H);
        $('pd-chg').style.display = 'none'; $('pd-chgrow').style.display = 'none';
        pd = Object.assign({ S, H, result: null, patchRGBA: null, kind: 'fill', cuts: new Map(), curCut: null }, o);
        $('pd-home').style.display = o.mode === 'retouch' ? '' : 'none';
        if (o.mode === 'retouch') {                          // remembered for panning (pdNavBasis) and Reset view (pdGoHome)
            pd.basis0 = { r: o.basis.r.clone(), u: o.basis.u.clone(), f: o.basis.f.clone() }; pd.fov0 = o.fov;
        }
        $('pd-kind-fill').checked = true;
        $('pd-kindrow').style.display = 'none';
        $('pd-uncov').style.display = o.mode === 'retouch' && o.target !== 'bg' ? '' : 'none';
        $('pd-cuthelp').style.display = 'none';
        pdMaskShade();
        $('pd-title').textContent = o.title;
        $('pd-ai').style.display = o.mode === 'retouch' ? 'flex' : 'none';
        $('pd-viewrow').style.display = 'none'; $('pd-run').classList.remove('tog-on');
        if (o.mode === 'retouch') pdOkState(); else { $('pd-ok').textContent = 'Apply'; $('pd-ok').disabled = false; $('pd-ok').className = 'sbtn border bg-emerald-600 hover:bg-emerald-500 border-emerald-400'; }
        $('pd-help').textContent = o.mode === 'retouch'
            ? (o.target === 'bg' ? 'Paint over the artifact (a little beyond its edge) and choose what to do with it: fill it, clone over it, sharpen or blur it, or lighten or darken it. Press Run (Preview), then Accept to paint the result into the background panorama; save it afterwards with Save modified pano.'
                : 'Paint over what should be changed (a little beyond its edge), then press Run. Accept keeps the result as a patch laid over the stitch.')
            : 'Paint over the parts of this photo that must not be used. Where other photos cover the same place they are used instead; where none do, this photo is still shown.';
        pdSetStatus('');
        clearTimeout(pdNavTimer); pdNavBusy = false; pdResetTF();
        $('pd-modal').style.display = 'flex';
        pdFit();
        if (o.mode === 'retouch') {
            $('pd-fx').style.display = $('pd-tools').style.display = o.target === 'bg' ? 'flex' : 'none';
            if ($('pd-op').value !== 'fill') $('pd-op').value = 'fill';
            pdFxSync(); pdShowEdits(); pdRefreshEdits();
        }
    }
    let pdWpx = 600, pdAspect = 1, pdAlt = false, pdZ = 100, pdUndoing = false;   // pdAlt: Alt or Shift held = the opposite of the Paint/Erase choice
    function pdZoom() { const wrap = $('pd-wrap'), w = pdWpx * pdZ / 100; wrap.style.width = w + 'px'; wrap.style.height = (w * pdAspect) + 'px'; if (pd && pd.lastE) pdRing(pd.lastE); }
    // 100% = the whole picture fits the window. The controls stay where they are; only the picture area scrolls.
    function pdMeasure() { const v = $('pd-view'); pdWpx = Math.max(120, Math.min(v.clientWidth - 6, (v.clientHeight - 6) / pdAspect)); }
    function pdFit() {
        const v = $('pd-view');
        pdMeasure(); pdZ = 100; pdZoom(); v.scrollLeft = v.scrollTop = 0;
    }
    // Zoom to z percent, keeping the point under (cx, cy) on screen where it is
    function pdSetZoom(z, cx, cy) {
        const v = $('pd-view'), wrap = $('pd-wrap');
        z = Math.max(100, Math.min(800, z));
        if (cx == null) { const r = v.getBoundingClientRect(); cx = r.left + r.width / 2; cy = r.top + r.height / 2; }
        const r0 = wrap.getBoundingClientRect(), fx = (cx - r0.left) / r0.width, fy = (cy - r0.top) / r0.height;
        pdZ = z; pdZoom();
        const r1 = wrap.getBoundingClientRect();
        v.scrollLeft += r1.left + fx * r1.width - cx; v.scrollTop += r1.top + fy * r1.height - cy;
    }
    // The brush cursor: a circle of the real brush size (follows zoom and the [ ] keys), blue when the stroke will erase
    function pdRing(e) {
        const R = $('pd-ring');
        if (!pd || !e) { R.style.display = 'none'; return; }
        pd.lastE = e;
        const mc = $('pd-mask'), r = mc.getBoundingClientRect(), d = Math.max(4, pdBrushPx() * r.width / mc.width);
        R.style.width = R.style.height = d + 'px'; R.style.left = e.clientX + 'px'; R.style.top = e.clientY + 'px';
        R.style.borderColor = ($('pd-erase').checked !== (e.altKey || e.shiftKey)) ? '#38bdf8' : '#ffffff';
        R.style.borderWidth = '2px'; R.style.boxShadow = '0 0 0 1px rgba(0,0,0,0.7)';
        if (pdFxOp() === 'pick' && pd.base) {          // Picker: a ring in the color that a click would take
            const p = pdPoint(e), x = Math.max(1, Math.min(pd.S - 2, Math.floor(p.x))), y = Math.max(1, Math.min(pd.H - 2, Math.floor(p.y))), q = pd.base.getContext('2d').getImageData(x - 1, y - 1, 3, 3).data, s = [0, 0, 0];
            for (let i = 0; i < 9; i++) for (let c = 0; c < 3; c++) s[c] += q[i * 4 + c] / 9;
            const hex = '#' + s.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
            if (pd.picking) { $('pd-color').value = hex; pdSetStatus('Color ' + hex + ' under your finger: lift to take it.'); }
            if (e.pointerType === 'touch') R.style.top = (e.clientY - 70) + 'px';       // a finger would cover the ring: it is shown above
            R.style.width = R.style.height = '54px'; R.style.borderWidth = '11px'; R.style.borderColor = 'rgb(' + s.map(Math.round).join(',') + ')'; R.style.boxShadow = '0 0 0 1.5px rgba(0,0,0,0.85), inset 0 0 0 1.5px rgba(0,0,0,0.85)';
        }
        R.style.display = 'block';
        const SR = $('pd-src'), cl = pd.clone;
        if (pdFxOp() === 'clone' && cl && (cl.off || cl.src)) {          // where the copy comes from: fixed until the first stroke, then it follows the brush
            const p = pdPoint(e), q = cl.off ? { x: p.x + cl.off.x, y: p.y + cl.off.y } : cl.src;
            SR.style.width = SR.style.height = d + 'px';
            SR.style.left = (r.left + q.x * r.width / mc.width) + 'px'; SR.style.top = (r.top + q.y * r.height / mc.height) + 'px'; SR.style.display = 'block';
        } else SR.style.display = 'none';
    }
    // Magnifying glass: 3x view of the picture, the paint and the brush, beside the cursor
    function pdLoupe(e) {
        const L = $('pd-loupe');
        if (!pd || !$('pd-loupe-chk').checked) { L.style.display = 'none'; return; }
        pd.lastE = e;
        const mc = $('pd-mask'), r = mc.getBoundingClientRect(), k = mc.width / r.width, p = pdPoint(e), Z = 3, side = L.width / Z * k;
        const c = L.getContext('2d');
        c.clearRect(0, 0, L.width, L.height); c.imageSmoothingEnabled = true;
        c.drawImage($('pd-base'), p.x - side / 2, p.y - side / 2, side, side, 0, 0, L.width, L.height);
        if ($('pd-cut').style.display !== 'none') { c.globalAlpha = 0.6; c.drawImage($('pd-cut'), p.x - side / 2, p.y - side / 2, side, side, 0, 0, L.width, L.height); }
        c.globalAlpha = pd.kind === 'cut' ? 0.25 : 0.55;
        c.drawImage(mc, p.x - side / 2, p.y - side / 2, side, side, 0, 0, L.width, L.height);
        c.globalAlpha = 1;
        c.strokeStyle = '#fff'; c.lineWidth = 1.5; c.beginPath(); c.arc(L.width / 2, L.height / 2, Math.max(2, pdBrushPx() / 2 * L.width / side), 0, 2 * Math.PI); c.stroke();
        let x = e.clientX + 28, y = e.clientY - L.height - 20;
        if (x + L.width > window.innerWidth) x = e.clientX - L.width - 28;
        if (y < 4) y = e.clientY + 28;
        L.style.left = x + 'px'; L.style.top = y + 'px'; L.style.display = 'block';
    }
    // ---- retouch window: pan and zoom over the whole panorama by re-rendering the view ----
    const pdTF = { tx: 0, ty: 0, k: 1 };
    let pdWheelAcc = 0;
    let pdNavTimer = 0, pdNavBusy = false;
    function pdApplyTF() {
        for (const id of ['pd-base', 'pd-cut', 'pd-chg', 'pd-mask']) {
            const el = $(id); el.style.transformOrigin = '0 0';
            el.style.transform = (pdTF.tx || pdTF.ty || pdTF.k !== 1) ? `translate(${pdTF.tx}px, ${pdTF.ty}px) scale(${pdTF.k})` : '';
        }
    }
    function pdResetTF() { pdTF.tx = pdTF.ty = 0; pdTF.k = 1; pdApplyTF(); }
    // Paint that is an AI spot not yet in the queue (it is queued by itself before the view moves, or when the spots are sent)
    function pdAiPaint() { return !!pd && pd.mode === 'retouch' && pd.kind !== 'cut' && pdFxOp() === 'fill' && !pdLocal() && !pd.result && pdHasMask(); }
    function pdNavDirty() { return !!pd && pd.mode === 'retouch' && (pdHasMask() || pd.cuts.size > 0 || !!pd.result); }
    // true when the view may be moved now
    function pdNavOk() {
        if (!pd || pd.mode !== 'retouch') return false;
        if (pdNavBusy) return false;
        if (pdAiPaint()) { pdQueue(); if (!pdHasMask()) return true; }          // an AI spot: queued, and the view may move on
        if (pdNavDirty()) { pdSetStatus('Finish this spot first: Accept, Discard or Clear the paint. Then pan or zoom to the next place.'); return false; }
        return true;
    }
    function pdNavSoon(ms) { clearTimeout(pdNavTimer); pdNavTimer = setTimeout(pdNavCommit, ms); }
    async function pdNavCommit() {
        if (!pd || pd.mode !== 'retouch' || pdNavBusy) return;
        const k = pdTF.k;
        if (Math.abs(pdTF.tx) < 2 && Math.abs(pdTF.ty) < 2 && Math.abs(k - 1) < 0.02) { pdResetTF(); return; }
        const W = $('pd-wrap').clientWidth;
        const qx = (W / 2 - pdTF.tx) / k, qy = (W / 2 - pdTF.ty) / k;
        const v = { w: pd.S, h: pd.S, basis: pd.basis, fov: pd.fov };
        const dir = rayFromNorm(v, pd.basis, qx / W * 2 - 1, 1 - qy / W * 2);
        const fov = Math.max(8, Math.min(120, 2 * Math.atan(Math.tan(pd.fov * DEG / 2) / k) / DEG));
        await pdGoTo(pdNavBasis(dir), fov, 'Rendering the new view…');
    }
    // The orientation of the window after panning to look along dir. It depends only on where we look, not on the path taken (chaining each
    // new view from the previous one let the picture twist a little more with every pan).
    // A window opened level (the horizon horizontal, at any height of view short of the poles) keeps the horizon level wherever it is panned.
    // One opened straight down or up keeps the "up" it opened with, so the picture slides like a flat map instead of turning.
    // Only where those mean nothing (looking along that "up") does it turn the shortest way from its first view.
    function pdNavBasis(dir) {
        dir = dir.clone().normalize();
        const b0 = pd.basis0, UP = new THREE.Vector3(0, 1, 0);
        if (Math.abs(b0.r.y) < 0.02 && Math.abs(b0.f.y) < 0.99 && Math.abs(dir.y) < 0.999) return basisLook(dir, UP);
        if (Math.abs(dir.dot(b0.u)) < 0.999) return basisLook(dir, b0.u);
        const q = new THREE.Quaternion().setFromUnitVectors(b0.f, dir);
        return { r: b0.r.clone().applyQuaternion(q), u: b0.u.clone().applyQuaternion(q), f: dir };
    }
    // Render the window again for a new view (clears the paint: the caller has checked there is none that matters).
    async function pdGoTo(basis, fov, busyMsg) {
        const me = pd;
        pdNavBusy = true; pdSetStatus(busyMsg);
        try {
            const base = me.target === 'bg' ? await renderBgView(basis, fov, pd.S) : await renderView(basis, fov, pd.S, true);
            if (pd !== me) return;
            pd.base = base; pd.basis = basis; pd.fov = fov; pd.coverage = base.coverage; pd.clone = null;
            pdDrawBase(false);
            const mc = $('pd-mask'); mc.getContext('2d').clearRect(0, 0, mc.width, mc.height);
            const cc = $('pd-cut'); cc.getContext('2d').clearRect(0, 0, cc.width, cc.height); pd.cuts.clear(); pd.curCut = null;
            pdResetTF();
            pdShowEdits();
            pdSetStatus(`View: ${Math.round(fov)}° wide. Paint over what should change.`);
        } catch (e) { pdResetTF(); pdSetStatus('Could not render the view: ' + (e.message || e)); }
        finally { pdNavBusy = false; }
    }
    // Back to the view the window opened with (same direction, horizon and width).
    async function pdGoHome() {
        if (!pd || pd.mode !== 'retouch' || !pdNavOk()) return;
        clearTimeout(pdNavTimer);
        const b = pd.basis0;
        if (pd.basis.f.dot(b.f) > 0.999999 && pd.basis.u.dot(b.u) > 0.999999 && Math.abs(pd.fov - pd.fov0) < 0.01) { pdResetTF(); pdSetStatus('Already at the first view.'); return; }
        await pdGoTo({ r: b.r.clone(), u: b.u.clone(), f: b.f.clone() }, pd.fov0, 'Going back to the first view…');
    }
    async function pdUndo() {
        if (!pd) return;
        if (pd.mode === 'retouch' && pd.kind === 'cut' ? (pd.cuts.size > 0) : pdHasMask()) { $('pd-clear').click(); pdSetStatus('Paint cleared.'); return; }
        if (pd.mode !== 'retouch') return;
        for (let i = rtQueue.length - 1; i >= 0; i--) {
            const j = rtQueue[i];
            if (j.state === 'waiting' || j.state === 'failed') { rtQueue.splice(i, 1); refreshQueue(); pdSetStatus(`${j.name} taken out of the queue.`); return; }
        }
        if (pd.target === 'bg' && bgEdits.length) {
            const me = pd; await bgUndoLast(); await pdRefreshView();
            if (pd === me) pdSetStatus('The last edit of the background panorama was taken back.' + (bgEdits.length ? ' Undo last takes back the one before.' : ''));
            return;
        }
        pdSetStatus('Nothing to undo.');
    }
    function pdClose() { $('pd-edits-box').style.display = 'none'; $('pd-ring').style.display = 'none'; $('pd-src').style.display = 'none'; $('pd-loupe').style.display = 'none'; $('pd-modal').style.display = 'none'; if (stitchAI) stitchAI.stop(); pd = null; }
    function pdPoint(e) { const m = $('pd-mask'), r = m.getBoundingClientRect(); return { x: (e.clientX - r.left) * m.width / r.width, y: (e.clientY - r.top) * m.height / r.height }; }
    function cutStroke(a, b) {
        const erase = $('pd-erase').checked !== pdAlt, w = pdBrushPx();
        const targets = [$('pd-cut').getContext('2d')];
        if (erase) pd.cuts.forEach(cv => targets.push(cv.getContext('2d')));
        else if (pd.curCut != null) {
            if (!pd.cuts.has(pd.curCut)) { const cv = document.createElement('canvas'); cv.width = pd.S; cv.height = pd.H; pd.cuts.set(pd.curCut, cv); }
            targets.push(pd.cuts.get(pd.curCut).getContext('2d'));
        } else return;
        for (const c of targets) {
            c.globalCompositeOperation = erase ? 'destination-out' : 'source-over';
            c.strokeStyle = 'rgb(255,150,0)'; c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = w;
            c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x + 0.01, b.y); c.stroke();
        }
    }
    function pdStroke(a, b) {
        if (pd && pd.kind === 'cut') { cutStroke(a, b); return; }
        const c = $('pd-mask').getContext('2d');
        c.globalCompositeOperation = ($('pd-erase').checked !== pdAlt) && !pdUndoing ? 'destination-out' : 'source-over';
        c.strokeStyle = 'rgb(255,0,80)'; c.lineCap = 'round'; c.lineJoin = 'round'; c.lineWidth = pdBrushPx();
        c.beginPath(); c.moveTo(a.x, a.y); c.lineTo(b.x + 0.01, b.y); c.stroke();
    }
    function pdPickColor(p) {
        const x = Math.max(1, Math.min(pd.S - 2, Math.floor(p.x))), y = Math.max(1, Math.min(pd.H - 2, Math.floor(p.y))), s = [0, 0, 0];
        const d = pd.base.getContext('2d').getImageData(x - 1, y - 1, 3, 3).data;          // the mean of 3 x 3 pixels, so that noise does not decide
        for (let i = 0; i < 9; i++) for (let c = 0; c < 3; c++) s[c] += d[i * 4 + c] / 9;
        $('pd-color').value = '#' + s.map(v => Math.round(v).toString(16).padStart(2, '0')).join('');
        pdSetStatus('Color ' + $('pd-color').value + ' taken. Click again to take another, or choose Paint to use it.');
    }
    // Per effect tool: make the effect as soon as the mouse is lifted (the default; Restore always does), or show a preview first
    // Live: like Apply on release, but the result shows while you paint (without the paint over it)
    const pdAutoFlag = {}, pdLiveFlag = {};
    function pdAutoOn(op) { op = op || pdFxOp(); if (op === 'restore') return true; return !!FX_NAME[op] && pdAutoFlag[op] !== false; }
    function pdLiveOn(op) { op = op || pdFxOp(); return pdAutoOn(op) && op !== 'restore' && pdLiveFlag[op] === true && !pdLiveSlow; }
    function pdModeSync() {
        const op = pdFxOp(); if (!FX_NAME[op]) return;
        const auto = pdAutoOn(op), live = pdLiveFlag[op] === true;
        $('pd-am-apply').checked = auto && !live; $('pd-am-live').checked = auto && live; $('pd-am-prev').checked = !auto;
    }
    function pdCycleMode() {          // E: Apply on release -> Live -> Preview first
        const op = pdFxOp(); if (!pd || pd.target !== 'bg' || !FX_NAME[op]) return;
        const st = !pdAutoOn(op) ? 'preview' : pdLiveFlag[op] ? 'live' : 'apply', nx = st === 'apply' ? 'live' : st === 'live' ? 'preview' : 'apply';
        pdAutoFlag[op] = nx !== 'preview'; pdLiveFlag[op] = nx === 'live'; pdModeSync();
        pdSetStatus(nx === 'apply' ? 'Apply on release: the change is made as soon as you let go.' : nx === 'live' ? 'Live: the result shows while you paint and is made when you let go.' : 'Preview first: the result is shown when you let go; Accept keeps it, Discard drops it (the paint stays).' + kb(' Hold X to hide the paint.', ''));
    }
    // X held, or the pointer over Preview: the paint is hidden, to see the result as it will be
    let pdPaintHidden = false, pdLiveStroke = false, pdLiveSlow = false;
    function pdHidePaint(on) { if (pdPaintHidden === on) return; pdPaintHidden = on; pdMaskShade(); }
    // While painting in Live mode: the result of the paint so far, drawn over the view (the paint itself is hidden)
    let pdLiveT = 0, pdLiveCost = 0, pdLiveLast = 0, pdLiveBusy = false;
    function pdLiveSched() {
        if (!pd || !pdLiveStroke || pdLiveBusy) return;
        clearTimeout(pdLiveT);
        pdLiveT = setTimeout(() => {
            if (!pd || !pdLiveStroke) return;
            pdLiveBusy = true;
            try {
                const t0 = performance.now(), fx = pdFxParams(); if (!fx) return;
                let mc = $('pd-mask');
                if (pd.selSave) { mc = copyCanvas(mc); const c = mc.getContext('2d'); c.globalCompositeOperation = 'destination-in'; c.drawImage(pd.selSave, 0, 0); }
                const rc = fxResultCanvas(pd.base, fx, pd.S, pd.H, pd.basis, pd.fov), o = makePatchPieces(pd.S, pd.H, pd.base, mc, rc, false, fxFeather(fx));
                if (!pdLiveStroke) return;
                const c = $('pd-base').getContext('2d'); c.drawImage(pd.base, 0, 0); c.drawImage(o.preview, 0, 0);
                pdLiveCost = performance.now() - t0;
                if (pdLiveCost > 1500) { pdLiveSlow = true; pdSetStatus('Live is too slow for this view: the result shows when you let go.'); }
            } catch (e) { /* the final result reports problems */ }
            finally { pdLiveBusy = false; pdLiveLast = performance.now(); }
        }, Math.max(0, pdLiveLast + Math.max(60, pdLiveCost * 1.5) - performance.now()));
    }
    // The mouse was lifted after a stroke
    async function pdLift() {
        if (!pd || pd.mode !== 'retouch' || pd.kind === 'cut') return;
        if (pdFxOp() === 'fill') {          // Fill from the surroundings: made as soon as the mouse is lifted (Undo last takes it back). AI spots wait for Send.
            if (pdLocal() && !pd.strokeErase && pdHasMask() && !pd.lifting) {
                const me = pd; pd.lifting = true;
                try { await pdRunLocal(); if (pd === me && pd.result) await pdAccept(); } finally { if (pd === me) pd.lifting = false; }
            } else if (!pdLocal() && pdHasMask()) pdFxSync(), pdSetStatus('Paint more, or write what should be there and press Send to AI. Pan to another place to mark the next spot: this one is queued (amber number).' + kb(' Enter queues it too.', ''));
            return;
        }
        if (pd.target !== 'bg') return;
        const me = pd, op = pd.strokeOp || pdFxOp(), undo = pdUndoing, sel = pd.selSave; pdUndoing = false; pd.selSave = null;
        if (PD_NOFX[op] && op !== 'restore') return;
        if (!pdAutoOn(op)) { if (pdHasMask()) pdRunFx(); return; }               // preview mode: the result is shown as soon as the mouse stops
        pd.lifting = true;
        try {
            if (sel) { const c = $('pd-mask').getContext('2d'); c.globalCompositeOperation = 'destination-in'; c.drawImage(sel, 0, 0); c.globalCompositeOperation = 'source-over'; }
            if (!pdHasMask()) { if (sel) pdSetStatus('That was outside the Mask selection: nothing changed. Clear removes the selection.'); return; }
            if (op === 'restore' || undo) await pdTakeBack(op === 'restore' ? 'all' : 'last');
            else { await pdRunFx(); if (pd === me && pd.result) await pdAccept(); }
        } finally {
            if (pd === me) {
                pd.lifting = false;
                if (sel) { const m = $('pd-mask'), c = m.getContext('2d'); c.clearRect(0, 0, m.width, m.height); c.drawImage(sel, 0, 0); pdMaskShade(); }
            }
        }
    }
    // Go back, on the painted pixels, to what they were before the newest edit that changed them ('last'), or before all of them ('all')
    async function pdTakeBack(mode) {
        const me = pd, mc = $('pd-mask');
        pdSetStatus(mode === 'all' ? 'Restoring…' : 'Taking back…');
        const o = makePatchPieces(pd.S, pd.H, pd.base, mc, pd.base, false, 0.03);
        try { await applyPatchToBg(pd.basis, pd.fov, pd.S, pd.H, null, o.alpha, null, null, mode); }
        catch (e) { if (pd === me) { pdSetStatus(e.message || String(e)); mc.getContext('2d').clearRect(0, 0, mc.width, mc.height); } return; }
        if (pd !== me) return;
        mc.getContext('2d').clearRect(0, 0, mc.width, mc.height);
        await pdRefreshView();
        if (pd === me) pdSetStatus((mode === 'all' ? 'Restored' : 'Took back the last change') + ' on those pixels (listed below; Undo last reverses it).', true);
    }
    // The settings changed while a preview is being looked at: it follows at once (as often as the view allows), with the paint hidden meanwhile
    let pdReprevT = 0, pdRpCost = 0, pdRpLast = 0, pdSlideT = 0, pdSlideHold = false;
    function pdReprev() {
        clearTimeout(pdReprevT);
        if (!pd || pd.mode !== 'retouch' || pd.target !== 'bg' || pd.kind === 'cut' || !FX_NAME[pdFxOp()] || pdAutoOn()) return;
        pdHidePaint(true); clearTimeout(pdSlideT); pdSlideT = setTimeout(() => { if (!pdSlideHold) pdHidePaint(false); }, 500);
        pdReprevT = setTimeout(async () => {
            if (!pd || pd.lifting || !pdHasMask()) return;
            const t0 = performance.now(); await pdRunFx(true); pdRpCost = performance.now() - t0; pdRpLast = performance.now();
        }, Math.max(0, pdRpLast + Math.max(40, pdRpCost * 1.5) - performance.now()));
    }
    function pdInit() {
        const mc = $('pd-mask');
        let last = null, pan = null, space = false;
        const panMove = e => { if (!pan) return; if (pan.nav) { pdTF.tx = pan.tx + e.clientX - pan.x; pdTF.ty = pan.ty + e.clientY - pan.y; pdApplyTF(); e.preventDefault(); return; } const v = $('pd-view'); v.scrollLeft = pan.sl - (e.clientX - pan.x); v.scrollTop = pan.st - (e.clientY - pan.y); e.preventDefault(); };
        const panEnd = () => { const wasNav = pan && pan.nav; pan = null; if (wasNav) pdNavSoon(30); document.removeEventListener('pointermove', panMove); document.removeEventListener('pointerup', panEnd); document.removeEventListener('pointercancel', panEnd); mc.style.cursor = 'none'; };
        window.addEventListener('keydown', e => { if (pd && e.key === ' ' && !/^(TEXTAREA|INPUT|SELECT)$/.test((document.activeElement || {}).tagName || '')) { space = true; e.preventDefault(); } });
        window.addEventListener('keyup', e => { if (e.key === ' ') space = false; });
        window.addEventListener('keydown', e => { if (pd && e.key === 'Home' && !/^(TEXTAREA|INPUT|SELECT)$/.test((document.activeElement || {}).tagName || '')) { e.preventDefault(); pdGoHome(); } });
        $('pd-home').addEventListener('click', pdGoHome);
        mc.addEventListener('pointerdown', e => {
            if (!pd) return;
            pdAlt = e.altKey || e.shiftKey;
            if (e.button !== 0 || space) {                      // right or middle button, or Space + left: drag the picture
                if (pd.mode === 'retouch') { if (!pdNavOk()) { e.preventDefault(); return; } clearTimeout(pdNavTimer); }
                const v = $('pd-view'); pan = { x: e.clientX, y: e.clientY, sl: v.scrollLeft, st: v.scrollTop, nav: pd.mode === 'retouch', tx: pdTF.tx, ty: pdTF.ty };
                mc.style.cursor = 'grabbing';
                document.addEventListener('pointermove', panMove); document.addEventListener('pointerup', panEnd); document.addEventListener('pointercancel', panEnd);
                e.preventDefault(); return;
            }
            mc.setPointerCapture(e.pointerId); last = pdPoint(e);
            pdUndoing = false; pd.strokeErase = $('pd-erase').checked !== pdAlt;
            if (pd.mode === 'retouch' && pd.target === 'bg' && pd.kind !== 'cut') {
                const op = pdFxOp(), er = $('pd-erase').checked !== pdAlt;
                if (op === 'pick') { pd.picking = true; last = null; pdRing(e); e.preventDefault(); return; }          // the color is taken when the finger or button is lifted; while it is down the ring and the Color box show what would be taken
                if (op === 'clone') {
                    if ((e.altKey && !e.shiftKey) || pd.markSrc || (TOUCH && !pd.clone)) {          // Alt + click, the button, or the first touch: the spot to copy from
                        pd.markSrc = false; pd.clone = { src: last, off: null }; last = null; pdRing(e);
                        pdSetStatus('Source marked (the dashed circle). Now paint where it should go: the copy follows the brush at the same distance.');
                        e.preventDefault(); return;
                    }
                    if (er) { /* Shift + paint takes back: no source needed */ }
                    else if (!pd.clone) { last = null; pdSetStatus(kb('Alt + click the spot to copy from first, then paint where it should go.', 'Touch the spot to copy from first, then paint where it should go.')); e.preventDefault(); return; }
                    else if (!pd.clone.off) pd.clone.off = { x: pd.clone.src.x - last.x, y: pd.clone.src.y - last.y };
                }
                if (pd.lifting) { last = null; pdSetStatus('Still working on the last stroke…'); e.preventDefault(); return; }
                pd.strokeOp = op; pdUndoing = er && pdAutoOn(op);
                if (op === 'fill') pd.maskSel = false; else if (op === 'mask' && !er) pd.maskSel = true;
                // with a Mask selection, an effect brush that applies on lifting is painted on a clean mask and cut to the selection afterwards
                pd.selSave = null;
                if (pdAutoOn(op) && pd.maskSel && pdHasMask()) { const m = $('pd-mask'); pd.selSave = copyCanvas(m); m.getContext('2d').clearRect(0, 0, m.width, m.height); }
                pdLiveStroke = pdLiveOn(op) && !pdUndoing && !er && !PD_NOFX[op] && !(op === 'clone' && !pd.clone); if (pdLiveStroke) pdMaskShade();
            }
            if (pd.lifting && pd.kind !== 'cut') { last = null; pdSetStatus('Still working on the last stroke…'); e.preventDefault(); return; }
            if (pd.kind === 'cut') {
                const v = { w: pd.S, h: pd.S, basis: pd.basis, fov: pd.fov };
                const img = photoAt(rayFromNorm(v, pd.basis, last.x / pd.S * 2 - 1, 1 - last.y / pd.H * 2));
                pd.curCut = img ? img.id : null;
                pdSetStatus(img ? 'Brushing out of ' + imgIndexLabel(img) + ' ' + img.name : 'No photo shows here: nothing to brush out. Use Fill instead.');
            } else pdResultInvalid();
            pdStroke(last, last); e.preventDefault();
        });
        mc.addEventListener('pointermove', e => {
            pdAlt = e.altKey || e.shiftKey;
            if (!last) return; const p = pdPoint(e); pdStroke(last, p); last = p; if (pdLiveStroke) pdLiveSched();
        });
        const end = () => { const was = last; last = null; if (pdLiveStroke) { pdLiveStroke = false; clearTimeout(pdLiveT); pdLiveSlow = false; if (pd) pdDrawBase(!!pd.result && $('pd-show').checked); } if (was) pdLift(); };
        mc.addEventListener('pointerup', e => { if (pd && pd.picking) { pd.picking = false; pdPickColor(pdPoint(e)); $('pd-ring').style.display = 'none'; } });
        mc.addEventListener('pointercancel', () => { if (pd) pd.picking = false; });
        mc.addEventListener('pointerup', end); mc.addEventListener('pointercancel', end);
        mc.addEventListener('pointermove', pdLoupe); mc.addEventListener('pointerdown', pdLoupe);
        mc.addEventListener('pointermove', e => { if (!pan) pdRing(e); else $('pd-ring').style.display = 'none'; });
        mc.addEventListener('pointerdown', e => { if (e.button === 0 && !space) pdRing(e); });
        mc.addEventListener('pointerleave', () => { $('pd-loupe').style.display = 'none'; $('pd-ring').style.display = 'none'; $('pd-src').style.display = 'none'; });
        $('pd-view').addEventListener('wheel', e => {
            if (!pd) return; e.preventDefault();
            const wd = e.deltaY || e.deltaX;          // Shift + wheel scrolls sideways on some systems
            if (e.altKey) { pdWheelAcc += wd; if (Math.abs(pdWheelAcc) >= 40) { brushSizeKey(pdWheelAcc < 0 ? 1 : -1); pdWheelAcc = 0; } return; }
            if (e.shiftKey) {
                const a = $('pd-amt');
                if ($('pd-fxopts').style.display !== 'none' && $('pd-amt-row').style.display !== 'none') {
                    pdWheelAcc += wd; if (Math.abs(pdWheelAcc) < 40) return;
                    const st = Math.max(1, Math.round((+a.max - +a.min) / 40));
                    a.value = Math.max(+a.min, Math.min(+a.max, +a.value + (pdWheelAcc < 0 ? st : -st))); pdWheelAcc = 0;
                    a.dispatchEvent(new Event('input'));
                }
                return;
            }
            const f = Math.exp(-Math.max(-150, Math.min(150, e.deltaY)) * 0.0006);
            if (pd.mode !== 'retouch') { pdSetZoom(pdZ * f, e.clientX, e.clientY); return; }
            if (!pdNavOk()) return;
            const r = $('pd-wrap').getBoundingClientRect(), W = $('pd-wrap').clientWidth;
            const k2 = Math.max(0.25, Math.min(8, pdTF.k * f)), s2 = k2 / pdTF.k;
            const cx = Math.max(0, Math.min(W, e.clientX - r.left)), cy = Math.max(0, Math.min(W, e.clientY - r.top));
            pdTF.tx = cx - s2 * (cx - pdTF.tx); pdTF.ty = cy - s2 * (cy - pdTF.ty); pdTF.k = k2;
            pdApplyTF(); pdNavSoon(450);
        }, { passive: false });
        // ---- touch screens: one finger paints, two fingers move and zoom the view ----
        // A finger that lands alone waits a moment (about 0.1 s) before it starts painting: if a second finger lands in that time the
        // pair is a pinch and nothing is painted. Once a stroke is under way, a second finger is ignored.
        const touches = new Map(); let pend = null, pinch = null;
        const fireDown = () => {
            if (!pend) return; const o = pend.e; clearTimeout(pend.t); pend = null;
            const ev = new PointerEvent('pointerdown', { pointerId: o.pointerId, pointerType: 'touch', isPrimary: o.isPrimary, button: 0, buttons: 1, clientX: o.clientX, clientY: o.clientY, bubbles: true, cancelable: true, pressure: 0.5 });
            ev.__replay = true; mc.dispatchEvent(ev);
        };
        const pinchPts = () => { const q = [...touches.values()]; const a = q[0], b = q[1]; return { d: Math.max(10, Math.hypot(a.x - b.x, a.y - b.y)), x: (a.x + b.x) / 2, y: (a.y + b.y) / 2 }; };
        const pinchMove = () => {
            if (!pinch || touches.size < 2 || !pd || pdNavBusy) return;
            const c = pinchPts(), f = c.d / pinch.d, dx = c.x - pinch.x, dy = c.y - pinch.y;
            if (pd.mode === 'retouch') {
                const r = $('pd-wrap').getBoundingClientRect(), W = $('pd-wrap').clientWidth;
                const k2 = Math.max(0.25, Math.min(8, pdTF.k * f)), s2 = k2 / pdTF.k;
                const cx = Math.max(0, Math.min(W, pinch.x - r.left)), cy = Math.max(0, Math.min(W, pinch.y - r.top));
                pdTF.tx = cx - s2 * (cx - pdTF.tx) + dx; pdTF.ty = cy - s2 * (cy - pdTF.ty) + dy; pdTF.k = k2;
                pdApplyTF(); pdNavSoon(450);
            } else {
                const v = $('pd-view'); pdSetZoom(pdZ * f, pinch.x, pinch.y); v.scrollLeft -= dx; v.scrollTop -= dy;
            }
            pinch = c;
        };
        mc.addEventListener('pointerdown', e => {
            if (e.pointerType !== 'touch' || e.__replay || !pd) return;
            touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
            e.stopImmediatePropagation();
            if (touches.size === 1) { pend = { e, x: e.clientX, y: e.clientY, t: setTimeout(fireDown, 110) }; return; }
            e.preventDefault();
            if (last || pinch || touches.size > 2) return;         // already painting, or a third finger: ignored
            if (pend) { clearTimeout(pend.t); pend = null; }
            if (pd.mode === 'retouch' && !pdNavOk()) return;
            clearTimeout(pdNavTimer); pinch = pinchPts();
            $('pd-ring').style.display = 'none'; $('pd-loupe').style.display = 'none';
        }, true);
        mc.addEventListener('pointermove', e => {
            if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
            touches.set(e.pointerId, { x: e.clientX, y: e.clientY });
            if (pend && touches.size === 1 && Math.hypot(e.clientX - pend.x, e.clientY - pend.y) > 8) fireDown();
            if (touches.size > 1 || pinch) { e.stopImmediatePropagation(); if (pinch) pinchMove(); }
        }, true);
        const touchUp = e => {
            if (e.pointerType !== 'touch' || !touches.has(e.pointerId)) return;
            if (pend && touches.size === 1) fireDown();             // a tap: paint the dab
            touches.delete(e.pointerId);
            if (pinch && touches.size < 2) { pinch = null; pdNavSoon(30); }
        };
        mc.addEventListener('pointerup', touchUp, true); mc.addEventListener('pointercancel', touchUp, true);
        // Moving the Brush slider shows the brush circle in the middle of the view, so its size can be seen while the finger is on the slider
        let sizeRingT = 0;
        $('pd-mark-src').addEventListener('click', () => { if (pd) { pd.markSrc = true; pdSetStatus(kb('Now click the spot to copy from.', 'Now touch the spot to copy from.')); } });
        $('pd-brush').addEventListener('input', () => {
            if (!pd) return;
            const r = $('pd-view').getBoundingClientRect();
            pdRing({ clientX: r.left + r.width / 2, clientY: r.top + r.height / 2, altKey: false, shiftKey: false });
            $('pd-src').style.display = 'none';
            clearTimeout(sizeRingT); sizeRingT = setTimeout(() => { if (!last) $('pd-ring').style.display = 'none'; }, 1200);
        });
        mc.addEventListener('contextmenu', e => e.preventDefault());
        $('pd-view').addEventListener('contextmenu', e => e.preventDefault());
        new ResizeObserver(() => { if (pd) { pdMeasure(); pdZoom(); } }).observe($('pd-view'));
        $('pd-paintshow').addEventListener('change', pdMaskShade);
        $('pd-loupe-chk').addEventListener('change', () => { if (!$('pd-loupe-chk').checked) $('pd-loupe').style.display = 'none'; });
        $('pd-clear').addEventListener('click', () => {
            if (pd && pd.kind === 'cut') { const c = $('pd-cut'); c.getContext('2d').clearRect(0, 0, c.width, c.height); pd.cuts.clear(); return; }
            const m = $('pd-mask'); m.getContext('2d').clearRect(0, 0, m.width, m.height); pdResultInvalid(); if (pd) pd.maskSel = false;
        });
        $('pd-kind-fill').addEventListener('change', pdKindUI);
        $('pd-kind-cut').addEventListener('change', pdKindUI);
        $('pd-uncov').addEventListener('click', pdMarkUncovered);
        $('pd-cancel').addEventListener('click', pdClose);
        $('pd-undo').addEventListener('click', pdUndo);
        $('pd-ok').addEventListener('click', pdAccept);
        $('pd-run').addEventListener('click', pdRun);
        $('pd-queue').addEventListener('click', pdQueue);
        $('pd-runq').addEventListener('click', runQueue);
        $('queue-run').addEventListener('click', runQueue);
        $('pd-op').addEventListener('change', () => { pdResultInvalid(); pdFxSync(true); });
        let pdBoxCss = null;
        $('pd-max').addEventListener('click', () => {
            const b = $('pd-box');
            if (pdBoxCss === null) { pdBoxCss = b.style.cssText; b.style.cssText += ';width:calc(100vw - 16px);height:calc(100vh - 16px);max-width:none;max-height:none;'; $('pd-max').textContent = 'Normal size'; }
            else { b.style.cssText = pdBoxCss; pdBoxCss = null; $('pd-max').textContent = 'Full window'; }
            pdFit();
        });
        for (const b of document.querySelectorAll('.fxt')) b.addEventListener('click', () => { if ($('pd-op').value !== b.dataset.op) { $('pd-op').value = b.dataset.op; $('pd-op').dispatchEvent(new Event('change')); } });
        const pdSlid = () => { if (pd && pd.result && pd.fx && !pdAutoOn()) { pd.stale = true; pdReprev(); } else pdResultInvalid(); };
        for (const id of ['pd-amt', 'pd-rad', 'pd-soft']) $(id).addEventListener('input', () => { pdSlid(); pdFxSync(); });
        $('pd-color').addEventListener('input', pdSlid);
        window.addEventListener('pointerup', () => { if (pdSlideHold) { pdSlideHold = false; clearTimeout(pdSlideT); pdSlideT = setTimeout(() => pdHidePaint(false), 150); } });
        for (const id of ['pd-amt', 'pd-rad', 'pd-soft', 'pd-color']) $(id).addEventListener('pointerdown', () => { pdSlideHold = true; });
        for (const id of ['pd-am-apply', 'pd-am-live', 'pd-am-prev']) $(id).addEventListener('change', () => {
            const op = pdFxOp(); pdAutoFlag[op] = !$('pd-am-prev').checked; pdLiveFlag[op] = $('pd-am-live').checked;
        });
        $('pd-run').addEventListener('mouseenter', () => { if (pdFxOp() !== 'fill') pdHidePaint(true); });
        $('pd-run').addEventListener('mouseleave', () => pdHidePaint(false));
        $('pd-discard').addEventListener('click', () => { if (pd && pd.result) { pdResultInvalid(); pdSetStatus('Result dropped. The paint stays: change the settings and press Preview, or Clear the paint.'); } });
        $('pd-chgshow').addEventListener('change', () => { $('pd-chg').style.display = $('pd-chgshow').checked ? '' : 'none'; });
        $('queue-clear').addEventListener('click', () => { if (rtQRunning) return; rtQueue.length = 0; refreshQueue(); });
        $('pd-stop').addEventListener('click', () => { if (stitchAI) stitchAI.stop(); });
        $('pd-show').addEventListener('change', pdShow);
        {
            const sel = $('pd-provider');
            for (const [k, l] of [['local', 'Local edit (no AI, free)'], ['sd', 'AI on this computer: Stable Diffusion'], ['openai', 'AI: OpenAI'], ['gemini', 'AI: Google Gemini'], ['openrouter', 'AI: OpenRouter']]) {
                const o = document.createElement('option'); o.value = k; o.textContent = l; sel.appendChild(o);
            }
        }
        $('pd-provider').addEventListener('change', () => {
            const v = $('pd-provider').value;
            pdLocal(v === 'local'); pdFxSync();
            if (v !== 'local') pdEnsureAI().then(() => { stitchAI.provider = v; pdSyncAI(); }).catch(e => pdSetStatus(e.message));
            else pdSyncAI();
        });
        $('pd-model').addEventListener('change', () => { if (stitchAI) stitchAI.model = $('pd-model').value; });
        $('pd-model-list').addEventListener('change', () => { $('pd-model').value = $('pd-model-list').value; if (stitchAI) stitchAI.model = $('pd-model').value; });
        $('pd-remember').addEventListener('change', () => { if (stitchAI) stitchAI.setRemember($('pd-remember').checked); });
        $('pd-models-btn').addEventListener('click', pdListModels);
        $('pd-sdbase').addEventListener('change', () => { if (stitchAI) { stitchAI.base = $('pd-sdbase').value; pdSyncAI(); } });
        $('pd-sdsize').addEventListener('change', () => { if (stitchAI) stitchAI.work = $('pd-sdsize').value; });
        $('pd-sdsteps').addEventListener('change', () => { if (stitchAI) stitchAI.sdSteps = $('pd-sdsteps').value; });
        $('pd-sdcfg').addEventListener('change', () => { if (stitchAI) stitchAI.sdCfg = $('pd-sdcfg').value; });
        for (const id of ['pd-olbase', 'pd-olmodel']) $(id).addEventListener('change', () => { if (stitchAI) stitchAI.setOllama($('pd-olbase').value, $('pd-olmodel').value); });
        $('pd-ollist').addEventListener('click', async () => {
            try {
                await pdEnsureAI(); stitchAI.setOllama($('pd-olbase').value, $('pd-olmodel').value);
                const list = await stitchAI.ollamaModels(), dl = $('pd-olmodels'); dl.textContent = '';
                for (const m of list) { const o = document.createElement('option'); o.value = m; dl.appendChild(o); }
                pdSetStatus(list.length ? list.length + ' Ollama models installed: ' + list.join(', ') + '. Type or paste the name of a vision model.' : 'Ollama has no models installed.');
            } catch (e) { pdSetStatus(e.message || String(e)); }
        });
        $('pd-describe').addEventListener('click', pdDescribe);
        $('pd-forget').addEventListener('click', () => { if (stitchAI) { stitchAI.forget(); pdSyncAI(); pdSetStatus('Saved keys and settings removed.'); } });
        $('pd-key').addEventListener('change', () => { if (stitchAI && $('pd-key').value.trim()) { stitchAI.setKey($('pd-key').value); $('pd-key').value = ''; pdSyncAI(); } });
        $('rt-open-btn').addEventListener('click', openRetouch);
        $('mb-btn').addEventListener('click', () => setMaskBrush(!maskBrush.on));
        $('mb-size').addEventListener('input', () => { $('mb-size-val').textContent = $('mb-size').value + '°'; });
        $('mb-clear-all').addEventListener('click', () => { let n = 0; for (const im of images) if (im.maskCanvas) { if (im.maskTex) im.maskTex.dispose(); im.maskTex = null; im.maskCanvas = null; n++; } maskTouched(); showMessage(n ? 'All masks cleared' : 'No masks to clear'); });
        renderer.domElement.addEventListener('pointermove', moveBrushCursor);
        renderer.domElement.addEventListener('pointerleave', () => { $('mb-cursor').style.display = 'none'; });
        window.addEventListener('keydown', e => { if (maskBrush.on && e.key === 'Escape') setMaskBrush(false); });
        $('excl-clear-btn').addEventListener('click', clearExclude);
        window.addEventListener('keydown', e => {
            if (!pd || $('pd-modal').style.display === 'none') return;
            const ae = document.activeElement, tag = ae && ae.tagName, typing = tag === 'TEXTAREA' || (tag === 'INPUT' && /^(text|password|number|search|email|url)$/i.test(ae.type));
            if (e.key === 'Escape') {        // drops what is pending; closes the window only when there is nothing
                e.stopPropagation(); e.preventDefault();
                if (typing) { ae.blur(); return; }
                if (pd.mode === 'retouch' && pd.kind !== 'cut' && pd.result) { pdResultInvalid(); pdSetStatus('Result dropped. The paint stays (Esc again clears it).'); return; }
                if (pd.mode === 'retouch' && pd.kind === 'cut' ? pd.cuts.size > 0 : pdHasMask()) { $('pd-clear').click(); pdSetStatus('Paint cleared. Esc again closes the window.'); return; }
                pdClose(); return;
            }
            if (typing) return;
            if (e.key === 'Enter') {          // accepts the result that is shown
                e.stopPropagation(); e.preventDefault();
                if (pd.mode !== 'retouch' || pd.kind === 'cut' || pd.result) pdAccept();
                else if (pdAiPaint()) pdQueue();
                else pdSetStatus(pdHasMask() ? 'Nothing to accept yet: press ' + $('pd-run').textContent + ' first.' : 'Nothing to accept. Paint over what should change.');
                return;
            }
            if ((e.ctrlKey || e.metaKey) && !e.shiftKey && e.key.toLowerCase() === 'z' && pd.mode === 'retouch') { e.stopPropagation(); e.preventDefault(); pdUndo(); }
        }, true);
    }
    const toB64 = blob => new Promise((res, rej) => { const r = new FileReader(); r.onload = () => res(String(r.result).split(',')[1]); r.onerror = () => rej(new Error('Could not read the picture.')); r.readAsDataURL(blob); });
    const toBlob = cv => new Promise(res => cv.toBlob(res, 'image/png'));
    const safeStore = name => { try { return window[name]; } catch (e) { return null; } };
    let stitchAILoading = null;
    function loadStitchAI() {
        if (typeof StitchAI !== 'undefined') return Promise.resolve();
        if (stitchAILoading) return stitchAILoading;          // one script tag, however many ask at once
        return stitchAILoading = new Promise((res, rej) => {
            const s = document.createElement('script');
            s.src = 'stitch_ai.js?v=' + (window.PANO_BUILD || '');
            s.onload = res;
            s.onerror = () => { stitchAILoading = null; s.remove(); } ; s.addEventListener('error', () => rej(new Error('stitch_ai.js was not found next to this page. Put it in the same folder as index.html.')));
            document.head.appendChild(s);
        });
    }
    async function pdEnsureAI() {
        await loadStitchAI();
        if (!stitchAI) {
            stitchAI = StitchAI.create({ local: safeStore('localStorage'), session: safeStore('sessionStorage'), toB64 });
        }
        pdSyncAI();
    }
    // Local fill or an AI provider (the choice is remembered)
    function pdLocal(on) {
        if (on === undefined) { try { return localStorage.getItem('stitch-fill') !== 'ai'; } catch (e) { return true; } }
        try { localStorage.setItem('stitch-fill', on ? 'local' : 'ai'); } catch (e) { }
        return on;
    }
    // ---- sharpen / dodge / burn of a painted area (background panorama only) ----
    const FX_NAME = { sharpen: 'Focus', clarity: 'Clarity', dodge: 'Light', saturation: 'Color', contrast: 'Contrast', warmth: 'Warmth', paint: 'Paint', clone: 'Clone' };
    const PD_TOOL_NAME = { mask: 'Mask', restore: 'Restore', pick: 'Color picker' };
    const PD_NOFX = { fill: 1, mask: 1, restore: 1, pick: 1 };          // tools that are not an effect with a preview
    const hexRgb = h => [1, 3, 5].map(i => parseInt(h.slice(i, i + 2), 16));
    // amt: [least, most, start] in per cent. rad: [least, most, step, start] in panorama pixels, for the tools that need a blurred copy.
    const FX_UI = {
        mask: { note: 'Paints a selection and changes nothing. The effect brushes then work only inside it (Clear removes it). To fill it, or send it to the AI, choose Fill.' },
        restore: { note: 'Takes back every change on the pixels you paint, back to the panorama as it was before the edits in the list (the last 16 are kept). Made as you let go; Undo last reverses it.' },
        paint: { amt: [5, 100, 100], soft: 15, note: 'Paints in the color chosen below. Amount is the opacity; a softer edge blends the stroke in.' },
        pick: { note: 'Click the picture to take its color, then paint with it.' },
        clone: { amt: [5, 100, 100], soft: 40, note: kb('Alt + click the spot to copy from, then paint where it should go. The copy follows the brush at the same distance until you Alt + click again or go to another view.', 'Touch the spot to copy from, then paint where it should go. The copy follows the brush at the same distance until you press Mark the spot to copy from, or go to another view.') + ' Amount is the opacity. It copies at the full resolution of the panorama.' },
        sharpen: { amt: [-100, 300, 60], rad: [0.5, 30, 0.5, 1.5], soft: 30, note: 'Plus sharpens fine detail, minus blurs (a stretched pole, noise, a stitching defect). Radius: the size of the detail to sharpen, or how far to blur, in panorama pixels. It works in the panorama itself, so it keeps the full resolution.' },
        clarity: { amt: [5, 200, 50], rad: [10, 100, 5, 40], note: 'Adds contrast to the mid-tones over a wide radius: brings out texture (stone, rust, brick) without the hard edges of sharpening.' },
        dodge: { amt: [-100, 100, 35], note: 'Plus lightens (dodge), minus darkens (burn), with a wide soft edge. To even out a band of uneven exposure between two photos, use a large, very soft brush and a small Amount.' },
        saturation: { amt: [-100, 100, 35], note: 'Plus makes the colors stronger, minus fades them toward gray.' },
        contrast: { amt: [-100, 100, 30], note: 'Plus adds contrast, minus flattens it.' },
        warmth: { amt: [-100, 100, 30], note: 'Plus warms (more red and yellow), minus cools (more blue).' },
    };
    const fxBlurs = op => op === 'sharpen' || op === 'clarity';
    function pdFxOp() { return pd && pd.mode === 'retouch' && pd.target === 'bg' && $('pd-op') ? $('pd-op').value : 'fill'; }
    function pdFxParams() {
        const op = pdFxOp(); if (PD_NOFX[op]) return null;
        return Object.assign({ op, amount: (parseFloat($('pd-amt').value) || 0) / 100, radius: parseFloat($('pd-rad').value) || 1.5, soft: parseFloat($('pd-soft').value) || 0 }, op === 'paint' ? { color: hexRgb($('pd-color').value) } : {}, op === 'clone' ? { off: pd && pd.clone && pd.clone.off ? { x: pd.clone.off.x, y: pd.clone.off.y } : null } : {});
    }
    // How wide the edge of the painted area is feathered: set by the Softness of the edge slider
    const fxFeather = fx => fx ? 0.012 + 0.0013 * fx.soft : 0.012;
    function pdFxSync(changed) {
        const op = pdFxOp(), fx = op !== 'fill', a = $('pd-amt'), r = $('pd-rad'), u = FX_UI[op] || {};
        if (changed && fx) {
            if (u.amt) { a.min = u.amt[0]; a.max = u.amt[1]; a.value = u.amt[2]; }
            $('pd-soft').value = u.soft != null ? u.soft : 60;
            if (u.rad) { r.min = u.rad[0]; r.max = u.rad[1]; r.step = u.rad[2]; r.value = u.rad[3]; }
        }
        $('pd-fxopts').style.display = fx ? 'flex' : 'none';
        $('pd-amt-row').style.display = fx && u.amt ? '' : 'none';
        $('pd-rad-row').style.display = fx && u.rad ? '' : 'none';
        $('pd-soft-row').style.display = fx && op !== 'mask' && op !== 'pick' && op !== 'restore' ? '' : 'none';
        $('pd-color-row').style.display = op === 'paint' || op === 'pick' ? '' : 'none';
        $('pd-src-row').style.display = op === 'clone' ? '' : 'none';
        $('pd-auto-row').style.display = FX_NAME[op] ? '' : 'none';
        if (FX_NAME[op]) pdModeSync();
        $('pd-discard').style.display = FX_NAME[op] ? '' : 'none';
        $('pd-amt-val').textContent = (fx && u.amt && u.amt[0] < 0 && +a.value > 0 ? '+' : '') + a.value + '%'; $('pd-rad-val').textContent = r.value + ' px'; $('pd-soft-val').textContent = $('pd-soft').value;
        $('pd-fxnote').textContent = fx ? u.note : '';
        $('pd-toolname').textContent = pd && pd.mode === 'retouch' && pd.target === 'bg' ? 'Tool: ' + (fx ? FX_NAME[op] || PD_TOOL_NAME[op] : 'Fill') : '';
        for (const b of document.querySelectorAll('.fxt')) b.classList.toggle('fxt-on', b.dataset.op === op);
        const nq = rtQueue.filter(j => (j.state === 'waiting' || j.state === 'failed') && pd && j.target === (pd.target === 'bg' ? 'bg' : 'photos')).length;
        $('pd-run').textContent = fx ? 'Preview' : pdLocal() ? 'Fill' : 'Send to AI' + (nq ? ' (' + (nq + (pdAiPaint() ? 1 : 0)) + ')' : '');
        $('pd-run').style.display = $('pd-queue').style.display = PD_NOFX[op] && op !== 'fill' ? 'none' : '';
        if (op === 'fill' && pdLocal()) $('pd-queue').style.display = 'none';          // a local fill is made at once
        pdSyncAI();
    }
    // Gaussian-like blur (three box passes each way) of the color of an RGBA picture; returns a new array
    function blurRGBA(src, w, h, sigma) {
        const r = Math.max(1, Math.round(sigma)), n = 2 * r + 1;
        let a = new Uint8ClampedArray(src), b = new Uint8ClampedArray(src.length);
        for (let it = 0; it < 3; it++) {
            for (let y = 0; y < h; y++) for (let c = 0; c < 3; c++) {          // along rows, a -> b
                const row = y * w * 4 + c; let sum = 0;
                for (let i = -r; i <= r; i++) sum += a[row + Math.min(w - 1, Math.max(0, i)) * 4];
                for (let x = 0; x < w; x++) { b[row + x * 4] = sum / n; sum += a[row + Math.min(w - 1, x + r + 1) * 4] - a[row + Math.max(0, x - r) * 4]; }
            }
            for (let x = 0; x < w; x++) for (let c = 0; c < 3; c++) {          // along columns, b -> a
                const col = x * 4 + c; let sum = 0;
                for (let i = -r; i <= r; i++) sum += b[Math.min(h - 1, Math.max(0, i)) * w * 4 + col];
                for (let y = 0; y < h; y++) { a[y * w * 4 + col] = sum / n; sum += b[Math.min(h - 1, y + r + 1) * w * 4 + col] - b[Math.max(0, y - r) * w * 4 + col]; }
            }
        }
        return a;
    }
    // One pixel of an effect: o[k..k+2] changed by g = amount times the opacity of the painted area there. ref: a blurred copy, for the tools that need one.
    function fxPix(fx, o, k, a, ref) {
        const g = fx.amount * a, op = fx.op;
        if (op === 'sharpen') { for (let c = 0; c < 3; c++) o[k + c] += g * (o[k + c] - ref[k + c]); }        // minus g moves toward the blurred copy
        else if (op === 'clarity') {
            const l = (0.299 * o[k] + 0.587 * o[k + 1] + 0.114 * o[k + 2]) / 255, gg = g * 4 * l * (1 - l);      // mid-tones most
            for (let c = 0; c < 3; c++) o[k + c] += gg * (o[k + c] - ref[k + c]);
        }
        else if (op === 'dodge') { for (let c = 0; c < 3; c++) o[k + c] += g > 0 ? (255 - o[k + c]) * g : o[k + c] * g; }        // plus lightens, minus darkens
        else if (op === 'saturation') { const y = 0.299 * o[k] + 0.587 * o[k + 1] + 0.114 * o[k + 2]; for (let c = 0; c < 3; c++) o[k + c] = y + (o[k + c] - y) * (1 + g); }
        else if (op === 'contrast') { for (let c = 0; c < 3; c++) o[k + c] = 128 + (o[k + c] - 128) * (1 + g); }
        else if (op === 'warmth') { o[k] *= 1 + 0.25 * g; o[k + 2] *= 1 - 0.25 * g; }
        else if (op === 'paint') { const q = fx.color; for (let c = 0; c < 3; c++) o[k + c] += (q[c] - o[k + c]) * g; }
    }
    const bgPanoWidth = () => bgSrc ? bgSrc.canvas.width : (sphereMesh.material.map.image.naturalWidth || sphereMesh.material.map.image.width);
    // The effect applied to the whole view (the opacity of the painted area limits it later): used for the preview in the window
    function fxResultCanvas(base, fx, S, H, basis, fov) {
        if (fx.op === 'clone') {          // the view moved by the offset: what is at (x + off) shows at x
            if (!fx.off) throw new Error(kb('Alt + click the spot to copy from first, then paint where it should go.', 'Touch the spot to copy from first, then paint where it should go.'));
            const out = document.createElement('canvas'); out.width = S; out.height = H;
            const oc = out.getContext('2d'); oc.drawImage(base, 0, 0); oc.drawImage(base, -fx.off.x, -fx.off.y);
            return out;
        }
        const ctx = base.getContext('2d'), id = ctx.getImageData(0, 0, S, H), d = id.data;
        let ref = null;
        if (fxBlurs(fx.op)) {
            const rv = Math.max(0.5, fx.radius * focalPx({ w: S, h: H, fov }) / (bgPanoWidth() / (2 * Math.PI)));      // the radius in view pixels
            ref = blurRGBA(d, S, H, rv);
        }
        for (let i = 0; i < d.length; i += 4) fxPix(fx, d, i, 1, ref);
        const out = document.createElement('canvas'); out.width = S; out.height = H; out.getContext('2d').putImageData(id, 0, 0);
        return out;
    }
    async function pdRunFx(quiet) {
        if (!pdHasMask()) { pdSetStatus('Paint over what should be changed first.'); return; }
        const me = pd, fx = pdFxParams();
        if (!quiet) { $('pd-run').disabled = true; $('pd-ok').disabled = true; pdSetStatus('Working…'); }
        try {
            if (!quiet) await new Promise(r => setTimeout(r, 20));
            const rc = fxResultCanvas(pd.base, fx, pd.S, pd.H, pd.basis, pd.fov);
            if (pd !== me) return;
            pd.result = rc; pd.fx = fx; pd.stale = false;
            pdBuildPatch();
            $('pd-show').checked = true; $('pd-run').classList.add('tog-on');
            pdDrawBase(true);
            if (!quiet) pdSetStatus('Done. Check the result (the checkbox shows the original, X hides the paint). Move the sliders to change it, then Accept, or Discard. Add to queue keeps this spot for later.');
        } catch (e) { pdSetStatus(e.message || String(e)); }
        finally { $('pd-run').disabled = false; pdOkState(); }
    }
    function pdSyncAI() {
        const fxOn = pdFxOp() !== 'fill';
        $('pd-provider').parentElement.style.display = fxOn ? 'none' : '';
        if (fxOn) { for (const id of ['pd-airows', 'pd-promptrow', 'pd-ainote', 'pd-localnote']) $(id).style.display = 'none'; $('pd-match').parentElement.style.display = 'none'; return; }
        const local = pdLocal();
        for (const id of ['pd-airows', 'pd-promptrow', 'pd-ainote']) $(id).style.display = local ? 'none' : 'flex';
        $('pd-promptrow').style.display = local ? 'none' : '';
        $('pd-localnote').style.display = local ? '' : 'none';
        $('pd-match').parentElement.style.display = local ? 'none' : '';
        if (local) { $('pd-provider').value = 'local'; return; }
        if (!stitchAI) { pdEnsureAI().catch(e => pdSetStatus(e.message)); return; }
        $('pd-provider').value = stitchAI.provider;
        const loc = stitchAI.isLocal;
        $('pd-keyrow').style.display = $('pd-remrow').style.display = loc ? 'none' : '';
        $('pd-sdrow').style.display = loc ? 'flex' : 'none';
        $('pd-forget').style.display = loc ? 'none' : '';
        $('pd-sendnote').textContent = loc ? 'Nothing leaves this computer. Start the WebUI with --api --cors-allow-origins=* and Ollama with OLLAMA_ORIGINS=*. Describe what should replace the painted area (the surface or background), not what to remove. Spots are redrawn one at a time.' : 'Only this view and the painted area are sent to the provider you chose, together with your prompt.';
        $('pd-prompt').placeholder = loc ? 'gravel path with a few fallen leaves' : 'Remove the person and continue the floor, as if no one was there.';
        if (loc) { $('pd-sdbase').value = stitchAI.base; $('pd-sdsize').value = String(stitchAI.work); $('pd-sdsteps').value = stitchAI.sdSteps; $('pd-sdcfg').value = stitchAI.sdCfg; $('pd-olbase').value = stitchAI.cfg.ollama.base; $('pd-olmodel').value = stitchAI.cfg.ollama.model; }
        $('pd-model').value = stitchAI.model;
        $('pd-model').placeholder = loc ? 'blank = the model loaded in the WebUI' : '';
        $('pd-remember').checked = stitchAI.cfg.remember;
        $('pd-keyhint').textContent = stitchAI.isLocal ? '' : stitchAI.hasKey ? '(saved ' + stitchAI.keyHint + ')' : '(none yet)';
        $('pd-model-list').style.display = 'none';
    }
    // Ollama looks at the painted spot (marked in magenta, with its surroundings) and writes the prompt for the image model.
    async function pdDescribe() {
        if (!pd || pd.mode !== 'retouch') return;
        if (!pdHasMask()) { pdSetStatus('Paint over the spot first.'); return; }
        const btn = $('pd-describe'); btn.disabled = true;
        try {
            await pdEnsureAI(); stitchAI.setOllama($('pd-olbase').value, $('pd-olmodel').value);
            const S = pd.S, H = pd.H, mc = $('pd-mask'), cr = spotCrop({ mask: mc, S, H }) || { x: 0, y: 0, w: S, h: H };
            const mg = document.createElement('canvas'); mg.width = S; mg.height = H;
            const gc = mg.getContext('2d'); gc.drawImage(mc, 0, 0); gc.globalCompositeOperation = 'source-in'; gc.fillStyle = '#ff00ff'; gc.fillRect(0, 0, S, H);
            const k = Math.min(1, 768 / Math.max(cr.w, cr.h)), out = document.createElement('canvas'); out.width = Math.round(cr.w * k); out.height = Math.round(cr.h * k);
            const oc = out.getContext('2d'); oc.drawImage(pd.base, cr.x, cr.y, cr.w, cr.h, 0, 0, out.width, out.height); oc.drawImage(mg, cr.x, cr.y, cr.w, cr.h, 0, 0, out.width, out.height);
            pdSetStatus('Asking Ollama (' + stitchAI.cfg.ollama.model + ')... the first answer can take a while while the model loads.');
            const t = await stitchAI.ollamaDescribe(await toBlob(out), 'This photo has an area painted solid magenta. That area will be erased and redrawn by an image generator. Write, in one short line, the prompt for the image generator: what the redrawn area should show so that it continues the surrounding scene naturally. Name only the surface or background (for example: gray gravel with a few fallen leaves). Do not mention magenta, painting or editing. Reply with the prompt only.');
            $('pd-prompt').value = t;
            pdSetStatus('Prompt written by Ollama. Edit it if you like, then Run.');
        } catch (e) { pdSetStatus(e.message || String(e)); }
        finally { btn.disabled = false; }
    }
    async function pdListModels() {
        try {
            await pdEnsureAI();
            if ($('pd-key').value.trim()) { stitchAI.setKey($('pd-key').value); $('pd-key').value = ''; pdSyncAI(); }
            pdSetStatus('Asking for the model list...');
            const list = await stitchAI.listModels();
            const sel = $('pd-model-list'); sel.textContent = '';
            for (const m of list) { const o = document.createElement('option'); o.value = m; o.textContent = m; sel.appendChild(o); }
            sel.style.display = list.length ? '' : 'none';
            if (list.includes($('pd-model').value)) sel.value = $('pd-model').value;
            pdSetStatus(list.length ? list.length + ' image models available. Pick one.' : 'No image models were listed for this key.');
        } catch (e) { pdSetStatus(e.message); }
    }
    function pdResultInvalid() { if (!pd || !pd.result) return; pd.stale = false; pd.result = null; pd.patchRGBA = null; $('pd-viewrow').style.display = 'none'; $('pd-run').classList.remove('tog-on'); if (pd.mode === 'retouch') pdOkState(); pdDrawBase(); }
    // How strongly the painted area is tinted: lightly while painting, barely while a fill result is shown (so the result can be judged), or not at all.
    function pdMaskShade() {
        if (!pd) return;
        const showing = !!pd.result && $('pd-show').checked;
        $('pd-mask').style.opacity = !$('pd-paintshow').checked || ((pdPaintHidden || pdLiveStroke) && pd.kind !== 'cut') ? 0 : pd.kind === 'cut' ? 0.25 : showing ? 0.24 : 0.32;
    }
    // ---- outline of the edited areas ----
    // Every edit (a patch over the photos, or an edit of the background panorama) keeps a small copy of its opacity. The outline for the
    // view in the window is found by looking each pixel's direction up in those copies, so it shows wherever you pan.
    function editFootprint(e) {
        if (e.fa) return e;
        const w = Math.min(256, e.w), h = Math.max(1, Math.round(w * e.h / e.w)), c = document.createElement('canvas'); c.width = w; c.height = h;
        const x = c.getContext('2d'); x.drawImage(e.alphaCanvas, 0, 0, w, h);
        const d = x.getImageData(0, 0, w, h).data; e.fa = new Uint8Array(w * h); e.fw = w; e.fh = h;
        for (let i = 0; i < e.fa.length; i++) e.fa[i] = d[i * 4];
        return e;
    }
    // The number shown for an edit: the one in its name (Spot 3, Patch 2), else its place in the list
    function editLabel(e, i) { const m = /(\d+)\s*$/.exec(e.name || ''); return m ? m[1] : String(i + 1); }
    function pdEditList() {
        if (!pd || pd.mode !== 'retouch') return [];
        return pd.target === 'bg' ? bgEdits : patches;
    }
    // Draw the outline for the current view; returns how many of its (half size) pixels lie inside an edited area.
    function pdShowEdits() {
        const hc = $('pd-chg'); hc.style.display = 'none'; $('pd-chgrow').style.display = 'none';
        if (!pd || pd.mode !== 'retouch') return 0;
        const tgt = pd.target === 'bg' ? 'bg' : 'photos';
        const queued = rtQueue.filter(j => j.target === tgt && j.state !== 'done').map(j => {          // spots waiting for the AI: amber
            if (!j._fp) j._fp = editFootprint({ alphaCanvas: whiteMask(j.mask, j.S, j.H), w: j.S, h: j.H, basis: j.basis, fov: j.fov, name: j.name, queued: true });
            return j._fp;
        });
        const list = pdEditList().filter(e => e.enabled !== false).map(editFootprint).concat(queued);
        if (!list.length) return 0;
        const V = 512, k = V / pd.S, b = pd.basis, F = focalPx({ w: pd.S, h: pd.S, fov: pd.fov }) * k;
        const cams = list.map(e => ({ e, r: e.basis.r, u: e.basis.u, f: e.basis.f, Fe: focalPx({ w: e.w, h: e.h, fov: e.fov }) }));
        const inside = new Uint8Array(V * V), st = cams.map(() => ({ n: 0, x0: V, y0: V, x1: -1 })); let n = 0;
        for (let y = 0; y < V; y++) for (let x = 0; x < V; x++) {
            let hit = 0;
            const qx = (x + 0.5 - V / 2) / F, qy = (V / 2 - y - 0.5) / F;
            const dx = b.r.x * qx + b.u.x * qy + b.f.x, dy = b.r.y * qx + b.u.y * qy + b.f.y, dz = b.r.z * qx + b.u.z * qy + b.f.z;
            for (let ci = 0; ci < cams.length; ci++) {
                const c = cams[ci];
                const z = dx * c.f.x + dy * c.f.y + dz * c.f.z; if (z <= 1e-6) continue;
                const ux = 0.5 + (dx * c.r.x + dy * c.r.y + dz * c.r.z) / z * c.Fe / c.e.w, uy = 0.5 + (dx * c.u.x + dy * c.u.y + dz * c.u.z) / z * c.Fe / c.e.h;
                if (ux < 0 || ux >= 1 || uy < 0 || uy >= 1) continue;
                if (c.e.fa[Math.floor((1 - uy) * c.e.fh) * c.e.fw + Math.floor(ux * c.e.fw)] > 100) {
                    hit = c.e.queued ? 2 : Math.max(hit, 1); const t = st[ci]; t.n++; if (x < t.x0) t.x0 = x; if (x > t.x1) t.x1 = x; if (y < t.y0) t.y0 = y;
                }
            }
            if (hit) { inside[y * V + x] = hit; n++; }
        }
        if (!n) return 0;
        hc.width = V; hc.height = V;
        const c2 = hc.getContext('2d'), id = c2.createImageData(V, V), d = id.data, E = 1;
        const at = (x, y) => x < 0 || y < 0 || x >= V || y >= V ? 0 : inside[y * V + x];
        for (let y = 0; y < V; y++) for (let x = 0; x < V; x++) {
            const v = inside[y * V + x]; if (!v) continue;
            const q = (y * V + x) * 4, edge = at(x - E, y) !== v || at(x + E, y) !== v || at(x, y - E) !== v || at(x, y + E) !== v;
            if (v === 2) { d[q] = 251; d[q + 1] = edge ? 191 : 200; d[q + 2] = edge ? 36 : 80; d[q + 3] = edge ? 255 : 30; }
            else { d[q] = edge ? 124 : 80; d[q + 1] = edge ? 252 : 255; d[q + 2] = edge ? 0 : 120; d[q + 3] = edge ? 255 : 26; }
        }
        c2.putImageData(id, 0, 0);
        // the number of each edit, at the top right of its area
        c2.font = 'bold 14px sans-serif'; c2.textBaseline = 'top'; c2.lineWidth = 3; c2.lineJoin = 'round'; c2.strokeStyle = 'rgba(0,0,0,0.85)'; c2.fillStyle = '#7CFC00';
        const all = pdEditList();
        list.forEach((e, i) => {
            if (st[i].n < 20) return;
            const lab = editLabel(e, all.indexOf(e)), tw = c2.measureText(lab).width;
            const tx = Math.max(2, Math.min(V - tw - 2, st[i].x1 + 4)), ty = Math.max(2, Math.min(V - 16, st[i].y0 - 3));
            c2.fillStyle = e.queued ? '#fbbf24' : '#7CFC00';
            c2.strokeText(lab, tx, ty); c2.fillText(lab, tx, ty);
        });
        $('pd-chgrow').style.display = '';
        hc.style.display = $('pd-chgshow').checked ? '' : 'none';
        return n;
    }
    // Draw the window's view again with the edits made so far in it (the paint being marked is kept) and outline the edited areas.
    async function pdRefreshView() {
        const me = pd;
        if (!me || me.mode !== 'retouch') return 0;
        pdResultInvalid();
        const base = me.target === 'bg' ? await renderBgView(me.basis, me.fov, me.S) : await renderView(me.basis, me.fov, me.S, true);
        if (pd !== me) return 0;
        me.base = base; me.coverage = base.coverage;
        pdDrawBase(false);
        return pdShowEdits();
    }
    // Go to the view of an edit of the list, with its area outlined.
    async function pdReview(e) {
        if (!pdNavOk()) return;
        const me = pd;
        await pdGoTo({ r: e.basis.r.clone(), u: e.basis.u.clone(), f: e.basis.f.clone() }, e.fov, 'Going to ' + e.name + '…');
        if (pd !== me) return;
        pdSetStatus(e.name + ': the edited areas are outlined in green.');
    }
    // The list in the window: spots waiting or failed in the queue, then the results (patches, or edits of the background panorama)
    function pdRefreshEdits() {
        if (!pd || pd.mode !== 'retouch') { $('pd-edits-box').style.display = 'none'; return; }
        const box = $('pd-edits'); box.textContent = '';
        const me = pd, mk = (cls, txt) => { const x = document.createElement('span'); x.className = cls; x.textContent = txt; return x; };
        const tgt = pd.target === 'bg' ? 'bg' : 'photos';
        let rows = 0;
        for (const j of rtQueue) {
            if (j.target !== tgt) continue;
            const row = document.createElement('div'); row.className = 'flex items-center gap-2'; rows++;
            const nm = mk('flex-1 truncate ' + (j.state === 'failed' ? 'text-red-300' : 'text-amber-300'), `${{ waiting: '⏳', running: '⏵', failed: '✗' }[j.state] || ''} ${j.name} (${j.fx ? j.fx.op : j.local ? 'local edit' : 'AI'}, ${j.state})` + (j.state === 'failed' ? ': ' + j.err : ''));
            nm.title = j.err || '';
            const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Remove this spot from the queue'; x.className = 'text-gray-400 hover:text-red-400';
            x.addEventListener('click', () => { if (j.state === 'running') return; rtQueue.splice(rtQueue.indexOf(j), 1); refreshQueue(); });
            row.append(nm, x); box.appendChild(row);
        }
        for (const e of pdEditList()) {
            const row = document.createElement('div'); row.className = 'flex items-center gap-2'; rows++;
            const cb = document.createElement('input'); cb.type = 'checkbox'; cb.checked = e.enabled !== false; cb.title = 'Keep this result (untick to take it out)';
            cb.disabled = !!e.busy;
            cb.addEventListener('change', async () => {
                cb.disabled = true;
                try { if (me.target === 'bg') await bgSetEnabled(e, cb.checked); else { e.enabled = cb.checked; compositeDirty = true; } } catch (err) { pdSetStatus(String(err.message || err)); }
                if (pd === me) { await pdRefreshView(); pdRefreshEdits(); pdSetStatus(`${e.name} ${cb.checked ? 'kept' : 'taken out'}.`, true); }
            });
            const nm = mk('flex-1 truncate text-gray-200 cursor-pointer underline', ''); nm.title = 'Go to this result';
            const mt = /^(.*?)(\d+)\s*$/.exec(e.name || '');
            if (mt) { nm.append(mt[1]); const dg = mk('font-bold', mt[2]); dg.style.color = '#7CFC00'; nm.append(dg); } else nm.textContent = e.name;
            nm.addEventListener('click', () => pdReview(e));
            const x = document.createElement('button'); x.textContent = '✕'; x.title = 'Delete this result for good'; x.className = 'text-gray-400 hover:text-red-400';
            x.addEventListener('click', async () => {
                x.disabled = true;
                try {
                    if (me.target === 'bg') await bgDeleteEdit(e);
                    else { e.tex.dispose(); e.alphaTex.dispose(); patches.splice(patches.indexOf(e), 1); compositeDirty = true; }
                } catch (err) { pdSetStatus(String(err.message || err)); }
                refreshPatchList();
                if (pd === me) { await pdRefreshView(); pdSetStatus(`${e.name} deleted.`, true); }
            });
            row.append(cb, nm, x); box.appendChild(row);
        }
        $('pd-edits-box').style.display = rows ? '' : 'none';
    }
    function pdDrawBase(showPatch) {
        pdMaskShade();
        const bc = $('pd-base'), c = bc.getContext('2d');
        c.drawImage(pd.base, 0, 0);
        if (showPatch && pd.patchRGBA) c.drawImage(pd.patchRGBA, 0, 0);
    }
    function pdShow() { if (pd && pd.patchRGBA) pdDrawBase($('pd-show').checked); }

    // Local fill of a view: returns the filled picture as a canvas (S x H).
    async function localFillCanvas(base, mc, S, H, onProgress) {
        const PS = await loadSeams();
        const rgba = new Uint8Array(base.getContext('2d').getImageData(0, 0, S, H).data.buffer.slice(0));
        const md = mc.getContext('2d').getImageData(0, 0, S, H).data, hole = new Uint8Array(S * H);
        for (let i = 0; i < hole.length; i++) hole[i] = md[i * 4 + 3] > 20 ? 1 : 0;
        const r = await PS.run({ type: 'inpaint', rgba, w: S, h: H, hole, opts: {} }, [rgba.buffer, hole.buffer], onProgress);
        const rc = document.createElement('canvas'); rc.width = S; rc.height = H;
        rc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba.buffer), S, H), 0, 0);
        return rc;
    }
    // ---- queue of retouch spots: collected one by one, then sent together ----
    const rtQueue = []; let rtQSeq = 0, rtQRunning = false;
    const copyCanvas = c => { const o = document.createElement('canvas'); o.width = c.width; o.height = c.height; o.getContext('2d').drawImage(c, 0, 0); return o; };
    function refreshQueue() {
        const box = $('queue-box'), list = $('queue-list');
        box.style.display = rtQueue.length ? '' : 'none';
        const nWait = rtQueue.filter(j => j.state === 'waiting' || j.state === 'failed').length;
        $('pd-runq').style.display = 'none';          // folded into Send to AI
        if (pd && pd.mode === 'retouch') pdFxSync();
        $('pd-runq').textContent = 'Run queued (' + nWait + ')';
        $('queue-run').disabled = !nWait;
        pdRefreshEdits();
        list.textContent = '';
        const icon = { waiting: '⏳', running: '⏵', done: '✓', failed: '✗' };
        for (const j of rtQueue) {
            const row = document.createElement('div'); row.className = 'flex items-center gap-2';
            const nm = document.createElement('span'); nm.className = 'flex-1 truncate ' + (j.state === 'failed' ? 'text-red-300' : 'text-gray-200');
            nm.textContent = `${icon[j.state]} ${j.name} (${j.target === 'bg' ? 'background, ' : ''}${j.fx ? j.fx.op : j.local ? 'local edit' : 'AI'})` + (j.state === 'failed' ? ': ' + j.err : '');
            nm.title = j.err || '';
            const x = document.createElement('button'); x.textContent = '✕'; x.className = 'text-gray-400 hover:text-red-400';
            x.title = 'Remove this spot from the queue';
            x.addEventListener('click', () => { if (j.state === 'running') return; rtQueue.splice(rtQueue.indexOf(j), 1); refreshQueue(); });
            row.append(nm, x); list.appendChild(row);
        }
    }
    function pdQueue() {
        if (!pd || pd.mode !== 'retouch' || pd.kind !== 'fill') return;
        if (!pdHasMask()) { pdSetStatus('Paint over what should be changed first.'); return false; }
        const fx = pdFxParams(), local = fx ? true : pdLocal();
        if (!local && stitchAI) { if ($('pd-key').value.trim()) { stitchAI.setKey($('pd-key').value); $('pd-key').value = ''; pdSyncAI(); } stitchAI.model = $('pd-model').value; }
        const mc = $('pd-mask');
        const job = {
            id: ++rtQSeq, name: (fx ? FX_NAME[fx.op] : 'Spot') + ' ' + rtQSeq, local, fx, S: pd.S, H: pd.H, basis: { r: pd.basis.r.clone(), u: pd.basis.u.clone(), f: pd.basis.f.clone() }, fov: pd.fov,
            base: copyCanvas(pd.base), mask: copyCanvas(mc), prompt: $('pd-prompt').value, match: $('pd-match').checked && !local, state: 'waiting', err: '', target: pd.target === 'bg' ? 'bg' : 'photos', bgGen
        };
        rtQueue.push(job);
        mc.getContext('2d').clearRect(0, 0, pd.S, pd.H); pdResultInvalid();
        refreshQueue();
        setTimeout(pdShowEdits, 0);
        pdShowEdits();
        pdSetStatus(`${job.name} queued: its number is shown in amber (${rtQueue.filter(j => j.state === 'waiting').length} waiting). Mark the next spot, or press Send to AI to send them all in one request.`);
    }
    // ---- all queued AI spots in ONE request ----
    // Each spot (the painted area with some of its surroundings) is cut out of its view and the pieces are packed into one sheet, each in a
    // numbered box. The provider is asked once for the whole sheet (one charge instead of one per spot) and the sheet is cut up again.
    const SHEET_W = 1536, SHEET_H = 1024, SHEET_HEAD = 26, SHEET_GAP = 10;     // 1536 x 1024 is a size every provider here accepts
    function spotCrop(j) {
        const md = j.mask.getContext('2d').getImageData(0, 0, j.S, j.H).data;
        let x0 = j.S, y0 = j.H, x1 = -1, y1 = -1;
        for (let y = 0; y < j.H; y++) for (let x = 0; x < j.S; x++) if (md[(y * j.S + x) * 4 + 3] > 20) { if (x < x0) x0 = x; if (x > x1) x1 = x; if (y < y0) y0 = y; if (y > y1) y1 = y; }
        if (x1 < 0) return null;
        const pad = Math.max(80, 0.6 * Math.max(x1 - x0 + 1, y1 - y0 + 1));
        const span = (a0, a1, lim) => {
            a0 = Math.max(0, Math.floor(a0 - pad)); a1 = Math.min(lim, Math.ceil(a1 + 1 + pad));
            if (a1 - a0 < 256) { const e = Math.ceil((256 - (a1 - a0)) / 2); a0 = Math.max(0, a0 - e); a1 = Math.min(lim, a1 + e); }
            return [a0, a1];
        };
        const [cx0, cx1] = span(x0, x1, j.S), [cy0, cy1] = span(y0, y1, j.H);
        return { x: cx0, y: cy0, w: cx1 - cx0, h: cy1 - cy0 };
    }
    // Shelf packing of boxes (crop size times a common scale, plus a number strip) into the sheet; null if they do not fit at 0.55 or more.
    function packSheet(crops) {
        for (let sc = 1; sc >= 0.55; sc -= 0.05) {
            let x = SHEET_GAP, y = SHEET_GAP, rowH = 0, ok = true; const pos = [];
            for (const c of crops) {
                const w = Math.round(c.w * sc), h = Math.round(c.h * sc) + SHEET_HEAD;
                if (x + w + SHEET_GAP > SHEET_W) { x = SHEET_GAP; y += rowH + SHEET_GAP; rowH = 0; }
                if (x + w + SHEET_GAP > SHEET_W || y + h + SHEET_GAP > SHEET_H) { ok = false; break; }
                pos.push({ x, y: y + SHEET_HEAD, w, h: h - SHEET_HEAD }); x += w + SHEET_GAP; rowH = Math.max(rowH, h);
            }
            if (ok) return { sc, pos };
        }
        return null;
    }
    // Spots into sheets: normally one; a new sheet only when more would make the pieces smaller than about half size.
    function planSheets(jobs) {
        const sheets = []; let cur = [];
        for (const j of jobs) {
            const crop = spotCrop(j);
            if (!crop) { j.state = 'failed'; j.err = 'nothing was painted'; continue; }
            if (cur.length && !packSheet(cur.map(g => g.crop).concat([crop]))) { sheets.push(cur); cur = []; }
            cur.push({ j, crop });
        }
        if (cur.length) sheets.push(cur);
        return sheets;
    }
    // Send one sheet; returns, for each spot, a full-size picture of its view with the AI's result in the cropped part.
    async function aiSheetResults(group) {
        const pk = packSheet(group.map(g => g.crop));
        const base = document.createElement('canvas'); base.width = SHEET_W; base.height = SHEET_H;
        const bx = base.getContext('2d'); bx.fillStyle = '#303030'; bx.fillRect(0, 0, SHEET_W, SHEET_H);
        const mask = document.createElement('canvas'); mask.width = SHEET_W; mask.height = SHEET_H;
        const mx = mask.getContext('2d');
        bx.fillStyle = '#fff'; bx.font = 'bold 20px sans-serif'; bx.textBaseline = 'top';
        group.forEach((g, i) => {
            const p = pk.pos[i], c = g.crop;
            bx.drawImage(g.j.base, c.x, c.y, c.w, c.h, p.x, p.y, p.w, p.h);
            mx.drawImage(g.j.mask, c.x, c.y, c.w, c.h, p.x, p.y, p.w, p.h);
            bx.fillText(String(i + 1), p.x + 2, p.y - SHEET_HEAD + 3);
        });
        const dflt = 'Remove whatever is in the masked area and continue the surrounding scene naturally.';
        const ps = group.map(g => (g.j.prompt || '').trim()), uniq = [...new Set(ps)];
        const prompt = `This picture is a sheet of ${group.length} separate pictures, each in its own box with its number above it. Treat every box on its own and keep every box exactly where it is, at the same size. ` +
            (uniq.length <= 1 ? (uniq[0] || dflt) + ' Do this in every box.' : ps.map((t, i) => `Box ${i + 1}: ${t || dflt}`).join(' '));
        const res = await aiEditCanvas(base, mask, prompt, SHEET_W, SHEET_H);
        return group.map((g, i) => {
            const p = pk.pos[i], c = g.crop, out = copyCanvas(g.j.base);
            out.getContext('2d').drawImage(res, p.x, p.y, p.w, p.h, c.x, c.y, c.w, c.h);
            return out;
        });
    }
    async function runQueue() {
        if (rtQRunning) return;
        if (pdAiPaint()) pdQueue();
        const jobs = rtQueue.filter(j => j.state === 'waiting' || j.state === 'failed');
        if (!jobs.length) { showMessage('Nothing is waiting in the queue.'); return; }
        const ai = jobs.filter(j => !j.local), loc = jobs.filter(j => j.local);
        if (ai.length) {
            await pdEnsureAI();
            if ($('pd-key').value.trim()) { stitchAI.setKey($('pd-key').value); $('pd-key').value = ''; pdSyncAI(); }
            if (!stitchAI.hasKey) { showMessage('Open the retouch window and paste the API key first.'); pdSetStatus('Paste the API key first.'); return; }
            if (pd && $('pd-model').value) stitchAI.model = $('pd-model').value;
        }
        rtQRunning = true;
        const prog = Progress.start(`Retouching ${jobs.length} spot${jobs.length > 1 ? 's' : ''}`); let done = 0, ok = 0;
        const fin = j => { done++; if (j.state === 'done') ok++; Progress.update(prog, `Retouching: ${done} of ${jobs.length} finished`, done / jobs.length); refreshQueue(); pdSetStatus(`${done} of ${jobs.length} finished.`); };
        const finishPatch = async (j, rc) => {
            const o = makePatchPieces(j.S, j.H, j.base, j.mask, rc, j.match, fxFeather(j.fx));
            if (j.target === 'bg') {
                if (j.bgGen !== bgGen) throw new Error('the background panorama was replaced since this spot was marked');
                await applyPatchToBg(j.basis, j.fov, j.S, j.H, o.color, o.alpha, j.name, j.fx);
            } else addPatch(j.basis, j.fov, j.S, j.H, o.color, o.alpha, j.name);
            j.state = 'done'; j.err = '';
        };
        const runAI = async j => {
            j.state = 'running'; refreshQueue();
            try { await finishPatch(j, await aiEditCanvas(j.base, j.mask, j.prompt, j.S, j.H)); } catch (e) { j.state = 'failed'; j.err = e.message || String(e); }
            fin(j);
        };
        const runAIGroup = async group => {
            for (const g of group) g.j.state = 'running';
            refreshQueue();
            let outs = null, err = '';
            try { outs = await aiSheetResults(group); } catch (e) { err = e.message || String(e); }
            for (let i = 0; i < group.length; i++) {
                const j = group[i].j;
                try { if (!outs) throw new Error(err); await finishPatch(j, outs[i]); } catch (e) { j.state = 'failed'; j.err = e.message || String(e); }
                fin(j);
            }
        };
        const runLocal = async j => {
            j.state = 'running'; refreshQueue();
            try { await finishPatch(j, j.fx ? j.base : await localFillCanvas(j.base, j.mask, j.S, j.H)); } catch (e) { j.state = 'failed'; j.err = e.message || String(e); }
            fin(j);
        };
        try {
            const aiWork = (async () => {
                if (ai.length === 1 || stitchAI.isLocal) { for (const j of ai) await runAI(j); return; }   // one spot, or an AI on this computer (free, and better at full size): the whole view each
                for (const group of planSheets(ai)) await runAIGroup(group);                // several: one request (one sheet) for all
                for (const j of ai) if (j.state === 'failed' && j.err === 'nothing was painted') fin(j);
            })();
            await Promise.all([aiWork, (async () => { for (const j of loc) await runLocal(j); })()]);
        } finally {
            Progress.end(prog); rtQRunning = false;
            for (let k = rtQueue.length - 1; k >= 0; k--) if (rtQueue[k].state === 'done') { const j = rtQueue[k]; j.base.width = j.mask.width = 0; rtQueue.splice(k, 1); }   // the results are in the list of results now
            refreshQueue();
        }
        const bad = rtQueue.filter(j => j.state === 'failed').length;
        const what = jobs.some(j => j.target === 'bg') ? `edit${ok === 1 ? '' : 's'} painted into the background panorama` : `patch${ok === 1 ? '' : 'es'} added`;
        let note = '';
        if (ok && pd && pd.mode === 'retouch') {
            const n = await pdRefreshView().catch(() => 0);
            note = (n ? ' The edited areas are outlined in green.' : ' None of them is in this view.') + ' Untick a result in the list to take it out; click its name to go there.';
        }
        const msg = `${ok} of ${jobs.length} ${what}` + (bad ? `; ${bad} failed (listed in the queue, press Run queued to try again).` : '.');
        showMessage(msg);
        pdSetStatus(msg + note, true);
    }
    async function pdRunLocal() {
        if (!pdHasMask()) { pdSetStatus('Paint over what should be changed first.'); return; }
        const S = pd.S, H = pd.H;
        $('pd-run').disabled = true; $('pd-ok').disabled = true;
        try {
            const PS = await loadSeams();
            const rgba = new Uint8Array(pd.base.getContext('2d').getImageData(0, 0, S, H).data.buffer.slice(0));
            const md = $('pd-mask').getContext('2d').getImageData(0, 0, S, H).data, hole = new Uint8Array(S * H);
            for (let i = 0; i < hole.length; i++) hole[i] = md[i * 4 + 3] > 20 ? 1 : 0;
            pdSetStatus('Filling from the surroundings...');
            const fprog = Progress.start('Filling from the surroundings');
            const r = await PS.run({ type: 'inpaint', rgba, w: S, h: H, hole, opts: {} }, [rgba.buffer, hole.buffer], (t, f) => { pdSetStatus(t); Progress.update(fprog, t, f == null ? null : f); }).finally(() => Progress.end(fprog));
            if (!pd) return;
            const rc = document.createElement('canvas'); rc.width = S; rc.height = H;
            rc.getContext('2d').putImageData(new ImageData(new Uint8ClampedArray(r.rgba.buffer), S, H), 0, 0);
            pd.result = rc;
            pdBuildPatch();
            $('pd-viewrow').style.display = ''; $('pd-show').checked = true;
            pdDrawBase(true);
            pdOkState();
            pdSetStatus('Done. Check the result (the checkbox shows the original), paint more and run again, try an AI provider, or Accept.');
        } catch (e) { pdSetStatus(e.message || String(e)); }
        finally { $('pd-run').disabled = false; pdOkState(); }
    }
    // Send one view with its painted spot to the AI provider; returns the returned picture as a canvas (S x H).
    async function aiEditCanvas(base, mc, prompt, S, H) {
        const image = await toBlob(base);
        const hole = document.createElement('canvas'); hole.width = S; hole.height = H;
        const hc = hole.getContext('2d'); hc.fillStyle = '#fff'; hc.fillRect(0, 0, S, H);
        hc.globalCompositeOperation = 'destination-out'; hc.drawImage(mc, 0, 0);       // transparent where the AI may paint
        const marked = document.createElement('canvas'); marked.width = S; marked.height = H;
        const kc = marked.getContext('2d'); kc.drawImage(base, 0, 0);
        const mg = document.createElement('canvas'); mg.width = S; mg.height = H;
        const gc = mg.getContext('2d'); gc.drawImage(mc, 0, 0); gc.globalCompositeOperation = 'source-in'; gc.fillStyle = '#ff00ff'; gc.fillRect(0, 0, S, H);
        kc.drawImage(mg, 0, 0);
        const sdm = whiteMask(mc, S, H);                  // white where Stable Diffusion should draw
        const out = await stitchAI.edit({ image, mask: await toBlob(hole), sdmask: await toBlob(sdm), marked: await toBlob(marked), prompt }, S + 'x' + H);
        const res = out.blob ? URL.createObjectURL(out.blob) : out.dataUrl;
        const im = await new Promise((ok, no) => { const i = new Image(); i.onload = () => ok(i); i.onerror = () => no(new Error('The returned picture could not be read.')); i.src = res; });
        if (out.blob) URL.revokeObjectURL(res);
        const rc = document.createElement('canvas'); rc.width = S; rc.height = H;
        rc.getContext('2d').drawImage(im, 0, 0, S, H);
        return rc;
    }
    async function pdRun() {
        if (!pd || pd.mode !== 'retouch') return;
        if (pdFxOp() !== 'fill') {
            // Preview toggles between the result and the original once a result for these settings exists: nothing is recalculated
            if (pd.result && pd.patchRGBA && JSON.stringify(pd.fx) === JSON.stringify(pdFxParams())) {
                const c = $('pd-show'); c.checked = !c.checked; pdShow(); $('pd-run').classList.toggle('tog-on', c.checked);
                pdSetStatus(c.checked ? 'Showing the result. Press Preview again for the original.' : 'Showing the original. Press Preview for the result.');
                return;
            }
            return pdRunFx();
        }
        pd.fx = null;
        if (pdLocal()) { const me = pd; await pdRunLocal(); if (pd === me && pd.result) await pdAccept(); return; }
        if (pdAiPaint()) pdQueue();
        if (rtQueue.some(j => (j.state === 'waiting' || j.state === 'failed') && j.target === (pd.target === 'bg' ? 'bg' : 'photos'))) { await runQueue(); return; }
        try {
            await pdEnsureAI();
            if ($('pd-key').value.trim()) { stitchAI.setKey($('pd-key').value); $('pd-key').value = ''; pdSyncAI(); }
            stitchAI.model = $('pd-model').value;
            if (!pdHasMask()) { pdSetStatus('Paint over what should be changed first.'); return; }
            const S = pd.S, H = pd.H, mc = $('pd-mask');
            $('pd-run').disabled = true; $('pd-stop').style.display = ''; $('pd-ok').disabled = true;
            pdSetStatus('Sent to ' + StitchAI.PROVIDERS[stitchAI.provider].label + '. This can take a minute or two...');
            const aprog = Progress.start('Waiting for ' + StitchAI.PROVIDERS[stitchAI.provider].label);
            let rc;
            try { rc = await aiEditCanvas(pd.base, mc, $('pd-prompt').value, S, H); }
            finally { Progress.end(aprog); }
            if (!pd) return;
            pd.result = rc;
            pdBuildPatch();
            $('pd-viewrow').style.display = ''; $('pd-show').checked = true;
            pdDrawBase(true);
            pdOkState();
            pdSetStatus('Done. Check the result (the checkbox shows the original), paint more and run again, or Accept.');
        } catch (e) {
            pdSetStatus(e.message || String(e));
        } finally {
            $('pd-run').disabled = false; $('pd-stop').style.display = 'none'; pdOkState();
        }
    }
    // From the AI result make: color canvas (opaque, color matched) and opacity canvas (feathered mask), plus a preview of both on the base.
    // From a picture result make the color canvas (color matched), the feathered opacity canvas and a preview of both on the base.
    function makePatchPieces(S, H, base, mc, result, match, featherK) {
        const col = document.createElement('canvas'); col.width = S; col.height = H;
        const cc = col.getContext('2d'); cc.drawImage(result, 0, 0);
        const wm = whiteMask(mc, S, H);
        const feather = Math.max(2, Math.round(S * (featherK || 0.012)));
        let soft = wm;
        if ('filter' in cc) {
            soft = document.createElement('canvas'); soft.width = S; soft.height = H;
            const sc = soft.getContext('2d'); sc.fillStyle = '#000'; sc.fillRect(0, 0, S, H);
            sc.filter = `blur(${feather}px)`; sc.drawImage(wm, 0, 0); sc.filter = 'none';
        }
        const sd = soft.getContext('2d').getImageData(0, 0, S, H), md = wm.getContext('2d').getImageData(0, 0, S, H).data;
        for (let i = 0; i < sd.data.length; i += 4) { const v = Math.max(md[i], Math.min(255, sd.data[i] * 2)); sd.data[i] = sd.data[i + 1] = sd.data[i + 2] = v; sd.data[i + 3] = 255; }
        // color match: mean difference original - result in a ring around the painted area
        if (match && 'filter' in cc) {
            const wide = document.createElement('canvas'); wide.width = S; wide.height = H;
            const wc = wide.getContext('2d'); wc.fillStyle = '#000'; wc.fillRect(0, 0, S, H);
            wc.filter = `blur(${feather * 4}px)`; wc.drawImage(wm, 0, 0); wc.filter = 'none';
            const wd = wc.getImageData(0, 0, S, H).data;
            const od = base.getContext('2d').getImageData(0, 0, S, H).data, rd = cc.getImageData(0, 0, S, H);
            const sum = [0, 0, 0]; let n = 0;
            for (let i = 0; i < wd.length; i += 4) if (wd[i] > 12 && md[i] < 128) { n++; for (let k = 0; k < 3; k++) sum[k] += od[i + k] - rd.data[i + k]; }
            if (n > 200) {
                const sh = sum.map(s => Math.max(-40, Math.min(40, s / n)));
                for (let i = 0; i < rd.data.length; i += 4) for (let k = 0; k < 3; k++) rd.data[i + k] = Math.max(0, Math.min(255, rd.data[i + k] + sh[k]));
                cc.putImageData(rd, 0, 0);
            }
        }
        const alpha = document.createElement('canvas'); alpha.width = S; alpha.height = H;
        alpha.getContext('2d').putImageData(sd, 0, 0);
        // preview: color with opacity as alpha
        const pv = document.createElement('canvas'); pv.width = S; pv.height = H;
        const pc = pv.getContext('2d'), pdd = cc.getImageData(0, 0, S, H);
        for (let i = 0; i < pdd.data.length; i += 4) pdd.data[i + 3] = sd.data[i];
        pc.putImageData(pdd, 0, 0);
        return { color: col, alpha, preview: pv };
    }
    function pdBuildPatch() {
        const o = makePatchPieces(pd.S, pd.H, pd.base, $('pd-mask'), pd.result, $('pd-match').checked && !pdLocal() && !pd.fx, fxFeather(pd.fx));
        pd.patchColor = o.color; pd.patchAlpha = o.alpha; pd.patchRGBA = o.preview;
    }
    async function pdAccept() {
        if (!pd) return;
        if (pd.mode === 'retouch' && pd.kind === 'cut') {
            const n = applyCuts();
            pdClose(); if (n) touch();
            showMessage(n ? `Brushed out of ${n} photo${n > 1 ? 's' : ''}. Other photos now show through.` : 'Nothing was painted.');
            return;
        }
        if (pd.mode === 'exclude') {
            const img = pd.img;
            if (img.maskTex) img.maskTex.dispose();
            img.maskTex = null; img.maskCanvas = null;
            if (pdHasMask()) {
                const k = Math.min(1, 512 / Math.max(pd.S, pd.H)), w = Math.max(2, Math.round(pd.S * k)), h = Math.max(2, Math.round(pd.H * k));
                img.maskCanvas = whiteMask($('pd-mask'), w, h);
                const t = new THREE.CanvasTexture(img.maskCanvas);
                t.generateMipmaps = false; t.minFilter = THREE.LinearFilter; t.magFilter = THREE.LinearFilter;
                img.maskTex = t;
            }
            pdClose(); touch();
            showMessage(img.maskTex ? 'Part of ' + img.name + ' will not be used' : 'Mask cleared');
            return;
        }
        if (pd.mode === 'retouch' && pd.result && pd.stale) await pdRunFx(true);
        if (!pd.result || !pd.patchColor) { pdDone(); return; }
        if (pd.target === 'bg') {
            const me = pd; $('pd-ok').disabled = true; pdSetStatus('Painting the result into the panorama…');
            try { await applyPatchToBg(pd.basis, pd.fov, pd.S, pd.H, pd.patchColor, pd.patchAlpha, null, pd.fx); }
            catch (e) { if (pd === me) { pdSetStatus(e.message || String(e)); pdOkState(); } return; }
            if (pd !== me) return;
            // The window stays open: it shows the panorama with the edit in it, the changed area outlined, ready for the next spot.
            const mc = $('pd-mask'); mc.getContext('2d').clearRect(0, 0, mc.width, mc.height);
            const n = await pdRefreshView();
            if (pd === me) pdSetStatus('Accepted: painted into the background panorama as ' + (bgEdits.length ? bgEdits[bgEdits.length - 1].name : 'an edit') + (n ? ', outlined in green and listed below (untick it there to take it out).' : '.') + ' Mark the next spot, or press Done.', true);
            return;
        }
        const me = pd, pa = addPatch(pd.basis, pd.fov, pd.S, pd.H, pd.patchColor, pd.patchAlpha);
        const mc = $('pd-mask'); mc.getContext('2d').clearRect(0, 0, mc.width, mc.height);
        const n = await pdRefreshView();
        if (pd === me) pdSetStatus('Accepted: ' + pa.name + ' is laid over the stitch' + (n ? ', outlined in green and listed below' : '') + '. It is included when you bake.', true);
    }
    function addPatch(basis, fov, S, H, color, alpha, name) {
        const p = {
            id: ++patchSeq, name: name || 'Patch ' + patchSeq, basis: { r: basis.r.clone(), u: basis.u.clone(), f: basis.f.clone() }, fov,
            w: S, h: H, canvas: color, alphaCanvas: alpha, enabled: true
        };
        p.tex = makeTexture(p.canvas); p.alphaTex = makeTexture(p.alphaCanvas);
        patches.push(p);
        refreshPatchList(); compositeDirty = true;
        return p;
    }
    function refreshPatchList() { pdRefreshEdits(); }          // the list of results is in the retouch window
    async function openRetouch() {
        if (!images.some(i => i.enabled)) { showMessage('Load and align photos first.'); return; }
        const fov = Math.max(20, Math.min(120, parseFloat($('rt-fov').value) || 70));
        const basis = viewBasis($('rt-view').value);
        try {
            const base = await renderView(basis, fov, 1024, true);
            showMessage('');
            $('message-box').classList.add('hidden');
            pdOpen({ mode: 'retouch', title: 'Retouch', base, basis, fov, coverage: base.coverage });
        } catch (e) { showMessage('Could not render the view: ' + (e.message || e)); }
    }
    async function openExclude() {
        const img = selectedImg;
        if (!img) { showMessage('Select a photo first (click it, or pick it in the list).'); return; }
        const { canvas } = await sourceCanvas(img, 1024);
        const base = document.createElement('canvas'); base.width = canvas.width; base.height = canvas.height;
        base.getContext('2d').drawImage(canvas, 0, 0);
        let maskInit = null;
        if (img.maskCanvas) {
            maskInit = document.createElement('canvas'); maskInit.width = base.width; maskInit.height = base.height;
            const c = maskInit.getContext('2d'); c.drawImage(img.maskCanvas, 0, 0, base.width, base.height);
            const d = c.getImageData(0, 0, base.width, base.height);
            for (let i = 0; i < d.data.length; i += 4) { const a = d.data[i] > 127 ? 255 : 0; d.data[i] = 255; d.data[i + 1] = 0; d.data[i + 2] = 80; d.data[i + 3] = a; }
            c.putImageData(d, 0, 0);
        }
        pdOpen({ mode: 'exclude', title: 'Mask out parts of ' + img.name, base, maskInit, img });
    }
    function clearExclude() {
        const img = selectedImg;
        if (!img) { showMessage('Select a photo first.'); return; }
        if (img.maskTex) img.maskTex.dispose();
        img.maskTex = null; img.maskCanvas = null; maskTouched(); showMessage('Mask cleared');
    }

    // Approximate equirect footprint of an image: lon interval (may extend past ±π) and lat interval.
    function footprint(img) {
        const B = camBasis(img);
        const c = lonLat(B.f);
        let lonMin = 0, lonMax = 0, latMin = c.lat, latMax = c.lat;
        const N = 16;
        const take = (xn, yn) => {
            const ll = lonLat(rayFromNorm(img, B, xn, yn));
            let dl = ll.lon - c.lon;
            while (dl > Math.PI) dl -= 2 * Math.PI;
            while (dl < -Math.PI) dl += 2 * Math.PI;
            lonMin = Math.min(lonMin, dl); lonMax = Math.max(lonMax, dl);
            latMin = Math.min(latMin, ll.lat); latMax = Math.max(latMax, ll.lat);
        };
        for (let i = 0; i <= N; i++) { const t = -1 + 2 * i / N; take(t, 1); take(t, -1); take(1, t); take(-1, t); }
        const m = 3 * DEG;
        const inside = d => { const n = dirToNorm(img, B, d); return n && Math.abs(n.xn) <= 1 && Math.abs(n.yn) <= 1; };
        let fullLon = lonMax - lonMin > 1.5 * Math.PI;
        if (inside(new THREE.Vector3(0, 1, 0))) { latMax = Math.PI / 2; fullLon = true; }
        if (inside(new THREE.Vector3(0, -1, 0))) { latMin = -Math.PI / 2; fullLon = true; }
        return {
            lon0: fullLon ? -Infinity : c.lon + lonMin - m, lon1: fullLon ? Infinity : c.lon + lonMax + m,
            lat0: latMin - m, lat1: latMax + m
        };
    }
    function overlapsTile(fp, lonA, lonB, latA, latB) {
        if (fp.lat1 < latA || fp.lat0 > latB) return false;
        if (!isFinite(fp.lon0)) return true;
        for (const k of [-2 * Math.PI, 0, 2 * Math.PI]) {
            if (fp.lon1 + k >= lonA && fp.lon0 + k <= lonB) return true;
        }
        return false;
    }

    async function bakeEquirectangular() {
        if (renderBusy) { showMessage('Another long job is running; wait for it to finish.'); return; }
        const prog = Progress.start('Baking the panorama'), busy0 = renderBusy;
        try { if (document.getElementById('bake-proj').value !== 'sphere') await bakeWindow(prog); else await bakeRun(prog); }
        catch (e) { console.error(e); showMessage('Bake failed: ' + (e && e.message ? e.message : e)); }
        finally { renderBusy = busy0; Progress.end(prog); compositeDirty = true; }       // the live preview waits until the file is saved
    }
    async function bakeRun(prog) {
        const list = images.filter(i => i.enabled);
        if (!list.length) { showMessage('No images to bake.'); return; }
        Progress.update(prog, 'Baking the panorama', 0);
        const gl = renderer.getContext();
        const maxSz = Math.min(renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
        let outW = parseInt(document.getElementById('bake-size').value) || 8192;
        outW = Math.floor(outW / 2) * 2;
        const outH = outW / 2;
        const T = Math.min(4096, maxSz);                   // tile size
        const nx = Math.ceil(outW / T), ny = Math.ceil(outH / T);

        const canvas = document.createElement('canvas');
        canvas.width = outW; canvas.height = outH;
        const ctx = canvas.getContext('2d');
        if (!ctx) { showMessage('Output too large for this browser; choose a smaller size.'); return; }

        const fps = new Map(list.map(img => [img, footprint(img)]));
        const acc = makeAccRT(T, T), out = makeOutRT(T, T);
        const acc2 = blendSharp() > 1 ? makeAccRT(T, T) : null;
        const buf = new Uint8Array(T * T * 4);
        renderBusy++;
        try {
            for (let ty = 0; ty < ny; ty++) {
                for (let tx = 0; tx < nx; tx++) {
                    const x0 = tx * T, y0 = ty * T;               // y0 counted from the bottom (south pole)
                    const w = Math.min(T, outW - x0), h = Math.min(T, outH - y0);
                    const region = [x0 / outW, y0 / outH, T / outW, T / outH];
                    const lonA = 2 * Math.PI * region[0], lonB = 2 * Math.PI * (x0 + w) / outW;
                    const latA = Math.PI * region[1] - Math.PI / 2, latB = Math.PI * (y0 + h) / outH - Math.PI / 2;
                    const inTile = list.filter(img => {
                        const fp = fps.get(img);
                        // footprint lon is in (-π, π]; tile lon in [0, 2π]: shifts handled in overlapsTile
                        return overlapsTile(fp, lonA, lonB, latA, latB);
                    });
                    clearRT(acc);
                    if (acc2) clearRT(acc2);
                    let k = 0;
                    for (const img of inTile) {
                        Progress.update(prog, `Baking: tile ${ty * nx + tx + 1} of ${nx * ny}, photo ${++k} of ${inTile.length}`, (ty * nx + tx + (k - 1) / Math.max(1, inTile.length)) / (nx * ny));
                        await new Promise(r => requestAnimationFrame(r));
                        const { canvas: src } = await sourceCanvas(img, maxSz);
                        const tex = makeTexture(src);
                        renderer.autoClear = false;
                        projectInto(img, tex, region, acc, acc2, false);
                        renderer.autoClear = true;
                        renderer.setRenderTarget(null);
                        tex.dispose();
                        if (src !== img.srcCanvas) src.width = src.height = 0;
                    }
                    normalize(acc, out, true, acc2);
                    const pin = patches.filter(p => p.enabled && p.tex && overlapsTile(footprint(p), lonA, lonB, latA, latB));
                    if (pin.length) pasteInto(out, pin, region);
                    renderer.readRenderTargetPixels(out, 0, 0, w, h, buf);
                    const id = ctx.createImageData(w, h);
                    for (let r = 0; r < h; r++) id.data.set(buf.subarray(r * w * 4, (r + 1) * w * 4), (h - 1 - r) * w * 4);
                    ctx.putImageData(id, x0, outH - y0 - h);
                }
            }
        } finally {
            acc.dispose(); out.dispose(); if (acc2) acc2.dispose();
            renderer.autoClear = true;
            renderer.setRenderTarget(null);
            compositeDirty = true;
        }

        Progress.update(prog, 'Encoding the JPEG...', null);
        await new Promise(r => setTimeout(r, 30));
        const crop = $('bake-crop').checked ? findCrop(canvas) : null;
        let enc = canvas;
        if (crop) { enc = document.createElement('canvas'); enc.width = crop.w; enc.height = crop.h; enc.getContext('2d').drawImage(canvas, crop.x, crop.y, crop.w, crop.h, 0, 0, crop.w, crop.h); }
        const blob = await new Promise(res => enc.toBlob(res, 'image/jpeg', 0.92));
        if (enc !== canvas) enc.width = enc.height = 0;
        if (!blob) { canvas.width = canvas.height = 0; showMessage('JPEG encoding failed (image too large for this browser).'); return; }
        const final = await addGPanoXMP(blob, outW, outH, crop);
        const link = document.createElement('a');
        link.download = 'stitched_panorama.jpg';
        link.href = URL.createObjectURL(final);
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
        showMessage(crop ? `Download complete: ${crop.w} × ${crop.h}, cropped from ${outW} × ${outH}` : `Download complete: ${outW} × ${outH}`);
        try {
            await showBakedResult(canvas);
            if (bgCustom && bgSrc && bgSrc.canvas === canvas) showMessage(`Download complete: ${outW} × ${outH}. The baked result is shown on top of the photos; untick "Show the background panorama on top" (Display and blending) to go back to the live photos. Artifacts in it can be retouched under "C. The background panorama".`);
        } catch (e) { console.warn('Could not show the baked result', e); canvas.width = canvas.height = 0; }
    }

    // ---------------- A window instead of the whole sphere ----------------
    // For pictures that do not cover the sphere (a building, a landscape from one spot): the output is a rectilinear or cylindrical window
    // centered on where the main view looks, kept level so the horizon stays straight, and saved as a plain JPEG (no 360° metadata).
    function winUI() {
        const kind = $('bake-proj').value, win = kind !== 'sphere';
        $('bake-sph').classList.toggle('hidden', win);
        $('bake-win').classList.toggle('hidden', !win);
        if (win) { const hf = $('bake-hfov'); if (kind === 'cyl' && parseFloat(hf.value) < 120) hf.value = 180; if (kind === 'rect' && parseFloat(hf.value) > 150) hf.value = 90; }
        $('bake-btn').textContent = win ? 'Bake the window' : 'Bake panorama';
    }
    function winGeom(quiet) {
        const kind = $('bake-proj').value;
        const hf = Math.max(5, Math.min(kind === 'cyl' ? 360 : 170, parseFloat($('bake-hfov').value) || 90));
        const vf = Math.max(5, Math.min(170, parseFloat($('bake-vfov').value) || 60));
        const W = Math.max(256, Math.min(20000, parseInt($('bake-ww').value) || 4096));
        const F = kind === 'cyl' ? W / (hf * DEG) : W / 2 / Math.tan(hf * DEG / 2);
        const H = Math.round(2 * F * Math.tan(vf * DEG / 2));
        return { kind, mode: kind === 'cyl' ? 2 : 1, hf, vf, W, H, F };
    }
    function updateWinSize() {
        if (!$('bake-proj') || $('bake-proj').value === 'sphere') return;
        const kind = $('bake-proj').value;
        const hf = Math.max(5, Math.min(kind === 'cyl' ? 360 : 170, parseFloat($('bake-hfov').value) || 90));
        const nat = nativePano || 4096;
        const W = kind === 'cyl' ? nat * hf / 360 : 2 * (nat / (2 * Math.PI)) * Math.tan(hf * DEG / 2);
        $('bake-ww').value = Math.max(512, Math.min(16384, Math.round(W / 16) * 16));
        $('bake-info').textContent = `Native size of this window ≈ ${$('bake-ww').value} px wide. Output ${winSizeText()}`;
    }
    function winSizeText() { const g = winGeom(); return `${g.W} × ${g.H} px`; }
    function winDir(g, B, px, py) {            // direction of the window pixel (px, py) counted from the middle, py up
        const v = new THREE.Vector3();
        if (g.mode === 2) { const a = px / g.F; return v.addScaledVector(B.r, Math.sin(a)).addScaledVector(B.f, Math.cos(a)).addScaledVector(B.u, py / g.F).normalize(); }
        return v.addScaledVector(B.r, px / g.F).addScaledVector(B.u, py / g.F).add(B.f).normalize();
    }
    function winPoint(g, B, d) {               // where direction d lands in the window, or null
        const x = d.dot(B.r), y = d.dot(B.u), z = d.dot(B.f);
        if (g.mode === 2) { const h = Math.hypot(x, z); if (h < 1e-6) return null; return { x: Math.atan2(x, z) * g.F, y: y / h * g.F }; }
        if (z <= 1e-6) return null;
        return { x: x / z * g.F, y: y / z * g.F };
    }
    function winSees(img, g, B) {
        const Bi = camBasis(img);
        for (let i = 0; i <= 6; i++) for (let j = 0; j <= 6; j++) {
            const q = winPoint(g, B, rayFromNorm(img, Bi, -1 + i / 3, -1 + j / 3));
            if (q && Math.abs(q.x) <= g.W / 2 + 2 && Math.abs(q.y) <= g.H / 2 + 2) return true;
        }
        for (let i = 0; i <= 16; i++) for (let j = 0; j <= 16; j++) {
            const n = dirToNorm(img, Bi, winDir(g, B, (i / 8 - 1) * g.W / 2, (j / 8 - 1) * g.H / 2));
            if (n && Math.abs(n.xn) <= 1.05 && Math.abs(n.yn) <= 1.05) return true;
        }
        return false;
    }
    // The background panorama seen through a mapping, into a W x H canvas, tile by tile. mode 0: a turned copy of the panorama itself
    // (Rinv maps a direction of the new picture to the old one); 1 / 2: a rectilinear / cylindrical window.
    let bgWinMat = null, bgWinScene = null;
    async function bgResample(W, H, mode, B, F, Rinv, prog) {
        const sr = ensureBgCanvas();
        if (!sr) throw new Error('There is no background panorama.');
        const maxTex = renderer.capabilities.maxTextureSize;
        if (sr.canvas.width > maxTex || sr.canvas.height > maxTex) throw new Error('The panorama is larger than this graphics card can handle (' + maxTex + ' px).');
        if (!bgWinMat) {
            bgWinMat = new THREE.ShaderMaterial({
                uniforms: Object.assign({ map: { value: null }, region: { value: new THREE.Vector4(0, 0, 1, 1) }, Rinv: { value: new THREE.Matrix3() } }, rectU2()),
                vertexShader: QUAD_VS,
                fragmentShader: `
                    uniform sampler2D map; uniform mat3 Rinv;
                    ${DIR_GLSL}
                    ${EQ_SAMPLE}
                    void main() { gl_FragColor = vec4(eqSample(map, normalize(Rinv * viewDir())).rgb, 1.0); }
                `
            });
            bgWinScene = new THREE.Scene();
            const quad = new THREE.Mesh(new THREE.PlaneGeometry(2, 2), bgWinMat); quad.frustumCulled = false; bgWinScene.add(quad);
        }
        const tex = prepEquirectTexture(new THREE.CanvasTexture(sr.canvas));
        const u = bgWinMat.uniforms;
        u.map.value = tex; u.Rinv.value.copy(Rinv || new THREE.Matrix3());
        u.rectMode.value = mode; u.cropSize.value.set(W, H); u.cropF.value = F || 1;
        if (B) { u.cr.value.copy(B.r); u.cu.value.copy(B.u); u.cf.value.copy(B.f); }
        const T = Math.min(4096, renderer.capabilities.maxTextureSize), nx = Math.ceil(W / T), ny = Math.ceil(H / T);
        const out = document.createElement('canvas'); out.width = W; out.height = H;
        const ctx = out.getContext('2d');
        if (!ctx) { tex.dispose(); throw new Error('The output is too large for this browser.'); }
        const rt = makeOutRT(T, T), buf = new Uint8Array(T * T * 4);
        renderBusy++;
        try {
            for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
                const x0 = tx * T, y0 = ty * T, w = Math.min(T, W - x0), h = Math.min(T, H - y0);
                if (prog) Progress.update(prog, `Rendering: tile ${ty * nx + tx + 1} of ${nx * ny}`, (ty * nx + tx) / (nx * ny));
                await new Promise(r => requestAnimationFrame(r));
                u.region.value.set(x0 / W, y0 / H, T / W, T / H);
                passQuad.material = bgWinMat;
                renderer.setRenderTarget(rt); renderer.render(bgWinScene, passCam);
                renderer.readRenderTargetPixels(rt, 0, 0, w, h, buf);
                const id = ctx.createImageData(w, h);
                for (let r = 0; r < h; r++) id.data.set(buf.subarray(r * w * 4, (r + 1) * w * 4), (h - 1 - r) * w * 4);
                ctx.putImageData(id, x0, H - y0 - h);
            }
        } finally { renderBusy--; renderer.setRenderTarget(null); rt.dispose(); tex.dispose(); compositeDirty = true; }
        return out;
    }
    function rectU2() {            // the uniforms of DIR_GLSL, as separate objects for a material of its own
        return { rectMode: { value: 0 }, cr: { value: new THREE.Vector3(1, 0, 0) }, cu: { value: new THREE.Vector3(0, 1, 0) }, cf: { value: new THREE.Vector3(0, 0, 1) }, cropF: { value: 1 }, cropSize: { value: new THREE.Vector2(1, 1) } };
    }
    async function bakeWindow(prog) {
        const g = winGeom(), fromBg = $('bake-src').value === 'bg';
        if (fromBg && !bgCustom) { showMessage('There is no background panorama: load one, or bake the whole sphere first. Or choose the photos as the source.'); return; }
        const list = images.filter(i => i.enabled);
        if (!fromBg && !list.length) { showMessage('No images to bake.'); return; }
        if (g.W > 16384 || g.H > 16384) { showMessage(`The window would be ${g.W} × ${g.H} px; the largest side is 16384. Lower the width or the angles.`); return; }
        if (isGyroEnabled) { showMessage('Turn the gyroscope off first: the window is centered on the main view.'); return; }
        const B = basisLook(viewBasis('cam').f, new THREE.Vector3(0, 1, 0));
        let canvas;
        if (fromBg) {
            canvas = await bgResample(g.W, g.H, g.mode, B, g.F, null, prog);
        } else {
            Progress.update(prog, 'Baking the window', 0);
            const gl = renderer.getContext();
            const maxSz = Math.min(renderer.capabilities.maxTextureSize, gl.getParameter(gl.MAX_RENDERBUFFER_SIZE));
            const T = Math.min(4096, maxSz), nx = Math.ceil(g.W / T), ny = Math.ceil(g.H / T);
            canvas = document.createElement('canvas'); canvas.width = g.W; canvas.height = g.H;
            const ctx = canvas.getContext('2d');
            if (!ctx) { showMessage('Output too large for this browser; choose a smaller size.'); return; }
            const seen = list.filter(img => winSees(img, g, B));
            const pin = patches.filter(p => p.enabled && p.tex);
            const acc = makeAccRT(T, T), out = makeOutRT(T, T), acc2 = blendSharp() > 1 ? makeAccRT(T, T) : null;
            const buf = new Uint8Array(T * T * 4);
            renderBusy++;
            try {
                setRectRaw(g.mode, B, g.F, g.W, g.H);
                for (let ty = 0; ty < ny; ty++) for (let tx = 0; tx < nx; tx++) {
                    const x0 = tx * T, y0 = ty * T, w = Math.min(T, g.W - x0), h = Math.min(T, g.H - y0);
                    const region = [x0 / g.W, y0 / g.H, T / g.W, T / g.H];
                    clearRT(acc); if (acc2) clearRT(acc2);
                    let k = 0;
                    for (const img of seen) {
                        Progress.update(prog, `Baking: tile ${ty * nx + tx + 1} of ${nx * ny}, photo ${++k} of ${seen.length}`, (ty * nx + tx + (k - 1) / Math.max(1, seen.length)) / (nx * ny));
                        await new Promise(r => requestAnimationFrame(r));
                        const { canvas: src } = await sourceCanvas(img, maxSz);
                        const tex = makeTexture(src);
                        renderer.autoClear = false;
                        projectInto(img, tex, region, acc, acc2, false);
                        renderer.autoClear = true; renderer.setRenderTarget(null);
                        tex.dispose();
                        if (src !== img.srcCanvas) src.width = src.height = 0;
                    }
                    normalize(acc, out, true, acc2);
                    if (pin.length) pasteInto(out, pin, region);
                    renderer.readRenderTargetPixels(out, 0, 0, w, h, buf);
                    const id = ctx.createImageData(w, h);
                    for (let r = 0; r < h; r++) id.data.set(buf.subarray(r * w * 4, (r + 1) * w * 4), (h - 1 - r) * w * 4);
                    ctx.putImageData(id, x0, g.H - y0 - h);
                }
            } finally {
                setRect(false); renderBusy--;
                acc.dispose(); out.dispose(); if (acc2) acc2.dispose();
                renderer.autoClear = true; renderer.setRenderTarget(null); compositeDirty = true;
            }
        }
        Progress.update(prog, 'Encoding the JPEG...', null);
        await new Promise(r => setTimeout(r, 30));
        const blob = await new Promise(res => canvas.toBlob(res, 'image/jpeg', 0.92));
        canvas.width = canvas.height = 0;
        if (!blob) { showMessage('JPEG encoding failed (image too large for this browser).'); return; }
        const link = document.createElement('a');
        link.download = g.kind === 'cyl' ? 'stitched_cylindrical.jpg' : 'stitched_window.jpg';
        link.href = URL.createObjectURL(blob);
        link.click();
        setTimeout(() => URL.revokeObjectURL(link.href), 10000);
        showMessage(`Download complete: ${g.W} × ${g.H}, ${g.hf.toFixed(0)}° × ${g.vf.toFixed(0)}`.replace(/(\d)$/, '$1°') + ' (a plain picture, without 360° metadata).');
    }

    // ---------------- Straightening the horizon ----------------
    // Click two points on the horizon. The great circle through them is turned to the level, around the axis perpendicular to both, so
    // the least possible happens to the front. Everything turns together: photos, patches, queued spots, the background panorama
    // (resampled) and the view, which keeps looking at the same picture content.
    let horizon = null;                // { pts: [unit vectors] } while picking
    let horizonBack = null;            // the quaternion that undoes the last straightening
    function horizonUI() {
        const on = !!horizon;
        $('level-btn').classList.toggle('tog-on', on);
        $('level-btn').textContent = on ? 'Cancel picking' : 'Straighten the horizon';
        $('level-undo').style.display = horizonBack ? '' : 'none';
    }
    function horizonStart() {
        if (horizon) { horizon = null; horizonUI(); showMessage('Cancelled.'); return; }
        if (pd) { showMessage('Close the retouch window first.'); return; }
        if (!images.length && !bgCustom) { showMessage('Load photos or a background panorama first.'); return; }
        if (isGyroEnabled) { showMessage('Turn the gyroscope off first.'); return; }
        if (renderBusy) { showMessage('Another long job is running; wait for it to finish.'); return; }
        horizon = { pts: [] }; horizonUI();
        showMessage('Click a point on the horizon at one side of the view, then another point on the horizon far from the first (at least 30° apart). Where the horizon is hidden, use the line where the sea or the flat ground would meet the sky, or the level lines of a building.');
    }
    function horizonClick(d) {
        horizon.pts.push(d.clone());
        if (horizon.pts.length < 2) { showMessage(`First point set (heading ${(wrap180(lonLat(d).lon / DEG)).toFixed(0)}°). Now click a second point on the horizon, away from the first.`); return; }
        const [a, b] = horizon.pts;
        horizon = null; horizonUI();
        if (a.angleTo(b) < 15 * DEG) { showMessage('The two points are too close together (less than 15°): the tilt cannot be measured well. Try again with points farther apart.'); return; }
        const n = new THREE.Vector3().crossVectors(a, b).normalize();
        if (n.y < 0) n.negate();
        const tilt = Math.acos(Math.max(-1, Math.min(1, n.y))) / DEG;
        if (tilt < 0.02) { showMessage('The horizon is already level.'); return; }
        if (tilt > 60) { showMessage('Those two points describe a circle tilted by ' + tilt.toFixed(0) + '°, which is not a horizon. Try again.'); return; }
        const Q = new THREE.Quaternion().setFromUnitVectors(n, new THREE.Vector3(0, 1, 0));
        horizonApply(Q).then(ok => { if (ok) showMessage('The horizon was tilted by ' + tilt.toFixed(2) + '° and is level now. “Undo” puts it back (the background panorama is resampled each time).'); });
    }
    async function horizonUndo() {
        if (!horizonBack) return;
        const ok = await horizonApply(horizonBack.clone(), true);
        if (ok) { horizonBack = null; horizonUI(); showMessage('Turned back.'); }
    }
    async function horizonApply(Q, isUndo) {
        if (renderBusy) { showMessage('Another long job is running; wait for it to finish.'); return false; }
        if (bgCustom && bgEdits.length && !confirm('The background panorama has ' + bgEdits.length + ' retouching edit' + (bgEdits.length > 1 ? 's' : '') + '. Turning it keeps them in the picture, but they can no longer be taken out one by one. Continue?')) return false;
        const prog = bgCustom ? Progress.start('Turning the panorama') : null;
        try {
            if (bgCustom) {                                         // first: it can fail, and then nothing else has moved
                const sr = ensureBgCanvas();
                if (sr) {
                    const Rinv = new THREE.Matrix3().setFromMatrix4(new THREE.Matrix4().makeRotationFromQuaternion(Q.clone().invert()));
                    const W = sr.canvas.width, H = sr.canvas.height;
                    const out = await bgResample(W, H, 0, null, 1, Rinv, prog);
                    const cc = sr.canvas.getContext('2d'); cc.clearRect(0, 0, W, H); cc.drawImage(out, 0, 0);
                    out.width = out.height = 0;
                    for (const e of bgEdits) e.before = [];
                    bgEdits = []; bgGen++; bgEdited = true;
                    bgRefreshDisplay(); bgUI();
                }
            }
        } catch (e) {
            console.error(e); showMessage('Could not turn the background panorama: ' + (e.message || e)); return false;
        } finally { if (prog) Progress.end(prog); }
        for (const im of images) {
            const q = new THREE.Quaternion().setFromEuler(new THREE.Euler(im.roll * DEG, -im.yaw * DEG, im.pitch * DEG, 'YZX'));
            const e = new THREE.Euler().setFromQuaternion(q.premultiply(Q), 'YZX');
            im.roll = e.x / DEG; im.yaw = wrap180(-e.y / DEG); im.pitch = e.z / DEG;
        }
        const turn = b => { b.r.applyQuaternion(Q); b.u.applyQuaternion(Q); b.f.applyQuaternion(Q); };
        for (const p of patches) turn(p.basis);
        for (const j of rtQueue) turn(j.basis);
        const la = lat * DEG, lo = lon * DEG;
        const v = new THREE.Vector3(Math.cos(la) * Math.cos(lo), Math.sin(la), Math.cos(la) * Math.sin(lo)).applyQuaternion(Q);
        const nl = Math.atan2(v.z, v.x) / DEG;
        lon += wrap180(nl - lon); targetLon = lon;
        lat = targetLat = Math.asin(Math.max(-1, Math.min(1, v.y))) / DEG;
        if (!isUndo) horizonBack = Q.clone().invert();
        horizonUI();
        updateSelectionUI(); touch(); updateOutlines(); refreshQueue();
        return true;
    }

    // Insert Google Photo Sphere (GPano) XMP so viewers recognize the file as a 360° panorama.
    // The largest rectangle with no empty (black) pixels, found on a reduced copy by trimming the emptiest edge until all four edges are full.
    // Returns {x, y, w, h} in pixels, or null when nothing needs cutting (or nothing is covered).
    function findCrop(canvas) {
        const K = 8;
        let c = canvas;
        while (c.width > canvas.width / K) {                 // shrink by halves so every small block is an average of its pixels
            const n = document.createElement('canvas'); n.width = Math.max(1, c.width >> 1); n.height = Math.max(1, c.height >> 1);
            const g = n.getContext('2d'); g.imageSmoothingQuality = 'high'; g.drawImage(c, 0, 0, n.width, n.height);
            if (c !== canvas) c.width = c.height = 0;
            c = n;
        }
        const w = c.width, h = c.height, d = c.getContext('2d').getImageData(0, 0, w, h).data;
        c.width = c.height = 0;
        const full = new Uint8Array(w * h);
        let any = 0;
        for (let i = 0; i < w * h; i++) { full[i] = (d[4 * i] + d[4 * i + 1] + d[4 * i + 2]) > 6 ? 1 : 0; any += full[i]; }
        if (!any) return null;
        let x0 = 0, y0 = 0, x1 = w, y1 = h;                  // the rectangle [x0, x1) x [y0, y1)
        const rowCov = y => { let n = 0; for (let x = x0; x < x1; x++) n += full[y * w + x]; return n / (x1 - x0); };
        const colCov = x => { let n = 0; for (let y = y0; y < y1; y++) n += full[y * w + x]; return n / (y1 - y0); };
        while (x1 - x0 > 4 && y1 - y0 > 4) {
            const cov = [rowCov(y0), rowCov(y1 - 1), colCov(x0), colCov(x1 - 1)];
            let m = 0; for (let k = 1; k < 4; k++) if (cov[k] < cov[m]) m = k;
            if (cov[m] >= 0.995) break;
            if (m === 0) y0++; else if (m === 1) y1--; else if (m === 2) x0++; else x1--;
        }
        const pad = 2;                                       // a little extra, since the reduced copy is blurry at the edges
        x0 = Math.min(x0 + (x0 > 0 ? pad : 0), w); y0 += y0 > 0 ? pad : 0; x1 -= x1 < w ? pad : 0; y1 -= y1 < h ? pad : 0;
        if (x1 - x0 < 4 || y1 - y0 < 4) return null;
        if (x0 === 0 && y0 === 0 && x1 === w && y1 === h) return null;
        const sx = canvas.width / w, sy = canvas.height / h;
        const r = { x: Math.round(x0 * sx), y: Math.round(y0 * sy), w: 0, h: 0 };
        r.w = Math.min(canvas.width - r.x, Math.round((x1 - x0) * sx)); r.h = Math.min(canvas.height - r.y, Math.round((y1 - y0) * sy));
        r.w &= ~1; r.h &= ~1;
        return r;
    }

    async function addGPanoXMP(blob, W, H, crop) {
        const cw = crop ? crop.w : W, ch = crop ? crop.h : H, cx = crop ? crop.x : 0, cy = crop ? crop.y : 0;
        const bytes = new Uint8Array(await blob.arrayBuffer());
        const xmp = '<?xpacket begin="﻿" id="W5M0MpCehiHzreSzNTczkc9d"?>' +
            '<x:xmpmeta xmlns:x="adobe:ns:meta/"><rdf:RDF xmlns:rdf="http://www.w3.org/1999/02/22-rdf-syntax-ns#">' +
            '<rdf:Description rdf:about="" xmlns:GPano="http://ns.google.com/photos/1.0/panorama/"' +
            ' GPano:ProjectionType="equirectangular" GPano:UsePanoramaViewer="True"' +
            ` GPano:FullPanoWidthPixels="${W}" GPano:FullPanoHeightPixels="${H}"` +
            ` GPano:CroppedAreaImageWidthPixels="${cw}" GPano:CroppedAreaImageHeightPixels="${ch}"` +
            ` GPano:CroppedAreaLeftPixels="${cx}" GPano:CroppedAreaTopPixels="${cy}"/>` +
            '</rdf:RDF></x:xmpmeta><?xpacket end="w"?>';
        const payload = new TextEncoder().encode('http://ns.adobe.com/xap/1.0/\0' + xmp);
        const seg = new Uint8Array(4 + payload.length);
        seg[0] = 0xFF; seg[1] = 0xE1; seg[2] = (payload.length + 2) >> 8; seg[3] = (payload.length + 2) & 0xFF;
        seg.set(payload, 4);
        let pos = 2;
        if (bytes[2] === 0xFF && bytes[3] === 0xE0) pos = 4 + ((bytes[4] << 8) | bytes[5]);   // after JFIF APP0
        return new Blob([bytes.subarray(0, pos), seg, bytes.subarray(pos)], { type: 'image/jpeg' });
    }

    // ---------------- Synthetic test set ----------------

    function makeTestSet() {
        const jitter = 0;
        const W = 1280, H = 960;
        const tanH = Math.tan(lens.fovLong * DEG / 2);
        const cam = new THREE.PerspectiveCamera(2 * Math.atan(tanH * H / W) / DEG, W / H, 1, 2000);
        const testScene = new THREE.Scene();
        testScene.add(new THREE.Mesh(sphereMesh.geometry, sphereMesh.material));
        const rt = new THREE.WebGLRenderTarget(W, H, { generateMipmaps: false });
        const buf = new Uint8Array(W * H * 4);
        const slots = layoutSlots();
        const rnd = () => (Math.random() * 2 - 1) * jitter;
        const startIndex = images.length;
        for (let i = 0; i < slots.length; i++) {
            const guess = layoutPose(startIndex + i, slots);
            const truth = { yaw: guess.yaw + rnd(), pitch: Math.max(-90, Math.min(90, guess.pitch + rnd())), roll: rnd() };
            const B = camBasis(truth);
            cam.quaternion.setFromRotationMatrix(new THREE.Matrix4().makeBasis(B.r, B.u, B.f.clone().negate()));
            cam.updateMatrixWorld();
            renderer.setRenderTarget(rt);
            renderer.render(testScene, cam);
            renderer.readRenderTargetPixels(rt, 0, 0, W, H, buf);
            const cv = document.createElement('canvas');
            cv.width = W; cv.height = H;
            const ctx = cv.getContext('2d');
            const id = ctx.createImageData(W, H);
            for (let r = 0; r < H; r++) id.data.set(buf.subarray(r * W * 4, (r + 1) * W * 4), (H - 1 - r) * W * 4);
            ctx.putImageData(id, 0, 0);
            images.push({ id: nextId++, name: `test_${String(i + 1).padStart(2, '0')}`, srcCanvas: cv, w: W, h: H,
                ...guess, enabled: true, gain: 1, truth, tex: makeTexture(cv) });
        }
        renderer.setRenderTarget(null);
        rt.dispose();
        touch();
        showMessage(`Added ${slots.length} test images (shot error ±${jitter}°)`);
    }

    function checkVsTruth() {
        const list = images.filter(i => i.truth);
        if (!list.length) { showMessage('No test images.'); return; }
        let s2 = 0, worst = 0, worstName = '';
        const rows = list.map(img => {
            const a = camBasis(img), b = camBasis(img.truth);
            // full rotation difference angle: acos((trace(Ra^T Rb) - 1) / 2)
            const tr = a.r.dot(b.r) + a.u.dot(b.u) + a.f.dot(b.f);
            const ang = Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))) / DEG;
            s2 += ang * ang;
            if (ang > worst) { worst = ang; worstName = img.name; }
            return { name: img.name, errorDeg: +ang.toFixed(3) };
        });
        console.table(rows);
        showMessage(`Pose error vs truth: RMS ${Math.sqrt(s2 / list.length).toFixed(3)}°, worst ${worst.toFixed(3)}° (${worstName})`);
        return rows;
    }

    // --- Core Events & Math ---

    function pointerDir(event) {
        mouse.x = (event.clientX / window.innerWidth) * 2 - 1;
        mouse.y = -(event.clientY / window.innerHeight) * 2 + 1;
        raycaster.setFromCamera(mouse, camera);
        return raycaster.ray.direction.clone().normalize();
    }

    // One mode for everything: the left button turns the view (a click selects the photo under it, with the brush on it paints),
    // the right button moves the photo under the cursor. Touch screens have no right button: the Touch button switches.
    function startLook(event) {
        isUserInteracting = true;
        lookStart = { x: event.clientX, y: event.clientY, button: event.button };
        onPointerDownMouseX = event.clientX;
        onPointerDownMouseY = event.clientY;
        onPointerDownLon = lon;
        onPointerDownLat = lat;
        document.addEventListener('pointermove', onPointerMoveLook);
        document.addEventListener('pointerup', onPointerUpLook);
    }
    function startImageDrag(event) {
        const d = pointerDir(event), img = hitTest(d);
        if (!img) return false;
        selectImage(img);
        const ll = lonLat(d);
        activeDrag = { img, lon0: ll.lon, lat0: ll.lat, yaw0: img.yaw, pitch0: img.pitch, k: event.shiftKey ? 0.25 : 1, fine: !!event.shiftKey };
        dragPointer.x = event.clientX; dragPointer.y = event.clientY; dragPointer.shift = !!event.shiftKey;
        document.addEventListener('pointermove', onPointerMoveDrag);
        document.addEventListener('pointerup', onPointerUpDrag);
        return true;
    }
    let lookStart = null;
    function onPointerDown(event) {
        if (isGyroEnabled || !event.isPrimary) return;
        const touch = event.pointerType === 'touch';
        if (event.button === 2 && !touch) {
            if (!maskBrush.on && startImageDrag(event)) return;
            startLook(event);                                    // brush on, or nothing under the cursor: turn the view
            return;
        }
        if (event.button !== 0) return;
        if (maskBrush.on) { mbDown(event); return; }
        if (touch && isDragMode) { startImageDrag(event); return; }
        startLook(event);
    }

    function onPointerMoveLook(event) {
        if (!isUserInteracting || !event.isPrimary) return;
        targetLon = (onPointerDownMouseX - event.clientX) * 0.15 + onPointerDownLon;
        targetLat = (event.clientY - onPointerDownMouseY) * 0.15 + onPointerDownLat;
    }

    function onPointerUpLook(event) {
        isUserInteracting = false;
        // a click (no movement) with the left button selects the photo under the cursor
        if (event && lookStart && lookStart.button === 0 && Math.hypot(event.clientX - lookStart.x, event.clientY - lookStart.y) < 4) {
            if (horizon) horizonClick(pointerDir(event));
            else { const img = hitTest(pointerDir(event)); if (img) selectImage(img); }
        }
        lookStart = null;
        document.removeEventListener('pointermove', onPointerMoveLook);
        document.removeEventListener('pointerup', onPointerUpLook);
    }

    function onPointerMoveDrag(event) {
        if (!activeDrag || !event.isPrimary) return;
        dragPointer.x = event.clientX; dragPointer.y = event.clientY; dragPointer.shift = event.shiftKey;
        applyDrag();
    }

    // Recomputes the dragged image pose from the last pointer position (also called every frame during edge auto-pan)
    function applyDrag() {
        if (!activeDrag) return;
        const ll = lonLat(pointerDir({ clientX: dragPointer.x, clientY: dragPointer.y }));
        const k = dragPointer.shift ? 0.25 : 1;                // Shift = fine movement, a quarter of the mouse travel
        if (k !== activeDrag.k) {                              // switching speed: restart from where the photo is now, without a jump
            activeDrag.k = k; activeDrag.lon0 = ll.lon; activeDrag.lat0 = ll.lat; activeDrag.yaw0 = activeDrag.img.yaw; activeDrag.pitch0 = activeDrag.img.pitch;
        }
        if (k < 1) activeDrag.fine = true;
        let dLon = ll.lon - activeDrag.lon0;
        while (dLon > Math.PI) dLon -= 2 * Math.PI;
        while (dLon < -Math.PI) dLon += 2 * Math.PI;
        const img = activeDrag.img;
        img.yaw = wrap180(activeDrag.yaw0 + k * dLon / DEG);
        img.pitch = Math.max(-90, Math.min(90, activeDrag.pitch0 + k * (ll.lat - activeDrag.lat0) / DEG));
        updateSelectionUI();
        touch();
    }

    let snapHintShown = false;
    function onPointerUpDrag(event) {
        const img = activeDrag && activeDrag.img, fine = !!(activeDrag && activeDrag.fine) || !!(event && event.shiftKey);
        activeDrag = null;
        document.removeEventListener('pointermove', onPointerMoveDrag);
        document.removeEventListener('pointerup', onPointerUpDrag);
        compositeDirty = true;
        if (img && fine) showMessage('Fine adjustment kept (no snap). Save Poses keeps it.');
        else if (img && document.getElementById('snap-release-chk').checked) {
            ensureAnalyzed().then(ok => { if (ok && images.includes(img)) snapImage(img, 20, false); });   // says why when it does not snap
        }
    }

    function toggleFullscreen() {
        if (!document.fullscreenElement) {
            document.documentElement.requestFullscreen().catch(err => showMessage(`Error: ${err.message}`));
        } else if (document.exitFullscreen) {
            document.exitFullscreen();
        }
    }

    // The three-bar button in the corner is always there: it shows the other buttons, or hides them. They stay as they are until
    // it is pressed again (no timers). The buttons start hidden: the picture is what matters.
    function setupIdleFader() {
        const layer = document.getElementById('ui-layer'), corner = document.getElementById('ui-corner');
        uiShow = on => { layer.classList.toggle('ui-off', !on); };
        corner.addEventListener('click', () => uiShow(layer.classList.contains('ui-off')));
        uiShow(false);
    }

    function generateProceduralEquirectangularTexture() {
        const width = 2048, height = 1024;
        const canvas = document.createElement('canvas');
        canvas.width = width; canvas.height = height;
        const ctx = canvas.getContext('2d');

        const gradient = ctx.createLinearGradient(0, 0, 0, height);
        gradient.addColorStop(0, "#0a0a1a");
        gradient.addColorStop(0.5, "#1a1a3a");
        gradient.addColorStop(1, "#0a0a1a");
        ctx.fillStyle = gradient; ctx.fillRect(0, 0, width, height);

        ctx.strokeStyle = "rgba(255, 255, 255, 0.05)";
        ctx.lineWidth = 2;
        for(let i = 0; i <= width; i += 64) { ctx.beginPath(); ctx.moveTo(i, 0); ctx.lineTo(i, height); ctx.stroke(); }
        for(let i = 0; i <= height; i += 64) { ctx.beginPath(); ctx.moveTo(0, i); ctx.lineTo(width, i); ctx.stroke(); }

        ctx.strokeStyle = "rgba(100, 255, 218, 0.3)";
        ctx.lineWidth = 2;
        ctx.beginPath(); ctx.moveTo(0, height / 2); ctx.lineTo(width, height / 2); ctx.stroke();

        ctx.fillStyle = "rgba(255,255,255,0.1)";
        ctx.font = "bold 60px Inter"; ctx.textAlign = "center"; ctx.textBaseline = "middle";
        ctx.fillText("FRONT", width / 2, height / 2);
        ctx.fillText("LEFT", width / 4, height / 2);
        ctx.fillText("RIGHT", (width / 4) * 3, height / 2);

        return new THREE.CanvasTexture(canvas);
    }

    function toggleGyro() {
        if (isGyroEnabled) {
            if (deviceControls) { deviceControls.dispose(); deviceControls = null; }
            isGyroEnabled = false;
            const euler = new THREE.Euler().setFromQuaternion(camera.quaternion, 'YXZ');
            lat = THREE.MathUtils.radToDeg(-euler.x);
            lon = THREE.MathUtils.radToDeg(-euler.y) - 90;
            targetLat = lat; targetLon = lon;
            document.getElementById('gyro-btn').classList.remove('bg-teal-600', 'tog-on');
        } else {
            if (typeof DeviceOrientationEvent !== 'undefined' && typeof DeviceOrientationEvent.requestPermission === 'function') {
                DeviceOrientationEvent.requestPermission().then(state => {
                    if (state === 'granted') activateGyro();
                    else showMessage('Gyro denied.');
                }).catch(err => showMessage('Error: ' + err.message));
            } else activateGyro();
        }
    }

    function activateGyro() {
        deviceControls = new DeviceOrientationControls(camera);
        isGyroEnabled = true;
        setDragMode(false);
        document.getElementById('gyro-btn').classList.add('bg-teal-600', 'tog-on');
    }

    let msgTimer = null;
    function showMessage(msg) {
        const msgBox = document.getElementById('message-box');
        msgBox.textContent = msg;
        msgBox.classList.remove('hidden');
        clearTimeout(msgTimer);
        msgTimer = setTimeout(() => msgBox.classList.add('hidden'), 4000);
    }

    function onWindowResize() {
        camera.aspect = window.innerWidth / window.innerHeight;
        camera.updateProjectionMatrix();
        renderer.setSize(window.innerWidth, window.innerHeight);
    }

    function onMouseWheel(event) {
        event.preventDefault();
        if (event.shiftKey || event.ctrlKey) {
            const img = hitTest(pointerDir(event)) || selectedImg;
            if (img) {
                adjustPriority(img, event.deltaY || event.deltaX);
                const label = document.getElementById('hover-label');
                label.textContent = hoverText(img);
                label.style.left = (event.clientX + 14) + 'px';
                label.style.top = (event.clientY + 14) + 'px';
                label.style.display = 'block';
                return;
            }
        }
        updateZoom(camera.fov + event.deltaY * 0.05);
    }
    // Blend priority in steps of a quarter octave: wheel up (negative delta) raises it.
    function adjustPriority(img, delta) {
        const v = Math.max(-2, Math.min(2, Math.log2(img.prio || 1) + (delta < 0 ? 0.25 : -0.25)));
        img.prio = Math.pow(2, v);
        if (img === selectedImg) updateSelectionUI();
        touch();
    }
    function hoverText(img) {
        return `${images.indexOf(img) + 1}/${images.length}  ${img.name}   priority ×${(img.prio || 1).toFixed(2)}`;
    }
    function getDistance(t1, t2) { return Math.sqrt(Math.pow(t1.clientX - t2.clientX, 2) + Math.pow(t1.clientY - t2.clientY, 2)); }
    function onTouchStart(e) { if (e.touches.length === 2) { initialPinchDistance = getDistance(e.touches[0], e.touches[1]); initialFov = camera.fov; } }
    function onTouchMove(e) { if (e.touches.length === 2 && initialPinchDistance) { e.preventDefault(); updateZoom(initialFov * (initialPinchDistance / getDistance(e.touches[0], e.touches[1]))); } }
    function updateZoom(newFov) { camera.fov = Math.max(minFov, Math.min(maxFov, newFov)); camera.updateProjectionMatrix(); }

    function animate() {
        requestAnimationFrame(animate);
        if (compositeDirty && !renderBusy) {
            compositeDirty = false; brushRect = null;
            composite(interacting ? previewMoving() : PREVIEW_HI);
        } else if (brushRect && !renderBusy && previewRTs[lastCompW]) {
            const r = brushRect; brushRect = null;      // brushing: redraw just the part that changed
            composite(lastCompW, r);
        }
        if (isGyroEnabled && deviceControls) {
            deviceControls.update();
        } else {
            if (activeDrag) {
                // Holding a dragged image near a screen edge keeps turning the view, so it can be carried far.
                const M = 0.12, ex = dragPointer.x / window.innerWidth, ey = dragPointer.y / window.innerHeight;
                const px = ex < M ? -(M - ex) / M : (ex > 1 - M ? (ex - (1 - M)) / M : 0);
                const py = ey < M ? -(M - ey) / M : (ey > 1 - M ? (ey - (1 - M)) / M : 0);
                if (px || py) {
                    targetLon += px * 1.0;
                    targetLat = Math.max(-85, Math.min(85, targetLat - py * 1.0));
                    applyDrag();
                }
            }
            lon += (targetLon - lon) * 0.1;
            lat += (targetLat - lat) * 0.1;
            lat = Math.max(-85, Math.min(85, lat));
            phi = THREE.MathUtils.degToRad(90 - lat);
            theta = THREE.MathUtils.degToRad(lon);
            const targetX = 500 * Math.sin(phi) * Math.cos(theta);
            const targetY = 500 * Math.cos(phi);
            const targetZ = 500 * Math.sin(phi) * Math.sin(theta);
            camera.lookAt(targetX, targetY, targetZ);
        }
        renderer.render(scene, camera);
    }
})().catch(e => { console.error(e); const m = document.getElementById('message-box'); if (m) { m.textContent = 'Simple Pano could not start: ' + (e.message || e); m.classList.remove('hidden'); } });
