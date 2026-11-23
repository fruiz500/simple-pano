/* pano_features.js: the feature matching Simple Pano needs, in plain JavaScript (no OpenCV download).
 *
 *   detect(gray, w, h, opts)   ORB features: FAST-9 corners on an 8-level image pyramid, ranked by the Harris response,
 *                              oriented by the intensity centroid, described by the 256 learned point pairs of rBRIEF.
 *   knn2(dA, nA, dB, nB, ratio) brute-force Hamming matching with Lowe's ratio test.
 *   homography(pa, pb, n, ...)  homography by RANSAC (4-point samples), refined by least squares on the inliers.
 *
 * It follows ORB as published (Rublee, Rabaud, Konolige, Bradski, "ORB: an efficient alternative to SIFT or SURF", ICCV 2011)
 * and as implemented in OpenCV, with the same parameters Simple Pano used with OpenCV.js.
 *
 * Copyright (C) 2026 Francisco Ruiz. SPDX-License-Identifier: GPL-3.0-or-later.
 * The rBRIEF point-pair table (PAIRS) comes from OpenCV's orb.cpp (BSD license, Willow Garage) by way of jsfeat
 * (MIT license, Copyright (c) 2012 Eugene Zatepyakin); both licenses allow its use here.
 */
(function (outer) {
'use strict';
function factory(root) {
    const PAIRS = new Int8Array([
        8, -3, 9, 5, 4, 2, 7, -12, -11, 9, -8, 2, 7, -12, 12, -13,
        2, -13, 2, 12, 1, -7, 1, 6, -2, -10, -2, -4, -13, -13, -11, -8,
        -13, -3, -12, -9, 10, 4, 11, 9, -13, -8, -8, -9, -11, 7, -9, 12,
        7, 7, 12, 6, -4, -5, -3, 0, -13, 2, -12, -3, -9, 0, -7, 5,
        12, -6, 12, -1, -3, 6, -2, 12, -6, -13, -4, -8, 11, -13, 12, -8,
        4, 7, 5, 1, 5, -3, 10, -3, 3, -7, 6, 12, -8, -7, -6, -2,
        -2, 11, -1, -10, -13, 12, -8, 10, -7, 3, -5, -3, -4, 2, -3, 7,
        -10, -12, -6, 11, 5, -12, 6, -7, 5, -6, 7, -1, 1, 0, 4, -5,
        9, 11, 11, -13, 4, 7, 4, 12, 2, -1, 4, 4, -4, -12, -2, 7,
        -8, -5, -7, -10, 4, 11, 9, 12, 0, -8, 1, -13, -13, -2, -8, 2,
        -3, -2, -2, 3, -6, 9, -4, -9, 8, 12, 10, 7, 0, 9, 1, 3,
        7, -5, 11, -10, -13, -6, -11, 0, 10, 7, 12, 1, -6, -3, -6, 12,
        10, -9, 12, -4, -13, 8, -8, -12, -13, 0, -8, -4, 3, 3, 7, 8,
        5, 7, 10, -7, -1, 7, 1, -12, 3, -10, 5, 6, 2, -4, 3, -10,
        -13, 0, -13, 5, -13, -7, -12, 12, -13, 3, -11, 8, -7, 12, -4, 7,
        6, -10, 12, 8, -9, -1, -7, -6, -2, -5, 0, 12, -12, 5, -7, 5,
        3, -10, 8, -13, -7, -7, -4, 5, -3, -2, -1, -7, 2, 9, 5, -11,
        -11, -13, -5, -13, -1, 6, 0, -1, 5, -3, 5, 2, -4, -13, -4, 12,
        -9, -6, -9, 6, -12, -10, -8, -4, 10, 2, 12, -3, 7, 12, 12, 12,
        -7, -13, -6, 5, -4, 9, -3, 4, 7, -1, 12, 2, -7, 6, -5, 1,
        -13, 11, -12, 5, -3, 7, -2, -6, 7, -8, 12, -7, -13, -7, -11, -12,
        1, -3, 12, 12, 2, -6, 3, 0, -4, 3, -2, -13, -1, -13, 1, 9,
        7, 1, 8, -6, 1, -1, 3, 12, 9, 1, 12, 6, -1, -9, -1, 3,
        -13, -13, -10, 5, 7, 7, 10, 12, 12, -5, 12, 9, 6, 3, 7, 11,
        5, -13, 6, 10, 2, -12, 2, 3, 3, 8, 4, -6, 2, 6, 12, -13,
        9, -12, 10, 3, -8, 4, -7, 9, -11, 12, -4, -6, 1, 12, 2, -8,
        6, -9, 7, -4, 2, 3, 3, -2, 6, 3, 11, 0, 3, -3, 8, -8,
        7, 8, 9, 3, -11, -5, -6, -4, -10, 11, -5, 10, -5, -8, -3, 12,
        -10, 5, -9, 0, 8, -1, 12, -6, 4, -6, 6, -11, -10, 12, -8, 7,
        4, -2, 6, 7, -2, 0, -2, 12, -5, -8, -5, 2, 7, -6, 10, 12,
        -9, -13, -8, -8, -5, -13, -5, -2, 8, -8, 9, -13, -9, -11, -9, 0,
        1, -8, 1, -2, 7, -4, 9, 1, -2, 1, -1, -4, 11, -6, 12, -11,
        -12, -9, -6, 4, 3, 7, 7, 12, 5, 5, 10, 8, 0, -4, 2, 8,
        -9, 12, -5, -13, 0, 7, 2, 12, -1, 2, 1, 7, 5, 11, 7, -9,
        3, 5, 6, -8, -13, -4, -8, 9, -5, 9, -3, -3, -4, -7, -3, -12,
        6, 5, 8, 0, -7, 6, -6, 12, -13, 6, -5, -2, 1, -10, 3, 10,
        4, 1, 8, -4, -2, -2, 2, -13, 2, -12, 12, 12, -2, -13, 0, -6,
        4, 1, 9, 3, -6, -10, -3, -5, -3, -13, -1, 1, 7, 5, 12, -11,
        4, -2, 5, -7, -13, 9, -9, -5, 7, 1, 8, 6, 7, -8, 7, 6,
        -7, -4, -7, 1, -8, 11, -7, -8, -13, 6, -12, -8, 2, 4, 3, 9,
        10, -5, 12, 3, -6, -5, -6, 7, 8, -3, 9, -8, 2, -12, 2, 8,
        -11, -2, -10, 3, -12, -13, -7, -9, -11, 0, -10, -5, 5, -3, 11, 8,
        -2, -13, -1, 12, -1, -8, 0, 9, -13, -11, -12, -5, -10, -2, -10, 11,
        -3, 9, -2, -13, 2, -3, 3, 2, -9, -13, -4, 0, -4, 6, -3, -10,
        -4, 12, -2, -7, -6, -11, -4, 9, 6, -3, 6, 11, -13, 11, -5, 5,
        11, 11, 12, 6, 7, -5, 12, -2, -1, 12, 0, 7, -4, -8, -3, -2,
        -7, 1, -6, 7, -13, -12, -8, -13, -7, -2, -6, -8, -8, 5, -6, -9,
        -5, -1, -4, 5, -13, 7, -8, 10, 1, 5, 5, -13, 1, 0, 10, -13,
        9, 12, 10, -1, 5, -8, 10, -9, -1, 11, 1, -13, -9, -3, -6, 2,
        -1, -10, 1, 12, -13, 1, -8, -10, 8, -11, 10, -6, 2, -13, 3, -6,
        7, -13, 12, -9, -10, -10, -5, -7, -10, -8, -8, -13, 4, -6, 8, 5,
        3, 12, 8, -13, -4, 2, -3, -3, 5, -13, 10, -12, 4, -13, 5, -1,
        -9, 9, -4, 3, 0, 3, 3, -9, -12, 1, -6, 1, 3, 2, 4, -8,
        -10, -10, -10, 9, 8, -13, 12, 12, -8, -12, -6, -5, 2, 2, 3, 7,
        10, 6, 11, -8, 6, 8, 8, -12, -7, 10, -6, 5, -3, -9, -3, 9,
        -1, -13, -1, 5, -3, -7, -3, 4, -8, -2, -8, 3, 4, 2, 12, 12,
        2, -5, 3, 11, 6, -9, 11, -13, 3, -1, 7, 12, 11, -1, 12, 4,
        -3, 0, -3, 6, 4, -11, 4, 12, 2, -4, 2, 1, -10, -6, -8, 1,
        -13, 7, -11, 1, -13, 12, -11, -13, 6, 0, 11, -13, 0, -1, 1, 4,
        -13, 3, -9, -2, -9, 8, -6, -3, -13, -6, -8, -2, 5, -9, 8, 10,
        2, 7, 3, -9, -1, -6, -1, -1, 9, 5, 11, -2, 11, -3, 12, -8,
        3, 0, 3, 5, -1, 4, 0, 10, 3, -6, 4, 5, -13, 0, -10, 5,
        5, 8, 12, 11, 8, 9, 9, -6, 7, -4, 8, -12, -10, 4, -10, 9,
        7, 3, 12, 4, 9, -7, 10, -2, 7, 0, 12, -2, -1, -6, 0, -11
    ]);          // 256 pairs: x1, y1, x2, y2 (y down), within a 31 x 31 patch

    // ------------------------------------------------------------------ images
    // Bilinear resize of a gray image
    function resize(src, w, h, nw, nh) {
        const dst = new Uint8Array(nw * nh), sx = w / nw, sy = h / nh;
        for (let y = 0; y < nh; y++) {
            let fy = (y + 0.5) * sy - 0.5; if (fy < 0) fy = 0;
            const y0 = Math.min(h - 1, fy | 0), y1 = Math.min(h - 1, y0 + 1), ty = fy - y0;
            for (let x = 0; x < nw; x++) {
                let fx = (x + 0.5) * sx - 0.5; if (fx < 0) fx = 0;
                const x0 = Math.min(w - 1, fx | 0), x1 = Math.min(w - 1, x0 + 1), tx = fx - x0;
                const a = src[y0 * w + x0] + (src[y0 * w + x1] - src[y0 * w + x0]) * tx;
                const b = src[y1 * w + x0] + (src[y1 * w + x1] - src[y1 * w + x0]) * tx;
                dst[y * nw + x] = (a + (b - a) * ty + 0.5) | 0;
            }
        }
        return dst;
    }
    // Gaussian blur, 7 x 7, sigma 2 (what ORB smooths with before comparing pixel pairs)
    const GK = (() => { const k = []; let s = 0; for (let i = -3; i <= 3; i++) { const v = Math.exp(-i * i / 8); k.push(v); s += v; } return k.map(v => Math.round(v / s * 256)); })();     // sums to 256 (± rounding)
    function blur(src, w, h) {
        const t = new Uint16Array(w * h), dst = new Uint8Array(w * h), K = GK, ks = K.reduce((a, b) => a + b, 0);
        for (let y = 0; y < h; y++) {
            const r = y * w;
            for (let x = 0; x < w; x++) {
                let s = 0;
                if (x >= 3 && x < w - 3) { const q = r + x; s = K[0] * (src[q - 3] + src[q + 3]) + K[1] * (src[q - 2] + src[q + 2]) + K[2] * (src[q - 1] + src[q + 1]) + K[3] * src[q]; }
                else for (let i = -3; i <= 3; i++) { let xx = x + i; xx = xx < 0 ? -xx : xx >= w ? 2 * w - 2 - xx : xx; s += K[i + 3] * src[r + xx]; }
                t[r + x] = (s * 64 / ks + 0.5) | 0;
            }
        }
        for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
            let s = 0;
            if (y >= 3 && y < h - 3) { const q = y * w + x; s = K[0] * (t[q - 3 * w] + t[q + 3 * w]) + K[1] * (t[q - 2 * w] + t[q + 2 * w]) + K[2] * (t[q - w] + t[q + w]) + K[3] * t[q]; }
            else for (let i = -3; i <= 3; i++) { let yy = y + i; yy = yy < 0 ? -yy : yy >= h ? 2 * h - 2 - yy : yy; s += K[i + 3] * t[yy * w + x]; }
            dst[y * w + x] = (s / (64 * ks) + 0.5) | 0;
        }
        return dst;
    }

    // ------------------------------------------------------------------ FAST-9 corners
    const CIRC = [[0, -3], [1, -3], [2, -2], [3, -1], [3, 0], [3, 1], [2, 2], [1, 3], [0, 3], [-1, 3], [-2, 2], [-3, 1], [-3, 0], [-3, -1], [-2, -2], [-1, -3]];
    // Corners: every pixel with 9 contiguous circle pixels all brighter than center + t, or all darker than center - t.
    // The score is the largest t for which it would still be a corner (as OpenCV's), and 3 x 3 non-maximum suppression is applied.
    // 9 or more contiguous set bits in a 16-bit ring
    function arc9(m) { if (!m) return false; let r = m | (m << 16); r &= r >>> 1; r &= r >>> 2; r &= r >>> 4; r &= r >>> 1; return r !== 0; }
    function fast(img, w, h, t, border) {
        const off = CIRC.map(([dx, dy]) => dy * w + dx), score = new Float32Array(w * h), cand = [];
        const d = new Int16Array(32);
        for (let y = border; y < h - border; y++) for (let x = border; x < w - border; x++) {
            const p = y * w + x, c = img[p], hi = c + t, lo = c - t;
            // a 9-arc covers at least two of the four compass pixels
            const a0 = img[p + off[0]], a4 = img[p + off[4]], a8 = img[p + off[8]], a12 = img[p + off[12]];
            if (((a0 > hi) + (a4 > hi) + (a8 > hi) + (a12 > hi)) < 2 && ((a0 < lo) + (a4 < lo) + (a8 < lo) + (a12 < lo)) < 2) continue;
            let mb = 0, md = 0;
            for (let k = 0; k < 16; k++) { const v = img[p + off[k]]; d[k] = d[k + 16] = v - c; if (v > hi) mb |= 1 << k; else if (v < lo) md |= 1 << k; }
            if (!arc9(mb) && !arc9(md)) continue;
            let best = 0;
            for (let s = 0; s < 16; s++) {
                let mn = 255, mx = -255;
                for (let k = s; k < s + 9; k++) { const v = d[k]; if (v < mn) mn = v; if (v > mx) mx = v; }
                if (mn > best) best = mn; if (-mx > best) best = -mx;
            }
            if (best > t) { score[p] = best; cand.push(p); }
        }
        const out = [];
        for (const p of cand) {
            const s = score[p];
            if (s >= score[p - 1] && s > score[p + 1] && s >= score[p - w - 1] && s >= score[p - w] && s >= score[p - w + 1] && s > score[p + w - 1] && s > score[p + w] && s > score[p + w + 1])
                out.push(p);
        }
        return out;
    }
    // Harris corner response on a 7 x 7 block (Sobel derivatives), k = 0.04
    function harris(img, w, p) {
        let a = 0, b = 0, c = 0;
        for (let dy = -3; dy <= 3; dy++) for (let dx = -3; dx <= 3; dx++) {
            const q = p + dy * w + dx;
            const ix = (img[q - w + 1] + 2 * img[q + 1] + img[q + w + 1]) - (img[q - w - 1] + 2 * img[q - 1] + img[q + w - 1]);
            const iy = (img[q + w - 1] + 2 * img[q + w] + img[q + w + 1]) - (img[q - w - 1] + 2 * img[q - w] + img[q - w + 1]);
            a += ix * ix; b += iy * iy; c += ix * iy;
        }
        const sc = 1 / (4 * 7 * 255); a *= sc * sc; b *= sc * sc; c *= sc * sc;      // the scale OpenCV uses
        return a * b - c * c - 0.04 * (a + b) * (a + b);
    }
    // Orientation: angle of the intensity centroid in a disc of radius 15
    const R = 15, UMAX = (() => {
        const u = new Int32Array(R + 2), vmax = Math.floor(R * Math.SQRT1_2 + 1), vmin = Math.ceil(R * Math.SQRT1_2);
        for (let v = 0; v <= vmax; v++) u[v] = Math.round(Math.sqrt(R * R - v * v));
        for (let v = R, v0 = 0; v >= vmin; --v) { while (u[v0] === u[v0 + 1]) ++v0; u[v] = v0; ++v0; }
        return u;
    })();
    function angle(img, w, p) {
        let m01 = 0, m10 = 0;
        for (let u = -R; u <= R; u++) m10 += u * img[p + u];
        for (let v = 1; v <= R; v++) {
            let vs = 0; const d = UMAX[v];
            for (let u = -d; u <= d; u++) { const a = img[p + u + v * w], b = img[p + u - v * w]; vs += a - b; m10 += u * (a + b); }
            m01 += v * vs;
        }
        return Math.atan2(m01, m10);
    }
    // rBRIEF: 256 comparisons of the smoothed image at the point pairs, turned by the keypoint's angle. Writes 8 words at d[o].
    function describe(img, w, h, x, y, ang, d, o) {
        const cs = Math.cos(ang), sn = Math.sin(ang);
        const at = (px, py) => {
            let xx = x + Math.round(px * cs - py * sn), yy = y + Math.round(px * sn + py * cs);
            xx = xx < 0 ? 0 : xx >= w ? w - 1 : xx; yy = yy < 0 ? 0 : yy >= h ? h - 1 : yy;
            return img[yy * w + xx];
        };
        for (let wd = 0; wd < 8; wd++) {
            let v = 0;
            for (let b = 0; b < 32; b++) {
                const q = (wd * 32 + b) * 4;
                if (at(PAIRS[q], PAIRS[q + 1]) < at(PAIRS[q + 2], PAIRS[q + 3])) v |= 1 << b;
            }
            d[o + wd] = v;
        }
    }

    // ------------------------------------------------------------------ ORB
    // gray: Uint8Array w*h. opts: nFeatures (2000), nLevels (8), scale (1.2), fastThreshold (10), counts: other totals to select too
    // Returns { n, xy: Float32Array (x, y in pixels of the input, y down), desc: Uint32Array (8 words each), resp, sets: { total: index list } }
    // The keypoints of a smaller total are a subset of the larger one (the best of each level), so one detection serves both.
    function detect(gray, w, h, opts) {
        opts = Object.assign({ nFeatures: 2000, nLevels: 8, scale: 1.2, fastThreshold: 10, counts: [] }, opts || {});
        const L = opts.nLevels, f = 1 / opts.scale, border = 19;
        const levels = [];
        let img = gray, lw = w, lh = h;
        for (let l = 0; l < L; l++) {
            if (l > 0) {
                const s = Math.pow(opts.scale, l), nw = Math.round(w / s), nh = Math.round(h / s);
                if (nw < 2 * border + 8 || nh < 2 * border + 8) break;
                img = resize(gray, w, h, nw, nh); lw = nw; lh = nh;
            }
            const pts = fast(img, lw, lh, opts.fastThreshold, border);
            const kp = pts.map(p => ({ p, r: harris(img, lw, p) })).sort((a, b) => b.r - a.r);
            levels.push({ img, w: lw, h: lh, s: Math.pow(opts.scale, l), kp });
        }
        // how many features each level gets: in proportion to its area, as in OpenCV
        const share = total => {
            const nL = levels.length, k = total * (1 - f) / (1 - Math.pow(f, nL)), out = [];
            let sum = 0;
            for (let l = 0; l < nL - 1; l++) { const c = Math.round(k * Math.pow(f, l)); out.push(c); sum += c; }
            out.push(Math.max(total - sum, 0));
            return out;
        };
        const main = share(opts.nFeatures);
        const keep = levels.map((lv, l) => lv.kp.slice(0, main[l]));
        const n = keep.reduce((s, a) => s + a.length, 0);
        const xy = new Float32Array(2 * n), desc = new Uint32Array(8 * n), resp = new Float32Array(n), lev = new Uint8Array(n), rank = new Int32Array(n);
        let k = 0;
        levels.forEach((lv, l) => {
            const sm = blur(lv.img, lv.w, lv.h);
            keep[l].forEach((q, r) => {
                const x = q.p % lv.w, y = (q.p / lv.w) | 0;
                describe(sm, lv.w, lv.h, x, y, angle(lv.img, lv.w, q.p), desc, 8 * k);
                xy[2 * k] = x * lv.s; xy[2 * k + 1] = y * lv.s; resp[k] = q.r; lev[k] = l; rank[k] = r; k++;
            });
        });
        const sets = {};
        for (const tot of opts.counts) {
            const sh = share(tot), idx = [];
            for (let i = 0; i < n; i++) if (rank[i] < sh[lev[i]]) idx.push(i);
            sets[tot] = idx;
        }
        return { n, xy, desc, resp, sets };
    }
    // The descriptors of a subset (an index list from detect's sets)
    function subset(desc, idx) {
        const o = new Uint32Array(8 * idx.length);
        idx.forEach((i, k) => o.set(desc.subarray(8 * i, 8 * i + 8), 8 * k));
        return o;
    }

    // ------------------------------------------------------------------ matching
    const pc = v => { v = v - ((v >>> 1) & 0x55555555); v = (v & 0x33333333) + ((v >>> 2) & 0x33333333); return (((v + (v >>> 4)) & 0x0F0F0F0F) * 0x01010101) >>> 24; };
    // For each descriptor of A, its two nearest in B (Hamming distance); kept when best < ratio * second. Returns flat [iA, iB, ...]
    function knn2(dA, nA, dB, nB, ratio) {
        const out = [];
        if (nB < 2) return out;
        for (let i = 0; i < nA; i++) {
            const o = 8 * i, a0 = dA[o], a1 = dA[o + 1], a2 = dA[o + 2], a3 = dA[o + 3], a4 = dA[o + 4], a5 = dA[o + 5], a6 = dA[o + 6], a7 = dA[o + 7];
            let b1 = 1e9, b2 = 1e9, bi = -1;
            for (let j = 0, q = 0; j < nB; j++, q += 8) {
                let d = pc(a0 ^ dB[q]) + pc(a1 ^ dB[q + 1]) + pc(a2 ^ dB[q + 2]) + pc(a3 ^ dB[q + 3]);
                if (d >= b2) continue;                         // already worse than the second best: skip the rest
                d += pc(a4 ^ dB[q + 4]) + pc(a5 ^ dB[q + 5]) + pc(a6 ^ dB[q + 6]) + pc(a7 ^ dB[q + 7]);
                if (d < b1) { b2 = b1; b1 = d; bi = j; } else if (d < b2) b2 = d;
            }
            if (bi >= 0 && b1 < ratio * b2) out.push(i, bi);
        }
        return out;
    }

    // ------------------------------------------------------------------ homography
    // Solve the 8 x 8 system for h (h33 = 1) from point correspondences (normalized coordinates), least squares when more than 4
    function solveH(sx, sy, dx, dy, idx) {
        const A = new Float64Array(64), b = new Float64Array(8);
        for (const i of idx) {
            const x = sx[i], y = sy[i], u = dx[i], v = dy[i];
            const r1 = [x, y, 1, 0, 0, 0, -u * x, -u * y], r2 = [0, 0, 0, x, y, 1, -v * x, -v * y];
            for (let p = 0; p < 8; p++) {
                for (let q = 0; q < 8; q++) A[p * 8 + q] += r1[p] * r1[q] + r2[p] * r2[q];
                b[p] += r1[p] * u + r2[p] * v;
            }
        }
        for (let c = 0; c < 8; c++) {                          // Gaussian elimination with partial pivoting
            let m = c; for (let r = c + 1; r < 8; r++) if (Math.abs(A[r * 8 + c]) > Math.abs(A[m * 8 + c])) m = r;
            if (Math.abs(A[m * 8 + c]) < 1e-12) return null;
            if (m !== c) { for (let q = 0; q < 8; q++) { const t = A[c * 8 + q]; A[c * 8 + q] = A[m * 8 + q]; A[m * 8 + q] = t; } const t = b[c]; b[c] = b[m]; b[m] = t; }
            for (let r = c + 1; r < 8; r++) { const k = A[r * 8 + c] / A[c * 8 + c]; if (!k) continue; for (let q = c; q < 8; q++) A[r * 8 + q] -= k * A[c * 8 + q]; b[r] -= k * b[c]; }
        }
        const h = new Float64Array(9); h[8] = 1;
        for (let r = 7; r >= 0; r--) { let s = b[r]; for (let q = r + 1; q < 8; q++) s -= A[r * 8 + q] * h[q]; h[r] = s / A[r * 8 + r]; }
        return h;
    }
    // Is a 4-point sample usable: no three points (nearly) on a line, and the same turning order in both pictures
    function goodSample(sx, sy, dx, dy, s) {
        for (let a = 0; a < 4; a++) for (let b = a + 1; b < 4; b++) for (let c = b + 1; c < 4; c++) {
            const i = s[a], j = s[b], k = s[c];
            const c1 = (sx[j] - sx[i]) * (sy[k] - sy[i]) - (sy[j] - sy[i]) * (sx[k] - sx[i]);
            const c2 = (dx[j] - dx[i]) * (dy[k] - dy[i]) - (dy[j] - dy[i]) * (dx[k] - dx[i]);
            if (Math.abs(c1) < 1e-6 || Math.abs(c2) < 1e-6 || (c1 > 0) !== (c2 > 0)) return false;
        }
        return true;
    }
    // pa, pb: Float32Array/Float64Array of n points (x, y). Returns { H: 9 numbers, row major, mapping pa to pb, h33 = 1; mask: Uint8Array } or null.
    function homography(pa, pb, n, thresh, maxIters, confidence) {
        thresh = thresh || 3; maxIters = maxIters || 2000; confidence = confidence || 0.995;
        if (n < 4) return null;
        // normalize both point sets (Hartley): centroid at 0, mean distance sqrt(2)
        const norm = (p) => {
            let mx = 0, my = 0; for (let i = 0; i < n; i++) { mx += p[2 * i]; my += p[2 * i + 1]; } mx /= n; my /= n;
            let md = 0; for (let i = 0; i < n; i++) md += Math.hypot(p[2 * i] - mx, p[2 * i + 1] - my); md = md / n || 1;
            const s = Math.SQRT2 / md, X = new Float64Array(n), Y = new Float64Array(n);
            for (let i = 0; i < n; i++) { X[i] = (p[2 * i] - mx) * s; Y[i] = (p[2 * i + 1] - my) * s; }
            return { X, Y, mx, my, s };
        };
        const A = norm(pa), B = norm(pb);
        // back to pixel coordinates: H = Tb^-1 * Hn * Ta
        const denorm = hn => {
            const Ta = [A.s, 0, -A.s * A.mx, 0, A.s, -A.s * A.my, 0, 0, 1], Tbi = [1 / B.s, 0, B.mx, 0, 1 / B.s, B.my, 0, 0, 1];
            const m = (P, Q) => { const o = new Float64Array(9); for (let r = 0; r < 3; r++) for (let c = 0; c < 3; c++) o[r * 3 + c] = P[r * 3] * Q[c] + P[r * 3 + 1] * Q[3 + c] + P[r * 3 + 2] * Q[6 + c]; return o; };
            const H = m(Tbi, m(hn, Ta)); if (Math.abs(H[8]) < 1e-15) return null;
            for (let i = 0; i < 9; i++) H[i] /= H[8];
            return H;
        };
        const t2 = thresh * thresh;
        const count = (H, mask) => {
            let c = 0;
            for (let i = 0; i < n; i++) {
                const x = pa[2 * i], y = pa[2 * i + 1], w = H[6] * x + H[7] * y + H[8];
                if (Math.abs(w) < 1e-12) { if (mask) mask[i] = 0; continue; }
                const ex = (H[0] * x + H[1] * y + H[2]) / w - pb[2 * i], ey = (H[3] * x + H[4] * y + H[5]) / w - pb[2 * i + 1];
                const ok = ex * ex + ey * ey <= t2; if (mask) mask[i] = ok ? 1 : 0; if (ok) c++;
            }
            return c;
        };
        let seed = 0x9e3779b9 ^ n;                              // a fixed sequence, so a run gives the same answer every time
        const rnd = k => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return (seed >>> 0) % k; };
        let bestH = null, bestN = 0, iters = maxIters;
        const s = [0, 0, 0, 0];
        for (let it = 0; it < iters; it++) {
            let tries = 0, ok = false;
            while (!ok && tries++ < 100) {
                for (let a = 0; a < 4; a++) { let v; do { v = rnd(n); } while (s.slice(0, a).includes(v)); s[a] = v; }
                ok = goodSample(A.X, A.Y, B.X, B.Y, s);
            }
            if (!ok) break;
            const hn = solveH(A.X, A.Y, B.X, B.Y, s); if (!hn) continue;
            const H = denorm(hn); if (!H) continue;
            const c = count(H, null);
            if (c > bestN) {
                bestN = c; bestH = H;
                const e = 1 - c / n, den = Math.log(1 - Math.pow(1 - e, 4));
                if (den < 0) iters = Math.min(maxIters, Math.ceil(Math.log(1 - confidence) / den));
            }
        }
        if (!bestH || bestN < 4) return null;
        const mask = new Uint8Array(n); count(bestH, mask);
        // least squares on the inliers; kept if it does not lose any
        const inl = []; for (let i = 0; i < n; i++) if (mask[i]) inl.push(i);
        const hr = solveH(A.X, A.Y, B.X, B.Y, inl), Hr = hr && denorm(hr);
        if (Hr) { const m2 = new Uint8Array(n); if (count(Hr, m2) >= bestN) return { H: Array.from(Hr), mask: m2 }; }
        return { H: Array.from(bestH), mask };
    }

    return { detect, subset, knn2, homography, popcount: pc };
}
const root = outer, API = factory(root);
API.factorySource = factory.toString();          // so the engine can run in a Web Worker built from a blob (also from file://)
if (typeof module !== 'undefined' && module.exports) module.exports = API; else root.PanoFeatures = API;
})(typeof window !== 'undefined' ? window : globalThis);
