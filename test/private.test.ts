import { describe, it } from "node:test";
import assert from "node:assert/strict";
import {
  redactForCloud,
  hasPrivateMarker,
  looksLikeSshConfig,
  redactSshConfigMetadata,
  isSshConfigPath,
  isPrivateKeyPath,
  redactContextMessages,
  redactProviderPayload,
  createPrivateKeyContinuationTracker,
} from "../src/private.ts";

type Fixture = {
  name: string;
  input: string;
  /** Raw values that must never remain in the redacted output. */
  leaked: string[];
  marker?: string;
  count?: number;
};

const SECRET_FIXTURES: Fixture[] = [
  {
    name: "AWS access key",
    input: "key: AKIA1234567890ABCDEF",
    leaked: ["AKIA1234567890ABCDEF"],
    marker: "[PRIVATE:AWS Access Key]",
    count: 1,
  },
  {
    name: "AWS temp access key",
    input: "key: ASIA1234567890ABCDEF",
    leaked: ["ASIA1234567890ABCDEF"],
    marker: "[PRIVATE:AWS Temp Access Key]",
    count: 1,
  },
  {
    name: "AWS secret key env var",
    input: "AWS_SECRET_ACCESS_KEY=wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY01",
    leaked: ["wJalrXUtnFEMI/K7MDENG+bPxRfiCYEXAMPLEKEY01"],
    marker: "[PRIVATE:AWS Secret Key]",
    count: 1,
  },
  {
    name: "Bearer token",
    input: "Authorization: Bearer abcdefghijklmnopqrstuvwxyz123456",
    leaked: ["Bearer abcdefghijklmnopqrstuvwxyz123456"],
    marker: "[PRIVATE:Bearer Token]",
    count: 1,
  },
  {
    name: "full private key block",
    input: `-----BEGIN PRIVATE KEY-----\nQ0FOQVJZX1BSSVZBVEVfS0VZX0JMT0NLX0xJTkVfMDAx\nQ0FOQVJZX1BSSVZBVEVfS0VZX0JMT0NLX0xJTkVfMDAy\n-----END PRIVATE KEY-----`,
    leaked: ["Q0FOQVJZX1BSSVZBVEVfS0VZX0JMT0NLX0xJTkVfMDAx"],
    marker: "[PRIVATE:Private Key]",
    count: 1,
  },
  {
    name: "private key chunk with missing END marker",
    input:
      "-----BEGIN PRIVATE KEY-----\nQ0FOQVJZX1BSSVZBVEVfS0VZX0ZJUlNUX0NIVU5L",
    leaked: ["Q0FOQVJZX1BSSVZBVEVfS0VZX0ZJUlNUX0NIVU5L"],
    marker: "[PRIVATE:Private Key]",
    count: 1,
  },
  {
    name: "connection string with password",
    input: "postgres://user:super-secret-password@localhost:5432/app",
    leaked: [":super-secret-password@"],
    marker: "[PRIVATE:Connection String with Password]",
    count: 1,
  },
  {
    name: "generic secret field",
    input: "SERVICE_PASSWORD=CanaryPassword-Redaction-001!",
    leaked: ["CanaryPassword-Redaction-001!"],
    marker: "[PRIVATE:Generic Password Field]",
    count: 1,
  },
  {
    name: "uppercase token-like env field",
    input: 'SERVICE_TOKEN = "CanaryPassword-Redaction-001!"',
    leaked: ["CanaryPassword-Redaction-001!"],
    marker: "[PRIVATE:Generic Password Field]",
    count: 1,
  },
  {
    name: "env secret containing shell punctuation",
    input: `PASSWORD=${["p@", "$$", "w0rd!", "xyz#%&*?~^"].join("")}`,
    leaked: ["xyz#%&*?~^", "w0rd!"],
    count: 1,
  },
  {
    name: "GitHub fine-grained PAT",
    input: `github_pat_${"A".repeat(30)}`,
    leaked: [`github_pat_${"A".repeat(30)}`],
    marker: "[PRIVATE:GitHub Fine-grained PAT]",
    count: 1,
  },
  {
    name: "JWT",
    input: [
      "eyJ",
      "hbGciOiJIUzI1NiJ9",
      ".",
      "eyJzdWIiOiIxMjM0NTY3ODkwIn0",
      ".",
      "signaturevalue123456",
    ].join(""),
    leaked: [],
    marker: "[PRIVATE:JWT]",
    count: 1,
  },
  {
    name: "Slack token",
    input: `xoxb-${"A".repeat(32)}`,
    leaked: [],
    marker: "[PRIVATE:Slack Token]",
    count: 1,
  },
  {
    name: "GitLab token",
    input: `glpat-${"B".repeat(24)}`,
    leaked: [],
    marker: "[PRIVATE:GitLab Token]",
    count: 1,
  },
  {
    name: "Google API key",
    input: `AIza${"C".repeat(35)}`,
    leaked: [],
    marker: "[PRIVATE:Google API Key]",
    count: 1,
  },
  {
    name: "npm token",
    input: `npm_${"D".repeat(36)}`,
    leaked: [],
    marker: "[PRIVATE:npm Token]",
    count: 1,
  },
  {
    name: "SendGrid API key",
    input: `SG.${"E".repeat(24)}.${"F".repeat(43)}`,
    leaked: [],
    marker: "[PRIVATE:SendGrid API Key]",
    count: 1,
  },
  {
    name: "generic secret phrase with explicit value",
    input: "password is CanaryPassword-Redaction-001!",
    leaked: ["CanaryPassword-Redaction-001!"],
    marker: "[PRIVATE:Generic Secret Phrase]",
    count: 1,
  },
];

describe("redactForCloud", () => {
  for (const fixture of SECRET_FIXTURES) {
    it(`redacts ${fixture.name}`, () => {
      const { redacted, count } = redactForCloud(fixture.input);
      if (fixture.count !== undefined) {
        assert.equal(count, fixture.count, `expected count ${fixture.count}`);
      } else {
        assert.ok(count >= 1, "expected at least one redaction");
      }
      for (const leaked of fixture.leaked) {
        assert.ok(
          !redacted.includes(leaked),
          `leaked raw value: ${leaked}`,
        );
      }
      if (fixture.marker) {
        assert.ok(redacted.includes(fixture.marker));
      }
      assert.ok(hasPrivateMarker(redacted));
      assertMarkerShape(redacted);
      // Idempotent: second pass changes nothing and counts nothing.
      const second = redactForCloud(redacted);
      assert.equal(second.redacted, redacted);
      assert.equal(second.count, 0);
    });
  }

  it("redacts quoted JSON secret fields without leaking their values", () => {
    const values = {
      password: ["super", "secret", "12345"].join(""),
      access_token: ["opaque", "-token-", "value!"].join(""),
      client_secret: ["client", "$#%&*?", "secret"].join(""),
      refresh_token: ["refresh", "-opaque-", "credential"].join(""),
      aws_secret_access_key: ["A1b2", "/+=", "C3d4"].join("").repeat(5),
    };
    const input = JSON.stringify(values);
    const { redacted, count } = redactForCloud(input);

    assert.equal(count, 5);
    for (const value of Object.values(values)) {
      assert.ok(!redacted.includes(value), `leaked value: ${value}`);
    }
    assert.ok(redacted.includes("[PRIVATE:Generic Password Field]"));
    assertMarkerShape(redacted);
    const second = redactForCloud(redacted);
    assert.equal(second.redacted, redacted);
    assert.equal(second.count, 0);
  });

  it("redacts lowercase prefixed secret fields in TOML assignments", () => {
    const values = {
      auth: ["fake", "-auth-token-", "value"].join(""),
      cursor: ["fake", "-cursor-secret-", "value"].join(""),
      service: ["fake", "-service-password-", "value"].join(""),
      uppercase: ["fake", "-uppercase-token-", "value"].join(""),
    };
    const input = `auth_token = "${values.auth}"
cursor_secret = "${values.cursor}"
service_password = '${values.service}' # primary
AUTH_TOKEN = "${values.uppercase}"`;
    const { redacted, count } = redactForCloud(input);

    assert.equal(count, 4);
    for (const value of Object.values(values)) {
      assert.ok(!redacted.includes(value), `leaked value: ${value}`);
    }
    assert.ok(
      redacted.includes(
        `service_password = '[PRIVATE:Generic Password Field]' # primary`,
      ),
    );
    const second = redactForCloud(redacted);
    assert.equal(second.redacted, redacted);
    assert.equal(second.count, 0);
  });

  it("redacts SSH config metadata from a config block", () => {
    const input = `Host prod-app\n  HostName 10.0.0.12\n  User deploy\n  IdentityFile ~/.ssh/work-prod\n  ProxyJump bastion.internal\n  LocalForward 5432 db.internal:5432\n  RemoteForward 8443 localhost:443\n  DynamicForward 1080\n  ProxyCommand ssh -W %h:%p bastion.internal\n  CertificateFile ~/.ssh/work-prod-cert.pub\n  HostKeyAlias prod-app.internal\n  Match host *.internal user deploy\n`;
    const { redacted, count } = redactForCloud(input);
    assert.equal(count, 12);
    for (const directive of [
      "Host",
      "HostName",
      "User",
      "IdentityFile",
      "ProxyJump",
      "LocalForward",
      "RemoteForward",
      "DynamicForward",
      "ProxyCommand",
      "CertificateFile",
      "HostKeyAlias",
      "Match",
    ]) {
      assert.ok(
        redacted.includes(`[PRIVATE:SSH ${directive}]`),
        `missing marker for ${directive}`,
      );
    }
    for (const leaked of [
      "10.0.0.12",
      "deploy",
      "~/.ssh/work-prod",
      "bastion.internal",
    ]) {
      assert.ok(!redacted.includes(leaked), `leaked: ${leaked}`);
    }
    const second = redactForCloud(redacted);
    assert.equal(second.redacted, redacted);
    assert.equal(second.count, 0);
  });

  it("keeps Host * and Match all unchanged", () => {
    const input = `Host *\n  ServerAliveInterval 30\nMatch all\n  ForwardAgent no\n`;
    const { redacted, count } = redactForCloud(input, {
      forceSshConfig: true,
    });
    assert.equal(count, 0);
    assert.equal(redacted, input);
  });

  it("does not treat ordinary prose as SSH config", () => {
    const input = "User deploy should run HostName setup in docs first.";
    const { redacted, count } = redactForCloud(input);
    assert.equal(count, 0);
    assert.equal(redacted, input);
  });

  it("can force SSH redaction for config fragments", () => {
    const input = "HostName 10.42.0.7";
    const { redacted, count } = redactForCloud(input, {
      forceSshConfig: true,
    });
    assert.equal(count, 1);
    assert.equal(redacted, "HostName [PRIVATE:SSH HostName]");
  });

  it("replaces the whole text on a forced private-key continuation", () => {
    const input = "Q0FOQVJZX0NPTlRJTlVhdGlvbl9DT05URU5U";
    const { redacted, count } = redactForCloud(input, {
      forcePrivateKey: true,
    });
    assert.equal(count, 1);
    assert.equal(redacted, "[PRIVATE:Private Key continuation]");
    assert.ok(!redacted.includes(input));
    assert.ok(hasPrivateMarker(redacted));
  });

  it("leaves clean text unchanged", () => {
    const input = "This is normal output with no secrets.";
    const { redacted, count } = redactForCloud(input);
    assert.equal(count, 0);
    assert.equal(redacted, input);
  });

  it("does not redact ordinary package metadata and documentation links", () => {
    const input = JSON.stringify(
      {
        name: "my-pi",
        homepage: "https://github.com/spences10/my-pi",
        repository: {
          type: "git",
          url: "git+https://github.com/spences10/my-pi.git",
        },
        author: "Scott Spence <scott@example.com>",
        keywords: ["cli", "sqlite", "telemetry"],
        badge: "https://img.shields.io/npm/v/@spences10/pi-redact",
      },
      null,
      2,
    );
    const markdown = `${input}\n[repo](https://github.com/spences10/my-pi)\n[npm](https://www.npmjs.com/package/@spences10/pi-redact)`;
    const { redacted, count } = redactForCloud(markdown);
    assert.equal(count, 0);
    assert.equal(redacted, markdown);
  });

  it("does not redact ordinary source variables that contain token", () => {
    const input =
      "const first_token = command.trim().split(/\\s+/)[0] ?? 'hook';";
    const { redacted, count } = redactForCloud(input);
    assert.equal(count, 0);
    assert.equal(redacted, input);
  });

  it("does not broaden prefixed config matching into source declarations", () => {
    const input = `const service_password = "configuration-placeholder-value";
let cursor_secret = "another-placeholder-value";`;
    const { redacted, count } = redactForCloud(input);
    assert.equal(count, 0);
    assert.equal(redacted, input);
  });

  it("does not let generic secret phrases span prose or markdown boundaries", () => {
    const input = `The redactor detects secrets defensively.

- tokens, passwords, and API keys are examples.
- Prefer nopeek for secret-safe loading.

See https://github.com/spences10/nopeek for details.`;
    const { redacted, count } = redactForCloud(input);
    assert.equal(count, 0);
    assert.equal(redacted, input);
  });

  it("does not blanket-redact unlabelled encoded output", () => {
    const input = Buffer.from(
      "ordinary build artifact content without credentials",
    ).toString("base64");
    const { redacted, count } = redactForCloud(input);
    assert.equal(count, 0);
    assert.equal(redacted, input);
  });

  it("leaves existing [REDACTED:…] markers alone (idempotent skip)", () => {
    const inputs = [
      "AWS_SECRET_ACCESS_KEY=[REDACTED:AWS Secret Key]",
      'Host [REDACTED:SSH Host]',
      'password = "[REDACTED:Generic Password Field]"',
    ];
    for (const input of inputs) {
      const { redacted, count } = redactForCloud(input);
      assert.equal(count, 0, `expected no redaction for: ${input}`);
      assert.equal(redacted, input);
    }
  });
});

/**
 * Markers are exactly `[PRIVATE:<category>]`: no original four-character
 * prefix, no stars, no value fragment.
 */
function assertMarkerShape(redacted: string): void {
  const markers = redacted.match(/\[PRIVATE:[^\]]*\]/g) ?? [];
  assert.ok(markers.length >= 1, "expected at least one [PRIVATE:] marker");
  for (const marker of markers) {
    assert.match(marker, /^\[PRIVATE:[A-Za-z0-9 ._-]+\]$/);
  }
  assert.ok(!redacted.includes("*"), "no star padding in markers");
  assert.ok(
    !/[A-Za-z0-9]{4}\[PRIVATE:/.test(redacted),
    "no four-character original prefix before markers",
  );
}

describe("hasPrivateMarker", () => {
  it("detects [PRIVATE:] markers", () => {
    assert.equal(hasPrivateMarker("x [PRIVATE:AWS Access Key] y"), true);
    assert.equal(hasPrivateMarker("[PRIVATE:Private Key continuation]"), true);
  });

  it("does not detect [REDACTED:] or clean text", () => {
    assert.equal(hasPrivateMarker("[REDACTED:AWS Access Key]"), false);
    assert.equal(hasPrivateMarker("clean output"), false);
    assert.equal(hasPrivateMarker(""), false);
  });
});

describe("SSH helpers", () => {
  it("detects SSH config content", () => {
    const input = `Host prod\n  HostName 10.0.0.12\n  User deploy\n`;
    assert.equal(looksLikeSshConfig(input), true);
  });

  it("does not detect unrelated content as SSH config", () => {
    assert.equal(
      looksLikeSshConfig("HostName examples are documented here."),
      false,
    );
  });

  it("redacts SSH config metadata directly", () => {
    const input = `Host prod\n  HostName 192.168.1.20\n  User ubuntu\n`;
    const { redacted, count } = redactSshConfigMetadata(input);
    assert.equal(count, 3);
    assert.ok(redacted.includes("Host [PRIVATE:SSH Host]"));
    assert.ok(redacted.includes("HostName [PRIVATE:SSH HostName]"));
    assert.ok(redacted.includes("User [PRIVATE:SSH User]"));
  });
});

describe("isSshConfigPath", () => {
  it("recognizes ssh config paths", () => {
    assert.equal(isSshConfigPath("/home/u/.ssh/config"), true);
    assert.equal(isSshConfigPath("/home/u/.ssh/config.d/00-laptop"), true);
    assert.equal(isSshConfigPath("/home/u/.ssh/conf.d/notes"), true);
    assert.equal(isSshConfigPath("/etc/ssh/ssh_config"), true);
    assert.equal(isSshConfigPath("C:\\Users\\u\\.ssh\\config"), true);
  });

  it("rejects non-ssh paths and non-strings", () => {
    assert.equal(isSshConfigPath("/home/u/.ssh/id_rsa"), false);
    assert.equal(isSshConfigPath("/tmp/ssh_config.backup"), false);
    assert.equal(isSshConfigPath(42), false);
    assert.equal(isSshConfigPath(undefined), false);
  });
});

describe("isPrivateKeyPath", () => {
  it("recognizes private key paths without treating public keys as private", () => {
    assert.equal(isPrivateKeyPath("/home/u/.ssh/id_rsa"), true);
    assert.equal(isPrivateKeyPath("/home/u/.ssh/id_ed25519"), true);
    assert.equal(isPrivateKeyPath("/tmp/client.pem"), true);
    assert.equal(isPrivateKeyPath("C:\\Users\\u\\private.key"), true);
    assert.equal(isPrivateKeyPath("/home/u/.ssh/id_rsa.pub"), false);
    assert.equal(isPrivateKeyPath("/tmp/monkey.ts"), false);
  });
});

describe("redactContextMessages", () => {
  it("redacts bash commands, outputs, summaries, and text content", () => {
    const messages = [
      {
        role: "bashExecution",
        command: 'export DATABASE_PASSWORD="context-command-value"',
        output: 'TOKEN="context-output-value"',
      },
      { role: "compactionSummary", summary: "password is context-summary-value" },
      { role: "branchSummary", summary: "secret is context-branch-value" },
      { role: "custom", content: "token is context-content-value" },
    ];

    assert.equal(redactContextMessages(messages), true);
    const serialized = JSON.stringify(messages);
    for (const value of [
      "context-command-value",
      "context-output-value",
      "context-summary-value",
      "context-branch-value",
      "context-content-value",
    ]) {
      assert.ok(!serialized.includes(value));
    }
  });

  it("redacts unsigned thinking without invalidating signed thinking", () => {
    const raw = `ghp_${"A".repeat(36)}`;
    const signed = `ghp_${"B".repeat(36)}`;
    const messages = [{
      role: "assistant",
      content: [
        { type: "thinking", thinking: raw },
        { type: "thinking", thinking: signed, thinkingSignature: "valid" },
      ],
    }];

    assert.equal(redactContextMessages(messages), true);
    assert.ok(!JSON.stringify(messages).includes(raw));
    assert.equal(messages[0]!.content[1]!.thinking, signed);
  });
});

describe("redactProviderPayload", () => {
  it("redacts compaction payloads but preserves signed thinking", () => {
    const raw = `ghp_${"C".repeat(36)}`;
    const signed = `ghp_${"D".repeat(36)}`;
    const payload = {
      system: `summarize ${raw}`,
      messages: [
        { role: "user", content: raw },
        { type: "thinking", thinking: signed, signature: "valid" },
      ],
    };

    assert.equal(redactProviderPayload(payload), true);
    assert.ok(!JSON.stringify(payload).includes(raw));
    assert.equal(payload.messages[1]!.thinking, signed);
  });
});

describe("createPrivateKeyContinuationTracker", () => {
  it("arms on BEGIN without END and clears on END across two read chunks", () => {
    const tracker = createPrivateKeyContinuationTracker();
    const path = "/tmp/chunked-private-key.pem";
    const firstChunk = [
      "-----BEGIN PRIVATE KEY-----",
      "Q0FOQVJZX0ZJUlNUX0NIVU5LX1BSSVZBVEVfS0VZ",
    ].join("\n");
    const secondChunk = [
      "Q0FOQVJZX1NFQ09ORF9DSFVOS19QUklWQVRFX0tFWQ==",
      "-----END PRIVATE KEY-----",
    ].join("\n");

    assert.equal(tracker.forcePrivateKey(path), false);
    const first = redactForCloud(firstChunk, {
      forcePrivateKey: tracker.forcePrivateKey(path),
    });
    tracker.noteChunk(path, firstChunk);
    assert.ok(first.redacted.includes("[PRIVATE:Private Key]"));
    assert.ok(!first.redacted.includes("Q0FOQVJZX0ZJUlNUX0NIVU5LX1BSSVZBVEVfS0VZ"));
    assert.equal(tracker.forcePrivateKey(path), true);

    const second = redactForCloud(secondChunk, {
      forcePrivateKey: tracker.forcePrivateKey(path),
    });
    tracker.noteChunk(path, secondChunk);
    assert.equal(second.count, 1);
    assert.equal(second.redacted, "[PRIVATE:Private Key continuation]");
    assert.ok(!second.redacted.includes("Q0FOQVJZX1NFQ09ORF9DSFVOS19QUklWQVRFX0tFWQ=="));
    assert.equal(tracker.forcePrivateKey(path), false);
  });

  it("redacts continuations split across text content blocks", () => {
    const tracker = createPrivateKeyContinuationTracker();
    const path = "/tmp/split-content-key.pem";
    const continuation = "Q0FOQVJZX1BSSVZBVEVfQk9EWV9DT05URU5U";
    const beginBlock = "-----BEGIN PRIVATE KEY-----\n";

    assert.equal(tracker.forcePrivateKey(path), false);
    const first = redactForCloud(beginBlock, {
      forcePrivateKey: tracker.forcePrivateKey(path),
    });
    tracker.noteChunk(path, beginBlock);
    assert.ok(first.redacted.includes("[PRIVATE:Private Key]"));
    assert.equal(tracker.forcePrivateKey(path), true);

    const second = redactForCloud(continuation, {
      forcePrivateKey: tracker.forcePrivateKey(path),
    });
    tracker.noteChunk(path, continuation);
    assert.equal(second.count, 1);
    assert.equal(second.redacted, "[PRIVATE:Private Key continuation]");
    assert.ok(!second.redacted.includes(continuation));
    // Still armed: the block stream ended without an END marker.
    assert.equal(tracker.forcePrivateKey(path), true);
  });

  it("normalizes read paths before tracking continuations", () => {
    const tracker = createPrivateKeyContinuationTracker();
    const continuation = "Q0FOQVJZX1NFQ09ORF9DSFVOS19QUklWQVRFX0tFWQ==";

    tracker.noteChunk(
      "/tmp/equivalent-key.pem",
      "-----BEGIN PRIVATE KEY-----\n",
    );
    assert.equal(tracker.forcePrivateKey("/tmp/./equivalent-key.pem"), true);

    const { redacted, count } = redactForCloud(continuation, {
      forcePrivateKey: tracker.forcePrivateKey("/tmp/./equivalent-key.pem"),
    });
    assert.equal(count, 1);
    assert.equal(redacted, "[PRIVATE:Private Key continuation]");
    assert.ok(!redacted.includes(continuation));

    tracker.noteChunk("/tmp/equivalent-key.pem", "-----END PRIVATE KEY-----\n");
    assert.equal(tracker.forcePrivateKey("/tmp/equivalent-key.pem"), false);
  });

  it("ignores undefined paths", () => {
    const tracker = createPrivateKeyContinuationTracker();
    assert.equal(tracker.forcePrivateKey(undefined), false);
    tracker.noteChunk(undefined, "-----BEGIN PRIVATE KEY-----\n");
    assert.equal(tracker.forcePrivateKey("/tmp/anything.pem"), false);
  });

  it("does not stay armed on a self-contained BEGIN+END chunk", () => {
    const tracker = createPrivateKeyContinuationTracker();
    const path = "/tmp/self-contained-key.pem";
    const block = [
      "-----BEGIN RSA PRIVATE KEY-----",
      "Q0FOQVJZX1NFTEZfQ09OVEVJTkVDX0tFWQ==",
      "-----END RSA PRIVATE KEY-----",
    ].join("\n");

    tracker.noteChunk(path, block);
    assert.equal(tracker.forcePrivateKey(path), false);
  });
});
