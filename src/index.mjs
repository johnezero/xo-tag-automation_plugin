// ============================================================
// xo-server-tag-automation v1.0.1
// Tag-Based VM Performance & Permission Management
// for Xen Orchestra (xo-server plugin)
// ============================================================

import fs from "fs";
import fsp from "fs/promises";
import path from "path";
import zlib from "zlib";
import { pipeline } from "stream";
import { promisify } from "util";
import { createSchedule } from "@xen-orchestra/cron";

const pipelineAsync = promisify(pipeline);

// ============================================================
// CONSTANTS & DEFAULTS
// ============================================================

const PLUGIN_VERSION = "1.0.1";
const FILE_CURRENT_VMS = "current-vms.csv";
const FILE_PRELOAD_VMS = "preload-vms.csv";
const FILE_LOG = "xo-tag-automation.log";
const FILE_SUMMARY_LOG = "xo-tag-automation-summary.log";
const FILE_DAILY = "xo-tag-automation-daily.log";
const ROLE_SUFFIXES = ["-Admin", "-Operator", "-Viewer"];

const LOG_MAX_BYTES = 10 * 1024 * 1024; // 10MB rotation threshold
const LOG_MAX_FILES = 3;                 // keep .log.1.gz, .log.2.gz, .log.3.gz

const DEFAULTS = {
  schedule: "hourly",
  scheduleOffset: 5,
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
    scheduleOffset: {
      type: "integer",
      title: "Schedule Offset (minutes)",
      description:
        "Minute offset for scheduled jobs (1-14) to avoid colliding with tasks starting on the hour or quarter-hour.",
      default: 5,
      minimum: 1,
      maximum: 14,
    },
    dryRun: {
      type: "boolean",
      title: "Dry Run Mode",
      description:
        "When ON (default), previews all changes in logs without applying anything. " +
        "Flip OFF only after verifying dry-run output looks correct.",
      default: true,
    },
    enablePerformance: {
      type: "boolean",
      title: "Enable Performance Sync",
      description:
        "Apply CPU weights and IO priorities based on VM performance tier tags " +
        "(0-core, 1-high, 2-normal, 3-low). Uses cache inspection before XAPI calls.",
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
        "Reads permission tags from current-vms.csv and preload-vms.csv and applies them automatically.",
      default: false,
    },
    nfsSharePath: {
      type: "string",
      title: "NFS Share Path",
      description:
        "Absolute path to the NFS share directory containing CSV files and logs (e.g. /mnt/v0/code/tag-automation).",
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
      description: "CPU weight and IO priority values for each performance tier.",
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
// HELPERS & SCHEDULING
// ============================================================

function sanitizeOffset(offset) {
  const num = parseInt(offset, 10);
  if (isNaN(num) || num < 1 || num > 14) return DEFAULTS.scheduleOffset;
  return num;
}

function getCron(schedule, offsetRaw = DEFAULTS.scheduleOffset) {
  const offset = sanitizeOffset(offsetRaw);
  if (schedule === "15min") {
    const m1 = offset;
    const m2 = offset + 15;
    const m3 = offset + 30;
    const m4 = offset + 45;
    return `${m1},${m2},${m3},${m4} * * * *`;
  }
  if (schedule === "hourly") return `${offset} * * * *`;
  if (schedule === "daily") return `${offset} 2 * * *`;
  if (schedule && schedule.includes(" ")) return schedule;
  return `${offset} * * * *`;
}

function parseCsvLine(line) {
  const result = [];
  let cur = "";
  let inQuotes = false;
  for (let i = 0; i < line.length; i++) {
    const char = line[i];
    if (char === '"') {
      if (inQuotes && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else {
        inQuotes = !inQuotes;
      }
    } else if (char === "," && !inQuotes) {
      result.push(cur.trim());
      cur = "";
    } else {
      cur += char;
    }
  }
  result.push(cur.trim());
  return result;
}

function escapeCsvCell(val) {
  if (val === null || val === undefined) return "";
  const str = String(val);
  if (str.includes(",") || str.includes('"') || str.includes("\n") || str.includes("\r")) {
    return `"${str.replace(/"/g, '""')}"`;
  }
  return str;
}

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

function getLogPath(config, filename) {
  return path.join(config.nfsSharePath || DEFAULTS.nfsSharePath, "logs", filename);
}

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
  const dateMatch    = line.match(/Updated:\s*([\d-]+)/);
  const vmCountMatch = line.match(/VMs:\s*(\d+)/);
  return {
    date:    dateMatch    ? dateMatch[1]              : null,
    vmCount: vmCountMatch ? parseInt(vmCountMatch[1], 10) : null,
  };
}

function getSafeXapi(xo, vm) {
  try {
    return xo.getXapi(vm);
  } catch (err) {
    return null;
  }
}

// ============================================================
// ASYNC BUFFERED LOGGER
// ============================================================

class AsyncLogger {
  constructor(config) {
    this.config = config;
    this.buffer = new Map(); // filename -> string[]
    this.dirChecked = false;
  }

  log(level, msg, summary = false) {
    const ts = new Date().toISOString();
    const line = `[${ts}] [${level}] xo-tag-automation: ${msg}`;
    if (level === "WARN" || level === "ERROR") {
      console.warn(line);
    } else {
      console.log(line);
    }

    this._queue(FILE_LOG, line);
    if (summary) {
      this._queue(FILE_SUMMARY_LOG, line);
    }
  }

  info(msg, summary = false) {
    this.log("INFO", msg, summary);
  }

  warn(msg, summary = false) {
    this.log("WARN", msg, summary);
  }

  error(msg, summary = false) {
    this.log("ERROR", msg, summary);
  }

  _queue(filename, line) {
    if (!this.buffer.has(filename)) {
      this.buffer.set(filename, []);
    }
    this.buffer.get(filename).push(line);
  }

  async flush() {
    if (this.buffer.size === 0) return;

    try {
      const logsDir = path.join(this.config.nfsSharePath || DEFAULTS.nfsSharePath, "logs");
      if (!this.dirChecked) {
        await fsp.mkdir(logsDir, { recursive: true });
        this.dirChecked = true;
      }

      for (const [filename, lines] of this.buffer.entries()) {
        if (!lines.length) continue;
        const logPath = getLogPath(this.config, filename);
        const payload = lines.join("\n") + "\n";
        await fsp.appendFile(logPath, payload, "utf8");
      }
      this.buffer.clear();
    } catch (err) {
      console.error(`[xo-tag-automation] AsyncLogger flush failed: ${err.message}`);
    }
  }
}

async function appendLogDirectAsync(config, filename, message) {
  try {
    const logPath = getLogPath(config, filename);
    const dir = path.dirname(logPath);
    await fsp.mkdir(dir, { recursive: true });
    await fsp.appendFile(logPath, message + "\n", "utf8");
  } catch (err) {
    console.error(`[xo-tag-automation] Direct async log write failed: ${err.message}`);
  }
}

async function readLogTailAsync(config, filename, lines = 50) {
  try {
    const logPath = getLogPath(config, filename);
    const content = await fsp.readFile(logPath, "utf8");
    const allLines = content.split("\n").filter(Boolean);
    return allLines.slice(-lines).join("\n");
  } catch (err) {
    if (err.code === "ENOENT") return `[Log file not found: ${getLogPath(config, filename)}]`;
    return `[Error reading log: ${err.message}]`;
  }
}

// ============================================================
// LOG ROTATION (Async)
// ============================================================

async function rotateSingleLogFile(config, filename, logger = null) {
  const logPath = getLogPath(config, filename);
  try {
    const stat = await fsp.stat(logPath);
    if (stat.size < LOG_MAX_BYTES) return;

    if (logger) {
      logger.info(
        `Log rotation triggered for ${filename} (size: ${(stat.size / 1024 / 1024).toFixed(2)}MB >= ${LOG_MAX_BYTES / 1024 / 1024}MB)`
      );
      await logger.flush();
    }

    for (let i = LOG_MAX_FILES; i > 1; i--) {
      const older = `${logPath}.${i}.gz`;
      const newer = `${logPath}.${i - 1}.gz`;
      try {
        await fsp.rename(newer, older);
      } catch (e) {
        // ignore missing intermediate files
      }
    }

    const dest = `${logPath}.1.gz`;
    await pipelineAsync(
      fs.createReadStream(logPath),
      zlib.createGzip(),
      fs.createWriteStream(dest)
    );

    await fsp.writeFile(logPath, "", "utf8");

    const ts = new Date().toISOString();
    await appendLogDirectAsync(
      config,
      filename,
      `[${ts}] [INFO] xo-tag-automation: Log rotated -- compressed previous logs to ${path.basename(dest)}`
    );
  } catch (err) {
    if (err.code !== "ENOENT") {
      console.error(`[xo-tag-automation] Log rotation failed for ${filename}: ${err.message}`);
    }
  }
}

async function rotateLogs(config, logger) {
  await rotateSingleLogFile(config, FILE_LOG, logger);
  await rotateSingleLogFile(config, FILE_SUMMARY_LOG, logger);
  await rotateSingleLogFile(config, FILE_DAILY, logger);
}

// ============================================================
// VM FILTER
// ============================================================

function isRealVm(vm) {
  if (!vm || !vm.uuid) return false;
  if (vm.type !== undefined && vm.type !== "VM") return false;
  if (vm.$type !== undefined && vm.$type !== "VM") return false;
  if (vm.is_a_template === true || vm.is_a_template === "true") return false;
  if (vm.is_control_domain) return false;

  const name = (vm.name_label || "").trim();
  if (!name) return false;
  if (name.startsWith("[XO Backup")) return false;
  if (name.startsWith("[ESXI]")) return false;
  if (name.includes("import from V2V")) return false;
  if (name === "base copy") return false;
  if (name.endsWith("-flat.vmdk") || name.endsWith("-sesparse.vmdk") || name.endsWith(".iso")) return false;
  if (name.startsWith("Xapi#") || name.startsWith("Control domain on host")) return false;

  return true;
}

function getVmNotes(vm) {
  if (vm.name_description && typeof vm.name_description === "string") {
    return vm.name_description.trim();
  }
  if (vm.other_config && typeof vm.other_config.description === "string") {
    return vm.other_config.description.trim();
  }
  return "";
}

// ============================================================
// LEGACY MIGRATION (Async)
// ============================================================

async function migrateVmMetadataCsv(config, logger) {
  const base = config.nfsSharePath || DEFAULTS.nfsSharePath;
  const oldPath = path.join(base, "vm_metadata.csv");
  const newPath = path.join(base, FILE_CURRENT_VMS);
  try {
    await fsp.access(oldPath);
    try {
      await fsp.access(newPath);
    } catch (e) {
      await fsp.rename(oldPath, newPath);
      logger.info(`Migrated legacy vm_metadata.csv -> ${FILE_CURRENT_VMS}`);
    }
  } catch (e) {
    // oldPath does not exist, nothing to do
  }
}

// ============================================================
// CSV HANDLING & EXPORT
// ============================================================

async function checkCsvStaleness(config, logger) {
  const csvPath = getCsvPath(config);
  try {
    const raw = await fsp.readFile(csvPath, "utf8");
    const lines = raw.split("\n");
    const metaLine = lines.find(l => l.startsWith("#"));
    if (!metaLine) return;

    const meta = parseMetaHeader(metaLine);
    if (meta.date) {
      const ageDays = Math.floor((new Date() - new Date(meta.date)) / (1000 * 60 * 60 * 24));
      const warnDays = config.stalenessWarnDays || DEFAULTS.stalenessWarnDays;
      if (ageDays > warnDays) {
        logger.warn(`${FILE_CURRENT_VMS} stale -- last updated ${ageDays} days ago.`, true);
      }
    }
  } catch (err) {
    // If file does not exist, no staleness to report
  }
}

async function writeRefreshedCsv(config, allVms, logger) {
  const csvPath = getCsvPath(config);
  const rows = [
    buildMetaHeader(allVms.length),
    "UUID,Name,CurrentTags,NewTags,CurrentNotes,NewNotes",
  ];

  for (const vm of allVms) {
    const uuid = vm.uuid || vm.id || "";
    const name = escapeCsvCell(vm.name_label || "");
    const currentTags = escapeCsvCell((vm.tags || []).join(";"));
    const currentNotes = escapeCsvCell(getVmNotes(vm));
    rows.push(`${uuid},${name},${currentTags},,${currentNotes},`);
  }

  const baseDir = path.dirname(csvPath);
  await fsp.mkdir(baseDir, { recursive: true });
  await fsp.writeFile(csvPath, rows.join("\n") + "\n", "utf8");
  if (logger) {
    logger.info(`Wrote refreshed ${FILE_CURRENT_VMS} (${allVms.length} VMs)`);
  }
}

// ============================================================
// PERFORMANCE ENFORCEMENT (Zero-write cache optimization)
// ============================================================

async function enforcePerformance(xo, config, vmIndex, logger) {
  const { dryRun, performanceTiers: t } = config;
  logger.info(`=== Performance Enforcement starting (dryRun=${dryRun}) ===`, true);

  const tiers = [
    { tag: "0-core",   weight: String(t.coreWeight),   ioPri: String(t.coreIoPri),   label: "CORE"   },
    { tag: "1-high",   weight: String(t.highWeight),   ioPri: String(t.highIoPri),   label: "HIGH"   },
    { tag: "2-normal", weight: String(t.normalWeight), ioPri: String(t.normalIoPri), label: "NORMAL" },
    { tag: "3-low",    weight: String(t.lowWeight),    ioPri: String(t.lowIoPri),    label: "LOW"    },
  ];

  const counts = { CORE: 0, HIGH: 0, NORMAL: 0, LOW: 0, UNCHANGED: 0, SKIPPED: 0 };

  for (const vm of vmIndex.list) {
    const vmTags = vm.tags || [];
    const matched = tiers.find(tier =>
      vmTags.some(tag => tag.toLowerCase() === tier.tag)
    );

    if (!matched) {
      counts.SKIPPED++;
      continue;
    }

    const currentWeight = vm.VCPUs_params?.weight ? String(vm.VCPUs_params.weight) : null;
    const currentIoPri  = vm.other_config?.["sched-pri"] ? String(vm.other_config["sched-pri"]) : null;

    const needsWeight = currentWeight !== matched.weight;
    const needsIoPri  = currentIoPri !== matched.ioPri;

    if (!needsWeight && !needsIoPri) {
      counts.UNCHANGED++;
      counts[matched.label]++;
      continue;
    }

    const desc = `Set ${matched.label} on "${vm.name_label}" (weight=${matched.weight}, ioPri=${matched.ioPri})`;

    if (dryRun) {
      logger.info(`[DRY-RUN] Would: ${desc} (current: weight=${currentWeight || "unset"}, ioPri=${currentIoPri || "unset"})`);
    } else {
      const xapi = getSafeXapi(xo, vm);
      if (!xapi) {
        logger.warn(`Skipping performance on "${vm.name_label}": host/pool is disconnected`);
        continue;
      }

      try {
        if (needsWeight) {
          try {
            await xapi.call("VM.remove_from_VCPUs_params", vm._xapiRef, "weight");
          } catch (_) {}
          await xapi.call("VM.add_to_VCPUs_params", vm._xapiRef, "weight", matched.weight);
        }

        if (needsIoPri) {
          try {
            await xapi.call("VM.remove_from_other_config", vm._xapiRef, "sched-pri");
          } catch (_) {}
          await xapi.call("VM.add_to_other_config", vm._xapiRef, "sched-pri", matched.ioPri);
        }

        logger.info(`[OK] ${desc}`);
      } catch (err) {
        logger.warn(`[WARN] Failed: ${desc} -- ${err.message}`);
      }
    }
    counts[matched.label]++;
  }

  logger.info(`=== Performance complete: ${JSON.stringify(counts)} ===`, true);
}

// ============================================================
// PERMISSION & ACL ENFORCEMENT
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

async function getOrCreateGroupCached(xo, groupMap, groupName, dryRun, logger) {
  if (groupMap.has(groupName)) {
    return groupMap.get(groupName);
  }

  if (dryRun) {
    logger.info(`  [DRY-RUN] Would create group "${groupName}"`);
    return { id: `mock-group-${groupName}`, name: groupName, isMock: true };
  }

  try {
    const groupId = await xo.createGroup({ name: groupName });
    const newGroup = { id: groupId, name: groupName };
    groupMap.set(groupName, newGroup);
    logger.info(`  [OK] Created group "${groupName}"`);
    return newGroup;
  } catch (err) {
    logger.warn(`  Failed to create group "${groupName}": ${err.message}`);
    return null;
  }
}

async function applyPermissionTagInline(xo, config, groupMap, vm, tag, logger) {
  const role = getRoleFromTag(tag);
  if (!role) return false;
  const { dryRun } = config;

  try {
    const group = await getOrCreateGroupCached(xo, groupMap, tag, dryRun, logger);
    if (!group) return false;

    if (!dryRun) {
      // Positional args: xo.addAcl(subjectId, objectId, action)
      await xo.addAcl(group.id, vm.id, role);
      logger.info(`  [OK] ACL grant: Group "${tag}" -> VM "${vm.name_label}" (role=${role})`);
    } else {
      logger.info(`  [DRY-RUN] Would grant ACL: Group "${tag}" -> VM "${vm.name_label}" (role=${role})`);
    }
    return true;
  } catch (err) {
    logger.warn(`  Failed ACL grant for "${tag}" -> "${vm.name_label}": ${err.message}`);
    return false;
  }
}

async function enforcePermissions(xo, config, vmIndex, groupMap, logger) {
  const { dryRun } = config;
  logger.info(`=== Permission Sync starting (dryRun=${dryRun}) ===`, true);

  let vmsProcessed = 0;
  let aclsApplied = 0;
  let skipped = 0;

  for (const vm of vmIndex.list) {
    const permTags = (vm.tags || []).filter(isPermissionTag);
    if (permTags.length === 0) {
      skipped++;
      continue;
    }
    vmsProcessed++;

    for (const tag of permTags) {
      const ok = await applyPermissionTagInline(xo, config, groupMap, vm, tag, logger);
      if (ok) aclsApplied++;
    }
  }

  logger.info(
    `=== Permission Sync complete (vmsProcessed=${vmsProcessed}, aclsApplied=${aclsApplied}, skipped=${skipped}) ===`,
    true
  );
}

// ============================================================
// CSV SYNC & PRELOAD PROCESSING
// ============================================================

async function runCsvSync(xo, config, vmIndex, groupMap, parsedCsvLines, logger) {
  const { dryRun } = config;
  logger.info(`=== CSV Sync starting (dryRun=${dryRun}) ===`, true);

  if (!parsedCsvLines || !parsedCsvLines.length) {
    await writeRefreshedCsv(config, vmIndex.list, logger);
    return { tagsApplied: 0, notesUpdated: 0 };
  }

  let tagsApplied = 0;
  let notesUpdated = 0;
  const shouldApplyAcls = config.enablePermissions || config.enablePermissionAutopilot;

  for (const cols of parsedCsvLines) {
    if (cols.length < 6) continue;
    const [uuidRaw, , , newTagsRaw, , newNotesRaw] = cols;
    const uuid = (uuidRaw || "").trim();
    const newTags = (newTagsRaw || "").trim();
    const newNotes = (newNotesRaw || "").trim();

    if (!newTags && !newNotes) continue;

    const vm = vmIndex.byUuid.get(uuid) || vmIndex.byId.get(uuid);
    if (!vm) continue;

    const xapi = getSafeXapi(xo, vm);
    if (!xapi) {
      logger.warn(`Skipping CSV sync updates on "${vm.name_label}": host/pool disconnected`);
      continue;
    }

    if (newTags) {
      const tagsToAdd = newTags.split(";").map(t => t.trim()).filter(Boolean);
      const existingTags = new Set(vm.tags || []);

      for (const tag of tagsToAdd) {
        if (existingTags.has(tag)) {
          continue;
        }

        if (!dryRun) {
          try {
            await xapi.call("VM.add_tags", vm._xapiRef, tag);
            existingTags.add(tag);
            logger.info(`[OK] Added tag "${tag}" to VM "${vm.name_label}"`);
            tagsApplied++;

            if (shouldApplyAcls && isPermissionTag(tag)) {
              logger.info(`[CSV Sync] Applying ACL inline for permission tag "${tag}" on "${vm.name_label}"`);
              await applyPermissionTagInline(xo, config, groupMap, vm, tag, logger);
            }
          } catch (err) {
            if (err.message && err.message.includes("MAP_DUPLICATE_KEY")) {
              existingTags.add(tag);
            } else {
              logger.warn(`Failed to add tag "${tag}" to "${vm.name_label}": ${err.message}`);
            }
          }
        } else {
          logger.info(`[DRY-RUN] Would add tag "${tag}" to VM "${vm.name_label}"`);
          tagsApplied++;
          if (shouldApplyAcls && isPermissionTag(tag)) {
            logger.info(`[DRY-RUN][CSV Sync] Would apply ACL inline for permission tag "${tag}" on "${vm.name_label}"`);
            await applyPermissionTagInline(xo, config, groupMap, vm, tag, logger);
          }
        }
      }
    }

    if (newNotes && newNotes !== getVmNotes(vm)) {
      if (!dryRun) {
        try {
          await xapi.call("VM.set_name_description", vm._xapiRef, newNotes);
          logger.info(`[OK] Updated notes on VM "${vm.name_label}"`);
          notesUpdated++;
        } catch (err) {
          logger.warn(`Failed to update notes on "${vm.name_label}": ${err.message}`);
        }
      } else {
        logger.info(`[DRY-RUN] Would update notes on VM "${vm.name_label}"`);
        notesUpdated++;
      }
    }
  }

  await writeRefreshedCsv(config, vmIndex.list, logger);
  logger.info(`=== CSV Sync complete (tagsApplied=${tagsApplied}, notesUpdated=${notesUpdated}) ===`, true);
  return { tagsApplied, notesUpdated };
}

async function processPreloadVms(xo, config, vmIndex, groupMap, logger) {
  const preloadPath = getPreloadPath(config);
  let raw = "";
  try {
    raw = await fsp.readFile(preloadPath, "utf8");
  } catch (err) {
    return; // file does not exist
  }

  const { dryRun } = config;
  logger.info(`=== Preload VMs starting (dryRun=${dryRun}) ===`, true);

  const lines = raw.split("\n");
  const remainingRows = [];
  let applied = 0;
  let notFound = 0;

  const shouldApplyAcls = config.enablePermissions || config.enablePermissionAutopilot;

  for (const line of lines) {
    const trimmed = line.trim();

    if (!trimmed || trimmed.startsWith("#") || trimmed.startsWith("Name,")) {
      if (trimmed) remainingRows.push(line);
      continue;
    }

    const cols = parseCsvLine(trimmed);
    const vmName = (cols[0] || "").trim();
    const tagsRaw = (cols[1] || "").trim();
    const notesRaw = (cols[2] || "").trim();

    if (!vmName) continue;

    const vm = vmIndex.byNameLower.get(vmName.toLowerCase());

    if (!vm) {
      // VM not yet migrated/created in XO -- keep in queue indefinitely
      remainingRows.push(line);
      notFound++;
      continue;
    }

    const xapi = getSafeXapi(xo, vm);
    if (!xapi) {
      logger.warn(`[Preload] VM "${vmName}" is on a disconnected pool -- retrying next cycle`);
      remainingRows.push(line);
      continue;
    }

    const tagsToAdd = tagsRaw.split(";").map(t => t.trim()).filter(Boolean);
    let rowOk = true;

    for (const tag of tagsToAdd) {
      if ((vm.tags || []).includes(tag)) continue;

      if (!dryRun) {
        try {
          await xapi.call("VM.add_tags", vm._xapiRef, tag);
          logger.info(`[Preload][OK] Added tag "${tag}" to VM "${vm.name_label}"`);
        } catch (err) {
          if (err.message && err.message.includes("MAP_DUPLICATE_KEY")) {
            // Already present
          } else {
            logger.warn(`[Preload][WARN] Failed to add tag "${tag}" to "${vm.name_label}": ${err.message}`);
            rowOk = false;
          }
        }
      } else {
        logger.info(`[Preload][DRY-RUN] Would add tag "${tag}" to VM "${vm.name_label}"`);
      }
    }

    if (notesRaw && notesRaw !== getVmNotes(vm)) {
      if (!dryRun) {
        try {
          await xapi.call("VM.set_name_description", vm._xapiRef, notesRaw);
          logger.info(`[Preload][OK] Updated notes on VM "${vm.name_label}"`);
        } catch (err) {
          logger.warn(`[Preload][WARN] Failed to update notes on "${vm.name_label}": ${err.message}`);
          rowOk = false;
        }
      } else {
        logger.info(`[Preload][DRY-RUN] Would update notes on VM "${vm.name_label}"`);
      }
    }

    if (shouldApplyAcls) {
      for (const tag of tagsToAdd) {
        if (isPermissionTag(tag)) {
          logger.info(`[Preload] Applying ACL inline for permission tag "${tag}" on "${vm.name_label}"`);
          await applyPermissionTagInline(xo, config, groupMap, vm, tag, logger);
        }
      }
    }

    if (dryRun) {
      logger.info(`[Preload][DRY-RUN] VM "${vm.name_label}" processed in dryRun`);
      remainingRows.push(line);
    } else if (rowOk) {
      logger.info(`[Preload][DONE] VM "${vm.name_label}" processed successfully -- removed from preload queue`);
      applied++;
    } else {
      logger.warn(`[Preload][RETRY] VM "${vm.name_label}" had errors -- keeping in preload`);
      remainingRows.push(line);
    }
  }

  if (!dryRun) {
    await fsp.writeFile(preloadPath, remainingRows.join("\n") + "\n", "utf8");
  }

  logger.info(`=== Preload VMs complete (applied=${applied}, notFound=${notFound}) ===`, true);
}

async function enforcePermissionsFromCsv(xo, config, vmIndex, groupMap, parsedCsvLines, logger) {
  if (!config.enablePermissionAutopilot) return;
  logger.info("=== Permission Autopilot starting ===", true);

  if (!parsedCsvLines || !parsedCsvLines.length) return;

  for (const cols of parsedCsvLines) {
    if (cols.length < 3) continue;
    const [uuidRaw, , currentTagsRaw] = cols;
    const uuid = (uuidRaw || "").trim();
    const tags = (currentTagsRaw || "")
      .split(";")
      .map(t => t.trim())
      .filter(isPermissionTag);

    if (!tags.length) continue;

    const vm = vmIndex.byUuid.get(uuid) || vmIndex.byId.get(uuid);
    if (!vm) continue;

    for (const tag of tags) {
      await applyPermissionTagInline(xo, config, groupMap, vm, tag, logger);
    }
  }

  logger.info("=== Permission Autopilot complete ===", true);
}

// ============================================================
// DAILY SUMMARY (Async)
// ============================================================

async function writeDailySummary(xo, config) {
  const allObjects = Object.values(xo.getObjects({ type: "VM" }));
  const realVms = allObjects.filter(isRealVm);
  const date = new Date().toISOString().slice(0, 10);
  const line = `[${new Date().toISOString()}] Daily Summary: ${realVms.length} VMs in pool on ${date}`;

  await appendLogDirectAsync(config, FILE_DAILY, line);
  console.log(`[xo-tag-automation] Daily summary written: ${realVms.length} VMs`);
  return line;
}

// ============================================================
// MASTER ENFORCEMENT CYCLE (With Mutex & O(1) Lookups)
// ============================================================

let _cycleInProgress = false;

async function runEnforcementCycle(xo, config) {
  if (_cycleInProgress) {
    console.warn("[xo-tag-automation] Enforcement cycle already running. Skipping concurrent trigger.");
    return;
  }

  _cycleInProgress = true;
  const logger = new AsyncLogger(config);
  logger.info(`=== Enforcement Cycle starting (v${PLUGIN_VERSION}, dryRun=${config.dryRun}) ===`, true);

  try {
    await rotateLogs(config, logger);
    await migrateVmMetadataCsv(config, logger);

    // Single XO object scan
    const allObjects = Object.values(xo.getObjects({ type: "VM" }));
    const realVms = allObjects.filter(isRealVm);

    // Build O(1) Index Maps
    const vmIndex = {
      list: realVms,
      byUuid: new Map(),
      byId: new Map(),
      byNameLower: new Map(),
    };

    for (const vm of realVms) {
      if (vm.uuid) vmIndex.byUuid.set(vm.uuid, vm);
      if (vm.id) vmIndex.byId.set(vm.id, vm);
      if (vm.name_label) vmIndex.byNameLower.set(vm.name_label.toLowerCase(), vm);
    }

    // Cache Groups once
    const allGroups = await xo.getAllGroups();
    const groupMap = new Map();
    for (const g of allGroups) {
      if (g.name) groupMap.set(g.name, g);
    }

    // Read CSV once
    const csvPath = getCsvPath(config);
    let parsedCsvLines = [];
    try {
      const raw = await fsp.readFile(csvPath, "utf8");
      parsedCsvLines = raw
        .split("\n")
        .map(l => l.trim())
        .filter(l => l && !l.startsWith("#") && !l.startsWith("UUID"))
        .map(parseCsvLine);
    } catch (e) {
      // CSV does not exist yet
    }

    await checkCsvStaleness(config, logger);
    await runCsvSync(xo, config, vmIndex, groupMap, parsedCsvLines, logger);
    await processPreloadVms(xo, config, vmIndex, groupMap, logger);

    if (config.enablePerformance) {
      await enforcePerformance(xo, config, vmIndex, logger);
    }
    if (config.enablePermissions) {
      await enforcePermissions(xo, config, vmIndex, groupMap, logger);
    }
    if (config.enablePermissionAutopilot) {
      await enforcePermissionsFromCsv(xo, config, vmIndex, groupMap, parsedCsvLines, logger);
    }

    logger.info(`=== Enforcement Cycle complete ===`, true);
  } catch (err) {
    logger.error(`=== Enforcement Cycle ERROR: ${err.message} ===`, true);
    throw err;
  } finally {
    await logger.flush();
    _cycleInProgress = false;
  }
}

// ============================================================
// PLUGIN EXPORT & LIFECYCLE
// ============================================================

export default function tagAutomationPlugin({ xo }) {
  let _config = {
    ...DEFAULTS,
    performanceTiers: { ...DEFAULTS.performanceTiers },
  };

  let _job = null;
  let _midnightJob = null;

  function initSchedulers(cfg) {
    if (_job) {
      try { _job.stop(); } catch (_) {}
    }
    if (_midnightJob) {
      try { _midnightJob.stop(); } catch (_) {}
    }

    const cron = getCron(cfg.schedule, cfg.scheduleOffset);
    const offset = sanitizeOffset(cfg.scheduleOffset);
    const midnightCron = `${offset} 0 * * *`;

    _job = createSchedule(cron).createJob(async () => {
      console.log("[xo-tag-automation] Scheduled enforcement starting...");
      try {
        await runEnforcementCycle(xo, _config);
      } catch (err) {
        console.warn(`[xo-tag-automation] Scheduled run error: ${err.message}`);
      }
    });

    _midnightJob = createSchedule(midnightCron).createJob(async () => {
      console.log("[xo-tag-automation] Midnight: Writing daily summary...");
      try {
        await writeDailySummary(xo, _config);
      } catch (err) {
        console.warn(`[xo-tag-automation] Daily summary error: ${err.message}`);
      }
    });

    _job.start();
    _midnightJob.start();

    console.log(`[xo-tag-automation] Schedulers started: cycle="${cron}", daily="${midnightCron}"`);
  }

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

      initSchedulers(_config);
    },

    async load() {
      console.log(`[xo-tag-automation] Plugin loading... (v${PLUGIN_VERSION})`);
      const logger = new AsyncLogger(_config);
      await migrateVmMetadataCsv(_config, logger);
      await logger.flush();
      initSchedulers(_config);
    },

    async unload() {
      if (_job) {
        try { _job.stop(); } catch (_) {}
      }
      if (_midnightJob) {
        try { _midnightJob.stop(); } catch (_) {}
      }
      console.log("[xo-tag-automation] Plugin unloaded -- schedulers stopped.");
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
        const logger = new AsyncLogger(_config);
        await writeRefreshedCsv(_config, allVms, logger);
        await logger.flush();
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
      return await readLogTailAsync(_config, FILE_LOG, Number(lines));
    },

    async "xo-server-tag-automation.getSummaryLog"({ lines = 50 } = {}) {
      return await readLogTailAsync(_config, FILE_SUMMARY_LOG, Number(lines));
    },

    async "xo-server-tag-automation.exportCsv"() {
      const allVms = Object.values(xo.getObjects({ type: "VM" })).filter(isRealVm);
      const logger = new AsyncLogger(_config);
      await writeRefreshedCsv(_config, allVms, logger);
      await logger.flush();
      return `Exported ${allVms.length} VMs to ${FILE_CURRENT_VMS}`;
    },

    async "xo-server-tag-automation.downloadCsvApi"() {
      const csvPath = getCsvPath(_config);
      try {
        return await fsp.readFile(csvPath, "utf8");
      } catch (e) {
        return `[File not found: ${csvPath}]`;
      }
    },

    async "xo-server-tag-automation.uploadCsvApi"({ content } = {}) {
      if (!content) throw new Error("No content provided.");
      const csvPath = getCsvPath(_config);
      await fsp.writeFile(csvPath, content, "utf8");
      console.log(`[xo-tag-automation] CSV uploaded via API -- wrote ${content.length} bytes to ${csvPath}`);
      return `Uploaded successfully to ${csvPath}`;
    },

    async "xo-server-tag-automation.getFilePaths"() {
      return getFilePaths(_config);
    },

    async "xo-server-tag-automation.getDailySummary"() {
      return await readLogTailAsync(_config, FILE_DAILY, 30);
    },

    async "xo-server-tag-automation.writeDailySummaryNow"() {
      return await writeDailySummary(xo, _config);
    },
  };
}