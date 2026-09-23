import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { Writable } from "node:stream";
import type { ExtensionAPI } from "@earendil-works/pi-coding-agent";
import { Ajv, type AnySchema } from "ajv";
import { Ajv2019 } from "ajv/dist/2019.js";
import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";
import { Type } from "typebox";

const TOOL = "structured_output";
const MAX_FAILURES = 3;

function parseJson(text: string): unknown {
  return JSON.parse(text, (_key, value: unknown) => {
    if (typeof value === "number" && !Number.isFinite(value)) {
      throw new Error("JSON numbers must be finite.");
    }
    return value;
  });
}

export function loadSchema(source: string, cwd: string) {
  const schema = parseJson(
    source.startsWith("@")
      ? readFileSync(resolve(cwd, source.slice(1)), "utf8")
      : source,
  );
  if (
    typeof schema !== "boolean" &&
    (typeof schema !== "object" || schema === null || Array.isArray(schema))
  ) {
    throw new Error("JSON Schema must be an object or a boolean.");
  }
  const dialect =
    typeof schema === "object" && "$schema" in schema
      ? schema.$schema
      : undefined;
  const Validator =
    dialect === "https://json-schema.org/draft/2020-12/schema"
      ? Ajv2020
      : dialect === "https://json-schema.org/draft/2019-09/schema"
        ? Ajv2019
        : Ajv;
  const ajv = new Validator({
    strictTypes: false,
    strictTuples: false,
    allErrors: true,
  });
  addFormats.default(ajv);
  const validate = ajv.compile(schema as AnySchema);
  if ("$async" in validate)
    throw new Error("Asynchronous schemas are not supported.");
  return { schema, validate };
}

function failure(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

export default function structuredOutputs(pi: ExtensionAPI) {
  pi.registerFlag("structured-outputs", {
    description: "Return validated JSON in print mode; requires --json-schema",
    type: "boolean",
    default: false,
  });
  pi.registerFlag("json-schema", {
    description:
      "JSON Schema as inline JSON or @file (use --json-schema=@file)",
    type: "string",
  });

  let enabled = false;
  let configurationError: string | undefined;
  let failures = 0;
  let standalone = false;
  let candidate: { id: string; json: string } | undefined;
  let output: string | undefined;
  let lastError: string | undefined;

  const report = (message: string) => {
    console.error(`structured-outputs: ${message}`);
    process.exitCode = 1;
  };

  pi.on("session_start", (_event, ctx) => {
    enabled = pi.getFlag("structured-outputs") === true;
    if (!enabled) return;
    try {
      if (ctx.mode !== "print") {
        throw new Error(
          "Use -p in text mode; interactive, JSON event, and RPC modes are not supported.",
        );
      }
      const source = pi.getFlag("json-schema");
      if (typeof source !== "string" || !source.trim()) {
        throw new Error(
          "--structured-outputs requires --json-schema '<schema>' or --json-schema=@file.",
        );
      }
      const { schema, validate } = loadSchema(source, ctx.cwd);
      pi.registerTool({
        name: TOOL,
        label: "Structured Output",
        description: `Submit the final answer as a JSON string conforming to this JSON Schema:\n${JSON.stringify(schema)}\nCall structured_output alone, with no other tool calls in the same response.`,
        promptSnippet: "Submit a validated final JSON answer and end the run",
        parameters: Type.Object({
          json: Type.String({
            description:
              "The final JSON value, serialized as a JSON string. No Markdown fences.",
          }),
        }),
        async execute(id, params, signal) {
          signal?.throwIfAborted();
          if (!standalone)
            throw new Error(
              "Call structured_output alone, not alongside other tools.",
            );
          const value = parseJson(params.json);
          if (!validate(value)) {
            throw new Error(
              `Output does not match JSON Schema: ${JSON.stringify(validate.errors).slice(0, 2000)}`,
            );
          }
          candidate = { id, json: JSON.stringify(value) };
          return {
            content: [{ type: "text", text: "Structured output accepted." }],
            details: { output: value },
            terminate: true,
          };
        },
      });
      if (!pi.getActiveTools().includes(TOOL)) {
        throw new Error(
          "structured_output is disabled by your tool selection; allow it to use --structured-outputs.",
        );
      }
    } catch (error) {
      configurationError = failure(error);
      report(configurationError);
      // Keep print mode from printing an old assistant answer when resuming a session.
      pi.sendMessage({
        customType: "structured-output-error",
        content: configurationError,
        display: false,
      });
    }
  });

  pi.on("input", () => {
    if (enabled && configurationError) return { action: "handled" };
  });

  pi.on("before_agent_start", (event) => {
    if (!enabled || configurationError) return;
    failures = 0;
    candidate = undefined;
    output = undefined;
    lastError = undefined;
    return {
      systemPrompt: `${event.systemPrompt}\n\nStructured output is required. Complete the task using the available tools, then call structured_output as your final, standalone action. Submit the answer in its json argument. Do not finish with a prose response.`,
    };
  });

  pi.on("message_end", (event) => {
    if (!enabled || configurationError) return;
    const message = event.message;
    if (message.role === "toolResult" && message.toolName === TOOL) {
      if (message.isError) {
        failures++;
        lastError = message.content
          .filter((part) => part.type === "text")
          .map((part) => part.text)
          .join("\n");
      } else if (candidate?.id === message.toolCallId) {
        output = candidate.json;
      }
    }
    if (message.role !== "assistant") return;
    candidate = undefined;
    output = undefined;
    const calls = message.content.filter((part) => part.type === "toolCall");
    standalone = calls.length === 1 && calls[0].name === TOOL;
    if (message.stopReason === "error" || message.stopReason === "aborted") {
      lastError = message.errorMessage ?? message.stopReason;
      return;
    }
    // Pi naturally retries failed tools. Bound repeated finalization failures.
    if (failures >= MAX_FAILURES) {
      return {
        message: {
          ...message,
          content: [],
          stopReason: "error",
          errorMessage:
            "Structured output failed after three invalid submissions.",
        },
      };
    }
  });

  pi.on("agent_before_settle", (event) => {
    if (!enabled || configurationError) return;
    if (event.outcome !== "completed") output = undefined;
    if (output !== undefined) return;
    failures++;
    return {
      // A hidden final entry also prevents print mode from emitting unvalidated prose.
      entries: [
        ...event.entries,
        {
          type: "custom_message",
          customType: "structured-output-required",
          content:
            "No valid structured output was received. Call structured_output alone with a JSON string matching the supplied schema.",
          display: false,
        },
      ],
      continue: event.outcome === "completed" && failures < MAX_FAILURES,
    };
  });

  pi.on("agent_settled", async () => {
    if (!enabled || configurationError) return;
    if (output === undefined) {
      report(lastError ?? "No valid structured output was received.");
      return;
    }
    try {
      // Bypass Pi's stdout.write-to-stderr redirect without replacing stdout.
      // Its native Writable still handles pipe backpressure and file output.
      await new Promise<void>((done, reject) => {
        process.stdout.once("error", reject);
        Writable.prototype.write.call(
          process.stdout,
          `${output}\n`,
          "utf8",
          (error?: Error | null) => {
            if (error) {
              reject(error);
            } else {
              process.stdout.off("error", reject);
              done();
            }
          },
        );
      });
    } catch (error) {
      report(`Could not write JSON output: ${failure(error)}`);
    }
  });
}
