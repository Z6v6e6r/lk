// Bounded lexical inventory only. No I/O, Nginx semantic validation or live verdict.
// Returned token values are PRIVATE inputs to an allowlisted projector: never log
// or export this result wholesale. Errors contain only fixed codes and line numbers.
// This retains the diagnostic scanner's limited grammar; it is not nginx -t.
const MAX_BYTES = 131072;
const MAX_TOKENS = 50000;
const whitespace = character => /\s/.test(character);

function fail(code, line = null) {
  const error = new Error(`NGINX_LEXICAL_${code}`);
  error.code = `NGINX_LEXICAL_${code}`;
  error.line = line;
  throw error;
}

function tokenize(text, structure) {
  if (typeof text !== "string" || Buffer.byteLength(text, "utf8") > MAX_BYTES || text.includes("\0")) fail("INPUT_REJECTED");
  const tokens = [];
  let index = 0, line = 1;
  const push = token => { if (tokens.length >= MAX_TOKENS) fail("TOKEN_LIMIT", token.line); tokens.push(token); };
  while (index < text.length) {
    const character = text[index];
    if (whitespace(character)) { if (character === "\n") line++; index++; continue; }
    // '#' starts a comment only at a token boundary. Inside an unquoted word
    // (including a regex character class), it is literal. See Nginx 1.24.0
    // src/core/ngx_conf_file.c: ngx_conf_read_token(), last_space branch.
    if (character === "#") { while (index < text.length && text[index] !== "\n") index++; continue; }
    if ("{};".includes(character)) { push({ value: character, line, punctuation: true }); index++; continue; }
    let value = "", quoted = false;
    const origin = line, start = index;
    while (index < text.length && !whitespace(text[index]) && !"{};".includes(text[index])) {
      if (text[index] === "\\") {
        index++; if (index >= text.length) fail("DANGLING_ESCAPE", line);
        if (text[index] === "\n") line++;
        value += text[index++]; continue;
      }
      if (text[index] === '"' || text[index] === "'") {
        quoted = true; const quote = text[index++]; let closed = false;
        while (index < text.length) {
          const next = text[index++];
          if (next === quote) { closed = true; break; }
          if (next === "\\") {
            if (index >= text.length) fail("DANGLING_ESCAPE", line);
            if (text[index] === "\n") line++;
            value += text[index++];
          } else { if (next === "\n") line++; value += next; }
        }
        if (!closed) fail("UNTERMINATED_QUOTE", origin);
        continue;
      }
      if (text[index] === "$" && text[index + 1] === "{") {
        const end = text.indexOf("}", index + 2);
        if (end < 0 || !/^[A-Za-z0-9_]+$/.test(text.slice(index + 2, end))) fail("UNSUPPORTED_VARIABLE", line);
        value += text.slice(index, end + 1); index = end + 1; continue;
      }
      value += text[index++];
    }
    if (!value && !quoted) fail("EMPTY_TOKEN", origin);
    // Structural consumers also inspect the exact private token spelling. The
    // legacy inventory value intentionally retains its original limited grammar.
    push({ value, line: origin, quoted, ...(structure ? { raw: text.slice(start, index) } : {}) });
  }
  return tokens;
}

function scan(text, structure) {
  const statements = [];
  const context = [];
  const contextIds = [];
  let nextBlockId = 0;
  let current = [], depth = 0;
  const row = (block, blockId) => ({
    // Keep the statement-token interface byte-for-byte compatible; raw spelling
    // is separate private structural metadata, not an extra inventory field.
    words: current.map(({ value, line, quoted }) => ({ value, line, quoted })),
    rawWords: current.map(word => word.raw),
    block, context: [...context], contextIds: [...contextIds], blockId,
  });
  for (const token of tokenize(text, structure)) {
    if (!token.punctuation) { current.push(token); continue; }
    if (token.value === ";") {
      if (current.length) statements.push(structure ? row(false, null) : current);
      current = [];
    }
    else if (token.value === "{") {
      if (!current.length) fail("UNNAMED_BLOCK", token.line);
      const blockId = ++nextBlockId;
      if (structure) statements.push(row(true, blockId));
      context.push(current[0].value);
      contextIds.push(blockId);
      current = []; if (++depth > 256) fail("DEPTH_LIMIT", token.line);
    } else {
      if (current.length) fail("UNTERMINATED_DIRECTIVE_BEFORE_CLOSE", token.line);
      if (--depth < 0) fail("UNBALANCED_CLOSE", token.line);
      context.pop();
      contextIds.pop();
    }
  }
  if (current.length) fail("UNTERMINATED_DIRECTIVE_AT_EOF", current[0].line);
  if (depth !== 0) fail("UNBALANCED_BLOCKS_AT_EOF");
  return statements;
}

export function scanNginxInventoryStatements(text) { return scan(text, false); }

// Same bounded dialect, additionally retaining block headers and lexical context.
// Private intermediate tokens, never a semantic Nginx AST or exportable receipt.
export function scanNginxInventoryStructure(text) { return scan(text, true); }
