/**
 * The committed native KG bundles must match ui/src: rebuilding them
 * (node ui/scripts/build-kg-native.mjs --check) must change nothing.
 */
import { execFileSync } from 'child_process';
import path from 'path';

describe('knowledge graph native bundles', () => {
  test('mobile/src/kg/generated is up to date with ui/src', () => {
    const script = path.resolve(__dirname, '../../../ui/scripts/build-kg-native.mjs');
    let out = '';
    let code = 0;
    try {
      out = execFileSync(process.execPath, [script, '--check'], { encoding: 'utf8', stdio: 'pipe' });
    } catch (e) {
      code = e.status ?? 1;
      out = `${e.stdout || ''}${e.stderr || ''}`;
    }
    expect({ code, out }).toEqual({ code: 0, out: '' });
  });

  test('the core bundle has no DOM / three.js dependency', () => {
    const fs = require('fs');
    const src = fs.readFileSync(path.resolve(__dirname, '../kg/generated/kg-core.js'), 'utf8');
    expect(src).not.toMatch(/from "three/);
    expect(src).not.toMatch(/\bdocument\./);
  });
});
