# pi-structured-output

A [Pi coding agent](https://github.com/earendil-works/pi) extension for generating JSON output that conforms to a supplied JSON Schema.

Requires **Node.js 22.19+** and **Pi 0.87.0+**. This extension targets Pi's non-interactive print mode (`-p`).

## Overview

Enable structured output with `--structured-outputs` and supply the schema separately with `--json-schema`. Pi can use its normal tools to complete the task, then submit its final answer as validated JSON.

The extension follows Pi's official [structured-output example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/structured-output.ts): a `structured_output` tool returns the final result with `terminate: true`, avoiding an unnecessary follow-up model response.

Features:

- Accept a JSON Schema inline or from a local file.
- Validate the schema before starting generation.
- Validate the generated result against the schema before accepting it.
- Print only the final JSON value to stdout in print mode (`-p`).
- Leave normal Pi behavior unchanged when structured output is disabled.

This is a tool-based approach, not a provider-specific JSON mode. It requires a model that supports tool calling. Local validation ensures that an accepted result conforms to the schema; it does not guarantee that every model request succeeds or that the content is factually correct.

## Installation

Install dependencies and register the local package with Pi:

```bash
cd /path/to/pi-structured-output
npm install
pi install .
```

Restart Pi after installation. For a project-local installation, use `pi install -l .` instead; Pi must trust that project to load its resources.

To try the extension without registering it, run `npm install` in this repository, then use `pi -e ./index.ts -p --structured-outputs --json-schema '<schema>' 'Your prompt'`. No build step is needed.

## Quick start

```bash
pi -p \
  --structured-outputs \
  --json-schema '{"type":"object","properties":{"answer":{"type":"integer"}},"required":["answer"],"additionalProperties":false}' \
  'What is 6 multiplied by 7?'
```

Expected stdout:

```json
{"answer":42}
```

The response contains no Markdown fences, commentary, or tool logs.

## CLI options

| Option | Purpose |
| --- | --- |
| `--structured-outputs` | Enable schema-constrained final output for this invocation. |
| `--json-schema <schema>` | Supply an inline JSON Schema. Required when structured output is enabled. |
| `--json-schema=@<path>` | Load a JSON Schema from a UTF-8 file. Relative paths resolve against the current working directory. |
| `-p`, `--print` | Use Pi's non-interactive print mode to receive plain JSON on stdout. |

Use the `=` form for `@file` values so Pi does not interpret the file as a prompt attachment. Quote the entire argument if the path contains spaces:

```bash
pi -p --structured-outputs --json-schema='@schemas/person schema.json' \
  'Extract the person from: Alice is 30 years old.'
```

These examples use POSIX shell quoting. Adjust quoting for your shell if necessary. Put `--structured-outputs` before another option, as shown above, or use `--` before the prompt: Pi may otherwise consume a following positional prompt as a boolean flag value.

If you restrict tools, include `structured_output` in the allowlist, for example `--tools read,structured_output`. `--no-builtin-tools` keeps the extension tool available; `--no-tools` or excluding `structured_output` produces a configuration error rather than overriding your tool selection.

### Schema from a file

Create `person.schema.json`:

```json
{
  "type": "object",
  "properties": {
    "name": { "type": "string" },
    "age": { "type": "integer", "minimum": 0 }
  },
  "required": ["name", "age"],
  "additionalProperties": false
}
```

Run:

```bash
pi -p --structured-outputs --json-schema=@person.schema.json \
  'Extract the person from: Alice is 30 years old.'
```

Expected stdout:

```json
{"name":"Alice","age":30}
```

### Pipe input and save the result

Pi's existing stdin support remains available:

```bash
printf '%s\n' 'Alice is 30 years old.' | \
  pi -p --structured-outputs --json-schema=@person.schema.json \
  'Extract the person described in the input.' > person.json
```

### Choose a model

Use Pi's existing provider and model options:

```bash
pi -p --provider openai --model gpt-4o \
  --structured-outputs --json-schema=@person.schema.json \
  'Extract the person from: Alice is 30 years old.'
```

Authentication is handled by Pi. The extension does not require separate provider credentials.

## JSON Schema support

Validation uses [Ajv](https://ajv.js.org/) with [ajv-formats](https://github.com/ajv-validator/ajv-formats).

- **Draft-07** is the default when `$schema` is omitted.
- **Draft 2019-09** and **2020-12** are selected by their standard HTTPS `$schema` URI.
- Object and boolean schemas are accepted. Results may be objects, arrays, strings, numbers, booleans, or `null`.
- Local references within the schema, nested constraints, composition, and standard formats such as `email` and `date-time` are validated.
- Values are not coerced, defaults are not inserted, and additional properties are not silently removed.
- Unknown keywords/formats, unsupported dialects, asynchronous schemas, and unresolved references are rejected. External schemas are not downloaded or loaded from sibling files; keep definitions in the supplied schema.

JSON parsing uses JavaScript number precision. Non-finite numbers are rejected. A boolean `false` schema is valid but cannot produce a successful result.

## Output and failure contract

For a single prompt in print mode:

- **Success:** stdout contains one JSON value followed by a newline, validated against the supplied schema. The process exits with code `0`.
- **Invalid configuration:** a missing schema, unreadable schema file, malformed JSON, or invalid/unsupported schema produces an error before generation starts.
- **Generation failure:** if no valid structured result is obtained, the invocation fails rather than returning unvalidated text as a successful result. The extension allows up to three finalization failures (invalid submissions or responses that end without the tool). After repeated tool failures, Pi may make one additional model request, but its response is not executed or accepted.
- **Errors:** diagnostics go to stderr and the process exits with a nonzero code. Failed invocations must not be treated as valid JSON results.

The plain-JSON stdout contract applies to `-p` in Pi's default text output mode. `--mode json`, interactive mode, and RPC mode are rejected when structured output is enabled. Pi's `--mode json` is a separate JSONL event protocol and may emit protocol events even when configuration fails.

Use one prompt per invocation when you need one JSON document. Multiple prompts produce one JSON line per successful prompt; an earlier failure still leaves the process exit status nonzero. Always check the exit status before consuming redirected output.

Without `--structured-outputs`, the extension does not register a tool, constrain responses, or change the active tools. A `--json-schema` value alone is ignored.

## How it works

1. Read and validate the supplied JSON Schema.
2. Make the `structured_output` tool available alongside the selected Pi tools.
3. Provide the schema in the tool description and instruct the model to use the tool as its final, standalone action.
4. Parse the tool's `json` string argument and validate the resulting value against the original schema.
5. Return a terminating tool result and emit the accepted JSON once the agent settles.

The tool accepts a JSON string rather than embedding the user schema inside its parameter schema. This preserves root-value types and reference resolution without depending on a provider's supported subset of JSON Schema. Stdout contains the decoded JSON value, not the tool argument wrapper.

Pi honors `terminate: true` only when every tool result in the current batch is terminating. The final structured-output call must therefore run on its own, rather than alongside other tool calls.

Schema validation checks structure and constraints, not semantic accuracy. Always validate application-specific assumptions before using generated data for consequential operations.

## Development

```bash
npm ci
npm run check       # Biome, TypeScript, and tests
npm pack --dry-run  # Inspect the distributable package
```

Tests use Node's built-in test runner and the real Pi CLI against a local mock OpenAI-compatible server. They require no API key or paid model calls. Live provider behavior is not covered by these tests.

## References

- [Pi structured-output example](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/examples/extensions/structured-output.ts)
- [Pi extensions documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/extensions.md)
- [Pi packages documentation](https://github.com/earendil-works/pi/blob/main/packages/coding-agent/docs/packages.md)
- [JSON Schema documentation](https://json-schema.org/learn)
