// ============================================================
// xo-server-tag-automation v0.9.2
// Tag-Based VM Performance & Permission Management
// for Xen Orchestra (xo-server plugin)
// ============================================================
// CHANGELOG v0.9.2 (2026-06-28):
// FIXED: CSV Sync tag application -- replaced non-existent xo.call("vm.addTag")
//        and xo.call("vm.set") with direct XAPI calls:
//          xapi.call("VM.add_tags", vm._xapiRef, tag)
//          xapi.call("VM.set_name_description", vm._xapiRef, notes)
//        Confirmed against xo-server source: no vm.addTag API method exists.
//        Tags are managed exclusively via XAPI on the VM object directly.
// RETAINED: All v0.9.1 fixes (positional XAPI args, suffix removal, dual-scheduler,
//           Permission Sync, Permission Autopilot, CSV staleness, preload-vms.csv,
//           xo-cli API methods, daily summary)
// ============================================================

import fs from "fs";
import path from "path";
import { createSchedule } from "@xen-orchestra/cron";

// ============================================================
// CONSTANTS & DEFAULTS
// ============================================================

const PLUGIN_VERSION = "0.9.2";
const FILE_CURRENT_VMS = "current-vms.csv";
const FILE_PRELOAD_VMS = "preload-vms.csv";
const FILE_LOG = "xo-tag-automation.log";
const FILE_SUMMARY_LOG = "xo-tag-automation-summary.log";
const FILE_DAILY = "xo-tag-automation-daily.log";
const ROLE_SUFFIXES = ["-Admin", "-Operator", "-Viewer"];

const DEFAULTS = {
  schedule: "hourly",
  dryRun: true,
  enablePerformance: false,
  enablePermissions: false,
  enablePermissionAutopilot: false,
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
// getCron()
// ============================================================

function getCron(schedule) {
  if (schedule === "15min") return "*/15 * * * *";
  if (schedule === "hourly") return "0 * * * *";
  if (schedule === "daily") return "0 2 * * *";
  if (schedule && schedule.includes(" ")) return schedule;
  return "0 * * * *";
}

// ============================================================
// CONFIGURATION SCHEMA
// ============================================================

export const configurationSchema = {
  type: "object",
  description:
    "IMPORTANT -- The 'Delete configuration' button resets all plugin settings to defaults. " +
    "It does NOT delete any VMs, tags, groups, or CSV files on your NFS share.",
  properties: {
    schedule: {
      type: "string",
      title: "Schedule",
      description:
        "How often to run the enforcement cycle (Performance Sync, CSV Sync, Permission Autopilot).",
      enum: ["15min", "hourly", "daily"],
      default: "hourly",
    },
    dryRun: {
      type: "boolean",
      title: "Dry Run Mode",
      description:
        "When ON (default), previews all changes in logs without applying anything.",
      default: true,
    },
    enablePerformance: {
      type: "boolean",
      title: "Enable Performance Sync",
      description:
        "Apply CPU weights and IO priorities based on VM performance tier tags. " +
        "Tags: 0-core, 1-high, 2-normal, 3-low (no suffix required).",
      default: false,
    },
    enablePermissions: {
      type: "boolean",
      title: "Enable Permission Sync",
      description:
        "Tags ending in -Admin, -Operator, or -Viewer trigger XO Group creation and ACL assignments.",
      default: false,
    },
    enablePermissionAutopilot: {
      type: "boolean",
      title: "Enable Permission Autopilot",
      description:
        "When enabled, reads permission tags from CSV files and applies them automatically.",
      default: false,
    },
    nfsSharePath: {
      type: "string",
      title: "NFS Share Path",
      description:
        "Absolute path to the NFS share directory (e.g. /mnt/v0/code/tag-automation).",
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
        coreIoPri:    { type: "integer", title: "Core IO Priority",   default: 7 },
        highWeight:   { type: "integer", title: "High CPU Weight",    default: 1024 },
        highIoPri:    { type: "integer", title: "High IO Priority",   default: 7 },
        normalWeight: { type: "integer", title: "Normal CPU Weight",  default: 512 },
        normalIoPri:  { type: "integer", title: "Normal IO Priority", default: 5 },
        lowWeight:    { type: "integer", title: "Low CPU Weight",     default: 256 },
        lowIoPri:     { type: "integer", title: "Low IO Priority",    default: 2 },
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
  const ts = new Date().toISOString();
  const line = `[${ts}] [INFO] xo-tag-automation: ${msg}`;
  console.log(line);
  writeLog(config, FILE_LOG, line);
  if (summary) writeLog(config, FILE_SUMMARY_LOG, line);
}

function logWarn(config, msg, summary = false) {
  const ts = new Date().toISOString();
  const line = `[${ts}] [WARN] xo-tag-automation: ${msg}`;
  console.warn(line);
  writeLog(config, FILE_LOG, line);
  if (summary) writeLog(config, FILE_SUMMARY_LOG, line);
}

function readLogTail(config, filename, lines = 50) {
  try {
    const logPath = getLogPath(config, filename);
    if (!fs.existsSync(logPath)) return `[Log file not found: ${logPath}]`;
    const content = fs.readFileSync(logPath, "utf8");
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
    nfsSharePath: base,
    currentVmsCsv: path.join(base, FILE_CURRENT_VMS),
    preloadVmsCsv: path.join(base, FILE_PRELOAD_VMS),
    logFile: path.join(base, "logs", FILE_LOG),
    summaryLog: path.join(base, "logs", FILE_SUMMARY_LOG),
    dailyLog: path.join(base, "logs", FILE_DAILY),
  };
}

// ============================================================
// VM FILTER
// ============================================================

function isRealVm(vm) {
  if (!vm || !vm.uuid) return false;
  if (vm.$type !== undefined && vm.$type !== "VM") return false;
  if (vm.type !== undefined && vm.type !== "VM") return false;
  if (vm.is_a_template === true || vm.is_a_template === "true") return false;
  if (vm.is_control_domain) return false;
  if (!vm.name_label || !vm.name_label.trim()) return false;
  const name = vm.name_label.trim();
  if (name.startsWith("[XO Backup")) return false;
  if (name.startsWith("[ESXI]")) return false;
  if (name.includes("import from V2V")) return false;
  if (name === "complete import from V2V") return false;
  if (name === "after complete import from V2V") return false;
  if (name === "after partial import from V2V") return false;
  if (name === "base copy") return false;
  if (name.endsWith("-flat.vmdk")) return false;
  if (name.endsWith("-sesparse.vmdk")) return false;
  if (name.endsWith(".iso")) return false;
  if (name.startsWith("Xapi#")) return false;
  if (name.startsWith("Control domain on host")) return false;
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

function buildMetaHeader(vmCount) {
  const date = new Date().toISOString().slice(0, 10);
  return `# Updated: ${date} | VMs: ${vmCount}`;
}

function parseMetaHeader(line) {
  const dateMatch = line.match(/Updated:\s*([\d-]+)/);
  const vmCountMatch = line.match(/VMs:\s*(\d+)/);
  return {
    date: dateMatch ? dateMatch[1] : null,
    vmCount: vmCountMatch ? parseInt(vmCountMatch[1]) : null,
  };
}

// ============================================================
// LEGACY MIGRATION
// ============================================================

async function migrateVmMetadataCsv(config) {
  const base = config.nfsSharePath || DEFAULTS.nfsSharePath;
  const oldPath = path.join(base, "vm_metadata.csv");
  const newPath = path.join(base, FILE_CURRENT_VMS);
  if (fs.existsSync(oldPath) && !fs.existsSync(newPath)) {
    fs.renameSync(oldPath, newPath);
    logInfo(config, `Migrated vm_metadata.csv -> ${FILE_CURRENT_VMS}`);
  }
}

// ============================================================
// NOTES HELPER
// ============================================================

function getVmNotes(vm) {
  if (vm.name_description && vm.name_description.trim()) return vm.name_description.trim();
  if (vm.notes && vm.notes.trim()) return vm.notes.trim();
  if (vm.other_config) {
    const oc = vm.other_config;
    if (oc.notes && oc.notes.trim()) return oc.notes.trim();
    if (oc.description && oc.description.trim()) return oc.description.trim();
  }
  return "";
}

// ============================================================
// PERFORMANCE ENFORCEMENT (v0.9.1+ -- suffix-free, positional XAPI args)
// ============================================================

async function enforcePerformance(xo, config) {
  const { dryRun, performanceTiers: t } = config;
  logInfo(config, `=== Performance Enforcement starting (dryRun=${dryRun}) ===`, true);

  const tiers = [
    { tag: "0-core",   weight: t.coreWeight,   ioPri: t.coreIoPri,   label: "CORE"   },
    { tag: "1-high",   weight: t.highWeight,   ioPri: t.highIoPri,   label: "HIGH"   },
    { tag: "2-normal", weight: t.normalWeight, ioPri: t.normalIoPri, label: "NORMAL" },
    { tag: "3-low",    weight: t.lowWeight,    ioPri: t.lowIoPri,    label: "LOW"    },
  ];

  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  const counts = { CORE: 0, HIGH: 0, NORMAL: 0, LOW: 0, SKIPPED: 0 };

  for (const vm of allVms) {
    const vmTags = vm.tags || [];
    const matched = tiers.find(tier =>
      vmTags.some(tag => tag.toLowerCase() === tier.tag)
    );

    if (!matched) {
      counts.SKIPPED++;
      continue;
    }

    const desc = `Set ${matched.label} on "${vm.name_label}" (weight=${matched.weight}, ioPri=${matched.ioPri})`;

    if (dryRun) {
      logInfo(config, `[DRY-RUN] Would: ${desc}`);
    } else {
      try {
        const xapi = xo.getXapi(vm);
        // Positional args (ref, key, value) -- prevents PARAMETER_COUNT_MISMATCH
        // remove_from before add_to -- prevents MAP_DUPLICATE_KEY
        await xapi.call("VM.remove_from_VCPUs_params", vm._xapiRef, "weight");
        await xapi.call("VM.add_to_VCPUs_params",      vm._xapiRef, "weight", String(matched.weight));
        await xapi.call("VM.remove_from_other_config", vm._xapiRef, "sched-pri");
        await xapi.call("VM.add_to_other_config",      vm._xapiRef, "sched-pri", String(matched.ioPri));
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

    for (const tag of permTags) {
      const role = getRoleFromTag(tag);
      if (!role) continue;

      let group;
      try {
        const allGroups = await xo.getAllGroups();
        group = allGroups.find(g => g.name === tag);
        if (!group) {
          if (!dryRun) {
            const groupId = await xo.createGroup({ name: tag });
            group = { id: groupId, name: tag };
            groupsCreated++;
          } else {
            groupsCreated++;
            continue;
          }
        }
      } catch (err) {
        logWarn(config, `  Failed to find/create group "${tag}": ${err.message}`);
        continue;
      }

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

  logInfo(config, `=== Permission Sync complete (vmsProcessed=${vmsProcessed}, groupsCreated=${groupsCreated}, aclsApplied=${aclsApplied}, skipped=${skipped}) ===`, true);
}

// ============================================================
// CSV SYNC
// ============================================================

async function checkCsvStaleness(config) {
  const csvPath = getCsvPath(config);
  if (!fs.existsSync(csvPath)) return;
  const lines = fs.readFileSync(csvPath, "utf8").split("\n");
  const metaLine = lines.find(l => l.startsWith("#"));
  if (!metaLine) return;
  const meta = parseMetaHeader(metaLine);
  if (meta.date) {
    const ageDays = Math.floor((new Date() - new Date(meta.date)) / (1000 * 60 * 60 * 24));
    const warnDays = config.stalenessWarnDays || DEFAULTS.stalenessWarnDays;
    if (ageDays > warnDays) {
      logWarn(config, `${FILE_CURRENT_VMS} stale -- last updated ${ageDays} days ago.`, true);
    }
  }
}

async function writeRefreshedCsv(xo, config, allVms) {
  const csvPath = getCsvPath(config);
  const rows = [
    buildMetaHeader(allVms.length),
    "UUID,Name,CurrentTags,NewTags,CurrentNotes,NewNotes",
  ];
  for (const vm of allVms) {
    const uuid         = vm.uuid || vm.id || "";
    const name         = (vm.name_label || "").replace(/,/g, ";");
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
  await checkCsvStaleness(config);

  const csvPath = getCsvPath(config);
  if (!fs.existsSync(csvPath)) {
    await writeRefreshedCsv(xo, config, allVms);
    return { tagsApplied: 0, notesUpdated: 0 };
  }

  const raw = fs.readFileSync(csvPath, "utf8");
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

    // v0.9.2 FIX: Use direct XAPI calls -- xo.call("vm.addTag") does not exist
    // Confirmed against xo-server source (packages/xo-server/src/api/vm.mjs)
    const xapi = xo.getXapi(vm);

    if (newTags) {
      const tagsToAdd = newTags.split(";").map(t => t.trim()).filter(Boolean);
      for (const tag of tagsToAdd) {
        if (!dryRun) {
          try {
            await xapi.call("VM.add_tags", vm._xapiRef, tag);
            logInfo(config, `[OK] Added tag "${tag}" to VM "${vm.name_label}"`);
            tagsApplied++;
          } catch (err) {
            // Ignore "already exists" errors -- tag may already be present
            if (err.message && err.message.includes("MAP_DUPLICATE_KEY")) {
              logInfo(config, `[SKIP] Tag "${tag}" already present on "${vm.name_label}"`);
            } else {
              logWarn(config, `Failed to add tag "${tag}" to "${vm.name_label}": ${err.message}`);
            }
          }
        } else {
          logInfo(config, `[DRY-RUN] Would add tag "${tag}" to VM "${vm.name_label}"`);
          tagsApplied++;
        }
      }
    }

    if (newNotes) {
      if (!dryRun) {
        try {
          // v0.9.2 FIX: Direct XAPI call for name_description
          await xapi.call("VM.set_name_description", vm._xapiRef, newNotes);
          logInfo(config, `[OK] Updated notes on VM "${vm.name_label}"`);
          notesUpdated++;
        } catch (err) {
          logWarn(config, `Failed to update notes on "${vm.name_label}": ${err.message}`);
        }
      } else {
        logInfo(config, `[DRY-RUN] Would update notes on VM "${vm.name_label}"`);
        notesUpdated++;
      }
    }
  }

  await writeRefreshedCsv(xo, config, allVms);
  logInfo(config, `=== CSV Sync complete (tagsApplied=${tagsApplied}, notesUpdated=${notesUpdated}) ===`, true);
  return { tagsApplied, notesUpdated };
}

// ============================================================
// PERMISSION AUTOPILOT
// ============================================================

async function applyPermissionTag(xo, config, vm, tag) {
  const role = getRoleFromTag(tag);
  if (!role) return;
  try {
    const allGroups = await xo.getAllGroups();
    let group = allGroups.find(g => g.name === tag);
    if (!group && !config.dryRun) {
      const groupId = await xo.createGroup({ name: tag });
      group = { id: groupId, name: tag };
    }
    if (group && !config.dryRun) {
      await xo.addAcl({ subjectId: group.id, objectId: vm.id, action: role });
    }
  } catch (err) {
    logWarn(config, `  Autopilot: Failed for tag "${tag}": ${err.message}`);
  }
}

async function enforcePermissionsFromCsv(xo, config) {
  if (!config.enablePermissionAutopilot) return;
  logInfo(config, "=== Permission Autopilot starting ===", true);

  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);

  // Process current-vms.csv
  const csvPath = getCsvPath(config);
  if (fs.existsSync(csvPath)) {
    const raw = fs.readFileSync(csvPath, "utf8");
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

  // Process preload-vms.csv
  const preloadPath = getPreloadPath(config);
  if (fs.existsSync(preloadPath)) {
    const raw = fs.readFileSync(preloadPath, "utf8");
    const dataLines = raw.split("\n").filter(l => l && !l.startsWith("#") && !l.startsWith("Name"));
    const remainingRows = ["Name,Tags,Notes"];
    for (const line of dataLines) {
      const cols = line.split(",");
      if (cols.length < 2) { remainingRows.push(line); continue; }
      const [vmName, tagsRaw] = cols;
      const tags = (tagsRaw || "").split(";").map(t => t.trim()).filter(isPermissionTag);
      const vm = allVms.find(v =>
        (v.name_label || "").toLowerCase() === vmName.trim().toLowerCase()
      );
      if (!vm) { remainingRows.push(line); continue; }
      for (const tag of tags) {
        await applyPermissionTag(xo, config, vm, tag);
      }
      logInfo(config, `Autopilot: Preload row applied for VM "${vmName}"`);
    }
    if (!config.dryRun) {
      fs.writeFileSync(preloadPath, remainingRows.join("\n") + "\n", "utf8");
    }
  }

  logInfo(config, "=== Permission Autopilot complete ===", true);
}

// ============================================================
// DAILY SUMMARY
// ============================================================

async function writeDailySummary(xo, config) {
  const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
  const date = new Date().toISOString().slice(0, 10);
  const line = `[${new Date().toISOString()}] Daily Summary: ${allVms.length} VMs in pool on ${date}`;
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

  let _job = createSchedule(getCron(DEFAULTS.schedule)).createJob(async () => {
    logInfo(_config, "AutoPilot: Scheduled run starting...");
    try {
      await runEnforcementCycle(xo, _config);
    } catch (err) {
      logWarn(_config, `AutoPilot: Scheduled run error -- ${err.message}`);
    }
  });

  let _midnightJob = createSchedule("0 0 * * *").createJob(async () => {
    logInfo(_config, "Midnight: Writing daily summary...");
    try {
      await writeDailySummary(xo, _config);
    } catch (err) {
      logWarn(_config, `Midnight: Daily summary error -- ${err.message}`);
    }
  });

  return {
    configure(rawConfig) {
      _config = {
        ...DEFAULTS,
        ...rawConfig,
        performanceTiers: {
          ...DEFAULTS.performanceTiers,
          ...(rawConfig.performanceTiers || {}),
        },
      };
      const cron = getCron(_config.schedule);
      logInfo(_config, `configure() called -- schedule="${_config.schedule}" -> cron="${cron}"`);

      _job = createSchedule(cron).createJob(async () => {
        logInfo(_config, "AutoPilot: Scheduled run starting...");
        try {
          await runEnforcementCycle(xo, _config);
        } catch (err) {
          logWarn(_config, `AutoPilot: Scheduled run error -- ${err.message}`);
        }
      });

      _midnightJob = createSchedule("0 0 * * *").createJob(async () => {
        logInfo(_config, "Midnight: Writing daily summary...");
        try {
          await writeDailySummary(xo, _config);
        } catch (err) {
          logWarn(_config, `Midnight: Daily summary error -- ${err.message}`);
        }
      });
    },

    async load() {
      logInfo(_config, `Plugin loading... (v${PLUGIN_VERSION})`);
      await migrateVmMetadataCsv(_config);
      _job.start();
      _midnightJob.start();
      const cron = getCron(_config.schedule);
      logInfo(_config, `Scheduler started -- schedule="${_config.schedule}" cron="${cron}"`);
      logInfo(_config, "Midnight scheduler started -- cron: 0 0 * * *");
    },

    async unload() {
      _job.stop();
      _midnightJob.stop();
      logInfo(_config, "Plugin unloaded -- schedulers stopped.");
    },

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

    async "xo-server-tag-automation.runSync"() {
      await runEnforcementCycle(xo, _config);
      return "Sync complete.";
    },

    async "xo-server-tag-automation.getLog"({ lines = 50 } = {}) {
      return readLogTail(_config, FILE_LOG, Number(lines));
    },

    async "xo-server-tag-automation.getSummaryLog"({ lines = 50 } = {}) {
      return readLogTail(_config, FILE_SUMMARY_LOG, Number(lines));
    },

    async "xo-server-tag-automation.exportCsv"() {
      const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
      await writeRefreshedCsv(xo, _config, allVms);
      return `Exported ${allVms.length} VMs to ${FILE_CURRENT_VMS}`;
    },

    async "xo-server-tag-automation.downloadCsvApi"() {
      const csvPath = getCsvPath(_config);
      if (!fs.existsSync(csvPath)) return `[File not found: ${csvPath}]`;
      return fs.readFileSync(csvPath, "utf8");
    },

    async "xo-server-tag-automation.uploadCsvApi"({ content } = {}) {
      if (!content) throw new Error("No content provided.");
      const csvPath = getCsvPath(_config);
      fs.writeFileSync(csvPath, content, "utf8");
      logInfo(_config, `CSV uploaded via API -- wrote ${content.length} bytes to ${csvPath}`);
      return `Uploaded successfully to ${csvPath}`;
    },

    async "xo-server-tag-automation.getFilePaths"() {
      return getFilePaths(_config);
    },

    async "xo-server-tag-automation.getDailySummary"() {
      return getDailySummaryContent(_config);
    },

    async "xo-server-tag-automation.writeDailySummaryNow"() {
      return await writeDailySummary(xo, _config);
    },
  };
}
