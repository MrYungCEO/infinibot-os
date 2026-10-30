const { spawn } = require('child_process');

process.chdir(__dirname);

const child = spawn('npx', ['expo', 'start', '--tunnel', '--port', '8082'], {
  stdio: 'inherit',
  shell: true,
  cwd: __dirname
});

child.on('error', (err) => console.error('Failed to start:', err));
child.on('close', (code) => process.exit(code));
