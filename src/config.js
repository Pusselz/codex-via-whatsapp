import { existsSync } from "node:fs";
import os from "node:os";
import path from "node:path";

function parsePositiveInt(name, value, fallback) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }

  const parsed = Number.parseInt(String(value), 10);
  if (!Number.isFinite(parsed) || parsed <= 0) {
    throw new Error(`${name} must be a positive integer, got "${value}"`);
  }
  return parsed;
}

function parseJsonStringArray(name, value, fallback = []) {
  if (!value) {
    return fallback;
  }

  let parsed;
  try {
    parsed = JSON.parse(value);
  } catch (error) {
    throw new Error(`${name} must be valid JSON: ${error.message}`);
  }

  if (!Array.isArray(parsed) || parsed.some((item) => typeof item !== "string")) {
    throw new Error(`${name} must be a JSON array of strings`);
  }

  return parsed;
}

function parseBool(value, fallback = false) {
  if (value === undefined || value === null || value === "") {
    return fallback;
  }
  const normalized = String(value).trim().toLowerCase();
  return normalized === "1" || normalized === "true" || normalized === "yes" || normalized === "on";
}

function normalizePhoneNumber(raw) {
  let digits = String(raw ?? "").replace(/\D/g, "");
  if (!digits) {
    throw new Error("ALLOWED_WHATSAPP_NUMBER is required (country code + number, digits only)");
  }

  // Accept international prefix form like 0049... and normalize to 49...
  if (digits.startsWith("00") && digits.length > 2) {
    digits = digits.slice(2);
  }

  return digits;
}

function resolvePath(inputPath, fallback) {
  const selected = inputPath && String(inputPath).trim() ? inputPath : fallback;
  return path.resolve(selected);
}

function resolveCodexCommand(rawCommand) {
  const normalizedRaw = String(rawCommand ?? "").trim();
  const fallback = "codex";
  const selected = normalizedRaw || fallback;

  if (process.platform !== "win32") {
    return selected;
  }

  // On Windows, prefer the npm shim path if the command is left at default.
  if (selected.toLowerCase() === "codex") {
    const userShim = path.join(os.homedir(), ".npm-global", "codex.cmd");
    if (existsSync(userShim)) {
      return userShim;
    }
  }

  return selected;
}

export function loadConfig() {
  const stateRootDefault = path.join(os.homedir(), "memory", "whatsapp-codex");
  const allowedNumber = normalizePhoneNumber(process.env.ALLOWED_WHATSAPP_NUMBER);
  const stateRoot = resolvePath(process.env.STATE_ROOT, stateRootDefault);

  return {
    allowedNumber,
    allowedJid: `${allowedNumber}@s.whatsapp.net`,
    codexCommand: resolveCodexCommand(process.env.CODEX_COMMAND),
    codexExtraArgs: parseJsonStringArray("CODEX_EXTRA_ARGS_JSON", process.env.CODEX_EXTRA_ARGS_JSON, []),
    codexWorkdir: resolvePath(process.env.CODEX_WORKDIR, process.cwd()),
    codexTimeoutMs: parsePositiveInt("CODEX_TIMEOUT_MS", process.env.CODEX_TIMEOUT_MS, 300000),
    maxQueue: parsePositiveInt("MAX_QUEUE", process.env.MAX_QUEUE, 10),
    maxResponseChars: parsePositiveInt("MAX_RESPONSE_CHARS", process.env.MAX_RESPONSE_CHARS, 14000),
    chunkSize: parsePositiveInt("CHUNK_SIZE", process.env.CHUNK_SIZE, 3200),
    reconnectDelayMs: parsePositiveInt("RECONNECT_DELAY_MS", process.env.RECONNECT_DELAY_MS, 5000),
    stateRoot,
    authDir: resolvePath(process.env.AUTH_DIR, path.join(stateRoot, "session")),
    runtimeDir: resolvePath(process.env.RUNTIME_DIR, path.join(stateRoot, "runtime")),
    logLevel: process.env.LOG_LEVEL || "info",
    logRawEvents: parseBool(process.env.LOG_RAW_EVENTS, false),
  };
}

export function formatConfigSummary(config) {
  const masked = config.allowedNumber.length > 4
    ? `***${config.allowedNumber.slice(-4)}`
    : config.allowedNumber;

  return [
    `Allowed number: ${masked}`,
    `Codex command: ${config.codexCommand}`,
    `Codex workdir: ${config.codexWorkdir}`,
    `Auth dir: ${config.authDir}`,
    `Runtime dir: ${config.runtimeDir}`,
    `Max queue: ${config.maxQueue}`,
    `Timeout ms: ${config.codexTimeoutMs}`,
  ].join("\n");
}
