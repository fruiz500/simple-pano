/* pano_align.js: automatic alignment engine for Simple Pano.
 *
 * Pipeline (after Szeliski, "Image Alignment and Stitching: A Tutorial", and Brown & Lowe):
 *   1. ORB features per image (pano_features.js, plain JavaScript), cheap probe to find candidate overlaps
 *   2. ratio-test matches + RANSAC homography per candidate pair  -> verified correspondences
 *   3. focal length from homographies (rotation-only model), rotations chained along a spanning tree
 *   4. robust bundle adjustment of rotations + shared focal length (+ radial term b), image-plane error
 *   5. leveling (up vector = smallest eigenvector of the camera x-axes) and yaw reference
 *   6. per-image gain compensation (Brown & Lowe least squares)
 *   7. helpers for the viewer: live fit of one image against its matches, snap one image, neighbors
 *
 * Conventions match the viewer: world y up, yaw 0 looks along +x and increases toward +z,
 * camera basis R = [right up forward] (columns), image coordinates centerd, x right, y UP, in pixels.
 * Focal length is stored as fn = F / (longSide / 2) = 1 / tan(fovLong / 2) so it is resolution independent.
 * Lens radial model: source = ideal * (a r^3 + b r^2 + c r + 1 - a - b - c), r = |ideal| / (shortSide / 2).
 * Plain classic script: works from file://. Exposes window.PanoAlign (and module.exports in Node).
 */
(function (outer) {
    function factory(root) {
    'use strict';
    const D2R = Math.PI / 180, R2D = 180 / Math.PI;

    // ------------------------------------------------------------------ small math (3x3 row-major arrays)
    const M = {
        id: () => [1, 0, 0, 0, 1, 0, 0, 0, 1],
        mul(A, B) {
            const C = new Array(9);
            for (let i = 0; i < 3; i++) for (let j = 0; j < 3; j++)
                C[3 * i + j] = A[3 * i] * B[j] + A[3 * i + 1] * B[3 + j] + A[3 * i + 2] * B[6 + j];
            return C;
        },
        T: A => [A[0], A[3], A[6], A[1], A[4], A[7], A[2], A[5], A[8]],
        mv: (A, v) => [A[0] * v[0] + A[1] * v[1] + A[2] * v[2], A[3] * v[0] + A[4] * v[1] + A[5] * v[2], A[6] * v[0] + A[7] * v[1] + A[8] * v[2]],
        mtv: (A, v) => [A[0] * v[0] + A[3] * v[1] + A[6] * v[2], A[1] * v[0] + A[4] * v[1] + A[7] * v[2], A[2] * v[0] + A[5] * v[1] + A[8] * v[2]],
        col: (A, k) => [A[k], A[3 + k], A[6 + k]],
        fromCols: (a, b, c) => [a[0], b[0], c[0], a[1], b[1], c[1], a[2], b[2], c[2]],
        // exp of the skew matrix of w (Rodrigues)
        exp(w) {
            const t = Math.hypot(w[0], w[1], w[2]);
            if (t < 1e-14) return [1, -w[2], w[1], w[2], 1, -w[0], -w[1], w[0], 1];
            const x = w[0] / t, y = w[1] / t, z = w[2] / t, c = Math.cos(t), s = Math.sin(t), k = 1 - c;
            return [c + x * x * k, x * y * k - z * s, x * z * k + y * s,
                y * x * k + z * s, c + y * y * k, y * z * k - x * s,
                z * x * k - y * s, z * y * k + x * s, c + z * z * k];
        },
        rotY(a) { const c = Math.cos(a), s = Math.sin(a); return [c, 0, -s, 0, 1, 0, s, 0, c]; },   // adds a to the yaw
        // angle (rad) of the rotation A^T B
        angleBetween(A, B) { const tr = A[0] * B[0] + A[1] * B[1] + A[2] * B[2] + A[3] * B[3] + A[4] * B[4] + A[5] * B[5] + A[6] * B[6] + A[7] * B[7] + A[8] * B[8]; return Math.acos(Math.max(-1, Math.min(1, (tr - 1) / 2))); },
        fromQuat(w, x, y, z) {
            return [1 - 2 * (y * y + z * z), 2 * (x * y - z * w), 2 * (x * z + y * w),
                2 * (x * y + z * w), 1 - 2 * (x * x + z * z), 2 * (y * z - x * w),
                2 * (x * z - y * w), 2 * (y * z + x * w), 1 - 2 * (x * x + y * y)];
        }
    };
    const cross = (a, b) => [a[1] * b[2] - a[2] * b[1], a[2] * b[0] - a[0] * b[2], a[0] * b[1] - a[1] * b[0]];
    const dot = (a, b) => a[0] * b[0] + a[1] * b[1] + a[2] * b[2];
    const nrm = a => Math.hypot(a[0], a[1], a[2]);
    const unit = a => { const n = nrm(a) || 1; return [a[0] / n, a[1] / n, a[2] / n]; };

    // Jacobi eigen-decomposition of a symmetric n x n matrix (array of arrays). Returns {values, vectors[col]}.
    function jacobiEigen(Ain, n) {
        const A = Ain.map(r => r.slice()), V = Array.from({ length: n }, (_, i) => Array.from({ length: n }, (_, j) => (i === j ? 1 : 0)));
        for (let sweep = 0; sweep < 60; sweep++) {
            let off = 0;
            for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) off += A[p][q] * A[p][q];
            if (off < 1e-24) break;
            for (let p = 0; p < n; p++) for (let q = p + 1; q < n; q++) {
                if (Math.abs(A[p][q]) < 1e-300) continue;
                const th = (A[q][q] - A[p][p]) / (2 * A[p][q]);
                const t = Math.sign(th || 1) / (Math.abs(th) + Math.sqrt(th * th + 1)), c = 1 / Math.sqrt(t * t + 1), s = t * c;
                for (let k = 0; k < n; k++) { const akp = A[k][p], akq = A[k][q]; A[k][p] = c * akp - s * akq; A[k][q] = s * akp + c * akq; }
                for (let k = 0; k < n; k++) { const apk = A[p][k], aqk = A[q][k]; A[p][k] = c * apk - s * aqk; A[q][k] = s * apk + c * aqk; }
                for (let k = 0; k < n; k++) { const vkp = V[k][p], vkq = V[k][q]; V[k][p] = c * vkp - s * vkq; V[k][q] = s * vkp + c * vkq; }
            }
        }
        return { values: A.map((r, i) => r[i]), vectors: (k) => V.map(r => r[k]) };
    }

    // Horn's closed-form absolute orientation: rotation R minimizing sum w |b - R a|^2.  pairs: arrays of [a, b, w].
    function hornRotation(A, B, W) {
        let Sxx = 0, Sxy = 0, Sxz = 0, Syx = 0, Syy = 0, Syz = 0, Szx = 0, Szy = 0, Szz = 0;
        for (let k = 0; k < A.length; k++) {
            const a = A[k], b = B[k], w = W ? W[k] : 1;
            Sxx += w * a[0] * b[0]; Sxy += w * a[0] * b[1]; Sxz += w * a[0] * b[2];
            Syx += w * a[1] * b[0]; Syy += w * a[1] * b[1]; Syz += w * a[1] * b[2];
            Szx += w * a[2] * b[0]; Szy += w * a[2] * b[1]; Szz += w * a[2] * b[2];
        }
        const N = [[Sxx + Syy + Szz, Syz - Szy, Szx - Sxz, Sxy - Syx],
            [Syz - Szy, Sxx - Syy - Szz, Sxy + Syx, Szx + Sxz],
            [Szx - Sxz, Sxy + Syx, -Sxx + Syy - Szz, Syz + Szy],
            [Sxy - Syx, Szx + Sxz, Syz + Szy, -Sxx - Syy + Szz]];
        const e = jacobiEigen(N, 4);
        let best = 0; for (let k = 1; k < 4; k++) if (e.values[k] > e.values[best]) best = k;
        const q = e.vectors(best);
        return M.fromQuat(q[0], q[1], q[2], q[3]);
    }

    // ------------------------------------------------------------------ pose <-> rotation (viewer convention)
    function RfromPose(yawDeg, pitchDeg, rollDeg) {
        const y = yawDeg * D2R, p = pitchDeg * D2R, r = rollDeg * D2R;
        const cy = Math.cos(y), sy = Math.sin(y), cp = Math.cos(p), sp = Math.sin(p);
        const f = [cy * cp, sp, sy * cp], r0 = [-sy, 0, cy], u0 = cross(r0, f);
        const c = Math.cos(r), s = Math.sin(r);
        const right = [c * r0[0] - s * u0[0], c * r0[1] - s * u0[1], c * r0[2] - s * u0[2]];
        const up = [c * u0[0] + s * r0[0], c * u0[1] + s * r0[1], c * u0[2] + s * r0[2]];
        return M.fromCols(right, up, f);
    }
    function poseFromR(R) {
        const right = M.col(R, 0), f = M.col(R, 2);
        const pitch = Math.asin(Math.max(-1, Math.min(1, f[1])));
        let yaw;
        if (Math.cos(pitch) > 0.005) yaw = Math.atan2(f[2], f[0]);
        else yaw = Math.atan2(-right[0], right[2]);         // at a pole: take yaw from the right vector, roll = 0
        const cy = Math.cos(yaw), sy = Math.sin(yaw);
        const r0 = [-sy, 0, cy], u0 = cross(r0, f);
        const roll = Math.cos(pitch) > 0.005 ? Math.atan2(-dot(right, u0), dot(right, r0)) : 0;
        return { yaw: yaw * R2D, pitch: pitch * R2D, roll: roll * R2D };
    }

    // ------------------------------------------------------------------ lens model helpers
    // source pixel -> ideal (undistorted) pixel, by fixed-point inversion of  src = ideal * sc(|ideal|/h)
    function undistort(x, y, h, a, b, c) {
        if (!a && !b && !c) return [x, y];
        let ux = x, uy = y;
        for (let it = 0; it < 6; it++) {
            const rn = Math.hypot(ux, uy) / h;
            const sc = ((a * rn + b) * rn + c) * rn + (1 - a - b - c);
            ux = x / sc; uy = y / sc;
        }
        return [ux, uy];
    }

    // ------------------------------------------------------------------ homography focal length (Szeliski eq. 2.19, OpenCV focalsFromHomography)
    function focalsFromHomography(h) {      // h: 9 numbers row-major, centerd coordinates. returns {f0, f1} (pixels, may be null)
        let d1 = h[6] * h[7], d2 = (h[7] - h[6]) * (h[7] + h[6]);
        let v1 = -(h[0] * h[1] + h[3] * h[4]) / d1, v2 = (h[0] * h[0] + h[3] * h[3] - h[1] * h[1] - h[4] * h[4]) / d2;
        if (v1 < v2) { const t = v1; v1 = v2; v2 = t; }
        let f1 = null, f0 = null;
        if (v1 > 0 && v2 > 0) f1 = Math.sqrt(Math.abs(d1) > Math.abs(d2) ? v1 : v2); else if (v1 > 0) f1 = Math.sqrt(v1);
        d1 = h[0] * h[3] + h[1] * h[4]; d2 = h[0] * h[0] + h[1] * h[1] - h[3] * h[3] - h[4] * h[4];
        v1 = -h[2] * h[5] / d1; v2 = (h[5] * h[5] - h[2] * h[2]) / d2;
        if (v1 < v2) { const t = v1; v1 = v2; v2 = t; }
        if (v1 > 0 && v2 > 0) f0 = Math.sqrt(Math.abs(d1) > Math.abs(d2) ? v1 : v2); else if (v1 > 0) f0 = Math.sqrt(v1);
        return { f0, f1 };
    }

    // ------------------------------------------------------------------ the feature matcher (pano_features.js)
    // It is plain JavaScript, about 25 KB: nothing to download from elsewhere or compile. In the Web Worker it is defined by the
    // prefix the viewer adds; on a page, pano_features.js must have been loaded first.
    async function loadFeatures() {
        if (root.PanoFeatures) return root.PanoFeatures;
        if (typeof module !== 'undefined' && module.exports && typeof require === 'function') return require('./pano_features.js');
        throw new Error('pano_features.js is missing: it must sit in the same folder as this page.');
    }

    // ------------------------------------------------------------------ feature detection
    // gray: Uint8Array w*h. Returns {w,h,n,xy (Float32Array, detection px, y down), desc, probe ({ d: Uint32Array, n }), lum (Float32Array)}
    function detect(F, gray, w, h, opts) {
        const r = F.detect(gray, w, h, { nFeatures: opts.nFeatures, counts: [opts.probeFeatures] });          // ORB, as OpenCV's ORB(n, 1.2, 8, 15, 0, 2, HARRIS, 31, 10)
        const out = { w, h }, n = r.n;
        out.n = n; out.xy = r.xy; out.lum = new Float32Array(n);
        for (let k = 0; k < n; k++) {
            const p = { x: r.xy[2 * k], y: r.xy[2 * k + 1] };
            // mean gray of a 5x5 patch around the keypoint (used for exposure compensation)
            const x0 = Math.max(0, Math.round(p.x) - 2), x1 = Math.min(w - 1, Math.round(p.x) + 2), y0 = Math.max(0, Math.round(p.y) - 2), y1 = Math.min(h - 1, Math.round(p.y) + 2);
            let s = 0, c = 0;
            for (let yy = y0; yy <= y1; yy++) for (let xx = x0; xx <= x1; xx++) { s += gray[yy * w + xx]; c++; }
            out.lum[k] = s / c;
        }
        out.desc = { d: r.desc, n };
        // cheap probe descriptors: the strongest 500 features only (a subset of the ones above)
        const pi = r.sets[opts.probeFeatures];
        out.probe = { d: F.subset(r.desc, pi), n: pi.length };
        return out;
    }

    function knn(F, dA, dB, ratio) { return F.knn2(dA.d, dA.n, dB.d, dB.n, ratio); }         // returns flat [qIdx, tIdx, ...]

    const tick = () => new Promise(r => setTimeout(r, 0));

    // ------------------------------------------------------------------ analysis: features, candidate pairs, verified correspondences
    // imgs: [{gray, w, h}]  (gray at detection resolution, all same scale convention)
    async function analyze(F, imgs, opts, onProgress) {
        opts = Object.assign({ nFeatures: 2000, probeFeatures: 500, ratio: 0.8, ransacPx: 4, minInliers: 18, minInlierFrac: 0.05, allPairsBelow: 13, topPartners: 6 }, opts || {});
        const N = imgs.length, say = (m, f) => onProgress && onProgress(m, f);
        const feats = [];
        for (let i = 0; i < N; i++) {
            say(`Finding features ${i + 1}/${N}`, 0.0 + 0.2 * i / N);
            feats.push(detect(F, imgs[i].gray, imgs[i].w, imgs[i].h, opts));
            await tick();
        }
        // candidate pairs
        const cand = [];
        if (N < opts.allPairsBelow) { for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) cand.push([i, j]); }
        else {
            const score = Array.from({ length: N }, () => []), probeCount = {};
            let done = 0; const total = N * (N - 1) / 2;
            for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
                const c = knn(F, feats[i].probe, feats[j].probe, 0.8).length / 2;
                probeCount[i + ',' + j] = c; score[i].push([c, j]); score[j].push([c, i]);
                if ((++done) % 40 === 0) { say(`Probing overlaps ${done}/${total}`, 0.2 + 0.15 * done / total); await tick(); }
            }
            const keep = new Set();
            for (let i = 0; i < N; i++) {
                score[i].sort((a, b) => b[0] - a[0]);
                score[i].slice(0, opts.topPartners).forEach(([c, j]) => keep.add(Math.min(i, j) + ',' + Math.max(i, j)));
            }
            for (const k in probeCount) if (probeCount[k] >= 3) keep.add(k);
            keep.forEach(k => cand.push(k.split(',').map(Number)));
        }
        // full matching + homography RANSAC
        const pairs = new Map(), fEst = [];
        let done = 0;
        for (const [i, j] of cand) {
            if ((++done) % 3 === 0) { say(`Matching pair ${done}/${cand.length}`, 0.35 + 0.6 * done / cand.length); await tick(); }
            const mt = knn(F, feats[i].desc, feats[j].desc, opts.ratio);
            const n = mt.length / 2;
            if (n < opts.minInliers) continue;
            const A = feats[i], B = feats[j];
            const pa = new Float32Array(2 * n), pb = new Float32Array(2 * n);
            for (let k = 0; k < n; k++) {
                const qi = mt[2 * k], ti = mt[2 * k + 1];
                pa[2 * k] = A.xy[2 * qi] - A.w / 2; pa[2 * k + 1] = A.h / 2 - A.xy[2 * qi + 1];
                pb[2 * k] = B.xy[2 * ti] - B.w / 2; pb[2 * k + 1] = B.h / 2 - B.xy[2 * ti + 1];
            }
            const hr = F.homography(pa, pb, n, opts.ransacPx, 2000, 0.995);
            let inl = 0; const keepIdx = [];
            if (hr) { for (let k = 0; k < n; k++) if (hr.mask[k]) { inl++; keepIdx.push(k); } }
            if (inl >= opts.minInliers && inl >= opts.minInlierFrac * n) {
                const pts = new Float32Array(4 * inl), la = new Float32Array(inl), lb = new Float32Array(inl);
                keepIdx.forEach((k, m) => {
                    pts[4 * m] = pa[2 * k]; pts[4 * m + 1] = pa[2 * k + 1]; pts[4 * m + 2] = pb[2 * k]; pts[4 * m + 3] = pb[2 * k + 1];
                    la[m] = A.lum[mt[2 * k]]; lb[m] = B.lum[mt[2 * k + 1]];
                });
                const key = i + ',' + j;
                pairs.set(key, { i, j, n, inl, pts, la, lb });
                if (inl >= 40) {
                    const h = hr.H, fo = focalsFromHomography(h);
                    const L0 = Math.max(A.w, A.h), L1 = Math.max(B.w, B.h);
                    if (fo.f0 && isFinite(fo.f0)) fEst.push(fo.f0 / (L0 / 2));
                    if (fo.f1 && isFinite(fo.f1)) fEst.push(fo.f1 / (L1 / 2));
                }
            }
        }
        // focal estimate from homographies (normalized fn), median of plausible values
        const good = fEst.filter(v => v > 0.5 && v < 4).sort((a, b) => a - b);
        const fnH = good.length >= 3 ? good[Math.floor(good.length / 2)] : null;
        const size = imgs.map(im => ({ w: im.w, h: im.h }));
        const an = { N, size, pairs, fnH, opts, nCandidates: cand.length };
        an.adj = buildAdj(an);
        say(`Found ${pairs.size} overlapping pairs`, 1);
        return an;
    }
    function buildAdj(an) {
        const adj = Array.from({ length: an.N }, () => []);
        an.pairs.forEach(p => { adj[p.i].push({ j: p.j, inl: p.inl, p }); adj[p.j].push({ j: p.i, inl: p.inl, p }); });
        adj.forEach(a => a.sort((x, y) => y.inl - x.inl));
        return adj;
    }

    // rays (unit, camera coordinates) for a correspondence list of one image of a pair
    function rayOf(an, img, x, y, fn, lens) {
        const s = an.size[img], F = fn * Math.max(s.w, s.h) / 2, h = Math.min(s.w, s.h) / 2;
        const u = undistort(x, y, h, lens.a, lens.b, lens.c);
        const n = Math.hypot(u[0], u[1], F);
        return [u[0] / n, u[1] / n, F / n];
    }

    // ------------------------------------------------------------------ initial rotations (spanning tree) and bundle adjustment
    function pairRotation(an, p, fn, lens) {       // rotation taking cam_i coords to cam_j coords
        const A = [], B = [];
        for (let k = 0; k < p.inl; k++) {
            A.push(rayOf(an, p.i, p.pts[4 * k], p.pts[4 * k + 1], fn, lens));
            B.push(rayOf(an, p.j, p.pts[4 * k + 2], p.pts[4 * k + 3], fn, lens));
        }
        let W = null, R = hornRotation(A, B, null);
        for (let it = 0; it < 4; it++) {            // reweight: drop gross outliers
            const e = A.map((a, k) => Math.acos(Math.max(-1, Math.min(1, dot(M.mv(R, a), B[k])))));
            const s = Math.max(0.002, 2.5 * median(e));
            W = e.map(x => (x < s ? 1 : 0.02));
            R = hornRotation(A, B, W);
        }
        return R;
    }
    function median(a) { const s = Array.from(a).sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : 0; }

    function components(an, pairOk) {
        const comp = new Array(an.N).fill(-1); let c = 0;
        for (let s = 0; s < an.N; s++) {
            if (comp[s] >= 0) continue;
            comp[s] = c; const st = [s];
            while (st.length) { const v = st.pop(); for (const e of an.adj[v]) if (pairOk(e.p) && comp[e.j] < 0) { comp[e.j] = c; st.push(e.j); } }
            c++;
        }
        return { comp, count: c };
    }

    function initialRotations(an, fn, lens, pairOk) {
        const { comp, count } = components(an, pairOk);
        const sizes = new Array(count).fill(0); comp.forEach(c => sizes[c]++);
        let main = 0; for (let c = 1; c < count; c++) if (sizes[c] > sizes[main]) main = c;
        const members = []; comp.forEach((c, i) => { if (c === main) members.push(i); });
        const R = new Array(an.N).fill(null);
        if (members.length < 2) return { R, members, root: members[0] };
        // root = image with most inliers; maximum spanning tree by inlier count (Prim)
        let root = members[0], best = -1;
        for (const i of members) { const s = an.adj[i].filter(e => pairOk(e.p)).reduce((a, e) => a + e.inl, 0); if (s > best) { best = s; root = i; } }
        R[root] = RfromPose(0, 0, 0);       // the viewer's [right up forward] basis is a reflection (det -1); keep every camera in that class
        const inTree = new Set([root]);
        while (inTree.size < members.length) {
            let bestE = null;
            for (const i of inTree) for (const e of an.adj[i]) if (pairOk(e.p) && !inTree.has(e.j) && (!bestE || e.inl > bestE.inl)) bestE = { from: i, to: e.j, inl: e.inl, p: e.p };
            if (!bestE) break;
            const p = bestE.p, Rp = pairRotation(an, p, fn, lens);          // cam_pi -> cam_pj
            // world = R_i cam_i = R_j cam_j, cam_j = Rp cam_i  =>  R_i = R_j Rp
            if (bestE.from === p.i) R[p.j] = M.mul(R[p.i], M.T(Rp));          // known i, want j: R_j = R_i Rp^T
            else R[p.i] = M.mul(R[p.j], Rp);                                  // known j, want i
            inTree.add(bestE.to);
        }
        return { R, members, root };
    }

    // Cholesky solve of the (symmetric positive definite) system A x = b. A: Float64Array n*n (destroyed)
    function cholSolve(A, b, n) {
        for (let j = 0; j < n; j++) {
            let s = A[j * n + j];
            for (let k = 0; k < j; k++) s -= A[j * n + k] * A[j * n + k];
            if (s <= 1e-14) return null;
            const d = Math.sqrt(s); A[j * n + j] = d;
            for (let i = j + 1; i < n; i++) {
                let t = A[i * n + j];
                for (let k = 0; k < j; k++) t -= A[i * n + k] * A[j * n + k];
                A[i * n + j] = t / d;
            }
        }
        const y = new Float64Array(n);
        for (let i = 0; i < n; i++) { let t = b[i]; for (let k = 0; k < i; k++) t -= A[i * n + k] * y[k]; y[i] = t / A[i * n + i]; }
        const x = new Float64Array(n);
        for (let i = n - 1; i >= 0; i--) { let t = y[i]; for (let k = i + 1; k < n; k++) t -= A[k * n + i] * x[k]; x[i] = t / A[i * n + i]; }
        return x;
    }

    // Robust bundle adjustment of rotations (+ shared fn, + optional b). Observations come from verified pairs.
    function bundleAdjust(an, R0, active, fn0, lens0, opts) {
        opts = Object.assign({ optFocal: true, optB: false, iters: 40, huber: 2.0, prune: true }, opts || {});
        const idx = new Map(); active.forEach((i, k) => idx.set(i, k));        // image -> slot; slot 0 is the gauge anchor
        const R = R0.map(r => (r ? r.slice() : null));
        let fn = fn0, b = lens0.b || 0;
        const lens = { a: lens0.a || 0, b, c: lens0.c || 0 };
        // gather observations from pairs whose two images are both active
        let obs = [];
        an.pairs.forEach(p => {
            if (!idx.has(p.i) || !idx.has(p.j) || p.dead) return;
            for (let k = 0; k < p.inl; k++) obs.push({ p, i: p.i, j: p.j, xi: p.pts[4 * k], yi: p.pts[4 * k + 1], xj: p.pts[4 * k + 2], yj: p.pts[4 * k + 3], k });
        });
        const nImg = active.length - 1, nP = 3 * nImg + (opts.optFocal ? 1 : 0) + (opts.optB ? 1 : 0);
        const iFn = opts.optFocal ? 3 * nImg : -1, iB = opts.optB ? 3 * nImg + (opts.optFocal ? 1 : 0) : -1;
        const half = i => Math.max(an.size[i].w, an.size[i].h) / 2, rad = i => Math.min(an.size[i].w, an.size[i].h) / 2;
        const out = new Float64Array(4);
        function resid(o, Ri, Rj, fnv, bv, res) {
            const A = lens.a, C = lens.c;
            const ui = undistort(o.xi, o.yi, rad(o.i), A, bv, C), uj = undistort(o.xj, o.yj, rad(o.j), A, bv, C);
            const Fi = fnv * half(o.i), Fj = fnv * half(o.j);
            const di = M.mv(Ri, [ui[0], ui[1], Fi]), dj = M.mv(Rj, [uj[0], uj[1], Fj]);
            const cj = M.mtv(Rj, di), ci = M.mtv(Ri, dj);
            if (cj[2] <= 1e-6 || ci[2] <= 1e-6) { res[0] = res[1] = res[2] = res[3] = 1e3; return false; }
            res[0] = cj[0] / cj[2] * Fj - uj[0]; res[1] = cj[1] / cj[2] * Fj - uj[1];
            res[2] = ci[0] / ci[2] * Fi - ui[0]; res[3] = ci[1] / ci[2] * Fi - ui[1];
            return true;
        }
        const rho = (e, d) => (e <= d ? e * e : 2 * d * e - d * d);
        function totalCost(Rs, fnv, bv) {
            let c = 0;
            for (const o of obs) { resid(o, Rs[o.i], Rs[o.j], fnv, bv, out); const e = Math.hypot(out[0], out[1], out[2], out[3]) / 2; c += rho(e, opts.huber); }
            return c;
        }
        let cost = totalCost(R, fn, b), lambda = 1e-3, rounds = 0;
        const eps = 1e-6;
        for (let it = 0; it < opts.iters; it++) {
            const A = new Float64Array(nP * nP), g = new Float64Array(nP);
            const r0 = new Float64Array(4), r1 = new Float64Array(4), J = new Float64Array(4 * 8);
            for (const o of obs) {
                const si = idx.get(o.i), sj = idx.get(o.j);
                resid(o, R[o.i], R[o.j], fn, b, r0);
                const e = Math.hypot(r0[0], r0[1], r0[2], r0[3]) / 2, w = e <= opts.huber ? 1 : opts.huber / e;
                const cols = [];                                  // list of {param index, column}
                const addRot = (slot, img, which) => {
                    if (slot === 0) return;
                    for (let ax = 0; ax < 3; ax++) {
                        const wv = [0, 0, 0]; wv[ax] = eps;
                        const Rp = M.mul(M.exp(wv), R[img]);
                        if (which === 0) resid(o, Rp, R[o.j], fn, b, r1); else resid(o, R[o.i], Rp, fn, b, r1);
                        cols.push([3 * (slot - 1) + ax, [(r1[0] - r0[0]) / eps, (r1[1] - r0[1]) / eps, (r1[2] - r0[2]) / eps, (r1[3] - r0[3]) / eps]]);
                    }
                };
                addRot(si, o.i, 0); addRot(sj, o.j, 1);
                if (iFn >= 0) { resid(o, R[o.i], R[o.j], fn + 1e-6, b, r1); cols.push([iFn, [0, 1, 2, 3].map(t => (r1[t] - r0[t]) / 1e-6)]); }
                if (iB >= 0) { resid(o, R[o.i], R[o.j], fn, b + 1e-6, r1); cols.push([iB, [0, 1, 2, 3].map(t => (r1[t] - r0[t]) / 1e-6)]); }
                for (const [pa, ca] of cols) {
                    g[pa] += w * (ca[0] * r0[0] + ca[1] * r0[1] + ca[2] * r0[2] + ca[3] * r0[3]);
                    for (const [pb, cb] of cols) A[pa * nP + pb] += w * (ca[0] * cb[0] + ca[1] * cb[1] + ca[2] * cb[2] + ca[3] * cb[3]);
                }
            }
            let accepted = false;
            for (let tryN = 0; tryN < 8 && !accepted; tryN++) {
                const Ad = A.slice(); for (let q = 0; q < nP; q++) Ad[q * nP + q] = A[q * nP + q] * (1 + lambda) + 1e-9;
                const x = cholSolve(Ad, g.map(v => -v), nP);
                if (!x) { lambda *= 10; continue; }
                const Rn = R.map(r => (r ? r.slice() : null));
                active.forEach((img, slot) => { if (slot === 0) return; Rn[img] = M.mul(M.exp([x[3 * (slot - 1)], x[3 * (slot - 1) + 1], x[3 * (slot - 1) + 2]]), R[img]); });
                const fnN = iFn >= 0 ? fn + x[iFn] : fn, bN = iB >= 0 ? b + x[iB] : b;
                if (fnN < 0.3 || fnN > 5) { lambda *= 10; continue; }
                const cN = totalCost(Rn, fnN, bN);
                if (cN < cost) {
                    const rel = (cost - cN) / Math.max(cost, 1e-9);
                    active.forEach(img => { R[img] = Rn[img]; }); fn = fnN; b = bN; cost = cN; lambda = Math.max(lambda / 4, 1e-9); accepted = true;
                    if (rel < 1e-7) it = opts.iters;
                } else lambda *= 8;
            }
            if (!accepted) break;
        }
        // statistics and pruning of outliers
        const errs = obs.map(o => { resid(o, R[o.i], R[o.j], fn, b, out); return Math.hypot(out[0], out[1], out[2], out[3]) / 2; });
        const sorted = errs.slice().sort((x, y) => x - y), med = sorted.length ? sorted[Math.floor(sorted.length / 2)] : 0;
        return { R, fn, b, obs, errs, median: med, cost, obsCount: obs.length };
    }

    // Full alignment: initial tree, BA (rotations+f), prune false pairs/outliers, optional distortion, BA again.
    function align(an, fnInit, lensInit, opts, onProgress) {
        opts = Object.assign({ optimizeDistortion: true, fixFocal: false }, opts || {});
        const say = m => onProgress && onProgress(m);
        const lens = { a: 0, b: 0, c: 0 };
        an.pairs.forEach(p => { p.dead = false; });
        let fn = fnInit;
        if (an.fnH && (!fn || Math.abs(an.fnH / fn - 1) > 0.12)) fn = an.fnH;          // lens guess is far off: use the homographies
        let init = initialRotations(an, fn, lens, () => true);
        if (init.members.length < 2) return { ok: false, reason: 'Not enough overlapping image pairs were found.', placed: [], R: init.R, fn };
        let active = init.members.slice();
        // anchor = root first
        active.sort((x, y) => (x === init.root ? -1 : y === init.root ? 1 : x - y));
        say('Optimizing camera rotations...');
        let r = { R: init.R, fn };
        for (const hub of [30, 10, 4]) r = bundleAdjust(an, r.R, active, r.fn, lens, { optFocal: !opts.fixFocal, huber: hub });   // graduated robust loss
        // remove false pairs (median residual high) and gross outliers, then re-run
        for (let round = 0; round < 3; round++) {
            const perPair = new Map();
            r.obs.forEach((o, k) => { const a = perPair.get(o.p) || []; a.push(r.errs[k]); perPair.set(o.p, a); });
            let removed = 0;
            perPair.forEach((a, p) => { if (median(a) > Math.max(6, 4 * r.median)) { p.dead = true; removed++; } });
            const thr = Math.max(4, 4 * r.median);
            // drop individual outlier observations by shrinking the pair data
            an.pairs.forEach(p => {
                if (p.dead) return;
                const list = perPair.get(p); if (!list) return;
                const keep = []; list.forEach((e, k) => { if (e <= thr) keep.push(k); });
                if (keep.length < list.length) {
                    const pts = new Float32Array(4 * keep.length), la = new Float32Array(keep.length), lb = new Float32Array(keep.length);
                    keep.forEach((k, m) => { for (let t = 0; t < 4; t++) pts[4 * m + t] = p.pts[4 * k + t]; la[m] = p.la[k]; lb[m] = p.lb[k]; });
                    p.pts = pts; p.la = la; p.lb = lb; p.inl = keep.length;
                    if (p.inl < 8) p.dead = true;
                }
            });
            // re-derive component & start from current solution
            const comps = components(an, p => !p.dead), sizes = new Array(comps.count).fill(0); comps.comp.forEach(c => sizes[c]++);
            let main = 0; for (let c = 1; c < comps.count; c++) if (sizes[c] > sizes[main]) main = c;
            const act2 = []; comps.comp.forEach((c, i) => { if (c === main) act2.push(i); });
            if (act2.length < 2) break;
            const start = r.R.map((x, i) => (act2.includes(i) ? x : null));
            const missing = act2.filter(i => !start[i]);
            let Rst = start;
            if (missing.length) Rst = initialRotations(an, r.fn, lens, p => !p.dead).R;
            act2.sort((x, y) => x - y);
            active = act2;
            r = bundleAdjust(an, Rst, active, r.fn, lens, { optFocal: !opts.fixFocal, huber: 2.5 });
            if (!removed) break;
        }
        // second chance: pairs killed while the solution was still rough are re-tested one by one against the converged one
        {
            let back = 0;
            const cand = [];
            an.pairs.forEach(p => { if (p.dead && p.inl >= 8 && active.includes(p.i) && active.includes(p.j)) cand.push(p); });
            cand.forEach(p => {
                p.dead = false;
                const rr = bundleAdjust(an, r.R, active, r.fn, lens, { optFocal: false, huber: 2.5, iters: 0 });
                const a = []; rr.obs.forEach((o, k) => { if (o.p === p) a.push(rr.errs[k]); });
                if (a.length && median(a) <= Math.max(3, 3 * r.median)) {
                    back++;
                    const thr = Math.max(4, 4 * r.median), keep = [];
                    a.forEach((e, k) => { if (e <= thr) keep.push(k); });
                    if (keep.length < a.length) {                       // trim gross outlier observations of this pair
                        const pts = new Float32Array(4 * keep.length), la = new Float32Array(keep.length), lb = new Float32Array(keep.length);
                        keep.forEach((k, m) => { for (let t = 0; t < 4; t++) pts[4 * m + t] = p.pts[4 * k + t]; la[m] = p.la[k]; lb[m] = p.lb[k]; });
                        p.pts = pts; p.la = la; p.lb = lb; p.inl = keep.length;
                    }
                } else p.dead = true;
            });
            if (back) r = bundleAdjust(an, r.R, active, r.fn, lens, { optFocal: !opts.fixFocal, huber: 2.5 });
        }
        let bUsed = 0;
        if (opts.optimizeDistortion && r.obsCount > 200) {
            say('Estimating lens distortion...');
            const r2 = bundleAdjust(an, r.R, active, r.fn, lens, { optFocal: !opts.fixFocal, optB: true, huber: 2.0 });
            if (r2.cost < 0.95 * r.cost && Math.abs(r2.b) < 0.2) { r = r2; bUsed = r2.b; }
        }
        lens.b = bUsed;
        // final pass for tight statistics
        const placed = new Array(an.N).fill(false); active.forEach(i => { placed[i] = true; });
        const perImg = active.map(i => ({ i, n: 0, sum: 0 }));
        const pm = new Map(perImg.map(x => [x.i, x]));
        r.obs.forEach((o, k) => { const e = r.errs[k]; [o.i, o.j].forEach(q => { const x = pm.get(q); x.n++; x.sum += e * e; }); });
        const rmsPerImage = {}; perImg.forEach(x => { rmsPerImage[x.i] = x.n ? Math.sqrt(x.sum / x.n) : 0; });
        const rms = Math.sqrt(r.errs.reduce((a, e) => a + e * e, 0) / Math.max(1, r.errs.length));
        return { ok: true, R: r.R, fn: r.fn, b: bUsed, placed, active, rms, rmsPerImage, obsCount: r.obsCount, usedPairs: Array.from(an.pairs.values()).filter(p => !p.dead && placed[p.i] && placed[p.j]).length };
    }

    // ------------------------------------------------------------------ leveling (Szeliski 5.1 "up vector selection")
    function level(R, placed, keepIndex, keepYawDeg) {
        const idx = []; R.forEach((r, i) => { if (r && placed[i]) idx.push(i); });
        const S = [[0, 0, 0], [0, 0, 0], [0, 0, 0]];
        let upSum = [0, 0, 0];
        for (const i of idx) {
            const rt = M.col(R[i], 0), u = M.col(R[i], 1);
            for (let a = 0; a < 3; a++) for (let c = 0; c < 3; c++) S[a][c] += rt[a] * rt[c];
            upSum = [upSum[0] + u[0], upSum[1] + u[1], upSum[2] + u[2]];
        }
        const e = jacobiEigen(S, 3);
        let k = 0; for (let t = 1; t < 3; t++) if (e.values[t] < e.values[k]) k = t;
        let n = e.vectors(k);
        if (dot(n, upSum) < 0) n = [-n[0], -n[1], -n[2]];
        // rotation Q taking n to +y
        const ax = cross(n, [0, 1, 0]), s = nrm(ax), c = n[1];
        let Q;
        if (s < 1e-9) Q = c > 0 ? M.id() : M.exp([Math.PI, 0, 0]);
        else Q = M.exp([ax[0] / s * Math.atan2(s, c), ax[1] / s * Math.atan2(s, c), ax[2] / s * Math.atan2(s, c)]);
        let out = R.map(r => (r ? M.mul(Q, r) : null));
        if (keepIndex != null && out[keepIndex]) {
            const yaw = poseFromR(out[keepIndex]).yaw;
            const Y = M.rotY((keepYawDeg - yaw) * D2R);
            out = out.map(r => (r ? M.mul(Y, r) : null));
        }
        return out;
    }

    // ------------------------------------------------------------------ exposure (gain) compensation, Brown & Lowe
    function gains(an, placed, opts) {
        opts = Object.assign({ sigmaN: 10, sigmaG: 0.1, min: 0.5, max: 2 }, opts || {});
        const ids = []; placed.forEach((p, i) => { if (p) ids.push(i); });
        const pos = new Map(ids.map((i, k) => [i, k])), n = ids.length;
        const A = new Float64Array(n * n), b = new Float64Array(n), cnt = new Float64Array(n);
        an.pairs.forEach(p => {
            if (p.dead || !pos.has(p.i) || !pos.has(p.j) || p.inl < 5) return;
            let sa = 0, sb = 0; for (let k = 0; k < p.inl; k++) { sa += p.la[k]; sb += p.lb[k]; }
            const Ia = sa / p.inl, Ib = sb / p.inl, N = p.inl, a = pos.get(p.i), c = pos.get(p.j), s2 = opts.sigmaN * opts.sigmaN;
            A[a * n + a] += N * Ia * Ia / s2; A[c * n + c] += N * Ib * Ib / s2;
            A[a * n + c] -= N * Ia * Ib / s2; A[c * n + a] -= N * Ia * Ib / s2;
            cnt[a] += N; cnt[c] += N;
        });
        for (let k = 0; k < n; k++) { const w = cnt[k] / (opts.sigmaG * opts.sigmaG); A[k * n + k] += w; b[k] += w; }
        const x = cholSolve(A, b, n), out = new Array(an.N).fill(1);
        if (x) ids.forEach((i, k) => { out[i] = Math.max(opts.min, Math.min(opts.max, x[k])); });
        return out;
    }

    // ------------------------------------------------------------------ live helpers for the viewer
    // Fit of image i with rotation Ri against the images it matched, whose current rotations are Rall[j].
    function fitFor(an, i, Ri, Rall, fn, lens, tolDeg) {
        lens = lens || { a: 0, b: 0, c: 0 }; tolDeg = tolDeg || 2;
        let n = 0, within = 0, sum = 0; const per = [];
        for (const e of an.adj[i]) {
            const p = e.p; if (p.dead) continue;
            const j = e.j, Rj = Rall[j]; if (!Rj) continue;
            const mine = p.i === i;
            let cn = 0, cw = 0, cs = 0;
            for (let k = 0; k < p.inl; k++) {
                const xi = mine ? p.pts[4 * k] : p.pts[4 * k + 2], yi = mine ? p.pts[4 * k + 1] : p.pts[4 * k + 3];
                const xj = mine ? p.pts[4 * k + 2] : p.pts[4 * k], yj = mine ? p.pts[4 * k + 3] : p.pts[4 * k + 1];
                const a = M.mv(Ri, rayOf(an, i, xi, yi, fn, lens)), bq = M.mv(Rj, rayOf(an, j, xj, yj, fn, lens));
                const ang = Math.acos(Math.max(-1, Math.min(1, dot(a, bq)))) * R2D;
                cn++; cs += ang; if (ang < tolDeg) cw++;
            }
            n += cn; within += cw; sum += cs; per.push({ j, n: cn, within: cw, meanDeg: cn ? cs / cn : 0 });
        }
        return { n, within, frac: n ? within / n : 0, meanDeg: n ? sum / n : 0, per };
    }

    // Place image i using its correspondences with the other (currently placed) images: robust Procrustes, f fixed.
    function snap(an, i, Rall, fn, lens, onlyPlaced) {
        lens = lens || { a: 0, b: 0, c: 0 };
        const A = [], B = [];
        for (const e of an.adj[i]) {
            const p = e.p; if (p.dead) continue;
            const j = e.j, Rj = Rall[j]; if (!Rj || (onlyPlaced && !onlyPlaced[j])) continue;
            const mine = p.i === i;
            for (let k = 0; k < p.inl; k++) {
                const xi = mine ? p.pts[4 * k] : p.pts[4 * k + 2], yi = mine ? p.pts[4 * k + 1] : p.pts[4 * k + 3];
                const xj = mine ? p.pts[4 * k + 2] : p.pts[4 * k], yj = mine ? p.pts[4 * k + 3] : p.pts[4 * k + 1];
                A.push(rayOf(an, i, xi, yi, fn, lens)); B.push(M.mv(Rj, rayOf(an, j, xj, yj, fn, lens)));
            }
        }
        if (A.length < 8) return null;
        // the viewer basis R_v = P Q with P = swap(x,z) (R_v at yaw=pitch=roll=0) and Q a proper rotation: solve for Q, return R_v
        const P = RfromPose(0, 0, 0), Bp = B.map(b => M.mv(P, b));
        let W = null, Q = hornRotation(A, Bp, null);
        for (let it = 0; it < 8; it++) {
            const e = A.map((a, k) => Math.acos(Math.max(-1, Math.min(1, dot(M.mv(Q, a), Bp[k])))) * R2D);
            const s = Math.max(0.15, 2.5 * median(e));
            W = e.map(x => 1 / (1 + (x / s) * (x / s)));
            Q = hornRotation(A, Bp, W);
        }
        const e = A.map((a, k) => Math.acos(Math.max(-1, Math.min(1, dot(M.mv(Q, a), Bp[k])))) * R2D);
        return { R: M.mul(P, Q), used: A.length, rmsDeg: Math.sqrt(e.reduce((s, x) => s + x * x, 0) / e.length), medianDeg: median(e) };
    }

    function neighbours(an, i) { return an.adj[i].filter(e => !e.p.dead).map(e => ({ j: e.j, inliers: e.inl })); }

    const API = { M, jacobiEigen, hornRotation, RfromPose, poseFromR, undistort, focalsFromHomography, loadFeatures, analyze, align, level, gains, fitFor, snap, neighbours, neighbors: neighbours, initialRotations, bundleAdjust, buildAdj, pairRotation };
    return API;
    }
    // The factory source is kept so the viewer can run the whole engine inside a Web Worker (blob), which also works from file://
    const root = outer, API = factory(root);
    API.factorySource = factory.toString();
    if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PanoAlign = API;
})(typeof window !== 'undefined' ? window : globalThis);
