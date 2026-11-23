// Simple Stitch: smart seams and local fill (no AI). Loaded on first use; the work runs in a Web Worker.
//  seams():   decides which photo is used for every part of the panorama. Boundaries between photos are put where the
//             photos agree (graph cut on the color difference), so parallax ghosts and moving people are cut around
//             instead of being averaged. Returns soft masks per photo (narrow edge for detail, wide edge for color).
//  inpaint(): fills a painted area from the texture around it (multi-scale PatchMatch, like a content-aware fill).
(function (outer) {
    function factory(root) {
        // ---------------- Max-flow / min-cut (Boykov-Kolmogorov) ----------------
        const NONE = -1, TERMINAL = -2, ORPHAN = -3, INF_D = 1e9;
        function Graph(nMax, eMax) {
            this.n = 0; this.e = 0; this.flow = 0;
            this.first = new Int32Array(nMax); this.parent = new Int32Array(nMax); this.next = new Int32Array(nMax);
            this.ts = new Int32Array(nMax); this.dist = new Int32Array(nMax); this.sink = new Uint8Array(nMax); this.tr = new Float64Array(nMax);
            this.head = new Int32Array(2 * eMax); this.anext = new Int32Array(2 * eMax); this.rc = new Float64Array(2 * eMax);
        }
        Graph.prototype.addNode = function () { const i = this.n++; this.first[i] = -1; this.tr[i] = 0; return i; };
        Graph.prototype.addT = function (i, cs, ct) {      // capacities source->i and i->sink
            const d = this.tr[i];
            if (d > 0) cs += d; else ct -= d;
            this.flow += Math.min(cs, ct);
            this.tr[i] = cs - ct;
        };
        Graph.prototype.addEdge = function (i, j, c, rc) {
            const a = this.e; this.e += 2;
            this.head[a] = j; this.anext[a] = this.first[i]; this.first[i] = a; this.rc[a] = c;
            this.head[a + 1] = i; this.anext[a + 1] = this.first[j]; this.first[j] = a + 1; this.rc[a + 1] = rc;
        };
        Graph.prototype.maxflow = function () {
            const n = this.n, first = this.first, parent = this.parent, next = this.next, ts = this.ts, dist = this.dist,
                sink = this.sink, tr = this.tr, head = this.head, anext = this.anext, rc = this.rc;
            let qFirst = -1, qLast = -1, time = 0;
            const orphans = []; let oHead = 0;
            const setActive = i => { if (next[i] !== -1) return; if (qLast >= 0) next[qLast] = i; else qFirst = i; qLast = i; next[i] = i; };
            const nextActive = () => {
                for (; ;) {
                    const i = qFirst; if (i < 0) return -1;
                    if (next[i] === i) qFirst = qLast = -1; else qFirst = next[i];
                    next[i] = -1;
                    if (parent[i] !== NONE) return i;
                }
            };
            const orphan = i => { parent[i] = ORPHAN; orphans.push(i); };
            for (let i = 0; i < n; i++) {
                next[i] = -1; ts[i] = 0;
                if (tr[i] > 0) { sink[i] = 0; parent[i] = TERMINAL; setActive(i); dist[i] = 1; }
                else if (tr[i] < 0) { sink[i] = 1; parent[i] = TERMINAL; setActive(i); dist[i] = 1; }
                else parent[i] = NONE;
            }
            let cur = -1;
            for (; ;) {
                let i = cur;
                if (i >= 0) { next[i] = -1; if (parent[i] === NONE) i = -1; }
                if (i < 0) { i = nextActive(); if (i < 0) break; }
                let mid = -1;
                if (!sink[i]) {
                    for (let a = first[i]; a >= 0; a = anext[a]) if (rc[a] > 0) {
                        const j = head[a];
                        if (parent[j] === NONE) { sink[j] = 0; parent[j] = a ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; setActive(j); }
                        else if (sink[j]) { mid = a; break; }
                        else if (ts[j] <= ts[i] && dist[j] > dist[i]) { parent[j] = a ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; }
                    }
                } else {
                    for (let a = first[i]; a >= 0; a = anext[a]) if (rc[a ^ 1] > 0) {
                        const j = head[a];
                        if (parent[j] === NONE) { sink[j] = 1; parent[j] = a ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; setActive(j); }
                        else if (!sink[j]) { mid = a ^ 1; break; }
                        else if (ts[j] <= ts[i] && dist[j] > dist[i]) { parent[j] = a ^ 1; ts[j] = ts[i]; dist[j] = dist[i] + 1; }
                    }
                }
                time++;
                if (mid < 0) { cur = -1; continue; }
                next[i] = i; cur = i;                                   // keep growing from this node next time
                // ---- augment along source ... mid ... sink
                let cap = rc[mid], k, a;
                for (k = head[mid ^ 1]; (a = parent[k]) !== TERMINAL; k = head[a]) cap = Math.min(cap, rc[a ^ 1]);
                cap = Math.min(cap, tr[k]);
                for (k = head[mid]; (a = parent[k]) !== TERMINAL; k = head[a]) cap = Math.min(cap, rc[a]);
                cap = Math.min(cap, -tr[k]);
                rc[mid ^ 1] += cap; rc[mid] -= cap;
                for (k = head[mid ^ 1]; (a = parent[k]) !== TERMINAL; k = head[a]) { rc[a] += cap; rc[a ^ 1] -= cap; if (!(rc[a ^ 1] > 0)) orphan(k); }
                tr[k] -= cap; if (!(tr[k] > 0)) orphan(k);
                for (k = head[mid]; (a = parent[k]) !== TERMINAL; k = head[a]) { rc[a ^ 1] += cap; rc[a] -= cap; if (!(rc[a] > 0)) orphan(k); }
                tr[k] += cap; if (!(tr[k] < 0)) orphan(k);
                this.flow += cap;
                // ---- adopt orphans
                time++;
                while (oHead < orphans.length) {
                    const o = orphans[oHead++];
                    const sk = sink[o];
                    let best = NONE, dmin = INF_D;
                    for (let a0 = first[o]; a0 >= 0; a0 = anext[a0]) {
                        if (!(sk ? rc[a0] > 0 : rc[a0 ^ 1] > 0)) continue;
                        let j = head[a0];
                        if (sink[j] !== sk || parent[j] === NONE) continue;
                        let d = 0, aa;
                        for (; ;) {
                            if (ts[j] === time) { d += dist[j]; break; }
                            aa = parent[j]; d++;
                            if (aa === TERMINAL) { ts[j] = time; dist[j] = 1; break; }
                            if (aa === ORPHAN) { d = INF_D; break; }
                            j = head[aa];
                        }
                        if (d < INF_D) {
                            if (d < dmin) { best = a0; dmin = d; }
                            for (j = head[a0]; ts[j] !== time; j = head[parent[j]]) { ts[j] = time; dist[j] = d--; }
                        }
                    }
                    if (best !== NONE) { parent[o] = best; ts[o] = time; dist[o] = dmin + 1; }
                    else {
                        parent[o] = NONE;
                        for (let a0 = first[o]; a0 >= 0; a0 = anext[a0]) {
                            const j = head[a0], aa = parent[j];
                            if (sink[j] !== sk || aa === NONE) continue;
                            if (sk ? rc[a0] > 0 : rc[a0 ^ 1] > 0) setActive(j);
                            if (aa !== TERMINAL && aa !== ORPHAN && head[aa] === o) orphan(j);
                        }
                    }
                }
                orphans.length = 0; oHead = 0;
            }
            return this.flow;
        };
        // true = node ended on the sink side
        Graph.prototype.isSink = function (i) { return this.parent[i] !== NONE && this.sink[i] === 1; };

        // ---------------- Seams ----------------
        // imgs[k] = { x0, y0, w, h, rgba (Uint8, w*h*4: color + coverage code in alpha), prio }
        //   x0 in [0, W); the crop may run past the right edge and wrap. alpha 0 = not covered, 1 = covered but excluded
        //   (painted mask) or at the very edge, 2..255 = covered, (a-1)/254 = distance-to-edge weight.
        // opts: { lambda (center preference), narrow, wide (blur radii in px), excl (penalty) }
        function seams(W, H, imgs, opts, onProgress) {
            opts = Object.assign({ lambda: 0.3, narrow: 1.5, wide: 12, excl: 400, big: 1e7 }, opts || {});
            const N = imgs.length, cosRow = new Float64Array(H);
            for (let y = 0; y < H; y++) cosRow[y] = Math.max(0.05, Math.cos(((y + 0.5) / H - 0.5) * Math.PI));
            const own = imgs.map(g => { const m = new Uint8Array(g.w * g.h); for (let i = 0; i < m.length; i++) m[i] = g.rgba[i * 4 + 3] > 0 ? 1 : 0; return m; });
            const loc = (g, gx, gy) => {                    // index in crop, or -1
                if (gy < g.y0 || gy >= g.y0 + g.h) return -1;
                let lx = gx - g.x0; if (lx < 0) lx += W;
                return lx < g.w ? (gy - g.y0) * g.w + lx : -1;
            };
            // candidate pairs (bounding boxes overlap)
            const colsOverlap = (a, b) => {
                if (a.w >= W || b.w >= W) return true;
                for (const k of [-W, 0, W]) if (a.x0 + k < b.x0 + b.w && b.x0 < a.x0 + k + a.w) return true;
                return false;
            };
            const pairs = [];
            for (let i = 0; i < N; i++) for (let j = i + 1; j < N; j++) {
                const A = imgs[i], B = imgs[j];
                if (A.y0 >= B.y0 + B.h || B.y0 >= A.y0 + A.h || !colsOverlap(A, B)) continue;
                let n = 0;                                   // overlap size (for ordering)
                for (let y = Math.max(A.y0, B.y0); y < Math.min(A.y0 + A.h, B.y0 + B.h); y += 2)
                    for (let lx = 0; lx < A.w; lx += 2) {
                        const p = (y - A.y0) * A.w + lx; if (!own[i][p]) continue;
                        const q = loc(B, (A.x0 + lx) % W, y); if (q >= 0 && own[j][q]) n++;
                    }
                if (n) pairs.push([i, j, n]);
            }
            pairs.sort((a, b) => b[2] - a[2]);
            let maxCrop = 0; for (const g of imgs) maxCrop = Math.max(maxCrop, g.w * g.h);
            const node = new Int32Array(maxCrop).fill(-1);
            let graph = null, gCap = 0;
            const diff = (A, pa, B, pb) => (Math.abs(A.rgba[pa * 4] - B.rgba[pb * 4]) + Math.abs(A.rgba[pa * 4 + 1] - B.rgba[pb * 4 + 1]) + Math.abs(A.rgba[pa * 4 + 2] - B.rgba[pb * 4 + 2])) / 3;
            const fOf = (g, p) => { const a = g.rgba[p * 4 + 3]; return a > 1 ? (a - 1) / 254 : 0; };
            for (let pi = 0; pi < pairs.length; pi++) {
                const [i, j] = pairs[pi], A = imgs[i], B = imgs[j], oi = own[i], oj = own[j];
                if (onProgress && pi % 4 === 0) onProgress(`Finding seams: ${pi + 1}/${pairs.length} overlaps`, pi / pairs.length);
                const list = [], qlist = [];                 // overlap pixels: index in A's crop and in B's crop
                for (let p = 0; p < A.w * A.h; p++) {
                    if (!oi[p]) continue;
                    const gy = A.y0 + ((p / A.w) | 0), gx = (A.x0 + p % A.w) % W, q = loc(B, gx, gy);
                    if (q >= 0 && oj[q]) { node[p] = list.length; list.push(p); qlist.push(q); }
                }
                const n = list.length; if (!n) continue;
                if (!graph || gCap < n) { gCap = Math.max(n, gCap * 2); graph = new Graph(gCap, 2 * gCap + 8); }
                graph.n = 0; graph.e = 0; graph.flow = 0;
                for (let k = 0; k < n; k++) graph.addNode();
                const prA = A.prio || 1, prB = B.prio || 1;
                for (let k = 0; k < n; k++) {
                    const p = list[k], q = qlist[k], ly = (p / A.w) | 0, lx = p % A.w, gy = A.y0 + ly, gx = (A.x0 + lx) % W, cr = cosRow[gy];
                    const aA = A.rgba[p * 4 + 3], aB = B.rgba[q * 4 + 3];
                    const costA = (opts.lambda * (1 - fOf(A, p)) / prA + (aA === 1 ? opts.excl : 0)) * cr;
                    const costB = (opts.lambda * (1 - fOf(B, q)) / prB + (aB === 1 ? opts.excl : 0)) * cr;
                    graph.addT(k, costB, costA);              // source side = A, sink side = B
                    const dp = diff(A, p, B, q);
                    // 4 neighbors (x wraps around the panorama)
                    for (let s = 0; s < 4; s++) {
                        const nx = s === 0 ? (gx + 1) % W : s === 1 ? (gx + W - 1) % W : gx, ny = s === 2 ? gy + 1 : s === 3 ? gy - 1 : gy;
                        if (ny < 0 || ny >= H) continue;
                        const geo = s < 2 ? 1 : 0.5 * (cr + cosRow[ny]);
                        const pa = loc(A, nx, ny), pb = loc(B, nx, ny);
                        const inA = pa >= 0 && oi[pa], inB = pb >= 0 && oj[pb];
                        if (inA && inB) {
                            if (s === 0 || s === 2) graph.addEdge(k, node[pa], (dp + diff(A, pa, B, pb) + 0.5) * geo, (dp + diff(A, pa, B, pb) + 0.5) * geo);
                        } else if (inA || inB) {
                            const bothValid = pa >= 0 && pb >= 0 && A.rgba[pa * 4 + 3] > 0 && B.rgba[pb * 4 + 3] > 0;
                            const c = bothValid ? (dp + diff(A, pa, B, pb) + 0.5) * geo : opts.big;
                            if (inA) graph.addT(k, c, 0); else graph.addT(k, 0, c);
                        }
                    }
                }
                graph.maxflow();
                for (let k = 0; k < n; k++) {
                    if (graph.isSink(k)) oi[list[k]] = 0; else oj[qlist[k]] = 0;
                    node[list[k]] = -1;
                }
            }
            if (onProgress) onProgress('Smoothing the seams', 1);
            // soft masks: R = narrow edge (detail), G = wide edge (color); crops padded so the blur can spread
            return imgs.map((g, k) => soften(W, H, g, own[k], cosRow, opts));
        }
        function soften(W, H, g, m, cosRow, o) {
            const padY = Math.ceil(o.wide * 2) + 2, padX = Math.min(W, Math.ceil(o.wide * 2 * 4) + 2);
            const full = g.w + 2 * padX >= W;
            const x0 = full ? 0 : (g.x0 - padX + W) % W, w = full ? W : g.w + 2 * padX;
            const y0 = Math.max(0, g.y0 - padY), y1 = Math.min(H, g.y0 + g.h + padY), h = y1 - y0;
            const base = new Float32Array(w * h);
            for (let ly = 0; ly < g.h; ly++) for (let lx = 0; lx < g.w; lx++) {
                if (!m[ly * g.w + lx]) continue;
                let x = (g.x0 + lx) % W - x0; if (x < 0) x += W;
                if (x < w) base[(g.y0 + ly - y0) * w + x] = 1;
            }
            const out = new Uint8Array(w * h * 4);
            [o.narrow, o.wide].forEach((r, ch) => {
                let a = Float32Array.from(base);
                for (let pass = 0; pass < 3; pass++) {
                    a = boxH(a, w, h, y => Math.min(r * 4, r / cosRow[y0 + y]) / 1.7, full);
                    a = boxV(a, w, h, r / 1.7);
                }
                for (let i = 0; i < w * h; i++) out[i * 4 + ch] = Math.round(Math.min(1, a[i]) * 255);
            });
            for (let i = 0; i < w * h; i++) out[i * 4 + 3] = 255;
            return { x0, y0, w, h, data: out };
        }
        function boxH(a, w, h, rOf, wrap) {
            const b = new Float32Array(w * h), cs = new Float64Array(w + 1);
            for (let y = 0; y < h; y++) {
                const r = Math.max(0, Math.round(rOf(y))), row = y * w;
                if (r === 0) { for (let x = 0; x < w; x++) b[row + x] = a[row + x]; continue; }
                cs[0] = 0; for (let x = 0; x < w; x++) cs[x + 1] = cs[x] + a[row + x];
                const tot = cs[w];
                for (let x = 0; x < w; x++) {
                    let s, lo = x - r, hi = x + r + 1;
                    if (wrap && r * 2 + 1 < w) {
                        s = cs[Math.min(hi, w)] - cs[Math.max(lo, 0)];
                        if (lo < 0) s += tot - cs[w + lo];
                        if (hi > w) s += cs[hi - w];
                        b[row + x] = s / (2 * r + 1);
                    } else {
                        lo = Math.max(lo, 0); hi = Math.min(hi, w);
                        b[row + x] = (cs[hi] - cs[lo]) / (2 * r + 1);
                    }
                }
            }
            return b;
        }
        function boxV(a, w, h, rf) {
            const r = Math.max(0, Math.round(rf)), b = new Float32Array(w * h), cs = new Float64Array(h + 1);
            if (!r) return a;
            for (let x = 0; x < w; x++) {
                cs[0] = 0; for (let y = 0; y < h; y++) cs[y + 1] = cs[y] + a[y * w + x];
                for (let y = 0; y < h; y++) b[y * w + x] = (cs[Math.min(h, y + r + 1)] - cs[Math.max(0, y - r)]) / (2 * r + 1);
            }
            return b;
        }

        // ---------------- Local fill (multi-scale PatchMatch) ----------------
        // rgba: Uint8 w*h*4; hole: Uint8 w*h (1 = fill). Returns a new Uint8 rgba with the hole filled.
        function inpaint(rgba, w, h, hole, opts, onProgress) {
            opts = Object.assign({ r: 3, iters: 6, seed: 12345 }, opts || {});
            let seed = opts.seed >>> 0;
            const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
            const R = opts.r;
            // pyramid
            const levels = [{ w, h, img: Float32Array.from(rgba), hole: Uint8Array.from(hole) }];
            for (; ;) {
                const L = levels[levels.length - 1];
                let cnt = 0; for (let i = 0; i < L.hole.length; i++) cnt += L.hole[i];
                if (Math.min(L.w, L.h) < 64 || Math.sqrt(cnt) < 3 * R + 4) break;
                const w2 = L.w >> 1, h2 = L.h >> 1, img = new Float32Array(w2 * h2 * 4), ho = new Uint8Array(w2 * h2);
                for (let y = 0; y < h2; y++) for (let x = 0; x < w2; x++) {
                    let s = [0, 0, 0], n = 0, hh = 0;
                    for (let dy = 0; dy < 2; dy++) for (let dx = 0; dx < 2; dx++) {
                        const p = (2 * y + dy) * L.w + 2 * x + dx;
                        if (L.hole[p]) { hh = 1; continue; }
                        for (let c = 0; c < 3; c++) s[c] += L.img[p * 4 + c]; n++;
                    }
                    const q = y * w2 + x;
                    ho[q] = hh;
                    for (let c = 0; c < 3; c++) img[q * 4 + c] = n ? s[c] / n : 0;
                    img[q * 4 + 3] = 255;
                }
                levels.push({ w: w2, h: h2, img, hole: ho });
            }
            // coarsest: fill from the edge inwards, ring by ring, each pixel from the best matching known patch
            const C = levels[levels.length - 1];
            diffuse(C);
            peel(C, R, rnd);
            let nnf = null;
            for (let li = levels.length - 1; li >= 0; li--) {
                const L = levels[li], W = L.w, Hh = L.h;
                // target centers: pixels whose patch touches the hole; valid sources: patch fully known and inside
                const dil = dilate(L.hole, W, Hh, R), valid = erodeOk(L.hole, W, Hh, R);
                // copy only from around the hole (texture nearby fits best): its box grown by 1.5x its size
                let bx0 = W, by0 = Hh, bx1 = -1, by1 = -1;
                for (let i = 0; i < W * Hh; i++) if (L.hole[i]) { const x = i % W, y = (i / W) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
                const grow = Math.max(16, Math.round(1.5 * Math.max(bx1 - bx0, by1 - by0)));
                for (let y = 0; y < Hh; y++) for (let x = 0; x < W; x++) if (x < bx0 - grow || x > bx1 + grow || y < by0 - grow || y > by1 + grow) valid[y * W + x] = 0;
                const srcs = []; for (let i = 0; i < W * Hh; i++) if (valid[i]) srcs.push(i);
                if (!srcs.length) break;
                const tgt = []; for (let i = 0; i < W * Hh; i++) if (dil[i]) tgt.push(i);
                const map = new Int32Array(W * Hh).fill(-1);
                if (nnf && li < levels.length - 1) {          // upsample the previous field
                    const P = levels[li + 1];
                    for (const t of tgt) {
                        const x = t % W, y = (t / W) | 0, px = Math.min(P.w - 1, x >> 1), py = Math.min(P.h - 1, y >> 1);
                        const s = nnf[py * P.w + px];
                        if (s >= 0) {
                            const sx = Math.min(W - 1 - R, Math.max(R, 2 * (s % P.w) + (x & 1))), sy = Math.min(Hh - 1 - R, Math.max(R, 2 * ((s / P.w) | 0) + (y & 1)));
                            const c = sy * W + sx; if (valid[c]) map[t] = c;
                        }
                    }
                    vote(L, tgt, map, R);                    // rebuild the hole at this level from the upsampled field
                }
                for (const t of tgt) if (map[t] < 0) map[t] = srcs[(rnd() * srcs.length) | 0];
                const cost = new Float64Array(W * Hh);
                for (const t of tgt) cost[t] = dist(L, t, map[t], R, Infinity);
                const iters = li === 0 ? Math.max(2, opts.iters >> 1) : opts.iters;
                for (let it = 0; it < iters; it++) {
                    if (onProgress) onProgress(`Filling: level ${levels.length - li}/${levels.length}, pass ${it + 1}/${iters}`, (levels.length - li - 1 + it / iters) / levels.length);
                    const fwd = it % 2 === 0, d = fwd ? 1 : -1;
                    for (let k = 0; k < tgt.length; k++) {
                        const t = tgt[fwd ? k : tgt.length - 1 - k], x = t % W, y = (t / W) | 0;
                        // propagation
                        for (const [nx, ny] of [[x - d, y], [x, y - d]]) {
                            if (nx < 0 || ny < 0 || nx >= W || ny >= Hh) continue;
                            const nb = map[ny * W + nx]; if (nb < 0) continue;
                            const cx = nb % W + (x - nx), cy = ((nb / W) | 0) + (y - ny);
                            if (cx < 0 || cy < 0 || cx >= W || cy >= Hh) continue;
                            const c = cy * W + cx; if (!valid[c]) continue;
                            const dd = dist(L, t, c, R, cost[t]);
                            if (dd < cost[t]) { cost[t] = dd; map[t] = c; }
                        }
                        // random search
                        let rad = 2 * grow + Math.max(bx1 - bx0, by1 - by0);
                        const bx = map[t] % W, by = (map[t] / W) | 0;
                        while (rad >= 1) {
                            const sx = Math.round(bx + (rnd() * 2 - 1) * rad), sy = Math.round(by + (rnd() * 2 - 1) * rad);
                            if (sx >= 0 && sy >= 0 && sx < W && sy < Hh) {
                                const c = sy * W + sx;
                                if (valid[c]) { const dd = dist(L, t, c, R, cost[t]); if (dd < cost[t]) { cost[t] = dd; map[t] = c; } }
                            }
                            rad *= 0.5;
                        }
                    }
                    vote(L, tgt, map, R);
                    for (const t of tgt) cost[t] = dist(L, t, map[t], R, Infinity);
                }
                nnf = map;
            }
            const out = new Uint8Array(rgba.length), F = levels[0].img;
            for (let i = 0; i < w * h; i++) {
                if (hole[i]) { for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(F[i * 4 + c]))); out[i * 4 + 3] = 255; }
                else for (let c = 0; c < 4; c++) out[i * 4 + c] = rgba[i * 4 + c];
            }
            return out;
        }
        function peel(L, R, rnd) {
            const { w, h, img, hole } = L, known = Uint8Array.from(hole, v => v ? 0 : 1);
            const valid = erodeOk(hole, w, h, R);
            let srcs = []; for (let i = 0; i < w * h; i++) if (valid[i]) srcs.push(i);
            if (!srcs.length) return;
            for (let guard = 0; guard < w + h; guard++) {
                const ring = [];
                for (let i = 0; i < w * h; i++) {
                    if (known[i]) continue;
                    const x = i % w, y = (i / w) | 0;
                    if ((x > 0 && known[i - 1]) || (x < w - 1 && known[i + 1]) || (y > 0 && known[i - w]) || (y < h - 1 && known[i + w])) ring.push(i);
                }
                if (!ring.length) break;
                const fills = ring.map(t => {
                    const tx = t % w, ty = (t / w) | 0;
                    const pick = srcs.length > 1500 ? Array.from({ length: 1500 }, () => srcs[(rnd() * srcs.length) | 0]) : srcs;
                    let best = -1, bd = Infinity;
                    for (const s of pick) {
                        const sx = s % w, sy = (s / w) | 0; let d = 0, n = 0;
                        for (let dy = -R; dy <= R && d < bd * Math.max(n, 1); dy++) {
                            const yy = ty + dy; if (yy < 0 || yy >= h) continue;
                            for (let dx = -R; dx <= R; dx++) {
                                const xx = tx + dx; if (xx < 0 || xx >= w) continue;
                                const q = yy * w + xx; if (!known[q]) continue;
                                const a = q * 4, b = ((sy + dy) * w + sx + dx) * 4;
                                const e0 = img[a] - img[b], e1 = img[a + 1] - img[b + 1], e2 = img[a + 2] - img[b + 2];
                                d += e0 * e0 + e1 * e1 + e2 * e2; n++;
                            }
                        }
                        if (n && d / n < bd) { bd = d / n; best = s; }
                    }
                    return best;
                });
                ring.forEach((t, k) => { const s = fills[k]; if (s >= 0) for (let c = 0; c < 3; c++) img[t * 4 + c] = img[s * 4 + c]; known[t] = 1; });
            }
        }
        function diffuse(L) {
            const { w, h, img, hole } = L, known = Uint8Array.from(hole, v => v ? 0 : 1);
            let left = 0; for (let i = 0; i < w * h; i++) if (!known[i]) left++;
            if (left === w * h) return;
            while (left) {
                const add = [];
                for (let i = 0; i < w * h; i++) {
                    if (known[i]) continue;
                    const x = i % w, y = (i / w) | 0; let s = [0, 0, 0], n = 0;
                    for (const [dx, dy] of [[1, 0], [-1, 0], [0, 1], [0, -1]]) {
                        const nx = x + dx, ny = y + dy; if (nx < 0 || ny < 0 || nx >= w || ny >= h) continue;
                        const q = ny * w + nx; if (!known[q]) continue;
                        for (let c = 0; c < 3; c++) s[c] += img[q * 4 + c]; n++;
                    }
                    if (n) add.push([i, s.map(v => v / n)]);
                }
                if (!add.length) break;
                for (const [i, c] of add) { img[i * 4] = c[0]; img[i * 4 + 1] = c[1]; img[i * 4 + 2] = c[2]; known[i] = 1; left--; }
            }
        }
        function dilate(m, w, h, r) {
            const o = new Uint8Array(w * h);
            for (let i = 0; i < w * h; i++) if (m[i]) {
                const x = i % w, y = (i / w) | 0;
                for (let dy = -r; dy <= r; dy++) for (let dx = -r; dx <= r; dx++) {
                    const nx = x + dx, ny = y + dy; if (nx >= 0 && ny >= 0 && nx < w && ny < h) o[ny * w + nx] = 1;
                }
            }
            return o;
        }
        // centers whose whole patch lies inside the picture and outside the hole
        function erodeOk(m, w, h, r) {
            const d = dilate(m, w, h, r), o = new Uint8Array(w * h);
            for (let y = r; y < h - r; y++) for (let x = r; x < w - r; x++) o[y * w + x] = d[y * w + x] ? 0 : 1;
            return o;
        }
        function dist(L, t, s, r, stop) {
            const { w, h, img } = L, tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0;
            let d = 0, n = 0;
            for (let dy = -r; dy <= r; dy++) {
                const yy = ty + dy; if (yy < 0 || yy >= h) continue;
                for (let dx = -r; dx <= r; dx++) {
                    const xx = tx + dx; if (xx < 0 || xx >= w) continue;
                    const a = (yy * w + xx) * 4, b = ((sy + dy) * w + sx + dx) * 4;
                    const e0 = img[a] - img[b], e1 = img[a + 1] - img[b + 1], e2 = img[a + 2] - img[b + 2];
                    d += e0 * e0 + e1 * e1 + e2 * e2; n++;
                }
                if (d > stop * n) return Infinity;
            }
            return n ? d / n : Infinity;
        }
        function vote(L, tgt, map, r) {
            const { w, h, img, hole } = L, acc = new Float64Array(w * h * 4);
            for (const t of tgt) {
                const s = map[t]; if (s < 0) continue;
                const tx = t % w, ty = (t / w) | 0, sx = s % w, sy = (s / w) | 0;
                const wt = 1 / (1 + dist(L, t, s, r, Infinity) / 400);
                for (let dy = -r; dy <= r; dy++) {
                    const yy = ty + dy; if (yy < 0 || yy >= h) continue;
                    for (let dx = -r; dx <= r; dx++) {
                        const xx = tx + dx; if (xx < 0 || xx >= w) continue;
                        const p = yy * w + xx; if (!hole[p]) continue;
                        const b = ((sy + dy) * w + sx + dx) * 4;
                        acc[p * 4] += img[b] * wt; acc[p * 4 + 1] += img[b + 1] * wt; acc[p * 4 + 2] += img[b + 2] * wt; acc[p * 4 + 3] += wt;
                    }
                }
            }
            for (let p = 0; p < w * h; p++) if (hole[p] && acc[p * 4 + 3] > 0) for (let c = 0; c < 3; c++) img[p * 4 + c] = acc[p * 4 + c] / acc[p * 4 + 3];
        }
        // ---------------- Local fill (copying real texture, after Criminisi et al.) ----------------
        // Fills the hole by copying whole pieces of the real picture from around it, the best supported edge first, so the texture
        // stays sharp (the averaging fill above turns a big hole into a flat blur). rgba: Uint8 w*h*4; hole: Uint8 w*h (1 = fill).
        function exemplarCore(rgba, w, h, hole, opts, onProgress) {
            opts = Object.assign({ seed: 12345, cands: 3000 }, opts || {});
            let seed = opts.seed >>> 0;
            const rnd = () => { seed = (seed * 1664525 + 1013904223) >>> 0; return seed / 4294967296; };
            const N = w * h;
            let area = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1;
            for (let i = 0; i < N; i++) if (hole[i]) { area++; const x = i % w, y = (i / w) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
            if (!area) return Uint8Array.from(rgba);
            const R = opts.r || Math.max(4, Math.min(10, Math.round(Math.sqrt(area) / 20)));
            const COH = opts.coh == null ? 0.8 : opts.coh;                                    // a source that continues the piece already copied next to it is preferred: bigger unbroken pieces, fewer shards
            const D = Math.max(Math.max(bx1 - bx0, by1 - by0) + 1, 6 * R), LAM = opts.lam == null ? 1.5 : opts.lam;    // distance scale and strength of the preference for nearby sources
            const grow = Math.max(40, Math.round(1.5 * (Math.max(bx1 - bx0, by1 - by0) + 1)));
            const valid = erodeOk(hole, w, h, R), srcs = [];              // centers of patches that are all real picture, near the hole
            for (let y = Math.max(R, by0 - grow); y <= Math.min(h - 1 - R, by1 + grow); y++)
                for (let x = Math.max(R, bx0 - grow); x <= Math.min(w - 1 - R, bx1 + grow); x++) if (valid[y * w + x]) srcs.push(y * w + x);
            if (!srcs.length) return inpaint(rgba, w, h, hole, opts, onProgress);
            const out = Uint8Array.from(rgba), known = Uint8Array.from(hole, v => v ? 0 : 1), conf = new Float32Array(N), srcOf = new Int32Array(N).fill(-1);
            for (let i = 0; i < N; i++) conf[i] = known[i];
            const P = new Float32Array(N), inFront = new Uint8Array(N);
            let front = [];
            const gray = i => 0.299 * out[i * 4] + 0.587 * out[i * 4 + 1] + 0.114 * out[i * 4 + 2];
            const onFront = i => { const x = i % w, y = (i / w) | 0; return !known[i] && ((x > 0 && known[i - 1]) || (x < w - 1 && known[i + 1]) || (y > 0 && known[i - w]) || (y < h - 1 && known[i + w])); };
            // priority = confidence (how much of the patch is known) x data (how strongly an edge runs into the hole)
            function priority(i) {
                const x0 = i % w, y0 = (i / w) | 0, cx = Math.min(w - 1 - R, Math.max(R, x0)), cy = Math.min(h - 1 - R, Math.max(R, y0));
                let c = 0, gm = -1, gx = 0, gy = 0;
                for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
                    const q = (cy + dy) * w + cx + dx; c += conf[q];
                    if (!known[q]) continue;
                    const x = cx + dx, y = cy + dy;
                    if (x < 1 || y < 1 || x >= w - 1 || y >= h - 1 || !known[q - 1] || !known[q + 1] || !known[q - w] || !known[q + w]) continue;
                    const ax = (gray(q + 1) - gray(q - 1)) / 2, ay = (gray(q + w) - gray(q - w)) / 2, m = ax * ax + ay * ay;
                    if (m > gm) { gm = m; gx = ax; gy = ay; }
                }
                c /= (2 * R + 1) * (2 * R + 1);
                let nx = 0, ny = 0;                                              // direction into the hole, from the known/unknown mask
                for (let dy = -1; dy <= 1; dy++) for (let dx = -1; dx <= 1; dx++) {
                    const x = x0 + dx, y = y0 + dy; if (x < 0 || y < 0 || x >= w || y >= h) continue;
                    const k = known[y * w + x]; nx += dx * k; ny += dy * k;
                }
                const nl = Math.hypot(nx, ny) || 1, d = gm > 0 ? Math.abs(-gy * nx + gx * ny) / (nl * 255) : 0;
                return c * (d + 0.05);
            }
            for (let i = 0; i < N; i++) if (onFront(i)) { inFront[i] = 1; P[i] = priority(i); front.push(i); }
            let filled = 0, step = 0;
            const tox = [], toy = [], tr = [], tg = [], tb = [];
            while (front.length) {
                let best = -1, bp = -1, keep = [];
                for (const i of front) { if (known[i]) { inFront[i] = 0; continue; } keep.push(i); if (P[i] > bp) { bp = P[i]; best = i; } }
                front = keep;
                if (best < 0) break;
                const x0 = best % w, y0 = (best / w) | 0, cx = Math.min(w - 1 - R, Math.max(R, x0)), cy = Math.min(h - 1 - R, Math.max(R, y0));
                tox.length = toy.length = tr.length = tg.length = tb.length = 0;
                for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
                    const q = (cy + dy) * w + cx + dx; if (!known[q]) continue;
                    tox.push(dx); toy.push(dy); tr.push(out[q * 4]); tg.push(out[q * 4 + 1]); tb.push(out[q * 4 + 2]);
                }
                const nk = tox.length; let bs = -1, bd = Infinity;
                // a source costs its color difference times (1 + how far it is from here, in hole sizes): near texture wins over similar texture far away
                const test = (c, bonus) => {
                    const sx = c % w, sy = (c / w) | 0, f = (1 + LAM * Math.min(3, Math.hypot(sx - cx, sy - cy) / D)) * (bonus || 1), lim = bd / f; let d = 0;
                    for (let k = 0; k < nk; k++) {
                        const s = ((sy + toy[k]) * w + sx + tox[k]) * 4, e0 = out[s] - tr[k], e1 = out[s + 1] - tg[k], e2 = out[s + 2] - tb[k];
                        d += e0 * e0 + e1 * e1 + e2 * e2; if (d >= lim) return;
                    }
                    bd = d * f; bs = c;
                };
                const nc = Math.min(opts.cands, srcs.length), near = Math.max(4 * R, Math.round(0.8 * D));
                if (srcs.length <= opts.cands) for (let k = 0; k < nc; k++) test(srcs[k]);
                else {
                    for (let k = 0; k < nc >> 1; k++) test(srcs[(rnd() * srcs.length) | 0]);
                    for (let k = 0; k < nc >> 1; k++) {                                   // half of the tries close to the patch
                        const sx = cx + Math.round((rnd() * 2 - 1) * near), sy = cy + Math.round((rnd() * 2 - 1) * near);
                        if (sx >= R && sy >= R && sx < w - R && sy < h - R && valid[sy * w + sx]) test(sy * w + sx);
                    }
                }
                for (let dy = -R; dy <= R; dy += Math.max(1, R >> 1)) for (let dx = -R; dx <= R; dx += Math.max(1, R >> 1)) {   // carry on from the pieces already copied next to it
                    const q = (cy + dy) * w + cx + dx, sp = srcOf[q]; if (sp < 0) continue;
                    const sx = (sp % w) - dx, sy = ((sp / w) | 0) - dy;
                    if (sx >= R && sy >= R && sx < w - R && sy < h - R && valid[sy * w + sx]) test(sy * w + sx, COH);
                }
                if (bs >= 0) for (let rad = 6; rad >= 1; rad = rad >> 1) for (let k = 0; k < 6; k++) {      // small shifts around the best
                    const sx = (bs % w) + Math.round((rnd() * 2 - 1) * rad), sy = ((bs / w) | 0) + Math.round((rnd() * 2 - 1) * rad);
                    if (sx >= R && sy >= R && sx < w - R && sy < h - R && valid[sy * w + sx]) test(sy * w + sx);
                }
                if (bs < 0) bs = srcs[(rnd() * srcs.length) | 0];
                let cc = 0; for (let k = 0; k < nk; k++) cc += conf[(cy + toy[k]) * w + cx + tox[k]]; cc /= (2 * R + 1) * (2 * R + 1);
                for (let dy = -R; dy <= R; dy++) for (let dx = -R; dx <= R; dx++) {
                    const q = (cy + dy) * w + cx + dx; if (known[q]) continue;
                    const s = bs + dy * w + dx;
                    out[q * 4] = out[s * 4]; out[q * 4 + 1] = out[s * 4 + 1]; out[q * 4 + 2] = out[s * 4 + 2]; out[q * 4 + 3] = 255;
                    known[q] = 1; conf[q] = cc; srcOf[q] = s; filled++;
                }
                // new edge pixels, and refreshed priorities nearby
                for (let y = Math.max(0, cy - 2 * R - 1); y <= Math.min(h - 1, cy + 2 * R + 1); y++) for (let x = Math.max(0, cx - 2 * R - 1); x <= Math.min(w - 1, cx + 2 * R + 1); x++) {
                    const i = y * w + x;
                    if (known[i]) continue;
                    if (inFront[i]) P[i] = priority(i);
                    else if (onFront(i)) { inFront[i] = 1; P[i] = priority(i); front.push(i); }
                }
                if (onProgress && (++step & 7) === 0) onProgress(`Filling: ${Math.round(100 * filled / area)}%`, filled / area);
            }
            return out;
        }
        // Brightness that changes slowly over the picture (lighting, shading, vignetting) made copying from far away look wrong. So the picture is
        // split: the slowly changing part L (an average over a neighbourhood of known pixels, wider where the hole is wide) and the texture left
        // over. The texture of the hole is copied from the real texture around it (above); L is carried into the hole from its edge.
        function lowPass(rgba, w, h, known, rad) {
            const W1 = w + 1, I = [new Float64Array(W1 * (h + 1)), new Float64Array(W1 * (h + 1)), new Float64Array(W1 * (h + 1)), new Float64Array(W1 * (h + 1))];
            for (let y = 0; y < h; y++) {
                let a0 = 0, a1 = 0, a2 = 0, a3 = 0;
                for (let x = 0; x < w; x++) {
                    const i = y * w + x, k = known[i];
                    if (k) { a0 += rgba[i * 4]; a1 += rgba[i * 4 + 1]; a2 += rgba[i * 4 + 2]; a3 += 1; }
                    const j = (y + 1) * W1 + x + 1, up = y * W1 + x + 1;
                    I[0][j] = I[0][up] + a0; I[1][j] = I[1][up] + a1; I[2][j] = I[2][up] + a2; I[3][j] = I[3][up] + a3;
                }
            }
            const L = new Float32Array(w * h * 3), wt = new Float32Array(w * h);
            for (let y = 0; y < h; y++) {
                const y0 = Math.max(0, y - rad), y1 = Math.min(h, y + rad + 1);
                for (let x = 0; x < w; x++) {
                    const x0 = Math.max(0, x - rad), x1 = Math.min(w, x + rad + 1), area = (x1 - x0) * (y1 - y0);
                    const c = I[3][y1 * W1 + x1] - I[3][y0 * W1 + x1] - I[3][y1 * W1 + x0] + I[3][y0 * W1 + x0];
                    const i = y * w + x; wt[i] = c / area;
                    if (c <= 0) continue;
                    for (let ch = 0; ch < 3; ch++) L[i * 3 + ch] = (I[ch][y1 * W1 + x1] - I[ch][y0 * W1 + x1] - I[ch][y1 * W1 + x0] + I[ch][y0 * W1 + x0]) / c;
                }
            }
            return { L, wt };
        }
        function inpaintExemplar(rgba, w, h, hole, opts, onProgress) {
            opts = opts || {};
            const N = w * h, known = Uint8Array.from(hole, v => v ? 0 : 1);
            let area = 0, bx0 = w, by0 = h, bx1 = -1, by1 = -1;
            for (let i = 0; i < N; i++) if (hole[i]) { area++; const x = i % w, y = (i / w) | 0; if (x < bx0) bx0 = x; if (x > bx1) bx1 = x; if (y < by0) by0 = y; if (y > by1) by1 = y; }
            if (!area || opts.noSplit) return exemplarCore(rgba, w, h, hole, opts, onProgress);
            const span = Math.max(bx1 - bx0, by1 - by0) + 1;
            const r0 = Math.max(12, Math.round(span / 4));                       // the neighbourhood that defines the slow part
            const lv = [lowPass(rgba, w, h, known, r0)];
            for (let r = r0 * 2; r < 2 * Math.max(w, h) && lv.length < 5; r *= 2) lv.push(lowPass(rgba, w, h, known, r));
            const L = new Float32Array(N * 3);                                    // finest level that has enough known pixels in its window
            for (let i = 0; i < N; i++) {
                let k = 0; while (k < lv.length - 1 && lv[k].wt[i] < (known[i] ? 0.02 : 0.2)) k++;
                if (lv[k].wt[i] <= 0) { L[i * 3] = L[i * 3 + 1] = L[i * 3 + 2] = 128; continue; }
                L[i * 3] = lv[k].L[i * 3]; L[i * 3 + 1] = lv[k].L[i * 3 + 1]; L[i * 3 + 2] = lv[k].L[i * 3 + 2];
            }
            const tex = new Uint8Array(rgba.length);                              // the texture part, around 128
            for (let i = 0; i < N; i++) {
                for (let c = 0; c < 3; c++) tex[i * 4 + c] = hole[i] ? 128 : Math.max(0, Math.min(255, Math.round(rgba[i * 4 + c] - L[i * 3 + c] + 128)));
                tex[i * 4 + 3] = 255;
            }
            const f = exemplarCore(tex, w, h, hole, opts, onProgress);
            const out = Uint8Array.from(rgba);
            for (let i = 0; i < N; i++) if (hole[i]) {
                for (let c = 0; c < 3; c++) out[i * 4 + c] = Math.max(0, Math.min(255, Math.round(L[i * 3 + c] + f[i * 4 + c] - 128)));
                out[i * 4 + 3] = 255;
            }
            return out;
        }
        return { Graph, seams, inpaint: inpaintExemplar, inpaintPatchMatch: inpaint };
    }

    // ---------------- Worker plumbing (page side) ----------------
    function workerMain() {
        const PS = factory(self);
        self.onmessage = e => {
            const m = e.data, post = (o, tr) => self.postMessage(Object.assign({ id: m.id }, o), tr || []);
            try {
                if (m.type === 'seams') {
                    const res = PS.seams(m.W, m.H, m.imgs, m.opts, (t, f) => post({ type: 'progress', text: t, frac: f }));
                    post({ type: 'done', res }, res.map(r => r.data.buffer));
                } else if (m.type === 'inpaint') {
                    const out = PS.inpaint(m.rgba, m.w, m.h, m.hole, m.opts, (t, f) => post({ type: 'progress', text: t, frac: f }));
                    post({ type: 'done', rgba: out }, [out.buffer]);
                }
            } catch (err) { post({ type: 'error', error: String((err && err.message) || err) }); }
        };
    }
    let worker = null, jobId = 0;
    const jobs = new Map();
    function run(msg, transfer, onProgress) {
        if (!worker) {
            const src = 'const factory = ' + factory.toString() + ';\n(' + workerMain.toString() + ')();';
            worker = new Worker(URL.createObjectURL(new Blob([src], { type: 'text/javascript' })));
            worker.onmessage = e => {
                const m = e.data, j = jobs.get(m.id); if (!j) return;
                if (m.type === 'progress') { if (j.onProgress) j.onProgress(m.text, m.frac); return; }
                jobs.delete(m.id);
                if (m.type === 'error') j.reject(new Error(m.error)); else j.resolve(m);
            };
            worker.onerror = e => { const err = new Error('Worker failed: ' + (e.message || 'unknown error')); jobs.forEach(j => j.reject(err)); jobs.clear(); worker.terminate(); worker = null; };
        }
        return new Promise((resolve, reject) => {
            const id = ++jobId;
            jobs.set(id, { resolve, reject, onProgress });
            worker.postMessage(Object.assign({ id }, msg), transfer || []);
        });
    }
    const API = factory(outer);
    API.run = run;
    API.factorySource = factory.toString();
    if (typeof module !== 'undefined' && module.exports) module.exports = API;
    else outer.PanoSeams = API;
})(typeof self !== 'undefined' ? self : this);
