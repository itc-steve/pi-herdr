// Vendored/adapted from @spences10/pi-redact (Scott Spence, MIT)
// https://github.com/spences10/my-pi/tree/main/packages/pi-redact
// Patterns from https://github.com/spences10/nopeek

import { resolve } from "node:path";

interface SecretPattern {
  name: string;
  pattern: RegExp;
}

interface RedactionResult {
  redacted: string;
  count: number;
}

export type RedactionOptions = {
  forceSshConfig?: boolean;
  forcePrivateKey?: boolean;
};

const PRIVATE_KEY_BEGIN_PATTERN =
  /-----BEGIN[ \t]+[\w -]*PRIVATE[ \t]+KEY-----/;
const PRIVATE_KEY_END_PATTERN = /-----END[ \t]+[\w -]*PRIVATE[ \t]+KEY-----/;

const SECRET_PATTERNS: SecretPattern[] = [
  { name: "AWS Access Key", pattern: /AKIA[A-Z0-9]{16}/g },
  { name: "AWS Temp Access Key", pattern: /ASIA[A-Z0-9]{16}/g },
  {
    name: "AWS Secret Key",
    pattern:
      /\b(?:AWS_SECRET_ACCESS_KEY|aws_secret_access_key|secret_access_key|SecretAccessKey)\b\s*[:=]\s*["']?[A-Za-z0-9/+=]{40,}["']?/g,
  },
  {
    name: "Bearer Token",
    pattern: /Bearer\s+[a-zA-Z0-9._-]{20,}/g,
  },
  {
    name: "OpenAI/Anthropic API Key",
    pattern: /sk-[a-zA-Z0-9._-]{20,}/g,
  },
  {
    name: "Stripe Live Key",
    pattern: /sk_live_[a-zA-Z0-9]{20,}/g,
  },
  {
    name: "Stripe Test Key",
    pattern: /sk_test_[a-zA-Z0-9]{20,}/g,
  },
  {
    name: "Hetzner Token",
    pattern:
      /(?:HCLOUD_TOKEN|hcloud_token|token)\s*[:=]\s*["']?[a-f0-9]{64}\b/g,
  },
  {
    name: "Private Key",
    pattern:
      /-----BEGIN[ \t]+[\w -]*PRIVATE[ \t]+KEY-----[\s\S]*?(?:-----END[ \t]+[\w -]*PRIVATE[ \t]+KEY-----|$)/g,
  },
  {
    name: "Connection String with Password",
    pattern: /\b[a-z][a-z0-9+.-]*:\/\/[^:\s/?#]+:[^@\s/?#]+@/gi,
  },
  {
    name: "Generic Secret Phrase",
    pattern:
      /\b(?:password|passwd|secret|token|api[_-]?key)\b\s+(?:is|was|seen|value|header)\s+["']?[A-Za-z0-9._:/+=@!-]{12,}["']?/gi,
  },
  {
    name: "Tavily API Key",
    pattern: /tvly-[a-zA-Z0-9_-]{20,}/g,
  },
  {
    name: "Kagi API Key",
    pattern: /[a-zA-Z0-9_-]{40,}\.[a-zA-Z0-9_-]{40,}/g,
  },
  {
    name: "Brave API Key",
    pattern: /BSA[A-Z0-9]{20,}/g,
  },
  {
    name: "Firecrawl API Key",
    pattern: /fc-[a-f0-9]{32}/g,
  },
  {
    name: "GitHub Token",
    pattern: /gh[pousr]_[a-zA-Z0-9]{36,}/g,
  },
  {
    name: "GitHub Fine-grained PAT",
    pattern: /github_pat_[a-zA-Z0-9_]{20,}/g,
  },
  {
    name: "JWT",
    pattern: /eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/g,
  },
  {
    name: "Slack Token",
    pattern: /xox[baprs]-[A-Za-z0-9-]{20,}/g,
  },
  {
    name: "GitLab Token",
    pattern: /glpat-[A-Za-z0-9_-]{20,}/g,
  },
  {
    name: "Google API Key",
    pattern: /AIza[A-Za-z0-9_-]{35}/g,
  },
  {
    name: "npm Token",
    pattern: /npm_[A-Za-z0-9]{36,}/g,
  },
  {
    name: "SendGrid API Key",
    pattern: /SG\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{32,}/g,
  },
];

const SECRET_FIELD_NAME =
  "(?:[A-Z0-9_]*(?:PASSWORD|PASSWD|SECRET|TOKEN|API_?KEY)|password|passwd|secret|token|api[_-]?key|access[_-]?token|client[_-]?secret|private[_-]?key)";
const JSON_SECRET_FIELD_NAME =
  "[A-Za-z0-9_-]*(?:password|passwd|secret|token|api[_-]?key|access[_-]?key|private[_-]?key)";
const PREFIXED_CONFIG_SECRET_FIELD_NAME =
  "[A-Za-z0-9]+(?:[_-][A-Za-z0-9]+)*[_-](?:password|passwd|secret|token|api[_-]?key)";
const DOUBLE_QUOTED_JSON_SECRET_FIELD_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_])((?:"${JSON_SECRET_FIELD_NAME}")[ \\t]*:[ \\t]*")((?:\\\\.|[^"\\\\]){8,})"`,
  "gim",
);
const SINGLE_QUOTED_JSON_SECRET_FIELD_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_])((?:'${JSON_SECRET_FIELD_NAME}')[ \\t]*:[ \\t]*')((?:\\\\.|[^'\\\\]){8,})'`,
  "gim",
);
const DOUBLE_QUOTED_SECRET_FIELD_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_])((?:"?${SECRET_FIELD_NAME}"?)[ \\t]*[:=][ \\t]*")((?:\\\\.|[^"\\\\]){8,})"`,
  "gm",
);
const SINGLE_QUOTED_SECRET_FIELD_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_])((?:'?${SECRET_FIELD_NAME}'?)[ \\t]*[:=][ \\t]*')((?:\\\\.|[^'\\\\]){8,})'`,
  "gm",
);
const DOUBLE_QUOTED_PREFIXED_CONFIG_SECRET_FIELD_PATTERN = new RegExp(
  `^([ \\t]*)((?:${PREFIXED_CONFIG_SECRET_FIELD_NAME})[ \\t]*=[ \\t]*")((?:\\\\.|[^"\\\\]){8,})"(?=[ \\t]*(?:#.*)?$)`,
  "gim",
);
const SINGLE_QUOTED_PREFIXED_CONFIG_SECRET_FIELD_PATTERN = new RegExp(
  `^([ \\t]*)((?:${PREFIXED_CONFIG_SECRET_FIELD_NAME})[ \\t]*=[ \\t]*')((?:\\\\.|[^'\\\\]){8,})'(?=[ \\t]*(?:#.*)?$)`,
  "gim",
);
const UNQUOTED_SECRET_FIELD_PATTERN = new RegExp(
  `(^|[^A-Za-z0-9_])((?:${SECRET_FIELD_NAME})[ \\t]*[:=][ \\t]*)([^\\s"',;}\\]]{8,})`,
  "gm",
);

const SSH_CONFIG_VALUE_DIRECTIVE_PATTERN =
  /^([ \t]*)(HostName|User|IdentityFile|CertificateFile|ProxyJump|ProxyCommand|LocalForward|RemoteForward|DynamicForward|HostKeyAlias)(\s+)(.+)$/gim;
const SSH_CONFIG_HOST_PATTERN = /^([ \t]*)(Host)(\s+)(.+)$/gim;
const SSH_CONFIG_MATCH_PATTERN = /^([ \t]*)(Match)(\s+)(.+)$/gim;

const PRIVATE_MARKER = "[PRIVATE:";

export function looksLikeSshConfig(text: string): boolean {
  const hasScopeLine = /^\s*(?:Host|Match)\b/m.test(text);
  const hasSensitiveDirective =
    /^\s*(?:HostName|User|IdentityFile|CertificateFile|ProxyJump|ProxyCommand|LocalForward|RemoteForward|DynamicForward|HostKeyAlias)\b/im.test(
      text,
    );

  return hasScopeLine && hasSensitiveDirective;
}

export function redactSshConfigMetadata(
  text: string,
): RedactionResult {
  let count = 0;

  const redactDirectiveValue = (
    match: string,
    indent: string,
    directive: string,
    spacing: string,
    value: string,
  ): string => {
    if (
      value.includes(PRIVATE_MARKER) ||
      value.includes("[REDACTED:")
    ) {
      return match;
    }
    count++;
    return `${indent}${directive}${spacing}${PRIVATE_MARKER}SSH ${directive}]`;
  };

  let result = text.replace(
    SSH_CONFIG_VALUE_DIRECTIVE_PATTERN,
    redactDirectiveValue,
  );

  result = result.replace(
    SSH_CONFIG_HOST_PATTERN,
    (match: string, indent: string, directive: string, spacing: string, value: string) => {
      const trimmed = value.trim();
      if (trimmed === "*" || value.includes(PRIVATE_MARKER) || value.includes("[REDACTED:")) {
        return match;
      }
      count++;
      return `${indent}${directive}${spacing}${PRIVATE_MARKER}SSH Host]`;
    },
  );

  result = result.replace(
    SSH_CONFIG_MATCH_PATTERN,
    (match: string, indent: string, directive: string, spacing: string, value: string) => {
      if (value.trim().toLowerCase() === "all") return match;
      if (value.includes(PRIVATE_MARKER) || value.includes("[REDACTED:")) {
        return match;
      }
      count++;
      return `${indent}${directive}${spacing}${PRIVATE_MARKER}SSH Match]`;
    },
  );

  return { redacted: result, count };
}

function redactSecretFields(text: string): RedactionResult {
  let count = 0;
  let result = text;
  const marker = `${PRIVATE_MARKER}Generic Password Field]`;

  const redactQuoted = (pattern: RegExp, quote: '"' | "'"): void => {
    pattern.lastIndex = 0;
    result = result.replace(
      pattern,
      (match, boundary: string, assignment: string, value: string) => {
        if (value.includes(PRIVATE_MARKER) || value.includes("[REDACTED:")) {
          return match;
        }
        count += 1;
        return `${boundary}${assignment}${marker}${quote}`;
      },
    );
  };

  redactQuoted(DOUBLE_QUOTED_JSON_SECRET_FIELD_PATTERN, '"');
  redactQuoted(SINGLE_QUOTED_JSON_SECRET_FIELD_PATTERN, "'");
  redactQuoted(DOUBLE_QUOTED_SECRET_FIELD_PATTERN, '"');
  redactQuoted(SINGLE_QUOTED_SECRET_FIELD_PATTERN, "'");
  redactQuoted(DOUBLE_QUOTED_PREFIXED_CONFIG_SECRET_FIELD_PATTERN, '"');
  redactQuoted(SINGLE_QUOTED_PREFIXED_CONFIG_SECRET_FIELD_PATTERN, "'");
  UNQUOTED_SECRET_FIELD_PATTERN.lastIndex = 0;
  result = result.replace(
    UNQUOTED_SECRET_FIELD_PATTERN,
    (match, boundary: string, assignment: string, value: string) => {
      if (value.includes(PRIVATE_MARKER) || value.includes("[REDACTED:")) {
        return match;
      }
      count += 1;
      return `${boundary}${assignment}${marker}`;
    },
  );

  return { redacted: result, count };
}

function redactSecretPatterns(text: string): RedactionResult {
  let count = 0;
  let result = text;

  for (const sp of SECRET_PATTERNS) {
    sp.pattern.lastIndex = 0;
    result = result.replace(sp.pattern, (match) => {
      if (match.includes(PRIVATE_MARKER) || match.includes("[REDACTED:")) {
        return match;
      }
      count++;
      return `${PRIVATE_MARKER}${sp.name}]`;
    });
  }

  return { redacted: result, count };
}

export function isSshConfigPath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  return /(?:^|\/)(?:\.ssh\/(?:config|config\.d\/.+|conf\.d\/.+)|ssh_config)$/.test(
    normalized,
  );
}

export function isPrivateKeyPath(path: unknown): boolean {
  if (typeof path !== "string") return false;
  const normalized = path.replaceAll("\\", "/").toLowerCase();
  if (normalized.endsWith(".pub")) return false;
  return (
    /\.(?:key|pem)$/.test(normalized) ||
    /(?:^|\/)(?:id_(?:rsa|dsa|ecdsa|ed25519)(?:_[^/]*)?|ssh_host_[^/]+_key)$/.test(
      normalized,
    )
  );
}

/** Path-keyed BEGIN-without-END tracker for chunked reads. */
export function createPrivateKeyContinuationTracker(): {
  forcePrivateKey(path: string | undefined): boolean;
  noteChunk(path: string | undefined, text: string): void;
} {
  const armedPaths = new Set<string>();

  const normalize = (path: string | undefined): string | undefined =>
    path ? resolve(path) : undefined;

  return {
    forcePrivateKey(path: string | undefined): boolean {
      const normalized = normalize(path);
      if (!normalized) return false;
      return armedPaths.has(normalized);
    },
    noteChunk(path: string | undefined, text: string): void {
      const normalized = normalize(path);
      if (!normalized) return;

      const hasBegin = PRIVATE_KEY_BEGIN_PATTERN.test(text);
      const hasEnd = PRIVATE_KEY_END_PATTERN.test(text);
      let continuation = armedPaths.has(normalized);

      // Clear END before re-arm BEGIN so a self-contained chunk neither
      // arms nor stays armed.
      if (continuation && hasEnd) continuation = false;
      if (hasBegin) continuation = !hasEnd;

      if (continuation) armedPaths.add(normalized);
      else armedPaths.delete(normalized);
    },
  };
}

export function redactForCloud(
  text: string,
  options?: RedactionOptions,
): RedactionResult {
  if (options?.forcePrivateKey && text) {
    return {
      redacted: `${PRIVATE_MARKER}Private Key continuation]`,
      count: 1,
    };
  }

  let count = 0;
  let result = text;

  if (options?.forceSshConfig || looksLikeSshConfig(result)) {
    const sshRedaction = redactSshConfigMetadata(result);
    result = sshRedaction.redacted;
    count += sshRedaction.count;
  }

  const fieldRedaction = redactSecretFields(result);
  result = fieldRedaction.redacted;
  count += fieldRedaction.count;

  const secretRedaction = redactSecretPatterns(result);
  result = secretRedaction.redacted;
  count += secretRedaction.count;

  return { redacted: result, count };
}

export function hasPrivateMarker(text: string): boolean {
  return text.includes(PRIVATE_MARKER);
}

function redactStringField(record: Record<string, unknown>, key: string): boolean {
  const value = record[key];
  if (typeof value !== "string") return false;
  const redacted = redactForCloud(value).redacted;
  if (redacted === value) return false;
  record[key] = redacted;
  return true;
}

function redactObjectStrings(value: unknown): boolean {
  if (!value || typeof value !== "object") return false;
  let changed = false;
  const record = value as Record<string, unknown>;
  const signedThinking = record.type === "thinking" &&
    typeof record.signature === "string" && record.signature.length > 0;
  for (const [key, child] of Object.entries(record)) {
    // Changing signed reasoning text invalidates provider signatures. Local
    // reasoning is unsigned and becomes ordinary text on cross-model replay.
    if (key === "signature" || key === "encrypted_content" || (signedThinking && key === "thinking")) {
      continue;
    }
    if (typeof child === "string") {
      changed = redactStringField(record, key) || changed;
    } else {
      changed = redactObjectStrings(child) || changed;
    }
  }
  return changed;
}

/** Final provider-payload safety net, including compaction requests. Mutates payload. */
export function redactProviderPayload(payload: unknown): boolean {
  return redactObjectStrings(payload);
}

/** Redact every message field serialized into provider context. Mutates Pi's copy. */
export function redactContextMessages(messages: unknown[]): boolean {
  let changed = false;
  for (const value of messages) {
    if (!value || typeof value !== "object") continue;
    const message = value as Record<string, unknown>;
    const role = message.role;
    if (role === "bashExecution") {
      changed = redactStringField(message, "command") || changed;
      changed = redactStringField(message, "output") || changed;
    }
    if (role === "branchSummary" || role === "compactionSummary") {
      changed = redactStringField(message, "summary") || changed;
    }
    changed = redactStringField(message, "errorMessage") || changed;

    if (typeof message.content === "string") {
      changed = redactStringField(message, "content") || changed;
    } else if (Array.isArray(message.content)) {
      for (const block of message.content) {
        if (!block || typeof block !== "object") continue;
        const content = block as Record<string, unknown>;
        if (content.type === "text") {
          changed = redactStringField(content, "text") || changed;
        } else if (content.type === "thinking" && !content.thinkingSignature) {
          changed = redactStringField(content, "thinking") || changed;
        } else if (content.type === "toolCall") {
          changed = redactObjectStrings(content.arguments) || changed;
        }
      }
    }
  }
  return changed;
}
