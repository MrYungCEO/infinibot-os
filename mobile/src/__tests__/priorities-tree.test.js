import { toVisual, normalize } from '../components/priorities-tree';

const mk = (id, parentId, ordinal) => ({ id, parentId, ordinal, title: id });

describe('priorities-tree', () => {
  test('toVisual produces depth-first order with correct depths', () => {
    const items = [
      mk('a', null, 1),
      mk('b', null, 0),
      mk('c', 'a', 0),
      mk('d', 'c', 0),
    ];
    const v = toVisual(items);
    expect(v.map((x) => x.id)).toEqual(['b', 'a', 'c', 'd']);
    expect(v.find((x) => x.id === 'b').depth).toBe(0);
    expect(v.find((x) => x.id === 'a').depth).toBe(0);
    expect(v.find((x) => x.id === 'c').depth).toBe(1);
    expect(v.find((x) => x.id === 'd').depth).toBe(2);
  });

  test('normalize densifies sibling ordinals to 0..n per parent', () => {
    const items = [
      mk('a', null, 5),
      mk('b', null, 2),
      mk('c', 'a', 9),
      mk('d', 'a', 3),
    ];
    const order = normalize(items);
    const byId = Object.fromEntries(order.map((o) => [o.id, o]));
    // top-level: b(2) before a(5) -> b=0, a=1
    expect(byId.b.ordinal).toBe(0);
    expect(byId.a.ordinal).toBe(1);
    expect(byId.b.parentId).toBe(null);
    // children of a: d(3) before c(9) -> d=0, c=1
    expect(byId.d.ordinal).toBe(0);
    expect(byId.c.ordinal).toBe(1);
    expect(byId.c.parentId).toBe('a');
  });

  test('indent then normalize nests item under previous sibling', () => {
    // start: a(0), b(1) at top level; indent b under a
    let items = [mk('a', null, 0), mk('b', null, 1)];
    // simulate indent: b.parentId = a, ordinal after a's children (none) -> 0
    items = items.map((i) => (i.id === 'b' ? { ...i, parentId: 'a', ordinal: 0 } : i));
    const order = normalize(items);
    const byId = Object.fromEntries(order.map((o) => [o.id, o]));
    expect(byId.b.parentId).toBe('a');
    const v = toVisual(items);
    expect(v.find((x) => x.id === 'b').depth).toBe(1);
  });

  test('outdent uses fractional ordinal that normalize resolves after parent', () => {
    // a(0) with child b(0); grandparent none. outdent b -> parentId null, ordinal a.ordinal + 0.5 = 0.5
    let items = [mk('a', null, 0), mk('b', 'a', 0), mk('z', null, 1)];
    items = items.map((i) => (i.id === 'b' ? { ...i, parentId: null, ordinal: 0.5 } : i));
    const order = normalize(items);
    const byId = Object.fromEntries(order.map((o) => [o.id, o]));
    // top-level order should be a(0) -> b(0.5) -> z(1) => a=0, b=1, z=2
    expect(byId.a.ordinal).toBe(0);
    expect(byId.b.ordinal).toBe(1);
    expect(byId.z.ordinal).toBe(2);
    expect(byId.b.parentId).toBe(null);
  });
});
