const { spawn } = require('child_process');
const path = require('path');

const electron = require('electron');

const child = spawn(electron, [path.resolve(__dirname)], {
  cwd: __dirname,
  detached: true,
  stdio: 'ignore',
  env: process.env,
});

child.unref();
