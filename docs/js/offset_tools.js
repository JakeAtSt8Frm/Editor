// offset_tools.js — Offset Discovery Algorithms
// Ported from offset_discovery_tools.py (the non-Tkinter algorithm core).
// UI is built in app.js; this module just exposes pure functions.

'use strict';

// ── Byte search ───────────────────────────────────────────────────────────────

// Find up to maxHits occurrences of `needle` in `blob`. When step > 1, only
// scan offsets aligned to step.
function findAllHits(blob, needle, maxHits = 500, step = 1) {
    if (!needle || !needle.length) return [];
    step = Math.max(1, step | 0);
    maxHits = Math.max(1, maxHits | 0);
    const hits = [];
    const nLen = needle.length;
    const maxPos = blob.length - nLen;
    if (maxPos < 0) return [];

    if (step === 1) {
        // Use indexOf-style scan via a tight byte loop.
        let pos = 0;
        outer: while (pos <= maxPos) {
            // Find next match of needle[0]
            while (pos <= maxPos && blob[pos] !== needle[0]) pos++;
            if (pos > maxPos) break;
            // Compare full needle
            let match = true;
            for (let k = 1; k < nLen; k++) {
                if (blob[pos + k] !== needle[k]) { match = false; break; }
            }
            if (match) {
                hits.push(pos);
                if (hits.length >= maxHits) return hits;
            }
            pos++;
        }
        return hits;
    }

    // Aligned scan
    for (let pos = 0; pos <= maxPos; pos += step) {
        let match = true;
        for (let k = 0; k < nLen; k++) {
            if (blob[pos + k] !== needle[k]) { match = false; break; }
        }
        if (match) {
            hits.push(pos);
            if (hits.length >= maxHits) break;
        }
    }
    return hits;
}

function bytesEqualAt(blob, offset, needle) {
    if (offset < 0 || offset + needle.length > blob.length) return false;
    for (let k = 0; k < needle.length; k++) {
        if (blob[offset + k] !== needle[k]) return false;
    }
    return true;
}

// Find offsets where curPayload appears in curBlob AND stockPayload at the
// same offset in stockBlob.
function findDualMatchOffsets(curBlob, stockBlob, curPayload, stockPayload, maxHits = 500, step = 1) {
    if (!curPayload || !stockPayload || !curPayload.length || !stockPayload.length) return [];
    step = Math.max(1, step | 0);
    const useCurAnchor = curPayload.length <= stockPayload.length;
    const anchorBlob = useCurAnchor ? curBlob : stockBlob;
    const anchorPL   = useCurAnchor ? curPayload : stockPayload;
    const otherBlob  = useCurAnchor ? stockBlob : curBlob;
    const otherPL    = useCurAnchor ? stockPayload : curPayload;

    const hits = [];
    const candidates = findAllHits(anchorBlob, anchorPL, Math.max(maxHits * 4, 64), step);
    for (const pos of candidates) {
        if (bytesEqualAt(otherBlob, pos, otherPL)) {
            hits.push(pos);
            if (hits.length >= maxHits) break;
        }
    }
    return hits;
}

// ── Range utilities ───────────────────────────────────────────────────────────

function diffRangesInclusive(a, b, minRun = 1) {
    const n = Math.min(a.length, b.length);
    const out = [];
    let i = 0;
    while (i < n) {
        if (a[i] === b[i]) { i++; continue; }
        const start = i;
        i++;
        while (i < n && a[i] !== b[i]) i++;
        const end = i - 1;
        if (end - start + 1 >= Math.max(1, minRun)) out.push([start, end]);
    }
    if (a.length !== b.length) {
        const tailStart = n;
        const tailEnd = Math.max(a.length, b.length) - 1;
        if (tailEnd >= tailStart && (tailEnd - tailStart + 1) >= Math.max(1, minRun)) {
            out.push([tailStart, tailEnd]);
        }
    }
    return out;
}

function windowOverlapsRanges(off, width, ranges) {
    if (width <= 0 || !ranges || !ranges.length) return false;
    const end = off + width - 1;
    for (const [s, e] of ranges) {
        if (off <= e && s <= end) return true;
    }
    return false;
}

// ── Signature windows ─────────────────────────────────────────────────────────

function buildSignatureWindows(data, minLen = 6, maxWindows = 12) {
    if (!data || !data.length) return [];
    const ln = data.length;
    if (ln <= minLen) return [[0, data, 'full']];

    const sizes = new Set([ln]);
    for (const denom of [2, 3, 4]) sizes.add(Math.max(minLen, (ln / denom) | 0));
    sizes.add(Math.max(minLen, (ln * 3 / 4) | 0));

    const sortedSizes = [...sizes].sort((a, b) => b - a);
    const windows = [];
    const seenPos = new Set();
    const seenContent = new Set();

    for (const size of sortedSizes) {
        if (size <= 0 || size > ln) continue;
        const starts = [
            0,
            Math.max(0, ln - size),
            Math.max(0, ((ln - size) / 2) | 0),
            Math.max(0, Math.min(ln - size, (ln / 4) | 0)),
            Math.max(0, Math.min(ln - size, (ln * 3 / 4 - size + 1) | 0)),
        ];
        for (const start of starts) {
            const key = `${start}:${size}`;
            if (seenPos.has(key)) continue;
            seenPos.add(key);
            const chunk = data.slice(start, start + size);
            if (!chunk.length) continue;
            const ck = Array.from(chunk).join(',');
            if (seenContent.has(ck)) continue;
            seenContent.add(ck);
            const label = size === ln ? 'full' : `slice@${start}+${size}`;
            windows.push([start, chunk, label]);
            if (windows.length >= maxWindows) return windows;
        }
    }
    return windows;
}

// ── Candidate ranking ─────────────────────────────────────────────────────────

function confidenceLabel(score, curVerified, stockVerified) {
    if (score >= 48 && curVerified && stockVerified) return 'Very High';
    if (score >= 36 && (curVerified || stockVerified)) return 'High';
    if (score >= 24) return 'Medium';
    return 'Low';
}

function rankOffsetCandidates(curBlob, stockBlob, curBytes, stockBytes, opts = {}) {
    curBytes = curBytes || new Uint8Array(0);
    stockBytes = stockBytes || new Uint8Array(0);
    if (!curBytes.length && !stockBytes.length) return [];

    const maxHits = opts.maxHits || 200;
    const maxCandidates = opts.maxCandidates || 8;
    const diffRanges = opts.diffRanges || [];
    const scanStep = Math.max(1, opts.scanStep || 1);

    const changed = curBytes.length && stockBytes.length &&
        !arraysEqual(curBytes, stockBytes);
    let pairHits = [];
    let pairUniqueOffset = null;
    if (changed) {
        pairHits = findDualMatchOffsets(curBlob, stockBlob, curBytes, stockBytes,
            Math.max(3, maxCandidates + 1), scanStep);
        if (pairHits.length === 1) pairUniqueOffset = pairHits[0];
    }

    const candidates = new Map();

    function ensureNode(off) {
        let node = candidates.get(off);
        if (!node) {
            node = {
                offset: off, score: 0, reasons: new Set(),
                cur_verified: false, stock_verified: false,
                diff_overlap: false, unique_pair: false,
                pair_match_count: 0,
            };
            candidates.set(off, node);
        }
        return node;
    }

    function addPoints(off, points, reason, curOk, stockOk) {
        if (off < 0) return;
        const node = ensureNode(off);
        node.score += points | 0;
        node.reasons.add(reason);
        if (curOk === true) node.cur_verified = true;
        if (stockOk === true) node.stock_verified = true;
    }

    function crossVerify(off) {
        const curOk = curBytes.length ? bytesEqualAt(curBlob, off, curBytes) : false;
        const stockOk = stockBytes.length ? bytesEqualAt(stockBlob, off, stockBytes) : false;
        return [curOk, stockOk];
    }

    function scanFull(blob, payload, source) {
        if (!payload.length) return;
        const hits = findAllHits(blob, payload, maxHits, scanStep);
        if (!hits.length) return;
        const unique = hits.length === 1;
        const densePenalty = Math.min(8, Math.max(0, hits.length - 1));
        for (const off of hits) {
            const [curOk, stockOk] = crossVerify(off);
            if (source === 'stock') {
                let base = unique ? 22 : (14 - densePenalty);
                if (curOk) base += 14;
                else if (changed) base -= 4;
                addPoints(off, base, `stock full hit (${hits.length}x)`, curOk, stockOk);
            } else {
                let base = unique ? 20 : (12 - densePenalty);
                if (stockOk) base += 12;
                else if (changed) base -= 3;
                addPoints(off, base, `current full hit (${hits.length}x)`, curOk, stockOk);
            }
        }
    }

    function scanSlices(blob, payload, source) {
        if (!payload.length || payload.length < 6) return;
        const minLen = Math.max(6, Math.min(16, (payload.length / 3) | 0));
        const windows = buildSignatureWindows(payload, minLen, 12);
        for (const [relOff, sig, label] of windows) {
            const hits = findAllHits(blob, sig, maxHits, 1);
            if (!hits.length) continue;
            if (hits.length > 32) continue;
            const unique = hits.length === 1;
            for (const hit of hits) {
                const cand = hit - relOff;
                if (cand < 0) continue;
                if (scanStep > 1 && (cand % scanStep) !== 0) continue;
                if (cand + payload.length > blob.length) continue;
                if (!bytesEqualAt(blob, cand, payload)) continue;
                const [curOk, stockOk] = crossVerify(cand);
                let pts = unique ? 8 : 5;
                if (curOk && stockOk) pts += 4;
                addPoints(cand, pts, `${source} ${label} (${hits.length}x)`, curOk, stockOk);
            }
        }
    }

    scanFull(stockBlob, stockBytes, 'stock');
    scanFull(curBlob, curBytes, 'current');
    scanSlices(stockBlob, stockBytes, 'stock-slice');
    scanSlices(curBlob, curBytes, 'current-slice');

    if (!candidates.size) return [];

    const maxWidth = Math.max(curBytes.length, stockBytes.length, 1);
    for (const node of candidates.values()) {
        const off = node.offset;
        if (node.cur_verified && node.stock_verified) {
            node.score += 10;
            node.reasons.add('both current/stock verified');
            if (pairUniqueOffset !== null && off === pairUniqueOffset) {
                node.score += 18;
                node.unique_pair = true;
                node.reasons.add('unique current+stock pair match');
            } else if (pairHits.length > 1) {
                node.score += 2;
                node.reasons.add('current+stock pair match (non-unique)');
            }
        }
        node.pair_match_count = pairHits.length;
        if (changed && diffRanges.length && windowOverlapsRanges(off, maxWidth, diffRanges)) {
            node.score += 8;
            node.diff_overlap = true;
            node.reasons.add('overlaps changed blob region');
        } else if (changed && diffRanges.length) {
            node.score -= 6;
            node.reasons.add('outside changed blob region');
        }
    }

    const ranked = [...candidates.values()].sort((a, b) => {
        if (b.score !== a.score) return b.score - a.score;
        const va = (a.cur_verified ? 1 : 0) + (a.stock_verified ? 1 : 0);
        const vb = (b.cur_verified ? 1 : 0) + (b.stock_verified ? 1 : 0);
        if (vb !== va) return vb - va;
        return b.offset - a.offset;
    });

    return ranked.slice(0, maxCandidates).map(node => ({
        offset: node.offset,
        offset_hex: '0x' + node.offset.toString(16).toUpperCase(),
        score: node.score,
        confidence: confidenceLabel(node.score, node.cur_verified, node.stock_verified),
        cur_verified: node.cur_verified,
        stock_verified: node.stock_verified,
        unique_pair: node.unique_pair,
        pair_match_count: node.pair_match_count,
        diff_overlap: node.diff_overlap,
        reason: [...node.reasons].slice(0, 5).join('; '),
        evidence: [...node.reasons],
    }));
}

function arraysEqual(a, b) {
    if (a.length !== b.length) return false;
    for (let i = 0; i < a.length; i++) if (a[i] !== b[i]) return false;
    return true;
}

// ── Pattern scanner ───────────────────────────────────────────────────────────

// Build encoding candidates for a value-search query (number → little-endian
// representations). Returns [{label, bytes, bits}, ...].
function buildSearchEncodings(valueStr, searchType = 'all') {
    const out = [];
    const trimmed = (valueStr || '').trim();
    if (!trimmed) return out;

    // Hex bytes (e.g. "DE AD BE EF" or "0xDEADBEEF")
    if (searchType === 'all' || searchType === 'hex') {
        const cleaned = trimmed.replace(/^0x/i, '').replace(/[\s,_]/g, '');
        if (/^[0-9a-fA-F]+$/.test(cleaned) && cleaned.length % 2 === 0 && cleaned.length >= 2) {
            const bytes = new Uint8Array(cleaned.length / 2);
            for (let i = 0; i < cleaned.length; i += 2) {
                bytes[i / 2] = parseInt(cleaned.slice(i, i + 2), 16);
            }
            out.push({ label: `hex bytes (${bytes.length})`, bytes, bits: bytes.length * 8 });
        }
    }

    const num = parseFloat(trimmed);
    if (!isNaN(num) && isFinite(num)) {
        if (searchType === 'all' || searchType === 'int' || searchType === 'integer') {
            const intVal = Math.round(num);
            for (const bits of [8, 16, 32]) {
                for (const signed of [false, true]) {
                    if (signed && intVal >= 0) continue;
                    if (!signed && intVal < 0) continue;
                    const bytes = packIntLE(intVal, bits, signed);
                    if (bytes) out.push({
                        label: `${signed ? 'i' : 'u'}${bits} LE`,
                        bytes, bits,
                    });
                }
            }
        }
        if (searchType === 'all' || searchType === 'float') {
            const buf32 = new ArrayBuffer(4);
            new DataView(buf32).setFloat32(0, num, true);
            out.push({ label: 'float32 LE', bytes: new Uint8Array(buf32), bits: 32 });
            const buf64 = new ArrayBuffer(8);
            new DataView(buf64).setFloat64(0, num, true);
            out.push({ label: 'float64 LE', bytes: new Uint8Array(buf64), bits: 64 });
        }
    }

    // String bytes
    if (searchType === 'all' || searchType === 'string' || searchType === 'ascii') {
        const enc = new TextEncoder().encode(trimmed);
        if (enc.length) out.push({ label: `ascii (${enc.length})`, bytes: enc, bits: enc.length * 8 });
    }

    return out;
}

function packIntLE(value, bits, signed) {
    const buf = new ArrayBuffer(bits / 8);
    const dv = new DataView(buf);
    try {
        if (bits === 8) signed ? dv.setInt8(0, value) : dv.setUint8(0, value);
        else if (bits === 16) signed ? dv.setInt16(0, value, true) : dv.setUint16(0, value, true);
        else if (bits === 32) signed ? dv.setInt32(0, value, true) : dv.setUint32(0, value >>> 0, true);
        else return null;
    } catch (e) { return null; }
    return new Uint8Array(buf);
}

// ── Hex viewer rendering helper ───────────────────────────────────────────────

function renderHexLines(data, baseOffset = 0, bytesPerLine = 16, maxBytes = 65536) {
    const limit = Math.min(data.length, maxBytes);
    const lines = [];
    for (let i = 0; i < limit; i += bytesPerLine) {
        const chunk = data.subarray(i, Math.min(i + bytesPerLine, limit));
        const offset = (baseOffset + i).toString(16).padStart(8, '0');
        const hex = Array.from(chunk)
            .map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(chunk)
            .map(b => (b >= 32 && b < 127) ? String.fromCharCode(b) : '.').join('');
        lines.push(`${offset}  ${hex.padEnd(bytesPerLine * 3 - 1)}  ${ascii}`);
    }
    if (data.length > maxBytes) lines.push(`... (${data.length - maxBytes} more bytes)`);
    return lines;
}

// Expose globally
window.OffsetTools = {
    findAllHits,
    findDualMatchOffsets,
    bytesEqualAt,
    diffRangesInclusive,
    windowOverlapsRanges,
    buildSignatureWindows,
    rankOffsetCandidates,
    confidenceLabel,
    buildSearchEncodings,
    renderHexLines,
};
