import "dotenv/config";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { spawn } from "node:child_process";

import makeWASocket, {
  DisconnectReason,
  fetchLatestBaileysVersion,
  getContentType,
  normalizeMessageContent,
  useMultiFileAuthState,
} from "@whiskeysockets/baileys";
import pino from "pino";
import qrcode from "qrcode-terminal";

import { formatConfigSummary, loadConfig } from "./config.js";

const config = loadConfig();
const logger = pino({ level: config.logLevel });

if (process.argv.includes("--verify-config")) {
  console.log("Config OK");
  console.log(formatConfigSummary(config));
  process.exit(0);
}

let sockRef = null;
let isShuttingDown = false;
let reconnectTimer = null;
let sequence = 0;
let codexSessionId = null;
const sessionIdFile = path.join(config.runtimeDir, "codex-session-id.txt");
const workdirFile = path.join(config.runtimeDir, "codex-workdir.txt");
const favoritesFile = path.join(config.runtimeDir, "codex-workdir-favorites.json");
let activeWorkdir = config.codexWorkdir;
let workdirFavorites = {};
const lockFile = path.join(
  os.tmpdir(),
  `codex-via-whatsapp-${config.allowedNumber}.lock`
);
let lockHandle = null;
let connectionEpoch = 0;
let connectInProgress = false;

const queue = [];
let queueRunning = false;
let activeJob = null;
const sentMessageIds = new Map();
const sentMessageTtlMs = 30 * 60 * 1000;

function shortId(id) {
  return id.slice(-6);
}

function scheduleReconnect(reason) {
  if (isShuttingDown) return;
  if (reconnectTimer) return;

  reconnectTimer = setTimeout(() => {
    reconnectTimer = null;
    logger.info({ reason }, "running scheduled reconnect");
    void connect();
  }, config.reconnectDelayMs);
}

function rememberSentMessageId(messageId) {
  if (!messageId) return;
  sentMessageIds.set(messageId, Date.now());
}

function wasSentByGateway(messageId) {
  if (!messageId) return false;

  const now = Date.now();
  for (const [id, ts] of sentMessageIds) {
    if (now - ts > sentMessageTtlMs) {
      sentMessageIds.delete(id);
    }
  }

  if (sentMessageIds.has(messageId)) {
    sentMessageIds.delete(messageId);
    return true;
  }
  return false;
}

function timestamp() {
  return new Date().toISOString();
}

function normalizeText(text) {
  if (!text) return "";
  return String(text).replace(/\r\n/g, "\n").trim();
}

function splitChunks(text, maxSize) {
  if (!text) return [];
  if (text.length <= maxSize) return [text];

  const chunks = [];
  const lines = text.split("\n");
  let current = "";

  const flush = () => {
    if (current) {
      chunks.push(current);
      current = "";
    }
  };

  for (const line of lines) {
    if (line.length > maxSize) {
      flush();
      for (let i = 0; i < line.length; i += maxSize) {
        chunks.push(line.slice(i, i + maxSize));
      }
      continue;
    }

    if (!current) {
      current = line;
      continue;
    }

    if (current.length + line.length + 1 > maxSize) {
      flush();
      current = line;
      continue;
    }

    current += `\n${line}`;
  }

  flush();
  return chunks;
}

function extractTextFromMessage(msg) {
  const normalized = normalizeMessageContent(msg?.message);
  if (!normalized) {
    return "";
  }

  const contentType = getContentType(normalized);
  if (!contentType) {
    return "";
  }

  switch (contentType) {
    case "conversation":
      return normalized.conversation || "";
    case "extendedTextMessage":
      return normalized.extendedTextMessage?.text || "";
    case "imageMessage":
      return normalized.imageMessage?.caption || "";
    case "videoMessage":
      return normalized.videoMessage?.caption || "";
    case "buttonsResponseMessage":
      return normalized.buttonsResponseMessage?.selectedDisplayText
        || normalized.buttonsResponseMessage?.selectedButtonId
        || "";
    case "listResponseMessage":
      return normalized.listResponseMessage?.title
        || normalized.listResponseMessage?.singleSelectReply?.selectedRowId
        || "";
    case "templateButtonReplyMessage":
      return normalized.templateButtonReplyMessage?.selectedDisplayText
        || normalized.templateButtonReplyMessage?.selectedId
        || "";
    default:
      return "";
  }
}

function isDirectChatJid(jid) {
  if (!jid) return false;
  return jid.endsWith("@s.whatsapp.net") || jid.endsWith("@lid");
}

function extractIncomingJidInfo(key) {
  const primary = key?.remoteJid || "";
  const alt = key?.remoteJidAlt || "";
  const all = [primary, alt].filter(Boolean);

  return {
    primary,
    alt,
    all,
    replyJid: primary || alt || "",
    hasDirectChatJid: all.some((jid) => isDirectChatJid(jid)),
    matchesAllowedNumber: all.includes(config.allowedJid),
  };
}

async function ensureDirs() {
  await fs.mkdir(config.authDir, { recursive: true });
  await fs.mkdir(config.runtimeDir, { recursive: true });
}

async function acquireProcessLock() {
  try {
    lockHandle = await fs.open(lockFile, "wx");
    await lockHandle.writeFile(
      JSON.stringify(
        {
          pid: process.pid,
          startedAt: new Date().toISOString(),
          allowedJid: config.allowedJid,
        },
        null,
        2
      ),
      "utf8"
    );
  } catch (error) {
    if (error?.code === "EEXIST") {
      throw new Error(
        `Gateway lock exists at ${lockFile}. Another instance is likely running. Stop it or remove stale lock file.`
      );
    }
    throw error;
  }
}

async function releaseProcessLock() {
  if (lockHandle) {
    try {
      await lockHandle.close();
    } catch {
      // ignore close errors
    }
    lockHandle = null;
  }

  try {
    await fs.unlink(lockFile);
  } catch {
    // ignore if already removed
  }
}

async function loadStoredSessionId() {
  try {
    const value = (await fs.readFile(sessionIdFile, "utf8")).trim();
    if (value) {
      codexSessionId = value;
      logger.info({ codexSessionId }, "loaded stored codex session id");
    }
  } catch {
    // no stored session yet
  }
}

async function storeSessionId(sessionId) {
  codexSessionId = sessionId;
  await fs.writeFile(sessionIdFile, `${sessionId}\n`, "utf8");
}

async function clearSessionId() {
  codexSessionId = null;
  try {
    await fs.unlink(sessionIdFile);
  } catch {
    // ignore if file does not exist
  }
}

function unquoteWrapped(input) {
  const value = String(input || "").trim();
  if (
    (value.startsWith("\"") && value.endsWith("\""))
    || (value.startsWith("'") && value.endsWith("'"))
  ) {
    return value.slice(1, -1).trim();
  }
  return value;
}

function expandPathVariables(input) {
  let value = String(input || "");
  value = value.replace(/^~(?=$|[\\/])/, os.homedir());
  value = value.replace(/%([^%]+)%/g, (full, name) => process.env[name] || full);
  return value;
}

async function validateDirectory(dirPath) {
  const stats = await fs.stat(dirPath);
  if (!stats.isDirectory()) {
    throw new Error(`Not a directory: ${dirPath}`);
  }
}

async function resolveRequestedWorkdir(input) {
  const raw = unquoteWrapped(input);
  if (!raw) {
    throw new Error("Missing path. Usage: /cd <path>");
  }

  const expanded = expandPathVariables(raw);
  const resolved = path.isAbsolute(expanded)
    ? path.resolve(expanded)
    : path.resolve(activeWorkdir, expanded);

  await validateDirectory(resolved);
  return resolved;
}

async function loadStoredWorkdir() {
  try {
    const stored = normalizeText(await fs.readFile(workdirFile, "utf8"));
    if (!stored) return;
    await validateDirectory(stored);
    activeWorkdir = stored;
    logger.info({ activeWorkdir }, "loaded stored codex workdir");
  } catch {
    // no stored workdir or invalid path -> keep default
  }
}

async function storeWorkdir(nextWorkdir) {
  activeWorkdir = nextWorkdir;
  await fs.writeFile(workdirFile, `${nextWorkdir}\n`, "utf8");
}

async function resetWorkdirToDefault() {
  activeWorkdir = config.codexWorkdir;
  try {
    await fs.unlink(workdirFile);
  } catch {
    // ignore if file does not exist
  }
}

function normalizeFavoriteName(name) {
  return String(name || "").trim().toLowerCase();
}

function assertValidFavoriteName(name) {
  if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(name)) {
    throw new Error("Favorite name must match [a-z0-9._-], max 32 chars.");
  }
}

async function loadStoredFavorites() {
  try {
    const raw = await fs.readFile(favoritesFile, "utf8");
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
      return;
    }

    const next = {};
    for (const [name, dirPath] of Object.entries(parsed)) {
      const normalized = normalizeFavoriteName(name);
      if (!normalized || typeof dirPath !== "string" || !dirPath.trim()) {
        continue;
      }
      if (!/^[a-z0-9][a-z0-9._-]{0,31}$/.test(normalized)) {
        continue;
      }
      next[normalized] = dirPath;
    }
    workdirFavorites = next;
    logger.info({ count: Object.keys(workdirFavorites).length }, "loaded workdir favorites");
  } catch {
    // no favorites file yet or invalid JSON
  }
}

async function saveFavorites() {
  await fs.writeFile(favoritesFile, `${JSON.stringify(workdirFavorites, null, 2)}\n`, "utf8");
}

function formatFavoritesList() {
  const names = Object.keys(workdirFavorites).sort();
  if (names.length === 0) {
    return "No favorites set. Use /fav-add <name> <path>.";
  }
  const lines = ["Favorites:"];
  for (const name of names) {
    lines.push(`- ${name}: ${workdirFavorites[name]}`);
  }
  return lines.join("\n");
}

async function applyWorkdirChange(sock, remoteJid, nextWorkdir, header) {
  if (nextWorkdir === activeWorkdir) {
    await sendText(sock, remoteJid, `Workdir unchanged:\n${activeWorkdir}`);
    return;
  }

  const previous = activeWorkdir;
  await storeWorkdir(nextWorkdir);
  await clearSessionId();
  await sendText(
    sock,
    remoteJid,
    [
      header,
      `from: ${previous}`,
      `to: ${activeWorkdir}`,
      "Session context reset.",
    ].join("\n")
  );
}

async function sendText(sock, jid, text) {
  const normalized = normalizeText(text);
  if (!normalized) return;
  const chunks = splitChunks(normalized, config.chunkSize);
  for (const chunk of chunks) {
    const sent = await sock.sendMessage(jid, { text: chunk });
    rememberSentMessageId(sent?.key?.id);
  }
}

function trimOutput(text) {
  if (!text) return "";
  if (text.length <= config.maxResponseChars) return text;
  const suffix = `\n\n[truncated to ${config.maxResponseChars} chars]`;
  return `${text.slice(0, config.maxResponseChars)}${suffix}`;
}

function buildStatusMessage() {
  const uptimeSec = Math.floor(process.uptime());
  const running = activeJob ? `yes (#${shortId(activeJob.id)})` : "no";
  const sessionDisplay = codexSessionId || "(none)";
  return [
    "Gateway status:",
    `- time: ${timestamp()}`,
    `- uptime_s: ${uptimeSec}`,
    `- queue_len: ${queue.length}`,
    `- running: ${running}`,
    `- session_id: ${sessionDisplay}`,
    `- workdir: ${activeWorkdir}`,
  ].join("\n");
}

function createJob(remoteJid, prompt) {
  sequence += 1;
  return {
    id: `${Date.now()}-${sequence}`,
    remoteJid,
    prompt,
    enqueuedAt: Date.now(),
  };
}

function quoteCmdArg(arg) {
  const value = String(arg ?? "");
  if (!value) {
    return "\"\"";
  }
  if (!/[ \t"&()^<>|]/.test(value)) {
    return value;
  }
  return `"${value.replace(/"/g, "\"\"")}"`;
}

function buildCodexSpawnSpec(command, args) {
  if (process.platform !== "win32") {
    return { command, args };
  }

  const cmdLine = [quoteCmdArg(command), ...args.map((arg) => quoteCmdArg(arg))].join(" ");
  return {
    command: "cmd.exe",
    args: ["/d", "/s", "/c", cmdLine],
  };
}

function extractSessionIdFromLogs(stdout, stderr) {
  const haystack = `${stdout || ""}\n${stderr || ""}`;
  const patterns = [
    /session id:\s*([0-9a-f-]{36})/gi,
    /"thread_id"\s*:\s*"([0-9a-f-]{36})"/gi,
  ];

  for (const pattern of patterns) {
    let match = null;
    let latest = null;
    while ((match = pattern.exec(haystack)) !== null) {
      latest = match[1];
    }
    if (latest) {
      return latest;
    }
  }

  return null;
}

function buildInteractiveCodexArgs() {
  if (codexSessionId) {
    return ["-C", activeWorkdir, "resume", codexSessionId];
  }
  return ["-C", activeWorkdir, "resume", "--last"];
}

async function openInteractiveCodexWindow() {
  if (process.platform !== "win32") {
    throw new Error("Opening a terminal window is currently implemented for Windows only.");
  }

  const args = buildInteractiveCodexArgs();

  await new Promise((resolve, reject) => {
    // Use argv form for `start` to avoid fragile quote parsing in one big command string.
    const child = spawn(
      "cmd.exe",
      ["/d", "/c", "start", "", "cmd.exe", "/k", config.codexCommand, ...args],
      {
      windowsHide: false,
      detached: true,
      stdio: "ignore",
      }
    );

    child.once("error", reject);
    child.once("spawn", resolve);
    child.unref();
  });

  return {
    resumed: Boolean(codexSessionId),
    sessionId: codexSessionId,
    workdir: activeWorkdir,
  };
}

async function killProcessTree(pid) {
  if (!pid) return false;

  return new Promise((resolve) => {
    const killer = spawn("taskkill", ["/PID", String(pid), "/T", "/F"], {
      windowsHide: true,
      stdio: "ignore",
    });

    killer.on("error", () => resolve(false));
    killer.on("close", () => resolve(true));
  });
}

async function runCodex(job) {
  const outputFile = path.join(config.runtimeDir, `codex-last-message-${job.id}.txt`);
  const args = codexSessionId
    ? [
      "exec",
      "-C",
      activeWorkdir,
      "--skip-git-repo-check",
      "-o",
      outputFile,
      ...config.codexExtraArgs,
      "resume",
      codexSessionId,
      "-",
    ]
    : [
      "exec",
      "-C",
      activeWorkdir,
      "--skip-git-repo-check",
      "-o",
      outputFile,
      ...config.codexExtraArgs,
      "-",
    ];

  return new Promise((resolve, reject) => {
    let stdout = "";
    let stderr = "";
    let timedOut = false;
    const spawnSpec = buildCodexSpawnSpec(config.codexCommand, args);

    const child = spawn(spawnSpec.command, spawnSpec.args, {
      cwd: activeWorkdir,
      windowsHide: true,
      stdio: ["pipe", "pipe", "pipe"],
    });

    activeJob = {
      ...job,
      pid: child.pid,
      child,
      startedAt: Date.now(),
      outputFile,
      manuallyStopped: false,
    };

    const timeoutHandle = setTimeout(async () => {
      timedOut = true;
      await killProcessTree(child.pid);
    }, config.codexTimeoutMs);

    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");

    child.stdout.on("data", (chunk) => {
      stdout += chunk;
    });

    child.stderr.on("data", (chunk) => {
      stderr += chunk;
    });

    child.on("error", (error) => {
      clearTimeout(timeoutHandle);
      reject(error);
    });

    child.on("close", async (exitCode, signal) => {
      clearTimeout(timeoutHandle);
      let finalText = "";
      try {
        finalText = await fs.readFile(outputFile, "utf8");
      } catch {
        finalText = "";
      }

      const detectedSessionId = extractSessionIdFromLogs(stdout, stderr);

      resolve({
        exitCode: exitCode ?? -1,
        signal: signal || "",
        stdout,
        stderr,
        finalText,
        detectedSessionId,
        timedOut,
      });
    });

    child.stdin.write(job.prompt);
    child.stdin.end();
  });
}

async function processQueue(sock) {
  if (queueRunning) return;
  queueRunning = true;

  while (queue.length > 0 && !isShuttingDown) {
    const job = queue.shift();
    const waitingMs = Date.now() - job.enqueuedAt;
    logger.info({ jobId: job.id, waitingMs }, "starting codex job");

    await sendText(sock, job.remoteJid, `Running #${shortId(job.id)}...`);

    try {
      const result = await runCodex(job);
      const stopped = activeJob?.manuallyStopped;
      const runtimeMs = Date.now() - (activeJob?.startedAt || Date.now());
      const cleanedOutput = trimOutput(normalizeText(result.finalText || result.stdout));

      if (result.detectedSessionId) {
        await storeSessionId(result.detectedSessionId);
        logger.info({ codexSessionId }, "updated codex session id from run output");
      }

      if (stopped) {
        await sendText(sock, job.remoteJid, `Stopped #${shortId(job.id)}.`);
      } else if (result.timedOut) {
        await sendText(
          sock,
          job.remoteJid,
          `Timeout on #${shortId(job.id)} after ${config.codexTimeoutMs} ms.`
        );
      } else if (result.exitCode !== 0) {
        const errorText = trimOutput(normalizeText(result.stderr || result.stdout || "Unknown error"));
        await sendText(
          sock,
          job.remoteJid,
          [
            `Codex failed on #${shortId(job.id)}.`,
            `exit_code: ${result.exitCode}`,
            errorText,
          ].join("\n")
        );
      } else if (!cleanedOutput) {
        await sendText(sock, job.remoteJid, `No output for #${shortId(job.id)}.`);
      } else {
        await sendText(
          sock,
          job.remoteJid,
          `Done #${shortId(job.id)} in ${runtimeMs} ms.\n\n${cleanedOutput}`
        );
      }
    } catch (error) {
      await sendText(
        sock,
        job.remoteJid,
        `Execution error on #${shortId(job.id)}: ${error.message}`
      );
      logger.error({ err: error, jobId: job.id }, "codex execution failed");
    } finally {
      if (activeJob?.outputFile) {
        try {
          await fs.unlink(activeJob.outputFile);
        } catch {
          // ignore cleanup failures
        }
      }
      activeJob = null;
    }
  }

  queueRunning = false;
}

async function handleStopCommand(sock, remoteJid) {
  if (activeJob?.child?.pid) {
    activeJob.manuallyStopped = true;
    const stopped = await killProcessTree(activeJob.child.pid);
    const dropped = queue.length;
    queue.length = 0;

    await sendText(
      sock,
      remoteJid,
      stopped
        ? `Stopped active run. Cleared ${dropped} queued item(s).`
        : "Could not stop active run cleanly."
    );
    return;
  }

  if (queue.length > 0) {
    const dropped = queue.length;
    queue.length = 0;
    await sendText(sock, remoteJid, `Cleared ${dropped} queued item(s).`);
    return;
  }

  await sendText(sock, remoteJid, "Nothing running.");
}

function hasWorkInProgress() {
  return Boolean(activeJob) || queue.length > 0;
}

async function handleCommand(sock, remoteJid, rawText) {
  const commandLine = rawText.slice(1).trim();
  const firstSpace = commandLine.indexOf(" ");
  const commandRaw = firstSpace === -1 ? commandLine : commandLine.slice(0, firstSpace);
  const argText = firstSpace === -1 ? "" : commandLine.slice(firstSpace + 1).trim();
  const command = String(commandRaw || "").toLowerCase();

  if (command === "help") {
    await sendText(
      sock,
      remoteJid,
      [
        "Gateway commands:",
        "/help - quick command list",
        "/guide - simple step-by-step guide",
        "/status - queue and runtime status",
        "/session - show tracked Codex session id",
        "/pwd - show current Codex workdir",
        "/cd <path> - change Codex workdir",
        "/cd-reset - reset workdir to default from .env",
        "/fav-list - list favorite workdirs",
        "/fav-add <name> <path> - save favorite workdir",
        "/fav-rm <name> - remove favorite workdir",
        "/fav <name> - switch workdir to favorite",
        "/pc - open Codex terminal on this PC (resume current session if available)",
        "/stop - stop active run and clear queue",
        "/new - reset Codex session context",
        "",
        "Any message without leading '/' is sent to Codex.",
      ].join("\n")
    );
    return;
  }

  if (command === "guide") {
    await sendText(
      sock,
      remoteJid,
      [
        "Quick guide (non-tech):",
        "1) Check status: /status",
        "2) See current folder: /pwd",
        "3) Change folder: /cd C:\\Users\\sflei\\Desktop\\SomeProject",
        "4) Save folder as favorite: /fav-add proj C:\\Users\\sflei\\Desktop\\SomeProject",
        "5) Switch to favorite later: /fav proj",
        "6) Send normal text (without /) to run Codex in that folder.",
        "",
        "Useful commands:",
        "- /pc : open Codex terminal on your PC (resumes current session when possible)",
        "- /stop : stop running job + clear queue",
        "- /new : reset chat context with Codex",
        "- /cd-reset : go back to default folder from .env",
        "- /fav-list : show all favorites",
        "- /fav-rm <name> : delete one favorite",
        "",
        "Example workflow:",
        "A) /fav proj",
        "B) \"Please list all files in this folder.\"",
        "C) \"Create a README for this project.\"",
      ].join("\n")
    );
    return;
  }

  if (command === "status") {
    await sendText(sock, remoteJid, buildStatusMessage());
    return;
  }

  if (command === "session") {
    await sendText(
      sock,
      remoteJid,
      codexSessionId
        ? `Tracked session id:\n${codexSessionId}`
        : "No tracked session id yet."
    );
    return;
  }

  if (command === "pwd") {
    await sendText(sock, remoteJid, `Current workdir:\n${activeWorkdir}`);
    return;
  }

  if (command === "cd") {
    if (!argText) {
      await sendText(sock, remoteJid, "Usage: /cd <path>");
      return;
    }

    if (hasWorkInProgress()) {
      await sendText(sock, remoteJid, "Cannot change workdir while jobs are running/queued. Use /stop first.");
      return;
    }

    try {
      const nextWorkdir = await resolveRequestedWorkdir(argText);
      await applyWorkdirChange(sock, remoteJid, nextWorkdir, "Workdir updated.");
    } catch (error) {
      await sendText(sock, remoteJid, `Could not set workdir: ${error.message}`);
    }
    return;
  }

  if (command === "cd-reset") {
    if (hasWorkInProgress()) {
      await sendText(sock, remoteJid, "Cannot change workdir while jobs are running/queued. Use /stop first.");
      return;
    }

    const defaultWorkdir = config.codexWorkdir;
    await applyWorkdirChange(sock, remoteJid, defaultWorkdir, "Workdir reset to default.");
    await resetWorkdirToDefault();
    return;
  }

  if (command === "fav-list") {
    await sendText(sock, remoteJid, formatFavoritesList());
    return;
  }

  if (command === "fav-add") {
    const parts = argText.match(/^(\S+)\s+(.+)$/);
    if (!parts) {
      await sendText(sock, remoteJid, "Usage: /fav-add <name> <path>");
      return;
    }

    const name = normalizeFavoriteName(parts[1]);
    const pathInput = parts[2];
    try {
      assertValidFavoriteName(name);
      const resolved = await resolveRequestedWorkdir(pathInput);
      workdirFavorites[name] = resolved;
      await saveFavorites();
      await sendText(sock, remoteJid, `Favorite saved: ${name}\n${resolved}`);
    } catch (error) {
      await sendText(sock, remoteJid, `Could not save favorite: ${error.message}`);
    }
    return;
  }

  if (command === "fav-rm") {
    const name = normalizeFavoriteName(argText);
    if (!name) {
      await sendText(sock, remoteJid, "Usage: /fav-rm <name>");
      return;
    }
    if (!workdirFavorites[name]) {
      await sendText(sock, remoteJid, `Favorite not found: ${name}`);
      return;
    }
    delete workdirFavorites[name];
    await saveFavorites();
    await sendText(sock, remoteJid, `Favorite removed: ${name}`);
    return;
  }

  if (command === "fav") {
    const name = normalizeFavoriteName(argText);
    if (!name) {
      await sendText(sock, remoteJid, "Usage: /fav <name>");
      return;
    }
    if (!workdirFavorites[name]) {
      await sendText(sock, remoteJid, `Favorite not found: ${name}`);
      return;
    }
    if (hasWorkInProgress()) {
      await sendText(sock, remoteJid, "Cannot change workdir while jobs are running/queued. Use /stop first.");
      return;
    }
    try {
      const resolved = await resolveRequestedWorkdir(workdirFavorites[name]);
      await applyWorkdirChange(sock, remoteJid, resolved, `Workdir changed to favorite: ${name}`);
    } catch (error) {
      await sendText(sock, remoteJid, `Could not switch to favorite "${name}": ${error.message}`);
    }
    return;
  }

  if (command === "pc" || command === "openpc") {
    try {
      const result = await openInteractiveCodexWindow();
      await sendText(
        sock,
        remoteJid,
        result.resumed
          ? `Opened Codex terminal on PC and resumed session ${result.sessionId}.\nworkdir: ${result.workdir}`
          : `Opened Codex terminal on PC.\nNo tracked session id found, trying latest session in:\n${result.workdir}`
      );
    } catch (error) {
      await sendText(sock, remoteJid, `Could not open PC terminal: ${error.message}`);
    }
    return;
  }

  if (command === "stop") {
    await handleStopCommand(sock, remoteJid);
    return;
  }

  if (command === "new") {
    const dropped = queue.length;
    queue.length = 0;
    await clearSessionId();
    await sendText(
      sock,
      remoteJid,
      `Started a fresh Codex session context. Cleared ${dropped} queued item(s).`
    );
    return;
  }

  await sendText(sock, remoteJid, "Unknown command. Use /help.");
}

async function handleIncomingText(sock, msg) {
  if (!msg?.key) return;
  const jidInfo = extractIncomingJidInfo(msg.key);
  if (!jidInfo.replyJid) return;

  if (wasSentByGateway(msg.key.id)) {
    return;
  }

  // Direct chat only.
  if (!jidInfo.hasDirectChatJid) return;

  if (!jidInfo.matchesAllowedNumber) {
    logger.warn({ jids: jidInfo.all }, "blocked message from unauthorized number");
    return;
  }

  const remoteJid = jidInfo.replyJid;
  const rawText = normalizeText(extractTextFromMessage(msg));
  if (!rawText) return;

  if (rawText.startsWith("/")) {
    await handleCommand(sock, remoteJid, rawText);
    return;
  }

  if (queue.length >= config.maxQueue) {
    await sendText(sock, remoteJid, `Queue full (${config.maxQueue}). Use /stop or wait.`);
    return;
  }

  const job = createJob(remoteJid, rawText);
  queue.push(job);
  await sendText(
    sock,
    remoteJid,
    `Queued #${shortId(job.id)} (position ${queue.length}).`
  );
  void processQueue(sock);
}

function shouldReconnect(lastDisconnectError) {
  const reason = String(lastDisconnectError?.message || "").toLowerCase();
  if (reason.includes("conflict") || reason.includes("replaced")) {
    return false;
  }
  const statusCode = lastDisconnectError?.output?.statusCode;
  return statusCode !== DisconnectReason.loggedOut;
}

async function connect() {
  if (isShuttingDown) return;
  if (connectInProgress) {
    logger.debug("connect already in progress, skipping");
    return;
  }
  connectInProgress = true;
  const epoch = ++connectionEpoch;
  try {
    await ensureDirs();

    const { state, saveCreds } = await useMultiFileAuthState(config.authDir);
    const { version } = await fetchLatestBaileysVersion();

    logger.info({ version }, "starting WhatsApp socket");

    if (sockRef) {
      try {
        sockRef.ev.removeAllListeners("connection.update");
        sockRef.ev.removeAllListeners("messages.upsert");
        sockRef.ev.removeAllListeners("creds.update");
        sockRef.ws?.close();
      } catch {
        // ignore teardown errors
      }
    }

    const sock = makeWASocket({
      auth: state,
      version,
      printQRInTerminal: false,
      markOnlineOnConnect: false,
      browser: ["OpenClaw-Style-Gateway", "Windows", "1.0.0"],
      syncFullHistory: false,
      logger: pino({ level: "error" }),
    });
    sockRef = sock;

    sock.ev.on("creds.update", saveCreds);

    sock.ev.on("connection.update", (update) => {
      if (epoch !== connectionEpoch || sock !== sockRef) {
        return;
      }

      const { connection, lastDisconnect, qr } = update;

      if (qr) {
        logger.info("scan this QR code with WhatsApp linked devices");
        qrcode.generate(qr, { small: true });
      }

      if (connection === "open") {
        logger.info("WhatsApp gateway connected");
        return;
      }

    if (connection === "close") {
      if (sock === sockRef) {
        sockRef = null;
      }

      const reasonText = String(lastDisconnect?.error?.message || "");
      const reconnect = shouldReconnect(lastDisconnect?.error);
      logger.warn(
        {
          reconnect,
          reason: reasonText,
        },
        "WhatsApp connection closed"
      );

      if (!reconnect && /conflict|replaced/i.test(reasonText)) {
        logger.error(
          "Conflict detected: another client is replacing this session. Stop other gateway instances, clear session, then re-link."
        );
      }

      if (!reconnect || isShuttingDown) {
        return;
      }

      scheduleReconnect(reasonText || "socket_closed");
    }
  });

    sock.ev.on("messages.upsert", async (event) => {
      if (epoch !== connectionEpoch || sock !== sockRef) {
        return;
      }

      if (event.type !== "notify") return;
      if (config.logRawEvents) {
        logger.debug({ event }, "raw messages.upsert event");
      }

      for (const message of event.messages) {
        try {
          await handleIncomingText(sock, message);
        } catch (error) {
          logger.error({ err: error }, "failed to process incoming message");
        }
      }
    });
  } catch (error) {
    logger.error({ err: error }, "connect attempt failed");
    scheduleReconnect(error?.message || "connect_error");
  } finally {
    connectInProgress = false;
  }
}

async function shutdown(signal) {
  if (isShuttingDown) return;
  isShuttingDown = true;

  logger.info({ signal }, "shutting down gateway");

  if (reconnectTimer) {
    clearTimeout(reconnectTimer);
    reconnectTimer = null;
  }

  queue.length = 0;

  if (activeJob?.child?.pid) {
    await killProcessTree(activeJob.child.pid);
  }

  try {
    sockRef?.ws?.close();
  } catch {
    // ignore close errors
  }

  await releaseProcessLock();

  process.exit(0);
}

process.on("SIGINT", () => {
  void shutdown("SIGINT");
});

process.on("SIGTERM", () => {
  void shutdown("SIGTERM");
});

logger.info("Codex via WhatsApp gateway booting");
logger.info(formatConfigSummary(config));

await ensureDirs();
await acquireProcessLock();
await loadStoredSessionId();
await loadStoredWorkdir();
await loadStoredFavorites();
logger.info({ activeWorkdir }, "using codex workdir");
void connect();
