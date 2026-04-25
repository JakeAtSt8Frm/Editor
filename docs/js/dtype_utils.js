// dtype_utils.js — Data type normalization utilities
// Port of dtype_utils.py

'use strict';

const _DT_BITS = {
    'int8': 8, 'uint8': 8,
    'int16': 16, 'uint16': 16,
    'int32': 32, 'uint32': 32,
    'int64': 64, 'uint64': 64,
    'float32': 32, 'float64': 64,
};

const _INT_RANGES = {
    'int8':   [-128, 127],
    'uint8':  [0, 255],
    'int16':  [-32768, 32767],
    'uint16': [0, 65535],
    'int32':  [-2147483648, 2147483647],
    'uint32': [0, 4294967295],
    'int64':  [-9223372036854775808n, 9223372036854775807n],
    'uint64': [0n, 18446744073709551615n],
};

function normalizeDtype(rawDtype) {
    if (!rawDtype) return '';
    const raw = String(rawDtype).trim().toLowerCase();
    if (!raw) return '';

    let prefix = '';
    if (raw.includes(':')) prefix = raw.split(':')[0].trim();
    const parts = raw.split(/[:\.]/);
    const tail = parts[parts.length - 1];
    const compactTail = tail.replace(/[^a-z0-9]+/g, '');
    const compactFull = raw.replace(/[^a-z0-9]+/g, '');
    const candidates = [compactTail, compactFull];

    if (candidates.some(c => c === 'double' || c === 'float64')) return 'float64';
    if (candidates.some(c => ['single','float','float32','real','decimal'].includes(c))) return 'float32';

    if (compactTail === 'unsignedbyte') return 'uint8';
    if (compactTail === 'byte') return ['xsd','xs'].includes(prefix) ? 'int8' : 'uint8';

    if (candidates.some(c => c === 'sbyte' || c === 'int8')) return 'int8';
    if (candidates.some(c => ['byte','ubyte','uint8','unsignedbyte','char'].includes(c))) return 'uint8';

    if (candidates.some(c => ['ushort','uint16','unsignedshort'].includes(c))) return 'uint16';
    if (candidates.some(c => c === 'short' || c === 'int16')) return 'int16';

    if (candidates.some(c => ['uint64','ulong','unsignedlong'].includes(c))) return 'uint64';
    if (candidates.some(c => c === 'int64' || c === 'long')) return 'int64';

    if (candidates.some(c => ['uint32','uint','unsignedint'].includes(c))) return 'uint32';
    if (candidates.some(c => ['int32','int','integer'].includes(c))) return 'int32';

    if (compactFull.includes('uint16')) return 'uint16';
    if (compactFull.includes('int16')) return 'int16';
    if (compactFull.includes('uint8')) return 'uint8';
    if (compactFull.includes('int8')) return 'int8';
    if (compactFull.includes('single') || compactFull.includes('float32')) return 'float32';
    if (compactFull.includes('float64')) return 'float64';
    return '';
}

function dtypeBits(rawDtype) {
    return _DT_BITS[normalizeDtype(rawDtype)] || null;
}

function dtypeBytes(rawDtype) {
    const bits = dtypeBits(rawDtype);
    return bits ? bits / 8 : null;
}

function dtypeIsFloat(rawDtype) {
    return ['float32', 'float64'].includes(normalizeDtype(rawDtype));
}

function dtypeIsInteger(rawDtype) {
    return normalizeDtype(rawDtype) in _INT_RANGES;
}

function dtypeIsSignedInt(rawDtype) {
    return ['int8', 'int16', 'int32', 'int64'].includes(normalizeDtype(rawDtype));
}

function dtypeRange(rawDtype) {
    return _INT_RANGES[normalizeDtype(rawDtype)] || null;
}

function clampSemanticInt(value, rawDtype) {
    const rng = dtypeRange(rawDtype);
    if (!rng) return Math.round(value);
    const [lo, hi] = rng;
    if (typeof lo === 'bigint') {
        const v = BigInt(Math.round(value));
        return Number(v < lo ? lo : v > hi ? hi : v);
    }
    return Math.max(lo, Math.min(hi, Math.round(value)));
}

function semanticIntToStorage(value, rawDtype) {
    const canon = normalizeDtype(rawDtype);
    const clamped = clampSemanticInt(value, canon);
    if (!canon || !(canon in _INT_RANGES)) return Math.round(clamped);
    const bits = _DT_BITS[canon];
    const mask = (1 << bits) - 1;
    if (bits <= 32) return (Math.round(clamped) & mask) >>> 0;
    // For 64-bit, use BigInt
    const bigV = BigInt(Math.round(clamped));
    return Number(bigV & ((1n << BigInt(bits)) - 1n));
}

// Convert raw unsigned storage integer to signed semantic value
function storageIntToSemantic(rawInt, rawDtype) {
    const canon = normalizeDtype(rawDtype);
    const bits = dtypeBits(canon);
    if (!bits) return rawInt;
    const raw = rawInt & ((1 << bits) - 1);
    if (dtypeIsSignedInt(canon)) {
        const signBit = 1 << (bits - 1);
        if (raw & signBit) return raw - (1 << bits);
    }
    return raw;
}
