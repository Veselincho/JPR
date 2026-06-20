const { ipcRenderer } = require('electron');

const songInput     = document.getElementById('songInput');
const playlistInput = document.getElementById('playlistInput');
const formatSelect  = document.getElementById('formatSelect');
const folderPath    = document.getElementById('folderPath');
const browseBtn     = document.getElementById('browseBtn');
const downloadBtn   = document.getElementById('downloadBtn');
const stopBtn       = document.getElementById('stopBtn');
const loadingCt     = document.getElementById('loading-container');
const chronometerEl = document.getElementById('chronometer');
const progressCt    = document.getElementById('progressContainer');
const progressBar   = document.getElementById('downloadProgress');
const progressLabel = document.getElementById('progressLabel');
const progressSpeed = document.getElementById('progressSpeed');
const progressEta   = document.getElementById('progressEta');
const trimToggleGroup = document.getElementById('trimToggleGroup');
const trimToggleBtn   = document.getElementById('trimToggleBtn');
const trimPanel       = document.getElementById('trimPanel');
const trimStart       = document.getElementById('trimStart');
const trimEnd         = document.getElementById('trimEnd');
const logOutput     = document.getElementById('logOutput');

const playlistActions      = document.getElementById('playlistActions');
const downloadAllBtn       = document.getElementById('downloadAllBtn');
const choosePlaylistBtn    = document.getElementById('choosePlaylistBtn');
const playlistFetchLoading = document.getElementById('playlistFetchLoading');
const playlistSelectionPanel = document.getElementById('playlistSelectionPanel');
const toggleSelectAllBtn   = document.getElementById('toggleSelectAllBtn');
const playlistTrackList    = document.getElementById('playlistTrackList');
const playlistCountLabel   = document.getElementById('playlistCountLabel');
const downloadSelectedBtn  = document.getElementById('downloadSelectedBtn');

const DOWNLOAD_LABEL = 'Download';
const DOWNLOAD_BUSY_LABEL = 'Downloading…';

let chronoInterval, startTime;
let playlistEntries = [];
let isFetchingPlaylist = false;
let isDownloadBusy = false;

function isPlaylistUrl(value) {
  const trimmed = value.trim();
  return trimmed.length > 0 && trimmed.includes('list=');
}

function setDownloadBusy(busy) {
  isDownloadBusy = busy;
  downloadBtn.disabled = busy;
  downloadBtn.classList.toggle('downloading', busy);
  downloadBtn.textContent = busy ? DOWNLOAD_BUSY_LABEL : DOWNLOAD_LABEL;
  updatePlaylistControlsState();
}

function updatePlaylistControlsState() {
  const disabled = isDownloadBusy || isFetchingPlaylist;
  downloadAllBtn.disabled = disabled;
  choosePlaylistBtn.disabled = disabled;
  downloadSelectedBtn.disabled = disabled || getSelectedCount() === 0;
}

function updatePlaylistModeUI() {
  const showPlaylistMode = isPlaylistUrl(playlistInput.value);

  playlistActions.hidden = !showPlaylistMode;
  downloadBtn.style.display = showPlaylistMode ? 'none' : '';

  if (!showPlaylistMode) {
    hidePlaylistSelection();
  }
}

function hidePlaylistSelection() {
  playlistFetchLoading.hidden = true;
  playlistSelectionPanel.hidden = true;
  playlistEntries = [];
  playlistTrackList.innerHTML = '';
  if (playlistCountLabel) playlistCountLabel.textContent = '';
  updateDownloadSelectedLabel();
}

function formatDuration(seconds) {
  if (seconds == null || Number.isNaN(seconds)) return '—';
  const total = Math.round(Number(seconds));
  const h = Math.floor(total / 3600);
  const m = Math.floor((total % 3600) / 60);
  const s = total % 60;
  if (h > 0) {
    return `${h}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
  }
  return `${m}:${String(s).padStart(2, '0')}`;
}

function pickThumbnail(thumbnails) {
  if (!thumbnails || !thumbnails.length) return null;
  const sorted = [...thumbnails].sort((a, b) => (b.width || 0) - (a.width || 0));
  return sorted[0]?.url || thumbnails[thumbnails.length - 1]?.url || null;
}

function getSelectedCount() {
  return playlistTrackList.querySelectorAll('input[type="checkbox"]:checked').length;
}

function updateDownloadSelectedLabel() {
  const count = getSelectedCount();
  downloadSelectedBtn.textContent = `Download Selected (${count})`;
  downloadSelectedBtn.disabled = isDownloadBusy || isFetchingPlaylist || count === 0;
}

function updateSelectAllLabel() {
  const checkboxes = [...playlistTrackList.querySelectorAll('input[type="checkbox"]')];
  const allChecked = checkboxes.length > 0 && checkboxes.every(cb => cb.checked);
  toggleSelectAllBtn.textContent = allChecked ? 'Deselect All' : 'Select All';
}

function renderPlaylistTracks(entries) {
  playlistEntries = entries;
  playlistTrackList.innerHTML = '';
  if (playlistCountLabel) {
    playlistCountLabel.textContent = `${entries.length} track${entries.length === 1 ? '' : 's'}`;
  }

  entries.forEach((entry, index) => {
    const row = document.createElement('label');
    row.className = 'playlist-track-item';

    const num = document.createElement('span');
    num.className = 'playlist-track-num';
    num.textContent = String(index + 1);

    const checkbox = document.createElement('input');
    checkbox.type = 'checkbox';
    checkbox.checked = true;
    checkbox.dataset.videoId = entry.id;
    checkbox.addEventListener('change', () => {
      updateDownloadSelectedLabel();
      updateSelectAllLabel();
    });

    const thumbUrl = pickThumbnail(entry.thumbnails);
    let thumbEl;
    if (thumbUrl) {
      thumbEl = document.createElement('img');
      thumbEl.className = 'playlist-track-thumb';
      thumbEl.src = thumbUrl;
      thumbEl.alt = '';
      thumbEl.loading = 'lazy';
    } else {
      thumbEl = document.createElement('span');
      thumbEl.className = 'playlist-track-thumb placeholder';
      thumbEl.setAttribute('aria-hidden', 'true');
    }

    const info = document.createElement('div');
    info.className = 'playlist-track-info';

    const title = document.createElement('div');
    title.className = 'playlist-track-title';
    title.textContent = entry.title;
    title.title = entry.title;

    const duration = document.createElement('div');
    duration.className = 'playlist-track-duration';
    duration.textContent = formatDuration(entry.duration);

    info.appendChild(title);
    info.appendChild(duration);
    row.appendChild(num);
    row.appendChild(checkbox);
    row.appendChild(thumbEl);
    row.appendChild(info);
    playlistTrackList.appendChild(row);
  });

  updateDownloadSelectedLabel();
  updateSelectAllLabel();
}

async function fetchAndShowPlaylist() {
  const playlistURL = playlistInput.value.trim();
  if (!isPlaylistUrl(playlistURL)) return;

  isFetchingPlaylist = true;
  playlistFetchLoading.hidden = false;
  playlistSelectionPanel.hidden = true;
  updatePlaylistControlsState();

  try {
    const result = await ipcRenderer.invoke('fetch-playlist-metadata', playlistURL);
    if (!isPlaylistUrl(playlistInput.value) || playlistInput.value.trim() !== playlistURL) return;

    if (!result.ok || !result.entries.length) {
      appendLog(result.error ? `❌ ${result.error}` : '❌ No tracks found in playlist');
      hidePlaylistSelection();
      return;
    }

    renderPlaylistTracks(result.entries);
    playlistSelectionPanel.hidden = false;
    appendLog(`📋 Loaded ${result.entries.length} tracks — select what to download`);
  } catch (err) {
    appendLog(`❌ Failed to fetch playlist: ${err.message}`);
    hidePlaylistSelection();
  } finally {
    isFetchingPlaylist = false;
    playlistFetchLoading.hidden = true;
    updatePlaylistControlsState();
  }
}

function isTrimActive() {
  return trimPanel.classList.contains('open')
    && trimStart.value.trim()
    && trimEnd.value.trim();
}

function buildDownloadPayload({ selectedVideoIds } = {}) {
  return {
    songName: songInput.value.trim(),
    playlistURL: selectedVideoIds ? '' : playlistInput.value.trim(),
    selectedVideoIds: selectedVideoIds || null,
    format: formatSelect.value,
    folder: folderPath.value,
    trimStart: isTrimActive() ? trimStart.value.trim() : '',
    trimEnd: isTrimActive() ? trimEnd.value.trim() : '',
  };
}

function startDownload(options = {}) {
  startChrono();
  ipcRenderer.send('cancel-download', { suppressStop: true });

  const payload = buildDownloadPayload(options);
  const { songName, playlistURL, selectedVideoIds } = payload;

  logOutput.innerHTML = '';
  appendLog(`🔎 Payload: ${JSON.stringify(payload)}`);

  if (!songName && !playlistURL && !(selectedVideoIds && selectedVideoIds.length)) {
    appendLog('❌ Enter a URL');
    stopChrono();
    return;
  }

  progressCt.style.display = 'block';
  resetProgressUI();
  setDownloadBusy(true);

  ipcRenderer.send('download-song', payload);
}

function startDownloadAll() {
  if (!isPlaylistUrl(playlistInput.value)) return;
  startDownload();
}

function startDownloadSelected() {
  const selectedIds = [...playlistTrackList.querySelectorAll('input[type="checkbox"]:checked')]
    .map(cb => cb.dataset.videoId)
    .filter(Boolean);

  if (!selectedIds.length) return;
  startDownload({ selectedVideoIds: selectedIds });
}

// init: show real Downloads folder
async function init() {
  const def = await ipcRenderer.invoke('get-default-folder');
  folderPath.value = def;
  hidePlaylistSelection();
  updatePlaylistModeUI();
}
init();

browseBtn.addEventListener('click', async () => {
  const f = await ipcRenderer.invoke('select-folder');
  if (f) folderPath.value = f;
});

// clearing one input when the other is used
songInput.addEventListener('input', () => {
  if (songInput.value) playlistInput.value = '';
  updateTrimVisibility();
  updatePlaylistModeUI();
});
playlistInput.addEventListener('input', () => {
  if (playlistInput.value) songInput.value = '';
  updateTrimVisibility();
  updatePlaylistModeUI();
  hidePlaylistSelection();
});

function updateTrimVisibility() {
  const hasSingle = songInput.value.trim() && !playlistInput.value.trim();
  trimToggleGroup.style.display = hasSingle ? 'block' : 'none';
  if (!hasSingle) {
    trimPanel.classList.remove('open');
    trimToggleBtn.textContent = '▸ Опции за изрязване';
    trimStart.value = '';
    trimEnd.value = '';
  }
}

trimToggleBtn.addEventListener('click', () => {
  const open = trimPanel.classList.toggle('open');
  trimToggleBtn.textContent = open ? '▾ Опции за изрязване' : '▸ Опции за изрязване';
  if (!open) {
    trimStart.value = '';
    trimEnd.value = '';
  }
});

// right-click context menu on both
window.addEventListener('contextmenu', e => {
  if (e.target.matches('#songInput, #playlistInput')) {
    e.preventDefault();
    ipcRenderer.send('show-context-menu');
  }
});

downloadBtn.addEventListener('click', () => startDownload());
downloadAllBtn.addEventListener('click', startDownloadAll);
choosePlaylistBtn.addEventListener('click', fetchAndShowPlaylist);
downloadSelectedBtn.addEventListener('click', startDownloadSelected);

toggleSelectAllBtn.addEventListener('click', () => {
  const checkboxes = [...playlistTrackList.querySelectorAll('input[type="checkbox"]')];
  if (!checkboxes.length) return;
  const allChecked = checkboxes.every(cb => cb.checked);
  checkboxes.forEach(cb => { cb.checked = !allChecked; });
  updateDownloadSelectedLabel();
  updateSelectAllLabel();
});

stopBtn.addEventListener('click', () => {
  ipcRenderer.send('cancel-download');
  stopChrono();
  isFetchingPlaylist = false;
  playlistFetchLoading.hidden = true;
  updatePlaylistControlsState();
});

songInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') startDownload();
});

playlistInput.addEventListener('keydown', e => {
  if (e.key === 'Enter') {
    if (isPlaylistUrl(playlistInput.value)) {
      startDownloadAll();
    } else {
      startDownload();
    }
  }
});

function startChrono() {
  startTime = Date.now();
  chronometerEl.textContent = '00:00:00';
  loadingCt.style.display = 'flex';
  chronoInterval = setInterval(() => {
    const diff = Date.now() - startTime;
    const h = String(Math.floor(diff/3600000)).padStart(2,'0');
    const m = String(Math.floor((diff%3600000)/60000)).padStart(2,'0');
    const s = String(Math.floor((diff%60000)/1000)).padStart(2,'0');
    chronometerEl.textContent = `${h}:${m}:${s}`;
  }, 500);
}

function stopChrono() {
  clearInterval(chronoInterval);
  chronometerEl.textContent = '00:00:00';
  loadingCt.style.display = 'none';
}

function appendLog(text) {
  const line = document.createElement('div');
  line.textContent = `[${new Date().toLocaleTimeString()}] ${text}`;
  logOutput.appendChild(line);
  logOutput.scrollTop = logOutput.scrollHeight;
}

function resetProgressUI() {
  progressBar.value = 0;
  progressLabel.textContent = '0%';
  progressSpeed.textContent = '—';
  progressEta.textContent = 'ETA —';
}

ipcRenderer.on('download-progress', (_, data) => {
  const pct = typeof data === 'number' ? data : data.percent;
  const rounded = Math.round(pct * 10) / 10;
  progressBar.value = rounded;
  progressLabel.textContent = `${rounded}%`;

  if (typeof data === 'object' && data) {
    if (data.speed) progressSpeed.textContent = data.speed;
    if (data.eta) progressEta.textContent = `ETA ${data.eta}`;
    if (data.item && data.total) {
      progressLabel.textContent = `${rounded}% (${data.item}/${data.total})`;
    }
  }
});

ipcRenderer.on('log-message', (_, msg) => {
  appendLog(msg);
});

ipcRenderer.on('stop-loading', () => {
  stopChrono();
  progressLabel.textContent = 'Done';
  progressSpeed.textContent = '—';
  progressEta.textContent = 'ETA —';
  isFetchingPlaylist = false;
  playlistFetchLoading.hidden = true;
  setDownloadBusy(false);
});
