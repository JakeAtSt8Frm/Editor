// tec_model.js — TEC File Data Model
// Port of tec_model.py

'use strict';

// ── AES key/IV (hardcoded as in original) ────────────────────────────────────
const TEC_AES_KEY_HEX = '453698c89124d13e1ee400f55fef1aac';
const TEC_AES_IV_HEX  = '4578a74b4064e1fdc52da6b4a3b3de6f';

function _hexToBytes(hex) {
    const bytes = new Uint8Array(hex.length / 2);
    for (let i = 0; i < hex.length; i += 2)
        bytes[i / 2] = parseInt(hex.slice(i, i + 2), 16);
    return bytes;
}

// ── Import crypto key once ────────────────────────────────────────────────────
let _tecAesKeyPromise = null;
async function _getTecAesKey(usage = ['decrypt']) {
    return crypto.subtle.importKey(
        'raw',
        _hexToBytes(TEC_AES_KEY_HEX),
        { name: 'AES-CBC' },
        false,
        usage.includes('encrypt') ? ['decrypt', 'encrypt'] : ['decrypt', 'encrypt']
    );
}

// ── Decompression ─────────────────────────────────────────────────────────────
async function _decompressGzip(data) {
    const ds = new DecompressionStream('gzip');
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    writer.write(data);
    writer.close();
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

async function _compressGzip(data) {
    const cs = new CompressionStream('gzip');
    const writer = cs.writable.getWriter();
    const reader = cs.readable.getReader();
    writer.write(data);
    writer.close();
    const chunks = [];
    while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
    }
    const total = chunks.reduce((s, c) => s + c.length, 0);
    const out = new Uint8Array(total);
    let off = 0;
    for (const c of chunks) { out.set(c, off); off += c.length; }
    return out;
}

// ── Text decode ───────────────────────────────────────────────────────────────
const _textDecoder = new TextDecoder('utf-8', { fatal: false });
const _textEncoder = new TextEncoder();

function decodeText(payload) {
    if (!payload || payload.length === 0) return '';
    return _textDecoder.decode(payload);
}

// ── Data structures ───────────────────────────────────────────────────────────

class ScalingInfo {
    constructor({ id_code = 0, divisor = 1, multiplier = 1, offset = 0 } = {}) {
        this.id_code = id_code;
        this.divisor = divisor;
        this.multiplier = multiplier;
        this.offset = offset;
    }

    apply(rawInt, dataType = '') {
        const signed = storageIntToSemantic(rawInt, dataType);
        if (this.divisor === 0) return signed + this.offset;
        return (signed * this.multiplier / this.divisor) + this.offset;
    }

    unapply(engValue, dataType = '') {
        let raw;
        if (this.divisor === 0) {
            raw = Math.round(engValue - this.offset);
        } else {
            if (this.multiplier === 0) throw new Error('Cannot invert scaling with zero multiplier');
            raw = Math.round((engValue - this.offset) * this.divisor / this.multiplier);
        }
        const canon = normalizeDtype(dataType);
        if (dtypeIsInteger(canon)) {
            raw = clampSemanticInt(raw, canon);
            return semanticIntToStorage(raw, canon);
        }
        return raw < 0 ? (raw + 4294967296) : raw;
    }

    clone() {
        return new ScalingInfo(this);
    }

    hasTransform() {
        return this.divisor !== 1 || this.multiplier !== 1 || this.offset !== 0;
    }
}

class MathTransformInfo {
    constructor({ id_code = 0, mode = 0, storage_code = 0, coefficients = [] } = {}) {
        this.id_code = id_code;
        this.mode = mode;
        this.storage_code = storage_code;
        this.coefficients = [...coefficients];
    }

    hasMetadata() {
        return !!(this.mode || this.storage_code || this.coefficients.length);
    }

    clone() {
        return new MathTransformInfo({
            id_code: this.id_code,
            mode: this.mode,
            storage_code: this.storage_code,
            coefficients: [...this.coefficients],
        });
    }
}

class FileHeader {
    constructor() {
        this.filename = '';
        this.year = '';
        this.strategy = '';
        this.cpu_code = '';
        this.base_strategy = '';
        this.base_cpu = '';
        this.vin = '';
        this.cpu = '';
        this.serial = '';
        this.pcm_count = 0;
    }
}

class StackTemplateRef {
    constructor() {
        this.column_refs = [];
        this.template_type = 0;
        this.index_mappings = [];
    }
}

const HIDDEN_PREFIXES = ['tec_coeffs', 'EQU'];

function isHiddenParam(aufId, symbol = '', equRef = '') {
    if (!aufId) return false;
    for (const p of HIDDEN_PREFIXES) {
        if (aufId.startsWith(p)) return true;
        if (aufId.startsWith('auF_') && aufId.slice(4).startsWith(p)) return true;
    }
    if (symbol && HIDDEN_PREFIXES.some(p => symbol.startsWith(p))) return true;
    return false;
}

function isCharDtype(dataType = '') {
    const raw = (dataType || '').trim().toLowerCase();
    if (!raw) return false;
    const tail = raw.split(/[:\.]/g).pop();
    return tail === 'char';
}

function hasDisplayScale(scale) {
    const s = parseFloat(scale);
    if (!isFinite(s)) return false;
    return s !== 0.0 && Math.abs(s - 1.0) > 1e-12;
}

function applyDisplayScale(values, displayScale) {
    if (!hasDisplayScale(displayScale)) return [...values];
    const s = parseFloat(displayScale);
    return values.map(v => v / s);
}

function removeDisplayScale(value, displayScale) {
    if (!hasDisplayScale(displayScale)) return value;
    return value * parseFloat(displayScale);
}

function displayValuesFromByteStorage(rawBytes, dataType = '', scaling = null, displayScale = 1.0, isChar = false) {
    const raw = Array.from(rawBytes || []);
    if (!raw.length) return [];
    if (isChar) return raw;

    const canon = normalizeDtype(dataType || '');
    if (canon === 'int8' || canon === 'uint8') {
        let result;
        if (scaling) result = raw.map(v => scaling.apply(v, dataType));
        else result = raw.map(v => storageIntToSemantic(v, dataType));
        if (displayScale !== 1.0 && displayScale !== 0.0)
            return result.map(v => v / displayScale);
        return result;
    }
    if (displayScale !== 1.0 && displayScale !== 0.0)
        return raw.map(v => v / displayScale);
    return raw;
}

class ParameterDef {
    constructor() {
        this.auf_id = '';
        this.category = '';
        this.units = '';
        this.description = '';
        this.data_type = '';
        this.long_description = '';
        this.symbol = '';
        this.group = '';
        this.num_cols = 1;
        this.num_rows = 1;
        this.total_cells = 1;
        this.x_axis_ref = '';
        this.y_axis_ref = '';
        this.axis_units = '';
        this.min_value = 0.0;
        this.max_value = 0.0;
        this.float_values = [];
        this.byte_values = new Uint8Array(0);
        this.int_values = [];
        this.int_scalar_value = null;
        this.format_meta = {};
        this.scaling = null;
        this.field_27 = 0;
        this.field_29 = 0;
        this.scale = 1.0;
        this.field_415 = 0;
        this.field_416 = 0;
        this.field_417_values = [];
        this.math_transform = null;
        this.field_10 = -1;
        this.field_11 = -1;
        this.field_16 = '';
        this.equ_ref = '';
        this.stack_template = null;
        this.display_scale = 1.0;
        this._proto_field = null;
        this._raw_index = -1;
    }

    get is_hidden() { return isHiddenParam(this.auf_id, this.symbol, this.equ_ref); }

    get is_stack_template() {
        return !!(this.stack_template && this.stack_template.column_refs.length > 0);
    }

    get is_scalar() {
        if (this.is_stack_template) return false;
        return this.num_cols <= 1 && this.num_rows <= 1 &&
               this.byte_values.length <= 1 && this.float_values.length <= 1 &&
               this.int_values.length <= 1;
    }

    get is_table() {
        if (this.is_stack_template) return true;
        return this.num_cols > 1 && this.num_rows > 1;
    }

    get is_array() {
        if (this.is_stack_template) return false;
        return (this.num_cols > 1 || this.num_rows > 1) && !this.is_table;
    }

    get is_byte_data() {
        return ['int8','uint8'].includes(normalizeDtype(this.data_type)) || this.byte_values.length > 0;
    }

    get is_int_data() {
        return this.int_values.length > 0 && !this.float_values.length && !this.byte_values.length;
    }

    get is_char() { return isCharDtype(this.data_type); }

    get is_custom_os() {
        const cat = (this.category || '').toLowerCase();
        if (cat.includes('customos') || cat.includes('custom_os')) return true;
        for (const s of [this.auf_id, this.symbol, this.field_16]) {
            const sl = (s || '').toLowerCase();
            if (sl.includes('_struct') && sl.includes('hdfx')) return true;
        }
        return false;
    }

    get display_category() {
        const cat = (this.category || '').trim();
        const catLower = cat.toLowerCase();
        if (!cat || cat === '-' || catLower.includes('unknown') ||
            catLower.includes('unlabeled') || catLower.includes('unlabelled')) return '';
        if (cat === 'CustomOSMultiTune' || this.is_custom_os) return 'CustomOS';
        if (cat === '4') return 'Bits';
        if (cat === '123456') return 'OS Pointers?';
        return cat;
    }

    get display_name() {
        if (this.description) return this.description.slice(0, 80);
        if (this.symbol) return this.symbol;
        return this.auf_id;
    }

    getValues() {
        if (this.byte_values && this.byte_values.length) {
            return displayValuesFromByteStorage(this.byte_values, this.data_type,
                this.scaling, this.display_scale, this.is_char);
        }
        if (this.float_values.length) {
            return applyDisplayScale(this.float_values.map(v => parseFloat(v)), this.display_scale);
        }
        if (this.int_values.length) {
            const canon = normalizeDtype(this.data_type);
            if (dtypeIsFloat(canon) && !this.scaling) {
                const dv = new DataView(new ArrayBuffer(8));
                const result = this.int_values.map(v => {
                    if (canon === 'float64') {
                        dv.setBigUint64(0, BigInt(v) & 0xFFFFFFFFFFFFFFFFn, true);
                        return dv.getFloat64(0, true);
                    } else {
                        dv.setUint32(0, v >>> 0, true);
                        return dv.getFloat32(0, true);
                    }
                });
                return applyDisplayScale(result, this.display_scale);
            }
            if (this.scaling) {
                return applyDisplayScale(
                    this.int_values.map(v => this.scaling.apply(v, this.data_type)),
                    this.display_scale
                );
            }
            const result = this.int_values.map(v => storageIntToSemantic(v, this.data_type));
            return applyDisplayScale(result, this.display_scale);
        }
        return [];
    }

    getScalarValue() {
        const vals = this.getValues();
        return vals.length ? vals[0] : 0.0;
    }

    getCharString() {
        if (!this.byte_values || !this.byte_values.length) return '';
        return Array.from(this.byte_values).map(b => {
            if (b >= 32 && b < 127) return String.fromCharCode(b);
            if (b === 0) return '\0';
            return `\\x${b.toString(16).padStart(2, '0')}`;
        }).join('');
    }
}

class StockDef {
    constructor() {
        this.auf_id = '';
        this.label = '';
        this.symbol = '';
        this.description = '';
        this.units = '';
        this.category = '';
        this.group = '';
        this.float_values = [];
        this.byte_values = new Uint8Array(0);
        this.int_values = [];
        this.scaling = null;
        this.data_type = '';
        this.num_cols = 1;
        this.num_rows = 1;
        this.scale = 1.0;
        this.display_scale = 1.0;
        this.math_transform = null;
        this.x_axis_ref = '';
        this.y_axis_ref = '';
        this.equ_ref = '';
        this.long_description = '';
        this.stack_template = null;
        this.int_scalar_value = null;
        this.min_value = 0.0;
        this.max_value = 0.0;
        this._proto_field = null;
    }

    get is_hidden() { return isHiddenParam(this.auf_id, this.label); }
    get is_stack_template() {
        return !!(this.stack_template && this.stack_template.column_refs.length > 0);
    }
    get is_scalar() {
        if (this.is_stack_template) return false;
        return this.num_cols <= 1 && this.num_rows <= 1 &&
               this.byte_values.length <= 1 && this.float_values.length <= 1 &&
               this.int_values.length <= 1;
    }
    get is_table() { return this.is_stack_template || (this.num_cols > 1 && this.num_rows > 1); }
    get is_array() {
        if (this.is_stack_template) return false;
        return (this.num_cols > 1 || this.num_rows > 1) && !this.is_table;
    }
    get is_byte_data() {
        return ['int8','uint8'].includes(normalizeDtype(this.data_type)) || this.byte_values.length > 0;
    }
    get is_int_data() {
        return this.int_values.length > 0 && !this.float_values.length && !this.byte_values.length;
    }
    get is_char() { return isCharDtype(this.data_type); }
    get is_custom_os() {
        const cat = (this.category || '').toLowerCase();
        return cat.includes('customos') || cat.includes('custom_os');
    }
    get display_category() {
        const cat = (this.category || '').trim();
        const catLower = cat.toLowerCase();
        if (!cat || cat === '-' || catLower.includes('unknown') ||
            catLower.includes('unlabeled') || catLower.includes('unlabelled')) return '';
        if (cat === 'CustomOSMultiTune' || this.is_custom_os) return 'CustomOS';
        if (cat === '4') return 'Bits';
        if (cat === '123456') return 'OS Pointers?';
        return cat;
    }
    get display_name() {
        if (this.description) return this.description.slice(0, 80);
        if (this.symbol) return this.symbol;
        if (this.label) return this.label;
        return this.auf_id;
    }

    getValues() {
        if (this.byte_values && this.byte_values.length) {
            return displayValuesFromByteStorage(this.byte_values, this.data_type,
                this.scaling, this.display_scale, this.is_char);
        }
        if (this.float_values.length) {
            return applyDisplayScale(this.float_values.map(v => parseFloat(v)), this.display_scale);
        }
        if (this.int_values.length) {
            const canon = normalizeDtype(this.data_type);
            if (this.scaling) {
                return applyDisplayScale(
                    this.int_values.map(v => this.scaling.apply(v, this.data_type)),
                    this.display_scale
                );
            }
            if (dtypeIsFloat(canon)) {
                const dv = new DataView(new ArrayBuffer(8));
                return this.int_values.map(v => {
                    if (canon === 'float64') {
                        dv.setBigUint64(0, BigInt(v) & 0xFFFFFFFFFFFFFFFFn, true);
                        return dv.getFloat64(0, true);
                    } else {
                        dv.setUint32(0, v >>> 0, true);
                        return dv.getFloat32(0, true);
                    }
                });
            }
            return applyDisplayScale(
                this.int_values.map(v => storageIntToSemantic(v, this.data_type)),
                this.display_scale
            );
        }
        return [];
    }

    getScalarValue() {
        const vals = this.getValues();
        return vals.length ? vals[0] : 0.0;
    }

    getCharString() {
        if (!this.byte_values || !this.byte_values.length) return '';
        return Array.from(this.byte_values).map(b =>
            b >= 32 && b < 127 ? String.fromCharCode(b) : b === 0 ? '\0' : `\\x${b.toString(16).padStart(2, '0')}`
        ).join('');
    }
}

class TecFile {
    constructor() {
        this.header = new FileHeader();
        this.parameters = {};      // auf_id -> ParameterDef
        this.stock_defs = {};      // auf_id -> StockDef
        this.categories = {};      // category -> [auf_id]
        this.groups = {};          // group -> [auf_id]
        this.param_order = [];
        this._raw_data = null;     // Uint8Array
        this._outer_tag_byte = new Uint8Array(0);
        this._outer_wire_type = LENGTH_DELIMITED;
        this._trailing_bytes = new Uint8Array(0);
        this._inner_fields = [];
        this._tec_header = null;   // Uint8Array, 16 bytes
        this._dirty_params = new Set();
        this.is_tec_file = false;
    }

    getParam(aufId) { return this.parameters[aufId] || null; }
    getStock(aufId) { return this.stock_defs[aufId] || null; }

    getVisibleParams() {
        const visible = [];
        const seen = new Set();
        for (const p of this.param_order) {
            seen.add(p);
            const param = this.parameters[p] || this.stock_defs[p];
            if (param ? !param.is_hidden : !isHiddenParam(p)) visible.push(p);
        }
        for (const [p, param] of Object.entries(this.stock_defs)) {
            if (seen.has(p)) continue;
            if (param && !param.is_hidden && !isHiddenParam(p)) visible.push(p);
        }
        return visible;
    }

    getVisibleCategories() {
        const result = {};
        for (const [cat, ids] of Object.entries(this.categories)) {
            const visible = ids.filter(i => {
                const param = this.parameters[i] || this.stock_defs[i];
                return param ? !param.is_hidden : !isHiddenParam(i);
            });
            if (visible.length) result[cat] = visible;
        }
        return result;
    }

    getVisibleGroups() {
        const result = {};
        for (const [grp, ids] of Object.entries(this.groups)) {
            const visible = ids.filter(i => {
                const param = this.parameters[i] || this.stock_defs[i];
                return param ? !param.is_hidden : !isHiddenParam(i);
            });
            if (visible.length) result[grp] = visible;
        }
        return result;
    }
}

// ── Parsing helpers ───────────────────────────────────────────────────────────

function _findScalingRecursive(fields) {
    for (const f of fields) {
        if (f.field_id === 2200 && f.wire_type === GROUP_START && f.children) {
            const info = new ScalingInfo();
            for (const c of f.children) {
                if (c.wire_type === VARINT) {
                    if (c.field_id === 2201) info.id_code = c.value;
                    else if (c.field_id === 2202) info.divisor = c.value;
                    else if (c.field_id === 2203) info.multiplier = c.value;
                    else if (c.field_id === 2204) info.offset = c.value;
                }
            }
            return info;
        }
        if (f.wire_type === GROUP_START && f.children) {
            const result = _findScalingRecursive(f.children);
            if (result) return result;
        }
    }
    return null;
}

function _findMathTransformRecursive(fields) {
    for (const f of fields) {
        if (f.field_id === 2500 && f.wire_type === GROUP_START && f.children) {
            const info = new MathTransformInfo();
            const coeffs = [];
            for (const c of f.children) {
                if (c.field_id === 2501 && c.wire_type === VARINT) info.id_code = c.value;
                else if (c.field_id === 2502 && c.wire_type === VARINT) info.mode = c.value;
                else if (c.field_id === 2503 && c.wire_type === VARINT) info.storage_code = c.value;
                else if (c.field_id === 2504 && (c.wire_type === FIXED32 || c.wire_type === FIXED64))
                    coeffs.push(parseFloat(c.value));
            }
            info.coefficients = coeffs;
            return info.hasMetadata() ? info : null;
        }
        if (f.wire_type === GROUP_START && f.children) {
            const result = _findMathTransformRecursive(f.children);
            if (result) return result;
        }
    }
    return null;
}

function _parseGroup3500(fields) {
    const ref = new StackTemplateRef();
    for (const f of fields) {
        if (f.field_id === 3501 && f.wire_type === LENGTH_DELIMITED)
            ref.column_refs.push(decodeText(f.payload));
        else if (f.field_id === 3502 && f.wire_type === VARINT)
            ref.template_type = f.value;
        else if (f.field_id === 3506 && f.wire_type === LENGTH_DELIMITED && f.payload && f.payload.length) {
            try {
                const ep = new ProtoParser(f.payload);
                const [ef] = ep.parseFields();
                let f1 = 0, f2 = 0;
                for (const ef2 of ef) {
                    if (ef2.field_id === 1 && ef2.wire_type === VARINT) f1 = ef2.value;
                    else if (ef2.field_id === 2 && ef2.wire_type === VARINT) f2 = ef2.value;
                }
                ref.index_mappings.push([f1, f2]);
            } catch (e) {}
        }
    }
    return ref;
}

function _parseGroup400(fields) {
    const result = {
        num_cols: 1, num_rows: 1, total_cells: 1,
        x_axis_ref: '', y_axis_ref: '',
        float_values: [], byte_values: new Uint8Array(0), int_values: [],
        int_scalar_value: null, field_411_raw: [],
        axis_units: '', scaling: null,
        field_415: 0, field_416: 0, field_417_values: [],
        stack_template: null, display_scale: 1.0, math_transform: null,
    };

    for (const f of fields) {
        if (f.field_id === 401 && f.wire_type === VARINT) result.num_cols = f.value;
        else if (f.field_id === 402 && f.wire_type === VARINT) result.num_rows = f.value;
        else if (f.field_id === 403 && f.wire_type === VARINT) result.total_cells = f.value;
        else if (f.field_id === 404 && f.wire_type === LENGTH_DELIMITED) result.x_axis_ref = decodeText(f.payload);
        else if (f.field_id === 405 && f.wire_type === LENGTH_DELIMITED) result.y_axis_ref = decodeText(f.payload);
        else if (f.field_id === 411 && f.wire_type === FIXED32) {
            result.float_values.push(f.value);
            const raw = f.raw_bytes && f.raw_bytes.length === 4 ? f.raw_bytes :
                (() => { const b = new ArrayBuffer(4); new DataView(b).setFloat32(0, f.value, true); return new Uint8Array(b); })();
            result.field_411_raw.push(...raw);
        }
        else if (f.field_id === 411 && f.wire_type === LENGTH_DELIMITED && f.payload) {
            result.field_411_raw.push(...f.payload);
            if (f.payload.length % 4 === 0) {
                const dv = new DataView(f.payload.buffer, f.payload.byteOffset, f.payload.byteLength);
                for (let i = 0; i < f.payload.length; i += 4)
                    result.float_values.push(dv.getFloat32(i, true));
            }
        }
        else if (f.field_id === 408 && f.wire_type === LENGTH_DELIMITED) result.byte_values = f.payload;
        else if (f.field_id === 410 && f.wire_type === VARINT) result.int_values.push(f.value);
        else if (f.field_id === 410 && f.wire_type === LENGTH_DELIMITED && f.payload) {
            let pos = 0;
            while (pos < f.payload.length) {
                const [v, newPos] = decodeVarint(f.payload, pos);
                result.int_values.push(v);
                pos = newPos;
            }
        }
        else if (f.field_id === 409 && f.wire_type === VARINT) {
            result.int_values.push(f.value);
            result.int_scalar_value = f.value;
        }
        else if (f.field_id === 413 && f.wire_type === VARINT) {
            result.int_values.push(f.value);
            result.int_scalar_value = f.value;
        }
        else if (f.field_id === 415 && f.wire_type === VARINT) result.field_415 = f.value;
        else if (f.field_id === 416 && f.wire_type === VARINT) result.field_416 = f.value;
        else if (f.field_id === 417 && f.wire_type === VARINT) result.field_417_values.push(f.value);
        else if (f.field_id === 600 && f.wire_type === GROUP_START && f.children) {
            for (const cf of f.children) {
                if (cf.field_id === 603 && cf.wire_type === LENGTH_DELIMITED)
                    result.axis_units = decodeText(cf.payload);
            }
            const scaling = _findScalingRecursive(f.children);
            if (scaling) result.scaling = scaling;
            const mt = _findMathTransformRecursive(f.children);
            if (mt) result.math_transform = mt;
        }
        else if (f.field_id === 3500 && f.wire_type === GROUP_START && f.children)
            result.stack_template = _parseGroup3500(f.children);
        else if (f.field_id === 500 && f.wire_type === GROUP_START && f.children) {
            for (const sf of f.children) {
                if (sf.field_id === 2700 && sf.wire_type === GROUP_START && sf.children) {
                    const f2706Vals = sf.children
                        .filter(c => c.field_id === 2706 && c.wire_type === FIXED32)
                        .map(c => c.value);
                    if (f2706Vals.length && f2706Vals[0] !== 1.0 && f2706Vals[0] !== 0.0)
                        result.display_scale = f2706Vals[0];
                }
            }
        }
    }
    result.field_411_raw = new Uint8Array(result.field_411_raw);
    return result;
}

function _coerceGroup400StorageForDtype(g400, dataType) {
    const raw_dtype = dataType || '';
    const canon = normalizeDtype(raw_dtype);
    const raw411 = g400.field_411_raw || new Uint8Array(0);

    if (dtypeIsInteger(canon) && (g400.int_values.length || g400.byte_values.length))
        g400.float_values = [];

    if (isCharDtype(raw_dtype)) {
        if (!g400.byte_values.length) {
            if (g400.int_values.length)
                g400.byte_values = new Uint8Array(g400.int_values.map(v => v & 0xFF));
            else if (raw411.length)
                g400.byte_values = raw411;
            else if (g400.float_values.length)
                g400.byte_values = new Uint8Array(g400.float_values.map(v => Math.round(v) & 0xFF));
        }
        g400.float_values = [];
        g400.int_values = [];
        g400.int_scalar_value = null;
        return;
    }

    if (raw411.length && !g400.byte_values.length && !g400.int_values.length) {
        const dv = new DataView(raw411.buffer, raw411.byteOffset, raw411.byteLength);
        if (canon === 'int8' || canon === 'uint8') {
            g400.int_values = Array.from(raw411);
            if (g400.int_values.length) g400.int_scalar_value = g400.int_values[g400.int_values.length - 1];
            g400.float_values = [];
            return;
        } else if (canon === 'int16' || canon === 'uint16') {
            const count = Math.floor(raw411.length / 2);
            if (count > 0) {
                g400.int_values = Array.from({length: count}, (_, i) => dv.getUint16(i * 2, true));
                g400.int_scalar_value = g400.int_values[g400.int_values.length - 1];
                g400.float_values = [];
                return;
            }
        } else if (canon === 'int32' || canon === 'uint32') {
            const count = Math.floor(raw411.length / 4);
            if (count > 0) {
                g400.int_values = Array.from({length: count}, (_, i) => dv.getUint32(i * 4, true));
                g400.int_scalar_value = g400.int_values[g400.int_values.length - 1];
                g400.float_values = [];
                return;
            }
        } else if (canon === 'float64') {
            const count = Math.floor(raw411.length / 8);
            if (count > 0) {
                g400.float_values = Array.from({length: count}, (_, i) => dv.getFloat64(i * 8, true));
                return;
            }
        } else if (canon === 'float32') {
            const count = Math.floor(raw411.length / 4);
            if (count > 0) {
                g400.float_values = Array.from({length: count}, (_, i) => dv.getFloat32(i * 4, true));
                return;
            }
        }
    }
}

function _normalizeParamStorageForDtype(param) {
    const raw_dtype = param.data_type || '';
    const canon = normalizeDtype(raw_dtype);

    if (dtypeIsInteger(canon)) {
        let ivals = [...(param.int_values || [])];
        if (!ivals.length && param.int_scalar_value != null) {
            ivals = [Math.round(param.int_scalar_value)];
            param.int_values = ivals;
        }
    }

    if (isCharDtype(raw_dtype)) {
        if (!param.byte_values || !param.byte_values.length) {
            const srcInts = [...(param.int_values || [])];
            if (!srcInts.length && param.int_scalar_value != null) srcInts.push(Math.round(param.int_scalar_value));
            if (srcInts.length) {
                param.byte_values = new Uint8Array(srcInts.map(v => v & 0xFF));
            } else if (param.float_values && param.float_values.length) {
                param.byte_values = new Uint8Array(param.float_values.map(v => Math.round(v) & 0xFF));
            }
        }
        if (param.byte_values && param.byte_values.length) {
            param.float_values = [];
            param.int_values = [];
            param.int_scalar_value = null;
        }
        return;
    }

    if (dtypeIsInteger(canon)) {
        if (param.int_values && param.int_values.length) {
            param.float_values = [];
            return;
        }
        if (param.float_values && param.float_values.length) {
            const outInts = param.float_values.map(v => {
                const sem = clampSemanticInt(Math.round(v), canon);
                return semanticIntToStorage(sem, canon);
            });
            param.int_values = outInts;
            param.float_values = [];
            if (outInts.length === 1 && param.int_scalar_value != null)
                param.int_scalar_value = outInts[0];
        }
    }
}

function _parseParam112(payload, protoField) {
    const parser = new ProtoParser(payload);
    const [fields] = parser.parseFields();
    const param = new ParameterDef();
    param._proto_field = protoField;

    let grp400Field = null;
    for (const f of fields) {
        if (f.field_id === 400 && f.wire_type === GROUP_START && f.children) {
            grp400Field = f;
            break;
        }
    }

    const g400 = grp400Field ? _parseGroup400(grp400Field.children) : null;

    for (const f of fields) {
        if (f.field_id === 2300 && f.wire_type === GROUP_START && f.children) {
            for (const cf of f.children) {
                if (cf.wire_type === VARINT && [2301,2302,2303,2304,2305].includes(cf.field_id))
                    param.format_meta[String(cf.field_id)] = cf.value;
            }
            break;
        }
    }

    for (const f of fields) {
        if (f.wire_type === GROUP_START) continue;
        if (f.field_id === 8 && f.wire_type === LENGTH_DELIMITED) param.auf_id = decodeText(f.payload);
        else if (f.field_id === 10 && f.wire_type === VARINT) param.field_10 = f.value;
        else if (f.field_id === 11 && f.wire_type === VARINT) param.field_11 = f.value;
        else if (f.field_id === 12 && f.wire_type === LENGTH_DELIMITED) param.category = decodeText(f.payload);
        else if (f.field_id === 13 && f.wire_type === LENGTH_DELIMITED) param.units = decodeText(f.payload);
        else if (f.field_id === 14 && f.wire_type === FIXED64) param.max_value = f.value;
        else if (f.field_id === 15 && f.wire_type === FIXED64) param.min_value = f.value;
        else if (f.field_id === 16 && f.wire_type === LENGTH_DELIMITED) param.field_16 = decodeText(f.payload);
        else if (f.field_id === 17 && f.wire_type === LENGTH_DELIMITED) param.description = decodeText(f.payload);
        else if (f.field_id === 20 && f.wire_type === LENGTH_DELIMITED) param.data_type = decodeText(f.payload);
        else if (f.field_id === 23 && f.wire_type === LENGTH_DELIMITED) param.long_description = decodeText(f.payload);
        else if (f.field_id === 24 && f.wire_type === LENGTH_DELIMITED) param.symbol = decodeText(f.payload);
        else if (f.field_id === 27 && f.wire_type === VARINT) param.field_27 = f.value;
        else if (f.field_id === 28 && f.wire_type === LENGTH_DELIMITED) param.equ_ref = decodeText(f.payload);
        else if (f.field_id === 29 && f.wire_type === VARINT) param.field_29 = f.value;
        else if (f.field_id === 44 && f.wire_type === LENGTH_DELIMITED) param.group = decodeText(f.payload);
        else if (f.field_id === 50 && f.wire_type === FIXED32) param.scale = f.value;
    }

    if (g400) {
        _coerceGroup400StorageForDtype(g400, param.data_type);
        param.num_cols = g400.num_cols;
        param.num_rows = g400.num_rows;
        param.total_cells = g400.total_cells;
        param.x_axis_ref = g400.x_axis_ref;
        param.y_axis_ref = g400.y_axis_ref;
        param.float_values = g400.float_values;
        param.byte_values = g400.byte_values;
        param.int_values = g400.int_values;
        param.int_scalar_value = g400.int_scalar_value;
        if (!param.int_values.length && param.int_scalar_value != null)
            param.int_values = [param.int_scalar_value];
        param.scaling = g400.scaling;
        param.math_transform = g400.math_transform;
        param.axis_units = g400.axis_units;
        param.field_415 = g400.field_415;
        param.field_416 = g400.field_416;
        param.field_417_values = g400.field_417_values;
        param.stack_template = g400.stack_template;
        if (g400.display_scale !== 1.0) param.display_scale = g400.display_scale;
    }

    _normalizeParamStorageForDtype(param);
    return param.auf_id ? param : null;
}

function _parseStock261(payload, protoField) {
    const parser = new ProtoParser(payload);
    const [fields] = parser.parseFields();
    const stock = new StockDef();
    stock._proto_field = protoField;

    let g400 = null;
    for (const f of fields) {
        if (f.field_id === 251 && f.wire_type === GROUP_START && f.children) {
            for (const cf of f.children) {
                if (cf.field_id === 8 && cf.wire_type === LENGTH_DELIMITED) stock.auf_id = decodeText(cf.payload);
                else if (cf.field_id === 12 && cf.wire_type === LENGTH_DELIMITED) stock.category = decodeText(cf.payload);
                else if (cf.field_id === 13 && cf.wire_type === LENGTH_DELIMITED) stock.units = decodeText(cf.payload);
                else if (cf.field_id === 17 && cf.wire_type === LENGTH_DELIMITED) stock.description = decodeText(cf.payload);
                else if (cf.field_id === 20 && cf.wire_type === LENGTH_DELIMITED) stock.data_type = decodeText(cf.payload);
                else if (cf.field_id === 24 && cf.wire_type === LENGTH_DELIMITED) stock.symbol = decodeText(cf.payload);
                else if (cf.field_id === 44 && cf.wire_type === LENGTH_DELIMITED) stock.group = decodeText(cf.payload);
                else if (cf.field_id === 50 && cf.wire_type === FIXED32) stock.scale = cf.value;
                else if (cf.field_id === 400 && cf.wire_type === GROUP_START && cf.children)
                    g400 = _parseGroup400(cf.children);
            }
        } else if (f.field_id === 252 && f.wire_type === LENGTH_DELIMITED) {
            stock.label = decodeText(f.payload);
        }
    }

    if (g400) {
        _coerceGroup400StorageForDtype(g400, stock.data_type);
        stock.num_cols = g400.num_cols;
        stock.num_rows = g400.num_rows;
        stock.float_values = g400.float_values;
        stock.byte_values = g400.byte_values;
        stock.int_values = g400.int_values;
        stock.int_scalar_value = g400.int_scalar_value;
        if (!stock.int_values.length && stock.int_scalar_value != null)
            stock.int_values = [stock.int_scalar_value];
        stock.scaling = g400.scaling;
        stock.math_transform = g400.math_transform;
        if (hasDisplayScale(g400.display_scale)) stock.display_scale = g400.display_scale;
    }
    _normalizeParamStorageForDtype(stock);
    return stock.auf_id ? stock : null;
}

function _parseHeader(fields) {
    const h = new FileHeader();
    for (const f of fields) {
        if (f.wire_type !== LENGTH_DELIMITED && f.wire_type !== VARINT) continue;
        if (f.field_id === 81 && f.wire_type === LENGTH_DELIMITED) h.filename = decodeText(f.payload);
        else if (f.field_id === 82 && f.wire_type === LENGTH_DELIMITED) h.year = decodeText(f.payload);
        else if (f.field_id === 83 && f.wire_type === LENGTH_DELIMITED) h.strategy = decodeText(f.payload);
        else if (f.field_id === 84 && f.wire_type === LENGTH_DELIMITED) h.cpu_code = decodeText(f.payload);
        else if (f.field_id === 85 && f.wire_type === LENGTH_DELIMITED) h.base_strategy = decodeText(f.payload);
        else if (f.field_id === 86 && f.wire_type === LENGTH_DELIMITED) h.base_cpu = decodeText(f.payload);
        else if (f.field_id === 87 && f.wire_type === LENGTH_DELIMITED) h.vin = decodeText(f.payload);
        else if (f.field_id === 89 && f.wire_type === LENGTH_DELIMITED) h.cpu = decodeText(f.payload);
        else if (f.field_id === 90 && f.wire_type === LENGTH_DELIMITED) h.serial = decodeText(f.payload);
        else if (f.field_id === 95 && f.wire_type === VARINT) h.pcm_count = f.value;
    }
    return h;
}

// ── TecParser ─────────────────────────────────────────────────────────────────

class TecParser {
    constructor(data) {
        this.data = data instanceof Uint8Array ? data : new Uint8Array(data);
    }

    parse(progressCallback = null) {
        const tec = new TecFile();
        tec._raw_data = this.data;
        if (!this.data.length) throw new Error('Input TEC/BIN payload is empty');

        const [tag, pos] = decodeVarint(this.data, 0);
        const outerWireType = tag & 7;
        tec._outer_wire_type = outerWireType;

        let innerStart, innerEnd;
        if (outerWireType === LENGTH_DELIMITED) {
            tec._outer_tag_byte = this.data.slice(0, pos);
            const [outerLength, innerStartPos] = decodeVarint(this.data, pos);
            innerStart = innerStartPos;
            innerEnd = innerStart + outerLength;
        } else {
            tec._outer_tag_byte = new Uint8Array(0);
            innerStart = 0;
            innerEnd = this.data.length;
        }

        tec._trailing_bytes = this.data.slice(innerEnd);
        const parser = new ProtoParser(this.data);
        const [allFields] = parser.parseFields(innerStart, innerEnd);
        tec._inner_fields = allFields;

        if (progressCallback) progressCallback(0, 100, 'Parsing file structure...');

        let group1601 = null;
        for (const f of allFields) {
            if (f.field_id === 1601 && f.wire_type === GROUP_START && f.children) {
                group1601 = f;
                break;
            }
        }
        if (!group1601) throw new Error('Could not find main group 1601 in file');

        tec.header = _parseHeader(group1601.children);
        if (progressCallback) progressCallback(10, 100, 'Parsing stock definitions...');

        for (const f of group1601.children) {
            if (f.field_id === 96 && f.wire_type === GROUP_START && f.children) {
                for (const cf of f.children) {
                    if (cf.field_id === 261 && cf.wire_type === LENGTH_DELIMITED) {
                        const stock = _parseStock261(cf.payload, cf);
                        if (stock && stock.auf_id) tec.stock_defs[stock.auf_id] = stock;
                    }
                }
            }
        }

        if (progressCallback) progressCallback(30, 100, 'Parsing tune parameters...');

        const f112List = group1601.children.filter(
            f => f.field_id === 112 && f.wire_type === LENGTH_DELIMITED
        );
        const total112 = f112List.length;

        for (let i = 0; i < f112List.length; i++) {
            if (progressCallback && i % 500 === 0) {
                const pct = 30 + Math.floor(60 * i / Math.max(total112, 1));
                progressCallback(pct, 100, `Parsing parameter ${i + 1}/${total112}...`);
            }
            const param = _parseParam112(f112List[i].payload, f112List[i]);
            if (param && param.auf_id) {
                param._raw_index = i;
                tec.parameters[param.auf_id] = param;
                tec.param_order.push(param.auf_id);
                if (param.category) {
                    if (!tec.categories[param.category]) tec.categories[param.category] = [];
                    tec.categories[param.category].push(param.auf_id);
                }
                if (param.group) {
                    if (!tec.groups[param.group]) tec.groups[param.group] = [];
                    tec.groups[param.group].push(param.auf_id);
                }
            }
        }

        // Propagate metadata from params to stock defs
        for (const [aufId, param] of Object.entries(tec.parameters)) {
            const stock = tec.stock_defs[aufId];
            if (!stock) continue;
            if (param.scaling && param.scaling.hasTransform() && (!stock.scaling || !stock.scaling.hasTransform()))
                stock.scaling = param.scaling.clone();
            if (param.data_type && !stock.data_type) stock.data_type = param.data_type;
            if (param.description && !stock.description) stock.description = param.description;
            if (param.symbol && !stock.symbol) stock.symbol = param.symbol;
            if (param.units && !stock.units) stock.units = param.units;
            if (param.category && !stock.category) stock.category = param.category;
            if (param.group && !stock.group) stock.group = param.group;
            if (param.x_axis_ref && !stock.x_axis_ref) stock.x_axis_ref = param.x_axis_ref;
            if (param.y_axis_ref && !stock.y_axis_ref) stock.y_axis_ref = param.y_axis_ref;
            if ((param.num_cols > 1 || param.num_rows > 1) && stock.num_cols <= 1 && stock.num_rows <= 1) {
                stock.num_cols = param.num_cols;
                stock.num_rows = param.num_rows;
            }
        }

        if (progressCallback) progressCallback(100, 100, `Loaded ${Object.keys(tec.parameters).length} parameters`);
        return tec;
    }
}

// ── Decrypt TEC file ──────────────────────────────────────────────────────────

async function decryptTecFile(data) {
    const encrypted = data instanceof Uint8Array ? data : new Uint8Array(data);
    if (!encrypted.length || encrypted.length % 16 !== 0)
        throw new Error('Invalid TEC payload length: must be non-empty and 16-byte aligned');

    const key = await _getTecAesKey(['decrypt']);
    const iv = _hexToBytes(TEC_AES_IV_HEX);

    let decrypted;
    try {
        const result = await crypto.subtle.decrypt(
            { name: 'AES-CBC', iv },
            key,
            encrypted
        );
        decrypted = new Uint8Array(result);
    } catch (e) {
        throw new Error(`AES decryption failed: ${e.message}. Is this a valid TEC file?`);
    }

    if (decrypted.length < 18 || decrypted[16] !== 0x1f || decrypted[17] !== 0x8b)
        throw new Error('Decryption failed: GZIP header not found at offset 16. Wrong key or not a .tec file?');

    const tecHeader = decrypted.slice(0, 16);
    const gzipData = decrypted.slice(16);

    let rawData;
    try {
        rawData = await _decompressGzip(gzipData);
    } catch (e) {
        throw new Error(`TEC gzip payload decompression failed: ${e.message}`);
    }
    if (!rawData.length) throw new Error('Decryption failed: decoded TEC payload is empty');

    return { rawData, tecHeader };
}

// ── Encrypt TEC file ──────────────────────────────────────────────────────────

async function encryptTecFile(rawData, tecHeader = null) {
    const raw = rawData instanceof Uint8Array ? rawData : new Uint8Array(rawData);
    const header = tecHeader instanceof Uint8Array ? tecHeader : (tecHeader ? new Uint8Array(tecHeader) : new Uint8Array(16));
    if (header.length !== 16) throw new Error('tecHeader must be 16 bytes');

    const compressed = await _compressGzip(raw);
    const plaintext = new Uint8Array(header.length + compressed.length);
    plaintext.set(header, 0);
    plaintext.set(compressed, header.length);

    const key = await _getTecAesKey(['encrypt']);
    const iv = _hexToBytes(TEC_AES_IV_HEX);

    const result = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, key, plaintext);
    return new Uint8Array(result);
}

// ── Load / Save ───────────────────────────────────────────────────────────────

async function loadTecFile(data, progressCallback = null) {
    const uint8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const { rawData, tecHeader } = await decryptTecFile(uint8);
    const tec = new TecParser(rawData).parse(progressCallback);
    tec._tec_header = tecHeader;
    tec.is_tec_file = true;
    return tec;
}

function loadBinFile(data, progressCallback = null) {
    const uint8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const tec = new TecParser(uint8).parse(progressCallback);
    tec.is_tec_file = false;
    return tec;
}

async function autoLoadFile(data, filename = '', progressCallback = null) {
    const uint8 = data instanceof Uint8Array ? data : new Uint8Array(data);
    const ext = filename.toLowerCase().split('.').pop();
    if (ext === 'tec') return loadTecFile(uint8, progressCallback);
    if (ext === 'bin') return loadBinFile(uint8, progressCallback);
    // Try TEC first, fall back to BIN
    try { return await loadTecFile(uint8, progressCallback); } catch (e) {
        return loadBinFile(uint8, progressCallback);
    }
}

// ── Serialize / Save ──────────────────────────────────────────────────────────

function _syncParamToProto(param) {
    const pf = param._proto_field;
    if (!pf || !pf.payload) return false;
    try {
        _normalizeParamStorageForDtype(param);
        const parser = new ProtoParser(pf.payload);
        const [fields] = parser.parseFields();

        // Rebuild group400 values
        let grp400Field = fields.find(f => f.field_id === 400 && f.wire_type === GROUP_START);
        if (grp400Field) {
            const children = grp400Field.children;
            // Remove old value fields, keep structure fields
            const keep = children.filter(f =>
                ![411, 408, 410, 409, 413].includes(f.field_id)
            );

            if (param.byte_values && param.byte_values.length) {
                const bvField = new ProtoField(408, LENGTH_DELIMITED);
                bvField.setBytes(param.byte_values);
                keep.push(bvField);
            } else if (param.float_values && param.float_values.length) {
                for (const v of param.float_values) {
                    const ff = new ProtoField(411, FIXED32);
                    ff.setFloat32(v);
                    keep.push(ff);
                }
            } else if (param.int_values && param.int_values.length) {
                for (const v of param.int_values) {
                    const ivf = new ProtoField(410, VARINT);
                    ivf.value = v;
                    keep.push(ivf);
                }
            }
            grp400Field.children = keep;
        }
        pf.payload = serializeFields(fields);
        return true;
    } catch (e) {
        console.error('Error syncing param to proto:', e);
        return false;
    }
}

function serializeTec(tec) {
    // Sync dirty params
    for (const aufId of tec._dirty_params) {
        const param = tec.parameters[aufId];
        if (param) _syncParamToProto(param);
    }
    tec._dirty_params.clear();

    const out = serializeFields(tec._inner_fields);

    if (tec._outer_wire_type === LENGTH_DELIMITED && tec._outer_tag_byte.length) {
        const lenBytes = encodeVarint(out.length);
        const result = new Uint8Array(
            tec._outer_tag_byte.length + lenBytes.length + out.length + tec._trailing_bytes.length
        );
        let off = 0;
        result.set(tec._outer_tag_byte, off); off += tec._outer_tag_byte.length;
        result.set(lenBytes, off); off += lenBytes.length;
        result.set(out, off); off += out.length;
        result.set(tec._trailing_bytes, off);
        return result;
    }
    if (tec._trailing_bytes.length) {
        const result = new Uint8Array(out.length + tec._trailing_bytes.length);
        result.set(out, 0);
        result.set(tec._trailing_bytes, out.length);
        return result;
    }
    return out;
}

async function saveTecFile(tec) {
    const raw = serializeTec(tec);
    if (tec.is_tec_file) return encryptTecFile(raw, tec._tec_header);
    return raw;
}

// ── Update values ─────────────────────────────────────────────────────────────

function updateParamValues(tec, aufId, newValues) {
    const param = tec.getParam(aufId);
    if (!param) return false;
    try {
        const ds = param.display_scale !== 0 ? param.display_scale : 1.0;
        const rawDtype = param.data_type || '';
        const canon = normalizeDtype(rawDtype);
        const isChar = isCharDtype(rawDtype);

        if (isChar) {
            const semanticInts = newValues.map(v => Math.round(ds !== 1.0 ? parseFloat(v) * ds : parseFloat(v)));
            const rawBytes = semanticInts.map(sem => {
                if (dtypeIsInteger(canon)) {
                    sem = clampSemanticInt(sem, canon);
                    return semanticIntToStorage(sem, canon) & 0xFF;
                }
                return Math.round(sem) & 0xFF;
            });
            param.byte_values = new Uint8Array(rawBytes);
            param.int_values = [];
            param.float_values = [];
            param.int_scalar_value = null;
        } else if ((canon === 'int8' || canon === 'uint8') && param.byte_values.length) {
            let rawBytes;
            if (param.scaling) {
                rawBytes = newValues.map(v => {
                    const rv = param.scaling.unapply(removeDisplayScale(parseFloat(v), ds), rawDtype);
                    return rv & 0xFF;
                });
            } else {
                const semanticInts = newValues.map(v => Math.round(ds !== 1.0 ? parseFloat(v) * ds : parseFloat(v)));
                rawBytes = semanticInts.map(sem => {
                    sem = clampSemanticInt(sem, canon);
                    return semanticIntToStorage(sem, canon) & 0xFF;
                });
            }
            param.byte_values = new Uint8Array(rawBytes);
            param.int_values = [];
            param.float_values = [];
            param.int_scalar_value = null;
        } else if (dtypeIsInteger(canon)) {
            let newInts;
            if (param.scaling) {
                newInts = newValues.map(v =>
                    param.scaling.unapply(removeDisplayScale(parseFloat(v), ds), rawDtype)
                );
            } else {
                const semanticInts = newValues.map(v =>
                    Math.round(ds !== 1.0 ? parseFloat(v) * ds : parseFloat(v))
                );
                newInts = semanticInts.map(v => semanticIntToStorage(clampSemanticInt(v, canon), canon));
            }
            param.int_values = newInts;
            param.float_values = [];
            param.byte_values = new Uint8Array(0);
            if (param.int_scalar_value != null && newInts.length === 1)
                param.int_scalar_value = newInts[0];
        } else if (dtypeIsFloat(canon)) {
            param.float_values = newValues.map(v => ds !== 1.0 ? parseFloat(v) * ds : parseFloat(v));
            param.int_values = [];
            param.byte_values = new Uint8Array(0);
        } else if (param.byte_values.length) {
            const raw = newValues.map(v => Math.max(0, Math.min(255, Math.round(ds !== 1.0 ? parseFloat(v) * ds : parseFloat(v)))));
            param.byte_values = new Uint8Array(raw);
        } else if (param.int_values.length) {
            param.int_values = newValues.map(v => {
                const sem = Math.round(ds !== 1.0 ? parseFloat(v) * ds : parseFloat(v));
                return sem < 0 ? (sem + 4294967296) : sem;
            });
        } else {
            param.float_values = newValues.map(v => parseFloat(v));
        }
        tec._dirty_params.add(aufId);
        return true;
    } catch (e) {
        console.error(`Error updating ${aufId}:`, e);
        return false;
    }
}

function updateCharValues(tec, aufId, newString) {
    const param = tec.getParam(aufId);
    if (!param) return false;
    try {
        let newBytes = Array.from(newString).map(c => c.charCodeAt(0) & 0xFF);
        const origLen = param.byte_values.length ||
            Math.max(1, (param.num_cols || 1) * (param.num_rows || 1));
        if (newBytes.length < origLen) newBytes = [...newBytes, ...new Array(origLen - newBytes.length).fill(0)];
        else if (newBytes.length > origLen) newBytes = newBytes.slice(0, origLen);
        param.byte_values = new Uint8Array(newBytes);
        param.int_values = [];
        param.float_values = [];
        param.int_scalar_value = null;
        tec._dirty_params.add(aufId);
        return true;
    } catch (e) {
        console.error(`Error updating char ${aufId}:`, e);
        return false;
    }
}

// ── Compare files ─────────────────────────────────────────────────────────────

function compareFiles(tecA, tecB) {
    const diffs = [];
    const allIds = new Set([...Object.keys(tecA.parameters), ...Object.keys(tecB.parameters)]);
    for (const aufId of allIds) {
        const pA = tecA.parameters[aufId];
        const pB = tecB.parameters[aufId];
        if (!pA || !pB) {
            diffs.push({ auf_id: aufId, type: pA ? 'only_a' : 'only_b' });
            continue;
        }
        const vA = pA.getValues();
        const vB = pB.getValues();
        if (vA.length !== vB.length || vA.some((v, i) => Math.abs(v - vB[i]) > 1e-6)) {
            diffs.push({ auf_id: aufId, type: 'changed', values_a: vA, values_b: vB });
        }
    }
    return diffs;
}
