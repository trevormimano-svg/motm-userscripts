// ==UserScript==
// @name         MOTM Patreon Ingest
// @namespace    https://motm.local/userscripts
// @match        https://www.patreon.com/*
// @grant        GM_xmlhttpRequest
// @grant        GM_setValue
// @grant        GM_getValue
// @grant        GM_registerMenuCommand
// @connect      api-motm-v2-production.up.railway.app
// @connect      www.patreon.com
// @updateURL    https://raw.githubusercontent.com/trevormimano-svg/motm-userscripts/main/motm-patreon-ingest.user.js
// @downloadURL  https://raw.githubusercontent.com/trevormimano-svg/motm-userscripts/main/motm-patreon-ingest.user.js
// @version      1.0.0
// @description  Auto-ingest Patreon post bodies to MOTM intel pipeline during normal browsing. Live mode + operator-initiated catch-up. ToS-clean: runs in your authenticated browser, identical fingerprint to manual select-copy-paste.
// @author       MOTM
// @run-at       document-idle
// ==/UserScript==

(function () {
    'use strict';

    const API_BASE = 'https://api-motm-v2-production.up.railway.app';
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
        { name: 'class=post-content', selector: '.post-content' },
        { name: 'class=postContent', selector: '[class*="postContent"]' },
    ];

    function extractFromDoc(doc) {
        for (const { name, selector } of EXTRACTORS) {
            const el = doc.querySelector(selector);
            if (el && el.textContent && el.textContent.trim().length > 50) {
                return { text: el.innerHTML, selector: name };
            }
        }
        // Text-density fallback: pick the largest <article> by textContent length.
        const articles = Array.from(doc.querySelectorAll('article'));
        if (articles.length) {
            articles.sort((a, b) => (b.textContent || '').length - (a.textContent || '').length);
            const candidate = articles[0];
            if (candidate && (candidate.textContent || '').trim().length > 200) {
                return { text: candidate.innerHTML, selector: 'article-density-fallback' };
            }
        }
        return null;
    }

    function domSignatureHash(doc) {
        // Lightweight DOM-shape signature for telemetry (NOT for security).
        const sig = Array.from(doc.querySelectorAll('main, article, [data-tag]'))
            .slice(0, 20)
            .map((el) => `${el.tagName}.${(el.className || '').slice(0, 30)}.${el.getAttribute('data-tag') || ''}`)
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
        } catch (e) {
            console.warn('[MOTM] paste POST failed', e.message);
        }
    }

    async function catchUpAll() {
        const token = getToken();
        if (!token) return;
        let queue;
        try {
            queue = await apiGet(ENDPOINTS.awaitingPaste, token);
        } catch (e) {
            console.error('[MOTM] catch-up: could not fetch queue', e.message);
            return;
        }
        const items = queue.items || [];
        console.info(`[MOTM] catch-up: ${items.length} rows`);
        for (const row of items) {
            try {
                // Same-origin fetch — uses Trevor's logged-in cookies, his fingerprint.
                const resp = await fetch(row.post_url, { credentials: 'include' });
                if (!resp.ok) {
                    console.warn(`[MOTM] catch-up: ${row.post_url} returned ${resp.status}`);
                    continue;
                }
                const html = await resp.text();
                const doc = new DOMParser().parseFromString(html, 'text/html');
                const extract = extractFromDoc(doc);
                if (!extract) {
                    console.warn(`[MOTM] catch-up: extractor failed for ${row.post_url}`);
                    reportFailure(token, row.post_url, doc, EXTRACTORS.map((e) => e.name));
                    continue;
                }
                await apiPost(ENDPOINTS.paste(row.id), token, { raw_text: extract.text });
                console.info(`[MOTM] catch-up: ingested ${row.id}`);
            } catch (e) {
                console.warn(`[MOTM] catch-up: error on ${row.post_url}`, e.message);
            }
            await sleep(CATCH_UP_DELAY_MS);
        }
        console.info('[MOTM] catch-up complete');
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

    console.info('[MOTM] userscript v1.0.0 loaded');
})();
