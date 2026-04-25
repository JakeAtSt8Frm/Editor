// app.js — TecEdit Web App Main Application
// All UI logic, tab management, parameter editing, tools

'use strict';

// ── App State ─────────────────────────────────────────────────────────────────
const App = {
    tec: null,
    tec2: null,          // second file for compare
    currentFile: null,
    currentFile2: null,
    modified: false,
    currentParam: null,
    currentCategory: '',
    currentGroup: '',
    navMode: 'categories',
    searchText: '',
    typeFilter: 'All',
    changedOnly: false,
    favOnly: false,
    hideUncategorized: true,
    heatmapEnabled: true,
    pctDiffEnabled: false,
    favorites: new Set(),
    undoStack: [],
    redoStack: [],
    maxUndo: 100,
    recentFiles: [],
    xdfOffsets: {},
    openTabs: [],
    activeTab: 'params',
    sortCol: null,
    sortReverse: false,
    _paramFilter: null,
    _filterChangedOnly: false,
    _tabCounter: 0,
};

// ── Color Palette (matching Python app) ──────────────────────────────────────
const C = {
    winBg: '#1a1a1a', bgDark: '#1e1e1e', bg: '#242424',
    bgSecondary: '#2a2a2a', bgTertiary: '#323232', bgHover: '#3a3a3a',
    bgSelected: '#1a3352', fg: '#d0d4dc', fgBright: '#eceff4',
    fgDim: '#8a92a0', fgMuted: '#5c6578', fgInverse: '#f0f4fa',
    accent: '#3cc8c8', accentDim: '#28a0a0', accentBg: '#1e3038',
    accentSoft: '#5ce0e0', green: '#2ecc40', greenBg: '#1a2e1a',
    yellow: '#f0c040', yellowBg: '#302c18', red: '#e04040',
    redBright: '#ff4d4d', redBg: '#3c1e1e', orange: '#e88020',
    border: '#3a3a3a', borderLight: '#484848',
    cellBg: '#c8ccd2', cellHeader: '#2a2e34', cellText: '#141414',
    cellMod: '#ff4d4d',
};

// ── Heatmap ───────────────────────────────────────────────────────────────────
function heatmapColor(val, vmin, vmax) {
    if (vmax === vmin) return C.cellBg;
    const t = Math.max(0, Math.min(1, (val - vmin) / (vmax - vmin)));
    let r, g, b;
    if (t < 0.333) {
        const s = t / 0.333;
        r = Math.round(200 * s); g = Math.round(200 + 30 * s); b = 0;
    } else if (t < 0.667) {
        const s = (t - 0.333) / 0.334;
        r = Math.round(200 + 40 * s); g = Math.round(230 - 100 * s); b = 0;
    } else {
        const s = (t - 0.667) / 0.333;
        r = Math.round(240 - 20 * s); g = Math.round(130 - 110 * s); b = Math.round(10 * s);
    }
    return `rgb(${Math.max(0,Math.min(255,r))},${Math.max(0,Math.min(255,g))},${Math.max(0,Math.min(255,b))})`;
}

// ── Number formatting ─────────────────────────────────────────────────────────
function formatNumeric(value) {
    try {
        const n = parseFloat(value);
        if (!isFinite(n)) return String(value);
        const abs = Math.abs(n);
        if (abs >= 1e5 || (abs > 0 && abs < 1e-5)) return n.toExponential(2);
        if (abs >= 1e4) return n.toFixed(4).replace(/\.?0+$/, '');
        if (abs < 1 && abs > 0) return n.toPrecision(6).replace(/\.?0+$/, '');
        return n.toPrecision(6).replace(/\.?0+$/, '');
    } catch (e) { return String(value); }
}

function fmtVal(value) {
    if (value === null || value === undefined) return '';
    if (typeof value === 'number') return formatNumeric(value);
    return String(value);
}

// ── DOM helpers ───────────────────────────────────────────────────────────────
function el(tag, attrs = {}, ...children) {
    const e = document.createElement(tag);
    for (const [k, v] of Object.entries(attrs)) {
        if (k === 'class') e.className = v;
        else if (k === 'style') Object.assign(e.style, v);
        else if (k.startsWith('on')) e.addEventListener(k.slice(2), v);
        else e.setAttribute(k, v);
    }
    for (const c of children) {
        if (c == null) continue;
        e.appendChild(typeof c === 'string' ? document.createTextNode(c) : c);
    }
    return e;
}

function $(sel, ctx = document) { return ctx.querySelector(sel); }
function $$(sel, ctx = document) { return [...ctx.querySelectorAll(sel)]; }

function setStatus(msg, type = 'info') {
    const bar = $('#status-bar');
    if (!bar) return;
    bar.textContent = msg;
    bar.className = `status-bar status-${type}`;
    if (type === 'info' || type === 'success') {
        clearTimeout(App._statusTimeout);
        if (type === 'success') {
            App._statusTimeout = setTimeout(() => {
                if (bar) bar.textContent = App.currentFile ? `File: ${App.currentFile}` : 'Ready';
            }, 3000);
        }
    }
}

// ── Tab management ────────────────────────────────────────────────────────────
function addTab(id, title, contentBuilder, closable = true) {
    const existing = App.openTabs.find(t => t.id === id);
    if (existing) { activateTab(id); return; }

    App.openTabs.push({ id, title, closable });

    const tabBar = $('#tab-bar');
    const tabContent = $('#tab-content');

    const tab = el('div', { class: 'tab', 'data-tab': id });
    const tabTitle = el('span', { class: 'tab-title' }, title);
    tab.appendChild(tabTitle);
    if (closable) {
        const closeBtn = el('button', {
            class: 'tab-close',
            onclick: (e) => { e.stopPropagation(); removeTab(id); }
        }, '×');
        tab.appendChild(closeBtn);
    }
    tab.addEventListener('click', () => activateTab(id));
    tabBar.appendChild(tab);

    const pane = el('div', { class: 'tab-pane', 'data-tab': id });
    tabContent.appendChild(pane);
    contentBuilder(pane);

    activateTab(id);
}

function removeTab(id) {
    const idx = App.openTabs.findIndex(t => t.id === id);
    if (idx === -1) return;
    const wasActive = App.activeTab === id;
    App.openTabs.splice(idx, 1);
    $(`[data-tab="${id}"]`, $('#tab-bar'))?.remove();
    $(`[data-tab="${id}"]`, $('#tab-content'))?.remove();
    if (wasActive) {
        const nextTab = App.openTabs[Math.min(idx, App.openTabs.length - 1)];
        if (nextTab) activateTab(nextTab.id);
    }
}

function activateTab(id) {
    App.activeTab = id;
    $$('.tab', $('#tab-bar')).forEach(t => t.classList.toggle('active', t.dataset.tab === id));
    $$('.tab-pane', $('#tab-content')).forEach(p => p.classList.toggle('active', p.dataset.tab === id));
}

function updateTabTitle(id, title) {
    const tab = App.openTabs.find(t => t.id === id);
    if (tab) tab.title = title;
    const titleEl = $(`[data-tab="${id}"] .tab-title`, $('#tab-bar'));
    if (titleEl) titleEl.textContent = title;
}

// ── Navigation panel ──────────────────────────────────────────────────────────
function buildNavTree() {
    const navTree = $('#nav-tree');
    if (!navTree) return;
    navTree.innerHTML = '';

    if (!App.tec) {
        navTree.innerHTML = '<div class="nav-empty">No file loaded</div>';
        return;
    }

    const modifiedIds = getModifiedAufIds();

    if (App.navMode === 'categories') {
        const cats = App.tec.getVisibleCategories();
        const sorted = Object.keys(cats).sort((a, b) => a.localeCompare(b));

        // All Parameters
        const allItem = el('div', { class: 'nav-item' + (App.currentCategory === '' && App.currentGroup === '' ? ' active' : '') },
            el('span', { class: 'nav-item-text' }, 'All Parameters'),
            el('span', { class: 'nav-count' }, String(App.tec.getVisibleParams().length))
        );
        allItem.addEventListener('click', () => {
            App.currentCategory = '';
            App.currentGroup = '';
            buildNavTree();
            refreshParamList();
        });
        navTree.appendChild(allItem);

        for (const cat of sorted) {
            const ids = cats[cat];
            const modCount = ids.filter(id => modifiedIds.has(id)).length;
            const item = el('div', {
                class: 'nav-item' + (App.currentCategory === cat ? ' active' : '') +
                       (modCount > 0 ? ' modified' : '')
            },
                el('span', { class: 'nav-item-text' }, cat || '(Uncategorized)'),
                el('span', { class: 'nav-count' }, String(ids.length))
            );
            item.addEventListener('click', () => {
                App.currentCategory = cat;
                App.currentGroup = '';
                buildNavTree();
                refreshParamList();
            });
            navTree.appendChild(item);
        }

        // Uncategorized
        const uncatIds = App.tec.getVisibleParams().filter(id => {
            const p = App.tec.parameters[id] || App.tec.stock_defs[id];
            return p && !p.display_category;
        });
        if (uncatIds.length) {
            const item = el('div', {
                class: 'nav-item' + (App.currentCategory === '__uncategorized__' ? ' active' : '')
            },
                el('span', { class: 'nav-item-text' }, '(Uncategorized)'),
                el('span', { class: 'nav-count' }, String(uncatIds.length))
            );
            item.addEventListener('click', () => {
                App.currentCategory = '__uncategorized__';
                App.currentGroup = '';
                buildNavTree();
                refreshParamList();
            });
            navTree.appendChild(item);
        }
    } else {
        // Groups mode
        const grps = App.tec.getVisibleGroups();
        const sorted = Object.keys(grps).sort((a, b) => a.localeCompare(b));

        const allItem = el('div', { class: 'nav-item' + (App.currentGroup === '' ? ' active' : '') },
            el('span', { class: 'nav-item-text' }, 'All Parameters'),
            el('span', { class: 'nav-count' }, String(App.tec.getVisibleParams().length))
        );
        allItem.addEventListener('click', () => {
            App.currentCategory = '';
            App.currentGroup = '';
            buildNavTree();
            refreshParamList();
        });
        navTree.appendChild(allItem);

        for (const grp of sorted) {
            const ids = grps[grp];
            const item = el('div', {
                class: 'nav-item' + (App.currentGroup === grp ? ' active' : '')
            },
                el('span', { class: 'nav-item-text' }, grp),
                el('span', { class: 'nav-count' }, String(ids.length))
            );
            item.addEventListener('click', () => {
                App.currentGroup = grp;
                App.currentCategory = '';
                buildNavTree();
                refreshParamList();
            });
            navTree.appendChild(item);
        }
    }
}

// ── Parameter list ────────────────────────────────────────────────────────────
function getModifiedAufIds() {
    const modified = new Set();
    if (!App.tec) return modified;
    for (const aufId of App.tec.getVisibleParams()) {
        const param = App.tec.parameters[aufId];
        const stock = App.tec.stock_defs[aufId];
        if (!param || !stock) continue;
        const pVals = param.getValues();
        const sVals = stock.getValues();
        if (pVals.length !== sVals.length) { modified.add(aufId); continue; }
        for (let i = 0; i < pVals.length; i++) {
            if (Math.abs(pVals[i] - sVals[i]) > 1e-6) { modified.add(aufId); break; }
        }
    }
    return modified;
}

function paramPassesFilters(aufId, modifiedIds) {
    const p = App.tec.parameters[aufId] || App.tec.stock_defs[aufId];
    if (!p) return false;
    if (p.is_hidden) return false;

    // Category/group filter
    const category = (p.display_category || '').trim();
    const group = (p.group || '').trim();
    const catUnknown = !category;
    const grpUnknown = !group;

    if (App.currentCategory) {
        if (App.currentCategory === '__uncategorized__') { if (!catUnknown) return false; }
        else if (category !== App.currentCategory) return false;
    }
    if (App.currentGroup) {
        if (App.currentGroup === '__ungrouped__') { if (!grpUnknown) return false; }
        else if (group !== App.currentGroup) return false;
    }

    if (App.hideUncategorized && catUnknown && !App.currentCategory && App.navMode === 'categories') return false;

    // Search
    const search = App.searchText.trim().toLowerCase();
    if (search) {
        const haystack = [aufId, p.description, p.symbol, p.display_category, p.group, p.units]
            .map(s => (s || '').toLowerCase()).join(' ');
        if (!search.split(/\s+/).every(tok => haystack.includes(tok))) return false;
    }

    // Type filter
    if (App.typeFilter === 'Scalars' && !p.is_scalar) return false;
    if (App.typeFilter === 'Tables' && !p.is_table) return false;
    if (App.typeFilter === 'Arrays' && !p.is_array) return false;

    // Changed only
    if (App.changedOnly && !modifiedIds.has(aufId)) return false;

    // Favorites
    if (App.favOnly && !App.favorites.has(aufId)) return false;

    return true;
}

function refreshParamList() {
    const container = $('#param-list-body');
    if (!container) return;

    if (!App.tec) {
        container.innerHTML = '<tr><td colspan="8" class="empty-msg">No file loaded. Open a .tec or .bin file to begin.</td></tr>';
        updateParamSummary(0, 0);
        return;
    }

    const modifiedIds = getModifiedAufIds();
    App.modified = modifiedIds.size > 0;
    updateModifiedIndicator();

    let allIds = App.tec.getVisibleParams();

    // Sort
    if (App.sortCol) {
        allIds = [...allIds].sort((a, b) => {
            const pA = App.tec.parameters[a] || App.tec.stock_defs[a];
            const pB = App.tec.parameters[b] || App.tec.stock_defs[b];
            if (!pA || !pB) return 0;
            let vA, vB;
            switch (App.sortCol) {
                case 'id': vA = a; vB = b; break;
                case 'name': vA = pA.display_name; vB = pB.display_name; break;
                case 'value': vA = fmtVal(pA.getScalarValue()); vB = fmtVal(pB.getScalarValue()); break;
                case 'category': vA = pA.display_category; vB = pB.display_category; break;
                case 'type': vA = pA.data_type; vB = pB.data_type; break;
                default: vA = a; vB = b;
            }
            const cmp = String(vA || '').localeCompare(String(vB || ''), undefined, { numeric: true });
            return App.sortReverse ? -cmp : cmp;
        });
    }

    const filtered = allIds.filter(id => paramPassesFilters(id, modifiedIds));
    updateParamSummary(filtered.length, allIds.length);

    // Build table rows — use document fragment for performance
    const frag = document.createDocumentFragment();
    for (const aufId of filtered) {
        const p = App.tec.parameters[aufId] || App.tec.stock_defs[aufId];
        const stock = App.tec.stock_defs[aufId];
        const isModified = modifiedIds.has(aufId);
        const isFav = App.favorites.has(aufId);

        let valDisplay = '', stockDisplay = '', typeDisplay = '';
        try {
            const vals = p.getValues();
            if (p.is_char) {
                valDisplay = p.getCharString().slice(0, 30);
            } else if (vals.length === 1) {
                if (App.pctDiffEnabled && stock) {
                    const sVals = stock.getValues();
                    if (sVals.length === 1 && sVals[0] !== 0) {
                        const pct = ((vals[0] - sVals[0]) / Math.abs(sVals[0]) * 100).toFixed(1);
                        valDisplay = `${fmtVal(vals[0])} (${pct > 0 ? '+' : ''}${pct}%)`;
                    } else {
                        valDisplay = fmtVal(vals[0]);
                    }
                } else {
                    valDisplay = fmtVal(vals[0]);
                }
            } else if (vals.length > 1) {
                valDisplay = `[${vals.length} values]`;
            }
            if (stock) {
                const sVals = stock.getValues();
                if (sVals.length === 1) stockDisplay = fmtVal(sVals[0]);
                else if (sVals.length > 1) stockDisplay = `[${sVals.length}]`;
            }
        } catch (e) {}
        typeDisplay = p.is_table ? '2D' : p.is_array ? '1D' : p.data_type ? p.data_type.slice(0, 12) : '';

        const row = document.createElement('tr');
        row.dataset.aufId = aufId;
        row.className = [
            isModified ? 'row-modified' : '',
            isFav ? 'row-fav' : '',
        ].filter(Boolean).join(' ');

        row.innerHTML = `
            <td class="col-id" title="${aufId}">${aufId}</td>
            <td class="col-name" title="${escHtml(p.display_name)}">${escHtml(p.display_name)}</td>
            <td class="col-value">${escHtml(valDisplay)}</td>
            <td class="col-stock">${escHtml(stockDisplay)}</td>
            <td class="col-type">${escHtml(typeDisplay)}</td>
            <td class="col-units">${escHtml(p.units || '')}</td>
            <td class="col-category">${escHtml(p.display_category || '')}</td>
            <td class="col-source">${App.tec.parameters[aufId] ? (App.tec.stock_defs[aufId] ? 'Both' : 'Tune') : 'Stock'}</td>
        `;

        row.addEventListener('click', () => selectParam(aufId));
        row.addEventListener('dblclick', () => openDetailTab(aufId));
        frag.appendChild(row);
    }

    container.innerHTML = '';
    container.appendChild(frag);

    // Restore selection
    if (App.currentParam) {
        const sel = container.querySelector(`[data-auf-id="${CSS.escape(App.currentParam)}"]`);
        if (sel) sel.classList.add('selected');
    }
}

function escHtml(s) {
    return String(s || '').replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

function updateParamSummary(shown, total) {
    const el = $('#param-summary');
    if (el) el.textContent = `Showing ${shown} of ${total} parameters`;
}

function updateModifiedIndicator() {
    const ind = $('#modified-indicator');
    if (ind) ind.style.display = App.modified ? 'inline' : 'none';
}

// ── Parameter selection ────────────────────────────────────────────────────────
function selectParam(aufId) {
    App.currentParam = aufId;
    $$('#param-list-body tr').forEach(r => r.classList.remove('selected'));
    const row = $(`#param-list-body [data-auf-id="${CSS.escape(aufId)}"]`);
    if (row) { row.classList.add('selected'); row.scrollIntoView({ block: 'nearest' }); }
    updateSplitPreview(aufId);
}

function updateSplitPreview(aufId) {
    const preview = $('#split-preview');
    if (!preview || !App.tec) { if (preview) preview.style.display = 'none'; return; }
    const p = App.tec.parameters[aufId] || App.tec.stock_defs[aufId];
    if (!p) { preview.style.display = 'none'; return; }
    preview.style.display = '';
    $('#preview-id').textContent = aufId;
    $('#preview-name').textContent = p.display_name;
    const vals = p.getValues();
    $('#preview-value').textContent = p.is_char ? p.getCharString() :
        vals.length <= 4 ? vals.map(fmtVal).join(', ') : `[${vals.length} values]`;
    $('#preview-meta').textContent = [
        p.data_type, p.units ? `Units: ${p.units}` : '',
        p.display_category ? `Cat: ${p.display_category}` : ''
    ].filter(Boolean).join('  |  ');
}

// ── Detail view tab ────────────────────────────────────────────────────────────
function openDetailTab(aufId) {
    if (!App.tec) return;
    const p = App.tec.parameters[aufId] || App.tec.stock_defs[aufId];
    if (!p) return;

    const tabId = `detail-${aufId}`;
    const title = `${aufId}`;

    addTab(tabId, title, (pane) => buildDetailView(pane, aufId), true);
}

function buildDetailView(pane, aufId) {
    if (!App.tec) return;
    const p = App.tec.parameters[aufId];
    const stock = App.tec.stock_defs[aufId];
    const displayParam = p || stock;
    if (!displayParam) { pane.innerHTML = '<div class="empty-msg">Parameter not found</div>'; return; }

    pane.className = 'tab-pane detail-pane';
    pane.innerHTML = '';

    // Header
    const header = el('div', { class: 'detail-header' },
        el('div', { class: 'detail-id' }, aufId),
        el('div', { class: 'detail-name' }, displayParam.display_name)
    );
    pane.appendChild(header);

    // Info grid
    const infoGrid = el('div', { class: 'detail-info-grid' });
    const infoItems = [
        ['Type', displayParam.data_type || '-'],
        ['Dims', displayParam.is_table ? `${displayParam.num_rows} × ${displayParam.num_cols}` :
                 displayParam.is_array ? `${Math.max(displayParam.num_cols, displayParam.num_rows)} elements` : 'Scalar'],
        ['Units', displayParam.units || '-'],
        ['Category', displayParam.display_category || '-'],
        ['Group', displayParam.group || '-'],
        ['Symbol', displayParam.symbol || '-'],
        ['X-Axis', displayParam.x_axis_ref || '-'],
        ['Y-Axis', displayParam.y_axis_ref || '-'],
        ['Range', `${fmtVal(displayParam.min_value)} … ${fmtVal(displayParam.max_value)}`],
        ['Scale', displayParam.display_scale !== 1.0 ? `÷${displayParam.display_scale}` : '-'],
        ['Source', p && stock ? 'Both (Tune+Stock)' : p ? 'Tune only' : 'Stock only'],
    ];
    for (const [label, value] of infoItems) {
        infoGrid.appendChild(el('div', { class: 'info-item' },
            el('span', { class: 'info-label' }, label + ':'),
            el('span', { class: 'info-value' }, value)
        ));
    }
    pane.appendChild(infoGrid);

    // Long description
    if (displayParam.long_description) {
        pane.appendChild(el('div', { class: 'detail-longdesc' }, displayParam.long_description));
    }

    // Action buttons
    const btnRow = el('div', { class: 'detail-btns' });
    const isFav = App.favorites.has(aufId);
    const favBtn = el('button', { class: 'btn' + (isFav ? ' btn-accent' : '') }, isFav ? '★ Favorited' : '☆ Favorite');
    favBtn.addEventListener('click', () => {
        if (App.favorites.has(aufId)) App.favorites.delete(aufId); else App.favorites.add(aufId);
        buildDetailView(pane, aufId);
        refreshParamList();
    });
    btnRow.appendChild(favBtn);

    if (p) {
        const revertBtn = el('button', { class: 'btn btn-danger' }, 'Revert to Stock');
        revertBtn.addEventListener('click', () => revertToStock(aufId, pane));
        btnRow.appendChild(revertBtn);
    }
    pane.appendChild(btnRow);

    // Value grid
    if (displayParam.is_char) {
        buildCharEditor(pane, aufId, displayParam, p);
    } else {
        buildValueGrid(pane, aufId, displayParam, p, stock);
    }
}

function buildCharEditor(pane, aufId, param, tuneParam) {
    const section = el('div', { class: 'detail-section' },
        el('div', { class: 'section-title' }, 'Character Data')
    );
    const val = param.getCharString();
    const input = el('input', { type: 'text', class: 'char-input', value: val });
    section.appendChild(input);

    if (tuneParam) {
        const saveBtn = el('button', { class: 'btn btn-primary', onclick: () => {
            const newStr = input.value;
            const oldVals = tuneParam.getValues();
            if (updateCharValues(App.tec, aufId, newStr)) {
                pushUndo(aufId, oldVals, tuneParam.getValues());
                setStatus(`Updated ${aufId}`, 'success');
                App.modified = true;
                updateModifiedIndicator();
                refreshParamList();
            }
        }}, 'Save');
        section.appendChild(saveBtn);
    }
    pane.appendChild(section);
}

function buildValueGrid(pane, aufId, displayParam, tuneParam, stockParam) {
    const vals = displayParam.getValues();
    if (!vals.length) {
        pane.appendChild(el('div', { class: 'empty-msg' }, 'No values available'));
        return;
    }

    const stockVals = stockParam ? stockParam.getValues() : null;
    const nCols = displayParam.num_cols || 1;
    const nRows = displayParam.num_rows || 1;
    const is2D = displayParam.is_table;

    // Compute heatmap range
    const numericVals = vals.filter(v => isFinite(v));
    const vmin = numericVals.length ? Math.min(...numericVals) : 0;
    const vmax = numericVals.length ? Math.max(...numericVals) : 1;

    // X-axis reference
    let xAxisVals = null, yAxisVals = null;
    if (displayParam.x_axis_ref && App.tec) {
        const xp = App.tec.parameters[displayParam.x_axis_ref] || App.tec.stock_defs[displayParam.x_axis_ref];
        if (xp) xAxisVals = xp.getValues();
    }
    if (displayParam.y_axis_ref && App.tec) {
        const yp = App.tec.parameters[displayParam.y_axis_ref] || App.tec.stock_defs[displayParam.y_axis_ref];
        if (yp) yAxisVals = yp.getValues();
    }

    const section = el('div', { class: 'detail-section' });
    const titleRow = el('div', { class: 'section-title-row' },
        el('span', { class: 'section-title' },
            is2D ? `Table (${nRows} rows × ${nCols} cols)` :
            vals.length > 1 ? `Array (${vals.length} values)` : 'Scalar'
        )
    );
    section.appendChild(titleRow);

    const gridWrap = el('div', { class: 'grid-wrap' });
    const table = el('table', { class: 'value-grid' });

    // Header row for 2D tables
    if (is2D && xAxisVals) {
        const thead = document.createElement('thead');
        const hrow = document.createElement('tr');
        hrow.appendChild(el('th', { class: 'grid-corner' }, ''));
        for (let c = 0; c < nCols; c++) {
            hrow.appendChild(el('th', { class: 'grid-axis-header' },
                fmtVal(xAxisVals[c] ?? c)));
        }
        thead.appendChild(hrow);
        table.appendChild(thead);
    }

    const tbody = document.createElement('tbody');
    const pendingEdits = {};
    const cellEls = {};

    for (let r = 0; r < (is2D ? nRows : 1); r++) {
        const tr = document.createElement('tr');
        if (is2D && yAxisVals) {
            tr.appendChild(el('td', { class: 'grid-axis-header' }, fmtVal(yAxisVals[r] ?? r)));
        }
        const colCount = is2D ? nCols : vals.length;
        for (let c = 0; c < colCount; c++) {
            const idx = is2D ? r * nCols + c : c;
            const v = vals[idx];
            const sv = stockVals ? stockVals[idx] : null;
            const isModCell = sv !== null && sv !== undefined && Math.abs(v - sv) > 1e-6;

            const bg = App.heatmapEnabled && isFinite(v) ? heatmapColor(v, vmin, vmax) : C.cellBg;
            const td = el('td', {
                class: 'grid-cell' + (isModCell ? ' cell-modified' : ''),
                style: { background: bg, color: C.cellText },
                title: sv !== null && sv !== undefined ? `Stock: ${fmtVal(sv)}` : ''
            }, fmtVal(v));

            if (tuneParam) {
                td.style.cursor = 'pointer';
                td.addEventListener('click', () => startCellEdit(td, aufId, idx, v, vals, pendingEdits, cellEls, displayParam, stockVals, vmin, vmax));
            }
            cellEls[idx] = td;
            tr.appendChild(td);
        }
        tbody.appendChild(tr);
    }
    table.appendChild(tbody);
    gridWrap.appendChild(table);
    section.appendChild(gridWrap);

    if (tuneParam) {
        const saveBtn = el('button', { class: 'btn btn-primary', style: { marginTop: '8px' }, onclick: () => {
            savePendingEdits(aufId, pendingEdits, vals, cellEls, displayParam, stockVals, vmin, vmax);
        }}, 'Save Changes');
        const revertBtn = el('button', { class: 'btn', style: { marginTop: '8px', marginLeft: '8px' }, onclick: () => {
            Object.keys(pendingEdits).forEach(k => {
                delete pendingEdits[k];
                const td = cellEls[parseInt(k)];
                const v = vals[parseInt(k)];
                if (td) {
                    td.textContent = fmtVal(v);
                    td.classList.remove('cell-pending');
                    const bg = App.heatmapEnabled && isFinite(v) ? heatmapColor(v, vmin, vmax) : C.cellBg;
                    td.style.background = bg;
                }
            });
        }}, 'Discard Changes');
        const copyBtn = el('button', { class: 'btn', style: { marginTop: '8px', marginLeft: '8px' }, onclick: () => {
            const allVals = Object.keys(pendingEdits).length > 0
                ? vals.map((v, i) => pendingEdits[i] !== undefined ? pendingEdits[i] : v)
                : vals;
            navigator.clipboard.writeText(allVals.map(fmtVal).join('\t'));
            setStatus('Values copied to clipboard', 'success');
        }}, 'Copy Values');
        section.appendChild(el('div', {}, saveBtn, revertBtn, copyBtn));
    }

    pane.appendChild(section);
}

function startCellEdit(td, aufId, idx, oldVal, vals, pendingEdits, cellEls, param, stockVals, vmin, vmax) {
    const input = el('input', {
        type: 'text',
        class: 'cell-input',
        value: String(pendingEdits[idx] !== undefined ? pendingEdits[idx] : oldVal)
    });
    td.innerHTML = '';
    td.appendChild(input);
    input.focus();
    input.select();

    const commit = () => {
        const newVal = parseFloat(input.value);
        if (isNaN(newVal)) {
            td.textContent = fmtVal(pendingEdits[idx] !== undefined ? pendingEdits[idx] : oldVal);
        } else {
            pendingEdits[idx] = newVal;
            td.textContent = fmtVal(newVal);
            td.classList.add('cell-pending');
            const bg = App.heatmapEnabled && isFinite(newVal) ? heatmapColor(newVal, vmin, vmax) : C.cellBg;
            td.style.background = bg;
        }
    };

    input.addEventListener('blur', commit);
    input.addEventListener('keydown', (e) => {
        if (e.key === 'Enter') { commit(); e.preventDefault(); }
        if (e.key === 'Escape') {
            td.textContent = fmtVal(pendingEdits[idx] !== undefined ? pendingEdits[idx] : oldVal);
            e.preventDefault();
        }
        // Tab to next cell
        if (e.key === 'Tab') {
            e.preventDefault();
            commit();
            const nextIdx = idx + (e.shiftKey ? -1 : 1);
            if (cellEls[nextIdx]) {
                const v = vals[nextIdx];
                startCellEdit(cellEls[nextIdx], aufId, nextIdx, v, vals, pendingEdits, cellEls, param, stockVals, vmin, vmax);
            }
        }
    });
}

function savePendingEdits(aufId, pendingEdits, oldVals, cellEls, param, stockVals, vmin, vmax) {
    if (!Object.keys(pendingEdits).length) { setStatus('No changes to save', 'info'); return; }
    const newVals = oldVals.map((v, i) => pendingEdits[i] !== undefined ? pendingEdits[i] : v);
    const oldValsSnapshot = [...oldVals];
    if (updateParamValues(App.tec, aufId, newVals)) {
        pushUndo(aufId, oldValsSnapshot, [...newVals]);
        // Clear pending
        Object.keys(pendingEdits).forEach(k => {
            delete pendingEdits[k];
            const td = cellEls[parseInt(k)];
            if (td) td.classList.remove('cell-pending');
        });
        setStatus(`Saved ${aufId}`, 'success');
        App.modified = true;
        updateModifiedIndicator();
        refreshParamList();
    } else {
        setStatus(`Failed to save ${aufId}`, 'error');
    }
}

function revertToStock(aufId, pane) {
    const stock = App.tec.stock_defs[aufId];
    if (!stock) { setStatus('No stock values available', 'error'); return; }
    const stockVals = stock.getValues();
    if (!stockVals.length) return;
    const param = App.tec.parameters[aufId];
    const oldVals = param ? param.getValues() : [];
    if (updateParamValues(App.tec, aufId, stockVals)) {
        pushUndo(aufId, oldVals, [...stockVals]);
        setStatus(`Reverted ${aufId} to stock`, 'success');
        App.modified = true;
        updateModifiedIndicator();
        refreshParamList();
        buildDetailView(pane, aufId);
    }
}

// ── Undo / Redo ────────────────────────────────────────────────────────────────
function pushUndo(aufId, oldVals, newVals) {
    App.undoStack.push({ aufId, oldVals: [...oldVals], newVals: [...newVals] });
    if (App.undoStack.length > App.maxUndo) App.undoStack.shift();
    App.redoStack = [];
}

function undo() {
    if (!App.undoStack.length) return;
    const { aufId, oldVals, newVals } = App.undoStack.pop();
    updateParamValues(App.tec, aufId, oldVals);
    App.redoStack.push({ aufId, oldVals, newVals });
    refreshParamList();
    setStatus(`Undone: ${aufId}`, 'info');
}

function redo() {
    if (!App.redoStack.length) return;
    const { aufId, oldVals, newVals } = App.redoStack.pop();
    updateParamValues(App.tec, aufId, newVals);
    App.undoStack.push({ aufId, oldVals, newVals });
    refreshParamList();
    setStatus(`Redone: ${aufId}`, 'info');
}

// ── File open / save ──────────────────────────────────────────────────────────
function openFile(slot = 1) {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.tec,.bin';
    input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        await loadFileData(file, slot);
    });
    input.click();
}

async function loadFileData(file, slot = 1) {
    setStatus(`Loading ${file.name}...`, 'info');
    try {
        const data = await file.arrayBuffer();
        const uint8 = new Uint8Array(data);

        const progressCallback = (done, total, msg) => {
            setStatus(`${msg} (${done}%)`, 'info');
        };

        const tec = await autoLoadFile(uint8, file.name, progressCallback);

        if (slot === 1) {
            App.tec = tec;
            App.currentFile = file.name;
            App.modified = false;
            App.currentParam = null;
            App.currentCategory = '';
            App.currentGroup = '';
            App.undoStack = [];
            App.redoStack = [];
            App.recentFiles = [file.name, ...App.recentFiles.filter(f => f !== file.name)].slice(0, 8);

            updateWorkspaceBar();
            buildNavTree();
            refreshParamList();
            setStatus(`Loaded ${file.name} — ${Object.keys(tec.parameters).length} parameters`, 'success');
        } else {
            App.tec2 = tec;
            App.currentFile2 = file.name;
            // Update compare modal if open
            const fileBLabel = document.getElementById('compare-file-b');
            const goBtn = document.getElementById('compare-go-btn');
            if (fileBLabel) fileBLabel.textContent = file.name;
            if (goBtn) goBtn.disabled = false;
            setStatus(`Loaded File B: ${file.name} — ${Object.keys(tec.parameters).length} parameters`, 'success');
        }
    } catch (e) {
        setStatus(`Error loading file: ${e.message}`, 'error');
        console.error(e);
    }
}

async function saveFile() {
    if (!App.tec) { setStatus('No file loaded', 'error'); return; }
    setStatus('Saving...', 'info');
    try {
        const data = await saveTecFile(App.tec);
        const blob = new Blob([data], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = App.currentFile || 'tune.tec';
        a.click();
        URL.revokeObjectURL(url);
        App.modified = false;
        updateModifiedIndicator();
        setStatus(`Saved ${App.currentFile}`, 'success');
    } catch (e) {
        setStatus(`Save failed: ${e.message}`, 'error');
        console.error(e);
    }
}

async function saveFileAs() {
    if (!App.tec) return;
    setStatus('Saving...', 'info');
    try {
        const data = await saveTecFile(App.tec);
        const blob = new Blob([data], { type: 'application/octet-stream' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        const ext = App.tec.is_tec_file ? '.tec' : '.bin';
        a.download = (App.currentFile || 'tune').replace(/\.[^.]+$/, '') + '_modified' + ext;
        a.click();
        URL.revokeObjectURL(url);
        setStatus('File saved', 'success');
    } catch (e) {
        setStatus(`Save failed: ${e.message}`, 'error');
    }
}

function exportCSV() {
    if (!App.tec) return;
    const rows = ['auF ID,Description,Value,Stock,Type,Units,Category'];
    const modIds = getModifiedAufIds();
    for (const aufId of App.tec.getVisibleParams()) {
        const p = App.tec.parameters[aufId] || App.tec.stock_defs[aufId];
        const stock = App.tec.stock_defs[aufId];
        if (!p || p.is_hidden) continue;
        const vals = p.getValues();
        const sVals = stock ? stock.getValues() : [];
        const valStr = p.is_char ? p.getCharString() : vals.map(fmtVal).join(';');
        const stockStr = sVals.map(fmtVal).join(';');
        rows.push([aufId, p.display_name, valStr, stockStr, p.data_type, p.units, p.display_category]
            .map(v => `"${String(v || '').replace(/"/g, '""')}"`).join(','));
    }
    const blob = new Blob([rows.join('\n')], { type: 'text/csv' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = (App.currentFile || 'tune').replace(/\.[^.]+$/, '') + '_params.csv';
    a.click();
    URL.revokeObjectURL(url);
    setStatus('CSV exported', 'success');
}

// ── Workspace bar ─────────────────────────────────────────────────────────────
function updateWorkspaceBar() {
    const titleEl = $('#workspace-title');
    const metaEl = $('#workspace-meta');
    if (!titleEl) return;
    if (!App.tec) {
        titleEl.textContent = 'Workspace: no file loaded';
        if (metaEl) metaEl.textContent = '';
        return;
    }
    const h = App.tec.header;
    titleEl.textContent = App.currentFile || 'Untitled';
    if (metaEl) {
        const parts = [
            h.year ? `Year: ${h.year}` : '',
            h.strategy ? `Strategy: ${h.strategy}` : '',
            h.vin ? `VIN: ${h.vin}` : '',
            h.cpu ? `CPU: ${h.cpu}` : '',
        ].filter(Boolean);
        metaEl.textContent = parts.join('  |  ');
    }
}

// ── Compare files tab ─────────────────────────────────────────────────────────
function openCompareTab() {
    if (!App.tec || !App.tec2) {
        setStatus('Load a second file to compare', 'info');
        return;
    }
    addTab('compare', 'Compare Files', (pane) => buildCompareView(pane), true);
}

function buildCompareView(pane) {
    pane.innerHTML = '';
    pane.className = 'tab-pane compare-pane';

    if (!App.tec || !App.tec2) {
        pane.innerHTML = '<div class="empty-msg">Load two files to compare. Use File > Compare Files…</div>';
        return;
    }

    const header = el('div', { class: 'compare-header' },
        el('div', { class: 'compare-file-label' }, `A: ${App.currentFile}`),
        el('div', { class: 'compare-vs' }, 'vs'),
        el('div', { class: 'compare-file-label' }, `B: ${App.currentFile2}`)
    );
    pane.appendChild(header);

    setStatus('Comparing files...', 'info');
    const diffs = compareFiles(App.tec, App.tec2);
    setStatus(`Found ${diffs.length} differences`, 'info');

    const searchBox = el('input', { type: 'text', class: 'search-input', placeholder: 'Filter by auF ID or description...' });
    pane.appendChild(el('div', { class: 'compare-toolbar' }, searchBox));

    const table = el('table', { class: 'compare-table' });
    const thead = el('thead', {},
        el('tr', {},
            el('th', {}, 'auF ID'), el('th', {}, 'Description'),
            el('th', {}, 'Value A'), el('th', {}, 'Value B'), el('th', {}, 'Diff')
        )
    );
    table.appendChild(thead);

    const tbody = el('tbody');
    const renderDiffs = (filter = '') => {
        tbody.innerHTML = '';
        for (const d of diffs) {
            const p = App.tec.parameters[d.auf_id] || App.tec.stock_defs[d.auf_id];
            const desc = p ? p.display_name : '';
            if (filter) {
                const h = (d.auf_id + ' ' + desc).toLowerCase();
                if (!filter.toLowerCase().split(/\s+/).every(t => h.includes(t))) continue;
            }
            if (d.type === 'only_a' || d.type === 'only_b') {
                const tr = el('tr', { class: 'diff-only' },
                    el('td', {}, d.auf_id), el('td', {}, desc),
                    el('td', {}, d.type === 'only_a' ? 'present' : '-'),
                    el('td', {}, d.type === 'only_b' ? 'present' : '-'),
                    el('td', {}, d.type === 'only_a' ? 'Only in A' : 'Only in B')
                );
                tr.addEventListener('dblclick', () => openDetailTab(d.auf_id));
                tbody.appendChild(tr);
            } else {
                const vA = d.values_a || [];
                const vB = d.values_b || [];
                const valAStr = vA.length === 1 ? fmtVal(vA[0]) : `[${vA.length}]`;
                const valBStr = vB.length === 1 ? fmtVal(vB[0]) : `[${vB.length}]`;
                let diffStr = '';
                if (vA.length === 1 && vB.length === 1 && isFinite(vA[0]) && isFinite(vB[0])) {
                    const d = vA[0] - vB[0];
                    diffStr = (d > 0 ? '+' : '') + fmtVal(d);
                }
                const tr = el('tr', { class: 'diff-changed' },
                    el('td', {}, d.auf_id), el('td', {}, desc),
                    el('td', { class: 'diff-val-a' }, valAStr),
                    el('td', { class: 'diff-val-b' }, valBStr),
                    el('td', { class: 'diff-delta' }, diffStr)
                );
                tr.addEventListener('dblclick', () => openDetailTab(d.auf_id));
                tbody.appendChild(tr);
            }
        }
    };

    renderDiffs();
    searchBox.addEventListener('input', () => renderDiffs(searchBox.value));
    table.appendChild(tbody);
    pane.appendChild(table);
}

// ── Search tab ────────────────────────────────────────────────────────────────
function openSearchTab() {
    addTab('search', 'Value Search', (pane) => buildSearchView(pane), true);
}

function buildSearchView(pane) {
    pane.className = 'tab-pane';
    pane.innerHTML = `
        <div class="tool-header">
            <h2 class="tool-title">Search Parameter Values</h2>
            <p class="tool-desc">Search for parameters by value. Supports exact match, range, and pattern.</p>
        </div>
        <div class="search-form">
            <label>Search value: <input type="text" id="val-search-input" class="input" placeholder="e.g. 1.5 or 1.0-2.0"></label>
            <label>Search mode:
                <select id="val-search-mode" class="select">
                    <option value="exact">Exact match</option>
                    <option value="range">Range (min-max)</option>
                    <option value="approx">Approximate (±5%)</option>
                </select>
            </label>
            <button class="btn btn-primary" id="val-search-btn">Search</button>
        </div>
        <div id="val-search-results"></div>
    `;

    pane.querySelector('#val-search-btn').addEventListener('click', () => {
        const query = pane.querySelector('#val-search-input').value;
        const mode = pane.querySelector('#val-search-mode').value;
        const results = searchParamValues(query, mode);
        const container = pane.querySelector('#val-search-results');
        if (!results.length) { container.innerHTML = '<div class="empty-msg">No matches found</div>'; return; }

        const table = el('table', { class: 'compare-table' });
        table.innerHTML = `<thead><tr><th>auF ID</th><th>Description</th><th>Value</th><th>Units</th></tr></thead>`;
        const tbody = el('tbody');
        for (const r of results) {
            const tr = el('tr', {},
                el('td', {}, r.aufId), el('td', {}, r.desc),
                el('td', {}, fmtVal(r.value)), el('td', {}, r.units)
            );
            tr.addEventListener('dblclick', () => openDetailTab(r.aufId));
            tbody.appendChild(tr);
        }
        table.appendChild(tbody);
        container.innerHTML = '';
        container.appendChild(el('div', { class: 'search-summary' }, `${results.length} matches`));
        container.appendChild(table);
    });
}

function searchParamValues(query, mode) {
    if (!App.tec) return [];
    const results = [];
    let target = parseFloat(query);
    let rangeMin, rangeMax;
    if (mode === 'range') {
        const parts = query.split('-').map(s => parseFloat(s.trim()));
        if (parts.length === 2 && isFinite(parts[0]) && isFinite(parts[1])) {
            rangeMin = Math.min(parts[0], parts[1]);
            rangeMax = Math.max(parts[0], parts[1]);
        }
    }

    for (const aufId of App.tec.getVisibleParams()) {
        const p = App.tec.parameters[aufId] || App.tec.stock_defs[aufId];
        if (!p || p.is_hidden) continue;
        const vals = p.getValues();
        for (const v of vals) {
            let match = false;
            if (mode === 'exact') match = Math.abs(v - target) < 1e-9;
            else if (mode === 'range' && rangeMin !== undefined) match = v >= rangeMin && v <= rangeMax;
            else if (mode === 'approx') {
                if (target === 0) match = Math.abs(v) < 1e-6;
                else match = Math.abs((v - target) / target) <= 0.05;
            }
            if (match) {
                results.push({ aufId, desc: p.display_name, value: v, units: p.units || '' });
                break;
            }
        }
    }
    return results;
}

// ── XML Scrambler tab ─────────────────────────────────────────────────────────
function openXmlScramblerTab() {
    addTab('xml-scrambler', 'XML Scrambler', (pane) => buildXmlScramblerView(pane), true);
}

function buildXmlScramblerView(pane) {
    pane.className = 'tab-pane';
    pane.innerHTML = `
        <div class="tool-header">
            <h2 class="tool-title">XML Scrambler</h2>
            <p class="tool-desc">Scramble PCMTec XML values to generate unique signatures for offset mapping.</p>
        </div>
        <div class="tool-row">
            <button class="btn" id="xml-load-btn">Load XML File…</button>
            <span id="xml-filename" class="file-label">No file loaded</span>
        </div>
        <div class="tool-row">
            <label>Seed (optional): <input type="number" id="xml-seed" class="input-small" placeholder="random"></label>
            <button class="btn btn-primary" id="xml-scramble-btn" disabled>Scramble & Download</button>
        </div>
        <div id="xml-stats" class="tool-stats"></div>
        <div id="xml-preview" class="code-preview"></div>
    `;

    let xmlContent = null;
    let xmlFilename = null;

    pane.querySelector('#xml-load-btn').addEventListener('click', () => {
        const input = document.createElement('input');
        input.type = 'file';
        input.accept = '.xml';
        input.addEventListener('change', async (e) => {
            const file = e.target.files[0];
            if (!file) return;
            xmlContent = await file.text();
            xmlFilename = file.name;
            pane.querySelector('#xml-filename').textContent = file.name;
            pane.querySelector('#xml-scramble-btn').disabled = false;
            pane.querySelector('#xml-preview').textContent = xmlContent.slice(0, 500) + (xmlContent.length > 500 ? '...' : '');
        });
        input.click();
    });

    pane.querySelector('#xml-scramble-btn').addEventListener('click', () => {
        if (!xmlContent) return;
        const seedInput = pane.querySelector('#xml-seed').value;
        const seed = seedInput ? parseInt(seedInput) : null;
        const scrambler = new XMLScrambler({ seed });
        const { result, stats } = scrambler.scramble(xmlContent);
        pane.querySelector('#xml-stats').textContent =
            `Scrambled ${stats.params} parameters, ${stats.changed} values changed. Seed: ${scrambler.seed}`;
        const blob = new Blob([result], { type: 'text/xml' });
        const url = URL.createObjectURL(blob);
        const a = document.createElement('a');
        a.href = url;
        a.download = (xmlFilename || 'scrambled').replace('.xml', '_scrambled.xml');
        a.click();
        URL.revokeObjectURL(url);
        setStatus('XML scrambled and downloaded', 'success');
    });
}

// ── Vehicle Info tab ──────────────────────────────────────────────────────────
function openVehicleInfoTab() {
    addTab('vehicle-info', 'Vehicle Info', (pane) => buildVehicleInfoView(pane), true);
}

function buildVehicleInfoView(pane) {
    pane.className = 'tab-pane';
    if (!App.tec) { pane.innerHTML = '<div class="empty-msg">No file loaded</div>'; return; }
    const h = App.tec.header;
    const items = [
        ['Filename', h.filename], ['Year', h.year], ['Strategy', h.strategy],
        ['CPU Code', h.cpu_code], ['Base Strategy', h.base_strategy], ['Base CPU', h.base_cpu],
        ['VIN', h.vin], ['CPU', h.cpu], ['Serial', h.serial], ['PCM Count', h.pcm_count],
    ];
    const table = el('table', { class: 'info-table' });
    for (const [label, value] of items) {
        if (!value && value !== 0) continue;
        table.appendChild(el('tr', {},
            el('td', { class: 'info-label' }, label),
            el('td', { class: 'info-value' }, String(value))
        ));
    }
    pane.innerHTML = '<div class="tool-header"><h2 class="tool-title">Vehicle Information</h2></div>';
    pane.appendChild(table);
}

// ── Statistics tab ────────────────────────────────────────────────────────────
function openStatisticsTab() {
    addTab('statistics', 'Statistics', (pane) => buildStatisticsView(pane), true);
}

function buildStatisticsView(pane) {
    pane.className = 'tab-pane';
    if (!App.tec) { pane.innerHTML = '<div class="empty-msg">No file loaded</div>'; return; }

    const params = Object.keys(App.tec.parameters);
    const stocks = Object.keys(App.tec.stock_defs);
    const modIds = getModifiedAufIds();
    const cats = Object.keys(App.tec.getVisibleCategories());

    pane.innerHTML = `
        <div class="tool-header"><h2 class="tool-title">File Statistics</h2></div>
        <div class="stats-grid">
            <div class="stat-card"><div class="stat-num">${params.length}</div><div class="stat-label">Tune Parameters</div></div>
            <div class="stat-card"><div class="stat-num">${stocks.length}</div><div class="stat-label">Stock Definitions</div></div>
            <div class="stat-card"><div class="stat-num">${modIds.size}</div><div class="stat-label">Modified Parameters</div></div>
            <div class="stat-card"><div class="stat-num">${cats.length}</div><div class="stat-label">Categories</div></div>
            <div class="stat-card"><div class="stat-num">${Object.keys(App.tec.getVisibleGroups()).length}</div><div class="stat-label">Groups</div></div>
            <div class="stat-card"><div class="stat-num">${App.tec.is_tec_file ? '.tec' : '.bin'}</div><div class="stat-label">File Type</div></div>
        </div>
    `;
}

// ── Hex Viewer tab ────────────────────────────────────────────────────────────
function openHexViewerTab(aufId = null) {
    const tabId = aufId ? `hex-${aufId}` : 'hex-viewer';
    addTab(tabId, aufId ? `Hex: ${aufId}` : 'Hex Viewer', (pane) => buildHexView(pane, aufId), true);
}

function buildHexView(pane, aufId = null) {
    pane.className = 'tab-pane';
    pane.innerHTML = '';

    let data = null;
    let label = 'No data';

    if (aufId && App.tec) {
        const p = App.tec.parameters[aufId];
        if (p && p._proto_field && p._proto_field.payload) {
            data = p._proto_field.payload;
            label = `Parameter: ${aufId}`;
        }
    } else if (App.tec && App.tec._raw_data) {
        data = App.tec._raw_data.slice(0, 4096);
        label = 'Raw protobuf data (first 4KB)';
    }

    const header = el('div', { class: 'tool-header' },
        el('h2', { class: 'tool-title' }, 'Hex Viewer'),
        el('p', { class: 'tool-desc' }, label)
    );
    pane.appendChild(header);

    if (!data) { pane.appendChild(el('div', { class: 'empty-msg' }, 'No data to display')); return; }

    const hexWrap = el('div', { class: 'hex-viewer' });
    const lines = [];
    for (let i = 0; i < Math.min(data.length, 16384); i += 16) {
        const chunk = data.slice(i, i + 16);
        const offset = `${i.toString(16).padStart(8, '0')}`;
        const hex = Array.from(chunk).map(b => b.toString(16).padStart(2, '0')).join(' ');
        const ascii = Array.from(chunk).map(b => b >= 32 && b < 127 ? String.fromCharCode(b) : '.').join('');
        lines.push(`${offset}  ${hex.padEnd(47)}  ${ascii}`);
    }
    hexWrap.textContent = lines.join('\n');
    if (data.length > 16384) hexWrap.textContent += '\n... (truncated)';
    pane.appendChild(hexWrap);
}

// ── CSV Import ────────────────────────────────────────────────────────────────
function importCSV() {
    const input = document.createElement('input');
    input.type = 'file';
    input.accept = '.csv';
    input.addEventListener('change', async (e) => {
        const file = e.target.files[0];
        if (!file) return;
        const text = await file.text();
        const lines = text.split('\n').map(l => l.trim()).filter(l => l);
        if (!lines.length) return;
        const header = lines[0].split(',').map(h => h.trim().replace(/^"|"$/g, '').toLowerCase());
        const idCol = header.findIndex(h => ['auf id','aufid','auf_id','id'].includes(h));
        const valCol = header.findIndex(h => ['value','values'].includes(h));
        if (idCol === -1 || valCol === -1) { setStatus('CSV must have "auF ID" and "Value" columns', 'error'); return; }

        let updated = 0;
        for (let i = 1; i < lines.length; i++) {
            const cols = lines[i].split(',').map(c => c.trim().replace(/^"|"$/g, ''));
            const aufId = normalizeAufId(cols[idCol]);
            if (!aufId || !App.tec) continue;
            const valStr = cols[valCol];
            const vals = valStr.split(';').map(v => parseFloat(v.trim())).filter(v => isFinite(v));
            if (vals.length && updateParamValues(App.tec, aufId, vals)) updated++;
        }
        refreshParamList();
        setStatus(`CSV imported: ${updated} parameters updated`, 'success');
    });
    input.click();
}

// ── Goto auF ID ───────────────────────────────────────────────────────────────
function gotoAufId() {
    const raw = prompt('Go to auF ID:');
    if (!raw) return;
    const aufId = normalizeAufId(raw) || raw;
    if (App.tec && (App.tec.parameters[aufId] || App.tec.stock_defs[aufId])) {
        App.currentCategory = '';
        App.currentGroup = '';
        App.searchText = aufId;
        if ($('#search-input')) $('#search-input').value = aufId;
        buildNavTree();
        refreshParamList();
        activateTab('params');
        selectParam(aufId);
    } else {
        setStatus(`auF ID not found: ${aufId}`, 'error');
    }
}

// ── Keyboard shortcuts ────────────────────────────────────────────────────────
document.addEventListener('keydown', (e) => {
    const mod = e.ctrlKey || e.metaKey;
    if (mod && e.key === 'o') { e.preventDefault(); openFile(); }
    if (mod && e.key === 's') { e.preventDefault(); saveFile(); }
    if (mod && e.key === 'z') { e.preventDefault(); undo(); }
    if (mod && (e.key === 'y' || (e.shiftKey && e.key === 'Z'))) { e.preventDefault(); redo(); }
    if (mod && e.key === 'g') { e.preventDefault(); gotoAufId(); }
    if (mod && e.key === 'f') { e.preventDefault(); $('#search-input')?.focus(); }
    if (e.key === 'F5') { e.preventDefault(); if (App.currentParam) { App.favorites.has(App.currentParam) ? App.favorites.delete(App.currentParam) : App.favorites.add(App.currentParam); refreshParamList(); } }
    if (mod && e.key === '1') { e.preventDefault(); activateTab('params'); }
    if (mod && e.key === '0') { e.preventDefault(); clearAllFilters(); }
});

function clearAllFilters() {
    App.searchText = '';
    App.typeFilter = 'All';
    App.changedOnly = false;
    App.favOnly = false;
    App.currentCategory = '';
    App.currentGroup = '';
    if ($('#search-input')) $('#search-input').value = '';
    if ($('#type-filter')) $('#type-filter').value = 'All';
    if ($('#changed-only')) $('#changed-only').checked = false;
    if ($('#fav-only')) $('#fav-only').checked = false;
    buildNavTree();
    refreshParamList();
}

// ── Sort ──────────────────────────────────────────────────────────────────────
function sortByColumn(col) {
    if (App.sortCol === col) App.sortReverse = !App.sortReverse;
    else { App.sortCol = col; App.sortReverse = false; }
    $$('.col-header').forEach(th => {
        th.classList.remove('sort-asc', 'sort-desc');
        if (th.dataset.col === col) th.classList.add(App.sortReverse ? 'sort-desc' : 'sort-asc');
    });
    refreshParamList();
}

// ── Drag-and-drop file loading ────────────────────────────────────────────────
function setupDragDrop() {
    const dropZone = document.body;
    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); document.body.classList.add('drag-over'); });
    dropZone.addEventListener('dragleave', () => document.body.classList.remove('drag-over'));
    dropZone.addEventListener('drop', async (e) => {
        e.preventDefault();
        document.body.classList.remove('drag-over');
        const file = e.dataTransfer.files[0];
        if (file) await loadFileData(file, 1);
    });
}

// ── Initial build ──────────────────────────────────────────────────────────────
function init() {
    setupDragDrop();

    // Build permanent params tab
    addTab('params', 'Parameters', (pane) => {
        pane.className = 'tab-pane params-pane';
        pane.innerHTML = `
            <div id="split-preview" class="split-preview" style="display:none">
                <div class="preview-main">
                    <span id="preview-id" class="preview-id"></span>
                    <span id="preview-name" class="preview-name"></span>
                </div>
                <div id="preview-value" class="preview-value"></div>
                <div id="preview-meta" class="preview-meta"></div>
                <div class="preview-btns">
                    <button class="btn btn-primary btn-sm" onclick="openDetailTab(App.currentParam)">Open Detail</button>
                    <button class="btn btn-sm" onclick="if(App.currentParam){App.favorites.has(App.currentParam)?App.favorites.delete(App.currentParam):App.favorites.add(App.currentParam);refreshParamList()}">Toggle Fav</button>
                </div>
            </div>
            <div id="param-filter-bar" class="filter-bar">
                <span id="param-summary" class="param-summary">No file loaded</span>
                <div class="filter-controls">
                    <select id="type-filter" class="select" title="Filter by type">
                        <option>All</option><option>Scalars</option><option>Tables</option><option>Arrays</option>
                    </select>
                    <label class="checkbox-label"><input type="checkbox" id="changed-only"> Changed</label>
                    <label class="checkbox-label"><input type="checkbox" id="fav-only"> Favorites</label>
                </div>
            </div>
            <div class="table-wrap">
                <table class="param-table" id="param-table">
                    <thead>
                        <tr>
                            <th class="col-header" data-col="id" onclick="sortByColumn('id')">auF ID</th>
                            <th class="col-header" data-col="name" onclick="sortByColumn('name')">Description</th>
                            <th class="col-header" data-col="value">Value</th>
                            <th class="col-header" data-col="stock">Stock</th>
                            <th class="col-header" data-col="type">Type</th>
                            <th class="col-header" data-col="units">Unit</th>
                            <th class="col-header" data-col="category" onclick="sortByColumn('category')">Category</th>
                            <th class="col-header" data-col="source">Source</th>
                        </tr>
                    </thead>
                    <tbody id="param-list-body"></tbody>
                </table>
            </div>
        `;
        // Wire up filters
        pane.querySelector('#type-filter').addEventListener('change', (e) => {
            App.typeFilter = e.target.value;
            refreshParamList();
        });
        pane.querySelector('#changed-only').addEventListener('change', (e) => {
            App.changedOnly = e.target.checked;
            refreshParamList();
        });
        pane.querySelector('#fav-only').addEventListener('change', (e) => {
            App.favOnly = e.target.checked;
            refreshParamList();
        });
    }, false);

    refreshParamList();
    setStatus('Ready — drag & drop a .tec or .bin file, or use File > Open', 'info');
}

// ── Nav mode toggle ───────────────────────────────────────────────────────────
function setNavMode(mode) {
    App.navMode = mode;
    App.currentCategory = '';
    App.currentGroup = '';
    $$('.nav-mode-btn').forEach(b => b.classList.toggle('active', b.dataset.mode === mode));
    buildNavTree();
    refreshParamList();
}
