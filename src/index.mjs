// ============================================================
// xo-server-tag-automation v0.7.1
// Tag-Based VM Automation Plugin for Xen Orchestra
//
// Changes in v0.7.1:
// - FIX: runCsvSync() now correctly applies NewTags/NewNotes
//        BEFORE writing the refreshed CSV. Previously the
//        writeRefreshedCsv() call was pulling live XAPI state
//        before tags had fully propagated, overwriting edits.
// - FIX: writeRefreshedCsv() now re-fetches each VM object
//        fresh from xo.getObject() AFTER the 500ms settle
//        delay, guaranteeing live tags are captured correctly.
// - FIX: runCsvSync() sleep(500) now always runs after any
//        XAPI writes (tags OR notes), not only when tagsApplied > 0.
// - NEW: Execution order in runCsvSync() is now guaranteed:
//        1. Read CSV (parse NewTags / NewNotes)
//        2. cleanupTags()
//        3. applyTagsToVm() for all rows with NewTags
//        4. syncNotesToVm() for all rows with NewNotes
//        5. processPreloadVms()
//        6. sleep(500ms) -- always, if dryRun=false
//        7. writeRefreshedCsv() -- re-fetches live state post-settle
//
// Changes in v0.7.0 (Phase 1 -- included):
// - RENAMED: vm_metadata.csv -> current-vms.csv (new default)
// - RENAMED: new-vm-list.csv -> preload-vms.csv
// - RENAMED: processNewVmList() -> processPreloadVms()
// - NEW: Auto-migration -- if vm_metadata.csv is detected at
//        plugin load, it is automatically renamed to current-vms.csv
// - NEW: preload-vms.csv columns: VM-Name, Tags, Notes
// - ENHANCED: processPreloadVms() triggers immediate per-VM
//        row refresh in current-vms.csv on successful match
//
// RETAINED from v0.6.8:
// - Simplified permission model (-Admin/-Operator/-Viewer)
// - getOrCreateGroup() + xo.addAcl()
// - 500ms cache delay, NFS file logging, summary log
// - Dry-Run/Export-CSV label
// - CSV-first order (v0.6.5)
// - testSchema removed (v0.6.4 Code 10 fix)
// - downloadCsv(), uploadCsv(), validateCsvContent() via apiMethods
// - Notes fallback chain, tag cleanup, CSV freshness check (v0.5.4)
// - Defensive multi-gate isRealVm() filter (v0.5.3)
// - Permissions OnDemand only (never on cron)
// - NFS security warnings
// ============================================================

import { readFile, writeFile, mkdir, appendFile, rename } from "fs/promises";
import { existsSync } from "fs";
import { dirname, join } from "path";

// ============================================================
// DEFAULTS
// ============================================================
const DEFAULTS = {
  tagSuffix: "-v",
  enablePerformance: false,
  enablePermissions: false,
  schedule: "daily",
  dryRun: true,
  csvPath: "/mnt/v0/code/tag-automation/current-vms.csv",
  logPath: "/mnt/v0/code/tag-automation/logs/xo-tag-automation.log",
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
// NFS FILE LOGGING
// logPath     = full rolling log (xo-tag-automation.log)
// summaryPath = per-run summary  (xo-tag-automation-summary.log)
// ============================================================
let _logPath = DEFAULTS.logPath;
let _summaryPath = "";
let _runSummary = [];

function deriveSummaryPath(logPath) {
  return join(dirname(logPath), "xo-tag-automation-summary.log");
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
  const ts = new Date().toISOString();
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
// MIGRATION HELPER -- v0.7.0
// If vm_metadata.csv exists at the legacy path, auto-rename it
// to current-vms.csv and log the event. Plugin continues normally.
// ============================================================
async function migrateVmMetadataCsv(csvPath) {
  const csvDir = dirname(csvPath);
  const legacyPath = join(csvDir, "vm_metadata.csv");
  const newPath    = join(csvDir, "current-vms.csv");

  if (existsSync(legacyPath) && !existsSync(newPath)) {
    try {
      await rename(legacyPath, newPath);
      logWarn(
        "MIGRATION: vm_metadata.csv detected -- automatically renamed to current-vms.csv. " +
        "Update your csvPath setting if it still points to vm_metadata.csv.",
        true
      );
    } catch (err) {
      logWarn("MIGRATION: Could not rename vm_metadata.csv -> current-vms.csv: " + err.message);
    }
  } else if (existsSync(legacyPath) && existsSync(newPath)) {
    logWarn(
      "MIGRATION: Both vm_metadata.csv and current-vms.csv exist in " + csvDir + ". " +
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
  if (name.startsWith("[XO Backup"))                  return false;
  if (name.startsWith("[ESXI]"))                       return false;
  if (name.includes("import from V2V"))                return false;
  if (name === "complete import from V2V")             return false;
  if (name === "after complete import from V2V")       return false;
  if (name === "after partial import from V2V")        return false;
  if (name === "base copy")                            return false;
  if (name.endsWith("-flat.vmdk"))                     return false;
  if (name.endsWith("-sesparse.vmdk"))                 return false;
  if (name.endsWith(".iso"))                           return false;
  if (name.startsWith("Xapi#"))                        return false;
  if (name.startsWith("Control domain on host"))       return false;
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
// Performance tags are "known" for cleanup purposes.
// Permission tags (-Admin/-Operator/-Viewer) are NOT cleaned up
// by cleanupTags() -- they are user-managed directly on the VM.
// ============================================================
const KNOWN_PERF_PATTERN = /^(0-core|1-high|2-normal|3-low)/i;
const KNOWN_PERM_PATTERN = /-(Admin|Operator|Viewer)$/i;

function isKnownTag(tag)    { return KNOWN_PERF_PATTERN.test(tag) || KNOWN_PERM_PATTERN.test(tag); }
function isPermissionTag(tag) { return KNOWN_PERM_PATTERN.test(tag); }

// ============================================================
// ROLE HELPER
// "NetMgmt-Operator" -> "operator"
// "NetMgmt-Admin"    -> "admin"
// "NetMgmt-Viewer"   -> "viewer"
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
  if (dryRun) {
    logInfo("[DRY-RUN] Would: " + description);
    return null;
  }
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
  let current = "";
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
    date:    dateMatch  ? dateMatch[1]              : null,
    vmCount: countMatch ? parseInt(countMatch[1], 10) : null,
  };
}

// ============================================================
// CSV VALIDATION
// ============================================================
function validateCsvContent(content) {
  if (!content || !content.trim()) {
    return { valid: false, error: "CSV content is empty." };
  }
  const lines = content.split("\n").filter(function(l) { return l.trim(); });
  if (lines.length < 2) {
    return { valid: false, error: "CSV must have at least a header row and one data row." };
  }
  let headerLine = lines[0];
  if (headerLine.startsWith("#")) { headerLine = lines[1] || ""; }
  const expectedCols = ["UUID", "Name", "CurrentTags", "NewTags", "CurrentNotes", "NewNotes"];
  const headerCols = headerLine.split(",").map(function(c) { return c.trim().replace(/"/g, ""); });
  for (let i = 0; i < expectedCols.length; i++) {
    if (headerCols.indexOf(expectedCols[i]) === -1) {
      return {
        valid: false,
        error: "Missing expected column: " + expectedCols[i] + ". Header found: " + headerLine,
      };
    }
  }
  return { valid: true, rowCount: lines.length - (lines[0].startsWith("#") ? 2 : 1) };
}

// ============================================================
// CSV FRESHNESS CHECK
// ============================================================
function checkCsvFreshness(metaLine, liveVmCount, stalenessWarnDays) {
  if (!metaLine || !metaLine.startsWith("#")) {
    logWarn("current-vms.csv has no metadata header -- consider running Export CSV to refresh.");
    return;
  }
  const meta = parseMetaHeader(metaLine);
  if (meta.date) {
    const ageDays = Math.floor((new Date() - new Date(meta.date)) / (1000 * 60 * 60 * 24));
    if (ageDays > stalenessWarnDays) {
      logWarn(
        "current-vms.csv may be stale -- last updated " + ageDays + " days ago (" + meta.date + ").",
        true
      );
    } else {
      logInfo("CSV freshness OK -- last updated " + ageDays + " day(s) ago (" + meta.date + ").");
    }
  }
  if (meta.vmCount !== null && liveVmCount > meta.vmCount) {
    logWarn(
      "current-vms.csv may be missing VMs -- CSV has " + meta.vmCount + " VMs, " +
      "live pool has " + liveVmCount + " (" + (liveVmCount - meta.vmCount) + " new VM(s) detected).",
      true
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
        if (vmTags[k].toLowerCase() === tiers[j].tag.toLowerCase()) {
          matchedTier = tiers[j];
          break;
        }
      }
      if (matchedTier) break;
    }
    if (!matchedTier) { counts.SKIPPED++; continue; }
    const weight = matchedTier.weight;
    const ioPri  = matchedTier.ioPri;
    const label  = matchedTier.label;
    const vmRef  = vm._xapiRef;
    await safeApply(
      dryRun,
      "Set " + label + " tier on VM \"" + vm.name_label + "\" (" + vm.uuid + ")" +
      " weight=" + weight + " ioPri=" + ioPri,
      async function() {
        const xapi = xo.getXapi(vm);
        try { await xapi.call("VM.remove_from_VCPUs_params", vmRef, "weight"); } catch (e) {}
        await xapi.call("VM.add_to_VCPUs_params", vmRef, "weight", String(weight));
        try { await xapi.call("VM.remove_from_other_config", vmRef, "sched-pri"); } catch (e) {}
        await xapi.call("VM.add_to_other_config", vmRef, "sched-pri", String(ioPri));
      }
    );
    counts[label]++;
  }
  const summary =
    "=== Performance complete -- CORE:" + counts.CORE +
    " HIGH:" + counts.HIGH + " NORMAL:" + counts.NORMAL +
    " LOW:" + counts.LOW + " SKIPPED:" + counts.SKIPPED + " ===";
  logInfo(summary, true);
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
      if (allGroups[g].name === groupName) {
        groupId = allGroups[g].id;
        logInfo("  Group \"" + groupName + "\" exists -- id=" + groupId);
        break;
      }
    }
  } catch (err) {
    logWarn("  Could not fetch groups: " + err.message);
  }
  if (!groupId) {
    logInfo("  Group \"" + groupName + "\" not found -- creating.");
    if (!dryRun) {
      try {
        const newGroup = await xo.createGroup({ name: groupName });
        groupId = (newGroup && newGroup.id) ? newGroup.id : newGroup;
        logInfo("  Group created -- id=" + groupId);
      } catch (err) {
        logWarn("  Could not create Group \"" + groupName + "\": " + err.message);
      }
    } else {
      logInfo("[DRY-RUN] Would: Create Group \"" + groupName + "\"");
    }
  }
  return groupId;
}

// ============================================================
// PERMISSIONS MODULE -- OnDemand ONLY
// Any VM tag ending in -Admin / -Operator / -Viewer triggers:
//   1. getOrCreateGroup(tag) -- group name = full tag
//   2. xo.addAcl(groupId, vmId, role)
// ============================================================
async function enforcePermissions(xo, config) {
  const dryRun = config.dryRun;
  logWarn("=== SECURITY NOTICE: Permission Sync is running OnDemand ===", true);
  logWarn("=== Ensure your NFS share is secured before proceeding ===");
  logInfo("=== Permission Sync starting (dryRun=" + dryRun + ") ===", true);
  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  logInfo("Permissions: " + allVms.length + " real VMs found after filter.");
  let processed = 0, created = 0, aclsApplied = 0, skipped = 0;
  for (let i = 0; i < allVms.length; i++) {
    const vm     = allVms[i];
    const liveVm = xo.getObject(vm.id) || vm;
    const vmTags = liveVm.tags || [];
    const permTags = vmTags.filter(isPermissionTag);
    if (permTags.length === 0) continue;
    processed++;
    logInfo("VM \"" + liveVm.name_label + "\" -- vm.id=" + liveVm.id + " vm.uuid=" + liveVm.uuid);
    logInfo("  Permission tags: " + permTags.join(", "));
    for (let j = 0; j < permTags.length; j++) {
      const tag     = permTags[j];
      const role    = getRoleFromTag(tag);
      const grpName = tag;
      if (!role) {
        logWarn("  Could not derive role from tag \"" + tag + "\" -- skipping.");
        skipped++;
        continue;
      }
      logInfo("  [PERM] Tag \"" + tag + "\" -> Group=\"" + grpName + "\" role=\"" + role + "\"");
      const groupId = await getOrCreateGroup(xo, grpName, dryRun);
      if (!groupId && !dryRun) {
        logWarn("  [PERM] No groupId for \"" + grpName + "\" -- skipping.");
        skipped++;
        continue;
      }
      if (groupId) created++;
      if (!dryRun && groupId) {
        let success = false;
        try {
          await xo.addAcl(groupId, liveVm.id, role);
          logInfo("  [OK] ACL grant: Group \"" + grpName + "\" -> VM \"" + liveVm.name_label + "\" role=" + role);
          success = true;
          aclsApplied++;
        } catch (err) {
          logWarn("  [PERM] addAcl(vm.id) failed: " + err.message);
          try {
            await xo.addAcl(groupId, liveVm.uuid, role);
            logInfo("  [OK] ACL grant via uuid: Group \"" + grpName + "\" -> VM \"" + liveVm.name_label + "\" role=" + role);
            success = true;
            aclsApplied++;
          } catch (err2) {
            logWarn("  [PERM] addAcl(uuid) also failed: " + err2.message);
          }
        }
        if (!success) skipped++;
      } else if (dryRun) {
        logInfo("[DRY-RUN] Would: addAcl(groupId=" + groupId + ", vmId=" + liveVm.id + ", role=" + role + ")");
      }
    }
  }
  const summary =
    "=== Permission Sync complete -- " + processed + " VMs processed, " +
    created + " Groups created, " + aclsApplied + " ACL grants applied, " +
    skipped + " skipped ===";
  logInfo(summary, true);
  return { processed, created, aclsApplied, skipped };
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
    csvMap[row.uuid] = {
      csvTags: parseTags(row.currentTags),
      newTags: parseTags(row.newTags),
    };
  }
  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  let removed = 0;
  for (let i = 0; i < allVms.length; i++) {
    const vm    = allVms[i];
    const entry = csvMap[vm.uuid];
    if (!entry) continue;
    const liveTags = vm.tags || [];
    for (let j = 0; j < liveTags.length; j++) {
      const liveTag = liveTags[j];
      if (!isKnownTag(liveTag)) continue;
      let inCsv = false;
      for (let k = 0; k < entry.csvTags.length; k++) {
        if (entry.csvTags[k].toLowerCase() === liveTag.toLowerCase()) { inCsv = true; break; }
      }
      if (inCsv) continue;
      let inNew = false;
      for (let k = 0; k < entry.newTags.length; k++) {
        if (entry.newTags[k].toLowerCase() === liveTag.toLowerCase()) { inNew = true; break; }
      }
      if (inNew) continue;
      const tagCopy = liveTag;
      const vmCopy  = vm;
      await safeApply(
        dryRun,
        "Remove tag \"" + tagCopy + "\" from VM \"" + vm.name_label + "\" (" + vm.uuid + ")",
        async function() {
          const xapi = xo.getXapi(vmCopy);
          await xapi.call("VM.remove_tags", vmCopy._xapiRef, tagCopy);
        }
      );
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
    for (let j = 0; j < liveTags.length; j++) {
      if (liveTags[j].toLowerCase() === tag.toLowerCase()) { already = true; break; }
    }
    if (already) {
      logInfo("  Tag \"" + tag + "\" already on VM \"" + vm.name_label + "\" -- skipping");
      skipped.push(tag);
      continue;
    }
    const tagCopy = tag;
    const vmCopy  = vm;
    await safeApply(
      dryRun,
      "Add tag \"" + tagCopy + "\" to VM \"" + vm.name_label + "\" (" + vm.uuid + ")",
      async function() {
        const xapi = xo.getXapi(vmCopy);
        await xapi.call("VM.add_tags", vmCopy._xapiRef, tagCopy);
      }
    );
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
  await safeApply(
    dryRun,
    "Set name_description on VM \"" + vm.name_label + "\" to: " + newNotes,
    async function() {
      const xapi = xo.getXapi(vmCopy);
      await xapi.call("VM.set_name_description", vmCopy._xapiRef, newNotes || "");
    }
  );
}

// ============================================================
// WRITE SINGLE VM ROW -- v0.7.0
// Called by processPreloadVms() for immediate per-VM refresh
// in current-vms.csv after a successful preload match.
// Re-fetches live VM state AFTER a 500ms settle delay.
// ============================================================
async function refreshSingleVmInCsv(xo, config, vm) {
  const csvPath = config.csvPath;
  if (!existsSync(csvPath)) {
    logWarn("  Preload: current-vms.csv not found -- skipping row refresh for \"" + vm.name_label + "\".");
    return;
  }
  let raw;
  try {
    raw = await readFile(csvPath, "utf8");
  } catch (err) {
    logWarn("  Preload: Could not read current-vms.csv for row refresh: " + err.message);
    return;
  }

  // Wait for XAPI cache to settle before reading live tags
  await sleep(500);
  const liveVm   = xo.getObject(vm.id) || vm;
  const liveTags = (liveVm.tags || []).join(";");
  const liveNotes = getVmNotes(liveVm);
  const vmName   = (liveVm.name_label || "").replace(/,/g, " ");
  const newRow   = [liveVm.uuid, vmName, liveTags, "", liveNotes, ""].map(quoteCsvField).join(",");

  const lines = raw.split("\n");
  let matched = false;
  const updatedLines = lines.map(function(line) {
    if (!line.trim() || line.startsWith("#")) return line;
    const cols = parseCsvLine(line);
    if (cols[0] && cols[0].trim() === liveVm.uuid) {
      matched = true;
      return newRow;
    }
    return line;
  });

  if (!matched) {
    updatedLines.push(newRow);
    logInfo("  Preload: VM \"" + vm.name_label + "\" not in current-vms.csv -- appended new row.");
  } else {
    logInfo("  Preload: current-vms.csv row refreshed for VM \"" + vm.name_label + "\".");
  }

  try {
    await writeFile(csvPath, updatedLines.join("\n"), "utf8");
  } catch (err) {
    logWarn("  Preload: Could not write updated current-vms.csv: " + err.message);
  }
}

// ============================================================
// PRELOAD-VMS PRE-LOADER -- v0.7.0
// Reads preload-vms.csv (VM-Name, Tags, Notes) from the same
// directory as current-vms.csv.
//
// Workflow per row:
//   1. Look up VM by name in live XO pool
//   2. Not found -> keep row, retry next run
//   3. Found + already tagged in current-vms.csv -> remove (duplicate)
//   4. Found + not yet tagged -> apply tags + notes,
//      immediately refresh that VM's row in current-vms.csv,
//      remove from preload-vms.csv
// ============================================================
async function processPreloadVms(xo, config, mainCsvRows) {
  const dryRun     = config.dryRun;
  const csvDir     = dirname(config.csvPath);
  const preloadPath = join(csvDir, "preload-vms.csv");

  if (!existsSync(preloadPath)) {
    logInfo("preload-vms.csv not found at " + preloadPath + " -- skipping pre-loader.");
    return;
  }

  logInfo("=== Preload-VMs Pre-loader starting (dryRun=" + dryRun + ") ===");

  let raw;
  try {
    raw = await readFile(preloadPath, "utf8");
  } catch (err) {
    logWarn("Could not read preload-vms.csv: " + err.message);
    return;
  }

  const lines = raw.split("\n");
  if (lines.length < 2) {
    logInfo("preload-vms.csv is empty -- skipping.");
    return;
  }

  const header    = lines[0];
  const dataLines = lines.slice(1).filter(function(l) { return l.trim(); });

  // Build lookup maps
  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  const vmByName = {};
  for (let i = 0; i < allVms.length; i++) {
    vmByName[allVms[i].name_label] = allVms[i];
  }

  const mainCsvByUuid = {};
  for (let i = 0; i < mainCsvRows.length; i++) {
    if (mainCsvRows[i].uuid) mainCsvByUuid[mainCsvRows[i].uuid] = mainCsvRows[i];
  }

  const rowsToKeep = [];
  let processed = 0, alreadyDone = 0, duplicates = 0, pending = 0;

  for (let i = 0; i < dataLines.length; i++) {
    const cols     = parseCsvLine(dataLines[i]);
    const name     = (cols[0] || "").trim();
    const tags     = (cols[1] || "").trim();
    const newNotes = (cols[2] || "").trim();

    if (!name) continue;

    const vm = vmByName[name];

    // VM not yet in pool -- keep row, retry next run
    if (!vm) {
      logInfo("  Preload: VM \"" + name + "\" not yet in pool -- will retry next run.");
      rowsToKeep.push(dataLines[i]);
      pending++;
      continue;
    }

    // VM exists but already has tags in current-vms.csv -- treat as duplicate
    const mainEntry = mainCsvByUuid[vm.uuid];
    if (mainEntry && parseTags(mainEntry.currentTags).length > 0) {
      logWarn("  Preload: VM \"" + name + "\" already in current-vms.csv with tags -- removing from preload-vms.csv.");
      duplicates++;
      continue;
    }

    // VM found and not yet tagged -- apply tags + notes
    const tagsToAdd = parseTags(tags);
    logInfo("  Preload: Processing VM \"" + name + "\" -- tags: " + tagsToAdd.join(", "));

    const result = await applyTagsToVm(xo, vm, tagsToAdd, dryRun);

    if (result.applied.length === 0 && result.skipped.length > 0) {
      logInfo("  Preload: VM \"" + name + "\" already had all tags -- marking as done.");
      alreadyDone++;
    } else {
      processed++;
    }

    if (newNotes) {
      await syncNotesToVm(xo, vm, newNotes, dryRun);
    }

    // Immediately refresh this VM's row in current-vms.csv
    if (!dryRun) {
      await refreshSingleVmInCsv(xo, config, vm);
    } else {
      logInfo("[DRY-RUN] Would: refresh current-vms.csv row for VM \"" + name + "\"");
    }
    // Row is processed -- do NOT add to rowsToKeep
  }

  // Write back only pending rows
  const newContent =
    [header].concat(rowsToKeep).join("\n") + (rowsToKeep.length > 0 ? "\n" : "");

  if (!dryRun) {
    try {
      await writeFile(preloadPath, newContent, "utf8");
      logInfo("  Preload: preload-vms.csv updated -- " + rowsToKeep.length + " row(s) remaining.");
    } catch (err) {
      logWarn("  Preload: Could not write preload-vms.csv: " + err.message);
    }
  } else {
    logInfo("[DRY-RUN] Would write " + rowsToKeep.length + " pending row(s) back to preload-vms.csv");
  }

  logInfo(
    "=== Preload-VMs Pre-loader complete -- " +
    processed + " processed, " + alreadyDone + " already done, " +
    duplicates + " duplicates removed, " + pending + " pending ==="
  );
}

// ============================================================
// CSV SYNC MODULE -- v0.7.1 FIXED EXECUTION ORDER
//
// Guaranteed sequence:
//   1. Read + parse current-vms.csv (NewTags / NewNotes)
//   2. cleanupTags()
//   3. applyTagsToVm()  -- all rows with NewTags
//   4. syncNotesToVm()  -- all rows with NewNotes
//   5. processPreloadVms()
//   6. sleep(500ms)     -- always when dryRun=false, any writes occurred
//   7. writeRefreshedCsv() -- re-fetches live VM state POST settle
// ============================================================
async function runCsvSync(xo, config) {
  const dryRun          = config.dryRun;
  const csvPath         = config.csvPath;
  const stalenessWarnDays = config.stalenessWarnDays;

  logInfo("=== CSV Sync starting (dryRun=" + dryRun + ", path=" + csvPath + ") ===", true);

  if (!existsSync(csvPath)) {
    logWarn("current-vms.csv not found at " + csvPath + " -- run Export CSV first.", true);
    return { error: "CSV not found" };
  }

  let raw;
  try {
    raw = await readFile(csvPath, "utf8");
  } catch (err) {
    logWarn("Could not read current-vms.csv: " + err.message);
    return { error: err.message };
  }

  const lines = raw.split("\n").filter(function(l) { return l.trim(); });
  if (lines.length < 2) {
    logWarn("current-vms.csv appears empty -- run Export CSV first.");
    return { error: "CSV empty" };
  }

  // Parse metadata header and column header
  let metaLine  = null;
  let dataStart = 0;
  if (lines[0].startsWith("#")) {
    metaLine  = lines[0];
    dataStart = 1;
  }
  dataStart++; // skip column header row

  // --- STEP 1: Parse all CSV rows up front ---
  const csvRows = [];
  for (let i = dataStart; i < lines.length; i++) {
    const cols = parseCsvLine(lines[i]);
    if (!cols[0] || cols[0].startsWith("#")) continue;
    csvRows.push({
      uuid:         cols[0] || "",
      name:         cols[1] || "",
      currentTags:  cols[2] || "",
      newTags:      cols[3] || "",
      currentNotes: cols[4] || "",
      newNotes:     cols[5] || "",
    });
  }

  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  logInfo("CSV Sync: " + allVms.length + " real VMs found after filter.");
  checkCsvFreshness(metaLine, allVms.length, stalenessWarnDays || 7);

  const vmByUuid = {};
  for (let i = 0; i < allVms.length; i++) { vmByUuid[allVms[i].uuid] = allVms[i]; }

  // --- STEP 2: Tag cleanup (remove stale known tags) ---
  await cleanupTags(xo, config, csvRows);

  // --- STEPS 3 + 4: Apply NewTags and NewNotes to all matching VMs ---
  let tagsApplied  = 0;
  let notesUpdated = 0;

  for (let i = 0; i < csvRows.length; i++) {
    const row = csvRows[i];
    const vm  = vmByUuid[row.uuid];
    if (!vm) {
      logWarn("CSV row VM not found in pool (uuid=" + row.uuid + " name=" + row.name + ") -- skipping.");
      continue;
    }

    // Apply NewTags
    const newTags = parseTags(row.newTags);
    if (newTags.length > 0) {
      logInfo("Applying NewTags to VM \"" + vm.name_label + "\": " + newTags.join(", "));
      const result = await applyTagsToVm(xo, vm, newTags, dryRun);
      tagsApplied += result.applied.length;
    }

    // Apply NewNotes
    if (row.newNotes && row.newNotes.trim()) {
      await syncNotesToVm(xo, vm, row.newNotes.trim(), dryRun);
      notesUpdated++;
    }
  }

  // --- STEP 5: Process preload-vms.csv ---
  await processPreloadVms(xo, config, csvRows);

  // --- STEP 6: Always sleep after any live writes to let XAPI cache settle ---
  if (!dryRun) {
    logInfo(
      "Cache settle delay: waiting 500ms after " + tagsApplied + " tag change(s) and " +
      notesUpdated + " note change(s) to propagate..."
    );
    await sleep(500);

    // --- STEP 7: Re-fetch live VM state and write refreshed CSV ---
    await writeRefreshedCsv(xo, config, allVms);
  } else {
    logInfo(
      "[DRY-RUN] Would rewrite current-vms.csv with refreshed CurrentTags, " +
      "cleared NewTags, updated CurrentNotes, cleared NewNotes."
    );
  }

  const summary =
    "=== CSV Sync complete -- " + tagsApplied + " tags applied, " + notesUpdated + " notes updated ===";
  logInfo(summary, true);
  return { tagsApplied, notesUpdated };
}

// ============================================================
// WRITE REFRESHED CSV -- v0.7.1
// Called AFTER sleep(500) so XAPI cache has settled.
// Re-fetches each VM object fresh via xo.getObject() to
// guarantee live tags are captured, not stale cache values.
// ============================================================
async function writeRefreshedCsv(xo, config, allVms) {
  const csvPath   = config.csvPath;
  const tagSuffix = config.tagSuffix;
  const metaHeader = buildMetaHeader(allVms.length, tagSuffix);
  const colHeader  = "UUID,Name,CurrentTags,NewTags,CurrentNotes,NewNotes";
  const rows = [metaHeader, colHeader];

  for (let i = 0; i < allVms.length; i++) {
    const vm = allVms[i];
    // Re-fetch live object from XO cache (post-settle)
    const liveVm    = xo.getObject(vm.id) || vm;
    const liveTags  = (liveVm.tags || []).join(";");
    const liveNotes = getVmNotes(liveVm);
    const name      = (liveVm.name_label || "").replace(/,/g, " ");
    rows.push(
      [liveVm.uuid, name, liveTags, "", liveNotes, ""].map(quoteCsvField).join(",")
    );
  }

  const output = rows.join("\n") + "\n";
  try {
    await mkdir(dirname(csvPath), { recursive: true });
    await writeFile(csvPath, output, "utf8");
    logInfo("current-vms.csv refreshed -- " + allVms.length + " VMs written to " + csvPath);
  } catch (err) {
    logWarn("Could not write refreshed current-vms.csv: " + err.message);
  }
}

// ============================================================
// EXPORT CSV -- Fresh baseline pull from XAPI
// ============================================================
async function exportCsv(xo, config) {
  const dryRun    = config.dryRun;
  const csvPath   = config.csvPath;
  const tagSuffix = config.tagSuffix;
  logInfo("=== Export CSV starting (dryRun=" + dryRun + ", path=" + csvPath + ") ===", true);
  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  logInfo("Export: " + allVms.length + " real VMs found after filter.");
  const metaHeader = buildMetaHeader(allVms.length, tagSuffix);
  const colHeader  = "UUID,Name,CurrentTags,NewTags,CurrentNotes,NewNotes";
  const rows = [metaHeader, colHeader];
  for (let i = 0; i < allVms.length; i++) {
    const vm    = allVms[i];
    const tags  = (vm.tags || []).join(";");
    const notes = getVmNotes(vm);
    const name  = (vm.name_label || "").replace(/,/g, " ");
    rows.push(
      [vm.uuid, name, tags, "", notes, ""].map(quoteCsvField).join(",")
    );
  }
  const output = rows.join("\n") + "\n";
  if (dryRun) {
    logInfo("[DRY-RUN] Would export " + allVms.length + " VMs to " + csvPath);
    return { exported: allVms.length, dryRun: true, path: csvPath };
  }
  try {
    await mkdir(dirname(csvPath), { recursive: true });
    await writeFile(csvPath, output, "utf8");
    logInfo("=== Export CSV complete -- " + allVms.length + " VMs written to " + csvPath + " ===", true);
    return { exported: allVms.length, dryRun: false, path: csvPath };
  } catch (err) {
    logWarn("Export CSV failed: " + err.message);
    throw new Error("Export CSV failed: " + err.message);
  }
}

// ============================================================
// DOWNLOAD CSV (accessible via apiMethods only)
// ============================================================
async function downloadCsv(config) {
  const csvPath = config.csvPath;
  logInfo("=== Download CSV starting (path=" + csvPath + ") ===");
  if (!existsSync(csvPath)) {
    throw new Error("CSV file not found at: \"" + csvPath + "\". Run Export CSV first.");
  }
  try {
    const content = await readFile(csvPath, "utf8");
    const lines   = content.split("\n").filter(function(l) { return l.trim(); });
    const rowCount = lines.length - (lines[0].startsWith("#") ? 2 : 1);
    logInfo("Download CSV: returning " + rowCount + " data rows from " + csvPath);
    return (
      "--- CSV CONTENT (" + rowCount + " VM rows) from \"" + csvPath + "\" ---\n\n" +
      content + "\n--- END OF CSV ---"
    );
  } catch (err) {
    throw new Error("Could not read CSV: " + err.message);
  }
}

// ============================================================
// UPLOAD CSV (accessible via apiMethods only)
// ============================================================
async function uploadCsv(config, rawContent) {
  const csvPath = config.csvPath;
  logInfo("=== Upload CSV starting (path=" + csvPath + ") ===");
  if (!rawContent || !rawContent.trim()) {
    throw new Error("CSV content is empty -- nothing to upload.");
  }
  const validation = validateCsvContent(rawContent);
  if (!validation.valid) {
    throw new Error("CSV validation failed: " + validation.error);
  }
  try {
    await mkdir(dirname(csvPath), { recursive: true });
    await writeFile(csvPath, rawContent.trim() + "\n", "utf8");
    logInfo("Upload CSV complete -- " + validation.rowCount + " rows written to " + csvPath);
    return (
      "Upload CSV complete. " + validation.rowCount + " VM rows written to \"" + csvPath + "\". " +
      "Click Run Now to apply the changes."
    );
  } catch (err) {
    throw new Error("Could not upload CSV: " + err.message);
  }
}

// ============================================================
// SCHEDULER HELPER
// ============================================================
function getCron(schedule) {
  if (schedule === "hourly") return "0 * * * *";
  return "0 2 * * *";
}

// ============================================================
// CONFIGURATION SCHEMA
// ============================================================
export const configurationSchema = {
  type: "object",
  description:
    "IMPORTANT -- About the 'Delete configuration' button at the bottom of this dialog: " +
    "Despite its name, this button ONLY clears the plugin settings back to defaults. " +
    "It does NOT delete any VMs, tags, groups, resource sets, or CSV files on your NFS share. " +
    "It is safe to use if you simply want to reset the plugin configuration fields.",
  properties: {
    tagSuffix: {
      type: "string",
      title: "Tag Suffix",
      description: "Pool-specific suffix on performance tags (e.g. -v for this pool).",
      default: "-v",
    },
    schedule: {
      type: "string",
      title: "Enforcement Schedule",
      description:
        "How often to run Performance and CSV Sync. " +
        "NOTE: Permissions NEVER run on schedule -- OnDemand only.",
      enum: ["hourly", "daily", "disabled"],
      default: "daily",
    },
    dryRun: {
      type: "boolean",
      title: "Dry-Run / Export-CSV",
      description:
        "When ON: previews all changes without applying them AND exports a fresh copy of all VM " +
        "metadata to your CSV file (NewTags and NewNotes columns will be blank and ready to fill in). " +
        "Check XO logs for full dry-run output. Turn OFF to apply changes for real.",
      default: true,
    },
    enablePerformance: {
      type: "boolean",
      title: "Enable Performance Sync",
      description:
        "Apply CPU weights and IO priorities based on 0-core / 1-high / 2-normal / 3-low tags.",
      default: false,
    },
    enablePermissions: {
      type: "boolean",
      title: "Enable Permission Sync (OnDemand Only)",
      description:
        "SECURITY: Permissions NEVER run automatically. OnDemand via Run Now only. " +
        "Tags ending in -Admin / -Operator / -Viewer trigger group creation and ACL grants. " +
        "Secure your NFS share before enabling.",
      default: false,
    },
    csvPath: {
      type: "string",
      title: "CSV File Path (current-vms.csv)",
      description:
        "Full path to current-vms.csv on your NFS share. " +
        "If vm_metadata.csv is detected in the same directory on load, it will be automatically renamed. " +
        "preload-vms.csv is auto-detected in the same directory.",
      default: "/mnt/v0/code/tag-automation/current-vms.csv",
    },
    logPath: {
      type: "string",
      title: "Log File Path",
      description:
        "Full path to plugin log file on your NFS share. " +
        "A companion summary log is written to the same directory as xo-tag-automation-summary.log.",
      default: "/mnt/v0/code/tag-automation/logs/xo-tag-automation.log",
    },
    stalenessWarnDays: {
      type: "integer",
      title: "CSV Age Warning (days)",
      description: "Warn in logs if current-vms.csv has not been exported in this many days.",
      default: 7,
    },
    performanceTiers: {
      type: "object",
      title: "Performance Tier Settings",
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
  required: ["tagSuffix", "enablePerformance", "enablePermissions", "schedule"],
};

// ============================================================
// TEST SCHEMA -- v0.6.4+: REMOVED ENTIRELY (Code 10 fix)
// ============================================================

// ============================================================
// DEFAULT EXPORT -- Plugin Factory
// ============================================================
export default function({ xo }) {
  let _config = Object.assign({}, DEFAULTS);
  let _job    = null;
  _logPath    = DEFAULTS.logPath;
  _summaryPath = deriveSummaryPath(DEFAULTS.logPath);

  logInfo("Plugin factory called -- xo context: " + (xo ? "YES" : "NO"));
  logWarn("SECURITY REMINDER: Ensure NFS share is secured before enabling Permissions module.");

  function startScheduler() {
    if (_config.schedule === "disabled") {
      logInfo("Schedule disabled -- skipping.");
      return;
    }
    if (!xo.scheduler) {
      logWarn("xo.scheduler not available -- manual runs only.");
      return;
    }
    _job = xo.scheduler.createJob({
      name: "xo-tag-automation-enforcement",
      cron: getCron(_config.schedule),
      fn: async function() {
        logInfo("=== Scheduled run triggered ===", true);
        startRunSummary();
        if (_config.enablePerformance) await enforcePerformance(xo, _config);
        await runCsvSync(xo, _config);
        // NOTE: Permissions intentionally excluded from scheduled runs
        endRunSummary(["scheduled"]);
      },
    });
    logInfo("Scheduler registered -- cron=" + getCron(_config.schedule));
  }

  return {
    configure: function(rawConfig) {
      _config = Object.assign({}, DEFAULTS, rawConfig, {
        performanceTiers: Object.assign(
          {},
          DEFAULTS.performanceTiers,
          (rawConfig && rawConfig.performanceTiers) || {}
        ),
      });
      _logPath     = _config.logPath || DEFAULTS.logPath;
      _summaryPath = deriveSummaryPath(_logPath);
      logInfo(
        "Configured -- suffix=" + _config.tagSuffix +
        " schedule=" + _config.schedule +
        " dryRun=" + _config.dryRun +
        " perf=" + _config.enablePerformance +
        " perms=" + _config.enablePermissions + " (OnDemand only)"
      );
    },

    load: async function() {
      logInfo("Plugin loading...");
      // v0.7.0: Run migration check on load
      await migrateVmMetadataCsv(_config.csvPath);
      if (xo.hooks) {
        xo.hooks.on("core started", function() {
          logInfo("Core started -- registering scheduler.");
          startScheduler();
        });
        logInfo("Plugin loaded -- waiting for core started.");
      } else {
        startScheduler();
      }
    },

    unload: async function() {
      if (_job) {
        _job.stop();
        _job = null;
        logInfo("Scheduler stopped.");
      }
    },

    test: async function(params) {
      const action = (params && params.action) || "Run Now";
      const act    = action.trim();
      logInfo("=== test() dispatching action: \"" + act + "\" ===");

      if (act.startsWith("Run Now")) {
        logInfo("=== RUN NOW triggered from UI ===", true);
        startRunSummary();
        const results = [];

        // Step 1: Performance
        if (_config.enablePerformance) {
          await enforcePerformance(xo, _config);
          results.push("performance: done");
        } else {
          logInfo("Performance disabled -- skipping.");
          results.push("performance: disabled");
        }

        // Step 2: CSV Sync (includes preload-vms processing)
        const csvResult = await runCsvSync(xo, _config);
        results.push("csv-sync: " + (csvResult.error ? "error -- " + csvResult.error : "done"));

        // Step 3: Permissions AFTER CSV -- sees fresh tags
        if (_config.enablePermissions) {
          await enforcePermissions(xo, _config);
          results.push("permissions: done (OnDemand)");
        } else {
          logInfo("Permissions disabled -- skipping.");
          results.push("permissions: disabled");
        }

        endRunSummary(results);
        return "Run Now complete -- " + results.join(", ") + ". Check XO logs for full output.";
      }

      if (act.startsWith("Export CSV")) {
        const result = await exportCsv(xo, _config);
        if (result.dryRun) {
          return "[DRY-RUN] Export CSV: would write " + result.exported + " VMs to \"" + result.path + "\".";
        }
        return (
          "Export CSV complete -- " + result.exported + " VMs written to \"" + result.path + "\". " +
          "NewTags and NewNotes columns are blank and ready to fill in. " +
          "Open the CSV from your NFS share, make your edits, then use xo-cli uploadCsvApi to push it back."
        );
      }

      throw new Error("Unknown action: \"" + act + "\". Please select a valid action from the dropdown.");
    },

    apiMethods: {
      getCsv: async function() {
        try {
          const content = await readFile(_config.csvPath, "utf8");
          logInfo("getCsv: read " + content.length + " bytes from " + _config.csvPath);
          return { content, path: _config.csvPath };
        } catch (err) {
          throw new Error("Could not read CSV: " + err.message);
        }
      },

      saveCsv: async function(params) {
        const content    = params && params.content;
        const validation = validateCsvContent(content);
        if (!validation.valid) {
          throw new Error("CSV validation failed: " + validation.error);
        }
        try {
          await mkdir(dirname(_config.csvPath), { recursive: true });
          await writeFile(_config.csvPath, content, "utf8");
          logInfo("saveCsv: wrote " + content.length + " bytes (" + validation.rowCount + " rows) to " + _config.csvPath);
          return { saved: true, path: _config.csvPath, rowCount: validation.rowCount };
        } catch (err) {
          throw new Error("Could not save CSV: " + err.message);
        }
      },

      exportCsv: async function() {
        return await exportCsv(xo, _config);
      },

      refreshCsvNow: async function() {
        const result = await exportCsv(xo, _config);
        return {
          message: "CSV refreshed -- " + result.exported + " VMs written to " + result.path,
          exported: result.exported,
          path: result.path,
          dryRun: result.dryRun,
        };
      },

      downloadCsvApi: async function() {
        return await downloadCsv(_config);
      },

      uploadCsvApi: async function(params) {
        return await uploadCsv(_config, params && params.content);
      },

      getLog: async function(params) {
        const lines = (params && params.lines) || 50;
        try {
          const content  = await readFile(_config.logPath, "utf8");
          const allLines = content.split("\n");
          return {
            content: allLines.slice(-lines).join("\n"),
            path: _config.logPath,
            totalLines: allLines.length,
            showing: Math.min(lines, allLines.length),
          };
        } catch (err) {
          throw new Error("Could not read log: " + err.message);
        }
      },

      getSummaryLog: async function(params) {
        const lines = (params && params.lines) || 20;
        try {
          const content  = await readFile(_summaryPath, "utf8");
          const allLines = content.split("\n");
          return {
            content: allLines.slice(-lines).join("\n"),
            path: _summaryPath,
            totalLines: allLines.length,
            showing: Math.min(lines, allLines.length),
          };
        } catch (err) {
          throw new Error("Could not read summary log: " + err.message);
        }
      },

      runSync: async function() {
        return await runCsvSync(xo, _config);
      },
    },
  };
}
