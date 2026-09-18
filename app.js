'use strict';

// ---- Config (da tarare guardando il gioco reale) ----
const SAMPLE_INTERVAL_MS = 800;   // ogni quanto controllare la zona sottotitoli
const STABLE_COUNT = 2;           // letture OCR uguali consecutive richieste prima di considerare la riga "stabile"
const MAX_CROP_WIDTH = 480;       // limite risoluzione ritaglio, per velocità OCR
const CHANGE_THRESHOLD = 14;      // sensibilità del pre-filtro "è cambiato qualcosa?" (0-255)
const DEFAULT_RECT = { x: 0.12, y: 0.70, w: 0.76, h: 0.24 }; // zona sottotitoli di default (frazioni video)

// ---- Elementi ----
const video = document.getElementById('video');
const cropBox = document.getElementById('cropBox');
const handle = document.getElementById('handle');
const btnCamera = document.getElementById('btnCamera');
const btnStart = document.getElementById('btnStart');
const btnStop = document.getElementById('btnStop');
const statusEl = document.getElementById('status');
const historyList = document.getElementById('historyList');

// ---- Stato ----
let ocrWorker = null;
let stream = null;
let rect = loadRect();
let loopTimer = null;
let processing = false;
let lastStableGrid = null;
let pendingText = '';
let pendingCount = 0;
let lastSpokenText = '';
let wakeLock = null;

const ocrCanvas = document.createElement('canvas');
const ocrCtx = ocrCanvas.getContext('2d', { willReadFrequently: true });
const gridCanvas = document.createElement('canvas');
gridCanvas.width = 32; gridCanvas.height = 10;
const gridCtx = gridCanvas.getContext('2d', { willReadFrequently: true });

function updateStatus(msg) {
  statusEl.textContent = msg;
}

// ---- Persistenza riquadro ----
function loadRect() {
  try {
    const saved = JSON.parse(localStorage.getItem('cropRect'));
    if (saved && saved.w > 0.02 && saved.h > 0.02) return saved;
  } catch (e) {}
  return { ...DEFAULT_RECT };
}
function saveRect() {
  localStorage.setItem('cropRect', JSON.stringify(rect));
}

// ---- Riquadro di calibrazione (trascinabile e ridimensionabile) ----
function layoutCropBox() {
  const w = video.clientWidth, h = video.clientHeight;
  cropBox.style.left = (rect.x * w) + 'px';
  cropBox.style.top = (rect.y * h) + 'px';
  cropBox.style.width = (rect.w * w) + 'px';
  cropBox.style.height = (rect.h * h) + 'px';
}

function setupCropBox() {
  layoutCropBox();
  window.addEventListener('resize', layoutCropBox);

  let dragging = null; // 'move' | 'resize'
  let startPointer = { x: 0, y: 0 };
  let startRect = null;

  cropBox.addEventListener('pointerdown', (ev) => {
    if (ev.target === handle) return;
    dragging = 'move';
    startPointer = { x: ev.clientX, y: ev.clientY };
    startRect = { ...rect };
    cropBox.setPointerCapture(ev.pointerId);
  });
  handle.addEventListener('pointerdown', (ev) => {
    dragging = 'resize';
    startPointer = { x: ev.clientX, y: ev.clientY };
    startRect = { ...rect };
    ev.stopPropagation();
    handle.setPointerCapture(ev.pointerId);
  });
  cropBox.addEventListener('pointermove', (ev) => handlePointerMove(ev));
  handle.addEventListener('pointermove', (ev) => handlePointerMove(ev));
  function handlePointerMove(ev) {
    if (!dragging) return;
    const w = video.clientWidth, h = video.clientHeight;
    const dx = (ev.clientX - startPointer.x) / w;
    const dy = (ev.clientY - startPointer.y) / h;
    if (dragging === 'move') {
      rect.x = clamp(startRect.x + dx, 0, 1 - rect.w);
      rect.y = clamp(startRect.y + dy, 0, 1 - rect.h);
    } else if (dragging === 'resize') {
      rect.w = clamp(startRect.w + dx, 0.08, 1 - rect.x);
      rect.h = clamp(startRect.h + dy, 0.06, 1 - rect.y);
    }
    layoutCropBox();
  }
  function endDrag(ev) { dragging = null; }
  cropBox.addEventListener('pointerup', endDrag);
  cropBox.addEventListener('pointercancel', endDrag);
  handle.addEventListener('pointerup', endDrag);
  handle.addEventListener('pointercancel', endDrag);
}

function clamp(v, min, max) { return Math.max(min, Math.min(max, v)); }

// ---- Fotocamera + motore OCR ----
btnCamera.addEventListener('click', async () => {
  btnCamera.disabled = true;
  updateStatus('Avvio fotocamera e motore OCR...');
  try {
    const [s] = await Promise.all([
      navigator.mediaDevices.getUserMedia({
        video: { facingMode: { ideal: 'environment' } },
        audio: false
      }),
      initOcrWorker()
    ]);
    stream = s;
    video.srcObject = stream;
    await new Promise((resolve) => { video.onloadedmetadata = resolve; });
    await video.play();
    setupCropBox();
    btnStart.disabled = false;
    updateStatus('Regola il riquadro sui sottotitoli, poi premi "Avvia lettura".');
  } catch (e) {
    updateStatus('Errore fotocamera/OCR: ' + e.message);
    btnCamera.disabled = false;
  }
});

async function initOcrWorker() {
  if (ocrWorker) return;
  ocrWorker = await Tesseract.createWorker('eng');
}

// ---- Avvio / stop lettura ----
btnStart.addEventListener('click', async () => {
  saveRect();

  // "Sblocca" la sintesi vocale su iOS Safari con un'utterance nel gesto utente
  window.speechSynthesis.cancel();
  const primer = new SpeechSynthesisUtterance('Lettura avviata');
  primer.lang = 'it-IT';
  window.speechSynthesis.speak(primer);

  await requestWakeLock();

  btnStart.hidden = true;
  btnStop.hidden = false;
  updateStatus('In ascolto...');

  lastStableGrid = null;
  pendingText = '';
  pendingCount = 0;

  loopTimer = setInterval(tick, SAMPLE_INTERVAL_MS);
});

btnStop.addEventListener('click', () => {
  clearInterval(loopTimer);
  loopTimer = null;
  window.speechSynthesis.cancel();
  btnStart.hidden = false;
  btnStop.hidden = true;
  updateStatus('Fermato.');
});

async function requestWakeLock() {
  try {
    wakeLock = await navigator.wakeLock.request('screen');
  } catch (e) {
    // non bloccante: su alcuni dispositivi/contesti potrebbe non essere disponibile
  }
}
document.addEventListener('visibilitychange', async () => {
  if (wakeLock !== null && document.visibilityState === 'visible' && loopTimer) {
    await requestWakeLock();
  }
});

// ---- Loop principale ----
async function tick() {
  if (processing) return;

  const vw = video.videoWidth, vh = video.videoHeight;
  if (!vw || !vh) return;

  const sx = rect.x * vw, sy = rect.y * vh, sw = rect.w * vw, sh = rect.h * vh;
  const scale = Math.min(1, MAX_CROP_WIDTH / sw);
  ocrCanvas.width = Math.round(sw * scale);
  ocrCanvas.height = Math.round(sh * scale);
  ocrCtx.drawImage(video, sx, sy, sw, sh, 0, 0, ocrCanvas.width, ocrCanvas.height);

  const grid = computeGrid(ocrCanvas);
  if (lastStableGrid && gridDiff(grid, lastStableGrid) < CHANGE_THRESHOLD) {
    return; // nulla di rilevante è cambiato rispetto all'ultimo stato stabile
  }

  processing = true;
  try {
    const { data } = await ocrWorker.recognize(ocrCanvas);
    const text = normalizeText(data.text);

    if (text === pendingText) {
      pendingCount++;
    } else {
      pendingText = text;
      pendingCount = 1;
    }

    if (pendingCount >= STABLE_COUNT) {
      lastStableGrid = grid;
      if (text && text !== lastSpokenText) {
        lastSpokenText = text;
        handleNewLine(text);
      }
    }
  } catch (e) {
    updateStatus('Errore OCR: ' + e.message);
  } finally {
    processing = false;
  }
}

function normalizeText(raw) {
  return raw.replace(/\s+/g, ' ').trim();
}

function computeGrid(sourceCanvas) {
  gridCtx.drawImage(sourceCanvas, 0, 0, gridCanvas.width, gridCanvas.height);
  const { data } = gridCtx.getImageData(0, 0, gridCanvas.width, gridCanvas.height);
  const out = new Uint8ClampedArray(gridCanvas.width * gridCanvas.height);
  for (let i = 0, p = 0; i < data.length; i += 4, p++) {
    out[p] = (data[i] * 0.3 + data[i + 1] * 0.59 + data[i + 2] * 0.11) | 0;
  }
  return out;
}

function gridDiff(a, b) {
  let sum = 0;
  for (let i = 0; i < a.length; i++) sum += Math.abs(a[i] - b[i]);
  return sum / a.length;
}

// ---- Traduzione + lettura vocale ----
async function handleNewLine(text) {
  updateStatus('EN: "' + text + '"');
  try {
    const translated = await translate(text);
    speak(translated);
    addHistory(text, translated);
  } catch (e) {
    updateStatus('Errore traduzione: ' + e.message);
  }
}

async function translate(text) {
  const url = 'https://api.mymemory.translated.net/get?q=' + encodeURIComponent(text) + '&langpair=en|it';
  const resp = await fetch(url);
  const data = await resp.json();
  if (!data.responseData || !data.responseData.translatedText) {
    throw new Error('risposta traduzione non valida');
  }
  return data.responseData.translatedText;
}

function speak(text) {
  window.speechSynthesis.cancel(); // interrompe subito la lettura in corso
  const utter = new SpeechSynthesisUtterance(text);
  utter.lang = 'it-IT';
  const voices = window.speechSynthesis.getVoices();
  const itVoice = voices.find((v) => v.lang && v.lang.toLowerCase().startsWith('it'));
  if (itVoice) utter.voice = itVoice;
  window.speechSynthesis.speak(utter);
}

// ---- Storico ----
const MAX_HISTORY = 50;
function addHistory(en, it) {
  const entry = document.createElement('div');
  entry.className = 'entry';
  const time = new Date().toLocaleTimeString('it-IT', { hour: '2-digit', minute: '2-digit', second: '2-digit' });
  entry.innerHTML = '<div class="en">' + time + ' — ' + escapeHtml(en) + '</div><div class="it">' + escapeHtml(it) + '</div>';
  historyList.prepend(entry);
  while (historyList.children.length > MAX_HISTORY) {
    historyList.removeChild(historyList.lastChild);
  }
  updateStatus('IT: "' + it + '"');
}

function escapeHtml(s) {
  return s.replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
}
