// -----------------------------------------------------------------------------
// A small XML reader for the answers of the controller (pure, no dependency):
// elements, attributes, text, comments, the declaration, CDATA. One linear
// pass, bounded in elements and depth; no DOCTYPE, no external entity, no
// entity but the five of XML and numeric ones. Attributes and children are
// kept in null-prototype objects and arrays: a name such as `__proto__` is
// just a name. Anything malformed throws (the answer is then not used).
// -----------------------------------------------------------------------------

import { LIMITS } from '../constants.js';

const ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" };
const NAME = /^[A-Za-z_][A-Za-z0-9_.:-]{0,127}$/;

/** Decodes the entities of a text or attribute value. */
function decode(text) {
  if (!text.includes('&')) return text;
  return text.replace(/&(#x[0-9a-fA-F]{1,6}|#\d{1,7}|[a-z]{2,4});/g, (all, ref) => {
    if (ref[0] === '#') {
      const code = ref[1] === 'x' ? parseInt(ref.slice(2), 16) : parseInt(ref.slice(1), 10);
      if (!Number.isInteger(code) || code > 0x10ffff || (code >= 0xd800 && code <= 0xdfff)) {
        throw new Error('bad character reference');
      }
      return String.fromCodePoint(code);
    }
    if (!Object.hasOwn(ENTITIES, ref)) throw new Error('unknown entity');
    return ENTITIES[ref];
  });
}

function element(name) {
  return { name, attrs: Object.create(null), children: [], text: '' };
}

/** Parses the attributes of a start tag (the text after its name). */
function parseAttributes(source, node) {
  const re = /\s*([A-Za-z_][A-Za-z0-9_.:-]*)\s*=\s*(?:"([^"<]*)"|'([^'<]*)')/y;
  let at = 0;
  while (at < source.length) {
    if (/^\s*$/.test(source.slice(at))) return;
    re.lastIndex = at;
    const match = re.exec(source);
    if (!match) throw new Error('bad attribute');
    if (Object.hasOwn(node.attrs, match[1])) throw new Error('duplicate attribute');
    node.attrs[match[1]] = decode(match[2] ?? match[3]);
    at = re.lastIndex;
  }
}

/**
 * The root element of `text`: `{ name, attrs, children, text }` (text: the
 * direct text content, trimmed). Throws on anything malformed.
 */
export function parseXml(text) {
  if (typeof text !== 'string') throw new Error('not a text');
  const stack = [];
  let root;
  let nodes = 0;
  let at = 0;
  const n = text.length;
  while (at < n) {
    const lt = text.indexOf('<', at);
    const chunk = lt === -1 ? text.slice(at) : text.slice(at, lt);
    if (chunk.trim() !== '') {
      if (stack.length === 0) throw new Error('text outside the root');
      const top = stack.at(-1);
      // Bounded: the text of one element never grows past 64 KiB.
      if (top.text.length + chunk.length > 65_536) throw new Error('text too long');
      top.text += decode(chunk);
    }
    if (lt === -1) break;
    if (text.startsWith('<?', lt)) {
      const end = text.indexOf('?>', lt + 2);
      if (end === -1) throw new Error('unclosed declaration');
      at = end + 2;
      continue;
    }
    if (text.startsWith('<!--', lt)) {
      const end = text.indexOf('-->', lt + 4);
      if (end === -1) throw new Error('unclosed comment');
      at = end + 3;
      continue;
    }
    if (text.startsWith('<![CDATA[', lt)) {
      const end = text.indexOf(']]>', lt + 9);
      if (end === -1 || stack.length === 0) throw new Error('bad CDATA');
      stack.at(-1).text += text.slice(lt + 9, end);
      at = end + 3;
      continue;
    }
    if (text.startsWith('<!', lt)) throw new Error('DOCTYPE refused');
    const gt = text.indexOf('>', lt + 1);
    if (gt === -1) throw new Error('unclosed tag');
    const inner = text.slice(lt + 1, gt);
    at = gt + 1;
    if (inner.startsWith('/')) {
      const name = inner.slice(1).trim();
      const open = stack.pop();
      if (!open || open.name !== name) throw new Error('mismatched end tag');
      open.text = open.text.trim();
      continue;
    }
    const selfClosing = inner.endsWith('/');
    const body = selfClosing ? inner.slice(0, -1) : inner;
    const space = body.search(/\s/);
    const name = space === -1 ? body : body.slice(0, space);
    if (!NAME.test(name)) throw new Error('bad element name');
    nodes += 1;
    if (nodes > LIMITS.maxXmlNodes) throw new Error('too many elements');
    const node = element(name);
    if (space !== -1) parseAttributes(body.slice(space), node);
    if (stack.length === 0) {
      if (root) throw new Error('two roots');
      root = node;
    } else {
      stack.at(-1).children.push(node);
    }
    if (!selfClosing) {
      if (stack.length >= LIMITS.maxXmlDepth) throw new Error('too deep');
      stack.push(node);
    }
  }
  if (stack.length > 0 || !root) throw new Error('unclosed element');
  return root;
}

/** The children of `node` named `name`. */
export const childrenNamed = (node, name) => (node?.children ?? []).filter((c) => c.name === name);

/** The first child of `node` named `name`. */
export const childNamed = (node, name) => (node?.children ?? []).find((c) => c.name === name);

/** The text of the first child named `name`, else undefined. */
export const childText = (node, name) => childNamed(node, name)?.text;

/** An attribute, own only. */
export const attrOf = (node, name) =>
  node && Object.hasOwn(node.attrs, name) ? node.attrs[name] : undefined;
