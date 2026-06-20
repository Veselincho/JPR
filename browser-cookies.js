const { execFileSync } = require('child_process');

const isWin = process.platform === 'win32';
const isMac = process.platform === 'darwin';

// yt-dlp --cookies-from-browser: Chrome, Safari (macOS only), Mozilla Firefox
const BROWSER_PRIORITY = [
  'chrome',
  ...(isMac ? ['safari'] : []),
  'firefox',
];

const BROWSER_LABELS = {
  chrome: 'Chrome',
  safari: 'Safari',
  firefox: 'Mozilla Firefox',
};

// Match running browser processes without hardcoded install paths.
const BROWSER_PATTERNS = {
  chrome: [
    /chrome\.exe/i,
    /google chrome/i,
    /google-chrome/i,
    /Google Chrome\.app/i,
  ],
  firefox: [
    /firefox\.exe/i,
    /\/firefox(?:\.exe)?$/im,
    /^firefox$/im,
    /Firefox\.app/i,
    /Mozilla Firefox/i,
  ],
  safari: [/safari\.app[/\\]contents[/\\]macos[/\\]safari/i, /^safari$/im],
};

function listProcessText() {
  try {
    if (isWin) {
      return execFileSync('tasklist /FO CSV /NH', {
        encoding: 'utf8',
        shell: true,
        windowsHide: true,
      });
    }
    return execFileSync('ps -ax -o comm=', {
      encoding: 'utf8',
      shell: true,
    });
  } catch {
    return '';
  }
}

function isBrowserRunning(browserId, processText) {
  const patterns = BROWSER_PATTERNS[browserId] || [];
  return patterns.some(rx => rx.test(processText));
}

function detectOpenBrowsers() {
  const processText = listProcessText();
  if (!processText) return [];

  return BROWSER_PRIORITY.filter(id => isBrowserRunning(id, processText));
}

function pickBrowserForCookies() {
  return detectOpenBrowsers()[0] || null;
}

function getBrowserLabel(browserId) {
  return BROWSER_LABELS[browserId] || browserId;
}

module.exports = {
  detectOpenBrowsers,
  pickBrowserForCookies,
  getBrowserLabel,
};
