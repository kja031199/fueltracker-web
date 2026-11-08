import { describe, expect, test } from 'vitest';
import { importsIn, resolved } from './imports';

/** The import reader the boundary tests share (#93), on every form it must see. */
describe('importsIn', () => {
  test.each([
    ["import { a } from '../data/store';", '../data/store'],
    ['import { a } from "../data/store";', '../data/store'],
    ["import type { A } from '../data/store';", '../data/store'],
    ["import * as all from '../data/store';", '../data/store'],
    ["export { a } from '../data/store';", '../data/store'],
    ["export * from \"../data/store\";", '../data/store'],
    ["import '../data/store';", '../data/store'],
    ['import "../data/store";', '../data/store'],
    ["const m = await import('../data/store');", '../data/store'],
    ['void import("../data/store").then(() => {});', '../data/store'],
    ['void import(`../data/store`);', '../data/store'],
    ["import {\n  a,\n  b,\n} from '../data/store';", '../data/store'],
    ["import x, { y } from 'firebase/firestore';", 'firebase/firestore'],
  ])('%s', (source, expected) => {
    expect(importsIn(source)).toContain(expected);
  });

  test('prose and commented-out code are not imports', () => {
    expect(importsIn("// import { a } from '../data/store';")).toEqual([]);
    expect(importsIn("/* import '../data/store'; */")).toEqual([]);
    expect(importsIn("const note = 'see https://example.com';")).toEqual([]);
  });

  test('a relative specifier resolves against the importing file', () => {
    expect(resolved('src/ui/App.tsx', '../data/store')).toBe('src/data/store');
    expect(resolved('src/ui/charts/Line.tsx', '../../domain/units')).toBe('src/domain/units');
    expect(resolved('src/ui/App.tsx', 'react')).toBe('react');
  });
});
