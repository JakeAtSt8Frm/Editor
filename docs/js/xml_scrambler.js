// xml_scrambler.js — XML Scrambler for unique signature generation
// Port of the XMLScrambler class in tec_editor.py

'use strict';

class XMLScrambler {
    static CHARSET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    static ID_RE = /<ID>\s*([^<]+?)\s*<\/ID>/g;
    static VALUE_RE = /(<Value(?!s)\b[^>]*>)([^<]*?)(<\/Value>)/g;
    static VALUES_START_RE = /<Values\b/gi;
    static DATATYPE_TAG_RE = /<(?:DataType|Type)>\s*([^<]+?)\s*<\/(?:DataType|Type)>/gi;
    static XSI_TYPE_RE = /\bxsi:type\s*=\s*(?:"([^"]+)"|'([^']+)')/gi;
    static INT_RE = /^\s*[+-]?\d+\s*$/;
    static FLOAT_RE = /^\s*[+-]?(?:\d+(?:\.\d*)?|\.\d+)(?:[eE][+-]?\d+)?\s*$/;

    constructor({ seed = null, float_base = 1.99, float_step = 0.0001, float_decimals = 7 } = {}) {
        this.seed = seed ?? (Math.floor(Math.random() * 0xFFFFFFFF));
        this.float_base = float_base;
        this.float_step = float_step;
        this.float_decimals = float_decimals;
        this._curParam = null;
        this._paramIdx = 0;
        this._curSeed = this.seed;
        this._curBase = float_base;
        this._curIsScalar = false;
        this._curDeclaredType = '';
        this.lastX = 0;
        this.lastY = 0;
        this.stats = { params: 0, values: 0 };
        this._paramCounts = {};
        this._paramValueLimits = {};
        this._paramDeclaredTypes = {};
        this._generatedFloatTexts = new Set();
        this._globalValueCounter = 0;
    }

    _fnv1a(s) {
        let h = 0x811C9DC5;
        for (let i = 0; i < s.length; i++) {
            h = Math.imul(h ^ s.charCodeAt(i), 0x01000193) >>> 0;
        }
        return h >>> 0;
    }

    _ensureParam(pid) {
        if (this._curParam !== pid) {
            this._curParam = pid;
            this._paramIdx = 0;
            this._curSeed = (this._fnv1a(pid) ^ this.seed) >>> 0;
            this._curBase = this.float_base + ((this._curSeed % 5000) / 100.0);
            this._curIsScalar = (this._paramCounts[pid] || 0) === 1;
            this._curDeclaredType = this._paramDeclaredTypes[pid] || '';
            this.lastX = 0;
            this.lastY = 0;
            this.stats.params++;
        }
    }

    _lcg(seed) {
        return ((seed * 1664525 + 1013904223) >>> 0);
    }

    _nextInt(min, max, seed) {
        const range = max - min + 1;
        return min + ((seed >>> 0) % range);
    }

    _scrambleIntValue(oldText, pid) {
        this._ensureParam(pid);
        const limits = this._paramValueLimits[pid];
        let lo = -32768, hi = 32767;
        if (limits) { lo = limits[0]; hi = limits[1]; }

        const baseSeed = (this._curSeed + this._paramIdx * 1234567 + this._globalValueCounter * 89) >>> 0;
        this._paramIdx++;
        this._globalValueCounter++;
        this.stats.values++;

        let val = this._nextInt(lo, hi, this._lcg(baseSeed));
        val = Math.max(lo, Math.min(hi, val));
        if (val === 0 || val === 1 || val === -1) val = val >= 0 ? val + 3 : val - 3;
        return String(val);
    }

    _scrambleFloatValue(oldText, pid) {
        this._ensureParam(pid);
        const baseSeed = (this._curSeed + this._paramIdx * 987654 + this._globalValueCounter * 1337) >>> 0;
        this._paramIdx++;
        this._globalValueCounter++;
        this.stats.values++;

        const base = this._curBase + (baseSeed % 1000) * 0.001;
        let val = base + this._paramIdx * this.float_step;
        let text = val.toFixed(this.float_decimals);

        let attempts = 0;
        while (this._generatedFloatTexts.has(text) && attempts < 100) {
            val += 0.0001337 * (attempts + 1);
            text = val.toFixed(this.float_decimals);
            attempts++;
        }
        this._generatedFloatTexts.add(text);
        return text;
    }

    _detectType(oldText) {
        if (XMLScrambler.INT_RE.test(oldText.trim())) return 'int';
        if (XMLScrambler.FLOAT_RE.test(oldText.trim())) return 'float';
        if (/^\s*(true|false)\s*$/i.test(oldText)) return 'bool';
        return 'string';
    }

    scramble(xml, progressCallback = null) {
        // First pass: collect param counts
        this._paramCounts = {};
        const idMatches = [...xml.matchAll(/<ID>\s*([^<]+?)\s*<\/ID>/g)];
        for (const m of idMatches) {
            const pid = m[1].trim();
            this._paramCounts[pid] = (this._paramCounts[pid] || 0) + 1;
        }

        // Split into param blocks and scramble
        let result = xml;
        let changed = 0;

        // Replace values within <Value> tags (not <Values>)
        result = result.replace(
            /(<ID>\s*([^<]+?)\s*<\/ID>[\s\S]*?)(?=<ID>|$)/g,
            (block, _, pid) => {
                if (!pid) return block;
                pid = pid.trim();
                return block.replace(
                    /(<Value(?!s)\b[^>]*>)([^<]*?)(<\/Value>)/g,
                    (full, open, val, close) => {
                        const type = this._detectType(val);
                        let newVal;
                        if (type === 'int') newVal = this._scrambleIntValue(val, pid);
                        else if (type === 'float') newVal = this._scrambleFloatValue(val, pid);
                        else if (type === 'bool') newVal = Math.random() > 0.5 ? 'true' : 'false';
                        else return full;
                        changed++;
                        return open + newVal + close;
                    }
                );
            }
        );

        return { result, stats: { ...this.stats, changed } };
    }
}
