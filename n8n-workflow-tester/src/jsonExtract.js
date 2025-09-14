/**
 * Extract the last well-formed JSON object from a mixed text blob.
 * Handles nested braces and quotes/escapes. This is used to extract
 * the workflow nodes execution results which are outputted in order
 * in a JSON format.
 */
function extractLastJsonObject(text) {
  let lastStart = -1;
  let depth = 0;
  let inStr = false;
  let esc = false;
  const starts = [];
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];

    if (inStr) {
      if (esc) {
        esc = false;
      } else if (ch === '\\') {
        esc = true;
      } else if (ch === '"') {
        inStr = false;
      }
      continue;
    }
    if (ch === '"') {
      inStr = true;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) {
        lastStart = i;
        starts.push(i);
      }
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && lastStart !== -1) {
        const candidate = text.slice(lastStart, i + 1);
        try {
          const obj = JSON.parse(candidate);
          if (obj && (obj.data || obj.error || obj.mode || obj.status)) {
            return obj;
          }
        } catch (_) {
          // ignore; keep scanning
        }
      }
    }
  }
  // Fallback: try greedy between first '{' and last '}'.
  const first = text.indexOf('{');
  const last = text.lastIndexOf('}');
  if (first !== -1 && last !== -1 && last > first) {
    try { return JSON.parse(text.slice(first, last + 1)); } catch (_) {}
  }
  return null;
}

module.exports = { extractLastJsonObject };
