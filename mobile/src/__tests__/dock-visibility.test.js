/**
 * FloatingDock hides itself when the focused tab's options carry
 * tabBarStyle.display === 'none' (immersive screens, e.g. the Knowledge Graph
 * in landscape). A global default of 'none' in MainTabs' screenOptions would
 * therefore hide the dock on EVERY tab — this locks that out.
 */
const fs = require('fs');
const path = require('path');

test('MainTabs screenOptions do not hide the tab bar globally', () => {
  const src = fs.readFileSync(path.join(__dirname, '../../App.js'), 'utf8');
  const start = src.indexOf('function MainTabs(');
  const block = src.slice(start, src.indexOf('<Tab.Screen', start));
  expect(start).toBeGreaterThan(-1);
  expect(block).toMatch(/screenOptions=\{\{/);
  expect(block).not.toMatch(/tabBarStyle\s*:\s*\{\s*display\s*:\s*['"]none['"]/);
});

test('FloatingDock still honours a per-screen immersive tabBarStyle', () => {
  const src = fs.readFileSync(path.join(__dirname, '../components/FloatingDock.js'), 'utf8');
  expect(src).toMatch(/tabBarStyle\?\.display === 'none'\) return null/);
});
