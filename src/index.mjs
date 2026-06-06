// ============================================================
// xo-server-tag-automation v0.7.8
// Tag-Based VM Automation Plugin for Xen Orchestra
//
// Changes in v0.7.8:
// - REMOVED: lastDailySummary field from configurationSchema
//        and DEFAULTS. The UI field is gone entirely.
// - RETAINED: All daily summary backend code unchanged --
//        writeDailySummary() still runs at midnight and
//        writes to logs/daily-summary.log on NFS share.
//        getDailySummary apiMethod still available via xo-cli.
//        writeDailySummaryNow apiMethod still available.
//        "Write Daily Summary" test() action still available.
//
// RETAINED from v0.7.7: All descriptions and UI changes
//   from the live GitHub repo (enablePermissionAutopilot
//   full description, tagSuffix, schedule, etc.)
// RETAINED from v0.7.6: Daily summary backend, midnight
//   scheduler, simplified Autopilot toggle.
// RETAINED from v0.7.3: All CSV/preload bug fixes.
// ============================================================

import { readFile, writeFile, mkdir, appendFile, rename } from "fs/promises";
import { existsSync, statSync } from "fs";
import { dirname, join, basename } from "path";

// ============================================================
// LOCKED FILENAMES -- controlled internally, not user-editable
// ============================================================
const FILE_CURRENT_VMS   = "current-vms.csv";
const FILE_PRELOAD_VMS   = "preload-vms.csv";
const FILE_LOG           = "xo-tag-automation.log";
const FILE_LOG_BACKUP    = "xo-tag-automation.log.1";
const FILE_SUMMARY_LOG   = "xo-tag-automation-summary.log";
const FILE_DAILY_SUMMARY = "daily-summary.log";
const LOG_MAX_BYTES      = 2 * 1024 * 1024; // 2MB rotation threshold

// ============================================================
// DEFAULTS -- lastDailySummary removed
// ============================================================
const DEFAULTS = {
  tagSuffix: "-v",
  enablePerformance: false,
  enablePermissions: false,
  enablePermissionAutopilot: false,
  schedule: "daily",
  dryRun: true,
  nfsSharePath: "/mnt/v0/code/tag-automation",
  stalenessWarnDays: 7,
  performanceTiers: {
    coreWeight: 2048,
    coreIoPri: 7,
    highWeight: 1024,
    highIoPri: 7,
    normalWeight: 512,
    normalIoPri: 5,
    lowWeight: 256,
    lowIoPri: 2,
  },
};

// ============================================================
// PATH HELPERS -- derive all paths from nfsSharePath
// ============================================================
function getCsvPath(config)          { return join(config.nfsSharePath, FILE_CURRENT_VMS); }
function getPreloadPath(config)      { return join(config.nfsSharePath, FILE_PRELOAD_VMS); }
function getLogPath(config)          { return join(config.nfsSharePath, "logs", FILE_LOG); }
function getLogBackupPath(config)    { return join(config.nfsSharePath, "logs", FILE_LOG_BACKUP); }
function getSummaryLogPath(config)   { return join(config.nfsSharePath, "logs", FILE_SUMMARY_LOG); }
function getDailySummaryPath(config) { return join(config.nfsSharePath, "logs", FILE_DAILY_SUMMARY); }

// ============================================================
// NFS FILE LOGGING
// ============================================================
let _logPath     = getLogPath(DEFAULTS);
let _summaryPath = getSummaryLogPath(DEFAULTS);
let _runSummary  = [];

async function rotateLogIfNeeded(logPath, backupPath) {
  try {
    if (existsSync(logPath)) {
      const stats = statSync(logPath);
      if (stats.size >= LOG_MAX_BYTES) {
        try {
          await rename(logPath, backupPath);
          const ts   = new Date().toISOString();
          const line = "[" + ts + "] [INFO] xo-tag-automation: Log rotated -- previous log saved as " +
                       basename(backupPath);
          await mkdir(dirname(logPath), { recursive: true });
          await appendFile(logPath, line + "\n", "utf8");
        } catch (err) {
          console.warn("[xo-tag-automation] Log rotation failed: " + err.message);
        }
      }
    }
  } catch (err) {
    console.warn("[xo-tag-automation] Could not check log size: " + err.message);
  }
}

async function writeToFile(filePath, line) {
  try {
    await mkdir(dirname(filePath), { recursive: true });
    await appendFile(filePath, line + "\n", "utf8");
  } catch (err) {
    console.warn("[xo-tag-automation] Could not write to log file: " + err.message);
  }
}

function logLine(level, message, isSummary) {
  const ts   = new Date().toISOString();
  const line = "[" + ts + "] [" + level + "] xo-tag-automation: " + message;
  if (level === "ERROR" || level === "WARN") {
    console.warn(line);
  } else {
    console.log(line);
  }
  writeToFile(_logPath, line);
  if (isSummary) {
    _runSummary.push(line);
    writeToFile(_summaryPath, line);
  }
}

function logInfo(msg, isSummary) { logLine("INFO", msg, isSummary || false); }
function logWarn(msg, isSummary) { logLine("WARN", msg, isSummary || false); }

function startRunSummary() {
  _runSummary = [];
  writeToFile(_summaryPath, "\n=== RUN START " + new Date().toISOString() + " ===");
}

function endRunSummary(results) {
  writeToFile(
    _summaryPath,
    "=== RUN END " + new Date().toISOString() + " -- " + results.join(" | ") + " ===\n"
  );
}

// ============================================================
// DAILY SUMMARY LOG -- v0.7.6
// Backend retained fully. UI field removed in v0.7.8.
// Written once per day at midnight by the midnight scheduler.
// Tallies total VM count and newly added VMs for that day.
// Format per line:
//   [YYYY-MM-DD] Total VMs: N | New VMs today: N | New VM names: name1, name2, ...
// ============================================================
async function writeDailySummary(config, xo) {
  const dailyPath = getDailySummaryPath(config);
  const date      = new Date().toISOString().slice(0, 10);
  try {
    const allVms   = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
    const totalVms = allVms.length;
    let newVmNames = [];
    const csvPath  = getCsvPath(config);
    if (existsSync(csvPath)) {
      try {
        const raw      = await readFile(csvPath, "utf8");
        const lines    = raw.split("\n").filter(function(l) { return l.trim() && !l.startsWith("#"); });
        const csvUuids = new Set();
        for (let i = 1; i < lines.length; i++) {
          const cols = parseCsvLine(lines[i]);
          if (cols[0]) csvUuids.add(cols[0].trim());
        }
        for (let i = 0; i < allVms.length; i++) {
          if (!csvUuids.has(allVms[i].uuid)) newVmNames.push(allVms[i].name_label);
        }
      } catch (err) {
        logWarn("Daily summary: could not read " + FILE_CURRENT_VMS + " for new VM detection: " + err.message);
      }
    }
    const newCount = newVmNames.length;
    const newNames = newCount > 0 ? newVmNames.join(", ") : "none";
    const line     = "[" + date + "] Total VMs: " + totalVms +
                     " | New VMs today: " + newCount +
                     " | New VM names: " + newNames;
    await mkdir(dirname(dailyPath), { recursive: true });
    await appendFile(dailyPath, line + "\n", "utf8");
    logInfo("Daily summary written -- " + line, true);
  } catch (err) {
    logWarn("Could not write daily summary: " + err.message);
  }
}

// ============================================================
// MIGRATION HELPER -- v0.7.0+
// ============================================================
async function migrateVmMetadataCsv(config) {
  const shareDir   = config.nfsSharePath;
  const legacyPath = join(shareDir, "vm_metadata.csv");
  const newPath    = join(shareDir, FILE_CURRENT_VMS);
  if (existsSync(legacyPath) && !existsSync(newPath)) {
    try {
      await rename(legacyPath, newPath);
      logWarn("MIGRATION: vm_metadata.csv detected -- automatically renamed to " + FILE_CURRENT_VMS + ".", true);
    } catch (err) {
      logWarn("MIGRATION: Could not rename vm_metadata.csv -> " + FILE_CURRENT_VMS + ": " + err.message);
    }
  } else if (existsSync(legacyPath) && existsSync(newPath)) {
    logWarn(
      "MIGRATION: Both vm_metadata.csv and " + FILE_CURRENT_VMS + " exist in " + shareDir + ". " +
      "Please manually verify and remove vm_metadata.csv when safe to do so."
    );
  }
}

// ============================================================
// VM FILTER -- v0.5.3 DEFENSIVE MULTI-GATE
// ============================================================
function isRealVm(vm) {
  if (!vm || !vm.uuid) return false;
  if (vm.$type !== undefined && vm.$type !== "VM") return false;
  if (vm.type  !== undefined && vm.type  !== "VM") return false;
  if (vm.is_a_template === true || vm.is_a_template === "true") return false;
  if (vm.is_control_domain) return false;
  if (!vm.name_label || !vm.name_label.trim()) return false;
  const name = vm.name_label.trim();
  if (name.startsWith("[XO Backup"))            return false;
  if (name.startsWith("[ESXI]"))                 return false;
  if (name.includes("import from V2V"))          return false;
  if (name === "complete import from V2V")       return false;
  if (name === "after complete import from V2V") return false;
  if (name === "after partial import from V2V")  return false;
  if (name === "base copy")                      return false;
  if (name.endsWith("-flat.vmdk"))               return false;
  if (name.endsWith("-sesparse.vmdk"))           return false;
  if (name.endsWith(".iso"))                     return false;
  if (name.startsWith("Xapi#"))                  return false;
  if (name.startsWith("Control domain on host")) return false;
  return true;
}

// ============================================================
// NOTES HELPER -- v0.5.4 FALLBACK CHAIN
// ============================================================
function getVmNotes(vm) {
  if (vm.name_description && vm.name_description.trim()) return vm.name_description.trim();
  if (vm.notes && vm.notes.trim()) return vm.notes.trim();
  if (vm.other_config) {
    const oc = vm.other_config;
    if (oc.notes       && oc.notes.trim())       return oc.notes.trim();
    if (oc.description && oc.description.trim()) return oc.description.trim();
  }
  return "";
}

// ============================================================
// KNOWN TAG PATTERNS
// ============================================================
const KNOWN_PERF_PATTERN = /^(0-core|1-high|2-normal|3-low)/i;
const KNOWN_PERM_PATTERN = /-(Admin|Operator|Viewer)$/i;

function isKnownTag(tag)      { return KNOWN_PERF_PATTERN.test(tag) || KNOWN_PERM_PATTERN.test(tag); }
function isPermissionTag(tag) { return KNOWN_PERM_PATTERN.test(tag); }

// ============================================================
// ROLE HELPER
// ============================================================
function getRoleFromTag(tag) {
  if (/-Admin$/i.test(tag))    return "admin";
  if (/-Operator$/i.test(tag)) return "operator";
  if (/-Viewer$/i.test(tag))   return "viewer";
  return null;
}

// ============================================================
// SAFE APPLY
// ============================================================
async function safeApply(dryRun, description, fn) {
  if (dryRun) { logInfo("[DRY-RUN] Would: " + description); return null; }
  try {
    const result = await fn();
    logInfo("[OK] " + description);
    return result !== undefined ? result : true;
  } catch (err) {
    logWarn("[FAIL] " + description + " -- " + err.message);
    return null;
  }
}

// ============================================================
// SLEEP HELPER
// ============================================================
function sleep(ms) {
  return new Promise(function(resolve) { setTimeout(resolve, ms); });
}

// ============================================================
// CSV HELPERS
// ============================================================
function parseCsvLine(line) {
  const result = [];
  let current  = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      inQuotes = !inQuotes;
    } else if (ch === "," && !inQuotes) {
      result.push(current.trim());
      current = "";
    } else {
      current += ch;
    }
  }
  result.push(current.trim());
  return result;
}

// Full RFC 4180 CSV parser -- handles quoted multi-line fields
function parseFullCsv(content) {
  const rows = [];
  const len  = content.length;
  let pos    = 0;
  while (pos < len) {
    const rowStart = pos;
    const cols     = [];
    let field      = "";
    let inQuotes   = false;
    while (pos < len) {
      const ch = content[pos];
      if (inQuotes) {
        if (ch === '"' && pos + 1 < len && content[pos + 1] === '"') {
          field += '"'; pos += 2;
        } else if (ch === '"') {
          inQuotes = false; pos++;
        } else {
          field += ch; pos++;
        }
      } else {
        if (ch === '"') {
          inQuotes = true; pos++;
        } else if (ch === ",") {
          cols.push(field.trim()); field = ""; pos++;
        } else if (ch === "\r" && pos + 1 < len && content[pos + 1] === "\n") {
          pos += 2; break;
        } else if (ch === "\n") {
          pos++; break;
        } else {
          field += ch; pos++;
        }
      }
    }
    cols.push(field.trim());
    const raw = content.slice(rowStart, pos).replace(/\r?\n$/, "");
    if (cols.length === 1 && cols[0] === "") continue;
    rows.push({ raw, cols });
  }
  return rows;
}

function quoteCsvField(val) {
  if (!val) return "";
  const s = String(val);
  if (s.includes(",") || s.includes('"') || s.includes("\n")) {
    return '"' + s.replace(/"/g, '""') + '"';
  }
  return s;
}

function parseTags(tagStr) {
  if (!tagStr || !tagStr.trim()) return [];
  return tagStr.split(/[;,]/).map(function(t) { return t.trim(); }).filter(Boolean);
}

function buildMetaHeader(vmCount, tagSuffix) {
  const date = new Date().toISOString().slice(0, 10);
  return "# Updated: " + date + " | VMs: " + vmCount + " | Pool: " + (tagSuffix || "generic");
}

function parseMetaHeader(line) {
  const dateMatch  = line.match(/Updated:\s*(\d{4}-\d{2}-\d{2})/);
  const countMatch = line.match(/VMs:\s*(\d+)/);
  return {
    date:    dateMatch  ? dateMatch[1]                : null,
    vmCount: countMatch ? parseInt(countMatch[1], 10) : null,
  };
}

// ============================================================
// CSV VALIDATION
// ============================================================
function validateCsvContent(content) {
  if (!content || !content.trim()) return { valid: false, error: "CSV content is empty." };
  const lines = content.split("\n").filter(function(l) { return l.trim(); });
  if (lines.length < 2) return { valid: false, error: "CSV must have at least a header row and one data row." };
  let headerLine = lines[0];
  if (headerLine.startsWith("#")) { headerLine = lines[1] || ""; }
  const expectedCols = ["UUID", "Name", "CurrentTags", "NewTags", "CurrentNotes", "NewNotes"];
  const headerCols   = headerLine.split(",").map(function(c) { return c.trim().replace(/"/g, ""); });
  for (let i = 0; i < expectedCols.length; i++) {
    if (headerCols.indexOf(expectedCols[i]) === -1) {
      return { valid: false, error: "Missing expected column: " + expectedCols[i] + ". Header found: " + headerLine };
    }
  }
  return { valid: true, rowCount: lines.length - (lines[0].startsWith("#") ? 2 : 1) };
}

// ============================================================
// CSV FRESHNESS CHECK
// ============================================================
function checkCsvFreshness(metaLine, liveVmCount, stalenessWarnDays) {
  if (!metaLine || !metaLine.startsWith("#")) {
    logWarn(FILE_CURRENT_VMS + " has no metadata header -- consider running Export CSV to refresh.");
    return;
  }
  const meta = parseMetaHeader(metaLine);
  if (meta.date) {
    const ageDays = Math.floor((new Date() - new Date(meta.date)) / (1000 * 60 * 60 * 24));
    if (ageDays > stalenessWarnDays) {
      logWarn(FILE_CURRENT_VMS + " may be stale -- last updated " + ageDays + " days ago (" + meta.date + ").", true);
    } else {
      logInfo("CSV freshness OK -- last updated " + ageDays + " day(s) ago (" + meta.date + ").");
    }
  }
  if (meta.vmCount !== null && liveVmCount > meta.vmCount) {
    logWarn(
      FILE_CURRENT_VMS + " may be missing VMs -- CSV has " + meta.vmCount + " VMs, " +
      "live pool has " + liveVmCount + " (" + (liveVmCount - meta.vmCount) + " new VM(s) detected).", true
    );
  }
}

// ============================================================
// PERFORMANCE MODULE
// ============================================================
async function enforcePerformance(xo, config) {
  const suffix = config.tagSuffix;
  const dryRun = config.dryRun;
  const t      = config.performanceTiers;
  logInfo("=== Performance Enforcement starting (suffix=" + suffix + ", dryRun=" + dryRun + ") ===", true);
  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  logInfo("Performance: " + allVms.length + " real VMs found after filter.");
  const tiers = [
    { tag: "0-core"   + suffix, weight: t.coreWeight,   ioPri: t.coreIoPri,   label: "CORE"   },
    { tag: "1-high"   + suffix, weight: t.highWeight,   ioPri: t.highIoPri,   label: "HIGH"   },
    { tag: "2-normal" + suffix, weight: t.normalWeight, ioPri: t.normalIoPri, label: "NORMAL" },
    { tag: "3-low"    + suffix, weight: t.lowWeight,    ioPri: t.lowIoPri,    label: "LOW"    },
  ];
  const counts = { CORE: 0, HIGH: 0, NORMAL: 0, LOW: 0, SKIPPED: 0 };
  for (let i = 0; i < allVms.length; i++) {
    const vm     = allVms[i];
    const vmTags = vm.tags || [];
    let matchedTier = null;
    for (let j = 0; j < tiers.length; j++) {
      for (let k = 0; k < vmTags.length; k++) {
        if (vmTags[k].toLowerCase() === tiers[j].tag.toLowerCase()) { matchedTier = tiers[j]; break; }
      }
      if (matchedTier) break;
    }
    if (!matchedTier) { counts.SKIPPED++; continue; }
    const vmRef = vm._xapiRef;
    await safeApply(
      dryRun,
      "Set " + matchedTier.label + " tier on VM \"" + vm.name_label + "\" (" + vm.uuid + ")" +
      " weight=" + matchedTier.weight + " ioPri=" + matchedTier.ioPri,
      async function() {
        const xapi = xo.getXapi(vm);
        try { await xapi.call("VM.remove_from_VCPUs_params", vmRef, "weight"); } catch (e) {}
        await xapi.call("VM.add_to_VCPUs_params", vmRef, "weight", String(matchedTier.weight));
        try { await xapi.call("VM.remove_from_other_config", vmRef, "sched-pri"); } catch (e) {}
        await xapi.call("VM.add_to_other_config", vmRef, "sched-pri", String(matchedTier.ioPri));
      }
    );
    counts[matchedTier.label]++;
  }
  logInfo(
    "=== Performance complete -- CORE:" + counts.CORE + " HIGH:" + counts.HIGH +
    " NORMAL:" + counts.NORMAL + " LOW:" + counts.LOW + " SKIPPED:" + counts.SKIPPED + " ===", true
  );
  return counts;
}

// ============================================================
// SHARED HELPER -- get or create a Group
// ============================================================
async function getOrCreateGroup(xo, groupName, dryRun) {
  let groupId = null;
  try {
    const allGroups = await xo.getAllGroups();
    for (let g = 0; g < allGroups.length; g++) {
      if (allGroups[g].name === groupName) { groupId = allGroups[g].id; logInfo("  Group \"" + groupName + "\" exists -- id=" + groupId); break; }
    }
  } catch (err) { logWarn("  Could not fetch groups: " + err.message); }
  if (!groupId) {
    logInfo("  Group \"" + groupName + "\" not found -- creating.");
    if (!dryRun) {
      try {
        const newGroup = await xo.createGroup({ name: groupName });
        groupId = (newGroup && newGroup.id) ? newGroup.id : newGroup;
        logInfo("  Group created -- id=" + groupId);
      } catch (err) { logWarn("  Could not create Group \"" + groupName + "\": " + err.message); }
    } else { logInfo("[DRY-RUN] Would: Create Group \"" + groupName + "\""); }
  }
  return groupId;
}

// ============================================================
// SHARED HELPER -- apply a single permission tag to a VM
// ============================================================
async function applyPermissionTag(xo, tag, vm, dryRun, counters) {
  const role    = getRoleFromTag(tag);
  const grpName = tag;
  if (!role) { logWarn("  Could not derive role from tag \"" + tag + "\" -- skipping."); counters.skipped++; return; }
  logInfo("  [PERM] Tag \"" + tag + "\" -> Group=\"" + grpName + "\" role=\"" + role + "\"");
  const groupId = await getOrCreateGroup(xo, grpName, dryRun);
  if (!groupId && !dryRun) { logWarn("  [PERM] No groupId for \"" + grpName + "\" -- skipping."); counters.skipped++; return; }
  if (groupId) counters.created++;
  if (!dryRun && groupId) {
    let success = false;
    try {
      await xo.addAcl(groupId, vm.id, role);
      logInfo("  [OK] ACL grant: Group \"" + grpName + "\" -> VM \"" + vm.name_label + "\" role=" + role);
      success = true; counters.aclsApplied++;
    } catch (err) {
      logWarn("  [PERM] addAcl(vm.id) failed: " + err.message);
      try {
        await xo.addAcl(groupId, vm.uuid, role);
        logInfo("  [OK] ACL grant via uuid: Group \"" + grpName + "\" -> VM \"" + vm.name_label + "\" role=" + role);
        success = true; counters.aclsApplied++;
      } catch (err2) { logWarn("  [PERM] addAcl(uuid) also failed: " + err2.message); }
    }
    if (!success) counters.skipped++;
  } else if (dryRun) {
    logInfo("[DRY-RUN] Would: addAcl(groupId=" + groupId + ", vmId=" + vm.id + ", role=" + role + ")");
  }
}

// ============================================================
// PERMISSIONS MODULE -- tag-driven, Run Now only
// ============================================================
async function enforcePermissions(xo, config) {
  const dryRun = config.dryRun;
  logWarn("=== SECURITY NOTICE: Permission Sync is running ===", true);
  logWarn("=== Ensure your NFS share is secured before proceeding ===");
  logInfo("=== Permission Sync starting (dryRun=" + dryRun + ") ===", true);
  const allVms   = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  const counters = { processed: 0, created: 0, aclsApplied: 0, skipped: 0 };
  for (let i = 0; i < allVms.length; i++) {
    const vm       = allVms[i];
    const liveVm   = xo.getObject(vm.id) || vm;
    const permTags = (liveVm.tags || []).filter(isPermissionTag);
    if (permTags.length === 0) continue;
    counters.processed++;
    logInfo("VM \"" + liveVm.name_label + "\" -- vm.id=" + liveVm.id + " vm.uuid=" + liveVm.uuid);
    logInfo("  Permission tags: " + permTags.join(", "));
    for (let j = 0; j < permTags.length; j++) { await applyPermissionTag(xo, permTags[j], liveVm, dryRun, counters); }
  }
  logInfo(
    "=== Permission Sync complete -- " + counters.processed + " VMs processed, " +
    counters.created + " Groups created, " + counters.aclsApplied + " ACL grants applied, " +
    counters.skipped + " skipped ===", true
  );
  return counters;
}

// ============================================================
// PERMISSION AUTOPILOT MODULE -- v0.7.6 SIMPLIFIED
// Controlled solely by enablePermissionAutopilot toggle.
// ============================================================
async function runPermissionAutopilot(xo, config) {
  if (!config.enablePermissionAutopilot) {
    logInfo("Permission Autopilot disabled -- skipping.");
    return "disabled";
  }
  logWarn("=== SECURITY NOTICE: Permission Autopilot is running (CSV-sourced) ===", true);
  await enforcePermissionsFromCsv(xo, config);
  return "done";
}

// ============================================================
// ENFORCE PERMISSIONS FROM CSV -- v0.7.3
// Source 1: current-vms.csv (CurrentTags col, matched by UUID)
// Source 2: preload-vms.csv (Tags col, matched by VM name)
// ============================================================
async function enforcePermissionsFromCsv(xo, config) {
  const dryRun      = config.dryRun;
  const csvPath     = getCsvPath(config);
  const preloadPath = getPreloadPath(config);
  logInfo("=== Permission Autopilot: enforcePermissionsFromCsv starting (dryRun=" + dryRun + ") ===", true);
  const allVms   = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  const vmByUuid = {};
  const vmByName = {};
  for (let i = 0; i < allVms.length; i++) {
    vmByUuid[allVms[i].uuid]       = allVms[i];
    vmByName[allVms[i].name_label] = allVms[i];
  }
  const counters = { processed: 0, created: 0, aclsApplied: 0, skipped: 0 };

  // Source 1: current-vms.csv
  if (existsSync(csvPath)) {
    let raw;
    try { raw = await readFile(csvPath, "utf8"); } catch (err) { logWarn("Autopilot: Could not read " + FILE_CURRENT_VMS + ": " + err.message); raw = null; }
    if (raw) {
      const lines   = raw.split("\n").filter(function(l) { return l.trim(); });
      let dataStart = 0;
      if (lines[0] && lines[0].startsWith("#")) dataStart = 1;
      dataStart++;
      for (let i = dataStart; i < lines.length; i++) {
        const cols     = parseCsvLine(lines[i]);
        if (!cols[0] || cols[0].startsWith("#")) continue;
        const uuid     = (cols[0] || "").trim();
        const permTags = parseTags((cols[2] || "").trim()).filter(isPermissionTag);
        if (permTags.length === 0) continue;
        const vm = vmByUuid[uuid];
        if (!vm) { logInfo("  Autopilot: UUID " + uuid + " not found in live pool -- skipping."); continue; }
        counters.processed++;
        logInfo("  Autopilot [CSV] VM \"" + vm.name_label + "\" -- perm tags: " + permTags.join(", "));
        for (let j = 0; j < permTags.length; j++) { await applyPermissionTag(xo, permTags[j], vm, dryRun, counters); }
      }
    }
  } else {
    logWarn("Autopilot: " + FILE_CURRENT_VMS + " not found at " + csvPath + " -- skipping source 1.");
  }

  // Source 2: preload-vms.csv
  if (existsSync(preloadPath)) {
    let raw;
    try { raw = await readFile(preloadPath, "utf8"); } catch (err) { logWarn("Autopilot: Could not read " + FILE_PRELOAD_VMS + ": " + err.message); raw = null; }
    if (raw) {
      const dataRows = parseFullCsv(raw).slice(1);
      for (let i = 0; i < dataRows.length; i++) {
        const cols     = dataRows[i].cols;
        const name     = (cols[0] || "").trim();
        const permTags = parseTags((cols[1] || "").trim()).filter(isPermissionTag);
        if (!name || permTags.length === 0) continue;
        const vm = vmByName[name];
        if (!vm) { logInfo("  Autopilot [Preload] VM \"" + name + "\" not yet in pool -- skipping."); continue; }
        counters.processed++;
        logInfo("  Autopilot [Preload] VM \"" + vm.name_label + "\" -- perm tags: " + permTags.join(", "));
        for (let j = 0; j < permTags.length; j++) { await applyPermissionTag(xo, permTags[j], vm, dryRun, counters); }
      }
    }
  } else {
    logInfo("Autopilot: " + FILE_PRELOAD_VMS + " not found -- skipping source 2.");
  }

  logInfo(
    "=== Permission Autopilot complete -- " + counters.processed + " VMs processed, " +
    counters.created + " Groups created, " + counters.aclsApplied + " ACL grants applied, " +
    counters.skipped + " skipped ===", true
  );
  return counters;
}

// ============================================================
// TAG CLEANUP MODULE
// ============================================================
async function cleanupTags(xo, config, csvRows) {
  const dryRun = config.dryRun;
  logInfo("=== Tag Cleanup starting (dryRun=" + dryRun + ") ===");
  const csvMap = {};
  for (let i = 0; i < csvRows.length; i++) {
    const row = csvRows[i];
    if (!row.uuid) continue;
    csvMap[row.uuid] = { csvTags: parseTags(row.currentTags), newTags: parseTags(row.newTags) };
  }
  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  let removed  = 0;
  for (let i = 0; i < allVms.length; i++) {
    const vm    = allVms[i];
    const entry = csvMap[vm.uuid];
    if (!entry) continue;
    const liveTags = vm.tags || [];
    for (let j = 0; j < liveTags.length; j++) {
      const liveTag = liveTags[j];
      if (!isKnownTag(liveTag)) continue;
      let inCsv = false;
      for (let k = 0; k < entry.csvTags.length; k++) { if (entry.csvTags[k].toLowerCase() === liveTag.toLowerCase()) { inCsv = true; break; } }
      if (inCsv) continue;
      let inNew = false;
      for (let k = 0; k < entry.newTags.length; k++) { if (entry.newTags[k].toLowerCase() === liveTag.toLowerCase()) { inNew = true; break; } }
      if (inNew) continue;
      const tagCopy = liveTag;
      const vmCopy  = vm;
      await safeApply(dryRun, "Remove tag \"" + tagCopy + "\" from VM \"" + vm.name_label + "\" (" + vm.uuid + ")", async function() {
        const xapi = xo.getXapi(vmCopy);
        await xapi.call("VM.remove_tags", vmCopy._xapiRef, tagCopy);
      });
      removed++;
    }
  }
  logInfo("=== Tag Cleanup complete -- " + removed + " tags removed ===");
  return removed;
}

// ============================================================
// APPLY TAGS TO VM
// ============================================================
async function applyTagsToVm(xo, vm, tagsToAdd, dryRun) {
  const liveTags = vm.tags || [];
  const applied  = [];
  const skipped  = [];
  for (let i = 0; i < tagsToAdd.length; i++) {
    const tag = tagsToAdd[i];
    let already = false;
    for (let j = 0; j < liveTags.length; j++) { if (liveTags[j].toLowerCase() === tag.toLowerCase()) { already = true; break; } }
    if (already) { logInfo("  Tag \"" + tag + "\" already on VM \"" + vm.name_label + "\" -- skipping"); skipped.push(tag); continue; }
    const tagCopy = tag;
    const vmCopy  = vm;
    await safeApply(dryRun, "Add tag \"" + tagCopy + "\" to VM \"" + vm.name_label + "\" (" + vm.uuid + ")", async function() {
      const xapi = xo.getXapi(vmCopy);
      await xapi.call("VM.add_tags", vmCopy._xapiRef, tagCopy);
    });
    applied.push(tag);
  }
  return { applied, skipped };
}

// ============================================================
// NOTES SYNC
// ============================================================
async function syncNotesToVm(xo, vm, newNotes, dryRun) {
  const currentNotes = getVmNotes(vm);
  if (newNotes === currentNotes) return;
  if (!newNotes && !currentNotes) return;
  const vmCopy = vm;
  await safeApply(dryRun, "Set name_description on VM \"" + vm.name_label + "\" to: " + newNotes, async function() {
    const xapi = xo.getXapi(vmCopy);
    await xapi.call("VM.set_name_description", vmCopy._xapiRef, newNotes || "");
  });
}

// ============================================================
// WRITE SINGLE VM ROW
// ============================================================
async function refreshSingleVmInCsv(xo, config, vm) {
  const csvPath = getCsvPath(config);
  if (!existsSync(csvPath)) { logWarn("  Preload: " + FILE_CURRENT_VMS + " not found -- skipping row refresh for \"" + vm.name_label + "\"."); return; }
  let raw;
  try { raw = await readFile(csvPath, "utf8"); } catch (err) { logWarn("  Preload: Could not read " + FILE_CURRENT_VMS + " for row refresh: " + err.message); return; }
  await sleep(500);
  const liveVm    = xo.getObject(vm.id) || vm;
  const liveTags  = (liveVm.tags || []).join(";");
  const liveNotes = getVmNotes(liveVm);
  const vmName    = (liveVm.name_label || "").replace(/,/g, " ");
  const newRow    = [liveVm.uuid, vmName, liveTags, "", liveNotes, ""].map(quoteCsvField).join(",");
  const lines     = raw.split("\n");
  let matched     = false;
  const updatedLines = lines.map(function(line) {
    if (!line.trim() || line.startsWith("#")) return line;
    const cols = parseCsvLine(line);
    if (cols[0] && cols[0].trim() === liveVm.uuid) { matched = true; return newRow; }
    return line;
  });
  if (!matched) { updatedLines.push(newRow); logInfo("  Preload: VM \"" + vm.name_label + "\" not in " + FILE_CURRENT_VMS + " -- appended new row."); }
  else { logInfo("  Preload: " + FILE_CURRENT_VMS + " row refreshed for VM \"" + vm.name_label + "\"."); }
  try { await writeFile(csvPath, updatedLines.join("\n"), "utf8"); } catch (err) { logWarn("  Preload: Could not write updated " + FILE_CURRENT_VMS + ": " + err.message); }
}

// ============================================================
// PRELOAD-VMS PRE-LOADER -- v0.7.3 FIXED
// ============================================================
async function processPreloadVms(xo, config, mainCsvRows) {
  const dryRun      = config.dryRun;
  const preloadPath = getPreloadPath(config);
  if (!existsSync(preloadPath)) { logInfo(FILE_PRELOAD_VMS + " not found at " + preloadPath + " -- skipping pre-loader."); return; }
  logInfo("=== Preload-VMs Pre-loader starting (dryRun=" + dryRun + ") ===");
  let raw;
  try { raw = await readFile(preloadPath, "utf8"); } catch (err) { logWarn("Could not read " + FILE_PRELOAD_VMS + ": " + err.message); return; }
  const allRows = parseFullCsv(raw);
  if (allRows.length < 2) { logInfo(FILE_PRELOAD_VMS + " is empty or header-only -- skipping."); return; }
  const headerText = allRows[0].raw;
  const dataRows   = allRows.slice(1);
  const allVms     = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  const vmByName   = {};
  for (let i = 0; i < allVms.length; i++) { vmByName[allVms[i].name_label] = allVms[i]; }
  const mainCsvByUuid = {};
  for (let i = 0; i < mainCsvRows.length; i++) { if (mainCsvRows[i].uuid) mainCsvByUuid[mainCsvRows[i].uuid] = mainCsvRows[i]; }
  const rowsToKeep = [];
  let processed = 0, alreadyDone = 0, duplicates = 0, pending = 0;
  for (let i = 0; i < dataRows.length; i++) {
    const cols     = dataRows[i].cols;
    const rawRow   = dataRows[i].raw;
    const name     = (cols[0] || "").trim();
    const tags     = (cols[1] || "").trim();
    const newNotes = (cols[2] || "").replace(/\r?\n/g, " ").trim();
    if (!name) continue;
    const vm = vmByName[name];
    if (!vm) { logInfo("  Preload: VM \"" + name + "\" not yet in pool -- will retry next run."); rowsToKeep.push(rawRow); pending++; continue; }
    const mainEntry = mainCsvByUuid[vm.uuid];
    if (mainEntry && parseTags(mainEntry.currentTags).length > 0) {
      logWarn("  Preload: VM \"" + name + "\" already in " + FILE_CURRENT_VMS + " with tags -- removing from " + FILE_PRELOAD_VMS + ".");
      duplicates++; continue;
    }
    const tagsToAdd = parseTags(tags);
    logInfo("  Preload: Processing VM \"" + name + "\" -- tags: " + tagsToAdd.join(", "));
    const result = await applyTagsToVm(xo, vm, tagsToAdd, dryRun);
    if (result.applied.length === 0 && result.skipped.length > 0) { logInfo("  Preload: VM \"" + name + "\" already had all tags -- marking as done."); alreadyDone++; }
    else { processed++; }
    if (newNotes) { await syncNotesToVm(xo, vm, newNotes, dryRun); }
    if (!dryRun) { await refreshSingleVmInCsv(xo, config, vm); }
    else { logInfo("[DRY-RUN] Would: refresh " + FILE_CURRENT_VMS + " row for VM \"" + name + "\""); }
  }
  const newContent = [headerText].concat(rowsToKeep).join("\n") + (rowsToKeep.length > 0 ? "\n" : "");
  if (!dryRun) {
    try { await writeFile(preloadPath, newContent, "utf8"); logInfo("  Preload: " + FILE_PRELOAD_VMS + " updated -- " + rowsToKeep.length + " row(s) remaining."); }
    catch (err) { logWarn("  Preload: Could not write " + FILE_PRELOAD_VMS + ": " + err.message); }
  } else { logInfo("[DRY-RUN] Would write " + rowsToKeep.length + " pending row(s) back to " + FILE_PRELOAD_VMS); }
  logInfo("=== Preload-VMs Pre-loader complete -- " + processed + " processed, " + alreadyDone + " already done, " + duplicates + " duplicates removed, " + pending + " pending ===");
}

// ============================================================
// CSV SYNC MODULE
// ============================================================
async function runCsvSync(xo, config) {
  const dryRun            = config.dryRun;
  const csvPath           = getCsvPath(config);
  const stalenessWarnDays = config.stalenessWarnDays;
  logInfo("=== CSV Sync starting (dryRun=" + dryRun + ", path=" + csvPath + ") ===", true);
  if (!existsSync(csvPath)) { logWarn(FILE_CURRENT_VMS + " not found at " + csvPath + " -- run Export CSV first.", true); return { error: "CSV not found" }; }
  let raw;
  try { raw = await readFile(csvPath, "utf8"); } catch (err) { logWarn("Could not read " + FILE_CURRENT_VMS + ": " + err.message); return { error: err.message }; }
  const lines = raw.split("\n").filter(function(l) { return l.trim(); });
  if (lines.length < 2) { logWarn(FILE_CURRENT_VMS + " appears empty -- run Export CSV first."); return { error: "CSV empty" }; }
  let metaLine  = null;
  let dataStart = 0;
  if (lines[0].startsWith("#")) { metaLine = lines[0]; dataStart = 1; }
  dataStart++;
  const csvRows = [];
  for (let i = dataStart; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (!cols[0] || cols[0].startsWith("#")) continue;
    csvRows.push({ uuid: cols[0] || "", name: cols[1] || "", currentTags: cols[2] || "", newTags: cols[3] || "", currentNotes: cols[4] || "", newNotes: cols[5] || "" });
  }
  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  logInfo("CSV Sync: " + allVms.length + " real VMs found after filter.");
  checkCsvFreshness(metaLine, allVms.length, stalenessWarnDays || 7);
  const vmByUuid = {};
  for (let i = 0; i < allVms.length; i++) { vmByUuid[allVms[i].uuid] = allVms[i]; }
  await cleanupTags(xo, config, csvRows);
  let tagsApplied = 0, notesUpdated = 0;
  for (let i = 0; i < csvRows.length; i++) {
    const row = csvRows[i];
    const vm  = vmByUuid[row.uuid];
    if (!vm) { logWarn("CSV row VM not found in pool (uuid=" + row.uuid + " name=" + row.name + ") -- skipping."); continue; }
    const newTags = parseTags(row.newTags);
    if (newTags.length > 0) { logInfo("Applying NewTags to VM \"" + vm.name_label + "\": " + newTags.join(", ")); const result = await applyTagsToVm(xo, vm, newTags, dryRun); tagsApplied += result.applied.length; }
    if (row.newNotes && row.newNotes.trim()) { await syncNotesToVm(xo, vm, row.newNotes.trim(), dryRun); notesUpdated++; }
  }
  await processPreloadVms(xo, config, csvRows);
  if (!dryRun) {
    logInfo("Cache settle delay: waiting 500ms after " + tagsApplied + " tag change(s) and " + notesUpdated + " note change(s) to propagate...");
    await sleep(500);
    await writeRefreshedCsv(xo, config, allVms);
  } else {
    logInfo("[DRY-RUN] Would rewrite " + FILE_CURRENT_VMS + " with refreshed CurrentTags, cleared NewTags, updated CurrentNotes, cleared NewNotes.");
  }
  logInfo("=== CSV Sync complete -- " + tagsApplied + " tags applied, " + notesUpdated + " notes updated ===", true);
  return { tagsApplied, notesUpdated };
}

// ============================================================
// WRITE REFRESHED CSV
// ============================================================
async function writeRefreshedCsv(xo, config, allVms) {
  const csvPath = getCsvPath(config);
  const rows    = [buildMetaHeader(allVms.length, config.tagSuffix), "UUID,Name,CurrentTags,NewTags,CurrentNotes,NewNotes"];
  for (let i = 0; i < allVms.length; i++) {
    const vm        = allVms[i];
    const liveVm    = xo.getObject(vm.id) || vm;
    const liveTags  = (liveVm.tags || []).join(";");
    const liveNotes = getVmNotes(liveVm);
    const name      = (liveVm.name_label || "").replace(/,/g, " ");
    rows.push([liveVm.uuid, name, liveTags, "", liveNotes, ""].map(quoteCsvField).join(","));
  }
  try {
    await mkdir(dirname(csvPath), { recursive: true });
    await writeFile(csvPath, rows.join("\n") + "\n", "utf8");
    logInfo(FILE_CURRENT_VMS + " refreshed -- " + allVms.length + " VMs written to " + csvPath);
  } catch (err) { logWarn("Could not write refreshed " + FILE_CURRENT_VMS + ": " + err.message); }
}

// ============================================================
// EXPORT CSV
// ============================================================
async function exportCsv(xo, config) {
  const dryRun  = config.dryRun;
  const csvPath = getCsvPath(config);
  logInfo("=== Export CSV starting (dryRun=" + dryRun + ", path=" + csvPath + ") ===", true);
  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  logInfo("Export: " + allVms.length + " real VMs found after filter.");
  const rows = [buildMetaHeader(allVms.length, config.tagSuffix), "UUID,Name,CurrentTags,NewTags,CurrentNotes,NewNotes"];
  for (let i = 0; i < allVms.length; i++) {
    const vm = allVms[i];
    rows.push([vm.uuid, (vm.name_label || "").replace(/,/g, " "), (vm.tags || []).join(";"), "", getVmNotes(vm), ""].map(quoteCsvField).join(","));
  }
  const output = rows.join("\n") + "\n";
  if (dryRun) { logInfo("[DRY-RUN] Would export " + allVms.length + " VMs to " + csvPath); return { exported: allVms.length, dryRun: true, path: csvPath }; }
  try {
    await mkdir(dirname(csvPath), { recursive: true });
    await writeFile(csvPath, output, "utf8");
    logInfo("=== Export CSV complete -- " + allVms.length + " VMs written to " + csvPath + " ===", true);
    return { exported: allVms.length, dryRun: false, path: csvPath };
  } catch (err) { logWarn("Export CSV failed: " + err.message); throw new Error("Export CSV failed: " + err.message); }
}

// ============================================================
// DOWNLOAD / UPLOAD CSV
// ============================================================
async function downloadCsv(config) {
  const csvPath = getCsvPath(config);
  if (!existsSync(csvPath)) throw new Error(FILE_CURRENT_VMS + " not found at: \"" + csvPath + "\". Run Export CSV first.");
  try {
    const content  = await readFile(csvPath, "utf8");
    const lines    = content.split("\n").filter(function(l) { return l.trim(); });
    const rowCount = lines.length - (lines[0].startsWith("#") ? 2 : 1);
    return "--- CSV CONTENT (" + rowCount + " VM rows) from \"" + csvPath + "\" ---\n\n" + content + "\n--- END OF CSV ---";
  } catch (err) { throw new Error("Could not read CSV: " + err.message); }
}

async function uploadCsv(config, rawContent) {
  const csvPath = getCsvPath(config);
  if (!rawContent || !rawContent.trim()) throw new Error("CSV content is empty -- nothing to upload.");
  const validation = validateCsvContent(rawContent);
  if (!validation.valid) throw new Error("CSV validation failed: " + validation.error);
  try {
    await mkdir(dirname(csvPath), { recursive: true });
    await writeFile(csvPath, rawContent.trim() + "\n", "utf8");
    return "Upload CSV complete. " + validation.rowCount + " VM rows written to \"" + csvPath + "\". Click Run Now to apply the changes.";
  } catch (err) { throw new Error("Could not upload CSV: " + err.message); }
}

// ============================================================
// SCHEDULER HELPER
// ============================================================
function getCron(schedule) {
  if (schedule === "hourly") return "0 * * * *";
  return "0 2 * * *";
}

// ============================================================
// CONFIGURATION SCHEMA -- v0.7.8
// lastDailySummary field REMOVED from UI.
// All other fields retained from live v0.7.7 GitHub source.
// ============================================================
export const configurationSchema = {
  type: "object",
  description:
    "IMPORTANT -- The 'Delete configuration' button resets all plugin settings to their defaults. " +
    "It does not delete any VMs, tags, groups, resource sets, or CSV files on your NFS share. " +
    "It is safe to use if you want to reset the plugin configuration.",
  properties: {
    tagSuffix: {
      type: "string", title: "Tag Suffix",
      description: "Pool-specific suffix , for granular control by pool (e.g. -v for POOL-V, -1 for POOL-1). Leave blank for generic.",
      default: "-v",
    },
    schedule: {
      type: "string", title: "Enforcement Schedule",
      description: "How often to run Performance, CSV Sync, and Permission Autopilot.",
      enum: ["hourly", "daily", "disabled"], default: "daily",
    },
    dryRun: {
      type: "boolean", title: "Dry-Run / Export-CSV",
      description:
        "When ON: previews all changes without applying them AND exports a fresh copy of all VM " +
        "metadata to your CSV file (NewTags and NewNotes columns will be blank and ready to fill in). " +
        "Check XO logs for full dry-run output. Turn OFF to apply changes for real.",
      default: true,
    },
    enablePerformance: {
      type: "boolean", title: "Enable Performance Sync",
      description: "Apply CPU weights and IO priorities based on VM performance tier tags (0-core, 1-high, 2-normal, 3-low).",
      default: false,
    },
    enablePermissions: {
      type: "boolean", title: "Enable Permission Sync",
      description:
        "Tags ending in -Admin / -Operator / -Viewer trigger group creation and ACL assignments. " +
        "IMPORTANT: Verify your NFS share is properly configured and secured before enabling.",
      default: false,
    },
    enablePermissionAutopilot: {
      type: "boolean", title: "Enable Permission Autopilot",
      description:
        "Automatically assigns permissions and performance settings using CSV files stored on a secure NFS share. " +
        "CURRENT-VMS.CSV: Contains existing VMs. To make changes, add performance and/or permission tags to the NewTags column. Changes are applied during the next Autopilot run. " +
        "PRELOAD-VMS.CSV: Used to predefine settings for VMs being added or migrated to XCP-ng. Autopilot monitors for matching VM names and automatically applies the specified NewTags and Notes when the VM is detected, then adds the VM to current-vms.csv for ongoing management. " +
        "Example: Set the NewTags value for VM My-VM1 to 2-normal-1;Dept1-Operator. On the next run, Autopilot will set the VM CPU weight to Normal and create (if needed) and assign the Dept1-Operator group with the appropriate VM permissions. " +
        "IMPORTANT: Verify that your NFS share is properly configured and secured before enabling this feature. " +
        "If you are not actively performing VM migrations or onboarding projects, Autopilot should be disabled until it is needed again.",
      default: false,
    },
    nfsSharePath: {
      type: "string", title: "NFS Share Path",
      description:
        "Base path to your NFS share directory. All plugin files are managed here automatically: " +
        FILE_CURRENT_VMS + ", " + FILE_PRELOAD_VMS + ", " +
        "logs/" + FILE_LOG + ", logs/" + FILE_SUMMARY_LOG + ", logs/" + FILE_DAILY_SUMMARY + ". " +
        "Main log auto-rotates at 2MB (one backup kept as " + FILE_LOG_BACKUP + ").",
      default: "/mnt/v0/code/tag-automation",
    },
    stalenessWarnDays: {
      type: "integer", title: "CSV Age Warning (days)",
      description: "Warn in logs if " + FILE_CURRENT_VMS + " has not been exported in this many days.",
      default: 7,
    },
    performanceTiers: {
      type: "object", title: "Performance Tier Settings",
      description: "CPU weights and IO priorities per tier.",
      properties: {
        coreWeight:   { type: "integer", title: "Core CPU Weight",    default: 2048 },
        coreIoPri:    { type: "integer", title: "Core IO Priority",   default: 7    },
        highWeight:   { type: "integer", title: "High CPU Weight",    default: 1024 },
        highIoPri:    { type: "integer", title: "High IO Priority",   default: 7    },
        normalWeight: { type: "integer", title: "Normal CPU Weight",  default: 512  },
        normalIoPri:  { type: "integer", title: "Normal IO Priority", default: 5    },
        lowWeight:    { type: "integer", title: "Low CPU Weight",     default: 256  },
        lowIoPri:     { type: "integer", title: "Low IO Priority",    default: 2    },
      },
    },
  },
  required: ["tagSuffix", "enablePerformance", "enablePermissions", "schedule", "nfsSharePath"],
};

// ============================================================
// DEFAULT EXPORT -- Plugin Factory
// ============================================================
export default function({ xo }) {
  let _config      = Object.assign({}, DEFAULTS);
  let _job         = null;
  let _midnightJob = null;
  _logPath         = getLogPath(DEFAULTS);
  _summaryPath     = getSummaryLogPath(DEFAULTS);

  logInfo("Plugin factory called -- xo context: " + (xo ? "YES" : "NO"));
  logWarn("SECURITY REMINDER: Ensure NFS share is secured before enabling Permissions or Autopilot.");

  function startScheduler() {
    if (_config.schedule === "disabled") { logInfo("Schedule disabled -- skipping."); return; }
    if (!xo.scheduler) { logWarn("xo.scheduler not available -- manual runs only."); return; }

    // Main enforcement job
    _job = xo.scheduler.createJob({
      name: "xo-tag-automation-enforcement",
      cron: getCron(_config.schedule),
      fn: async function() {
        logInfo("=== Scheduled run triggered ===", true);
        startRunSummary();
        await rotateLogIfNeeded(_logPath, getLogBackupPath(_config));
        if (_config.enablePerformance) await enforcePerformance(xo, _config);
        await runCsvSync(xo, _config);
        if (_config.enablePermissionAutopilot) await runPermissionAutopilot(xo, _config);
        endRunSummary(["scheduled"]);
      },
    });
    logInfo("Scheduler registered -- cron=" + getCron(_config.schedule));

    // Midnight daily summary job -- always runs at 00:00 regardless of main schedule
    _midnightJob = xo.scheduler.createJob({
      name: "xo-tag-automation-daily-summary",
      cron: "0 0 * * *",
      fn: async function() {
        logInfo("=== Daily summary job triggered (midnight) ===");
        await writeDailySummary(_config, xo);
      },
    });
    logInfo("Daily summary scheduler registered -- cron=0 0 * * *");
  }

  return {
    configure: function(rawConfig) {
      _config = Object.assign({}, DEFAULTS, rawConfig, {
        performanceTiers: Object.assign({}, DEFAULTS.performanceTiers, (rawConfig && rawConfig.performanceTiers) || {}),
      });
      _logPath     = getLogPath(_config);
      _summaryPath = getSummaryLogPath(_config);
      logInfo(
        "Configured -- suffix=" + _config.tagSuffix + " schedule=" + _config.schedule +
        " dryRun=" + _config.dryRun + " perf=" + _config.enablePerformance +
        " perms=" + _config.enablePermissions + " autopilot=" + _config.enablePermissionAutopilot +
        " nfsSharePath=" + _config.nfsSharePath
      );
    },

    load: async function() {
      logInfo("Plugin loading...");
      await migrateVmMetadataCsv(_config);
      if (xo.hooks) {
        xo.hooks.on("core started", function() { logInfo("Core started -- registering scheduler."); startScheduler(); });
        logInfo("Plugin loaded -- waiting for core started.");
      } else { startScheduler(); }
    },

    unload: async function() {
      if (_job)         { _job.stop();        _job         = null; logInfo("Scheduler stopped."); }
      if (_midnightJob) { _midnightJob.stop(); _midnightJob = null; logInfo("Daily summary scheduler stopped."); }
    },

    test: async function(params) {
      const action = (params && params.action) || "Run Now";
      const act    = action.trim();
      logInfo("=== test() dispatching action: \"" + act + "\" ===");

      if (act.startsWith("Run Now")) {
        logInfo("=== RUN NOW triggered from UI ===", true);
        startRunSummary();
        await rotateLogIfNeeded(_logPath, getLogBackupPath(_config));
        const results = [];

        if (_config.enablePerformance) { await enforcePerformance(xo, _config); results.push("performance: done"); }
        else { logInfo("Performance disabled -- skipping."); results.push("performance: disabled"); }

        const csvResult = await runCsvSync(xo, _config);
        results.push("csv-sync: " + (csvResult.error ? "error -- " + csvResult.error : "done"));

        const autopilotResult = await runPermissionAutopilot(xo, _config);
        results.push("autopilot: " + autopilotResult);

        if (_config.enablePermissions) { await enforcePermissions(xo, _config); results.push("permissions: done"); }
        else { logInfo("Permissions disabled -- skipping."); results.push("permissions: disabled"); }

        endRunSummary(results);
        return "Run Now complete -- " + results.join(" | ") + ". Check XO logs for full output.";
      }

      if (act.startsWith("Export CSV")) {
        const result = await exportCsv(xo, _config);
        if (result.dryRun) return "[DRY-RUN] Export CSV: would write " + result.exported + " VMs to \"" + result.path + "\".";
        return (
          "Export CSV complete -- " + result.exported + " VMs written to \"" + result.path + "\". " +
          "NewTags and NewNotes columns are blank and ready to fill in. " +
          "Open the CSV from your NFS share, make your edits, then use xo-cli uploadCsvApi to push it back."
        );
      }

      if (act.startsWith("Write Daily Summary")) {
        await writeDailySummary(_config, xo);
        return "Daily summary written to " + getDailySummaryPath(_config) + ". Check XO logs for details.";
      }

      throw new Error("Unknown action: \"" + act + "\". Please select a valid action from the dropdown.");
    },

    apiMethods: {
      getCsv: async function() {
        try { const csvPath = getCsvPath(_config); const content = await readFile(csvPath, "utf8"); return { content, path: csvPath }; }
        catch (err) { throw new Error("Could not read CSV: " + err.message); }
      },
      saveCsv: async function(params) {
        const content    = params && params.content;
        const validation = validateCsvContent(content);
        if (!validation.valid) throw new Error("CSV validation failed: " + validation.error);
        const csvPath = getCsvPath(_config);
        try {
          await mkdir(dirname(csvPath), { recursive: true });
          await writeFile(csvPath, content, "utf8");
          return { saved: true, path: csvPath, rowCount: validation.rowCount };
        } catch (err) { throw new Error("Could not save CSV: " + err.message); }
      },
      exportCsv:      async function()       { return await exportCsv(xo, _config); },
      refreshCsvNow:  async function() {
        const result = await exportCsv(xo, _config);
        return { message: "CSV refreshed -- " + result.exported + " VMs written to " + result.path, exported: result.exported, path: result.path, dryRun: result.dryRun };
      },
      downloadCsvApi: async function()       { return await downloadCsv(_config); },
      uploadCsvApi:   async function(params) { return await uploadCsv(_config, params && params.content); },
      getLog: async function(params) {
        const lines   = (params && params.lines) || 50;
        const logPath = getLogPath(_config);
        try { const content = await readFile(logPath, "utf8"); const allLines = content.split("\n"); return { content: allLines.slice(-lines).join("\n"), path: logPath, totalLines: allLines.length, showing: Math.min(lines, allLines.length) }; }
        catch (err) { throw new Error("Could not read log: " + err.message); }
      },
      getSummaryLog: async function(params) {
        const lines       = (params && params.lines) || 20;
        const summaryPath = getSummaryLogPath(_config);
        try { const content = await readFile(summaryPath, "utf8"); const allLines = content.split("\n"); return { content: allLines.slice(-lines).join("\n"), path: summaryPath, totalLines: allLines.length, showing: Math.min(lines, allLines.length) }; }
        catch (err) { throw new Error("Could not read summary log: " + err.message); }
      },
      getDailySummary: async function(params) {
        const lines     = (params && params.lines) || 30;
        const dailyPath = getDailySummaryPath(_config);
        try {
          if (!existsSync(dailyPath)) return { content: "(no daily summary yet -- will be written at midnight)", path: dailyPath, totalLines: 0, showing: 0 };
          const content  = await readFile(dailyPath, "utf8");
          const allLines = content.split("\n").filter(function(l) { return l.trim(); });
          const lastLine = allLines.length > 0 ? allLines[allLines.length - 1] : "(empty)";
          return { content: allLines.slice(-lines).join("\n"), lastEntry: lastLine, path: dailyPath, totalLines: allLines.length, showing: Math.min(lines, allLines.length) };
        } catch (err) { throw new Error("Could not read daily summary: " + err.message); }
      },
      writeDailySummaryNow: async function() {
        await writeDailySummary(_config, xo);
        return "Daily summary written to " + getDailySummaryPath(_config);
      },
      runSync: async function() { return await runCsvSync(xo, _config); },
      getFilePaths: async function() {
        return {
          nfsSharePath:    _config.nfsSharePath,
          currentVmsCsv:  getCsvPath(_config),
          preloadVmsCsv:  getPreloadPath(_config),
          logFile:         getLogPath(_config),
          logBackup:       getLogBackupPath(_config),
          summaryLog:      getSummaryLogPath(_config),
          dailySummaryLog: getDailySummaryPath(_config),
        };
      },
    },
  };
}
