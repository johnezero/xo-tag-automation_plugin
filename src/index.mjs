// ============================================================
// xo-server-tag-automation  v0.8.1
// Tag-Based VM Performance & Permission Management
// for Xen Orchestra (xo-server plugin)
// ============================================================
// CHANGELOG v0.8.1 (2026-06-20):
//   FIXED: Scheduler now uses xo.hooks.on('core started', ...)
//          which is the CONFIRMED correct xo-server internal event
//          (verified from xo-server/src/xo-mixins/scheduling.mjs)
//   FIXED: Midnight scheduler uses same xo.hooks pattern
//   FIXED: Double-registration guard retained (_job / _midnightJob)
//   FIXED: xo-cli API methods registered at top-level return object
//   RETAINED: All v0.8.0 fixes and cumulative history
//
// CHANGELOG v0.8.0 (2026-06-20):
//   FIXED: Scheduler race condition -- xo.on("start") replaced
//   FIXED: xo-cli methods now registered at top-level return object
//   FIXED: Midnight scheduler uses same guard pattern
//   ADDED: Explicit "Scheduler registered" log confirmation
//
// CHANGELOG v0.7.9 (2026-06-07) -- First Official Public Release:
//   Airgap bundle verified, build-release.sh added
//   README fully documented
//   Daily summary backend (writeDailySummary() at midnight)
//   getDailySummary and writeDailySummaryNow API methods
//   preload-vms.csv workflow (renamed from new-vm-list.csv)
//   current-vms.csv (renamed from vm_metadata.csv, auto-migrated)
//   Permission Autopilot toggle (enablePermissionAutopilot)
//   Midnight scheduler independent of main enforcement schedule
//
// Plugin install path:
//   /usr/local/lib/node_modules/xo-server-tag-automation/
// ============================================================

import fs   from "fs";
import path from "path";
import { parse }     from "csv-parse/sync";
import { stringify } from "csv-stringify/sync";

// ============================================================
// CONSTANTS & DEFAULTS
// ============================================================

const PLUGIN_VERSION = "0.8.1";
const PLUGIN_NAME    = "xo-tag-automation";

const FILE_CURRENT_VMS = "current-vms.csv";
const FILE_PRELOAD_VMS = "preload-vms.csv";
const FILE_LOG         = "xo-tag-automation.log";
const FILE_SUMMARY_LOG = "xo-tag-automation-summary.log";
const FILE_DAILY       = "xo-tag-automation-daily.log";

// Hardcoded role suffixes -- intentionally NOT configurable.
// Configurable suffixes risk mis-assignment with sub-department names.
const ROLE_SUFFIXES = ["-Admin", "-Operator", "-Viewer"];

const DEFAULTS = {
  tagSuffix:                 "-v",
  schedule:                  "0 * * * *",
  dryRun:                    true,
  enablePerformance:         false,
  enablePermissions:         false,
  enablePermissionAutopilot: false,
  nfsSharePath:              "/mnt/v0/code/tag-automation",
  stalenessWarnDays:         7,
  performanceTiers: {
    coreWeight:   2048,
    coreIoPri:    7,
    highWeight:   1024,
    highIoPri:    7,
    normalWeight: 512,
    normalIoPri:  5,
    lowWeight:    256,
    lowIoPri:     2,
  },
};

// ============================================================
// CONFIGURATION SCHEMA
// ============================================================

export const configurationSchema = {
  type: "object",
  properties: {
    tagSuffix: {
      type: "string",
      title: "Tag Suffix",
      description:
        "Suffix appended to performance tier tags (e.g. -v gives 2-normal-v). " +
        "Use a unique suffix per pool when managing multiple pools from one XO instance.",
      default: "-v",
    },
    schedule: {
      type: "string",
      title: "Schedule (cron)",
      description:
        "Cron expression for how often to run Performance Sync, CSV Sync, and Permission Autopilot. " +
        "Default: hourly (0 * * * *). Use standard 5-field cron syntax.",
      default: "0 * * * *",
    },
    dryRun: {
      type: "boolean",
      title: "Dry Run Mode",
      description:
        "When ON (default), previews all changes in logs without applying anything. " +
        "Also exports a fresh current-vms.csv. Turn OFF to apply changes for real.",
      default: true,
    },
    enablePerformance: {
      type: "boolean",
      title: "Enable Performance Sync",
      description:
        "Apply CPU weights and IO priorities based on VM performance tier tags.",
      default: false,
    },
    enablePermissions: {
      type: "boolean",
      title: "Enable Permission Sync",
      description:
        "Tags ending in -Admin, -Operator, or -Viewer trigger XO Group creation " +
        "and ACL assignments.",
      default: false,
    },
    enablePermissionAutopilot: {
      type: "boolean",
      title: "Enable Permission Autopilot",
      description:
        "When enabled, reads permission tags from current-vms.csv (by UUID) and " +
        "preload-vms.csv (by VM name) and applies them automatically on each scheduled run. " +
        "Disable when not actively performing VM migrations or onboarding.",
      default: false,
    },
    nfsSharePath: {
      type: "string",
      title: "NFS Share Path",
      description:
        "Absolute path to the NFS share directory where CSV files and logs are stored " +
        "(e.g. /mnt/v0/code/tag-automation).",
      default: "/mnt/v0/code/tag-automation",
    },
    stalenessWarnDays: {
      type: "integer",
      title: "CSV Age Warning (days)",
      description:
        "Warn in logs if current-vms.csv has not been updated within this many days.",
      default: 7,
    },
    performanceTiers: {
      type: "object",
      title: "Performance Tier Settings",
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
  required: [],
};

// ============================================================
// LOGGING
// ============================================================

function getLogPath(config, filename) {
  return path.join(config.nfsSharePath || DEFAULTS.nfsSharePath, "logs", filename);
}

function writeLog(config, filename, message) {
  try {
    const logPath = getLogPath(config, filename);
    const dir = path.dirname(logPath);
    if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
    fs.appendFileSync(logPath, message + "\n", "utf8");
  } catch (e) {
    console.error("[xo-tag-automation] Failed to write log: " + e.message);
  }
}

function logInfo(config, msg, summary = false) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [INFO] xo-tag-automation: ${msg}`;
  console.log(line);
  writeLog(config, FILE_LOG, line);
  if (summary) writeLog(config, FILE_SUMMARY_LOG, line);
}

function logWarn(config, msg, summary = false) {
  const ts   = new Date().toISOString();
  const line = `[${ts}] [WARN] xo-tag-automation: ${msg}`;
  console.warn(line);
  writeLog(config, FILE_LOG, line);
  if (summary) writeLog(config, FILE_SUMMARY_LOG, line);
}

function readLogTail(config, filename, lines = 50) {
  try {
    const logPath = getLogPath(config, filename);
    if (!fs.existsSync(logPath)) return `[Log file not found: ${logPath}]`;
    const content  = fs.readFileSync(logPath, "utf8");
    const allLines = content.split("\n").filter(Boolean);
    return allLines.slice(-lines).join("\n");
  } catch (e) {
    return `[Error reading log: ${e.message}]`;
  }
}

// ============================================================
// FILE PATHS HELPER
// ============================================================

function getFilePaths(config) {
  const base = config.nfsSharePath || DEFAULTS.nfsSharePath;
  return {
    nfsSharePath:  base,
    currentVmsCsv: path.join(base, FILE_CURRENT_VMS),
    preloadVmsCsv: path.join(base, FILE_PRELOAD_VMS),
    logFile:       path.join(base, "logs", FILE_LOG),
    summaryLog:    path.join(base, "logs", FILE_SUMMARY_LOG),
    dailyLog:      path.join(base, "logs", FILE_DAILY),
  };
}

// ============================================================
// VM FILTER
// ============================================================

function isRealVm(vm) {
  if (!vm) return false;
  if (vm.type !== "VM" && vm.$type !== "VM") return false;
  if (vm.is_a_template)    return false;
  if (vm.is_control_domain) return false;
  const name = (vm.name_label || vm.name || "").toLowerCase();
  if (name.startsWith("xo ") || name.startsWith("xo-")) return false;
  if (name.includes("[backup]") || name.includes("v2v") || name.includes("esxi")) return false;
  if (/\.(iso|vmdk|ova|ovf)$/i.test(name)) return false;
  return true;
}

// ============================================================
// CSV HELPERS
// ============================================================

function getCsvPath(config) {
  return path.join(config.nfsSharePath || DEFAULTS.nfsSharePath, FILE_CURRENT_VMS);
}

function getPreloadPath(config) {
  return path.join(config.nfsSharePath || DEFAULTS.nfsSharePath, FILE_PRELOAD_VMS);
}

function buildMetaHeader(vmCount, tagSuffix) {
  const date = new Date().toISOString().slice(0, 10);
  return `# Updated: ${date} | VMs: ${vmCount} | Pool: ${tagSuffix}`;
}

function parseMetaHeader(line) {
  const dateMatch    = line.match(/Updated:\s*([\d-]+)/);
  const vmCountMatch = line.match(/VMs:\s*(\d+)/);
  return {
    date:    dateMatch    ? dateMatch[1]              : null,
    vmCount: vmCountMatch ? parseInt(vmCountMatch[1]) : null,
  };
}

// ============================================================
// LEGACY MIGRATION (vm_metadata.csv -> current-vms.csv)
// ============================================================

async function migrateVmMetadataCsv(config) {
  const base    = config.nfsSharePath || DEFAULTS.nfsSharePath;
  const oldPath = path.join(base, "vm_metadata.csv");
  const newPath = path.join(base, FILE_CURRENT_VMS);
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    fs.renameSync(oldPath, newPath);
    logInfo(config, `Migrated vm_metadata.csv -> ${FILE_CURRENT_VMS}`);
  }
}

// ============================================================
// GET VM NOTES
// ============================================================

function getVmNotes(vm) {
  return (
    vm.name_description ||
    vm.notes            ||
    (vm.other_config && vm.other_config.notes)       ||
    (vm.other_config && vm.other_config.description) ||
    ""
  );
}

// ============================================================
// PERFORMANCE ENFORCEMENT
// ============================================================

async function enforcePerformance(xo, config) {
  const { tagSuffix, dryRun, performanceTiers: t } = config;
  logInfo(config, `=== Performance Enforcement starting (dryRun=${dryRun}) ===`, true);

  const suffix = tagSuffix || DEFAULTS.tagSuffix;
  const tiers = [
    { tag: `0-core${suffix}`,   weight: t.coreWeight,   ioPri: t.coreIoPri,   label: "CORE"   },
    { tag: `1-high${suffix}`,   weight: t.highWeight,   ioPri: t.highIoPri,   label: "HIGH"   },
    { tag: `2-normal${suffix}`, weight: t.normalWeight, ioPri: t.normalIoPri, label: "NORMAL" },
    { tag: `3-low${suffix}`,    weight: t.lowWeight,    ioPri: t.lowIoPri,    label: "LOW"    },
  ];

  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  let counts = { CORE: 0, HIGH: 0, NORMAL: 0, LOW: 0, SKIPPED: 0 };

  for (const vm of allVms) {
    const vmTags = vm.tags || [];
    const matched = tiers.find(tier =>
      vmTags.some(t => t.toLowerCase() === tier.tag.toLowerCase())
    );
    if (!matched) { counts.SKIPPED++; continue; }

    const desc = `Set ${matched.label} on "${vm.name_label}" (weight=${matched.weight}, ioPri=${matched.ioPri})`;
    if (dryRun) {
      logInfo(config, `[DRY-RUN] Would: ${desc}`);
    } else {
      try {
        const xapi = xo.getXapi(vm);
        await xapi.call("VM.add_to_VCPUs_params", vm._xapiRef, "weight", String(matched.weight));
        await xapi.call("VM.add_to_other_config", vm._xapiRef, "sched-pri", String(matched.ioPri));
        logInfo(config, `[OK] ${desc}`);
      } catch (err) {
        logWarn(config, `[WARN] Failed: ${desc} -- ${err.message}`);
      }
    }
    counts[matched.label]++;
  }

  logInfo(config, `=== Performance complete: ${JSON.stringify(counts)} ===`, true);
}

// ============================================================
// PERMISSION ENFORCEMENT
// ============================================================

function isPermissionTag(tag) {
  return ROLE_SUFFIXES.some(suffix =>
    tag.toLowerCase().endsWith(suffix.toLowerCase())
  );
}

function getRoleFromTag(tag) {
  const t = tag.toLowerCase();
  if (t.endsWith("-admin"))    return "admin";
  if (t.endsWith("-operator")) return "operator";
  if (t.endsWith("-viewer"))   return "viewer";
  return null;
}

async function enforcePermissions(xo, config) {
  const { dryRun } = config;
  logInfo(config, `=== Permission Sync starting (dryRun=${dryRun}) ===`, true);

  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  let vmsProcessed = 0, groupsCreated = 0, aclsApplied = 0, skipped = 0;

  for (const vm of allVms) {
    const permTags = (vm.tags || []).filter(isPermissionTag);
    if (permTags.length === 0) { skipped++; continue; }

    vmsProcessed++;
    logInfo(config, `Processing VM "${vm.name_label}" -- vm.id=${vm.id} vm.uuid=${vm.uuid}`);

    for (const tag of permTags) {
      const role = getRoleFromTag(tag);
      if (!role) continue;

      // Find or create group
      let group;
      try {
        const allGroups = await xo.getAllGroups();
        group = allGroups.find(g => g.name === tag);
        if (!group) {
          if (!dryRun) {
            const groupId = await xo.createGroup({ name: tag });
            group = { id: groupId, name: tag };
            logInfo(config, `  Group "${tag}" created -- id=${groupId}`);
            groupsCreated++;
          } else {
            logInfo(config, `  [DRY-RUN] Would create Group "${tag}"`);
            groupsCreated++;
            continue;
          }
        } else {
          logInfo(config, `  Group "${tag}" exists -- id=${group.id}`);
        }
      } catch (err) {
        logWarn(config, `  Failed to find/create group "${tag}": ${err.message}`);
        continue;
      }

      // Apply ACL
      try {
        if (!dryRun) {
          await xo.addAcl({ subjectId: group.id, objectId: vm.id, action: role });
          logInfo(config, `  [OK] ACL grant: Group "${tag}" -> VM "${vm.name_label}" role=${role}`);
        } else {
          logInfo(config, `  [DRY-RUN] Would grant: Group "${tag}" -> VM "${vm.name_label}" role=${role}`);
        }
        aclsApplied++;
      } catch (err) {
        logWarn(config, `  Failed ACL grant for "${tag}" -> "${vm.name_label}": ${err.message}`);
      }
    }
  }

  logInfo(config,
    `=== Permission Sync complete -- ${vmsProcessed} VMs processed, ` +
    `${groupsCreated} Groups created/verified, ${aclsApplied} ACL grants applied, ` +
    `${skipped} skipped ===`,
    true
  );
}

// ============================================================
// CSV SYNC
// ============================================================

async function checkCsvStaleness(config, liveVmCount) {
  const csvPath = getCsvPath(config);
  if (!fs.existsSync(csvPath)) return;
  const lines   = fs.readFileSync(csvPath, "utf8").split("\n");
  const metaLine = lines.find(l => l.startsWith("#"));
  if (!metaLine) {
    logWarn(config, `${FILE_CURRENT_VMS} has no metadata header -- consider running Export CSV to refresh.`);
    return;
  }
  const meta = parseMetaHeader(metaLine);
  if (meta.date) {
    const ageDays  = Math.floor((new Date() - new Date(meta.date)) / (1000 * 60 * 60 * 24));
    const warnDays = config.stalenessWarnDays || DEFAULTS.stalenessWarnDays;
    if (ageDays > warnDays) {
      logWarn(config, `${FILE_CURRENT_VMS} may be stale -- last updated ${ageDays} days ago (${meta.date}).`, true);
    } else {
      logInfo(config, `CSV freshness OK -- last updated ${ageDays} day(s) ago (${meta.date}).`);
    }
  }
  if (meta.vmCount !== null && liveVmCount > meta.vmCount) {
    logWarn(config,
      `VM count mismatch -- CSV has ${meta.vmCount}, live pool has ${liveVmCount}. ` +
      `Consider re-exporting.`,
      true
    );
  }
}

async function writeRefreshedCsv(xo, config, allVms) {
  const csvPath = getCsvPath(config);
  const rows = [
    buildMetaHeader(allVms.length, config.tagSuffix || DEFAULTS.tagSuffix),
    "UUID,Name,CurrentTags,NewTags,CurrentNotes,NewNotes",
  ];
  for (const vm of allVms) {
    const uuid         = vm.uuid || vm.id || "";
    const name         = (vm.name_label || vm.name || "").replace(/,/g, ";");
    const currentTags  = (vm.tags || []).join(";").replace(/,/g, ";");
    const currentNotes = getVmNotes(vm).replace(/,/g, ";").replace(/\n/g, " ");
    rows.push(`${uuid},${name},${currentTags},,${currentNotes},`);
  }
  fs.writeFileSync(csvPath, rows.join("\n") + "\n", "utf8");
  logInfo(config, `Wrote refreshed ${FILE_CURRENT_VMS} (${allVms.length} VMs)`);
}

async function runCsvSync(xo, config) {
  const { dryRun } = config;
  logInfo(config, `=== CSV Sync starting (dryRun=${dryRun}) ===`, true);

  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  await checkCsvStaleness(config, allVms.length);

  const csvPath = getCsvPath(config);
  if (!fs.existsSync(csvPath)) {
    logInfo(config, `${FILE_CURRENT_VMS} not found -- exporting fresh copy.`);
    await writeRefreshedCsv(xo, config, allVms);
    return { tagsApplied: 0, notesUpdated: 0 };
  }

  const raw       = fs.readFileSync(csvPath, "utf8");
  const dataLines = raw.split("\n").filter(l => l && !l.startsWith("#") && !l.startsWith("UUID"));
  let tagsApplied = 0, notesUpdated = 0;

  for (const line of dataLines) {
    const cols = line.split(",");
    if (cols.length < 6) continue;
    const [uuid, , , newTagsRaw, , newNotesRaw] = cols;
    const newTags  = (newTagsRaw  || "").trim();
    const newNotes = (newNotesRaw || "").trim();
    if (!newTags && !newNotes) continue;

    const vm = allVms.find(v => (v.uuid || v.id) === uuid.trim());
    if (!vm) continue;

    // v0.7.1 FIX: Apply tags BEFORE writing refreshed CSV
    if (newTags) {
      const tagsToAdd = newTags.split(";").map(t => t.trim()).filter(Boolean);
      for (const tag of tagsToAdd) {
        if (dryRun) {
          logInfo(config, `[DRY-RUN] Would add tag "${tag}" to VM "${vm.name_label}"`);
        } else {
          try {
            await xo.call("vm.addTag", { id: vm.id, tag });
            logInfo(config, `[OK] Added tag "${tag}" to VM "${vm.name_label}"`);
            tagsApplied++;
          } catch (err) {
            logWarn(config, `Failed to add tag "${tag}" to "${vm.name_label}": ${err.message}`);
          }
        }
      }
      if (dryRun) tagsApplied++;
    }

    if (newNotes) {
      if (dryRun) {
        logInfo(config, `[DRY-RUN] Would update notes on VM "${vm.name_label}"`);
        notesUpdated++;
      } else {
        try {
          await xo.call("vm.set", { id: vm.id, name_description: newNotes });
          logInfo(config, `[OK] Updated notes on VM "${vm.name_label}"`);
          notesUpdated++;
        } catch (err) {
          logWarn(config, `Failed to update notes on "${vm.name_label}": ${err.message}`);
        }
      }
    }
  }

  // v0.7.1 FIX: Refresh CSV AFTER applying changes (not before)
  if (!dryRun && (tagsApplied > 0 || notesUpdated > 0)) {
    logInfo(config, `Refreshing ${FILE_CURRENT_VMS} after applying changes...`);
    await writeRefreshedCsv(xo, config, allVms);
  } else if (dryRun) {
    logInfo(config, `[DRY-RUN] Would rewrite ${FILE_CURRENT_VMS} with refreshed data.`);
    await writeRefreshedCsv(xo, config, allVms);
  }

  logInfo(config,
    `=== CSV Sync complete -- ${tagsApplied} tags applied, ${notesUpdated} notes updated ===`,
    true
  );
  return { tagsApplied, notesUpdated };
}

// ============================================================
// PERMISSION AUTOPILOT (CSV-driven)
// ============================================================

async function enforcePermissionsFromCsv(xo, config) {
  if (!config.enablePermissionAutopilot) return;
  logInfo(config, "=== Permission Autopilot starting ===", true);

  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);

  // Source 1: current-vms.csv (match by UUID, read CurrentTags column)
  const csvPath = getCsvPath(config);
  if (fs.existsSync(csvPath)) {
    const raw       = fs.readFileSync(csvPath, "utf8");
    const dataLines = raw.split("\n").filter(l => l && !l.startsWith("#") && !l.startsWith("UUID"));
    for (const line of dataLines) {
      const cols = line.split(",");
      if (cols.length < 3) continue;
      const [uuid, , currentTagsRaw] = cols;
      const tags = (currentTagsRaw || "").split(";").map(t => t.trim()).filter(isPermissionTag);
      if (!tags.length) continue;
      const vm = allVms.find(v => (v.uuid || v.id) === uuid.trim());
      if (!vm) continue;
      for (const tag of tags) {
        await applyPermissionTag(xo, config, vm, tag);
      }
    }
  }

  // Source 2: preload-vms.csv (match by VM name)
  const preloadPath = getPreloadPath(config);
  if (fs.existsSync(preloadPath)) {
    const raw         = fs.readFileSync(preloadPath, "utf8");
    const dataLines   = raw.split("\n").filter(l => l && !l.startsWith("#") && !l.startsWith("Name"));
    const remainingRows = ["Name,Tags,Notes"];

    for (const line of dataLines) {
      const cols = line.split(",");
      if (cols.length < 2) { remainingRows.push(line); continue; }
      const [vmName, tagsRaw] = cols;
      const tags = (tagsRaw || "").split(";").map(t => t.trim()).filter(isPermissionTag);
      const vm   = allVms.find(v =>
        (v.name_label || v.name || "").toLowerCase() === vmName.trim().toLowerCase()
      );
      if (!vm) { remainingRows.push(line); continue; } // VM not found yet -- keep row
      for (const tag of tags) {
        await applyPermissionTag(xo, config, vm, tag);
      }
      logInfo(config, `Autopilot: Preload row applied and removed for VM "${vmName}"`);
    }

    // Write back remaining rows (VMs not yet found)
    if (!config.dryRun) {
      fs.writeFileSync(preloadPath, remainingRows.join("\n") + "\n", "utf8");
    }
  }

  logInfo(config, "=== Permission Autopilot complete ===", true);
}

async function applyPermissionTag(xo, config, vm, tag) {
  const role = getRoleFromTag(tag);
  if (!role) return;
  try {
    const allGroups = await xo.getAllGroups();
    let group = allGroups.find(g => g.name === tag);
    if (!group && !config.dryRun) {
      const groupId = await xo.createGroup({ name: tag });
      group = { id: groupId, name: tag };
      logInfo(config, `  Autopilot: Created Group "${tag}"`);
    }
    if (group && !config.dryRun) {
      await xo.addAcl({ subjectId: group.id, objectId: vm.id, action: role });
      logInfo(config, `  Autopilot: ACL grant Group "${tag}" -> VM "${vm.name_label}" role=${role}`);
    } else {
      logInfo(config, `  [DRY-RUN] Autopilot: Would grant Group "${tag}" -> VM "${vm.name_label}" role=${role}`);
    }
  } catch (err) {
    logWarn(config, `  Autopilot: Failed for tag "${tag}" on VM "${vm.name_label}": ${err.message}`);
  }
}

// ============================================================
// DAILY SUMMARY
// ============================================================

async function writeDailySummary(xo, config) {
  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  const date   = new Date().toISOString().slice(0, 10);
  const line   = `[${new Date().toISOString()}] Daily Summary: ${allVms.length} VMs in pool on ${date}`;
  writeLog(config, FILE_DAILY, line);
  logInfo(config, `Daily summary written: ${allVms.length} VMs`);
  return line;
}

function getDailySummaryContent(config) {
  return readLogTail(config, FILE_DAILY, 30);
}

// ============================================================
// FULL ENFORCEMENT CYCLE
// ============================================================

async function runEnforcementCycle(xo, config) {
  logInfo(config, `=== Enforcement Cycle starting (v${PLUGIN_VERSION}, dryRun=${config.dryRun}) ===`, true);
  try {
    await migrateVmMetadataCsv(config);
    await runCsvSync(xo, config);
    if (config.enablePerformance)         await enforcePerformance(xo, config);
    if (config.enablePermissions)         await enforcePermissions(xo, config);
    if (config.enablePermissionAutopilot) await enforcePermissionsFromCsv(xo, config);
    logInfo(config, `=== Enforcement Cycle complete ===`, true);
  } catch (err) {
    logWarn(config, `=== Enforcement Cycle ERROR: ${err.message} ===`, true);
    throw err;
  }
}

// ============================================================
// PLUGIN EXPORT
// ============================================================

export default function tagAutomationPlugin({ xo }) {
  let _config = {
    ...DEFAULTS,
    performanceTiers: { ...DEFAULTS.performanceTiers },
  };
  let _job         = null;
  let _midnightJob = null;

  // --------------------------------------------------------
  // v0.8.1 FIX: Scheduler registration helpers
  // Double-registration guard: if _job already set, bail out.
  // --------------------------------------------------------
  function registerScheduler() {
    if (_job) return;

    const cron = _config.schedule || "0 * * * *";
    _job = xo.scheduler.createJob({
      name: "xo-tag-automation-main",
      cron: cron,
      fn: async () => {
        logInfo(_config, "AutoPilot: Scheduled run starting...");
        await runEnforcementCycle(xo, _config);
      },
    });
    _job.start();
    logInfo(_config, `Scheduler registered -- cron: ${cron}`);
  }

  function registerMidnightScheduler() {
    if (_midnightJob) return;

    _midnightJob = xo.scheduler.createJob({
      name: "xo-tag-automation-midnight",
      cron: "0 0 * * *",
      fn: async () => {
        logInfo(_config, "Midnight: Writing daily summary...");
        await writeDailySummary(xo, _config);
      },
    });
    _midnightJob.start();
    logInfo(_config, "Midnight scheduler registered -- cron: 0 0 * * *");
  }

  return {
    // --------------------------------------------------------
    // configure() -- called by xo-server when plugin settings change
    // --------------------------------------------------------
    configure(rawConfig) {
      _config = {
        ...DEFAULTS,
        ...rawConfig,
        performanceTiers: {
          ...DEFAULTS.performanceTiers,
          ...(rawConfig.performanceTiers || {}),
        },
      };
    },

    // --------------------------------------------------------
    // load() -- v0.8.1 FIX:
    //   Use xo.hooks.on('core started', ...) -- the CONFIRMED correct
    //   xo-server internal event, verified from source:
    //   packages/xo-server/src/xo-mixins/scheduling.mjs
    //
    //   xo.hooks.on('core started') fires when xo-server core is
    //   fully initialized and xo.scheduler is guaranteed available.
    //
    //   Fallback: if xo.hooks is unavailable, attempt direct
    //   registration (defensive coding for future xo-server changes).
    // --------------------------------------------------------
    async load() {
      logInfo(_config, `Plugin loading... (v${PLUGIN_VERSION})`);
      await migrateVmMetadataCsv(_config);

      if (xo.hooks) {
        // v0.8.1: Correct event -- confirmed from xo-server source
        xo.hooks.on("core started", () => {
          logInfo(_config, "Core started event received -- registering schedulers now.");
          registerScheduler();
          registerMidnightScheduler();
        });
        logInfo(_config, "Plugin loaded -- waiting for core started event (via xo.hooks).");
      } else {
        // Fallback: xo.hooks not available -- attempt direct registration
        logWarn(_config, "xo.hooks not available -- attempting direct scheduler registration.");
        if (xo.scheduler) {
          registerScheduler();
          registerMidnightScheduler();
        } else {
          logWarn(_config, "xo.scheduler also not available -- AutoPilot will NOT run! Check xo-server version.");
        }
      }
    },

    // --------------------------------------------------------
    // unload() -- clean up jobs on plugin disable/restart
    // --------------------------------------------------------
    async unload() {
      if (_job)         { _job.stop();        _job         = null; }
      if (_midnightJob) { _midnightJob.stop(); _midnightJob = null; }
      logInfo(_config, "Plugin unloaded -- schedulers stopped.");
    },

    // --------------------------------------------------------
    // test() -- triggered by [Test Plugin] button in XO UI
    // --------------------------------------------------------
    testSchema: {
      type: "object",
      properties: {
        action: {
          type: "string",
          enum: ["Run Now", "Export CSV"],
          default: "Run Now",
        },
      },
      required: [],
    },

    async test({ action } = {}) {
      if (action === "Export CSV") {
        const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
        await writeRefreshedCsv(xo, _config, allVms);
        return `Exported ${allVms.length} VMs to ${FILE_CURRENT_VMS}`;
      }
      await runEnforcementCycle(xo, _config);
      return "Enforcement cycle complete -- check NFS logs for details.";
    },

    // --------------------------------------------------------
    // xo-cli API Methods
    // v0.8.0 FIX: Registered at top-level return object.
    // These MUST be here (not inside load()) to be exposed
    // to the JSON-RPC API and callable via xo-cli.
    // --------------------------------------------------------

    // Trigger a full enforcement cycle
    async "xo-server-tag-automation.runSync"() {
      await runEnforcementCycle(xo, _config);
      return "Sync complete.";
    },

    // View last N lines of main log
    async "xo-server-tag-automation.getLog"({ lines = 50 } = {}) {
      return readLogTail(_config, FILE_LOG, Number(lines));
    },

    // View last N lines of summary log
    async "xo-server-tag-automation.getSummaryLog"({ lines = 50 } = {}) {
      return readLogTail(_config, FILE_SUMMARY_LOG, Number(lines));
    },

    // Export VM inventory to current-vms.csv
    async "xo-server-tag-automation.exportCsv"() {
      const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
      await writeRefreshedCsv(xo, _config, allVms);
      return `Exported ${allVms.length} VMs to ${FILE_CURRENT_VMS}`;
    },

    // Print CSV content to stdout
    async "xo-server-tag-automation.downloadCsvApi"() {
      const csvPath = getCsvPath(_config);
      if (!fs.existsSync(csvPath)) return `[File not found: ${csvPath}]`;
      return fs.readFileSync(csvPath, "utf8");
    },

    // Push an edited CSV back to the NFS share
    async "xo-server-tag-automation.uploadCsvApi"({ content } = {}) {
      if (!content) throw new Error("No content provided.");
      const csvPath = getCsvPath(_config);
      fs.writeFileSync(csvPath, content, "utf8");
      logInfo(_config, `CSV uploaded via API -- wrote ${content.length} bytes to ${csvPath}`);
      return `Uploaded successfully to ${csvPath}`;
    },

    // Show all configured file paths
    async "xo-server-tag-automation.getFilePaths"() {
      return getFilePaths(_config);
    },

    // Get nightly VM count summary
    async "xo-server-tag-automation.getDailySummary"() {
      return getDailySummaryContent(_config);
    },

    // Write daily summary immediately (without waiting for midnight)
    async "xo-server-tag-automation.writeDailySummaryNow"() {
      return await writeDailySummary(xo, _config);
    },
  };
}
