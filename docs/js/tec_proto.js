// tec_proto.js — Protobuf wire-format parser/serializer for PCMTec TEC/BIN files
// Port of tec_proto.py

'use strict';

const VARINT = 0;
const FIXED64 = 1;
const LENGTH_DELIMITED = 2;
const GROUP_START = 3;
const GROUP_END = 4;
const FIXED32 = 5;

const MAX_VARINT_BYTES = 10;

function makeTag(fieldId, wireType) {
    return ((fieldId >>> 0) << 3) | (wireType & 7);
}

// Encode a non-negative integer as protobuf varint, returns Uint8Array
function encodeVarint(value) {
    // Treat as unsigned 64-bit
    let v = (typeof value === 'bigint') ? value : BigInt(Math.floor(value < 0 ? value + 2**64 : value));
    if (v < 0n) v += (1n << 64n);
    if (v < 128n) return new Uint8Array([Number(v)]);
    const out = [];
    while (v > 0n) {
        const b = Number(v & 0x7Fn);
        v >>= 7n;
        if (v > 0n) out.push(b | 0x80);
        else out.push(b);
    }
    return new Uint8Array(out);
}

// Decode varint from DataView or Uint8Array at pos, returns [value_as_number, newPos]
// For values > 2^53, may lose precision; use decodeVarintBig for full 64-bit
function decodeVarint(buf, pos = 0, end = null) {
    const data = buf instanceof DataView ? null : buf;
    const dv = buf instanceof DataView ? buf : new DataView(buf.buffer, buf.byteOffset, buf.byteLength);
    const len = dv.byteLength;
    if (end === null) end = len;
    else end = Math.min(end, len);

    if (pos < 0 || pos >= end) throw new Error('truncated varint');

    let b0 = dv.getUint8(pos++);
    if ((b0 & 0x80) === 0) return [b0, pos];

    let result = BigInt(b0 & 0x7F);
    let shift = 7n;
    let byteCount = 1;

    while (pos < end) {
        const b = dv.getUint8(pos++);
        byteCount++;
        if (byteCount > MAX_VARINT_BYTES) throw new Error('varint too long / corrupt');
        result |= BigInt(b & 0x7F) << shift;
        if ((b & 0x80) === 0) return [Number(result), pos];
        shift += 7n;
    }
    throw new Error('truncated varint');
}

class ProtoField {
    constructor(fieldId, wireType) {
        this.field_id = fieldId;
        this.wire_type = wireType;
        this.value = null;       // for VARINT/FIXED32/FIXED64
        this.payload = null;     // Uint8Array for LENGTH_DELIMITED
        this.children = [];      // for GROUP_START
        this.raw_bytes = null;   // raw bytes for FIXED32/FIXED64
    }

    setBytes(b) {
        this.value = null;
        this.payload = b instanceof Uint8Array ? b : new Uint8Array(b);
        this.raw_bytes = null;
        this.children = [];
    }

    setString(s, encoding = 'utf-8') {
        this.setBytes(new TextEncoder().encode(s));
    }

    setVarint(v) {
        this.value = v;
        this.payload = null;
        this.raw_bytes = null;
        this.children = [];
    }

    setFloat32(f) {
        this.value = f;
        const buf = new ArrayBuffer(4);
        new DataView(buf).setFloat32(0, f, true);
        this.raw_bytes = new Uint8Array(buf);
        this.payload = null;
        this.children = [];
    }

    setFloat64(f) {
        this.value = f;
        const buf = new ArrayBuffer(8);
        new DataView(buf).setFloat64(0, f, true);
        this.raw_bytes = new Uint8Array(buf);
        this.payload = null;
        this.children = [];
    }
}

class ProtoParser {
    constructor(data) {
        if (data instanceof ArrayBuffer) {
            this.data = new Uint8Array(data);
        } else if (data instanceof Uint8Array) {
            this.data = data;
        } else {
            this.data = new Uint8Array(data);
        }
        this.dv = new DataView(this.data.buffer, this.data.byteOffset, this.data.byteLength);
    }

    // Returns [fields, endPos]
    parseFields(start = 0, end = null, untilEndGroupId = null) {
        const len = this.data.length;
        if (end === null) end = len;
        else end = Math.min(end, len);

        const fields = [];
        let pos = start;

        while (pos < end) {
            let tag, pos2;
            try {
                [tag, pos2] = decodeVarint(this.data, pos, end);
            } catch (e) {
                throw new Error(`Invalid tag at pos ${pos}: ${e.message}`);
            }
            pos = pos2;

            const fieldId = tag >>> 3;
            const wireType = tag & 7;

            if (fieldId <= 0) throw new Error(`Invalid field id 0 at pos ${pos}`);

            if (wireType === GROUP_END) {
                if (untilEndGroupId === null) throw new Error(`Unexpected end-group for field ${fieldId} at pos ${pos}`);
                if (fieldId === untilEndGroupId) return [fields, pos];
                throw new Error(`Mismatched end-group: expected ${untilEndGroupId}, got ${fieldId}`);
            }

            const f = new ProtoField(fieldId, wireType);

            if (wireType === VARINT) {
                let v;
                [v, pos] = decodeVarint(this.data, pos, end);
                f.value = v;
                fields.push(f);

            } else if (wireType === FIXED64) {
                if (pos + 8 > end) throw new Error('truncated fixed64');
                f.raw_bytes = this.data.slice(pos, pos + 8);
                f.value = this.dv.getFloat64(pos, true);
                pos += 8;
                fields.push(f);

            } else if (wireType === LENGTH_DELIMITED) {
                let ln;
                [ln, pos] = decodeVarint(this.data, pos, end);
                if (pos + ln > end) throw new Error('truncated length-delimited payload');
                f.payload = this.data.slice(pos, pos + ln);
                pos += ln;
                fields.push(f);

            } else if (wireType === FIXED32) {
                if (pos + 4 > end) throw new Error('truncated fixed32');
                f.raw_bytes = this.data.slice(pos, pos + 4);
                f.value = this.dv.getFloat32(pos, true);
                pos += 4;
                fields.push(f);

            } else if (wireType === GROUP_START) {
                let childFields;
                [childFields, pos] = this.parseFields(pos, end, fieldId);
                f.children = childFields;
                fields.push(f);

            } else {
                throw new Error(`Unsupported wire type ${wireType} at pos ${pos} (field ${fieldId})`);
            }
        }

        if (untilEndGroupId !== null) throw new Error(`Missing end-group for field ${untilEndGroupId}`);
        return [fields, pos];
    }
}

function _serializeFieldsInto(out, fields) {
    for (const f of fields) {
        const fid = f.field_id;
        const wt = f.wire_type;

        if (wt === GROUP_END) continue;

        const tagBytes = encodeVarint(makeTag(fid, wt));
        for (const b of tagBytes) out.push(b);

        if (wt === VARINT) {
            const vBytes = encodeVarint(f.value || 0);
            for (const b of vBytes) out.push(b);

        } else if (wt === FIXED64) {
            let raw = f.raw_bytes;
            if (!raw || raw.length !== 8) {
                const buf = new ArrayBuffer(8);
                new DataView(buf).setFloat64(0, f.value || 0.0, true);
                raw = new Uint8Array(buf);
            }
            for (const b of raw) out.push(b);

        } else if (wt === LENGTH_DELIMITED) {
            const payload = f.payload || new Uint8Array(0);
            const lenBytes = encodeVarint(payload.length);
            for (const b of lenBytes) out.push(b);
            for (const b of payload) out.push(b);

        } else if (wt === FIXED32) {
            let raw = f.raw_bytes;
            if (!raw || raw.length !== 4) {
                const buf = new ArrayBuffer(4);
                new DataView(buf).setFloat32(0, f.value || 0.0, true);
                raw = new Uint8Array(buf);
            }
            for (const b of raw) out.push(b);

        } else if (wt === GROUP_START) {
            _serializeFieldsInto(out, f.children || []);
            const endTag = encodeVarint(makeTag(fid, GROUP_END));
            for (const b of endTag) out.push(b);
        }
    }
}

function serializeFields(fields) {
    const out = [];
    _serializeFieldsInto(out, fields);
    return new Uint8Array(out);
}

function findFields(fields, fieldId) {
    return fields.filter(f => f.field_id === fieldId);
}

function findField(fields, fieldId) {
    return fields.find(f => f.field_id === fieldId) || null;
}

function buildVarintField(fieldId, value) {
    const f = new ProtoField(fieldId, VARINT);
    f.value = value;
    return f;
}

function buildFloat32Field(fieldId, value) {
    const f = new ProtoField(fieldId, FIXED32);
    f.setFloat32(value);
    return f;
}

function buildStringField(fieldId, s) {
    const f = new ProtoField(fieldId, LENGTH_DELIMITED);
    f.setString(s);
    return f;
}
