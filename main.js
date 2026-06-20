const { app, BrowserWindow, ipcMain, dialog, Menu } = require('electron');
const path = require('path');
const fs = require('fs');
const { spawn, execFileSync } = require('child_process');
const { detectOpenBrowsers, getBrowserLabel } = require('./browser-cookies');

let mainWindow, currentProc = null;
let currentTaskId = 0, cancelledTaskId = 0;
let jsRuntimeArgs = null;
let ytDlpPath = null;
let taskCookieBrowsers = [];
let lastYtDlpStderr = '';
const isWin = process.platform === 'win32';

const PERF_ARGS = ['--no-update', '--no-write-thumbnail', '--no-embed-thumbnail', '--no-embed-metadata'];
const COOKIE_ERROR_RE = /(?:cookies-from-browser|could not copy|failed to decrypt|decrypt.{0,20}cookie|no such browser|unsupported browser|browser.{0,30}not found|cookie database).{0,50}(?:error|fail|unable|cannot|could not|locked)|(?:error|fail|unable|cannot|could not).{0,50}(?:cookies-from-browser|cookie database|decrypt.{0,20}cookie|browser cookies)/i;
const JS_CHALLENGE_ERROR_RE = /javascript runtime|js[- ]challenge|jsc:|signature extraction|n[- ]function|solve.{0,20}challenge|unable to extract.*player|player.?response|requested format is not available|no formats found|signature|cipher/i;
const AUTH_ERROR_RE = /sign in to confirm|confirm you.?re not a bot|use --cookies-from-browser|age[- ]restricted|login required|private video|members[- ]only|this video requires payment|not available in your country|http error 403/i;
const OUTPUT_FILENAME_TEMPLATE = '%(title)s.%(ext)s';
const ALREADY_DOWNLOADED_RE = /has already been downloaded|not overwriting|already exists/i;
const JS_RUNTIME_WARNING_RE = /no supported javascript runtime/i;
const YTDLP_PROGRESS_RE = /\[download\]\s+([\d.]+)%(?:\s+of\s+~?\s*[\d.]+\s*\w+)?\s+at\s+([\d.]+\s*\w+\/s|Unknown B\/s|\?\?\?\s*B\/s)(?:\s+ETA\s+([\d:]+|Unknown))?/i;
const YTDLP_PROGRESS_SIMPLE_RE = /\[download\]\s+([\d.]+)%/;
const isMac = process.platform === 'darwin';
const nodeBinary = isWin ? 'node.exe' : 'node';
const ytDlpBinary = isWin ? 'yt-dlp.exe' : 'yt-dlp';
const pathSeparator = isWin ? ';' : ':';

function getMacPathPrefix() {
  return ['/opt/homebrew/bin', '/opt/homebrew/sbin', '/usr/local/bin', '/usr/local/sbin'];
}

function getSystemPath() {
  if (isWin) {
    try {
      const machine = execFileSync(
        'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'Machine\')"',
        { encoding: 'utf8', shell: true }
      ).trim();
      const user = execFileSync(
        'powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable(\'Path\',\'User\')"',
        { encoding: 'utf8', shell: true }
      ).trim();
      return [machine, user, process.env.PATH].filter(Boolean).join(';');
    } catch {
      return process.env.PATH || '';
    }
  }
  if (isMac) {
    return [...getMacPathPrefix(), process.env.PATH || ''].filter(Boolean).join(':');
  }
  return process.env.PATH || '';
}

function findBinaryInPath(pathEnv, binaryName) {
  for (const dir of pathEnv.split(pathSeparator)) {
    const trimmed = dir.trim();
    if (!trimmed) continue;
    const candidate = path.join(trimmed, binaryName);
    if (fs.existsSync(candidate)) return candidate;
  }
  return null;
}

function findNodeInPath(pathEnv) {
  return findBinaryInPath(pathEnv, nodeBinary);
}

function findNodeViaCommand() {
  try {
    const cmd = isWin ? 'where node' : 'which node';
    const found = execFileSync(cmd, { encoding: 'utf8', shell: true })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();
    if (found && fs.existsSync(found)) return found;
  } catch { /* not in PATH */ }
  return null;
}

function findLatestNvmNode() {
  const home = process.env.HOME || process.env.USERPROFILE;
  if (!home) return null;

  const nvmRoots = isWin
    ? [
        ...(process.env.NVM_HOME ? [process.env.NVM_HOME] : []),
        ...(process.env.APPDATA ? [path.join(process.env.APPDATA, 'nvm')] : []),
      ]
    : [path.join(home, '.nvm', 'versions', 'node')];

  for (const root of nvmRoots) {
    if (!root || !fs.existsSync(root)) continue;
    try {
      const versions = fs.readdirSync(root).filter(Boolean).sort().reverse();
      for (const ver of versions) {
        const candidate = isWin
          ? path.join(root, ver, 'node.exe')
          : path.join(root, ver, 'bin', nodeBinary);
        if (fs.existsSync(candidate)) return candidate;
      }
    } catch { /* unreadable nvm dir */ }
  }
  return null;
}

function getCommonNodePaths() {
  const home = process.env.HOME || process.env.USERPROFILE || '';
  const candidates = [];

  if (isWin) {
    if (process.env.ProgramFiles) candidates.push(path.join(process.env.ProgramFiles, 'nodejs', nodeBinary));
    if (process.env['ProgramFiles(x86)']) candidates.push(path.join(process.env['ProgramFiles(x86)'], 'nodejs', nodeBinary));
    if (process.env.LOCALAPPDATA) candidates.push(path.join(process.env.LOCALAPPDATA, 'Programs', 'nodejs', nodeBinary));
    if (process.env.NVM_HOME) candidates.push(path.join(process.env.NVM_HOME, nodeBinary));
    if (process.env.NVM_SYMLINK) candidates.push(path.join(process.env.NVM_SYMLINK, nodeBinary));
  } else if (isMac) {
    candidates.push(
      '/opt/homebrew/bin/node',
      '/usr/local/bin/node',
      '/usr/bin/node',
    );
    if (process.env.NVM_BIN) candidates.push(path.join(process.env.NVM_BIN, nodeBinary));
  } else {
    candidates.push('/usr/bin/node', '/usr/local/bin/node');
    if (process.env.NVM_BIN) candidates.push(path.join(process.env.NVM_BIN, nodeBinary));
  }

  if (process.env.FNM_MULTISHELL_PATH) candidates.push(path.join(process.env.FNM_MULTISHELL_PATH, nodeBinary));
  if (process.env.VOLTA_HOME) candidates.push(path.join(process.env.VOLTA_HOME, 'bin', nodeBinary));

  return candidates.filter(Boolean);
}

function findNodeExecutable() {
  const strategies = [
    () => findNodeInPath(getSystemPath()),
    () => findNodeInPath(process.env.PATH || ''),
    findNodeViaCommand,
    () => getCommonNodePaths().find(p => fs.existsSync(p)) || null,
    findLatestNvmNode,
  ];

  for (const strategy of strategies) {
    const found = strategy();
    if (found) return found;
  }
  return null;
}

function findBinaryViaCommand(binaryName) {
  try {
    const cmd = isWin ? `where ${binaryName}` : `which ${binaryName}`;
    const found = execFileSync(cmd, { encoding: 'utf8', shell: true })
      .trim()
      .split(/\r?\n/)[0]
      ?.trim();
    if (found && fs.existsSync(found)) return found;
  } catch { /* not in PATH */ }
  return null;
}

function findYtDlpExecutable() {
  if (ytDlpPath) return ytDlpPath;

  const commonPaths = isMac
    ? ['/opt/homebrew/bin/yt-dlp', '/usr/local/bin/yt-dlp']
    : [];

  const strategies = [
    () => findBinaryInPath(getSystemPath(), ytDlpBinary),
    () => findBinaryInPath(process.env.PATH || '', ytDlpBinary),
    () => findBinaryViaCommand('yt-dlp'),
    () => commonPaths.find(p => fs.existsSync(p)) || null,
  ];

  for (const strategy of strategies) {
    const found = strategy();
    if (found) {
      ytDlpPath = found;
      return ytDlpPath;
    }
  }

  ytDlpPath = 'yt-dlp';
  return ytDlpPath;
}

function getJsRuntimeArgs() {
  if (jsRuntimeArgs) return jsRuntimeArgs;

  const nodePath = findNodeExecutable();
  jsRuntimeArgs = nodePath
    ? ['--js-runtimes', `node:${nodePath}`]
    : ['--js-runtimes', 'node'];

  return jsRuntimeArgs;
}

function logMessage(msg) {
  mainWindow?.webContents.send('log-message', msg);
}

function sendProgress(data) {
  if (!mainWindow) return;
  const payload = typeof data === 'number'
    ? { percent: data, speed: null, eta: null }
    : data;
  mainWindow.webContents.send('download-progress', payload);
}

function parseTimeToHMS(input) {
  if (!input || !String(input).trim()) return null;
  const parts = String(input).trim().split(':').map(p => p.trim());
  if (!parts.length || parts.some(p => p === '' || !/^\d+$/.test(p))) return null;

  let h = 0;
  let m = 0;
  let s = 0;
  if (parts.length === 3) {
    [h, m, s] = parts.map(Number);
  } else if (parts.length === 2) {
    [m, s] = parts.map(Number);
  } else if (parts.length === 1) {
    s = Number(parts[0]);
  } else {
    return null;
  }

  if ([h, m, s].some(n => Number.isNaN(n) || n < 0) || m > 59 || s > 59) return null;

  return `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function timeToSeconds(hms) {
  const [h, m, s] = hms.split(':').map(Number);
  return h * 3600 + m * 60 + s;
}

function buildDownloadSections(trimStart, trimEnd) {
  const start = parseTimeToHMS(trimStart);
  const end = parseTimeToHMS(trimEnd);
  if (!start && !end) return [];
  if (!start || !end) {
    logMessage('⚠️ Trim requires both start and end times (HH:MM:SS or MM:SS)');
    return [];
  }
  if (timeToSeconds(end) <= timeToSeconds(start)) {
    logMessage('⚠️ End time must be after start time');
    return [];
  }
  const duration = timeToSeconds(end) - timeToSeconds(start);
  logMessage(`✂️ Trim: ${start} → ${end} (${duration}s)`);
  return ['--download-sections', `*${start}-${end}`, '--force-keyframes-at-cuts'];
}

function buildOutputArgs(folder, duplicateIndex = 0) {
  if (!folder) return [];
  const suffix = duplicateIndex > 0 ? ` (${duplicateIndex})` : '';
  const template = OUTPUT_FILENAME_TEMPLATE.replace('.%(ext)s', `${suffix}.%(ext)s`);
  return ['--no-overwrites', '-o', path.join(folder, template)];
}

async function runYtDlpDownload(baseArgs, folder, url, options = {}) {
  if (!folder) {
    await runYtDlp([...baseArgs, url], { ...options, preferJs: true });
    return;
  }

  for (let dup = 0; dup < 100; dup++) {
    await runYtDlp([...baseArgs, ...buildOutputArgs(folder, dup), url], {
      ...options,
      preferJs: true,
    });

    if (!ALREADY_DOWNLOADED_RE.test(lastYtDlpStderr)) {
      if (dup > 0) logMessage(`📁 Saved as copy (${dup})`);
      return;
    }

    logMessage(dup === 0
      ? '📁 File already exists — downloading as copy…'
      : `📁 Trying alternate name (${dup})…`);
  }

  throw new Error('Could not find an available filename');
}

function parseYtDlpProgress(line) {
  const trimmed = line.trim();
  if (!trimmed.includes('[download]')) return null;

  const full = trimmed.match(YTDLP_PROGRESS_RE);
  if (full) {
    return {
      percent: parseFloat(full[1]),
      speed: full[2].replace(/\s+/g, ' ').trim(),
      eta: full[3] && !/^unknown$/i.test(full[3]) ? full[3] : null,
    };
  }

  const simple = trimmed.match(YTDLP_PROGRESS_SIMPLE_RE);
  if (simple) {
    return { percent: parseFloat(simple[1]), speed: null, eta: null };
  }

  return null;
}

function createProgressStreamHandler(onProgress, onLine) {
  let buffer = '';
  return chunk => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';

    for (const line of lines) {
      const progress = parseYtDlpProgress(line);
      if (progress && onProgress) onProgress(progress);
      if (onLine) onLine(line);
    }
  };
}

function failureText(stderrText, errMessage) {
  return `${stderrText || ''}\n${errMessage || ''}`;
}

function isCookieRelatedFailure(stderrText, errMessage) {
  return COOKIE_ERROR_RE.test(failureText(stderrText, errMessage));
}

function isJsChallengeFailure(stderrText, errMessage) {
  return JS_CHALLENGE_ERROR_RE.test(failureText(stderrText, errMessage));
}

function isAuthRelatedFailure(stderrText, errMessage) {
  return AUTH_ERROR_RE.test(failureText(stderrText, errMessage));
}

function analyzeSingleSongInput(input) {
  const trimmed = String(input || '').trim();
  if (!trimmed.startsWith('http')) return { url: trimmed, scopeArgs: ['--no-playlist'] };

  try {
    const u = new URL(trimmed);
    const host = u.hostname.replace(/^www\./, '');
    if (!host.includes('youtube.com') && !host.includes('youtu.be')) {
      return { url: trimmed, scopeArgs: ['--no-playlist'] };
    }

    if (host.includes('youtu.be')) {
      return { url: trimmed, scopeArgs: ['--no-playlist'] };
    }

    const list = u.searchParams.get('list');
    const vid = u.searchParams.get('v');
    const isPlaylistPath = u.pathname.includes('/playlist');

    if (isPlaylistPath || (list && !vid)) {
      return {
        url: trimmed,
        scopeArgs: ['--playlist-items', '1'],
        note: 'Playlist link detected — downloading first track only',
      };
    }

    if (vid) {
      const cleanUrl = `https://www.youtube.com/watch?v=${vid}`;
      const note = list ? 'Playlist context ignored — downloading the linked video only' : null;
      return { url: cleanUrl, scopeArgs: ['--no-playlist'], note };
    }
  } catch { /* fall through */ }

  return { url: trimmed, scopeArgs: ['--no-playlist'] };
}

function delay(ms) {
  return new Promise(r => setTimeout(r, ms));
}

function prepareTaskFallbacks() {
  taskCookieBrowsers = detectOpenBrowsers();
}

function spawnYtDlpOnce(args, { jsArgs = [], cookieArgs = [], onProgress } = {}) {
  return new Promise((resolve, reject) => {
    const needsStdout = args.includes('--get-id') || args.includes('--get-title') || args.includes('-J') || args.includes('--dump-json');
    const spawnOpts = { stdio: ['ignore', 'pipe', 'pipe'] };

    lastYtDlpStderr = '';

    currentProc = spawn(
      findYtDlpExecutable(),
      ['--no-mtime', ...PERF_ARGS, ...jsArgs, ...cookieArgs, ...args],
      spawnOpts
    );

    let stdout = '';
    let stderrAcc = '';
    const handleStreamLine = line => {
      const trimmed = line.trim();
      if (!trimmed) return;
      if (parseYtDlpProgress(trimmed)) return;
      logMessage(trimmed);
    };
    const handleProgressData = createProgressStreamHandler(onProgress, handleStreamLine);

    currentProc.stdout.on('data', d => {
      const chunk = d.toString();
      if (needsStdout) stdout += chunk;
      else handleProgressData(chunk);
    });

    currentProc.stderr.on('data', d => {
      const chunk = d.toString();
      stderrAcc += chunk;
      lastYtDlpStderr += chunk;
      handleProgressData(chunk);
    });

    currentProc.on('close', code => {
      currentProc = null;
      if (code === 0) resolve(needsStdout ? stdout : '');
      else {
        const err = new Error(`yt-dlp exited with code ${code}`);
        err.stderr = stderrAcc;
        reject(err);
      }
    });

    currentProc.on('error', reject);
  });
}

async function runYtDlp(args, options = {}) {
  let useJs = options.preferJs ? !!findNodeExecutable() : false;
  let cookieArgs = [];
  let cookieIndex = 0;
  let cookiesExhausted = false;

  while (true) {
    try {
      return await spawnYtDlpOnce(args, {
        jsArgs: useJs ? getJsRuntimeArgs() : [],
        cookieArgs,
        onProgress: options.onProgress,
      });
    } catch (err) {
      const text = failureText(err.stderr, err.message);

      if (!useJs && (isJsChallengeFailure(text) || JS_RUNTIME_WARNING_RE.test(text))) {
        useJs = true;
        const runtimeArgs = getJsRuntimeArgs();
        const runtimeLabel = runtimeArgs[1]?.startsWith('node:')
          ? runtimeArgs[1].slice(5)
          : 'node';
        logMessage(`⚠️ JS challenge detected — retrying with Node.js (${runtimeLabel})…`);
        continue;
      }

      if (!cookieArgs.length && !cookiesExhausted && taskCookieBrowsers.length && isAuthRelatedFailure(text)) {
        const browser = taskCookieBrowsers[cookieIndex];
        cookieArgs = ['--cookies-from-browser', browser];
        logMessage(`⚠️ Authentication required — retrying with ${getBrowserLabel(browser)} cookies…`);
        continue;
      }

      if (cookieArgs.length && isCookieRelatedFailure(text) && cookieIndex < taskCookieBrowsers.length - 1) {
        cookieIndex += 1;
        const browser = taskCookieBrowsers[cookieIndex];
        cookieArgs = ['--cookies-from-browser', browser];
        logMessage(`⚠️ Browser cookies unavailable, trying ${getBrowserLabel(browser)}…`);
        continue;
      }

      if (cookieArgs.length && isCookieRelatedFailure(text)) {
        logMessage('⚠️ Could not use browser cookies, retrying without them…');
        cookieArgs = [];
        cookiesExhausted = true;
        continue;
      }

      throw err;
    }
  }
}

async function downloadSingleVideo(url, { fmt, folder, scopeArgs, sectionArgs, taskId, onProgress }) {
  if (taskId <= cancelledTaskId) return false;

  logMessage(`⬇️ Downloading: ${url}`);
  try {
    await runYtDlpDownload([...scopeArgs, ...sectionArgs, ...fmt], folder, url, {
      onProgress: onProgress ? ({ percent, speed, eta }) => onProgress({ percent, speed, eta }) : undefined,
    });
    logMessage('✅ Finished download');
    return true;
  } catch (err) {
    if (taskId <= cancelledTaskId) return false;
    logMessage(`❌ Failed: ${err.message}`);
    return false;
  }
}

function normalizePlaylistEntries(entries) {
  return (entries || [])
    .filter(entry => entry && entry.id && entry.id !== '[deleted]')
    .map(entry => ({
      id: entry.id,
      title: entry.title || entry.id,
      duration: entry.duration ?? null,
      thumbnails: entry.thumbnails || [],
    }));
}

function getPlaylistTotal(data) {
  return data?.playlist_count ?? data?.n_entries ?? null;
}

function isPlaylistIncomplete(data, entryCount) {
  const total = getPlaylistTotal(data);
  if (total != null && entryCount < total) return true;
  if (total == null && entryCount >= 100 && entryCount % 100 === 0) return true;
  return false;
}

function buildPlaylistFetchArgs(playlistURL, playlistItems) {
  const args = ['--flat-playlist', '--no-lazy-playlist', '-J'];
  if (playlistItems) args.push('--playlist-items', String(playlistItems));
  args.push(playlistURL);
  return args;
}

async function fetchPlaylistJsonRaw(playlistURL, { playlistItems, forceCookies = false } = {}) {
  const strategies = forceCookies || !taskCookieBrowsers.length
    ? [{ forceCookies }]
    : [{ forceCookies: false }, { forceCookies: true }];

  let lastErr = null;

  for (const strategy of strategies) {
    const args = buildPlaylistFetchArgs(playlistURL, playlistItems);
    const cookieArgs = strategy.forceCookies && taskCookieBrowsers.length
      ? ['--cookies-from-browser', taskCookieBrowsers[0]]
      : [];

    for (let attempt = 1; attempt <= 3; attempt++) {
      try {
        const raw = cookieArgs.length
          ? await spawnYtDlpOnce(args, { cookieArgs, jsArgs: [] })
          : await runYtDlp(args);
        return JSON.parse(raw);
      } catch (err) {
        lastErr = err;
        if (attempt === 3) break;
        logMessage(`⚠️ Fetch playlist attempt ${attempt} failed, retrying...`);
        await delay(2000);
      }
    }

    if (!strategy.forceCookies && taskCookieBrowsers.length) {
      logMessage('⚠️ Playlist fetch failed — retrying with browser cookies…');
    }
  }

  throw lastErr || new Error('Failed to fetch playlist');
}

async function fetchPlaylistPages(playlistURL, initialEntries, knownTotal) {
  const seen = new Set(initialEntries.map(entry => entry.id));
  const all = [...initialEntries];
  const pageSize = 100;
  let start = all.length + 1;

  while (true) {
    const end = knownTotal ? Math.min(start + pageSize - 1, knownTotal) : start + pageSize - 1;
    let data;
    try {
      data = await fetchPlaylistJsonRaw(playlistURL, {
        playlistItems: `${start}-${end}`,
        forceCookies: true,
      });
    } catch {
      break;
    }

    const batch = normalizePlaylistEntries(data.entries).filter(entry => !seen.has(entry.id));
    if (!batch.length) break;

    for (const entry of batch) {
      seen.add(entry.id);
      all.push(entry);
    }

    const total = knownTotal ?? getPlaylistTotal(data);
    logMessage(`📋 Loaded ${all.length}${total ? ` / ${total}` : ''} tracks…`);

    if (total && all.length >= total) break;
    if (batch.length < pageSize) break;

    start += pageSize;
  }

  return all;
}

async function fetchAllPlaylistEntries(playlistURL) {
  prepareTaskFallbacks();
  logMessage('📋 Fetching playlist tracks…');

  let data = await fetchPlaylistJsonRaw(playlistURL);
  let entries = normalizePlaylistEntries(data.entries);
  let total = getPlaylistTotal(data);

  if (isPlaylistIncomplete(data, entries.length) && taskCookieBrowsers.length) {
    logMessage(`📋 Got ${entries.length}${total ? ` of ${total}` : ''} — retrying with browser cookies…`);
    try {
      data = await fetchPlaylistJsonRaw(playlistURL, { forceCookies: true });
      entries = normalizePlaylistEntries(data.entries);
      total = getPlaylistTotal(data) ?? total;
    } catch { /* keep best result so far */ }
  }

  if (isPlaylistIncomplete(data, entries.length)) {
    logMessage('📋 Loading remaining tracks…');
    entries = await fetchPlaylistPages(playlistURL, entries, total);
  }

  logMessage(`📋 Found ${entries.length} track(s)`);
  return entries;
}

async function fetchPlaylistMetadata(playlistURL) {
  return fetchAllPlaylistEntries(playlistURL);
}

async function downloadMedia({ songName, playlistURL, selectedVideoIds, format, folder, trimStart, trimEnd }, taskId) {
  if (taskId <= cancelledTaskId) return;

  logMessage(`🚀 Starting download task #${taskId}`);
  prepareTaskFallbacks();

  const fmt = [];
  if (format === 'mp3') fmt.push('-x', '--audio-format', 'mp3', '--audio-quality', '0');
  if (format === 'flac') fmt.push('-x', '--audio-format', 'flac');
  if (format === 'wav') fmt.push('-x', '--audio-format', 'wav');
  logMessage(`🔧 Format args: ${fmt.join(' ')}`);
  logMessage(`📂 Output folder: ${folder}`);

  //
  // SELECTED VIDEOS BRANCH (sequential single-song downloads)
  //
  if (selectedVideoIds && selectedVideoIds.length) {
    const total = selectedVideoIds.length;
    logMessage(`🎯 Downloading ${total} selected track(s)...`);

    for (let i = 0; i < total; i++) {
      if (taskId <= cancelledTaskId) break;
      const videoId = selectedVideoIds[i];
      const url = `https://www.youtube.com/watch?v=${videoId}`;

      await downloadSingleVideo(url, {
        fmt,
        folder,
        scopeArgs: ['--no-playlist'],
        sectionArgs: [],
        taskId,
        onProgress: ({ percent, speed, eta }) => {
          const overall = Math.min(100, Math.round(((i + percent / 100) / total) * 1000) / 10);
          sendProgress({ percent: overall, speed, eta, item: i + 1, total });
        },
      });

      sendProgress(Math.floor(((i + 1) / total) * 100));
    }

    if (taskId > cancelledTaskId) logMessage('🎉 Selected downloads complete!');
    mainWindow.webContents.send('stop-loading');
    return;
  }

  //
  // PLAYLIST BRANCH
  //
  if (playlistURL) {
    let entries = [];
    try {
      entries = await fetchAllPlaylistEntries(playlistURL);
    } catch (err) {
      logMessage(`❌ Failed to fetch playlist: ${err.message}`);
      mainWindow.webContents.send('stop-loading');
      return;
    }
    if (taskId <= cancelledTaskId) return;

    if (!entries.length) {
      logMessage('❌ No videos found in playlist');
      mainWindow.webContents.send('stop-loading');
      return;
    }

    const total = entries.length;
    logMessage(`🎶 Downloading ${total} track(s)...`);

    for (let i = 0; i < total; i++) {
      if (taskId <= cancelledTaskId) break;
      const videoId = entries[i].id;
      const url = `https://www.youtube.com/watch?v=${videoId}`;

      logMessage(`⬇️ Downloading (${i + 1}/${total}): ${entries[i].title}`);
      try {
        await runYtDlpDownload(['--no-playlist', ...fmt], folder, url, {
          onProgress: ({ percent, speed, eta }) => {
            const overall = Math.min(100, Math.round(((i + percent / 100) / total) * 1000) / 10);
            sendProgress({ percent: overall, speed, eta, item: i + 1, total });
          },
        });
        logMessage(`✅ Finished (${i + 1}/${total})`);
      } catch (err) {
        if (taskId <= cancelledTaskId) break;
        logMessage(`❌ Failed (${i + 1}/${total}): ${err.message}`);
      }

      sendProgress(Math.floor(((i + 1) / total) * 100));
    }

    if (taskId > cancelledTaskId) logMessage('🎉 Playlist complete!');
    mainWindow.webContents.send('stop-loading');
    return;
  }

  //
  // SINGLE-SONG BRANCH
  //
  if (!songName.startsWith('http')) {
    logMessage('❌ Please enter a valid YouTube URL');
    mainWindow.webContents.send('stop-loading');
    return;
  }

  const { url: resolvedUrl, scopeArgs, note } = analyzeSingleSongInput(songName);
  if (note) logMessage(`📝 ${note}`);

  const sectionArgs = buildDownloadSections(trimStart, trimEnd);

  logMessage(`⬇️ Downloading: ${resolvedUrl}`);
  try {
    await runYtDlpDownload([...scopeArgs, ...sectionArgs, ...fmt], folder, resolvedUrl, {
      onProgress: ({ percent, speed, eta }) => {
        sendProgress({ percent, speed, eta });
      },
    });
    logMessage('✅ Finished download');
    sendProgress({ percent: 100, speed: null, eta: null });
  } catch (err) {
    logMessage(`❌ Failed: ${err.message}`);
  }

  mainWindow.webContents.send('stop-loading');
}

ipcMain.handle('fetch-playlist-metadata', async (_, playlistURL) => {
  try {
    const entries = await fetchPlaylistMetadata(playlistURL);
    return { ok: true, entries };
  } catch (err) {
    logMessage(`❌ Failed to fetch playlist: ${err.message}`);
    return { ok: false, error: err.message, entries: [] };
  }
});

// IPC & app setup
ipcMain.handle('select-folder', async () => {
  const { canceled, filePaths } = await dialog.showOpenDialog(mainWindow, {
    properties: ['openDirectory','createDirectory']
  });
  if (!canceled) {
    logMessage(`📁 Selected folder: ${filePaths[0]}`);
    return filePaths[0];
  }
  return null;
});

ipcMain.handle('get-default-folder', () => app.getPath('downloads'));

ipcMain.on('cancel-download', (_, { suppressStop = false } = {}) => {
  cancelledTaskId = currentTaskId;
  if (currentProc) {
    currentProc.kill('SIGINT');
    logMessage('🛑 Download cancelled');
  }
  if (!suppressStop) mainWindow.webContents.send('stop-loading');
});

ipcMain.on('show-context-menu', e => {
  const menu = Menu.buildFromTemplate([
    { role: 'cut' }, { role: 'copy' },
    { role: 'paste' }, { type: 'separator' },
    { role: 'selectAll' }
  ]);
  menu.popup({ window: BrowserWindow.fromWebContents(e.sender) });
});

ipcMain.on('download-song', (_, payload) => {
  cancelledTaskId = currentTaskId;
  if (currentProc) currentProc.kill('SIGINT');
  currentTaskId++;
  downloadMedia(payload, currentTaskId).catch(err => {
    logMessage(`❌ Error: ${err.message}`);
    mainWindow.webContents.send('stop-loading');
  });
});

function createWindow() {
  mainWindow = new BrowserWindow({
    width: 420, height: 820, show: false,
    webPreferences: { nodeIntegration: true, contextIsolation: false }
  });
  mainWindow.once('ready-to-show', () => {
    mainWindow.show();
    mainWindow.focus();
  });
  mainWindow.loadFile('index.html');
}

app.whenReady()
  .then(createWindow)
  .catch(console.error);

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit();
});
