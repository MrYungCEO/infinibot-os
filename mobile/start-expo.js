const { spawn } = require('child_process');
const path = require('path');

// 8081 is held by `tailscale serve` on the tailnet IP, which makes Metro's
// wildcard bind fail — and non-interactive starts then skip the dev server.
const expo = spawn('npx', ['expo', 'start', '--lan', '--port', '8082'], {
  cwd: path.resolve(__dirname),
  stdio: 'inherit',
  shell: true,
});

expo.on('error', (err) => {
  console.error('Failed to start Expo:', err);
  process.exit(1);
});

expo.on('close', (code) => {
  console.log('Expo exited with code:', code);
  process.exit(code);
});
