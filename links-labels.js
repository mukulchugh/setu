// The short free-text labels a shared project publishes (an owner, a task) carry no path, environment
// reference or secret. Secrets are found by the existing Spans redaction; paths and environment references
// by the shapes below, which the engine checks again with the same shapes before it keeps anything. The
// check reads only the label itself: nothing is derived from a transcript, the environment or the
// filesystem.

import { redactSpansValue } from './spans-redaction.js';

export const MAX_LABEL_CHARS = 120;
const PATH_MARKER = '[path]';
const ENV_MARKER = '[env]';
// Text already replaced by a marker has nothing left to hide, so markers are ignored when judging a word.
const MARKERS = [PATH_MARKER, ENV_MARKER, '[REDACTED]'];
const CONTROL_CHARACTER = /\p{Cc}/gu;
const WHITESPACE_RUN = /\s+/u;
const LEADING_WRAPPERS = /^[([{<"'`,;!?]+/;
const TRAILING_WRAPPERS = /[)\]}>"'`,;!?]+$/;
const TRAILING_SENTENCE = /[.:]+$/;
const DRIVE_PATH = /^[A-Za-z]:[\\/]/;
const FILE_EXTENSION = /^[^.].*\.[A-Za-z0-9]{1,8}$|^\.[^.]+\.[A-Za-z0-9]{1,8}$/;
const DOLLAR_REFERENCE = /\$[A-Za-z_{(]/;
const PERCENT_VARIABLE = /%[A-Za-z0-9_]+%/;
const ASSIGNMENT = /^[A-Za-z_][A-Za-z0-9_]*=./;
const WORD_CHARACTER = /[\p{L}\p{N}]/u;

function withoutMarkers(word) {
  return MARKERS.reduce((text, marker) => text.replaceAll(marker, ''), word);
}

function isPathLike(core) {
  const separators = core.split('/').length - 1;
  const last = core.slice(core.lastIndexOf('/') + 1);
  return (
    core.startsWith('/') ||
    core.startsWith('~') ||
    core.startsWith('./') ||
    core.startsWith('../') ||
    DRIVE_PATH.test(core) ||
    core.includes('\\') ||
    separators >= 2 ||
    (separators === 1 && FILE_EXTENSION.test(last))
  );
}

function isEnvLike(core) {
  return (
    DOLLAR_REFERENCE.test(core) ||
    PERCENT_VARIABLE.test(core) ||
    ASSIGNMENT.test(core)
  );
}

// The part of a word that is judged: wrapping punctuation and a closing sentence mark are not part of a path.
function parts(word) {
  const lead = word.match(LEADING_WRAPPERS)?.[0] ?? '';
  const afterLead = word.slice(lead.length);
  const trail = afterLead.match(TRAILING_WRAPPERS)?.[0] ?? '';
  const middle = afterLead.slice(0, afterLead.length - trail.length);
  const sentence = middle.match(TRAILING_SENTENCE)?.[0] ?? '';
  return {
    core: middle.slice(0, middle.length - sentence.length),
    lead,
    trail: sentence + trail,
  };
}

function classify(word) {
  const { core } = parts(withoutMarkers(word));
  if (isEnvLike(core)) {
    return ENV_MARKER;
  }
  return isPathLike(core) ? PATH_MARKER : null;
}

const words = (text) =>
  text.replace(CONTROL_CHARACTER, ' ').split(WHITESPACE_RUN).filter(Boolean);

/** Whether a label is free of secrets, paths and environment references as it stands. */
export function isSafeLabel(label) {
  return (
    typeof label === 'string' &&
    redactSpansValue(label) === label &&
    words(label).every((word) => classify(word) === null)
  );
}

/**
 * The label as it may be published: one line, secrets and path or environment references replaced by
 * markers, cut to MAX_LABEL_CHARS with an ellipsis. Null when nothing meaningful is left.
 */
export function screenLabel(label) {
  if (typeof label !== 'string') {
    return null;
  }
  const screened = words(redactSpansValue(label))
    .map((word) => {
      const marker = classify(word);
      if (!marker) {
        return word;
      }
      const { lead, trail } = parts(word);
      return `${lead}${marker}${trail}`;
    })
    .join(' ');
  if (!WORD_CHARACTER.test(withoutMarkers(screened))) {
    return null;
  }
  const characters = [...screened];
  return characters.length > MAX_LABEL_CHARS
    ? `${characters
        .slice(0, MAX_LABEL_CHARS - 1)
        .join('')
        .trimEnd()}…`
    : screened;
}
