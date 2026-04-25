// ============================================================
// ImageRef - Image Measurement Tool
// ============================================================

(() => {
  'use strict';

  // ---- Utility -------------------------------------------
  const $ = (sel) => document.querySelector(sel);
  const $$ = (sel) => [...document.querySelectorAll(sel)];
  const uid = () => Math.random().toString(36).slice(2, 10);

  function dist(x1, y1, x2, y2) {
    return Math.hypot(x2 - x1, y2 - y1);
  }

  function esc(str) {
    const d = document.createElement('div');
    d.textContent = str;
    return d.innerHTML;
  }

  function clamp(v, lo, hi) { return Math.max(lo, Math.min(hi, v)); }

  // ---- Unit Conversion ------------------------------------
  const UNITS = ['mm', 'cm', 'm', 'inch', 'mil'];
  const UNIT_TO_MM = { mm: 1, cm: 10, m: 1000, inch: 25.4, mil: 0.0254 };

  function convertUnits(value, fromUnit, toUnit) {
    if (fromUnit === toUnit) return value;
    return value * UNIT_TO_MM[fromUnit] / UNIT_TO_MM[toUnit];
  }

  function formatValue(value) {
    if (value == null || isNaN(value)) return '\u2014';
    const p = Math.abs(value) >= 100 ? 1 : Math.abs(value) >= 10 ? 2 : 3;
    return value.toFixed(p);
  }

  function formatDim(value, unit) {
    return `${formatValue(value)} ${unit}`;
  }

  // ---- Data Model ----------------------------------------
  /*
    state = {
      sessions: [Session],
      activeSessionId: null,
    }
    Session = { id, name, imageDataURL, thumb, layers: [Layer], activeLayerId }
    Layer = {
      id, name, visible,
      reference: null | RefLine,
      perspRef: null | PerspRef,
      measurements: [Measurement]
    }
    RefLine = { id, type:'reference', x1,y1,x2,y2, refValue, refUnit }
    PerspRef = { id, type:'persp-ref', points:[{x,y}*4], width, height, refUnit, homography:[8] }
    Measurement = { id, type:'line'|'rect'|'circle', x1,y1,x2,y2, displayUnit:null|string }
  */

  const STORAGE_KEY = 'imageref_sessions';
  let state = { sessions: [], activeSessionId: null };

  // ---- Interaction State ---------------------------------
  let activeTool = 'pan';
  let drawing = null;          // in-progress draw {type, x1,y1,x2,y2}
  let selectedMeasId = null;
  let undoStack = [];
  let dragging = null;         // {meas, endpointIndex, pointerId}
  let perspDrawPoints = [];    // world coords for persp-ref tool, up to 4

  // ---- Canvas / View State -------------------------------
  const canvas = $('#main-canvas');
  const ctx = canvas.getContext('2d');
  const container = $('#canvas-container');
  let img = null;
  let view = { x: 0, y: 0, scale: 1 };
  let isPanning = false;
  let panStart = { x: 0, y: 0, vx: 0, vy: 0 };
  let clickStart = null;       // for detecting clicks vs drags in pan mode
  let spaceDown = false;

  // ---- Init ----------------------------------------------
  function init() {
    loadState();
    resizeCanvas();
    window.addEventListener('resize', resizeCanvas);
    setupPaste();
    setupDragDrop();
    setupToolbar();
    setupCanvasInput();
    setupRefDialog();
    setupPerspDialog();
    setupLayerPanel();
    setupKeyboard();
    renderSidebar();
    if (state.activeSessionId) {
      switchSession(state.activeSessionId);
    }
    renderAll();
  }

  // ---- Persistence ---------------------------------------
  function saveState() {
    try {
      localStorage.setItem(STORAGE_KEY, JSON.stringify(state));
    } catch (e) { /* storage full */ }
  }

  function loadState() {
    try {
      const raw = localStorage.getItem(STORAGE_KEY);
      if (raw) {
        state = JSON.parse(raw);
        for (const s of state.sessions) {
          if (!s.layers) s.layers = [makeLayer('Layer 1')];
          if (!s.activeLayerId && s.layers.length) s.activeLayerId = s.layers[0].id;
          for (const l of s.layers) {
            if (!l.perspRef) l.perspRef = null;
            if (!l.measurements) l.measurements = [];
            if (l.perspRef) recomputeHomography(l.perspRef);
          }
        }
      }
    } catch (e) {
      state = { sessions: [], activeSessionId: null };
    }
  }

  // ---- Session Management --------------------------------
  function makeLayer(name) {
    return { id: uid(), name, visible: true, reference: null, perspRef: null, measurements: [] };
  }

  function activeSession() {
    return state.sessions.find(s => s.id === state.activeSessionId) || null;
  }

  function activeLayer() {
    const s = activeSession();
    if (!s) return null;
    return s.layers.find(l => l.id === s.activeLayerId) || null;
  }

  function createSession(imageDataURL) {
    const thumbCanvas = document.createElement('canvas');
    const thumbSize = 96;
    const tImg = new Image();
    tImg.onload = () => {
      const aspect = tImg.width / tImg.height;
      thumbCanvas.width = thumbSize;
      thumbCanvas.height = thumbSize;
      const tCtx = thumbCanvas.getContext('2d');
      tCtx.fillStyle = '#1a1a2e';
      tCtx.fillRect(0, 0, thumbSize, thumbSize);
      let dw, dh, dx, dy;
      if (aspect > 1) { dw = thumbSize; dh = thumbSize / aspect; dx = 0; dy = (thumbSize - dh) / 2; }
      else { dh = thumbSize; dw = thumbSize * aspect; dy = 0; dx = (thumbSize - dw) / 2; }
      tCtx.drawImage(tImg, dx, dy, dw, dh);
      const thumb = thumbCanvas.toDataURL('image/jpeg', 0.6);
      const session = {
        id: uid(), name: `Image ${state.sessions.length + 1}`,
        imageDataURL, thumb,
        layers: [makeLayer('Layer 1')], activeLayerId: null,
      };
      session.activeLayerId = session.layers[0].id;
      state.sessions.push(session);
      state.activeSessionId = session.id;
      saveState();
      renderSidebar();
      switchSession(session.id);
    };
    tImg.src = imageDataURL;
  }

  function switchSession(id) {
    state.activeSessionId = id;
    selectedMeasId = null;
    undoStack = [];
    drawing = null;
    dragging = null;
    perspDrawPoints = [];
    const s = activeSession();
    if (!s) {
      img = null;
      $('#empty-state').classList.remove('hidden');
      saveState();
      renderAll();
      return;
    }
    $('#empty-state').classList.add('hidden');
    img = new Image();
    img.onload = () => { fitView(); renderAll(); };
    img.src = s.imageDataURL;
    saveState();
    renderSidebar();
    renderLayerPanel();
    renderMeasurementList();
    renderAll();
  }

  function deleteSession(id) {
    state.sessions = state.sessions.filter(s => s.id !== id);
    if (state.activeSessionId === id) {
      state.activeSessionId = state.sessions.length ? state.sessions[0].id : null;
      switchSession(state.activeSessionId);
    }
    saveState();
    renderSidebar();
  }

  // ---- Sidebar Rendering ---------------------------------
  function renderSidebar() {
    const list = $('#session-list');
    list.innerHTML = '';
    for (const s of state.sessions) {
      const el = document.createElement('div');
      el.className = 'session-item' + (s.id === state.activeSessionId ? ' active' : '');
      el.innerHTML = `
        <img class="session-thumb" src="${s.thumb}" alt="">
        <div class="session-info">
          <div class="session-name">${esc(s.name)}</div>
          <div class="session-meta">${s.layers.length} layer${s.layers.length !== 1 ? 's' : ''}</div>
        </div>
        <button class="session-delete" title="Delete session">
          <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>`;
      el.querySelector('.session-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        deleteSession(s.id);
      });
      el.addEventListener('click', () => switchSession(s.id));
      list.appendChild(el);
    }
  }

  // ---- Layer Panel ---------------------------------------
  function setupLayerPanel() {
    $('#btn-add-layer').addEventListener('click', () => {
      const s = activeSession();
      if (!s) return;
      const layer = makeLayer(`Layer ${s.layers.length + 1}`);
      s.layers.push(layer);
      s.activeLayerId = layer.id;
      saveState();
      renderLayerPanel();
      renderMeasurementList();
      renderAll();
    });
  }

  function renderLayerPanel() {
    const list = $('#layer-list');
    list.innerHTML = '';
    const s = activeSession();
    if (!s) return;
    for (const layer of s.layers) {
      const el = document.createElement('div');
      el.className = 'layer-item' + (layer.id === s.activeLayerId ? ' active' : '');

      const eyeIcon = layer.visible
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M17.94 17.94A10.07 10.07 0 0112 20c-7 0-11-8-11-8a18.45 18.45 0 015.06-5.94M9.9 4.24A9.12 9.12 0 0112 4c7 0 11 8 11 8a18.5 18.5 0 01-2.16 3.19M1 1l22 22"/></svg>';

      let refBadge;
      if (layer.perspRef) {
        refBadge = `<span class="layer-ref-badge persp">persp</span>`;
      } else if (layer.reference) {
        refBadge = `<span class="layer-ref-badge">${formatDim(layer.reference.refValue, layer.reference.refUnit)}</span>`;
      } else {
        refBadge = `<span class="layer-ref-badge no-ref">no ref</span>`;
      }

      el.innerHTML = `
        <button class="layer-visibility ${layer.visible ? '' : 'hidden-layer'}" title="Toggle visibility">${eyeIcon}</button>
        <span class="layer-name">${esc(layer.name)}</span>
        ${refBadge}
        <button class="layer-delete" title="Delete layer">
          <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
            <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
          </svg>
        </button>`;

      el.querySelector('.layer-visibility').addEventListener('click', (e) => {
        e.stopPropagation();
        layer.visible = !layer.visible;
        saveState();
        renderLayerPanel();
        renderAll();
      });

      el.querySelector('.layer-delete').addEventListener('click', (e) => {
        e.stopPropagation();
        if (s.layers.length <= 1) return;
        s.layers = s.layers.filter(l => l.id !== layer.id);
        if (s.activeLayerId === layer.id) s.activeLayerId = s.layers[0].id;
        saveState();
        renderLayerPanel();
        renderMeasurementList();
        renderAll();
      });

      const nameSpan = el.querySelector('.layer-name');
      nameSpan.addEventListener('dblclick', (e) => {
        e.stopPropagation();
        const input = document.createElement('input');
        input.value = layer.name;
        nameSpan.innerHTML = '';
        nameSpan.appendChild(input);
        input.focus();
        input.select();
        const finish = () => {
          layer.name = input.value.trim() || layer.name;
          saveState();
          renderLayerPanel();
        };
        input.addEventListener('blur', finish);
        input.addEventListener('keydown', (ev) => { if (ev.key === 'Enter') input.blur(); });
      });

      el.addEventListener('click', () => {
        s.activeLayerId = layer.id;
        selectedMeasId = null;
        saveState();
        renderLayerPanel();
        renderMeasurementList();
        renderAll();
      });

      list.appendChild(el);
    }
  }

  // ---- Measurement List ----------------------------------
  function getRefUnit(layer) {
    if (layer.perspRef && layer.perspRef.refUnit) return layer.perspRef.refUnit;
    if (layer.reference) return layer.reference.refUnit;
    return null;
  }

  function renderMeasurementList() {
    const list = $('#measurement-list');
    list.innerHTML = '';
    const layer = activeLayer();
    if (!layer) return;

    // Reference line
    if (layer.reference) {
      list.appendChild(makeMeasurementItem(layer.reference, layer));
    }
    // Perspective reference
    if (layer.perspRef) {
      list.appendChild(makeMeasurementItem(layer.perspRef, layer));
    }
    // Measurements
    for (const m of layer.measurements) {
      list.appendChild(makeMeasurementItem(m, layer));
    }
  }

  function makeMeasurementItem(m, layer) {
    const el = document.createElement('div');
    el.className = 'measurement-item' + (m.id === selectedMeasId ? ' selected' : '');

    const typeClass = m.type === 'reference' ? 'ref' : m.type;
    const isRef = m.type === 'reference';
    const isPersp = m.type === 'persp-ref';

    // Compute display values
    let dimStr = '';
    let currentUnit;
    if (isRef) {
      dimStr = formatValue(m.refValue);
      currentUnit = m.refUnit;
    } else if (isPersp) {
      dimStr = `${formatValue(m.width)} \u00d7 ${formatValue(m.height)}`;
      currentUnit = m.refUnit;
    } else {
      const result = computeMeasurementValues(m, layer);
      if (result) {
        if (m.type === 'line') dimStr = formatValue(result.values[0]);
        else if (m.type === 'rect') dimStr = `${formatValue(result.values[0])} \u00d7 ${formatValue(result.values[1])}`;
        else if (m.type === 'circle') dimStr = `\u2300 ${formatValue(result.values[0])}`;
        currentUnit = result.unit;
      } else {
        dimStr = '\u2014';
        currentUnit = m.displayUnit || getRefUnit(layer) || 'mm';
      }
    }

    const dimClass = isRef ? 'ref-dim' : isPersp ? 'persp-dim' : '';

    el.innerHTML = `
      <span class="measurement-type ${typeClass}"></span>
      <span class="measurement-label">${m.type === 'persp-ref' ? 'persp ref' : m.type}</span>
      <span class="measurement-dim ${dimClass}">${dimStr}</span>
      <button class="measurement-delete" title="Delete">
        <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2">
          <line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/>
        </svg>
      </button>`;

    // Unit selector
    const select = document.createElement('select');
    select.className = 'measurement-unit-select';
    for (const u of UNITS) {
      const opt = document.createElement('option');
      opt.value = u;
      opt.textContent = u;
      if (u === currentUnit) opt.selected = true;
      select.appendChild(opt);
    }
    select.addEventListener('click', (e) => e.stopPropagation());
    select.addEventListener('change', (e) => {
      e.stopPropagation();
      const newUnit = select.value;
      if (isRef) {
        m.refValue = convertUnits(m.refValue, m.refUnit, newUnit);
        m.refUnit = newUnit;
      } else if (isPersp) {
        m.width = convertUnits(m.width, m.refUnit, newUnit);
        m.height = convertUnits(m.height, m.refUnit, newUnit);
        m.refUnit = newUnit;
      } else {
        m.displayUnit = newUnit;
      }
      saveState();
      renderMeasurementList();
      renderLayerPanel();
      renderAll();
    });

    // Insert select before delete button
    const deleteBtn = el.querySelector('.measurement-delete');
    el.insertBefore(select, deleteBtn);

    el.addEventListener('click', () => {
      selectedMeasId = m.id;
      renderMeasurementList();
      renderAll();
    });

    // Double-click to edit reference values
    el.addEventListener('dblclick', (e) => {
      e.stopPropagation();
      if (isRef) {
        refDialogMode = 'edit';
        editingRefMeas = m;
        showRefDialog(m.refValue, m.refUnit);
      } else if (isPersp) {
        perspDialogMode = 'edit';
        editingPerspMeas = m;
        showPerspDialog(m.width, m.height, m.refUnit);
      }
    });

    deleteBtn.addEventListener('click', (e) => {
      e.stopPropagation();
      deleteMeasurement(m.id);
    });

    return el;
  }

  function findMeasurementById(id, layer) {
    if (layer.reference && layer.reference.id === id) return layer.reference;
    if (layer.perspRef && layer.perspRef.id === id) return layer.perspRef;
    return layer.measurements.find(m => m.id === id) || null;
  }

  function deleteMeasurement(id) {
    const layer = activeLayer();
    if (!layer) return;
    if (layer.reference && layer.reference.id === id) {
      layer.reference = null;
    } else if (layer.perspRef && layer.perspRef.id === id) {
      layer.perspRef = null;
    } else {
      layer.measurements = layer.measurements.filter(m => m.id !== id);
    }
    if (selectedMeasId === id) selectedMeasId = null;
    saveState();
    renderLayerPanel();
    renderMeasurementList();
    renderAll();
  }

  // ---- Hit Testing ---------------------------------------
  function pointToSegDist(px, py, x1, y1, x2, y2) {
    const dx = x2 - x1, dy = y2 - y1;
    const len2 = dx * dx + dy * dy;
    if (len2 === 0) return dist(px, py, x1, y1);
    let t = ((px - x1) * dx + (py - y1) * dy) / len2;
    t = clamp(t, 0, 1);
    return dist(px, py, x1 + t * dx, y1 + t * dy);
  }

  function hitTestEndpoints(sx, sy, m) {
    // Returns endpoint index or -1. Works in screen coords.
    const threshold = 12;
    if (m.type === 'persp-ref') {
      for (let i = 0; i < m.points.length; i++) {
        const sp = worldToScreen(m.points[i].x, m.points[i].y);
        if (dist(sx, sy, sp.x, sp.y) < threshold) return i;
      }
      return -1;
    }
    // Regular measurements have endpoints at (x1,y1) and (x2,y2)
    const s1 = worldToScreen(m.x1, m.y1);
    const s2 = worldToScreen(m.x2, m.y2);
    if (dist(sx, sy, s1.x, s1.y) < threshold) return 0;
    if (dist(sx, sy, s2.x, s2.y) < threshold) return 1;
    return -1;
  }

  function hitTestBody(sx, sy, m, layer) {
    // Returns distance in screen pixels
    if (m.type === 'reference' || m.type === 'line') {
      const s1 = worldToScreen(m.x1, m.y1);
      const s2 = worldToScreen(m.x2, m.y2);
      return pointToSegDist(sx, sy, s1.x, s1.y, s2.x, s2.y);
    }
    if (m.type === 'rect') {
      const hasPerspective = layer && layer.perspRef && layer.perspRef.inverseHomography;
      if (hasPerspective) {
        const corners = getPerspRectCorners(m, layer);
        if (corners) {
          const sc = corners.map(c => worldToScreen(c.x, c.y));
          let minD = Infinity;
          for (let i = 0; i < 4; i++) {
            minD = Math.min(minD, pointToSegDist(sx, sy, sc[i].x, sc[i].y, sc[(i + 1) % 4].x, sc[(i + 1) % 4].y));
          }
          return minD;
        }
      }
      const s1 = worldToScreen(m.x1, m.y1);
      const s2 = worldToScreen(m.x2, m.y2);
      const minX = Math.min(s1.x, s2.x), maxX = Math.max(s1.x, s2.x);
      const minY = Math.min(s1.y, s2.y), maxY = Math.max(s1.y, s2.y);
      return Math.min(
        pointToSegDist(sx, sy, minX, minY, maxX, minY),
        pointToSegDist(sx, sy, maxX, minY, maxX, maxY),
        pointToSegDist(sx, sy, minX, maxY, maxX, maxY),
        pointToSegDist(sx, sy, minX, minY, minX, maxY),
      );
    }
    if (m.type === 'circle') {
      const hasPerspective = layer && layer.perspRef && layer.perspRef.inverseHomography;
      if (hasPerspective) {
        const pts = getPerspCirclePoints(m, layer, 32);
        if (pts) {
          const sc = pts.map(p => worldToScreen(p.x, p.y));
          let minD = Infinity;
          for (let i = 0; i < sc.length; i++) {
            const j = (i + 1) % sc.length;
            minD = Math.min(minD, pointToSegDist(sx, sy, sc[i].x, sc[i].y, sc[j].x, sc[j].y));
          }
          return minD;
        }
      }
      const s1 = worldToScreen(m.x1, m.y1);
      const s2 = worldToScreen(m.x2, m.y2);
      const r = dist(s1.x, s1.y, s2.x, s2.y);
      return Math.abs(dist(sx, sy, s1.x, s1.y) - r);
    }
    if (m.type === 'persp-ref') {
      let minD = Infinity;
      for (let i = 0; i < 4; i++) {
        const p1 = worldToScreen(m.points[i].x, m.points[i].y);
        const p2 = worldToScreen(m.points[(i + 1) % 4].x, m.points[(i + 1) % 4].y);
        minD = Math.min(minD, pointToSegDist(sx, sy, p1.x, p1.y, p2.x, p2.y));
      }
      return minD;
    }
    return Infinity;
  }

  function hitTestAll(sx, sy, layer) {
    const threshold = 10;
    let bestDist = threshold;
    let bestMeas = null;
    const allMeas = [];
    if (layer.reference) allMeas.push(layer.reference);
    if (layer.perspRef) allMeas.push(layer.perspRef);
    allMeas.push(...layer.measurements);
    for (const m of allMeas) {
      const d = hitTestBody(sx, sy, m, layer);
      if (d < bestDist) {
        bestDist = d;
        bestMeas = m;
      }
    }
    return bestMeas;
  }

  // ---- Dimension Computation -----------------------------
  function getPixelsPerUnit(layer) {
    if (!layer.reference) return null;
    const ref = layer.reference;
    const pxLen = dist(ref.x1, ref.y1, ref.x2, ref.y2);
    if (pxLen === 0 || !ref.refValue) return null;
    return pxLen / ref.refValue;
  }

  function computeMeasurementValues(m, layer) {
    // Returns { values: [number...], unit: string } or null
    const hasPerspective = layer.perspRef && layer.perspRef.homography;
    const refUnit = getRefUnit(layer);
    if (!refUnit) return null;

    if (m.type === 'line') {
      let value;
      if (hasPerspective) {
        const H = layer.perspRef.homography;
        const p1 = applyHomography(H, m.x1, m.y1);
        const p2 = applyHomography(H, m.x2, m.y2);
        value = dist(p1.x, p1.y, p2.x, p2.y);
        const baseUnit = layer.perspRef.refUnit;
        const dispUnit = m.displayUnit || baseUnit;
        return { values: [convertUnits(value, baseUnit, dispUnit)], unit: dispUnit };
      } else {
        const ppUnit = getPixelsPerUnit(layer);
        if (!ppUnit) return null;
        value = dist(m.x1, m.y1, m.x2, m.y2) / ppUnit;
        const baseUnit = layer.reference.refUnit;
        const dispUnit = m.displayUnit || baseUnit;
        return { values: [convertUnits(value, baseUnit, dispUnit)], unit: dispUnit };
      }
    }

    if (m.type === 'rect') {
      let w, h, baseUnit;
      if (hasPerspective) {
        const H = layer.perspRef.homography;
        const w1 = applyHomography(H, m.x1, m.y1);
        const w2 = applyHomography(H, m.x2, m.y2);
        w = Math.abs(w2.x - w1.x);
        h = Math.abs(w2.y - w1.y);
        baseUnit = layer.perspRef.refUnit;
      } else {
        const ppUnit = getPixelsPerUnit(layer);
        if (!ppUnit) return null;
        w = Math.abs(m.x2 - m.x1) / ppUnit;
        h = Math.abs(m.y2 - m.y1) / ppUnit;
        baseUnit = layer.reference.refUnit;
      }
      const dispUnit = m.displayUnit || baseUnit;
      return {
        values: [convertUnits(w, baseUnit, dispUnit), convertUnits(h, baseUnit, dispUnit)],
        unit: dispUnit,
      };
    }

    if (m.type === 'circle') {
      let diameter, baseUnit;
      if (hasPerspective) {
        const H = layer.perspRef.homography;
        const center = applyHomography(H, m.x1, m.y1);
        const edge = applyHomography(H, m.x2, m.y2);
        diameter = dist(center.x, center.y, edge.x, edge.y) * 2;
        baseUnit = layer.perspRef.refUnit;
      } else {
        const ppUnit = getPixelsPerUnit(layer);
        if (!ppUnit) return null;
        diameter = dist(m.x1, m.y1, m.x2, m.y2) * 2 / ppUnit;
        baseUnit = layer.reference.refUnit;
      }
      const dispUnit = m.displayUnit || baseUnit;
      return { values: [convertUnits(diameter, baseUnit, dispUnit)], unit: dispUnit };
    }

    return null;
  }

  function computeDimensionStr(m, layer) {
    if (m.type === 'reference') return formatDim(m.refValue, m.refUnit);
    if (m.type === 'persp-ref') return `${formatDim(m.width, m.refUnit)} \u00d7 ${formatDim(m.height, m.refUnit)}`;
    const result = computeMeasurementValues(m, layer);
    if (!result) return '\u2014 (no ref)';
    if (m.type === 'line') return formatDim(result.values[0], result.unit);
    if (m.type === 'rect') return `${formatDim(result.values[0], result.unit)} \u00d7 ${formatDim(result.values[1], result.unit)}`;
    if (m.type === 'circle') return `\u2300 ${formatDim(result.values[0], result.unit)}`;
    return '\u2014';
  }

  // ---- Homography Math -----------------------------------
  function computeHomography(srcPoints, dstPoints) {
    // srcPoints/dstPoints: [{x,y}*4]
    // Returns [h1..h8] where H = [[h1,h2,h3],[h4,h5,h6],[h7,h8,1]]
    const A = [];
    for (let i = 0; i < 4; i++) {
      const { x, y } = srcPoints[i];
      const { x: X, y: Y } = dstPoints[i];
      A.push([x, y, 1, 0, 0, 0, -X * x, -X * y, X]);
      A.push([0, 0, 0, x, y, 1, -Y * x, -Y * y, Y]);
    }
    // Gaussian elimination with partial pivoting on 8x9 augmented matrix
    for (let col = 0; col < 8; col++) {
      let maxRow = col, maxVal = Math.abs(A[col][col]);
      for (let row = col + 1; row < 8; row++) {
        if (Math.abs(A[row][col]) > maxVal) { maxVal = Math.abs(A[row][col]); maxRow = row; }
      }
      [A[col], A[maxRow]] = [A[maxRow], A[col]];
      const pivot = A[col][col];
      if (Math.abs(pivot) < 1e-12) return null; // singular
      for (let j = col; j < 9; j++) A[col][j] /= pivot;
      for (let row = 0; row < 8; row++) {
        if (row === col) continue;
        const factor = A[row][col];
        for (let j = col; j < 9; j++) A[row][j] -= factor * A[col][j];
      }
    }
    return A.map(row => row[8]);
  }

  function applyHomography(H, x, y) {
    const [h1, h2, h3, h4, h5, h6, h7, h8] = H;
    const w = h7 * x + h8 * y + 1;
    if (Math.abs(w) < 1e-12) return { x: 0, y: 0 };
    return { x: (h1 * x + h2 * y + h3) / w, y: (h4 * x + h5 * y + h6) / w };
  }

  function recomputeHomography(perspRef) {
    const dst = [
      { x: 0, y: 0 },
      { x: perspRef.width, y: 0 },
      { x: perspRef.width, y: perspRef.height },
      { x: 0, y: perspRef.height },
    ];
    perspRef.homography = computeHomography(perspRef.points, dst);
    perspRef.inverseHomography = computeHomography(dst, perspRef.points);
  }

  // Get 4 image-space corners of a rect defined in world space
  function getPerspRectCorners(m, layer) {
    const H = layer.perspRef.homography;
    const Hi = layer.perspRef.inverseHomography;
    if (!H || !Hi) return null;
    const w1 = applyHomography(H, m.x1, m.y1);
    const w2 = applyHomography(H, m.x2, m.y2);
    const wMinX = Math.min(w1.x, w2.x), wMaxX = Math.max(w1.x, w2.x);
    const wMinY = Math.min(w1.y, w2.y), wMaxY = Math.max(w1.y, w2.y);
    return [
      applyHomography(Hi, wMinX, wMinY),
      applyHomography(Hi, wMaxX, wMinY),
      applyHomography(Hi, wMaxX, wMaxY),
      applyHomography(Hi, wMinX, wMaxY),
    ];
  }

  // Get sampled image-space points for a circle defined in world space
  function getPerspCirclePoints(m, layer, N) {
    N = N || 64;
    const H = layer.perspRef.homography;
    const Hi = layer.perspRef.inverseHomography;
    if (!H || !Hi) return null;
    const wCenter = applyHomography(H, m.x1, m.y1);
    const wEdge = applyHomography(H, m.x2, m.y2);
    const wR = dist(wCenter.x, wCenter.y, wEdge.x, wEdge.y);
    const points = [];
    for (let i = 0; i < N; i++) {
      const angle = (i / N) * Math.PI * 2;
      const wx = wCenter.x + wR * Math.cos(angle);
      const wy = wCenter.y + wR * Math.sin(angle);
      points.push(applyHomography(Hi, wx, wy));
    }
    return points;
  }

  // ---- Paste / Drop Image --------------------------------
  function setupPaste() {
    document.addEventListener('paste', (e) => {
      // Don't intercept paste in input/select fields
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;
      const items = e.clipboardData?.items;
      if (!items) return;
      for (const item of items) {
        if (item.type.startsWith('image/')) {
          e.preventDefault();
          readImageFile(item.getAsFile());
          return;
        }
      }
    });
  }

  function setupDragDrop() {
    container.addEventListener('dragover', (e) => { e.preventDefault(); e.dataTransfer.dropEffect = 'copy'; });
    container.addEventListener('drop', (e) => {
      e.preventDefault();
      const file = e.dataTransfer.files?.[0];
      if (file && file.type.startsWith('image/')) readImageFile(file);
    });
  }

  function readImageFile(file) {
    const reader = new FileReader();
    reader.onload = (e) => createSession(e.target.result);
    reader.readAsDataURL(file);
  }

  // ---- Toolbar -------------------------------------------
  function setupToolbar() {
    const tools = ['pan', 'reference', 'persp-ref', 'line', 'rect', 'circle'];
    for (const t of tools) {
      $(`#tool-${t}`).addEventListener('click', () => setTool(t));
    }
    $('#btn-zoom-in').addEventListener('click', () => zoomBy(1.3));
    $('#btn-zoom-out').addEventListener('click', () => zoomBy(1 / 1.3));
    $('#btn-zoom-fit').addEventListener('click', fitView);
    $('#btn-delete').addEventListener('click', () => { if (selectedMeasId) deleteMeasurement(selectedMeasId); });
    $('#btn-undo').addEventListener('click', undo);
  }

  function setTool(t) {
    activeTool = t;
    drawing = null;
    // Cancel persp-ref placement if switching away
    if (t !== 'persp-ref') perspDrawPoints = [];
    $$('.tool-btn').forEach(b => b.classList.remove('active'));
    $(`#tool-${t}`)?.classList.add('active');
    container.classList.remove('pan-cursor', 'crosshair', 'move-cursor');
    if (t === 'pan') container.classList.add('pan-cursor');
    else container.classList.add('crosshair');
    renderAll();
  }

  // ---- Canvas Resize -------------------------------------
  function resizeCanvas() {
    const rect = container.getBoundingClientRect();
    canvas.width = rect.width * devicePixelRatio;
    canvas.height = rect.height * devicePixelRatio;
    canvas.style.width = rect.width + 'px';
    canvas.style.height = rect.height + 'px';
    renderAll();
  }

  // ---- View / Zoom ---------------------------------------
  function fitView() {
    if (!img || !img.naturalWidth) return;
    const rect = container.getBoundingClientRect();
    const pad = 0.9;
    const scaleX = (rect.width * pad) / img.naturalWidth;
    const scaleY = (rect.height * pad) / img.naturalHeight;
    view.scale = Math.min(scaleX, scaleY);
    view.x = (rect.width - img.naturalWidth * view.scale) / 2;
    view.y = (rect.height - img.naturalHeight * view.scale) / 2;
    updateZoomLabel();
    renderAll();
  }

  function zoomBy(factor, cx, cy) {
    const rect = container.getBoundingClientRect();
    if (cx == null) { cx = rect.width / 2; cy = rect.height / 2; }
    const wx = (cx - view.x) / view.scale;
    const wy = (cy - view.y) / view.scale;
    view.scale = clamp(view.scale * factor, 0.01, 200);
    view.x = cx - wx * view.scale;
    view.y = cy - wy * view.scale;
    updateZoomLabel();
    renderAll();
  }

  function updateZoomLabel() {
    $('#zoom-level').textContent = Math.round(view.scale * 100) + '%';
  }

  function screenToWorld(sx, sy) {
    return { x: (sx - view.x) / view.scale, y: (sy - view.y) / view.scale };
  }

  function worldToScreen(wx, wy) {
    return { x: wx * view.scale + view.x, y: wy * view.scale + view.y };
  }

  // ---- Canvas Input --------------------------------------
  function setupCanvasInput() {
    canvas.addEventListener('wheel', onWheel, { passive: false });
    canvas.addEventListener('pointerdown', onPointerDown);
    canvas.addEventListener('pointermove', onPointerMove);
    canvas.addEventListener('pointerup', onPointerUp);
    canvas.addEventListener('dblclick', onDblClick);
    canvas.addEventListener('contextmenu', (e) => e.preventDefault());
  }

  function canvasCoords(e) {
    const rect = container.getBoundingClientRect();
    return { x: e.clientX - rect.left, y: e.clientY - rect.top };
  }

  function onWheel(e) {
    e.preventDefault();
    const { x, y } = canvasCoords(e);
    if (e.ctrlKey || e.metaKey) {
      // Pinch-to-zoom on trackpad, or Ctrl/Cmd+scroll with mouse
      const factor = Math.exp(-e.deltaY * 0.01);
      zoomBy(factor, x, y);
    } else {
      // Two-finger scroll on trackpad, or regular scroll wheel => pan
      view.x -= e.deltaX;
      view.y -= e.deltaY;
      updateZoomLabel();
      renderAll();
    }
  }

  function onPointerDown(e) {
    const { x, y } = canvasCoords(e);

    // Pan: middle, right, space+left
    if (e.button === 1 || e.button === 2 || (e.button === 0 && spaceDown)) {
      isPanning = true;
      panStart = { x, y, vx: view.x, vy: view.y };
      container.classList.add('panning');
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    if (e.button !== 0) return;
    if (!activeSession()) return;

    const w = screenToWorld(x, y);

    // Persp-ref tool: click to place corners
    if (activeTool === 'persp-ref') {
      perspDrawPoints.push({ x: w.x, y: w.y });
      if (perspDrawPoints.length >= 4) {
        showPerspDialog(0, 0, 'mm');
      }
      renderAll();
      return;
    }

    // Drawing tools
    if (activeTool === 'reference' || activeTool === 'line' || activeTool === 'rect' || activeTool === 'circle') {
      drawing = { type: activeTool === 'reference' ? 'reference' : activeTool, x1: w.x, y1: w.y, x2: w.x, y2: w.y };
      canvas.setPointerCapture(e.pointerId);
      return;
    }

    // Pan tool: check for endpoint drag on selected measurement
    if (activeTool === 'pan') {
      const layer = activeLayer();
      canvas.setPointerCapture(e.pointerId);

      if (layer && selectedMeasId) {
        const m = findMeasurementById(selectedMeasId, layer);
        if (m) {
          const ep = hitTestEndpoints(x, y, m);
          if (ep >= 0) {
            pushUndo();
            dragging = { meas: m, endpointIndex: ep, pointerId: e.pointerId };
            container.classList.add('move-cursor');
            return;
          }
        }
      }

      // Start pan (may become a click on pointerup)
      isPanning = true;
      panStart = { x, y, vx: view.x, vy: view.y };
      clickStart = { x, y };
      container.classList.add('panning');
    }
  }

  function onPointerMove(e) {
    const { x, y } = canvasCoords(e);

    if (dragging) {
      const w = screenToWorld(x, y);
      const m = dragging.meas;
      const i = dragging.endpointIndex;
      if (m.type === 'persp-ref') {
        m.points[i] = { x: w.x, y: w.y };
        recomputeHomography(m);
      } else {
        if (i === 0) { m.x1 = w.x; m.y1 = w.y; }
        else { m.x2 = w.x; m.y2 = w.y; }
      }
      renderAll();
      return;
    }

    if (isPanning) {
      view.x = panStart.vx + (x - panStart.x);
      view.y = panStart.vy + (y - panStart.y);
      renderAll();
      return;
    }

    if (drawing) {
      const w = screenToWorld(x, y);
      drawing.x2 = w.x;
      drawing.y2 = w.y;
      renderAll();
      return;
    }

    // Hover: update cursor for endpoint proximity in pan mode
    if (activeTool === 'pan' && selectedMeasId) {
      const layer = activeLayer();
      if (layer) {
        const m = findMeasurementById(selectedMeasId, layer);
        if (m) {
          const ep = hitTestEndpoints(x, y, m);
          if (ep >= 0) {
            container.classList.remove('pan-cursor');
            container.classList.add('move-cursor');
            return;
          }
        }
      }
      container.classList.remove('move-cursor');
      container.classList.add('pan-cursor');
    }
  }

  function onPointerUp(e) {
    const { x, y } = canvasCoords(e);

    if (dragging) {
      container.classList.remove('move-cursor');
      if (activeTool === 'pan') container.classList.add('pan-cursor');
      dragging = null;
      saveState();
      renderMeasurementList();
      renderLayerPanel();
      renderAll();
      return;
    }

    if (isPanning) {
      isPanning = false;
      container.classList.remove('panning');

      // Check if this was a click (no significant drag) in pan mode
      if (clickStart && activeTool === 'pan') {
        const moved = dist(clickStart.x, clickStart.y, x, y);
        if (moved < 4) {
          const layer = activeLayer();
          if (layer) {
            const hit = hitTestAll(clickStart.x, clickStart.y, layer);
            selectedMeasId = hit ? hit.id : null;
            saveState();
            renderMeasurementList();
            renderAll();
          }
        }
      }
      clickStart = null;
      return;
    }

    if (drawing) {
      const pxLen = dist(drawing.x1, drawing.y1, drawing.x2, drawing.y2);
      if (pxLen < 3 / view.scale) {
        drawing = null;
        renderAll();
        return;
      }
      if (drawing.type === 'reference') {
        pendingRefDraw = { ...drawing, id: uid() };
        drawing = null;
        refDialogMode = 'create';
        showRefDialog(0, 'mm');
      } else {
        const layer = activeLayer();
        if (layer) {
          pushUndo();
          const m = { id: uid(), type: drawing.type, x1: drawing.x1, y1: drawing.y1, x2: drawing.x2, y2: drawing.y2, displayUnit: null };
          layer.measurements.push(m);
          selectedMeasId = m.id;
          saveState();
          renderMeasurementList();
        }
        drawing = null;
        renderAll();
      }
    }
  }

  function onDblClick(e) {
    if (activeTool !== 'pan') return;
    const { x, y } = canvasCoords(e);
    const layer = activeLayer();
    if (!layer) return;

    const hit = hitTestAll(x, y, layer);
    if (!hit) return;

    if (hit.type === 'reference') {
      refDialogMode = 'edit';
      editingRefMeas = hit;
      showRefDialog(hit.refValue, hit.refUnit);
    } else if (hit.type === 'persp-ref') {
      perspDialogMode = 'edit';
      editingPerspMeas = hit;
      showPerspDialog(hit.width, hit.height, hit.refUnit);
    }
  }

  // ---- Reference Dialog ----------------------------------
  let pendingRefDraw = null;
  let refDialogMode = 'create'; // 'create' | 'edit'
  let editingRefMeas = null;

  function setupRefDialog() {
    $('#ref-ok').addEventListener('click', confirmRef);
    $('#ref-cancel').addEventListener('click', cancelRef);
    $('#ref-value').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmRef();
      if (e.key === 'Escape') cancelRef();
    });
  }

  function showRefDialog(value, unit) {
    const dialog = $('#ref-dialog');
    dialog.classList.remove('hidden');
    const input = $('#ref-value');
    const select = $('#ref-unit');
    input.value = value || '';
    select.value = unit || 'mm';
    $('#ref-dialog-title').textContent = refDialogMode === 'edit' ? 'Edit Reference Size' : 'Set Reference Size';
    setTimeout(() => { input.focus(); input.select(); }, 50);
  }

  function confirmRef() {
    const val = parseFloat($('#ref-value').value);
    const unit = $('#ref-unit').value;
    if (!val || val <= 0) { $('#ref-value').focus(); return; }

    const layer = activeLayer();
    if (refDialogMode === 'edit' && editingRefMeas) {
      pushUndo();
      editingRefMeas.refValue = val;
      editingRefMeas.refUnit = unit;
      editingRefMeas = null;
    } else if (layer && pendingRefDraw) {
      pushUndo();
      layer.reference = { ...pendingRefDraw, type: 'reference', refValue: val, refUnit: unit };
      selectedMeasId = layer.reference.id;
    }
    pendingRefDraw = null;
    $('#ref-dialog').classList.add('hidden');
    saveState();
    renderLayerPanel();
    renderMeasurementList();
    renderAll();
  }

  function cancelRef() {
    pendingRefDraw = null;
    editingRefMeas = null;
    $('#ref-dialog').classList.add('hidden');
    renderAll();
  }

  // ---- Perspective Reference Dialog ----------------------
  let perspDialogMode = 'create'; // 'create' | 'edit'
  let editingPerspMeas = null;

  function setupPerspDialog() {
    $('#persp-ok').addEventListener('click', confirmPersp);
    $('#persp-cancel').addEventListener('click', cancelPersp);
    $('#persp-width').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmPersp();
      if (e.key === 'Escape') cancelPersp();
    });
    $('#persp-height').addEventListener('keydown', (e) => {
      if (e.key === 'Enter') confirmPersp();
      if (e.key === 'Escape') cancelPersp();
    });
  }

  function showPerspDialog(w, h, unit) {
    const dialog = $('#persp-dialog');
    dialog.classList.remove('hidden');
    $('#persp-width').value = w || '';
    $('#persp-height').value = h || '';
    $('#persp-unit').value = unit || 'mm';
    $('#persp-dialog-title').textContent = perspDialogMode === 'edit' ? 'Edit Perspective Reference' : 'Perspective Reference Dimensions';
    setTimeout(() => { $('#persp-width').focus(); $('#persp-width').select(); }, 50);
  }

  function confirmPersp() {
    const w = parseFloat($('#persp-width').value);
    const h = parseFloat($('#persp-height').value);
    const unit = $('#persp-unit').value;
    if (!w || w <= 0 || !h || h <= 0) {
      if (!w || w <= 0) $('#persp-width').focus();
      else $('#persp-height').focus();
      return;
    }

    const layer = activeLayer();
    if (perspDialogMode === 'edit' && editingPerspMeas) {
      pushUndo();
      editingPerspMeas.width = w;
      editingPerspMeas.height = h;
      editingPerspMeas.refUnit = unit;
      recomputeHomography(editingPerspMeas);
      editingPerspMeas = null;
    } else if (layer && perspDrawPoints.length >= 4) {
      pushUndo();
      const points = perspDrawPoints.slice(0, 4);
      const perspRef = {
        id: uid(), type: 'persp-ref',
        points, width: w, height: h, refUnit: unit,
        homography: null,
      };
      recomputeHomography(perspRef);
      layer.perspRef = perspRef;
      selectedMeasId = perspRef.id;
    }
    perspDrawPoints = [];
    $('#persp-dialog').classList.add('hidden');
    saveState();
    renderLayerPanel();
    renderMeasurementList();
    renderAll();
  }

  function cancelPersp() {
    perspDrawPoints = [];
    editingPerspMeas = null;
    $('#persp-dialog').classList.add('hidden');
    renderAll();
  }

  // ---- Undo ----------------------------------------------
  function pushUndo() {
    const layer = activeLayer();
    if (!layer) return;
    undoStack.push(JSON.stringify({
      reference: layer.reference,
      perspRef: layer.perspRef,
      measurements: layer.measurements,
    }));
    if (undoStack.length > 50) undoStack.shift();
  }

  function undo() {
    const layer = activeLayer();
    if (!layer || !undoStack.length) return;
    const prev = JSON.parse(undoStack.pop());
    layer.reference = prev.reference;
    layer.perspRef = prev.perspRef !== undefined ? prev.perspRef : null;
    layer.measurements = prev.measurements;
    selectedMeasId = null;
    saveState();
    renderLayerPanel();
    renderMeasurementList();
    renderAll();
  }

  // ---- Keyboard ------------------------------------------
  function setupKeyboard() {
    document.addEventListener('keydown', (e) => {
      if (e.target.tagName === 'INPUT' || e.target.tagName === 'SELECT' || e.target.tagName === 'TEXTAREA') return;

      if (e.code === 'Space') {
        e.preventDefault();
        spaceDown = true;
        if (activeTool !== 'pan') container.classList.add('pan-cursor');
      }
      if (e.key === 'Escape') {
        if (perspDrawPoints.length > 0) { perspDrawPoints = []; renderAll(); }
        if (drawing) { drawing = null; renderAll(); }
        if (selectedMeasId) { selectedMeasId = null; renderMeasurementList(); renderAll(); }
      }
      if (e.key === 'Delete' || e.key === 'Backspace') {
        if (selectedMeasId) deleteMeasurement(selectedMeasId);
      }
      if (e.ctrlKey && e.key === 'z') { e.preventDefault(); undo(); }
      if (e.key === 'v' || e.key === '1') setTool('pan');
      if (e.key === 'r' || e.key === '2') setTool('reference');
      if (e.key === 'l' || e.key === '3') setTool('line');
      if (e.key === 'b' || e.key === '4') setTool('rect');
      if (e.key === 'c' || e.key === '5') setTool('circle');
      if (e.key === 'p' || e.key === '6') setTool('persp-ref');
      if (e.key === '+' || e.key === '=') zoomBy(1.3);
      if (e.key === '-') zoomBy(1 / 1.3);
      if (e.key === '0') fitView();
    });

    document.addEventListener('keyup', (e) => {
      if (e.code === 'Space') {
        spaceDown = false;
        container.classList.remove('pan-cursor');
      }
    });
  }

  // ---- Rendering -----------------------------------------
  const monoFont = () => getComputedStyle(document.body).getPropertyValue('--mono').trim() || 'monospace';

  function renderAll() {
    const dpr = devicePixelRatio;
    const w = canvas.width;
    const h = canvas.height;
    ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    ctx.clearRect(0, 0, w, h);

    drawCheckerboard(w / dpr, h / dpr);

    // Image
    ctx.save();
    ctx.translate(view.x, view.y);
    ctx.scale(view.scale, view.scale);
    if (img && img.naturalWidth) {
      ctx.drawImage(img, 0, 0);
    }
    ctx.restore();

    // Layers
    const s = activeSession();
    if (s) {
      for (const layer of s.layers) {
        if (!layer.visible) continue;
        const isActiveLayer = layer.id === s.activeLayerId;
        ctx.globalAlpha = isActiveLayer ? 1.0 : 0.5;

        if (layer.perspRef) drawPerspRef(layer.perspRef, layer, isActiveLayer);
        if (layer.reference) drawMeasurement(layer.reference, layer, isActiveLayer);
        for (const m of layer.measurements) drawMeasurement(m, layer, isActiveLayer);

        ctx.globalAlpha = 1.0;
      }
    }

    // In-progress drawing
    if (drawing) drawInProgress(drawing);

    // In-progress perspective ref
    if (perspDrawPoints.length > 0) drawPerspProgress(perspDrawPoints);
  }

  function drawCheckerboard(w, h) {
    const size = 16;
    ctx.fillStyle = '#1e1e2e';
    ctx.fillRect(0, 0, w, h);
    ctx.fillStyle = '#252538';
    for (let y = 0; y < h; y += size) {
      for (let x = 0; x < w; x += size) {
        if ((Math.floor(x / size) + Math.floor(y / size)) % 2 === 0) {
          ctx.fillRect(x, y, size, size);
        }
      }
    }
  }

  // ---- Draw Perspective Reference -------------------------
  function drawPerspRef(pr, layer, isActiveLayer) {
    const isSelected = pr.id === selectedMeasId && isActiveLayer;
    const pts = pr.points.map(p => worldToScreen(p.x, p.y));

    ctx.save();
    // Fill
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * 0.08;
    ctx.fillStyle = '#fb923c';
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.fill();
    ctx.globalAlpha = prevAlpha;

    // Outline
    ctx.strokeStyle = '#fb923c';
    ctx.lineWidth = isSelected ? 2.5 : 1.8;
    ctx.setLineDash([6, 4]);
    ctx.beginPath();
    ctx.moveTo(pts[0].x, pts[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
    ctx.closePath();
    ctx.stroke();
    ctx.setLineDash([]);

    if (isSelected) {
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(pts[i].x, pts[i].y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Corner points with numbers
    for (let i = 0; i < 4; i++) {
      const p = pts[i];
      const r = isSelected ? 7 : 5;
      ctx.beginPath();
      ctx.arc(p.x, p.y, r, 0, Math.PI * 2);
      ctx.fillStyle = '#fb923c';
      ctx.fill();
      if (isSelected) {
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
      // Number
      ctx.fillStyle = 'white';
      ctx.font = `bold ${r < 6 ? 8 : 10}px ${monoFont()}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y);
    }

    // Dimension labels on edges
    // Edge 0->1: width
    const wLabel = formatDim(pr.width, pr.refUnit);
    drawEdgeLabel(pts[0], pts[1], wLabel, '#fb923c');
    // Edge 0->3: height
    const hLabel = formatDim(pr.height, pr.refUnit);
    drawEdgeLabel(pts[0], pts[3], hLabel, '#fb923c');

    ctx.restore();
  }

  function drawEdgeLabel(p1, p2, text, color) {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    const offX = -Math.sin(angle) * 16;
    const offY = Math.cos(angle) * 16;
    const lx = mx + offX;
    const ly = my + offY;

    ctx.save();
    ctx.font = `10px ${monoFont()}`;
    const tw = ctx.measureText(text).width + 10;
    const th = 16;
    ctx.fillStyle = 'rgba(22, 33, 62, 0.9)';
    ctx.beginPath();
    roundRect(ctx, lx - tw / 2, ly - th / 2, tw, th, 3);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.8;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx, ly);
    ctx.restore();
  }

  function drawPerspProgress(points) {
    const pts = points.map(p => worldToScreen(p.x, p.y));

    ctx.save();
    ctx.strokeStyle = '#fb923c';
    ctx.lineWidth = 2;
    ctx.setLineDash([6, 4]);

    if (pts.length > 1) {
      ctx.beginPath();
      ctx.moveTo(pts[0].x, pts[0].y);
      for (let i = 1; i < pts.length; i++) ctx.lineTo(pts[i].x, pts[i].y);
      if (pts.length === 4) ctx.closePath();
      ctx.stroke();
    }
    ctx.setLineDash([]);

    // Corner dots with numbers
    for (let i = 0; i < pts.length; i++) {
      const p = pts[i];
      ctx.beginPath();
      ctx.arc(p.x, p.y, 6, 0, Math.PI * 2);
      ctx.fillStyle = '#fb923c';
      ctx.fill();
      ctx.fillStyle = 'white';
      ctx.font = `bold 9px ${monoFont()}`;
      ctx.textAlign = 'center';
      ctx.textBaseline = 'middle';
      ctx.fillText(String(i + 1), p.x, p.y);
    }

    // Hint text
    if (pts.length < 4) {
      const hintText = `Click corner ${pts.length + 1} of 4`;
      const hx = pts[pts.length - 1].x + 16;
      const hy = pts[pts.length - 1].y - 16;
      ctx.font = `11px ${monoFont()}`;
      ctx.fillStyle = 'rgba(22, 33, 62, 0.9)';
      const tw = ctx.measureText(hintText).width + 10;
      ctx.beginPath();
      roundRect(ctx, hx, hy - 9, tw, 18, 4);
      ctx.fill();
      ctx.fillStyle = '#fb923c';
      ctx.textAlign = 'left';
      ctx.textBaseline = 'middle';
      ctx.fillText(hintText, hx + 5, hy);
    }

    ctx.restore();
  }

  // ---- Draw Measurement -----------------------------------
  function drawMeasurement(m, layer, isActiveLayer) {
    const s1 = worldToScreen(m.x1, m.y1);
    const s2 = worldToScreen(m.x2, m.y2);
    const isSelected = m.id === selectedMeasId && isActiveLayer;
    const lineWidth = isSelected ? 2.5 : 1.8;
    const hasPerspective = layer.perspRef && layer.perspRef.inverseHomography;

    if (m.type === 'reference') {
      drawLine(s1, s2, '#f59e0b', lineWidth, isSelected, true);
      drawLabel(s1, s2, formatDim(m.refValue, m.refUnit), '#f59e0b', isSelected);
    } else if (m.type === 'line') {
      const color = '#38bdf8';
      drawLine(s1, s2, color, lineWidth, isSelected, false);
      drawLabel(s1, s2, computeDimensionStr(m, layer), color, isSelected);
    } else if (m.type === 'rect') {
      const color = '#a78bfa';
      if (hasPerspective) {
        drawPerspRectShape(m, layer, color, lineWidth, isSelected);
        drawPerspRectLabels(m, layer, color, isSelected);
      } else {
        drawRectShape(s1, s2, color, lineWidth, isSelected);
        drawRectLabels(s1, s2, m, layer, color, isSelected);
      }
    } else if (m.type === 'circle') {
      const color = '#34d399';
      if (hasPerspective) {
        drawPerspCircleShape(m, layer, color, lineWidth, isSelected);
        drawPerspCircleLabel(m, layer, color, isSelected);
      } else {
        const r = dist(s1.x, s1.y, s2.x, s2.y);
        drawCircleShape(s1, r, color, lineWidth, isSelected);
        drawCircleLabel(s1, r, computeDimensionStr(m, layer), color, isSelected);
      }
    }
  }

  function drawLine(p1, p2, color, lineWidth, isSelected, isRef) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    if (isRef) ctx.setLineDash([6, 4]);
    else ctx.setLineDash([]);
    ctx.beginPath();
    ctx.moveTo(p1.x, p1.y);
    ctx.lineTo(p2.x, p2.y);
    ctx.stroke();

    const epR = isSelected ? 5 : 3.5;
    for (const p of [p1, p2]) {
      ctx.beginPath();
      ctx.arc(p.x, p.y, epR, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.setLineDash([]);
      ctx.fill();
      if (isSelected) {
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawRectShape(p1, p2, color, lineWidth, isSelected) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([]);
    const x = Math.min(p1.x, p2.x), y = Math.min(p1.y, p2.y);
    const w = Math.abs(p2.x - p1.x), h = Math.abs(p2.y - p1.y);
    ctx.strokeRect(x, y, w, h);
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * 0.1;
    ctx.fillStyle = color;
    ctx.fillRect(x, y, w, h);
    ctx.globalAlpha = prevAlpha;

    // Corner handles when selected
    if (isSelected) {
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.strokeRect(x - 2, y - 2, w + 4, h + 4);
      ctx.setLineDash([]);
      // Endpoint dots
      for (const p of [p1, p2]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawRectLabels(s1, s2, m, layer, color, isSelected) {
    const result = computeMeasurementValues(m, layer);
    if (!result) return;
    const cx = (s1.x + s2.x) / 2;
    const top = Math.min(s1.y, s2.y);
    const mainText = `${formatDim(result.values[0], result.unit)} \u00d7 ${formatDim(result.values[1], result.unit)}`;

    ctx.save();
    ctx.font = `${isSelected ? 'bold ' : ''}11px ${monoFont()}`;
    const tw = ctx.measureText(mainText).width + 12;
    const th = 18;
    const ly = top - 14;
    ctx.fillStyle = 'rgba(22, 33, 62, 0.92)';
    ctx.beginPath();
    roundRect(ctx, cx - tw / 2, ly - th / 2, tw, th, 4);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(mainText, cx, ly);

    // Individual W and H labels on sides
    const bx = cx;
    const by = Math.max(s1.y, s2.y) + 14;
    drawSmallLabel(bx, by, formatDim(result.values[0], result.unit), color);
    const rx = Math.max(s1.x, s2.x) + 14;
    const ry = (s1.y + s2.y) / 2;
    drawSmallLabel(rx, ry, formatDim(result.values[1], result.unit), color);

    ctx.restore();
  }

  // ---- Perspective-Warped Rect ----------------------------
  function drawPerspRectShape(m, layer, color, lineWidth, isSelected) {
    const corners = getPerspRectCorners(m, layer);
    if (!corners) return;
    const sc = corners.map(c => worldToScreen(c.x, c.y));

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([]);

    // Draw warped quadrilateral
    ctx.beginPath();
    ctx.moveTo(sc[0].x, sc[0].y);
    for (let i = 1; i < 4; i++) ctx.lineTo(sc[i].x, sc[i].y);
    ctx.closePath();
    ctx.stroke();

    // Fill
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * 0.1;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = prevAlpha;

    // Selection outline and handles
    if (isSelected) {
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.moveTo(sc[0].x, sc[0].y);
      for (let i = 1; i < 4; i++) ctx.lineTo(sc[i].x, sc[i].y);
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);

      // Endpoint dots at the two defining corners (x1,y1) and (x2,y2)
      const sp1 = worldToScreen(m.x1, m.y1);
      const sp2 = worldToScreen(m.x2, m.y2);
      for (const p of [sp1, sp2]) {
        ctx.beginPath();
        ctx.arc(p.x, p.y, 4, 0, Math.PI * 2);
        ctx.fillStyle = color;
        ctx.fill();
        ctx.strokeStyle = 'white';
        ctx.lineWidth = 1.5;
        ctx.stroke();
      }
    }
    ctx.restore();
  }

  function drawPerspRectLabels(m, layer, color, isSelected) {
    const result = computeMeasurementValues(m, layer);
    if (!result) return;
    const corners = getPerspRectCorners(m, layer);
    if (!corners) return;
    const sc = corners.map(c => worldToScreen(c.x, c.y));

    // Centroid for main label
    const cx = (sc[0].x + sc[1].x + sc[2].x + sc[3].x) / 4;
    const topY = Math.min(sc[0].y, sc[1].y, sc[2].y, sc[3].y);
    const mainText = `${formatDim(result.values[0], result.unit)} \u00d7 ${formatDim(result.values[1], result.unit)}`;

    ctx.save();
    ctx.font = `${isSelected ? 'bold ' : ''}11px ${monoFont()}`;
    const tw = ctx.measureText(mainText).width + 12;
    const th = 18;
    const ly = topY - 14;
    ctx.fillStyle = 'rgba(22, 33, 62, 0.92)';
    ctx.beginPath();
    roundRect(ctx, cx - tw / 2, ly - th / 2, tw, th, 4);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(mainText, cx, ly);

    // Width label on top edge
    drawEdgeLabel(sc[0], sc[1], formatDim(result.values[0], result.unit), color);

    // Height label on left edge
    drawEdgeLabel(sc[0], sc[3], formatDim(result.values[1], result.unit), color);

    ctx.restore();
  }

  // ---- Perspective-Warped Circle --------------------------
  function drawPerspCircleShape(m, layer, color, lineWidth, isSelected) {
    const pts = getPerspCirclePoints(m, layer, 64);
    if (!pts) return;
    const sc = pts.map(p => worldToScreen(p.x, p.y));

    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([]);

    // Draw sampled ellipse
    ctx.beginPath();
    ctx.moveTo(sc[0].x, sc[0].y);
    for (let i = 1; i < sc.length; i++) ctx.lineTo(sc[i].x, sc[i].y);
    ctx.closePath();
    ctx.stroke();

    // Fill
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * 0.1;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = prevAlpha;

    // Radius line from center to edge point
    const sCenter = worldToScreen(m.x1, m.y1);
    const sEdge = worldToScreen(m.x2, m.y2);
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(sCenter.x, sCenter.y);
    ctx.lineTo(sEdge.x, sEdge.y);
    ctx.stroke();
    ctx.setLineDash([]);

    // Selection outline
    if (isSelected) {
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      // Draw a slightly offset outline using the same points
      ctx.beginPath();
      const cx = sCenter.x, cy = sCenter.y;
      for (let i = 0; i < sc.length; i++) {
        const dx = sc[i].x - cx, dy = sc[i].y - cy;
        const d = Math.hypot(dx, dy) || 1;
        const px = sc[i].x + (dx / d) * 3;
        const py = sc[i].y + (dy / d) * 3;
        if (i === 0) ctx.moveTo(px, py);
        else ctx.lineTo(px, py);
      }
      ctx.closePath();
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Center dot
    ctx.beginPath();
    ctx.arc(sCenter.x, sCenter.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (isSelected) {
      // Center handle
      ctx.beginPath();
      ctx.arc(sCenter.x, sCenter.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1.5;
      ctx.stroke();
      // Edge handle
      ctx.beginPath();
      ctx.arc(sEdge.x, sEdge.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1.5;
      ctx.stroke();
    }
    ctx.restore();
  }

  function drawPerspCircleLabel(m, layer, color, isSelected) {
    const pts = getPerspCirclePoints(m, layer, 64);
    if (!pts) return;
    const sc = pts.map(p => worldToScreen(p.x, p.y));
    const sCenter = worldToScreen(m.x1, m.y1);

    // Find topmost point of the ellipse
    let topY = Infinity, topX = sCenter.x;
    for (const p of sc) {
      if (p.y < topY) { topY = p.y; topX = p.x; }
    }

    const text = computeDimensionStr(m, layer);
    const lx = topX;
    const ly = topY - 16;
    ctx.save();
    ctx.font = `${isSelected ? 'bold ' : ''}11px ${monoFont()}`;
    const tw = ctx.measureText(text).width + 12;
    const th = 18;
    ctx.fillStyle = 'rgba(22, 33, 62, 0.92)';
    ctx.beginPath();
    roundRect(ctx, lx - tw / 2, ly - th / 2, tw, th, 4);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx, ly);
    ctx.restore();
  }

  function drawCircleShape(center, r, color, lineWidth, isSelected) {
    ctx.save();
    ctx.strokeStyle = color;
    ctx.lineWidth = lineWidth;
    ctx.setLineDash([]);
    ctx.beginPath();
    ctx.arc(center.x, center.y, r, 0, Math.PI * 2);
    ctx.stroke();
    const prevAlpha = ctx.globalAlpha;
    ctx.globalAlpha = prevAlpha * 0.1;
    ctx.fillStyle = color;
    ctx.fill();
    ctx.globalAlpha = prevAlpha;

    // Radius line
    ctx.setLineDash([3, 3]);
    ctx.lineWidth = 1;
    ctx.strokeStyle = color;
    ctx.beginPath();
    ctx.moveTo(center.x, center.y);
    ctx.lineTo(center.x + r, center.y);
    ctx.stroke();
    ctx.setLineDash([]);

    if (isSelected) {
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1;
      ctx.setLineDash([3, 3]);
      ctx.beginPath();
      ctx.arc(center.x, center.y, r + 3, 0, Math.PI * 2);
      ctx.stroke();
      ctx.setLineDash([]);
    }

    // Center dot (and edge dot when selected)
    ctx.beginPath();
    ctx.arc(center.x, center.y, 3, 0, Math.PI * 2);
    ctx.fillStyle = color;
    ctx.fill();

    if (isSelected) {
      // Edge handle
      const edgePt = { x: center.x + r, y: center.y };
      ctx.beginPath();
      ctx.arc(center.x, center.y, 4, 0, Math.PI * 2);
      ctx.fillStyle = color;
      ctx.fill();
      ctx.strokeStyle = 'white';
      ctx.lineWidth = 1.5;
      ctx.stroke();

      // Draw a handle at the actual x2,y2 screen position (the edge point from the measurement)
      // The radius line goes to center.x + r, but the actual edge point may be elsewhere
      // We just show the center and the "right" point for simplicity
    }
    ctx.restore();
  }

  function drawCircleLabel(center, r, text, color, isSelected) {
    const lx = center.x;
    const ly = center.y - r - 16;
    ctx.save();
    ctx.font = `${isSelected ? 'bold ' : ''}11px ${monoFont()}`;
    const tw = ctx.measureText(text).width + 12;
    const th = 18;
    ctx.fillStyle = 'rgba(22, 33, 62, 0.92)';
    ctx.beginPath();
    roundRect(ctx, lx - tw / 2, ly - th / 2, tw, th, 4);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx, ly);
    ctx.restore();
  }

  function drawLabel(p1, p2, text, color, isSelected) {
    const mx = (p1.x + p2.x) / 2;
    const my = (p1.y + p2.y) / 2;
    const angle = Math.atan2(p2.y - p1.y, p2.x - p1.x);
    ctx.save();
    ctx.font = `${isSelected ? 'bold ' : ''}12px ${monoFont()}`;
    const tw = ctx.measureText(text).width + 12;
    const th = 20;
    const offX = -Math.sin(angle) * 14;
    const offY = Math.cos(angle) * 14;
    const lx = mx + offX;
    const ly = my + offY;
    ctx.fillStyle = 'rgba(22, 33, 62, 0.92)';
    ctx.beginPath();
    roundRect(ctx, lx - tw / 2, ly - th / 2, tw, th, 4);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 1;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, lx, ly);
    ctx.restore();
  }

  function drawSmallLabel(x, y, text, color) {
    ctx.save();
    ctx.font = `10px ${monoFont()}`;
    const tw = ctx.measureText(text).width + 8;
    const th = 16;
    ctx.fillStyle = 'rgba(22, 33, 62, 0.85)';
    ctx.beginPath();
    roundRect(ctx, x - tw / 2, y - th / 2, tw, th, 3);
    ctx.fill();
    ctx.strokeStyle = color;
    ctx.lineWidth = 0.8;
    ctx.setLineDash([]);
    ctx.stroke();
    ctx.fillStyle = color;
    ctx.textAlign = 'center';
    ctx.textBaseline = 'middle';
    ctx.fillText(text, x, y);
    ctx.restore();
  }

  // ---- Draw In-Progress -----------------------------------
  function drawInProgress(d) {
    const s1 = worldToScreen(d.x1, d.y1);
    const s2 = worldToScreen(d.x2, d.y2);
    const layer = activeLayer();

    if (d.type === 'reference') {
      drawLine(s1, s2, '#f59e0b', 2, false, true);
      const pxLen = dist(d.x1, d.y1, d.x2, d.y2);
      drawLabel(s1, s2, `${Math.round(pxLen)} px`, '#f59e0b', false);
    } else if (d.type === 'line') {
      drawLine(s1, s2, '#38bdf8', 2, false, false);
      const tempMeas = { type: 'line', x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, displayUnit: null };
      const result = layer ? computeMeasurementValues(tempMeas, layer) : null;
      const text = result ? formatDim(result.values[0], result.unit) : `${Math.round(dist(d.x1, d.y1, d.x2, d.y2))} px`;
      drawLabel(s1, s2, text, '#38bdf8', false);
    } else if (d.type === 'rect') {
      const tempMeas = { type: 'rect', x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, displayUnit: null };
      const hasPerspective = layer && layer.perspRef && layer.perspRef.inverseHomography;
      if (hasPerspective) {
        drawPerspRectShape(tempMeas, layer, '#a78bfa', 2, false);
        const result = computeMeasurementValues(tempMeas, layer);
        if (result) {
          const corners = getPerspRectCorners(tempMeas, layer);
          if (corners) {
            const sc = corners.map(c => worldToScreen(c.x, c.y));
            const cx = (sc[0].x + sc[1].x + sc[2].x + sc[3].x) / 4;
            const topY = Math.min(sc[0].y, sc[1].y, sc[2].y, sc[3].y);
            const text = `${formatDim(result.values[0], result.unit)} \u00d7 ${formatDim(result.values[1], result.unit)}`;
            drawSmallLabel(cx, topY - 14, text, '#a78bfa');
          }
        }
      } else {
        drawRectShape(s1, s2, '#a78bfa', 2, false);
        const result = layer ? computeMeasurementValues(tempMeas, layer) : null;
        if (result) {
          const text = `${formatDim(result.values[0], result.unit)} \u00d7 ${formatDim(result.values[1], result.unit)}`;
          const cx = (s1.x + s2.x) / 2;
          const top = Math.min(s1.y, s2.y);
          drawSmallLabel(cx, top - 14, text, '#a78bfa');
        }
      }
    } else if (d.type === 'circle') {
      const tempMeas = { type: 'circle', x1: d.x1, y1: d.y1, x2: d.x2, y2: d.y2, displayUnit: null };
      const hasPerspective = layer && layer.perspRef && layer.perspRef.inverseHomography;
      if (hasPerspective) {
        drawPerspCircleShape(tempMeas, layer, '#34d399', 2, false);
        const result = computeMeasurementValues(tempMeas, layer);
        if (result) {
          const pts = getPerspCirclePoints(tempMeas, layer, 64);
          if (pts) {
            const sc = pts.map(p => worldToScreen(p.x, p.y));
            let topY = Infinity, topX = s1.x;
            for (const p of sc) {
              if (p.y < topY) { topY = p.y; topX = p.x; }
            }
            drawSmallLabel(topX, topY - 14, `\u2300 ${formatDim(result.values[0], result.unit)}`, '#34d399');
          }
        }
      } else {
        const r = dist(s1.x, s1.y, s2.x, s2.y);
        drawCircleShape(s1, r, '#34d399', 2, false);
        const result = layer ? computeMeasurementValues(tempMeas, layer) : null;
        if (result) {
          drawCircleLabel(s1, r, `\u2300 ${formatDim(result.values[0], result.unit)}`, '#34d399', false);
        }
      }
    }
  }

  // ---- Helpers --------------------------------------------
  function roundRect(ctx, x, y, w, h, r) {
    ctx.moveTo(x + r, y);
    ctx.lineTo(x + w - r, y);
    ctx.arcTo(x + w, y, x + w, y + r, r);
    ctx.lineTo(x + w, y + h - r);
    ctx.arcTo(x + w, y + h, x + w - r, y + h, r);
    ctx.lineTo(x + r, y + h);
    ctx.arcTo(x, y + h, x, y + h - r, r);
    ctx.lineTo(x, y + r);
    ctx.arcTo(x, y, x + r, y, r);
    ctx.closePath();
  }

  // ---- Boot -----------------------------------------------
  init();
})();
