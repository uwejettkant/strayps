// Command lines as strayps shows them: secrets redacted first, then shortened. They come from
// every process on the machine and end up in screenshots and logs.
//
// Secret redaction. Every pattern below either starts at a fixed literal or at the start of a word
// and has a bounded name, so its cost grows with the length of the command line, not its square:
// unbounded, one argument of 50,000 letters held each scan for 2.7 s (external audit, 21.11.2026),
// and a command line can be 1 MB on macOS.
const SECRET_WORD = /token|secret|passw(?:or)?d|pwd|api[-_]?key|access[-_]?key|private[-_]?key|auth|credential|bearer/i;
const KEY_SUFFIX = /(?:^|[-_])key$/i;
/** Longer names are not taken for secret names; the bound keeps the patterns linear. */
const MAX_SECRET_NAME = 64;
/** How many words a quoted value may span (`sh -c 'x --token "a b"'` shows the quotes). */
const MAX_QUOTED_WORDS = 16;
// --token VALUE, --api-key=VALUE, -key VALUE; --no-auth is a switch without a value
const SECRET_FLAG = /^(--(?!no-)|-(?!-))([A-Za-z0-9_.-]{1,64})(?:=([\s\S]*))?$/i;
// API_KEY=VALUE as a word of its own
const SECRET_VAR = /^([A-Za-z0-9_.-]{1,64})=([\s\S]*)$/;
// a header name and its colon where a word or a list item starts: "x-api-key:", "{Authorization :",
// "Accept:json,Authorization:Basic ..."
const HEADER_NAME = /(?<=^|[\s"'=,;{(\[:])([A-Za-z0-9_-]{1,64})[ \t]*:/g;
// what follows the colon and stays: spaces and a scheme
const HEADER_PREFIX = /[ \t]*(?:(?:bearer|token|basic)[ \t]+)?/iy;
// the value: quoted, or plain up to a space, a quote or the end of a list item
const HEADER_VALUE = /"[^"]*"|'[^']*'|["']?[^\s"',;)}\]]+/y;
// JSON: {"x-api-key":"VALUE"}
const SECRET_JSON = /"([A-Za-z0-9_.-]{1,64})"(\s*:\s*)"((?:[^"\\]|\\.)*)"/g;
// query parameters: ?api_key=VALUE&token=VALUE
const SECRET_QUERY = /([?&])([A-Za-z0-9_.-]{1,64})=([^\s&#"']+)/g;
// whatever stands between "://" and "@": user:password (which may hold ? and #), or a token alone.
// It starts at "://", not at the scheme, which may be long or follow a letter (-ihttps://...)
const URL_USERINFO = /:\/\/(?:[^\s/@:]*:[^\s/@]*|[^\s/?#@:]+)@/g;
const BEARER = /\b(Bearer)\s+[A-Za-z0-9._~+/=-]{8,}/g;
// well-known token formats anywhere: GitHub, OpenAI/Anthropic/Stripe (sk-), Slack, Google, AWS, npm, GitLab
const TOKEN_FORMATS =
  /\b(?:(?:ghp|gho|ghs|ghu|ghr|github_pat|sk|xox[abprs])[-_][A-Za-z0-9_-]{10,}|AIza[0-9A-Za-z_-]{30,}|(?:AKIA|ASIA)[0-9A-Z]{16}\b|npm_[A-Za-z0-9]{30,}|glpat-[0-9A-Za-z_-]{20,})/g;


function isSecretName(name: string): boolean {
  return name.length <= MAX_SECRET_NAME && (SECRET_WORD.test(name) || KEY_SUFFIX.test(name));
}

/**
 * Replaces secrets in a command line with [redacted]: values of flags, variables, headers, query
 * parameters and JSON keys named like a token, key, secret or password, credentials in URLs, and
 * well-known token formats. Command lines come from every process on the machine and are shown in
 * the terminal, the dashboard and /api/status, where they end up in screenshots and logs.
 * Recognition always uses the original command line.
 *
 * `ps` joins the arguments with spaces and drops the quotes the shell removed: a value with spaces
 * that was one argument cannot be told from several, and only its first word is redacted. Where the
 * quotes are part of the argument (a command for `sh -c`), the value is redacted up to its closing
 * quote.
 */
export function redactSecrets(cmd: string): string {
  return redactHeaders(redactArguments(cmd))
    .replace(SECRET_JSON, (match, name: string, colon: string) =>
      isSecretName(name) ? `"${name}"${colon}"[redacted]"` : match,
    )
    .replace(SECRET_QUERY, (match, sep: string, name: string) => (isSecretName(name) ? `${sep}${name}=[redacted]` : match))
    .replace(URL_USERINFO, '://[redacted]@')
    .replace(BEARER, '$1 [redacted]')
    .replace(TOKEN_FORMATS, '[redacted]');
}

/**
 * Header values. A header with a harmless name gives up only its name: in "Accept:json,Authorization:
 * Basic ..." the value of Accept must not swallow the header after it (safety review, 21.11.2026).
 */
function redactHeaders(text: string): string {
  let out = '';
  let copied = 0;
  HEADER_NAME.lastIndex = 0;
  for (let name = HEADER_NAME.exec(text); name; name = HEADER_NAME.exec(text)) {
    if (!isSecretName(name[1])) continue;
    HEADER_PREFIX.lastIndex = HEADER_NAME.lastIndex;
    HEADER_PREFIX.exec(text);
    const start = HEADER_PREFIX.lastIndex;
    // "x-api-key: a b" in quotes that are part of the argument (sh -c): up to the closing quote
    const opened = text[name.index - 1];
    let end = opened === '"' || opened === "'" ? text.indexOf(opened, start) : -1;
    let replacement = '[redacted]';
    if (end === -1) {
      HEADER_VALUE.lastIndex = start;
      const value = HEADER_VALUE.exec(text);
      if (!value) continue;
      end = HEADER_VALUE.lastIndex;
      const quote = value[0][0] === '"' || value[0][0] === "'" ? value[0][0] : '';
      const closed = quote !== '' && value[0].length > 1 && value[0].endsWith(quote);
      replacement = `${quote}[redacted]${closed ? quote : ''}`;
    } else if (end === start) {
      continue;
    }
    out += `${text.slice(copied, start)}${replacement}`;
    copied = end;
    // on after the value: a name inside it was redacted with it
    HEADER_NAME.lastIndex = end;
  }
  return out + text.slice(copied);
}

/** Flags and variables, word by word: only where a word starts, never inside a path. */
function redactArguments(cmd: string): string {
  // even indexes: the words; odd indexes: the whitespace between them
  const parts = cmd.split(/(\s+)/);
  for (let i = 0; i < parts.length; i += 2) {
    const flag = SECRET_FLAG.exec(parts[i]);
    if (flag && isSecretName(flag[2])) {
      if (flag[3] !== undefined) {
        if (flag[3] === '') continue;
        parts[i] = `${flag[1]}${flag[2]}=[redacted]`;
        i = redactQuotedRest(parts, i, flag[3]);
      } else if (i + 2 < parts.length && parts[i + 2] !== '' && !parts[i + 2].startsWith('-')) {
        // the next word is the value, unless it is another flag
        i += 2;
        const value = parts[i];
        parts[i] = '[redacted]';
        i = redactQuotedRest(parts, i, value);
      }
      continue;
    }
    const variable = SECRET_VAR.exec(parts[i]);
    if (variable && variable[2] !== '' && isSecretName(variable[1])) {
      parts[i] = `${variable[1]}=[redacted]`;
      i = redactQuotedRest(parts, i, variable[2]);
    }
  }
  return parts.join('');
}

/**
 * A value that opens a quote and does not close it in the same word goes on up to the word with
 * the closing quote: those words go too. Returns the index of the last word redacted.
 */
function redactQuotedRest(parts: string[], i: number, value: string): number {
  const quote = value[0];
  if (quote !== '"' && quote !== "'") return i;
  if (value.length > 1 && value.indexOf(quote, 1) !== -1) return i;
  for (let j = i + 2; j < parts.length && j <= i + 2 * MAX_QUOTED_WORDS; j += 2) {
    if (parts[j].includes(quote)) {
      for (let k = i + 1; k <= j; k++) parts[k] = '';
      return j;
    }
  }
  return i;
}

/**
 * Redacted first, shortened after: cut first, a URL lost its "@" and a token its length, and the
 * visible part of a secret was shown (external audit, 21.11.2026).
 */
export function formatReadableCmd(rawName: string, rawCmd: string): string {
  return readableCmd(rawName, redactSecrets(rawCmd));
}

function readableCmd(rawName: string, rawCmd: string): string {
  const cmd = rawCmd.trim();

  if (
    cmd.includes('claude-code') ||
    cmd.includes('/native-binary/claude') ||
    cmd.includes('/claude.app/Contents/MacOS/claude')
  ) {
    const modelMatch = cmd.match(/--model[=\s]+([^\s]+)/);
    const modelSuffix = modelMatch ? ` (${modelMatch[1]})` : '';
    return `claude-code${modelSuffix}`;
  }

  if (rawName === 'claude' || cmd === 'claude' || cmd.startsWith('claude ')) {
    return cmd.length > 80 ? `${cmd.slice(0, 77)}...` : cmd;
  }

  const binMatch = cmd.match(/\.bin\/([^\s]+)/);
  if (binMatch) {
    return `node .bin/${binMatch[1]}`;
  }

  return cmd.length > 100 ? `${cmd.slice(0, 97)}...` : cmd;
}
