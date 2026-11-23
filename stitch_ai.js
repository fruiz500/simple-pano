// Simple Pano: AI image edits for retouching (remove the photographer, a passer-by, a tripod, ...).
// The user brings a key for OpenAI, Google Gemini or OpenRouter. The key stays in this browser and goes only to the provider.
// Same provider / key / model pattern as the AI assistant of Simple Equation Solver (a key saved there under the same site
// address is found here too). Classic script, no dependence on the page: the viewer passes in what it needs (StitchAI.create).
// Only a small crop of the panorama, the mask and the prompt are sent, never the other photos.
const StitchAI = (() => {
    // style: how the request and the reply are shaped. mask: the provider takes a real mask (otherwise the area is marked in the picture).
    const PROVIDERS = {
        openai: { label: 'OpenAI', style: 'openai', base: 'https://api.openai.com/v1', model: 'gpt-image-1', mask: true },
        gemini: { label: 'Google Gemini', style: 'gemini', base: 'https://generativelanguage.googleapis.com/v1beta', model: 'gemini-2.5-flash-image', mask: false },
        openrouter: { label: 'OpenRouter', style: 'openrouter', base: 'https://openrouter.ai/api/v1', model: 'google/gemini-2.5-flash-image', mask: false },
        // Stable Diffusion WebUI (AUTOMATIC1111 or Forge) running on this computer: started with --api --cors-allow-origins=*. No key. Blank model = the one loaded in the WebUI.
        sd: { label: 'Stable Diffusion (this computer)', style: 'sd', base: 'http://127.0.0.1:7860', model: '', mask: true, local: true },
    };
    const TIMEOUT_MS = 300000;

    // The prompt actually sent. Providers without a mask get the area painted in solid magenta and are told so.
    function buildPrompt(provider, user) {
        if (provider === 'sd') return String(user || '').trim() || 'natural empty background, the same surface and lighting as the surroundings, seamless, photograph';
        const base = String(user || '').trim() || 'Remove whatever is in the masked area and continue the surrounding scene naturally.';
        if (PROVIDERS[provider].mask) return base + ' Change only the masked area; keep everything else exactly as it is.';
        return 'Edit this photo. The region painted in solid magenta (#FF00FF) marks the area to change. ' + base +
            ' Replace the magenta completely with natural content that matches the surrounding scene (same perspective, texture, lighting and sharpness). ' +
            'Do not change anything outside the magenta area. Return the whole picture at the same size and framing, with no magenta left.';
    }

    // parts: { image, mask, marked } = Blobs (PNG) or, for tests, objects with a b64 string; prompt; size like '1024x1024'.
    // Returns { url, init } for fetch. async because the picture may need to be turned into base64.
    async function buildEditRequest(provider, o, parts, toB64) {
        const P = PROVIDERS[provider], base = (o.base || P.base).replace(/\/+$/, ''), prompt = buildPrompt(provider, parts.prompt);
        if (P.style === 'openai') {
            const fd = new FormData();
            fd.append('model', o.model);
            fd.append('prompt', prompt);
            fd.append('image', parts.image, 'image.png');
            fd.append('mask', parts.mask, 'mask.png');
            if (parts.size) fd.append('size', parts.size);
            return { url: base + '/images/edits', init: { method: 'POST', headers: { authorization: 'Bearer ' + o.key }, body: fd } };
        }
        if (P.style === 'sd') {
            // the painted area is redrawn at the working size (o.work), then pasted back into the picture
            const wk = Math.max(256, Math.min(1536, Math.round((o.work || 768) / 8) * 8));
            const body = { init_images: [await toB64(parts.image)], mask: await toB64(parts.sdmask), prompt, negative_prompt: 'text, watermark, signature, blurry, deformed, person, people',
                denoising_strength: 0.92, inpainting_fill: 1, inpaint_full_res: true, inpaint_full_res_padding: 48, mask_blur: 6, inpainting_mask_invert: 0, resize_mode: 0,
                width: wk, height: wk, steps: o.steps || 28, cfg_scale: o.cfgScale || 6.5, seed: -1, batch_size: 1, n_iter: 1 };
            if (o.model) { body.override_settings = { sd_model_checkpoint: o.model }; body.override_settings_restore_afterwards = true; }
            return { url: base + '/sdapi/v1/img2img', init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) } };
        }
        const b64 = await toB64(parts.marked);
        if (P.style === 'gemini') {
            return { url: `${base}/models/${encodeURIComponent(o.model)}:generateContent`, init: { method: 'POST', headers: { 'content-type': 'application/json', 'x-goog-api-key': o.key },
                body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: prompt }, { inlineData: { mimeType: 'image/png', data: b64 } }] }], generationConfig: { responseModalities: ['TEXT', 'IMAGE'] } }) } };
        }
        // Picture models are called on OpenRouter's /images endpoint; chat-style ones (Gemini) on /chat/completions.
        const route = o.route || (orOutputs[o.model] ? (orOutputs[o.model].includes('text') ? 'chat' : 'images') : (/^google\/gemini/.test(o.model) ? 'chat' : 'images'));
        if (route === 'images') {
            return { url: base + '/images', init: { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + o.key },
                body: JSON.stringify({ model: o.model, prompt, input_references: [{ type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }] }) } };
        }
        const mods = o.imageOnly === true || (o.imageOnly == null && orOutputs[o.model] && !orOutputs[o.model].includes('text')) ? ['image'] : ['image', 'text'];
        return { url: base + '/chat/completions', init: { method: 'POST', headers: { 'content-type': 'application/json', authorization: 'Bearer ' + o.key },
            body: JSON.stringify({ model: o.model, modalities: mods, messages: [{ role: 'user', content: [{ type: 'text', text: prompt }, { type: 'image_url', image_url: { url: 'data:image/png;base64,' + b64 } }] }] }) } };
    }

    // { dataUrl } (or { url } when the provider returns an address) from the JSON reply, or an Error with what the model said.
    function parseEditReply(provider, j) {
        const style = PROVIDERS[provider].style;
        if (style === 'sd') {
            const im = (j.images || [])[0];
            if (!im) throw new Error('The reply held no picture.');
            return { dataUrl: 'data:image/png;base64,' + String(im).replace(/^data:[^,]*,/, '') };
        }
        if (style === 'openai') {
            const d = (j.data || [])[0];
            if (d && d.b64_json) return { dataUrl: 'data:image/png;base64,' + d.b64_json };
            if (d && d.url) return { url: d.url };
            throw new Error('The reply held no picture.');
        }
        if (style === 'gemini') {
            const c = (j.candidates || [])[0], parts = c && c.content && c.content.parts ? c.content.parts : [];
            for (const p of parts) {
                const id = p.inlineData || p.inline_data;
                if (id && id.data) return { dataUrl: `data:${id.mimeType || id.mime_type || 'image/png'};base64,${id.data}` };
            }
            if (j.promptFeedback && j.promptFeedback.blockReason) throw new Error('The request was blocked by the provider (' + j.promptFeedback.blockReason + ').');
            const said = parts.map(p => p.text || '').join(' ').trim();
            throw new Error('The model returned no picture' + (said ? ': ' + said.slice(0, 300) : (c && c.finishReason ? ' (' + c.finishReason + ')' : '.')));
        }
        if (Array.isArray(j.data)) {                                  // OpenRouter /images reply
            const d = j.data[0];
            if (d && d.b64_json) return { dataUrl: 'data:image/png;base64,' + d.b64_json };
            if (d && d.url) return { url: d.url };
            throw new Error('The reply held no picture.');
        }
        const m = ((j.choices || [])[0] || {}).message || {};
        const im = (m.images || [])[0];
        const url = im && (im.image_url ? (im.image_url.url || im.image_url) : im.url);
        if (url) return { dataUrl: url };
        const said = Array.isArray(m.content) ? m.content.map(p => p.text || '').join(' ') : (m.content || '');
        throw new Error('The model returned no picture' + (said.trim() ? ': ' + said.trim().slice(0, 300) : '.'));
    }

    function errorText(status, body) {
        let msg = '';
        try {
            let j = JSON.parse(body); if (Array.isArray(j)) j = j[0];
            msg = (j && j.error && (j.error.message || (typeof j.error === 'string' ? j.error : ''))) || (j && j.message) || (j && typeof j.detail === 'string' ? j.detail : '') || (j && j.errors) || '';
        } catch (e) { msg = String(body || '').slice(0, 300); }
        return `${status}${msg ? ': ' + msg : ''}`;
    }
    function modelsRequest(provider, o) {
        const P = PROVIDERS[provider], base = (o.base || P.base).replace(/\/+$/, '');
        if (P.style === 'sd') return { url: base + '/sdapi/v1/sd-models', headers: {} };
        if (P.style === 'gemini') return { url: base + '/models?pageSize=1000', headers: { 'x-goog-api-key': o.key } };
        if (provider === 'openrouter') return { url: base + '/models?output_modalities=image', headers: o.key ? { authorization: 'Bearer ' + o.key } : {} };
        return { url: base + '/models', headers: { authorization: 'Bearer ' + o.key } };
    }
    // OpenRouter: what each listed model outputs, remembered from the model list
    const orOutputs = {};
    // The models that can make pictures
    function parseModels(provider, j) {
        if (provider === 'sd') return (Array.isArray(j) ? j : []).map(m => m.title || m.model_name).filter(Boolean);
        if (provider === 'gemini') return (j.models || []).map(m => String(m.name).replace(/^models\//, '')).filter(n => /image|imagen/i.test(n));
        const list = j.data || j.models || [];
        if (provider === 'openrouter') {
            const ok = list.filter(m => !m.architecture || !m.architecture.output_modalities || m.architecture.output_modalities.includes('image'))
                .filter(m => !m.architecture || !m.architecture.input_modalities || m.architecture.input_modalities.includes('image'));   // retouching needs a model that accepts a picture
            for (const m of ok) if (m.id && m.architecture && m.architecture.output_modalities) orOutputs[m.id] = m.architecture.output_modalities;
            return ok.map(m => m.id).filter(Boolean);
        }
        return list.map(m => m.id).filter(id => /image|dall-e/i.test(id));
    }

    // A picture reply may come as an address: fetched here.
    // deps: { fetch, local, session (storages), toB64(blob) }
    function create(deps) {
        const cfg = { provider: 'openai', models: {}, remember: true, bases: {}, work: 768, sdSteps: 28, sdCfg: 6.5, ollama: { base: 'http://127.0.0.1:11434', model: '' } };
        let keys = {};
        const rd = (s, k) => { try { return s && s.getItem(k); } catch (e) { return null; } };
        const wr = (s, k, v) => { try { if (s) s.setItem(k, v); } catch (e) { } };
        const rm = (s, k) => { try { if (s) s.removeItem(k); } catch (e) { } };
        const local = deps.local || null, session = deps.session || null;
        try { Object.assign(cfg, JSON.parse(rd(local, 'stitch-ai') || '{}')); } catch (e) { }
        try { keys = JSON.parse(rd(cfg.remember ? local : session, 'stitch-ai-keys') || '{}'); } catch (e) { keys = {}; }
        if (!PROVIDERS[cfg.provider]) cfg.provider = 'openai';
        const saveCfg = () => wr(local, 'stitch-ai', JSON.stringify(cfg));
        const saveKeys = () => { rm(local, 'stitch-ai-keys'); rm(session, 'stitch-ai-keys'); wr(cfg.remember ? local : session, 'stitch-ai-keys', JSON.stringify(keys)); };
        // Keys saved by Simple Equation Solver (same browser and site address) are used when none was given here.
        const borrowed = (p) => { try { const k = JSON.parse(rd(local, 'ses-ai-keys') || '{}'); return k[p] || ''; } catch (e) { return ''; } };

        const keyOf = (p) => keys[p] || borrowed(p) || '';
        const opts = () => ({ key: keyOf(cfg.provider), model: cfg.models[cfg.provider] || PROVIDERS[cfg.provider].model, base: (cfg.bases && cfg.bases[cfg.provider]) || PROVIDERS[cfg.provider].base, work: cfg.work, steps: cfg.sdSteps, cfgScale: cfg.sdCfg });
        const http = (url, init) => (deps.fetch || fetch)(url, init);
        const ctls = new Set();      // requests in flight (several can run at once)

        async function edit(parts, size) {
            const o = opts(), P = PROVIDERS[cfg.provider];
            if (!P.local && !o.key) throw new Error(`No key for ${P.label}. Paste it in the key field.`);
            const ctl = new AbortController(); ctls.add(ctl);
            const timer = setTimeout(() => { ctl.timedOut = true; ctl.abort(); }, TIMEOUT_MS);
            try {
                let r = await buildEditRequest(cfg.provider, o, Object.assign({ size }, parts), deps.toB64);
                let res;
                try {
                    res = await http(r.url, Object.assign({}, r.init, { signal: ctl.signal }));
                    if (cfg.provider === 'openrouter' && !res.ok && res.status >= 400 && res.status < 500 && !(orOutputs[o.model])) {
                        // a model we know nothing about: if it says it belongs to the other endpoint, ask there
                        const t = await res.clone().text(), wasImages = /\/images\b/.test(r.url);
                        if (wasImages ? /chat|text/i.test(t) : /\/images|image generation/i.test(t)) {
                            r = await buildEditRequest(cfg.provider, Object.assign({}, o, { route: wasImages ? 'chat' : 'images' }), Object.assign({ size }, parts), deps.toB64);
                            res = await http(r.url, Object.assign({}, r.init, { signal: ctl.signal }));
                        }
                    }
                }
                catch (e) { throw new Error(e && e.name === 'AbortError' ? (ctl.timedOut ? 'No answer within ' + TIMEOUT_MS / 1000 + ' s.' : 'Stopped.') : P.local ? `Could not reach ${P.label} at ${o.base}. Is the WebUI running, started with --api --cors-allow-origins=* ?` : `Could not reach ${P.label}: check the connection.`); }
                const body = await res.text();
                if (!res.ok) throw new Error(`${P.label} replied ${errorText(res.status, body)}`);
                let j; try { j = JSON.parse(body); } catch (e) { throw new Error('The reply was not JSON: ' + body.slice(0, 200)); }
                const out = parseEditReply(cfg.provider, j);
                if (out.url) {                                           // an address: download the picture
                    const pr = await http(out.url, { signal: ctl.signal });
                    if (!pr.ok) throw new Error('Could not download the picture (' + pr.status + ').');
                    return { blob: await pr.blob() };
                }
                return { dataUrl: out.dataUrl };
            } finally { clearTimeout(timer); ctls.delete(ctl); }
        }
        async function listModels() {
            const o = opts(), r = modelsRequest(cfg.provider, o);
            if (!PROVIDERS[cfg.provider].local && !o.key) throw new Error('Paste the key first.');
            let res;
            try { res = await http(r.url, { headers: r.headers }); } catch (e) { throw new Error('Could not reach ' + PROVIDERS[cfg.provider].label + (PROVIDERS[cfg.provider].local ? ' at ' + o.base + '. Is it running, started with --api --cors-allow-origins=* ?' : '.')); }
            const body = await res.text();
            if (!res.ok) throw new Error(`${PROVIDERS[cfg.provider].label} replied ${errorText(res.status, body)}`);
            return parseModels(cfg.provider, JSON.parse(body)).sort();
        }
        // Ollama (on this computer, started with OLLAMA_ORIGINS=*): a vision model looks at the picture and writes the prompt for the image model.
        const olBase = () => String(cfg.ollama.base || 'http://127.0.0.1:11434').replace(/\/+$/, '');
        const olFail = () => new Error('Could not reach Ollama at ' + olBase() + '. Is it running, started with OLLAMA_ORIGINS=* ?');
        async function ollamaModels() {
            let res; try { res = await http(olBase() + '/api/tags', {}); } catch (e) { throw olFail(); }
            const body = await res.text(); if (!res.ok) throw new Error('Ollama replied ' + errorText(res.status, body));
            return ((JSON.parse(body).models) || []).map(m => m.name || m.model).filter(Boolean).sort();
        }
        async function ollamaDescribe(imageBlob, question) {
            if (!cfg.ollama.model) throw new Error('Type the name of an Ollama vision model first (List shows what is installed).');
            const ctl = new AbortController(); ctls.add(ctl);
            const timer = setTimeout(() => { ctl.timedOut = true; ctl.abort(); }, TIMEOUT_MS);
            try {
                let res;
                try {
                    res = await http(olBase() + '/api/chat', { method: 'POST', headers: { 'content-type': 'application/json' }, signal: ctl.signal,
                        body: JSON.stringify({ model: cfg.ollama.model, stream: false, messages: [{ role: 'user', content: question, images: [await deps.toB64(imageBlob)] }] }) });
                } catch (e) { throw e && e.name === 'AbortError' ? new Error(ctl.timedOut ? 'No answer from Ollama within ' + TIMEOUT_MS / 1000 + ' s.' : 'Stopped.') : olFail(); }
                const body = await res.text(); if (!res.ok) throw new Error('Ollama replied ' + errorText(res.status, body));
                const t = (((JSON.parse(body).message) || {}).content || '').trim().replace(/^["'\s]+|["'\s]+$/g, '');
                if (!t) throw new Error('Ollama returned no text.');
                return t;
            } finally { clearTimeout(timer); ctls.delete(ctl); }
        }
        return {
            cfg, edit, listModels, ollamaModels, ollamaDescribe, PROVIDERS,
            get isLocal() { return !!PROVIDERS[cfg.provider].local; },
            get base() { return opts().base; },
            set base(v) { v = String(v || '').trim().replace(/\/+$/, ''); if (v) cfg.bases[cfg.provider] = v; else delete cfg.bases[cfg.provider]; saveCfg(); },
            get work() { return cfg.work; },
            set work(v) { cfg.work = Math.max(256, Math.min(1536, parseInt(v, 10) || 768)); saveCfg(); },
            get sdSteps() { return cfg.sdSteps; },
            set sdSteps(v) { cfg.sdSteps = Math.max(1, Math.min(60, parseInt(v, 10) || 28)); saveCfg(); },
            get sdCfg() { return cfg.sdCfg; },
            set sdCfg(v) { cfg.sdCfg = Math.max(1, Math.min(12, parseFloat(v) || 6.5)); saveCfg(); },
            setOllama(base, model) { cfg.ollama = { base: String(base || '').trim() || 'http://127.0.0.1:11434', model: String(model || '').trim() }; saveCfg(); },
            stop() { for (const c of ctls) c.abort(); },
            get busy() { return ctls.size > 0; },
            get model() { return opts().model; },
            set model(v) { cfg.models[cfg.provider] = String(v || '').trim(); saveCfg(); },
            set provider(p) { if (PROVIDERS[p]) { cfg.provider = p; saveCfg(); } },
            get provider() { return cfg.provider; },
            get hasKey() { return !!PROVIDERS[cfg.provider].local || !!keyOf(cfg.provider); },
            get keyHint() { const k = keyOf(cfg.provider); return k ? '...' + k.slice(-4) : ''; },
            setKey(k) { k = String(k || '').trim(); if (k) { keys[cfg.provider] = k; saveKeys(); } },
            setRemember(on) { cfg.remember = !!on; saveCfg(); saveKeys(); },
            forget() { keys = {}; rm(local, 'stitch-ai-keys'); rm(session, 'stitch-ai-keys'); rm(local, 'stitch-ai'); Object.assign(cfg, { provider: 'openai', models: {}, remember: true, bases: {}, work: 768, sdSteps: 28, sdCfg: 6.5, ollama: { base: 'http://127.0.0.1:11434', model: '' } }); },
        };
    }
    return { create, PROVIDERS, buildPrompt, buildEditRequest, parseEditReply, errorText, modelsRequest, parseModels };
})();
if (typeof window !== 'undefined') window.StitchAI = StitchAI;
if (typeof module !== 'undefined' && module.exports) module.exports = StitchAI;
