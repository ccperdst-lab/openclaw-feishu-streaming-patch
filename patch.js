#!/usr/bin/env node
/**
 * openclaw-feishu-streaming-patch
 * Patches the OpenClaw production bundle to enable real Feishu streaming output.
 *
 * Usage:
 *   node patch.js            - Apply patch (with auto-backup)
 *   node patch.js --verify   - Check if patch is applied
 *   node patch.js --rollback - Restore from backup
 */

const fs = require("fs");
const path = require("path");
const { execSync } = require("child_process");

// ── Find target file ──────────────────────────────────────────────────────────

function findTargetFile() {
  const distDir = "/usr/lib/node_modules/openclaw/dist";
  if (!fs.existsSync(distDir)) {
    throw new Error(`OpenClaw dist dir not found: ${distDir}`);
  }
  const files = fs.readdirSync(distDir).filter((f) => f.endsWith(".js"));
  for (const file of files) {
    const full = path.join(distDir, file);
    const content = fs.readFileSync(full, "utf8");
    if (content.includes("createFeishuReplyDispatcher") && content.includes("FeishuStreamingSession")) {
      return full;
    }
  }
  throw new Error("Could not find Feishu reply dispatcher bundle in OpenClaw dist/");
}

// ── Patch definitions ─────────────────────────────────────────────────────────

const PATCHES = [
  {
    name: "P1: Add streamingWasStarted + streamingDidClose flags",
    find: `\tlet streaming = null;\n\tlet streamText = "";\n\tlet lastPartial = "";\n\tlet reasoningText = "";`,
    replace: `\tlet streaming = null;\n\tlet streamingWasStarted = false;\n\tlet streamingDidClose = false;\n\tlet streamText = "";\n\tlet lastPartial = "";\n\tlet reasoningText = "";`,
    verify: "streamingWasStarted = false",
  },
  {
    name: "P2: Set streamingWasStarted in startStreaming()",
    find: `\tconst startStreaming = () => {\n\t\tif (!streamingEnabled || streamingStartPromise || streaming) return;`,
    replace: `\tconst startStreaming = () => {\n\t\tif (!streamingEnabled || streamingStartPromise || streaming) return;\n\t\tstreamingWasStarted = true;`,
    verify: "streamingWasStarted = true",
  },
  {
    name: "P3: Reset flags + set streamingDidClose in closeStreaming()",
    find: `\t\tstreaming = null;\n\t\tstreamingStartPromise = null;\n\t\tstreamText = "";\n\t\tlastPartial = "";\n\t\treasoningText = "";\n\t};`,
    replace: `\t\tstreaming = null;\n\t\tstreamingStartPromise = null;\n\t\tstreamText = "";\n\t\tlastPartial = "";\n\t\treasoningText = "";\n\t\tstreamingWasStarted = false;\n\t\tstreamingDidClose = true;\n\t};`,
    verify: "streamingDidClose = true",
  },
  {
    name: "P4: onReplyStart — start streaming in auto mode + reset streamingDidClose",
    find: `\t\t\tdeliveredFinalTexts.clear();\n\t\t\tif (streamingEnabled && renderMode === "card") startStreaming();\n\t\t\tawait typingCallbacks?.onReplyStart?.();`,
    replace: `\t\t\tdeliveredFinalTexts.clear();\n\t\t\tstreamingDidClose = false;\n\t\t\tif (streamingEnabled && (renderMode === "card" || renderMode === "auto")) startStreaming();\n\t\t\tawait typingCallbacks?.onReplyStart?.();`,
    verify: 'renderMode === "auto")) startStreaming',
  },
  {
    name: "P5: onPartialReply — call startStreaming() before queuing update",
    find: `\t\t\tonPartialReply: streamingEnabled ? (payload) => {\n\t\t\t\tif (!payload.text) return;\n\t\t\t\tqueueStreamingUpdate(payload.text, {`,
    replace: `\t\t\tonPartialReply: streamingEnabled ? (payload) => {\n\t\t\t\tif (!payload.text) return;\n\t\t\t\tstartStreaming();\n\t\t\t\tqueueStreamingUpdate(payload.text, {`,
    verify: "startStreaming();\n\t\t\t\tqueueStreamingUpdate",
  },
  {
    name: "P6: deliver — suppress duplicate finals after streaming closes",
    find: `\t\t\tconst skipTextForDuplicateFinal = info?.kind === "final" && hasText && deliveredFinalTexts.has(text);\n\t\t\tconst shouldDeliverText = hasText && !skipTextForDuplicateFinal;`,
    replace: `\t\t\t// If streaming already closed this turn, suppress further final text delivers\n\t\t\t// (the full reply was already sent via the streaming card).\n\t\t\tif (info?.kind === "final" && hasText && streamingDidClose) {\n\t\t\t\tif (hasMedia) {\n\t\t\t\t\tawait sendMediaReplies(payload);\n\t\t\t\t}\n\t\t\t\treturn;\n\t\t\t}\n\t\t\t// Mark streaming as closed synchronously when the first final arrives\n\t\t\t// so concurrent finals in the sendChain see the flag immediately.\n\t\t\tif (info?.kind === "final" && (streamingWasStarted || streaming?.isActive())) {\n\t\t\t\tstreamingDidClose = true;\n\t\t\t}\n\t\t\tconst skipTextForDuplicateFinal = info?.kind === "final" && hasText && deliveredFinalTexts.has(text);\n\t\t\tconst shouldDeliverText = hasText && !skipTextForDuplicateFinal;`,
    verify: "If streaming already closed this turn, suppress further final text delivers",
  },
  {
    name: "P7: deliver — streaming active or wasStarted → use streaming close path for final",
    find: `\t\t\t\tif (streaming?.isActive()) {\n\t\t\t\t\tif (info?.kind === "block") queueStreamingUpdate(text, { mode: "delta" });\n\t\t\t\t\tif (info?.kind === "final") {\n\t\t\t\t\t\tstreamText = mergeStreamingText(streamText, text);\n\t\t\t\t\t\tawait closeStreaming();\n\t\t\t\t\t\tdeliveredFinalTexts.add(text);\n\t\t\t\t\t}`,
    replace: `\t\t\t\tif (streaming?.isActive() || (info?.kind === "final" && streamingWasStarted)) {\n\t\t\t\t\tif (info?.kind === "block") queueStreamingUpdate(text, { mode: "delta" });\n\t\t\t\t\tif (info?.kind === "final") {\n\t\t\t\t\t\tdeliveredFinalTexts.add(text);\n\t\t\t\t\t\tstreamText = mergeStreamingText(streamText, text);\n\t\t\t\t\t\tawait closeStreaming();\n\t\t\t\t\t}`,
    verify: "streamingWasStarted)) {",
  },
];

// ── Commands ──────────────────────────────────────────────────────────────────

function applyPatch() {
  const target = findTargetFile();
  console.log(`Target: ${target}`);

  // Check if already patched
  const content = fs.readFileSync(target, "utf8");
  const alreadyPatched = PATCHES.every((p) => content.includes(p.verify));
  if (alreadyPatched) {
    console.log("✅ All patches already applied.");
    return;
  }

  // Backup
  const backup = `${target}.bak.${Date.now()}`;
  fs.copyFileSync(target, backup);
  console.log(`Backup: ${backup}`);

  // Apply patches
  let patched = content;
  let allOk = true;
  for (const p of PATCHES) {
    if (patched.includes(p.verify)) {
      console.log(`  ⏭  ${p.name} (already applied)`);
      continue;
    }
    if (!patched.includes(p.find)) {
      console.error(`  ❌ ${p.name} — target string not found!`);
      allOk = false;
      continue;
    }
    patched = patched.replace(p.find, p.replace);
    if (!patched.includes(p.verify)) {
      console.error(`  ❌ ${p.name} — patch applied but verify string missing!`);
      allOk = false;
    } else {
      console.log(`  ✅ ${p.name}`);
    }
  }

  if (!allOk) {
    console.error("\nSome patches failed. Restoring backup...");
    fs.copyFileSync(backup, target);
    console.error("Restored. No changes applied.");
    process.exit(1);
  }

  fs.writeFileSync(target, patched, "utf8");
  console.log("\n✅ All patches applied successfully!");
  console.log("Restart OpenClaw to activate:");
  console.log("  systemctl --user restart openclaw-gateway");
}

function verifyPatch() {
  const target = findTargetFile();
  const content = fs.readFileSync(target, "utf8");
  let allOk = true;
  for (const p of PATCHES) {
    const ok = content.includes(p.verify);
    console.log(`  ${ok ? "✅" : "❌"} ${p.name}`);
    if (!ok) allOk = false;
  }
  process.exit(allOk ? 0 : 1);
}

function rollback() {
  const target = findTargetFile();
  const dir = path.dirname(target);
  const base = path.basename(target);
  const backups = fs
    .readdirSync(dir)
    .filter((f) => f.startsWith(base + ".bak."))
    .sort()
    .reverse();

  if (backups.length === 0) {
    console.error("No backup found.");
    process.exit(1);
  }

  const latest = path.join(dir, backups[0]);
  console.log(`Restoring from: ${latest}`);
  fs.copyFileSync(latest, target);
  console.log("✅ Restored. Restart OpenClaw to activate:");
  console.log("  systemctl --user restart openclaw-gateway");
}

// ── Main ──────────────────────────────────────────────────────────────────────

const args = process.argv.slice(2);
try {
  if (args.includes("--verify")) {
    verifyPatch();
  } else if (args.includes("--rollback")) {
    rollback();
  } else {
    applyPatch();
  }
} catch (err) {
  console.error("Error:", err.message);
  process.exit(1);
}
