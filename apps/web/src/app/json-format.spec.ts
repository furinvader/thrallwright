import { describe, expect, it } from 'vitest';
import { formatJsonDocument } from './json-format';

describe('formatJsonDocument', () => {
  it('preserves exact numeric and escaped string tokens in nested JSON', () => {
    expect(
      formatJsonDocument(
        '{"big":900719925474099312345,"huge":1e400,"text":"quote: \\"a,b\\"","nested":[true,null,{},[]]}',
      ),
    ).toBe(
      '{\n  "big": 900719925474099312345,\n  "huge": 1e400,\n  "text": "quote: \\"a,b\\"",\n  "nested": [\n    true,\n    null,\n    {},\n    []\n  ]\n}',
    );
  });

  it('keeps scalar and null documents intact', () => {
    expect(formatJsonDocument(' 1e400\n')).toBe('1e400');
    expect(formatJsonDocument(' null ')).toBe('null');
  });

  it('uses the exact source for nesting or indentation beyond display limits', () => {
    const deep = '['.repeat(81) + '900719925474099312345' + ']'.repeat(81);
    expect(formatJsonDocument(`  ${deep}\n`)).toBe(deep);

    const broad = '['.repeat(80) + '0,'.repeat(60_000) + '0' + ']'.repeat(80);
    expect(formatJsonDocument(broad)).toBe(broad);
  });
});
