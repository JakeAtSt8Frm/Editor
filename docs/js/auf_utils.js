// auf_utils.js — auF ID normalization helpers
// Port of auf_utils.py

'use strict';

const _AUF_ID_RE = /\bauf[\s_-]*0*(\d+)\b/gi;
const _BARE_DIGITS_RE = /^0*(\d+)$/;

function normalizeAufId(value) {
    if (value == null) return null;
    const s = String(value).trim();
    if (!s) return null;

    const m = /\bauf[\s_-]*0*(\d+)\b/i.exec(s);
    if (m) return `auF${parseInt(m[1], 10)}`;

    const m2 = _BARE_DIGITS_RE.exec(s);
    if (m2) return `auF${parseInt(m2[1], 10)}`;

    return null;
}

function extractAufIds(text) {
    const seen = new Set();
    const result = [];
    const re = new RegExp(_AUF_ID_RE.source, 'gi');
    let m;
    while ((m = re.exec(text)) !== null) {
        const canon = `auF${parseInt(m[1], 10)}`;
        if (!seen.has(canon)) {
            seen.add(canon);
            result.push(canon);
        }
    }
    return result;
}

function parseIntLike(value) {
    if (value == null) return null;
    if (typeof value === 'number' && Number.isFinite(value) && Number.isInteger(value)) return value;
    if (typeof value === 'number' && Number.isFinite(value) && value === Math.round(value)) return Math.round(value);
    const s = String(value).trim();
    if (!s) return null;
    try {
        if (s.startsWith('0x') || s.startsWith('0X')) return parseInt(s, 16);
        if (s.startsWith('0b') || s.startsWith('0B')) return parseInt(s, 2);
        const n = parseInt(s, 10);
        if (!isNaN(n)) return n;
    } catch (e) {}
    const f = parseFloat(s);
    if (!isNaN(f) && isFinite(f) && f === Math.floor(f)) return Math.floor(f);
    return null;
}
