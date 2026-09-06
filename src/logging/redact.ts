/**
 * Strips credentials out of anything on its way into the log.
 *
 * Two mechanisms, in order of reliability. Values we already know are secret —
 * taken from the environment — are matched literally, which cannot produce a
 * false negative. Everything else is pattern matching, which is a backstop for
 * credentials that arrive in a provider's own output.
 *
 * Provider auth files are never read into a log at all; there is no redaction
 * rule for them because nothing may put them here in the first place.
 */

/** Anything that survives a round trip through JSON. */
export type JsonValue =
  string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };

const REDACTED = "[redacted]";

/**
 * Long enough that a log line stays useful, short enough that model output
 * cannot end up on disk by accident.
 */
const MAX_STRING_LENGTH = 2_000;

/** Below this a "secret" is a flag or a version, and masking it blanks logs. */
const MIN_SECRET_LENGTH = 8;

const SECRET_VARIABLE_PATTERN = /token|secret|key|password|credential/i;

// Bearer is handled first so the token after it is masked even when the token
// itself matches nothing else.
const PATTERNS: readonly RegExp[] = [
  /\bBearer\s+[\w.~+/=-]{16,}/gi,
  // Anthropic: api03 keys and the long-lived tokens `claude setup-token` mints.
  /\bsk-ant-[\w-]{20,}/g,
  // OpenAI, including the sk-proj- form Codex uses.
  /\bsk-[A-Za-z0-9_-]{20,}/g,
  // GitHub classic, and the fine-grained personal access token.
  /\bgh[pousr]_[A-Za-z0-9]{20,}/g,
  /\bgithub_pat_[A-Za-z0-9_]{20,}/g,
  // A JSON web token, which is what an OAuth flow hands back.
  /\beyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}/g,
];

function maskPatterns(text: string): string {
  return PATTERNS.reduce(
    (masked, pattern) =>
      masked.replace(pattern, (match) =>
        match.toLowerCase().startsWith("bearer")
          ? `Bearer ${REDACTED}`
          : REDACTED,
      ),
    text,
  );
}

function maskKnown(text: string, secrets: readonly string[]): string {
  // Short strings are the danger: a secret of "1" matches between every
  // character and blanks the whole log, and a tenant id of "team" would redact
  // the word wherever it appeared. The length bar lives here rather than only
  // in `secretsFromEnv`, because configuration is now a source of secrets too
  // and it was never subject to it.
  return secrets
    .filter((secret) => secret.trim().length >= MIN_SECRET_LENGTH)
    .reduce(
      // split/join rather than a regex: an environment value can contain any
      // character, and building a pattern out of it would either break or match
      // more than itself.
      (masked, secret) => masked.split(secret).join(REDACTED),
      text,
    );
}

function redactString(text: string, secrets: readonly string[]): string {
  const masked = maskPatterns(maskKnown(text, secrets));

  return masked.length <= MAX_STRING_LENGTH
    ? masked
    : `${masked.slice(0, MAX_STRING_LENGTH)}… (truncated)`;
}

/** Redacts every string in a value, including the keys of an object. */
export function redactValue(
  value: JsonValue,
  secrets: readonly string[],
): JsonValue {
  if (typeof value === "string") return redactString(value, secrets);

  if (Array.isArray(value)) {
    return value.map((item) => redactValue(item, secrets));
  }

  if (typeof value === "object" && value !== null) {
    return Object.fromEntries(
      Object.entries(value).map(([key, item]) => [
        redactString(key, secrets),
        redactValue(item, secrets),
      ]),
    );
  }

  return value;
}

/**
 * Collects the environment values worth treating as secret.
 *
 * Named rather than sniffed: a variable that calls itself a token, secret, key,
 * password or credential is taken at its word.
 */
export function secretsFromEnv(
  env: Readonly<Record<string, string | undefined>>,
): string[] {
  return Object.entries(env).flatMap(([name, value]) =>
    SECRET_VARIABLE_PATTERN.test(name) &&
    value !== undefined &&
    value.length >= MIN_SECRET_LENGTH
      ? [value]
      : [],
  );
}
