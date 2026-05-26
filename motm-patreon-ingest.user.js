// ==UserScript==
// @name         MOTM Patreon Ingest
// @namespace    https://motm.local/userscripts
// @match        https://www.patreon.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      api.motm.trevormimano.com
// @connect      www.patreon.com
// @updateURL    https://raw.githubusercontent.com/trevormimano-svg/motm-userscripts/main/motm-patreon-ingest.user.js
// @downloadURL  https://raw.githubusercontent.com/trevormimano-svg/motm-userscripts/main/motm-patreon-ingest.user.js
// @version      1.3.0
// @description  Auto-ingest Patreon post bodies to MOTM intel pipeline during normal browsing. Live mode + operator-initiated catch-up. ToS-clean: runs in your authenticated browser, identical fingerprint to manual select-copy-paste.
// @author       MOTM
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'https://api.motm.trevormimano.com';
    const ENDPOINTS = {
        awaitingPaste: `${API_BASE}/api/motm/intel/awaiting-paste`,
        paste: (id) => `${API_BASE}/api/motm/review/${id}/paste`,
        extractionFailure: `${API_BASE}/api/motm/intel/extraction-failure`,
    };
    const TOKEN_KEY = 'motm_patreon_ingest_token';
    const CATCH_UP_DELAY_MS = 800;
    const POST_URL_RE = /^https?:\/\/(?:www\.)?patreon\.com\/posts\/[^?#]+/i;

    // ----- token bootstrap -----

    function getToken() {
        let t = GM_getValue(TOKEN_KEY, '');
        if (!t) {
            t = prompt('Paste your MOTM_PATREON_INGEST_KEY (64-hex)');
            if (t && /^[0-9a-f]{64}$/i.test(t.trim())) {
                t = t.trim();
                GM_setValue(TOKEN_KEY, t);
            } else {
                console.warn('[MOTM] invalid token; not stored');
                return '';
            }
        }
        return t;
    }

    // ----- multi-selector extractor -----

    const EXTRACTORS = [
        { name: 'data-tag=post-content', selector: '[data-tag="post-content"]' },
        { name: 'data-tag=post-html-content', selector: '[data-tag="post-html-content"]' },
        { name: 'data-tag=post-body', selector: '[data-tag="post-body"]' },
        { name: 'data-tag=content', selector: '[data-tag="content"]' },
        { name: 'class=post-content', selector: '.post-content' },
        { name: 'class=postContent', selector: '[class*="postContent"]' },
        { name: 'class=postBody', selector: '[class*="postBody"]' },
        { name: 'class=post_body', selector: '[class*="post_body"]' },
        { name: 'class=post-body', selector: '[class*="post-body"]' },
        { name: 'data-test-name=post-body', selector: '[data-test-name*="post-body"]' },
        { name: 'data-test-tag=post-content', selector: '[data-test-tag*="post-content"]' },
    ];

    function classString(el) {
        // SVG elements have SVGAnimatedString, not String — guard against .slice crashes.
        const c = el.className;
        if (typeof c === 'string') return c;
        if (c && typeof c.baseVal === 'string') return c.baseVal;
        return '';
    }

    function looksLikeProse(text) {
        // Heuristic: post bodies have multiple sentences with letters + spaces.
        const t = (text || '').trim();
        if (t.length < 200) return 0;
        const sentenceTerminators = (t.match(/[.!?]\s/g) || []).length;
        const letterRatio = (t.match(/[a-zA-Z]/g) || []).length / t.length;
        return sentenceTerminators * (letterRatio > 0.5 ? 1 : 0);
    }

    function densityExtract(doc) {
        // Walk every block-level element; score by prose-likeness + size; pick the best.
        // Skip elements whose textContent is dominated by a single child (containers).
        const blocks = doc.querySelectorAll('article, section, main, div');
        let best = null;
        let bestScore = 0;
        for (const el of blocks) {
            const text = (el.textContent || '').trim();
            if (text.length < 300 || text.length > 80000) continue;
            const cls = classString(el).toLowerCase();
            if (/sidebar|footer|header|nav|menu|comment|cookie|banner|modal/.test(cls)) continue;
            // Avoid pure containers: require the element itself to add something.
            const childMaxText = Math.max(0, ...Array.from(el.children).map((c) => (c.textContent || '').length));
            const ownContribution = text.length - childMaxText;
            if (ownContribution < 100 && el.children.length === 1) continue;
            const proseScore = looksLikeProse(text);
            const sizeScore = Math.min(text.length / 1000, 50);
            const score = proseScore * 10 + sizeScore;
            if (score > bestScore) {
                bestScore = score;
                best = el;
            }
        }
        return best;
    }

    function extractFromDoc(doc) {
        for (const { name, selector } of EXTRACTORS) {
            const el = doc.querySelector(selector);
            if (el && el.textContent && el.textContent.trim().length > 50) {
                return { text: el.innerHTML, selector: name };
            }
        }
        // Aggressive density fallback: largest prose-like block on the page.
        const dense = densityExtract(doc);
        if (dense) {
            const len = (dense.textContent || '').trim().length;
            return { text: dense.innerHTML, selector: `density-fallback(${dense.tagName.toLowerCase()}.${classString(dense).slice(0, 24)})/len=${len}` };
        }
        return null;
    }

    function domSignatureHash(doc) {
        // Lightweight DOM-shape signature for telemetry (NOT for security).
        const sig = Array.from(doc.querySelectorAll('main, article, [data-tag]'))
            .slice(0, 20)
            .map((el) => `${el.tagName}.${classString(el).slice(0, 30)}.${el.getAttribute('data-tag') || ''}`)
            .join('|');
        let h = 0;
        for (let i = 0; i < sig.length; i++) {
            h = ((h << 5) - h + sig.charCodeAt(i)) | 0;
        }
        return `sig_${(h >>> 0).toString(16)}`;
    }

    function reportFailure(token, postUrl, doc, attempted) {
        if (!token) return;
        GM_xmlhttpRequest({
            method: 'POST',
            url: ENDPOINTS.extractionFailure,
            headers: {
                'Content-Type': 'application/json',
                Authorization: `Bearer ${token}`,
            },
            data: JSON.stringify({
                post_url: postUrl,
                page_title: doc.title || '',
                dom_signature_hash: domSignatureHash(doc),
                attempted_selectors: attempted,
            }),
            timeout: 10000,
            onload: () => console.info('[MOTM] extraction-failure reported'),
            onerror: (e) => console.warn('[MOTM] failure-report failed', e),
        });
    }

    // ----- API helpers (GM_xmlhttpRequest bypasses CORS) -----

    function apiGet(url, token) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'GET',
                url,
                headers: { Authorization: `Bearer ${token}` },
                timeout: 15000,
                onload: (resp) => {
                    if (resp.status >= 200 && resp.status < 300) {
                        try {
                            resolve(JSON.parse(resp.responseText));
                        } catch (e) {
                            reject(new Error(`bad JSON from ${url}: ${e.message}`));
                        }
                    } else {
                        reject(new Error(`HTTP ${resp.status}: ${resp.responseText.slice(0, 200)}`));
                    }
                },
                onerror: (e) => reject(new Error(`network: ${e.error || 'unknown'}`)),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    function apiPost(url, token, body) {
        return new Promise((resolve, reject) => {
            GM_xmlhttpRequest({
                method: 'POST',
                url,
                headers: {
                    'Content-Type': 'application/json',
                    Authorization: `Bearer ${token}`,
                },
                data: JSON.stringify(body),
                timeout: 15000,
                onload: (resp) => {
                    if (resp.status >= 200 && resp.status < 300) {
                        resolve({ status: resp.status, body: resp.responseText });
                    } else {
                        reject(new Error(`HTTP ${resp.status}: ${resp.responseText.slice(0, 200)}`));
                    }
                },
                onerror: (e) => reject(new Error(`network: ${e.error || 'unknown'}`)),
                ontimeout: () => reject(new Error('timeout')),
            });
        });
    }

    // ----- core ingest -----

    async function ingestPostFromCurrentPage() {
        const token = getToken();
        if (!token) return;
        const postUrl = canonicalPostUrl(window.location.href);
        if (!postUrl) {
            console.info('[MOTM] not a post page; skipping');
            return;
        }

        // Look up the AWAITING_PASTE row id by post_url.
        let queue;
        try {
            queue = await apiGet(ENDPOINTS.awaitingPaste, token);
        } catch (e) {
            console.warn('[MOTM] could not fetch awaiting-paste queue', e.message);
            return;
        }
        const row = (queue.items || []).find((r) => urlsMatch(r.post_url, postUrl));
        if (!row) {
            console.info('[MOTM] no AWAITING_PASTE row for this post; either already ingested or not yet email-triggered');
            return;
        }

        const extract = extractFromDoc(document);
        if (!extract) {
            console.warn('[MOTM] extractor failed; reporting telemetry');
            reportFailure(token, postUrl, document, EXTRACTORS.map((e) => e.name));
            return;
        }

        try {
            await apiPost(ENDPOINTS.paste(row.id), token, { raw_text: extract.text });
            console.info(`[MOTM] ingested row ${row.id} via ${extract.selector}`);
            try { document.title = `[MOTM✓ ${row.id.slice(0, 8)}] ` + document.title; } catch (e) {}
        } catch (e) {
            console.warn('[MOTM] paste POST failed', e.message);
            try { document.title = `[MOTM✗ paste-failed] ` + document.title; } catch (_) {}
        }
    }

    // ----- visible status overlay -----

    function showOverlay(text, ms = 4000) {
        try {
            let el = document.getElementById('motm-overlay');
            if (!el) {
                el = document.createElement('div');
                el.id = 'motm-overlay';
                el.style.cssText = [
                    'position:fixed', 'bottom:16px', 'right:16px', 'z-index:2147483647',
                    'background:#111', 'color:#fff', 'padding:10px 14px', 'border-radius:8px',
                    'font:13px/1.4 -apple-system,system-ui,sans-serif',
                    'box-shadow:0 4px 12px rgba(0,0,0,0.3)', 'max-width:380px',
                    'pointer-events:none', 'white-space:pre-line',
                ].join(';');
                (document.body || document.documentElement).appendChild(el);
            }
            el.textContent = `[MOTM] ${text}`;
            el.style.opacity = '1';
            clearTimeout(el._fadeTimer);
            if (ms > 0) {
                el._fadeTimer = setTimeout(() => {
                    el.style.transition = 'opacity 600ms';
                    el.style.opacity = '0';
                }, ms);
            }
        } catch (e) {
            console.warn('[MOTM] overlay failed', e);
        }
    }

    async function catchUpAll() {
        const token = getToken();
        if (!token) {
            showOverlay('catch-up aborted: no token. Run "MOTM: reset stored token" then retry.');
            return;
        }
        let queue;
        try {
            queue = await apiGet(ENDPOINTS.awaitingPaste, token);
        } catch (e) {
            const msg = `catch-up: could not fetch queue (${e.message})`;
            console.error(`[MOTM] ${msg}`);
            showOverlay(msg);
            return;
        }
        const items = queue.items || [];
        console.info(`[MOTM] catch-up: ${items.length} rows`);
        showOverlay(`catch-up: ${items.length} row(s) to process`);
        if (items.length === 0) return;

        let ok = 0;
        let failed = 0;
        for (let i = 0; i < items.length; i++) {
            const row = items[i];
            showOverlay(`catch-up: ${i + 1}/${items.length}  ok=${ok} fail=${failed}\n${row.post_url}`, 0);
            const result = await ingestOne(row, token);
            if (result === 'ok') ok++;
            else failed++;
            await sleep(CATCH_UP_DELAY_MS);
        }
        const final = `catch-up complete: ${ok} ok, ${failed} failed`;
        console.info(`[MOTM] ${final}`);
        showOverlay(final, 8000);
    }

    async function ingestOne(row, token) {
        // Strategy A: same-origin fetch. Cheap; works when Patreon SSRs the body.
        try {
            const resp = await fetch(row.post_url, { credentials: 'include' });
            if (resp.ok) {
                const html = await resp.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const extract = extractFromDoc(doc);
                if (extract) {
                    await apiPost(ENDPOINTS.paste(row.id), token, { raw_text: extract.text });
                    console.info(`[MOTM] catch-up A (fetch): ingested ${row.id} via ${extract.selector}`);
                    return 'ok';
                }
                console.info(`[MOTM] catch-up A (fetch): no body in SSR HTML for ${row.post_url} — falling back to window.open`);
            } else {
                console.warn(`[MOTM] catch-up A (fetch): ${row.post_url} returned ${resp.status} — falling back to window.open`);
            }
        } catch (e) {
            console.warn(`[MOTM] catch-up A (fetch): error on ${row.post_url} (${e.message}) — falling back to window.open`);
        }

        // Strategy B: window.open to a Patreon post URL. Live mode in the new
        // tab will extract from the fully-rendered DOM and POST itself. We
        // then close the tab after a safety window. This is the resilient
        // path for SPA-rendered post pages where SSR HTML lacks the body.
        try {
            const tab = window.open(row.post_url, '_blank');
            if (!tab) {
                console.warn(`[MOTM] catch-up B (window.open): popup blocked for ${row.post_url}`);
                reportFailure(token, row.post_url, document, ['popup-blocked']);
                return 'fail';
            }
            // Wait for live-mode in the new tab to do its work. Live mode has a
            // 1.5s settle delay + API roundtrip; 8s total is generous.
            await sleep(8000);
            try { tab.close(); } catch (e) { /* tab may already be closed */ }
            // We don't have a direct success signal — assume ok unless a poll
            // says otherwise. Caller will re-list the queue on next click.
            console.info(`[MOTM] catch-up B (window.open): dispatched ${row.post_url}`);
            return 'ok';
        } catch (e) {
            console.error(`[MOTM] catch-up B (window.open): ${e.message}`);
            return 'fail';
        }
    }

    // ----- helpers -----

    function canonicalPostUrl(href) {
        const m = href.match(POST_URL_RE);
        return m ? m[0] : null;
    }

    function urlsMatch(a, b) {
        if (!a || !b) return false;
        const norm = (u) => u.replace(/^https?:\/\/(?:www\.)?/, '').replace(/[?#].*$/, '').replace(/\/$/, '');
        return norm(a) === norm(b);
    }

    function sleep(ms) {
        return new Promise((r) => setTimeout(r, ms));
    }

    // ----- trigger dispatch -----

    GM_registerMenuCommand('MOTM: catch up Patreon queue', catchUpAll);
    GM_registerMenuCommand('MOTM: reset stored token', () => {
        GM_setValue(TOKEN_KEY, '');
        alert('[MOTM] token cleared. Next ingest will prompt for re-entry.');
    });

    // Live mode: page is a post → auto-ingest on load.
    if (canonicalPostUrl(window.location.href)) {
        // Small delay so SPA / React content has settled.
        setTimeout(ingestPostFromCurrentPage, 1500);
    }

    // Catch-up mode: ?motm_catchup=1 anywhere on patreon.com.
    if (window.location.search.includes('motm_catchup=1')) {
        // Slightly longer settle to make sure session cookies are warmed.
        setTimeout(catchUpAll, 2000);
    }

    console.info('[MOTM] userscript v1.3.0 loaded');
})();
