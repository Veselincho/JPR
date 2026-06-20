const { spawn } = require('child_process');
const path = require('path');

const electronPath = require('electron');
const appDir = __dirname;
const isWin = process.platform === 'win32';

const env = {
  ...process.env,
  ELECTRON_NO_ATTACH_CONSOLE: '1',
};

console.log('Starting joinpukra — the app window should open separately (not in this terminal).');

const child = spawn(electronPath, [appDir], {
  cwd: appDir,
  stdio: 'inherit',
  windowsHide: true,
  env,
});

child.on('close', code => {
  process.exit(code ?? 0);
});

child.on('error', err => {
  console.error(err);
  process.exit(1);
});
