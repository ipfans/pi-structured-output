import assert from "node:assert/strict";
import { spawn } from "node:child_process";
import { once } from "node:events";
import { closeSync, openSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";
import { loadSchema } from "../index.ts";

const extension = fileURLToPath(new URL("../index.ts", import.meta.url));
const cli = fileURLToPath(
  new URL(
    "./bundle/cli.js",
    import.meta.resolve("@earendil-works/pi-coding-agent"),
  ),
);
const schema = {
  type: "object",
  properties: { answer: { type: "integer" } },
  required: ["answer"],
  additionalProperties: false,
};

test("validates schemas, references, formats, and all JSON root types without coercion", () => {
  const { validate } = loadSchema(JSON.stringify(schema), process.cwd());
  assert.equal(validate({ answer: 42 }), true);
  for (const value of [
    {},
    { answer: "42" },
    { answer: 42, extra: true },
    null,
  ]) {
    assert.equal(validate(value), false);
  }
  for (const [spec, value] of [
    [{ type: "array", items: { type: "integer" } }, [1, 2]],
    [{ type: "string" }, "hello"],
    [{ type: "number" }, 42],
    [{ type: "boolean" }, false],
    [{ type: "null" }, null],
    [true, { anything: true }],
    [
      {
        definitions: { count: { type: "integer" } },
        $ref: "#/definitions/count",
      },
      7,
    ],
  ] as const) {
    assert.equal(
      loadSchema(JSON.stringify(spec), process.cwd()).validate(value),
      true,
    );
  }
  assert.equal(loadSchema("false", process.cwd()).validate({}), false);
  const email = loadSchema(
    '{"type":"string","format":"email"}',
    process.cwd(),
  ).validate;
  assert.equal(email("alice@example.com"), true);
  assert.equal(email("invalid"), false);
  for (const dialect of ["2019-09", "2020-12"]) {
    const { validate } = loadSchema(
      JSON.stringify({
        $schema: `https://json-schema.org/draft/${dialect}/schema`,
        $defs: { count: { type: "integer", minimum: 1 } },
        $ref: "#/$defs/count",
      }),
      process.cwd(),
    );
    assert.equal(validate(2), true);
    assert.equal(validate(0), false);
  }
});

test("rejects malformed, unsupported, async, and unresolved schemas", () => {
  for (const spec of [
    "{",
    "null",
    "[]",
    '"string"',
    '{"type":"invalid"}',
    '{"minimum":"zero"}',
    '{"type":"string","format":"unknown-format"}',
    '{"typo":true}',
    '{"$ref":"https://example.com/schema"}',
    '{"$async":true}',
    '{"$schema":"https://example.com/unsupported"}',
    '{"const":1e400}',
  ]) {
    assert.throws(() => loadSchema(spec, process.cwd()), spec);
  }
  assert.throws(
    () => loadSchema("@does-not-exist.json", process.cwd()),
    /ENOENT/,
  );
});

type Reply = {
  text?: string;
  calls?: { name: string; arguments: unknown }[];
  error?: string;
};

function answer(value: unknown): Reply {
  return {
    calls: [
      { name: "structured_output", arguments: { json: JSON.stringify(value) } },
    ],
  };
}

async function runCli(
  options: {
    replies?: Reply[];
    schema?: string;
    flags?: string[];
    enabled?: boolean;
    stdin?: string;
    prompts?: string[];
    files?: Record<string, string>;
    stdoutFile?: boolean;
  } = {},
) {
  const cwd = await mkdtemp(join(tmpdir(), "pi-structured-output-"));
  const agentDir = join(cwd, "agent");
  let outputFd: number | undefined;
  const requests: {
    tools?: { function: { name: string; description: string } }[];
    messages: { content: unknown }[];
  }[] = [];
  const replies = options.replies ?? [answer({ answer: 42 })];
  const server = createServer(async (req, res) => {
    let body = "";
    for await (const chunk of req) body += chunk;
    requests.push(JSON.parse(body));
    const reply = replies[Math.min(requests.length - 1, replies.length - 1)];
    if (reply.error || requests.length > 6) {
      res.writeHead(400, { "content-type": "application/json" });
      res.end(
        JSON.stringify({
          error: {
            message: reply.error ?? "Too many requests",
            type: "invalid_request_error",
          },
        }),
      );
      return;
    }
    res.writeHead(200, { "content-type": "text/event-stream" });
    const delta = {
      role: "assistant",
      content: reply.text,
      tool_calls: reply.calls?.map((call, index) => ({
        index,
        id: `call_${requests.length}_${index}`,
        type: "function",
        function: {
          name: call.name,
          arguments: JSON.stringify(call.arguments),
        },
      })),
    };
    for (const choice of [
      { index: 0, delta, finish_reason: null },
      {
        index: 0,
        delta: {},
        finish_reason: reply.calls ? "tool_calls" : "stop",
      },
    ]) {
      res.write(
        `data: ${JSON.stringify({ id: "test", object: "chat.completion.chunk", model: "mock", choices: [choice] })}\n\n`,
      );
    }
    res.end("data: [DONE]\n\n");
  });
  try {
    server.listen(0, "127.0.0.1");
    await once(server, "listening");
    const address = server.address();
    assert(address && typeof address !== "string");
    await mkdir(agentDir);
    await writeFile(
      join(agentDir, "models.json"),
      JSON.stringify({
        providers: {
          "structured-test": {
            baseUrl: `http://127.0.0.1:${address.port}/v1`,
            api: "openai-completions",
            apiKey: "test-only",
            models: [{ id: "mock", contextWindow: 128000, maxTokens: 16384 }],
          },
        },
      }),
    );
    await writeFile(
      join(agentDir, "settings.json"),
      JSON.stringify({
        retry: { enabled: false },
        compaction: { enabled: false },
      }),
    );
    for (const [name, content] of Object.entries(options.files ?? {})) {
      await writeFile(join(cwd, name), content);
    }
    const args = [
      cli,
      "--offline",
      "--no-approve",
      "--no-extensions",
      "--no-skills",
      "--no-prompt-templates",
      "--no-themes",
      "--no-context-files",
      "--no-session",
      "-e",
      extension,
      "--provider",
      "structured-test",
      "--model",
      "mock",
      "-p",
    ];
    if (options.enabled !== false) args.push("--structured-outputs");
    if (options.schema !== "")
      args.push(`--json-schema=${options.schema ?? JSON.stringify(schema)}`);
    args.push(
      ...(options.flags ?? []),
      "--",
      ...(options.prompts ?? ["Return the answer."]),
    );
    if (options.stdoutFile) outputFd = openSync(join(cwd, "result.json"), "w");
    const child = spawn(process.execPath, args, {
      cwd,
      stdio: ["pipe", outputFd ?? "pipe", "pipe"],
      env: {
        ...process.env,
        PI_CODING_AGENT_DIR: agentDir,
        PI_OFFLINE: "1",
        PI_TELEMETRY: "0",
        NO_PROXY: "127.0.0.1,localhost",
        no_proxy: "127.0.0.1,localhost",
      },
      timeout: 30000,
    });
    let stdout = "";
    let stderr = "";
    child.stdout?.setEncoding("utf8").on("data", (chunk) => {
      stdout += chunk;
    });
    child.stderr?.setEncoding("utf8").on("data", (chunk) => {
      stderr += chunk;
    });
    child.stdin?.end(options.stdin ?? "");
    const [code, signal] = await once(child, "close");
    assert.equal(signal, null, stderr);
    if (options.stdoutFile)
      stdout = await readFile(join(cwd, "result.json"), "utf8");
    return { code, stdout, stderr, requests };
  } finally {
    if (outputFd !== undefined) closeSync(outputFd);
    server.closeAllConnections();
    await new Promise<void>((done) => server.close(() => done()));
    await rm(cwd, { recursive: true, force: true });
  }
}

test("real CLI emits only JSON and terminates without a follow-up model call", async () => {
  const result = await runCli({
    replies: [{ ...answer({ answer: 42 }), text: "Here is the answer:" }],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '{"answer":42}\n');
  assert.equal(result.requests.length, 1);
  const tool = result.requests[0].tools?.find(
    (tool) => tool.function.name === "structured_output",
  );
  assert(tool);
  assert(tool.function.description.includes(JSON.stringify(schema)));
  assert(
    result.requests[0].tools?.some((tool) => tool.function.name === "read"),
  );
});

test("real CLI loads @schema files relative to cwd and preserves piped input", async () => {
  const result = await runCli({
    schema: "@schema with spaces.json",
    files: { "schema with spaces.json": JSON.stringify(schema) },
    stdin: "Some piped input.",
  });
  assert.equal(result.code, 0, result.stderr);
  assert.deepEqual(JSON.parse(result.stdout), { answer: 42 });
  assert(
    JSON.stringify(result.requests[0].messages).includes("Some piped input."),
  );
});

test("real CLI leaves ordinary behavior unchanged when disabled", async () => {
  const result = await runCli({
    enabled: false,
    schema: "not JSON",
    replies: [{ text: "Ordinary answer." }],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, "Ordinary answer.\n");
  assert(
    !result.requests[0].tools?.some(
      (tool) => tool.function.name === "structured_output",
    ),
  );
});

test("real CLI rejects configuration errors before any model request", async (t) => {
  for (const options of [
    { schema: "" },
    { schema: "{" },
    { schema: "null" },
    { schema: "@missing.json" },
    { schema: '{"type":"invalid"}' },
    { flags: ["--exclude-tools", "structured_output"] },
    { flags: ["--tools", "read"] },
    { flags: ["--no-tools"] },
  ]) {
    await t.test(JSON.stringify(options), async () => {
      const result = await runCli(options);
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "", result.stderr);
      assert.equal(result.requests.length, 0);
      assert.match(result.stderr, /structured-outputs:/);
    });
  }
});

test("real CLI retries unstructured and invalid answers, then emits only the valid result", async (t) => {
  for (const first of [
    { text: "42" },
    answer({ answer: "42" }),
    { calls: [{ name: "structured_output", arguments: { json: "not JSON" } }] },
  ]) {
    await t.test(JSON.stringify(first), async () => {
      const result = await runCli({ replies: [first, answer({ answer: 42 })] });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(result.stdout, '{"answer":42}\n');
      assert.equal(result.requests.length, 2);
    });
  }
});

test("real CLI bounds failures and never emits unvalidated prose", async (t) => {
  for (const reply of [
    { text: "Not JSON" },
    answer({ answer: "wrong" }),
    { calls: [{ name: "structured_output", arguments: {} }] },
    { error: "Provider rejected request" },
  ]) {
    await t.test(JSON.stringify(reply), async () => {
      const result = await runCli({ replies: [reply] });
      assert.notEqual(result.code, 0);
      assert.equal(result.stdout, "", result.stderr);
      assert(
        result.requests.length <= 4,
        `Unexpected requests: ${result.requests.length}`,
      );
      assert.match(result.stderr, /structured-outputs:/);
    });
  }
});

test("real CLI supports root scalars, arrays, and large UTF-8 output", async (t) => {
  for (const value of [null, false, 42, [1, 2], "你好".repeat(40000)]) {
    await t.test(typeof value, async () => {
      const result = await runCli({ schema: "true", replies: [answer(value)] });
      assert.equal(result.code, 0, result.stderr);
      assert.equal(
        result.stdout.length,
        JSON.stringify(value).length + 1,
        JSON.stringify({
          tail: result.stdout.slice(-20),
          stderr: result.stderr,
        }),
      );
      assert.equal(result.stdout, `${JSON.stringify(value)}\n`);
    });
  }
});

test("real CLI writes complete JSON to a redirected file", async () => {
  const value = { answer: "你好".repeat(40000) };
  const result = await runCli({
    schema: "true",
    replies: [answer(value)],
    stdoutFile: true,
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout.length, JSON.stringify(value).length + 1);
  assert.deepEqual(JSON.parse(result.stdout), value);
});

test("real CLI supports selected tools and intermediate tool calls", async () => {
  const result = await runCli({
    flags: ["--tools", "read,structured_output"],
    files: { "note.txt": "42" },
    replies: [
      {
        text: "Reading the input.",
        calls: [{ name: "read", arguments: { path: "note.txt" } }],
      },
      answer({ answer: 42 }),
    ],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '{"answer":42}\n');
  assert.equal(result.requests.length, 2);
  assert.deepEqual(
    result.requests[0].tools?.map((tool) => tool.function.name).sort(),
    ["read", "structured_output"],
  );
});

test("real CLI rejects mixed finalization batches and accepts a subsequent standalone call", async () => {
  const result = await runCli({
    files: { "note.txt": "42" },
    replies: [
      {
        calls: [
          { name: "structured_output", arguments: { json: '{"answer":1}' } },
          { name: "read", arguments: { path: "note.txt" } },
        ],
      },
      answer({ answer: 42 }),
    ],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '{"answer":42}\n');
  assert.equal(result.requests.length, 2);
});

test("real CLI resets output for multiple prompts and retains a failure exit status", async () => {
  const success = await runCli({
    prompts: ["First", "Second"],
    replies: [answer({ answer: 1 }), answer({ answer: 2 })],
  });
  assert.equal(success.code, 0, success.stderr);
  assert.equal(success.stdout, '{"answer":1}\n{"answer":2}\n');
  const failed = await runCli({
    prompts: ["First", "Second"],
    replies: [{ error: "Provider rejected request" }, answer({ answer: 2 })],
  });
  assert.notEqual(failed.code, 0);
  assert.equal(failed.stdout, '{"answer":2}\n');
});

test("real CLI rejects the JSON event mode without making a model request", async () => {
  const result = await runCli({ flags: ["--mode", "json"] });
  assert.notEqual(result.code, 0);
  assert.equal(result.requests.length, 0);
  assert.match(result.stderr, /Use -p in text mode/);
  for (const line of result.stdout.trim().split("\n")) JSON.parse(line);
});

test("real CLI preserves original reference roots and format constraints", async () => {
  const spec = JSON.stringify({
    $schema: "https://json-schema.org/draft/2020-12/schema",
    $defs: { email: { type: "string", format: "email" } },
    type: "array",
    items: { $ref: "#/$defs/email" },
    minItems: 1,
  });
  const result = await runCli({
    schema: spec,
    replies: [answer(["invalid"]), answer(["alice@example.com"])],
  });
  assert.equal(result.code, 0, result.stderr);
  assert.equal(result.stdout, '["alice@example.com"]\n');
  assert.equal(result.requests.length, 2);
});

test("README example schemas are valid JSON", async () => {
  const readme = await readFile(
    new URL("../README.md", import.meta.url),
    "utf8",
  );
  for (const match of readme.matchAll(/```json\n([\s\S]*?)\n```/g))
    JSON.parse(match[1]);
});
