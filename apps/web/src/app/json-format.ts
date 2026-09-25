/** Formats validated JSON without parsing numbers through JavaScript doubles. */
export function formatJsonDocument(document: string): string {
  const source = document.trim();
  const maxDepth = 80;
  const maxLength = 8 * 1024 * 1024;
  let result = '';
  let depth = 0;
  let quoted = false;
  let escaped = false;
  const indent = () => '  '.repeat(depth);

  for (let index = 0; index < document.length; index++) {
    const char = document[index]!;
    if (quoted) {
      result += char;
      if (result.length > maxLength) return source;
      if (escaped) escaped = false;
      else if (char === '\\') escaped = true;
      else if (char === '"') quoted = false;
      continue;
    }
    if (char === '"') {
      quoted = true;
      result += char;
    } else if (char === '{' || char === '[') {
      const close = char === '{' ? '}' : ']';
      let next = index + 1;
      while (next < document.length && /\s/.test(document[next]!)) next++;
      if (document[next] === close) {
        result += char + close;
        index = next;
      } else {
        if (depth >= maxDepth) return source;
        result += `${char}\n${'  '.repeat(++depth)}`;
      }
    } else if (char === '}' || char === ']') {
      result += `\n${'  '.repeat(--depth)}${char}`;
    } else if (char === ',') {
      result += `,\n${indent()}`;
    } else if (char === ':') {
      result += ': ';
    } else if (!/\s/.test(char)) {
      result += char;
    }
    if (result.length > maxLength) return source;
  }
  return result;
}
