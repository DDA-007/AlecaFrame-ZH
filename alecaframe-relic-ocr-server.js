"use strict";

const http = require("http");
const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const vm = require("vm");

const [translationsPath, ocrScriptPath, outputDirectory, captureScriptPath, paddlePythonPath, paddleWorkerPath, requestedPort] = process.argv.slice(2);
const port = Number(requestedPort || 38147);
const powershell = path.join(process.env.SystemRoot || "C:\\Windows", "System32", "WindowsPowerShell", "v1.0", "powershell.exe");

if (!translationsPath || !ocrScriptPath || !outputDirectory || !captureScriptPath || !paddlePythonPath || !paddleWorkerPath) {
  throw new Error("Expected translation table, OCR script, output directory, capture script, and Paddle worker paths.");
}
fs.mkdirSync(outputDirectory, { recursive: true });
const auditPath = path.join(outputDirectory, "bridge-audit.log");
const latestRewardPath = path.join(outputDirectory, "latest-reward.json");
// This is intentionally independent from reward and relic-planner state.
// Riven OCR is diagnostic-only until a real Chinese reroll card sample has
// been captured and its line layout has been validated.
const latestRivenPath = path.join(outputDirectory, "latest-riven.json");
const rivenCrop = Object.freeze({
  relative: true,
  // Same coarse crop as AlecaFrameClientLib.RivenOverlays.RivenReroll:
  // left=34.25%, top=41.60%, right=65.75%, bottom=85.00%.
  left: 0.3425,
  top: 0.416,
  right: 0.6575,
  bottom: 0.85
});
let rivenCaptureInProgress = false;
let lastRivenCaptureAt = 0;

// OCR screenshots exist only to diagnose recognition/layout failures.  Keep a
// small recent history for each independent capture path so diagnostic output
// cannot grow indefinitely during normal play.  Runtime result JSON files and
// the Paddle model files are deliberately outside these retention groups.
const diagnosticScreenshotGroups = Object.freeze([
  (name) => name.startsWith("riven-raw-"),
  (name) => name.startsWith("refinement-paddle-"),
  (name) => name.startsWith("refinement-zh-"),
  (name) => name.startsWith("refinement-") && !name.startsWith("refinement-paddle-") && !name.startsWith("refinement-zh-"),
  (name) => name.startsWith("capture-"),
  (name) => name.startsWith("relic-zh-"),
  (name) => name.startsWith("foreground-")
]);
const diagnosticScreenshotLimit = 20;

function trimDiagnosticScreenshots() {
  let files;
  try {
    files = fs.readdirSync(outputDirectory, { withFileTypes: true })
      .filter((entry) => entry.isFile() && entry.name.toLowerCase().endsWith(".png"));
  } catch {
    return;
  }

  for (const matchesGroup of diagnosticScreenshotGroups) {
    const matches = files
      .filter((entry) => matchesGroup(entry.name))
      .map((entry) => {
        const filePath = path.join(outputDirectory, entry.name);
        try {
          return { filePath, modifiedAt: fs.statSync(filePath).mtimeMs };
        } catch {
          return null;
        }
      })
      .filter(Boolean)
      .sort((left, right) => right.modifiedAt - left.modifiedAt);

    for (const stale of matches.slice(diagnosticScreenshotLimit)) {
      try {
        fs.unlinkSync(stale.filePath);
      } catch {
        // A worker may still have just released a screenshot.  Retention is
        // best-effort and will retry after the next capture.
      }
    }
  }
}

const auditLogMaximumBytes = 5 * 1024 * 1024;
const auditLogRetainedBytes = 2 * 1024 * 1024;

function trimAuditLog() {
  try {
    const size = fs.statSync(auditPath).size;
    if (size <= auditLogMaximumBytes) return;
    const start = Math.max(0, size - auditLogRetainedBytes);
    const descriptor = fs.openSync(auditPath, "r");
    const buffer = Buffer.alloc(size - start);
    try {
      fs.readSync(descriptor, buffer, 0, buffer.length, start);
    } finally {
      fs.closeSync(descriptor);
    }
    const firstNewline = buffer.indexOf(0x0a);
    const retained = firstNewline >= 0 ? buffer.subarray(firstNewline + 1) : buffer;
    fs.writeFileSync(auditPath, retained);
  } catch {
    // Diagnostic logging must never interrupt OCR or overlay updates.
  }
}

function audit(event, detail = "") {
  try {
    trimAuditLog();
    fs.appendFileSync(auditPath, `${new Date().toISOString()} ${event}${detail ? ` ${detail}` : ""}\n`);
  } catch {
    // Audit output is optional; recognition remains available if the log is locked.
  }
}

function saveLatestReward(result) {
  if (!result || !result.success || result.screenKind !== "reward" || result.rewardReady !== true || !Array.isArray(result.replacements)) {
    return;
  }
  // Keep a reward per card. Two squad members can reveal the same component,
  // and collapsing those values makes the reward overlay display fewer cards
  // than the game actually showed.
  const rewards = result.replacements.filter((name) => typeof name === "string" && name.trim());
  if (rewards.length === 0) return;
  const payload = { rewards, updatedAt: Date.now() };
  fs.writeFileSync(latestRewardPath, JSON.stringify(payload), "utf8");
  audit("LATEST_REWARD_SAVED", rewards.join(" | "));
}

function saveRewardNames(rewards, source) {
  const validRewards = Array.isArray(rewards)
    ? rewards.filter((name) => typeof name === "string" && name.trim())
    : [];
  if (validRewards.length === 0) return false;
  fs.writeFileSync(latestRewardPath, JSON.stringify({ rewards: validRewards, updatedAt: Date.now() }), "utf8");
  audit("LATEST_REWARD_PUBLISHED", `${source || "browser"} ${validRewards.join(" | ")}`);
  return true;
}

// The launcher may clear the runtime output directory while the helper is
// running, so retain the OCR input next to the stable worker script instead.
const normalizedTranslationsPath = path.join(path.dirname(ocrScriptPath), "item-translations.normalized.runtime.json");
const itemSource = fs.readFileSync(translationsPath, "utf8");
const itemContext = { window: {} };
vm.runInNewContext(itemSource, itemContext, { filename: translationsPath });
const normalizedTranslations = JSON.stringify(
  Object.entries(itemContext.window.__ALECAFRAME_ZH_CN_ITEMS__)
);
const translationEntries = Object.entries(itemContext.window.__ALECAFRAME_ZH_CN_ITEMS__);

function normalizeText(value) {
  return String(value || "")
    .toLowerCase()
    .replace(/[\s\p{P}\p{S}]/gu, "");
}

const exactChineseNames = new Map();
const localizedNameIndex = [];
const primeBases = [];
const localizedEntries = [];
const componentSuffixes = [
  ["头部神经光元蓝图", " Neuroptics Blueprint"],
  ["头部神经光元", " Neuroptics"],
  ["机体蓝图", " Chassis Blueprint"],
  ["系统蓝图", " Systems Blueprint"],
  ["连接器", " Link"],
  ["枪机", " Receiver"],
  ["枪管", " Barrel"],
  ["枪托", " Stock"],
  ["握把", " Grip"],
  ["握柄", " Handle"],
  ["弓弦", " String"],
  ["弓身", " Grip"],
  ["刀刃", " Blade"],
  ["蓝图", " Blueprint"],
  ["系统", " Systems"],
  ["机体", " Chassis"],
];

// These are suffixes, not independently valid relic rewards.  Paddle can
// isolate them when a wrapped title is cropped, and publishing one would
// poison both the price lookup and the account-state lookup.
const invalidStandaloneRewardNames = new Set([
  "blueprint",
  "set",
  "barrel",
  "receiver",
  "stock",
  "handle",
  "blade",
  "grip",
  "string",
  "chassis",
  "systems",
  "neuroptics"
]);
for (const [english, chinese] of translationEntries) {
  const normalizedChinese = normalizeText(chinese);
  if (normalizedChinese.length >= 2 && !exactChineseNames.has(normalizedChinese)) {
    exactChineseNames.set(normalizedChinese, english);
    localizedNameIndex.push({ normalizedChinese, english });
  }
  if (normalizedChinese.length >= 2) localizedEntries.push({ normalizedChinese, english });
  if (english.endsWith(" Prime")) {
    primeBases.push({ english, normalizedChinese });
  }
}

// Paddle can combine adjacent reward-card titles into one long line when
// their labels align exactly. Keep a longest-first reverse table so one OCR
// line can yield several card titles without guessing from visual spacing.
const localizedTitleTokens = localizedNameIndex
  .filter((entry) => entry.normalizedChinese.length >= 4)
  .sort((left, right) => right.normalizedChinese.length - left.normalizedChinese.length);

// Riven cards use the base weapon name followed by a random Latin riven
// surname (for example "沙皇 Visitis"). Never build this index from the
// complete UI translation table: it also contains MOD names such as
// "爆发装填 Prime", which previously made an ordinary MOD configuration
// page open the Riven overlay. Only official weapon-cache entries with a
// Riven disposition may become Riven title candidates.
const rivenWeaponCacheFiles = ["Primary.json", "Secondary.json", "Melee.json", "Arch-Gun.json", "Arch-Melee.json", "SentinelWeapons.json"];
const rivenWeaponCacheRoot = path.join(process.env.LOCALAPPDATA || "", "AlecaFrame", "cachedData", "json");
const rivenWeaponNames = new Set();
for (const cacheFile of rivenWeaponCacheFiles) {
  try {
    const cachedItems = JSON.parse(fs.readFileSync(path.join(rivenWeaponCacheRoot, cacheFile), "utf8"));
    if (!Array.isArray(cachedItems)) continue;
    for (const item of cachedItems) {
      // disposition is present on actual weapons that can have a Riven.
      // Components, MODs, blueprints and translated UI labels stay out.
      if (item && typeof item.name === "string" && item.name.trim() && Number.isFinite(Number(item.disposition))) {
        rivenWeaponNames.add(item.name.trim());
      }
    }
  } catch (error) {
    audit("RIVEN_WEAPON_CACHE_SKIPPED", cacheFile + ": " + String(error && error.code || error && error.message || error));
  }
}
const rivenWeaponCandidates = [...new Map(
  translationEntries
    .filter(([english]) => rivenWeaponNames.has(english))
    .map(([english, chinese]) => ({ english, chinese: String(chinese || "").trim(), normalizedChinese: normalizeText(chinese) }))
    .filter((entry) => entry.normalizedChinese.length >= 2)
    .map((entry) => [entry.normalizedChinese + "\u0000" + entry.english, entry])
).values()]
  .sort((left, right) => right.normalizedChinese.length - left.normalizedChinese.length);
audit("RIVEN_WEAPON_CANDIDATE_INDEX", "officialWeapons=" + rivenWeaponNames.size + " localizedCandidates=" + rivenWeaponCandidates.length);

// Some rewards intentionally retain their English base name in the Chinese
// client (for example Forma).  These are still entries in the shared table,
// but keeping a normalized reverse index makes them resolve exactly like all
// localized names and avoids routing a complete reward frame to Windows OCR.
const normalizedEnglishNames = new Map();
for (const [english] of translationEntries) {
  const normalizedEnglish = normalizeText(english);
  if (normalizedEnglish && !normalizedEnglishNames.has(normalizedEnglish)) {
    normalizedEnglishNames.set(normalizedEnglish, english);
  }
}

audit("PADDLE_TRANSLATION_INDEX", `localized=${exactChineseNames.size} english=${normalizedEnglishNames.size}`);

function resolvePaddleTitle(text) {
  const normalized = normalizeText(text);
  if (!normalized) return null;
  if (exactChineseNames.has(normalized)) {
    const english = exactChineseNames.get(normalized);
    return invalidStandaloneRewardNames.has(String(english).toLowerCase()) ? null : english;
  }
  if (normalizedEnglishNames.has(normalized)) {
    const english = normalizedEnglishNames.get(normalized);
    return invalidStandaloneRewardNames.has(String(english).toLowerCase()) ? null : english;
  }
  for (const [suffixChinese, englishSuffix] of componentSuffixes) {
    const suffix = normalizeText(suffixChinese);
    if (!normalized.endsWith(suffix)) continue;
    const base = normalized.slice(0, -suffix.length);
    const candidates = primeBases.filter((entry) => entry.normalizedChinese === base);
    if (candidates.length === 1) return candidates[0].english + englishSuffix;
  }
  // A narrow title crop occasionally loses the final character of a component
  // suffix (for example "握" instead of "握柄").  Recover it only when the
  // localized table has one unique full item beginning with that OCR text.
  // This remains data-driven across weapons and Warframe parts and never
  // turns an ambiguous fragment into a guessed reward.
  if (normalized.length >= 6) {
    const truncatedCandidates = localizedEntries
      .filter((entry) => entry.normalizedChinese.startsWith(normalized))
      .map((entry) => entry.english)
      .filter((english, index, all) => all.indexOf(english) === index);
    if (truncatedCandidates.length === 1) return truncatedCandidates[0];
  }
  // A one-character recovery is useful only for an otherwise complete card
  // title. Do not let a short or corrupted OCR fragment map to an unrelated
  // item merely because it contains a common suffix such as Prime.
  if (normalized.length >= 6 &&
    (normalized.includes("prime") || componentSuffixes.some(([suffix]) => normalized.endsWith(normalizeText(suffix))))) {
    const oneEdit = localizedNameIndex.filter((entry) => isOneEditAway(normalized, entry.normalizedChinese));
    if (oneEdit.length === 1) return oneEdit[0].english;
  }
  return null;
}

function resolvePaddleTitleParts(text) {
  const normalized = normalizeText(text);
  if (!normalized) return [];
  const direct = resolvePaddleTitle(text);
  if (direct) return [{ english: direct, start: 0, length: normalized.length }];

  const parts = [];
  let cursor = 0;
  while (cursor < normalized.length) {
    let match = null;
    for (const entry of localizedTitleTokens) {
      if (normalized.startsWith(entry.normalizedChinese, cursor)) {
        match = entry;
        break;
      }
    }
    if (!match) {
      cursor += 1;
      continue;
    }
    parts.push({ english: match.english, start: cursor, length: match.normalizedChinese.length });
    cursor += match.normalizedChinese.length;
  }
  return parts;
}

function isOneEditAway(observed, expected) {
  if (Math.abs(observed.length - expected.length) > 1) return false;
  let left = 0;
  while (left < observed.length && left < expected.length && observed[left] === expected[left]) left += 1;
  if (left === observed.length && left === expected.length) return true;
  let right = 0;
  while (right < observed.length - left && right < expected.length - left &&
    observed[observed.length - 1 - right] === expected[expected.length - 1 - right]) right += 1;
  return observed.length - left - right <= 1 && expected.length - left - right <= 1;
}

let paddleChild = null;
let paddleReady = false;
let paddleBuffer = "";
let paddleStartPromise = null;
const paddleRequests = [];
const paddleStartupTimeoutMs = 120000;

function rejectPaddleRequests(reason) {
  while (paddleRequests.length) {
    paddleRequests.shift().resolve({ success: false, reason });
  }
}

function startPaddleWorker() {
  if (paddleReady && paddleChild) return Promise.resolve(true);
  if (paddleStartPromise) return paddleStartPromise;
  paddleStartPromise = new Promise((resolve) => {
    const child = spawn(paddlePythonPath, [paddleWorkerPath], {
      windowsHide: true,
      env: {
        ...process.env,
        HOME: path.join(path.dirname(paddleWorkerPath), ".tools", "paddleocr-home"),
        USERPROFILE: path.join(path.dirname(paddleWorkerPath), ".tools", "paddleocr-home"),
        PADDLE_HOME: path.join(path.dirname(paddleWorkerPath), ".tools", "paddleocr-home"),
        FLAGS_use_mkldnn: "0"
      }
    });
    paddleChild = child;
    let settled = false;
    const finish = (ready) => {
      if (settled) return;
      settled = true;
      paddleStartPromise = null;
      paddleReady = ready;
      audit(ready ? "PADDLE_READY" : "PADDLE_UNAVAILABLE");
      resolve(ready);
    };
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (chunk) => {
      paddleBuffer += chunk;
      let newline;
      while ((newline = paddleBuffer.indexOf("\n")) >= 0) {
        const line = paddleBuffer.slice(0, newline).trim();
        paddleBuffer = paddleBuffer.slice(newline + 1);
        if (!line) continue;
        try {
          const response = JSON.parse(line);
          if (response.ready) {
            finish(true);
          } else if (paddleRequests.length) {
            paddleRequests.shift().resolve(response);
          }
        } catch {
          audit("PADDLE_PROTOCOL_INVALID", line.slice(0, 160));
        }
      }
    });
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk) => audit("PADDLE_STDERR", chunk.trim().slice(0, 300)));
    child.on("error", (error) => {
      audit("PADDLE_START_FAILED", error.message);
      finish(false);
      rejectPaddleRequests(error.message);
    });
    child.on("exit", (code) => {
      paddleChild = null;
      paddleReady = false;
      paddleStartPromise = null;
      audit("PADDLE_EXIT", String(code));
      rejectPaddleRequests("Paddle worker exited.");
    });
    // Paddle can load its Chinese recognition models noticeably slower after
    // a cold AlecaFrame restart. Do not permanently mark a still-running
    // worker unavailable before it has a chance to emit its ready message.
    setTimeout(() => {
      if (!settled) {
        audit("PADDLE_START_TIMEOUT", `waitedMs=${paddleStartupTimeoutMs}`);
        finish(false);
      }
    }, paddleStartupTimeoutMs);
  });
  return paddleStartPromise;
}

async function runPaddleWorker(imagePath, crop = null, extra = {}) {
  if (!(await startPaddleWorker()) || !paddleChild || !paddleReady) {
    return { success: false, reason: "Paddle worker is unavailable." };
  }
  return new Promise((resolve) => {
    const request = { resolve };
    paddleRequests.push(request);
    try {
      paddleChild.stdin.write(`${JSON.stringify({ path: imagePath, crop, ...extra })}\n`);
    } catch (error) {
      paddleRequests.splice(paddleRequests.indexOf(request), 1);
      resolve({ success: false, reason: error.message });
    }
  });
}

function appendPaddleLaneCandidates(lane, candidates, options = {}) {
  const lines = [...lane.lines].sort((a, b) => a.top - b.top || a.left - b.left);
  if (options.exactOnly) {
    // A crop represents exactly one reward card.  Do not recover individual
    // tokens here: a wrapped title must resolve as one complete item, while
    // fragments such as "蓝图" must never become their own reward.
    const visualRows = [];
    for (const line of lines) {
      const row = visualRows.find((candidate) => Math.abs(candidate.top - line.top) <= 45);
      if (row) row.lines.push(line);
      else visualRows.push({ top: line.top, lines: [line] });
    }
    const orderedLines = visualRows
      .sort((a, b) => a.top - b.top)
      .flatMap((row) => row.lines.sort((a, b) => a.left - b.left));
    const texts = [];
    for (let start = 0; start < orderedLines.length; start += 1) {
      let text = "";
      for (let end = start; end < orderedLines.length; end += 1) {
        text += orderedLines[end].text;
        texts.push(text);
      }
    }
    for (const text of texts) {
      const normalized = normalizeText(text);
      if (!normalized || componentSuffixes.some(([suffix]) => normalized === normalizeText(suffix))) continue;
      const english = resolvePaddleTitle(text);
      if (english) candidates.push({ english, text, centerX: lane.centerX, top: orderedLines[0] ? orderedLines[0].top : 0 });
    }
    return;
  }
  for (const line of lines) {
    const parts = resolvePaddleTitleParts(line.text);
    if (parts.length > 1) {
      audit("PADDLE_COMBINED_TITLES", `${line.text} => ${parts.map((part) => part.english).join(" | ")}`);
    }
    for (const part of parts) {
      // Project individual title locations across the merged OCR bounds so
      // the normal left-to-right card ordering remains accurate.
      const width = Math.max(1, Number(line.right) - Number(line.left));
      const totalLength = Math.max(1, normalizeText(line.text).length);
      const centerX = Number(line.left) + width * ((part.start + part.length / 2) / totalLength);
      candidates.push({ english: part.english, text: line.text, centerX, top: line.top });
    }
  }
  // A long card title often wraps to two OCR lines. Resolve every ordered
  // contiguous group; other UI rows in the same column cannot form a card
  // because only the reward-title vertical band reaches this point.
  for (let start = 0; start < lines.length; start += 1) {
    let text = "";
    for (let end = start; end < Math.min(lines.length, start + 3); end += 1) {
      text += lines[end].text;
      const english = resolvePaddleTitle(text);
      const centerX = start === end ? lines[start].centerX : lane.centerX;
      if (english) candidates.push({ english, text, centerX, top: lines[start].top });
    }
  }
}

function distinctPaddleCandidates(candidates) {
  const distinct = [];
  for (const candidate of candidates.sort((a, b) => a.centerX - b.centerX || a.top - b.top)) {
    if (distinct.some((item) => item.english === candidate.english && Math.abs(item.centerX - candidate.centerX) < 80)) continue;
    distinct.push(candidate);
  }
  return distinct;
}

function getRewardCardAnchors(lines, imageHeight) {
  // Some reward cards show a small owned/crafted badge above them. These are
  // useful positional hints, but are optional: unowned and unbuilt cards may
  // not display one at all.
  const badges = lines
    .filter((line) => line && line.confidence >= 0.75)
    .filter((line) => line.top >= imageHeight * 0.18 && line.top <= imageHeight * 0.29)
    .filter((line) => /已拥有|已制造/.test(String(line.text || "")))
    .sort((a, b) => a.centerX - b.centerX);
  const anchors = [];
  for (const badge of badges) {
    if (!anchors.some((anchor) => Math.abs(anchor.centerX - badge.centerX) < 120)) {
      anchors.push({ centerX: badge.centerX, lines: [] });
    }
  }
  return anchors.length >= 2 && anchors.length <= 4 ? anchors : [];
}

function buildRewardCardLanes(titleLanes, candidates, badgeAnchors, imageWidth) {
  const tolerance = Math.max(120, imageWidth * 0.06);
  const centers = [];
  const addCenter = (centerX) => {
    if (!Number.isFinite(centerX)) return;
    if (!centers.some((value) => Math.abs(value - centerX) < 115)) centers.push(centerX);
  };
  const distinctCandidates = distinctPaddleCandidates([...candidates]);
  // A four-card layout can split wrapped titles across neighbouring columns.
  // In that case the outermost cards still establish an even grid, while
  // candidate-based centers can wrongly pull a card toward an item-description
  // line below the title. Preserve the actual four-card geometry for crops.
  if (titleLanes.length === 4) {
    const observedCenters = titleLanes.map((lane) => Number(lane.centerX)).filter(Number.isFinite).sort((a, b) => a - b);
    const first = observedCenters[0];
    const last = observedCenters[observedCenters.length - 1];
    const gap = (last - first) / 3;
    if (Number.isFinite(gap) && gap >= imageWidth * 0.07 && gap <= imageWidth * 0.14) {
      const grid = Array.from({ length: 4 }, (_, index) => ({ centerX: first + gap * index, lines: [] }));
      audit("PADDLE_FOUR_CARD_GRID", grid.map((lane) => Math.round(lane.centerX)).join(","));
      return grid;
    }
  }
  for (const lane of titleLanes) {
    const laneMatches = distinctCandidates.filter((candidate) => Math.abs(candidate.centerX - lane.centerX) <= tolerance);
    // A merged OCR line can resolve to multiple complete titles. Each title
    // gives a more precise card location than the merged line's center.
    if (laneMatches.length) laneMatches.forEach((candidate) => addCenter(candidate.centerX));
    else addCenter(lane.centerX);
  }
  // Title lanes are the actual card geometry.  Status badges are optional
  // and can be horizontally offset or split from a wrapped name, so use them
  // only when too few title columns were detected.  Adding badge columns to a
  // complete title layout can split a single card into two crops.
  if (centers.length < 2) {
    for (const badge of badgeAnchors) addCenter(badge.centerX);
  }
  return centers
    .sort((a, b) => a - b)
    .slice(0, 4)
    .map((centerX) => ({ centerX, lines: [] }));
}

function resolvePaddleRewards(result, imagePath) {
  if (!result || !result.success || !Array.isArray(result.lines)) {
    audit("PADDLE_INCOMPLETE", `invalid=${JSON.stringify(result || {}).slice(0, 220)}`);
    return null;
  }
  const imageWidth = Number(result.imageWidth) || 0;
  const imageHeight = Number(result.imageHeight) || 0;
  if (!imageWidth || !imageHeight) {
    audit("PADDLE_INCOMPLETE", `dimensions=${result.imageWidth}x${result.imageHeight}`);
    return null;
  }
  audit("PADDLE_REWARD_RAW_LINES", JSON.stringify(result.lines.map((line) => ({
    text: line.text,
    confidence: Number(line.confidence || 0).toFixed(3),
    left: Math.round(Number(line.left) || 0),
    top: Math.round(Number(line.top) || 0),
    right: Math.round(Number(line.right) || 0),
    bottom: Math.round(Number(line.bottom) || 0),
    centerX: Math.round(Number(line.centerX) || 0)
  }))));
  const titleLines = result.lines
    .filter((line) => line && line.confidence >= 0.78 && line.top >= 0)
    // Reward titles sit directly beneath their cards. The following player
    // names are lower on the frame and must not be grouped into a card lane.
    .filter((line) => line.top >= imageHeight * 0.35 && line.top <= imageHeight * 0.44);
  audit("PADDLE_REWARD_TITLE_LINES", JSON.stringify(titleLines.map((line) => ({
    text: line.text,
    confidence: Number(line.confidence || 0).toFixed(3),
    left: Math.round(Number(line.left) || 0),
    top: Math.round(Number(line.top) || 0),
    right: Math.round(Number(line.right) || 0),
    bottom: Math.round(Number(line.bottom) || 0),
    centerX: Math.round(Number(line.centerX) || 0)
  }))));
  const lanes = [];
  // A reward card is roughly one eighth of a 3440px frame. Keep wrapped OCR
  // fragments from one card together, but never merge adjacent reward cards.
  const laneTolerance = Math.max(120, imageWidth * 0.06);
  for (const line of [...titleLines].sort((a, b) => a.centerX - b.centerX || a.top - b.top)) {
    let lane = lanes.find((candidate) => Math.abs(candidate.centerX - line.centerX) < laneTolerance);
    if (!lane) {
      lane = { centerX: line.centerX, lines: [] };
      lanes.push(lane);
    }
    lane.lines.push(line);
    // OCR may split one visual title into adjacent fragments.  The bounding
    // box center remains the card center; an arithmetic mean of fragment
    // centers shifts toward short fragments and can crop off the title edge.
    const left = Math.min(...lane.lines.map((item) => Number(item.left) || Number(item.centerX) || 0));
    const right = Math.max(...lane.lines.map((item) => Number(item.right) || Number(item.centerX) || 0));
    lane.centerX = (left + right) / 2;
  }
  const candidates = [];
  for (const lane of lanes) {
    appendPaddleLaneCandidates(lane, candidates);
  }
  const badgeAnchors = getRewardCardAnchors(result.lines, imageHeight);
  const cardLanes = buildRewardCardLanes(lanes, candidates, badgeAnchors, imageWidth);
  if (cardLanes.length >= 2) {
    // Title candidates define the normal card geometry; optional status
    // badges contribute only when a title is still unresolved.
    for (const line of titleLines) {
      let target = cardLanes[0];
      let distance = Math.abs(line.centerX - target.centerX);
      for (const anchor of cardLanes.slice(1)) {
        const candidateDistance = Math.abs(line.centerX - anchor.centerX);
        if (candidateDistance < distance) {
          target = anchor;
          distance = candidateDistance;
        }
      }
      target.lines.push(line);
    }
    lanes.splice(0, lanes.length, ...cardLanes);
    audit("PADDLE_CARD_ANCHORS", `badges=${badgeAnchors.length} ${cardLanes.map((lane) => `${Math.round(lane.centerX)}:[${lane.lines.map((line) => line.text).join(" + ")}]`).join(" | ")}`);
  }
  result.rewardLanes = lanes;
  audit("PADDLE_REWARD_LANES", lanes.map((lane) => `${Math.round(lane.centerX)}:[${lane.lines.map((line) => line.text).join(" + ")}]`).join(" | "));
  audit("PADDLE_CARD_CANDIDATES", candidates.map((item) => `${item.text}=>${item.english}`).join(" | "));
  result.rewardCandidates = candidates;
  if (candidates.length < 2) {
    audit("PADDLE_INCOMPLETE", `mapped=${candidates.length} raw=${titleLines.map((line) => line.text).join(" | ")}`);
    return null;
  }
  const distinct = distinctPaddleCandidates(candidates);
  if (distinct.length < 2 || distinct.length > 4) {
    audit("PADDLE_INCOMPLETE", `${distinct.length} ${distinct.map((item) => item.english).join(" | ")}`);
    return null;
  }
  // Two valid titles do not prove that this is a two-reward selection. Paddle
  // may only read fragments from the other cards while they are fading in.
  // Require every detected title lane to map before publishing this frame.
  if (lanes.length >= 2 && distinct.length !== lanes.length) {
    audit("PADDLE_INCOMPLETE", `lanes=${lanes.length} mapped=${distinct.length} ${distinct.map((item) => item.english).join(" | ")}`);
    return null;
  }
  return {
    success: true,
    outputPath: imagePath,
    replacements: distinct.map((item) => item.english),
    candidates: result.lines.map((line) => line.text),
    screenKind: "reward",
    rewardCardCount: distinct.length,
    rewardReady: true,
    ocrSource: "paddle"
  };
}

function makePaddleRewardResult(distinct, result, imagePath) {
  return {
    success: true,
    outputPath: imagePath,
    replacements: distinct.map((item) => item.english),
    candidates: result.lines.map((line) => line.text),
    screenKind: "reward",
    rewardCardCount: distinct.length,
    rewardReady: true,
    ocrSource: "paddle"
  };
}

function getInferredLeadingRewardLane(lanes, imageWidth) {
  if (lanes.length !== 3 || !imageWidth) return null;
  const centers = lanes.map((lane) => Number(lane.centerX)).sort((left, right) => left - right);
  const firstGap = centers[1] - centers[0];
  const secondGap = centers[2] - centers[1];
  const expectedGap = (firstGap + secondGap) / 2;
  // A normal three-card reward layout is centered on the screen. Its evenly
  // spaced titles otherwise look exactly like the right-most three columns of
  // a four-card layout, so only infer a missing leading card when the observed
  // group is visibly shifted to the right.
  const layoutCenter = (centers[0] + centers[2]) / 2;
  const centeredThreeCardLayout = Math.abs(layoutCenter - imageWidth / 2) <= imageWidth * 0.02
    && centers[2] <= imageWidth * 0.66;
  if (centeredThreeCardLayout) return null;
  // Four-card reward layouts use evenly spaced columns.  If Paddle misses the
  // leftmost title completely, the three surviving columns still reveal its
  // position. Do not infer a lane unless the observed spacing is consistent.
  if (expectedGap < imageWidth * 0.07 || expectedGap > imageWidth * 0.14) return null;
  if (Math.abs(firstGap - secondGap) > expectedGap * 0.22) return null;
  const centerX = centers[0] - expectedGap;
  if (centerX < imageWidth * 0.12 || centerX > imageWidth * 0.5) return null;
  return { centerX, lines: [], inferred: true };
}

function getInferredFourCardGrid(lanes, imageWidth) {
  if (lanes.length !== 2 || !imageWidth) return null;
  const centers = lanes.map((lane) => Number(lane.centerX)).sort((left, right) => left - right);
  const observedGap = centers[1] - centers[0];
  // When the first and third titles are the only ones Paddle reads, their
  // distance is two card columns. Try that four-card geometry, but publish it
  // only after all four independently cropped title bands resolve below.
  const columnGap = observedGap / 2;
  if (columnGap < imageWidth * 0.07 || columnGap > imageWidth * 0.14) return null;
  const grid = [centers[0], centers[0] + columnGap, centers[1], centers[1] + columnGap];
  if (grid[0] < imageWidth * 0.12 || grid[3] > imageWidth * 0.88) return null;
  return grid.map((centerX) => ({ centerX, lines: [], inferred: true }));
}

async function resolvePaddleRewardsWithTitleCrops(result, imagePath) {
  const parsed = resolvePaddleRewards(result, imagePath);
  const originalLanes = Array.isArray(result && result.rewardLanes) ? result.rewardLanes : [];
  const imageWidth = Number(result && result.imageWidth) || 0;
  const imageHeight = Number(result && result.imageHeight) || 0;
  const inferredLeadingLane = parsed ? getInferredLeadingRewardLane(originalLanes, imageWidth) : null;
  const inferredFourCardGrid = parsed ? getInferredFourCardGrid(originalLanes, imageWidth) : null;
  if (parsed && !inferredLeadingLane && !inferredFourCardGrid) return parsed;
  const lanes = inferredFourCardGrid || (inferredLeadingLane
    ? [inferredLeadingLane, ...originalLanes].sort((left, right) => left.centerX - right.centerX)
    : originalLanes);
  const candidates = Array.isArray(result && result.rewardCandidates) ? [...result.rewardCandidates] : [];
  if (lanes.length < 2 || lanes.length > 4 || !imageWidth || !imageHeight) return null;
  if (inferredLeadingLane) {
    audit("PADDLE_INFERRED_LEADING_LANE", `center=${Math.round(inferredLeadingLane.centerX)} observed=${originalLanes.map((lane) => Math.round(lane.centerX)).join(",")}`);
  }
  if (inferredFourCardGrid) {
    audit("PADDLE_INFERRED_FOUR_CARD_GRID", `centers=${lanes.map((lane) => Math.round(lane.centerX)).join(",")} observed=${originalLanes.map((lane) => Math.round(lane.centerX)).join(",")}`);
  }

  const initialDistinct = distinctPaddleCandidates(candidates);
  const mappedByLane = new Array(lanes.length).fill(null);
  for (const candidate of initialDistinct) {
    let closestIndex = -1;
    let closestDistance = Infinity;
    lanes.forEach((lane, index) => {
      const distance = Math.abs(lane.centerX - candidate.centerX);
      if (distance < closestDistance) {
        closestDistance = distance;
        closestIndex = index;
      }
    });
    if (closestDistance <= Math.max(120, imageWidth * 0.06)) {
      // A merged OCR title can contain multiple complete reward names. Keep
      // each candidate only on the card whose visual span contains it.
      const previousCenter = closestIndex > 0
        ? lanes[closestIndex - 1].centerX
        : lanes[closestIndex].centerX - (lanes[closestIndex + 1].centerX - lanes[closestIndex].centerX);
      const nextCenter = closestIndex < lanes.length - 1
        ? lanes[closestIndex + 1].centerX
        : lanes[closestIndex].centerX + (lanes[closestIndex].centerX - lanes[closestIndex - 1].centerX);
      const leftBoundary = (previousCenter + lanes[closestIndex].centerX) / 2;
      const rightBoundary = (lanes[closestIndex].centerX + nextCenter) / 2;
      if (candidate.centerX >= leftBoundary && candidate.centerX <= rightBoundary && !mappedByLane[closestIndex]) {
        mappedByLane[closestIndex] = candidate;
      }
    }
  }

  for (let index = 0; index < lanes.length; index += 1) {
    if (mappedByLane[index]) continue;
    // Divide at the midpoint between adjacent card centers.  OCR fragments
    // can shift a lane's center slightly, but this still preserves the card
    // boundary and prevents a crop from reading its neighbour's title.
    const previousCenter = index > 0
      ? lanes[index - 1].centerX
      : lanes[index].centerX - (lanes[index + 1].centerX - lanes[index].centerX);
    const nextCenter = index < lanes.length - 1
      ? lanes[index + 1].centerX
      : lanes[index].centerX + (lanes[index].centerX - lanes[index - 1].centerX);
    const leftEdge = (previousCenter + lanes[index].centerX) / 2;
    const rightEdge = (lanes[index].centerX + nextCenter) / 2;
    const crop = {
      left: Math.max(0, Math.floor(leftEdge)),
      top: Math.max(0, Math.floor(imageHeight * 0.34)),
      right: Math.min(imageWidth, Math.ceil(rightEdge)),
      bottom: Math.min(imageHeight, Math.ceil(imageHeight * 0.44))
    };
    const cropResult = await runPaddleWorker(imagePath, crop);
    const cropLines = Array.isArray(cropResult && cropResult.lines)
      ? cropResult.lines.filter((line) => line && line.confidence >= 0.65)
      : [];
    const cropLane = { centerX: lanes[index].centerX, lines: cropLines };
    const cropCandidates = [];
    appendPaddleLaneCandidates(cropLane, cropCandidates, { exactOnly: true });
    const cropDistinct = distinctPaddleCandidates(cropCandidates);
    if (cropDistinct.length === 1) mappedByLane[index] = cropDistinct[0];
    audit("PADDLE_TITLE_CROP", `lane=${index + 1} crop=${crop.left},${crop.top},${crop.right},${crop.bottom} lines=${cropLines.map((line) => line.text).join(" + ")} mapped=${cropDistinct.map((item) => item.english).join(" | ") || "none"}`);
  }

  if (mappedByLane.some((candidate) => !candidate)) {
    const mapped = mappedByLane.filter(Boolean);
    audit("PADDLE_INCOMPLETE", `title-crops lanes=${lanes.length} mapped=${mapped.length} ${mapped.map((item) => item.english).join(" | ")}`);
    // This is a conservative probe. A real two-card screen can have a gap
    // resembling columns one and three; keep its already-valid result when
    // the inferred four-card title crops do not all confirm the grid.
    return inferredFourCardGrid && parsed ? parsed : null;
  }
  const distinct = mappedByLane;
  audit(inferredFourCardGrid ? "PADDLE_INFERRED_FOUR_CARD_MATCH" : (inferredLeadingLane ? "PADDLE_INFERRED_LEADING_MATCH" : "PADDLE_TITLE_CROP_MATCH"), distinct.map((item) => item.english).join(" | "));
  return makePaddleRewardResult(distinct, result, imagePath);
}

function ensureTranslationsFile() {
  // The patch launcher can rebuild the state directory while the helper is
  // alive. Re-create this worker input immediately before every OCR request.
  fs.writeFileSync(normalizedTranslationsPath, normalizedTranslations, "utf8");
}

ensureTranslationsFile();

function sendJson(response, status, body) {
  response.writeHead(status, {
    "Content-Type": "application/json; charset=utf-8",
    "Access-Control-Allow-Origin": "*",
    "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
    "Access-Control-Allow-Headers": "Content-Type"
  });
  response.end(JSON.stringify(body));
}

function delay(milliseconds) {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function runOcrWorker(imagePath, outputPath) {
  return new Promise((resolve) => {
    try {
      ensureTranslationsFile();
    } catch (error) {
      resolve({ success: false, reason: `Unable to prepare item translations: ${error.message}` });
      return;
    }
    const child = spawn(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", ocrScriptPath,
      "-ImagePath", imagePath,
      "-TranslationsPath", normalizedTranslationsPath,
      "-OutputPath", outputPath
    ], { windowsHide: true });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => { output += data; });
    child.on("error", (error) => resolve({ success: false, reason: error.message }));
    child.on("close", () => {
      try {
        const result = JSON.parse(output.trim());
        resolve(result);
      } catch {
        resolve({ success: false, reason: "Local OCR returned an invalid response." });
      }
    });
  });
}

function captureForegroundWarframe() {
  return new Promise((resolve) => {
    const outputPath = path.join(outputDirectory, `foreground-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    const child = spawn(powershell, [
      "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass",
      "-File", captureScriptPath,
      "-OutputPath", outputPath
    ], { windowsHide: true });
    let output = "";
    child.stdout.setEncoding("utf8");
    child.stdout.on("data", (data) => { output += data; });
    child.on("error", (error) => resolve({ success: false, reason: error.message }));
    child.on("close", () => {
      try {
        resolve(JSON.parse(output.trim()));
      } catch {
        resolve({ success: false, reason: "Foreground capture returned an invalid response." });
      }
    });
  });
}

function normalizeRivenLines(workerResult) {
  const lines = Array.isArray(workerResult && workerResult.lines) ? workerResult.lines : [];
  return lines
    .filter((line) => line && typeof line.text === "string" && line.text.trim())
    .map((line) => ({
      text: line.text.trim(),
      confidence: Number.isFinite(Number(line.confidence)) ? Number(line.confidence) : 0,
      left: Number(line.left || 0),
      top: Number(line.top || 0),
      right: Number(line.right || 0),
      bottom: Number(line.bottom || 0)
    }))
    .sort((left, right) => left.top - right.top || left.left - right.left);
}

// Fixed UI words are not randomized Riven surnames. Rejecting them
// prevents ordinary names such as "爆发装填 Prime" from looking like a
// Chinese weapon followed by a Latin Riven surname.
const nonRivenSurnameTokens = new Set(["prime", "blueprint", "set", "rank", "mod", "riven", "owned", "crafted"]);
function isPlausibleRivenSurname(value) {
  const surname = String(value || "").toLowerCase();
  return /^[a-z]{3,16}$/.test(surname) && !nonRivenSurnameTokens.has(surname);
}

function resolveChineseRivenWeapon(rivenName) {
  const normalizedName = normalizeText(rivenName);
  if (!normalizedName) return null;
  // Prefer an exact weapon prefix across the entire catalog before attempting
  // OCR recovery.  Otherwise a preceding one-glyph candidate (for example
  // 月神) can steal an exact later candidate (鳄神) merely because their names
  // differ by one Chinese character.
  for (const candidate of rivenWeaponCandidates) {
    const matchedLength = candidate.normalizedChinese.length;
    const remainder = normalizedName.slice(matchedLength);
    if (!normalizedName.startsWith(candidate.normalizedChinese)) continue;
    // A riven surname is Latin text. Requiring it prevents a short Chinese
    // item name elsewhere in the crop from being misclassified as a weapon.
    if (!isPlausibleRivenSurname(remainder)) continue;
    return {
      chinese: candidate.chinese,
      english: candidate.english,
      surname: remainder,
      matchQuality: "exact"
    };
  }
  // The dim, unselected card can lose or confuse one Chinese glyph.  Only
  // after every exact prefix has failed, accept exactly one substituted glyph
  // when the remaining text is a plausible Latin riven surname.
  for (const candidate of rivenWeaponCandidates) {
    const matchedLength = candidate.normalizedChinese.length;
    // The dim, unselected card can lose or confuse one Chinese glyph. Accept
    // exactly one substituted glyph only when the remaining text is still a
    // plausible Latin riven surname; this recovers "少皇Visitis" as "沙皇"
    // without turning unrelated Chinese UI text into a weapon name.
    if (normalizedName.length <= matchedLength) continue;
    const possibleWeapon = normalizedName.slice(0, matchedLength);
    const possibleRemainder = normalizedName.slice(matchedLength);
    if (!isOneEditAway(possibleWeapon, candidate.normalizedChinese) || !isPlausibleRivenSurname(possibleRemainder)) continue;
    return {
      chinese: candidate.chinese,
      english: candidate.english,
      surname: possibleRemainder,
      matchQuality: "one-glyph-recovery"
    };
  }
  return null;
}

function getLineCenter(line) {
  return (Number(line.left || 0) + Number(line.right || 0)) / 2;
}

function parseRivenCardLines(lines, titleLine = null, cardIndex = 0) {
  const ignoredLines = [];
  const traits = [];
  let rivenName = titleLine ? String(titleLine.text || "").trim() : null;
  let rank = null;
  for (const line of lines) {
    if (titleLine === line) continue;
    const text = String(line.text || "").trim();
    if (!text) continue;
    const trait = text.match(/^([+-])?\s*(\d+(?:\.\d+)?)\s*(%?)\s*(.+)$/);
    if (trait && trait[4].trim() && !/^\d+$/.test(trait[4].trim())) {
      traits.push({
        sign: trait[1] || null,
        value: Number(trait[2]),
        unit: trait[3] || "",
        text: trait[4].trim(),
        raw: text,
        confidence: line.confidence,
        signRecognized: Boolean(trait[1])
      });
      continue;
    }
    // Chinese faction damage uses `x1.55 对 Grineer 的伤害` rather than a
    // percentage. Preserve it as a real positive riven stat.
    const multiplierTrait = text.match(/^x\s*(\d+(?:\.\d+)?)\s*(对\s*(?:Grineer|Corpus|Infested)\s*的?伤害)$/i);
    if (multiplierTrait) {
      traits.push({
        sign: "+", value: Number(multiplierTrait[1]), unit: "x",
        text: multiplierTrait[2].replace(/\s+/g, "").replace("的伤害", "伤害"),
        raw: text, confidence: line.confidence, signRecognized: true, isMultiplier: true
      });
      continue;
    }
    const rankMatch = text.match(/^段位\s*(\d{1,2})$/);
    if (rankMatch) {
      rank = Number(rankMatch[1]);
      continue;
    }
    if (!rivenName && resolveChineseRivenWeapon(text)) {
      rivenName = text;
      continue;
    }
    ignoredLines.push(text);
  }
  const weapon = rivenName ? resolveChineseRivenWeapon(rivenName) : null;
  const titleCenter = titleLine ? getLineCenter(titleLine) : null;
  const signedTraitCount = traits.filter((trait) => trait.signRecognized).length;
  return {
    cardIndex,
    detected: Boolean(rivenName && weapon && traits.length > 0),
    rivenName,
    weaponNameChinese: weapon ? weapon.chinese : null,
    weaponNameEnglishCandidate: weapon ? weapon.english : null,
    rivenSurname: weapon ? weapon.surname : null,
    weaponMatchQuality: weapon ? weapon.matchQuality : null,
    rank,
    traits,
    signedTraitCount,
    titleCenter,
    ignoredLines,
    // Browser-side publishing must not trust a generic one-card OCR result
    // from another game screen. This evidence is deliberately conservative.
    chatLinkEvidence: Boolean(
      rivenName && weapon && weapon.matchQuality === "exact" &&
      isPlausibleRivenSurname(weapon.surname) && signedTraitCount >= 2
    )
  };
}

function resolvePaddleRivenDiagnostic(lines) {
  // A reroll result shows two cards. Their selected state moves the cards,
  // so fixed left/right percentages are unreliable; title positions define
  // the two card columns instead.
  const titleLines = lines
    .filter((line) => resolveChineseRivenWeapon(line.text))
    .sort((left, right) => left.left - right.left);
  const centers = titleLines.map(getLineCenter);
  let cardGroups = [];
  if (titleLines.length >= 2 && centers[centers.length - 1] - centers[0] >= 160) {
    cardGroups = titleLines.map((titleLine, cardIndex) => ({ titleLine, cardIndex, lines: [] }));
    for (const line of lines) {
      const center = getLineCenter(line);
      let nearest = 0;
      for (let index = 1; index < centers.length; index += 1) {
        if (Math.abs(center - centers[index]) < Math.abs(center - centers[nearest])) nearest = index;
      }
      cardGroups[nearest].lines.push(line);
    }
  } else {
    cardGroups = [{ titleLine: titleLines[0] || null, cardIndex: 0, lines }];
  }
  const cards = cardGroups
    .map((group) => parseRivenCardLines(group.lines, group.titleLine, group.cardIndex))
    .filter((card) => card.detected);
  const selectedCard = cards.length > 1
    ? cards.reduce((best, card) => card.signedTraitCount > best.signedTraitCount ? card : best)
    : cards[0] || parseRivenCardLines(lines, titleLines[0] || null);
  const success = Boolean(selectedCard && selectedCard.detected);
  const selectedCardIndex = success && cards.length > 1 ? selectedCard.cardIndex : null;
  const comparison = cards.length >= 2 ? {
    selectedCardIndex,
    cardOrder: cards.map((card) => ({
      cardIndex: card.cardIndex,
      side: card.titleCenter < selectedCard.titleCenter ? "left-of-selected" : card.titleCenter > selectedCard.titleCenter ? "right-of-selected" : "selected",
      rivenName: card.rivenName,
      signedTraitCount: card.signedTraitCount
    }))
  } : null;
  return {
    success,
    phase: cards.length >= 2 ? "reroll-comparison" : success ? "selected-for-reroll" : "unrecognized",
    rivenName: selectedCard.rivenName,
    weaponNameChinese: selectedCard.weaponNameChinese,
    weaponNameEnglishCandidate: selectedCard.weaponNameEnglishCandidate,
    rivenSurname: selectedCard.rivenSurname,
    rank: selectedCard.rank,
    traits: selectedCard.traits,
    ignoredLines: selectedCard.ignoredLines,
    cards,
    comparison,
    reason: success ? null : "The captured crop did not contain a complete Chinese riven title and at least one trait."
  };
}

async function processRivenScreenshot(imagePath) {
  if (!fs.existsSync(imagePath)) {
    return { success: false, reason: "Riven screenshot file disappeared before OCR could read it." };
  }
  const stamp = `${Date.now()}-${Math.random().toString(16).slice(2)}`;
  const snapshotPath = path.join(outputDirectory, `riven-raw-${stamp}.png`);
  try {
    fs.copyFileSync(imagePath, snapshotPath);
  } catch (error) {
    return { success: false, reason: `Unable to preserve riven screenshot: ${error.message}` };
  }
  trimDiagnosticScreenshots();
  const workerResult = await runPaddleWorker(snapshotPath, rivenCrop);
  if (!workerResult || !workerResult.success) {
    return { success: false, reason: workerResult && workerResult.reason || "Paddle could not read the riven crop." };
  }
  const lines = normalizeRivenLines(workerResult);
  const parsed = resolvePaddleRivenDiagnostic(lines);
  const result = {
    success: true,
    screenKind: "riven-diagnostic",
    capturedAt: Date.now(),
    sourcePath: snapshotPath,
    crop: rivenCrop,
    imageWidth: workerResult.imageWidth,
    imageHeight: workerResult.imageHeight,
    lines,
    parsed,
    rawText: lines.map((line) => line.text).join("\n"),
    recognitionEngine: "paddle-riven-diagnostic"
  };
  fs.writeFileSync(latestRivenPath, JSON.stringify(result, null, 2), "utf8");
  audit("RIVEN_PADDLE_RESULT", lines.map((line) => `${line.text} (${line.confidence.toFixed(2)})`).join(" | ").slice(0, 1200));
  audit("RIVEN_PARSE_RESULT", parsed.success
    ? `${parsed.weaponNameEnglishCandidate} rank=${parsed.rank === null ? "?" : parsed.rank} traits=${parsed.traits.length}`
    : parsed.reason);
  return result;
}

async function captureRivenWithPaddle() {
  const now = Date.now();
  if (rivenCaptureInProgress) {
    return { success: false, reason: "A riven diagnostic capture is already in progress." };
  }
  if (now - lastRivenCaptureAt < 2000) {
    return { success: false, reason: "Riven diagnostic capture is cooling down." };
  }
  rivenCaptureInProgress = true;
  lastRivenCaptureAt = now;
  try {
    audit("RIVEN_CAPTURE_REQUESTED");
    const capture = await captureForegroundWarframe();
    if (!capture.success || !capture.path) {
      audit("RIVEN_CAPTURE_SKIPPED_NOT_FOREGROUND", capture.reason || "Warframe is not foreground.");
      return capture;
    }
    audit("RIVEN_CAPTURE_SUCCESS", capture.path);
    return await processRivenScreenshot(capture.path);
  } finally {
    rivenCaptureInProgress = false;
  }
}

async function captureRewardWithPaddle() {
  // This endpoint is exclusively for the post-opening reward window. It is
  // isolated from the relic-planner probe and never waits for slow Windows
  // OCR; if the first screenshot is early, inspect one newer Paddle frame.
  for (let attempt = 0; attempt < 2; attempt += 1) {
    const capture = await captureForegroundWarframe();
    if (!capture.success || !capture.path) {
      audit("REWARD_CAPTURE_SKIPPED", capture.reason || "Warframe is not foreground.");
      return capture;
    }
    audit("REWARD_CAPTURE", `attempt=${attempt + 1} ${capture.path}`);
    const result = await processScreenshot(capture.path, false, 1, false);
    if (result.success) {
      audit("REWARD_CAPTURE_MATCH", `attempt=${attempt + 1} ${result.replacements.join(" | ")}`);
      return result;
    }
    if (attempt === 0) await delay(250);
  }
  return { success: false, reason: "Paddle did not recognize a complete reward frame." };
}

async function processScreenshot(imagePath, requiresStableCopy = true, maxAttempts = 1, allowWindowsFallback = true) {
  // Overwolf owns and later removes its capture file. Snapshot it into this
  // helper's directory before invoking WinRT OCR so the reader sees a stable
  // local file for the entire recognition operation.
  if (!fs.existsSync(imagePath)) {
    return { success: false, reason: "Screenshot file disappeared before OCR could read it." };
  }
  let snapshotPath = imagePath;
  if (requiresStableCopy) {
    if (!fs.existsSync(imagePath)) {
      return { success: false, reason: "Screenshot file disappeared before OCR could read it." };
    }
    snapshotPath = path.join(outputDirectory, `capture-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    try {
      fs.copyFileSync(imagePath, snapshotPath);
    } catch (error) {
      return { success: false, reason: `Unable to copy screenshot: ${error.message}` };
    }
    trimDiagnosticScreenshots();
  }
  let lastResult = { success: false, reason: "OCR worker did not return a result." };
  for (let attempt = 0; attempt < maxAttempts; attempt += 1) {
    const outputPath = path.join(outputDirectory, `relic-zh-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
    const paddleResult = await resolvePaddleRewardsWithTitleCrops(await runPaddleWorker(snapshotPath), snapshotPath);
    if (paddleResult) {
      audit("PADDLE_REWARD_MATCH", paddleResult.replacements.join(" | "));
      saveLatestReward(paddleResult);
      return paddleResult;
    }
    if (!allowWindowsFallback) {
      lastResult = { success: false, reason: "Paddle did not recognize a complete 2-4 reward-card result." };
      audit("PADDLE_REWARD_PENDING", lastResult.reason);
      if (attempt + 1 < maxAttempts) {
        await delay(350 * (attempt + 1));
      }
      continue;
    }
    audit("PADDLE_FALLBACK_WINDOWS", "No complete 2-4 reward-card result.");
    lastResult = await runOcrWorker(snapshotPath, outputPath);
    if (lastResult.success) {
      saveLatestReward(lastResult);
      return lastResult;
    }
    if (attempt + 1 < maxAttempts) {
      await delay(350 * (attempt + 1));
    }
  }
  return lastResult;
}

function resolvePaddleRefinement(result) {
  const lines = Array.isArray(result && result.lines)
    ? result.lines.filter((line) => line && Number(line.confidence) >= 0.65)
    : [];
  const normalizedLines = lines.map((line) => normalizeText(line.text));
  const isRefinement = normalizedLines.some((text) => text.includes("虚空遗物") && text.includes("精炼"));
  if (!isRefinement) return null;

  const eras = [
    ["古纪", "Lith"],
    ["前纪", "Meso"],
    ["中纪", "Neo"],
    ["后纪", "Axi"]
  ];
  const evidence = eras.map(([label, era]) => ({
    era,
    count: normalizedLines.reduce((total, text) => total + (text.includes(label) ? 1 : 0), 0)
  }));
  evidence.sort((left, right) => right.count - left.count);
  if (!evidence[0] || evidence[0].count < 1 ||
      (evidence[1] && evidence[0].count === evidence[1].count)) {
    return null;
  }
  return {
    success: true,
    screenKind: "refinement",
    era: evidence[0].era,
    replacements: ["VOID RELICS / REFINEMENT", "EQUIP FOR MISSION"],
    candidates: lines.map((line) => line.text),
    recognitionEngine: "paddle-refinement"
  };
}

async function processRefinementScreenshot(imagePath) {
  // This page shares Paddle's resident process, but not the reward-card
  // parser. It recognizes only the upper-left title and the era labels.
  if (!fs.existsSync(imagePath)) {
    return { success: false, reason: "Screenshot file disappeared before refinement OCR could read it." };
  }
  const snapshotPath = path.join(outputDirectory, `refinement-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  try {
    fs.copyFileSync(imagePath, snapshotPath);
  } catch (error) {
    return { success: false, reason: `Unable to copy refinement screenshot: ${error.message}` };
  }
  trimDiagnosticScreenshots();
  const paddleProbe = await runPaddleWorker(snapshotPath, {
    left: 0,
    top: 0,
    right: 0.38,
    bottom: 0.40,
    relative: true
  });
  // The relative crop contains only the title and era grid. This avoids
  // treating unrelated gameplay text as an era label and keeps the resident
  // Paddle request substantially smaller than a full-frame recognition.
  if (paddleProbe && paddleProbe.success) {
    const paddleResult = resolvePaddleRefinement(paddleProbe);
    if (paddleResult) {
      const landmarkPath = path.join(outputDirectory, `refinement-paddle-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
      const landmark = await runPaddleWorker(snapshotPath, null, {
        mode: "refinement-landmark",
        outputPath: landmarkPath
      });
      if (landmark && landmark.success && landmark.outputPath && fs.existsSync(landmark.outputPath)) {
        paddleResult.outputPath = landmark.outputPath;
        audit("PADDLE_REFINEMENT_MATCH", `${paddleResult.era} ${paddleResult.candidates.join(" | ")}`);
        return paddleResult;
      }
      audit("PADDLE_REFINEMENT_LANDMARK_FAILED", landmark && landmark.reason || "No output path.");
    }
    audit("PADDLE_REFINEMENT_NO_MATCH", (paddleProbe.lines || []).map((line) => line.text).join(" | "));
  }
  // Keep the existing Windows OCR path as a correctness fallback. Its output
  // also creates AlecaFrame's English landmark image for uncommon layouts.
  const outputPath = path.join(outputDirectory, `refinement-zh-${Date.now()}-${Math.random().toString(16).slice(2)}.png`);
  const result = await runOcrWorker(snapshotPath, outputPath);
  if (!result.success || result.screenKind !== "refinement") return result;
  return result;
}

const server = http.createServer((request, response) => {
  if (request.method === "OPTIONS") {
    audit("OPTIONS", request.headers.origin || "");
    response.writeHead(204, {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, POST, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
      "Access-Control-Max-Age": "600"
    });
    response.end();
    return;
  }
  if (request.method === "GET" && request.url === "/health") {
    return sendJson(response, 200, { ready: true });
  }
  if (request.method === "GET" && request.url === "/latest-reward") {
    try {
      if (!fs.existsSync(latestRewardPath)) {
        return sendJson(response, 404, { success: false, reason: "No recognized reward is available yet." });
      }
      const payload = JSON.parse(fs.readFileSync(latestRewardPath, "utf8"));
      // A stale frame from an earlier mission must never populate a newly
      // opened overlay.
      if (!payload.updatedAt || Date.now() - payload.updatedAt > 30000) {
        return sendJson(response, 404, { success: false, reason: "The recognized reward has expired." });
      }
      return sendJson(response, 200, { success: true, rewards: payload.rewards, updatedAt: payload.updatedAt });
    } catch (error) {
      return sendJson(response, 500, { success: false, reason: `Unable to read recognized rewards: ${error.message}` });
    }
  }
  if (request.method === "GET" && request.url === "/latest-riven") {
    try {
      if (!fs.existsSync(latestRivenPath)) {
        return sendJson(response, 404, { success: false, reason: "No riven diagnostic capture is available yet." });
      }
      return sendJson(response, 200, JSON.parse(fs.readFileSync(latestRivenPath, "utf8")));
    } catch (error) {
      return sendJson(response, 500, { success: false, reason: `Unable to read riven diagnostic data: ${error.message}` });
    }
  }
  if (request.method === "POST" && request.url === "/audit") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        const data = JSON.parse(body);
        audit(`BROWSER_${String(data.event || "UNKNOWN")}`, String(data.detail || ""));
      } catch {
        audit("BROWSER_INVALID_AUDIT");
      }
      sendJson(response, 200, { success: true });
    });
    return;
  }
  if (request.method === "POST" && request.url === "/audit-riven-native") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        const data = JSON.parse(body);
        const diagnosticPath = path.join(
          outputDirectory,
          data && data.phase === "history-grade-readonly"
            ? "latest-riven-history-diagnostic.json"
            : data && data.phase === "chat-native-readonly"
              ? "latest-riven-chat-native-diagnostic.json"
              : "latest-riven-native-diagnostic.json"
        );
        fs.writeFileSync(diagnosticPath, JSON.stringify(data, null, 2), "utf8");
        audit("RIVEN_NATIVE_DIAGNOSTIC", String(data && data.weaponName || "unknown"));
        sendJson(response, 200, { success: true });
      } catch (error) {
        audit("RIVEN_NATIVE_DIAGNOSTIC_FAILED", error.message);
        sendJson(response, 400, { success: false, reason: error.message });
      }
    });
    return;
  }
  if (request.method === "POST" && request.url === "/clear-reward") {
    try {
      if (fs.existsSync(latestRewardPath)) fs.unlinkSync(latestRewardPath);
      audit("LATEST_REWARD_CLEARED");
      return sendJson(response, 200, { success: true });
    } catch (error) {
      audit("LATEST_REWARD_CLEAR_FAILED", error.message);
      return sendJson(response, 500, { success: false, reason: error.message });
    }
  }
  if (request.method === "POST" && request.url === "/clear-riven") {
    try {
      if (fs.existsSync(latestRivenPath)) fs.unlinkSync(latestRivenPath);
      audit("LATEST_RIVEN_CLEARED");
      return sendJson(response, 200, { success: true });
    } catch (error) {
      audit("LATEST_RIVEN_CLEAR_FAILED", error.message);
      return sendJson(response, 500, { success: false, reason: error.message });
    }
  }
  if (request.method === "POST" && request.url === "/publish-reward") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", () => {
      try {
        const data = JSON.parse(body);
        const saved = saveRewardNames(data && data.rewards, "browser");
        sendJson(response, saved ? 200 : 400, { success: saved });
      } catch {
        sendJson(response, 400, { success: false });
      }
    });
    return;
  }
  if (request.method === "POST" && request.url === "/capture") {
    return captureForegroundWarframe().then(async (capture) => {
      if (!capture.success || !capture.path) {
        audit("CAPTURE_SKIPPED", capture.reason || "Warframe is not foreground.");
        return sendJson(response, 200, capture);
      }
      audit("CAPTURE", capture.path);
      // The recommendation probe only needs one current-frame result. Retry
      // cycles delay opening the overlay and are not useful after a failed
      // landmark match; the next lightweight probe will capture a newer UI.
      const result = await processScreenshot(capture.path, false, 1);
      audit(result.success ? "MATCH" : "NO_MATCH", result.era || result.reason || "");
      return sendJson(response, 200, result);
    });
  }
  if (request.method === "POST" && request.url === "/capture-riven") {
    return captureRivenWithPaddle().then((result) => {
      audit(result.success ? "RIVEN_CAPTURE_DONE" : "RIVEN_CAPTURE_NO_RESULT", result.reason || "");
      return sendJson(response, 200, result);
    });
  }
  if (request.method === "POST" && request.url === "/process-riven") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      try {
        const data = JSON.parse(body);
        if (!data.path || typeof data.path !== "string" || !fs.existsSync(data.path)) {
          return sendJson(response, 400, { success: false, reason: "Riven screenshot path is invalid." });
        }
        audit("RIVEN_NATIVE_PROCESS", data.path);
        return sendJson(response, 200, await processRivenScreenshot(data.path));
      } catch (error) {
        return sendJson(response, 400, { success: false, reason: error.message });
      }
    });
    return;
  }
  if (request.method === "POST" && request.url === "/process-refinement") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      try {
        const data = JSON.parse(body);
        if (!data.path || typeof data.path !== "string" || !fs.existsSync(data.path)) {
          return sendJson(response, 400, { success: false, reason: "Refinement screenshot path is invalid." });
        }
        audit("REFINEMENT_NATIVE_PROCESS", data.path);
        const result = await processRefinementScreenshot(data.path);
        audit(result.success ? "REFINEMENT_NATIVE_MATCH" : "REFINEMENT_NATIVE_NO_MATCH", result.era || result.reason || "");
        return sendJson(response, 200, result);
      } catch (error) {
        return sendJson(response, 400, { success: false, reason: error.message });
      }
    });
    return;
  }
  if (request.method === "POST" && request.url === "/capture-reward") {
    return captureRewardWithPaddle().then((result) => {
      audit(result.success ? "REWARD_CAPTURE_DONE" : "REWARD_CAPTURE_NO_MATCH", result.reason || "");
      return sendJson(response, 200, result);
    });
  }
  if (request.method === "POST" && request.url === "/process-reward") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      try {
        const data = JSON.parse(body);
        if (!data.path || typeof data.path !== "string" || !fs.existsSync(data.path)) {
          return sendJson(response, 400, { success: false, reason: "Reward screenshot path is invalid." });
        }
        audit("REWARD_NATIVE_PROCESS", data.path);
        const result = await processScreenshot(data.path, true, 1, false);
        audit(result.success ? "REWARD_NATIVE_MATCH" : "REWARD_NATIVE_NO_MATCH", result.reason || "");
        return sendJson(response, 200, result);
      } catch (error) {
        return sendJson(response, 400, { success: false, reason: error.message });
      }
    });
    return;
  }
  if (request.method === "POST" && request.url === "/debug-process-reward") {
    let body = "";
    request.setEncoding("utf8");
    request.on("data", (chunk) => { body += chunk; });
    request.on("end", async () => {
      try {
        const data = JSON.parse(body);
        if (!data.path || typeof data.path !== "string" || !fs.existsSync(data.path)) {
          return sendJson(response, 400, { success: false, reason: "Reward screenshot path is invalid." });
        }
        const workerResult = await runPaddleWorker(data.path);
        const parsed = await resolvePaddleRewardsWithTitleCrops(workerResult, data.path);
        audit("PADDLE_REWARD_DEBUG", parsed ? parsed.replacements.join(" | ") : "no complete result");
        return sendJson(response, 200, {
          success: Boolean(parsed),
          parsed: parsed ? parsed.replacements : [],
          lines: Array.isArray(workerResult.lines) ? workerResult.lines : [],
          imageWidth: workerResult.imageWidth,
          imageHeight: workerResult.imageHeight
        });
      } catch (error) {
        return sendJson(response, 400, { success: false, reason: error.message });
      }
    });
    return;
  }
  if (request.method !== "POST" || request.url !== "/process") {
    return sendJson(response, 404, { success: false });
  }
  let body = "";
  request.setEncoding("utf8");
  request.on("data", (chunk) => { body += chunk; });
  request.on("end", async () => {
    try {
      const data = JSON.parse(body);
      if (!data.path || typeof data.path !== "string" || !fs.existsSync(data.path)) {
        audit("INVALID_PATH", String(data.path || ""));
        return sendJson(response, 400, { success: false, reason: "Screenshot path is invalid." });
      }
      audit("PROCESS", data.path);
      const result = await processScreenshot(data.path);
      audit(result.success ? "MATCH" : "NO_MATCH", result.era || result.reason || "");
      return sendJson(response, 200, result);
    } catch {
      audit("INVALID_REQUEST");
      return sendJson(response, 400, { success: false, reason: "Request format is invalid." });
    }
  });
});

server.listen(port, "127.0.0.1", () => {
  trimDiagnosticScreenshots();
  startPaddleWorker().catch(() => { });
  process.stdout.write(`AlecaFrame Chinese relic OCR listening on ${port}\n`);
});
